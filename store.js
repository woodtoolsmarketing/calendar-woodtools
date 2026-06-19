/*
 * store.js
 * Persistencia local de tareas/plantillas en JSON dentro de userData.
 * Robusto contra pérdida de datos (igual que credentials.js):
 *  - Escritura ATÓMICA (temporal + rename) → un corte no corrompe el archivo
 *  - Backup que se mantiene siempre; si el principal se corrompe, se restaura solo
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const dataFile = path.join(app.getPath('userData'), 'calendario-data.json');
const bakFile = path.join(app.getPath('userData'), 'calendario-data.bak.json');

function normalize(data) {
  return {
    tasks: data && Array.isArray(data.tasks) ? data.tasks : [],
    templates: data && Array.isArray(data.templates) ? data.templates : [],
  };
}

function parseFile(p) {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf-8');
  if (!raw.trim()) return null;
  return JSON.parse(raw); // lanza si está corrupto
}

function read() {
  // 1) principal
  try {
    const data = parseFile(dataFile);
    if (data) return normalize(data);
  } catch (e) {
    console.error('[store] principal corrupto, pruebo backup:', e.message);
  }
  // 2) backup (y restaurar)
  try {
    const data = parseFile(bakFile);
    if (data) {
      try { fs.copyFileSync(bakFile, dataFile); } catch (_) {}
      console.warn('[store] restaurado desde backup');
      return normalize(data);
    }
  } catch (e) {
    console.error('[store] backup también falló:', e.message);
  }
  return { tasks: [], templates: [] };
}

function write(data) {
  try {
    const safe = normalize(data);
    // respaldar el actual antes de tocarlo
    try { if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, bakFile); } catch (_) {}
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf-8');
    fs.renameSync(tmp, dataFile);
    return true;
  } catch (e) {
    console.error('[store] Error guardando datos:', e);
    return false;
  }
}

module.exports = { read, write, dataFile };

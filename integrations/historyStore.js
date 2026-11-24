/*
 * integrations/historyStore.js — Historial de marketing persistido como HOJA DE CÁLCULO (CSV) en userData.
 * Guarda SÓLO métricas (nunca tokens/secretos). Escritura ATÓMICA (tmp + rename) con respaldo .bak,
 * igual patrón que adsStore.js, pero SIN tope de días (para comparativa anual).
 * Archivo liviano: una fila por día; se abre nativo en Excel/Google Sheets.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const history = require('./history');

const dataFile = path.join(app.getPath('userData'), 'historial-marketing.csv');
const bakFile = path.join(app.getPath('userData'), 'historial-marketing.bak.csv');

/** Lee y parsea las filas; cae al .bak si el principal se corrompe. */
function read() {
  try {
    return history.parseCsv(fs.readFileSync(dataFile, 'utf-8'));
  } catch (_) {
    try { return history.parseCsv(fs.readFileSync(bakFile, 'utf-8')); } catch (__) { return []; }
  }
}

/** Escribe TODAS las filas de forma atómica. */
function writeRows(rows) {
  try {
    const text = history.serialize(rows);
    try { if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, bakFile); } catch (_) {}
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, dataFile);
    return true;
  } catch (e) {
    console.error('[historyStore] Error guardando historial:', e);
    return false;
  }
}

/** Mergea filas nuevas por fecha (sólo pisa campos definidos) y persiste.
 *  Devuelve { ok, rows }: ok=false si el guardado falló (típicamente el archivo abierto en Excel → EPERM). */
function upsert(incoming) {
  const merged = history.upsertByDate(read(), incoming || []);
  const ok = writeRows(merged);
  return { ok, rows: merged.length };
}

/** Garantiza que el archivo exista (crea uno vacío con encabezado si falta). Devuelve la ruta. */
function ensureFile() {
  try { if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, history.serialize([]), 'utf-8'); } catch (_) {}
  return dataFile;
}

/** Cobertura (rango de fechas, primer día con consultas). */
function coverage() { return history.coverage(read()); }

module.exports = { read, writeRows, upsert, ensureFile, coverage, dataFile, bakFile };

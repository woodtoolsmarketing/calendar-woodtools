/*
 * credentials.js — Guardado de credenciales de APIs (Meta, YouTube, TikTok, Threads).
 *
 * Diseñado para NO perder datos nunca (ni con corte de luz):
 *  - Se guarda en JSON legible: connections.json
 *  - Antes de cada escritura se respalda el actual en connections.bak.json
 *  - La escritura es ATÓMICA (archivo temporal + rename) → si se corta, no corrompe
 *  - Si el principal se corrompe, se RESTAURA solo desde el backup
 *  - Migra automáticamente el viejo archivo cifrado (connections.dat) si existía
 *
 * Nota de seguridad: el JSON queda en la carpeta de datos del usuario de Windows
 * (solo accesible por esa cuenta). Si preferís cifrado, se puede reactivar.
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const dir = app.getPath('userData');
const file = path.join(dir, 'connections.json');
const bak = path.join(dir, 'connections.bak.json');
const legacy = path.join(dir, 'connections.dat'); // viejo archivo cifrado

console.log('[DEBUG credentials] userData =', dir);
console.log('[DEBUG credentials] connections.json =', file, '| existe:', fs.existsSync(file));

function parseFile(p) {
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf-8');
  if (!txt.trim()) return null;
  return JSON.parse(txt); // lanza si está corrupto
}

function readAll() {
  // 1) archivo principal
  try {
    const data = parseFile(file);
    if (data && typeof data === 'object') return data;
  } catch (e) {
    console.error('[credentials] principal corrupto, pruebo backup:', e.message);
  }
  // 2) backup (y restaurar el principal)
  try {
    const data = parseFile(bak);
    if (data && typeof data === 'object') {
      try { fs.copyFileSync(bak, file); } catch (_) {}
      console.warn('[credentials] restaurado desde backup');
      return data;
    }
  } catch (e) {
    console.error('[credentials] backup también falló:', e.message);
  }
  // 3) migración del viejo .dat cifrado, si existe
  try {
    if (fs.existsSync(legacy)) {
      const raw = fs.readFileSync(legacy);
      if (raw.length) {
        const json = raw[0] === 0x7b
          ? raw.toString('utf-8')
          : (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : null);
        if (json) {
          const data = JSON.parse(json);
          if (data && typeof data === 'object') { writeAll(data); return data; }
        }
      }
    }
  } catch (_) { /* migración best-effort */ }
  return {};
}

function writeAll(data) {
  const safe = data && typeof data === 'object' ? data : {};
  // 1) respaldar el archivo actual ANTES de tocarlo
  try { if (fs.existsSync(file)) fs.copyFileSync(file, bak); } catch (_) {}
  // 2) escritura atómica
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return true;
}

function getPlatform(p) {
  return readAll()[p] || null;
}

function setPlatform(p, data) {
  const all = readAll(); // tolerante: nunca devuelve {} si hay datos recuperables
  all[p] = data;
  return writeAll(all);
}

function summary() {
  const all = readAll();
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = { connected: !!v && (!!v.pageToken || !!v.accessToken || !!v.refreshToken || !!v.token), label: v.label || '' };
  }
  return out;
}

module.exports = { readAll, writeAll, getPlatform, setPlatform, summary };

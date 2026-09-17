/*
 * credentials.js — Guardado de credenciales de APIs (Meta, YouTube, TikTok, Threads).
 *
 * Diseñado para NO perder datos nunca (ni con corte de luz ni si alguien borra la carpeta):
 *  - Se guarda en JSON legible: connections.json (carpeta de datos de la app)
 *  - Antes de cada escritura se respalda el actual en connections.bak.json
 *  - La escritura es ATÓMICA (archivo temporal + rename) → si se corta, no corrompe
 *  - ESPEJO en otra carpeta (%LOCALAPPDATA%\CalendarioWoodTools) por si borran la principal
 *  - Instantáneas por día (últimos 20 días) en respaldos-conexiones\
 *  - Si falta o se corrompe el principal, se RESTAURA solo desde la mejor copia disponible
 *  - Nunca se pisa un archivo con datos por uno vacío, ni un campo guardado por un campo vacío
 *  - Migra automáticamente el viejo archivo cifrado (connections.dat) si existía
 *
 * Nota de seguridad: el JSON queda en carpetas del usuario de Windows
 * (solo accesibles por esa cuenta).
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const dir = app.getPath('userData');
const file = path.join(dir, 'connections.json');
const bak = path.join(dir, 'connections.bak.json');
const legacy = path.join(dir, 'connections.dat'); // viejo archivo cifrado
const snapDir = path.join(dir, 'respaldos-conexiones');
const mirrorDir = path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'CalendarioWoodTools');
const mirror = path.join(mirrorDir, 'connections.mirror.json');
const MAX_SNAPSHOTS = 20;

let lastRecovery = null; // { from, at } si hubo que restaurar

function hasData(obj) {
  return !!obj && typeof obj === 'object' && Object.keys(obj).length > 0;
}

function parseFile(p) {
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf-8');
  if (!txt.trim()) return null;
  return JSON.parse(txt); // lanza si está corrupto
}

function tryParse(p) {
  try {
    const d = parseFile(p);
    return hasData(d) ? d : null;
  } catch (e) {
    console.error('[credentials] no se pudo leer', p, '-', e.message);
    return null;
  }
}

function newestSnapshot() {
  try {
    if (!fs.existsSync(snapDir)) return null;
    const files = fs.readdirSync(snapDir).filter((f) => /^conexiones-.*\.json$/.test(f)).sort().reverse();
    for (const f of files) {
      const d = tryParse(path.join(snapDir, f));
      if (d) return { data: d, name: f };
    }
  } catch (_) {}
  return null;
}

function readLegacy() {
  try {
    if (!fs.existsSync(legacy)) return null;
    const raw = fs.readFileSync(legacy);
    if (!raw.length) return null;
    const json = raw[0] === 0x7b
      ? raw.toString('utf-8')
      : (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : null);
    if (!json) return null;
    const d = JSON.parse(json);
    return hasData(d) ? d : null;
  } catch (_) {
    return null; // migración best-effort
  }
}

function readAll() {
  // 1) archivo principal
  const main = tryParse(file);
  if (main) return main;

  // 2) copias, en orden de confianza
  const candidates = [
    () => ({ data: tryParse(bak), from: 'connections.bak.json' }),
    () => ({ data: tryParse(mirror), from: 'espejo en LOCALAPPDATA' }),
    () => { const s = newestSnapshot(); return { data: s && s.data, from: s ? 'instantánea ' + s.name : '' }; },
    () => ({ data: readLegacy(), from: 'connections.dat (viejo)' }),
  ];
  for (const get of candidates) {
    const { data, from } = get();
    if (data) {
      try { writeRaw(data); } catch (e) { console.error('[credentials] no pude restaurar:', e.message); }
      lastRecovery = { from, at: new Date().toISOString() };
      console.warn('[credentials] credenciales restauradas desde', from);
      return data;
    }
  }
  return {};
}

function atomicWrite(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, target);
}

function writeSnapshot(text) {
  try {
    fs.mkdirSync(snapDir, { recursive: true });
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    atomicWrite(path.join(snapDir, `conexiones-${day}.json`), text);
    const files = fs.readdirSync(snapDir).filter((f) => /^conexiones-.*\.json$/.test(f)).sort();
    while (files.length > MAX_SNAPSHOTS) {
      try { fs.unlinkSync(path.join(snapDir, files.shift())); } catch (_) {}
    }
  } catch (e) {
    console.error('[credentials] instantánea falló:', e.message);
  }
}

// Escribe principal + backup + espejo + instantánea del día
function writeRaw(data) {
  const text = JSON.stringify(data, null, 2);
  try { if (fs.existsSync(file)) fs.copyFileSync(file, bak); } catch (_) {}
  atomicWrite(file, text);
  try { atomicWrite(mirror, text); } catch (e) { console.error('[credentials] espejo falló:', e.message); }
  writeSnapshot(text);
}

function writeAll(data) {
  const safe = hasData(data) ? data : {};
  // Nunca reemplazar credenciales existentes por un archivo vacío
  if (!hasData(safe) && hasData(readAll())) {
    console.warn('[credentials] se ignoró una escritura vacía para no perder datos');
    return false;
  }
  writeRaw(safe);
  return true;
}

function getPlatform(p) {
  return readAll()[p] || null;
}

// Guarda una plataforma SIN borrar campos que ya estaban guardados:
// un campo vacío ('' / null / undefined) no pisa un valor existente.
// Para desconectar a propósito usar clearFields() o clearPlatform().
function setPlatform(p, data) {
  const all = readAll();
  const prev = all[p] && typeof all[p] === 'object' ? all[p] : {};
  const next = { ...prev };
  for (const [k, v] of Object.entries(data || {})) {
    const empty = v === '' || v === null || v === undefined;
    if (empty && prev[k] !== undefined && prev[k] !== '' && prev[k] !== null) continue;
    next[k] = v;
  }
  all[p] = next;
  return writeAll(all);
}

// Aplica un cambio en TODAS las copias (principal, backup, espejo e instantáneas).
// Se usa al desconectar/borrar: así un token revocado no puede "volver" desde un respaldo.
function scrubCopies(mutator) {
  const targets = [file, bak, mirror];
  try {
    if (fs.existsSync(snapDir)) {
      for (const f of fs.readdirSync(snapDir)) {
        if (/^conexiones-.*\.json$/.test(f)) targets.push(path.join(snapDir, f));
      }
    }
  } catch (_) {}
  for (const t of targets) {
    try {
      if (!fs.existsSync(t)) continue;
      const d = parseFile(t);
      if (!d || typeof d !== 'object') continue;
      if (mutator(d)) atomicWrite(t, JSON.stringify(d, null, 2));
    } catch (e) {
      console.error('[credentials] no se pudo limpiar una copia:', e.message);
    }
  }
}

// Borra campos puntuales (ej. tokens al desconectar) en todas las copias
function clearFields(p, keys) {
  readAll(); // si faltaba el principal, primero se restaura
  scrubCopies((d) => {
    if (!d[p] || typeof d[p] !== 'object') return false;
    let changed = false;
    for (const k of keys) {
      if (k in d[p]) { delete d[p][k]; changed = true; }
    }
    return changed;
  });
  return true;
}

// Borra una plataforma entera en todas las copias
function clearPlatform(p) {
  readAll();
  scrubCopies((d) => {
    if (!(p in d)) return false;
    delete d[p];
    return true;
  });
  return true;
}

function summary() {
  const all = readAll();
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = { connected: !!v && (!!v.pageToken || !!v.accessToken || !!v.refreshToken || !!v.token || !!v.igToken), label: (v && v.label) || '' };
  }
  return out;
}

function recoveryInfo() {
  return lastRecovery;
}

function paths() {
  return { file, bak, mirror, snapDir };
}

module.exports = { readAll, writeAll, getPlatform, setPlatform, clearFields, clearPlatform, summary, recoveryInfo, paths };

/*
 * credentials.js — Guardado seguro de credenciales de APIs (Meta, YouTube, TikTok).
 * Usa safeStorage de Electron (cifra con la cuenta de Windows del usuario).
 * Si el cifrado no está disponible, cae a texto plano avisando por consola.
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const file = path.join(app.getPath('userData'), 'connections.dat');

function readAll() {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file);
    let json;
    if (safeStorage.isEncryptionAvailable() && raw.length && raw[0] !== 0x7b /* '{' */) {
      json = safeStorage.decryptString(raw);
    } else {
      json = raw.toString('utf-8');
    }
    return JSON.parse(json);
  } catch (e) {
    console.error('[credentials] Error leyendo:', e);
    return {};
  }
}

function writeAll(obj) {
  try {
    const json = JSON.stringify(obj);
    let buf;
    if (safeStorage.isEncryptionAvailable()) {
      buf = safeStorage.encryptString(json);
    } else {
      console.warn('[credentials] safeStorage no disponible: guardando en texto plano.');
      buf = Buffer.from(json, 'utf-8');
    }
    fs.writeFileSync(file, buf);
    return true;
  } catch (e) {
    console.error('[credentials] Error guardando:', e);
    return false;
  }
}

function getPlatform(p) {
  return readAll()[p] || null;
}

function setPlatform(p, data) {
  const all = readAll();
  all[p] = data;
  return writeAll(all);
}

// Devuelve un resumen SIN secretos, para mostrar en la UI
function summary() {
  const all = readAll();
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = {
      connected: !!v && (!!v.pageToken || !!v.accessToken || !!v.refreshToken),
      label: v.label || '',
    };
  }
  return out;
}

module.exports = { readAll, writeAll, getPlatform, setPlatform, summary };

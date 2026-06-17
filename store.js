/*
 * store.js
 * Persistencia local simple en archivo JSON dentro de userData.
 * Sin dependencias nativas: a prueba de balas en Windows.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const dataFile = path.join(app.getPath('userData'), 'calendario-data.json');

const defaultData = { tasks: [], templates: [] };

function read() {
  try {
    if (!fs.existsSync(dataFile)) return { tasks: [], templates: [] };
    const raw = fs.readFileSync(dataFile, 'utf-8');
    const data = JSON.parse(raw);
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      templates: Array.isArray(data.templates) ? data.templates : [],
    };
  } catch (e) {
    console.error('[store] Error leyendo datos:', e);
    return { tasks: [], templates: [] };
  }
}

function write(data) {
  try {
    const safe = {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      templates: Array.isArray(data.templates) ? data.templates : [],
    };
    fs.writeFileSync(dataFile, JSON.stringify(safe, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[store] Error guardando datos:', e);
    return false;
  }
}

module.exports = { read, write, dataFile };

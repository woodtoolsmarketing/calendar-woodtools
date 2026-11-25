/*
 * adsStore.js
 * Guarda localmente las "fotos diarias" del rendimiento de las campañas (Meta/Instagram Ads)
 * y la última sincronización. Así, aunque la PC haya estado apagada, al abrir la app se ve lo
 * último guardado al instante y el sondeo rellena lo que falte desde Meta.
 *
 * Robusto contra pérdida de datos (igual que store.js): escritura ATÓMICA + backup.
 * El TOKEN de anuncios NO se guarda acá: va en credentials.js (platform 'metaAds').
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const dataFile = path.join(app.getPath('userData'), 'ads-data.json');
const bakFile = path.join(app.getPath('userData'), 'ads-data.bak.json');

const MAX_DAYS = 180; // conserva ~6 meses de historial diario

function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    account: d.account && typeof d.account === 'object' ? d.account : null,
    accounts: Array.isArray(d.accounts) ? d.accounts : [],
    // Mapa cuenta->conexión (accountId -> connKey) para resolver el token correcto por cuenta
    // (WoodTools vs Shark). DEBE preservarse: si se pierde, activar/pausar/promocionar una campaña
    // de Shark cae al token de WoodTools y Meta tira "Object ... missing permissions".
    accountConn: d.accountConn && typeof d.accountConn === 'object' ? d.accountConn : {},
    lastSyncAt: Number(d.lastSyncAt) || null,
    lastError: typeof d.lastError === 'string' ? d.lastError : null,
    days: d.days && typeof d.days === 'object' ? d.days : {},
    campaigns: d.campaigns && typeof d.campaigns === 'object' ? d.campaigns : {},
    // Nombres locales para mostrar (alias) por campaña: NO cambian el nombre real en Meta
    aliases: d.aliases && typeof d.aliases === 'object' ? d.aliases : {},
    // Objetivos/metas locales por campaña (ctr, results, spend, reach, impressions)
    objectives: d.objectives && typeof d.objectives === 'object' ? d.objectives : {},
    // Pausas programadas (una vez o semanal). Se ejecutan con la app abierta.
    schedules: Array.isArray(d.schedules) ? d.schedules : [],
    morningNotifiedDay: typeof d.morningNotifiedDay === 'string' ? d.morningNotifiedDay : null,
  };
}

function parseFile(p) {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf-8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function read() {
  try {
    const data = parseFile(dataFile);
    if (data) return normalize(data);
  } catch (e) {
    console.error('[adsStore] principal corrupto, pruebo backup:', e.message);
  }
  try {
    const data = parseFile(bakFile);
    if (data) {
      try { fs.copyFileSync(bakFile, dataFile); } catch (_) {}
      console.warn('[adsStore] restaurado desde backup');
      return normalize(data);
    }
  } catch (e) {
    console.error('[adsStore] backup también falló:', e.message);
  }
  return normalize(null);
}

// Poda el historial para no crecer sin límite
function prune(data) {
  const keys = Object.keys(data.days).sort();
  while (keys.length > MAX_DAYS) {
    const old = keys.shift();
    delete data.days[old];
  }
  return data;
}

function write(data) {
  try {
    const safe = prune(normalize(data));
    try { if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, bakFile); } catch (_) {}
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf-8');
    fs.renameSync(tmp, dataFile);
    return true;
  } catch (e) {
    console.error('[adsStore] Error guardando datos:', e);
    return false;
  }
}

module.exports = { read, write, dataFile };

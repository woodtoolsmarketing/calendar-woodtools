/*
 * tokens.js — Mantenimiento de las conexiones (proceso principal).
 *
 * - Al arrancar (a los 8 s) y cada 6 h revisa todas las redes: renueva tokens cuando toca
 *   y valida la conexión con 1-2 pedidos baratos (lo hace cada integración en su maintain()).
 * - Guarda lo que devuelven (updates) en credentials.js y el último estado (sin secretos)
 *   en userData/api-status.json, para mostrarlo apenas abre la app.
 * - Avisa por notificación cuando hay que reconectar una red (y lo recuerda cada 24 h mientras siga así)
 *   o cuando una conexión vence pronto.
 * - Nunca lanza: cualquier error queda reflejado en el estado de esa red.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const credentials = require('./credentials');
const meta = require('./integrations/meta');
const threads = require('./integrations/threads');
const youtube = require('./integrations/youtube');
const tiktok = require('./integrations/tiktok');

const FIRST_RUN_DELAY_MS = 8 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECONNECT_REMIND_MS = DAY_MS; // recordatorio de "reconectá" como mucho una vez por día

// Orden en que se revisan (secuencial)
const KEYS = ['facebook', 'instagram', 'threads', 'youtube', 'tiktok', 'hosting'];

const DEFS = {
  facebook: { label: 'Facebook', storage: 'meta', maintain: (c) => meta.maintainFacebook(c) },
  instagram: { label: 'Instagram', storage: 'meta', maintain: (c) => meta.maintainInstagram(c) },
  threads: { label: 'Threads', storage: 'threads', maintain: (c) => threads.maintain(c) },
  youtube: { label: 'YouTube', storage: 'youtube', maintain: (c) => youtube.maintain(c) },
  tiktok: { label: 'TikTok', storage: 'tiktok', maintain: (c) => tiktok.maintain(c) },
  hosting: { label: 'Cloudinary', storage: 'hosting', maintain: null },
};

// 'Facebook' → 'facebook'
const NAME_TO_KEY = { Facebook: 'facebook', Instagram: 'instagram', Threads: 'threads', YouTube: 'youtube', TikTok: 'tiktok' };

let statusFile = null;
let last = null;        // STATUS_ALL en memoria
let notifyLog = {};     // { [key]: { expiryDay, lastReminderAt } } — para no repetir avisos
let notifyFn = null;
let onChangeFn = null;
let runAllPromise = null;
let rerunPromise = null;    // revisión completa encolada mientras otra está en curso
const inFlight = new Map(); // key -> Promise (una sola revisión por red a la vez)

// Campos que identifican la conexión guardada: si cambian mientras se revisa
// (se reconectó o desconectó), lo revisado es de la conexión anterior y no se guarda.
// Solo se comparan en memoria; nunca se guardan ni se muestran.
const IDENTITY_FIELDS = {
  facebook: ['pageId', 'pageToken'],
  instagram: ['igToken'],
  threads: ['token'],
  youtube: ['refreshToken'],
  tiktok: ['accessToken', 'refreshToken'],
};

// Conservación de datos (lo que promete la política de privacidad):
// - token revocado o vencido del todo (status.revoked) durante 7 días seguidos → se borran los tokens y los datos de la cuenta
//   (needsReconnect sin revoked — permisos, cliente mal cargado — nunca borra)
// - datos de la cuenta que no se pudieron actualizar en 30 días → se borra el nombre guardado
const REVOKED_PURGE_MS = 7 * DAY_MS;
const STALE_DATA_MS = 30 * DAY_MS;
const PURGE_FIELDS = {
  facebook: ['pageToken', 'pageTokenType', 'pageTokenExpiresAt', 'pageName'],
  instagram: ['igToken', 'igTokenIssuedAt', 'igTokenExpiresAt', 'igLastRefreshAt', 'igUserId', 'igUsername'],
  threads: ['token', 'issuedAt', 'expiresAt', 'lastRefreshAt', 'dataAccessExpiresAt', 'userId', 'username'],
  youtube: ['refreshToken', 'lastRefreshAt', 'needsReconnect', 'channel', 'channelId', 'scope', 'connectedAt'],
  tiktok: ['accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt', 'needsReconnect', 'openId', 'displayName', 'scope', 'firstConsentAt'],
};
const STALE_FIELDS = { facebook: ['pageName'], instagram: ['igUsername'], threads: ['username'], youtube: ['channel'], tiktok: ['displayName'] };
// { [key]: { fp, revokedSince, lastOkAt } } — fp es una huella corta (hash) de la conexión, nunca el token
let retention = {};
let timers = [];

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
function emptyStatus(checkedAt = null) {
  return { ok: false, connected: false, account: null, expiresAt: null, needsReconnect: false, revoked: false, warnings: [], error: null, checkedAt };
}

function toNum(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) || n <= 0 ? null : n;
}

// Revisión sin respuesta clara de la red (sin internet, servicio caído, error puntual): no prueba nada
// sobre el token. No corta la cuenta de 7 días de un token revocado ni cuenta como "se arregló" para los avisos.
const NET_ERROR_RE = /sin conexión a internet|servicio caído/i;
function isInconclusive(status) {
  if (!status || status.ok || status.revoked) return false;
  if (status.error && NET_ERROR_RE.test(String(status.error))) return true;
  return !!status.connected && !status.needsReconnect && !!status.error;
}

// Asegura la forma exacta del objeto STATUS
function normalizeStatus(s) {
  const src = s && typeof s === 'object' ? s : {};
  return {
    ok: !!src.ok,
    connected: !!src.connected,
    account: src.account ? String(src.account) : null,
    expiresAt: toNum(src.expiresAt),
    needsReconnect: !!src.needsReconnect,
    // revoked: el token en sí fue revocado o venció del todo (no un permiso faltante ni un corte de red)
    revoked: !!src.revoked,
    warnings: Array.isArray(src.warnings) ? src.warnings.filter((w) => typeof w === 'string' && w) : [],
    error: src.error ? String(src.error) : null,
    checkedAt: toNum(src.checkedAt) || Date.now(),
  };
}

function defaultAll() {
  const out = {};
  for (const k of KEYS) out[k] = emptyStatus(null);
  out.checkedAt = null;
  out.recovery = null;
  return out;
}

function getStatusFile() {
  if (!statusFile) statusFile = path.join(app.getPath('userData'), 'api-status.json');
  return statusFile;
}

function load() {
  if (last) return;
  last = defaultAll();
  try {
    const f = getStatusFile();
    if (!fs.existsSync(f)) return;
    const txt = fs.readFileSync(f, 'utf-8');
    if (!txt.trim()) return;
    const saved = JSON.parse(txt);
    for (const k of KEYS) {
      if (saved[k] && typeof saved[k] === 'object') {
        last[k] = normalizeStatus(saved[k]);
        last[k].checkedAt = toNum(saved[k].checkedAt); // nunca revisada → null
      }
    }
    last.checkedAt = toNum(saved.checkedAt);
    last.recovery = saved.recovery || null;
    notifyLog = saved.notifyLog && typeof saved.notifyLog === 'object' ? saved.notifyLog : {};
    retention = saved.retention && typeof saved.retention === 'object' ? saved.retention : {};
  } catch (e) {
    console.error('[tokens] no se pudo leer api-status.json:', e.message);
  }
}

function persist() {
  try {
    const f = getStatusFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...last, notifyLog, retention }, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
  } catch (e) {
    console.error('[tokens] no se pudo guardar api-status.json:', e.message);
  }
}

function snapshot() {
  load();
  const out = {};
  for (const k of KEYS) out[k] = { ...last[k], warnings: last[k].warnings.slice() };
  // Cloudinary no usa la red: se calcula al momento con lo guardado (así se ve apenas se guarda)
  out.hosting = hostingStatus(readCreds('hosting'));
  out.checkedAt = last.checkedAt;
  let recovery = null;
  try { recovery = credentials.recoveryInfo() || null; } catch (_) {}
  out.recovery = recovery || last.recovery || null;
  return out;
}

function getAll() {
  return snapshot();
}

// ---------------------------------------------------------------------------
// Cloudinary (sin red)
// ---------------------------------------------------------------------------
function hostingStatus(h) {
  const c = h || {};
  const configured = !!(c.cloudName && c.uploadPreset);
  const warnings = [];
  if (configured && !Number(c.maxVideoMB)) warnings.push('Plan gratis de Cloudinary: videos de hasta 100 MB.');
  return {
    ok: configured,
    connected: configured,
    account: configured ? String(c.cloudName) : null,
    expiresAt: null,
    needsReconnect: false,
    revoked: false,
    warnings,
    error: configured ? null : 'Falta configurar Cloudinary (necesario para Instagram, Threads e historias).',
    checkedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Revisión de una red
// ---------------------------------------------------------------------------
function readCreds(storage) {
  try { return credentials.getPlatform(storage); } catch (_) { return null; }
}

function hasUpdates(u) {
  return !!u && typeof u === 'object' && Object.keys(u).length > 0;
}

function identityOf(key, creds) {
  const c = creds || {};
  return (IDENTITY_FIELDS[key] || []).map((f) => (c[f] === undefined || c[f] === null ? '' : String(c[f]))).join('\n');
}

async function maintainOne(key, attempt = 0) {
  const def = DEFS[key];
  const creds = readCreds(def.storage);
  if (!def.maintain) return { status: hostingStatus(creds), updates: null };
  const identity = identityOf(key, creds);

  let result = null;
  try {
    result = await def.maintain(creds);
  } catch (e) {
    // maintain() no debería lanzar; si pasa, no marcamos reconexión
    const prev = last && last[key];
    result = {
      status: {
        ...emptyStatus(Date.now()),
        connected: !!(prev && prev.connected),
        account: prev ? prev.account : null,
        error: 'No se pudo revisar la conexión de ' + def.label + ': ' + ((e && e.message) || String(e)),
      },
      updates: null,
    };
  }
  // ¿Se reconectó o desconectó la red mientras se revisaba? Entonces lo revisado (y un token
  // renovado de la conexión anterior) no se guarda encima de lo nuevo: se revisa otra vez.
  if (identityOf(key, readCreds(def.storage)) !== identity) {
    if (attempt < 1) return maintainOne(key, attempt + 1);
    const prev = last && last[key];
    return { status: prev ? normalizeStatus(prev) : emptyStatus(Date.now()), updates: null };
  }

  const status = normalizeStatus(result && result.status);
  const updates = result && hasUpdates(result.updates) ? result.updates : null;
  if (updates) {
    try {
      credentials.setPlatform(def.storage, updates);
    } catch (e) {
      console.error('[tokens] no se pudo guardar la renovación de', def.label, '-', e.message);
      status.warnings.push('No se pudo guardar el token renovado de ' + def.label + '. Revisá el espacio en disco.');
    }
  }
  // identity: la conexión tal como quedó guardada (para no borrar datos de una conexión nueva)
  return { status, updates, identity: identityOf(key, readCreds(def.storage)) };
}

// Una sola revisión por red a la vez (evita renovar dos veces el mismo token)
function runOne(key) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = maintainOne(key)
    .then(({ status, identity }) => {
      load();
      let st = status;
      try { st = applyRetention(key, status, identity); } catch (e) { console.error('[tokens] conservación de datos falló:', e.message); }
      const prev = last[key];
      last[key] = st;
      try { maybeNotify(key, prev, st); } catch (e) { console.error('[tokens] aviso falló:', e.message); }
      return st;
    })
    .catch((e) => {
      // Red de seguridad: nunca rechazar
      console.error('[tokens] error revisando', key, '-', e && e.message);
      load();
      return last[key];
    })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

function emitChange() {
  persist();
  if (typeof onChangeFn === 'function') {
    try { onChangeFn(snapshot()); } catch (e) { console.error('[tokens] onChange falló:', e.message); }
  }
}

function runAll() {
  if (runAllPromise) {
    // La revisión en curso pudo leer datos viejos (ej. se acaba de conectar o guardar una red):
    // se repite una vez al terminar, así el estado refleja lo último guardado
    if (!rerunPromise) {
      rerunPromise = runAllPromise.then(() => {
        rerunPromise = null;
        return runAll();
      });
    }
    return rerunPromise;
  }
  runAllPromise = (async () => {
    load();
    for (const key of KEYS) {
      await runOne(key);
    }
    last.checkedAt = Date.now();
    emitChange();
    return snapshot();
  })()
    .catch((e) => {
      console.error('[tokens] runAll falló:', e && e.message);
      return snapshot();
    })
    .finally(() => { runAllPromise = null; });
  return runAllPromise;
}

// Antes de publicar: revisa/renueva solo las redes que se van a usar
async function ensureFresh(platformNames) {
  try {
    load();
    const keys = [];
    for (const name of Array.isArray(platformNames) ? platformNames : []) {
      const k = NAME_TO_KEY[name] || (DEFS[name] ? name : null);
      if (k && k !== 'hosting' && !keys.includes(k)) keys.push(k);
    }
    if (!keys.length) return;
    for (const k of keys) {
      await runOne(k);
    }
    emitChange();
  } catch (e) {
    console.error('[tokens] ensureFresh falló:', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// Conservación de datos (política de privacidad: 7 días si se revocó, 30 días sin actualizar)
// ---------------------------------------------------------------------------
// Huella corta de la conexión: distingue una conexión nueva sin guardar el token
function fingerprint(identity) {
  return crypto.createHash('sha256').update(String(identity)).digest('hex').slice(0, 16);
}

// Borra campos solo si la conexión guardada sigue siendo la que se revisó
function purgeFields(key, fields, identity) {
  const storage = DEFS[key].storage;
  if (identityOf(key, readCreds(storage)) !== identity) return false;
  return credentials.clearFields(storage, fields) !== false;
}

function applyRetention(key, status, identity) {
  if (!DEFS[key] || !DEFS[key].maintain || typeof identity !== 'string') return status;
  const label = DEFS[key].label;
  const now = Date.now();

  // Sin conexión guardada: no hay nada que conservar
  if (!identity.replace(/\n/g, '') || (!status.connected && !status.needsReconnect && !status.revoked)) {
    delete retention[key];
    return status;
  }

  const fp = fingerprint(identity);
  let r = retention[key];
  if (!r || typeof r !== 'object' || r.fp !== fp) {
    r = { fp, revokedSince: null, lastOkAt: null }; // conexión nueva: se empieza a contar de cero
    retention[key] = r;
  }
  // Formato viejo: contaba cualquier "reconectar" (también permisos o cliente mal cargado), no solo tokens revocados
  delete r.reconnectSince;

  // Funciona: se actualizó todo
  if (status.ok && !status.needsReconnect && !status.revoked) {
    r.revokedSince = null;
    r.lastOkAt = now;
    return status;
  }

  // Token revocado o vencido del todo: si sigue así 7 días seguidos se borran los tokens y los datos de la cuenta.
  // Un "reconectar" por otra causa (permisos, Client ID/Secret, red caída) nunca borra nada.
  if (status.revoked) {
    r.revokedSince = toNum(r.revokedSince) || now;
    if (now - r.revokedSince >= REVOKED_PURGE_MS && purgeFields(key, PURGE_FIELDS[key], identity)) {
      delete retention[key];
      sendNotification(
        '🗑️ Se borró la conexión de ' + label,
        'El acceso a ' + label + ' estuvo revocado o vencido más de 7 días: se borraron los tokens y los datos de la cuenta. Para volver a publicar, conectalo de nuevo en ⚙ Conexiones.'
      );
      return {
        ...emptyStatus(now),
        error: 'Se borraron los tokens y los datos de ' + label + ' porque el acceso estuvo revocado o vencido más de 7 días. Conectalo de nuevo en ⚙ Conexiones.',
      };
    }
  } else if (!isInconclusive(status)) {
    r.revokedSince = null; // la red respondió y el token ya no figura revocado: la cuenta de 7 días vuelve a cero
  }
  // (sin internet o servicio caído: no se sabe nada nuevo del token, la cuenta de 7 días sigue como estaba;
  //  el borrado solo ocurre en una revisión que vuelve a confirmar que está revocado)

  // Sin poder verificar (sin internet, error puntual, reconexión pendiente): el nombre guardado vale 30 días
  const lastOk = toNum(r.lastOkAt);
  if (lastOk && now - lastOk >= STALE_DATA_MS && purgeFields(key, STALE_FIELDS[key], identity)) {
    r.lastOkAt = null; // no repetir el borrado; la próxima verificación buena lo vuelve a completar
    return {
      ...status,
      account: null,
      warnings: status.warnings.concat('No se pudo verificar ' + label + ' en 30 días: se borró el nombre de la cuenta guardado. Revisá la conexión.'),
    };
  }
  return status;
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(ms) {
  try {
    return new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return new Date(ms).toISOString();
  }
}

function sendNotification(title, body) {
  if (typeof notifyFn !== 'function') return;
  try { notifyFn(title, body); } catch (e) { console.error('[tokens] notify falló:', e.message); }
}

// Fecha de vencimiento que importa para avisar (TikTok: el refresh token, que dura 1 año)
function expiryForNotice(key, status) {
  if (key === 'hosting' || key === 'youtube') return null;
  if (key === 'tiktok') {
    const t = readCreds('tiktok');
    return toNum(t && t.refreshExpiresAt);
  }
  return status.expiresAt;
}

// Aviso extra si el token está revocado: cuántos días faltan para que se borren los datos guardados
function purgeHint(key, status, now) {
  if (!status.revoked) return '';
  const since = toNum(retention[key] && retention[key].revokedSince);
  if (!since) return '';
  const days = Math.max(1, Math.ceil((since + REVOKED_PURGE_MS - now) / DAY_MS));
  return '\nSi no lo reconectás, en ' + days + (days === 1 ? ' día' : ' días') + ' se borran los tokens y los datos guardados de la cuenta.';
}

function maybeNotify(key, prev, status) {
  if (key === 'hosting') return;
  const label = DEFS[key].label;
  if (!notifyLog[key] || typeof notifyLog[key] !== 'object') notifyLog[key] = {};
  const log = notifyLog[key];
  // Ya no hace falta reconectar: el próximo aviso de reconexión arranca de cero.
  // Una revisión sin respuesta clara (sin internet, servicio caído) no cuenta como arreglado.
  if (!status.needsReconnect && !isInconclusive(status)) delete log.lastReminderAt;

  const everConfigured = status.connected || status.needsReconnect;
  if (!everConfigured) return; // nada para redes que nunca se configuraron

  const now = Date.now();

  // Necesita reconexión: aviso al pasar a ese estado y después un recordatorio cada 24 h
  // (lastReminderAt se guarda en api-status.json, así no se repite al reiniciar la app)
  if (status.needsReconnect) {
    const lastAt = toNum(log.lastReminderAt);
    // Ya se avisó hace menos de 24 h por este mismo problema (sin una revisión buena en el medio,
    // ej. se cortó internet un rato): no repetir
    if (lastAt && lastAt <= now && now - lastAt < RECONNECT_REMIND_MS) return;
    const isNew = !lastAt && !(prev && prev.needsReconnect);
    log.lastReminderAt = now;
    sendNotification(
      '⚠️ Reconectá ' + label,
      (isNew ? '' : 'Recordatorio: ' + label + ' sigue sin poder publicar. ') + 'Reconectá ' + label + ' en ⚙ Conexiones.'
        + purgeHint(key, status, now) + (status.error ? '\n' + status.error : '')
    );
    return;
  }

  // Vence dentro de 7 días (como mucho un aviso por día por red)
  const exp = expiryForNotice(key, status);
  if (exp && exp - now < EXPIRY_WARN_MS) {
    const today = dayKey(now);
    if (notifyLog[key].expiryDay === today) return;
    notifyLog[key].expiryDay = today;
    const vencio = exp <= now;
    sendNotification(
      '⏳ ' + label + (vencio ? ': la conexión venció' : ': la conexión vence pronto'),
      (vencio ? 'Venció el ' : 'Vence el ') + formatDate(exp) + '. Abrí ⚙ Conexiones y reconectá ' + label + ' para que no se corten las publicaciones.'
    );
  }
}

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
function init({ notify, onChange } = {}) {
  notifyFn = notify || null;
  onChangeFn = onChange || null;
  load();
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers = [];
  timers.push(setTimeout(() => { runAll(); }, FIRST_RUN_DELAY_MS));
  timers.push(setInterval(() => { runAll(); }, INTERVAL_MS));

  // Al volver de suspensión la PC pudo estar horas apagada: revisar de nuevo
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('resume', () => {
      setTimeout(() => { runAll(); }, 30 * 1000);
    });
  } catch (_) {}
}

module.exports = { init, runAll, ensureFresh, getAll };

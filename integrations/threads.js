/*
 * integrations/threads.js — Conexión, mantenimiento del token y publicación en Threads
 * (API de Meta para Threads). Corre en el proceso principal de Electron (fetch global).
 *
 * Credenciales guardadas (clave "threads"):
 *   { appId, appSecret, token, userId, username, issuedAt, expiresAt, lastRefreshAt,
 *     dataAccessExpiresAt, redirectUri }   (fechas en ms)
 *
 * Tokens de Threads:
 *  - El token de larga duración dura 60 días. Se RENUEVA SIN App Secret
 *    (th_refresh_token) cuando tiene al menos 24 h; cada renovación da otros 60 días
 *    y, si el perfil es público, extiende también el permiso de datos (90 días).
 *  - El App Secret solo se usa UNA vez: para canjear el código de autorización y
 *    convertir el primer token (dura 1 hora) en uno de 60 días (th_exchange_token).
 *  - Si pasan 60 días sin renovar, el token muere y hay que volver a conectar.
 *
 * Publicación: contenedor (POST /{user}/threads) → esperar estado FINISHED →
 * POST /{user}/threads_publish. Las imágenes y videos necesitan URL pública
 * (Cloudinary; main.js la deja en task.mediaUrl).
 * Límites: 500 caracteres (los emojis cuentan como bytes), 5 enlaces por posteo,
 * 250 posteos cada 24 h, video hasta 5 minutos y 1 GB.
 */
const hosting = require('./hosting');

const TH_HOST = 'https://graph.threads.net';
const TH = `${TH_HOST}/v1.0`;
const AUTHORIZE_URL = 'https://threads.com/oauth/authorize';
const DEFAULT_REDIRECT_URI = 'https://calendario-woodtools.onrender.com/oauth/callback.html';
const SCOPES = 'threads_basic,threads_content_publish';
const REQUIRED_SCOPES = ['threads_basic', 'threads_content_publish'];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_TEXT = 500;
const MAX_LINKS = 5;
const MAX_VIDEO_SEC = 300;
const MAX_VIDEO_BYTES = 1000 * 1000 * 1000;
const NET_ERROR = 'Sin conexión a internet o servicio caído';

const EMPTY_TEXT_ERROR = 'Threads: escribí el epígrafe (texto) para publicar.';
const AMBIGUOUS_ERROR = 'Threads no confirmó la publicación (se cortó la conexión). Puede que se haya publicado: revisalo antes de volver a intentar.';
const CONFIRMED_AFTER_CUT = 'Se confirmó la publicación después de un corte de conexión.';

// Códigos de la Graph API que conviene reintentar más tarde
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613]);
// Error 190: subcódigos que indican que el token en sí se revocó o venció del todo
const REVOKED_SUBCODES = new Set([458, 460, 463, 467]);
// Error 190: Meta pide verificar la cuenta (checkpoint); el token no está revocado
const CHECKPOINT_SUBCODES = new Set([459, 464]);
// Fallas de red en las que el pedido no llegó a salir (seguro reintentar)
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

// Motivos que devuelve GET /{contenedor}?fields=status,error_message cuando status = ERROR
const CONTAINER_ERRORS = {
  FAILED_DOWNLOADING_VIDEO: 'Threads no pudo descargar el video desde Cloudinary.',
  FAILED_PROCESSING_AUDIO: 'Threads no pudo procesar el audio del video. Exportalo con audio AAC (48 kHz, mono o estéreo).',
  FAILED_PROCESSING_VIDEO: 'Threads no pudo procesar el video. Exportalo como MP4 (H.264 + AAC).',
  INVALID_ASPEC_RATIO: 'La proporción del video no es válida para Threads (máximo 10:1; se recomienda 9:16).',
  INVALID_ASPECT_RATIO: 'La proporción del video no es válida para Threads (máximo 10:1; se recomienda 9:16).',
  INVALID_BIT_RATE: 'El video tiene un bitrate demasiado alto para Threads (máximo 100 Mbps).',
  INVALID_DURATION: 'La duración del video no es válida para Threads (hasta 5 minutos).',
  INVALID_FRAME_RATE: 'Los cuadros por segundo del video no son válidos para Threads (entre 23 y 60 fps).',
  INVALID_AUDIO_CHANNELS: 'El audio del video tiene demasiados canales para Threads (usá mono o estéreo).',
  INVALID_AUDIO_CHANNEL_LAYOUT: 'La distribución de canales de audio no es válida para Threads (usá mono o estéreo).',
};
const TRANSIENT_CONTAINER_ERRORS = new Set(['FAILED_DOWNLOADING_VIDEO']);

// Emojis y sus modificadores: Threads los cuenta como bytes UTF-8
const EMOJI_CHAR = /[\p{Extended_Pictographic}‍︎️⃣]/u;
const LINK_RE = /(?<![\w@])(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;

// Tokens renovados en esta sesión: token viejo → { token, issuedAt, expiresAt, lastRefreshAt }.
// Evita usar un token ya reemplazado si alguien llama con credenciales leídas antes de guardar.
const replacedTokens = new Map();
const maintainInFlight = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// HTTP y errores
// --------------------------------------------------------------------------
function thError(message, extra) {
  const err = new Error(message);
  if (extra) Object.assign(err, extra);
  return err;
}

// Código de la falla de red de fetch (undici lo deja en err.cause.code)
function causeCode(e) {
  const c = e && e.cause;
  const first = c && Array.isArray(c.errors) && c.errors[0];
  return String((c && c.code) || (first && first.code) || (e && e.code) || '');
}

// responded: ya había respuesta del servidor (se cortó leyendo el cuerpo) → el pedido sí llegó
function networkError(cause, responded) {
  const preSend = !responded && PRE_SEND_CODES.has(causeCode(cause));
  return thError(NET_ERROR, { transient: true, network: true, preSend });
}

// ¿El token en sí fue revocado o venció del todo? (no permisos, checkpoints, roles ni cortes de red)
function isRevokedToken(code, subcode, message) {
  if (Number(code) !== 190) return false;
  const sub = Number(subcode) || 0;
  if (REVOKED_SUBCODES.has(sub)) return true;
  return !sub && /expired|session is invalid|invalid session|session has been invalidated/i.test(String(message || ''));
}

// Convierte el objeto "error" de la Graph API en un Error con mensaje en castellano y banderas
function apiError(errObj, httpStatus) {
  const e = errObj || {};
  const code = Number(e.code) || 0;
  const subcode = Number(e.error_subcode) || 0;
  const type = String(e.type || '');
  const raw = String(e.message || e.error_user_title || 'error desconocido');
  const userMsg = e.error_user_msg ? String(e.error_user_msg) : '';
  const extra = { code, subcode, type, httpStatus, apiMessage: raw };

  let blob = `${raw} ${type} ${e.error_user_title || ''} ${userMsg}`;
  try { blob += ' ' + JSON.stringify(e.error_data || ''); } catch (_) {}
  if (/THREADS_API__LINK_LIMIT_EXCEEDED/i.test(blob)) {
    return thError('Threads rechazó el posteo porque tiene más de 5 enlaces (contando el enlace adjunto). Dejá como máximo 5.', extra);
  }

  const tokenInvalid = code === 190 || code === 102 ||
    (type === 'OAuthException' && !TRANSIENT_CODES.has(code) && (httpStatus === 401 ||
      /access token|session has expired|session is invalid/i.test(raw)));
  if (tokenInvalid) {
    let msg = 'El acceso a Threads ya no es válido (token vencido o revocado). Reconectá Threads en ⚙ Conexiones.';
    if (subcode === 463) msg = 'El token de Threads venció. Reconectá Threads en ⚙ Conexiones.';
    else if (CHECKPOINT_SUBCODES.has(subcode)) msg = 'Meta pide verificar la cuenta de Threads: entrá a Threads o Instagram, resolvé el aviso de seguridad y después reconectá Threads en ⚙ Conexiones.';
    else if (subcode === 458) msg = 'Se quitó el permiso de la app en la cuenta de Threads. Reconectá Threads en ⚙ Conexiones.';
    else if (subcode === 460) msg = 'Cambió la contraseña de la cuenta de Threads. Reconectá Threads en ⚙ Conexiones.';
    else if (/expired/i.test(raw)) msg = 'El token de Threads venció. Reconectá Threads en ⚙ Conexiones.';
    // Con HTTP 5xx no se confirma nada sobre el token (servicio caído): nunca se marca revocado
    const revoked = !(httpStatus >= 500) && isRevokedToken(code, subcode, raw);
    return thError(msg, { ...extra, needsReconnect: true, tokenInvalid: true, revoked });
  }

  if (code === 10 || (code >= 200 && code <= 299)) {
    return thError(`A la conexión de Threads le falta un permiso (${userMsg || raw}). Reconectá Threads aceptando threads_basic y threads_content_publish.`,
      { ...extra, needsReconnect: true });
  }

  if (RATE_LIMIT_CODES.has(code) || httpStatus === 429) {
    return thError('Threads limitó las consultas o publicaciones por un rato. Se reintenta más tarde.', { ...extra, transient: true, rateLimited: true });
  }
  if (TRANSIENT_CODES.has(code) || e.is_transient === true || httpStatus >= 500) {
    return thError(`Threads tuvo un error temporal (${userMsg || raw}). Se reintenta más tarde.`, { ...extra, transient: true });
  }
  return thError(`Threads: ${userMsg || raw}${code ? ` (código ${code})` : ''}`, extra);
}

function httpError(status) {
  if (status >= 500) {
    return thError('Threads no responde (servicio caído o en mantenimiento). Se reintenta más tarde.', { transient: true, network: true, httpStatus: status });
  }
  if (status === 429) {
    return thError('Threads limitó las consultas o publicaciones por un rato. Se reintenta más tarde.', { transient: true, rateLimited: true, httpStatus: status });
  }
  if (status === 401) {
    return thError('El acceso a Threads ya no es válido (token vencido o revocado). Reconectá Threads en ⚙ Conexiones.', { needsReconnect: true, tokenInvalid: true, httpStatus: status });
  }
  return thError(`Threads respondió con un error (HTTP ${status}).`, { httpStatus: status });
}

// GET: parámetros en la URL. POST: formulario. Nunca se loguea la URL (lleva el token).
async function thRequest(method, url, params, token) {
  const u = new URL(url);
  const data = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') data.append(k, String(v));
  }
  if (token) data.append('access_token', token);
  const init = { method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (method === 'GET') data.forEach((v, k) => u.searchParams.append(k, v));
  else init.body = data;

  let res;
  let text = '';
  try {
    res = await fetch(u, init);
  } catch (e) {
    throw networkError(e, false);
  }
  try {
    text = await res.text();
  } catch (e) {
    throw networkError(e, true);
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let json = null;
  if (ctype.includes('json') || /^\s*[{[]/.test(text)) {
    try { json = JSON.parse(text); } catch (_) { json = null; }
  }
  if (json && typeof json === 'object') {
    if (json.error && typeof json.error === 'object') throw apiError(json.error, res.status);
    // Formato OAuth estilo Instagram. Ojo: el estado del contenedor trae "error_message" normal (con HTTP 200)
    if (json.error_type || (!res.ok && json.error_message)) {
      throw apiError({ type: json.error_type, message: json.error_message, code: json.code }, res.status);
    }
    if (typeof json.error === 'string') {
      throw apiError({ message: json.error_description || json.error }, res.status);
    }
  }
  if (!res.ok) throw httpError(res.status);
  if (!json || typeof json !== 'object') {
    throw thError(`Threads respondió algo inesperado (HTTP ${res.status}). Se reintenta más tarde.`, { transient: true, unexpected: true, httpStatus: res.status });
  }
  return json;
}

// --------------------------------------------------------------------------
// Utilidades de token
// --------------------------------------------------------------------------
function secToMs(sec) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

function toMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (_) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function cleanToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^(bearer\s+|access_token=)/i, '')
    .replace(/\s+/g, '');
}

function rememberReplacement(oldToken, fresh) {
  for (const [k, v] of replacedTokens) {
    if (v.token === oldToken) replacedTokens.set(k, fresh);
  }
  replacedTokens.set(oldToken, fresh);
}

function currentToken(token) {
  const r = token ? replacedTokens.get(token) : null;
  return r ? r.token : token;
}

// debug_token con el mismo token (sirve porque la cuenta es Tester de la app)
async function debugToken(token) {
  const json = await thRequest('GET', `${TH}/debug_token`, { input_token: token }, token);
  return json && json.data && typeof json.data === 'object' ? json.data : null;
}

// Token de 1 hora → token de 60 días. ÚNICO uso del App Secret.
async function exchangeLongLived(shortToken, appSecret) {
  const json = await thRequest('GET', `${TH_HOST}/access_token`, {
    grant_type: 'th_exchange_token',
    client_secret: appSecret,
  }, shortToken);
  if (!json.access_token) throw thError('Threads no devolvió el token de larga duración.');
  return json;
}

// Renovación: no necesita App Secret
async function refreshLongLived(token) {
  const json = await thRequest('GET', `${TH_HOST}/refresh_access_token`, { grant_type: 'th_refresh_token' }, token);
  if (!json.access_token) throw thError('Threads no devolvió el token renovado.');
  return json;
}

function checkScopes(dbg) {
  const scopes = dbg && Array.isArray(dbg.scopes) ? dbg.scopes : null;
  if (!scopes || !scopes.length) return;
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) {
    throw thError(`Al token de Threads le faltan permisos: ${missing.join(', ')}. Volvé a conectar (o a generar el token) aceptando esos permisos.`);
  }
}

// Arma el objeto de credenciales a guardar a partir de un token de larga duración
async function buildConnection(token, opts) {
  const o = opts || {};
  const now = Date.now();
  let dbg = o.dbg;
  if (dbg === undefined) {
    try {
      dbg = await debugToken(token);
    } catch (e) {
      if (e.network) throw e;
      dbg = null; // opcional: /me decide si el token sirve
    }
  }
  if (dbg && dbg.is_valid === false) {
    throw thError('El token de Threads no es válido o ya venció. Generá uno nuevo.', { needsReconnect: true, tokenInvalid: true });
  }
  checkScopes(dbg);

  const me = await thRequest('GET', `${TH}/me`, { fields: 'id,username' }, token);
  const userId = String((me && me.id) || (dbg && dbg.user_id) || o.fallbackUserId || '');
  if (!userId) throw thError('Threads no devolvió el ID de la cuenta. Volvé a intentar.');

  const issuedAt = o.issuedAt || secToMs(dbg && dbg.issued_at) || now;
  const expiresAt = o.expiresAt || secToMs(dbg && dbg.expires_at) || (now + 60 * DAY);
  return {
    token,
    userId,
    username: (me && me.username) || null,
    issuedAt,
    expiresAt,
    lastRefreshAt: issuedAt,
    dataAccessExpiresAt: secToMs(dbg && dbg.data_access_expires_at),
  };
}

function withHint(e, hint) {
  if (e && e.network) return e;
  return thError(`${(e && e.message) || 'Error desconocido.'} ${hint}`);
}

// --------------------------------------------------------------------------
// Conectar (OAuth en ventana embebida) y pegar token
// --------------------------------------------------------------------------
async function connect(creds) {
  const c = creds || {};
  if (!c.appId || !c.appSecret) {
    throw new Error('Para conectar Threads cargá el ID y la clave secreta de la app de Threads (developers.facebook.com → Casos de uso → Acceder a la API de Threads → Personalizar → Configuración). No son los de Facebook.');
  }
  const redirectUri = c.redirectUri || DEFAULT_REDIRECT_URI;
  const { authorizeEmbedded, randomState } = require('./oauth'); // requiere Electron: se carga recién acá
  const state = randomState();

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('client_id', c.appId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);

  const { params } = await authorizeEmbedded({ authUrl: authUrl.toString(), redirectUri, state, title: 'Conectar Threads' });
  const code = params && params.code;
  if (!code) throw new Error('Threads no devolvió el código de autorización. Volvé a intentar.');

  // 1) código → token de 1 hora
  let short;
  try {
    short = await thRequest('POST', `${TH_HOST}/oauth/access_token`, {
      client_id: c.appId,
      client_secret: c.appSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }, null);
  } catch (e) {
    throw withHint(e, `Revisá que la URL de redirección (${redirectUri}) esté cargada tal cual en la configuración de Threads de la app, que el ID y la clave secreta sean los de Threads y que la cuenta haya aceptado la invitación de "Tester de Threads" (Threads → Configuración → Cuenta → Permisos de sitios web → Invitaciones).`);
  }
  if (!short || !short.access_token) throw new Error('Threads no devolvió el token de acceso. Volvé a intentar.');

  // 2) token de 1 hora → token de 60 días (único uso del App Secret)
  let long;
  try {
    long = await exchangeLongLived(short.access_token, c.appSecret);
  } catch (e) {
    throw withHint(e, 'No se pudo convertir el token en uno de 60 días: revisá la clave secreta de la app de Threads.');
  }
  const now = Date.now();
  return buildConnection(long.access_token, {
    issuedAt: now,
    expiresAt: Number(long.expires_in) > 0 ? now + Number(long.expires_in) * 1000 : null,
    fallbackUserId: short.user_id,
  });
}

async function normalizeToken(creds, pastedToken) {
  const c = creds || {};
  const token = cleanToken(pastedToken);
  if (!token) throw new Error('Pegá el token de acceso de Threads.');
  if (/^EAA/.test(token)) {
    throw new Error('Ese token es de Facebook, no de Threads. Generalo en la configuración de Threads de la app (Generador de tokens de usuario).');
  }
  if (/^IG/.test(token)) {
    throw new Error('Ese token es de Instagram, no de Threads. Generalo en la configuración de Threads de la app (Generador de tokens de usuario).');
  }

  let dbg = null;
  try {
    dbg = await debugToken(token);
  } catch (e) {
    if (e.network) throw e;
    if (e.tokenInvalid) throw new Error('El token de Threads no es válido o ya venció. Generá uno nuevo y pegalo otra vez.');
    dbg = null; // debug_token es opcional; /me valida más abajo
  }
  if (dbg && dbg.is_valid === false) {
    throw new Error('El token de Threads no es válido o ya venció. Generá uno nuevo y pegalo otra vez.');
  }
  checkScopes(dbg);

  const now = Date.now();
  const dbgExpires = secToMs(dbg && dbg.expires_at);
  const shortLived = !!dbgExpires && dbgExpires - now < 2 * HOUR;

  if (shortLived && !c.appSecret) {
    throw new Error('Ese token es de corta duración (vence en menos de 2 horas). Cargá la clave secreta de la app de Threads y guardá para convertirlo en uno de 60 días, o pegá un token de larga duración.');
  }
  if (c.appSecret && (shortLived || !dbgExpires)) {
    try {
      const long = await exchangeLongLived(token, c.appSecret);
      const t = Date.now();
      return await buildConnection(long.access_token, {
        issuedAt: t,
        expiresAt: Number(long.expires_in) > 0 ? t + Number(long.expires_in) * 1000 : null,
        fallbackUserId: dbg && dbg.user_id,
      });
    } catch (e) {
      if (shortLived) {
        if (e.network) throw e;
        throw new Error(`Ese token es de corta duración (dura 1 hora) y no se pudo convertir en uno de 60 días: ${e.message} Revisá la clave secreta de la app de Threads.`);
      }
      // Si no sabíamos el tipo, probablemente ya era de larga duración: seguimos con el pegado
    }
  }

  return buildConnection(token, {
    dbg,
    issuedAt: secToMs(dbg && dbg.issued_at) || now,
    expiresAt: dbgExpires,
  });
}

// --------------------------------------------------------------------------
// Mantenimiento (renovación + verificación). Nunca lanza.
// --------------------------------------------------------------------------
function makeStatus(checkedAt, fields) {
  return Object.assign({
    ok: false, connected: false, account: null, expiresAt: null,
    needsReconnect: false, revoked: false, warnings: [], error: null, checkedAt,
  }, fields || {});
}

function expiryWarnings(expiresAt, dataAccessExpiresAt, now) {
  const w = [];
  if (expiresAt && expiresAt - now < 7 * DAY) {
    w.push(expiresAt <= now
      ? `El token de Threads venció el ${fmtDate(expiresAt)}. Reconectá Threads en ⚙ Conexiones.`
      : `El token de Threads vence el ${fmtDate(expiresAt)}. Si no se renueva solo, reconectá Threads.`);
  }
  if (dataAccessExpiresAt && dataAccessExpiresAt - now < 7 * DAY) {
    w.push(`El permiso de la app para usar tu cuenta de Threads vence el ${fmtDate(dataAccessExpiresAt)}. Mantené el perfil de Threads público (así se extiende solo al renovar) o reconectá Threads.`);
  }
  return w;
}

async function runMaintain(c, checkedAt) {
  const now = checkedAt;
  const updates = {};
  const warnings = [];
  let token = c.token;
  let issuedAt = toMs(c.issuedAt);
  let expiresAt = toMs(c.expiresAt);
  let lastRefreshAt = toMs(c.lastRefreshAt);
  let dataAccessExpiresAt = toMs(c.dataAccessExpiresAt);
  let userId = c.userId ? String(c.userId) : null;
  let username = c.username || null;

  const account = () => (username ? '@' + username : userId);
  const pendingUpdates = () => (Object.keys(updates).length ? updates : null);
  const fail = (e) => {
    warnings.push(...expiryWarnings(expiresAt, dataAccessExpiresAt, now));
    if (e && e.needsReconnect) {
      return {
        status: makeStatus(checkedAt, {
          connected: false, account: account(), expiresAt, needsReconnect: true, revoked: !!e.revoked, warnings, error: e.message,
        }),
        updates: pendingUpdates(),
      };
    }
    return {
      status: makeStatus(checkedAt, {
        connected: true, account: account(), expiresAt, warnings,
        error: !e || e.network || e.httpStatus >= 500 ? NET_ERROR : e.message,
      }),
      updates: pendingUpdates(),
    };
  };

  // 1) Tokens guardados sin fechas (versiones viejas): se consultan una vez
  if (!issuedAt || !expiresAt) {
    try {
      const d = await debugToken(token);
      if (d && d.is_valid === false) {
        const de = (d.error && typeof d.error === 'object') ? d.error : {};
        const exp = secToMs(d.expires_at) || expiresAt;
        throw thError('El acceso a Threads ya no es válido (token vencido o revocado). Reconectá Threads en ⚙ Conexiones.', {
          needsReconnect: true,
          tokenInvalid: true,
          revoked: isRevokedToken(de.code, de.subcode || de.error_subcode, de.message) || (!!exp && exp <= now),
        });
      }
      if (d) {
        if (!issuedAt && secToMs(d.issued_at)) issuedAt = updates.issuedAt = secToMs(d.issued_at);
        if (!expiresAt && secToMs(d.expires_at)) expiresAt = updates.expiresAt = secToMs(d.expires_at);
        const da = secToMs(d.data_access_expires_at);
        if (da && da !== dataAccessExpiresAt) dataAccessExpiresAt = updates.dataAccessExpiresAt = da;
        if (!userId && d.user_id) userId = updates.userId = String(d.user_id);
      }
    } catch (e) {
      // debug_token es opcional: un error de permiso acá no significa que el token no sirva
      if (e.tokenInvalid || e.network) return fail(e);
    }
    // Edad desconocida: se cuenta desde hoy (renovar un token de menos de 24 h falla)
    if (!issuedAt) issuedAt = updates.issuedAt = now;
  }

  // 2) Renovar si corresponde: >= 24 h de antigüedad y (>= 7 días desde la última o < 30 días de vida)
  let refreshed = false;
  const age = now - issuedAt;
  const sinceRefresh = now - (lastRefreshAt || issuedAt);
  const due = age >= DAY && (sinceRefresh >= 7 * DAY || (!!expiresAt && expiresAt - now < 30 * DAY));
  if (due) {
    try {
      const r = await refreshLongLived(token);
      const t = Date.now();
      const fresh = {
        token: r.access_token,
        issuedAt: t,
        expiresAt: Number(r.expires_in) > 0 ? t + Number(r.expires_in) * 1000 : t + 60 * DAY,
        lastRefreshAt: t,
      };
      rememberReplacement(token, fresh);
      Object.assign(updates, fresh);
      ({ token, issuedAt, expiresAt, lastRefreshAt } = fresh);
      refreshed = true;
    } catch (e) {
      if (e.needsReconnect || e.network) return fail(e);
      warnings.push(`No se pudo renovar el token de Threads (${e.message}). Se vuelve a intentar en unas horas.`);
    }
  }

  // 3) Verificar (barato): tras renovar, debug_token trae el nuevo vencimiento del permiso de datos
  try {
    if (refreshed) {
      try {
        const d = await debugToken(token);
        const da = secToMs(d && d.data_access_expires_at);
        if (da && da !== dataAccessExpiresAt) dataAccessExpiresAt = updates.dataAccessExpiresAt = da;
        if (d && d.user_id && !userId) userId = updates.userId = String(d.user_id);
      } catch (e) {
        if (e.tokenInvalid || e.network) throw e; // un error de permiso en debug_token no invalida el token recién renovado
      }
    }
    if (!refreshed || !username || !userId) {
      const me = await thRequest('GET', `${TH}/me`, { fields: 'id,username' }, token);
      if (me.id && String(me.id) !== userId) userId = updates.userId = String(me.id);
      if (me.username && me.username !== username) username = updates.username = me.username;
    }
  } catch (e) {
    return fail(e);
  }

  warnings.push(...expiryWarnings(expiresAt, dataAccessExpiresAt, now));
  return {
    status: makeStatus(checkedAt, {
      ok: true, connected: true, account: account(), expiresAt: expiresAt || null, warnings,
    }),
    updates: pendingUpdates(),
  };
}

async function maintain(creds) {
  const checkedAt = Date.now();
  try {
    const stored = creds || {};
    if (!stored.token) return { status: makeStatus(checkedAt), updates: null };

    // Si el token guardado ya se renovó en esta sesión, seguimos con el nuevo
    const carried = replacedTokens.get(stored.token) || null;
    const c = carried ? { ...stored, ...carried } : stored;

    // Una sola ejecución a la vez por token (el arranque y el timer no deben renovar dos veces)
    let p = maintainInFlight.get(c.token);
    if (!p) {
      p = runMaintain(c, checkedAt).finally(() => maintainInFlight.delete(c.token));
      maintainInFlight.set(c.token, p);
    }
    const out = await p;
    if (carried) return { status: out.status, updates: { ...carried, ...(out.updates || {}) } };
    return out;
  } catch (e) {
    return {
      status: makeStatus(checkedAt, {
        connected: true,
        error: e && (e.network || e.httpStatus >= 500) ? NET_ERROR : `No se pudo verificar Threads: ${(e && e.message) || 'error desconocido'}`,
      }),
      updates: null,
    };
  }
}

// --------------------------------------------------------------------------
// Publicación
// --------------------------------------------------------------------------

// Largo según Threads: cada carácter cuenta 1, los emojis cuentan sus bytes UTF-8 (cota superior)
function threadsLength(text) {
  let n = 0;
  for (const ch of text) {
    n += (ch.codePointAt(0) > 0xFFFF || EMOJI_CHAR.test(ch)) ? Buffer.byteLength(ch, 'utf8') : 1;
  }
  return n;
}

function linkKey(url) {
  return String(url || '')
    .trim()
    .replace(/[.,;:!?)\]}'"»]+$/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function textLinks(text) {
  const set = new Set();
  for (const m of text.match(LINK_RE) || []) {
    const k = linkKey(m);
    if (k) set.add(k);
  }
  return set;
}

// ¿El texto ya menciona este enlace (con o sin https://www.)? Respeta bordes: "x.com" no coincide con "fx.com"
// y ".../tienda" no coincide con ".../tienda-2".
function textHasLink(text, key) {
  if (!key) return false;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w@.\\/-])(?:https?:\\/\\/)?(?:www\\.)?${esc}\\/*(?![\\w\\/%-])`, 'i');
  return re.test(text);
}

function cleanLink(link) {
  const s = String(link || '').trim();
  if (!s) return '';
  const full = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try {
    const u = new URL(full);
    return u.hostname.includes('.') ? full : '';
  } catch (_) {
    return '';
  }
}

// 'image' | 'video' | null (texto). Prioriza task.mediaKind; si no, la extensión del archivo.
function resolveKind(task) {
  let kind = task.mediaKind ? String(task.mediaKind).toLowerCase() : null;
  if (!kind && task.mediaPath) kind = hosting.mediaKind(task.mediaPath);
  if (!kind && task.mediaInfo && task.mediaInfo.kind) kind = String(task.mediaInfo.kind).toLowerCase();
  if (!kind && task.mediaUrl) {
    let p = String(task.mediaUrl);
    try { p = new URL(task.mediaUrl).pathname; } catch (_) {}
    kind = hosting.mediaKind(p) || 'image';
  }
  if (kind === 'webm') throw thError('Threads no acepta videos .webm. Exportalo como MP4 (H.264 + AAC).');
  if (kind && kind !== 'image' && kind !== 'video') kind = null;
  if (!kind && task.mediaPath) {
    const ext = (String(task.mediaPath).match(/\.[^.\\/]+$/) || ['(sin extensión)'])[0];
    throw thError(`Threads no acepta ese formato de archivo (${ext}). Usá JPG/PNG o MP4/MOV.`);
  }
  return kind;
}

function validateVideo(info) {
  if (!info) return;
  const dur = Number(info.duration);
  if (dur > MAX_VIDEO_SEC) {
    const mins = Math.floor(dur / 60);
    const secs = String(Math.floor(dur % 60)).padStart(2, '0');
    throw thError(`El video dura ${mins}:${secs} min y Threads acepta hasta 5 minutos. Recortalo antes de publicarlo.`);
  }
  const bytes = Number(info.bytes);
  if (bytes > MAX_VIDEO_BYTES) {
    throw thError(`El video pesa ${(bytes / 1e9).toFixed(2)} GB y Threads acepta hasta 1 GB.`);
  }
}

// Arma los parámetros del contenedor y valida texto/enlaces (sin recortar nada)
function buildPost(task, warnings) {
  const kind = resolveKind(task);
  const mediaType = kind === 'video' ? 'VIDEO' : (kind === 'image' ? 'IMAGE' : 'TEXT');
  // Solo el epígrafe: nunca se publican las notas internas ni el título de la tarea
  const text = String(task.caption || '').trim();
  const params = { media_type: mediaType };

  let link = '';
  if (task.link && String(task.link).trim()) {
    link = cleanLink(task.link);
    if (!link) warnings.push('El link de la tarea no es una dirección web válida; no se agregó en Threads.');
  }

  if (mediaType !== 'TEXT') {
    if (!task.mediaUrl) {
      throw thError('Falta la URL pública del archivo para Threads. Revisá la configuración de Cloudinary en ⚙ Conexiones.');
    }
    if (mediaType === 'VIDEO') {
      validateVideo(task.mediaInfo);
      params.video_url = task.mediaUrl;
    } else {
      params.image_url = task.mediaUrl;
    }
  } else if (!text) {
    throw thError(EMPTY_TEXT_ERROR);
  }

  const len = threadsLength(text);
  if (len > MAX_TEXT) {
    throw thError(`El texto para Threads tiene ${len} caracteres y el máximo es ${MAX_TEXT} (los emojis cuentan como varios). Acortalo: no se recorta automáticamente.`);
  }

  const found = textLinks(text);
  const key = link ? linkKey(link) : '';
  const inText = !!key && (found.has(key) || textHasLink(text, key));
  let attach = false;
  if (link && !inText) {
    if (mediaType === 'TEXT') attach = true;
    else warnings.push('Threads no permite enlace adjunto en posteos con imagen o video: el link no se agregó (si lo querés, ponelo en el texto).');
  }
  const totalLinks = found.size + (attach ? 1 : 0);
  if (totalLinks > MAX_LINKS) {
    throw thError(`Threads permite hasta ${MAX_LINKS} enlaces por posteo y este tiene ${totalLinks}${attach ? ' (contando el link de la tarea)' : ''}. Sacá algunos.`);
  }

  if (text) params.text = text;
  if (attach) params.link_attachment = link;
  if (/historia/i.test(String(task.contentType || ''))) {
    warnings.push('Threads no tiene historias: se publica como posteo común.');
  }
  return { params, mediaType };
}

// Cupo de 250 posteos cada 24 h. Opcional: si la consulta falla, se intenta publicar igual.
async function checkQuota(userId, token) {
  let json;
  try {
    json = await thRequest('GET', `${TH}/${userId}/threads_publishing_limit`, { fields: 'quota_usage,config' }, token);
  } catch (e) {
    if (e.tokenInvalid || e.network) throw e;
    return;
  }
  const row = json && Array.isArray(json.data) ? json.data[0] : null;
  if (!row) return;
  const usage = Number(row.quota_usage);
  const total = Number(row.config && row.config.quota_total);
  if (Number.isFinite(usage) && Number.isFinite(total) && total > 0 && usage >= total) {
    throw thError(`Llegaste al límite de Threads (${total} publicaciones cada 24 horas). Se reintenta más tarde.`, { transient: true, rateLimited: true });
  }
}

function containerError(errorMessage) {
  const raw = String(errorMessage || '').trim();
  const upper = raw.toUpperCase();
  const known = CONTAINER_ERRORS[upper] ? upper : Object.keys(CONTAINER_ERRORS).find((k) => upper.includes(k));
  const msg = known ? CONTAINER_ERRORS[known] : `Threads no pudo procesar el posteo${raw ? ` (${raw})` : ''}.`;
  return thError(msg, { transient: !!known && TRANSIENT_CONTAINER_ERRORS.has(known), containerError: raw || null });
}

// TEXT: 3 s y se consulta. IMAGE/VIDEO: 20 s y después cada 30 s, hasta 5 minutos.
async function waitContainer(containerId, token, mediaType) {
  const isText = mediaType === 'TEXT';
  const interval = isText ? 5000 : 30000;
  const maxMs = isText ? 2 * 60 * 1000 : 5 * 60 * 1000;
  const started = Date.now();
  await sleep(isText ? 3000 : 20000);

  let lastErr = null;
  for (;;) {
    let st = null;
    try {
      st = await thRequest('GET', `${TH}/${containerId}`, { fields: 'status,error_message' }, token);
      lastErr = null;
    } catch (e) {
      if (!e.transient) throw e;
      lastErr = e; // corte momentáneo: se vuelve a consultar
    }
    if (st) {
      const status = String(st.status || '').toUpperCase();
      if (!status || status === 'FINISHED' || status === 'PUBLISHED') return status || 'FINISHED';
      if (status === 'ERROR') throw containerError(st.error_message);
      if (status === 'EXPIRED') {
        throw thError('El contenedor de Threads venció antes de publicarse. Se reintenta más tarde.', { transient: true });
      }
    }
    if (Date.now() - started + interval > maxMs) break;
    await sleep(interval);
  }
  if (lastErr) throw lastErr;
  throw thError(isText
    ? 'Threads no terminó de preparar el posteo a tiempo. Se reintenta más tarde.'
    : 'Threads sigue procesando el archivo después de 5 minutos. Se reintenta más tarde.', { transient: true });
}

// Tras un corte al publicar: consulta unas veces el estado del contenedor.
// 'PUBLISHED' | 'FINISHED' | 'EXPIRED' (según la última consulta) | null (no se sabe)
async function statusAfterCut(containerId, token) {
  let last = null;
  for (const wait of [5000, 10000, 15000]) {
    await sleep(wait);
    try {
      const st = await thRequest('GET', `${TH}/${containerId}`, { fields: 'status' }, token);
      last = String((st && st.status) || '').toUpperCase() || null;
    } catch (_) {
      last = null;
      continue;
    }
    if (last === 'PUBLISHED') return last;
  }
  return last === 'FINISHED' || last === 'EXPIRED' ? last : null;
}

// Publica el contenedor. Si no hay confirmación (corte después de enviar, 5xx o respuesta sin ID),
// revisa el estado del contenedor: nunca se informa "reintentable" si pudo haberse publicado.
async function publishContainer(userId, containerId, token) {
  let failure;
  try {
    const pub = await thRequest('POST', `${TH}/${userId}/threads_publish`, { creation_id: containerId }, token);
    if (pub && pub.id) return { id: String(pub.id) };
    failure = thError('Threads no devolvió el ID de la publicación.');
  } catch (e) {
    // Error "desconocido/temporal" de Meta (códigos 1 y 2 o is_transient) aunque venga con HTTP 4xx:
    // tampoco confirma si se publicó, así que se verifica igual
    const uncertain = !!e.unexpected || (!!e.network && !e.preSend) || e.httpStatus >= 500 ||
      (!!e.transient && !e.rateLimited && !e.network);
    // Rechazo explícito (token, permisos, límites) o el pedido no llegó a salir: se informa tal cual
    if (!uncertain || e.needsReconnect) throw e;
    failure = e;
  }

  const status = await statusAfterCut(containerId, token);
  if (status === 'PUBLISHED') return { id: null, confirmedAfterCut: true };
  if (status === 'FINISHED' || status === 'EXPIRED') {
    // El contenedor sigue sin publicar: es seguro reintentar más tarde
    throw thError(failure.transient ? failure.message : 'Threads no publicó el posteo. Se reintenta más tarde.', { transient: true });
  }
  throw thError(AMBIGUOUS_ERROR, { ambiguous: true });
}

// Busca el posteo recién publicado cuando se perdió la respuesta (para guardar su ID y enlace). Opcional.
async function findRecentPost(userId, token, text, since) {
  try {
    const json = await thRequest('GET', `${TH}/${userId}/threads`, { fields: 'id,permalink,text,timestamp', limit: 5 }, token);
    const rows = json && Array.isArray(json.data) ? json.data : [];
    const want = String(text || '').trim();
    const hit = rows.find((p) => {
      const at = Date.parse(String((p && p.timestamp) || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
      return p && p.id && Number.isFinite(at) && at >= since && String(p.text || '').trim() === want;
    });
    if (!hit) return null;
    const out = { id: String(hit.id) };
    if (hit.permalink) out.url = hit.permalink;
    return out;
  } catch (_) {
    return null;
  }
}

async function publishForTask(creds, task) {
  const warnings = [];
  const result = (fields) => {
    const r = { platform: 'Threads', ...fields };
    if (warnings.length) r.warnings = warnings;
    return r;
  };
  try {
    const c = creds || {};
    const t = task || {};
    const token = currentToken(c.token);
    if (!token) {
      return result({ error: 'Threads no está conectado. Conectalo en ⚙ Conexiones.', needsReconnect: true });
    }

    const post = buildPost(t, warnings);

    let userId = c.userId ? String(c.userId) : '';
    if (!userId) {
      const me = await thRequest('GET', `${TH}/me`, { fields: 'id' }, token);
      userId = me && me.id ? String(me.id) : '';
      if (!userId) throw thError('No pude obtener el ID de la cuenta de Threads. Reconectá Threads.', { needsReconnect: true });
    }

    await checkQuota(userId, token);

    const containerAt = Date.now();
    const container = await thRequest('POST', `${TH}/${userId}/threads`, post.params, token);
    if (!container || !container.id) {
      throw thError('Threads no creó el contenedor del posteo. Se reintenta más tarde.', { transient: true });
    }
    await waitContainer(container.id, token, post.mediaType);

    const pub = await publishContainer(userId, container.id, token);
    if (pub.confirmedAfterCut) {
      warnings.push(CONFIRMED_AFTER_CUT);
      const found = await findRecentPost(userId, token, post.params.text, containerAt - 2 * 60 * 1000);
      return result(found || {});
    }

    const out = { id: pub.id };
    try {
      const m = await thRequest('GET', `${TH}/${pub.id}`, { fields: 'permalink' }, token);
      if (m && m.permalink) out.url = m.permalink;
    } catch (_) { /* el enlace es opcional */ }
    return result(out);
  } catch (e) {
    const fields = { error: (e && e.message) || 'Error desconocido al publicar en Threads.' };
    if (e && e.ambiguous) {
      // Puede haberse publicado: no reintentar automáticamente
      fields.transient = false;
      fields.ambiguous = true;
      return result(fields);
    }
    if (e && e.transient) fields.transient = true;
    if (e && e.needsReconnect) fields.needsReconnect = true;
    return result(fields);
  }
}

module.exports = { connect, normalizeToken, maintain, publishForTask };

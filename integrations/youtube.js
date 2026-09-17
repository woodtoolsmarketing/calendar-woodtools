/*
 * integrations/youtube.js — Subida y programación de videos en YouTube (Data API v3).
 * Corre en el proceso principal de Electron.
 *
 * Credenciales guardadas (objeto "youtube"):
 *   { clientId, clientSecret, refreshToken, channel, channelId, scope, connectedAt,
 *     lastRefreshAt, needsReconnect, auditApproved }
 *
 * - Login de Google con el NAVEGADOR DEL SISTEMA (loopback 127.0.0.1 + PKCE S256).
 *   Google bloquea los navegadores embebidos, por eso no se usa una ventana de Electron.
 * - El video se sube DIRECTO desde el archivo local con subida reanudable (partes de 8 MiB).
 * - Programación nativa: si la tarea es "public" y la fecha es futura (+15 min), se sube
 *   como "private" con publishAt.
 * - Políticas de YouTube (III.C.3): nunca se recorta ni se modifica el título o la
 *   descripción sin que el usuario lo pida. '#Shorts' solo se agrega si la tarea lo pide.
 * - El access token vive solo en memoria; el refresh token lo guarda tokens.js/main.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const oauth = require('./oauth');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
const SCOPES = [SCOPE_UPLOAD, SCOPE_READONLY];

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TOKEN_SAFETY_MS = 5 * MINUTE_MS;          // renovar el access token 5 min antes de que venza
const SCHEDULE_MIN_AHEAD_MS = 15 * MINUTE_MS;   // programar solo si falta más de 15 min
const API_TIMEOUT_MS = 30 * 1000;
const CHUNK_TIMEOUT_MS = 5 * MINUTE_MS;
const THUMB_TIMEOUT_MS = 3 * MINUTE_MS;
const CHUNK_SIZE = 8 * 1024 * 1024;             // múltiplo de 256 KiB, como pide Google
const MAX_UPLOAD_RETRIES = 5;
const INIT_ATTEMPTS = 3;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024 * 1024;
const THUMB_MAX_BYTES = 50 * 1024 * 1024;
const TITLE_MAX_CHARS = 100;
const DESCRIPTION_MAX_BYTES = 5000;

const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
};
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i;

const NET_MSG = 'Sin conexión a internet o servicio caído';
const RECONNECT_MSG = 'Google revocó o venció el acceso de YouTube. Reconectá YouTube.';
const NOT_CONNECTED_MSG = 'YouTube no está conectado. Conectalo en ⚙ Conexiones.';
const MISSING_CLIENT_MSG = 'Falta el Client ID o el Client Secret de Google. Cargalos en ⚙ Conexiones.';
const NO_CHANNEL_MSG = 'La cuenta de Google conectada no tiene un canal de YouTube. Creá el canal o reconectá eligiendo la cuenta correcta (si el canal es de una cuenta de marca, elegila en la pantalla de Google).';
const API_DISABLED_MSG = 'La "YouTube Data API v3" no está habilitada en tu proyecto de Google Cloud. Habilitala en APIs y servicios > Biblioteca y volvé a intentar.';
const AUDIT_WARNING = 'Proyecto de Google sin auditoría de YouTube: los videos subidos por la API quedan PRIVADOS hasta que Google apruebe la auditoría.';
const LOCK_WARNING = 'YouTube dejó el video en PRIVADO: el proyecto de Google todavía no pasó la auditoría de la API.';
const CLIENT_CHECK_MSG = 'Revisá el Client ID y el Client Secret de Google en Conexiones';
const AMBIGUOUS_UPLOAD_MSG = 'YouTube recibió el video pero no confirmó. Revisá YouTube Studio antes de volver a intentar para no duplicarlo.';
const CONFIRMED_AFTER_CUT = 'Se confirmó la publicación después de un corte de conexión.';

// Fallas de red en las que el pedido no llegó a salir (no pudo crear nada)
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function tagged(err, flags) {
  return Object.assign(err, flags || {});
}

function netError() {
  return tagged(new Error(NET_MSG), { transient: true, network: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Espera exponencial con un poco de azar: 1 s, 2 s, 4 s, 8 s, 16 s (+ hasta 0,5 s)
function backoffMs(attempt) {
  return Math.min(32000, 1000 * Math.pow(2, Math.max(0, attempt - 1))) + Math.floor(Math.random() * 500);
}

// true si fetch falló ANTES de mandar el pedido (sin conexión, DNS, no se pudo conectar)
function isPreSendFailure(err) {
  const seen = new Set();
  const queue = [err];
  while (queue.length) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    if (e.code && PRE_SEND_CODES.has(String(e.code))) return true;
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors);
  }
  return false;
}

// fetch con tiempo límite; devuelve null si falla la red (nunca lanza).
// info (opcional) recibe info.preSend = true si el pedido no llegó a salir.
async function safeFetch(url, opts, timeoutMs, info) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs || API_TIMEOUT_MS) });
  } catch (e) {
    if (info) info.preSend = isPreSendFailure(e);
    return null;
  }
}

// Subida con resultado desconocido: no se reintenta sola (duplicaría el video)
function ambiguousUploadError() {
  return tagged(new Error(AMBIGUOUS_UPLOAD_MSG), { ambiguous: true, transient: false });
}

async function readJson(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}

async function drain(res) {
  try { await res.arrayBuffer(); } catch (_) { /* nada */ }
}

function hasText(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function cacheKey(refreshToken) {
  return crypto.createHash('sha256').update(String(refreshToken)).digest('hex');
}

function makeStatus(fields) {
  return Object.assign({
    ok: false,
    connected: false,
    account: null,
    expiresAt: null,
    needsReconnect: false,
    revoked: false,
    warnings: [],
    error: null,
    checkedAt: Date.now(),
  }, fields || {});
}

// Motivos de error de Google (errors[].reason, details[].reason y status)
function errorReasons(json) {
  const e = json && json.error;
  if (!e || typeof e !== 'object') return [];
  const out = [];
  (Array.isArray(e.errors) ? e.errors : []).forEach((x) => { if (x && x.reason) out.push(String(x.reason)); });
  (Array.isArray(e.details) ? e.details : []).forEach((x) => { if (x && x.reason) out.push(String(x.reason)); });
  if (e.status) out.push(String(e.status));
  return out;
}

function errorMessage(json) {
  const e = json && json.error;
  const msg = e && typeof e === 'object' ? e.message : (json && (json.error_description || json.error));
  return String(msg || '').replace(/<[^>]*>/g, '').slice(0, 200);
}

// Traduce un error de la API de YouTube a un Error en castellano con banderas transient/needsReconnect
function apiError(status, json) {
  const reasons = errorReasons(json);
  const has = (...r) => r.some((x) => reasons.includes(x));
  const detail = errorMessage(json);

  if (has('quotaExceeded', 'dailyLimitExceeded')) {
    return tagged(new Error('Se agotó la cuota diaria de la API de YouTube (se renueva a la medianoche, hora del Pacífico). Se va a reintentar más tarde.'), { transient: true });
  }
  if (has('uploadLimitExceeded')) {
    return tagged(new Error('Tu canal llegó al límite diario de subidas de YouTube. Se va a reintentar más tarde (puede tardar hasta 24 h).'), { transient: true });
  }
  if (status === 429 || has('rateLimitExceeded', 'userRateLimitExceeded', 'uploadRateLimitExceeded', 'RATE_LIMIT_EXCEEDED')) {
    return tagged(new Error('YouTube está limitando los pedidos por ahora. Se va a reintentar más tarde.'), { transient: true });
  }
  if (has('invalidPublishAt')) {
    return tagged(new Error('YouTube rechazó la fecha de publicación programada (tiene que ser futura). Revisá la fecha y la visibilidad de la tarea.'));
  }
  if (has('invalidTitle')) {
    return tagged(new Error('YouTube rechazó el título: máximo 100 caracteres y sin los signos < ni >. Corregilo en la tarea.'));
  }
  if (has('invalidDescription')) {
    return tagged(new Error('YouTube rechazó la descripción: máximo 5000 bytes y sin los signos < ni >. Corregila en la tarea.'));
  }
  if (has('invalidTags')) {
    return tagged(new Error('YouTube rechazó las etiquetas del video. Revisalas en la tarea.'));
  }
  if (has('forbiddenPrivacySetting')) {
    return tagged(new Error('YouTube no permite la visibilidad elegida para este video. Elegí otra en la tarea.'));
  }
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) {
    return tagged(new Error(API_DISABLED_MSG));
  }
  if (has('youtubeSignupRequired', 'channelNotFound')) {
    return tagged(new Error(NO_CHANNEL_MSG), { needsReconnect: true });
  }
  if (has('insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
    return tagged(new Error('Falta el permiso para subir videos a YouTube. Reconectá YouTube y tildá todos los permisos.'), { needsReconnect: true });
  }
  if (status === 401 || has('authError')) {
    return tagged(new Error('Google rechazó el acceso a YouTube. Reconectá YouTube.'), { needsReconnect: true });
  }
  if (status >= 500) {
    return tagged(new Error(`YouTube tuvo un error temporal (HTTP ${status}). Se va a reintentar más tarde.`), { transient: true });
  }
  return tagged(new Error(`YouTube rechazó el pedido (HTTP ${status})` + (detail ? ': ' + detail : '.')));
}

// ---------------------------------------------------------------------------
// Tokens (solo en memoria)
// ---------------------------------------------------------------------------

const tokenCache = new Map();   // hash(refreshToken) -> { accessToken, expiresAt }
const tokenInflight = new Map();

async function refreshAccessToken(creds) {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await safeFetch(TOKEN_URL, { method: 'POST', body }, API_TIMEOUT_MS);
  if (!res || res.status >= 500) throw netError();
  const json = await readJson(res);
  if (res.status === 429) {
    throw tagged(new Error('Google está limitando los pedidos por ahora. Se va a reintentar más tarde.'), { transient: true });
  }
  if (!json) {
    throw tagged(new Error(`Google respondió algo inesperado al renovar el acceso (HTTP ${res.status}).`), { transient: true });
  }
  if (json.error) {
    // Solo invalid_grant significa que el refresh token fue revocado o venció
    if (json.error === 'invalid_grant') throw tagged(new Error(RECONNECT_MSG), { needsReconnect: true, revoked: true });
    if (json.error === 'invalid_client' || json.error === 'unauthorized_client') {
      throw tagged(new Error('Google rechazó el Client ID o el Client Secret (¿se borró o cambió el cliente OAuth?). Revisalos en ⚙ Conexiones y reconectá YouTube.'), { needsReconnect: true, clientProblem: true });
    }
    if (json.error === 'deleted_client' || json.error === 'disabled_client') {
      // Google borra los clientes OAuth sin uso durante 6 meses
      throw tagged(new Error('Google borró o desactivó el cliente OAuth de YouTube. Creá uno nuevo (tipo "App de escritorio") en Google Cloud, cargá sus datos en ⚙ Conexiones y reconectá YouTube.'), { needsReconnect: true, clientProblem: true, clientGone: true });
    }
    if (json.error === 'temporarily_unavailable') throw netError();
    throw tagged(new Error('Google: ' + (json.error_description || json.error)));
  }
  if (!json.access_token) {
    throw tagged(new Error('Google no devolvió un token de acceso. Se va a reintentar más tarde.'), { transient: true });
  }
  return { accessToken: json.access_token, expiresIn: Number(json.expires_in) || 3600 };
}

/*
 * Devuelve un access token válido (cacheado en memoria hasta 5 min antes de vencer).
 * opts.force = true ignora la caché (la usa maintain para comprobar el refresh token).
 * Errores: err.needsReconnect (invalid_grant, cliente inválido), err.transient (red/5xx).
 */
async function getAccessToken(creds, opts = {}) {
  if (!creds || !creds.refreshToken) throw tagged(new Error(NOT_CONNECTED_MSG), { needsReconnect: true });
  if (!creds.clientId || !creds.clientSecret) throw tagged(new Error(MISSING_CLIENT_MSG));
  const key = cacheKey(creds.refreshToken);
  const hit = tokenCache.get(key);
  if (!opts.force && hit && hit.expiresAt - TOKEN_SAFETY_MS > Date.now()) return hit.accessToken;
  if (tokenInflight.has(key)) return tokenInflight.get(key);

  const p = refreshAccessToken(creds)
    .then((r) => {
      tokenCache.set(key, { accessToken: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000 });
      return r.accessToken;
    })
    .catch((e) => {
      if (e.needsReconnect) tokenCache.delete(key);
      throw e;
    })
    .finally(() => tokenInflight.delete(key));
  tokenInflight.set(key, p);
  return p;
}

function forgetAccessToken(refreshToken) {
  if (refreshToken) tokenCache.delete(cacheKey(refreshToken));
}

// ---------------------------------------------------------------------------
// Canal
// ---------------------------------------------------------------------------

async function fetchChannel(accessToken) {
  const res = await safeFetch(`${API_BASE}/channels?part=snippet&mine=true`, {
    headers: { Authorization: 'Bearer ' + accessToken },
  }, API_TIMEOUT_MS);
  if (!res) throw netError();
  const json = await readJson(res);
  if (!res.ok) throw apiError(res.status, json);
  const item = json && Array.isArray(json.items) ? json.items[0] : null;
  if (!item || !item.id) throw tagged(new Error(NO_CHANNEL_MSG), { needsReconnect: true });
  return { channelId: item.id, channel: (item.snippet && item.snippet.title) || '' };
}

// ---------------------------------------------------------------------------
// Conectar (login de Google en el navegador del sistema)
// ---------------------------------------------------------------------------

function connectTokenError(status, json) {
  const err = json && json.error;
  if (err === 'invalid_client' || err === 'unauthorized_client') {
    return 'Google rechazó el Client ID o el Client Secret. Revisá que sean del cliente OAuth de tipo "App de escritorio" y volvé a intentar.';
  }
  if (err === 'deleted_client' || err === 'disabled_client') {
    return 'Google borró o desactivó ese cliente OAuth. Creá uno nuevo (tipo "App de escritorio") en Google Cloud y cargá sus datos en ⚙ Conexiones.';
  }
  if (err === 'invalid_grant') return 'Google rechazó el código de autorización (venció o ya se usó). Volvé a tocar Conectar.';
  if (err === 'redirect_uri_mismatch') return 'El cliente OAuth de Google no es de tipo "App de escritorio". Creá uno de ese tipo y cargá sus datos en ⚙ Conexiones.';
  if (status >= 500) return NET_MSG;
  if (err) return 'Google: ' + ((json && json.error_description) || err);
  return `Google respondió algo inesperado al conectar (HTTP ${status}).`;
}

async function revokeToken(token) {
  const res = await safeFetch(REVOKE_URL, { method: 'POST', body: new URLSearchParams({ token }) }, 15000);
  if (res) await drain(res);
}

/*
 * Revoca (best-effort) el refresh token anterior SOLO si pertenece a OTRO canal.
 * Google revoca la autorización completa de la cuenta para este cliente: si el token viejo
 * es de la misma cuenta, revocarlo invalidaría también el token nuevo recién obtenido.
 */
async function revokeOldIfOtherChannel(creds, newChannelId) {
  const old = creds.refreshToken;
  if (!newChannelId) return;
  // Si el canal guardado coincide, no revocar (en la duda, nunca revocar). Si no coincide o falta,
  // se comprueba EN VIVO con el token viejo: el channelId guardado puede haber quedado desactualizado
  // y revocar por error mataría también el token nuevo de la misma cuenta.
  if (creds.channelId && creds.channelId === newChannelId) return;
  let oldChannelId = '';
  try {
    const at = await getAccessToken(creds);
    oldChannelId = (await fetchChannel(at)).channelId;
  } catch (_) {
    return; // token viejo muerto (no hace falta revocarlo) o no se pudo comprobar
  } finally {
    forgetAccessToken(old);
  }
  if (!oldChannelId || oldChannelId === newChannelId) return;
  try { await revokeToken(old); } catch (_) { /* best-effort */ }
}

async function connect(creds) {
  if (!creds || !creds.clientId || !creds.clientSecret) {
    throw new Error('Falta el Client ID o el Client Secret de Google. Cargalos en ⚙ Conexiones, guardá y volvé a tocar Conectar.');
  }

  let auth;
  try {
    auth = await oauth.authorizeLoopback({
      authBaseUrl: AUTH_URL,
      clientId: creds.clientId,
      scope: SCOPES.join(' '),
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      pkce: true,
      pkceEncoding: 'base64url',
      useSystemBrowser: true,
    });
  } catch (e) {
    if (/access_denied/i.test((e && e.message) || '')) {
      throw new Error('No se aceptaron los permisos en Google. Volvé a tocar Conectar y aceptá los permisos de YouTube.');
    }
    throw e;
  }

  const body = new URLSearchParams({
    code: auth.code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret, // Google lo exige para clientes de escritorio aunque se use PKCE
    redirect_uri: auth.redirectUri,
    grant_type: 'authorization_code',
  });
  if (auth.codeVerifier) body.set('code_verifier', auth.codeVerifier);

  const res = await safeFetch(TOKEN_URL, { method: 'POST', body }, API_TIMEOUT_MS);
  if (!res) throw new Error(NET_MSG);
  const json = await readJson(res);
  if (!res.ok || !json || json.error) throw new Error(connectTokenError(res.status, json));
  if (!json.refresh_token) {
    throw new Error('Google no devolvió un refresh token. Quitá el acceso de la app en myaccount.google.com/permissions y volvé a conectar.');
  }
  if (!json.access_token) throw new Error('Google no devolvió un token de acceso. Volvé a intentar.');

  // Con el consentimiento granular el usuario puede destildar permisos: el "scope" de la respuesta manda
  const granted = String(json.scope || '').split(/\s+/).filter(Boolean);
  if (granted.length && !SCOPES.every((s) => granted.includes(s))) {
    throw new Error('En la pantalla de Google no quedaron tildados todos los permisos de YouTube (subir videos y ver tu canal). Volvé a tocar Conectar y tildá todas las casillas.');
  }

  const now = Date.now();
  tokenCache.set(cacheKey(json.refresh_token), {
    accessToken: json.access_token,
    expiresAt: now + (Number(json.expires_in) || 3600) * 1000,
  });

  let channel = '';
  let channelId = '';
  try {
    const ch = await fetchChannel(json.access_token);
    channel = ch.channel;
    channelId = ch.channelId;
  } catch (e) {
    if (!e.transient) throw new Error(e.message); // sin canal, API deshabilitada, permisos
  }

  if (creds.refreshToken && creds.refreshToken !== json.refresh_token) {
    forgetAccessToken(creds.refreshToken);
    await revokeOldIfOtherChannel(creds, channelId);
  }

  return {
    refreshToken: json.refresh_token,
    channel,
    channelId,
    scope: json.scope || SCOPES.join(' '),
    connectedAt: now,
    // Sin canal (falla pasajera de channels.list): 0 obliga a maintain a comprobarlo en la próxima pasada
    lastRefreshAt: channelId ? now : 0,
    needsReconnect: false,
  };
}

// ---------------------------------------------------------------------------
// Mantenimiento (lo llama tokens.js)
// ---------------------------------------------------------------------------

async function maintain(creds) {
  const checkedAt = Date.now();
  try {
    if (!creds || !creds.refreshToken) return { status: makeStatus({ checkedAt }), updates: null };

    const account = creds.channel || null;
    const warnings = [];
    if (!creds.auditApproved) warnings.push(AUDIT_WARNING);

    if (!creds.clientId || !creds.clientSecret) {
      return {
        status: makeStatus({ connected: true, account, needsReconnect: !!creds.needsReconnect, warnings, error: MISSING_CLIENT_MSG, checkedAt }),
        updates: null,
      };
    }

    const last = Number(creds.lastRefreshAt) || 0;
    const due = !!creds.needsReconnect || !last || checkedAt - last >= DAY_MS;
    if (!due) {
      return { status: makeStatus({ ok: true, connected: true, account, warnings, checkedAt }), updates: null };
    }

    // Renovación real (mantiene vivo el refresh token: Google lo borra tras 6 meses sin uso)
    let accessToken;
    try {
      accessToken = await getAccessToken(creds, { force: true });
    } catch (e) {
      if (e.needsReconnect) {
        let error = e.message;
        const outWarnings = warnings.slice();
        if (e.clientProblem) {
          // Cliente OAuth rechazado (datos mal cargados, borrado o desactivado): el token no se revocó
          error = CLIENT_CHECK_MSG;
          if (e.clientGone) outWarnings.push(e.message);
        } else if (e.revoked) {
          const age = checkedAt - (Number(creds.connectedAt) || 0);
          if (creds.connectedAt && age > 6.5 * DAY_MS && age < 9 * DAY_MS) {
            error += ' Si tu proyecto de Google está en modo "Prueba" (Testing), el acceso vence a los 7 días: pasalo a "En producción" en Google Auth Platform > Público.';
          }
        }
        return {
          status: makeStatus({ connected: false, account, needsReconnect: true, revoked: !!e.revoked, warnings: outWarnings, error, checkedAt }),
          updates: { needsReconnect: true },
        };
      }
      return {
        status: makeStatus({ connected: true, account, needsReconnect: !!creds.needsReconnect, warnings, error: e.message, checkedAt }),
        updates: null,
      };
    }

    const updates = { lastRefreshAt: Date.now(), needsReconnect: false };
    try {
      const ch = await fetchChannel(accessToken);
      if (ch.channel) updates.channel = ch.channel;
      updates.channelId = ch.channelId;
      return { status: makeStatus({ ok: true, connected: true, account: ch.channel || account, warnings, checkedAt }), updates };
    } catch (e) {
      if (e.needsReconnect) {
        return {
          status: makeStatus({ connected: false, account, needsReconnect: true, warnings, error: e.message, checkedAt }),
          updates: { lastRefreshAt: updates.lastRefreshAt, needsReconnect: true },
        };
      }
      // El refresh anduvo: un fallo pasajero de channels.list no invalida la conexión
      if (e.transient) return { status: makeStatus({ ok: true, connected: true, account, warnings, checkedAt }), updates };
      return { status: makeStatus({ connected: true, account, warnings, error: e.message, checkedAt }), updates };
    }
  } catch (e) {
    return {
      status: makeStatus({
        connected: !!(creds && creds.refreshToken),
        account: (creds && creds.channel) || null,
        error: 'YouTube: ' + ((e && e.message) || 'error inesperado'),
        checkedAt,
      }),
      updates: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Subida reanudable
// ---------------------------------------------------------------------------

async function startUploadSession(creds, size, mime, metadata) {
  const url = `${UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`;
  let authRetried = false;
  for (let attempt = 1; ; attempt++) {
    const accessToken = await getAccessToken(creds);
    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': mime,
      },
      body: JSON.stringify(metadata),
      redirect: 'manual',
    }, API_TIMEOUT_MS);

    if (res && res.ok) {
      const location = res.headers.get('location');
      await drain(res);
      if (!location) throw tagged(new Error('YouTube no devolvió la dirección de subida. Se va a reintentar más tarde.'), { transient: true });
      return location;
    }
    if (res && res.status === 401 && !authRetried) {
      authRetried = true;
      await drain(res);
      forgetAccessToken(creds.refreshToken);
      attempt--;
      continue;
    }
    if ((!res || res.status >= 500) && attempt < INIT_ATTEMPTS) {
      if (res) await drain(res);
      await sleep(backoffMs(attempt));
      continue;
    }
    if (!res) throw netError();
    throw apiError(res.status, await readJson(res));
  }
}

function readChunk(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (!n) throw new Error('No se pudo leer el archivo de video completo (¿se movió o cambió durante la subida?).');
    done += n;
  }
  return buf;
}

// "bytes=0-8388607" -> 8388608 (próximo byte a mandar); sin Range -> 0
function nextOffset(rangeHeader) {
  const m = /bytes=(\d+)-(\d+)/i.exec(rangeHeader || '');
  return m ? Number(m[2]) + 1 : 0;
}

async function resumableUpload(creds, filePath, size, mime, metadata) {
  // Abrir el archivo ANTES de crear la sesión: si está bloqueado no se gasta una subida de la cuota
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    throw new Error('No se pudo abrir el archivo de video (¿está abierto en otro programa o se movió?): ' + filePath);
  }
  try {
    const uploadUrl = await startUploadSession(creds, size, mime, metadata);
    let offset = 0;
    let highWater = 0;      // máximo de bytes confirmados por YouTube (solo avanzar acá reinicia los reintentos)
    let failures = 0;
    let authRetries = 0;
    let needStatus = false; // true = preguntar a YouTube cuántos bytes recibió antes de seguir
    let lastProblem = null;
    // true = la última parte (o el video entero) pudo llegar a YouTube sin confirmación. Si no se aclara,
    // el resultado es AMBIGUO: no se reintenta solo para no duplicar el video.
    let finalSent = false;

    for (;;) {
      let accessToken = null;
      try {
        accessToken = await getAccessToken(creds);
      } catch (e) {
        if (!e.transient) {
          // Sin poder preguntar a YouTube y con la última parte posiblemente entregada: resultado ambiguo
          if (finalSent) throw tagged(ambiguousUploadError(), { needsReconnect: !!e.needsReconnect });
          throw e;
        }
        lastProblem = e;
      }

      let res = null;
      const wasStatusQuery = needStatus;
      if (accessToken) {
        if (needStatus) {
          res = await safeFetch(uploadUrl, {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + accessToken, 'Content-Range': `bytes */${size}` },
            redirect: 'manual',
          }, API_TIMEOUT_MS);
        } else {
          const end = Math.min(offset + CHUNK_SIZE, size) - 1;
          const chunk = readChunk(fd, offset, end - offset + 1);
          const info = {};
          res = await safeFetch(uploadUrl, {
            method: 'PUT',
            headers: {
              Authorization: 'Bearer ' + accessToken,
              'Content-Type': mime,
              'Content-Range': `bytes ${offset}-${end}/${size}`,
            },
            body: chunk,
            redirect: 'manual',
          }, CHUNK_TIMEOUT_MS, info);
          // Última parte cortada DESPUÉS de enviarla, o respondida con 5xx: YouTube pudo crear el video
          if (end === size - 1 && (res ? res.status >= 500 : !info.preSend)) finalSent = true;
        }
        if (!res) lastProblem = netError();
      }

      if (res) {
        if (res.status === 200 || res.status === 201) {
          const json = await readJson(res);
          // recovered: la confirmación llegó al volver a preguntar después de un corte
          if (json && json.id) return { video: json, recovered: wasStatusQuery && finalSent };
          // YouTube cerró la subida pero no se pudo leer el ID: se vuelve a preguntar antes de rendirse
          finalSent = true;
          lastProblem = ambiguousUploadError();
        } else if (res.status === 308) {
          const range = res.headers.get('range');
          await drain(res);
          const next = nextOffset(range);
          const wasChunk = !wasStatusQuery;
          const progressed = next > offset;
          if (next > highWater) {
            highWater = next;
            failures = 0;
          }
          offset = next;
          // YouTube informa que le faltan bytes: el video todavía no existe, se puede seguir sin riesgo
          if (offset < size) finalSent = false;
          if (offset < size && (progressed || !wasChunk)) {
            needStatus = false;
            continue;
          }
          if (offset < size) {
            // Se mandó una parte y YouTube no avanzó: cuenta como falla (evita un bucle infinito)
            lastProblem = tagged(new Error('YouTube no está aceptando las partes del video. Se va a reintentar más tarde.'), { transient: true });
          } else {
            // YouTube tiene todos los bytes pero todavía no cerró la subida: volver a preguntar
            finalSent = true;
            lastProblem = ambiguousUploadError();
          }
        } else if (res.status === 404 || res.status === 410) {
          await drain(res);
          if (finalSent) throw ambiguousUploadError();
          throw tagged(new Error('La sesión de subida venció. Se va a volver a subir el video más tarde.'), { transient: true });
        } else if (res.status === 401 && authRetries < 2) {
          authRetries++;
          await drain(res);
          forgetAccessToken(creds.refreshToken);
          needStatus = true;
          continue;
        } else if (res.status >= 500 || res.status === 408 || res.status === 429) {
          await drain(res);
          lastProblem = res.status >= 500
            ? tagged(new Error(`YouTube tuvo un error temporal durante la subida (HTTP ${res.status}). Se va a reintentar más tarde.`), { transient: true })
            : tagged(new Error('YouTube está limitando los pedidos por ahora. Se va a reintentar más tarde.'), { transient: true });
        } else {
          const err = apiError(res.status, await readJson(res));
          // Con finalSent esto es la respuesta a una CONSULTA de estado (401 repetido, 403 de límite, 400...):
          // no dice si el video se creó. Nunca devolver "transitorio" (duplicaría el video).
          if (finalSent) throw tagged(ambiguousUploadError(), { needsReconnect: !!err.needsReconnect });
          throw err;
        }
      }

      // Falla de red, 5xx o sin token: esperar y preguntar el estado para retomar
      failures++;
      if (failures > MAX_UPLOAD_RETRIES) {
        const problem = lastProblem || netError();
        // Si la última parte pudo haber llegado, un error "pasajero" no es seguro de reintentar
        throw finalSent && (problem.transient || problem.ambiguous) ? ambiguousUploadError() : problem;
      }
      console.warn(`[youtube] subida interrumpida, reintento ${failures}/${MAX_UPLOAD_RETRIES}`);
      await sleep(backoffMs(failures));
      needStatus = true;
    }
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* nada */ }
  }
}

// ---------------------------------------------------------------------------
// Después de subir: visibilidad real y miniatura
// ---------------------------------------------------------------------------

function isLockedPrivate(status) {
  return !!status && status.privacyStatus === 'private' && !status.publishAt;
}

async function fetchVideoStatus(creds, videoId) {
  try {
    const accessToken = await getAccessToken(creds);
    const res = await safeFetch(`${API_BASE}/videos?part=status&id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: 'Bearer ' + accessToken },
    }, API_TIMEOUT_MS);
    if (!res) return null;
    const json = await readJson(res);
    if (!res.ok || !json || !Array.isArray(json.items) || !json.items[0]) return null;
    return json.items[0].status || null;
  } catch (_) {
    return null;
  }
}

// Devuelve null si salió bien, o un texto de advertencia (nunca lanza)
async function setThumbnail(creds, videoId, thumbPath) {
  const ext = path.extname(thumbPath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : null;
  if (!mime) return 'La miniatura tiene que ser JPG o PNG: no se subió (el video sí).';
  let size;
  try {
    size = fs.statSync(thumbPath).size;
  } catch (_) {
    return 'No encuentro el archivo de la miniatura: no se subió (el video sí).';
  }
  if (size > THUMB_MAX_BYTES) {
    return `La miniatura pesa ${(size / 1048576).toFixed(1)} MB y YouTube acepta hasta 50 MB: no se subió (el video sí).`;
  }

  try {
    const accessToken = await getAccessToken(creds); // token fresco: la subida pudo tardar mucho
    const body = fs.readFileSync(thumbPath);
    const res = await safeFetch(`${UPLOAD_BASE}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': mime },
      body,
    }, THUMB_TIMEOUT_MS);
    if (!res) return 'No se pudo poner la miniatura: sin conexión a internet o servicio caído. Podés ponerla a mano en YouTube Studio.';
    if (res.ok) {
      await drain(res);
      return null;
    }
    const json = await readJson(res);
    const reasons = errorReasons(json);
    if (reasons.includes('quotaExceeded') || reasons.includes('dailyLimitExceeded')) {
      return 'No se pudo poner la miniatura: se agotó la cuota diaria de la API de YouTube. Podés ponerla a mano en YouTube Studio.';
    }
    if (res.status === 429 || reasons.includes('uploadRateLimitExceeded')) {
      return 'No se pudo poner la miniatura: YouTube limitó las subidas de miniaturas por ahora. Podés ponerla a mano en YouTube Studio.';
    }
    if (res.status === 403) {
      return 'No se pudo poner la miniatura personalizada. Verificá tu canal por teléfono en youtube.com/verify para miniaturas personalizadas.';
    }
    if (res.status === 400) {
      return 'YouTube rechazó la imagen de la miniatura (usá JPG o PNG en 16:9, de al menos 640 px de ancho). El video sí se subió.';
    }
    if (res.status === 404) {
      return 'No se pudo poner la miniatura: YouTube todavía no encuentra el video. Podés ponerla a mano en YouTube Studio.';
    }
    return `No se pudo poner la miniatura (HTTP ${res.status}). Podés ponerla a mano en YouTube Studio.`;
  } catch (e) {
    return 'No se pudo poner la miniatura: ' + ((e && e.message) || 'error inesperado') + ' (el video sí se subió).';
  }
}

// ---------------------------------------------------------------------------
// Publicar desde una tarea del calendario
// ---------------------------------------------------------------------------

// Arma título, descripción y visibilidad SIN modificar lo que escribió el usuario.
// Lanza Error en castellano si algo no cumple las reglas de YouTube.
function buildMetadata(task) {
  const title = hasText(task.ytTitle) ? task.ytTitle : (hasText(task.title) ? task.title : '');
  if (!title) throw new Error('Falta el título del video de YouTube. Escribilo en la tarea.');
  const titleChars = Array.from(title).length;
  if (titleChars > TITLE_MAX_CHARS) {
    throw new Error(`El título de YouTube tiene ${titleChars} caracteres y el máximo es ${TITLE_MAX_CHARS}. Acortalo en la tarea.`);
  }
  if (/[<>]/.test(title)) throw new Error('El título de YouTube no puede tener los signos < ni >. Sacalos en la tarea.');

  // Descripción: la de YouTube o el epígrafe. Las notas son internas y nunca se publican.
  let description = hasText(task.ytDescription) ? task.ytDescription
    : hasText(task.caption) ? task.caption : '';
  let addedShorts = false;
  if (task.ytAddShortsTag === true && !/(^|\s)#shorts\b/i.test(description)) {
    const base = description.replace(/\s+$/, '');
    description = base ? base + '\n\n#Shorts' : '#Shorts';
    addedShorts = true;
  }
  const bytes = Buffer.byteLength(description, 'utf8');
  if (bytes > DESCRIPTION_MAX_BYTES) {
    throw new Error(`La descripción de YouTube ocupa ${bytes} bytes${addedShorts ? ' (con #Shorts)' : ''} y el máximo es ${DESCRIPTION_MAX_BYTES} (los emojis y los acentos ocupan más de 1 byte). Acortala en la tarea.`);
  }
  if (/[<>]/.test(description)) throw new Error('La descripción de YouTube no puede tener los signos < ni >. Sacalos en la tarea.');

  const privacy = task.ytPrivacy || 'public';
  if (!['public', 'unlisted', 'private'].includes(privacy)) {
    throw new Error('La visibilidad de YouTube de la tarea no es válida (tiene que ser Público, No listado o Privado).');
  }

  const status = { privacyStatus: privacy, selfDeclaredMadeForKids: false };
  const startMs = Date.parse(task.start);
  if (privacy === 'public' && Number.isFinite(startMs) && startMs > Date.now() + SCHEDULE_MIN_AHEAD_MS) {
    status.privacyStatus = 'private';
    status.publishAt = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  return { snippet: { title, description }, status, requestedVisible: privacy !== 'private' };
}

function checkVideoFile(task) {
  const filePath = task.mediaPath;
  if (!filePath) throw new Error('YouTube necesita un archivo de video. Elegí el video en la tarea.');
  const mime = VIDEO_MIME[path.extname(filePath).toLowerCase()];
  if (!mime) {
    if (task.mediaKind === 'image' || IMAGE_EXT.test(filePath)) {
      throw new Error('YouTube solo acepta videos (por ejemplo MP4). La tarea tiene una imagen.');
    }
    throw new Error(`Formato de video no soportado para YouTube (${path.extname(filePath) || 'sin extensión'}). Exportalo como MP4 (H.264).`);
  }
  let size;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) throw new Error('no es archivo');
    size = st.size;
  } catch (_) {
    throw new Error('No encuentro el archivo de video: ' + filePath);
  }
  if (!size) throw new Error('El archivo de video está vacío: ' + filePath);
  if (size > MAX_VIDEO_BYTES) throw new Error('El video pesa más de 256 GB, el máximo que acepta YouTube.');
  return { filePath, size, mime };
}

function errorResult(e) {
  const out = { platform: 'YouTube', error: (e && e.message) || 'Error inesperado al publicar en YouTube.' };
  if (e && e.ambiguous) {
    // Puede haberse subido: no se reintenta solo
    out.transient = false;
    out.ambiguous = true;
  } else if (e && e.transient) {
    out.transient = true;
  }
  if (e && e.needsReconnect) out.needsReconnect = true;
  return out;
}

async function publishForTask(creds, task) {
  try {
    if (!creds || !creds.refreshToken) {
      return { platform: 'YouTube', error: NOT_CONNECTED_MSG, needsReconnect: true };
    }
    if (!creds.clientId || !creds.clientSecret) {
      return { platform: 'YouTube', error: MISSING_CLIENT_MSG };
    }
    const t = task || {};
    const file = checkVideoFile(t);
    const meta = buildMetadata(t);

    const upload = await resumableUpload(creds, file.filePath, file.size, file.mime, {
      snippet: meta.snippet,
      status: meta.status,
    });
    const video = upload.video;

    const warnings = upload.recovered ? [CONFIRMED_AFTER_CUT] : [];
    const id = video.id;

    // ¿YouTube respetó la visibilidad? (proyectos sin auditoría quedan bloqueados en privado)
    let st = video.status || null;
    let locked = false;
    if (meta.requestedVisible) {
      locked = isLockedPrivate(st);
      if (!locked) {
        const listed = await fetchVideoStatus(creds, id);
        if (listed) {
          st = listed;
          locked = isLockedPrivate(listed);
        }
      }
      if (locked) warnings.push(LOCK_WARNING);
      else if (!creds.auditApproved) warnings.push(AUDIT_WARNING);
    }
    if (st && st.uploadStatus === 'rejected') {
      warnings.push('YouTube rechazó el video' + (st.rejectionReason ? ` (motivo: ${st.rejectionReason})` : '') + '. Revisalo en YouTube Studio.');
    } else if (st && st.uploadStatus === 'failed') {
      warnings.push('YouTube no pudo procesar el video' + (st.failureReason ? ` (motivo: ${st.failureReason})` : '') + '. Revisalo en YouTube Studio.');
    }

    if (hasText(t.thumbPath)) {
      const w = await setThumbnail(creds, id, t.thumbPath);
      if (w) warnings.push(w);
    }

    return { platform: 'YouTube', id, url: 'https://youtu.be/' + id, warnings };
  } catch (e) {
    return errorResult(e);
  }
}

module.exports = { connect, getAccessToken, maintain, publishForTask };

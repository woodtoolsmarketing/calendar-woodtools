/*
 * integrations/tiktok.js — TikTok (Login Kit Desktop + Content Posting API v2).
 * Corre en el proceso principal de Electron.
 *
 * Credenciales guardadas (objeto "tiktok"):
 *   { clientKey, clientSecret, accessToken, refreshToken, openId, displayName, scope,
 *     accessExpiresAt, refreshExpiresAt, firstConsentAt, directPost, needsReconnect }
 *
 * - OAuth: navegador del sistema + receptor local http://127.0.0.1:8723/ con PKCE HEX
 *   (TikTok usa HEX(SHA256(verifier)), no base64url).
 * - Token de acceso: dura 24 h. Refresh token: rota en cada renovación (siempre se guarda
 *   el nuevo) y dura hasta un año desde el consentimiento → hay que reconectar 1 vez por año.
 * - directPost (app auditada): publica directo con la privacidad elegida en la tarea
 *   (consulta creator_info antes). Sin auditoría: sube el video a los BORRADORES (inbox) de
 *   TikTok y se termina de publicar desde la app de TikTok.
 * - Los archivos locales se suben con FILE_UPLOAD en partes, leyendo de a un chunk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const oauth = require('./oauth');

const API = 'https://open.tiktokapis.com/v2';
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = API + '/oauth/token/';
const REDIRECT_PORT = 8723;
const REDIRECT_PATH = '/';

const SCOPE_BASE = 'user.info.basic,video.upload';
const SCOPE_PUBLISH = 'video.publish';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;
const REFRESH_MARGIN_MS = 2 * HOUR_MS; // renovar cuando quedan menos de 2 h
const VALIDATE_EVERY_MS = DAY_MS; // validar con /user/info como mucho 1 vez por día
const YEARLY_WARN_LEFT_MS = 30 * DAY_MS;
const YEARLY_WARN_AGE_MS = 330 * DAY_MS;
const REFRESH_CACHE_MS = 10 * 60 * 1000;

const API_TIMEOUT_MS = 60 * 1000;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_EVERY_MS = 5000;
const POLL_MAX_MS = 3 * 60 * 1000;
const POST_ID_EXTRA_POLLS = 3;

// Reglas de FILE_UPLOAD: hasta 64 MB va en una sola parte; más grande, partes de 10 MB
// (la última lleva el resto). Máximo 4 GB.
const SINGLE_CHUNK_MAX = 64 * 1000 * 1000;
const CHUNK_SIZE = 10 * 1000 * 1000;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CHUNKS = 1000;
const TITLE_MAX = 2200;

const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const NET_ERROR = 'Sin conexión a internet o servicio caído';
const NO_AUDIT_WARNING = 'App de TikTok sin auditoría: los videos van a tus borradores (bandeja de TikTok) y los terminás de publicar desde la app.';
const PRIVACY_REQUIRED = 'Elegí la privacidad de TikTok en la tarea (no se puede publicar sin elegirla).';
const DRAFT_WARNING = 'Quedó en tus borradores de TikTok: abrí la app de TikTok para terminar de publicarlo.';
const CLIENT_CREDS_ERROR = 'Revisá el Client Key y el Client Secret de TikTok';
const AMBIGUOUS_ERROR = 'TikTok recibió el video pero no confirmó. Revisá tu perfil o tus borradores de TikTok antes de volver a intentar.';
const CONFIRMED_AFTER_CUT = 'Se confirmó la publicación después de un corte de conexión.';

// Fallas de red en las que el pedido no llegó a salir (seguro reintentar)
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
// Si no se supo el estado final: cuánto más se consulta antes de avisar que no se confirmó
const UNKNOWN_EXTRA_POLL_MS = 60 * 1000;
// Tras un corte en la última parte: cuántas veces se consulta si TikTok recibió el video completo
const UPLOAD_CHECK_POLLS = 6;

const PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: 'Todos',
  MUTUAL_FOLLOW_FRIENDS: 'Amigos',
  FOLLOWER_OF_CREATOR: 'Seguidores',
  SELF_ONLY: 'Solo yo',
};

// Errores de la API (campo error.code) → mensaje en castellano + clasificación
const API_ERRORS = {
  access_token_invalid: {
    msg: 'El acceso a TikTok venció o fue revocado. Reconectá TikTok.',
    needsReconnect: true,
  },
  scope_not_authorized: {
    msg: 'La conexión de TikTok no tiene el permiso necesario para esta acción. Reconectá TikTok con permiso de publicación.',
    needsReconnect: true,
  },
  rate_limit_exceeded: {
    msg: 'TikTok limitó la cantidad de pedidos por minuto. Se va a reintentar más tarde.',
    transient: true,
  },
  spam_risk_too_many_posts: {
    msg: 'Llegaste al límite diario de publicaciones de TikTok para esta cuenta. Se va a reintentar más tarde.',
    transient: true,
  },
  spam_risk_user_banned_from_posting: {
    msg: 'TikTok no deja publicar desde esta cuenta por ahora (restricción de la cuenta). Revisalo en la app de TikTok.',
  },
  reached_active_user_cap: {
    msg: 'La app de TikTok llegó al cupo diario de cuentas que pueden publicar. Se va a reintentar más tarde.',
    transient: true,
  },
  unaudited_client_can_only_post_to_private_accounts: {
    msg: 'Tu app de TikTok todavía no pasó la auditoría de publicación directa: hasta que TikTok la apruebe, solo puede publicar en cuentas privadas y con privacidad "Solo yo". Desmarcá "App auditada" en Conexiones para mandar los videos a tus borradores, o esperá la aprobación de TikTok.',
  },
  privacy_level_option_mismatch: {
    msg: 'La privacidad elegida no está disponible para esta cuenta de TikTok. Elegí otra privacidad en la tarea.',
  },
  spam_risk_too_many_pending_share: {
    msg: 'Ya tenés el máximo de videos pendientes en los borradores de TikTok (5 por día). Publicá o descartá alguno desde la app de TikTok; se va a reintentar más tarde.',
    transient: true,
  },
  url_ownership_unverified: {
    msg: 'TikTok no acepta el enlace del video porque el dominio no está verificado en la app de TikTok.',
  },
  internal_error: {
    msg: NET_ERROR,
    transient: true,
  },
};

// fail_reason de /status/fetch/ → mensaje + clasificación
const FAIL_REASONS = {
  file_format_check_failed: { msg: 'TikTok no aceptó el formato del video. Exportalo como MP4 (H.264) y volvé a intentar.' },
  duration_check_failed: { msg: 'TikTok no aceptó la duración del video (es muy corto o más largo de lo que permite la cuenta).' },
  frame_rate_check_failed: { msg: 'TikTok no aceptó los cuadros por segundo del video (tienen que estar entre 23 y 60 FPS).' },
  picture_size_check_failed: { msg: 'TikTok no aceptó la resolución del video (cada lado tiene que medir entre 360 y 4096 píxeles).' },
  internal: { msg: 'TikTok tuvo un error interno procesando el video. Se va a reintentar más tarde.', transient: true },
  video_pull_failed: { msg: 'TikTok no pudo recibir el video. Se va a reintentar más tarde.', transient: true },
  photo_pull_failed: { msg: 'TikTok no pudo recibir la imagen. Se va a reintentar más tarde.', transient: true },
  publish_cancelled: { msg: 'La publicación se canceló en TikTok.' },
  auth_removed: { msg: 'Se quitó el permiso de la app en tu cuenta de TikTok. Reconectá TikTok.', needsReconnect: true },
  spam_risk_too_many_posts: { msg: API_ERRORS.spam_risk_too_many_posts.msg, transient: true },
  spam_risk_user_banned_from_posting: { msg: API_ERRORS.spam_risk_user_banned_from_posting.msg },
  spam_risk_text: { msg: 'TikTok marcó el texto de la publicación como posible spam. Cambiá la descripción y volvé a intentar.' },
  spam_risk: { msg: 'TikTok frenó la publicación por riesgo de spam. Revisá el contenido y probá más tarde.' },
};

// --- Helpers generales ---

function makeError(message, extra = {}) {
  const err = new Error(message);
  if (extra.code) err.code = extra.code;
  if (extra.status) err.status = extra.status;
  if (extra.transient) err.transient = true;
  if (extra.needsReconnect) err.needsReconnect = true;
  if (extra.revoked) err.revoked = true; // el refresh token en sí venció o se revocó
  if (extra.ambiguous) err.ambiguous = true; // no se sabe si quedó publicado: no reintentar solo
  if (extra.uploadUncertain) err.uploadUncertain = true; // se cortó la última parte después de enviarla
  return err;
}

function netError() {
  return makeError(NET_ERROR, { transient: true });
}

// Código de la falla de red de fetch (undici lo deja en err.cause.code)
function causeCode(e) {
  const c = e && e.cause;
  const first = c && Array.isArray(c.errors) && c.errors[0];
  return String((c && c.code) || (first && first.code) || (e && e.code) || '');
}

function reconnectError(message) {
  return makeError(message, { needsReconnect: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashOf(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function hasScope(scopeStr, scope) {
  return String(scopeStr || '').split(/[\s,]+/).includes(scope);
}

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// Corta a `max` unidades UTF-16 sin partir un emoji (par sustituto)
function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// Vencimiento real de la conexión: el refresh token o 1 año desde el consentimiento
function connectionExpiry(c) {
  const list = [];
  if (Number(c.refreshExpiresAt) > 0) list.push(Number(c.refreshExpiresAt));
  if (Number(c.firstConsentAt) > 0) list.push(Number(c.firstConsentAt) + YEAR_MS);
  return list.length ? Math.min(...list) : null;
}

function newStatus(extra = {}) {
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
  }, extra);
}

// --- Llamadas HTTP ---

function apiError(status, code, message, logId) {
  const known = code && API_ERRORS[code];
  if (known) {
    return makeError(known.msg, { code, status, transient: known.transient, needsReconnect: known.needsReconnect });
  }
  if (status >= 500) return makeError(NET_ERROR, { code, status, transient: true });
  if (status === 429) return makeError(API_ERRORS.rate_limit_exceeded.msg, { code, status, transient: true });
  if (status === 401) return makeError('TikTok rechazó el acceso. Reconectá TikTok.', { code, status, needsReconnect: true });
  if (code === 'invalid_param' || code === 'invalid_params') {
    return makeError('TikTok rechazó los datos de la publicación' + (message ? ': ' + message : '.'), { code, status });
  }
  const detail = [code, message].filter(Boolean).join(': ');
  const log = logId ? ` [log_id ${logId}]` : '';
  return makeError(`TikTok respondió con un error${detail ? ' (' + detail + ')' : ` (HTTP ${status})`}.${log}`, { code, status });
}

// Llamada a la API v2 con el sobre { data, error: { code, message, log_id } }
async function callApi(method, apiPath, { token, body, timeoutMs = API_TIMEOUT_MS } = {}) {
  const headers = { Authorization: 'Bearer ' + token };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    init.body = JSON.stringify(body);
  }
  let res;
  let raw = '';
  try {
    res = await fetch(API + apiPath, init);
    raw = await res.text();
  } catch (_) {
    throw netError();
  }
  const json = parseJson(raw);
  const err = json && json.error && typeof json.error === 'object' ? json.error : null;
  const code = err && err.code;
  if (res.ok && json && (!code || code === 'ok')) {
    return { data: json.data || {}, raw };
  }
  if (res.ok && !json) {
    throw makeError('TikTok respondió algo inesperado. Se va a reintentar más tarde.', { status: res.status, transient: true });
  }
  throw apiError(res.status, code, err && err.message, err && err.log_id);
}

// POST al endpoint de tokens (form-urlencoded). Devuelve el JSON con access_token o tira.
async function tokenRequest(params) {
  let res;
  let raw = '';
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    raw = await res.text();
  } catch (_) {
    throw netError();
  }
  const json = parseJson(raw);
  if (res.ok && json && json.access_token) return json;
  if (res.status >= 500) throw makeError(NET_ERROR, { status: res.status, transient: true });

  let code = null;
  let description = '';
  if (json && json.error && typeof json.error === 'object') {
    code = json.error.code || null;
    description = json.error.message || '';
  } else if (json) {
    code = json.error || null;
    description = json.error_description || '';
  }
  if (res.status === 429 || code === 'rate_limit_exceeded') {
    throw makeError(API_ERRORS.rate_limit_exceeded.msg, { code, status: res.status, transient: true });
  }
  // Errores del lado de TikTok: no significan que el token esté revocado
  if (code === 'server_error' || code === 'temporarily_unavailable' || code === 'internal_error') {
    throw makeError(NET_ERROR, { code, status: res.status, transient: true });
  }
  const err = makeError(description || code || `HTTP ${res.status}`, { code, status: res.status });
  err.tokenRejected = !!code; // TikTok rechazó el pedido explícitamente
  err.description = description;
  throw err;
}

// Arma los campos a guardar a partir de la respuesta del endpoint de tokens
function tokenFields(json, prev = {}) {
  const now = Date.now();
  const expiresIn = Number(json.expires_in);
  const refreshIn = Number(json.refresh_expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || prev.refreshToken || null,
    openId: json.open_id || prev.openId || null,
    scope: json.scope || prev.scope || null,
    accessExpiresAt: now + (expiresIn > 0 ? expiresIn * 1000 : DAY_MS),
    refreshExpiresAt: refreshIn > 0 ? now + refreshIn * 1000 : (prev.refreshExpiresAt || null),
  };
}

async function getUserInfo(accessToken) {
  const { data } = await callApi('GET', '/user/info/?fields=open_id,display_name', { token: accessToken });
  const user = (data && data.user) || {};
  return { openId: user.open_id || null, displayName: user.display_name || null };
}

// --- Conectar (OAuth) ---

async function connect(creds) {
  if (!creds || !creds.clientKey || !creds.clientSecret) {
    throw new Error('Falta el Client Key o el Client Secret de TikTok (cargalos en Conexiones).');
  }
  const scope = creds.directPost ? `${SCOPE_BASE},${SCOPE_PUBLISH}` : SCOPE_BASE;
  const { code, redirectUri, codeVerifier, grantedScopes } = await oauth.authorizeLoopback({
    authBaseUrl: AUTH_URL,
    clientId: creds.clientKey,
    clientParam: 'client_key', // TikTok usa client_key
    scope,
    pkce: true, // Desktop exige PKCE
    pkceEncoding: 'hex', // TikTok: HEX(SHA256(verifier))
    fixedPort: REDIRECT_PORT, // redirect exacto registrado en TikTok: http://127.0.0.1:8723/
    redirectPath: REDIRECT_PATH,
    useSystemBrowser: true,
  });

  let json;
  try {
    json = await tokenRequest({
      client_key: creds.clientKey,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
  } catch (e) {
    if (e.transient) throw e;
    if (e.code === 'invalid_client') {
      throw new Error('TikTok rechazó el Client Key o el Client Secret. Revisalos en Conexiones y volvé a conectar.');
    }
    throw new Error('TikTok no aceptó la autorización' + (e.description ? ': ' + e.description : '') + '. Volvé a intentar.');
  }

  const fields = tokenFields(json);
  if (!fields.scope && grantedScopes) fields.scope = grantedScopes;
  if (fields.scope && !hasScope(fields.scope, 'video.upload') && !hasScope(fields.scope, SCOPE_PUBLISH)) {
    throw new Error('No se aceptó el permiso para subir videos a TikTok. Volvé a conectar y aceptá todos los permisos.');
  }

  let displayName = null;
  try {
    const u = await getUserInfo(fields.accessToken);
    displayName = u.displayName;
    if (!fields.openId && u.openId) fields.openId = u.openId;
  } catch (_) {
    // El nombre es opcional: si falla, la conexión igual queda hecha
  }

  lastCheck = { key: hashOf(fields.accessToken), at: Date.now() };
  return Object.assign(fields, { displayName, firstConsentAt: Date.now(), needsReconnect: false });
}

// --- Renovar token ---

// Guardas para no usar dos veces el mismo refresh token (rota en cada renovación)
const refreshInFlight = new Map(); // hash(refreshToken) → Promise
const refreshRecent = new Map(); // hash(refreshToken) → { at, result }
let lastCheck = null; // { key: hash(accessToken), at }

async function doRefresh(creds) {
  let json;
  try {
    json = await tokenRequest({
      client_key: creds.clientKey,
      client_secret: creds.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
    });
  } catch (e) {
    if (e.transient) throw e;
    if (e.code === 'invalid_client') {
      // Client Key / Secret mal cargados: el refresh token no está revocado
      throw reconnectError(CLIENT_CREDS_ERROR);
    }
    if (e.tokenRejected) {
      const desc = String(e.description || '');
      const dead = e.code === 'invalid_grant' ||
        (/refresh[\s_-]*token/i.test(desc) && /invalid|expired|revoked|not exist/i.test(desc));
      throw makeError('TikTok no dejó renovar el acceso (venció o se revocó el permiso). Reconectá TikTok.',
        { code: e.code, status: e.status, needsReconnect: true, revoked: dead });
    }
    throw makeError(`TikTok respondió algo inesperado al renovar el acceso (HTTP ${e.status || '?'}).`, { status: e.status });
  }
  const { accessToken, refreshToken, openId, scope, accessExpiresAt, refreshExpiresAt } = tokenFields(json, creds);
  return { accessToken, refreshToken, openId, scope, accessExpiresAt, refreshExpiresAt };
}

async function refresh(creds) {
  if (!creds || !creds.refreshToken) throw reconnectError('TikTok no está conectado (falta el refresh token). Reconectá TikTok.');
  if (!creds.clientKey || !creds.clientSecret) {
    throw new Error('Falta el Client Key o el Client Secret de TikTok para renovar el acceso (cargalos en Conexiones).');
  }
  const key = hashOf(creds.refreshToken);
  const recent = refreshRecent.get(key);
  if (recent && Date.now() - recent.at < REFRESH_CACHE_MS) return Object.assign({}, recent.result);
  if (refreshInFlight.has(key)) return Object.assign({}, await refreshInFlight.get(key));

  const p = doRefresh(creds);
  refreshInFlight.set(key, p);
  try {
    const result = await p;
    refreshRecent.clear();
    refreshRecent.set(key, { at: Date.now(), result });
    lastCheck = { key: hashOf(result.accessToken), at: Date.now() };
    return Object.assign({}, result);
  } finally {
    refreshInFlight.delete(key);
  }
}

// --- Mantenimiento (arranque, cada 6 h, antes de publicar) ---

async function runMaintain(c) {
  const now = Date.now();
  const updates = {};
  const warnings = [];
  let cur = Object.assign({}, c);
  let error = null;
  let needsReconnect = false;
  let revoked = false;
  let refreshed = false;
  const canRefresh = !!(c.refreshToken && c.clientKey && c.clientSecret);

  const fail = (e) => {
    if (e && e.needsReconnect) {
      needsReconnect = true;
      revoked = !!e.revoked; // solo si el refresh token venció o se revocó (no por Client Key/Secret)
      updates.needsReconnect = true;
      error = e.message;
    } else {
      // Sin internet / servicio caído / error de configuración: no marcar reconexión
      needsReconnect = !!c.needsReconnect;
      error = (e && e.message) || NET_ERROR;
    }
  };

  const refreshNow = async () => {
    const r = await refresh(cur);
    Object.assign(updates, r, { needsReconnect: false });
    cur = Object.assign(cur, r, { needsReconnect: false });
    refreshed = true;
  };

  if (Number(c.refreshExpiresAt) > 0 && c.refreshExpiresAt <= now) {
    fail(makeError('La conexión con TikTok venció (dura hasta un año). Reconectá TikTok.', { needsReconnect: true, revoked: true }));
  } else {
    const due = !c.accessToken || !c.accessExpiresAt || c.accessExpiresAt - now < REFRESH_MARGIN_MS;
    if (due) {
      if (!c.refreshToken) {
        fail(reconnectError('Venció el acceso a TikTok. Reconectá TikTok.'));
      } else if (!c.clientKey || !c.clientSecret) {
        fail(new Error('Falta el Client Key o el Client Secret de TikTok para renovar el acceso (cargalos en Conexiones).'));
      } else {
        try {
          await refreshNow();
        } catch (e) {
          fail(e);
        }
      }
    }

    // Validación barata con /user/info (máx. 1 vez por día, o si quedó marcada para reconectar)
    if (!error && cur.accessToken) {
      const key = hashOf(cur.accessToken);
      const stale = !!c.needsReconnect || !lastCheck || lastCheck.key !== key || now - lastCheck.at >= VALIDATE_EVERY_MS;
      if ((!refreshed && stale) || (refreshed && !cur.displayName)) {
        try {
          const u = await getUserInfo(cur.accessToken);
          lastCheck = { key, at: Date.now() };
          if (u.displayName && u.displayName !== c.displayName) updates.displayName = u.displayName;
          if (u.openId && u.openId !== cur.openId) updates.openId = u.openId;
          if (u.displayName) cur.displayName = u.displayName;
          if (c.needsReconnect) updates.needsReconnect = false;
        } catch (e) {
          if (refreshed) {
            // La renovación ya probó que la conexión anda; el nombre es opcional
          } else if (e.code === 'scope_not_authorized') {
            lastCheck = { key, at: Date.now() };
            warnings.push('La conexión de TikTok no tiene permiso para leer el perfil (user.info.basic). Reconectá TikTok aceptando todos los permisos.');
          } else if ((e.code === 'access_token_invalid' || e.status === 401) && canRefresh) {
            // Token de acceso inválido: se prueba una renovación antes de pedir reconectar
            try {
              await refreshNow();
            } catch (e2) {
              fail(e2);
            }
          } else {
            fail(e);
          }
        }
      }
    }
  }

  if (!c.directPost) {
    warnings.push(NO_AUDIT_WARNING);
  } else if (cur.scope && !hasScope(cur.scope, SCOPE_PUBLISH)) {
    warnings.push('Marcaste la app de TikTok como auditada, pero la conexión no tiene permiso de publicación directa (video.publish). Reconectá TikTok.');
  }

  const expiresAt = connectionExpiry(cur);
  const yearlyDue = (Number(cur.refreshExpiresAt) > 0 && cur.refreshExpiresAt - now < YEARLY_WARN_LEFT_MS) ||
    (Number(cur.firstConsentAt) > 0 && now - cur.firstConsentAt > YEARLY_WARN_AGE_MS);
  if (!needsReconnect && yearlyDue) {
    warnings.push('TikTok pide volver a conectar una vez por año: ' +
      (expiresAt ? `reconectá TikTok antes del ${fmtDate(expiresAt)}.` : 'reconectá TikTok pronto para que no se corten las publicaciones.'));
  }

  const status = newStatus({
    ok: !error && !needsReconnect,
    connected: true,
    account: cur.displayName || null,
    expiresAt,
    needsReconnect,
    revoked: needsReconnect && revoked,
    warnings,
    error,
  });
  return { status, updates: Object.keys(updates).length ? updates : null };
}

async function maintain(creds) {
  const c = creds || {};
  if (!c.accessToken && !c.refreshToken) return { status: newStatus(), updates: null };
  try {
    return await runMaintain(c);
  } catch (e) {
    return {
      status: newStatus({
        connected: true,
        account: c.displayName || null,
        expiresAt: connectionExpiry(c),
        needsReconnect: !!c.needsReconnect,
        error: 'No se pudo revisar la conexión de TikTok: ' + ((e && e.message) || 'error desconocido'),
      }),
      updates: null,
    };
  }
}

// --- Creator info (obligatorio antes de publicar directo) ---

async function queryCreatorInfo(creds) {
  if (!creds || !creds.accessToken) throw reconnectError('TikTok no está conectado (entrá a Conexiones y tocá Conectar).');
  const { data } = await callApi('POST', '/post/publish/creator_info/query/', { token: creds.accessToken, body: {} });
  return {
    nickname: data.creator_nickname || '',
    username: data.creator_username || '',
    avatarUrl: data.creator_avatar_url || '',
    privacyLevelOptions: Array.isArray(data.privacy_level_options) ? data.privacy_level_options.map(String) : [],
    commentDisabled: !!data.comment_disabled,
    duetDisabled: !!data.duet_disabled,
    stitchDisabled: !!data.stitch_disabled,
    maxVideoPostDurationSec: Number(data.max_video_post_duration_sec) > 0 ? Number(data.max_video_post_duration_sec) : null,
  };
}

// --- Subida del archivo ---

function chunkPlan(size) {
  if (size <= SINGLE_CHUNK_MAX) return { chunkSize: size, count: 1 };
  return { chunkSize: CHUNK_SIZE, count: Math.floor(size / CHUNK_SIZE) };
}

function readChunk(fd, start, length) {
  const buf = Buffer.allocUnsafe(length);
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, start + off);
    if (n <= 0) throw new Error('No se pudo leer el video completo (¿se modificó o se movió mientras se subía?).');
    off += n;
  }
  return buf;
}

async function uploadChunks(uploadUrl, filePath, size, plan, contentType) {
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let i = 0; i < plan.count; i++) {
      const isLast = i === plan.count - 1;
      const start = i * plan.chunkSize;
      const length = isLast ? size - start : plan.chunkSize;
      const end = start + length - 1;
      const chunk = readChunk(fd, start, length);
      let res;
      let raw = '';
      try {
        res = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(length),
            'Content-Range': `bytes ${start}-${end}/${size}`,
          },
          body: chunk,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        raw = await res.text().catch(() => '');
      } catch (e) {
        // Una parte intermedia cortada no publica nada. La última, si llegó a salir, pudo completar la subida.
        throw makeError('Se cortó la subida del video a TikTok (sin conexión a internet o servicio caído).',
          { transient: true, uploadUncertain: isLast && !PRE_SEND_CODES.has(causeCode(e)) });
      }
      const expected = isLast ? (res.status === 201 || res.status === 200) : res.status === 206;
      if (expected) continue;

      const json = parseJson(raw);
      const err = json && json.error && typeof json.error === 'object' ? json.error : null;
      if (err && err.code && err.code !== 'ok' && API_ERRORS[err.code] && !(isLast && res.status >= 500)) {
        throw apiError(res.status, err.code, err.message, err.log_id);
      }
      if (res.status >= 500 || res.status === 429) {
        throw makeError(`TikTok no pudo recibir el video (HTTP ${res.status}). Se va a reintentar más tarde.`,
          { status: res.status, transient: true, uploadUncertain: isLast && res.status >= 500 });
      }
      const part = plan.count > 1 ? `, parte ${i + 1} de ${plan.count}` : '';
      throw makeError(`TikTok rechazó la subida del video (HTTP ${res.status}${part}).`, { status: res.status });
    }
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

// --- Estado de la publicación ---

async function fetchStatus(token, publishId) {
  const { data, raw } = await callApi('POST', '/post/publish/status/fetch/', { token, body: { publish_id: publishId } });
  // Los IDs de post son int64: se leen del texto crudo para no perder precisión
  const m = /"publica?l?ly_available_post_id"\s*:\s*\[\s*"?(\d+)/.exec(raw || '');
  const bytes = data.uploaded_bytes === undefined || data.uploaded_bytes === null ? NaN : Number(data.uploaded_bytes);
  return {
    status: data.status || null,
    failReason: data.fail_reason || null,
    postId: m ? m[1] : null,
    uploadedBytes: Number.isFinite(bytes) ? bytes : null,
  };
}

// Estados: 'failed' | 'inbox' | 'complete' | 'timeout' (TikTok sigue procesando) | 'unknown' (nunca se supo el estado)
async function waitForPublish(token, publishId, { expectPostId, maxMs = POLL_MAX_MS }) {
  const deadline = Date.now() + maxMs;
  let completed = false;
  let seen = false; // TikTok informó al menos un estado de esta publicación
  let extraPolls = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_EVERY_MS);
    let st;
    try {
      st = await fetchStatus(token, publishId);
    } catch (e) {
      if (e.transient) continue;
      return { state: completed ? 'complete' : (seen ? 'timeout' : 'unknown'), postId: null, error: e };
    }
    if (st.status) seen = true;
    if (st.status === 'FAILED') return { state: 'failed', failReason: st.failReason };
    if (st.status === 'SEND_TO_USER_INBOX') return { state: 'inbox' };
    if (st.status === 'PUBLISH_COMPLETE') {
      completed = true;
      // El ID público aparece recién después de la moderación: se espera un poco
      if (st.postId || !expectPostId || extraPolls >= POST_ID_EXTRA_POLLS) return { state: 'complete', postId: st.postId };
      extraPolls++;
    }
  }
  return { state: completed ? 'complete' : (seen ? 'timeout' : 'unknown'), postId: null };
}

// Tras un corte en la última parte: ¿TikTok recibió el video completo?
// 'yes' | 'no' (TikTok informa que faltan bytes: no se publica nada) | 'unknown'
async function checkUploadReceived(token, publishId, size) {
  let answer = 'unknown';
  for (let i = 0; i < UPLOAD_CHECK_POLLS; i++) {
    await sleep(POLL_EVERY_MS);
    let st;
    try {
      st = await fetchStatus(token, publishId);
    } catch (_) {
      answer = 'unknown';
      continue;
    }
    // Procesando, publicado, en borradores o FAILED: lo resuelve el sondeo normal
    if (st.status && st.status !== 'PROCESSING_UPLOAD') return 'yes';
    if (st.uploadedBytes !== null && st.uploadedBytes >= size) return 'yes';
    answer = st.status === 'PROCESSING_UPLOAD' && st.uploadedBytes !== null ? 'no' : 'unknown';
  }
  return answer;
}

function failError(failReason) {
  const known = failReason && FAIL_REASONS[failReason];
  if (known) return makeError(known.msg, { code: failReason, transient: known.transient, needsReconnect: known.needsReconnect });
  return makeError('TikTok no pudo publicar el video' + (failReason ? ` (${failReason})` : '') + '.', { code: failReason || undefined });
}

// --- Publicar ---

function errorResult(e) {
  const r = { platform: 'TikTok', error: (e && e.message) || 'No se pudo publicar en TikTok.' };
  if (e && e.ambiguous) {
    // Puede haberse publicado: no reintentar automáticamente
    r.transient = false;
    r.ambiguous = true;
    return r;
  }
  if (e && e.transient) r.transient = true;
  if (e && e.needsReconnect) r.needsReconnect = true;
  return r;
}

async function publishInner(creds, task) {
  if (!creds.accessToken) throw reconnectError('TikTok no está conectado (entrá a Conexiones y tocá Conectar).');
  // El token de acceso dura 24 h: si ya venció es porque la renovación previa no se pudo hacer
  if (Number(creds.accessExpiresAt) > 0 && creds.accessExpiresAt <= Date.now()) {
    if (!creds.clientKey || !creds.clientSecret) {
      throw new Error('Falta el Client Key o el Client Secret de TikTok para renovar el acceso (cargalos en Conexiones).');
    }
    if (creds.needsReconnect || !creds.refreshToken) {
      throw reconnectError('El acceso a TikTok venció y no se pudo renovar. Reconectá TikTok.');
    }
    throw makeError('El acceso a TikTok venció y todavía no se pudo renovar (sin conexión o servicio caído). Se va a reintentar más tarde.', { transient: true });
  }

  // 1) Validar el archivo local
  const filePath = task.mediaPath;
  if (!filePath) throw new Error('TikTok necesita un video en la tarea (MP4, MOV o WebM).');
  const contentType = VIDEO_TYPES[path.extname(filePath).toLowerCase()];
  if (task.mediaKind === 'image' || !contentType) {
    throw new Error('TikTok solo acepta videos (MP4, MOV o WebM): las fotos no se pueden subir a TikTok desde el calendario.');
  }
  let size;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) throw new Error('no es un archivo');
    size = st.size;
  } catch (_) {
    throw new Error('No encuentro el video para TikTok: revisá que el archivo siga en su carpeta.');
  }
  if (!size) throw new Error('El video para TikTok está vacío (0 bytes).');
  if (size > MAX_VIDEO_BYTES) throw new Error('El video pesa más de 4 GB, el máximo que acepta TikTok.');
  const plan = chunkPlan(size);
  if (plan.count > MAX_CHUNKS) throw new Error('El video es demasiado grande para subirlo a TikTok.');

  const sourceInfo = {
    source: 'FILE_UPLOAD',
    video_size: size,
    chunk_size: plan.chunkSize,
    total_chunk_count: plan.count,
  };
  const warnings = [];
  const directPost = !!creds.directPost;
  let init;
  let username = '';
  let privacyLevel = null;

  if (directPost) {
    // 2a) Publicación directa (app auditada)
    if (creds.scope && !hasScope(creds.scope, SCOPE_PUBLISH)) {
      throw reconnectError('La conexión de TikTok no tiene permiso de publicación directa (video.publish). Reconectá TikTok con permiso de publicación.');
    }
    const tt = task.tiktok || {};
    privacyLevel = tt.privacyLevel ? String(tt.privacyLevel) : null;
    if (!privacyLevel) throw new Error(PRIVACY_REQUIRED);
    if (tt.brandedContent && privacyLevel === 'SELF_ONLY') {
      throw new Error('El "Contenido de marca" no se puede publicar con privacidad "Solo yo" en TikTok. Elegí otra privacidad en la tarea.');
    }

    const info = await queryCreatorInfo(creds);
    username = info.username;
    if (!info.privacyLevelOptions.includes(privacyLevel)) {
      throw new Error(PRIVACY_REQUIRED + ' La opción guardada ya no está disponible para esta cuenta.');
    }
    // Duración: la guarda el calendario al elegir el video (o viene de Cloudinary)
    const rawDuration = Number(task.mediaDurationSec || (task.mediaInfo && task.mediaInfo.duration));
    // Al milisegundo: diferencias menores son ruido de los metadatos del archivo
    const duration = Number.isFinite(rawDuration) ? Math.round(rawDuration * 1000) / 1000 : NaN;
    const maxSec = info.maxVideoPostDurationSec;
    if (maxSec && Number.isFinite(duration) && duration > 0 && duration > maxSec) {
      // Redondeo hacia arriba a 1 decimal: nunca mostrar "dura 600 s y permite hasta 600 s"
      const shown = String(Math.ceil(Math.round(duration * 1000) / 100) / 10).replace('.', ',');
      throw new Error(`TikTok: el video dura ${shown} s y tu cuenta permite hasta ${maxSec} s.`);
    }

    // Solo el epígrafe: nunca las notas internas ni el título de la tarea (puede quedar vacío)
    const fullTitle = String(task.caption || '').trim();
    const title = clip(fullTitle, TITLE_MAX);
    if (title.length < fullTitle.length) {
      warnings.push(`La descripción superaba los ${TITLE_MAX} caracteres que permite TikTok: se publicó recortada.`);
    }
    const postInfo = {
      title,
      privacy_level: privacyLevel,
      disable_comment: !tt.allowComment || info.commentDisabled,
      disable_duet: !tt.allowDuet || info.duetDisabled,
      disable_stitch: !tt.allowStitch || info.stitchDisabled,
      brand_content_toggle: !!tt.brandedContent,
      brand_organic_toggle: !!tt.brandOrganic,
    };
    const cover = Number(tt.coverTimestampMs);
    if (tt.coverTimestampMs !== null && tt.coverTimestampMs !== undefined && tt.coverTimestampMs !== '' &&
        Number.isFinite(cover) && cover >= 0) {
      postInfo.video_cover_timestamp_ms = Math.round(cover);
    }
    init = await callApi('POST', '/post/publish/video/init/', {
      token: creds.accessToken,
      body: { post_info: postInfo, source_info: sourceInfo },
    });
  } else {
    // 2b) Sin auditoría: sube a los borradores (inbox) de TikTok
    init = await callApi('POST', '/post/publish/inbox/video/init/', {
      token: creds.accessToken,
      body: { source_info: sourceInfo },
    });
  }

  const publishId = init.data.publish_id;
  const uploadUrl = init.data.upload_url;
  if (!publishId || !uploadUrl) {
    throw makeError('TikTok no devolvió dónde subir el video. Se va a reintentar más tarde.', { transient: true });
  }

  // 3) Subir el archivo en partes (la URL de subida vale 1 hora)
  let uploadCut = false;
  try {
    await uploadChunks(uploadUrl, filePath, size, plan, contentType);
  } catch (e) {
    if (!e.uploadUncertain) throw e;
    // Se cortó la última parte después de enviarla: se pregunta a TikTok si llegó completa
    const received = await checkUploadReceived(creds.accessToken, publishId, size);
    if (received === 'no') throw makeError(e.message, { transient: true });
    if (received !== 'yes') throw makeError(AMBIGUOUS_ERROR, { ambiguous: true });
    uploadCut = true;
  }

  // 4) Consultar el estado. Desde acá el video ya está en TikTok: no devolver errores
  //    "reintentables" que dupliquen la publicación, salvo que TikTok diga FAILED.
  const pollOpts = { expectPostId: directPost && privacyLevel !== 'SELF_ONLY' && !!username };
  let outcome = await waitForPublish(creds.accessToken, publishId, pollOpts);
  if (outcome.state === 'unknown') {
    // No se pudo leer ningún estado: se insiste un rato más antes de rendirse
    outcome = await waitForPublish(creds.accessToken, publishId, Object.assign({}, pollOpts, { maxMs: UNKNOWN_EXTRA_POLL_MS }));
  }

  if (outcome.state === 'failed') throw failError(outcome.failReason);
  if (outcome.state === 'unknown') throw makeError(AMBIGUOUS_ERROR, { ambiguous: true });

  const result = { platform: 'TikTok', id: publishId };
  if (outcome.state === 'inbox' || (!directPost && outcome.state !== 'complete')) result.draft = true;
  if (uploadCut && (outcome.state === 'inbox' || outcome.state === 'complete')) warnings.push(CONFIRMED_AFTER_CUT);

  if (outcome.state === 'inbox') {
    warnings.push(DRAFT_WARNING);
    if (String(task.caption || '').trim()) {
      warnings.push('Los borradores de TikTok no reciben el texto: pegá la descripción cuando lo publiques desde la app.');
    }
  } else if (outcome.state === 'complete') {
    if (outcome.postId) {
      result.id = outcome.postId;
      if (username) result.url = `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${outcome.postId}`;
    }
    if (privacyLevel === 'SELF_ONLY') {
      warnings.push(`Se publicó en TikTok con privacidad "${PRIVACY_LABELS.SELF_ONLY}": solo lo ves vos.`);
    }
  } else {
    // 'timeout': TikTok informó el video pero sigue procesándolo
    warnings.push(directPost
      ? 'TikTok sigue procesando el video: revisá en unos minutos en la app de TikTok que se haya publicado.'
      : 'TikTok sigue procesando el video: en unos minutos debería aparecer en tus borradores de TikTok para terminar de publicarlo.');
  }

  if (warnings.length) result.warnings = warnings;
  return result;
}

async function publishForTask(creds, task) {
  try {
    return await publishInner(creds || {}, task || {});
  } catch (e) {
    return errorResult(e);
  }
}

module.exports = { connect, refresh, maintain, queryCreatorInfo, publishForTask };

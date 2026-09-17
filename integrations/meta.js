/*
 * integrations/meta.js — Facebook (Página) e Instagram (cuenta profesional) con las APIs de Meta.
 * Corre en el proceso principal de Electron (fetch, FormData y Blob globales).
 *
 * Credenciales (objeto "meta"; Facebook e Instagram lo comparten):
 *   Facebook:  appId, appSecret, fbScopes, pageId, pageName, pageToken, pageTokenType,
 *              pageTokenExpiresAt, liveMode
 *   Instagram: igAppId, igAppSecret, igToken, igUserId, igUsername, igTokenIssuedAt,
 *              igTokenExpiresAt, igLastRefreshAt, redirectUri
 *
 * - Facebook publica SIEMPRE con token de Página (si hay uno de usuario guardado, se deriva
 *   el de la Página con me/accounts). Sube el archivo local cuando puede.
 * - Instagram publica SOLO con el token de "Instagram Login" (graph.instagram.com): dura
 *   60 días y se renueva solo (maintainInstagram). Necesita la URL pública del archivo.
 * - Nunca se loguean tokens ni URLs con access_token / client_secret.
 */
const fs = require('fs');
const path = require('path');
const hosting = require('./hosting');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const META_API_VERSION = 'v25.0';
const GRAPH = 'https://graph.facebook.com/' + META_API_VERSION;
const IG_GRAPH = 'https://graph.instagram.com/' + META_API_VERSION;
const RUPLOAD = 'https://rupload.facebook.com/video-upload/' + META_API_VERSION;
const FB_DIALOG = 'https://www.facebook.com/' + META_API_VERSION + '/dialog/oauth';
const FB_LOGIN_REDIRECT = 'https://www.facebook.com/connect/login_success.html';
const IG_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const IG_CODE_EXCHANGE = 'https://api.instagram.com/oauth/access_token';
const IG_LONG_EXCHANGE = 'https://graph.instagram.com/access_token';
const IG_REFRESH = 'https://graph.instagram.com/refresh_access_token';
const DEFAULT_REDIRECT_URI = 'https://calendario-woodtools.onrender.com/oauth/callback.html';
const DEFAULT_FB_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management';
const IG_SCOPES = 'instagram_business_basic,instagram_business_content_publish';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const API_TIMEOUT_MS = 60 * 1000;
const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const FB_PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const FB_THUMB_MAX_BYTES = 10 * 1024 * 1024;
const IG_CAPTION_MAX = 2200;
const IG_MAX_HASHTAGS = 30;
const IG_MAX_MENTIONS = 20;
const IG_FIRST_CHECK_MS = { image: 10 * 1000, video: 15 * 1000 };
const IG_POLL_EVERY_MS = 30 * 1000;
const IG_POLL_MAX_MS = 5 * 60 * 1000;
const IG_PUBLISH_RETRY_MS = 20 * 1000;
const IG_DEFAULT_LIFETIME_MS = 60 * DAY;
const VERIFY_DELAY_MS = 5 * 1000;       // espera antes de buscar el posteo después de un corte
const VERIFY_TIMEOUT_MS = 15 * 1000;    // las consultas de verificación son cortas
const VERIFY_WINDOW_S = 60;             // margen hacia atrás para comparar created_time

const NET_ERROR = 'Sin conexión a internet o servicio caído';
const LIVE_MODE_WARNING = 'La app de Meta está en modo Desarrollo: lo que publiques solo lo ven los administradores de la app. Publicala (modo Live) para que sea público.';
const CONFIRMED_AFTER_CUT = 'Se confirmó la publicación después de un corte de conexión.';
const CONFIRMED_AFTER_ERROR = 'Meta respondió con un error temporal, pero se confirmó que la publicación quedó hecha.';
const FB_LINK_WARNING = 'Facebook: el link se agrega solo en publicaciones de texto. En fotos y videos pegalo en el epígrafe.';

// Fallas de red en las que el pedido no llegó a salir (no pudo crear nada: se puede reintentar)
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

// Se puede reemplazar en pruebas (_setSleep) para no esperar de verdad
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------
// Error de la API con datos estructurados (code, subcode, fbtrace, httpStatus...)
function apiError(message, props) {
  const err = new Error(message || 'error desconocido');
  Object.assign(err, props || {});
  return err;
}

// Error propio, con mensaje ya listo para el usuario (en castellano)
function userError(message, opts) {
  const err = new Error(message);
  err.local = true;
  err.transient = !!(opts && opts.transient);
  err.needsReconnect = !!(opts && opts.needsReconnect);
  return err;
}

// Pedido que crea contenido con resultado desconocido: NO se reintenta solo (podría duplicar)
function ambiguousError(platform) {
  const err = userError(`${platform} no confirmó la publicación (se cortó la conexión). Puede que se haya publicado: revisalo antes de volver a intentar.`);
  err.ambiguous = true;
  return err;
}

// Subcódigos de token inválido (acompañan a los errores 190/102)
const TOKEN_SUBCODES = {
  458: 'se quitó el acceso de la app desde la cuenta.',
  459: 'la cuenta tiene un control de seguridad pendiente (entrá a la red social y resolvelo).',
  460: 'cambió la contraseña de la cuenta y el token dejó de valer.',
  463: 'el token venció.',
  464: 'la cuenta no está confirmada.',
  467: 'el token no es válido (fue revocado o reemplazado).',
  492: 'la sesión no es válida: el usuario ya no tiene rol en la Página.',
};

// Errores de publicación de Instagram (por subcódigo)
const IG_ERRORS = {
  2207001: { msg: 'error interno de Instagram al procesar el archivo.', transient: true },
  2207003: { msg: 'Instagram tardó demasiado en descargar el archivo desde la URL pública.', transient: true },
  2207004: { msg: 'la imagen pesa más de 8 MB.' },
  2207005: { msg: 'formato de imagen no soportado (Instagram solo acepta JPEG).' },
  2207009: { msg: 'la proporción de la imagen no está permitida (tiene que estar entre 4:5 vertical y 1.91:1 horizontal).' },
  2207010: { msg: 'el texto supera los 2200 caracteres, los 30 hashtags o las 20 menciones.' },
  2207020: { msg: 'el contenido preparado venció.', transient: true },
  2207023: { msg: 'tipo de contenido desconocido.' },
  2207026: { msg: 'formato de video no soportado (usá MP4 o MOV con video H.264 y audio AAC).' },
  2207027: { msg: 'el archivo todavía no terminó de procesarse.', transient: true },
  2207032: { msg: 'no se pudo crear el contenido (error temporal de Instagram).', transient: true },
  2207040: { msg: 'el texto tiene demasiadas menciones (@).' },
  2207042: { msg: 'alcanzaste el límite diario de publicaciones por API de Instagram.', transient: true },
  2207050: { msg: 'la cuenta de Instagram está restringida o inactiva. Entrá a la app de Instagram y revisá el estado de la cuenta.' },
  2207051: { msg: 'Instagram bloqueó la publicación (la considera spam o contraria a sus normas).' },
  2207052: { msg: 'Instagram no pudo descargar el archivo desde la URL pública.' },
  2207053: { msg: 'error temporal de Instagram al subir el archivo.', transient: true },
  2207057: { msg: 'el momento elegido para la portada está fuera de la duración del video.' },
};

function metaDetail(e) {
  return String(e.userMsg || e.message || 'error desconocido').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/*
 * ¿El token en sí fue revocado o venció del todo? Solo error 190 con subcódigo 458/460/463/467,
 * o sin subcódigo con mensaje de sesión vencida/inválida. NO: permisos (10, 200-299),
 * controles de seguridad (459/464), rol en la Página (492) ni fallas de red.
 */
function isRevokedToken(e) {
  if (Number(e.code) !== 190) return false;
  const sub = Number(e.subcode);
  if (sub) return [458, 460, 463, 467].includes(sub);
  const msg = String(e.message || '');
  if (/checkpoint|confirm|role/i.test(msg)) return false;
  return /expired|invalid|revoked|not authorized|decrypt|malformed|cannot parse|password/i.test(msg);
}

/*
 * Clasifica cualquier error → { message (castellano), transient, needsReconnect, network, revoked, ambiguous }
 * platform: 'Facebook' | 'Instagram'
 */
function classifyError(err, platform) {
  const p = platform || 'Meta';
  const e = err || {};
  const out = (message, flags) => ({
    message,
    transient: !!(flags && flags.transient),
    needsReconnect: !!(flags && flags.needsReconnect),
    network: !!(flags && flags.network),
    revoked: !!(flags && flags.revoked),
    ambiguous: !!(flags && flags.ambiguous),
  });
  const retry = ' Se reintenta más tarde.';

  if (e.local) return out(e.message, { transient: e.transient, needsReconnect: e.needsReconnect, ambiguous: e.ambiguous });
  if (e.network) return out(`${p}: ${NET_ERROR}.`, { transient: true, network: true });

  const code = Number(e.code);
  const sub = Number(e.subcode);
  const detail = metaDetail(e);

  const ig = IG_ERRORS[sub];
  if (ig) return out(`${p}: ${ig.msg}${ig.transient ? retry : ''}`, { transient: ig.transient });
  if (code === 9007) return out(`${p}: ${IG_ERRORS[2207027].msg}${retry}`, { transient: true });

  if (code === 190 || code === 102 || TOKEN_SUBCODES[sub]) {
    const why = TOKEN_SUBCODES[sub] || 'el token no es válido, venció o fue revocado.';
    return out(`${p}: ${why} Reconectá ${p} en Conexiones.`, { needsReconnect: true, revoked: isRevokedToken(e) });
  }
  // rupload.facebook.com no manda código: { debug_info: { type: 'AuthError' } }
  if (!code && String(e.type || '') === 'AuthError') {
    return out(`${p}: el token no es válido, venció o fue revocado. Reconectá ${p} en Conexiones.`, { needsReconnect: true });
  }
  if (code === 10 || (code >= 200 && code <= 299)) {
    return out(`${p}: falta un permiso para esta acción (Meta: ${detail}). Reconectá ${p} en Conexiones y aceptá todos los permisos pedidos.`, { needsReconnect: true });
  }
  if (code === 100 && sub === 33) {
    return out(`${p}: no encuentro la cuenta o la Página, o el token no tiene acceso a ella. Reconectá ${p} en Conexiones.`, { needsReconnect: true });
  }
  if (code === 101) return out(`${p}: el App ID o el App Secret no son correctos. Revisalos en Conexiones.`);
  if (code === 506) return out(`${p}: Meta rechazó el posteo por duplicado (es igual a uno publicado hace poco). Cambiá el texto.`);
  if (code === 368) {
    return out(`${p}: Meta bloqueó temporalmente las publicaciones de la cuenta por sus políticas.${retry} Si se repite, revisá el estado de la cuenta.`, { transient: true });
  }
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014)) {
    return out(`${p}: Meta limitó la cantidad de llamadas por un rato.${retry}`, { transient: true });
  }
  if (code === 341) return out(`${p}: se alcanzó un límite de la app de Meta.${retry}`, { transient: true });
  if (code === 389) return out(`${p}: Meta no pudo descargar el archivo desde la URL pública.`);
  if (code === 1 || code === 2 || code === -2 || e.isTransient === true) {
    return out(`${p}: error temporal de Meta (${detail}).${retry}`, { transient: true });
  }
  if (e.httpStatus >= 500 || e.unexpected) return out(`${p}: ${NET_ERROR}.`, { transient: true, network: true });

  const codeTxt = Number.isFinite(code) && code ? ` (código ${code}${Number.isFinite(sub) && sub ? '/' + sub : ''})` : '';
  return out(`${p}: ${detail}${codeTxt}`);
}

// Convierte cualquier error en uno con mensaje en castellano (para connect/normalize)
function toUserError(err, platform) {
  if (err && err.local) return err;
  const k = classifyError(err, platform);
  return userError(k.message, k);
}

function isNetworkError(err) {
  return classifyError(err).network;
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

/*
 * ¿No se sabe si el pedido se procesó? Corte/tiempo agotado después de enviarlo, respuesta 5xx
 * o una respuesta OK ilegible. Los rechazos claros de la API y las fallas previas al envío no cuentan.
 */
function isUnknownOutcome(e) {
  if (!e || e.local) return false;
  if (e.network) return !e.preSend && !(e.httpStatus >= 400 && e.httpStatus < 500);
  if (Number(e.httpStatus) >= 500) return true;
  return !!e.unexpected;
}

/*
 * Respuesta clara de Meta con "error temporal" (códigos 1, 2, -1, -2 o is_transient) a un pedido que crea
 * contenido: a veces el posteo igual queda hecho. Se busca antes de dejarlo para reintentar (evita duplicados).
 * No cuentan los límites de llamadas, los bloqueos ni "todavía no está listo": ahí nada se procesó.
 */
function isTransientRefusal(e) {
  if (!e || e.local || e.network || e.unexpected || Number(e.httpStatus) >= 500) return false;
  const code = Number(e.code);
  const sub = Number(e.subcode);
  if ([4, 17, 32, 341, 368, 613].includes(code) || (code >= 80000 && code <= 80014)) return false;
  if (sub === 2207027 || code === 9007) return false;
  if (IG_ERRORS[sub] && sub !== 2207001 && sub !== 2207032) return false;
  if (code === 190 || code === 102 || code === 10 || (code >= 200 && code <= 299)) return false; // token o permisos
  return code === 1 || code === 2 || code === -1 || code === -2 || e.isTransient === true;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function seg(id) {
  return encodeURIComponent(String(id).trim());
}

function buildUrl(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// fetch + JSON con errores estructurados. Nunca pone la URL en el mensaje (puede llevar el token).
async function httpJson(url, options, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { ...(options || {}), signal: AbortSignal.timeout(timeoutMs || API_TIMEOUT_MS) });
  } catch (e) {
    // sin internet, DNS, corte o tiempo agotado. preSend: el pedido no llegó a salir
    throw apiError(NET_ERROR, { network: true, preSend: isPreSendFailure(e) });
  }
  let text = '';
  try {
    text = await res.text();
  } catch (_) {
    throw apiError(NET_ERROR, { network: true, preSend: false, httpStatus: res.status });
  }
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch (_) { json = null; }
  }
  if (json && typeof json === 'object') {
    const e = json.error;
    if (e && typeof e === 'object') {
      throw apiError(e.message, {
        code: e.code, subcode: e.error_subcode, fbtrace: e.fbtrace_id, type: e.type,
        userMsg: e.error_user_msg, isTransient: e.is_transient, httpStatus: res.status,
      });
    }
    // Formato de api.instagram.com: { error_type, code, error_message }
    if (typeof e === 'string' || json.error_message || json.error_type) {
      throw apiError(json.error_message || json.error_description || e, { code: json.code, type: json.error_type, httpStatus: res.status });
    }
    // Formato de rupload.facebook.com: { debug_info: { retriable, type, message } }
    if (json.debug_info && json.success !== true) {
      throw apiError(json.debug_info.message, { type: json.debug_info.type, isTransient: json.debug_info.retriable === true, httpStatus: res.status });
    }
  }
  if (!res.ok) throw apiError(`HTTP ${res.status}`, { httpStatus: res.status });
  if (!json || typeof json !== 'object') {
    const ct = (res.headers.get('content-type') || '').split(';')[0];
    throw apiError(`respuesta inesperada (HTTP ${res.status}${ct ? ', ' + ct : ''})`, { httpStatus: res.status, unexpected: true });
  }
  return json;
}

function postForm(url, token, params) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  }
  if (token) form.append('access_token', token);
  return httpJson(url, { method: 'POST', body: form });
}

function fbGet(pathStr, token, params) {
  return httpJson(buildUrl(`${GRAPH}/${pathStr}`, { ...params, access_token: token }));
}

function fbPost(pathStr, token, params) {
  return postForm(`${GRAPH}/${pathStr}`, token, params);
}

function igGet(pathStr, token, params) {
  return httpJson(buildUrl(`${IG_GRAPH}/${pathStr}`, { ...params, access_token: token }));
}

function igPost(pathStr, token, params) {
  return postForm(`${IG_GRAPH}/${pathStr}`, token, params);
}

// multipart/form-data (archivos locales). Los valores { blob, name } van como archivo.
async function fbPostMultipart(pathStr, token, fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object' && v.blob) form.append(k, v.blob, v.name);
    else form.append(k, String(v));
  }
  form.append('access_token', token);
  return httpJson(`${GRAPH}/${pathStr}`, { method: 'POST', body: form }, UPLOAD_TIMEOUT_MS);
}

async function fileBlob(filePath) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  if (typeof fs.openAsBlob === 'function') return fs.openAsBlob(filePath, { type }); // no carga todo en memoria
  return new Blob([fs.readFileSync(filePath)], { type });
}

async function filePart(filePath) {
  return { blob: await fileBlob(filePath), name: path.basename(filePath) };
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(ms) {
  const d = new Date(ms);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function cleanToken(t) {
  return String(t || '').trim().replace(/^(Bearer|OAuth)\s+/i, '').replace(/["'\s]/g, '');
}

function lifetimeMs(expiresIn) {
  const s = Number(expiresIn);
  return s > 0 ? s * 1000 : IG_DEFAULT_LIFETIME_MS;
}

function nonEmpty(obj) {
  return obj && Object.keys(obj).length ? obj : null;
}

function newStatus() {
  return { ok: false, connected: false, account: null, expiresAt: null, needsReconnect: false, revoked: false, warnings: [], error: null, checkedAt: Date.now() };
}

function finalize(st) {
  st.ok = st.connected && !st.needsReconnect && !st.error;
  st.checkedAt = Date.now();
  return st;
}

function applyErrorToStatus(st, err, platform) {
  const k = classifyError(err, platform);
  if (k.needsReconnect) {
    st.connected = false;
    st.needsReconnect = true;
    st.revoked = k.revoked; // solo token revocado/vencido del todo (no permisos ni controles de seguridad)
    st.error = k.message;
  } else {
    st.connected = true; // sin internet / límite / error puntual: el token sigue guardado
    st.error = k.network ? NET_ERROR : k.message;
  }
}

// Texto a publicar: SOLO el epígrafe. Las notas son internas y nunca se publican.
function captionOf(task) {
  return typeof task.caption === 'string' ? task.caption.trim() : '';
}

function contentFlags(task) {
  const ct = String(task.contentType || '').toLowerCase();
  return { isStory: ct.includes('historia'), isReel: ct.includes('reel') };
}

function kindFromUrl(url) {
  const clean = String(url).split(/[?#]/)[0];
  if (/\.(mp4|mov|m4v)$/i.test(clean) || /res\.cloudinary\.com\/[^/]+\/video\/upload\//i.test(clean)) return 'video';
  if (/\.(jpe?g|png|gif|bmp|tiff?|webp|heic|heif)$/i.test(clean) || /res\.cloudinary\.com\/[^/]+\/image\/upload\//i.test(clean)) return 'image';
  return null;
}

/*
 * Archivo de la tarea → { kind: 'image'|'video'|'webm'|null, localPath, url, missingLocal, hasMedia }
 * Prioridad del tipo: task.mediaKind → task.mediaInfo.kind → extensión del archivo local → URL.
 */
function resolveMedia(task) {
  let localPath = null;
  if (task.mediaPath) {
    try { if (fs.existsSync(task.mediaPath)) localPath = task.mediaPath; } catch (_) {}
  }
  const url = task.mediaUrl ? String(task.mediaUrl).trim() : '';
  let kind = task.mediaKind || (task.mediaInfo && task.mediaInfo.kind) || null;
  if (!kind && task.mediaPath) kind = hosting.mediaKind(task.mediaPath);
  if (!kind && url) kind = kindFromUrl(url);
  return {
    kind,
    localPath,
    url,
    missingLocal: !!task.mediaPath && !localPath,
    hasMedia: !!(task.mediaPath || url),
    name: task.mediaPath ? path.basename(task.mediaPath) : '',
  };
}

// ---------------------------------------------------------------------------
// Facebook — tokens
// ---------------------------------------------------------------------------
function appAccessToken(creds) {
  return `${creds.appId}|${creds.appSecret}`;
}

// debug_token → { isValid, type, expiresAt (null = no vence), scopes }
async function debugToken(inputToken, accessToken) {
  const json = await fbGet('debug_token', accessToken, { input_token: inputToken });
  const d = json.data || {};
  return {
    isValid: d.is_valid !== false,
    type: d.type || null,
    expiresAt: Number(d.expires_at) > 0 ? Number(d.expires_at) * 1000 : null,
    scopes: Array.isArray(d.scopes) ? d.scopes : null,
  };
}

// Token de usuario (corto) → token de usuario de larga duración (necesita App Secret)
async function exchangeFbUserToken(creds, userToken) {
  const json = await fbGet('oauth/access_token', null, {
    grant_type: 'fb_exchange_token',
    client_id: creds.appId,
    client_secret: creds.appSecret,
    fb_exchange_token: userToken,
  });
  if (!json.access_token) throw userError('Facebook: no se pudo obtener el token de larga duración.');
  return { token: json.access_token, expiresAt: Number(json.expires_in) > 0 ? Date.now() + Number(json.expires_in) * 1000 : null };
}

// Un token de Página responde el campo "category" en /me; uno de usuario da error 100
async function looksLikePage(token) {
  try {
    const json = await fbGet('me', token, { fields: 'id,category' });
    return !!json.category;
  } catch (e) {
    if (Number(e.code) === 100) return false;
    throw e;
  }
}

function canCreateContent(page) {
  return !Array.isArray(page.tasks) || page.tasks.includes('CREATE_CONTENT') || page.tasks.includes('MANAGE');
}

/*
 * Con un token de usuario (o de usuario del sistema) elige la Página y obtiene su token.
 * Devuelve { page: { id, name, access_token, tasks }, pages: [{ id, name }] }
 */
async function pageFromUserToken(creds, userToken) {
  const wanted = creds.pageId ? String(creds.pageId).trim() : '';
  let pages = [];
  let listError = null;
  try {
    const json = await fbGet('me/accounts', userToken, { fields: 'id,name,access_token,tasks', limit: 100 });
    pages = Array.isArray(json.data) ? json.data : [];
  } catch (e) {
    if (!wanted || isNetworkError(e)) throw e;
    listError = e;
  }
  const list = pages.map((p) => ({ id: String(p.id), name: p.name || '' }));

  let page = null;
  if (wanted) {
    page = pages.find((p) => String(p.id) === wanted) || null;
    if (!page) {
      // Páginas de un portfolio comercial (usuario del sistema) pueden no figurar en me/accounts
      try {
        const direct = await fbGet(seg(wanted), userToken, { fields: 'id,name,access_token' });
        if (direct && direct.access_token) {
          page = direct;
          if (!list.some((p) => p.id === String(direct.id))) list.push({ id: String(direct.id), name: direct.name || '' });
        }
      } catch (e) {
        if (isNetworkError(e)) throw e;
        if (listError) throw listError;
      }
    }
    if (!page) {
      throw userError(`Facebook: la Página con ID ${wanted} no está entre las que autorizaste (o no tenés permiso para publicar en ella). Volvé a conectar y marcá esa Página, o borrá el ID de Página en Conexiones para elegir otra.`, { needsReconnect: true });
    }
  } else if (pages.length === 1) {
    page = pages[0];
  } else {
    page = pages.find((p) => p.access_token && canCreateContent(p)) || null;
    if (!pages.length) {
      throw userError('Facebook: tu usuario no administra ninguna Página o no aceptaste el permiso para verlas. Volvé a conectar y elegí la Página de WoodTools.', { needsReconnect: true });
    }
    if (!page) {
      throw userError('Facebook: ninguna de tus Páginas te permite crear contenido. Pedí acceso de contenido en la configuración de la Página.');
    }
  }

  if (!canCreateContent(page)) {
    throw userError(`Facebook: tu usuario no tiene permiso para publicar en la Página "${page.name || page.id}" (falta la tarea "Crear contenido"). Pedí ese acceso a un administrador de la Página.`);
  }
  if (!page.access_token) {
    throw userError(`Facebook: Meta no entregó el token de la Página "${page.name || page.id}". Reconectá Facebook y aceptá todos los permisos (pages_show_list, pages_manage_posts).`, { needsReconnect: true });
  }
  return { page, pages: list };
}

// Arma el resultado de connect/normalize con tipo y vencimiento del token de Página
async function pageResult(creds, page, pages, fallbackExpiresAt) {
  let type = 'PAGE';
  let expiresAt = fallbackExpiresAt || null;
  const accessToken = creds.appId && creds.appSecret ? appAccessToken(creds) : page.access_token;
  try {
    const dbg = await debugToken(page.access_token, accessToken);
    if (dbg.type) type = dbg.type;
    expiresAt = dbg.expiresAt;
  } catch (_) { /* opcional: sin datos de vencimiento */ }
  return {
    pageId: String(page.id),
    pageName: page.name || '',
    pageToken: page.access_token,
    pageTokenType: type,
    pageTokenExpiresAt: expiresAt,
    pages,
  };
}

function assertUsableExpiry(expiresAt) {
  if (expiresAt && expiresAt - Date.now() < DAY) {
    throw userError('Facebook: ese token vence en menos de un día (es de corta duración) y no sirve para publicar programado. Cargá el App Secret de Meta en Conexiones y volvé a pegarlo para hacerlo permanente, o usá "Conectar" o un token de usuario del sistema.');
  }
}

// Si lo guardado no es un token de Página, lo deriva (sin guardarlo: eso lo hace maintain)
async function resolvePageToken(creds) {
  if (creds.pageTokenType === 'PAGE') return creds.pageToken;
  const me = await fbGet('me', creds.pageToken, { fields: 'id' });
  if (String(me.id) === String(creds.pageId).trim()) return creds.pageToken;
  const { page } = await pageFromUserToken(creds, creds.pageToken);
  return page.access_token;
}

// ---------------------------------------------------------------------------
// Facebook — conectar / pegar token
// ---------------------------------------------------------------------------
async function connectFacebook(creds) {
  const c = creds || {};
  if (!c.appId || !c.appSecret) {
    throw userError('Facebook: falta el App ID o el App Secret de la app de Meta. Cargalos en Conexiones y guardá antes de conectar.');
  }
  const { authorizeEmbedded, randomState } = require('./oauth');
  const state = randomState();
  const authUrl = buildUrl(FB_DIALOG, {
    client_id: c.appId,
    redirect_uri: FB_LOGIN_REDIRECT,
    response_type: 'token',
    scope: c.fbScopes || DEFAULT_FB_SCOPES,
    state,
  });
  const { params } = await authorizeEmbedded({ authUrl, redirectUri: FB_LOGIN_REDIRECT, state, title: 'Conectar Facebook' });
  if (!params.access_token) {
    throw userError('Facebook no devolvió un token. En la app de Meta (Inicio de sesión con Facebook > Configuración) activá "Inicio de sesión de OAuth del cliente" y "Inicio de sesión de OAuth con navegador integrado", y agregá https://www.facebook.com/connect/login_success.html a las URI de redireccionamiento válidas.');
  }
  try {
    const longUser = await exchangeFbUserToken(c, params.access_token);
    const { page, pages } = await pageFromUserToken(c, longUser.token);
    return await pageResult(c, page, pages, null); // token de Página desde token largo: no vence
  } catch (e) {
    throw toUserError(e, 'Facebook');
  }
}

/*
 * Acepta un token pegado: de PÁGINA, de USUARIO (se canjea por uno largo y se deriva el de la
 * Página) o de USUARIO DEL SISTEMA (no se puede canjear: se usa directo con me/accounts).
 */
async function normalizeFacebookToken(creds, pastedToken) {
  const c = creds || {};
  const token = cleanToken(pastedToken);
  if (!token) throw userError('Facebook: pegá un token.');
  const hasApp = !!(c.appId && c.appSecret);
  const wanted = c.pageId ? String(c.pageId).trim() : '';
  try {
    let dbg = null;
    try {
      dbg = await debugToken(token, hasApp ? appAccessToken(c) : token);
    } catch (e) {
      if (isNetworkError(e)) throw e;
    }
    if (dbg && !dbg.isValid) {
      throw userError('Facebook: el token pegado no es válido o ya venció. Generá uno nuevo.', { needsReconnect: true });
    }

    const me = await fbGet('me', token, { fields: 'id,name' });
    let isPage;
    if (dbg && dbg.type) isPage = dbg.type === 'PAGE';
    else if (wanted && String(me.id) === wanted) isPage = true;
    else isPage = await looksLikePage(token);

    if (isPage) {
      if (wanted && String(me.id) !== wanted) {
        throw userError(`Facebook: ese token es de la Página "${me.name || me.id}" (ID ${me.id}), pero en Conexiones figura la Página ID ${wanted}. Pegá el token de esa Página o borrá el ID de Página.`);
      }
      const expiresAt = dbg ? dbg.expiresAt : null;
      assertUsableExpiry(expiresAt);
      const info = { id: String(me.id), name: me.name || '' };
      return { pageId: info.id, pageName: info.name, pageToken: token, pageTokenType: 'PAGE', pageTokenExpiresAt: expiresAt, pages: [info] };
    }

    // Token de usuario o de usuario del sistema
    let userToken = token;
    let userExpiresAt = dbg ? dbg.expiresAt : null;
    if (hasApp && !(dbg && dbg.type === 'SYSTEM_USER')) {
      try {
        const ex = await exchangeFbUserToken(c, token);
        userToken = ex.token;
        userExpiresAt = ex.expiresAt;
      } catch (e) {
        if (isNetworkError(e)) throw e; // si no se pudo canjear (usuario del sistema), seguimos con el pegado
      }
    }
    const { page, pages } = await pageFromUserToken(c, userToken);
    // Sin debug_token: si el token de usuario era corto, el de Página vence con él
    const fallback = userToken === token && userExpiresAt && userExpiresAt - Date.now() < DAY ? userExpiresAt : null;
    const result = await pageResult(c, page, pages, fallback);
    assertUsableExpiry(result.pageTokenExpiresAt);
    return result;
  } catch (e) {
    throw toUserError(e, 'Facebook');
  }
}

// ---------------------------------------------------------------------------
// Instagram — conectar / pegar token
// ---------------------------------------------------------------------------
async function connectInstagram(creds) {
  const c = creds || {};
  if (!c.igAppId || !c.igAppSecret) {
    throw userError('Instagram: falta el ID o la clave secreta de la app de Instagram ("Configuración de la API con inicio de sesión de Instagram"). Cargalos en Conexiones y guardá antes de conectar.');
  }
  const redirectUri = c.redirectUri || DEFAULT_REDIRECT_URI;
  const { authorizeEmbedded, randomState } = require('./oauth');
  const state = randomState();
  const authUrl = buildUrl(IG_AUTHORIZE, {
    client_id: c.igAppId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: IG_SCOPES,
    state,
  });
  const { params } = await authorizeEmbedded({ authUrl, redirectUri, state, title: 'Conectar Instagram' });
  if (!params.code) {
    throw userError('Instagram no devolvió el código de autorización. Revisá que la URI de redireccionamiento de la app de Instagram sea exactamente ' + redirectUri);
  }
  try {
    const form = new URLSearchParams({
      client_id: String(c.igAppId),
      client_secret: String(c.igAppSecret),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: params.code,
    });
    const shortRes = await httpJson(IG_CODE_EXCHANGE, { method: 'POST', body: form });
    const short = Array.isArray(shortRes.data) ? (shortRes.data[0] || {}) : shortRes;
    if (!short.access_token) throw userError('Instagram: no se pudo canjear el código por un token.');

    const long = await httpJson(buildUrl(IG_LONG_EXCHANGE, {
      grant_type: 'ig_exchange_token',
      client_secret: c.igAppSecret,
      access_token: short.access_token,
    }));
    if (!long.access_token) throw userError('Instagram: no se pudo obtener el token de larga duración.');

    const me = await igGet('me', long.access_token, { fields: 'user_id,username' });
    const now = Date.now();
    return {
      igToken: long.access_token,
      igUserId: String(me.user_id || me.id || ''),
      igUsername: me.username || '',
      igTokenIssuedAt: now,
      igTokenExpiresAt: now + lifetimeMs(long.expires_in),
      igLastRefreshAt: now,
    };
  } catch (e) {
    throw toUserError(e, 'Instagram');
  }
}

async function normalizeInstagramToken(creds, pastedToken) {
  const c = creds || {};
  const pasted = cleanToken(pastedToken);
  if (!pasted) throw userError('Instagram: pegá un token.');
  try {
    let token = pasted;
    let expiresIn = null;
    if (c.igAppSecret) {
      try {
        const ex = await httpJson(buildUrl(IG_LONG_EXCHANGE, { grant_type: 'ig_exchange_token', client_secret: c.igAppSecret, access_token: pasted }));
        if (ex.access_token) {
          token = ex.access_token;
          expiresIn = Number(ex.expires_in) || null;
        }
      } catch (e) {
        if (isNetworkError(e)) throw e; // si ya era de larga duración el canje falla: seguimos
      }
    }
    let me;
    try {
      me = await igGet('me', token, { fields: 'user_id,username' });
    } catch (e) {
      if (/^EAA/.test(pasted) && classifyError(e, 'Instagram').needsReconnect) {
        throw userError('Instagram: ese token es de Facebook, no de Instagram. Generalo en la app de Meta > Instagram > "Configuración de la API con inicio de sesión de Instagram" > Generar tokens de acceso (empieza con "IG").');
      }
      throw e;
    }
    const now = Date.now();
    return {
      igToken: token,
      igUserId: String(me.user_id || me.id || ''),
      igUsername: me.username || '',
      igTokenIssuedAt: now,
      igTokenExpiresAt: now + (expiresIn ? expiresIn * 1000 : IG_DEFAULT_LIFETIME_MS),
      // 0 = nunca renovado por la app (vencimiento real desconocido): se renueva apenas cumpla 24 h
      igLastRefreshAt: expiresIn ? now : 0,
    };
  } catch (e) {
    throw toUserError(e, 'Instagram');
  }
}

// ---------------------------------------------------------------------------
// Mantenimiento (nunca lanzan)
// ---------------------------------------------------------------------------
async function maintainFacebook(creds) {
  const c = creds || {};
  const st = newStatus();
  if (!c.pageToken) return { status: st, updates: null };
  const updates = {};
  st.account = c.pageName || null;
  st.expiresAt = Number(c.pageTokenExpiresAt) || null;
  try {
    let token = c.pageToken;
    const pageId = c.pageId ? String(c.pageId).trim() : '';

    if (c.pageTokenType === 'PAGE' && pageId) {
      const page = await fbGet(seg(pageId), token, { fields: 'id,name' });
      if (page.name) {
        st.account = page.name;
        if (page.name !== c.pageName) updates.pageName = page.name;
      }
    } else {
      // Tipo desconocido (datos viejos) o token de usuario: averiguar y, si hace falta, derivar el de Página
      const me = await fbGet('me', token, { fields: 'id,name' });
      if (pageId && String(me.id) === pageId) {
        updates.pageTokenType = 'PAGE';
        if (me.name) {
          st.account = me.name;
          if (me.name !== c.pageName) updates.pageName = me.name;
        }
      } else if (!pageId && await looksLikePage(token)) {
        Object.assign(updates, { pageId: String(me.id), pageName: me.name || '', pageTokenType: 'PAGE' });
        st.account = me.name || null;
      } else {
        const { page } = await pageFromUserToken(c, token);
        token = page.access_token;
        Object.assign(updates, { pageToken: token, pageTokenType: 'PAGE', pageId: String(page.id), pageName: page.name || '' });
        // 0 = no vence (null no pisa el vencimiento viejo guardado)
        if (Number(c.pageTokenExpiresAt) > 0) updates.pageTokenExpiresAt = 0;
        st.account = page.name || null;
        st.expiresAt = null;
      }
    }

    if (c.appId && c.appSecret) {
      try {
        const dbg = await debugToken(token, appAccessToken(c));
        if (dbg.isValid) {
          const knownType = updates.pageTokenType || c.pageTokenType || null;
          if (dbg.type && dbg.type !== knownType) updates.pageTokenType = dbg.type;
          st.expiresAt = dbg.expiresAt;
          if (dbg.expiresAt && dbg.expiresAt !== Number(c.pageTokenExpiresAt)) updates.pageTokenExpiresAt = dbg.expiresAt;
          else if (!dbg.expiresAt && Number(c.pageTokenExpiresAt) > 0) updates.pageTokenExpiresAt = 0; // ya no vence
          if (dbg.scopes && dbg.scopes.length && !dbg.scopes.includes('pages_manage_posts')) {
            st.warnings.push('Al token de Facebook le falta el permiso pages_manage_posts: no va a poder publicar. Reconectá Facebook y aceptá todos los permisos.');
          }
        }
      } catch (_) { /* opcional: el token ya se validó arriba */ }
    }

    st.connected = true;
    if (st.expiresAt) st.warnings.push(`El token de Facebook vence el ${fmtDate(st.expiresAt)}; reconectá para que sea permanente.`);
    if (!c.liveMode) st.warnings.push(LIVE_MODE_WARNING);
  } catch (e) {
    applyErrorToStatus(st, e, 'Facebook');
  }
  return { status: finalize(st), updates: nonEmpty(updates) };
}

async function maintainInstagram(creds) {
  const c = creds || {};
  const st = newStatus();
  if (!c.igToken) return { status: st, updates: null };
  const now = Date.now();
  const updates = {};
  st.account = c.igUsername ? '@' + c.igUsername : null;
  st.expiresAt = Number(c.igTokenExpiresAt) || null;

  const issuedAt = Number(c.igTokenIssuedAt) || 0;
  const lastRefresh = Number(c.igLastRefreshAt) || 0;
  const expiresAt = Number(c.igTokenExpiresAt) || 0;
  // Meta solo deja renovar tokens de 24 h o más
  const oldEnough = !issuedAt || now - issuedAt >= DAY;
  const due = oldEnough && (!lastRefresh || now - lastRefresh >= 7 * DAY || !expiresAt || expiresAt - now < 45 * DAY);

  let token = c.igToken;
  let refreshed = false;
  let refreshFailed = false;
  try {
    if (due) {
      try {
        const r = await httpJson(buildUrl(IG_REFRESH, { grant_type: 'ig_refresh_token', access_token: token }));
        if (r.access_token) {
          token = r.access_token;
          refreshed = true;
          Object.assign(updates, { igToken: token, igTokenIssuedAt: now, igTokenExpiresAt: now + lifetimeMs(r.expires_in), igLastRefreshAt: now });
          st.expiresAt = updates.igTokenExpiresAt;
        }
      } catch (e) {
        if (isNetworkError(e)) throw e;
        refreshFailed = true; // se confirma abajo con /me si el token todavía sirve
      }
    }

    if (!refreshed || !c.igUserId || !c.igUsername) {
      const me = await igGet('me', token, { fields: 'user_id,username' });
      const uid = String(me.user_id || me.id || '');
      if (uid && uid !== String(c.igUserId || '')) updates.igUserId = uid;
      if (me.username && me.username !== c.igUsername) updates.igUsername = me.username;
      if (me.username) st.account = '@' + me.username;
    }

    st.connected = true;
    if (refreshFailed) {
      if (!issuedAt) updates.igTokenIssuedAt = now; // datos viejos sin fecha: se reintenta en 24 h
      else st.warnings.push('No se pudo renovar el token de Instagram; se vuelve a intentar más tarde. Si el aviso sigue, reconectá Instagram.');
    }
    const left = st.expiresAt ? st.expiresAt - now : null;
    if (left !== null && left > 0 && left < 7 * DAY) {
      st.warnings.push(`El token de Instagram vence el ${fmtDate(st.expiresAt)}. Si no se renueva solo, reconectá Instagram.`);
    }
    if (!c.liveMode) st.warnings.push(LIVE_MODE_WARNING);
  } catch (e) {
    applyErrorToStatus(st, e, 'Instagram');
  }
  // updates se devuelve aunque /me falle: si hubo token nuevo hay que guardarlo sí o sí
  return { status: finalize(st), updates: nonEmpty(updates) };
}

// ---------------------------------------------------------------------------
// Facebook — publicación
// ---------------------------------------------------------------------------
function fbPostUrl(id) {
  const s = String(id || '');
  if (!s) return undefined;
  const [owner, post] = s.split('_');
  return post ? `https://www.facebook.com/${owner}/posts/${post}` : `https://www.facebook.com/${s}`;
}

function localPhotoSource(filePath) {
  if (!filePath || !/\.(jpe?g|png)$/i.test(filePath)) return null;
  try {
    return fs.statSync(filePath).size <= FB_PHOTO_MAX_BYTES ? filePath : null;
  } catch (_) {
    return null;
  }
}

// Sube una foto a la Página: archivo local (JPG/PNG hasta 4 MB) o la URL pública (JPEG)
async function fbUploadPhoto(pageId, token, media, extra) {
  const local = localPhotoSource(media.localPath);
  if (local) return fbPostMultipart(`${seg(pageId)}/photos`, token, { source: await filePart(local), ...extra });
  const url = media.url || (media.localPath ? await publicJpegFor(media.localPath) : '');
  if (url) return fbPost(`${seg(pageId)}/photos`, token, { url, ...extra });
  throw userError(`Facebook: no encuentro el archivo de la foto${media.name ? ' "' + media.name + '"' : ''}.`);
}

// Foto que Facebook no acepta tal cual (no es JPG/PNG o pesa más de 4 MB) y sin URL pública
// (main.js solo la arma para Instagram/Threads/historias): se sube a Cloudinary → JPEG liviano
async function publicJpegFor(filePath) {
  let hostingCreds = null;
  try {
    hostingCreds = require('../credentials').getPlatform('hosting');
  } catch (_) { /* fuera de Electron (pruebas) */ }
  if (!hostingCreds || !hostingCreds.cloudName || !hostingCreds.uploadPreset) {
    throw userError('Facebook: la foto no es JPG/PNG o pesa más de 4 MB. Configurá Cloudinary en Conexiones (la convierte sola) o usá un JPG/PNG de hasta 4 MB.');
  }
  try {
    const info = await hosting.uploadPublic(filePath, hostingCreds);
    if (!info || !info.url) throw new Error('Cloudinary no devolvió la URL');
    return info.url;
  } catch (e) {
    const offline = e instanceof TypeError || (e && (e.name === 'AbortError' || e.name === 'TimeoutError'));
    throw userError(`Facebook: no se pudo preparar la foto en Cloudinary (${offline ? NET_ERROR : (e && e.message)}).${offline ? ' Se reintenta más tarde.' : ''}`, { transient: offline });
  }
}

// Sube el video al upload_url de rupload: binario desde el archivo local o por URL pública
async function fbRuploadVideo(uploadUrl, token, media) {
  const headers = { Authorization: 'OAuth ' + token };
  let body;
  if (media.localPath) {
    headers.offset = '0';
    headers.file_size = String(fs.statSync(media.localPath).size);
    body = await fileBlob(media.localPath);
  } else if (media.url) {
    headers.file_url = media.url;
  } else {
    throw userError('Facebook: no encuentro el archivo de video.');
  }
  const json = await httpJson(uploadUrl, { method: 'POST', headers, body }, UPLOAD_TIMEOUT_MS);
  if (json.success === false) throw userError('Facebook: la subida del video falló.', { transient: true });
  return json;
}

function ruploadUrlFor(start) {
  const u = start && start.upload_url ? String(start.upload_url) : '';
  return u.startsWith('https://rupload.facebook.com/') ? u : `${RUPLOAD}/${seg(start.video_id)}`;
}

// ---------------------------------------------------------------------------
// Facebook — verificación después de un corte (evita duplicados)
// ---------------------------------------------------------------------------
// Momento (segundos unix) desde el que se busca el posteo, con un margen hacia atrás
function attemptStartSec() {
  return Math.floor(Date.now() / 1000) - VERIFY_WINDOW_S;
}

// created_time de Graph ("2026-09-15T12:34:56+0000") o creation_time unix → segundos
function graphTimeSec(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  const ms = Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

function itemTimeSec(item) {
  return graphTimeSec(item.created_time !== undefined ? item.created_time : item.creation_time);
}

function newestItem(list) {
  let best = null;
  let bestT = -Infinity;
  for (const item of list) {
    const t = itemTimeSec(item);
    if (Number.isFinite(t) && t > bestT) {
      best = item;
      bestT = t;
    }
  }
  return best;
}

function sameText(a, b) {
  const norm = (v) => String(v || '').replace(/\r\n/g, '\n').trim();
  return norm(a) === norm(b);
}

function verifyGet(pathStr, token, params) {
  return httpJson(buildUrl(`${GRAPH}/${pathStr}`, { ...params, access_token: token }), undefined, VERIFY_TIMEOUT_MS);
}

// Posteo de texto/foto creado desde "since" con el mismo texto (o, sin texto, el más nuevo sin texto)
async function findRecentPost(pageId, token, message, since) {
  const json = await verifyGet(`${seg(pageId)}/posts`, token, { fields: 'id,message,created_time', limit: 10 });
  const list = (Array.isArray(json.data) ? json.data : []).filter((p) => p && p.id && itemTimeSec(p) >= since);
  const text = String(message || '').trim();
  const hit = text ? list.find((p) => sameText(p.message, text)) : newestItem(list.filter((p) => !String(p.message || '').trim()));
  return hit ? { id: String(hit.id), url: fbPostUrl(hit.id) } : null;
}

/*
 * Video o reel creado desde "since" con la misma descripción. Para reels (knownId) el video existe
 * desde la fase "start": solo cuenta si ya tiene la descripción que se manda en "finish".
 */
async function findRecentVideo(pageId, token, description, since, knownId) {
  const json = await verifyGet(`${seg(pageId)}/videos`, token, { fields: 'id,description,created_time', limit: 10 });
  const data = (Array.isArray(json.data) ? json.data : []).filter((v) => v && v.id);
  const text = String(description || '').trim();
  let hit = null;
  if (knownId) {
    if (text) hit = data.find((v) => (String(v.id) === String(knownId) || itemTimeSec(v) >= since) && sameText(v.description, text)) || null;
  } else {
    const list = data.filter((v) => itemTimeSec(v) >= since);
    hit = text ? list.find((v) => sameText(v.description, text)) : newestItem(list.filter((v) => !String(v.description || '').trim()));
  }
  return hit ? { id: String(hit.id) } : null;
}

// Historia con ese media_id (foto sin publicar o video) o, si la API no lo informa, la más nueva desde "since"
async function findRecentStory(pageId, token, mediaId, since) {
  const json = await verifyGet(`${seg(pageId)}/stories`, token, {});
  const data = (Array.isArray(json.data) ? json.data : []).filter((s) => s && typeof s === 'object');
  const wanted = String(mediaId || '');
  let hit = wanted ? data.find((s) => String(s.media_id || '') === wanted) : null;
  if (!hit && !data.some((s) => s.media_id)) {
    hit = newestItem(data.filter((s) => itemTimeSec(s) >= since && String(s.status || '').toUpperCase() !== 'ARCHIVED'));
  }
  return hit ? { id: String(hit.post_id || hit.id || wanted) } : null;
}

/*
 * Ejecuta un pedido que CREA contenido. Si el resultado es incierto (corte después de enviar, 5xx,
 * respuesta sin confirmación) busca el posteo; si no aparece → error ambiguo (no se reintenta solo).
 * Devuelve { res, found } (found = { id, url? } cuando se confirmó por la verificación).
 */
async function tryVerify(verify) {
  try {
    await sleep(VERIFY_DELAY_MS);
    return (await verify()) || null;
  } catch (_) {
    return null; // no se pudo verificar
  }
}

async function fbCreate(call, isOk, verify) {
  let res = null;
  try {
    res = await call();
  } catch (e) {
    if (isTransientRefusal(e)) {
      // "Error temporal" de Meta: si el posteo igual aparece es un éxito; si no, queda para reintentar
      const found = await tryVerify(verify);
      if (found) return { res: null, found: { ...found, note: CONFIRMED_AFTER_ERROR } };
      throw e;
    }
    if (!isUnknownOutcome(e)) throw e; // rechazo claro o la red cortó antes de mandar: nada se creó
  }
  if (res && isOk(res)) return { res, found: null };
  const found = await tryVerify(verify);
  if (found) return { res, found };
  throw ambiguousError('Facebook');
}

async function publishFacebook(creds, task) {
  const c = creds || {};
  if (!c.pageId || !c.pageToken) {
    throw userError('Facebook: falta conectar la Página. Entrá a Conexiones y conectá Facebook.', { needsReconnect: true });
  }
  const pageId = String(c.pageId).trim();
  const caption = captionOf(task);
  const { isStory, isReel } = contentFlags(task);
  const media = resolveMedia(task);

  // Validaciones locales antes de tocar la red
  if (media.missingLocal && !media.url) throw userError(`Facebook: no encuentro el archivo "${media.name}". ¿Se movió o se borró?`);
  if (media.hasMedia && !media.kind) {
    throw userError('Facebook: no reconozco el tipo de archivo. Usá JPG/PNG para fotos o MP4/MOV para videos.');
  }
  if (isStory && !media.hasMedia) throw userError('Facebook: una historia necesita una foto o un video.');
  if (media.kind === 'webm' && (isStory || isReel || !media.localPath)) {
    throw userError('Facebook: los reels e historias necesitan un video MP4 o MOV (H.264); .webm no sirve.');
  }
  if (isReel && !isStory && (media.kind === 'image' || !media.hasMedia)) {
    throw userError(media.hasMedia ? 'Facebook: un reel necesita un video, no una imagen.' : 'Facebook: un reel necesita un video (MP4 o MOV).');
  }
  if (!media.hasMedia && !caption && !task.link) {
    throw userError('Facebook: el posteo está vacío. Agregá un texto, un link o un archivo.');
  }

  const token = await resolvePageToken(c);
  const isVideo = media.kind === 'video' || media.kind === 'webm';

  // El link solo se publica en posteos de texto: en fotos/videos/reels/historias se avisa (no se altera nada)
  const warnings = [];
  const link = String(task.link || '').trim();
  if (media.hasMedia && link && (isStory || !caption.includes(link))) warnings.push(FB_LINK_WARNING);
  // found: posteo confirmado por la verificación (después de un corte o de un error temporal)
  const result = (id, url, found) => ({
    id,
    url,
    warnings: found ? [found.note || CONFIRMED_AFTER_CUT, ...warnings] : warnings,
  });

  // --- Historias ---
  if (isStory) {
    if (!isVideo) {
      const photo = await fbUploadPhoto(pageId, token, media, { published: 'false' });
      if (!photo.id) throw userError('Facebook: no se pudo subir la foto de la historia.', { transient: true });
      // Enseguida: Meta borra las fotos sin publicar después de ~24 h
      const since = attemptStartSec();
      const { res: story, found } = await fbCreate(
        () => fbPost(`${seg(pageId)}/photo_stories`, token, { photo_id: photo.id }),
        () => true,
        () => findRecentStory(pageId, token, photo.id, since),
      );
      if (found) return result(found.id, undefined, found);
      if (story.success === false) throw userError('Facebook: no se pudo crear la historia.', { transient: true });
      return result(String(story.post_id || photo.id));
    }
    const start = await fbPost(`${seg(pageId)}/video_stories`, token, { upload_phase: 'start' });
    if (!start.video_id) throw userError('Facebook: no se pudo iniciar la historia de video.', { transient: true });
    await fbRuploadVideo(ruploadUrlFor(start), token, media);
    const since = attemptStartSec();
    const { res: fin, found } = await fbCreate(
      () => fbPost(`${seg(pageId)}/video_stories`, token, { upload_phase: 'finish', video_id: start.video_id }),
      () => true,
      () => findRecentStory(pageId, token, start.video_id, since),
    );
    if (found) return result(found.id, undefined, found);
    if (fin.success === false) throw userError('Facebook: no se pudo publicar la historia de video.', { transient: true });
    return result(String(fin.post_id || start.video_id));
  }

  // --- Texto / link ---
  if (!media.hasMedia) {
    const since = attemptStartSec();
    const { res, found } = await fbCreate(
      () => fbPost(`${seg(pageId)}/feed`, token, { message: caption, link: task.link }),
      (r) => !!r.id,
      () => findRecentPost(pageId, token, caption, since),
    );
    if (found) return result(found.id, found.url, found);
    return result(String(res.id), fbPostUrl(res.id));
  }

  // --- Reel ---
  if (isVideo && isReel) {
    const since = attemptStartSec(); // el video existe desde "start"
    const start = await fbPost(`${seg(pageId)}/video_reels`, token, { upload_phase: 'start' });
    if (!start.video_id) throw userError('Facebook: no se pudo iniciar el reel.', { transient: true });
    await fbRuploadVideo(ruploadUrlFor(start), token, media);
    const { res: fin, found } = await fbCreate(
      () => fbPost(`${seg(pageId)}/video_reels`, token, {
        upload_phase: 'finish',
        video_id: start.video_id,
        video_state: 'PUBLISHED',
        description: caption,
      }),
      () => true,
      () => findRecentVideo(pageId, token, caption, since, start.video_id),
    );
    if (!found && fin.success === false) throw userError('Facebook: no se pudo publicar el reel.', { transient: true });
    return result(String(start.video_id), `https://www.facebook.com/reel/${start.video_id}`, found);
  }

  // --- Video ---
  if (isVideo) {
    const fields = { description: caption };
    if (media.localPath) fields.source = await filePart(media.localPath);
    else fields.file_url = media.url;
    // Portada opcional: solo JPG/PNG de hasta 10 MB (otro formato podría hacer fallar la subida del video)
    if (task.thumbPath && /\.(jpe?g|png)$/i.test(task.thumbPath)) {
      try {
        if (fs.statSync(task.thumbPath).size <= FB_THUMB_MAX_BYTES) fields.thumb = await filePart(task.thumbPath);
      } catch (_) { /* sin portada */ }
    }
    const since = attemptStartSec();
    const { res, found } = await fbCreate(
      () => fbPostMultipart(`${seg(pageId)}/videos`, token, fields),
      (r) => !!r.id,
      () => findRecentVideo(pageId, token, caption, since, null),
    );
    const videoId = found ? found.id : String(res.id);
    return result(videoId, `https://www.facebook.com/${pageId}/videos/${videoId}`, found);
  }

  // --- Foto ---
  const since = attemptStartSec();
  const { res, found } = await fbCreate(
    () => fbUploadPhoto(pageId, token, media, { caption }),
    (r) => !!(r.post_id || r.id),
    () => findRecentPost(pageId, token, caption, since),
  );
  if (found) return result(found.id, found.url, found);
  const id = res.post_id || res.id;
  return result(String(id), res.post_id ? fbPostUrl(res.post_id) : `https://www.facebook.com/photo/?fbid=${res.id}`);
}

// ---------------------------------------------------------------------------
// Instagram — publicación (solo Instagram Login)
// ---------------------------------------------------------------------------
function validateInstagramCaption(caption) {
  const text = String(caption || '');
  const len = Array.from(text).length;
  if (len > IG_CAPTION_MAX) {
    throw userError(`Instagram: el texto tiene ${len} caracteres y el máximo es ${IG_CAPTION_MAX}. Acortalo.`);
  }
  const tags = text.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) || [];
  if (tags.length > IG_MAX_HASHTAGS) {
    throw userError(`Instagram: el texto tiene ${tags.length} hashtags y el máximo es ${IG_MAX_HASHTAGS}. Sacá algunos.`);
  }
  const mentions = text.match(/(^|[^\p{L}\p{N}_.@])@[\p{L}\p{N}_.]+/gu) || [];
  if (mentions.length > IG_MAX_MENTIONS) {
    throw userError(`Instagram: el texto tiene ${mentions.length} menciones (@) y el máximo es ${IG_MAX_MENTIONS}. Sacá algunas.`);
  }
}

function containerStatusError(statusText) {
  const txt = String(statusText || '').trim();
  const m = /(22070\d\d)/.exec(txt);
  const known = m ? IG_ERRORS[Number(m[1])] : null;
  if (known) {
    return userError(`Instagram no pudo procesar el archivo: ${known.msg}${txt ? ' (' + txt + ')' : ''}`, { transient: known.transient });
  }
  return userError('Instagram no pudo procesar el archivo' + (txt ? ': ' + txt : '. Revisá el formato (JPEG para fotos; MP4/MOV H.264 para videos).'));
}

// Espera a que el contenedor esté listo: primera consulta a los 10-15 s, después cada 30 s hasta 5 min
async function waitForContainer(containerId, token, kind) {
  const first = IG_FIRST_CHECK_MS[kind] || IG_FIRST_CHECK_MS.video;
  const maxChecks = 1 + Math.floor((IG_POLL_MAX_MS - first) / IG_POLL_EVERY_MS);
  await sleep(first);
  for (let i = 0; i < maxChecks; i++) {
    if (i > 0) await sleep(IG_POLL_EVERY_MS);
    let st = null;
    try {
      st = await igGet(seg(containerId), token, { fields: 'status_code,status' });
    } catch (e) {
      if (!classifyError(e, 'Instagram').transient) throw e; // un corte puntual no corta la espera
      continue;
    }
    const code = st && st.status_code;
    if (code === 'FINISHED' || code === 'PUBLISHED') return code;
    if (code === 'ERROR') throw containerStatusError(st.status);
    if (code === 'EXPIRED') {
      throw userError('Instagram: el contenido preparado venció antes de publicarse. Se reintenta más tarde.', { transient: true });
    }
  }
  throw userError('Instagram sigue procesando el archivo después de 5 minutos. Se reintenta más tarde.', { transient: true });
}

function isNotReady(err) {
  return Number(err && err.subcode) === 2207027 || Number(err && err.code) === 9007;
}

// ¿El contenedor ya figura PUBLISHED? (verificación después de un corte; nunca lanza)
async function igContainerPublished(containerId, token) {
  try {
    await sleep(VERIFY_DELAY_MS);
    const st = await httpJson(buildUrl(`${IG_GRAPH}/${seg(containerId)}`, { fields: 'status_code', access_token: token }), undefined, VERIFY_TIMEOUT_MS);
    return !!st && st.status_code === 'PUBLISHED';
  } catch (_) {
    return false;
  }
}

/*
 * media_publish con un reintento si "todavía no está listo".
 * Devuelve { id } o { id: null, confirmedAfterCut: true } si se confirmó por el estado del contenedor.
 * Resultado desconocido (corte después de enviar, 5xx, respuesta sin id) y sin confirmación → error ambiguo.
 */
async function publishContainer(igUserId, containerId, token) {
  for (let attempt = 0; ; attempt++) {
    let pub = null;
    try {
      pub = await igPost(`${seg(igUserId)}/media_publish`, token, { creation_id: containerId });
    } catch (e) {
      if (attempt === 0 && isNotReady(e)) {
        await sleep(IG_PUBLISH_RETRY_MS);
        continue;
      }
      if (isTransientRefusal(e)) {
        // "Error temporal" de Meta: a veces igual publica. Si el contenedor figura PUBLISHED, es un éxito
        if (await igContainerPublished(containerId, token)) return { id: null, confirmedAfterCut: true, note: CONFIRMED_AFTER_ERROR };
        throw e;
      }
      if (!isUnknownOutcome(e)) throw e; // rechazo claro o la red cortó antes de mandar: nada se publicó
    }
    if (pub && pub.id) return { id: String(pub.id) };
    // La respuesta pudo perderse con el posteo ya hecho: evitar duplicados
    if (await igContainerPublished(containerId, token)) return { id: null, confirmedAfterCut: true };
    throw ambiguousError('Instagram');
  }
}

async function publishInstagram(creds, task) {
  const c = creds || {};
  if (!c.igToken) {
    throw userError('Instagram: falta conectar la cuenta (token de Instagram). Entrá a Conexiones y conectá Instagram.', { needsReconnect: true });
  }
  const media = resolveMedia(task);
  if (!media.url) throw userError('Instagram: falta la imagen o el video');
  if (media.kind === 'webm') throw userError('Instagram no acepta videos .webm. Exportalo como MP4 (H.264).');
  if (media.kind !== 'image' && media.kind !== 'video') {
    throw userError('Instagram: no reconozco si el archivo es una imagen o un video. Usá JPG/PNG o MP4/MOV.');
  }
  const { isStory, isReel } = contentFlags(task);
  const caption = captionOf(task);
  const params = {};
  if (isStory) {
    params.media_type = 'STORIES';
    if (media.kind === 'video') params.video_url = media.url;
    else params.image_url = media.url;
  } else if (media.kind === 'video') {
    validateInstagramCaption(caption);
    params.media_type = 'REELS';
    params.video_url = media.url;
    params.caption = caption;
    params.share_to_feed = 'true';
    if (task.thumbUrl) params.cover_url = task.thumbUrl;
  } else {
    if (isReel) throw userError('Instagram: un reel necesita un video, no una imagen.');
    validateInstagramCaption(caption);
    params.image_url = media.url;
    params.caption = caption;
  }

  const token = c.igToken;
  let igUserId = c.igUserId ? String(c.igUserId).trim() : '';
  if (!igUserId) {
    const me = await igGet('me', token, { fields: 'user_id,username' });
    igUserId = String(me.user_id || me.id || '');
    if (!igUserId) throw userError('Instagram: no pude obtener el ID de la cuenta. Reconectá Instagram.', { needsReconnect: true });
  }

  const container = await igPost(`${seg(igUserId)}/media`, token, params);
  if (!container.id) throw userError('Instagram: no se pudo crear el contenido.', { transient: true });
  await waitForContainer(container.id, token, media.kind);
  const pub = await publishContainer(igUserId, container.id, token);
  if (!pub.id) return { warnings: [pub.note || CONFIRMED_AFTER_CUT] };
  const mediaId = pub.id;

  let url;
  try {
    const info = await igGet(seg(mediaId), token, { fields: 'permalink' });
    url = info.permalink || undefined;
  } catch (_) { /* el link es opcional */ }
  return { id: mediaId, url };
}

// ---------------------------------------------------------------------------
// Tarea del calendario → resultados (uno por Facebook / Instagram). Nunca lanza.
// ---------------------------------------------------------------------------
async function runPublish(platform, creds, fn) {
  try {
    const r = (await fn()) || {};
    const out = { platform };
    if (r.id) out.id = String(r.id);
    if (r.url) out.url = r.url;
    const warnings = (r.warnings || []).slice();
    if (!(creds && creds.liveMode)) warnings.push(LIVE_MODE_WARNING);
    if (warnings.length) out.warnings = warnings;
    return out;
  } catch (e) {
    const k = classifyError(e, platform);
    const out = { platform, error: k.message };
    if (k.ambiguous) {
      // Puede haberse publicado: no se reintenta solo
      out.transient = false;
      out.ambiguous = true;
    } else if (k.transient) {
      out.transient = true;
    }
    if (k.needsReconnect) out.needsReconnect = true;
    return out;
  }
}

async function publishForTask(creds, task) {
  const t = task || {};
  const c = creds || {};
  const plats = Array.from(new Set(Array.isArray(t.platforms) ? t.platforms : []))
    .filter((p) => p === 'Facebook' || p === 'Instagram');
  try {
    const jobs = plats.map((plat) => (plat === 'Facebook'
      ? runPublish('Facebook', c, () => publishFacebook(c, t))
      : runPublish('Instagram', c, () => publishInstagram(c, t))));
    return await Promise.all(jobs); // en paralelo; el orden sigue al de task.platforms
  } catch (e) {
    return plats.map((platform) => ({ platform, error: `${platform}: error inesperado al publicar (${e && e.message}).` }));
  }
}

module.exports = {
  connectFacebook,
  normalizeFacebookToken,
  connectInstagram,
  normalizeInstagramToken,
  maintainFacebook,
  maintainInstagram,
  publishForTask,
  // Para pruebas
  _META_API_VERSION: META_API_VERSION,
  _classifyError: classifyError,
  _validateInstagramCaption: validateInstagramCaption,
  _setSleep: (fn) => { sleep = fn; },
};

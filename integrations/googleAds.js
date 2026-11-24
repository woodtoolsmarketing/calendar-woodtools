/*
 * integrations/googleAds.js — Google Ads API (REST v26).
 * Lee campañas + métricas (searchStream con GAQL) y pausa/activa campañas (campaigns:mutate).
 *
 * Autenticación: OAuth2 de USUARIO (token Bearer). Google ELIMINÓ el "developer token" el 9/9/2026;
 * ahora el nivel de acceso va por el PROYECTO de Google Cloud dueño del cliente OAuth. Reutilizamos el
 * cliente OAuth que la app ya tiene (mismo proyecto que YouTube), sumando el permiso
 * https://www.googleapis.com/auth/adwords. NO se manda el header developer-token (es ignorado).
 *
 * El proyecto necesita acceso de producción (Explorer o Basic) en la Cloud Console; si no, la API
 * responde CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION.
 */
const oauth = require('./oauth');

const API_VERSION = 'v26';
const BASE = 'https://googleads.googleapis.com/' + API_VERSION;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const TIMEOUT_MS = 30 * 1000;

function gadsError(message, extra) {
  const e = new Error(message);
  e.local = true;
  Object.assign(e, extra || {});
  return e;
}

// customerId → solo dígitos (Google exige el ID sin guiones: 123-456-7890 → 1234567890)
function cid(customerId) { return String(customerId || '').replace(/\D/g, ''); }

// Extrae el mensaje de error de la respuesta de Google Ads (error.details[].errors[].message)
function apiErr(json, status) {
  const g = json && json.error;
  let msg = (g && g.message) || '';
  const details = g && g.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const errs = d && d.errors;
      if (Array.isArray(errs) && errs[0] && errs[0].message) { msg = errs[0].message; break; }
    }
  }
  const e = new Error(msg || ('HTTP ' + status));
  e.gads = g; e.httpStatus = status;
  return e;
}

// Traduce errores a mensajes claros en castellano con banderas (needsReconnect/needsAccess/network/transient)
function toUserError(e) {
  if (e && e.local) return e;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return gadsError('Google Ads no respondió a tiempo. Revisá la conexión.', { network: true });
  }
  if (e && /fetch failed|ENOTFOUND|ECONNRESET|network/i.test(String(e.message))) {
    return gadsError('Sin conexión a internet o Google Ads no responde.', { network: true });
  }
  const status = e && e.httpStatus;
  const msg = (e && e.message) || 'error';
  if (/CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION|not approved for production/i.test(msg)) {
    return gadsError('Tu proyecto de Google Cloud todavía no tiene acceso de producción. Aplicá a Explorer/Basic en la Cloud Console (Google Ads API → Overview).', { needsAccess: true });
  }
  if (/AUTHORIZATION_ERROR/i.test(msg)) {
    return gadsError('Google Ads rechazó la autorización del proyecto (problema conocido tras el cambio de set-2026). Puede necesitar un proyecto de Cloud nuevo.', { needsAccess: true });
  }
  if (status === 401 || /UNAUTHENTICATED|invalid.*credential|invalid.*token/i.test(msg)) {
    return gadsError('Google rechazó el acceso a Google Ads. Reconectá Google Ads.', { needsReconnect: true });
  }
  if (status === 403 || /PERMISSION_DENIED|USER_PERMISSION|not permitted|ACTION_NOT_PERMITTED/i.test(msg)) {
    return gadsError('Falta permiso para esta cuenta de Google Ads. Revisá el Customer ID y que tu usuario tenga acceso.', {});
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|RATE_EXCEEDED|QUOTA/i.test(msg)) {
    return gadsError('Google Ads pidió esperar (límite de la API). Probá de nuevo en un rato.', { transient: true });
  }
  return gadsError('Google Ads devolvió un error: ' + msg + (status ? ` (HTTP ${status})` : ''));
}

// ---------------------------------------------------------------------------
// OAuth: conexión (consentimiento) con el NAVEGADOR DEL SISTEMA (loopback + PKCE), reutilizando el
// cliente OAuth de la app (el mismo de YouTube, mismo proyecto de Google Cloud) con el scope adwords.
// ---------------------------------------------------------------------------
async function connect(creds) {
  if (!creds || !creds.clientId || !creds.clientSecret) {
    throw gadsError('Falta el Client ID/Secret de Google. Se reutilizan los de tu conexión de YouTube: conectá YouTube primero (⚙ Conexiones).', { needsClient: true });
  }
  let auth;
  try {
    auth = await oauth.authorizeLoopback({
      authBaseUrl: AUTH_URL,
      clientId: creds.clientId,
      scope: SCOPE,
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      pkce: true, pkceEncoding: 'base64url', useSystemBrowser: true,
    });
  } catch (e) {
    if (/access_denied/i.test((e && e.message) || '')) throw gadsError('No se aceptó el permiso de Google Ads. Volvé a Conectar y aceptá.', {});
    throw e;
  }
  const body = new URLSearchParams({
    code: auth.code, client_id: creds.clientId, client_secret: creds.clientSecret,
    redirect_uri: auth.redirectUri, grant_type: 'authorization_code',
  });
  if (auth.codeVerifier) body.set('code_verifier', auth.codeVerifier);
  let res;
  try { res = await fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw toUserError(e); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.error) {
    throw gadsError('Google rechazó la conexión de Google Ads: ' + ((json && json.error_description) || (json && json.error) || ('HTTP ' + res.status)));
  }
  if (!json.refresh_token) {
    throw gadsError('Google no devolvió un refresh token. Quitá el acceso de la app en myaccount.google.com/permissions y reconectá.', {});
  }
  const granted = String(json.scope || '').split(/\s+/).filter(Boolean);
  if (granted.length && !granted.includes(SCOPE)) {
    throw gadsError('No quedó tildado el permiso de Google Ads en la pantalla de Google. Reconectá y aceptá.', {});
  }
  return { refreshToken: json.refresh_token, scope: json.scope || SCOPE, connectedAt: Date.now() };
}

// Access token a partir del refresh token (mismo cliente OAuth que YouTube)
async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  if (!refreshToken) throw gadsError('Google Ads no está conectado. Conectalo en ⚙ Conexiones.', { needsReconnect: true });
  const body = new URLSearchParams({
    client_id: clientId || '', client_secret: clientSecret || '',
    refresh_token: refreshToken, grant_type: 'refresh_token',
  });
  let res;
  try { res = await fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw toUserError(e); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.access_token) {
    if (json && /invalid_grant/i.test(json.error || '')) {
      throw gadsError('Google revocó o venció el acceso a Google Ads. Reconectá.', { needsReconnect: true });
    }
    if (json && /invalid_client/i.test(json.error || '')) {
      throw gadsError('El cliente OAuth de Google no es válido (¿se borró?). Revisalo en ⚙ Conexiones.', { needsReconnect: true, clientProblem: true });
    }
    throw gadsError('No se pudo renovar el acceso a Google Ads.', { needsReconnect: true });
  }
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Lectura: searchStream con GAQL
// ---------------------------------------------------------------------------
// Agregado por campaña (una fila por campaña, 30 días). SIN segments.date → métricas sumadas del período.
const GAQL_CAMPAIGNS =
  'SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, ' +
  'metrics.cost_micros, metrics.conversions, metrics.average_cpc ' +
  "FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status != 'REMOVED'";

// Diario (una fila por campaña por día) para la tendencia. Se agrupa por fecha.
// Nota: NO se filtra por campaign.status != 'REMOVED': campaign.status es el estado ACTUAL (no por fecha),
// así que ese filtro descartaría el gasto histórico de campañas hoy eliminadas. Los totales diarios deben
// reflejar el gasto REAL (incluye campañas pausadas y eliminadas que gastaron esos días).
const GAQL_DAILY =
  'SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions ' +
  'FROM campaign WHERE segments.date DURING LAST_30_DAYS';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// searchStream devuelve un ARRAY de lotes: [{ results:[GoogleAdsRow...] }, ...] → aplana a [row...]
function parseSearchStream(json) {
  const out = [];
  const batches = Array.isArray(json) ? json : (json ? [json] : []);
  for (const b of batches) {
    const results = b && b.results;
    if (Array.isArray(results)) for (const r of results) out.push(r);
  }
  return out;
}

// GoogleAdsRow → objeto campaña. REST usa camelCase (costMicros, averageCpc) y números como string.
function mapCampaignRow(r) {
  const c = (r && r.campaign) || {};
  const m = (r && r.metrics) || {};
  const impressions = num(m.impressions);
  const clicks = num(m.clicks);
  return {
    id: String(c.id || ''),
    name: c.name || '(sin nombre)',
    status: c.status || '',                 // ENABLED | PAUSED | REMOVED
    running: c.status === 'ENABLED',
    impressions,
    clicks,
    cost: num(m.costMicros) / 1e6,          // micros → unidad monetaria
    conversions: num(m.conversions),
    avgCpc: num(m.averageCpc) / 1e6,
    ctr: impressions ? (clicks / impressions) * 100 : 0,
  };
}

async function searchStream(accessToken, customerId, query) {
  const url = `${BASE}/customers/${cid(customerId)}/googleAds:searchStream`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) { throw toUserError(e); }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { throw gadsError(`Google Ads respondió algo inesperado (HTTP ${res.status}).`); }
  if (!res.ok) throw toUserError(apiErr(json, res.status));
  return parseSearchStream(json);
}

// Campañas con métricas de 30 días (agrupa por id por las dudas que Google parta en varias filas).
async function getCampaigns(accessToken, customerId) {
  const rows = await searchStream(accessToken, customerId, GAQL_CAMPAIGNS);
  const byId = {};
  for (const r of rows) {
    const c = mapCampaignRow(r);
    if (!c.id) continue;
    const cur = byId[c.id];
    if (!cur) byId[c.id] = c;
    else { cur.impressions += c.impressions; cur.clicks += c.clicks; cur.cost += c.cost; cur.conversions += c.conversions; }
  }
  const list = Object.values(byId);
  for (const c of list) c.ctr = c.impressions ? (c.clicks / c.impressions) * 100 : 0;
  list.sort((a, b) => b.cost - a.cost);
  return list;
}

// Totales diarios (sumando todas las campañas por fecha) para la tendencia del tablero.
async function getDailyTotals(accessToken, customerId) {
  const rows = await searchStream(accessToken, customerId, GAQL_DAILY);
  const byDay = {};
  for (const r of rows) {
    const day = (r && r.segments && r.segments.date) || '';
    if (!day) continue;
    const m = (r && r.metrics) || {};
    const d = byDay[day] || (byDay[day] = { day, impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    d.impressions += num(m.impressions);
    d.clicks += num(m.clicks);
    d.cost += num(m.costMicros) / 1e6;
    d.conversions += num(m.conversions);
  }
  const list = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const d of list) d.ctr = d.impressions ? (d.clicks / d.impressions) * 100 : 0;
  return list;
}

// Igual que getDailyTotals pero para un rango ARBITRARIO [since, until] (YYYY-MM-DD). Para backfill del historial.
async function getDailyBetween(accessToken, customerId, since, until) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('rango inválido');
  // Sin filtro de estado: campaign.status es el estado ACTUAL, filtrar por != 'REMOVED' borraría el
  // gasto histórico de campañas hoy eliminadas (subcontaría meses viejos). Los totales diarios = gasto real.
  const gaql =
    'SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions ' +
    `FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;
  const rows = await searchStream(accessToken, customerId, gaql);
  const byDay = {};
  for (const r of rows) {
    const day = (r && r.segments && r.segments.date) || '';
    if (!day) continue;
    const m = (r && r.metrics) || {};
    const d = byDay[day] || (byDay[day] = { day, impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    d.impressions += num(m.impressions);
    d.clicks += num(m.clicks);
    d.cost += num(m.costMicros) / 1e6;
    d.conversions += num(m.conversions);
  }
  const list = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const d of list) d.ctr = d.impressions ? (d.clicks / d.impressions) * 100 : 0;
  return list;
}

// ---------------------------------------------------------------------------
// Escritura: pausar / activar una campaña (campaigns:mutate). GASTA/!gasta plata real.
// ---------------------------------------------------------------------------
async function setCampaignStatus(accessToken, customerId, campaignId, status, opts) {
  const s = String(status || '').toUpperCase();
  if (s !== 'ENABLED' && s !== 'PAUSED') throw gadsError('Estado inválido (solo ENABLED o PAUSED).');
  if (!campaignId) throw gadsError('Falta la campaña.');
  const c = cid(customerId);
  const body = {
    operations: [{
      update: { resourceName: `customers/${c}/campaigns/${campaignId}`, status: s },
      updateMask: 'status',
    }],
  };
  if (opts && opts.validateOnly) body.validateOnly = true; // valida sin aplicar (dry-run)
  const url = `${BASE}/customers/${c}/campaigns:mutate`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) { throw toUserError(e); }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = null; }
  if (!res.ok) throw toUserError(apiErr(json, res.status));
  return json;
}

// customerId (desde me/listAccessibleCustomers si hiciera falta elegir; por ahora el usuario lo carga)
async function listAccessibleCustomers(accessToken) {
  const url = `${BASE}/customers:listAccessibleCustomers`;
  let res;
  try { res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw toUserError(e); }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = null; }
  if (!res.ok) throw toUserError(apiErr(json, res.status));
  // devuelve { resourceNames: ["customers/1234567890", ...] }
  return ((json && json.resourceNames) || []).map((rn) => String(rn).split('/').pop());
}

module.exports = {
  connect,
  getCampaigns,
  getDailyTotals,
  getDailyBetween,
  setCampaignStatus,
  refreshAccessToken,
  listAccessibleCustomers,
  // puras (para pruebas)
  parseSearchStream,
  mapCampaignRow,
  cid,
  GAQL_CAMPAIGNS,
  GAQL_DAILY,
  SCOPE,
  API_VERSION,
  _toUserError: toUserError,
};

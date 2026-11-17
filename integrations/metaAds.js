/*
 * integrations/metaAds.js — Rendimiento de campañas de Meta / Instagram Ads.
 *
 * FASE 1: SOLO LECTURA (permiso ads_read). No activa, pausa ni crea nada.
 * "Anuncios de Instagram" = anuncios de Meta con ubicación de Instagram: todo sale de la
 * misma cuenta publicitaria (act_...), así que una sola integración cubre ambos.
 *
 * Token: idealmente un "Usuario del sistema" (System User) del Business Manager, que no vence.
 * También sirve un token de usuario con ads_read mientras no venza.
 *
 * Los datos de rendimiento viven en los servidores de Meta, no en esta PC: cuando la app
 * arranca a la mañana pide el rango que falta (incluida la noche) y Meta devuelve todo. Por eso
 * no hace falta un servidor prendido de noche (eso lo resuelve el sondeo en main.js + adsStore).
 */
const META_API_VERSION = 'v25.0';
const GRAPH = 'https://graph.facebook.com/' + META_API_VERSION;
const TIMEOUT_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function buildUrl(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function adsError(message, extra) {
  const e = new Error(message);
  e.local = true;
  Object.assign(e, extra || {});
  return e;
}

// Traduce errores de Graph a mensajes claros en castellano
function toUserError(e) {
  if (e && e.local) return e;
  const g = e && e.graph ? e.graph : null;
  const code = g ? Number(g.code) : null;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return adsError('Meta no respondió a tiempo. Revisá la conexión a internet.', { network: true });
  }
  if (e && /fetch failed|ENOTFOUND|ECONNRESET|network/i.test(String(e.message))) {
    return adsError('Sin conexión a internet o Meta no responde.', { network: true });
  }
  if (code === 190) return adsError('El token de anuncios venció o fue revocado. Generá uno nuevo y volvé a conectar Publicidad.', { needsReconnect: true });
  if (code === 10 || code === 200 || code === 294 || code === 299) {
    return adsError('Al token le falta el permiso de anuncios (ads_read para ver; ads_management para activar, pausar o crear). Generá el token con ese permiso y volvé a conectar.', { needsReconnect: true });
  }
  if (code === 17 || code === 4 || code === 613) return adsError('Meta pidió esperar (límite de consultas). Probá de nuevo en unos minutos.', { transient: true });
  const detail = g && g.message ? g.message : (e && e.message) || 'error desconocido';
  return adsError('Meta devolvió un error: ' + detail + (code ? ' (código ' + code + ')' : ''));
}

async function graphGet(pathStr, token, params, timeout) {
  if (!token) throw adsError('Falta el token de anuncios. Conectá Publicidad primero.', { needsReconnect: true });
  const url = buildUrl(`${GRAPH}/${pathStr}`, { ...params, access_token: token });
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout || TIMEOUT_MS) });
  } catch (e) {
    throw toUserError(e);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) {
    throw adsError(`Meta respondió algo inesperado (HTTP ${res.status}).`);
  }
  if (json && json.error) {
    const err = new Error(json.error.message || 'error');
    err.graph = json.error;
    throw toUserError(err);
  }
  return json;
}

// act_123 ⟷ 123 (acepta cualquiera de las dos formas)
function actId(adAccountId) {
  const s = String(adAccountId || '').trim();
  return s.startsWith('act_') ? s : 'act_' + s;
}

// ---------------------------------------------------------------------------
// Llamadas a la API (lectura)
// ---------------------------------------------------------------------------
// Lista las cuentas publicitarias a las que el token tiene acceso
async function listAdAccounts(token) {
  const json = await graphGet('me/adaccounts', token, {
    fields: 'account_id,name,account_status,currency,timezone_name',
    limit: 200,
  });
  return (json.data || []).map((a) => ({
    id: String(a.account_id),
    name: a.name || ('Cuenta ' + a.account_id),
    status: Number(a.account_status) || 0,
    active: Number(a.account_status) === 1,
    currency: a.currency || '',
    timezone: a.timezone_name || '',
  }));
}

// Campañas de la cuenta (sin métricas)
async function getCampaigns(token, adAccountId) {
  const json = await graphGet(`${actId(adAccountId)}/campaigns`, token, {
    fields: 'name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time',
    limit: 500,
  });
  return (json.data || []).map((c) => ({
    id: String(c.id),
    name: c.name || '(sin nombre)',
    status: c.status || '',
    effectiveStatus: c.effective_status || c.status || '',
    running: (c.effective_status || c.status) === 'ACTIVE',
    objective: c.objective || '',
    // Los presupuestos vienen en la unidad MÍNIMA (centavos) → /100
    dailyBudget: c.daily_budget != null ? Number(c.daily_budget) / 100 : null,
    lifetimeBudget: c.lifetime_budget != null ? Number(c.lifetime_budget) / 100 : null,
    startTime: c.start_time || null,
    stopTime: c.stop_time || null,
  }));
}

// Insights por campaña, con una fila por día (time_increment=1)
async function getInsights(token, adAccountId, { since, until, level = 'campaign', timeIncrement = 1 } = {}) {
  const params = {
    level,
    fields: 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,cpm,actions',
    limit: 1000,
  };
  if (since && until) params.time_range = JSON.stringify({ since, until });
  if (timeIncrement) params.time_increment = timeIncrement;
  const json = await graphGet(`${actId(adAccountId)}/insights`, token, params);
  return json.data || [];
}

// Insights con desglose por plataforma (Facebook / Instagram / Messenger / Audience Network).
// Instagram es una UBICACIÓN de Meta Ads: esto parte las métricas de cada campaña por red.
async function getInsightsByPlatform(token, adAccountId, { since, until, timeIncrement = 1 } = {}) {
  const params = {
    level: 'campaign',
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,reach,actions',
    breakdowns: 'publisher_platform',
    limit: 1000,
  };
  if (since && until) params.time_range = JSON.stringify({ since, until });
  if (timeIncrement) params.time_increment = timeIncrement;
  const json = await graphGet(`${actId(adAccountId)}/insights`, token, params);
  return json.data || [];
}

// ---------------------------------------------------------------------------
// Escritura (Fase 2: activar/pausar) — requiere ads_management
// ---------------------------------------------------------------------------
async function graphPost(pathStr, token, params, timeout) {
  if (!token) throw adsError('Falta el token de anuncios.', { needsReconnect: true });
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  body.set('access_token', token);
  let res;
  try {
    res = await fetch(`${GRAPH}/${pathStr}`, { method: 'POST', body, signal: AbortSignal.timeout(timeout || TIMEOUT_MS) });
  } catch (e) {
    throw toUserError(e);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) {
    throw adsError(`Meta respondió algo inesperado (HTTP ${res.status}).`);
  }
  if (json && json.error) {
    const err = new Error(json.error.message || 'error');
    err.graph = json.error;
    throw toUserError(err);
  }
  return json;
}

// status: 'ACTIVE' | 'PAUSED'. Mismo endpoint para campaña, conjunto o anuncio.
async function setEntityStatus(token, id, status) {
  const s = String(status || '').toUpperCase();
  if (s !== 'ACTIVE' && s !== 'PAUSED') throw adsError('Estado inválido (solo ACTIVE o PAUSED).');
  if (!id) throw adsError('Falta el identificador de la campaña.');
  return graphPost(String(id), token, { status: s });
}

// ---------------------------------------------------------------------------
// Fase 3: promocionar una publicación existente (se crea EN PAUSA)
// ---------------------------------------------------------------------------
// Lista las publicaciones recientes de la Página (usa el token de la Página).
async function getPagePosts(pageToken, pageId, limit = 25) {
  if (!pageId) throw adsError('Falta la Página. Conectá Facebook primero.');
  const json = await graphGet(`${pageId}/posts`, pageToken, {
    fields: 'id,message,story,created_time,full_picture,permalink_url',
    limit,
  });
  return (json.data || []).map((p) => ({
    id: String(p.id),
    postId: String(p.id).includes('_') ? String(p.id).split('_')[1] : String(p.id),
    message: p.message || p.story || '(publicación sin texto)',
    createdTime: p.created_time || null,
    picture: p.full_picture || null,
    permalink: p.permalink_url || null,
  }));
}

const OPT_GOAL = { OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT', OUTCOME_TRAFFIC: 'LINK_CLICKS', OUTCOME_AWARENESS: 'REACH' };
function optimizationGoalFor(objective) { return OPT_GOAL[objective] || 'POST_ENGAGEMENT'; }

// --- Constructores puros de los pedidos (testeables) ---
function boostCampaignParams(name, objective) {
  return { name, objective: objective || 'OUTCOME_ENGAGEMENT', status: 'PAUSED', special_ad_categories: JSON.stringify([]) };
}
function boostAdsetParams({ name, campaignId, dailyBudget, countries, objective, startMs, endMs }) {
  return {
    name,
    campaign_id: campaignId,
    daily_budget: Math.round(Number(dailyBudget) * 100), // a centavos (unidad mínima)
    billing_event: 'IMPRESSIONS',
    optimization_goal: optimizationGoalFor(objective),
    start_time: Math.floor(Number(startMs) / 1000),
    end_time: Math.floor(Number(endMs) / 1000),
    targeting: { geo_locations: { countries: (countries && countries.length) ? countries : ['AR'] }, age_min: 18, age_max: 65 },
    status: 'PAUSED',
  };
}
function boostCreativeParams({ name, pageId, postId }) {
  return { name, object_story_id: `${pageId}_${postId}` };
}
function boostAdParams({ name, adsetId, creativeId }) {
  return { name, adset_id: adsetId, creative: { creative_id: creativeId }, status: 'PAUSED' };
}

// Crea campaña → conjunto → creativo → anuncio, TODO en PAUSA. Devuelve los ids.
async function createBoost(token, adAccountId, opts) {
  const o = opts || {};
  const act = actId(adAccountId);
  const name = o.name || ('Promoción ' + (o.postId || '') + ' · ' + o.days + 'd');
  if (!o.pageId || !o.postId) throw adsError('Falta la publicación o la Página.');

  const campaign = await graphPost(`${act}/campaigns`, token, boostCampaignParams(name, o.objective));
  const campaignId = campaign && campaign.id;
  if (!campaignId) throw adsError('No se pudo crear la campaña.');

  const adset = await graphPost(`${act}/adsets`, token, boostAdsetParams({
    name, campaignId, dailyBudget: o.dailyBudget, countries: o.countries, objective: o.objective, startMs: o.startMs, endMs: o.endMs,
  }));
  const adsetId = adset && adset.id;
  if (!adsetId) throw adsError('No se pudo crear el conjunto de anuncios.');

  const creative = await graphPost(`${act}/adcreatives`, token, boostCreativeParams({ name, pageId: o.pageId, postId: o.postId }));
  const creativeId = creative && creative.id;
  if (!creativeId) throw adsError('No se pudo crear el creativo (¿la publicación es apta para anuncios?).');

  const ad = await graphPost(`${act}/ads`, token, boostAdParams({ name, adsetId, creativeId }));
  return { campaignId, adsetId, creativeId, adId: ad && ad.id };
}

// ---------------------------------------------------------------------------
// Helpers puros (testeables sin red)
// ---------------------------------------------------------------------------
// Resultados "útiles" según el tipo de acción (mensajes, leads, compras, clics…)
const RESULT_MATCHERS = [
  { key: 'mensajes', label: 'Mensajes iniciados', test: (t) => /messaging_conversation_started/.test(t) },
  { key: 'leads', label: 'Clientes potenciales', test: (t) => t === 'lead' || /onsite_conversion\.lead_grouped|leadgen/.test(t) },
  { key: 'compras', label: 'Compras', test: (t) => /purchase/.test(t) },
  { key: 'registros', label: 'Registros completados', test: (t) => /complete_registration/.test(t) },
  { key: 'linkClicks', label: 'Clics en el enlace', test: (t) => t === 'link_click' },
  { key: 'interacciones', label: 'Interacciones con la publicación', test: (t) => t === 'post_engagement' },
];

// actions[] → { mensajes, leads, compras, linkClicks, interacciones, registros, total }
function pickResults(actions) {
  const out = { mensajes: 0, leads: 0, compras: 0, registros: 0, linkClicks: 0, interacciones: 0 };
  for (const a of Array.isArray(actions) ? actions : []) {
    const type = String(a.action_type || '');
    const val = Number(a.value) || 0;
    for (const m of RESULT_MATCHERS) {
      if (m.test(type)) { out[m.key] += val; break; }
    }
  }
  return out;
}

// "Resultado principal" para mostrar en una línea, según prioridad
function primaryResult(results) {
  const order = [
    ['compras', 'compras'], ['leads', 'clientes potenciales'], ['mensajes', 'mensajes'],
    ['registros', 'registros'], ['linkClicks', 'clics en el enlace'], ['interacciones', 'interacciones'],
  ];
  for (const [key, label] of order) {
    if (results[key] > 0) return { key, label, value: results[key] };
  }
  return { key: null, label: 'resultados', value: 0 };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Suma una lista de filas de insights en un total
function aggregateRows(rows) {
  const total = { spend: 0, impressions: 0, reach: 0, clicks: 0, results: { mensajes: 0, leads: 0, compras: 0, registros: 0, linkClicks: 0, interacciones: 0 } };
  for (const r of Array.isArray(rows) ? rows : []) {
    total.spend += num(r.spend);
    total.impressions += num(r.impressions);
    total.reach += num(r.reach);
    total.clicks += num(r.clicks);
    const res = pickResults(r.actions);
    for (const k of Object.keys(total.results)) total.results[k] += res[k] || 0;
  }
  total.ctr = total.impressions ? (total.clicks / total.impressions) * 100 : 0;
  total.cpc = total.clicks ? total.spend / total.clicks : 0;
  total.cpm = total.impressions ? (total.spend / total.impressions) * 1000 : 0;
  return total;
}

// Cuántos días hacia atrás pedir según cuándo se sincronizó por última vez.
// Nunca sincronizado o hace > 7 días → 30 días; si no → 7 (ventana que se auto-repara).
function fetchWindowDays(lastSyncAt, nowMs) {
  const now = Number(nowMs) || 0;
  const last = Number(lastSyncAt) || 0;
  if (!last) return 30;
  const gapDays = (now - last) / (24 * 60 * 60 * 1000);
  if (gapDays > 7) return 30;
  return 7;
}

// YYYY-MM-DD de una fecha local
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Rango {since, until} de los últimos `days` días contando hoy (fechas locales)
function rangeForDays(days, nowDate) {
  const until = nowDate;
  const since = new Date(until.getFullYear(), until.getMonth(), until.getDate() - (days - 1));
  return { since: ymd(since), until: ymd(until) };
}

// Claves YYYY-MM-DD de los últimos n días contando hoy (fechas locales)
function lastNDayKeys(n, nowDate) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
    out.push(ymd(d));
  }
  return out;
}

function emptyTotals() {
  return { spend: 0, impressions: 0, reach: 0, clicks: 0, results: { mensajes: 0, leads: 0, compras: 0, registros: 0, linkClicks: 0, interacciones: 0 } };
}

// Suma las fotos diarias guardadas (daysObj = { 'YYYY-MM-DD': {spend,impressions,...,results} })
// de los últimos n días. Nota: 'reach' sumado entre días es aproximado (no es alcance único).
function sumDays(daysObj, n, nowDate) {
  const t = emptyTotals();
  for (const k of lastNDayKeys(n, nowDate)) {
    const day = daysObj && daysObj[k];
    if (!day) continue;
    t.spend += num(day.spend); t.impressions += num(day.impressions);
    t.reach += num(day.reach); t.clicks += num(day.clicks);
    const res = day.results || {};
    for (const key of Object.keys(t.results)) t.results[key] += num(res[key]);
  }
  t.ctr = t.impressions ? (t.clicks / t.impressions) * 100 : 0;
  t.cpc = t.clicks ? t.spend / t.clicks : 0;
  t.cpm = t.impressions ? (t.spend / t.impressions) * 1000 : 0;
  return t;
}

// --- Desglose por plataforma (Facebook / Instagram / …) ---
function normalizePlatform(p) {
  const s = String(p || '').toLowerCase();
  return ['facebook', 'instagram', 'messenger', 'audience_network'].includes(s) ? s : 'other';
}
function emptyPlatMetric() {
  return { spend: 0, impressions: 0, clicks: 0, reach: 0, results: { mensajes: 0, leads: 0, compras: 0, registros: 0, linkClicks: 0, interacciones: 0 } };
}
function addPlatMetric(t, m) {
  if (!m) return;
  t.spend += num(m.spend); t.impressions += num(m.impressions);
  t.clicks += num(m.clicks); t.reach += num(m.reach);
  const res = m.results || {};
  for (const k of Object.keys(t.results)) t.results[k] += num(res[k]);
}

// Suma el desglose por plataforma guardado en las fotos diarias, sobre un conjunto de días.
// campaignId opcional: si se pasa, suma el de esa campaña; si no, el total de la cuenta.
// Devuelve { facebook:{...}, instagram:{...}, ... } (solo las plataformas con datos).
function sumPlatformForKeys(daysObj, keys, campaignId) {
  const out = {};
  for (const k of keys || []) {
    const day = daysObj && daysObj[k];
    if (!day) continue;
    const src = campaignId
      ? (day.perCampaign && day.perCampaign[campaignId] && day.perCampaign[campaignId].platforms)
      : day.platforms;
    if (!src) continue;
    for (const [plat, m] of Object.entries(src)) {
      if (!out[plat]) out[plat] = emptyPlatMetric();
      addPlatMetric(out[plat], m);
    }
  }
  return out;
}
function sumPlatformDays(daysObj, n, nowDate, campaignId) {
  return sumPlatformForKeys(daysObj, lastNDayKeys(n, nowDate), campaignId);
}

// --- Totales por CUENTA (para el selector de cuenta) ---
// Lee day.byAccount[accId] (guardado por el sondeo multi-cuenta).
function sumAccountForKeys(daysObj, accId, keys) {
  const t = emptyTotals();
  for (const k of keys || []) {
    const day = daysObj && daysObj[k];
    const ab = day && day.byAccount && day.byAccount[accId];
    if (!ab) continue;
    t.spend += num(ab.spend); t.impressions += num(ab.impressions);
    t.reach += num(ab.reach); t.clicks += num(ab.clicks);
    const res = ab.results || {};
    for (const key of Object.keys(t.results)) t.results[key] += num(res[key]);
  }
  t.ctr = t.impressions ? (t.clicks / t.impressions) * 100 : 0;
  t.cpc = t.clicks ? t.spend / t.clicks : 0;
  t.cpm = t.impressions ? (t.spend / t.impressions) * 1000 : 0;
  return t;
}
function sumAccountPlatformForKeys(daysObj, accId, keys) {
  const out = {};
  for (const k of keys || []) {
    const day = daysObj && daysObj[k];
    const platforms = day && day.byAccount && day.byAccount[accId] && day.byAccount[accId].platforms;
    if (!platforms) continue;
    for (const [plat, m] of Object.entries(platforms)) {
      if (!out[plat]) out[plat] = emptyPlatMetric();
      addPlatMetric(out[plat], m);
    }
  }
  return out;
}

// Agrupa filas diarias por campaña → { [campaignId]: { name, byDay: {YYYY-MM-DD: row}, total } }
function groupByCampaign(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = String(r.campaign_id || '');
    if (!id) continue;
    if (!out[id]) out[id] = { id, name: r.campaign_name || '', rows: [] };
    out[id].rows.push(r);
  }
  for (const id of Object.keys(out)) out[id].total = aggregateRows(out[id].rows);
  return out;
}

module.exports = {
  // API
  listAdAccounts,
  getCampaigns,
  getInsights,
  getInsightsByPlatform,
  setEntityStatus,
  getPagePosts,
  createBoost,
  actId,
  // constructores puros (para pruebas)
  boostCampaignParams,
  boostAdsetParams,
  boostCreativeParams,
  boostAdParams,
  optimizationGoalFor,
  // helpers puros
  pickResults,
  primaryResult,
  aggregateRows,
  fetchWindowDays,
  rangeForDays,
  groupByCampaign,
  lastNDayKeys,
  emptyTotals,
  sumDays,
  normalizePlatform,
  emptyPlatMetric,
  addPlatMetric,
  sumPlatformForKeys,
  sumPlatformDays,
  sumAccountForKeys,
  sumAccountPlatformForKeys,
  ymd,
  _toUserError: toUserError,
  _META_API_VERSION: META_API_VERSION,
};

/*
 * integrations/history.js — Lógica PURA del Historial + Comparativa de marketing.
 * Sin electron, sin fs, sin red: todo testeable en aislamiento.
 *
 * Contiene:
 *   1) Matemática de períodos (actual vs anterior) para año/semestre/trimestre/mes/15d/semana/custom.
 *   2) Serialización de la hoja de cálculo CSV es-AR (';' separador, coma decimal, BOM, CRLF) + upsert con merge por fecha.
 *   3) Agregación/comparación de filas diarias -> totales por canal + ratios + deltas + series para el gráfico.
 *   4) Mappers de cada fuente (adsStore.days de Meta, getDailyTotals de Google, fetchFunnel de WhatsApp) a filas de la hoja,
 *      y helpers de backfill (GAQL BETWEEN de Google, agregación de insights crudos de Meta, troceo mensual).
 *
 * Métricas guardadas: sólo ADITIVAS (gasto/impresiones/clics/resultados/conversiones/consultas/ventas).
 * Los ratios (CTR, CVR, costo por consulta/venta) se DERIVAN al comparar. El alcance NO se guarda (no es aditivo entre días).
 * consultas/ventas pueden faltar (vacío) en días sólo de Meta/Google: vacío = sin dato, distinto de 0.
 */

// ===================================================================
// 1) PERÍODOS (UTC, comparación ISO lexicográfica)
// ===================================================================
function pad(n) { return String(n).padStart(2, '0'); }
function ymdToUTC(ymd) { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function utcToYmd(t) { const dt = new Date(t); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; }
function addDays(ymd, n) { return utcToYmd(ymdToUTC(ymd) + n * 86400000); }
function daysInclusive(a, b) { return Math.round((ymdToUTC(b) - ymdToUTC(a)) / 86400000) + 1; }
function startOfMonth(ymd) { return ymd.slice(0, 7) + '-01'; }
function startOfYear(ymd) { return ymd.slice(0, 4) + '-01-01'; }
function startOfQuarter(ymd) { const [y, m] = ymd.split('-').map(Number); const q = Math.floor((m - 1) / 3) * 3 + 1; return `${y}-${pad(q)}-01`; }
function startOfSemester(ymd) { const [y, m] = ymd.split('-').map(Number); return `${y}-${m <= 6 ? '01' : '07'}-01`; }
function endOfMonth(ymd) { const sm = startOfMonth(ymd); return addDays(startOfMonth(addDays(sm, 32)), -1); }
/** ymd LOCAL (no UTC) a partir de un Date — para "hoy"/"ayer" alineado a la fecha de la PC. */
function ymdLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

const PERIOD_TYPES = ['anio', 'semestre', 'trimestre', 'mes', '15dias', 'semana', 'custom'];
const PERIOD_LABELS = {
  anio: 'Año', semestre: 'Medio año', trimestre: 'Trimestre', mes: 'Mes',
  '15dias': 'Últimos 15 días', semana: 'Última semana', custom: 'Personalizado',
};

/** { actual:{from,to,days}, anterior:{from,to,days}, label, clamped } */
function computeWindows(type, today, cFrom, cTo) {
  if (!PERIOD_TYPES.includes(type)) throw new Error('período inválido: ' + type);
  let aStart, aEnd, bStart, bEnd, clamped = false;
  if (type === 'custom') {
    if (!cFrom || !cTo) throw new Error('personalizado requiere desde y hasta');
    aStart = cFrom < cTo ? cFrom : cTo;
    aEnd = cFrom < cTo ? cTo : cFrom;
    const len = daysInclusive(aStart, aEnd);
    bEnd = addDays(aStart, -1);
    bStart = addDays(bEnd, -(len - 1));
  } else if (type === '15dias' || type === 'semana') {
    const span = type === '15dias' ? 15 : 7;
    aEnd = today;
    aStart = addDays(today, -(span - 1));
    bEnd = addDays(aStart, -1);
    bStart = addDays(bEnd, -(span - 1));
  } else {
    let ps;
    if (type === 'mes') ps = startOfMonth(today);
    else if (type === 'trimestre') ps = startOfQuarter(today);
    else if (type === 'semestre') ps = startOfSemester(today);
    else ps = startOfYear(today);
    const prevLastDay = addDays(ps, -1);
    let prevStart;
    if (type === 'mes') prevStart = startOfMonth(prevLastDay);
    else if (type === 'trimestre') prevStart = startOfQuarter(prevLastDay);
    else if (type === 'semestre') prevStart = startOfSemester(prevLastDay);
    else prevStart = startOfYear(prevLastDay);
    aStart = ps;
    aEnd = today;
    const elapsed = daysInclusive(aStart, aEnd);
    bStart = prevStart;
    bEnd = addDays(prevStart, elapsed - 1);
    if (bEnd > prevLastDay) { bEnd = prevLastDay; clamped = true; }
  }
  return {
    actual: { from: aStart, to: aEnd, days: daysInclusive(aStart, aEnd) },
    anterior: { from: bStart, to: bEnd, days: daysInclusive(bStart, bEnd) },
    label: PERIOD_LABELS[type], clamped,
  };
}

function bucketGranularity(type, days) {
  if (type === 'anio' || type === 'semestre') return 'month';
  if (type === 'trimestre') return 'week';
  if (type === 'mes' || type === '15dias' || type === 'semana') return 'day';
  if (days <= 45) return 'day';
  if (days <= 180) return 'week';
  return 'month';
}
function bucketKey(ymd, gran) {
  if (gran === 'month') return ymd.slice(0, 7);
  if (gran === 'day') return ymd;
  const t = ymdToUTC(ymd);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // 0 = lunes
  return utcToYmd(t - dow * 86400000);
}
/** Trocea [since,until] en tramos que no cruzan de mes (para backfill sin paginación). */
function monthChunks(since, until) {
  const chunks = [];
  let s = since;
  while (s <= until) {
    const me = endOfMonth(s);
    chunks.push({ since: s, until: me < until ? me : until });
    s = addDays(me, 1);
  }
  return chunks;
}

// ===================================================================
// 2) HOJA DE CÁLCULO CSV (es-AR)
// ===================================================================
const HEADER = [
  'fecha',
  'metaGasto', 'metaImpresiones', 'metaClics', 'metaResultados',
  'googleGasto', 'googleImpresiones', 'googleClics', 'googleConversiones',
  'consultas', 'ventas',
];
const DECIMALS = { metaGasto: 2, googleGasto: 2, googleConversiones: 2 };
const SEP = ';';
const BOM = '﻿';

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function numAR(n, dec) {
  if (n == null || n === '' || (typeof n === 'number' && !isFinite(n))) return '';
  return Number(n).toFixed(dec || 0).replace('.', ',');
}
function parseAR(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}
function byFecha(a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; }

function serialize(rows) {
  const out = [BOM + HEADER.join(SEP)];
  for (const r of [...rows].sort(byFecha)) {
    out.push(HEADER.map((k) => (k === 'fecha' ? r.fecha : numAR(r[k], DECIMALS[k]))).join(SEP));
  }
  return out.join('\r\n') + '\r\n';
}
function parseCsv(text) {
  if (!text) return [];
  const clean = String(text).replace(/^﻿/, '');
  const rows = [];
  for (const line of clean.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(SEP);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) continue; // salta header/sep=/basura
    const r = { fecha: parts[0] };
    for (let i = 1; i < HEADER.length; i++) r[HEADER[i]] = parseAR(parts[i]);
    rows.push(r);
  }
  return rows.sort(byFecha);
}
/** Merge por fecha: cada fila entrante sólo pisa los campos DEFINIDOS (no null). */
function upsertByDate(existing, incoming) {
  const map = new Map((existing || []).map((r) => [r.fecha, { ...r }]));
  for (const row of incoming || []) {
    if (!row || !row.fecha) continue;
    const cur = map.get(row.fecha) || { fecha: row.fecha };
    for (const k of HEADER) {
      if (k === 'fecha') continue;
      if (row[k] != null) cur[k] = row[k];
    }
    map.set(row.fecha, cur);
  }
  return [...map.values()].sort(byFecha);
}

// ===================================================================
// 3) AGREGACIÓN / COMPARACIÓN
// ===================================================================
function aggregate(rows, from, to) {
  const inR = (rows || []).filter((r) => r.fecha >= from && r.fecha <= to);
  let mG = 0, mI = 0, mC = 0, mR = 0, gG = 0, gI = 0, gC = 0, gV = 0;
  let consultas = 0, ventas = 0, gastoCov = 0, diasCov = 0;
  let hadConsultas = false, hadVentas = false;
  for (const r of inR) {
    mG += r.metaGasto || 0; mI += r.metaImpresiones || 0; mC += r.metaClics || 0; mR += r.metaResultados || 0;
    gG += r.googleGasto || 0; gI += r.googleImpresiones || 0; gC += r.googleClics || 0; gV += r.googleConversiones || 0;
    if (r.consultas != null) { consultas += r.consultas; hadConsultas = true; diasCov++; gastoCov += (r.metaGasto || 0) + (r.googleGasto || 0); }
    if (r.ventas != null) { ventas += r.ventas; hadVentas = true; }
  }
  const gasto = mG + gG, impresiones = mI + gI, clics = mC + gC;
  const diasTot = daysInclusive(from, to);
  return {
    from, to, diasTot, diasConDato: inR.length,
    gasto, impresiones, clics, resultados: mR, googleConversiones: gV,
    meta: { gasto: mG, impresiones: mI, clics: mC, resultados: mR },
    google: { gasto: gG, impresiones: gI, clics: gC, conversiones: gV },
    ctr: impresiones ? (clics / impresiones) * 100 : null,
    consultas: hadConsultas ? consultas : null,
    ventas: hadVentas ? ventas : null,
    diasCov, gastoCov, cobertura: diasTot ? diasCov / diasTot : 0,
    cvr: (hadConsultas && consultas > 0) ? (ventas / consultas) * 100 : null,
    costoConsulta: (hadConsultas && consultas > 0) ? gastoCov / consultas : null,
    costoVenta: (hadVentas && ventas > 0) ? gastoCov / ventas : null,
  };
}
function pct(actual, anterior) {
  if (actual == null || anterior == null || anterior === 0) return null;
  return (actual - anterior) / anterior * 100;
}
const COMPARE_METRICS = ['gasto', 'impresiones', 'clics', 'ctr', 'resultados', 'consultas', 'ventas', 'cvr', 'costoConsulta', 'costoVenta'];
function compare(rows, windows) {
  const a = aggregate(rows, windows.actual.from, windows.actual.to);
  const b = aggregate(rows, windows.anterior.from, windows.anterior.to);
  const deltas = {};
  for (const m of COMPARE_METRICS) deltas[m] = { actual: a[m], anterior: b[m], abs: (a[m] != null && b[m] != null) ? a[m] - b[m] : null, pct: pct(a[m], b[m]) };
  return { actual: a, anterior: b, deltas, windows };
}
/** Serie por bucket. accessor(row)->número. Devuelve [{key,value}] ordenado. */
function buildSeries(rows, from, to, gran, accessor) {
  const inR = (rows || []).filter((r) => r.fecha >= from && r.fecha <= to);
  const map = new Map();
  for (const r of inR) {
    const k = bucketKey(r.fecha, gran);
    map.set(k, (map.get(k) || 0) + (accessor(r) || 0));
  }
  return [...map.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([key, value]) => ({ key, value }));
}

const ACCESSORS = {
  gasto: (r) => (r.metaGasto || 0) + (r.googleGasto || 0),
  impresiones: (r) => (r.metaImpresiones || 0) + (r.googleImpresiones || 0),
  clics: (r) => (r.metaClics || 0) + (r.googleClics || 0),
  consultas: (r) => (r.consultas != null ? r.consultas : 0),
};

/** Arma el objeto de respuesta completo de la comparativa (totales + deltas + datos del gráfico). */
function buildComparison(rows, type, today, cFrom, cTo) {
  const windows = computeWindows(type, today, cFrom, cTo);
  const cmp = compare(rows, windows);
  const gran = bucketGranularity(type, windows.actual.days);
  const series = {};
  for (const metric of Object.keys(ACCESSORS)) {
    const act = buildSeries(rows, windows.actual.from, windows.actual.to, gran, ACCESSORS[metric]);
    const ant = buildSeries(rows, windows.anterior.from, windows.anterior.to, gran, ACCESSORS[metric]);
    series[metric] = { actual: act, anterior: ant };
  }
  return { ...cmp, label: windows.label, type, gran, series };
}

// ===================================================================
// 4) MAPPERS DE FUENTES + BACKFILL
// ===================================================================
const RE_YMD = /^\d{4}-\d{2}-\d{2}$/;

/** adsStore.read().days  ->  filas de la hoja (campos Meta). resultados = mensajes+leads+compras+registros. */
function metaDaysToRows(daysObj) {
  const rows = [];
  for (const fecha of Object.keys(daysObj || {})) {
    if (!RE_YMD.test(fecha)) continue;
    const d = daysObj[fecha] || {};
    const r = d.results || {};
    const resultados = (Number(r.mensajes) || 0) + (Number(r.leads) || 0) + (Number(r.compras) || 0) + (Number(r.registros) || 0);
    rows.push({
      fecha,
      metaGasto: round2(d.spend),
      metaImpresiones: Math.round(Number(d.impressions) || 0),
      metaClics: Math.round(Number(d.clicks) || 0),
      metaResultados: Math.round(resultados),
    });
  }
  return rows;
}

/** googleAds.getDailyTotals()  ->  filas de la hoja (campos Google). */
function googleDailyToRows(list) {
  return (list || []).filter((d) => d && RE_YMD.test(d.day || '')).map((d) => ({
    fecha: d.day,
    googleGasto: round2(d.cost),
    googleImpresiones: Math.round(Number(d.impressions) || 0),
    googleClics: Math.round(Number(d.clicks) || 0),
    googleConversiones: round2(d.conversions),
  }));
}

/** Una ventana del funnel (hoy/ayer) -> fila de la hoja (consultas/ventas) para una fecha dada. */
function consultaRow(win, fecha) {
  if (!win || !RE_YMD.test(fecha || '')) return null;
  return { fecha, consultas: Math.round(Number(win.consultas) || 0), ventas: Math.round(Number(win.ventas) || 0) };
}

/** Filas CRUDAS de metaAds.getInsights (timeIncrement:1) -> filas diarias agregadas.
 *  pickResults = metaAds.pickResults (inyectado para no acoplar electron/red). */
function metaInsightRowsToDaily(rawRows, pickResults) {
  const byDay = {};
  for (const row of rawRows || []) {
    const fecha = row && row.date_start;
    if (!RE_YMD.test(fecha || '')) continue;
    const b = byDay[fecha] || (byDay[fecha] = { metaGasto: 0, metaImpresiones: 0, metaClics: 0, metaResultados: 0 });
    b.metaGasto += Number(row.spend) || 0;
    b.metaImpresiones += Number(row.impressions) || 0;
    b.metaClics += Number(row.clicks) || 0;
    if (pickResults) {
      const res = pickResults(row.actions || []) || {};
      b.metaResultados += (Number(res.mensajes) || 0) + (Number(res.leads) || 0) + (Number(res.compras) || 0) + (Number(res.registros) || 0);
    }
  }
  return Object.keys(byDay).map((fecha) => ({
    fecha,
    metaGasto: round2(byDay[fecha].metaGasto),
    metaImpresiones: Math.round(byDay[fecha].metaImpresiones),
    metaClics: Math.round(byDay[fecha].metaClics),
    metaResultados: Math.round(byDay[fecha].metaResultados),
  }));
}

/** Resumen de cobertura de un set de filas (para la UI y el estado). */
function coverage(rows) {
  const r = (rows || []).slice().sort(byFecha);
  const firstConsulta = r.find((x) => x.consultas != null);
  return {
    rows: r.length,
    firstDay: r.length ? r[0].fecha : null,
    lastDay: r.length ? r[r.length - 1].fecha : null,
    firstConsultaDay: firstConsulta ? firstConsulta.fecha : null,
  };
}

module.exports = {
  // períodos
  computeWindows, bucketGranularity, bucketKey, monthChunks, endOfMonth,
  addDays, daysInclusive, startOfMonth, startOfQuarter, startOfSemester, startOfYear, ymdLocal,
  PERIOD_TYPES, PERIOD_LABELS,
  // csv
  HEADER, SEP, BOM, DECIMALS, round2, numAR, parseAR, serialize, parseCsv, upsertByDate, byFecha,
  // comparación
  aggregate, compare, buildSeries, buildComparison, pct, COMPARE_METRICS, ACCESSORS,
  // mappers / backfill
  metaDaysToRows, googleDailyToRows, consultaRow, metaInsightRowsToDaily, coverage,
};

/*
 * integrations/consultas.js — Lee consultas/ventas del proyecto "Contador-Consultas-Publicidad"
 * (bot de WhatsApp con API local en la MISMA PC). SOLO lectura, sin credenciales ni token: el Contador
 * expone http://localhost:3100/publicidad/resumen. Si no está corriendo, se degrada con gracia.
 *
 * Sirve para armar el embudo:  Impresiones (Meta) → Consultas (WhatsApp) → Ventas,
 * y así tener un % de impresiones→consulta más preciso y la conversión (CVR) real.
 */
const DEFAULT_PORT = 3100;
const TIMEOUT_MS = 3000;

function baseUrl(port) { return 'http://localhost:' + (port || DEFAULT_PORT); }

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Normaliza una ventana del resumen del Contador a {consultas, ventas, cvr, ...}.
// 'unicos' = personas únicas (no duplica por día) → es la medida de "consultas" que importa.
function normWindow(w) {
  w = w || {};
  const consultas = Number(w.unicos) || 0;
  const ventas = Number(w.ventas) || 0;
  const cvr = w.cvr != null ? Number(w.cvr) : (consultas ? Math.round((ventas / consultas) * 1000) / 10 : 0);
  return {
    consultas,
    ventas,
    cvr,
    mensajes: Number(w.total) || 0,   // total de mensajes (puede duplicar por día)
    agendados: Number(w.agendados) || 0,
  };
}

// Trae el resumen de consultas de PUBLICIDAD (tipo=publicidad: deja afuera lo orgánico).
// Devuelve {ok:true, hoy, ayer, last7, last30, updatedAt} o {ok:false, offline, error}.
// `ayer` es el día cerrado (completo): sirve para registrar el historial diario sin huecos.
async function fetchFunnel({ port } = {}) {
  try {
    const r = await getJson(baseUrl(port) + '/publicidad/resumen?tipo=publicidad');
    return {
      ok: true,
      hoy: normWindow(r.hoy),
      ayer: normWindow(r.ayer),
      last7: normWindow(r.ultimos_7_dias),
      last30: normWindow(r.ultimos_30_dias),
      updatedAt: r.actualizado || null,
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const offline = /abort|timeout|ECONNREFUSED|fetch failed|refused|ENOTFOUND|ECONNRESET/i.test(msg);
    return {
      ok: false,
      offline,
      error: offline
        ? 'El Contador de Consultas no está abierto en esta PC.'
        : ('No se pudo leer el Contador de Consultas: ' + msg),
    };
  }
}

module.exports = { fetchFunnel, normWindow, _baseUrl: baseUrl, DEFAULT_PORT };

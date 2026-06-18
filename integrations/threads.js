/*
 * integrations/threads.js — Publicación en Threads (API de Meta para Threads).
 * Corre en el proceso principal de Electron.
 *
 * Credenciales esperadas (objeto "threads"):
 *   { appId, appSecret, token, userId }
 *
 * El token de Threads es de larga duración (~60 días) y se puede renovar con el
 * App Secret. Las imágenes/videos necesitan una URL pública (igual que Instagram).
 */
const TH = 'https://graph.threads.net/v1.0';

async function thGet(pathStr, token, fields) {
  const url = new URL(`${TH}/${pathStr}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json;
}

async function thPost(pathStr, params, token) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') form.append(k, v);
  }
  if (token) form.append('access_token', token);
  const res = await fetch(`${TH}/${pathStr}`, { method: 'POST', body: form });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json;
}

async function resolveUserId(creds) {
  if (creds.userId) return creds.userId;
  const me = await thGet('me', creds.token, 'id,username');
  return me.id;
}

async function testConnection(creds) {
  try {
    if (!creds || !creds.token) throw new Error('Falta el token de Threads.');
    const me = await thGet('me', creds.token, 'id,username');
    return { ok: true, username: me.username, userId: me.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Renueva el token de Threads (extiende ~60 días). Best-effort.
async function refreshToken(creds) {
  const url = new URL('https://graph.threads.net/refresh_access_token');
  url.searchParams.set('grant_type', 'th_refresh_token');
  url.searchParams.set('access_token', creds.token);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.access_token;
}

async function waitThreads(containerId, token, maxMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const st = await thGet(containerId, token, 'status');
    if (st.status === 'FINISHED') return true;
    if (st.status === 'ERROR' || st.status === 'EXPIRED') throw new Error('Threads: el procesamiento falló.');
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('Threads: tiempo de espera agotado procesando el medio.');
}

async function publishForTask(creds, task) {
  if (!creds || !creds.token) return { platform: 'Threads', error: 'Threads no está conectado (entrá a Conexiones).' };
  try {
    const userId = await resolveUserId(creds);
    const text = task.caption || task.notes || task.title || '';
    const isVideo = task.mediaUrl && /\.(mp4|mov|m4v)(\?|$)/i.test(task.mediaUrl);

    const params = { text };
    if (task.mediaUrl) {
      if (isVideo) { params.media_type = 'VIDEO'; params.video_url = task.mediaUrl; }
      else { params.media_type = 'IMAGE'; params.image_url = task.mediaUrl; }
    } else {
      params.media_type = 'TEXT';
    }

    const container = await thPost(`${userId}/threads`, params, creds.token);
    if (!container.id) throw new Error('Threads: no se pudo crear el contenedor.');
    if (isVideo) await waitThreads(container.id, creds.token);

    const pub = await thPost(`${userId}/threads_publish`, { creation_id: container.id }, creds.token);
    return { platform: 'Threads', id: pub.id, raw: pub };
  } catch (e) {
    return { platform: 'Threads', error: e.message };
  }
}

module.exports = { testConnection, refreshToken, publishForTask };

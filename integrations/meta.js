/*
 * integrations/meta.js — Publicación en Facebook e Instagram vía Graph API.
 * Corre en el proceso principal de Electron (tiene fetch global).
 *
 * Credenciales esperadas (objeto "meta"):
 *   { appId, appSecret, pageId, pageToken, igUserId, label }
 *
 * NOTA Instagram: las imágenes/videos deben estar en una URL PÚBLICA accesible
 * (image_url / video_url). No se pueden subir archivos locales directos.
 */
const GRAPH = 'https://graph.facebook.com/v21.0';

async function graphGet(pathStr, token, fields) {
  const url = new URL(`${GRAPH}/${pathStr}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json;
}

async function graphPost(pathStr, params, token) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') form.append(k, v);
  }
  if (token) form.append('access_token', token);
  const res = await fetch(`${GRAPH}/${pathStr}`, { method: 'POST', body: form });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json;
}

// --------------------------------------------------------------------------
// Probar conexión
// --------------------------------------------------------------------------
async function testConnection(creds) {
  const result = { ok: false, pageName: null, igUsername: null, error: null };
  try {
    if (!creds || !creds.pageId || !creds.pageToken) {
      throw new Error('Faltan datos: necesito el ID de la Página y el token de Página.');
    }
    const page = await graphGet(creds.pageId, creds.pageToken, 'name');
    result.pageName = page.name;
    if (creds.igUserId) {
      const ig = await graphGet(creds.igUserId, creds.pageToken, 'username');
      result.igUsername = ig.username;
    }
    result.ok = true;
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

// --------------------------------------------------------------------------
// Facebook (Página)
// content: { kind: 'auto'|'text'|'photo', message, link, mediaUrl, scheduledUnix }
// --------------------------------------------------------------------------
async function publishFacebook(creds, content) {
  const token = creds.pageToken;
  if (!creds.pageId || !token) throw new Error('Facebook: falta Página o token.');

  let endpoint, body = {};
  const hasPhoto = content.mediaUrl && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(content.mediaUrl);

  if ((content.kind === 'photo' || hasPhoto) && content.mediaUrl) {
    endpoint = `${creds.pageId}/photos`;
    body.url = content.mediaUrl;
    body.caption = content.message || '';
  } else {
    endpoint = `${creds.pageId}/feed`;
    body.message = content.message || '';
    if (content.link) body.link = content.link;
  }

  // Programación nativa de Facebook (10 min a 75 días en el futuro)
  if (content.scheduledUnix) {
    body.published = 'false';
    body.scheduled_publish_time = content.scheduledUnix;
  }

  const res = await graphPost(endpoint, body, token);
  return { platform: 'Facebook', id: res.id || res.post_id, raw: res };
}

// --------------------------------------------------------------------------
// Instagram (cuenta profesional)
// content: { format: 'image'|'reel'|'story', mediaUrl, caption }
// --------------------------------------------------------------------------
async function publishInstagram(creds, content) {
  const token = creds.pageToken;
  const ig = creds.igUserId;
  if (!ig || !token) throw new Error('Instagram: falta ID de cuenta IG o token.');
  if (!content.mediaUrl) throw new Error('Instagram: necesito una URL pública de la imagen o video.');

  const isVideo = /\.(mp4|mov|m4v)(\?|$)/i.test(content.mediaUrl);
  const params = {};

  if (content.format === 'reel') {
    params.media_type = 'REELS';
    params.video_url = content.mediaUrl;
    params.caption = content.caption || '';
  } else if (content.format === 'story') {
    params.media_type = 'STORIES';
    if (isVideo) params.video_url = content.mediaUrl;
    else params.image_url = content.mediaUrl;
  } else {
    // imagen de feed
    params.image_url = content.mediaUrl;
    params.caption = content.caption || '';
  }

  // 1) Crear contenedor
  const container = await graphPost(`${ig}/media`, params, token);
  if (!container.id) throw new Error('Instagram: no se pudo crear el contenedor.');

  // 2) Si es video/reel, esperar a que termine de procesarse
  const needsWait = content.format === 'reel' || (content.format === 'story' && isVideo);
  if (needsWait) {
    await waitForContainer(container.id, token);
  }

  // 3) Publicar
  const pub = await graphPost(`${ig}/media_publish`, { creation_id: container.id }, token);
  return { platform: 'Instagram', id: pub.id, raw: pub };
}

async function waitForContainer(containerId, token, maxMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const st = await graphGet(containerId, token, 'status_code');
    if (st.status_code === 'FINISHED') return true;
    if (st.status_code === 'ERROR') throw new Error('Instagram: el procesamiento del video falló.');
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('Instagram: tiempo de espera agotado procesando el video.');
}

// --------------------------------------------------------------------------
// Mapeo desde una tarea del calendario hacia cada red
// --------------------------------------------------------------------------
function igFormatFromTask(task) {
  const t = (task.contentType || '').toLowerCase();
  if (t.includes('historia')) return 'story';
  if (t.includes('reel')) return 'reel';
  if (t.includes('video')) return 'reel';   // los videos de feed van como reel
  return 'image';
}

async function publishForTask(creds, task) {
  const results = [];
  const caption = task.caption || task.notes || '';
  for (const plat of task.platforms || []) {
    try {
      if (plat === 'Instagram') {
        results.push(await publishInstagram(creds, {
          format: igFormatFromTask(task),
          mediaUrl: task.mediaUrl,
          caption,
        }));
      } else if (plat === 'Facebook') {
        results.push(await publishFacebook(creds, {
          message: caption,
          link: task.link,
          mediaUrl: task.mediaUrl,
        }));
      } else {
        results.push({ platform: plat, skipped: true, error: 'Integración aún no implementada (' + plat + ').' });
      }
    } catch (e) {
      results.push({ platform: plat, error: e.message });
    }
  }
  return results;
}

module.exports = { testConnection, publishFacebook, publishInstagram, publishForTask };

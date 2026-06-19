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
const fs = require('fs');
const path = require('path');

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
  const result = { ok: false, pageName: null, igUsername: null, error: null, tokenType: null, scopes: null, expiresAt: null, igLogin: null, igLoginError: null };
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
    // Token de Instagram (método nuevo): lo verificamos si está cargado
    if (creds.igToken) {
      try {
        const igMe = await igGet('me', creds.igToken, 'user_id,username');
        result.igLogin = '@' + (igMe.username || '?') + ' (id ' + (igMe.user_id || '?') + ')';
      } catch (e) {
        result.igLoginError = e.message;
      }
    }
    // Tipo de token: /me devuelve la Página (si es token de Página) o el usuario
    try {
      const me = await graphGet('me', creds.pageToken, 'id,name');
      result.tokenType = (String(me.id) === String(creds.pageId)) ? 'PAGE' : 'USER';
      result.tokenEntity = (me.name || '') + ' (' + me.id + ')';
    } catch (_) { /* opcional */ }

    // Permisos y vencimiento via debug_token (necesita App Secret)
    if (creds.appId && creds.appSecret) {
      try {
        const dbg = new URL(`${GRAPH}/debug_token`);
        dbg.searchParams.set('input_token', creds.pageToken);
        dbg.searchParams.set('access_token', `${creds.appId}|${creds.appSecret}`);
        const dres = await fetch(dbg);
        const djson = await dres.json();
        if (djson && djson.data) {
          if (!result.tokenType) result.tokenType = djson.data.type || null;
          result.scopes = djson.data.scopes || [];
          result.expiresAt = !djson.data.expires_at
            ? 'sin vencimiento'
            : new Date(djson.data.expires_at * 1000).toLocaleString('es-AR');
        } else if (djson && djson.error) {
          result.debugError = djson.error.message;
        }
      } catch (e) {
        result.debugError = e.message;
      }
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
// Asegura un token de PÁGINA. Si lo guardado es un token de usuario, deriva el de
// la Página vía me/accounts (hereda los permisos otorgados, como pages_manage_posts).
async function ensurePageToken(creds) {
  try {
    const me = await graphGet('me', creds.pageToken, 'id');
    if (String(me.id) === String(creds.pageId)) return creds.pageToken; // ya es token de Página
  } catch (_) { /* seguimos a derivar */ }
  const accts = await graphGet('me/accounts', creds.pageToken, 'id,access_token');
  const page = (accts.data || []).find((p) => String(p.id) === String(creds.pageId));
  if (page && page.access_token) return page.access_token;
  throw new Error('No pude obtener el token de la Página. Verificá que sos administrador de la Página y que el token tiene pages_show_list.');
}

// Convierte el token (de usuario, corta duración) en un token de PÁGINA de larga
// duración (no vence). Necesita App ID + App Secret correctos.
async function exchangeForLongLived(creds) {
  if (!creds.appId || !creds.appSecret) {
    throw new Error('Falta App ID o App Secret para renovar el token.');
  }
  if (!creds.pageToken) throw new Error('Falta el token a renovar.');
  // 1) token de usuario corta duración → larga duración (60 días)
  const ex = new URL(`${GRAPH}/oauth/access_token`);
  ex.searchParams.set('grant_type', 'fb_exchange_token');
  ex.searchParams.set('client_id', creds.appId);
  ex.searchParams.set('client_secret', creds.appSecret);
  ex.searchParams.set('fb_exchange_token', creds.pageToken);
  const res = await fetch(ex);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const longUserToken = json.access_token;
  if (!longUserToken) throw new Error('No se obtuvo el token de larga duración.');
  // 2) me/accounts con el token largo → token de Página que no vence
  const accts = await graphGet('me/accounts', longUserToken, 'id,access_token,name');
  const page = (accts.data || []).find((p) => String(p.id) === String(creds.pageId));
  if (!page || !page.access_token) {
    throw new Error('No encontré tu Página con ese token (¿sos admin de la Página?).');
  }
  return { pageToken: page.access_token, pageName: page.name };
}

// Convierte lo que haya en un token de Página PERMANENTE (no vence), si es posible.
// Devuelve { pageToken, changed }. Best-effort: si ya es permanente, lo deja igual.
async function makePermanent(creds) {
  let isUser = false;
  try {
    const me = await graphGet('me', creds.pageToken, 'id');
    isUser = String(me.id) !== String(creds.pageId);
  } catch (_) {
    isUser = true; // si /me falla, probablemente sea un token de usuario (o venció)
  }
  if (isUser) {
    const r = await exchangeForLongLived(creds); // user token → page token sin vencimiento
    return { pageToken: r.pageToken, changed: true };
  }
  return { pageToken: creds.pageToken, changed: false };
}

async function publishFacebook(creds, content) {
  if (!creds.pageId || !creds.pageToken) throw new Error('Facebook: falta Página o token.');
  const token = await ensurePageToken(creds);
  const pageId = creds.pageId;
  const isVideo = content.mediaUrl && /\.(mp4|mov|m4v)(\?|$)/i.test(content.mediaUrl);
  const isPhoto = content.mediaUrl && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(content.mediaUrl);

  // --- Historias de Facebook (API aparte) ---
  if (content.format === 'story') {
    if (!content.mediaUrl) throw new Error('Facebook: una historia necesita una imagen o video.');
    return isVideo ? publishFbVideoStory(pageId, token, content.mediaUrl)
                   : publishFbPhotoStory(pageId, token, content.mediaUrl);
  }

  // Video de Facebook (con miniatura/portada si hay)
  if (isVideo) {
    return publishFbVideo(pageId, token, content.mediaUrl, content.message || '', content.thumbPath);
  }

  let endpoint, body = {};
  if (isPhoto) {
    endpoint = `${pageId}/photos`;
    body.url = content.mediaUrl;
    body.caption = content.message || '';
  } else {
    endpoint = `${pageId}/feed`;
    body.message = content.message || '';
    if (content.link) body.link = content.link;
    if (!body.message && !content.link) {
      throw new Error('Facebook: el posteo está vacío. Agregá un texto/epígrafe o un archivo.');
    }
  }

  // Programación nativa de Facebook (10 min a 75 días en el futuro)
  if (content.scheduledUnix) {
    body.published = 'false';
    body.scheduled_publish_time = content.scheduledUnix;
  }

  const res = await graphPost(endpoint, body, token);
  return { platform: 'Facebook', id: res.id || res.post_id, raw: res };
}

// Video de Facebook con miniatura opcional (multipart: file_url + thumb)
async function publishFbVideo(pageId, token, videoUrl, description, thumbPath) {
  const form = new FormData();
  form.append('access_token', token);
  form.append('file_url', videoUrl);
  if (description) form.append('description', description);
  if (thumbPath && fs.existsSync(thumbPath)) {
    const buf = fs.readFileSync(thumbPath);
    form.append('thumb', new Blob([buf]), path.basename(thumbPath));
  }
  const res = await fetch(`${GRAPH}/${pageId}/videos`, { method: 'POST', body: form });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return { platform: 'Facebook', id: json.id, raw: json };
}

// Historia de foto: subir foto sin publicar y luego crear la historia
async function publishFbPhotoStory(pageId, token, imageUrl) {
  const photo = await graphPost(`${pageId}/photos`, { url: imageUrl, published: 'false' }, token);
  if (!photo.id) throw new Error('Facebook: no se pudo subir la foto de la historia.');
  const story = await graphPost(`${pageId}/photo_stories`, { photo_id: photo.id }, token);
  return { platform: 'Facebook', id: story.post_id || story.id || photo.id, raw: story };
}

// Historia de video: start → subir (por URL pública) → finish
async function publishFbVideoStory(pageId, token, videoUrl) {
  const start = await graphPost(`${pageId}/video_stories`, { upload_phase: 'start' }, token);
  if (!start.video_id || !start.upload_url) {
    throw new Error('Facebook: no se pudo iniciar la historia de video.');
  }
  // Subida por archivo hospedado (FB descarga la URL)
  const up = await fetch(start.upload_url, {
    method: 'POST',
    headers: { Authorization: 'OAuth ' + token, file_url: videoUrl },
  });
  let upJson = {};
  try { upJson = await up.json(); } catch (_) {}
  if (upJson && upJson.error) throw new Error('Facebook (subida historia): ' + upJson.error.message);

  const finish = await graphPost(`${pageId}/video_stories`, {
    upload_phase: 'finish', video_id: start.video_id,
  }, token);
  return { platform: 'Facebook', id: finish.post_id || start.video_id, raw: finish };
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
    if (content.coverUrl) params.cover_url = content.coverUrl; // portada del reel
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
// Instagram — método NUEVO ("Instagram Login", graph.instagram.com).
// Usa un token de Instagram (creds.igToken), NO el token de Página.
// Es el que funciona en modo desarrollo sin la revisión de semanas.
// --------------------------------------------------------------------------
const IG_GRAPH = 'https://graph.instagram.com/v21.0';

async function igGet(pathStr, token, fields) {
  const url = new URL(`${IG_GRAPH}/${pathStr}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json;
}

async function igPost(pathStr, params, token) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') form.append(k, v);
  }
  if (token) form.append('access_token', token);
  const res = await fetch(`${IG_GRAPH}/${pathStr}`, { method: 'POST', body: form });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json;
}

async function resolveIgUserId(creds) {
  try {
    const me = await igGet('me', creds.igToken, 'user_id,username');
    return me.user_id || me.id || creds.igUserId;
  } catch (_) {
    return creds.igUserId;
  }
}

async function publishInstagramLogin(creds, content) {
  const token = creds.igToken;
  if (!token) throw new Error('Instagram: falta el token de Instagram (método nuevo).');
  if (!content.mediaUrl) throw new Error('Instagram: necesito una URL pública de la imagen o video.');
  const igId = await resolveIgUserId(creds);

  const isVideo = /\.(mp4|mov|m4v)(\?|$)/i.test(content.mediaUrl);
  const params = {};
  if (content.format === 'reel') {
    params.media_type = 'REELS';
    params.video_url = content.mediaUrl;
    params.caption = content.caption || '';
    if (content.coverUrl) params.cover_url = content.coverUrl; // portada del reel
  } else if (content.format === 'story') {
    params.media_type = 'STORIES';
    if (isVideo) params.video_url = content.mediaUrl;
    else params.image_url = content.mediaUrl;
  } else {
    params.image_url = content.mediaUrl;
    params.caption = content.caption || '';
  }

  const container = await igPost(`${igId}/media`, params, token);
  if (!container.id) throw new Error('Instagram: no se pudo crear el contenedor.');

  const needsWait = content.format === 'reel' || (content.format === 'story' && isVideo);
  if (needsWait) await waitForContainerIG(container.id, token);

  const pub = await igPost(`${igId}/media_publish`, { creation_id: container.id }, token);
  return { platform: 'Instagram', id: pub.id, raw: pub };
}

async function waitForContainerIG(containerId, token, maxMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const st = await igGet(containerId, token, 'status_code');
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

function fbFormatFromTask(task) {
  const t = (task.contentType || '').toLowerCase();
  if (t.includes('historia')) return 'story';
  return 'post';
}

async function publishForTask(creds, task) {
  const results = [];
  const caption = task.caption || task.notes || '';
  for (const plat of task.platforms || []) {
    try {
      if (plat === 'Instagram') {
        const igContent = { format: igFormatFromTask(task), mediaUrl: task.mediaUrl, caption, coverUrl: task.thumbUrl };
        // Si hay token de Instagram (método nuevo) lo usamos; si no, el método clásico
        if (creds.igToken) {
          results.push(await publishInstagramLogin(creds, igContent));
        } else {
          results.push(await publishInstagram(creds, igContent));
        }
      } else if (plat === 'Facebook') {
        results.push(await publishFacebook(creds, {
          format: fbFormatFromTask(task),
          message: caption,
          link: task.link,
          mediaUrl: task.mediaUrl,
          thumbPath: task.thumbPath,
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

module.exports = { testConnection, publishFacebook, publishInstagram, publishInstagramLogin, publishForTask, exchangeForLongLived, makePermanent };

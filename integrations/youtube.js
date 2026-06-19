/*
 * integrations/youtube.js — Subida y programación de videos en YouTube (Data API v3).
 * Corre en el proceso principal de Electron.
 *
 * Credenciales esperadas (objeto "youtube"):
 *   { clientId, clientSecret, refreshToken, channel }
 *
 * El video se sube DIRECTO desde el archivo local (no necesita hosting público).
 * Programación nativa: si la fecha es futura, sube como "privado" con publishAt.
 */
const fs = require('fs');
const oauth = require('./oauth');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

// --- Conectar (login de Google) → devuelve refresh token ---
async function connect(creds) {
  if (!creds || !creds.clientId || !creds.clientSecret) {
    throw new Error('Falta el Client ID o Client Secret de Google.');
  }
  const { code, redirectUri } = await oauth.authorizeLoopback({
    authBaseUrl: AUTH_URL,
    clientId: creds.clientId,
    scope: SCOPE,
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  });

  const body = new URLSearchParams({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body });
  const json = await res.json();
  if (json.error) throw new Error(json.error_description || json.error);
  if (!json.refresh_token) {
    throw new Error('Google no devolvió un refresh token. Quitá el acceso de la app en tu cuenta de Google y reintentá.');
  }

  let channel = '';
  try {
    const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: 'Bearer ' + json.access_token },
    });
    const chJson = await ch.json();
    channel = (chJson.items && chJson.items[0] && chJson.items[0].snippet.title) || '';
  } catch (_) { /* opcional */ }

  return { refreshToken: json.refresh_token, channel };
}

async function getAccessToken(creds) {
  if (!creds || !creds.refreshToken) throw new Error('YouTube no está conectado.');
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body });
  const json = await res.json();
  if (json.error) throw new Error(json.error_description || json.error);
  return json.access_token;
}

async function testConnection(creds) {
  try {
    const at = await getAccessToken(creds);
    const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: 'Bearer ' + at },
    });
    const json = await ch.json();
    if (json.error) throw new Error(json.error.message);
    const name = (json.items && json.items[0] && json.items[0].snippet.title) || '(canal)';
    return { ok: true, channel: name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Sube una miniatura personalizada a un video ya subido (requiere canal verificado)
async function setThumbnail(accessToken, videoId, thumbPath) {
  const buf = fs.readFileSync(thumbPath);
  const ct = /\.png$/i.test(thumbPath) ? 'image/png' : 'image/jpeg';
  const res = await fetch('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=' + videoId, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': ct, 'Content-Length': String(buf.length) },
    body: buf,
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message);
  return true;
}

// --- Subir un video (resumable upload) ---
async function uploadVideo(creds, { filePath, title, description, publishAtISO, tags, thumbPath }) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('YouTube: necesito un archivo de video (MP4). Elegí el archivo en la tarea.');
  }
  if (!/\.(mp4|mov|m4v|webm|avi)$/i.test(filePath)) {
    throw new Error('YouTube: el archivo tiene que ser un video (MP4).');
  }
  const accessToken = await getAccessToken(creds);

  const snippet = { title: (title || 'Video').slice(0, 100), description: description || '' };
  if (tags && tags.length) snippet.tags = tags;
  const status = { privacyStatus: publishAtISO ? 'private' : 'public', selfDeclaredMadeForKids: false };
  if (publishAtISO) status.publishAt = publishAtISO;

  const size = fs.statSync(filePath).size;
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/*',
    },
    body: JSON.stringify({ snippet, status }),
  });
  if (!init.ok) {
    throw new Error('YouTube (inicio de subida): ' + (await init.text()).slice(0, 200));
  }
  const uploadUrl = init.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube: no se obtuvo la URL de subida.');

  const buf = fs.readFileSync(filePath);
  const up = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/*', 'Content-Length': String(size) },
    body: buf,
  });
  const upJson = await up.json();
  if (upJson.error) throw new Error('YouTube: ' + upJson.error.message);
  // Miniatura personalizada (best-effort: si el canal no está verificado por teléfono, falla sin romper la subida)
  if (thumbPath && upJson.id) {
    try { await setThumbnail(accessToken, upJson.id, thumbPath); }
    catch (e) { console.error('[youtube] no se pudo poner la miniatura:', e.message); }
  }
  return { platform: 'YouTube', id: upJson.id, raw: upJson };
}

// --- Publicar desde una tarea del calendario ---
async function publishForTask(creds, task) {
  if (!creds || !creds.refreshToken) return { platform: 'YouTube', error: 'YouTube no está conectado (entrá a Conexiones).' };
  try {
    const title = (task.ytTitle && task.ytTitle.trim()) || task.title || 'Video';
    const description = (task.ytDescription && task.ytDescription.trim()) || task.caption || task.notes || '';
    // Si el formato es Short, agregamos #Shorts para que YouTube lo trate como tal
    const isShort = /short/i.test(task.contentType || '');
    const fullDesc = isShort && !/#shorts/i.test(description) ? (description + '\n\n#Shorts').trim() : description;

    const start = new Date(task.start);
    const publishAtISO = start.getTime() > Date.now() + 60000 ? start.toISOString() : null;

    return await uploadVideo(creds, {
      filePath: task.mediaPath,
      title,
      description: fullDesc,
      publishAtISO,
      thumbPath: task.thumbPath,
    });
  } catch (e) {
    return { platform: 'YouTube', error: e.message };
  }
}

module.exports = { connect, getAccessToken, testConnection, uploadVideo, publishForTask };

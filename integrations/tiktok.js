/*
 * integrations/tiktok.js — Subida de videos a TikTok (Content Posting API).
 * Corre en el proceso principal de Electron.
 *
 * Credenciales esperadas (objeto "tiktok"):
 *   { clientKey, clientSecret, accessToken, refreshToken, openId, directPost }
 *
 * IMPORTANTE: para POSTEAR PÚBLICO directo, TikTok exige que la app pase una
 * auditoría. Sin auditar, se sube el video a tus BORRADORES de TikTok (inbox) y
 * vos terminás de publicarlo desde la app de TikTok (2 toques). Eso es lo que hace
 * por defecto (directPost = false).
 */
const fs = require('fs');
const oauth = require('./oauth');

const API = 'https://open.tiktokapis.com/v2';
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
// Sin auditoría: user.info.basic + video.upload (sube a borradores). Para posteo
// directo público se agrega video.publish (requiere que la app esté auditada).
const SCOPE = 'user.info.basic,video.upload';

// --- Conectar (OAuth) ---
async function connect(creds) {
  if (!creds || !creds.clientKey || !creds.clientSecret) {
    throw new Error('Falta el Client Key o Client Secret de TikTok.');
  }
  const { code, redirectUri, codeVerifier } = await oauth.authorizeLoopback({
    authBaseUrl: AUTH_URL,
    clientId: creds.clientKey, // TikTok usa client_key
    clientParam: 'client_key',
    scope: SCOPE,
    pkce: true, // TikTok escritorio exige PKCE
    fixedPort: 8723, // puerto fijo → redirect exacto que se registra en TikTok
    redirectPath: '/',
  });

  const body = new URLSearchParams({
    client_key: creds.clientKey,
    client_secret: creds.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (json.error || json.error_description) {
    throw new Error(json.error_description || json.error);
  }
  if (!json.access_token) throw new Error('TikTok no devolvió token de acceso.');
  return { accessToken: json.access_token, refreshToken: json.refresh_token, openId: json.open_id };
}

async function refresh(creds) {
  const body = new URLSearchParams({
    client_key: creds.clientKey,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
  });
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('TikTok: no se pudo renovar el token.');
  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}

async function testConnection(creds) {
  try {
    if (!creds || !creds.accessToken) throw new Error('TikTok no está conectado.');
    const res = await fetch(`${API}/user/info/?fields=open_id,display_name`, {
      headers: { Authorization: 'Bearer ' + creds.accessToken },
    });
    const json = await res.json();
    if (json.error && json.error.code && json.error.code !== 'ok') {
      throw new Error(json.error.message || json.error.code);
    }
    const name = (json.data && json.data.user && json.data.user.display_name) || '(cuenta)';
    return { ok: true, displayName: name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Subir video ---
async function uploadVideo(creds, { filePath, title, directPost }) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('TikTok: necesito un archivo de video (MP4).');
  }
  const size = fs.statSync(filePath).size;
  const buf = fs.readFileSync(filePath);

  // 1) init: borrador (inbox) por defecto; directo solo si la app está auditada
  const initUrl = directPost ? `${API}/post/publish/video/init/` : `${API}/post/publish/inbox/video/init/`;
  const initBody = {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: size,
      chunk_size: size,
      total_chunk_count: 1,
    },
  };
  if (directPost) {
    initBody.post_info = { title: (title || '').slice(0, 2200), privacy_level: 'SELF_ONLY' };
  }
  const init = await fetch(initUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + creds.accessToken, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(initBody),
  });
  const initJson = await init.json();
  if (!initJson.data || !initJson.data.upload_url) {
    const msg = (initJson.error && initJson.error.message) || JSON.stringify(initJson);
    throw new Error('TikTok (init): ' + msg);
  }

  // 2) subir el archivo
  const up = await fetch(initJson.data.upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
      'Content-Range': `bytes 0-${size - 1}/${size}`,
    },
    body: buf,
  });
  if (!up.ok && up.status !== 201) {
    throw new Error('TikTok (subida): ' + (await up.text()).slice(0, 160));
  }

  return { platform: 'TikTok', id: initJson.data.publish_id, draft: !directPost, raw: initJson.data };
}

async function publishForTask(creds, task) {
  if (!creds || !creds.accessToken) return { platform: 'TikTok', error: 'TikTok no está conectado (entrá a Conexiones).' };
  try {
    const title = task.caption || task.title || '';
    return await uploadVideo(creds, { filePath: task.mediaPath, title, directPost: !!creds.directPost });
  } catch (e) {
    return { platform: 'TikTok', error: e.message };
  }
}

module.exports = { connect, refresh, testConnection, uploadVideo, publishForTask };

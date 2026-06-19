/*
 * integrations/hosting.js — Sube un archivo local a una URL pública.
 * Instagram exige una URL pública para publicar; esto la genera sola.
 *
 * Si hay credenciales de Cloudinary configuradas (recomendado, más confiable),
 * usa Cloudinary. Si no, cae a hostings temporales gratuitos (tmpfiles.org y,
 * de respaldo, catbox.moe). La URL solo tiene que vivir unos minutos mientras
 * Instagram descarga el archivo para procesarlo.
 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CalendarioWoodTools/1.0';

function isVideo(filePath) {
  return /\.(mp4|mov|m4v|webm)$/i.test(filePath);
}

async function uploadPublic(filePath, hostingCreds) {
  console.log('[DEBUG hosting] creds recibidas:', JSON.stringify(hostingCreds), '| usa Cloudinary:', !!(hostingCreds && hostingCreds.cloudName && hostingCreds.uploadPreset));
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('No encuentro el archivo: ' + filePath);
  }
  if (hostingCreds && hostingCreds.cloudName && hostingCreds.uploadPreset) {
    return uploadCloudinary(filePath, hostingCreds);
  }
  return uploadTemp(filePath);
}

// --- Cloudinary (subida "unsigned" con upload preset, sin secreto) ---
async function uploadCloudinary(filePath, creds) {
  const resource = isVideo(filePath) ? 'video' : 'image';
  const url = `https://api.cloudinary.com/v1_1/${creds.cloudName}/${resource}/upload`;
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(filePath));
  form.append('upload_preset', creds.uploadPreset);
  const res = await fetch(url, { method: 'POST', body: form });
  const json = await res.json();
  if (json && json.secure_url) return json.secure_url;
  throw new Error('Cloudinary: ' + (json && json.error ? json.error.message : 'fallo al subir'));
}

// --- Hostings temporales gratuitos (sin cuenta) ---
async function uploadTemp(filePath) {
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const errors = [];

  // 1) tmpfiles.org — se autoborra en 1 hora
  try {
    const form = new FormData();
    form.append('file', new Blob([buf]), name);
    const res = await fetch('https://tmpfiles.org/api/v1/upload', {
      method: 'POST', body: form, headers: { 'User-Agent': UA },
    });
    const json = await res.json();
    if (json && json.data && json.data.url) {
      const u = new URL(json.data.url);
      u.protocol = 'https:';
      u.pathname = '/dl' + u.pathname; // enlace de descarga directa
      return u.toString();
    }
    errors.push('tmpfiles: respuesta inesperada');
  } catch (e) {
    errors.push('tmpfiles: ' + e.message);
  }

  // 2) catbox.moe — de respaldo
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', new Blob([buf]), name);
    const res = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST', body: form, headers: { 'User-Agent': UA },
    });
    const text = (await res.text()).trim();
    if (text.startsWith('https://')) return text;
    errors.push('catbox: ' + text.slice(0, 80));
  } catch (e) {
    errors.push('catbox: ' + e.message);
  }

  throw new Error(
    'No se pudo subir el archivo a un hosting gratuito (' + errors.join(' | ') +
    '). Configurá Cloudinary en ⚙ Conexiones para algo confiable.'
  );
}

module.exports = { uploadPublic, isVideo };

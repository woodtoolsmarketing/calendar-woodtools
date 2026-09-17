/*
 * integrations/hosting.js — Sube un archivo local a Cloudinary y devuelve una URL pública.
 * Instagram, Threads y las historias de Facebook exigen una URL pública del archivo.
 *
 * - Solo Cloudinary (subida "unsigned" con upload preset). Los hostings temporales
 *   gratuitos se quitaron: borraban el archivo antes de tiempo y Meta no siempre los leía.
 * - Imágenes: se entregan como JPEG por URL (Instagram solo acepta JPEG).
 * - Videos: se entregan originales (MP4/MOV). Los .webm se rechazan (Meta no los acepta).
 * - Límites del plan gratis de Cloudinary: imagen 10 MB, video 100 MB (configurables).
 * - Archivos de más de 95 MB se suben en partes (subida por chunks de Cloudinary).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;
const CHUNK_THRESHOLD = 95 * 1024 * 1024;
const CHUNK_SIZE = 20 * 1024 * 1024;
const DEFAULT_LIMIT_MB = { image: 10, video: 100 };

// 'image' | 'video' | 'webm' | null
function mediaKind(filePath) {
  if (!filePath) return null;
  if (VIDEO_EXT.test(filePath)) return 'video';
  if (/\.webm$/i.test(filePath)) return 'webm';
  if (IMAGE_EXT.test(filePath)) return 'image';
  return null;
}

// Compatibilidad con código viejo
function isVideo(filePath) {
  return /\.(mp4|mov|m4v|webm)$/i.test(filePath || '');
}

// fetch con tiempo máximo: si Cloudinary se cuelga, la publicación no queda trabada para siempre
async function timedFetch(url, opts, ms) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('Cloudinary no respondió a tiempo al subir el archivo. Revisá la conexión a internet.');
    }
    throw e;
  }
}

async function parseJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`Cloudinary respondió algo inesperado (HTTP ${res.status}). Revisá el "Cloud name" en Conexiones.`);
  }
}

async function fileBlob(filePath) {
  if (typeof fs.openAsBlob === 'function') return fs.openAsBlob(filePath); // no carga todo en memoria
  return new Blob([fs.readFileSync(filePath)]);
}

async function singleUpload(endpoint, filePath, preset) {
  const form = new FormData();
  form.append('file', await fileBlob(filePath), path.basename(filePath));
  form.append('upload_preset', preset);
  const res = await timedFetch(endpoint, { method: 'POST', body: form }, 15 * 60 * 1000);
  return parseJson(res);
}

async function chunkedUpload(endpoint, filePath, size, preset) {
  const uploadId = crypto.randomUUID();
  const name = path.basename(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    let last = null;
    for (let start = 0; start < size; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, size) - 1;
      const buf = Buffer.alloc(end - start + 1);
      fs.readSync(fd, buf, 0, buf.length, start);
      const form = new FormData();
      form.append('file', new Blob([buf]), name);
      form.append('upload_preset', preset);
      const res = await timedFetch(endpoint, {
        method: 'POST',
        body: form,
        headers: { 'X-Unique-Upload-Id': uploadId, 'Content-Range': `bytes ${start}-${end}/${size}` },
      }, 5 * 60 * 1000);
      last = await parseJson(res);
      if (last && last.error) throw new Error('Cloudinary: ' + last.error.message);
    }
    return last;
  } finally {
    fs.closeSync(fd);
  }
}

/*
 * Sube el archivo y devuelve:
 * { url, secureUrl, publicId, version, format, resourceType, bytes, width, height, duration, cloudName, kind }
 * url = URL lista para Meta (JPEG para imágenes, original para videos).
 */
async function uploadPublic(filePath, hostingCreds) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('No encuentro el archivo: ' + filePath);
  }
  const creds = hostingCreds || {};
  if (!creds.cloudName || !creds.uploadPreset) {
    throw new Error('Falta configurar Cloudinary en ⚙ Conexiones (Cloud name + Upload preset). Es necesario para publicar archivos en Instagram, Threads y las historias.');
  }
  const kind = mediaKind(filePath);
  if (kind === 'webm') throw new Error('Instagram, Threads y Facebook no aceptan videos .webm. Exportalo como MP4 (H.264).');
  if (!kind) throw new Error('Formato de archivo no soportado: ' + (path.extname(filePath) || '(sin extensión)'));

  const size = fs.statSync(filePath).size;
  const limitMB = kind === 'video'
    ? (Number(creds.maxVideoMB) || DEFAULT_LIMIT_MB.video)
    : (Number(creds.maxImageMB) || DEFAULT_LIMIT_MB.image);
  if (size > limitMB * 1000 * 1000) {
    const mb = (size / 1e6).toFixed(1);
    throw new Error(kind === 'video'
      ? `El video pesa ${mb} MB y tu plan de Cloudinary permite hasta ${limitMB} MB. Comprimilo (por ejemplo con HandBrake, MP4 H.264) o aumentá el límite en Conexiones si tenés plan pago.`
      : `La imagen pesa ${mb} MB y tu plan de Cloudinary permite hasta ${limitMB} MB. Achicala antes de subirla.`);
  }

  const resource = kind === 'video' ? 'video' : 'image';
  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(creds.cloudName)}/${resource}/upload`;
  const json = size > CHUNK_THRESHOLD
    ? await chunkedUpload(endpoint, filePath, size, creds.uploadPreset)
    : await singleUpload(endpoint, filePath, creds.uploadPreset);
  if (!json || !json.secure_url) {
    throw new Error('Cloudinary: ' + (json && json.error ? json.error.message : 'no se pudo subir el archivo'));
  }

  const info = {
    secureUrl: json.secure_url,
    publicId: json.public_id,
    version: json.version,
    format: json.format,
    resourceType: json.resource_type,
    bytes: json.bytes,
    width: json.width || null,
    height: json.height || null,
    duration: json.duration || null,
    cloudName: creds.cloudName,
    kind,
  };
  info.url = kind === 'image' ? jpegUrl(info) : info.secureUrl;
  return info;
}

/*
 * URL de entrega en JPEG (Instagram solo acepta JPEG; Facebook /photos máx 4 MB).
 * opts: { maxWidth=1440, maxHeight }
 */
function jpegUrl(info, { maxWidth = 1440, maxHeight = null } = {}) {
  if (!info || !info.cloudName || !info.publicId) return info ? info.secureUrl : null;
  const t = [`c_limit`, `w_${maxWidth}`];
  if (maxHeight) t.push(`h_${maxHeight}`);
  t.push('q_auto:good');
  const ver = info.version ? `v${info.version}/` : '';
  return `https://res.cloudinary.com/${info.cloudName}/image/upload/${t.join(',')}/${ver}${info.publicId}.jpg`;
}

module.exports = { uploadPublic, jpegUrl, mediaKind, isVideo };

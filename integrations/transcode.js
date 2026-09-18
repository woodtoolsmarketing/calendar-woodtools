/*
 * integrations/transcode.js — Comprime videos con ffmpeg para que entren en el
 * límite de Cloudinary (plan gratis: 100 MB).
 *
 * Instagram y Threads exigen una URL pública del archivo, y Cloudinary rechaza
 * los videos muy pesados. Cuando un video supera el límite, la app lo comprime
 * sola (H.264, faststart, hasta 1080 px de ancho) manteniendo buena calidad, y
 * recién ahí lo sube. Facebook no pasa por acá (sube el archivo directo).
 *
 * ffmpeg se busca en la carpeta donde lo instala winget y en el PATH. No corre
 * en el hilo principal (usa spawn asíncrono) para no congelar la app.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

let cachedFfmpeg;  // undefined = sin buscar; null = no está; string = ruta
let cachedFfprobe;

function findExe(name) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(local, 'Microsoft', 'WinGet', 'Links', name + '.exe'), // shim de winget
  ];
  // Paquete de winget (Gyan.FFmpeg_...\ffmpeg-x.y-full_build\bin\ffmpeg.exe)
  try {
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(pkgs)) {
      if (!/ffmpeg/i.test(d)) continue;
      const base = path.join(pkgs, d);
      for (const sub of fs.readdirSync(base)) {
        candidates.push(path.join(base, sub, 'bin', name + '.exe'));
      }
    }
  } catch (_) { /* no hay paquetes de winget */ }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  // Último recurso: PATH
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, [name], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return null;
}

function ffmpegPath() {
  if (cachedFfmpeg === undefined) cachedFfmpeg = findExe('ffmpeg');
  return cachedFfmpeg;
}
function ffprobePath() {
  if (cachedFfprobe === undefined) cachedFfprobe = findExe('ffprobe');
  return cachedFfprobe;
}
function available() { return !!ffmpegPath(); }

function isVideo(p) { return /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(p || ''); }

// Duración en segundos (0 si no se puede leer). ffprobe es rápido (solo metadatos).
function durationSec(input) {
  const fp = ffprobePath();
  if (!fp) return 0;
  try {
    const out = execFileSync(fp, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', input,
    ], { encoding: 'utf8' });
    const d = parseFloat(String(out).trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch (_) {
    return 0;
  }
}

function runFfmpeg(ff, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ff, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg (' + code + '): ' + err.slice(-300)))));
  });
}

/*
 * Comprime `input` a un archivo .mp4 <= targetBytes dentro de outDir.
 * Devuelve la ruta del comprimido. Lanza si no hay ffmpeg o no logra el objetivo.
 */
async function compressToLimit(input, targetBytes, outDir) {
  const ff = ffmpegPath();
  if (!ff) throw new Error('ffmpeg no está disponible');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'cwt-' + Date.now().toString(36) + '.mp4');

  const dur = durationSec(input);
  const AUDIO = 128000;
  let vbit = dur > 0
    ? Math.floor((targetBytes * 8 * 0.88) / dur) - AUDIO // 88% de margen; el resto, audio
    : 2500000;                                           // sin duración: ~2.5 Mbps
  vbit = Math.max(400000, vbit);                          // piso 400 kbps

  const encode = (vb) => runFfmpeg(ff, [
    '-y', '-i', input,
    '-vf', "scale='min(1080,iw)':-2", // achica a 1080 px de ancho como mucho (par), respeta el alto
    '-c:v', 'libx264', '-preset', 'medium',
    '-b:v', String(vb), '-maxrate', String(Math.floor(vb * 1.15)), '-bufsize', String(vb * 2),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    out,
  ]);

  await encode(vbit);
  let size = fs.statSync(out).size;
  // Si por el contenido quedó por encima del objetivo, un reintento con menos bitrate
  if (size > targetBytes && vbit > 450000) {
    const vb2 = Math.max(400000, Math.floor(vbit * (targetBytes / size) * 0.9));
    await encode(vb2);
    size = fs.statSync(out).size;
  }
  if (size > targetBytes) {
    try { fs.unlinkSync(out); } catch (_) {}
    throw new Error('no se pudo bajar el video por debajo de ' + Math.round(targetBytes / 1e6) + ' MB');
  }
  return out;
}

// Borra comprimidos viejos (más de 1 día) para que no se acumulen en la carpeta temporal.
function pruneOld(outDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(outDir)) {
      if (!/^cwt-.*\.mp4$/.test(f)) continue;
      const p = path.join(outDir, f);
      try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) { /* la carpeta puede no existir todavía */ }
}

module.exports = { available, ffmpegPath, isVideo, durationSec, compressToLimit, pruneOld };

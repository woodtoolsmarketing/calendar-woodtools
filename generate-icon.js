/*
 * generate-icon.js — Genera assets/icon.png (256x256) sin dependencias.
 * Un cuadrado redondeado rosa->cobre con una "W". Reemplazalo por el logo
 * de WoodTools cuando quieras (mantené 256x256 PNG).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

function rgba(r, g, b, a) { return [r, g, b, a]; }

// Mezcla lineal entre dos colores
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

const colTop = [232, 74, 111];    // rosa rojizo
const colBot = [184, 115, 51];    // marrón cobrizo

const buf = Buffer.alloc(SIZE * SIZE * 4);

function setPx(x, y, c) {
  const i = (y * SIZE + x) * 4;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
}

// Esquinas redondeadas
const radius = 48;
function inside(x, y) {
  const r = radius;
  if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
  if (x >= SIZE - r && y < r) return (x - (SIZE - r - 1)) ** 2 + (y - r) ** 2 <= r * r;
  if (x < r && y >= SIZE - r) return (x - r) ** 2 + (y - (SIZE - r - 1)) ** 2 <= r * r;
  if (x >= SIZE - r && y >= SIZE - r) return (x - (SIZE - r - 1)) ** 2 + (y - (SIZE - r - 1)) ** 2 <= r * r;
  return true;
}

// Dibujar fondo degradado + letra W simple
for (let y = 0; y < SIZE; y++) {
  const t = y / (SIZE - 1);
  const base = rgba(lerp(colTop[0], colBot[0], t), lerp(colTop[1], colBot[1], t), lerp(colTop[2], colBot[2], t), 255);
  for (let x = 0; x < SIZE; x++) {
    if (!inside(x, y)) { setPx(x, y, [0, 0, 0, 0]); continue; }
    setPx(x, y, base);
  }
}

// "W" en blanco (trazos diagonales)
function drawLine(x0, y0, x1, y1, w, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps);
    const y = Math.round(y0 + ((y1 - y0) * s) / steps);
    for (let dx = -w; dx <= w; dx++)
      for (let dy = -w; dy <= w; dy++) {
        const px = x + dx, py = y + dy;
        if (px >= 0 && px < SIZE && py >= 0 && py < SIZE && inside(px, py)) setPx(px, py, color);
      }
  }
}
const white = [255, 255, 255, 255];
drawLine(60, 80, 95, 180, 6, white);
drawLine(95, 180, 128, 110, 6, white);
drawLine(128, 110, 161, 180, 6, white);
drawLine(161, 180, 196, 80, 6, white);

// --- Codificar PNG ---
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// scanlines con filtro 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw);

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('Icono generado en assets/icon.png');

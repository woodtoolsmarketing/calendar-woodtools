/*
 * generate-icon.js — Genera assets/icon.png (256) y assets/icon-1024.png (1024)
 * sin dependencias. Cuadrado redondeado rosa->cobre con una "W".
 * Reemplazalos por el logo de WoodTools cuando quieras.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const colTop = [232, 74, 111];
const colBot = [184, 115, 51];

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function makeIcon(SIZE, outPath) {
  const S = SIZE / 256; // factor de escala respecto al diseño base 256
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const setPx = (x, y, c) => { const i = (y * SIZE + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3]; };

  const radius = Math.round(48 * S);
  const inside = (x, y) => {
    const r = radius;
    if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
    if (x >= SIZE - r && y < r) return (x - (SIZE - r - 1)) ** 2 + (y - r) ** 2 <= r * r;
    if (x < r && y >= SIZE - r) return (x - r) ** 2 + (y - (SIZE - r - 1)) ** 2 <= r * r;
    if (x >= SIZE - r && y >= SIZE - r) return (x - (SIZE - r - 1)) ** 2 + (y - (SIZE - r - 1)) ** 2 <= r * r;
    return true;
  };

  for (let y = 0; y < SIZE; y++) {
    const t = y / (SIZE - 1);
    const base = [lerp(colTop[0], colBot[0], t), lerp(colTop[1], colBot[1], t), lerp(colTop[2], colBot[2], t), 255];
    for (let x = 0; x < SIZE; x++) setPx(x, y, inside(x, y) ? base : [0, 0, 0, 0]);
  }

  const white = [255, 255, 255, 255];
  const w = Math.max(2, Math.round(6 * S));
  const drawLine = (x0, y0, x1, y1) => {
    x0 *= S; y0 *= S; x1 *= S; y1 *= S;
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps);
      const y = Math.round(y0 + ((y1 - y0) * s) / steps);
      for (let dx = -w; dx <= w; dx++) for (let dy = -w; dy <= w; dy++) {
        const px = x + dx, py = y + dy;
        if (px >= 0 && px < SIZE && py >= 0 && py < SIZE && inside(px, py)) setPx(px, py, white);
      }
    }
  };
  drawLine(60, 80, 95, 180); drawLine(95, 180, 128, 110); drawLine(128, 110, 161, 180); drawLine(161, 180, 196, 80);

  fs.writeFileSync(outPath, encodePng(SIZE, buf));
  console.log('Generado', outPath);
}

function encodePng(SIZE, buf) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c; };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) { raw[y * (SIZE * 4 + 1)] = 0; buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4); }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, 'assets');
fs.mkdirSync(outDir, { recursive: true });
makeIcon(256, path.join(outDir, 'icon.png'));
makeIcon(1024, path.join(outDir, 'icon-1024.png'));

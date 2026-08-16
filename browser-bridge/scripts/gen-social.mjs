// Социальная превью-картинка репозитория (1280x640) — без зависимостей.
// Тёмный градиент + крупная иконка-стрелка (как иконки расширения).
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
fs.mkdirSync(OUT, { recursive: true });

const W = 1280;
const H = 640;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const ARROW = [
  [5, 2],
  [19, 12],
  [12, 13.5],
  [8.5, 18],
];

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y, s, r) {
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// фон: вертикальный градиент #0f172a -> #1d4ed8 (тёмный к синему)
function bgColor(x, y) {
  const t = y / H;
  const r = Math.round(15 + (29 - 15) * t);
  const g = Math.round(23 + (78 - 23) * t);
  const b = Math.round(42 + (216 - 42) * t);
  return [r, g, b];
}

// иконка в центре: скруглённый квадрат 300px + стрелка
const ICON_S = 300;
const ICON_X = (W - ICON_S) / 2;
const ICON_Y = (H - ICON_S) / 2;
const k = (ICON_S * 0.82) / 24;
const poly = ARROW.map(([x, y]) => [ICON_X + ICON_S * 0.09 + x * k, ICON_Y + ICON_S * 0.09 + y * k]);

const SS = 4;
const buf = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let bgCov = 0;
    let iconCov = 0;
    let fgCov = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        const inIcon = inRoundRect(px, py, ICON_S, ICON_S * 0.22) &&
          px >= ICON_X && px <= ICON_X + ICON_S && py >= ICON_Y && py <= ICON_Y + ICON_S;
        if (inIcon) {
          iconCov += 1;
          if (inPoly(px - ICON_X, py - ICON_Y, poly)) fgCov += 1;
        } else {
          bgCov += 1;
        }
      }
    }
    const n = SS * SS;
    const [br, bg, bb] = bgColor(x, y);
    let r = br, g = bg, b = bb;
    const iC = iconCov / n;
    const fC = fgCov / n;
    // иконка: тёмный фон поверх градиента
    r = br * (1 - iC) + 15 * iC;
    g = bg * (1 - iC) + 23 * iC;
    b = bb * (1 - iC) + 42 * iC;
    // стрелка: голубая поверх иконки
    r = r * (1 - fC) + 56 * fC;
    g = g * (1 - fC) + 189 * fC;
    b = b * (1 - fC) + 248 * fC;
    const i = (y * W + x) * 4;
    buf[i] = Math.round(r);
    buf[i + 1] = Math.round(g);
    buf[i + 2] = Math.round(b);
    buf[i + 3] = 255;
  }
}

const file = path.join(OUT, "social-preview.png");
fs.writeFileSync(file, encodePNG(W, H, buf));
console.log("written", file, fs.statSync(file).size, "bytes");

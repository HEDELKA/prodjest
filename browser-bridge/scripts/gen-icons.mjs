// Генератор иконок расширения (PNG, без зависимостей).
// Рисует тёмный скруглённый квадрат + голубую стрелку-курсор (как призрачный курсор оверлея).
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
fs.mkdirSync(OUT, { recursive: true });

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
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// Форма стрелки-курсора в координатах 24x24 (как в SVG оверлея).
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

function renderIcon(S) {
  const SS = 4; // supersampling
  const W = S * SS;
  const buf = Buffer.alloc(W * W * 4);
  const R = S * 0.22;
  // масштаб стрелки: 24-пространство -> квадрат с отступом ~9%
  const k = (S * 0.82) / 24;
  const ox = S * 0.09;
  const oy = S * 0.09;
  const poly = ARROW.map(([x, y]) => [x * k + ox, y * k + oy]);

  const BG = [15, 23, 42]; // #0f172a
  const FG = [56, 189, 248]; // #38bdf8

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let bgCov = 0;
      let fgCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / SS;
          const py = (y + (sy + 0.5) / SS) / SS;
          if (inRoundRect(px, py, S, R)) {
            bgCov += 1;
            if (inPoly(px, py, poly)) fgCov += 1;
          }
        }
      }
      bgCov /= SS * SS;
      fgCov /= SS * SS;
      const r = Math.round(BG[0] * bgCov + FG[0] * fgCov);
      const g = Math.round(BG[1] * bgCov + FG[1] * fgCov);
      const b = Math.round(BG[2] * bgCov + FG[2] * fgCov);
      const a = Math.round(255 * bgCov);
      const i = (y * W + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  // даунсемплинг WxW -> SxS (усреднение блоков SSxSS)
  const out = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * S + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(S, S, out);
}

for (const size of [16, 32, 48, 128]) {
  const png = renderIcon(size);
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log("written", file, png.length, "bytes");
}

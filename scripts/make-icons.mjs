#!/usr/bin/env node
// Draws Leyline's icons from code (no image tools needed) and writes PNGs to app/assets.
// The mark: two nodes joined by a flowing S-curve, with a smaller node (the NAS) on the line.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'assets');
mkdirSync(OUT, { recursive: true });

// ---- PNG encoding ---------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- geometry (unit square, y down) ---------------------------------------
const P0 = [0.2, 0.78], P1 = [0.62, 0.86], P2 = [0.38, 0.14], P3 = [0.8, 0.22];
const bez = (t) => { const u = 1 - t; return [0, 1].map((i) => u * u * u * P0[i] + 3 * u * u * t * P1[i] + 3 * u * t * t * P2[i] + t * t * t * P3[i]); };
const SEG = 160;
const pts = Array.from({ length: SEG + 1 }, (_, i) => bez(i / SEG));
function curveDist(x, y) {
  let best = Infinity, bestT = 0;
  for (let i = 0; i < SEG; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) { best = d; bestT = (i + t) / SEG; }
  }
  return [best, bestT];
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const over = (dst, src, a) => { for (let i = 0; i < 3; i++) dst[i] = src[i] * a + dst[i] * (1 - a); dst[3] = a + dst[3] * (1 - a); };

/**
 * Coverage of the mark at a pixel: line + end nodes + middle node.
 * @param mid  position (0..1) of the middle node on the curve
 * @param px   pixel size in unit coordinates (for anti-aliasing)
 */
function mark(x, y, { mid = 0.5, line = 0.045, node = 0.105, midNode = 0.075, px }) {
  const [d, t] = curveDist(x, y);
  const cov = (dist) => clamp01(0.5 - dist / px);
  const m = bez(mid);
  const nodeA = Math.hypot(x - P0[0], y - P0[1]) - node;
  const nodeB = Math.hypot(x - P3[0], y - P3[1]) - node;
  const nodeM = Math.hypot(x - m[0], y - m[1]) - midNode;
  // a ring of clear space around the middle node keeps it readable at 16px
  const gap = Math.hypot(x - m[0], y - m[1]) - (midNode + line * 1.1);
  const lineCov = cov(d - line / 2) * clamp01(gap / px + 0.5);
  const a = Math.max(lineCov, cov(nodeA), cov(nodeB), cov(nodeM));
  return { a, t, d };
}

// ---- tray icons: macOS template (black + alpha), Windows colored ---------
function tray(size, { mid, color = null }) {
  const buf = Buffer.alloc(size * size * 4);
  const px = 1 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    const { a, t } = mark(u, v, { mid, px, line: 0.085, node: 0.13, midNode: 0.095 });
    const c = color ? mix(color[0], color[1], t) : [0, 0, 0];
    const o = (y * size + x) * 4;
    buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = Math.round(a * 255);
  }
  return png(size, size, buf);
}

const TEAL = [94, 234, 212], VIOLET = [167, 139, 250];
const frames = [0.5, 0.3, 0.42, 0.58, 0.7];
frames.forEach((mid, i) => {
  const name = i === 0 ? 'trayTemplate' : `traySync${i}Template`;
  writeFileSync(path.join(OUT, `${name}.png`), tray(18, { mid }));
  writeFileSync(path.join(OUT, `${name}@2x.png`), tray(36, { mid }));
});
writeFileSync(path.join(OUT, 'tray-win.png'), tray(32, { mid: 0.5, color: [TEAL, VIOLET] }));

// ---- app icon: dark squircle, glowing gradient mark -----------------------
function appIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const px = 1 / size;
  const inset = 0.1, r = 0.225; // macOS-style margin and corner radius
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    // rounded square
    const qx = Math.max(Math.abs(u - 0.5) - (0.5 - inset - r), 0), qy = Math.max(Math.abs(v - 0.5) - (0.5 - inset - r), 0);
    const sd = Math.hypot(qx, qy) - r;
    const bgA = clamp01(0.5 - sd / px);
    const out = [0, 0, 0, 0];
    if (bgA > 0) {
      // deep night gradient with a soft light from the top
      const g = clamp01((v - inset) / (1 - 2 * inset));
      const bg = mix([30, 27, 75], [9, 10, 24], g);
      const sheen = Math.exp(-((u - 0.35) ** 2 + (v - 0.15) ** 2) / 0.08) * 0.35;
      const c = mix(bg, [120, 110, 220], sheen);
      // the mark, scaled into the inner area
      const s = 1 - 2 * (inset + 0.06), mu = (u - inset - 0.06) / s, mv = (v - inset - 0.06) / s;
      const { a, t, d } = mark(mu, mv, { mid: 0.5, px: px / s });
      const col = mix(TEAL, VIOLET, t);
      const glow = Math.exp(-((d / 0.07) ** 2)) * 0.55 * (1 - a);
      const lit = mix(c, col, clamp01(glow));
      const fin = mix(lit, mix(col, [255, 255, 255], 0.12), a);
      over(out, fin, bgA);
      // hairline highlight on the top edge
      const edge = clamp01(1 - Math.abs(sd + px * 1.5) / (px * 1.2)) * clamp01(1 - (v - inset) * 3) * 0.35;
      for (let i = 0; i < 3; i++) out[i] = out[i] + (255 - out[i]) * edge;
    }
    const o = (y * size + x) * 4;
    buf[o] = Math.round(out[0]); buf[o + 1] = Math.round(out[1]); buf[o + 2] = Math.round(out[2]); buf[o + 3] = Math.round(out[3] * 255);
  }
  return png(size, size, buf);
}
for (const s of [512, 1024]) writeFileSync(path.join(OUT, `icon-${s}.png`), appIcon(s));
writeFileSync(path.join(OUT, 'icon.png'), appIcon(256));
console.log('icons written to', OUT);

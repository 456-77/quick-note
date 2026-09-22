/**
 * 应用图标生成（零依赖：Node 内置 zlib 直接编码 PNG）。
 *
 * 设计：品牌靛蓝（--accent #5b5bd6 一族）渐变圆角方块 + 白色闪电（Quick）。
 * 4× 超采样抗锯齿，输出 1024×1024 源图；全套尺寸用 `npx tauri icon` 展开：
 *   node scripts/make-icon.mjs && npx tauri icon scripts/icon-source.png -o src-tauri/icons
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SS = 4; // 每边超采样倍数
const TOTAL = SIZE * SS;

// 渐变端色（品牌靛蓝）与前景
const TOP = [0x76, 0x76, 0xf2];
const BOTTOM = [0x46, 0x46, 0xc2];
const FORE = [0xff, 0xff, 0xff];

/** 闪电外轮廓（归一化坐标，y 向下）。 */
const BOLT = [
  [0.6, 0.06],
  [0.26, 0.56],
  [0.46, 0.56],
  [0.38, 0.94],
  [0.74, 0.44],
  [0.53, 0.44],
];

/** 射线法：点是否在多边形内。 */
function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 圆角方块的带符号距离（负在内部），归一化坐标。 */
const RADIUS = 0.22;
function roundedRectSDF(px, py) {
  const half = 0.5;
  const b = half - RADIUS;
  const qx = Math.abs(px - half) - b;
  const qy = Math.abs(py - half) - b;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - RADIUS;
}

const rowStride = SIZE * 4;
const raw = Buffer.alloc((rowStride + 1) * SIZE);

for (let y = 0; y < SIZE; y += 1) {
  raw[y * (rowStride + 1)] = 0; // PNG filter: None
  for (let x = 0; x < SIZE; x += 1) {
    let covBg = 0;
    let covFg = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const px = (x * SS + sx + 0.5) / TOTAL;
        const py = (y * SS + sy + 0.5) / TOTAL;
        if (roundedRectSDF(px, py) < 0) {
          covBg += 1;
          if (inPoly(px, py, BOLT)) covFg += 1;
        }
      }
    }
    const samples = SS * SS;
    covBg /= samples;
    covFg /= samples;
    const t = y / (SIZE - 1);
    const base = [
      Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
      Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
      Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
    ];
    const out = raw.subarray(y * (rowStride + 1) + 1 + x * 4);
    out[0] = Math.round(base[0] + (FORE[0] - base[0]) * covFg);
    out[1] = Math.round(base[1] + (FORE[1] - base[1]) * covFg);
    out[2] = Math.round(base[2] + (FORE[2] - base[2]) * covFg);
    out[3] = Math.round(covBg * 255);
  }
}

// ---- PNG 编码（RGBA8，单 IDAT）----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "icon-source.png");
writeFileSync(out, png);
console.log(`written: ${out} (${png.length} bytes)`);

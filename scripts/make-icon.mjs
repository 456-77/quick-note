/**
 * 应用图标生成（零依赖：Node 内置 zlib 直接编码 PNG）。
 *
 * 0.27 起为「方案 D · 极简 Q」（用户 2026-10-20 反馈选定）：深靛蓝渐变圆角
 * 方块 + 青→蓝→紫渐变的粗圆环 Q + 右下斜出的紫色尾笔。环与尾共用蓝紫强调色
 * 一族，小尺寸下只剩「一个环一条尾」，辨识度靠轮廓不靠细节。
 *
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

// 瓷砖：深靛蓝纵向渐变（亮部在上，压住圆环的青色那侧）
const TILE_TOP = [0x2a, 0x33, 0xb4];
const TILE_BOTTOM = [0x0d, 0x1e, 0x70];

// 圆环渐变：左上青 → 右下紫（沿环的角度插值，首尾同色闭环）
const RING_A = [0x53, 0xc3, 0xfe];
const RING_B = [0x2f, 0x7b, 0xf9];
const RING_C = [0x8a, 0x52, 0xfd];
// 尾笔：紫色（与环的末端同族，视觉上是环的延伸）
const TAIL = [0x8a, 0x52, 0xfd];

/** 圆角方块的带符号距离（负在内部），归一化坐标。 */
const RADIUS = 0.225;
function roundedRectSDF(px, py) {
  const half = 0.5;
  const b = half - RADIUS;
  const qx = Math.abs(px - half) - b;
  const qy = Math.abs(py - half) - b;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - RADIUS;
}

/** Q 的几何：环心略偏左上，给右下的尾笔留出呼吸位（环径 ~75% 图标宽）。 */
const CX = 0.472;
const CY = 0.468;
const RING_R = 0.308;
const RING_W = 0.132; // 环的半宽（笔画粗 ~26% 直径，小尺寸不断线）

/** 环的带符号距离（负在笔画内）。 */
function ringSDF(px, py) {
  return Math.abs(Math.hypot(px - CX, py - CY) - RING_R) - RING_W / 2;
}

/**
 * 尾笔：从环内侧右下方斜出到图标右下角的一条「平行四边形带」。
 * 用点积把点投影到尾笔的轴上，带宽做半宽；尾根与环搭接（起点在环内侧），
 * 尾端止于距右下角 ~0.10 处，不出瓷砖边。
 */
const TAIL_AX = 0.53; // 尾根（环内）
const TAIL_AY = 0.55;
const TAIL_BX = 0.845; // 尾梢
const TAIL_BY = 0.865;
const TAIL_HW = 0.072; // 半宽
function tailSDF(px, py) {
  const vx = TAIL_BX - TAIL_AX;
  const vy = TAIL_BY - TAIL_AY;
  const len2 = vx * vx + vy * vy;
  let t = ((px - TAIL_AX) * vx + (py - TAIL_AY) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = TAIL_AX + vx * t;
  const cy = TAIL_AY + vy * t;
  return Math.hypot(px - cx, py - cy) - TAIL_HW;
}

/** 环上一点的角度 → 渐变色（左上青起，顺时针经蓝到右下紫，闭环回青）。 */
function ringColorAt(px, py) {
  const ang = Math.atan2(py - CY, px - CX); // -π..π，0=右
  // t 沿角度走：0 = 左上(-3π/4) → 0.5 = 右下(π/4) → 1 回到左上
  let t = ((ang + (Math.PI * 5) / 4) / (Math.PI * 2) + 1) % 1;
  if (t > 0.5) t = 1 - t; // 对称闭环：两侧都从青过渡到紫
  const mix2 = (a, b, k) => [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
  return t < 0.5 ? mix2(RING_A, RING_B, t * 2) : mix2(RING_B, RING_C, (t - 0.5) * 2);
}

const rowStride = SIZE * 4;
const raw = Buffer.alloc((rowStride + 1) * SIZE);

for (let y = 0; y < SIZE; y += 1) {
  raw[y * (rowStride + 1)] = 0; // PNG filter: None
  for (let x = 0; x < SIZE; x += 1) {
    let covTile = 0;
    let covRing = 0;
    let covTail = 0;
    let ringColorAcc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const px = (x * SS + sx + 0.5) / TOTAL;
        const py = (y * SS + sy + 0.5) / TOTAL;
        if (roundedRectSDF(px, py) < 0) {
          covTile += 1;
          if (ringSDF(px, py) < 0) {
            covRing += 1;
            const c = ringColorAt(px, py);
            ringColorAcc[0] += c[0];
            ringColorAcc[1] += c[1];
            ringColorAcc[2] += c[2];
          } else if (tailSDF(px, py) < 0) {
            covTail += 1;
          }
        }
      }
    }
    const samples = SS * SS;
    covTile /= samples;
    covRing /= samples;
    covTail /= samples;
    const t = y / (SIZE - 1);
    const tile = [
      Math.round(TILE_TOP[0] + (TILE_BOTTOM[0] - TILE_TOP[0]) * t),
      Math.round(TILE_TOP[1] + (TILE_BOTTOM[1] - TILE_TOP[1]) * t),
      Math.round(TILE_TOP[2] + (TILE_BOTTOM[2] - TILE_TOP[2]) * t),
    ];
    // 前景混合顺序：环（角向渐变）压瓷砖，尾压环（尾根在环上搭接）
    let fore = tile;
    if (covRing + covTail > 0) {
      // ringColorAcc 累加的是「每个命中子采样」的颜色；除以命中数即为均值
      const hit = Math.round(covRing * samples);
      const ringMean = hit > 0
        ? [
            Math.round(ringColorAcc[0] / hit),
            Math.round(ringColorAcc[1] / hit),
            Math.round(ringColorAcc[2] / hit),
          ]
        : RING_B;
      const over = (base, top, alpha) => [
        Math.round(base[0] + (top[0] - base[0]) * alpha),
        Math.round(base[1] + (top[1] - base[1]) * alpha),
        Math.round(base[2] + (top[2] - base[2]) * alpha),
      ];
      fore = over(tile, ringMean, covRing);
      fore = over(fore, TAIL, covTail);
    }
    const out = raw.subarray(y * (rowStride + 1) + 1 + x * 4);
    out[0] = fore[0];
    out[1] = fore[1];
    out[2] = fore[2];
    out[3] = Math.round(covTile * 255);
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

/**
 * Android 自适应图标（adaptive icon）双层生成——零依赖。
 *
 * 0.34.6 用户反馈「手机上显示的软件图标效果不好」：此前 adaptive icon 的
 * background 是白色颜色资源，且前景图未经安全区缩放——圆形遮罩下表现成
 * 「白圈 + 偏小的图形」。本脚本从渲染源图（scripts/icon-source.png，透明底、
 * 0.29.1 放大版）产出规范两层：
 *   - foreground：按 alpha 包围盒裁出图形，Box 采样缩到画布中心 ~60%
 *     （安全区 66% 内），任意遮罩不裁主体；
 *   - background：方案 D 的深靛蓝纵向渐变（make-icon.mjs 同款瓷砖色）铺满；
 *   - 合成品（ic_launcher.png / _round.png，API<26 与设置页用）：背景 + 前景
 *     + 圆角遮罩。
 * 并把 ic_launcher.xml 的 background 从 @color 切到 @mipmap。源图或几何变了
 * 重跑本脚本即可。
 */

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "scripts", "icon-source.png");
const RES = join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");

// 方案 D 瓷砖色（make-icon.mjs 同款）：深靛蓝纵向渐变
const TILE_TOP = [0x2a, 0x33, 0xb4];
const TILE_BOTTOM = [0x0d, 0x1e, 0x70];

// ---------------------------------------------------------------- PNG 解码
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`unsupported png: depth=${bitDepth} color=${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? line[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      switch (filter) {
        case 1: line[x] = (line[x] + a) & 0xff; break;
        case 2: line[x] = (line[x] + b) & 0xff; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
      }
    }
    line.copy(out, y * stride);
    line.copy(prev);
  }
  return { width, height, data: out };
}

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 0;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] >>> 0;
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
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 主流程
const { width: W, height: H, data: px } = decodePng(readFileSync(SRC));
console.log(`source: ${W}x${H}`);

// 1) alpha 包围盒（透明底源图：图形就是 alpha>16 的区域）
let minX = W;
let minY = H;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    if (px[(y * W + x) * 4 + 3] > 16) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
const gw = maxX - minX + 1;
const gh = maxY - minY + 1;
console.log(`figure bbox: (${minX},${minY})-(${maxX},${maxY}) ${gw}x${gh} (${(Math.max(gw, gh) / W).toFixed(2)} of source)`);

// 2) Box 采样缩放（premultiply 防暗边）到目标画布中心 ~60%（安全区 66% 内）
function foreground(canvasSize) {
  const out = Buffer.alloc(canvasSize * canvasSize * 4);
  const target = Math.round(canvasSize * 0.6);
  const scale = target / Math.max(gw, gh);
  const dw = Math.max(1, Math.round(gw * scale));
  const dh = Math.max(1, Math.round(gh * scale));
  const ox = Math.round((canvasSize - dw) / 2);
  const oy = Math.round((canvasSize - dh) / 2);
  for (let dy = 0; dy < dh; dy += 1) {
    const syA = minY + Math.floor((dy * gh) / dh);
    const syB = Math.max(syA + 1, minY + Math.floor(((dy + 1) * gh) / dh));
    for (let dx = 0; dx < dw; dx += 1) {
      const sxA = minX + Math.floor((dx * gw) / dw);
      const sxB = Math.max(sxA + 1, minX + Math.floor(((dx + 1) * gw) / dw));
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      let n = 0;
      for (let sy = syA; sy < syB && sy < H; sy += 1) {
        for (let sx = sxA; sx < sxB && sx < W; sx += 1) {
          const o = (sy * W + sx) * 4;
          const a = px[o + 3] / 255;
          ar += px[o] * a;
          ag += px[o + 1] * a;
          ab += px[o + 2] * a;
          aa += px[o + 3];
          n += 1;
        }
      }
      if (n === 0) continue;
      const alpha = aa / n;
      const a01 = alpha / 255;
      const o = ((oy + dy) * canvasSize + (ox + dx)) * 4;
      out[o] = a01 > 0 ? Math.round(ar / n / a01) : 0;
      out[o + 1] = a01 > 0 ? Math.round(ag / n / a01) : 0;
      out[o + 2] = a01 > 0 ? Math.round(ab / n / a01) : 0;
      out[o + 3] = Math.round(alpha);
    }
  }
  return out;
}

// 3) 背景：深靛蓝纵向渐变（铺满 108dp 全出血）
function background(canvasSize) {
  const out = Buffer.alloc(canvasSize * canvasSize * 4);
  for (let y = 0; y < canvasSize; y += 1) {
    const t = y / (canvasSize - 1);
    const r = Math.round(TILE_TOP[0] + (TILE_BOTTOM[0] - TILE_TOP[0]) * t);
    const g = Math.round(TILE_TOP[1] + (TILE_BOTTOM[1] - TILE_TOP[1]) * t);
    const b = Math.round(TILE_TOP[2] + (TILE_BOTTOM[2] - TILE_TOP[2]) * t);
    for (let x = 0; x < canvasSize; x += 1) {
      const o = (y * canvasSize + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}

// 4) 合成品（API<26 fallback 与设置页）：背景 + 前景 + 圆角遮罩
function composite(canvasSize, fgRgba) {
  const out = background(canvasSize);
  for (let i = 0; i < canvasSize * canvasSize; i += 1) {
    const a = fgRgba[i * 4 + 3] / 255;
    if (a > 0) {
      for (let ch = 0; ch < 3; ch += 1) {
        out[i * 4 + ch] = Math.round(out[i * 4 + ch] * (1 - a) + fgRgba[i * 4 + ch] * a);
      }
    }
  }
  const r = Math.round(canvasSize * 0.12);
  for (let y = 0; y < canvasSize; y += 1) {
    for (let x = 0; x < canvasSize; x += 1) {
      const cx = Math.min(x, canvasSize - 1 - x);
      const cy = Math.min(y, canvasSize - 1 - y);
      if (cx < r && cy < r) {
        const dx = r - cx;
        const dy = r - cy;
        if (dx * dx + dy * dy > r * r) out[(y * canvasSize + x) * 4 + 3] = 0;
      }
    }
  }
  return out;
}

const DENSITIES = [
  ["mdpi", 108],
  ["hdpi", 162],
  ["xhdpi", 216],
  ["xxhdpi", 324],
  ["xxxhdpi", 432],
];
for (const [dpi, size] of DENSITIES) {
  const dir = join(RES, `mipmap-${dpi}`);
  const fgCanvas = foreground(size);
  writeFileSync(join(dir, "ic_launcher_foreground.png"), encodePng(size, size, fgCanvas));
  writeFileSync(join(dir, "ic_launcher_background.png"), encodePng(size, size, background(size)));
  writeFileSync(join(dir, "ic_launcher.png"), encodePng(size, size, composite(size, fgCanvas)));
  writeFileSync(join(dir, "ic_launcher_round.png"), encodePng(size, size, composite(size, fgCanvas)));
  console.log(`mipmap-${dpi}: ${size}px ✓`);
}

// 5) adaptive icon 的 background 从 @color（白）切到 @mipmap（渐变图）——白圈根源
for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  const p = join(RES, "mipmap-anydpi-v26", name);
  try {
    const updated = readFileSync(p, "utf8").replace(
      '<background android:drawable="@color/ic_launcher_background"/>',
      '<background android:drawable="@mipmap/ic_launcher_background"/>',
    );
    writeFileSync(p, updated);
  } catch {
    // 没有 round 变体就算了
  }
}
console.log("adaptive icon xml updated ✓");

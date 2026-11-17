/**
 * 图片「框选识别」的公共管线（0.39.19 用户反馈「图片的识别文本功能不是全部
 * 识别而是识别框定的范围内的内容」）：在图片上拖一个框，只把框内的像素送
 * WinRT OCR。灯箱与图片预览两条表面共用这里的坐标换算与裁剪。
 *
 * 为什么用 fetch + createImageBitmap 裁剪而不是直接对 <img> 画 canvas：
 * 图片来自 asset 协议（与 tauri.localhost 跨源），直接画进 canvas 会污染、
 * toDataURL 抛 SecurityError；fetch 回 blob 再 createImageBitmap 是同源的，
 * 画布干净。裁剪按**自然分辨率**取像素（放大后框选也能拿到原图精度的区域，
 * OCR 质量不受显示缩放影响；超尺寸由 Rust 侧的 WinRT 预缩放兜底）。
 */

/** 图片自然像素坐标下的裁剪区域。 */
export interface PixelRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** 比这更小的拖动视为「点了识别」→ 整图识别。 */
export const SELECTION_MIN_DRAG = 6;

/**
 * 视口选框 → 图片自然像素区域。与 img 的可视矩形求交并夹取到自然尺寸；
 * 选框完全在图外返回 null。
 */
export function selectionToRegion(
  img: HTMLImageElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): PixelRegion | null {
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || !img.naturalWidth) return null;
  const ix1 = Math.max(Math.min(x1, x2), rect.left);
  const iy1 = Math.max(Math.min(y1, y2), rect.top);
  const ix2 = Math.min(Math.max(x1, x2), rect.right);
  const iy2 = Math.min(Math.max(y1, y2), rect.bottom);
  if (ix2 <= ix1 || iy2 <= iy1) return null;
  const scaleX = img.naturalWidth / rect.width;
  const scaleY = img.naturalHeight / rect.height;
  const sx = Math.max(0, Math.floor((ix1 - rect.left) * scaleX));
  const sy = Math.max(0, Math.floor((iy1 - rect.top) * scaleY));
  const sw = Math.min(img.naturalWidth - sx, Math.ceil((ix2 - ix1) * scaleX));
  const sh = Math.min(img.naturalHeight - sy, Math.ceil((iy2 - iy1) * scaleY));
  if (sw <= 0 || sh <= 0) return null;
  return { sx, sy, sw, sh };
}

/**
 * 取图片字节并裁剪成 PNG base64（screenshot_ocr 的入参格式）。
 * `region` 传 null = 整图。
 */
export async function cropImageRegionBase64(
  src: string,
  region: PixelRegion | null,
): Promise<string> {
  const blob = await fetch(src).then((r) => r.blob());
  const bitmap = await createImageBitmap(blob);
  const sx = Math.max(0, Math.round(region?.sx ?? 0));
  const sy = Math.max(0, Math.round(region?.sy ?? 0));
  const sw = Math.max(
    1,
    Math.min(bitmap.width - Math.min(sx, bitmap.width - 1), Math.round(region?.sw ?? bitmap.width)),
  );
  const sh = Math.max(
    1,
    Math.min(bitmap.height - Math.min(sy, bitmap.height - 1), Math.round(region?.sh ?? bitmap.height)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建裁剪画布");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}

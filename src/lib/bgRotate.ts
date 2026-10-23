/**
 * 壁纸轮换的选图逻辑（0.32 用户需求「支持选定壁纸图片目录，设置一定时间自动
 * 轮换壁纸，可以随机也可以按顺序轮换」）。
 *
 * 定时器与落盘在 App 侧（settings 变更会触发背景重铺），这里只放**纯函数**：
 * 目录扫描的文件列表进、下一张图出，Node 里直接断言。
 */

/** 顺序模式：按列表（已按文件名排序）取当前图的下一张；当前图不在列表里（被删/首次启动）从头开始。 */
export function nextSequential(images: string[], current: string): string | null {
  if (images.length === 0) return null;
  const index = images.findIndex((image) => samePath(image, current));
  if (index < 0) return images[0];
  return images[(index + 1) % images.length];
}

/** 随机模式：等概率挑一张，且不与当前重复（目录里只有一张时只能重复它）。 */
export function nextRandom(images: string[], current: string): string | null {
  if (images.length === 0) return null;
  if (images.length === 1) return images[0];
  let index = Math.floor(Math.random() * images.length);
  if (samePath(images[index], current)) {
    index = (index + 1) % images.length;
  }
  return images[index];
}

/** Windows 路径大小写不敏感、分隔符 \ / 等价。 */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.toLowerCase().replace(/\\/g, "/") === b.toLowerCase().replace(/\\/g, "/");
}

/** 轮换间隔（分钟）的合法范围：1 分钟到一天。 */
export function clampRotateMinutes(value: number): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(1440, Math.max(1, Math.round(value)));
}

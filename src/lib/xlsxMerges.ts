/**
 * Excel 合并单元格的纯函数处理（0.39.5 用户反馈「表头合并了多个单元格，
 * 预览却只占一个单元格」——WPS 里 F1:M1 的合并标题，预览里只落在 F 一格）。
 *
 * xlsx Worker 从 `ws['!merges']` 读到原始区间（起止单元格），这里负责把区间
 * 裁剪进实际解析的窗口（20000 行 × 80 列）并转成渲染侧的 (r, c, rowSpan,
 * colSpan) 相对坐标。渲染层按「区间左上角带 span、被覆盖格跳过」铺开。
 */

/** 渲染侧的合并区间：相对解析窗口的 0 基坐标 + 跨行/跨列数（≥1）。 */
export interface SheetMerge {
  r: number;
  c: number;
  rs: number;
  cs: number;
}

/** SheetJS 的 `!merges` 原始条目（起止单元格，绝对 0 基坐标）。 */
export interface RawMerge {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

/**
 * 把原始合并区间裁剪进解析窗口。
 *
 * - 与窗口无交集的丢弃；跨界（比如 5000 行截断处拦腰）的 span 收进窗口；
 * - 单格区间（rs=cs=1）没有渲染意义，丢弃；
 * - 上限 count 上限防异常文件（个别表有上万条无意义合并）拖慢渲染。
 */
export function clampMerges(
  raw: RawMerge[] | undefined,
  startRow: number,
  endRow: number,
  startCol: number,
  endCol: number,
  limit = 2000,
): SheetMerge[] {
  const out: SheetMerge[] = [];
  if (!raw || raw.length === 0) return out;
  for (const m of raw) {
    const r0 = Math.max(m.s.r, startRow);
    const r1 = Math.min(m.e.r, endRow);
    const c0 = Math.max(m.s.c, startCol);
    const c1 = Math.min(m.e.c, endCol);
    if (r1 < r0 || c1 < c0) continue;
    const rs = r1 - r0 + 1;
    const cs = c1 - c0 + 1;
    if (rs <= 1 && cs <= 1) continue;
    out.push({ r: r0 - startRow, c: c0 - startCol, rs, cs });
    if (out.length >= limit) break;
  }
  return out;
}

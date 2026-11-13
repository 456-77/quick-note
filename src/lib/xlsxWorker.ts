/**
 * xlsx 解析 Worker（M5 改动二 / 0.34.3 内存轮）：SheetJS 的模块底数（~8–15MB）
 * 不再常驻主线程——每次解析新建 worker、拿到结果立即 terminate（见 xlsxWorkerHost），
 * worker isolate 连同整块模块一起释放。
 *
 * 0.39 用户反馈「添加对 excel 表的预览支持，同时要支持筛选功能」：
 * - 预览早已支持 xlsx（只读 HTML 注入），但 HTML 无法做列筛选——改为返回
 *   **二维显示字符串**，主线程按表渲染并带表头筛选（SpreadsheetPreview）。
 * - 顺带补上旧版 `.xls`（SheetJS 本身能读，之前 fileTypes 没路由）。
 * - 超大表截断：最多 20000 行 × 80 列（带 truncated 标记），筛选/渲染都在
 *   这个上限内，避免百万行表把预览拖死。0.39.3 用户反馈「为什么最多只显示
 *   4999 行」——5000 上限连表头一起算，数据行只剩 4999；Worker 一次性解析
 *   用完即释放，放大到 20000 对内存无压力。
 */

import * as XLSX from "xlsx";
import { clampMerges } from "./xlsxMerges.ts";
import { detectHeaderRow } from "./xlsxHeader.ts";

/** 单表最大预览行数/列数（0.39.3 由 5000 放大；超出只提示，不解析进内存）。 */
const MAX_ROWS = 20000;
const MAX_COLS = 80;

/** 一张表的解析结果（主线程 SpreadsheetPreview 用；行 = 显示字符串数组）。 */
export interface ParsedSheet {
  name: string;
  rows: string[][];
  /** 表里实际的行数（可能大于 rows.length，被 MAX_ROWS 截断时提示用）。 */
  totalRows: number;
  /** 行或列被截断。 */
  truncated: boolean;
  /**
   * 合并单元格区间（0.39.5：相对解析窗口的 (r,c,rs,cs)）——渲染层按区间
   * 左上角带 colSpan/rowSpan 铺开、被覆盖格跳过；没有它，WPS 里跨列合并的
   * 表头在预览里只占一格、其余列变字母占位。
   */
  merges: { r: number; c: number; rs: number; cs: number }[];
  /**
   * 真正的表头行号（0.39.7）：「合并大标题行 + 字段名行」两行头的文件里，
   * 0..headerRow-1 作为横幅行渲染（不吸附、无筛选），筛选与列头用紧挨数据
   * 的那一行。普通表恒为 0，行为不变。
   */
  headerRow: number;
}

self.onmessage = (event: MessageEvent<{ id: number; base64: string }>) => {
  const { id, base64 } = event.data;
  try {
    // 快速 base64→字节：Uint8Array.from(atob, 映射) 在数兆字节上比手写循环慢
    // 2-3 倍（0.39.9 用户反馈「优化表格加载速度」）
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    // dense:true：单元格存进二维数组、按 ws[R][C] 直取——省掉每格的 A1 地址
    // 字符串拼装 + 稀疏哈希查找，大表解析的主要开销之一；!ref/!merges 照常在
    const workbook = XLSX.read(bytes, { type: "array", dense: true });
    const sheets: ParsedSheet[] = workbook.SheetNames.map((name) => {
      const ws = workbook.Sheets[name];
      const ref = ws?.["!ref"];
      if (!ws || !ref) return { name, rows: [], totalRows: 0, truncated: false, merges: [], headerRow: 0 };
      const range = XLSX.utils.decode_range(ref);
      const rowCount = range.e.r - range.s.r + 1;
      const colCount = range.e.c - range.s.c + 1;
      const rowEnd = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
      const colEnd = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
      const merges = clampMerges(
        ws["!merges"] as { s: { r: number; c: number }; e: { r: number; c: number } }[] | undefined,
        range.s.r,
        rowEnd,
        range.s.c,
        colEnd,
      );
      // dense 形态（ws 是数组、ws[R][C] 即单元格）与稀疏形态都接：万一某个
      // 格式没走 dense，回退旧地址查找，行为与之前一致
      const denseRows = Array.isArray(ws)
        ? (ws as unknown as (XLSX.CellObject | undefined)[][])
        : null;
      const rows: string[][] = [];
      for (let r = range.s.r; r <= rowEnd; r += 1) {
        const row: string[] = [];
        for (let c = range.s.c; c <= colEnd; c += 1) {
          const cell = denseRows ? denseRows[r]?.[c] : ws[XLSX.utils.encode_cell({ r, c })];
          // format_cell 走 cell.w（数字/日期按表里的显示格式）——预览要所见即所得
          row.push(cell ? XLSX.utils.format_cell(cell) : "");
        }
        rows.push(row);
      }
      return {
        name,
        rows,
        totalRows: rowCount,
        truncated: rowCount > MAX_ROWS || colCount > MAX_COLS,
        merges,
        headerRow: detectHeaderRow(rows),
      };
    });
    self.postMessage({ id, sheets });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

/**
 * xlsx 解析 Worker（M5 改动二 / 0.34.3 内存轮）：SheetJS 的模块底数（~8–15MB）
 * 不再常驻主线程——每次解析新建 worker、拿到结果立即 terminate（见 xlsxWorkerHost），
 * worker isolate 连同整块模块一起释放。
 *
 * 0.39 用户反馈「添加对 excel 表的预览支持，同时要支持筛选功能」：
 * - 预览早已支持 xlsx（只读 HTML 注入），但 HTML 无法做列筛选——改为返回
 *   **二维显示字符串**，主线程按表渲染并带表头筛选（SpreadsheetPreview）。
 * - 顺带补上旧版 `.xls`（SheetJS 本身能读，之前 fileTypes 没路由）。
 * - 超大表截断：最多 5000 行 × 80 列（带 truncated 标记），筛选/渲染都在
 *   这个上限内，避免百万行表把预览拖死。
 */

import * as XLSX from "xlsx";

/** 单表最大预览行数/列数（0.39；超出只提示，不解析进内存）。 */
const MAX_ROWS = 5000;
const MAX_COLS = 80;

/** 一张表的解析结果（主线程 SpreadsheetPreview 用；行 = 显示字符串数组）。 */
export interface ParsedSheet {
  name: string;
  rows: string[][];
  /** 表里实际的行数（可能大于 rows.length，被 MAX_ROWS 截断时提示用）。 */
  totalRows: number;
  /** 行或列被截断。 */
  truncated: boolean;
}

self.onmessage = (event: MessageEvent<{ id: number; base64: string }>) => {
  const { id, base64 } = event.data;
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const workbook = XLSX.read(bytes, { type: "array" });
    const sheets: ParsedSheet[] = workbook.SheetNames.map((name) => {
      const ws = workbook.Sheets[name];
      const ref = ws?.["!ref"];
      if (!ws || !ref) return { name, rows: [], totalRows: 0, truncated: false };
      const range = XLSX.utils.decode_range(ref);
      const rowCount = range.e.r - range.s.r + 1;
      const colCount = range.e.c - range.s.c + 1;
      const rowEnd = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
      const colEnd = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
      const rows: string[][] = [];
      for (let r = range.s.r; r <= rowEnd; r += 1) {
        const row: string[] = [];
        for (let c = range.s.c; c <= colEnd; c += 1) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
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
      };
    });
    self.postMessage({ id, sheets });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

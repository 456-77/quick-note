/**
 * xlsx 解析 Worker（M5 改动二 / 0.34.3 内存轮）：SheetJS 的模块底数（~8–15MB）
 * 不再常驻主线程——每次解析新建 worker、拿到结果立即 terminate（见 xlsxWorkerHost），
 * worker isolate 连同整块模块一起释放。
 *
 * HTML 在这里只做 sheet_to_html 的**原始输出**：DOMPurify 依赖 DOM，消毒留在
 * 主线程做（与 FilePreview 原有流程一致）。
 */

import * as XLSX from "xlsx";

self.onmessage = (event: MessageEvent<{ id: number; base64: string }>) => {
  const { id, base64 } = event.data;
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const workbook = XLSX.read(bytes, { type: "array" });
    const sheets = workbook.SheetNames.map((name) => ({
      name,
      html: XLSX.utils.sheet_to_html(workbook.Sheets[name]),
    }));
    self.postMessage({ id, sheets });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

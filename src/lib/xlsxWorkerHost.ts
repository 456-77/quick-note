/**
 * xlsx 解析的 Worker 宿主（M5 改动二 / 0.34.3 内存轮）。
 *
 * 为什么要 Worker：SheetJS（xlsx）按需 import 后模块底数 ~8–15MB 常驻**主线程**
 * ——打开过一次 Excel 预览就一直占着。解析搬进 worker isolate，**用完即
 * terminate**，整块底数（连同 worker 全局）随之释放；下次预览重建（模块文件
 * 有 HTTP 缓存，重建开销可忽略）。大表解析 1–2 秒，"正在加载…"遮罩本就有。
 *
 * `?worker&inline`：tauri 自定义协议下跨源加载 module worker 会静默失败（与
 * pdfjs worker 同款坑，见 FilePreview 头部注释）。inline 会把 worker 打进本
 * 模块的异步 chunk——本模块只在首次 xlsx 预览时被动态 import，不影响启动体积。
 */

import XlsxWorker from "./xlsxWorker.ts?worker&inline";

export interface ParsedSheet {
  name: string;
  /** sheet_to_html 的原始输出（未消毒；主线程 DOMPurify.sanitize 后再用）。 */
  html: string;
}

/** 解析一个 xlsx/xls 字节流（base64）。任何失败都以 Error 抛出。 */
export function parseXlsxInWorker(base64: string, timeoutMs = 30_000): Promise<ParsedSheet[]> {
  return new Promise((resolve, reject) => {
    const worker = new XlsxWorker();
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("xlsx 解析超时"));
    }, timeoutMs);
    const finish = (fn: () => void) => {
      window.clearTimeout(timer);
      worker.terminate();
      fn();
    };
    worker.onmessage = (event: MessageEvent<{ id: number; sheets?: ParsedSheet[]; error?: string }>) => {
      finish(() => {
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.sheets ?? []);
      });
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "xlsx 解析失败")));
    };
    worker.postMessage({ id: 1, base64 });
  });
}

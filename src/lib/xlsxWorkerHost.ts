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

import { invoke } from "@tauri-apps/api/core";
import XlsxWorker from "./xlsxWorker.ts?worker&inline";
import { clampMerges } from "./xlsxMerges.ts";
import { detectHeaderRow } from "./xlsxHeader.ts";
import type { ParsedSheet } from "./xlsxWorker.ts";

export type { ParsedSheet };

/** Rust 侧 parse_xlsx 的返回（merges 是**原始**区间，前端 clampMerges 统一裁剪）。 */
interface NativeXlsxResult {
  sha256: string;
  size: number;
  sheets: {
    name: string;
    rows: string[][];
    totalRows: number;
    totalCols: number;
    truncated: boolean;
    merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  }[];
}

/**
 * Rust（calamine）直读解析：省掉 read_binary 的 base64 IPC、atob 与 SheetJS
 * Worker 三段（0.39.9 用户反馈「用 rust 加快表格的解析」）。merges 裁剪与
 * headerRow 识别复用前端同一套纯函数，保证与 Worker 路径同口径。
 * 仅支持 .xlsx；打不开（加密/损坏等）抛错由调用方回退 Worker 路径。
 */
export async function parseXlsxNative(vault: string, path: string): Promise<ParsedSheet[]> {
  const res = await invoke<NativeXlsxResult>("parse_xlsx", { vault, path });
  const key = `${vault}::${path}::${res.sha256}`;
  const hit = parseCache.get(key);
  if (hit) {
    parseCache.delete(key);
    parseCache.set(key, hit);
    return hit;
  }
  const sheets: ParsedSheet[] = res.sheets.map((s) => {
    const colEnd = Math.max(0, (s.rows[0]?.length ?? 1) - 1);
    return {
      name: s.name,
      rows: s.rows,
      totalRows: s.totalRows,
      truncated: s.truncated,
      merges: clampMerges(s.merges, 0, Math.max(0, s.rows.length - 1), 0, colEnd),
      headerRow: detectHeaderRow(s.rows),
    };
  });
  parseCache.set(key, sheets);
  while (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value as string;
    parseCache.delete(oldest);
  }
  return sheets;
}

/**
 * 解析结果的会话缓存（0.39.9 用户反馈「优化表格加载速度」）：同一文件在左右
 * 两栏各开一份、预览标签切走再切回，都会重走一遍「读盘 → Worker 解析」，大表
 * 1–2 秒的解析是大头。读盘本来就返回 sha256——键带哈希，文件一变键就变，
 * **不可能吃到旧表**；LRU 上限 2 份（解析结果只是显示字符串，SheetJS 模块
 * 底数仍随 worker 用完即释放，内存纪律不破）。
 */
const parseCache = new Map<string, ParsedSheet[]>();
const PARSE_CACHE_MAX = 2;

/** 解析一个 xlsx/xls 字节流（base64）。传 cacheKey（含文件哈希）时命中缓存直接返回。任何失败都以 Error 抛出。 */
export function parseXlsxInWorker(
  base64: string,
  timeoutMs = 30_000,
  cacheKey?: string,
): Promise<ParsedSheet[]> {
  if (cacheKey) {
    const hit = parseCache.get(cacheKey);
    if (hit) {
      // LRU 触碰：删了再放，命中过的排到最年轻
      parseCache.delete(cacheKey);
      parseCache.set(cacheKey, hit);
      return Promise.resolve(hit);
    }
  }
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
        else {
          const sheets = event.data.sheets ?? [];
          if (cacheKey) {
            parseCache.set(cacheKey, sheets);
            while (parseCache.size > PARSE_CACHE_MAX) {
              const oldest = parseCache.keys().next().value as string;
              parseCache.delete(oldest);
            }
          }
          resolve(sheets);
        }
      });
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "xlsx 解析失败")));
    };
    worker.postMessage({ id: 1, base64 });
  });
}

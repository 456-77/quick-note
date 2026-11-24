/**
 * 预览窗格：PDF / Word(docx) / Excel(xlsx) / PPT(pptx) / HTML / 图片 的只读查看。
 *
 * 打开方式：点击左侧树里的对应文件（不进编辑器、不占标签）。所有渲染器都
 * **按需动态 import**——pdfjs/docx-preview/xlsx 体量都不小，主包不能背着它们。
 *
 * ## PDF 渲染的两个关键决定
 *
 * 1. **workerPort 内联 worker**：tauri 自定义协议下跨源加载 module worker 会
 *    静默失败（getDocument 永远等待），内联构造没有任何网络请求，dev/prod 一致。
 * 2. **懒渲染 + 主动销毁**：只渲染视口内的页（IntersectionObserver，前后预渲染
 *    一屏），滚离的页释放画布只留占位高度；关闭/切换时经 PDFDocumentLoadingTask
 *    销毁整个文档。预览大 PDF 曾把渲染进程推到 600MB+，这组纪律把它压回两位数。
 *
 * ## 内存纪律
 *
 * - pdfjs worker 是**模块级单例**：外部传入的 worker 在 loadingTask.destroy()
 *   时只会销毁文档传输层，**不会 terminate 这个 Worker**——此前每次打开都 new
 *   一个且从不回收，快速连续预览十几个文件就把渲染进程顶到 600MB+；
 * - 图片走 asset 协议 URL（解码交给浏览器缓存策略），不做 base64 内联；
 * - docx/xlsx 的字节缓冲传给渲染器后不长期持有；
 * - React StrictMode 下 effect 会跑两次：以"后一次挂载"为准，前一次的取消标志
 *   负责把它刚开的加载任务立刻销毁。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readBinary, readNote, screenshotOcr } from "../lib/api";
import { aiConfigured, aiRecognizeImage } from "../lib/aiVision";
import { extOf, fileKindOf } from "../lib/fileTypes";
import { isMobile } from "../lib/platform";
import type { ParsedSheet } from "../lib/xlsxWorkerHost";
import SpreadsheetPreview from "./SpreadsheetPreview";
import PreviewScrollbar from "./PreviewScrollbar";
import { cropImageRegionBase64, selectionToRegion, SELECTION_MIN_DRAG, type PixelRegion } from "../lib/imageOcr";
import { IconMinus, IconPlus, IconX } from "./icons";

interface Props {
  vault: string;
  path: string;
  onClose: () => void;
  /** true = 嵌在内容区标签页里（0.35.3），不再是全屏浮层；默认 false = 浮层。 */
  embedded?: boolean;
  /** Esc 关闭预览是否生效（0.39.8）：App 在任何浮层/菜单开着时传 false——
   *  预览的 window 级 Esc 监听是浮层时代遗留，标签页化后不能抢别的弹层的 Esc。 */
  escClose?: boolean;
  /** 用户在预览内容上按下鼠标（0.39.9）：嵌入形态的预览盖住编辑器，App 的
   *  「最后聚焦窗格」此前只能靠编辑器/标签栏的 mousedown 更新——左栏预览上
   *  点来点去焦点永远停在右栏，之后点文件树的文件全开进右栏。 */
  onActivate?: () => void;
  /** 外部修改刷新信号（0.39.12 反馈「excel 预览文件外部修改时，不会更新内容」）：
   *  App 监听到该路径的文件变更事件后递增；数值变化让加载 effect 重跑——重读
   *  磁盘、哈希变化使解析缓存失配，内容没变时缓存命中、无感。 */
  reloadSignal?: number;
  /** PDF 书签目录上报（0.39.17 用户反馈「pdf 有目录的，显示在右侧目录面板」）：
   *  加载完成后把目录与跳页闭包交给 App（App 清空时机=预览切换）。 */
  onPdfToc?: (toc: PdfToc | null) => void;
}

/** PDF 手动缩放范围：下限防糊、上限防画布爆内存（3× A4 = 约 1800×2400 CSS px）。 */
const PDF_ZOOM_MIN = 0.4;
const PDF_ZOOM_MAX = 3;
/** 单页画布的像素预算：缩放/dpr 再大也不超过它（1 页 ~32MB RGBA）。 */
const PDF_CANVAS_PIXEL_BUDGET = 8_000_000;

const KIND_LABEL: Record<string, string> = {
  pdf: "PDF 文档",
  docx: "Word 文档",
  ppt: "PPT 演示文稿",
  spreadsheet: "Excel 表格",
  html: "HTML 页面",
  image: "图片",
};

/** PDF 书签（outline）目录的一项。page 为 0 基页码，-1 = 目标解析失败（只显示标题）。 */
export interface PdfTocEntry {
  title: string;
  page: number;
  depth: number;
}

/** 一份 PDF 的目录：path 用于 App 侧对齐「当前在看哪一栏的预览」，jump 跳页。 */
export interface PdfToc {
  path: string;
  entries: PdfTocEntry[];
  jump: (page: number) => void;
}

/**
 * 0.38.7 用户反馈「预览文件切换回来后，原来的缩放状态会重置」：切走即卸载、
 * 切回重挂载，缩放状态按 仓库/路径 缓存在模块级（内存态，应用重启即清）。
 * zoom=pdf/html/docx 的倍率（pdf 的「适应宽度」记 undefined）；图片另存
 * 位图缩放与平移。 */
const previewZoomMemo = new Map<string, { zoom?: number; imgScale?: number; imgX?: number; imgY?: number }>();
function zoomMemoOf(key: string): { zoom?: number; imgScale?: number; imgX?: number; imgY?: number } {
  let memo = previewZoomMemo.get(key);
  if (!memo) {
    memo = {};
    previewZoomMemo.set(key, memo);
  }
  return memo;
}

/**
 * 图片识别结果的会话缓存（0.39.28 用户反馈「AI 识别响应一般比较慢，切换标签页
 * 后得重新点击」）：FilePreview 以 activePreview 为 key 条件渲染，切标签即卸载
 * 重挂、组件 state 全丢——识别结果以 `vault\0path` 为键记在这里，切回来直接
 * 回填，点 ✕ 才清掉。与 SpreadsheetPreview 的 filterCache 同一套纪律。
 */
const ocrCache = new Map<string, { busy: boolean; text: string | null; kind: "ocr" | "ai" }>();

/** base64 → 字节（分块转换，避免超长参数撑爆调用栈）。 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * pdfjs worker 单例（所有文档复用同一个 worker）。
 *
 * pdfjs 对外部传入的 workerPort 只用不还：loadingTask.destroy() 销毁文档传输层，
 * 但 terminate 不到这个 Worker 本体。此前每次打开 PDF 都 new 一个且不回收，每个
 * 常驻 20-40MB，连续预览就把渲染进程顶到 600MB+。
 *
 * 这里自持 **PDFWorker 包装层**并经 `getDocument({ worker })` 传入，而不是设
 * GlobalWorkerOptions.workerPort：后者创建的包装层会被任务 destroy 打上
 * _pendingDestroy 并在异步完成后才从端口缓存摘除，快速切换文件时下一次
 * getDocument 会撞上 "the worker is being destroyed"。自持实例任务碰不到，
 * 端口缓存也不再参与。
 */
let pdfWorker: import("pdfjs-dist").PDFWorker | null = null;
let pdfWorkerRaw: Worker | null = null;
/** 本会话是否加载过 pptx 渲染器（连带 echarts）；未加载时图表清理无事可做。 */
let pptxChartsLoaded = false;

async function acquirePdfWorker(pdfjs: typeof import("pdfjs-dist")) {
  if (pdfWorker) return pdfWorker;
  const PdfWorkerImpl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?worker&inline")).default;
  // pdfjs 的 d.ts 由 JSDoc 生成，把 constructor 的 port 误标成 null|undefined，
  // 运行时签名是 port?: Worker——这里按真实签名重述一遍
  type PdfWorkerCtor = new (params: {
    name?: string;
    port?: Worker;
    verbosity?: number;
  }) => import("pdfjs-dist").PDFWorker;
  const PDFWorkerC = pdfjs.PDFWorker as unknown as PdfWorkerCtor;
  pdfWorkerRaw = new PdfWorkerImpl();
  pdfWorker = new PDFWorkerC({ port: pdfWorkerRaw });
  return pdfWorker;
}

/** 预览整体关闭时 terminate worker：只有线程真死掉，其堆内的字体/图片缓存才归还。 */
function releasePdfWorker(): void {
  pdfWorker?.destroy();
  pdfWorkerRaw?.terminate();
  pdfWorker = null;
  pdfWorkerRaw = null;
}

/**
 * 闲置深度清理。按需加载的**模块代码**（pdfjs/echarts/docx-preview…）受平台限制
 * 无法卸载，属于常驻底数；能回收的是各渲染器的**运行期产物**——图表实例就是
 * 典型：pptx 内嵌的 echarts 图表在 DOM 摘除后仍驻留在 echarts 注册表里，必须
 * 显式 dispose。这里兜两类：切换/关闭当场扫一遍挂载容器；关闭瞬间渲染还在
 * 进行、来不及扫到的实例挂在孤儿容器上，闲置一段时间后再清。
 */
const IDLE_RELEASE_MS = 120_000;
let idleReleaseTimer: number | undefined;
let pptxOrphanRoot: HTMLElement | null = null;

/** 把 root 里 echarts 实例逐个 dispose（容器可能已脱离文档，直接按元素找）。 */
function sweepPptxCharts(root: HTMLElement | null): void {
  if (!root || !pptxChartsLoaded) return;
  const containers = root.querySelectorAll("[_echarts_instance_]");
  if (containers.length === 0) return;
  void import("echarts").then((echarts) => {
    containers.forEach((el) => {
      try {
        echarts.getInstanceByDom(el as HTMLElement)?.dispose();
      } catch {
        // 实例可能已自行销毁，忽略
      }
    });
  });
}

function sweepOrphanCharts(): void {
  if (!pptxOrphanRoot) return;
  sweepPptxCharts(pptxOrphanRoot);
  pptxOrphanRoot = null;
}

function scheduleOrphanSweep(): void {
  window.clearTimeout(idleReleaseTimer);
  idleReleaseTimer = window.setTimeout(() => {
    idleReleaseTimer = undefined;
    sweepOrphanCharts();
  }, IDLE_RELEASE_MS);
}

export default function FilePreview({ vault, path, onClose, embedded = false, escClose = true, onActivate, reloadSignal = 0, onPdfToc }: Props) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const kind = fileKindOf(name);
  // 缩放记忆键（0.38.7）：切走再切回按此恢复缩放
  const zoomKey = `${vault}/${path}`;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** docx 的 HTML 结果；xlsx 走结构化行数据（0.39 列筛选）；PDF 走懒渲染画布，图片走 asset URL。 */
  const [html, setHtml] = useState<string | null>(null);
  const [sheets, setSheets] = useState<ParsedSheet[] | null>(null);
  /** 编辑队列（0.39.19）：每次保存都是「读盘 → 改 zip → 原子写」的读改写，
   *  两次编辑并发落盘会互相覆盖——串成一条链，后一次一定在前一次写完之后读盘。 */
  const sheetEditQueueRef = useRef<Promise<void>>(Promise.resolve());
  /** 当前预览的「仓库::路径」快照：保存期间切换文件时丢弃过期的回写。
   *  渲染期同步更新——effect 要等提交后，切文件瞬间的在途保存会误判成同一文件。 */
  const sheetEditScopeRef = useRef(`${vault}\u0000${path}`);
  const sheetEditScopeNow = `${vault}\u0000${path}`;
  if (sheetEditScopeRef.current !== sheetEditScopeNow) {
    sheetEditScopeRef.current = sheetEditScopeNow;
  }

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  /** 图片预览的 OCR（0.39.19 用户反馈「不是全部识别而是识别框定的范围内的
   *  内容」）：frameMode=框选态（十字光标拖一个框）；frameRect=拖动中的选框
   *  （视口坐标）；imageOcr.text=识别结果（可能是空结果的提示文案）。
   *  0.39.28 用户反馈「AI 识别响应慢，切换标签页后得重新点击」：结果另存
   *  模块级 ocrCache（键 vault::path）——FilePreview 以 activePreview 为 key
   *  条件渲染，切标签即卸载重挂、组件 state 全丢；缓存让切回来还在。 */
  const [imageOcr, setImageOcr] = useState<{ busy: boolean; text: string | null; kind: "ocr" | "ai" } | null>(
    () => ocrCache.get(`${vault}\u0000${path}`) ?? null,
  );
  const [frameMode, setFrameMode] = useState(false);
  const frameModeRef = useRef(false);
  /** 识别结果面板（0.39.31 用户反馈「点击识别内容，滚动鼠标滚轮，滚动的是
   *  图片而不是识别弹窗中的内容」）：面板盖在图片宿主上、自身不滚，滚轮会
   *  冒泡到 body 把图片层滚走。下面用原生非被动监听把面板区域的滚轮截住。 */
  const ocrPanelRef = useRef<HTMLDivElement | null>(null);
  /** 框选/识别的通道（0.39.23：AI 识别与普通识别共用同一套框选交互）。 */
  const frameKindRef = useRef<"ocr" | "ai">("ocr");
  const frameStartRef = useRef<{ x: number; y: number } | null>(null);
  const [frameRect, setFrameRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  /** 关掉识别结果面板 = 同时清掉会话缓存（重新识别才再进缓存）。 */
  const clearImageOcr = useCallback(() => {
    setImageOcr(null);
    ocrCache.delete(`${vault}\u0000${path}`);
  }, [vault, path]);
  /** 图片预览的 OCR（0.39.19）：`region` 传 null = 整图；框选时传视口选框换算
   *  出的自然像素区域。取图片字节走 screenshot_ocr（WinRT，桌面命令，移动端
   *  按钮不渲染）。结果存 imageOcr.text，面板在图片预览 body 里。 */
  const runImageOcr = useCallback(async (region?: PixelRegion | null, kind: "ocr" | "ai" = "ocr") => {
    if (!imageUrl || (imageOcr?.busy ?? false)) return;
    setImageOcr({ busy: true, text: null, kind });
    try {
      const base64 = await cropImageRegionBase64(imageUrl, region ?? null);
      const text =
        kind === "ai"
          ? await aiRecognizeImage(base64)
          : await screenshotOcr(base64);
      const next: NonNullable<typeof imageOcr> = {
        busy: false,
        kind,
        text: text.trim()
          ? text
          : kind === "ai"
            ? "AI 没有返回内容"
            : "没有识别出文字（框内可能没有文本，或系统缺少 OCR 语言包）",
      };
      setImageOcr(next);
      ocrCache.set(`${vault}\u0000${path}`, next);
    } catch (error) {
      const next: NonNullable<typeof imageOcr> = {
        busy: false,
        kind,
        text: `识别失败：${error instanceof Error ? error.message : String(error)}`,
      };
      setImageOcr(next);
      ocrCache.set(`${vault}\u0000${path}`, next);
    }
  }, [imageUrl, imageOcr?.busy, vault, path]);

  // 识别结果面板吞掉滚轮（0.39.31 用户反馈「滚动的是图片，而不是识别弹窗中
  // 的内容」）：面板是图片宿主的绝对定位子节点、自身不产生滚动条，滚轮默认
  // 会链式冒泡到 .file-preview-body 把整张图滚走。这里非被动监听：面板内
  // preventDefault，并手动把增量滚给结果文本框（它才是真正的内容滚动区）。
  useEffect(() => {
    const panel = ocrPanelRef.current;
    if (!panel || imageOcr?.text == null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const area = panel.querySelector<HTMLTextAreaElement>(".file-preview-ocr-text");
      if (!area) return;
      const max = area.scrollHeight - area.clientHeight;
      if (max <= 0) return;
      const step = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaMode === 2 ? event.deltaY * area.clientHeight : event.deltaY;
      area.scrollTop = Math.max(0, Math.min(max, area.scrollTop + step));
    };
    panel.addEventListener("wheel", onWheel, { passive: false });
    return () => panel.removeEventListener("wheel", onWheel);
  }, [imageOcr?.text]);

  // 框选态的窗口级拖动/收尾（0.39.19 用户反馈「不是全部识别而是识别框定的
  // 范围内的内容」）：mousemove 更新选框，mouseup 把视口选框换算成图片自然
  // 像素区域送 OCR；Esc 先退框选（拦在 FilePreview 的 window Esc 之前）
  useEffect(() => {
    frameModeRef.current = frameMode;
    if (!frameMode) return;
    const onMove = (event: MouseEvent) => {
      const start = frameStartRef.current;
      if (!start) return;
      setFrameRect({
        x: Math.min(start.x, event.clientX),
        y: Math.min(start.y, event.clientY),
        w: Math.abs(event.clientX - start.x),
        h: Math.abs(event.clientY - start.y),
      });
    };
    const onUp = (event: MouseEvent) => {
      const start = frameStartRef.current;
      frameStartRef.current = null;
      setFrameRect(null);
      setFrameMode(false);
      if (!start) return;
      const drag = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      const img = imageHostRef.current?.querySelector("img");
      const region =
        img && drag >= SELECTION_MIN_DRAG
          ? selectionToRegion(img, start.x, start.y, event.clientX, event.clientY)
          : null;
      void runImageOcr(region, frameKindRef.current);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        frameStartRef.current = null;
        setFrameRect(null);
        setFrameMode(false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [frameMode, runImageOcr]);

  const handleSheetEdit = useCallback(
    (sheetName: string, rowIndex: number, col: number, value: string): Promise<void> => {
      const scope = `${vault}\u0000${path}`;
      const run = async () => {
        const target = sheets?.find((sheet) => sheet.name === sheetName);
        if (!target) throw new Error("找不到目标工作表");
        // calamine 的解析窗口起点可能不是 A1：渲染层相对下标 → 绝对坐标
        const absRow = (target.startRow ?? 0) + rowIndex;
        const absCol = (target.startCol ?? 0) + col;
        const { editXlsxCell } = await import("../lib/xlsxWorkerHost");
        const result = await editXlsxCell(vault, path, sheetName, absRow, absCol, value);
        if (sheetEditScopeRef.current !== scope) return;
        // Rust 侧已用同一套解析链校验过并给出显示值——原地更新这一格即可；
        // watcher 的 reloadSignal 之后会静默重读，把表头识别/合并等顺带对齐
        setSheets((prev) =>
          (prev ?? []).map((sheet) =>
            sheet.name !== sheetName
              ? sheet
              : {
                  ...sheet,
                  rows: sheet.rows.map((line, r) =>
                    r !== rowIndex
                      ? line
                      : line.map((cell, c) => (c === col ? result.display : cell)),
                  ),
                },
          ),
        );
      };
      const next = sheetEditQueueRef.current.then(run, run);
      sheetEditQueueRef.current = next.catch(() => {});
      return next;
    },
    [vault, path, sheets],
  );
  /** 0.38.3 SVG 预览改 DOM 内联（消毒后）：`<img>` 展示 svg 时浏览器按固有
      尺寸光栅再降采样，窄面板下文字糊（用户反馈「mermaid 导出文件全屏清晰、
      响应式布局下模糊」）；内联矢量随容器重排，任何宽度都锐利。 */
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  /** 桌面 HTML 缩放倍率的显示值（0.39.17 浮动菜单百分比；实际值在 htmlZoomRef）。 */
  const [htmlZoomNow, setHtmlZoomNow] = useState(1);
  /** HTML 缩放模式（0.39.22 用户反馈「优化一下预览文件的响应式布局」）：
   *  默认**适应宽度**（同 PDF 的 fit 口径；内容比面板宽时等比缩小，面板变宽窄
   *  自动重算）；Ctrl+滚轮手动缩放后退出，切文件按缩放记忆恢复。 */
  const htmlFitRef = useRef(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const docxHostRef = useRef<HTMLDivElement | null>(null);
  const pdfHostRef = useRef<HTMLDivElement | null>(null);
  /** 组件根：PDF 的 Ctrl+滚轮缩放绑在这里（0.35.3 嵌入化后绑 pdfHost 会出现
      命中层差异，绑根对浮层/嵌入两种形态都稳定）。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const taskRef = useRef<import("pdfjs-dist").PDFDocumentLoadingTask | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const renderedRef = useRef<Set<number>>(new Set());
  /** 在途的页面渲染任务：滚离/重渲时取消，避免白耗 CPU 与双倍画布内存。 */
  const renderTasksRef = useRef<Map<number, import("pdfjs-dist").RenderTask>>(new Map());
  /** 在途的文字层（与画布同生命周期，一起取消）。 */
  const textLayersRef = useRef<Map<number, import("pdfjs-dist").TextLayer>>(new Map());
  /** PDF 缩放："fit" = 适应宽度（自动），数字 = 用户手动缩放倍率。 */
  const [pdfZoom, setPdfZoom] = useState<"fit" | number>(() => zoomMemoOf(`${vault}/${path}`).zoom ?? "fit");
  const pdfZoomRef = useRef<"fit" | number>("fit");
  useEffect(() => {
    pdfZoomRef.current = pdfZoom;
    // 缩放记忆写入（0.38.7）：fit 记 undefined
    zoomMemoOf(`${vault}/${path}`).zoom = pdfZoom === "fit" ? undefined : pdfZoom;
  }, [pdfZoom, vault, path]);
  const pptxRef = useRef<import("pptx-preview").PPTXPreviewer | null>(null);
  const pptxHostRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(1);
  /** PDF 捏合手势的目标倍率（touchmove 累计、touchend 落地，见 0.38 捏合 effect）。 */
  const pinchZoomRef = useRef<number | null>(null);
  /** HTML 覆盖层手势状态（0.38.3 重做：单指=滚动 body 平移，双指=CSS zoom
      缩放，轻点=切标题条；「横滑开抽屉」已按用户要求移除——预览内的滑动
      属于内容，App 手势守卫也加了 .file-preview 排除）。 */
  const htmlFrameRef = useRef<HTMLIFrameElement | null>(null);
  const htmlContentSizeRef = useRef<{ w: number; h: number } | null>(null);
  const htmlZoomRef = useRef(1);
  const htmlLastRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const htmlPinchRef = useRef(0);
  // 盖层上的拖动/捏合不算「点击内容」：轻点判定在 touchend 自己做
  //（0.38.8：部分 WebView 对 preventDefault 过 touchmove 的元素不合成 click）
  const htmlTapMovedRef = useRef(false);
  const htmlTapAtRef = useRef(0);
  const htmlPinchZoomRef = useRef(0);
  const pdfRelayoutRef = useRef<() => void>(() => {});
  /** PDF 缩放的实际执行器（渲染 effect 内部赋值）：按 fit 或指定倍率重建页位。 */
  const pdfZoomApplyRef = useRef<(explicit?: number) => void>(() => {});
  /** 缩放重建的防抖定时器（0.38.10：手势全程不再触发重渲）。 */
  const zoomRenderTimerRef = useRef<number | undefined>(undefined);
  const pptxRelayoutRef = useRef<() => void>(() => {});
  const pptxRelayoutTokenRef = useRef(0);
  const pptxBytesRef = useRef<ArrayBuffer | null>(null);
  const pptxWidthRef = useRef(0);
  /** 最近一次 pptx 渲染容器：关闭时还来不及清理的图表实例从这里兜底回收。 */
  const orphanSourceRef = useRef<HTMLElement | null>(null);

  // Esc 关闭预览。0.39.8 用户反馈「使用 esc 关闭弹窗时，也会关闭一个选中的
  // 预览文件」：这是浮层时代的遗留——预览改标签页后，快速笔记/收录弹窗等任何
  // 弹层的 Esc（局部 preventDefault 后事件仍冒泡到 window）都会连带关掉预览
  // 标签。现在两层门：①事件已被局部处理器消费（defaultPrevented）就不抢；
  // ②App 侧有浮层/菜单开着时传 escClose=false 整体让位。无浮层时保留
  // 「Esc 关预览」的原有便捷。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!escClose) return;
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, escClose]);

  // ---------------------------------------------------------------- 移动端全屏预览（0.38 用户反馈）
  // 0.38.5 用户反馈（推翻 0.38.3 的「预览期收走药丸」）：**预览期药丸/底条常驻**
  // ——底条 [N] 标签页是快速切换文件的入口（预览文件也以标签页形式在册）；
  // 移动端所有 kind 一律无标题浮条（PDF 也不再显示，缩放靠捏合、关闭靠系统
  // 返回手势），只有桌面非嵌入态保留标题条。
  // 0.38.7 用户反馈「点击预览文件内容时药丸可以隐藏，再次点击取消」：点击
  // 内容派发 toggle（App 挂 .qn-preview-chrome-off 收走药丸/底条），再点恢复。
  const mobile = isMobile();
  useEffect(() => {
    if (!mobile) return;
    // 卸载时复位：预览关掉后药丸必须回来（类不能残留到非预览态）
    return () => {
      window.dispatchEvent(new CustomEvent("qn-preview-chrome", { detail: false }));
    };
  }, [mobile]);

  // -------------------------------------------------- HTML 预览适配（0.38.3 移动端引入；0.39.17 桌面同款）
  // 按 zoom 重建 iframe 布局：缩放走 CSS zoom（内容随 zoom 重排，文字始终锐利
  // ——transform:scale 是位图拉伸，正文会糊）。宽度恒铺满 body 视口，高度=内容
  // 自然高——iframe 内部**永不出现滚动条**，平移全部由 body 的原生滚动承担。
  // 0.39.17 用户反馈「html 也要实现类似缩放；为什么有两个滚轮」：桌面此前是
  // iframe 100%×100% 内部滚动（iframe 内一条 + body 因 padding 溢出又一条），
  // 现在桌面与移动端同一架构：量内容自然尺寸 → JS 写 iframe 宽高，body 独享滚动，
  // 缩放=CSS zoom + 中心锚定。
  const applyHtmlLayout = useCallback(() => {
    const frame = htmlFrameRef.current;
    const body = bodyRef.current;
    const size = htmlContentSizeRef.current;
    if (!frame || !body || !size) return;
    const viewW = Math.max(1, body.clientWidth - 28); // body 左右 padding 14×2
    // fit：内容比面板宽就等比缩到恰好铺满（不小于 0.4 防不可读），否则保持 100%
    const z = htmlFitRef.current
      ? Math.min(1, Math.max(0.4, viewW / Math.max(size.w, 1)))
      : htmlZoomRef.current;
    htmlZoomRef.current = z;
    setHtmlZoomNow(z);
    frame.style.zoom = String(z);
    frame.style.width = `${Math.max(size.w, viewW / z)}px`;
    frame.style.height = `${size.h}px`;
  }, []);

  // 0.39.22：换文件按缩放记忆恢复 fit/手动模式
  useEffect(() => {
    if (kind !== "html") return;
    const saved = zoomMemoOf(`${vault}/${path}`).zoom;
    htmlFitRef.current = saved === undefined;
    htmlZoomRef.current = saved ?? 1;
    setHtmlZoomNow(saved ?? 1);
  }, [kind, vault, path]);

  // 0.39.22 响应式：面板宽度变化时，fit 模式重算缩放（手动模式不动，
  // 让用户自己的倍率保持稳定）
  useEffect(() => {
    if (kind !== "html") return;
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => {
      if (htmlFitRef.current) applyHtmlLayout();
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, [kind, html, applyHtmlLayout]);

  /** 桌面 HTML 缩放（0.39.17）：CSS zoom + 中心锚定，倍率记进预览缩放记忆。 */
  const changeHtmlZoom = useCallback(
    (next: number) => {
      const frame = htmlFrameRef.current;
      const body = bodyRef.current;
      if (!frame) return;
      const prev = htmlZoomRef.current;
      const clamped = Math.min(3, Math.max(0.4, Math.round(next * 20) / 20));
      if (clamped === prev) return;
      const anchorLeft = body ? body.scrollLeft + body.clientWidth / 2 : 0;
      const anchorTop = body ? body.scrollTop + body.clientHeight / 2 : 0;
      htmlZoomRef.current = clamped;
      // 手动缩放 = 退出「适应宽度」；记忆里的倍率按文件恢复
      htmlFitRef.current = false;
      zoomMemoOf(zoomKey).zoom = clamped;
      setHtmlZoomNow(clamped);
      applyHtmlLayout();
      if (body) {
        const ratio = clamped / prev;
        body.scrollLeft = Math.max(0, anchorLeft * ratio - body.clientWidth / 2);
        body.scrollTop = Math.max(0, anchorTop * ratio - body.clientHeight / 2);
      }
    },
    [applyHtmlLayout, zoomKey],
  );

  /** 量内容自然尺寸（sandbox 带 allow-same-origin 才可读；脚本仍被禁）。
      0.39.17 起桌面也走这套（body 独享滚动 + JS 布局），不再只限移动端。
      顺带在 iframe **文档内**挂 wheel 转发：iframe 是独立文档，父层的 wheel
      监听收不到它内部的事件——同源才能从父侧把滚轮转给 body（Ctrl=缩放，
      普通滚轮=body 滚动），iframe 内部不滚动也就没有了第二条滚动条。 */
  const measureHtml = useCallback(() => {
    const frame = htmlFrameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.documentElement) return;
    const w = Math.max(
      doc.documentElement.scrollWidth,
      doc.body?.scrollWidth ?? 0,
      1,
    );
    const h = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0,
      1,
    );
    htmlContentSizeRef.current = { w, h };
    applyHtmlLayout();
    doc.documentElement.addEventListener("wheel", (event: WheelEvent) => {
      const body = bodyRef.current;
      if (event.ctrlKey && event.deltaY !== 0) {
        event.preventDefault();
        changeHtmlZoom(htmlZoomRef.current + (event.deltaY < 0 ? 0.1 : -0.1));
        return;
      }
      if (!body) return;
      const line = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? body.clientHeight : 1;
      body.scrollTop += event.deltaY * line;
      body.scrollLeft += event.deltaX * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? body.clientWidth : 1);
    }, { passive: false });
    // 0.39.18 用户反馈「聚焦到 html 文件时，最近文件/语句库/速记管理/快速笔记
    // 弹窗失效」：iframe 是独立文档，父窗口的全局快捷键分发器收不到它内部的
    // keydown——克隆一份转发到父 window（分发器不检查 isTrusted/target）。
    // iframe 文档里的表单控件（导出页面可能带 input）自己不转发，避免打断输入。
    doc.documentElement.addEventListener("keydown", (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
        return;
      }
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          location: event.location,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // 点在 iframe 内容上时父层收不到 mousedown：补一次聚焦上报（窗格跟踪/目录
    // 跟随与「预览上的 mousedown 上报聚焦」同口径）
    doc.documentElement.addEventListener("mousedown", () => onActivate?.());
    // 字体/图片晚于 load 到位会改变高度，补一次迟到的复测（组件卸载后 ref
    // 为空，回调体自然早退）
    window.setTimeout(() => {
      const doc2 = htmlFrameRef.current?.contentDocument;
      if (!doc2?.documentElement || !htmlContentSizeRef.current) return;
      const w2 = Math.max(doc2.documentElement.scrollWidth, doc2.body?.scrollWidth ?? 0, 1);
      const h2 = Math.max(doc2.documentElement.scrollHeight, doc2.body?.scrollHeight ?? 0, 1);
      if (w2 !== htmlContentSizeRef.current.w || h2 !== htmlContentSizeRef.current.h) {
        htmlContentSizeRef.current = { w: w2, h: h2 };
        applyHtmlLayout();
      }
    }, 400);
  }, [applyHtmlLayout, changeHtmlZoom, onActivate]);

  // ---------------------------------------------------------------- 图片预览：拖动 + 滚轮缩放
  // 按住左键拖动移动、滚轮缩放（以指针为锚）、双击重置。与 mermaid 灯箱同一套手感。
  const imageHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (kind !== "image") return;
    const host = imageHostRef.current;
    if (!host) return;
    // SVG 内联预览（0.38.3）与位图 img 共用同一套拖动/捏合手势；
    // SVGElement 无 HTMLElement 事件表，按 HTMLElement 用（只加监听/写 style）
    const img = host.querySelector("img, svg") as HTMLElement | null;
    if (!img) return;

    // 0.38.7 缩放记忆：恢复上次的缩放与平移
    const zoomMemo = zoomMemoOf(zoomKey);
    let scale = zoomMemo.imgScale ?? 1;
    let x = zoomMemo.imgX ?? 0;
    let y = zoomMemo.imgY ?? 0;
    const apply = () => {
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      zoomMemo.imgScale = scale;
      zoomMemo.imgX = x;
      zoomMemo.imgY = y;
    };
    // 有历史状态挂载即落地（无记忆保持 CSS 适应尺寸的初始态）
    if (zoomMemo.imgScale !== undefined) apply();

    const onWheel = (event: WheelEvent) => {
      if (frameModeRef.current) return; // 框选态不缩放（按下是框选起点）
      event.preventDefault();
      const hostRect = host.getBoundingClientRect();
      const next = Math.min(8, Math.max(0.1, scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (next === scale) return;
      // 以指针为锚缩放（指针坐标转成 host 中心坐标系）
      const cx = event.clientX - hostRect.left - hostRect.width / 2;
      const cy = event.clientY - hostRect.top - hostRect.height / 2;
      const dx = cx - x;
      const dy = cy - y;
      const ratio = next / scale;
      x += dx * (1 - ratio);
      y += dy * (1 - ratio);
      scale = next;
      apply();
    };

    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (event: MouseEvent) => {
      if (frameModeRef.current) return; // 框选态不平移
      if (event.button !== 0) return;
      dragging = true;
      moved = false;
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const onMove = (event: MouseEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      x += dx;
      y += dy;
      lastX = event.clientX;
      lastY = event.clientY;
      apply();
    };
    const onUp = () => {
      dragging = false;
    };
    const onDbl = () => {
      scale = 1;
      x = 0;
      y = 0;
      apply();
    };

    img.addEventListener("wheel", onWheel, { passive: false });
    img.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    img.addEventListener("dblclick", onDbl);

    // 0.38 用户反馈「预览图片无手动滑动进行放大或者缩小」：移动端触摸——单指
    // 平移（与桌面拖动同一 x/y），双指捏合缩放（以两指中点为锚，与滚轮同一套
    // 锚点公式）。0.34.10 灯箱踩过的坑：缩放元素在 flex 容器必须 flex:none，
    // 这里 img 的宿主 .file-preview-image 自身 flex:none 不受影响。
    let touchDist = 0;
    let touchX = 0;
    let touchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        touchX = event.touches[0].clientX;
        touchY = event.touches[0].clientY;
      } else if (event.touches.length === 2) {
        const [a, b] = [event.touches[0], event.touches[1]];
        touchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        touchX = (a.clientX + b.clientX) / 2;
        touchY = (a.clientY + b.clientY) / 2;
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      event.preventDefault();
      if (event.touches.length === 1 && touchDist === 0) {
        const nx = event.touches[0].clientX;
        const ny = event.touches[0].clientY;
        x += nx - touchX;
        y += ny - touchY;
        touchX = nx;
        touchY = ny;
        apply();
        return;
      }
      if (event.touches.length === 2) {
        const [a, b] = [event.touches[0], event.touches[1]];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const cx = (a.clientX + b.clientX) / 2;
        const cy = (a.clientY + b.clientY) / 2;
        if (touchDist > 0) {
          const hostRect = host.getBoundingClientRect();
          const next = Math.min(8, Math.max(0.1, (scale * dist) / touchDist));
          const anchorX = cx - hostRect.left - hostRect.width / 2;
          const anchorY = cy - hostRect.top - hostRect.height / 2;
          const ratio = next / scale;
          x += (anchorX - x) * (1 - ratio);
          y += (anchorY - y) * (1 - ratio);
          scale = next;
          apply();
        }
        touchDist = dist;
        touchX = cx;
        touchY = cy;
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        // 0.38.3 用户反馈「手指离开屏幕后图片位置偏移」：双指收起一根转单指，
        // 平移基准必须重置到剩余手指——沿用旧中点坐标一起手就跳一截
        touchX = event.touches[0].clientX;
        touchY = event.touches[0].clientY;
        touchDist = 0;
        return;
      }
      touchDist = 0;
    };
    img.addEventListener("touchstart", onTouchStart, { passive: true });
    img.addEventListener("touchmove", onTouchMove, { passive: false });
    img.addEventListener("touchend", onTouchEnd);
    img.addEventListener("touchcancel", onTouchEnd);

    return () => {
      img.removeEventListener("wheel", onWheel);
      img.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      img.removeEventListener("dblclick", onDbl);
      img.removeEventListener("touchstart", onTouchStart);
      img.removeEventListener("touchmove", onTouchMove);
      img.removeEventListener("touchend", onTouchEnd);
      img.removeEventListener("touchcancel", onTouchEnd);
    };
    // 0.38.10 用户反馈「mermaid 导出的文件预览时无法缩放」：svg 走内联渲染，
    // svgMarkup 异步到位后才有 <svg> 可绑——deps 必须带上它（此前只盯
    // imageUrl，SVG 预览的手势从未绑定过）
  }, [kind, imageUrl, svgMarkup]);

  /**
   * 切换 PDF 缩放：fit 走适应宽度，数字为手动倍率（PDF_ZOOM_MIN–MAX，
   * 防画布爆内存）。0.28：到上限时值保持不变——此前 300% 再点放大仍把
   * 状态往上夹、比例数字看着涨，但页面宽度被 CSS max-width 卡住，观感没变
   * （用户反馈）。
   */
  const changePdfZoom = useCallback((next: "fit" | number) => {
    const clamped =
      next === "fit"
        ? "fit"
        : Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, Math.round(next * 20) / 20));
    if (clamped !== "fit" && clamped === pdfZoomRef.current) return;
    setPdfZoom(clamped);
    pdfZoomRef.current = clamped;
    pdfZoomApplyRef.current?.(clamped === "fit" ? undefined : clamped);
  }, []);

  // Ctrl + 滚轮缩放 PDF / HTML（0.28 用户反馈；0.39.17 HTML 同款）。只拦
  // Ctrl+wheel：普通滚轮留给纵向翻页；listener 必须非 passive，否则
  // preventDefault 无效、页面会缩放。绑在组件根（冒泡覆盖画布/文本层一切
  // 子元素），不绑 pdfHost——嵌入化后 host 的命中层会随布局形态漂（0.35.3）。
  useEffect(() => {
    if (kind !== "pdf" && kind !== "html") return;
    const host = rootRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? 0.1 : -0.1;
      if (kind === "pdf") {
        const current = pdfZoomRef.current === "fit" ? scaleRef.current : pdfZoomRef.current;
        changePdfZoom(current + step);
      } else {
        changeHtmlZoom(htmlZoomRef.current + step);
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [kind, changePdfZoom, changeHtmlZoom]);

  // PDF 双指捏合缩放（0.38 用户反馈「预览 pdf 无手动滑动进行放大或者缩小」）：
  // 以两指张合比例累计目标倍率，手势结束时一次性 changePdfZoom——捏合过程中
  // 每档都重建 canvas 会卡成幻灯片；松手重渲一次，代价可接受。
  useEffect(() => {
    if (kind !== "pdf") return;
    const host = rootRef.current;
    if (!host) return;
    let baseDist = 0;
    let baseZoom = 1;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const [a, b] = [event.touches[0], event.touches[1]];
      baseDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      baseZoom = pdfZoomRef.current === "fit" ? scaleRef.current : pdfZoomRef.current;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || baseDist <= 0) return;
      event.preventDefault();
      const [a, b] = [event.touches[0], event.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinchZoomRef.current = (baseZoom * dist) / baseDist;
    };
    const onTouchEnd = () => {
      if (baseDist > 0 && pinchZoomRef.current !== null) {
        const target = pinchZoomRef.current;
        const prev = pdfZoomRef.current === "fit" ? scaleRef.current : pdfZoomRef.current;
        changePdfZoom(target);
        // 0.38.7 捏合锚定：内容按倍率放大，滚动位置同比缩放——捏合中心的内容
        // 点不漂移（此前缩放后视口跳到别处，观感也是「卡」）
        const clamped = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, Math.round(target * 20) / 20));
        const body = bodyRef.current;
        if (body && prev > 0 && clamped !== prev) {
          const ratio = clamped / prev;
          body.scrollTop *= ratio;
          body.scrollLeft *= ratio;
        }
        pinchZoomRef.current = null;
      }
      baseDist = 0;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd);
    host.addEventListener("touchcancel", onTouchEnd);
    return () => {
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [kind, changePdfZoom]);

  // Word 预览双指捏合缩放（0.38.4 用户反馈「word 文件无法缩放」）：口径同 PDF
  // 捏合——过程中累计目标倍率、松手一次性落地。docx 是纯 HTML（无 canvas 重建
  // 成本），直接写宿主 CSS zoom：内容按 zoom 真重排文字锐利（transform:scale
  // 是位图拉伸）；缩放后的平移由 body 原生滚动承担（含横向溢出）。
  const docxZoomRef = useRef(1);
  useEffect(() => {
    if (kind !== "docx" || !mobile) return;
    const host = docxHostRef.current;
    if (!host) return;
    // 0.38.7 缩放记忆：恢复上次缩放
    docxZoomRef.current = zoomMemoOf(zoomKey).zoom ?? 1;
    host.style.zoom = String(docxZoomRef.current);
    let baseDist = 0;
    let baseZoom = 1;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const [a, b] = [event.touches[0], event.touches[1]];
      baseDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      baseZoom = docxZoomRef.current;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || baseDist <= 0) return;
      event.preventDefault();
      const [a, b] = [event.touches[0], event.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      docxZoomRef.current = Math.min(4, Math.max(0.5, (baseZoom * dist) / baseDist));
    };
    const onTouchEnd = () => {
      if (baseDist > 0) {
        host.style.zoom = String(docxZoomRef.current);
        zoomMemoOf(zoomKey).zoom = docxZoomRef.current;
      }
      baseDist = 0;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd);
    host.addEventListener("touchcancel", onTouchEnd);
    return () => {
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
      host.style.zoom = "";
    };
  }, [kind, mobile]);

  // 视窗尺寸变化：PDF 换缩放重渲可见页、pptx 按新宽度重建（统一防抖 250ms）
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        pdfRelayoutRef.current();
        pptxRelayoutRef.current();
      }, 250);
    });
    ro.observe(body);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  // reloadSignal 重读的「静默化」（0.39.17）：同一文件的重跑不再清空内容 +
  // 闪「正在加载」——手机端用户实锤「不断刷新、正在加载一闪而过」（App 已在
  // 手机端不传 reloadSignal；这里再兜一层：桌面端 watcher 对同一文件的多串
  // 事件重读时，缓存命中（同一引用）React 直接跳过渲染，一帧都不闪；
  // 内容真变了才原地换内容）。只有 spreadsheet 走静默通道——pdf/docx/html
  // 的重渲本来就要重建宿主内容。
  const lastLoadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const loadKey = `${vault}::${path}`;
    const silentReload =
      kind === "spreadsheet" && lastLoadKeyRef.current === loadKey && reloadSignal !== 0;
    lastLoadKeyRef.current = loadKey;
    if (!silentReload) {
      setLoading(true);
      setSheets(null);
    }
    setError(null);
    setHtml(null);
    setImageUrl(null);
    setImageOcr(null);
    setFrameMode(false);
    frameStartRef.current = null;
    setFrameRect(null);
    setSvgMarkup(null);
    // 0.38.7 缩放记忆：切回时恢复上次缩放（load 后 measure→apply 落地）
    htmlZoomRef.current = zoomMemoOf(zoomKey).zoom ?? 1;
    setHtmlZoomNow(htmlZoomRef.current);
    htmlContentSizeRef.current = null;
    htmlPinchRef.current = 0;
    docxZoomRef.current = 1;
    renderedRef.current.clear();
    pdfRelayoutRef.current = () => {};
    pptxRelayoutRef.current = () => {};
    // 上一次预览关闭时来不及清理的图表孤儿，现在一定可以安全回收了
    sweepOrphanCharts();

    // 释放 PDF 文档与其占用的渲染内存（切换/关闭/StrictMode 二次挂载都走这里）
    const releasePdf = () => {
      window.clearTimeout(zoomRenderTimerRef.current);
      observerRef.current?.disconnect();
      observerRef.current = null;
      for (const task of renderTasksRef.current.values()) task.cancel();
      renderTasksRef.current.clear();
      for (const layer of textLayersRef.current.values()) layer.cancel();
      textLayersRef.current.clear();
      void taskRef.current?.destroy();
      taskRef.current = null;
      docRef.current = null;
    };
    // pptx-preview 的 destroy 只解绑全局监听，wrapper DOM 由下一次渲染或卸载清理
    const releasePptx = () => {
      pptxRelayoutTokenRef.current += 1; // 作废在途的尺寸重建
      pptxRef.current?.destroy();
      pptxRef.current = null;
      pptxBytesRef.current = null;
      // 图表实例不 dispose 会一直驻留在 echarts 注册表里（DOM 摘除不会自动回收）；
      // 卸载场景下 host 已被 React 摘走，这里的扫描落空没关系，孤儿兜底会接手
      sweepPptxCharts(pptxHostRef.current);
      orphanSourceRef.current = null;
    };
    releasePdf();
    releasePptx();

    void (async () => {
      try {
        if (kind === "image") {
          const abs = `${vault.replace(/[\\/]+$/, "")}/${path}`;
          const url = convertFileSrc(abs);
          if (/\.svg$/i.test(name)) {
            // 0.38.3：svg 走 DOM 内联（消毒后）——矢量随容器重排，任何宽度锐利；
            // 读不到文本再退回 <img> 老路
            try {
              const text = await fetch(url).then((r) => r.text());
              if (!cancelled) {
                setSvgMarkup(
                  DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true } }),
                );
              }
            } catch {
              if (!cancelled) setImageUrl(url);
            }
          } else {
            setImageUrl(url);
          }
          setLoading(false);
          return;
        }

        if (kind === "html") {
          const note = await readNote(vault, path);
          if (cancelled) return;
          // sandbox 空串 = 禁脚本禁表单：预览第三方/导出的 HTML 时不执行其中代码。
          // FORCE_BODY 必须开：很多导出 HTML 以 <style> 开头（没有 <html> 外壳），
          // 解析器会把它挪进 <head>，DOMPurify 默认只遍历 body——样式整体丢失，
          // 预览只剩一堆无样式的裸文本。
          setHtml(
            DOMPurify.sanitize(note.content, {
              USE_PROFILES: { html: true },
              FORCE_BODY: true,
            }),
          );
          setLoading(false);
          return;
        }

        if (kind === "spreadsheet") {
          // 0.39.9 Rust（calamine）直读解析优先：Rust 自己读盘，read_binary 的
          // base64 IPC、atob、SheetJS Worker 三段全省；打不开（加密/损坏/老
          // 版式）回退下面的 SheetJS Worker 路径
          try {
            const { parseXlsxNative } = await import("../lib/xlsxWorkerHost");
            const parsed = await parseXlsxNative(vault, path);
            if (cancelled) return;
            setSheets(parsed);
            setLoading(false);
            return;
          } catch {
            // 回退，不提示——native 只是快路径，不是唯一路径
          }
        }

        const data = await readBinary(vault, path);
        const bytes = base64ToBytes(data.base64);

        if (kind === "pdf") {
          const pdfjs = await import("pdfjs-dist");
          const { TextLayer } = await import("pdfjs-dist");
          const worker = await acquirePdfWorker(pdfjs);
          const task = pdfjs.getDocument({ data: bytes, worker });
          taskRef.current = task;
          const doc = await task.promise;
          if (cancelled) {
            // 销毁**自己这一次**的加载任务：taskRef 可能已被后一次挂载覆盖，
            // 销毁它会把别人的加载打断（表现为切换后永远卡在加载）
            void task.destroy();
            if (taskRef.current === task) taskRef.current = null;
            return;
          }
          // 已被更新的挂载取代时才让位（首次挂载 docRef 为 null，必须继续）
          if (docRef.current && docRef.current !== doc) return;
          docRef.current = doc;

          const host = pdfHostRef.current;
          if (!host) return;
          const first = await doc.getPage(1);
          const base = first.getViewport({ scale: 1 });
          const fitScale = () =>
            Math.min(1.2, Math.max(0.4, (host.clientWidth - 24) / base.width));
          const scale = pdfZoomRef.current === "fit" ? fitScale() : pdfZoomRef.current;
          scaleRef.current = scale;
          const pageHeight = Math.round(base.height * scale);
          const pageWidth = Math.round(base.width * scale);

          // 全部页先给占位（保持高度让滚动条稳定），进入视口才真正渲染。
          // 高度交给 aspect-ratio：占位被 max-width:100% 压缩时高度跟随宽度
          // 等比缩小，窄视窗下整页可见而不是被裁掉
          host.replaceChildren();
          host.classList.toggle("is-manual", pdfZoomRef.current !== "fit");
          for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
            const placeholder = document.createElement("div");
            placeholder.className = "file-preview-pdf-page is-placeholder";
            placeholder.dataset.page = String(pageNumber);
            placeholder.style.width = `${pageWidth}px`;
            placeholder.style.aspectRatio = `${base.width} / ${base.height}`;
            host.appendChild(placeholder);
          }

          /**
           * 渲染一页：画布 + 文字选择层。
           *
           * 文字层（pdfjs TextLayer）把 PDF 里的文字以透明 span 铺在画布上——
           * 这样代码/正文都能选中复制（用户在 IDE 导出的 PDF 里看到的"复制按钮"
           * 是烤进 PDF 的位图，点不了；真正可行的复制路径就是选中文字）。
           *
           * 0.38.7 用户反馈「缩放 pdf 会卡顿」两处改造：
           * ①渲染**排队串行**（enqueueRender→renderChain）：此前缩放后视口内
           *   所有页并发渲染，几张大画布同时上主线程直接卡死；排队后一次只渲
           *   一页，主线程保持响应。
           * ②**旧画布保底换装**：新画布离屏渲染、完成后才整槽替换——重渲期间
           *   旧位图拉伸显示当即时预览，不再整屏白等。代际号（renderGen）作废
           *   机制：缩放/滚离时 bump，过期的排队与在途渲染在各检查点自行放弃。
           */
          let renderChain: Promise<void> = Promise.resolve();
          const zoomRenderTimer = zoomRenderTimerRef;
          const renderGen = new Map<number, number>();
          const visibleRef = new Set<number>();
          const renderPage = async (pageNumber: number, slot: HTMLElement) => {
            const docCurrent = docRef.current;
            if (!docCurrent || cancelled) {
              renderedRef.current.delete(pageNumber);
              return;
            }
            // 排队期间已滚离视口：放弃本次渲染（标记清掉允许再入队）
            if (!visibleRef.has(pageNumber)) {
              renderedRef.current.delete(pageNumber);
              return;
            }
            const gen = renderGen.get(pageNumber) ?? 0;
            // 读后即落表：首次渲染 map 无条目，gate 的 get() 若仍 undefined 会
            // 与哨兵 0 恒不等——首渲永远被自己拒绝（0.38.7 探针实锤）
            renderGen.set(pageNumber, gen);
            try {
              const pdfPage = await docCurrent.getPage(pageNumber);
              if (
                cancelled ||
                docRef.current !== docCurrent ||
                !visibleRef.has(pageNumber) ||
                (renderGen.get(pageNumber) ?? 0) !== gen
              ) {
                return;
              }
              const viewport = pdfPage.getViewport({ scale: scaleRef.current });
              const canvas = document.createElement("canvas");
              // 按设备像素比出图（0.28「适应大小有点模糊」）：此前画布只按 CSS
              // 像素渲染，在 125%/150% 缩放的屏上被浏览器再放大一次，文字发虚。
              // 只提高**可见页**的位图分辨率，滚动离屏照样释放；再用像素预算
              // 兜住高倍缩放（A4 3× + dpr2 会到 17M 像素/页）。
              const cssW = Math.max(1, viewport.width);
              const cssH = Math.max(1, viewport.height);
              const dpr = Math.max(
                // 超大页在高倍缩放时允许降到 1 以下：宁可让浏览器放大一点，
                // 也不让单页画布把内存吃穿（预算优先于清晰度）
                0.5,
                Math.min(
                  window.devicePixelRatio || 1,
                  2,
                  Math.sqrt(PDF_CANVAS_PIXEL_BUDGET / (cssW * cssH)),
                ),
              );
              canvas.width = Math.round(cssW * dpr);
              canvas.height = Math.round(cssH * dpr);
              canvas.style.width = "100%";
              canvas.style.height = "100%";
              const textDiv = document.createElement("div");
              textDiv.className = "qn-pdf-text";
              // pdfjs 的文字层 CSS 用 --total-scale-factor 计算字号与位移
              textDiv.style.setProperty("--total-scale-factor", String(viewport.scale));
              const renderTask = pdfPage.render({
                canvas,
                viewport,
                ...(dpr > 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}),
              });
              renderTasksRef.current.set(pageNumber, renderTask);
              const textLayer = new TextLayer({
                textContentSource: pdfPage.streamTextContent({ includeMarkedContent: true }),
                container: textDiv,
                viewport,
              });
              textLayersRef.current.set(pageNumber, textLayer);
              await Promise.all([renderTask.promise, textLayer.render()]);
              // 渲染期间被新缩放/滚离/销毁取代：丢弃新产物（槽里旧画布继续显示）
              if (
                cancelled ||
                docRef.current !== docCurrent ||
                !visibleRef.has(pageNumber) ||
                (renderGen.get(pageNumber) ?? 0) !== gen
              ) {
                canvas.width = 0;
                canvas.height = 0;
                canvas.remove();
                textDiv.remove();
                return;
              }
              // 转正：清隐藏样式并整槽换装（旧画布/旧文字层随之移除）
              canvas.style.position = "";
              canvas.style.visibility = "";
              textDiv.style.position = "";
              textDiv.style.visibility = "";
              slot.replaceChildren(canvas, textDiv);
            } catch {
              // 页面渲染被销毁/取消打断：清掉标记允许 observer 稍后重试
              //（gen 已变时由作废方负责清理，不越权）
              if (renderGen.get(pageNumber) === gen) renderedRef.current.delete(pageNumber);
            } finally {
              if (renderGen.get(pageNumber) === gen) {
                renderTasksRef.current.delete(pageNumber);
                textLayersRef.current.delete(pageNumber);
              }
            }
          };
          /** 入渲染队列（串行）；重复入队按标记拦。 */
          const enqueueRender = (pageNumber: number, slot: HTMLElement) => {
            if (renderedRef.current.has(pageNumber)) return;
            renderedRef.current.add(pageNumber);
            renderChain = renderChain.then(() => renderPage(pageNumber, slot)).catch(() => {});
          };

          /** 释放某页的全部渲染产物（画布位图尺寸先清零，立即归还内存）。 */
          const discardPage = (slot: HTMLElement) => {
            const pageNumber = Number((slot as HTMLElement).dataset.page);
            // bump 代际：排队中/在途的渲染一并作废
            renderGen.set(pageNumber, (renderGen.get(pageNumber) ?? 0) + 1);
            renderTasksRef.current.get(pageNumber)?.cancel();
            renderTasksRef.current.delete(pageNumber);
            textLayersRef.current.get(pageNumber)?.cancel();
            textLayersRef.current.delete(pageNumber);
            renderedRef.current.delete(pageNumber);
            visibleRef.delete(pageNumber);
            for (const canvas of slot.querySelectorAll("canvas")) {
              canvas.width = 0;
              canvas.height = 0;
            }
            slot.replaceChildren();
          };

          // 首屏页立即渲染（IntersectionObserver 的首次回调时机在部分驱动下
          // 不保证同步，首页白屏是最影响观感的路径），滚动页交给 observer
          const initial = Math.min(doc.numPages, Math.ceil((host.clientHeight || 900) / pageHeight) + 1);
          for (let pageNumber = 1; pageNumber <= initial; pageNumber += 1) {
            const slot = host.children[pageNumber - 1] as HTMLElement | undefined;
            if (slot) {
              visibleRef.add(pageNumber);
              enqueueRender(pageNumber, slot);
            }
          }

          // 进入视口（前后预渲染 600px）才渲染；离开视口时取消在途任务并释放画布
          const observer = new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const slot = entry.target as HTMLElement;
                const pageNumber = Number(slot.dataset.page);
                if (entry.isIntersecting) {
                  visibleRef.add(pageNumber);
                  enqueueRender(pageNumber, slot);
                } else if (renderedRef.current.has(pageNumber) || visibleRef.has(pageNumber)) {
                  discardPage(slot);
                }
              }
            },
            { root: bodyRef.current, rootMargin: "600px 0px" },
          );
          observerRef.current = observer;
          Array.from(host.children).forEach((child) => observer.observe(child));

          /**
           * 按新的缩放重建全部页位：清画布、改占位宽度，再重新 observe——
           * observer 会立刻回发相交状态，视口内页按新缩放重渲（防抖在外层）。
           * explicit 给出用户手动缩放；省略时按"适应宽度"重算。
           */
          const applyScale = (explicit?: number) => {
            if (cancelled || docRef.current !== doc) return;
            const hostNow = pdfHostRef.current;
            if (!hostNow) return;
            const next = explicit ?? fitScale();
            // 手动缩放时不再把页宽卡在容器宽度内（否则超过适应宽度后数字在涨、
            // 页面不变大——正是用户反馈的现象）；改由外层横向滚动。
            hostNow.classList.toggle("is-manual", explicit !== undefined);
            if (Math.abs(next - scaleRef.current) / scaleRef.current < 0.02) return;
            const prevScale = scaleRef.current;
            scaleRef.current = next;
            const width = Math.round(base.width * next);
            // 中心锚定（0.39.17 用户反馈「ctrl+滚轮缩放时紧挨左侧，不应该居中缩
            // 放吗」）：缩放前后**视口中心**对应的内容点不动——旧左对齐锚会让
            // 内容越缩越往右跑。页间距不随缩放，锚点有亚像素级漂移，可忽略。
            const bodyNow = bodyRef.current;
            const anchorLeft = bodyNow ? bodyNow.scrollLeft + bodyNow.clientWidth / 2 : 0;
            const anchorTop = bodyNow ? bodyNow.scrollTop + bodyNow.clientHeight / 2 : 0;
            // 0.38.10 用户反馈「放大缩小还是很卡顿」：占位宽度**立即**改（旧画布
            // 拉伸显示=即时视觉反馈，零重渲），重建渲染延迟 350ms——连续捏合/
            // 连点只在停顿后按最终倍率重渲一次，长任务不再糊满手势全程
            for (const slot of Array.from(hostNow.children) as HTMLElement[]) {
              slot.style.width = `${width}px`;
            }
            if (bodyNow && prevScale > 0) {
              const ratio = next / prevScale;
              bodyNow.scrollLeft = Math.max(0, anchorLeft * ratio - bodyNow.clientWidth / 2);
              bodyNow.scrollTop = Math.max(0, anchorTop * ratio - bodyNow.clientHeight / 2);
            }
            if (zoomRenderTimer.current !== undefined) window.clearTimeout(zoomRenderTimer.current);
            zoomRenderTimer.current = window.setTimeout(() => {
              zoomRenderTimer.current = undefined;
              if (cancelled || docRef.current !== doc) return;
              const hostLate = pdfHostRef.current;
              if (!hostLate) return;
              for (const slot of Array.from(hostLate.children) as HTMLElement[]) {
                const pageNumber = Number(slot.dataset.page);
                // 旧画布**保留**（拉伸显示当即时预览）；只作废在途/排队的旧
                // 缩放渲染——observer 重发相交后按新缩放排队重渲，完成后整槽换装
                renderGen.set(pageNumber, (renderGen.get(pageNumber) ?? 0) + 1);
                renderTasksRef.current.get(pageNumber)?.cancel();
                renderTasksRef.current.delete(pageNumber);
                textLayersRef.current.get(pageNumber)?.cancel();
                textLayersRef.current.delete(pageNumber);
                renderedRef.current.delete(pageNumber);
              }
              for (const slot of Array.from(hostLate.children)) {
                observer.unobserve(slot);
                observer.observe(slot);
              }
            }, 350);
          };
          // 视窗尺寸变化只在"适应宽度"模式下跟随；手动缩放时保持用户的选择
          pdfRelayoutRef.current = () => {
            if (pdfZoomRef.current !== "fit") return;
            applyScale();
          };
          pdfZoomApplyRef.current = applyScale;

          // PDF 书签目录 → 右侧目录面板（0.39.17 用户反馈「有些 pdf 文件是有目录
          // 的，可以显示在右侧目录面板中」）：getOutline 拿书签树，dest 引用转页码
          // （命名目的地要先 getDestination 解引用）；异步铺平后上报给 App，
          // jump 闭包滚动本预览的 body 到目标页占位（占位高度在，懒渲染会跟着补）
          if (onPdfToc) {
            void (async () => {
              try {
                const outline = await doc.getOutline();
                if (cancelled) return;
                const entries: PdfTocEntry[] = [];
                const walk = async (
                  items: Awaited<ReturnType<typeof doc.getOutline>> | undefined,
                  depth: number,
                ) => {
                  for (const item of items ?? []) {
                    let page = -1;
                    try {
                      const dest =
                        typeof item.dest === "string"
                          ? await doc.getDestination(item.dest)
                          : item.dest;
                      if (dest && dest.length > 0) page = await doc.getPageIndex(dest[0]);
                    } catch {
                      // 目的地解析失败：只展示标题，不可跳转
                    }
                    entries.push({ title: item.title ?? "", page, depth });
                    if (item.items && item.items.length > 0) await walk(item.items, depth + 1);
                  }
                };
                await walk(outline ?? undefined, 0);
                if (cancelled || entries.length === 0 || entries.every((e) => e.page < 0)) return;
                onPdfToc({
                  path,
                  entries,
                  jump: (page: number) => {
                    const body = bodyRef.current;
                    const slot = pdfHostRef.current?.children[page] as HTMLElement | undefined;
                    if (!body || !slot) return;
                    const delta = slot.getBoundingClientRect().top - body.getBoundingClientRect().top;
                    body.scrollTo({ top: Math.max(0, body.scrollTop + delta - 8), behavior: "smooth" });
                  },
                });
              } catch {
                // 没有书签/解析失败的 pdf 静默无目录
              }
            })();
          }

          setLoading(false);
          return;
        }

        if (kind === "docx") {
          const docx = await import("docx-preview");
          const host = docxHostRef.current;
          if (!host) return;
          host.replaceChildren();
          await docx.renderAsync(bytes.buffer as ArrayBuffer, host, undefined, {
            inWrapper: true,
            ignoreLastRenderedPageBreak: true,
          });
          setLoading(false);
          return;
        }

        if (kind === "ppt") {
          const host = pptxHostRef.current;
          if (!host) return;
          if (extOf(name) === "ppt") {
            // 旧版二进制格式没有纯前端解析器：明确提示，而不是无限转圈
            setError("旧版 .ppt 格式暂不支持预览，请用 PowerPoint/WPS 另存为 .pptx");
            return;
          }
          const buffer = bytes.buffer as ArrayBuffer;
          const width = Math.max(320, host.clientWidth || 900);
          const { init } = await import("pptx-preview");
          pptxChartsLoaded = true;
          if (cancelled) return;
          host.replaceChildren();
          // 库内部按 viewPort.width / 页宽 算缩放，不传数值 width 会得到 NaN
          pptxBytesRef.current = buffer;
          pptxWidthRef.current = width;
          const previewer = init(host, { width, mode: "list" });
          pptxRef.current = previewer;
          orphanSourceRef.current = previewer.wrapper;

          // 视窗宽度变化后按新宽度重建预览（防抖由 ResizeObserver 统一处理）
          pptxRelayoutRef.current = () => {
            const hostNow = pptxHostRef.current;
            const buf = pptxBytesRef.current;
            if (!hostNow || !buf || cancelled) return;
            const next = Math.max(320, hostNow.clientWidth || 900);
            if (Math.abs(next - pptxWidthRef.current) < 40) return;
            pptxWidthRef.current = next;
            const myToken = ++pptxRelayoutTokenRef.current;
            pptxRef.current?.destroy();
            pptxRef.current = null;
            void (async () => {
              const { init: initAgain } = await import("pptx-preview");
              if (cancelled || myToken !== pptxRelayoutTokenRef.current) return;
              hostNow.replaceChildren();
              const rebuilt = initAgain(hostNow, { width: next, mode: "list" });
              pptxRef.current = rebuilt;
              await rebuilt.preview(buf);
              if (pptxRef.current === rebuilt && myToken === pptxRelayoutTokenRef.current) {
                pptxRef.current = null;
              }
            })();
          };

          await previewer.preview(buffer);
          if (pptxRef.current === previewer) pptxRef.current = null;
          setLoading(false);
          return;
        }

        if (kind === "spreadsheet") {
          // 0.39：Worker 返回二维显示字符串（不再走 sheet_to_html），主线程
          // 自己渲染表格以支持列筛选。SheetJS 底数仍只在 Worker 里活着。
          // 0.39.9：缓存键带读盘哈希——同一文件两栏各开/切走再切回不再重解析
          const { parseXlsxInWorker } = await import("../lib/xlsxWorkerHost");
          const parsed = await parseXlsxInWorker(
            data.base64,
            30_000,
            `${vault}::${path}::${data.sha256}`,
          );
          if (cancelled) return;
          setSheets(parsed);
          setLoading(false);
          return;
        }

        setError("该文件类型暂不支持预览");
      } catch (e) {
        // 换文件/关闭引发的销毁中断不算错误（加载任务显示为 Loading aborted）
        if (!cancelled) setError(`预览加载失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      releasePdf();
      releasePptx();
    };
    // reloadSignal（0.39.12）：外部修改时 App 递增，让本 effect 重跑重读磁盘——
    // 解析缓存键带内容哈希，内容没变时命中缓存、无感
  }, [vault, path, kind, reloadSignal]);

  // 预览整体关闭（卸载）才 terminate pdf worker；文件间切换仍复用同一实例。
  // 刻意放在主 effect 之后：卸载时 React 按定义顺序跑清理，先销毁加载任务、
  // 再 terminate worker，避免任务销毁流程向已死线程发消息。
  // 关闭瞬间仍在渲染的 pptx 图表挂为孤儿，闲置一段时间后兜底回收
  useEffect(
    () => () => {
      releasePdfWorker();
      pptxOrphanRoot = orphanSourceRef.current;
      scheduleOrphanSweep();
    },
    [],
  );

  // 显示的缩放取实际生效值（fit 模式下是实时算出的适应倍率）
  const pdfScaleNow = pdfZoom === "fit" ? scaleRef.current : pdfZoom;
  const canZoomOut = pdfScaleNow > PDF_ZOOM_MIN + 0.001;
  const canZoomIn = pdfScaleNow < PDF_ZOOM_MAX - 0.001;

  // 0.36.1 用户反馈「预览标题条与标签栏重复，白白浪费空间」：桌面嵌入态下
  // 标签栏已显示同名 ◇ 标签（含关闭钮），标题条纯冗余——隐藏。
  // 0.38.5 用户反馈：移动端**所有 kind 一律无标题浮条**（缩放靠捏合、关闭靠
  // 系统返回手势），浮条与常驻药丸二选一；桌面非嵌入态（独立预览窗）保留标题条。
  // 0.39.17 用户反馈「左上角有点多余了吧；放大缩小/百分比/适应按钮换成竖向
  // 排列的菜单浮动在右上角，默认隐藏、光标聚焦时才显示」：嵌入态 PDF 的标题
  // 条（连缩放钮）整条撤掉，缩放控件改右上角竖排浮动条（见渲染区）。
  const showBar = !embedded;

  return (
    <div
      ref={rootRef}
      className={`file-preview${embedded ? " is-embedded" : ""}`}
      role="dialog"
      aria-label={`预览 ${name}`}
      onMouseDown={onActivate}
    >
      {showBar && (
      <div className="file-preview-bar">
        <span className="file-preview-name" title={path}>
          {name}
        </span>
        <span className="file-preview-kind">{KIND_LABEL[kind] ?? "预览"}</span>
        {kind === "pdf" && !error && (
          <span className="file-preview-zoom" role="group" aria-label="缩放">
            <button
              type="button"
              className="icon-btn file-preview-zoom-out"
              aria-label="缩小"
              title={canZoomOut ? "缩小（Ctrl+滚轮）" : "已是最小"}
              disabled={!canZoomOut}
              onClick={() => changePdfZoom(pdfScaleNow - 0.2)}
            >
              <IconMinus size={13} />
            </button>
            <span className="file-preview-zoom-value" title="当前缩放（Ctrl+滚轮可调）">
              {Math.round(pdfScaleNow * 100)}%
            </span>
            <button
              type="button"
              className="icon-btn file-preview-zoom-in"
              aria-label="放大"
              title={canZoomIn ? "放大（Ctrl+滚轮）" : "已是最大"}
              disabled={!canZoomIn}
              onClick={() => changePdfZoom(pdfScaleNow + 0.2)}
            >
              <IconPlus size={13} />
            </button>
            <button
              type="button"
              className={`icon-btn file-preview-zoom-fit${pdfZoom === "fit" ? " is-on" : ""}`}
              title="适应宽度"
              onClick={() => changePdfZoom("fit")}
            >
              <span className="file-preview-zoom-fit">适应</span>
            </button>
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={onClose} title="关闭预览（Esc）">
          <IconX size={14} />
        </button>
      </div>
      )}

      <div
        className={`file-preview-body${mobile ? " is-mobile-body" : ""}${showBar ? "" : " is-barless"}${kind === "spreadsheet" ? " is-sheet" : ""}`}
        ref={bodyRef}
        onClick={() => {
          // 移动端点击内容区切药丸/底条显隐（0.38.7）；桌面不参与
          if (!mobile) return;
          window.dispatchEvent(new CustomEvent("qn-preview-chrome", { detail: "toggle" }));
        }}
      >
        {loading && <div className="file-preview-loading">正在加载…</div>}
        {error && <div className="file-preview-error">{error}</div>}
        {kind === "pdf" && !error && <div className="file-preview-pdf" ref={pdfHostRef} />}
        {kind === "docx" && !error && <div className="file-preview-docx" ref={docxHostRef} />}
        {kind === "ppt" && !error && <div className="file-preview-pptx" ref={pptxHostRef} />}
        {kind === "html" && html !== null && (
          <iframe
            ref={htmlFrameRef}
            className={`file-preview-html${mobile ? " is-fit" : ""}`}
            title={name}
            // 0.38.3：加 allow-same-origin——移动端要量内容自然尺寸做铺满/缩放
            // 布局；**没有 allow-scripts，预览文档里的代码仍然不执行**（同
            // 0.38 前的 sandbox="" 安全口径）
            sandbox="allow-same-origin"
            srcDoc={html}
            onLoad={measureHtml}
          />
        )}
        {kind === "html" && html !== null && mobile && (
          // 0.38.3 用户反馈「预览的 html 不支持放大缩小，也不能左右上下滑动」：
          // iframe 吞触摸（独立文档），盖层自己实现手势——单指拖=滚动 body
          // （平移，横竖都通），双指捏合=CSS zoom 缩放（内容重排不糊，中点锚定），
          // 轻点=切标题条。旧「横滑开抽屉」按用户要求移除（预览内滑动属于内容）
          <div
            className="file-preview-html-touch"
            onTouchStart={(event) => {
              htmlTapMovedRef.current = false;
              htmlTapAtRef.current = Date.now();
              htmlLastRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
              if (event.touches.length === 2) {
                const [a, b] = [event.touches[0], event.touches[1]];
                htmlPinchRef.current = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
                htmlPinchZoomRef.current = htmlZoomRef.current;
              }
            }}
            onTouchMove={(event) => {
              event.preventDefault();
              const body = bodyRef.current;
              if (!body) return;
              if (event.touches.length === 1 && htmlPinchRef.current === 0) {
                const t = event.touches[0];
                const dx = t.clientX - htmlLastRef.current.x;
                const dy = t.clientY - htmlLastRef.current.y;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) htmlTapMovedRef.current = true;
                body.scrollLeft -= dx;
                body.scrollTop -= dy;
                htmlLastRef.current = { x: t.clientX, y: t.clientY };
                return;
              }
              if (event.touches.length === 2) {
                htmlTapMovedRef.current = true;
                const [a, b] = [event.touches[0], event.touches[1]];
                const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
                const base = htmlPinchRef.current;
                if (base <= 0 || dist <= 0) return;
                const newZoom = Math.min(5, Math.max(0.5, htmlPinchZoomRef.current * (dist / base)));
                if (newZoom === htmlZoomRef.current) return;
                const ratio = newZoom / htmlZoomRef.current;
                htmlZoomRef.current = newZoom;
                zoomMemoOf(zoomKey).zoom = newZoom;
                applyHtmlLayout();
                // 中点锚定：滚动范围随有效内容尺寸同比变化，捏合中心的内容点
                // 保持不动（横向仅在内容宽超视口、存在横向滚动时修正）
                const rect = body.getBoundingClientRect();
                const cx = (a.clientX + b.clientX) / 2 - rect.left;
                const cy = (a.clientY + b.clientY) / 2 - rect.top;
                body.scrollTop = (body.scrollTop + cy) * ratio - cy;
                if (body.scrollWidth > body.clientWidth + 1) {
                  body.scrollLeft = (body.scrollLeft + cx) * ratio - cx;
                }
              }
            }}
            onTouchEnd={(event) => {
              if (event.touches.length === 1) {
                // 双指收起一根转单指：平移基准重置到剩余手指（口径同灯箱）
                htmlPinchRef.current = 0;
                htmlLastRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
                return;
              }
              if (event.touches.length === 0) {
                htmlPinchRef.current = 0;
                // 0.38.8 用户反馈「HTML 预览点击内容不隐藏药丸（PDF 正常）」：
                // 部分 WebView 对 preventDefault 过 touchmove 的元素不合成
                // click——轻点判定在 touchend 自己做（未拖动/捏合 + 时长短）
                if (
                  !htmlTapMovedRef.current &&
                  Date.now() - htmlTapAtRef.current < 350
                ) {
                  window.dispatchEvent(new CustomEvent("qn-preview-chrome", { detail: "toggle" }));
                }
              }
            }}
          />
        )}
        {kind === "image" && svgMarkup && (
          <div
            className="file-preview-image file-preview-image-pannable"
            ref={imageHostRef}
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
          />
        )}
        {kind === "image" && !svgMarkup && imageUrl && (
          <div
            className={`file-preview-image file-preview-image-pannable${frameMode ? " is-framing" : ""}`}
            ref={imageHostRef}
            onMouseDown={(event) => {
              // 框选态：按下是选框起点（img 自身的拖动/缩放已被 frameModeRef 拦掉）
              if (!frameMode || event.button !== 0) return;
              if ((event.target as HTMLElement).closest(".file-preview-ocr-btn, .file-preview-ocr")) return;
              event.preventDefault();
              frameStartRef.current = { x: event.clientX, y: event.clientY };
            }}
          >
            <img src={imageUrl} alt={name} draggable={false} />
            {/* 0.39.19 用户反馈「预览图片的时候，添加识别文本功能」+ 二轮澄清
                「不是全部识别而是识别框定的范围内的内容」：桌面在图片预览里给
                「框选识别」钮（十字光标拖一个框，轻点=整图），结果面板可复制。
                识别走 screenshot_ocr（WinRT，桌面命令），移动端不出。 */}
            {!mobile && (
              <>
                <button
                  type="button"
                  className={`file-preview-ocr-btn${frameMode && frameKindRef.current === "ocr" ? " is-framing" : ""}${
                    imageOcr?.busy && imageOcr.kind === "ocr" ? " is-busy" : ""
                  }`}
                  title="框选图中区域识别文字（轻点=整图）"
                  onClick={() => {
                    if (frameMode && frameKindRef.current === "ocr") {
                      setFrameMode(false); // 同通道再点 = 取消框选
                      return;
                    }
                    if (!frameMode) clearImageOcr();
                    frameKindRef.current = "ocr";
                    setFrameMode(true); // 若正在 AI 框选则切回普通识别通道
                  }}
                >
                  {frameMode && frameKindRef.current === "ocr"
                    ? "框选中…（Esc 取消）"
                    : imageOcr?.busy && imageOcr.kind === "ocr"
                      ? "识别中…"
                      : "框选识别"}
                </button>
                <button
                  type="button"
                  className={`file-preview-ocr-btn file-preview-ai-btn${frameMode && frameKindRef.current === "ai" ? " is-framing" : ""}${
                    imageOcr?.busy && imageOcr.kind === "ai" ? " is-busy" : ""
                  }`}
                  title="框选区域交给 AI 模型识别（轻点=整图）；先在 设置 → AI 配置供应商"
                  onClick={() => {
                    if (!aiConfigured()) {
                      setImageOcr({
                        busy: false,
                        kind: "ai",
                        text: "先在 设置 → AI 里配置模型供应商（Base URL / API Key / 模型名）",
                      });
                      return;
                    }
                    if (frameMode && frameKindRef.current === "ai") {
                      setFrameMode(false); // 同通道再点 = 取消框选
                      return;
                    }
                    if (!frameMode) clearImageOcr();
                    frameKindRef.current = "ai";
                    setFrameMode(true); // 若在普通框选中则切到 AI 通道
                  }}
                >
                  {frameMode && frameKindRef.current === "ai"
                    ? "框选中…（Esc 取消）"
                    : imageOcr?.busy && imageOcr.kind === "ai"
                      ? "AI 识别中…"
                      : "AI 识别"}
                </button>
                {frameMode && (
                  <div className="file-preview-frame-hint">
                    拖动框选要识别的区域（轻点=整图识别） · Esc 取消
                  </div>
                )}
                {frameRect && (
                  <div
                    className="file-preview-frame"
                    style={{ left: frameRect.x, top: frameRect.y, width: frameRect.w, height: frameRect.h }}
                  />
                )}
                {imageOcr?.text != null && (
                  <div className="file-preview-ocr" ref={ocrPanelRef}>
                    <div className="file-preview-ocr-head">
                      <span className="file-preview-ocr-title">
                        {imageOcr.kind === "ai" ? "AI 识别结果" : "识别结果"}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(imageOcr.text ?? "").then(() => {
                            window.dispatchEvent(
                              new CustomEvent("qn-notice", { detail: { message: "已复制识别文本" } }),
                            );
                          });
                        }}
                      >
                        复制
                      </button>
                      <button type="button" onClick={() => clearImageOcr()}>
                        关闭
                      </button>
                    </div>
                    <textarea
                      className="file-preview-ocr-text"
                      readOnly
                      value={imageOcr.text}
                      rows={Math.min(8, Math.max(3, (imageOcr.text.match(/\n/g)?.length ?? 0) + 1))}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {kind === "spreadsheet" && sheets && sheets.length > 0 && (
          /* 0.39.8 筛选状态跨切换留存：以「仓库::路径」为键记进会话级缓存 */
          <SpreadsheetPreview
            sheets={sheets}
            cacheKey={`${vault}::${path}`}
            /* 0.39.19 单元格编辑：只对 zip+XML 的新式工作簿开放（.xls 是二进制
               OLE，外科手术式写入不适用）；写盘失败会以 toast 呈现 */
            editable={/\.(xlsx|xlsm)$/i.test(path)}
            onEditCell={handleSheetEdit}
          />
        )}
      </div>
      {/* 0.39.17 用户反馈「滚轮不要占用空间，悬浮在空隙上」：原生滚动条隐藏，
          自绘悬浮 thumb 贴右缘（PreviewScrollbar）。xlsx 的滚动在
          SpreadsheetPreview 内部容器，由它自己渲染。 */}
      {embedded && !mobile && <PreviewScrollbar targetRef={bodyRef} />}
      {/* 0.39.17 用户反馈「缩放按钮换成竖向排列的菜单浮动在右上角，默认隐藏、
          光标聚焦时才显示」：桌面嵌入态的缩放控件从标题条（已撤）挪到这里，
          0.39.17 二轮反馈「html 也要类似缩放」——HTML 与 PDF 共用同一浮条。
          显示规则：光标悬停菜单自身即显，离开即隐；键盘聚焦到按钮也显。
          移动端不渲染——缩放走捏合。 */}
      {(kind === "pdf" || kind === "html") && !error && embedded && !mobile && (
        <div className="pdf-float-tools" role="group" aria-label="预览缩放">
          {kind === "pdf" ? (
            <>
              <button
                type="button"
                className="icon-btn"
                aria-label="缩小"
                title={canZoomOut ? "缩小（Ctrl+滚轮）" : "已是最小"}
                disabled={!canZoomOut}
                onClick={() => changePdfZoom(pdfScaleNow - 0.2)}
              >
                <IconMinus size={14} />
              </button>
              <span className="pdf-float-zoom-value" title="当前缩放（Ctrl+滚轮可调）">
                {Math.round(pdfScaleNow * 100)}%
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label="放大"
                title={canZoomIn ? "放大（Ctrl+滚轮）" : "已是最大"}
                disabled={!canZoomIn}
                onClick={() => changePdfZoom(pdfScaleNow + 0.2)}
              >
                <IconPlus size={14} />
              </button>
              <button
                type="button"
                className={`pdf-float-fit${pdfZoom === "fit" ? " is-on" : ""}`}
                title="适应宽度"
                onClick={() => changePdfZoom("fit")}
              >
                适应
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="icon-btn"
                aria-label="缩小"
                title={htmlZoomNow > 0.4 + 0.001 ? "缩小（Ctrl+滚轮）" : "已是最小"}
                disabled={htmlZoomNow <= 0.4 + 0.001}
                onClick={() => changeHtmlZoom(htmlZoomNow - 0.2)}
              >
                <IconMinus size={14} />
              </button>
              <span className="pdf-float-zoom-value" title="当前缩放（Ctrl+滚轮可调）">
                {Math.round(htmlZoomNow * 100)}%
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label="放大"
                title={htmlZoomNow < 3 - 0.001 ? "放大（Ctrl+滚轮）" : "已是最大"}
                disabled={htmlZoomNow >= 3 - 0.001}
                onClick={() => changeHtmlZoom(htmlZoomNow + 0.2)}
              >
                <IconPlus size={14} />
              </button>
              <button
                type="button"
                className={`pdf-float-fit${Math.abs(htmlZoomNow - 1) < 0.001 ? " is-on" : ""}`}
                title="重置 100%"
                onClick={() => changeHtmlZoom(1)}
              >
                适应
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

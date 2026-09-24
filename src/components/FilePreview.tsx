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

import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readBinary, readNote } from "../lib/api";
import { extOf, fileKindOf } from "../lib/fileTypes";
import { IconMinus, IconPlus, IconX } from "./icons";

interface Props {
  vault: string;
  path: string;
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = {
  pdf: "PDF 文档",
  docx: "Word 文档",
  ppt: "PPT 演示文稿",
  spreadsheet: "Excel 表格",
  html: "HTML 页面",
  image: "图片",
};

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

export default function FilePreview({ vault, path, onClose }: Props) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const kind = fileKindOf(name);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** docx/xlsx 的 HTML 结果；PDF 走懒渲染画布，图片走 asset URL。 */
  const [html, setHtml] = useState<string | null>(null);
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const docxHostRef = useRef<HTMLDivElement | null>(null);
  const pdfHostRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const taskRef = useRef<import("pdfjs-dist").PDFDocumentLoadingTask | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const renderedRef = useRef<Set<number>>(new Set());
  /** 在途的页面渲染任务：滚离/重渲时取消，避免白耗 CPU 与双倍画布内存。 */
  const renderTasksRef = useRef<Map<number, import("pdfjs-dist").RenderTask>>(new Map());
  /** 在途的文字层（与画布同生命周期，一起取消）。 */
  const textLayersRef = useRef<Map<number, import("pdfjs-dist").TextLayer>>(new Map());
  /** PDF 缩放："fit" = 适应宽度（自动），数字 = 用户手动缩放倍率。 */
  const [pdfZoom, setPdfZoom] = useState<"fit" | number>("fit");
  const pdfZoomRef = useRef<"fit" | number>("fit");
  useEffect(() => {
    pdfZoomRef.current = pdfZoom;
  }, [pdfZoom]);
  const pptxRef = useRef<import("pptx-preview").PPTXPreviewer | null>(null);
  const pptxHostRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(1);
  const pdfRelayoutRef = useRef<() => void>(() => {});
  /** PDF 缩放的实际执行器（渲染 effect 内部赋值）：按 fit 或指定倍率重建页位。 */
  const pdfZoomApplyRef = useRef<(explicit?: number) => void>(() => {});
  const pptxRelayoutRef = useRef<() => void>(() => {});
  const pptxRelayoutTokenRef = useRef(0);
  const pptxBytesRef = useRef<ArrayBuffer | null>(null);
  const pptxWidthRef = useRef(0);
  /** 最近一次 pptx 渲染容器：关闭时还来不及清理的图表实例从这里兜底回收。 */
  const orphanSourceRef = useRef<HTMLElement | null>(null);

  // Esc 关闭预览
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---------------------------------------------------------------- 图片预览：拖动 + 滚轮缩放
  // 按住左键拖动移动、滚轮缩放（以指针为锚）、双击重置。与 mermaid 灯箱同一套手感。
  const imageHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (kind !== "image") return;
    const host = imageHostRef.current;
    if (!host) return;
    const img = host.querySelector("img");
    if (!img) return;

    let scale = 1;
    let x = 0;
    let y = 0;
    const apply = () => {
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    };

    const onWheel = (event: WheelEvent) => {
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
    return () => {
      img.removeEventListener("wheel", onWheel);
      img.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      img.removeEventListener("dblclick", onDbl);
    };
  }, [kind, imageUrl]);

  /** 切换 PDF 缩放：fit 走适应宽度，数字为手动倍率（0.4–3.0，防画布爆内存）。 */
  const changePdfZoom = (next: "fit" | number) => {
    const clamped = next === "fit" ? "fit" : Math.min(3, Math.max(0.4, Math.round(next * 20) / 20));
    setPdfZoom(clamped);
    pdfZoomRef.current = clamped;
    pdfZoomApplyRef.current?.(clamped === "fit" ? undefined : clamped);
  };

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHtml(null);
    setSheets(null);
    setImageUrl(null);
    renderedRef.current.clear();
    pdfRelayoutRef.current = () => {};
    pptxRelayoutRef.current = () => {};
    // 上一次预览关闭时来不及清理的图表孤儿，现在一定可以安全回收了
    sweepOrphanCharts();

    // 释放 PDF 文档与其占用的渲染内存（切换/关闭/StrictMode 二次挂载都走这里）
    const releasePdf = () => {
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
          setImageUrl(convertFileSrc(abs));
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
           * 画布渲染与文字层并行；滚离视口时两者都要 cancel（在途任务白耗
           * CPU，还会让新旧两套画布同时占内存）。
           */
          const renderPage = async (pageNumber: number, slot: HTMLElement) => {
            const docCurrent = docRef.current;
            if (!docCurrent || renderedRef.current.has(pageNumber)) return;
            renderedRef.current.add(pageNumber);
            try {
              const pdfPage = await docCurrent.getPage(pageNumber);
              if (cancelled || docRef.current !== docCurrent) return;
              const viewport = pdfPage.getViewport({ scale: scaleRef.current });
              const canvas = document.createElement("canvas");
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              canvas.style.width = "100%";
              canvas.style.height = "100%";
              const textDiv = document.createElement("div");
              textDiv.className = "qn-pdf-text";
              // pdfjs 的文字层 CSS 用 --total-scale-factor 计算字号与位移
              textDiv.style.setProperty("--total-scale-factor", String(viewport.scale));
              slot.replaceChildren(canvas, textDiv);
              const renderTask = pdfPage.render({ canvas, viewport });
              renderTasksRef.current.set(pageNumber, renderTask);
              const textLayer = new TextLayer({
                textContentSource: pdfPage.streamTextContent({ includeMarkedContent: true }),
                container: textDiv,
                viewport,
              });
              textLayersRef.current.set(pageNumber, textLayer);
              await Promise.all([renderTask.promise, textLayer.render()]);
            } catch {
              // 页面渲染被销毁/取消打断：占位保持原样；清掉标记允许 observer 稍后重试
              renderedRef.current.delete(pageNumber);
            } finally {
              renderTasksRef.current.delete(pageNumber);
              textLayersRef.current.delete(pageNumber);
            }
          };

          /** 释放某页的全部渲染产物（画布位图尺寸先清零，立即归还内存）。 */
          const discardPage = (slot: HTMLElement) => {
            const pageNumber = Number((slot as HTMLElement).dataset.page);
            renderTasksRef.current.get(pageNumber)?.cancel();
            renderTasksRef.current.delete(pageNumber);
            textLayersRef.current.get(pageNumber)?.cancel();
            textLayersRef.current.delete(pageNumber);
            renderedRef.current.delete(pageNumber);
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
            if (slot) void renderPage(pageNumber, slot);
          }

          // 进入视口（前后预渲染 600px）才渲染；离开视口时取消在途任务并释放画布
          const observer = new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const slot = entry.target as HTMLElement;
                const pageNumber = Number(slot.dataset.page);
                if (entry.isIntersecting) {
                  void renderPage(pageNumber, slot);
                } else if (renderedRef.current.has(pageNumber)) {
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
            if (Math.abs(next - scaleRef.current) / scaleRef.current < 0.02) return;
            scaleRef.current = next;
            const width = Math.round(base.width * next);
            for (const slot of Array.from(hostNow.children) as HTMLElement[]) {
              slot.style.width = `${width}px`;
              discardPage(slot);
            }
            for (const slot of Array.from(hostNow.children)) {
              observer.unobserve(slot);
              observer.observe(slot);
            }
          };
          // 视窗尺寸变化只在"适应宽度"模式下跟随；手动缩放时保持用户的选择
          pdfRelayoutRef.current = () => {
            if (pdfZoomRef.current !== "fit") return;
            applyScale();
          };
          pdfZoomApplyRef.current = applyScale;
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
          const XLSX = await import("xlsx");
          const workbook = XLSX.read(bytes, { type: "array" });
          const list = workbook.SheetNames.map((sheetName) => ({
            name: sheetName,
            html: DOMPurify.sanitize(XLSX.utils.sheet_to_html(workbook.Sheets[sheetName])),
          }));
          if (cancelled) return;
          setSheets(list);
          setSheetIndex(0);
          setHtml(list[0]?.html ?? "");
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
  }, [vault, path, kind]);

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

  return (
    <div className="file-preview" role="dialog" aria-label={`预览 ${name}`}>
      <div className="file-preview-bar">
        <span className="file-preview-name" title={path}>
          {name}
        </span>
        <span className="file-preview-kind">{KIND_LABEL[kind] ?? "预览"}</span>
        {kind === "pdf" && !error && (
          <span className="file-preview-zoom" role="group" aria-label="缩放">
            <button
              type="button"
              className="icon-btn"
              title="缩小"
              onClick={() => changePdfZoom((pdfZoom === "fit" ? scaleRef.current : pdfZoom) - 0.2)}
            >
              <IconMinus size={13} />
            </button>
            <span className="file-preview-zoom-value" title="当前缩放">
              {Math.round((pdfZoom === "fit" ? scaleRef.current : pdfZoom) * 100)}%
            </span>
            <button
              type="button"
              className="icon-btn"
              title="放大"
              onClick={() => changePdfZoom((pdfZoom === "fit" ? scaleRef.current : pdfZoom) + 0.2)}
            >
              <IconPlus size={13} />
            </button>
            <button
              type="button"
              className={`icon-btn${pdfZoom === "fit" ? " is-on" : ""}`}
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

      <div className="file-preview-body" ref={bodyRef}>
        {loading && <div className="file-preview-loading">正在加载…</div>}
        {error && <div className="file-preview-error">{error}</div>}
        {kind === "pdf" && !error && <div className="file-preview-pdf" ref={pdfHostRef} />}
        {kind === "docx" && !error && <div className="file-preview-docx" ref={docxHostRef} />}
        {kind === "ppt" && !error && <div className="file-preview-pptx" ref={pptxHostRef} />}
        {kind === "html" && html !== null && (
          <iframe
            className="file-preview-html"
            title={name}
            sandbox=""
            srcDoc={html}
          />
        )}
        {kind === "image" && imageUrl && (
          <div className="file-preview-image file-preview-image-pannable" ref={imageHostRef}>
            <img src={imageUrl} alt={name} draggable={false} />
          </div>
        )}
        {kind === "spreadsheet" && sheets && sheets.length > 0 && (
          <div className="file-preview-xlsx">
            {sheets.length > 1 && (
              <div className="file-preview-sheets" role="tablist">
                {sheets.map((sheet, index) => (
                  <button
                    key={sheet.name}
                    type="button"
                    role="tab"
                    aria-selected={index === sheetIndex}
                    className={`file-preview-sheet${index === sheetIndex ? " is-on" : ""}`}
                    onClick={() => {
                      setSheetIndex(index);
                      setHtml(sheet.html);
                    }}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            )}
            <div className="file-preview-sheet-body" dangerouslySetInnerHTML={{ __html: html ?? "" }} />
          </div>
        )}
      </div>
    </div>
  );
}

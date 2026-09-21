/**
 * Live Preview 装饰层——Obsidian 式「富文本」观感的实现。
 *
 * 核心机制：文档缓冲区始终是 Markdown 原文，装饰层只做两件事——
 *   1. 用 `Decoration.replace` 把语法标记（`**`、`#`、`` ` ``、`](url)` 等）藏起来；
 *   2. 用 `Decoration.mark` / `Decoration.line` 给内容加样式。
 *
 * 光标所在的那一行（或选区覆盖到的行）不做隐藏，直接显示源码，方便就地修改语法。
 *
 * 之所以把 `buildLivePreviewDecorations` 写成不依赖 EditorView 的纯函数：
 * 装饰计算是这套方案里最容易出错的部分，纯函数可以直接在 Node 里单测，
 * 不必启动 GUI。见 scripts/verify-livepreview.mjs。
 *
 * 节点名不是猜的，来自 `node scripts/dump-markdown-tree.mjs` 的实际输出。
 */

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { EditorState, Range } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumn,
  insertRow,
  normalizeColumns,
  parseTableBlock,
  type TableBlock,
} from "./table.ts";
import { renderEmbeddedNote } from "./embed.ts";
import {
  findComments,
  findHighlights,
  findInlineHtml,
  findInlineMath,
  findTags,
  parseCalloutLine,
} from "./inlineSyntax.ts";
import { CalloutLabelWidget, HtmlWidget, isExternalUrl, mathWidgetFor } from "./markdownExtras.ts";
import {
  EMPTY_CONTEXT,
  IMAGE_EXT,
  livePreviewContext,
  resolveResource,
  resolveResourceRelative,
  resolveWikiRelative,
  resolveWikiTarget,
  type LivePreviewContext,
} from "./paths.ts";
/** 单元格里的一段文字及其行内样式。

    把嵌套样式拍平成「带标记的文本段」，好处是可直接序列化，widget 的 eq 比较
    只需比 JSON，不必处理 DOM 树。 */
interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
}

const EMPTY_FLAGS = { bold: false, italic: false, strike: false, code: false, link: false };

/** 表格解析结果。rows 是三层结构：行 → 单元格 → 文本段；raw 是单元格的原文。 */
interface ParsedTable {
  rows: TextRun[][][];
  align: (null | "left" | "center" | "right")[];
  /** 每个单元格的**原文**（渲染态就地编辑写回时用）。 */
  raw: string[][];
  /** 分隔行的原文（写回时原样保留用户的对齐标记与间距）。 */
  delimiterLine: string;
}

/**
 * 把一个语法节点的内容拍平成带样式的文本段。
 *
 * 行内标记节点（名字以 Mark 结尾的，如 EmphasisMark / CodeMark）只是定界符，
 * 跳过即可——标记之间的正文在语法树里没有独立节点，靠位置差取出。
 */
function flattenInline(
  state: EditorState,
  parent: SyntaxNode,
  flags: Omit<TextRun, "text">,
): TextRun[] {
  const doc = state.doc;
  const runs: TextRun[] = [];
  let pos = parent.from;

  const push = (text: string) => {
    if (text) runs.push({ text, ...flags });
  };

  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.name.endsWith("Mark")) {
      // 定界符：先把它之前的正文取出，再跳过它。
      // 必须推进 pos——否则循环结束后 `pos < parent.to` 会把整段（含标记）
      // 当成一段文本推出去，表现为单元格里显示 `**粗体**`。
      if (child.from > pos) push(doc.sliceString(pos, child.from));
      pos = child.to;
      continue;
    }
    if (child.from > pos) push(doc.sliceString(pos, child.from));

    switch (child.name) {
      case "StrongEmphasis":
        runs.push(...flattenInline(state, child, { ...flags, bold: true }));
        break;
      case "Emphasis":
        runs.push(...flattenInline(state, child, { ...flags, italic: true }));
        break;
      case "Strikethrough":
        runs.push(...flattenInline(state, child, { ...flags, strike: true }));
        break;
      case "InlineCode":
        runs.push(...flattenInline(state, child, { ...flags, code: true }));
        break;
      case "Link": {
        // 链接只取可见文字，丢掉 `](url)`。
        const open = child.firstChild;
        const close = open?.nextSibling;
        const text =
          open && close
            ? doc.sliceString(open.to, close.from)
            : doc.sliceString(child.from, child.to);
        runs.push({ text, ...flags, link: true });
        break;
      }
      default:
        if (child.firstChild) runs.push(...flattenInline(state, child, flags));
        else push(doc.sliceString(child.from, child.to));
    }
    pos = child.to;
  }

  if (pos < parent.to) push(doc.sliceString(pos, parent.to));
  return runs;
}

/** 把文本段渲染进一个元素。 */
function appendRuns(target: HTMLElement, runs: TextRun[]): void {
  for (const run of runs) {
    let node: Node;
    if (run.code) {
      const code = document.createElement("code");
      code.className = "cm-lp-code";
      code.textContent = run.text;
      node = code;
    } else if (run.link) {
      const link = document.createElement("span");
      link.className = "cm-lp-link";
      link.textContent = run.text;
      node = link;
    } else {
      node = document.createTextNode(run.text);
    }

    if (run.strike) {
      const el = document.createElement("s");
      el.appendChild(node);
      node = el;
    }
    if (run.italic) {
      const el = document.createElement("em");
      el.appendChild(node);
      node = el;
    }
    if (run.bold) {
      const el = document.createElement("strong");
      el.appendChild(node);
      node = el;
    }
    target.appendChild(node);
  }
}

/** 隐藏语法标记。 */
const HIDE = Decoration.replace({});

const LINE_CLASS: Record<number, Decoration> = {
  1: Decoration.line({ class: "cm-lp-heading cm-lp-h1" }),
  2: Decoration.line({ class: "cm-lp-heading cm-lp-h2" }),
  3: Decoration.line({ class: "cm-lp-heading cm-lp-h3" }),
  4: Decoration.line({ class: "cm-lp-heading cm-lp-h4" }),
  5: Decoration.line({ class: "cm-lp-heading cm-lp-h5" }),
  6: Decoration.line({ class: "cm-lp-heading cm-lp-h6" }),
};

const MARK = {
  strong: Decoration.mark({ class: "cm-lp-strong" }),
  em: Decoration.mark({ class: "cm-lp-em" }),
  strike: Decoration.mark({ class: "cm-lp-strike" }),
  code: Decoration.mark({ class: "cm-lp-code" }),
  link: Decoration.mark({ class: "cm-lp-link" }),
  highlight: Decoration.mark({ class: "cm-lp-highlight" }),
  /** 有序列表的序号（1. 2. …）：与圆点同风格的列表标记。 */
  olMark: Decoration.mark({ class: "cm-lp-olmark" }),
  /** 反斜杠转义里保留的字符：回正文颜色，盖掉 escape 的语法主题色。 */
  plain: Decoration.mark({ class: "cm-lp-plain" }),
};

const OL_MARK = MARK.olMark;

/** 行内「语法标记 + 内容」型节点的样式映射。 */
const INLINE_MARKS: Record<string, Decoration> = {
  StrongEmphasis: MARK.strong,
  Emphasis: MARK.em,
  Strikethrough: MARK.strike,
  InlineCode: MARK.code,
};

// ---------------------------------------------------------------- 小部件
//
// 注意：这里不能用 TypeScript 的「参数属性」写法（`constructor(readonly x: T)`）。
// 测试脚本用 Node 的类型擦除直接加载本文件，而参数属性需要生成赋值代码，
// 不属于可擦除语法，会导致加载失败。tsconfig 里的 erasableSyntaxOnly 会守住这条。

/** 任务清单复选框：点击直接改写源码里的 `[ ]` / `[x]`。 */
class TaskCheckboxWidget extends WidgetType {
  readonly checked: boolean;
  readonly from: number;
  readonly to: number;

  constructor(checked: boolean, from: number, to: number) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    // 阻止 mousedown 的默认行为即可，避免光标被移到本行（否则本行会退回源码、
    // 复选框消失）；但**不能**阻止 click，否则浏览器不会切换勾选状态。
    box.addEventListener("mousedown", (event) => event.preventDefault());
    // 由浏览器完成切换，再把结果写回源码。比自己在 click 里翻转更可靠。
    box.addEventListener("change", () => {
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: box.checked ? "[x]" : "[ ]" },
      });
    });
    return box;
  }
}

/** 无序列表的项目符号：把 `-` / `*` / `+` 显示成圆点。 */
class BulletWidget extends WidgetType {
  eq(other: BulletWidget) {
    return other instanceof BulletWidget;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
}

/** 分割线。 */
class RuleWidget extends WidgetType {
  eq(other: RuleWidget) {
    return other instanceof RuleWidget;
  }
  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-lp-rule";
    return hr;
  }
}

/**
 * 围栏代码块的头部条：语言名 + 一键复制。
 *
 * 挂在起始围栏行（```ts 那一行）上，与语言标签同一位置。复制按钮在 mousedown
 * 就 preventDefault + stopPropagation——CM 若收到这个按下事件会把光标放进围栏块，
 * 该行随即退回源码、按钮在 click 触发前就没了（正是要防的竞态）。
 */
class CodeHeaderWidget extends WidgetType {
  readonly info: string;
  readonly code: string;

  constructor(info: string, code: string) {
    super();
    this.info = info;
    this.code = code;
  }

  eq(other: CodeHeaderWidget) {
    return other.info === this.info && other.code === this.code;
  }

  toDOM() {
    const box = document.createElement("span");
    box.className = "cm-lp-codehead";

    const chip = document.createElement("span");
    chip.className = "cm-lp-codeinfo";
    chip.textContent = this.info || "代码";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "cm-lp-codecopy";
    copy.textContent = "复制";
    copy.title = "复制代码";
    copy.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      void navigator.clipboard.writeText(this.code).then(
        () => {
          copy.textContent = "已复制";
          copy.classList.add("is-done");
          window.setTimeout(() => {
            copy.textContent = "复制";
            copy.classList.remove("is-done");
          }, 1200);
        },
        () => {
          // 剪贴板不可用（权限等）静默失败，不打断阅读
        },
      );
    });

    box.append(chip, copy);
    return box;
  }
}

/** Mermaid 的渲染入口（只用到这两个方法，不必依赖它的完整类型定义）。 */
interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

/**
 * mermaid 按需加载。
 *
 * mermaid 是个很重的库（含全部图表类型），绝不能进主包——`import()` 会让打包器
 * 把它切成独立 chunk，只有文档里真的出现 mermaid 围栏块时才加载。
 * 加载后常驻内存（不重复加载），这一点接受。
 */
let mermaidLoader: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((mod) => {
      const mermaid = (mod as unknown as { default: MermaidApi }).default;
      mermaid.initialize({
        startOnLoad: false,
        // strict 会清洗标签里的 HTML/事件处理器。绝不要用 loose——
        // 笔记内容可能来自别处，loose 等于允许注入。
        securityLevel: "strict",
        theme: "neutral",
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

/** 已渲染 SVG 的缓存，避免同一张图反复解析渲染。简单的先进先出淘汰。
 *  上限刻意保守：复杂图表的 SVG 标记串每张可达数百 KB，缓存是纯内存开销；
 *  12 张足够覆盖来回翻页的可见范围。 */
const svgCache = new Map<string, string>();
const SVG_CACHE_LIMIT = 12;

/** 取会话内已渲染的 mermaid SVG（PDF 导出打印视图复用；没有则 null）。 */
export function cachedMermaidSvg(code: string): string | null {
  return svgCache.get(code) ?? null;
}
let mermaidSeq = 0;

/**
 * 判断一个围栏代码块是否为 mermaid 图，是则返回图定义源码。
 *
 * 插件与 StateField 共用这个判断，避免两处各写一份而出现不一致。
 */
function mermaidCode(state: EditorState, fenced: SyntaxNode): string | null {
  let info: string | null = null;
  let code = "";
  for (let child = fenced.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeInfo") {
      info = state.doc.sliceString(child.from, child.to).trim().toLowerCase();
    } else if (child.name === "CodeText") {
      code = state.doc.sliceString(child.from, child.to);
    }
  }
  return info === "mermaid" ? code : null;
}

/**
 * 把 mermaid 围栏块渲染成图。
 *
 * mermaid 的渲染是异步的，而 widget 的 toDOM 是同步的，所以先占位、后填充。
 * 渲染失败不能让编辑器崩掉——错误信息显示在占位框里，源码仍在（点一下即可编辑）。
 *
 * 0.5 渲染增强（自 quick-daily-note 插件移植）：SVG 插入后包装上工具栏——
 * 缩放（−/百分比/＋/还原）、导出 SVG/PNG（保存进仓库，见 `downloadDiagram`）、
 * 单击放大浮层；双击仍是退回源码编辑（单击有 260ms 延迟，双击会取消它）。
 */
class MermaidWidget extends WidgetType {
  readonly code: string;
  readonly from: number;
  readonly to: number;

  constructor(code: string, from: number, to: number) {
    super();
    this.code = code;
    this.from = from;
    this.to = to;
  }

  eq(other: MermaidWidget) {
    return other.code === this.code && other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-lp-mermaid";
    box.title = "单击放大 · 双击编辑源码";
    // 单击保持渲染（0.3：与表格一致——图不该一点就消失）。
    // 双击才把光标放进围栏块，退回源码编辑。
    box.addEventListener("dblclick", (event) => {
      event.preventDefault();
      view.dispatch({
        selection: { anchor: Math.min(this.from + 1, view.state.doc.length) },
      });
      view.focus();
    });

    const context = view.state.facet(livePreviewContext);
    const insertSvg = (svg: string) => {
      box.innerHTML = svg;
      const element = box.querySelector("svg");
      if (element) enhanceMermaid(box, element as SVGSVGElement, context.vaultPath, context.notePath);
      // 渲染后的 SVG 比占位文字高得多：不重测的话 CM 的高度图停在占位尺寸上，
      // 后续所有点击定位/选区/行号都整体错位（选中的行和实际行对不上）。
      // 异步回调跑的时候 widget 可能已被移除，isConnected 守卫一下。
      if (box.isConnected) view.requestMeasure();
    };
    const cached = svgCache.get(this.code);
    if (cached) {
      insertSvg(cached);
      return box;
    }

    box.textContent = "图表渲染中…";
    box.classList.add("is-loading");

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(`qn-mermaid-${(mermaidSeq += 1)}`, this.code);
        svgCache.set(this.code, svg);
        if (svgCache.size > SVG_CACHE_LIMIT) {
          const oldest = svgCache.keys().next();
          if (!oldest.done) svgCache.delete(oldest.value);
        }
        // widget 可能已被替换/移除，此时写入不影响任何可见内容。
        box.classList.remove("is-loading");
        insertSvg(svg);
      } catch (error) {
        box.classList.remove("is-loading");
        box.classList.add("is-error");
        const message = error instanceof Error ? error.message : String(error);
        box.textContent = `图表渲染失败：${message.split("\n")[0]}`;
        if (box.isConnected) view.requestMeasure();
      }
    })();

    return box;
  }
}

// ------------------------------------------------------------- mermaid 增强

interface MermaidZoomState {
  naturalW: number;
  naturalH: number;
  /** 当前缩放（fitted 时无意义）。 */
  scale: number;
  /** true = 自适应宽度（高图限高），false = 按像素宽度缩放。 */
  fitted: boolean;
}

/** mermaid 通知通道：默认只写控制台，App 启动时接到界面提示上。 */
let mermaidNotice: (message: string, kind?: "info" | "error") => void = () => {};

export function setMermaidNotice(
  handler: (message: string, kind?: "info" | "error") => void,
): void {
  mermaidNotice = handler;
}

/** 给渲染好的 mermaid SVG 挂上工具栏、缩放与放大浮层。 */
function enhanceMermaid(
  box: HTMLElement,
  svg: SVGSVGElement,
  vaultPath: string | null,
  notePath: string | null,
): void {
  // 自然尺寸：viewBox 最可靠（mermaid 开启 useMaxWidth 时 width 属性是 "100%"，
  // 解析成数字会得到 100——按它缩放就全错了）。
  const vb = svg.viewBox.baseVal;
  const rect = svg.getBoundingClientRect();
  const naturalW = vb.width > 0 ? vb.width : rect.width || 300;
  const naturalH = vb.height > 0 ? vb.height : rect.height || 200;
  if (naturalW <= 0 || naturalH <= 0) return;

  const state: MermaidZoomState = { naturalW, naturalH, scale: 1, fitted: true };

  const applyZoom = () => {
    if (state.fitted) {
      // 宽图适应容器宽度（mermaid 内联的 max-width 保留即可）；高图限高，宽度按比例
      if (state.naturalH > state.naturalW) {
        svg.classList.add("me-fit-tall");
        svg.classList.remove("me-zoom-px");
        svg.style.removeProperty("width");
        svg.style.height = "60vh";
      } else {
        svg.classList.remove("me-fit-tall", "me-zoom-px");
        svg.style.removeProperty("width");
        svg.style.removeProperty("height");
      }
    } else {
      svg.classList.remove("me-fit-tall");
      svg.classList.add("me-zoom-px");
      svg.style.removeProperty("height");
      svg.style.width = `${Math.max(1, Math.round(state.naturalW * state.scale))}px`;
    }
    percent.textContent = state.fitted ? "适应" : `${Math.round(state.scale * 100)}%`;
  };

  const zoomBy = (factor: number) => {
    if (state.fitted) {
      // 从「适应」切到像素缩放：以当前显示比例作起点，切换不平跳
      state.fitted = false;
      const availW = box.clientWidth || state.naturalW;
      state.scale = Math.max(0.05, Math.min(1, availW / state.naturalW));
    }
    state.scale = Math.min(8, Math.max(0.05, state.scale * factor));
    applyZoom();
  };

  const toolbar = document.createElement("div");
  toolbar.className = "qn-mermaid-toolbar";
  const button = (text: string, title: string, onClick: () => void) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "qn-mermaid-btn";
    el.title = title;
    el.textContent = text;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    toolbar.appendChild(el);
    return el;
  };
  button("−", "缩小", () => zoomBy(1 / 1.25));
  const percent = document.createElement("span");
  percent.className = "qn-mermaid-percent";
  toolbar.appendChild(percent);
  button("＋", "放大", () => zoomBy(1.25));
  button("↺", "还原", () => {
    state.fitted = true;
    state.scale = 1;
    applyZoom();
  });
  button("⬇", "导出 SVG / PNG", () => menu.classList.toggle("me-open"));
  const menu = document.createElement("div");
  menu.className = "qn-mermaid-menu";
  for (const format of ["svg", "png"] as const) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "qn-mermaid-menu-item";
    item.textContent = format.toUpperCase();
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.classList.remove("me-open");
      void downloadDiagram(svg, state, format, vaultPath, notePath);
    });
    menu.appendChild(item);
  }
  toolbar.appendChild(menu);
  box.appendChild(toolbar);

  // 单击放大浮层（延迟触发，给双击留出取消窗口）
  let clickTimer: number | null = null;
  svg.addEventListener("click", (event) => {
    event.stopPropagation();
    if (clickTimer !== null) window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => {
      clickTimer = null;
      openMermaidOverlay(svg);
    }, 260);
  });
  box.addEventListener("dblclick", () => {
    if (clickTimer !== null) {
      window.clearTimeout(clickTimer);
      clickTimer = null;
    }
  });

  applyZoom();
}

/** 全屏放大浮层：克隆 SVG 铺到视口，点任意处 / Esc 关闭。 */
function openMermaidOverlay(svg: SVGSVGElement): void {
  const overlay = document.createElement("div");
  overlay.className = "qn-mermaid-overlay";
  overlay.title = "点击任意处或按 Esc 关闭";
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.classList.remove("me-fit-tall", "me-zoom-px");
  clone.removeAttribute("style");
  clone.style.maxWidth = "92vw";
  clone.style.maxHeight = "86vh";
  clone.style.width = "auto";
  clone.style.height = "auto";
  overlay.appendChild(clone);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
}

/**
 * 导出图表（自插件的 downloadAsSVG/downloadAsPNG 移植）。
 *
 * 与插件的一处刻意差异：插件走浏览器下载（落到系统下载目录），Quick Note
 * 用 writeBinary 把导出**保存进仓库**（当前笔记同目录，没开笔记就仓库根），
 * 命名 `笔记名-mermaid-N.svg/png`——知识系统的导出物应该跟着库走，而不是散在
 * 下载文件夹里；同时也绕开了 WebView 对 blob 下载支持不确定的问题。
 */
async function downloadDiagram(
  svg: SVGSVGElement,
  state: MermaidZoomState,
  format: "svg" | "png",
  vaultPath: string | null,
  notePath: string | null,
): Promise<void> {
  if (!vaultPath) {
    mermaidNotice("尚未打开仓库，无法导出图表", "error");
    return;
  }
  try {
    const base = (notePath ?? "diagram").replace(/\.md$/i, "").split("/").pop() || "diagram";
    const seq = (diagramExportSeq += 1);
    const name = `${base}-mermaid-${seq}.${format}`;
    // 落点：当前笔记同目录；没有目录信息的（仓库根的笔记）就是仓库根
    const dir = notePath && notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
    const target = dir ? `${dir}/${name}` : name;

    if (format === "svg") {
      const clone = cloneForExport(svg, state);
      const xml = new XMLSerializer().serializeToString(clone);
      await writeVaultBinary(vaultPath, target, new TextEncoder().encode(xml));
    } else {
      const scale = 2;
      const url = svgToBlobUrl(svg, state);
      try {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("SVG 加载失败"));
          image.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(state.naturalW * scale);
        canvas.height = Math.round(state.naturalH * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 不可用");
        ctx.fillStyle = themeBackgroundColor();
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("PNG 生成失败");
        await writeVaultBinary(vaultPath, target, new Uint8Array(await blob.arrayBuffer()));
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    mermaidNotice(`已导出图表：${target}`);
  } catch (error) {
    mermaidNotice(`导出图表失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

let diagramExportSeq = 0;

/** 写入库内二进制（导出用）；动态 import，让纯逻辑测试不必碰 Tauri API。 */
async function writeVaultBinary(vault: string, path: string, bytes: Uint8Array): Promise<void> {
  const { writeBinary } = await import("./api.ts");
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  await writeBinary(vault, path, btoa(binary));
}

/** 导出用克隆：定死自然尺寸、清掉运行时样式。 */
function cloneForExport(svg: SVGSVGElement, state: MermaidZoomState): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(state.naturalW));
  clone.setAttribute("height", String(state.naturalH));
  clone.removeAttribute("style");
  clone.classList.remove("me-fit-tall", "me-zoom-px");
  return clone;
}

/**
 * 序列化 SVG 为 Blob URL（PNG 导出用）。
 *
 * mermaid 的文字默认用 foreignObject 承载 HTML，而 SVG 作为 <img> 加载时浏览器
 * 不渲染其中的 HTML——PNG 会丢掉所有文字。克隆时把 foreignObject 逐个换成
 * 普通 <text>（位置/字号/颜色取自原始 DOM 的实时布局），文字就保住了。
 */
function svgToBlobUrl(svg: SVGSVGElement, state: MermaidZoomState): string {
  const clone = cloneForExport(svg, state);
  const sourceFos = Array.from(svg.querySelectorAll("foreignObject"));
  const cloneFos = Array.from(clone.querySelectorAll("foreignObject"));
  if (sourceFos.length > 0) {
    const sourceRect = svg.getBoundingClientRect();
    const displayScale = sourceRect.width > 0 ? sourceRect.width / state.naturalW : 1;
    const ns = "http://www.w3.org/2000/svg";
    cloneFos.forEach((cloneFo, index) => {
      const sourceFo = sourceFos[index];
      const holder = sourceFo?.querySelector("div, span");
      const text = holder ? flattenLabelText(holder as HTMLElement).trim() : "";
      if (!sourceFo || !holder || !text) {
        cloneFo.remove();
        return;
      }
      const rect = (holder as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(holder as HTMLElement);
      const fontSize = parseFloat(style.fontSize) || 16;
      const lineHeight = fontSize * 1.2;
      const centerX = (rect.left + rect.width / 2 - sourceRect.left) / displayScale;
      const topY = (rect.top - sourceRect.top) / displayScale;
      const anchor = style.textAlign === "left" ? "start" : "middle";
      text.split("\n").forEach((lineText, lineIndex) => {
        if (!lineText.trim()) return;
        const el = document.createElementNS(ns, "text");
        el.setAttribute(
          "x",
          String(anchor === "middle" ? centerX : (rect.left - sourceRect.left) / displayScale),
        );
        el.setAttribute("y", String(topY + fontSize + lineIndex * lineHeight));
        el.setAttribute("font-size", `${fontSize}px`);
        el.setAttribute("font-family", style.fontFamily || "inherit");
        el.setAttribute("font-weight", style.fontWeight || "normal");
        el.setAttribute("text-anchor", anchor);
        el.setAttribute("fill", style.color || "#000");
        el.textContent = lineText;
        cloneFo.parentElement?.insertBefore(el, cloneFo);
      });
      cloneFo.remove();
    });
  }
  const xml = new XMLSerializer().serializeToString(clone);
  return URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
}

/** 提取 label 文本并保留 <br/> 换行（遍历子节点，不做 innerHTML 拼接）。 */
function flattenLabelText(el: HTMLElement): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeName === "BR") out += "\n";
    else if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? "";
    else if (node.nodeType === Node.ELEMENT_NODE) out += flattenLabelText(node as HTMLElement);
  }
  return out;
}

/** 当前主题的底色，作为 PNG 画布底色（透明底在浅色查看器里会看不见白线）。 */
function themeBackgroundColor(): string {
  const bg = getComputedStyle(document.body).backgroundColor;
  if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
  return document.documentElement.dataset.theme === "dark" ? "#1e1e28" : "#ffffff";
}

/**
 * 表格渲染成真正的 `<table>`，单元格可选中、可就地编辑（Obsidian 式，0.4）。
 *
 * 每个单元格是 `contenteditable="plaintext-only"`：点击即进入编辑、可拖选复制，
 * 编辑结束时（blur / Enter / Tab / Esc）把单元格文本写回源码——走 table.ts 的
 * 结构化变换整块替换，管道顺带重新对齐。提交时机刻意放在「编辑结束」而不是
 * 每次键入：逐键写回会让 StateField 判定内容变化、重建 widget，输入焦点随之丢失。
 *
 * 结构操作（＋行 / ＋列）走 document 级委托；点击前先把正在编辑的单元格冲刷掉，
 * 否则结构变换读的是旧源码，刚敲的字就丢了。双击单元格之外的区域退回源码。
 *
 * 单元格按"肉眼可见的管道"解析，转义 `\|` 与行内代码里的 `|` 不支持——与
 * Obsidian 的表格编辑器同一条边界。所以单元格输入里的竖线被直接拦下。
 */
class TableWidget extends WidgetType {
  readonly rows: TextRun[][][];
  readonly align: (null | "left" | "center" | "right")[];
  /** 每个单元格的源码原文（含 `code`、**粗体** 等标记）。点击单元格切换到原文编辑用。 */
  readonly rawRows: string[][];
  readonly from: number;
  readonly to: number;

  constructor(
    rows: TextRun[][][],
    align: (null | "left" | "center" | "right")[],
    rawRows: string[][],
    from: number,
    to: number,
  ) {
    super();
    this.rows = rows;
    this.align = align;
    this.rawRows = rawRows;
    this.from = from;
    this.to = to;
  }

  eq(other: TableWidget) {
    return (
      other.from === this.from &&
      other.to === this.to &&
      JSON.stringify(other.rows) === JSON.stringify(this.rows) &&
      JSON.stringify(other.align) === JSON.stringify(this.align) &&
      JSON.stringify(other.rawRows) === JSON.stringify(this.rawRows)
    );
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-tablewrap";
    // 块起点随单元格写回不变，重建后凭它找回同一张表（导航聚焦、提交前冲刷都用它）
    wrap.dataset.tblFrom = String(this.from);

    const table = document.createElement("table");
    table.className = "cm-lp-table";

    // 列数取"分隔行管道段数"与各行单元格数的最大值：
    // lezer 对**只含空格的末尾单元格**不产出 TableCell 节点——不加这一步，
    // 「＋ 列」新加的空列会在渲染里隐形（实测 th 一直是 3）。
    const columnCount = Math.max(
      this.align.length,
      ...this.rows.map((row) => row.length),
      1,
    );

    const buildRow = (cells: TextRun[][], cellTag: "th" | "td", rowIndex: number) => {
      const tr = document.createElement("tr");
      tr.dataset.row = String(rowIndex);
      for (let index = 0; index < columnCount; index += 1) {
        const el = document.createElement(cellTag);
        const runs = cells[index];
        if (runs) appendRuns(el, runs);
        const align = this.align[index];
        if (align) el.style.textAlign = align;
        // 就地编辑：WebView2 基于 Chromium，支持 plaintext-only（粘贴自动去格式）
        el.contentEditable = "plaintext-only";
        el.spellcheck = false;
        // 右键结构菜单的委托靠这个类识别单元格
        el.classList.add(TABLE_CELL_CLASS);
        // 坐标随行走：写回时按它定位 (row, col)。曾把所有数据行都写成 1——
        // 编辑任何一行都会覆盖第一行，加行/加列后的编辑全军覆没
        el.dataset.row = String(rowIndex);
        el.dataset.col = String(index);
        // 单元格源码原文：聚焦含行内样式的单元格时切换到原文编辑（见 attachCellEvents）
        el.dataset.raw = this.rawRows[rowIndex]?.[index] ?? "";
        if (runs) cellRuns.set(el, runs);
        attachCellEvents(view, wrap, el);
        tr.appendChild(el);
      }
      return tr;
    };

    if (this.rows.length > 0) {
      const thead = document.createElement("thead");
      thead.appendChild(buildRow(this.rows[0], "th", 0));
      table.appendChild(thead);

      if (this.rows.length > 1) {
        const tbody = document.createElement("tbody");
        this.rows
          .slice(1)
          .forEach((row, index) => tbody.appendChild(buildRow(row, "td", index + 1)));
        table.appendChild(tbody);
      }
    }

    // Ctrl+A 两段式全选：第一次全选本格，第二次升级为**选中整张表**。
    // 跨格拖选在「单元格各自独立编辑宿主」的模型下会被浏览器钳在单格里
    // （Obsidian 用自研表格模型才做得到跨格选区），用两段式全选代替；
    // 单元格保持独立编辑宿主——表格宿主一旦 contenteditable，Chromium 会把
    // 焦点给表格而不是单元格，整套就地编辑就失效了（实测）。
    // 两段都手动 Range 并 preventDefault：原生的 Ctrl+A 选区会被 CM 的
    // DOM 观察者按文档选区重置掉（实测），靠不住。
    table.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const cell = selection.anchorNode?.parentElement?.closest<HTMLElement>("td,th");
      if (!cell || !table.contains(cell)) return;
      event.preventDefault();
      event.stopPropagation();
      const current = selection.getRangeAt(0);
      const cellRange = document.createRange();
      cellRange.selectNodeContents(cell);
      // 已全选本格（且本格非空）→ 升级为整表；否则全选本格
      const coversCell =
        current.toString() === cellRange.toString() && current.toString().trim() !== "";
      const range = document.createRange();
      range.selectNodeContents(coversCell ? table : cell);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    // 整表选择被复制时以选中文本为准——CM 的 copy 处理会按**文档选区**序列化源码，
    // widget 内部的 DOM 选区对它是没有意义的位置
    table.addEventListener("copy", (event) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!table.contains(range.commonAncestorContainer)) return;
      // 单格内的复制交给原生（plaintext-only 已经是纯文本）
      if (range.commonAncestorContainer.parentElement?.closest("td,th")) return;
      event.preventDefault();
      event.stopPropagation();
      event.clipboardData?.setData("text/plain", selection.toString());
    });

    // 点击表格空白处保持渲染：不把光标放进源码。单元格内的按下事件已在
    // attachCellEvents 里 stopPropagation，不会走到这里。
    table.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    // 双击单元格之外的空白退回源码（进阶编辑入口）；
    // 单元格内的双击是原生选词，不触发
    wrap.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest("td,th")) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      view.dispatch({
        selection: { anchor: Math.min(this.from + 1, view.state.doc.length) },
      });
      view.focus();
    });

    // 宽表的横向滚动在内层 .cm-tb-scroll 上——右缘悬挑的「＋ 列」钮绝不能落进
    // 滚动容器，否则它负偏移造成的溢出会让 wrap 常驻一条横向滚动条（实测踩过）。
    const scroll = document.createElement("div");
    scroll.className = "cm-tb-scroll";
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    // 底部「＋ 行」/ 右缘「＋ 列」：点击行为走 document 级委托
    // （见 ensureTableOpsDelegate）——按钮会随 widget 重建，挂自身不可靠。
    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "cm-tb-addrow";
    addRow.textContent = "＋ 行";
    addRow.title = "在末尾添加一行";
    addRow.addEventListener("mousedown", (event) => event.preventDefault());
    wrap.appendChild(addRow);

    const addCol = document.createElement("button");
    addCol.type = "button";
    addCol.className = "cm-tb-addcol";
    addCol.textContent = "＋";
    addCol.title = "在末尾添加一列";
    addCol.addEventListener("mousedown", (event) => event.preventDefault());
    wrap.appendChild(addCol);

    // 「＋ 行 / ＋ 列」点击与右键结构菜单都走 document 级委托
    // （同一套委托理由：widget 会随结构变化整体重建，挂自身不可靠）。
    ensureTableOpsDelegate();
    ensureTableContextMenuDelegate();
    tableOps.set(wrap, { view });

    return wrap;
  }
}

/**
 * 表格结构按钮的注册表与 document 级委托。
 *
 * 按钮的 click 监听**不**挂在按钮自身：widget 在结构变化后会整体重建，
 * "重建与点击的竞态"下按钮处理函数会丢事件（实测 +列 按钮点到旧 DOM 的
 * 克隆时处理函数根本不触发）。委托到 document 一份，按钮怎么重建都能命中。
 */
const tableOps = new WeakMap<HTMLElement, { view: EditorView }>();
let tableOpsDelegateInstalled = false;

function ensureTableOpsDelegate(): void {
  if (tableOpsDelegateInstalled || typeof document === "undefined") return;
  tableOpsDelegateInstalled = true;
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const addRowBtn = target.closest(".cm-tb-addrow");
    const addColBtn = target.closest(".cm-tb-addcol");
    if (!addRowBtn && !addColBtn) return;
    const btn = (addRowBtn ?? addColBtn) as HTMLElement;
    const wrap = btn.closest(".cm-lp-tablewrap") as HTMLElement | null;
    const info = wrap ? tableOps.get(wrap) : undefined;
    if (!info) return;
    event.stopPropagation();
    withFlushedCellEdit(info.view, wrap as HTMLElement, (block) =>
      addRowBtn
        ? insertRow(block, block.rows.length - 1, [])
        : insertColumn(block, block.header.length),
    );
  });
}

/**
 * 表格单元格右键菜单（Obsidian 式）：插入/删除行列。
 *
 * 菜单 DOM 复用文件树右键菜单的 `.context-menu` / `.menu-backdrop`（fixed 定位，
 * z-index 覆盖全界面）。widget 的右键监听同样走 document 委托——重建竞态下依然命中。
 *
 * 行号口径：widget 的 dataset.row 里 0 = 表头，1..N = 数据行；而 table.ts 的
 * insertRow/deleteRow 用「数据行下标」（0 基），换算是 `widgetRow - 1`。
 */
function ensureTableContextMenuDelegate(): void {
  if (tableMenuDelegateInstalled || typeof document === "undefined") return;
  tableMenuDelegateInstalled = true;
  document.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const cell = target.closest("td,th");
    if (!cell || !cell.classList.contains("cm-lp-cell")) return;
    const wrap = cell.closest(".cm-lp-tablewrap") as HTMLElement | null;
    const info = wrap ? tableOps.get(wrap) : undefined;
    if (!info) return;
    event.preventDefault();
    event.stopPropagation();
    openTableMenu(
      event.clientX,
      event.clientY,
      info.view,
      wrap as HTMLElement,
      Number((cell as HTMLElement).dataset.row ?? "0"),
      Number((cell as HTMLElement).dataset.col ?? "0"),
    );
  });
}

let tableMenuDelegateInstalled = false;

/** 单元格挂上统一的类名，供右键委托识别（td/th 本身没有专属类）。 */
const TABLE_CELL_CLASS = "cm-lp-cell";

function openTableMenu(
  x: number,
  y: number,
  view: EditorView,
  wrap: HTMLElement,
  widgetRow: number,
  column: number,
): void {
  closeTableMenu();
  const dataRow = Math.max(widgetRow - 1, -1); // 数据行下标；表头行 → -1（插到最前）

  const backdrop = document.createElement("div");
  backdrop.className = "menu-backdrop";
  const menu = document.createElement("div");
  menu.className = "context-menu";

  const item = (label: string, danger: boolean, run: (block: TableBlock) => string[]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    if (danger) btn.className = "danger";
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTableMenu();
      withFlushedCellEdit(view, wrap, run);
    });
    menu.appendChild(btn);
  };

  item("在上方插入行", false, (block) => insertRow(block, dataRow - 1, []));
  item("在下方插入行", false, (block) => insertRow(block, dataRow, []));
  const delRow = menu.appendChild(document.createElement("button"));
  delRow.type = "button";
  delRow.textContent = "删除行";
  delRow.className = "danger";
  if (widgetRow < 1) delRow.disabled = true; // 表头行没有可删的数据行
  delRow.addEventListener("mousedown", (e) => e.preventDefault());
  delRow.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTableMenu();
    withFlushedCellEdit(view, wrap, (block) => deleteRow(block, dataRow));
  });
  item("在左侧插入列", false, (block) => insertColumn(block, column));
  item("在右侧插入列", false, (block) => insertColumn(block, column + 1));
  const delCol = menu.appendChild(document.createElement("button"));
  delCol.type = "button";
  delCol.textContent = "删除列";
  delCol.className = "danger";
  // 只剩一列时删无可删（deleteColumn 对此也是空操作，这里把入口置灰更清楚）
  const columnCount = wrap.querySelector("tr")?.children.length ?? 1;
  if (columnCount <= 1) delCol.disabled = true;
  delCol.addEventListener("mousedown", (e) => e.preventDefault());
  delCol.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTableMenu();
    withFlushedCellEdit(view, wrap, (block) => deleteColumn(block, column));
  });

  backdrop.addEventListener("mousedown", closeTableMenu);
  backdrop.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    closeTableMenu();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeTableMenu();
    }
  };
  document.addEventListener("keydown", onKey, true);
  tableMenuCleanup = () => {
    document.removeEventListener("keydown", onKey, true);
  };

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  tableMenuElements = [backdrop, menu];
  document.body.append(backdrop, menu);
  // 贴近视口右缘/下缘时往回收，避免菜单被裁掉
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) menu.style.left = `${Math.max(8, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - 8) menu.style.top = `${Math.max(8, y - rect.height)}px`;
}

let tableMenuCleanup: (() => void) | null = null;
let tableMenuElements: HTMLElement[] | null = null;

function closeTableMenu(): void {
  if (tableMenuElements) {
    for (const el of tableMenuElements) el.remove();
    tableMenuElements = null;
  }
  tableMenuCleanup?.();
  tableMenuCleanup = null;
}

// ---------------------------------------------------------------- 单元格就地编辑

/** 本轮编辑已提交过的单元格：blur 与程序性导航会让提交触发两次。 */
const committedCells = new WeakSet<HTMLElement>();

/** 每个单元格的渲染 runs：Esc 取消编辑时恢复渲染态（切原文后 innerText 已是原文）。 */
const cellRuns = new WeakMap<HTMLElement, TextRun[]>();

/**
 * 单元格的事件：聚焦记原文，keydown 处理导航与非法字符，失焦提交。
 *
 * mousedown 只 stopPropagation 不 preventDefault——前者拦住 CodeMirror 的
 * 选区处理（否则选区落进被替换区间，整张表退回源码），后者保留浏览器
 * 自己放光标、拖选的能力。
 */
function attachCellEvents(view: EditorView, wrap: HTMLElement, cell: HTMLElement): void {
  cell.addEventListener("mousedown", (event) => event.stopPropagation());

  cell.addEventListener("focus", () => {
    // 新一轮编辑：清掉上一轮的提交标记，否则改过的内容在 blur 时不会写回
    committedCells.delete(cell);
    // 含行内样式的单元格（`code`、**粗体** 等被渲染成了元素）先切到**原文**编辑：
    // 直接以渲染态的 innerText 写回会把 `` ` `` / `**` 丢掉（等于静默破坏语法）。
    // 纯文本单元格 raw 与显示一致，交换是无感的。
    if (cell.children.length > 0 && cell.dataset.raw) {
      // 记录光标在显示文本中的偏移，切原文后按偏移落位（近似映射）
      let offset = 0;
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && cell.contains(sel.anchorNode)) {
        const probe = document.createRange();
        probe.selectNodeContents(cell);
        probe.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
        offset = probe.toString().length;
      }
      cell.textContent = cell.dataset.raw;
      const placed = document.createRange();
      placed.selectNodeContents(cell);
      placed.collapse(true);
      // 只有一个文本节点，直接按偏移折叠光标（钳到原文长度内）
      const node = cell.firstChild;
      if (node) {
        try {
          placed.setStart(node, Math.min(offset, (node.textContent ?? "").length));
          placed.collapse(true);
        } catch {
          // 偏移越界等异常：保持光标在行首
        }
      }
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(placed);
    }
    cell.dataset.orig = cell.innerText;
  });

  cell.addEventListener("keydown", (event) => {
    // 输入法组词期间按键的 key 是 "Process"、Enter 是"确认候选"——都不是编辑指令，
    // 必须放行给 IME，否则中文输入打到一半回车会变成"提交并跳格"。
    if (event.isComposing || event.keyCode === 229) return;
    // 竖线会破坏源码里的表格结构（本表格模型不支持转义），直接拦下；
    // 换行同理——管道表格的单元格是单行的。
    if (event.key === "|") {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commitCellEdit(view, wrap, cell);
      const row = Number(cell.dataset.row ?? "0");
      const col = cell.dataset.col ?? "0";
      // 下方有格就跳过去；没有就在原位（重建后凭坐标找回）
      const below = findCell(wrap, row + 1, col) ? row + 1 : row;
      refocusAfterCommit(view, wrap, String(below), col);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      const next = stepCell(wrap, cell, step);
      commitCellEdit(view, wrap, cell);
      if (next) {
        refocusAfterCommit(view, wrap, next.dataset.row ?? "0", next.dataset.col ?? "0");
      } else {
        // 最后一个单元格再 Tab：停在原位（Obsidian 会加行，这里保守一点）
        refocusAfterCommit(view, wrap, cell.dataset.row ?? "0", cell.dataset.col ?? "0");
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (cell.dataset.orig !== undefined) {
        // 恢复**渲染态**：切原文后 orig 存的是原文，直接写回会让格子停在原文显示
        const runs = cellRuns.get(cell);
        if (runs) {
          cell.textContent = "";
          appendRuns(cell, runs);
        } else {
          cell.innerText = cell.dataset.orig;
        }
      }
      // 标记为已提交：Esc 的语义是「放弃编辑」，但恢复渲染态后 innerText 是
      // 渲染文本、与源码原文不等——紧随其后的 blur 会把标记吃掉变成一次提交，
      // 把 `**粗体**` 写成粗体。先占住 committedCells，blur 就不会再走提交。
      committedCells.add(cell);
      cell.blur();
    }
  });

  cell.addEventListener("blur", () => commitCellEdit(view, wrap, cell));
}

/** 把编辑后的单元格写回源码（整块替换、管道重新对齐）。没改或已提交过就跳过。 */
function commitCellEdit(view: EditorView, wrap: HTMLElement, cell: HTMLElement): void {
  if (committedCells.has(cell)) return;
  committedCells.add(cell);

  const orig = (cell.dataset.orig ?? "").trim();
  const raw = cell.innerText.replace(/\r?\n/g, " ").replace(/\|/g, "").trim();
  if (raw === orig) {
    // 切到原文编辑后没改就失焦：把渲染态恢复回来，否则格子会一直停在
    // `**粗体**` 这样的源码显示（widget 不重建，没人替它换回去）。
    const runs = cellRuns.get(cell);
    if (runs && cell.children.length === 0) {
      cell.textContent = "";
      appendRuns(cell, runs);
    }
    return; // 没改：不动文档，widget 也就不用重建
  }

  const row = Number(cell.dataset.row ?? "0");
  const col = Number(cell.dataset.col ?? "0");
  replaceTableCell(view, wrap, (block) => {
    const normalized = normalizeColumns(block);
    if (row === 0) normalized.header[col] = raw;
    else if (normalized.rows[row - 1]) normalized.rows[row - 1][col] = raw;
    return formatTable(normalized);
  });
}

/**
 * 冲刷正在编辑的单元格后，对同一张表执行一次整块结构替换。
 *
 * 顺序很重要：先提交单元格（一次 dispatch，widget 同步重建），再对**新**的
 * wrap 定位做结构变换（第二次 dispatch）——结构变换若读旧源码，刚敲的字就丢了。
 */
function withFlushedCellEdit(
  view: EditorView,
  wrap: HTMLElement,
  transform: (block: TableBlock) => string[],
): void {
  const active = document.activeElement;
  // 只冲刷**单元格**。表格宿主本身也是 contentEditable（跨格选区用），
  // 焦点落在宿主上时没有"正在编辑的单元格"可言
  const editing =
    active instanceof HTMLElement &&
    (active.tagName === "TD" || active.tagName === "TH") &&
    wrap.contains(active)
      ? active
      : null;
  if (editing) commitCellEdit(view, wrap, editing);
  // 提交已触发重建：换上重建后的 wrap（凭块起点找回），拿不到就退回旧的
  const fromKey = wrap.dataset.tblFrom;
  const fresh = fromKey
    ? (view.dom.querySelector(`.cm-lp-tablewrap[data-tbl-from="${fromKey}"]`) as HTMLElement | null)
    : null;
  replaceTableCell(view, fresh ?? wrap, transform);
}

/** 对 widget 覆盖的表格块执行一次整块替换。起点从当前 DOM 位置取，避免陈旧的 from。 */
function replaceTableCell(
  view: EditorView,
  wrap: HTMLElement,
  transform: (block: TableBlock) => string[],
): void {
  let pos: number;
  try {
    pos = view.posAtDOM(wrap);
  } catch {
    return; // widget 已被替换/移除，无从写回
  }

  const first = view.state.doc.lineAt(pos);
  let last = first;
  for (;;) {
    if (last.number >= view.state.doc.lines) break;
    const next = view.state.doc.line(last.number + 1);
    if (!isTableLineText(next.text)) break;
    last = next;
  }
  const lines: string[] = [];
  for (let n = first.number; n <= last.number; n += 1) lines.push(view.state.doc.line(n).text);
  const block = parseTableBlock(lines);
  if (!block) return;
  const newLines = transform(block);
  view.dispatch({
    changes: { from: first.from, to: last.to, insert: newLines.join(view.state.lineBreak) },
  });
}

function isTableLineText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

/** 按坐标找单元格（th/td 都算）。 */
function findCell(wrap: HTMLElement, row: number, col: string | number): HTMLElement | null {
  return wrap.querySelector(`[data-row="${row}"][data-col="${col}"]`);
}

/** 行主序的下一个/上一个单元格（DOM 顺序即行主序）。 */
function stepCell(wrap: HTMLElement, cell: HTMLElement, delta: 1 | -1): HTMLElement | null {
  const cells = Array.from(wrap.querySelectorAll("td,th")) as HTMLElement[];
  const index = cells.indexOf(cell);
  return cells[index + delta] ?? null;
}

/** 聚焦单元格并全选内容：Tab 跳格后直接输入即可覆盖，与 Obsidian 一致。 */
function focusCell(cell: HTMLElement | null): void {
  if (!cell) return;
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * 提交会触发 widget 重建、旧 DOM（连同其中的焦点）被丢弃；这里在重建完成后
 * 凭「块起点 + 单元格坐标」找回新 DOM 里的目标单元格并聚焦。
 */
function refocusAfterCommit(
  view: EditorView,
  wrap: HTMLElement,
  row: string,
  col: string,
): void {
  const fromKey = wrap.dataset.tblFrom;
  requestAnimationFrame(() => {
    if (!fromKey) return;
    const fresh = view.dom.querySelector(
      `.cm-lp-tablewrap[data-tbl-from="${fromKey}"] [data-row="${row}"][data-col="${col}"]`,
    );
    focusCell(fresh as HTMLElement | null);
  });
}

/** 从 Table 语法节点提取表格内容与对齐方式。 */
function parseTable(state: EditorState, table: SyntaxNode): ParsedTable {
  const rows: TextRun[][][] = [];
  const raw: string[][] = [];
  let align: (null | "left" | "center" | "right")[] = [];
  let delimiterLine = "";

  const cellsOf = (parent: SyntaxNode): TextRun[][] => {
    const out: TextRun[][] = [];
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.name === "TableCell") {
        out.push(flattenInline(state, child, EMPTY_FLAGS));
      }
    }
    return out;
  };

  const rawCellsOf = (parent: SyntaxNode): string[] => {
    const out: string[] = [];
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.name === "TableCell") {
        out.push(state.doc.sliceString(child.from, child.to).trim());
      }
    }
    return out;
  };

  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader") {
      rows.push(cellsOf(child));
      raw.push(rawCellsOf(child));
    } else if (child.name === "TableRow") {
      rows.push(cellsOf(child));
      raw.push(rawCellsOf(child));
    } else if (child.name === "TableDelimiter") {
      // 分隔行是 Table 的直接子节点，整行一个节点，从中读对齐方式。
      delimiterLine = state.doc.sliceString(child.from, child.to);
      // 分隔行的**全部**内部段都算列（含空段=无对齐的新列）——
      // 只数非空段会让"＋ 列"新增的空列在渲染里隐形
      const segments = delimiterLine.split("|").slice(1, -1).map((cell) => cell.trim());
      align = segments.map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (left) return "left";
        if (right) return "right";
        return null;
      });
    }
  }

  return { rows, align, raw, delimiterLine };
}

/** 图片加载不出来时的降级显示。 */
function imageChip(alt: string, target: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "cm-lp-image-chip";
  chip.textContent = `🖼 ${alt || target}`;
  chip.title = target;
  return chip;
}

/** 外部链接的 mark 装饰：带 title 提示，便于发现 Ctrl+点击的用法。 */
function externalLinkMark(url: string): Decoration {
  return Decoration.mark({
    class: "cm-lp-link",
    attributes: { title: `Ctrl+点击用系统浏览器打开：${url}` },
  });
}

/** 一段 Obsidian wiki 语法的匹配结果。 */
interface WikiMatch {
  from: number;
  to: number;
  /** `![[...]]` 为 true，`[[...]]` 为 false。 */
  embed: boolean;
  target: string;
  /** `|` 之后的部分：链接的别名，或图片的宽度数字。 */
  label: string;
}

/**
 * 找出范围内的 Obsidian wiki 语法。
 *
 * lezer 的 Markdown 解析器不认识 `[[...]]`，会把它拆成奇怪的嵌套——`![[x.png]]`
 * 会变成一个**目标为空**的 Image 节点（这正是"图片显示成 `[Pasted image ...]`
 * 占位标签"的原因）。所以这类语法必须自己用正则找，并屏蔽解析器为它生成的节点，
 * 否则会被两套逻辑重复处理。
 *
 * 行内代码与代码块里的 `[[...]]` 不算语法。
 */
function findWikiSyntax(
  doc: { sliceString(from: number, to: number): string },
  from: number,
  to: number,
  excluded: Array<[number, number]>,
): WikiMatch[] {
  const text = doc.sliceString(from, to);
  const pattern = /(!?)\[\[([^\]\n]+?)\]\]/g;
  const out: WikiMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = from + match.index;
    const end = start + match[0].length;
    if (excluded.some(([a, b]) => start < b && end > a)) continue;
    const [target, ...rest] = match[2].split("|");
    out.push({
      from: start,
      to: end,
      embed: match[1] === "!",
      target: target.trim(),
      label: rest.join("|").trim(),
    });
  }
  return out;
}

/** `笔记#小节` → `笔记 › 小节`，用于嵌入标签的显示。 */
function wikiDisplayText(target: string): string {
  const cleaned = target.replace(/\^[^\s]*$/, "");
  const hash = cleaned.indexOf("#");
  if (hash < 0) return cleaned;
  const note = cleaned.slice(0, hash);
  const section = cleaned.slice(hash + 1);
  return section ? `${note} › ${section}` : note;
}

/** 内联图片。
 *
 * `local` 是本地绝对路径（仓库内），渲染时才转成 asset URL——`convertFileSrc`
 * 依赖 `window`，不能在装饰计算阶段调用（那样单元测试就没法在 Node 里跑）。
 * 文件缺失或目录未授权时 `error` 事件会把它降级成标签，避免留一个破图。
 *
 * 0.5 渲染增强：本地图悬停出工具栏（复制/裁剪/重命名/删除，动作由 App 经上下文
 * 注入）；`epoch` 参与相等性判断，裁剪覆写文件后靠它强制重建 <img> 绕过缓存。
 */
let imageEpoch = 0;

/** 二进制文件被覆写（裁剪）后调用：所有已渲染图片按新文件重载。 */
export function bumpImageEpoch(): void {
  imageEpoch += 1;
}

class ImageWidget extends WidgetType {
  readonly remote: string | null;
  readonly local: string | null;
  readonly alt: string;
  readonly target: string;
  /** `![[图.png|200]]` 里的宽度（像素）；没有就是 null。 */
  readonly width: number | null;
  /** 仓库相对路径；远程资源或解析不出时为 null（此时不挂工具栏）。 */
  readonly relativePath: string | null;

  constructor(
    remote: string | null,
    local: string | null,
    alt: string,
    target: string,
    width: number | null = null,
    relativePath: string | null = null,
  ) {
    super();
    this.remote = remote;
    this.local = local;
    this.alt = alt;
    this.target = target;
    this.width = width;
    this.relativePath = relativePath;
  }

  eq(other: ImageWidget) {
    return (
      other.remote === this.remote &&
      other.local === this.local &&
      other.alt === this.alt &&
      other.target === this.target &&
      other.width === this.width &&
      other.relativePath === this.relativePath &&
      other.epoch === this.epoch
    );
  }

  get epoch() {
    return imageEpoch;
  }

  toDOM(view: EditorView) {
    // 根节点用容器固定下来，只替换它的子节点。
    // 不能在 error 里替换 widget 的根节点——CM6 持有该节点的引用，
    // 换掉它会让 CM6 的 DOM 记账失效（表现为降级标签根本不出现）。
    const box = document.createElement("span");
    const source = this.local ? convertFileSrc(this.local) : this.remote;
    if (!source) {
      box.appendChild(imageChip(this.alt, this.target));
      return box;
    }

    const img = document.createElement("img");
    img.className = "cm-lp-image";
    img.alt = this.alt;
    img.title = this.target;
    if (this.width !== null) img.style.width = `${this.width}px`;
    // 图片从 0 高涨到真实高度：必须通知 CM 重新测量，否则高度图停在第 0 帧上，
    // 下方的行号、点击落点、选区全部按旧几何算——整体往下漂移。error 分支
    // （降级成标签）高度同样会变，一并重测。isConnected 守卫：事件触发时
    // widget 可能已被移除。
    img.addEventListener("load", () => {
      if (box.isConnected) view.requestMeasure();
    });
    // 文件不存在或目录未授权时退化成标签，避免留一个破图。
    img.addEventListener("error", () => {
      box.replaceChildren(imageChip(this.alt, this.target));
      if (box.isConnected) view.requestMeasure();
    });
    // asset 协议按完整 URL 缓存：带上代际，裁剪覆写后立刻看到新图
    img.src = this.local ? `${source}?v=${imageEpoch}` : source;
    box.appendChild(img);

    const actions = view.state.facet(livePreviewContext).imageActions;
    if (actions && this.relativePath && this.local) {
      box.classList.add("cm-lp-imgbox");
      const bar = document.createElement("div");
      bar.className = "qn-img-toolbar";
      const mk = (text: string, title: string, run: () => void) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "qn-img-btn";
        btn.title = title;
        btn.textContent = text;
        // 工具栏点击不能落进编辑器（否则光标跳动、本行退回源码）
        btn.addEventListener("mousedown", (event) => event.preventDefault());
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          run();
        });
        bar.appendChild(btn);
      };
      mk("⧉", "复制图片到剪贴板", () => actions.copy(this.relativePath!));
      mk("✂", "裁剪图片", () => actions.crop(this.relativePath!));
      mk("✎", "重命名（同步更新引用）", () => actions.rename(this.relativePath!));
      mk("🗑", "删除（并清理笔记里的引用）", () => actions.remove(this.relativePath!));
      box.appendChild(bar);
    }
    return box;
  }
}

/**
 * `![[某笔记]]`：把目标笔记的内容渲染进来（内容嵌入 / transclusion）。
 *
 * 渲染是异步的（要读文件、按需加载 markdown-it），所以先占位再填充——与 mermaid 同一套路。
 * `generation` 参与 `eq`：索引或文件内容变化后旧 widget 会被判定为"不等"，CM6 重建 DOM
 * 并重新渲染；否则目标笔记改了、界面上还是旧内容。
 */
class NoteEmbedWidget extends WidgetType {
  readonly text: string;
  readonly target: string;
  readonly generation: number;

  constructor(text: string, target: string, generation: number) {
    super();
    this.text = text;
    this.target = target;
    this.generation = generation;
  }

  eq(other: NoteEmbedWidget) {
    return (
      other.text === this.text &&
      other.target === this.target &&
      other.generation === this.generation
    );
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-lp-embed is-loading";
    // 目标写在属性上：调试与自动化测试都要靠它区分同一篇笔记的不同嵌入方式
    box.dataset.embedTarget = this.target;
    box.textContent = `正在嵌入「${this.text}」…`;

    // 点击回到源码编辑：把光标放到嵌入语法的位置，本行随即显示源码
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
      view.focus();
    });

    void renderEmbeddedNote(view.state.facet(livePreviewContext), this.target).then((html) => {
      box.classList.remove("is-loading");
      box.innerHTML = html;
      // 嵌入内容比占位文字高得多：重测高度，别让下方行的几何停在占位尺寸上
      if (box.isConnected) view.requestMeasure();
      // 嵌入渲染出的 HTML 里可能带图片：加载完成还会再变一次高度
      for (const image of Array.from(box.querySelectorAll("img"))) {
        image.addEventListener("load", () => {
          if (box.isConnected) view.requestMeasure();
        });
      }
    });

    return box;
  }
}

// ---------------------------------------------------------------- 装饰计算

interface BuildContext {
  state: EditorState;
  /** 选区覆盖到的行号，这些行显示源码不做隐藏。 */
  activeLines: Set<number>;
  /** 选区是否触及 [from, to]（按位置而非行——标题标记只在光标真落在标记区时显形）。 */
  touched: (from: number, to: number) => boolean;
  /**
   * 光标（折叠选区）是否落在 [from, to] 内。行内元素（粗体、行内代码、链接…）
   * 的源码显隐用它：曾经按「光标在本行」判断，点行内代码会把**整行**的
   * `**`、`` ` `` 全部恢复成源码——Obsidian 只展开光标所在的那个元素。
   */
  cursorIn: (from: number, to: number) => boolean;
}

/** 节点是否与当前选区同处一行（同行则显示源码）。 */
function isActive(ctx: BuildContext, from: number, to: number): boolean {
  const doc = ctx.state.doc;
  const startLine = doc.lineAt(from).number;
  const endLine = doc.lineAt(to).number;
  for (let n = startLine; n <= endLine; n += 1) {
    if (ctx.activeLines.has(n)) return true;
  }
  return false;
}

/**
 * 计算整个（或视口范围内的）装饰集。
 *
 * 纯函数，不触碰 DOM，可直接单测。
 */
export function buildLivePreviewDecorations(
  state: EditorState,
  from: number,
  to: number,
  resources: LivePreviewContext = EMPTY_CONTEXT,
): DecorationSet {
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const a = state.doc.lineAt(range.from).number;
    const b = state.doc.lineAt(range.to).number;
    for (let n = a; n <= b; n += 1) activeLines.add(n);
  }
  const ctx: BuildContext = {
    state,
    activeLines,
    touched: (from, to) =>
      state.selection.ranges.some((range) => range.from <= to && range.to >= from),
    cursorIn: (from, to) =>
      state.selection.ranges.some((range) => range.empty && range.from >= from && range.to <= to),
  };

  const marks: Range<Decoration>[] = [];
  const replaces: Range<Decoration>[] = [];

  const hide = (from: number, to: number) => {
    if (to > from) replaces.push(HIDE.range(from, to));
  };
  const replaceWith = (from: number, to: number, widget: WidgetType) => {
    if (to > from) replaces.push(Decoration.replace({ widget }).range(from, to));
  };

  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
  const doc = state.doc;

  // 先收集"不要把里面的东西当语法"的区域：代码块、行内代码，以及手写 HTML 块。
  // HTML 块里的 `[[...]]`、`$...$` 也不该被解析——那不是 Markdown。
  const excluded: Array<[number, number]> = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (
        node.name === "FencedCode" ||
        node.name === "InlineCode" ||
        node.name === "CodeBlock" ||
        node.name === "HTMLBlock"
      ) {
        excluded.push([node.from, node.to]);
        return false;
      }
      return undefined;
    },
  });

  const slice = doc.sliceString(from, to);

  // 手写 HTML 最先注册：它是最外层的结构，重叠时应当由它接管
  // （例如 `<font color=red>[[某笔记]]</font>` 整段归 HTML）。
  const htmlSpans = findInlineHtml(slice, from, excluded);
  for (const item of htmlSpans) {
    if (ctx.cursorIn(item.from, item.to)) continue; // 光标在该元素内才显示源码
    replaceWith(item.from, item.to, new HtmlWidget(item.inner));
  }

  // Obsidian 的 `[[...]]` / `![[...]]` 解析器不认识，得自己找。
  const wiki = findWikiSyntax(doc, from, to, excluded);
  const inWiki = (a: number, b: number) => wiki.some((w) => a < w.to && b > w.from);

  // wiki 语法先注册：去重时它要优先于解析器为它生成的那些节点。
  for (const item of wiki) {
    // 只有点进括号区（`[[` / `![[` / `]]`）才显出源码；点链接文字保持渲染——
    // 整个 item 一个区间的话，点文字也会让括号弹出来、文字横移
    const bracketHit =
      ctx.cursorIn(item.from, item.from + (item.embed ? 3 : 2)) ||
      ctx.cursorIn(item.to - 2, item.to);
    if (bracketHit) continue; // 光标在该元素内才显示源码

    if (item.embed) {
      if (IMAGE_EXT.test(item.target)) {
        const { remote, local } = resolveWikiTarget(resources, item.target);
        const relative = resolveWikiRelative(resources, item.target);
        // `![[图.png|200]]` 里的数字是宽度，不是说明文字
        const numeric = /^\d+$/.test(item.label);
        replaceWith(
          item.from,
          item.to,
          new ImageWidget(
            remote,
            local,
            numeric ? "" : item.label,
            item.target,
            numeric ? Number(item.label) : null,
            relative,
          ),
        );
      } else {
        // 笔记嵌入：把目标笔记的内容渲染进来
        replaceWith(
          item.from,
          item.to,
          new NoteEmbedWidget(wikiDisplayText(item.target), item.target, resources.generation),
        );
      }
      continue;
    }

    // wiki 链接：只隐藏方括号，文字保留为可编辑文本（比换成 widget 更贴近 Obsidian）
    const source = doc.sliceString(item.from, item.to);
    const pipe = item.label ? source.indexOf("|") : -1;
    const textFrom = item.from + (pipe >= 0 ? pipe + 1 : 2);
    const textTo = item.to - 2;
    if (textTo > textFrom) {
      hide(item.from, textFrom);
      hide(textTo, item.to);
      // 带 data-wiki-target：Alt+点击在资源管理器中定位目标文件
      marks.push(
        Decoration.mark({
          class: "cm-lp-link",
          attributes: { "data-wiki-target": item.target, title: "Alt+点击在资源管理器中定位文件" },
        }).range(textFrom, textTo),
      );
    }
  }

  // 行内公式 `$...$`（21% 的笔记里都有，见 docs/M1-实现说明.md 的统计）
  // 后续扫描器要跳过已被 HTML / wiki 语法接管的区间：那些内容整体被替换掉了，
  // 里面的 `$`、`#` 都不是语法（例如 <font color="#c00"> 里的 "#c00"）。
  const taken: Array<[number, number]> = [
    ...excluded,
    ...htmlSpans.map((item) => [item.from, item.to] as [number, number]),
    ...wiki.map((item) => [item.from, item.to] as [number, number]),
  ];

  for (const item of findInlineMath(slice, from, taken)) {
    if (ctx.cursorIn(item.from, item.to)) continue;
    replaceWith(item.from, item.to, mathWidgetFor(item));
  }

  // 高亮 `==文字==`：藏掉两侧的 `==`，给文字加底色
  for (const item of findHighlights(slice, from, taken)) {
    if (ctx.cursorIn(item.from, item.to)) continue;
    hide(item.from, item.from + 2);
    hide(item.to - 2, item.to);
    if (item.to - 2 > item.from + 2) {
      marks.push(MARK.highlight.range(item.from + 2, item.to - 2));
    }
  }

  // 注释 `%%...%%`：整段隐藏（只处理单行——跨行替换换行符是插件不允许的）。
  // 光标移到本行时会显示源码，所以不会"找不回"。
  for (const item of findComments(slice, from, taken)) {
    if (ctx.cursorIn(item.from, item.to)) continue;
    hide(item.from, item.to);
  }

  // 标签 `#标签`：加个弱化的底色，与正文区分（点击跳转尚未实现）
  for (const item of findTags(slice, from, taken)) {
    if (ctx.cursorIn(item.from, item.to)) continue;
    marks.push(
      Decoration.mark({
        class: "cm-lp-tag",
        attributes: { title: `标签 #${item.name}` },
      }).range(item.from, item.to),
    );
  }

  // 当前正在下沉的 callout 块（内层在外）。QuoteMark 用它判断要不要让路，
  // Link 用它识别 `[!type]` 标记；按范围比对，leave 时弹栈。
  const calloutStack: Array<{ from: number; to: number }> = [];
  const inCallout = () => calloutStack.length > 0;

  tree.iterate({
    from,
    to,
    enter: (node) => {
      const name = node.name;
      const hidden = (a: number, b: number) => {
        if (!isActive(ctx, node.from, node.to)) hide(a, b);
      };

      // 行内「标记+内容」：把两侧标记藏起来，给内容加样式。
      // 定界符取「第一个与最后一个 Mark 子节点」而不是第1、2个子节点：
      // **加粗 `代码`** 的第二个子节点是 InlineCode，旧判断会整体失灵，
      // `**` 直接露出（实测踩过）。处理完定界符后继续下沉子节点，
      // 嵌套的行内代码仍会走自己的分支。光标落在哪个元素，就只展开哪个元素。
      const inlineMark = INLINE_MARKS[name];
      if (inlineMark) {
        const firstMark =
          node.node.firstChild?.name.endsWith("Mark") ? node.node.firstChild : null;
        let lastMark: SyntaxNode | null = null;
        for (let c = node.node.lastChild; c; c = c.prevSibling) {
          if (c.name.endsWith("Mark")) {
            lastMark = c;
            break;
          }
        }
        if (firstMark && lastMark && lastMark.from > firstMark.to && !ctx.cursorIn(node.from, node.to)) {
          hide(firstMark.from, firstMark.to);
          hide(lastMark.from, lastMark.to);
          if (lastMark.from > firstMark.to) marks.push(inlineMark.range(firstMark.to, lastMark.from));
        }
        return undefined;
      }

      switch (name) {
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6": {
          const level = Number(name.slice(-1));
          const line = doc.lineAt(node.from);
          marks.push(LINE_CLASS[level].range(line.from));
          const headerMark = node.node.firstChild;
          if (headerMark?.name === "HeaderMark") {
            // 连同标记后的一个空格一起隐藏，否则标题会残留一个缩进。
            let end = headerMark.to;
            if (doc.sliceString(end, end + 1) === " ") end += 1;
            // 标记只在光标真的落在标记区时显形（按位置判断；行级判断会让
            // 光标一进标题行 `#### ` 就冒出来、整行文字右移，拖选/双击锚点
            // 全部错位——表现成「标题选不中」。Obsidian 的标题在光标行保持渲染。）
            if (!ctx.touched(headerMark.from, end)) hide(headerMark.from, end);
          }
          // 继续下沉：标题里的行内代码/粗体/链接也要走各自的渲染分支
          // （曾经 return false 挡住子节点，标题内的 `code` 一直以原文示人）。
          return undefined;
        }

        case "Link": {
          // `[[笔记]]` 会被解析器拆成一个内层 Link，这里不处理，交给 wiki 分支。
          if (inWiki(node.from, node.to)) return false;
          // callout 的 `[!type]` 标记也会被解析成（无 URL 的）Link，但标签替换
          // 归 Blockquote 的 callout 分支管；这里再藏括号会跟 widget 替换抢区间。
          if (inCallout() && /^\s*\[![a-zA-Z][a-zA-Z0-9-]*\]\s*$/.test(doc.sliceString(node.from, node.to))) {
            return false;
          }
          const open = node.node.firstChild;
          const close = open?.nextSibling;
          if (
            open?.name === "LinkMark" &&
            close?.name === "LinkMark" &&
            !ctx.cursorIn(node.from, node.to)
          ) {
            hide(open.from, open.to);
            // 从 `]` 一路藏到节点末尾，覆盖 `](url)`。
            hide(close.from, node.to);
            if (close.from > open.to) {
              const urlNode = node.node.getChild("URL");
              const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
              marks.push(
                isExternalUrl(url)
                  ? externalLinkMark(url).range(open.to, close.from)
                  : MARK.link.range(open.to, close.from),
              );
            }
          }
          return false;
        }

        case "URL": {
          // 裸链接（GFM 自动链接）：`https://…` 直接出现在正文里。
          // Link 内部的 URL 由上面那个分支一起处理，这里跳过。
          if (node.node.parent?.name === "Link") return false;
          if (ctx.cursorIn(node.from, node.to)) return false;
          const bare = doc.sliceString(node.from, node.to);
          if (!isExternalUrl(bare)) return false;
          marks.push(externalLinkMark(bare).range(node.from, node.to));
          return false;
        }

        case "SetextHeading1":
        case "SetextHeading2": {
          // setext 标题：正文在上一行，`=====` / `-----` 是下一行的 HeaderMark
          const level = name === "SetextHeading1" ? 1 : 2;
          const textLine = doc.lineAt(node.from);
          marks.push(LINE_CLASS[level].range(textLine.from));
          const headerMark = node.node.firstChild;
          // 下划线行只在光标真的落在那一行（按位置判断）时显形，与 ATX 同理
          if (
            headerMark?.name === "HeaderMark" &&
            !ctx.touched(headerMark.from, headerMark.to)
          ) {
            hide(headerMark.from, headerMark.to);
            // 下划线独占一行，藏掉文字后还要把行高压掉，否则留一条空行
            marks.push(
              Decoration.line({ class: "cm-lp-collapsed" }).range(doc.lineAt(headerMark.from).from),
            );
          }
          return undefined;
        }

        case "Blockquote": {
          const firstLine = doc.lineAt(node.from);
          const info = parseCalloutLine(
            doc.sliceString(firstLine.from, firstLine.to),
            firstLine.from,
          );
          if (!info) return undefined; // 普通引用：交给下面的 QuoteMark 分支

          // 整块加容器样式（按类型区分颜色）。这是逐行装饰：行级 margin/圆角会把
          // 多行 callout 拆成一摞小方块（行间缝 + 每行圆角缺口），所以外边距与
          // 圆角只挂在首尾行（cm-lp-callout-first/last，CSS 见 styles.css）。
          const lastLineNumber = doc.lineAt(node.to).number;
          for (let n = firstLine.number; n <= lastLineNumber; n += 1) {
            const edge =
              n === firstLine.number
                ? " cm-lp-callout-first"
                : n === lastLineNumber
                  ? " cm-lp-callout-last"
                  : "";
            marks.push(
              Decoration.line({ class: `cm-lp-callout cm-lp-callout-${info.type}${edge}` }).range(
                doc.line(n).from,
              ),
            );
          }

          // 标签只在光标落到**首行**时显源码（逐行揭示，对齐 Obsidian）：
          // 光标在正文行时标签保持渲染，其余行照常显示。
          if (!isActive(ctx, info.markerFrom, info.markerTo)) {
            replaceWith(
              info.markerFrom,
              info.markerTo,
              new CalloutLabelWidget(info.type, info.title),
            );
            if (info.titleTo > info.titleFrom) {
              marks.push(
                Decoration.mark({ class: "cm-lp-callout-title" }).range(info.titleFrom, info.titleTo),
              );
            }
          }

          // 记入 callout 栈并**继续下沉子节点**：callout 里同样要渲染列表（序号、
          // 任务框）、行内样式。`>` 标记仍由 QuoteMark 分支藏，但它要据此让路——
          // 不再叠加 cm-lp-quote 引用样式（否则同一行两套容器样式打架）。
          calloutStack.push({ from: node.from, to: node.to });
          return undefined;
        }

        case "Image": {
          // `![[图.png]]` 是 wiki 嵌入，由上面的 wiki 分支处理（解析器给它的目标是空的）。
          if (inWiki(node.from, node.to)) return false;
          if (ctx.cursorIn(node.from, node.to)) return false;
          const alt = doc.sliceString(node.from, node.to);
          const urlNode = node.node.getChild("URL");
          const target = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
          const altText = alt.replace(/^!\[/, "").split("]")[0] ?? "";
          const { remote, local } = resolveResource(resources, target);
          const relative = resolveResourceRelative(resources, target);
          replaceWith(
            node.from,
            node.to,
            new ImageWidget(remote, local, altText, target, null, relative),
          );
          return false;
        }

        case "HorizontalRule": {
          if (isActive(ctx, node.from, node.to)) return false;
          // 只替换 `---` 本身，保留行尾换行——该行渲染出来就是一个 <hr>。
          //
          // 这里**不能**用块级替换：CM6 禁止插件产生块级装饰
          // （"Block decorations may not be specified via plugins"），
          // 一旦使用会让整个装饰集抛异常、编辑器直接空白。
          replaceWith(node.from, node.to, new RuleWidget());
          return false;
        }

        case "ListMark": {
          const item = node.node.parent;
          if (!item) return false;
          const grand = item.parent;
          const hasTask = item.getChild("Task") !== null;
          if (hasTask) {
            // 任务项由复选框代表，项目符号隐藏。
            hidden(node.from, node.to);
          } else if (grand?.name === "BulletList") {
            if (!isActive(ctx, node.from, node.to)) {
              replaceWith(node.from, node.to, new BulletWidget());
            }
          } else if (grand?.name === "OrderedList" && !isActive(ctx, node.from, node.to)) {
            // 序号（1. 2. …）保持原文（编号由源码决定，不能替换），只加标记样式：
            // 与圆点同色，序号看起来是「渲染过的列表标记」而不是普通正文。
            marks.push(OL_MARK.range(node.from, node.to));
          }
          return false;
        }

        case "TaskMarker": {
          const checked = /\[[xX]\]/.test(doc.sliceString(node.from, node.to));
          // 复选框始终显示（即使光标在本行），这样才点得到。
          replaceWith(node.from, node.to, new TaskCheckboxWidget(checked, node.from, node.to));
          return false;
        }

        case "QuoteMark": {
          hidden(node.from, node.to + (doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0));
          // callout 已经给整行上了自己的容器样式，`>` 的隐藏归它管、引用样式要让路
          //（callout 现在下沉子节点，行内/列表都靠这条通道渲染）。
          if (!inCallout()) {
            const line = doc.lineAt(node.from);
            marks.push(Decoration.line({ class: "cm-lp-quote" }).range(line.from));
          }
          return false;
        }

        case "Escape": {
          // `\*`、`\$` 这类反斜杠转义（Obsidian 同款写法）：渲染态藏掉反斜杠、
          // 保留被转义的字符，并用普通正文色盖掉 escape 的语法主题色（否则 `\$`
          // 会带着橙色 escape 配色露出来）。光标在本行时显出源码，方便编辑。
          // 只有「反斜杠 + 1 个字符」才是转义；行尾孤反斜杠不归这里管。
          if (node.to > node.from + 1 && !isActive(ctx, node.from, node.to)) {
            hide(node.from, node.from + 1);
            marks.push(MARK.plain.range(node.from + 1, node.to));
          }
          return false;
        }

        case "FencedCode": {
          const active = isActive(ctx, node.from, node.to);
          // mermaid 图由 StateField 整块替换成图。被替换时这里必须一个装饰都不产生——
          // 行装饰与块级替换落在同一行会冲突。光标进入该块（active）时则按普通代码块
          // 处理，方便直接改图定义。
          if (!active && mermaidCode(state, node.node) !== null) return false;
          // 整块加底色，包含被隐藏的围栏行，视觉上才连续。
          const firstLine = doc.lineAt(node.from).number;
          const lastLine = doc.lineAt(node.to).number;
          for (let n = firstLine; n <= lastLine; n += 1) {
            marks.push(Decoration.line({ class: "cm-lp-codeblock" }).range(doc.line(n).from));
          }
          if (!active) {
            let closing: { from: number; to: number } | null = null;
            let codeInfo: { from: number; to: number; text: string } | null = null;
            let codeText = "";
            let child = node.node.firstChild;
            while (child) {
              if (child.name === "CodeMark") {
                hide(child.from, child.to);
                closing = { from: child.from, to: child.to };
              } else if (child.name === "CodeInfo") {
                codeInfo = { from: child.from, to: child.to, text: doc.sliceString(child.from, child.to) };
              } else if (child.name === "CodeText") {
                codeText = doc.sliceString(child.from, child.to);
              }
              child = child.nextSibling;
            }
            if (codeInfo) {
              replaceWith(codeInfo.from, codeInfo.to, new CodeHeaderWidget(codeInfo.text, codeText));
            }
            // 收尾围栏被藏掉后，那一行就空了。若它只剩围栏本身，就把行高压掉，
            // 否则每个代码块底部都会多出一条空行。
            // 起始行不处理——那行还有语言标签，需要正常高度。
            if (closing) {
              const line = doc.lineAt(closing.from);
              if (line.from === closing.from && line.to === closing.to) {
                marks.push(Decoration.line({ class: "cm-lp-fence" }).range(line.from));
              }
            }
          }
          return false;
        }

        case "Table": {
          // 表格由 StateField 做块级替换（插件不允许块级装饰）。
          // 被替换时内部内容根本不渲染，此时必须跳过子节点——否则单元格里的
          // 行内装饰会与块级替换重叠，CM6 会直接抛异常。
          // 光标在表格内时是源码视图，正常处理子节点。
          return isActive(ctx, node.from, node.to) ? undefined : false;
        }

        default:
          return undefined;
      }
    },
    leave: (node) => {
      // callout 块的所有后代都处理完了，弹出栈顶，兄弟节点不再受它影响
      const top = calloutStack[calloutStack.length - 1];
      if (top && top.from === node.from && top.to === node.to) calloutStack.pop();
    },
  });

  // CM6 遇到重叠的 replace 装饰会抛异常，整个编辑器会挂掉。
  // 手工构造的装饰在嵌套语法下可能重叠，这里按起点排序后丢弃被包含的项。
  replaces.sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: Range<Decoration>[] = [];
  let reach = -1;
  for (const r of replaces) {
    if (r.from < reach) continue;
    kept.push(r);
    reach = r.to;
  }

  const all = [...kept, ...marks].sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(all, true);
}

/**
 * 请求重算装饰。
 *
 * 用途：资源索引（文件名 → 路径）在后台刷新后，编辑器需要重新解析图片路径。
 * 装饰只在文档/选区/视口变化时重算，索引变化不在其中，所以得显式通知一次。
 */
export const refreshDecorations = StateEffect.define<null>();

/** 让编辑器立刻按最新的资源上下文重算装饰。 */
export function requestDecorationRefresh(view: EditorView): void {
  view.dispatch({ effects: refreshDecorations.of(null) });
}

/** 从状态里取出资源上下文并计算视口内的装饰。 */
function decorationsFor(view: EditorView): DecorationSet {
  return buildLivePreviewDecorations(
    view.state,
    view.viewport.from,
    view.viewport.to,
    view.state.facet(livePreviewContext),
  );
}

/** Live Preview 扩展。装饰只在视口内计算，长文档不会因全量装饰而变慢。 */
export function livePreviewExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorationsFor(view);
      }

      update(update: ViewUpdate) {
        const forced = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshDecorations)),
        );
        if (update.docChanged || update.selectionSet || update.viewportChanged || forced) {
          this.decorations = decorationsFor(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/**
 * 需要整块替换的装饰（表格、mermaid 图）。
 *
 * 必须由 StateField 提供：CM6 不允许**插件**产生块级装饰
 * （"Block decorations may not be specified via plugins"），违反会让整个装饰集
 * 抛异常、编辑器渲染成空白。
 *
 * 代价：StateField 拿不到 `view.viewport`，只能按全文档扫描。这里只遍历语法树找
 * `Table` 与 `FencedCode` 节点，且 CM6 的语法树是增量维护的，`ensureSyntaxTree`
 * 在树已完整时立即返回，因此常态开销只是遍历节点，不涉及重新解析。
 *
 * 光标落在被替换的块内时不替换——退回源码，方便直接改语法。
 */
export function computeBlockDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const selections = state.selection.ranges;
  const touched = (from: number, to: number) =>
    selections.some((range) => range.from <= to && range.to >= from);

  const tree = ensureSyntaxTree(state, doc.length, 500) ?? syntaxTree(state);
  const ranges: Range<Decoration>[] = [];

  /** 块级替换必须覆盖完整的行（含行尾换行），否则会与行装饰冲突或残留空行。 */
  const wholeLines = (from: number, to: number): [number, number] => {
    const firstLine = doc.lineAt(from);
    const lastLine = doc.lineAt(to);
    return [firstLine.from, lastLine.to < doc.length ? lastLine.to + 1 : lastLine.to];
  };

  tree.iterate({
    enter: (node) => {
      // 手写 HTML 块：清洗后整块渲染（清洗只作用于显示，原文不动）
      if (node.name === "HTMLBlock") {
        if (touched(node.from, node.to)) return false;
        const html = doc.sliceString(node.from, node.to);
        if (!html.trim()) return false;
        const [from, to] = wholeLines(node.from, node.to);
        ranges.push(
          Decoration.replace({
            widget: new HtmlWidget(html, true),
            block: true,
          }).range(from, to),
        );
        return false;
      }

      if (node.name === "FencedCode") {
        const code = mermaidCode(state, node.node);
        if (code === null) return undefined; // 普通代码块交给装饰插件
        if (touched(node.from, node.to)) return false;

        const [from, to] = wholeLines(node.from, node.to);
        ranges.push(
          Decoration.replace({
            widget: new MermaidWidget(code, node.from, node.to),
            block: true,
          }).range(from, to),
        );
        return false;
      }

      if (node.name !== "Table") return undefined;
      if (touched(node.from, node.to)) return false;

      const parsed = parseTable(state, node.node);
      if (parsed.rows.length === 0) return false;

      const [from, to] = wholeLines(node.from, node.to);
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(parsed.rows, parsed.align, parsed.raw, node.from, node.to),
          block: true,
        }).range(from, to),
      );
      return false;
    },
  });

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
}

/** 整块替换装饰的提供者。见 computeBlockDecorations 的说明。 */
export const blockWidgetsField = StateField.define<DecorationSet>({
  create: (state) => computeBlockDecorations(state),
  // 选区变化也要重算：光标进出表格/图表决定「渲染」还是「显示源码」。
  update: (_value, tr) => computeBlockDecorations(tr.state),
  provide: (field) => EditorView.decorations.from(field),
});

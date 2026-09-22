/**
 * 额外语法的渲染：手写 HTML、行内公式、高亮、注释。
 *
 * ## 清洗只作用于显示
 *
 * 笔记里手写的 HTML 会用 DOMPurify 清洗后渲染，但**清洗结果绝不回写**：
 * 文档缓冲区、编辑器状态、磁盘文件始终是原文。同步按内容哈希判增量，
 * 回写清洗后的版本会毁掉用户数据并制造冲突。
 * 这个不变量由 `scripts/verify-all.sh` 的字节精确基线守着。
 *
 * ## 不要打开的东西
 *
 * - **不允许 `style` 属性**：内联样式能覆盖界面（`position:fixed` 盖住整个应用）
 *   或用 `url()` 外泄数据。
 * - **不允许 `class` / `id`**：用户 HTML 里写 `class="settings-panel"` 会套上应用的样式。
 * - **链接一律降级成 span**：Tauri 的 webview 里点 `<a href>` 会把整个应用导航走。
 * - **KaTeX 用 `trust: false`**：禁掉 `\href` 之类的可信命令。
 */

import DOMPurify from "dompurify";
import type { Extension } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { convertFileSrc } from "@tauri-apps/api/core";
import { CALLOUT_ICONS, CALLOUT_TITLES, type MathSpan } from "./inlineSyntax.ts";
import { livePreviewContext, resolveResource } from "./paths.ts";

/** DOMPurify 的允许清单：只放开笔记里实际会用到的标签与属性。 */
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    "br", "hr", "img", "font", "mark", "span", "sub", "sup", "u", "s", "del", "ins",
    "b", "strong", "i", "em", "code", "kbd", "samp", "var", "small", "big", "center",
    "div", "p", "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tr", "th", "td", "caption",
    "details", "summary", "blockquote", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6", "a", "figure", "figcaption",
  ],
  ALLOWED_ATTR: [
    "color", "face", "size", "align", "valign", "src", "alt", "title",
    "width", "height", "colspan", "rowspan", "start", "type", "open", "href",
  ],
  // 明确禁止：脚本、样式、内联事件、嵌套文档
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "link", "meta"],
  FORBID_ATTR: ["style", "class", "id", "onerror", "onload", "onclick"],
};

/**
 * 清洗一段 HTML。**返回 null 表示当前环境无法清洗**，调用方必须退化成显示源码——
 * 绝不能因为"清不了"就直接注入。
 */
export function sanitizeHtml(html: string): string | null {
  if (typeof DOMPurify.sanitize !== "function") return null;
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/** 把清洗后的片段装进容器，并处理其中的链接与图片。 */
function mountSanitized(container: HTMLElement, view: EditorView, html: string): boolean {
  const clean = sanitizeHtml(html);
  if (clean === null) return false;
  container.innerHTML = clean;

  // 链接降级成 span：webview 里点 <a href> 会把整个应用导航走
  for (const anchor of Array.from(container.querySelectorAll("a"))) {
    const span = document.createElement("span");
    span.className = "cm-lp-link";
    span.textContent = anchor.textContent ?? "";
    const href = anchor.getAttribute("href");
    if (href) span.title = href;
    anchor.replaceWith(span);
  }

  // 图片：本地路径要走 asset 协议，远程地址原样
  const resources = view.state.facet(livePreviewContext);
  for (const image of Array.from(container.querySelectorAll("img"))) {
    const source = image.getAttribute("src") ?? "";
    if (!source) continue;
    const resolved = resolveResource(resources, source);
    const url = resolved.local ? convertFileSrc(resolved.local) : resolved.remote;
    if (url) image.setAttribute("src", url);
    else image.replaceWith(document.createTextNode(`🖼 ${image.getAttribute("alt") || source}`));
  }

  // 清洗后的 HTML 里带的图片是异步加载的：加载完高度会变，必须让 CM 重测，
  // 否则高度图陈旧、下方所有行的行号/点击/选区整体漂移
  for (const image of Array.from(container.querySelectorAll("img"))) {
    image.addEventListener("load", () => {
      if (container.isConnected) view.requestMeasure();
    });
  }

  return true;
}

/** 手写 HTML（成对标签整段接管，或 `<br>`/`<img>` 这类 void 标签）。 */
export class HtmlWidget extends WidgetType {
  readonly html: string;
  /** 块级 HTML（由 StateField 做整块替换）还是行内标签。 */
  readonly block: boolean;

  constructor(html: string, block = false) {
    super();
    this.html = html;
    this.block = block;
  }

  eq(other: HtmlWidget) {
    return other.html === this.html && other.block === this.block;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = this.block ? "cm-lp-html cm-lp-html-block" : "cm-lp-html";
    if (!mountSanitized(box, view, this.html)) {
      // 清洗不可用时显示源码，绝不注入
      box.textContent = this.html;
      box.className = `${box.className} is-raw`;
    }
    return box;
  }
}

// ---------------------------------------------------------------- 数学公式

type KatexModule = { default: { renderToString: (tex: string, options: object) => string } };

let katexPromise: Promise<KatexModule> | null = null;

/** 按需加载 KaTeX 与其样式（含字体），不进主包。 */
function loadKatex(): Promise<KatexModule> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import("katex"),
      // 样式单独 import：Vite 会把它切成独立 chunk，字体也只在用到公式时下载
      import("katex/dist/katex.min.css"),
    ]).then(([katex]) => katex as unknown as KatexModule);
  }
  return katexPromise;
}

/**
 * 行内公式。KaTeX 的 CSS 与其字体是异步加载的，所以先显示原文占位、拿到后替换，
 * 与 mermaid 同一套路。
 */
export class MathWidget extends WidgetType {
  readonly latex: string;

  constructor(latex: string) {
    super();
    this.latex = latex;
  }

  eq(other: MathWidget) {
    return other.latex === this.latex;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-lp-math is-loading";
    box.dataset.latex = this.latex;
    // 加载完成前先显示公式源码：比空白好认，也不会因为异步而跳动太多
    box.textContent = `$${this.latex}$`;

    // 点击回到源码编辑
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
      view.focus();
    });

    void loadKatex()
      .then((katex) => {
        box.innerHTML = katex.default.renderToString(this.latex, {
          throwOnError: false,
          displayMode: false,
          // trust: false 会禁掉 \href 之类的可信命令（默认即如此，这里写出来是为了明确）
          trust: false,
          strict: "ignore",
        });
        box.classList.remove("is-loading");
        // 渲染产物与占位文字高度不同：重测，别让 CM 的高度图停在占位尺寸上。
        // 异步回调跑的时候 widget 可能已被移除，isConnected 守卫一下
        if (box.isConnected) view.requestMeasure();
        // KaTeX 的 woff2 字体是渲染之后才异步下载的，就位后公式高度还会再变一次
        // （字号相同但基线/行高不同）——字体就绪再补一次重测，行号/选区才不会漂
        void document.fonts?.ready.then(() => {
          if (box.isConnected) view.requestMeasure();
        });
      })
      .catch((error: unknown) => {
        box.classList.remove("is-loading");
        box.classList.add("is-error");
        box.textContent = `$${this.latex}$`;
        box.title = `公式渲染失败：${error instanceof Error ? error.message : String(error)}`;
      });

    return box;
  }
}

/** 便于外部按 span 构造，避免调用方关心 widget 细节。 */
export function mathWidgetFor(span: MathSpan): MathWidget {
  return new MathWidget(span.latex);
}

// ---------------------------------------------------------------- callout

/** callout 的类型标签：图标 + 标题，替换掉源码里的 `[!type]`。 */
export class CalloutLabelWidget extends WidgetType {
  readonly type: string;
  readonly title: string;

  constructor(type: string, title: string) {
    super();
    this.type = type;
    this.title = title;
  }

  eq(other: CalloutLabelWidget) {
    return other.type === this.type && other.title === this.title;
  }

  toDOM() {
    const label = document.createElement("span");
    label.className = "cm-lp-callout-label";
    label.dataset.calloutType = this.type;
    const icon = CALLOUT_ICONS[this.type] ?? "📌";
    const title = this.title || CALLOUT_TITLES[this.type] || this.type;
    label.textContent = `${icon} ${title}`;
    return label;
  }
}

// ---------------------------------------------------------------- 外部链接

/** 只认 http/https：别的协议（file:、javascript:…）一律不开。 */
export function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * 用系统默认浏览器打开链接。
 *
 * 刻意不在 webview 里导航：那会把整个应用带走，并且很难回来。
 * 也不在应用内打开——笔记软件里点链接的预期就是交给系统浏览器。
 */
export async function openExternal(url: string): Promise<void> {
  if (!isExternalUrl(url)) return;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/**
 * 从文档里的某个位置向外查找最近的 URL（Ctrl/Cmd+点击链接时用）。
 *
 * 为什么这么找：链接文字是 mark 装饰（不是 widget），DOM 上只有个 span，
 * 拿不到 URL。所以从点击位置反查语法树，向上找到 URL 或 Link 节点再取出地址。
 * 纯函数，可以在 Node 里断言。
 */
export function externalUrlAt(state: EditorState, pos: number): string | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node) {
    if (node.name === "URL" || node.name === "Autolink") {
      const text = state.doc.sliceString(node.from, node.to).replace(/^<|>$/g, "");
      return isExternalUrl(text) ? text : null;
    }
    if (node.name === "Link") {
      const urlNode = node.getChild("URL");
      if (!urlNode) return null;
      const text = state.doc.sliceString(urlNode.from, urlNode.to);
      return isExternalUrl(text) ? text : null;
    }
    node = node.parent;
  }
  return null;
}

/**
 * Ctrl/Cmd+点击链接时用系统浏览器打开。
 *
 * 用修饰键而不是直接点击：直接点击要留给"把光标放到这里"，
 * 误触跳走浏览器是很难受的体验（Obsidian 也是修饰键）。
 */
export function linkClickHandler(): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!event.ctrlKey && !event.metaKey) return false;
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".cm-lp-link")) return false;
      const url = externalUrlAt(view.state, view.posAtDOM(target));
      if (!url) return false;
      event.preventDefault();
      void openExternal(url);
      return true;
    },
  });
}

// ---------------------------------------------------------------- Alt+点击增强

/**
 * Alt+点击增强（对齐 Obsidian 插件）：
 *
 * - 行内代码（含表格单元格内的）：快捷复制代码内容（不含反引号）；
 * - 图片（wiki 嵌入与 Markdown 语法）：在资源管理器中定位该文件；
 * - wiki 链接：在资源管理器中定位目标文件。
 *
 * 用 Alt 修饰而不是直接点击：直接点击要留给「放光标/编辑」。
 * 动作由 App 经上下文的 altActions 实现（剪贴板、资源管理器、提示）。
 */
export function altClickHandler(): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      if (event.button !== 0) return false;
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      const actions = view.state.facet(livePreviewContext).altActions;
      if (!actions) return false;

      const chip = target.closest(".cm-lp-code");
      if (chip) {
        event.preventDefault();
        actions.copyText(chip.textContent ?? "");
        return true;
      }
      const image = target.closest("img.cm-lp-image") as HTMLImageElement | null;
      if (image?.title) {
        event.preventDefault();
        actions.revealFile(image.title);
        return true;
      }
      const wikiLink = target.closest("[data-wiki-target]");
      if (wikiLink) {
        event.preventDefault();
        actions.revealFile(wikiLink.getAttribute("data-wiki-target") ?? "");
        return true;
      }

      // 渲染 chip 不存在时的兜底：源码模式整篇、实时模式下光标所在行都没有
      // cm-lp-code 元素。从点击位置反查语法树，落在 InlineCode 里就剥掉反引号复制。
      const pos = view.posAtDOM(target);
      let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
      while (node) {
        if (node.name === "InlineCode") {
          const code = view.state.doc
            .sliceString(node.from, node.to)
            .replace(/^`+/, "")
            .replace(/`+$/, "");
          if (code) {
            event.preventDefault();
            actions.copyText(code);
            return true;
          }
          return false;
        }
        node = node.parent;
      }
      return false;
    },
  });
}

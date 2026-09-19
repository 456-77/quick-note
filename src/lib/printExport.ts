/**
 * PDF 导出：把当前笔记渲染成打印视图，交给系统打印对话框（WebView2 的打印
 * 预览里选「另存为 PDF」即可，与 Obsidian 的 Export to PDF 体验对齐）。
 *
 * 为什么不直接 window.print() 当前界面：CodeMirror 只渲染**可视区域**的行
 * （虚拟滚动），直接打印长笔记会只剩眼前一屏。所以这里用嵌入同一套
 * markdown-it 渲染器（html: false 的安全前提见 embed.ts）把整篇笔记
 * 转成 HTML，放进 #qn-print-root，@media print 隐藏应用界面、只显示它。
 *
 * 局限（v1）：mermaid 图与 callout 标签按原始 Markdown 文本/引用块打印，
 * 不走 Live Preview 的图形渲染；后续需要时再把打印视图接到 Live Preview
 * 的渲染产物上。
 */

import type { EditorState } from "@codemirror/state";
import { renderMarkdownToHtml } from "./embed.ts";
import { CALLOUT_TITLES } from "./inlineSyntax.ts";
import type { LivePreviewContext } from "./paths.ts";
import { PRINT_CSS } from "./printStyles.ts";

/** 剥掉 YAML frontmatter（`---` 围起的头部），markdown-it 不认识它。 */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return markdown;
  return markdown.slice(markdown.indexOf("\n", end + 1) + 1);
}

/**
 * 把 markdown-it 输出的引用块升级成 callout 卡片：
 * `> [!note] 标题` → 带类型色与标题的卡片（与 Live Preview 的 callout 观感对齐）。
 */
function enhanceCallouts(root: HTMLElement): void {
  root.querySelectorAll("blockquote").forEach((bq) => {
    const first = bq.querySelector("p");
    if (!first) return;
    const text = first.textContent ?? "";
    const match = /^\[!(\w+)\][+-]?\s*/.exec(text);
    if (!match) return;
    const type = match[1].toLowerCase();
    const rest = text.slice(match[0].length).trim();

    const card = document.createElement("div");
    card.className = `qn-print-callout qn-print-callout-${type}`;
    const title = document.createElement("div");
    title.className = "qn-print-callout-title";
    title.textContent = rest || CALLOUT_TITLES[type] || type;
    card.appendChild(title);

    if (rest) {
      // 标题占用了第一个段落的文字：把标记从段落里去掉，段落留在卡片里
      const remaining = text.slice(match[0].length);
      if (remaining.trim()) first.textContent = remaining;
      else first.remove();
    } else {
      first.remove();
    }
    while (bq.firstChild) card.appendChild(bq.firstChild);
    bq.replaceWith(card);
  });
}

/** 渲染当前笔记并弹出打印对话框。没有可打印内容时抛错由调用方提示。 */
export async function exportNoteToPdf(
  state: EditorState,
  ctx: LivePreviewContext,
): Promise<void> {
  const markdown = stripFrontmatter(state.sliceDoc());
  if (!markdown.trim()) throw new Error("笔记是空的");

  const html = await renderMarkdownToHtml(markdown, ctx);

  const previous = document.getElementById("qn-print-root");
  previous?.remove();
  const root = document.createElement("div");
  root.id = "qn-print-root";
  root.innerHTML = html;
  enhanceCallouts(root);
  document.body.appendChild(root);

  const cleanup = () => {
    root.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  // 取消打印也会触发 afterprint；再兜底一个定时器防环境不触发
  window.addEventListener("afterprint", cleanup);
  window.setTimeout(cleanup, 60_000);
  window.print();
}

/**
 * 构建独立 HTML（「导出 PDF 文件」用）：打印样式内联、callout 升级、
 * 本地图片改写为 file:/// 绝对地址——无头浏览器进程访问不到 tauri 的
 * asset 协议，只有磁盘路径能加载。
 */
export async function buildStandalonePrintHtml(
  state: EditorState,
  ctx: LivePreviewContext,
): Promise<string> {
  const markdown = stripFrontmatter(state.sliceDoc());
  if (!markdown.trim()) throw new Error("笔记是空的");

  const html = await renderMarkdownToHtml(markdown, ctx);
  const parsed = new DOMParser().parseFromString(`<div id="qn-print-root">${html}</div>`, "text/html");
  const root = parsed.getElementById("qn-print-root");
  if (!root) throw new Error("渲染失败");

  enhanceCallouts(root);

  // asset 协议图片 → file:/// 绝对路径（无头浏览器在 tauri 协议之外）
  root.querySelectorAll("img.cm-lp-image").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const match = /^https?:\/\/asset\.localhost\/(.+)$/.exec(src);
    if (!match) return;
    const abs = decodeURIComponent(match[1]).replace(/\\/g, "/");
    img.setAttribute("src", `file:///${abs.replace(/^\/+/, "")}`);
  });

  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<style>${PRINT_CSS}</style>`,
    "</head><body>",
    root.outerHTML,
    "</body></html>",
  ].join("\n");
}

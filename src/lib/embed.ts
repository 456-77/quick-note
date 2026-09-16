/**
 * 内容嵌入（transclusion）：把 `![[某笔记]]` 的目标笔记内容渲染进来。
 *
 * 安全前提（重要）：嵌入的内容可能来自同步，也就是**外部来源**，而这个应用具备写文件
 * 能力（write_note）。所以 markdown-it 必须用 `html: false`——把笔记里的原始 HTML
 * 转义掉，而不是渲染。markdown-it 默认还会拦截 `javascript:` 之类的链接协议。
 * **不要为了"更贴近 Obsidian"而打开 html。**
 *
 * 另外链接一律渲染成不可导航的 span：Tauri 的 webview 里点一个 <a href> 会把整个应用
 * 导航走，那是很难恢复的状态。
 *
 * 分层：切片与预处理是纯函数（可在 Node 直接断言），只有最终渲染与资源 URL 生成
 * 依赖浏览器环境。嵌套嵌入只支持一层：内层渲染成占位标签，不做递归展开。
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  IMAGE_EXT,
  resolveResource,
  resolveWikiRelative,
  resolveWikiTarget,
  type LivePreviewContext,
} from "./paths.ts";

/** 把 `笔记#小节` 拆成两部分。 */
export function splitEmbedTarget(target: string): { path: string; section: string } {
  const hash = target.indexOf("#");
  if (hash < 0) return { path: target, section: "" };
  return { path: target.slice(0, hash), section: target.slice(hash + 1) };
}

/**
 * 取出笔记里的一小节。
 *
 * - `^id`：块引用，取包含该标记的整个段落；
 * - 其他：按标题匹配（忽略大小写），取到下一个同级或更高级标题之前；
 * - 找不到返回空串，由调用方提示。
 */
export function sliceSection(markdown: string, section: string): string {
  if (!section) return markdown;
  const lines = markdown.split("\n");

  if (section.startsWith("^")) {
    const id = section.slice(1);
    const index = lines.findIndex((line) => line.trimEnd().endsWith(`^${id}`));
    if (index < 0) return "";
    let start = index;
    while (start > 0 && lines[start - 1].trim() !== "") start -= 1;
    let end = index;
    while (end + 1 < lines.length && lines[end + 1].trim() !== "") end += 1;
    return lines.slice(start, end + 1).join("\n");
  }

  const wanted = section.trim().toLowerCase();
  let level = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
    if (!match) continue;
    if (start < 0) {
      if (match[2].toLowerCase() === wanted) {
        level = match[1].length;
        start = i;
      }
      continue;
    }
    if (match[1].length <= level) return lines.slice(start, i).join("\n");
  }
  return start < 0 ? "" : lines.slice(start).join("\n");
}

/**
 * 把嵌入内容里的 Obsidian wiki 语法转成 Markdown，交给 markdown-it 渲染。
 *
 * - `![[图.png]]` → `![alt](<wiki:图.png>)`，图片目标用 `<...>` 包住以容忍空格；
 *   宽度/说明放在 alt 里（纯数字当宽度），避免往 URL 里塞参数。
 * - `![[某笔记]]` → 链接形式的占位（嵌套嵌入不递归展开）。
 * - `[[笔记|别名]]` → 链接形式的别名。
 */
export function prepareEmbedMarkdown(markdown: string): string {
  return markdown.replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (_whole, bang: string, inner: string) => {
    const [rawTarget, ...rest] = inner.split("|");
    const target = rawTarget.trim();
    const label = rest.join("|").trim();

    if (bang === "!") {
      if (IMAGE_EXT.test(target)) return `![${label}](<wiki:${target}>)`;
      return `[📄 ${target}](<wiki-link:${target}>)`;
    }
    return `[${label || target}](<wiki-link:${target}>)`;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface MarkdownRenderer {
  render: (markdown: string) => string;
  renderer: { rules: Record<string, unknown> };
}

let rendererPromise: Promise<MarkdownRenderer> | null = null;

/** 按需加载 markdown-it，并装上自定义渲染规则。 */
function loadRenderer(): Promise<MarkdownRenderer> {
  if (!rendererPromise) {
    rendererPromise = import("markdown-it").then((mod) => {
      const MarkdownIt = (mod as unknown as { default: new (options: unknown) => MarkdownRenderer })
        .default;
      // html: false —— 关键的安全设置，见文件头说明
      return new MarkdownIt({ html: false, linkify: false, breaks: false });
    });
  }
  return rendererPromise;
}

const cache = new Map<string, string>();
const CACHE_LIMIT = 40;

/** 清空嵌入缓存（文件变化时调用）。 */
export function clearEmbedCache(): void {
  cache.clear();
}

/** 读取目标笔记的正文。用 invoke 直接走命令，避免把 api 模块（含 dialog 插件）拖进来。 */
async function readEmbedSource(vaultPath: string, relative: string): Promise<string> {
  const note = await invoke<{ content: string }>("read_note", { vault: vaultPath, path: relative });
  return note.content;
}

/**
 * 渲染 `![[...]]` 目标笔记的内容。返回 HTML 片段（失败时是可读的错误提示）。
 *
 * 这个函数只在浏览器里调用（用到 convertFileSrc 与 markdown-it 的 DOM 无关部分，
 * 但资源 URL 生成依赖 window）。
 */
export async function renderEmbeddedNote(
  ctx: LivePreviewContext,
  target: string,
): Promise<string> {
  const { path: noteTarget, section } = splitEmbedTarget(target);
  const relative = resolveWikiRelative(ctx, noteTarget);
  if (!relative) return errorBlock(`找不到笔记：${noteTarget}`);
  if (!relative.toLowerCase().endsWith(".md")) {
    // 带扩展名说明确实解析到了某个文件，只是不是笔记；否则就是找不到
    const hasExtension = /\.[a-z0-9]+$/i.test(noteTarget);
    return errorBlock(
      hasExtension ? `只能嵌入 Markdown 笔记：${noteTarget}` : `找不到笔记：${noteTarget}`,
    );
  }
  if (!ctx.vaultPath) return errorBlock("尚未打开仓库");

  // 代际参与缓存键：索引或内容变化后旧结果自动失效
  const key = `${ctx.generation}:${relative}#${section}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let content: string;
  try {
    content = await readEmbedSource(ctx.vaultPath, relative);
  } catch (e) {
    return errorBlock(`读取失败：${String(e)}`);
  }

  if (section) {
    const sliced = sliceSection(content, section);
    if (!sliced.trim()) return errorBlock(`找不到小节：${section}`);
    content = sliced;
  }

  const md = await loadRenderer();
  const renderer = md.renderer as unknown as {
    rules: Record<
      string,
      (tokens: Array<{ attrGet: (name: string) => string | null; content: string }>, idx: number) => string
    >;
  };

  // 链接：一律不可导航（点 <a href> 会把整个应用导航走）
  renderer.rules.link_open = (tokens, idx) => {
    const href = tokens[idx].attrGet("href") ?? "";
    const title = href.startsWith("wiki-link:") ? href.slice("wiki-link:".length) : href;
    return `<span class="cm-lp-link" title="${escapeHtml(title)}">`;
  };
  renderer.rules.link_close = () => "</span>";

  // 图片：wiki: 目标走仓库解析，其余按 Markdown 的相对路径规则
  renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const src = token.attrGet("src") ?? "";
    const alt = token.content ?? "";
    const numeric = /^\d+$/.test(alt);
    const width = numeric ? Number(alt) : null;
    const label = numeric ? "" : alt;
    const isWiki = src.startsWith("wiki:");
    const cleanSrc = isWiki ? src.slice("wiki:".length) : src;
    const resolved = isWiki ? resolveWikiTarget(ctx, cleanSrc) : resolveResource(ctx, cleanSrc);
    const url = resolved.local ? convertFileSrc(resolved.local) : resolved.remote;
    if (!url) return `<span class="cm-lp-image-chip">🖼 ${escapeHtml(label || cleanSrc)}</span>`;
    const style = width ? ` style="width:${width}px"` : "";
    return `<img class="cm-lp-image" src="${escapeHtml(url)}" alt="${escapeHtml(label)}"${style}>`;
  };

  const html = md.render(prepareEmbedMarkdown(content));
  const wrapped = `<div class="cm-lp-embed-body">${html}</div>`;
  cache.set(key, wrapped);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return wrapped;
}

function errorBlock(message: string): string {
  return `<div class="cm-lp-embed-error">嵌入失败：${escapeHtml(message)}</div>`;
}

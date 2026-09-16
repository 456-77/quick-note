/**
 * 额外的行内语法扫描：手写 HTML、行内公式、高亮、注释。
 *
 * **纯函数，无任何依赖**（不碰 DOM、不碰 Node，也不 import 别的东西），
 * 因此可以直接在 Node 里断言。widget 与清洗放在 markdownExtras.ts。
 *
 * 这些语法 lezer 的 GFM 解析器都不认识（`$`、`==`、`%%`），
 * `[[...]]` 更是会被硬套成内联链接，所以统一走"正则扫描 + 代码区域排除"。
 */

export interface Span {
  from: number;
  to: number;
}

export interface HtmlSpan extends Span {
  tag: string;
  /** void：`<br>`、`<img>` 这类单独就成立的标签；paired：`<font>…</font>`。 */
  kind: "void" | "paired";
  /** 原始源码片段（已含成对标签的结束标签）。 */
  inner: string;
}

export interface MathSpan extends Span {
  latex: string;
}

/** HTML 里不需要结束标签的标签。 */
const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "wbr",
  "area",
  "base",
  "col",
  "embed",
  "input",
  "link",
  "meta",
  "source",
  "track",
]);

function overlaps(from: number, to: number, excluded: Array<[number, number]>): boolean {
  return excluded.some(([start, end]) => from < end && to > start);
}

/**
 * 扫描手写的 HTML 标签。
 *
 * - void 标签（`<br>`/`<img …>`/`<hr>`）单独接管；
 * - 成对标签（`<font color=red>…</font>`）必须**连同内容和结束标签**一起接管，
 *   只渲染开标签是无效的（样式不会作用到后面的文字）；
 * - 找不到结束标签就跳过：宁可按源码显示，也不要猜着渲染；
 * - `<https://…>` 这类自动链接不会被误判（`https` 不是 void 标签且没有结束标签）。
 */
export function findInlineHtml(
  text: string,
  base: number,
  excluded: Array<[number, number]>,
): HtmlSpan[] {
  const out: HtmlSpan[] = [];
  const tagPattern = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(text)) !== null) {
    const tag = match[1].toLowerCase();
    const from = base + match.index;
    const to = from + match[0].length;
    if (overlaps(from, to, excluded)) continue;

    if (VOID_TAGS.has(tag) || match[3] === "/") {
      out.push({ from, to, tag, kind: "void", inner: match[0] });
      continue;
    }

    const rest = text.slice(match.index + match[0].length);
    const closeMatch = new RegExp(`</${tag}\\s*>`, "i").exec(rest);
    if (!closeMatch) continue;

    const closeFrom = base + match.index + match[0].length + closeMatch.index;
    const closeTo = closeFrom + closeMatch[0].length;
    if (overlaps(from, closeTo, excluded)) continue;

    out.push({
      from,
      to: closeTo,
      tag,
      kind: "paired",
      inner: text.slice(match.index, match.index + match[0].length + closeMatch.index + closeMatch[0].length),
    });
    // 跳过已接管的整段，避免把里面的标签再匹配一次
    tagPattern.lastIndex = match.index + match[0].length + closeMatch.index + closeMatch[0].length;
  }

  return out;
}

/**
 * 行内公式 `$...$`。
 *
 * 判定规则（与常见约定一致，避免把 `$100` 这类当公式）：
 * 开 `$` 后不能是空白、闭 `$` 前不能是空白、中间不跨行、
 * 不是 `$$`（块公式留待以后）、也不是转义的 `\$`。
 */
export function findInlineMath(
  text: string,
  base: number,
  excluded: Array<[number, number]>,
): MathSpan[] {
  const out: MathSpan[] = [];
  const pattern = /(?<![\\$])\$([^\s$\n](?:[^$\n]*[^\s$\n])?)\$(?!\$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const from = base + match.index;
    const to = from + match[0].length;
    if (overlaps(from, to, excluded)) continue;
    out.push({ from, to, latex: match[1] });
  }
  return out;
}

/** 高亮 `==文字==`。 */
export function findHighlights(
  text: string,
  base: number,
  excluded: Array<[number, number]>,
): Span[] {
  const out: Span[] = [];
  const pattern = /==([^=\n](?:[^=\n]*[^=\n])?)==/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const from = base + match.index;
    const to = from + match[0].length;
    if (overlaps(from, to, excluded)) continue;
    out.push({ from, to });
  }
  return out;
}

/**
 * 注释 `%%...%%`。
 *
 * 只处理**单行**注释：跨行的替换会覆盖换行符，而 CM6 不允许插件替换换行符
 * （跨行注释要隐藏得走 StateField 的块级装饰，暂未做）。
 */
export function findComments(
  text: string,
  base: number,
  excluded: Array<[number, number]>,
): Span[] {
  const out: Span[] = [];
  const pattern = /%%([^%\n]*)%%/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const from = base + match.index;
    const to = from + match[0].length;
    if (overlaps(from, to, excluded)) continue;
    out.push({ from, to });
  }
  return out;
}

export interface TagSpan extends Span {
  /** 不含 `#` 的标签名。 */
  name: string;
}

/**
 * 标签 `#标签`、`#嵌套/标签`。
 *
 * 判定刻意收紧，避免误伤：
 * - `#` 前面**不能是字母/数字/下划线**（而非"必须是空白"）——中文标点后的标签也算，
 *   例如 `正文、#标签`，这正是把规则从"前一个字符是空白"放宽过来的原因；
 *   同时这样 `[[笔记#小节]]`（前面是汉字）不会被当成标签；
 * - `#` 后面必须是字母/中文/下划线（不能是数字或 `#`）——所以 `# 标题`、`### 标题`
 *   这些 ATX 标题以及 `#1` 都不会命中；
 * - 标签名里允许字母数字、下划线、连字符与 `/`。
 */
export function findTags(text: string, base: number, excluded: Array<[number, number]>): TagSpan[] {
  const out: TagSpan[] = [];
  const pattern = /(?<![\p{L}\p{N}_])#([\p{L}_][\p{L}\p{N}_/-]*)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const from = base + match.index;
    const to = from + 1 + match[1].length;
    if (overlaps(from, to, excluded)) continue;
    out.push({ from, to, name: match[1] });
  }
  return out;
}

export interface CalloutInfo {
  /** 小写类型，如 note / tip / warning。 */
  type: string;
  /** `[!type]` 之后的标题文字；可能为空。 */
  title: string;
  /** `[!type]` 标记的绝对范围。 */
  markerFrom: number;
  markerTo: number;
  /** 标题文字的范围（无标题时 from === to）。 */
  titleFrom: number;
  titleTo: number;
}

/**
 * 识别 callout 的首行：`> [!type] 可选标题`。
 *
 * 直接在**首行文本**上做正则，比走语法树可靠：`[!note]` 会被解析器当成一个内联链接，
 * 结构上不好定位，而它的书写形式是固定的。
 */
export function parseCalloutLine(lineText: string, lineFrom: number): CalloutInfo | null {
  const match = /^\s*>\s*\[!([a-zA-Z][a-zA-Z0-9-]*)\]\s*(.*)$/.exec(lineText);
  if (!match) return null;

  const markerStart = lineFrom + lineText.indexOf("[!");
  const markerEnd = markerStart + match[1].length + 3; // "[!" + type + "]"
  const hasSpace = lineText.endsWith(" ") || /\]\s/.test(lineText.slice(markerEnd - lineFrom - 2, markerEnd - lineFrom + 1));
  const titleFrom = markerEnd + (hasSpace ? 1 : 0);
  const title = match[2].trim();

  return {
    type: match[1].toLowerCase(),
    title,
    markerFrom: markerStart,
    markerTo: markerEnd,
    titleFrom: title ? titleFrom : markerEnd,
    titleTo: title ? lineFrom + lineText.length : markerEnd,
  };
}

/** callout 的默认标题（没写标题时显示），按类型给中文名。 */
export const CALLOUT_TITLES: Record<string, string> = {
  note: "笔记",
  info: "信息",
  tip: "提示",
  hint: "提示",
  important: "重要",
  warning: "警告",
  caution: "注意",
  attention: "注意",
  danger: "危险",
  error: "错误",
  failure: "失败",
  success: "成功",
  check: "完成",
  question: "疑问",
  example: "示例",
  quote: "引用",
  cite: "引用",
  todo: "待办",
  abstract: "摘要",
  summary: "摘要",
  bug: "缺陷",
};

/** callout 类型对应的图标。未收录的类型用默认图标。 */
export const CALLOUT_ICONS: Record<string, string> = {
  note: "📝",
  info: "ℹ️",
  tip: "💡",
  hint: "💡",
  important: "❗",
  warning: "⚠️",
  caution: "⚠️",
  attention: "⚠️",
  danger: "⛔",
  error: "❌",
  failure: "❌",
  success: "✅",
  check: "✅",
  question: "❓",
  example: "📋",
  quote: "📖",
  cite: "📖",
  todo: "☑️",
  abstract: "📄",
  summary: "📄",
  bug: "🐛",
};

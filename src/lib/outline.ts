/**
 * 大纲（目录）提取。
 *
 * 纯文本扫描而不是语法树：目录要在每次键入后重算，正则扫一遍全文的成本远低于
 * 构建增量语法树的查询链，而且这里只需要行级信息。围栏代码块里的 `# 注释` 不是
 * 标题——这是这类扫描最常见的假阳性，必须跳过。
 *
 * Setext 标题（下一行是 `===` 或 `---`）也要认出来：M1 的渲染层支持它，
 * 大纲与渲染看到的标题不一致会让人困惑。
 */

export interface OutlineEntry {
  /** 标题级别：1-6（ATX）或 1/2（setext）。 */
  level: number;
  /** 标题文字（去掉 # 与空格）。 */
  text: string;
  /** 所在行号（0 基）。 */
  line: number;
}

/**
 * 这一行是否是 `fence` 的闭合围栏。CommonMark 口径：闭合围栏只能是**同一种
 * 标记**、长度不小于开栏、且后面除了空白什么都不许有（不能带语言标签）。
 *
 * 0.39.16 用户反馈「md 文件内容过多时，目录会识别不完整吗」（实测 25k 字、
 * 20 个 `##` 的库笔记只列出 1 个标题）：这份笔记有一段漏了闭合围栏，随后的
 * ` ```sql ` 开栏行被旧状态机当成闭合 → 之后每一段代码与标题的围栏状态全部
 * 反相，标题全被当成代码跳过。按 CommonMark 只认裸闭合后，与编辑器 lezer
 * 的解析一致（只丢真正落在未闭合围栏里的那一个标题）。
 */
function isClosingFence(trimmed: string, fence: { marker: string; len: number }): boolean {
  let count = 0;
  while (trimmed[count] === fence.marker) count += 1;
  if (count < fence.len) return false;
  return trimmed.slice(count).trim() === "";
}

/** 提取一篇笔记的大纲。文本按行传入（保留行内的 `\r`，由这里 trim 掉）。 */
export function outlineOf(lines: string[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let fence: { marker: string; len: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    const trimmed = line.trim();

    if (fence !== null) {
      if (isClosingFence(trimmed, fence)) fence = null;
      continue;
    }

    // 开栏围栏：``` 或 ~~~（后面可以带语言标签）
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], len: fenceMatch[1].length };
      continue;
    }

    // ATX：#{1,6} 后必须有空格或行尾
    const atx = /^(#{1,6})(\s+(.*))?$/.exec(trimmed);
    if (atx) {
      entries.push({
        level: atx[1].length,
        text: (atx[3] ?? "").trim(),
        line: index,
      });
      continue;
    }

    // Setext：本行非空、无 #，下一行全是 = 或 -（至少两个，避免把列表/分隔线误判）
    if (trimmed.length > 0 && !trimmed.startsWith("#") && index + 1 < lines.length) {
      const next = lines[index + 1].replace(/\r$/, "").trim();
      if (/^={2,}$/.test(next)) {
        entries.push({ level: 1, text: trimmed, line: index });
        continue;
      }
      if (/^-{2,}$/.test(next) && !/^\s*([-*+]|\d+\.)\s/.test(trimmed)) {
        // `---` 是分隔线还是 setext 下划线，取决于上一行有没有文字——有文字就是标题
        entries.push({ level: 2, text: trimmed, line: index });
        continue;
      }
    }
  }

  return entries;
}

/**
 * 目录标题文字里的行内标记分段（0.27 用户反馈：标题中的 `**加粗**` 在目录里
 * 要渲染出来）。支持 行内代码 / 加粗（`**`）/ 删除线 / 斜体（`*`），不做嵌套
 * ——目录里一层足够，复杂标记按原文显示。
 *
 * 刻意不支持下划线变体（`__粗__` / `_斜_`）：`snake_case` 这类词内下划线会
 * 被误判成斜体，目录里显示错比显示原文更糟；星号没有这个问题。
 */
export interface OutlineSpan {
  text: string;
  code?: boolean;
  bold?: boolean;
  strike?: boolean;
  italic?: boolean;
}

const OUTLINE_INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)/g;

export function outlineInlineSpans(text: string): OutlineSpan[] {
  const spans: OutlineSpan[] = [];
  let last = 0;
  OUTLINE_INLINE_RE.lastIndex = 0;
  for (const match of text.matchAll(OUTLINE_INLINE_RE)) {
    const at = match.index ?? 0;
    if (at > last) spans.push({ text: text.slice(last, at) });
    const raw = match[0];
    if (match[1]) spans.push({ text: raw.slice(1, -1), code: true });
    else if (match[2]) spans.push({ text: raw.slice(2, -2), bold: true });
    else if (match[3]) spans.push({ text: raw.slice(2, -2), strike: true });
    else spans.push({ text: raw.slice(1, -1), italic: true });
    last = at + raw.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length > 0 ? spans : [{ text }];
}

/**
 * 笔记标签：纯文本层面的解析与增删。
 *
 * 标签的存储格式就是正文里的 `#标签`（Obsidian 兼容）：不引入 frontmatter，
 * 文件保持纯 Markdown，同步/外部编辑器都不需要特殊理解。
 * 「笔记的标签行」约定为**第 3 行**——第 1 行是标题、第 2 行可能是日记天气，
 * 标签行紧跟其后，新建笔记的自动「待整理」标签也落在这条线上。
 */

import { findTags } from "./inlineSyntax.ts";

/** 全文中出现的标签名（按出现顺序去重）。 */
export function noteTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of findTags(text, 0, [])) {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      out.push(item.name);
    }
  }
  return out;
}

/** 规范化用户输入：去掉 # 与首尾空白；保留中文/字母/数字/下划线/连字符/斜杠。 */
export function normalizeTagName(input: string): string | null {
  const name = input.trim().replace(/^#+/, "").trim();
  return /^[\p{L}_][\p{L}\p{N}_/-]*$/u.test(name) ? name : null;
}

/** 一行去掉首尾空白后是否只由标签序列构成（即「标签行」）。 */
function isTagLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const rest = trimmed.replace(/(^|\s)#[\p{L}_][\p{L}\p{N}_/-]*/gu, "");
  return rest.trim() === "";
}

export interface TagEdit {
  /** 插入/删除位置（文档偏移）。 */
  at: number;
  /** 插入内容（删除时为空串）。 */
  insert: string;
  /** 删除区间的终点（插入时等于 at）。 */
  to: number;
}

/**
 * 计算添加标签的编辑：标签行固定放第 3 行（标题/天气之后），已是标签行就并入
 * 行尾，否则在那一行新起一条；有 frontmatter 时顺延到闭合 `---` 之后。
 * 文本里已有同名标签时返回 null（不动文档）。
 */
export function tagAddEdit(text: string, tag: string, lineBreak: string): TagEdit | null {
  if (noteTags(text).includes(tag)) return null;
  // 结构分析按 \n（doc.toString() 的口径）；lineBreak 只用于要插入的分隔符
  const lines = text.split("\n");
  // 标签行落点：默认索引 2（第 3 行）；有 frontmatter 则挪到其闭合 --- 的下一行
  let index = 2;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === "---") {
        index = i + 1;
        break;
      }
    }
  }
  // 落点已是标签行：并入行尾
  if (lines[index] !== undefined && isTagLine(lines[index])) {
    const at = lines.slice(0, index + 1).join("\n").length;
    return { at, insert: ` #${tag}`, to: at };
  }
  // 落点在文档内：在该行位置插入一条标签行（带尾随换行，把原行顶下去）；
  // 落点越界（文档不满两行）：退化为追加文末，沿用旧的接续规则
  if (index < lines.length) {
    const at = lines.slice(0, index).join("\n").length + (index > 0 ? 1 : 0);
    return { at, insert: `#${tag}${lineBreak}`, to: at };
  }
  const at = text.length;
  const prefix = text.endsWith("\n") || text.length === 0 ? "" : lineBreak;
  return { at, insert: `${prefix}#${tag}`, to: at };
}

/**
 * 计算移除标签的编辑：删掉第一个 `#标签`（连同前面贴着的单个空格）。
 * 删空了文末标签行时把整行收掉，不留一条空尾巴。
 */
export function tagRemoveEdit(text: string, tag: string): TagEdit | null {
  const span = findTags(text, 0, []).find((item) => item.name === tag);
  if (!span) return null;
  let from = span.from;
  let to = span.to;
  if (from > 0 && text[from - 1] === " " && (from < 2 || /[\p{L}\p{N}_/-]/u.test(text[from - 2]))) {
    from -= 1;
  } else {
    // 删的是行内首个标签：吃掉后面贴着的空格，避免留下 " #b" 的行首空格
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    if (from === lineStart && to < text.length && text[to] === " ") to += 1;
  }
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const lineEndIndex = text.indexOf("\n", span.to);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const line = text.slice(lineStart, lineEnd);
  // 整行只剩这个标签（考虑首行无前导换行的情形）→ 连行带换行一起删
  if (isTagLine(line) && line.replace(/(^|\s)#[\p{L}_][\p{L}\p{N}_/-]*/gu, "").trim() === "") {
    const only = noteTags(line);
    if (only.length === 1 && only[0] === tag && lineEnd < text.length) {
      // 整行收掉；这同时是文档最后一行时，连前面的换行一起吃掉，避免留空尾巴
      if (lineEnd + 1 >= text.length && lineStart > 0 && text[lineStart - 1] === "\n") {
        return { at: lineStart - 1, insert: "", to: lineEnd + 1 };
      }
      return { at: lineStart, insert: "", to: lineEnd + 1 };
    }
  }
  return { at: from, insert: "", to };
}

/**
 * 笔记标签：纯文本层面的解析与增删。
 *
 * 标签的存储格式就是正文里的 `#标签`（Obsidian 兼容）：不引入 frontmatter，
 * 文件保持纯 Markdown，同步/外部编辑器都不需要特殊理解。
 * 「笔记的标签行」约定为**最后一个非空行**且整行只由标签组成——添加标签
 * 优先并入这一行，没有才在文末新起一行。
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
 * 计算添加标签的编辑：并入文末标签行，或新建一行。
 * 文本里已有同名标签时返回 null（不动文档）。
 */
export function tagAddEdit(text: string, tag: string, lineBreak: string): TagEdit | null {
  if (noteTags(text).includes(tag)) return null;
  // 结构分析按 \n（doc.toString() 的口径）；lineBreak 只用于要插入的分隔符
  const lines = text.split("\n");
  // 从后往前找最后一个非空行
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    if (isTagLine(lines[i])) {
      const at = lines.slice(0, i + 1).join("\n").length;
      return { at, insert: ` #${tag}`, to: at };
    }
    // 最后一个非空行不是标签行：其后可能还有空行（结尾换行），插到文档末尾
    const at = text.length;
    const prefix = text.endsWith("\n") || text.length === 0 ? "" : lineBreak;
    return { at, insert: `${prefix}#${tag}`, to: at };
  }
  // 空文档：直接就是标签行
  return { at: 0, insert: `#${tag}`, to: 0 };
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

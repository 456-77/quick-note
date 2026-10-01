/**
 * 速记（快速笔记）的行格式：解析、序列化、行级编辑。
 *
 * 一条速记就是收件文件里的**一个列表行**，文件保持纯 Markdown（与待办存 JSON、
 * 标签存正文的取舍一致：任何编辑器都能打开，同步只是普通文本）：
 *
 *   - 2026-09-30 14:32 [运维库/部署笔记] #想法 #项目A 明天要跟进 xxx ^archived
 *     └ 时间戳           └ 来源(速记时所在仓库/笔记)  └ 标签   └ 正文    └ 归档标记
 *
 * 规则：
 * - 只有匹配「- 日期 时间」开头的行才算结构化速记；旧格式（没有来源/标签）与
 *   手写行都按同一套回退解析，不丢内容。
 * - 归档**不删除**：在行尾打 `^archived` 标记（与待办的墓碑同思路，物理删除会让
 *   「已经归档过」这件事丢失，重复归档就没有防线了）。
 * - 时间戳/标签写进行内而不是 frontmatter：速记要的是「追加一行」这种无结构的写法。
 */

import { noteTags } from "./tags.ts";

export interface CaptureEntry {
  /** 所在文件（收件仓库内相对路径）。 */
  file: string;
  /** 行号（0 基）。操作都是整文件按行重写，这里主要给 UI 当 key 的一部分。 */
  line: number;
  /** `YYYY-MM-DD HH:mm`；手写行可能没有（null → 归入「未标注日期」组）。 */
  timestamp: string | null;
  /** 来源显示名（速记时所在仓库/笔记）。 */
  source: string | null;
  /** 标签（时间戳后显式写的 + 正文里出现的，去重）。 */
  tags: string[];
  /** 正文（剥掉时间戳/来源/前导标签/归档标记后的剩余部分）。 */
  text: string;
  archived: boolean;
  /** 所在文件最后修改时间（epoch ms）。「最近修改」排序用；解析器不填，扫描侧补。 */
  modified?: number;
}

/** `^archived` 行尾标记：归档 = 打上，撤销归档 = 剥掉。 */
export const ARCHIVE_MARK = "^archived";

const ENTRY_RE = /^-\s+(.*)$/;

/**
 * 解析一个收件文件的速记行。只把 `- ` 列表行当条目（其他正文不动）；
 * 解析不出的部分原样保留在 text 里，宁可显示得笨，也不静默丢内容。
 */
export function parseCaptureEntries(file: string, content: string): CaptureEntry[] {
  const out: CaptureEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const head = ENTRY_RE.exec(lines[i]);
    if (!head) continue;
    let rest = head[1];
    let timestamp: string | null = null;
    const ts = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*/.exec(rest);
    if (ts) {
      timestamp = `${ts[1]} ${ts[2]}`;
      rest = rest.slice(ts[0].length);
    }
    let source: string | null = null;
    const src = /^\[([^\]]+)\]\s+/.exec(rest);
    if (src) {
      source = src[1];
      rest = rest.slice(src[0].length);
    }
    let archived = false;
    const mark = new RegExp(`\\s+${ARCHIVE_MARK.replace("^", "\\^")}\\s*$`);
    const marked = mark.exec(rest);
    if (marked) {
      archived = true;
      rest = rest.slice(0, marked.index);
    }
    // 前导标签：时间戳/来源后面连着写的 #tag 序列
    const tags: string[] = [];
    for (;;) {
      const tag = /^#([^\s#]+)\s+/.exec(rest);
      if (!tag) break;
      if (!tags.includes(tag[1])) tags.push(tag[1]);
      rest = rest.slice(tag[0].length);
    }
    const text = rest.trim();
    // 正文里出现的标签也算数（速记正文里手写 #标签 是合法用法）
    for (const tag of noteTags(text)) {
      if (!tags.includes(tag)) tags.push(tag);
    }
    out.push({ file, line: i, timestamp, source, tags, text, archived });
  }
  return out;
}

/** 组装一条速记行（不带换行符）。tags 已由调用方规范过。 */
export function buildCaptureLine(parts: {
  timestamp: string;
  source?: string | null;
  tags?: string[];
  text: string;
  archived?: boolean;
}): string {
  const tags = (parts.tags ?? []).filter(Boolean);
  const tagStr = tags.length > 0 ? ` ${tags.map((t) => `#${t}`).join(" ")}` : "";
  const src = parts.source ? ` [${parts.source}]` : "";
  return `- ${parts.timestamp}${src}${tagStr} ${parts.text}${parts.archived ? ` ${ARCHIVE_MARK}` : ""}`;
}

/** 给某一行行尾打/撤归档标记（保留行尾的 \r）。返回新行；无变化返回 null。 */
export function lineArchiveEdit(line: string, archived: boolean): string | null {
  const cr = line.endsWith("\r") ? "\r" : "";
  const body = cr ? line.slice(0, -1) : line;
  const has = new RegExp(`\\s+${ARCHIVE_MARK.replace("^", "\\^")}$`).test(body);
  if (has === archived) return null;
  if (archived) return `${body} ${ARCHIVE_MARK}${cr}`;
  return `${body.replace(new RegExp(`\\s+${ARCHIVE_MARK.replace("^", "\\^")}$`), "")}${cr}`;
}

/**
 * 替换一行的正文（保留时间戳/来源/标签/归档标记与行尾 \r）。
 * 正文在行尾，取 oldText 的**最后一次**出现（前面标签里撞同名前缀也不会误伤）；
 * 找不到（正文被空行/trim 差异挪走）返回 null，调用方按无变化处理。
 */
export function lineTextEditText(line: string, oldText: string, newText: string): string | null {
  const cr = line.endsWith("\r") ? "\r" : "";
  const body = cr ? line.slice(0, -1) : line;
  if (!oldText || oldText === newText || !body.includes(oldText)) return null;
  const index = body.lastIndexOf(oldText);
  return `${body.slice(0, index)}${newText}${body.slice(index + oldText.length)}${cr}`;
}

/** 给某一行追加标签（已有同名标签则不动）。返回新行；无变化返回 null。 */
export function lineAddTagEdit(line: string, tag: string): string | null {
  const cr = line.endsWith("\r") ? "\r" : "";
  const body = cr ? line.slice(0, -1) : line;
  const entries = parseCaptureEntries("x", `${body}\n`);
  if (entries.length === 0 || entries[0].tags.includes(tag)) return null;
  // 标签插在归档标记之前（有的话），保持「正文 在前、标记 在尾」的形状
  const markRe = new RegExp(`(\\s+${ARCHIVE_MARK.replace("^", "\\^")})$`);
  const marked = markRe.exec(body);
  const base = marked ? body.slice(0, marked.index) : body;
  const tail = marked ? marked[1] : "";
  return `${base} #${tag}${tail}${cr}`;
}

/**
 * 归档时要追加到目标笔记的行：与速记行同格式，但剥掉归档标记
 * （目标笔记里它是一条普通记录，不再是「待整理」状态）。
 */
export function archivedLineForTarget(entry: CaptureEntry): string {
  const ts = entry.timestamp ?? "";
  const src = entry.source ? ` [${entry.source}]` : "";
  const tags = entry.tags.length > 0 ? ` ${entry.tags.map((t) => `#${t}`).join(" ")}` : "";
  return `- ${ts}${src}${tags} ${entry.text}`.replace(/\s+$/, "");
}

/** 文件的换行风格（读出来的原样内容判定）；写回时按它拼接。 */
export function detectEol(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

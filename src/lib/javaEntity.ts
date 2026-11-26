/**
 * Java 实体库（0.34.13 用户反馈「类似于 ddl 语句，对于 java 中的实体也类似
 * 处理；也要考虑多项目中名字复用」）：把实体类源码集中存进仓库内一篇笔记，
 * 笔记里出现类名时悬浮显示该类的源码——与 DDL 库同一套交互与段落格式。
 *
 * ## 收录格式
 *
 * 整篇笔记全文扫描（```java 围栏块、散落的类都算）：`class Foo` /
 * `interface Foo` / `enum Foo` / `record Foo(...)`（可带 public/final/abstract
 * 等修饰）按**类名**收录，值是「从修饰符行首到配对右花括号」的完整源码。
 * 残段（没有配对 `}`）按硬边界兜底：下一个类声明行 / 围栏行 / 120_000 字符
 * （0.37.2 起，此前 8000 会把超长实体类拦腰截断）。
 *
 * ## 多项目
 *
 * 与 ddl.ts 完全同构：`## 项目名` 起段落、未分组兼容老笔记、同名类跨项目
 * 各存一份。段落切割直接复用 ddlSections。0.39.29 起项目段落退役（迁移进
 * 块内 `// @tags:` 注释，见 migrateClassSectionsToTags），解析保持兼容。
 *
 * ## 纯函数
 *
 * 不碰 DOM、不碰 Tauri，Node 里直接断言（verify-all 的一节）。
 */

import {
  applyStatementTags,
  ddlSections,
  dropEmptyFence,
  matchingSections,
  metaBlockAbove,
  migrateSectionsToTagRows,
  sectionProjectAt,
  tagsLineText,
  timeLineText,
  type DdlEntry,
  type DdlLibrary,
} from "./ddl.ts";

const CLASS_RE =
  /(?:^|\n)[ \t]*(?:(?:public|protected|private|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * 残段兜底长度（没有配对 `}` 时的截断上限）。
 *
 * 0.37.2 用户反馈「DDL/实体内容过长保存时被截断」：兜底此前是 8000，超长实体类
 * （字段多的表实体轻松过万）即使花括号能配对也会在匹配中途被它打断、按 8000 硬切
 * 进库。兜底的职责只是"别让残段吞掉整篇笔记"，不是限制合法语句的长度——提到
 * 120_000，远超任何真实单类/单语句，又仍能兜住失控残段。
 */
const MAX_CLASS_LENGTH = 120_000;

/** 类名（保持原文大小写；匹配时调用方自行小写化）→ 收录键。 */
export type ClassLibrary = DdlLibrary;

/**
 * 从一段文本（可以是整篇笔记）里抽出全部类型定义，按项目分段归组。
 *
 * 取值范围：声明行首（含修饰符）到**配对右花括号**——花括号计数会跳过字符串
 * 字面量、字符、行/块注释，与 Java 语法对齐；没有配对 `}` 的残段退到硬边界
 * （下一个类声明 / 围栏行）或 120_000 字符兜底（0.37.2 起，勿回调小：超长
 * 实体类会被拦腰截断）。同一项目内同名以最后一次出现为准。
 */
export function parseClassLibrary(text: string): ClassLibrary {
  const out: ClassLibrary = new Map();
  const sections = ddlSections(text);
  /** 文档序记录：@ExtendPOJO 子类要挂到它前面出现的父类条目上。 */
  const records: Array<{ name: string; project: string; entry: DdlEntry }> = [];
  CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASS_RE.exec(text)) !== null) {
    const name = match[1];
    // 声明起点回退到「这一行的行首」（修饰符之前的缩进不收进源码）
    const declStart = text.lastIndexOf("\n", match.index) + 1;
    // 0.39.19 用户反馈「这些注解要保留」：类声明上方的连续注解块
    // （@ApiModel/@Table 等，含跨行）一并收进源码
    const lineStart = annotationBlockStart(text, declStart);
    const rest = text.slice(lineStart);
    const { cut, advance } = classSpan(rest, declStart - lineStart);
    const code = stripFenceLines(rest.slice(0, cut));
    if (name && code) {
      const key = name;
      const project = sectionProjectAt(sections, lineStart);
      // 0.39 多标签 + 收录时间：类声明上方的 `// @tags:` / `// @time:` 元数据块
      // （0.39.19 起注解收进源码，元数据块在注解块之上）
      const meta = metaBlockAbove(text, lineStart);
      const tags = meta?.hasTags ? meta.tags : project ? [project] : [];
      // 同项目内同名：0.39.21 起「同名新增」允许同段并存多份（内容不同），必须
      // 全部保留；手工复制段落造成的**内容完全相同**的重复照旧收成一条
      const entries = (out.get(key) ?? []).filter(
        (entry) => entry.project !== project || entry.ddl !== code,
      );
      const entry: DdlEntry = { project, tags, time: meta?.time ?? undefined, ddl: code };
      entries.push(entry);
      out.set(key, entries);
      records.push({ name, project, entry });
    }
    // 游标永远向前：从声明行首起消费整个类体
    CLASS_RE.lastIndex = lineStart + advance;
  }
  attachExtendPojoChildren(records);
  return out;
}

/**
 * Hand 的 `@ExtendPOJO` 扩展实体（0.39.35 用户需求「在原本的实体后面添加这段
 * 代码，识别时要保留下来」）：子类代码在库笔记里就写在父类条目后面，这里把子类
 * 源码**追加到父类条目的 ddl** 上，悬停父类时能一起看到扩展字段；子类自身仍
 * 保留独立条目（悬停子类名照常出卡）。
 *
 * 只认带 `@ExtendPOJO` 注解、且 extends 的父类**在文档中出现在它之前**的类；
 * 同项目优先、否则取最近一次。追加带 idempotent 判重（同一段子类代码不重复拼）。
 */
function attachExtendPojoChildren(records: Array<{ name: string; project: string; entry: DdlEntry }>): void {
  for (let i = 0; i < records.length; i += 1) {
    const child = records[i];
    if (!isExtendPojo(child.entry.ddl)) continue;
    const parentName = extendedParentOf(child.entry.ddl);
    if (!parentName || parentName === child.name) continue;
    let parent: (typeof records)[number] | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = records[j];
      if (candidate.name !== parentName) continue;
      if (candidate.project === child.project) {
        parent = candidate;
        break;
      }
      if (!parent) parent = candidate;
    }
    if (!parent) continue;
    if (parent.entry.ddl.includes(child.entry.ddl)) continue;
    parent.entry.ddl = `${parent.entry.ddl}\n\n${child.entry.ddl}`;
  }
}

/** 是不是 Hand 的 `@ExtendPOJO` 扩展实体（类级注解，允许全限定名/带参）。 */
export function isExtendPojo(code: string): boolean {
  return /(?:^|\n)[ \t]*@(?:[\w$]+\.)*ExtendPOJO\b/.test(code);
}

/**
 * 类声明 extends 的父类简单名（跳过泛型参数列表里的 `extends`：
 * `class Foo<T extends Bar> extends Baz` → Baz；`class Foo implements Bar` → null）。
 */
export function extendedParentOf(code: string): string | null {
  const decl = /\bclass[ \t]+[A-Za-z_$][\w$]*/.exec(code);
  if (!decl) return null;
  let depth = 0;
  for (let i = decl.index + decl[0].length; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "<") {
      depth += 1;
      continue;
    }
    if (ch === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "{") break;
    if (depth > 0) continue;
    const rest = code.slice(i);
    const kw = /^(extends|implements)\b/.exec(rest);
    if (!kw) continue;
    if (kw[1] === "implements") return null;
    const type = /^\s*([\w$.]+)/.exec(rest.slice(kw[0].length));
    if (!type) return null;
    const parts = type[1].split(".");
    return parts[parts.length - 1] || null;
  }
  return null;
}

/**
 * 类定义的取值范围（相对文本起点）：配对 `}`、下一个类声明/围栏行、
 * 兜底长度三者取最早；`advance` 带回游标推进量（≥ 头部长度）。
 * `declAt` = 类声明行起点在 text 里的下标（0.39.19 起调用方可能从注解块
 * 开始切——硬边界搜索必须跳过声明行自己，否则会把类体拦腰截断）。
 */
function classSpan(text: string, declAt = 0): { cut: number; advance: number } {
  const boundary = nextClassBoundary(text, declAt);
  let depth = 0;
  let seenOpen = false;
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i += 1;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      seenOpen = true;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (seenOpen && depth <= 0) {
        const cut = i + 1;
        return { cut, advance: cut };
      }
    }
    if (boundary >= 0 && i >= boundary) break;
    if (i > MAX_CLASS_LENGTH) break;
  }
  // 没有配对 `}`：硬边界 / 兜底长度
  const cut = boundary >= 0 ? boundary : Math.min(text.length, MAX_CLASS_LENGTH);
  return { cut, advance: Math.max(cut, 1) };
}

/** 下一个硬边界（类声明行首、``` 围栏行首或 `@tags`/`@time` 元数据行）的绝对下标；找不到 -1。
 *  `declAt` = 当前类声明行起点（含）：边界搜索跳过它自己（0.39.19 起切片可能
 *  从注解块开始，声明行不再位于切片 0 处）。 */
function nextClassBoundary(text: string, declAt = 0): number {
  const re = /^[ \t]*(?:(?:public|protected|private|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\b|^[ \t]*```|^[ \t]*(?:--|\/\/)[ \t]*@(?:tags|time)\b/gm;
  let at: RegExpExecArray | null;
  while ((at = re.exec(text)) !== null) {
    if (at.index > declAt) return at.index;
  }
  return -1;
}

/**
 * 类声明上方**连续注解块**的起点（0.39.19 用户反馈「对于 Java 实体，这些
 * 注解要保留」——收录/解析此前从修饰符行开始，`@ApiModel`/`@Table` 这类
 * 类级注解整块丢失）。规则：自声明行**向上**走，`@` 开头的行计入注解段；
 * 自身括号入不敷出（`@Table(` 跨行时，向上先遇到 `)` / 参数行）或下方已并入
 * 的块还有未闭合括号时，本行也算续行；空行/注释行/普通代码断开。
 * 元数据行（`// @tags:`/`// @time:`）是库协议，不属于注解，遇到即停。
 */
function annotationBlockStart(text: string, declStart: number): number {
  const WINDOW = 80;
  let blockStart = declStart;
  // 已并入注解块的各行括号净值：负 = 还有开括号在更上方（块没到头）
  let balanceBelow = 0;
  let end = declStart - 1; // 上一行的行尾（\n 下标）
  for (let walked = 0; end >= 0 && walked < WINDOW; walked += 1) {
    const lineStart = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(lineStart, end); // 不含行尾 \n
    const trimmed = line.trim();
    if (trimmed === "") break;
    if (/^(?:\/\/|--)\s*@(?:tags|time)\b/.test(trimmed)) break;
    let net = 0;
    for (const ch of line) {
      if (ch === "(") net += 1;
      else if (ch === ")") net -= 1;
    }
    if (!trimmed.startsWith("@") && balanceBelow >= 0 && net >= 0) break;
    blockStart = lineStart;
    balanceBelow += net;
    end = lineStart - 1;
  }
  return blockStart;
}

/**
 * 实体类级 `@ApiModel("…")` 的值（0.39.19 用户反馈「这里的 apimodel 其实就
 * 是实体的名称，这个类似于 ddl 的 comment」）。没有该注解返回 null。
 */
export function classCommentOf(code: string): string | null {
  const match = /@[Aa]pi[Mm]odel\s*\(\s*(?:value\s*=\s*)?"((?:\\.|[^"\\])*)"/.exec(code);
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
}

/** 去掉首尾整行的围栏标记（``` / ```java）：悬浮预览只展示类源码本身。 */
function stripFenceLines(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && /^\s*```/.test(lines[0])) lines.shift();
  while (lines.length > 0 && /^\s*```/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n").trim();
}

/** 文本里出现过的全部类名（保持出现顺序，去重）。 */
export function extractClassNames(text: string): string[] {  const seen = new Set<string>();
  const order: string[] = [];
  CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASS_RE.exec(text)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      order.push(match[1]);
    }
  }
  return order;
}

/** 类名（声明里的裸名）→ 匹配该类声明起点的正则。 */
function classAt(name: string, flags: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:(?:public|protected|private|static|final|abstract|sealed)\\s+)*(?:class|interface|enum|record)\\s+${escaped}\\b`,
    flags,
  );
}

/**
 * 把新的一批类源码合进实体库笔记（弹窗「收录」用）。策略与 mergeDdlIntoNote
 * 完全同构：目标项目段落内同名类整段替换；段落内没有的插到段落末尾；
 * 项目不存在就在文末新建 `## 项目` 段落；未分组无段落时追加文末。
 * `opts.time` 给**新追加**的类写 `@time` 收录时间行（替换旧类不动原元数据块）。
 */
/**
 * 在给定段落集合里找某个类**最后一次**声明（0.39.17：同名项目段落可能重复，
 * 跨段落取绝对位置最大，与 DDL 的 lastTableMatch 同口径）。
 */
function lastClassMatch(
  text: string,
  sections: { from: number; to: number }[],
  name: string,
): { at: number } | null {
  const hits = classMatches(text, sections, name);
  return hits.length > 0 ? hits[hits.length - 1] : null;
}

/** 全部声明（文档序升序；occurrence 定位与 lastClassMatch 共用）。 */
function classMatches(
  text: string,
  sections: { from: number; to: number }[],
  name: string,
): Array<{ at: number }> {
  const hits: Array<{ at: number }> = [];
  for (const section of sections) {
    const span = text.slice(section.from, section.to);
    const re = classAt(name, "gm");
    re.lastIndex = 0;
    for (let m = re.exec(span); m !== null; m = re.exec(span)) {
      hits.push({ at: section.from + m.index });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * 同（项目, 类名）下第 occurrence 份声明（0.39.29，与 ddl.ts 的
 * occurrenceTableMatch 同口径——同名新增/迁移后 (名, 项目) 不再唯一）。
 */
function occurrenceClassMatch(
  text: string,
  sections: { from: number; to: number }[],
  name: string,
  occurrence: number | null | undefined,
): { at: number } | null {
  const hits = classMatches(text, sections, name);
  if (hits.length === 0) return null;
  if (occurrence == null) return hits[hits.length - 1];
  return hits[occurrence] ?? null;
}

export function mergeClassesIntoNote(
  existing: string,
  incoming: string,
  project = "",
  opts: { time?: string; tags?: string[]; mode?: "replace" | "append" } = {},
): string {
  const fresh = parseClassLibrary(incoming);
  if (fresh.size === 0) return existing;
  const batch = new Map<string, string>();
  for (const [name, entries] of fresh) {
    batch.set(name, entries[entries.length - 1].ddl);
  }

  let text = existing;
  const replaced = new Set<string>();
  // 0.39.17：同名项目段落可能重复——替换跨全部目标段落找最后一次声明。
  // 0.39.21 用户反馈「虽然同名，但是内容不同呀」：mode=append 时同名也作为
  // 新条目追加（旧条目原样保留）
  const targets = matchingSections(ddlSections(text), project);
  if (opts.mode !== "append" && targets.length > 0) {
    const hits: Array<{ at: number; ddl: string; replaceEnd: number }> = [];
    for (const [name, ddl] of batch) {
      const hit = lastClassMatch(text, targets, name);
      if (!hit) continue;
      // 0.39.19 注解保留：替换跨度从注解块起点开始（旧条目带注解整块换新）
      const start = annotationBlockStart(text, hit.at);
      const { cut } = classSpan(text.slice(start), hit.at - start);
      hits.push({ at: start, ddl, replaceEnd: start + cut });
      replaced.add(name);
    }
    hits.sort((a, b) => b.at - a.at);
    for (const hit of hits) {
      text = text.slice(0, hit.at) + hit.ddl + text.slice(hit.replaceEnd);
    }
    // 0.39.20 收录替换补写标签（同 mergeDdlIntoNote）：替换跨度从注解块起点
    // 起、在元数据行之下，弹窗新填的标签此前整个丢掉。替换后的新位置按
    // add 并集补 @tags（插到**注解块之上**，与追加路径的元数据布局一致）；
    // @time 保留原值。
    if ((opts.tags?.length ?? 0) > 0) {
      const sectionsAfter = matchingSections(ddlSections(text), project);
      for (const [name] of batch) {
        if (!replaced.has(name)) continue;
        const hit = lastClassMatch(text, sectionsAfter, name);
        if (hit) {
          text = applyStatementTags(
            text,
            annotationBlockStart(text, hit.at),
            project,
            opts.tags as string[],
            "java",
            "add",
          );
        }
      }
    }
  }

  // 0.39：新追加的类带 @time 收录时间行（每类一行；替换旧类保留原时间）。
  // 0.39.8 收录弹窗多标签；0.39.17 起没有项目段落，单个标签也要写 @tags 行
  //（标签行在前、时间行在后，与 ddl.ts applyStatementTags 次序一致）
  const metaHead = [
    opts.tags && opts.tags.length > 0 ? tagsLineText("java", opts.tags) : null,
    opts.time ? timeLineText("java", opts.time) : null,
  ]
    .filter(Boolean)
    .join("\n");

  // 0.39.35 用户需求（Hand 的 @ExtendPOJO）「在原本的实体后面添加这段代码，
  // 识别时要保留下来」：子类代码写到**父类条目后面**的同一个代码块里，悬停
  // 父类时一起显示扩展字段；父类不在库里就退回普通新类追加。
  const attached = new Set<string>();
  for (const [name, ddl] of batch) {
    if (replaced.has(name)) continue;
    if (!isExtendPojo(ddl)) continue;
    const parentName = extendedParentOf(ddl);
    if (!parentName) continue;
    const parentHits = classMatches(text, [{ from: 0, to: text.length }], parentName);
    if (parentHits.length === 0) continue;
    const parentHit = parentHits[parentHits.length - 1];
    const parentStart = annotationBlockStart(text, parentHit.at);
    const { cut } = classSpan(text.slice(parentStart), parentHit.at - parentStart);
    const at = parentStart + cut;
    const block = metaHead ? `${metaHead}\n${ddl}` : ddl;
    text = `${text.slice(0, at)}\n\n${block}${text.slice(at)}`;
    attached.add(name);
  }

  const pending = [...batch]
    .filter(([name]) => !replaced.has(name) && !attached.has(name))
    .map(([, ddl]) => ddl);
  if (pending.length === 0) return text;
  const block = pending
    .map((ddl) => (metaHead ? `${metaHead}\n${ddl}` : ddl))
    .join("\n\n");
  const sectionsNow = matchingSections(ddlSections(text), project);
  const targetNow = sectionsNow.length > 0 ? sectionsNow[sectionsNow.length - 1] : null;
  if (targetNow) {
    const insert = `\n\n\`\`\`java\n${block}\n\`\`\`\n`;
    const head = text.slice(0, targetNow.to).replace(/\s*$/, "\n");
    const tail = text.slice(targetNow.to).replace(/^\n*/, "");
    return head + insert + tail;
  }
  const section = `\n\n## ${project}\n\n\`\`\`java\n${block}\n\`\`\`\n`;
  return text.replace(/\s*$/, "") + section;
}

/** 实体库笔记的初始内容（第一次收录时创建）。 */
export function javaNoteIntro(): string {
  return [
    "# Java 实体",
    "",
    "实体类源码集中收录在这里（设置里可改路径）。笔记里光标悬停在已收录的类名上，会浮动显示该类的源码；用「收录建表语句」弹窗粘贴类源码即可收录（自动识别 class/interface/enum/record），归属由类声明上方的 `// @tags:` 注释行表达。",
    "",
  ].join("\n");
}

/**
 * Java 实体库迁移（0.39.29「## 项目段落 → 块内 @tags 注释」，见 ddl.ts
 * migrateSectionsToTagRows）：语句锚点 = 段内每个类声明的**注解块起点**
 * （元数据块在注解之上，锚点必须落在注解块的顶上，否则 mergeProjectTagAt
 * 的向上扫描会被 `@ApiModel` 这类注解行截停、找不到已有元数据块）。
 */
export function migrateClassSectionsToTags(text: string): string | null {
  return migrateSectionsToTagRows(text, "java", (from, to) => {
    const starts: number[] = [];
    const span = text.slice(from, to);
    CLASS_RE.lastIndex = 0;
    for (let m = CLASS_RE.exec(span); m !== null; m = CLASS_RE.exec(span)) {
      // 与 parseClassLibrary 同一套切法：锚点=注解块起点，游标消费整个类体
      //（只推进到声明行末尾的话，类体里的 `Xxx.class` 会被当成新声明）
      const declStart = span.lastIndexOf("\n", m.index) + 1;
      const blockStart = annotationBlockStart(span, declStart);
      starts.push(from + blockStart);
      const { advance } = classSpan(span.slice(blockStart), declStart - blockStart);
      CLASS_RE.lastIndex = blockStart + advance;
    }
    return starts;
  });
}

/** 没有显式 `// @tags:` 行的类锚点（0.39.29「批量归入项目」用；同构见 ddl.ts）。 */
export function untaggedClassAnchors(text: string): number[] {
  const anchors: number[] = [];
  CLASS_RE.lastIndex = 0;
  for (let m = CLASS_RE.exec(text); m !== null; m = CLASS_RE.exec(text)) {
    const declStart = text.lastIndexOf("\n", m.index) + 1;
    const blockStart = annotationBlockStart(text, declStart);
    const meta = metaBlockAbove(text, blockStart);
    if (!meta?.hasTags) anchors.push(blockStart);
    const { advance } = classSpan(text.slice(blockStart), declStart - blockStart);
    CLASS_RE.lastIndex = blockStart + advance;
  }
  return anchors;
}

// -------------------------------------------------------- 管理面板配套（0.35.1）

/**
 * 在库笔记里定位某项目下某个类的源码（面板「定位/删除」用）。
 * 与 {@link locateDdlEntry} 同构：目标项目段落内按 occurrence 取声明（缺省=
 * **最后一次**出现），classSpan 切到配对右花括号。找不到返回 null。
 */
export function locateClassEntry(
  text: string,
  name: string,
  project = "",
  occurrence?: number | null,
): { from: number; to: number; line: number } | null {
  const hit = occurrenceClassMatch(text, matchingSections(ddlSections(text), project), name, occurrence);
  if (!hit) return null;
  // 0.39.19 注解保留：定位/删除/改标签的跨度都从注解块起点起算
  const start = annotationBlockStart(text, hit.at);
  const { cut } = classSpan(text.slice(start), hit.at - start);
  return { from: start, to: start + cut, line: newlineCount(text, start) };
}

/**
 * 从库笔记里删除某项目下某个类的源码（面板删除用）。
 * 与 {@link removeDdlEntry} 同构：删类体 + 行尾换行 + 紧跟的空白行，删空后
 * 的 ```java 围栏整块拿掉（复用 ddl.ts 的 dropEmptyFence——先从这导出）。
 */
export function removeClassEntry(
  existing: string,
  name: string,
  project = "",
  occurrence?: number | null,
): { text: string; line: number } | null {
  const hit = locateClassEntry(existing, name, project, occurrence);
  if (!hit) return null;
  // 0.39：元数据块（@tags/@time）一并删除（同 removeDdlEntry）
  const meta = metaBlockAbove(existing, hit.from);
  const from = meta ? meta.start : hit.from;
  let end = hit.to;
  if (existing.startsWith("\r\n", end)) end += 2;
  else if (existing[end] === "\n") end += 1;
  for (;;) {
    const nl = existing.indexOf("\n", end);
    const lineEnd = nl < 0 ? existing.length : nl + 1;
    if (lineEnd === end || existing.slice(end, lineEnd).trim() !== "") break;
    end = lineEnd;
  }
  let text = existing.slice(0, from) + existing.slice(end);
  text = dropEmptyFence(text, from);
  return { text, line: hit.line };
}

/** 给某个类定义写标签（0.39；面板「设置标签」用，同 setDdlEntryTags）。 */
export function setClassEntryTags(
  text: string,
  name: string,
  project = "",
  tags: string[],
  options: { mode?: "set" | "add"; occurrence?: number | null } = {},
): { text: string } | null {
  const hit = locateClassEntry(text, name, project, options.occurrence);
  if (!hit) return null;
  return {
    text: applyStatementTags(
      text,
      hit.from,
      project,
      tags,
      "java",
      options.mode ?? "set",
    ),
  };
}

/** pos 之前的换行数（0 基行号）。 */
function newlineCount(text: string, pos: number): number {
  let count = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < pos; i = text.indexOf("\n", i + 1)) count += 1;
  return count;
}

// -------------------------------------------------------- Java 着色纯函数

export interface JavaToken {
  from: number;
  text: string;
  /** 与 SqlToken 同一套类名（弹窗复用同一组 CSS）：kw 关键字/注解、str 字符串、
      id 标识符、num 数字、cmt 注释。 */
  cls: "kw" | "str" | "id" | "num" | "cmt";
}

const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
  "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
  "new", "package", "private", "protected", "public", "record", "return", "sealed", "short",
  "static", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try",
  "var", "void", "volatile", "while", "true", "false", "null",
]);

/**
 * Java 源码 → 着色 token 序列（纯函数）。规则：`//` 与 `/* *\/` 注释、"..."
 * 字符串、'...' 字符、@注解、数字、关键字（词边界）；落单的引号按普通文本走。
 */
export function tokenizeJava(code: string): JavaToken[] {
  const out: JavaToken[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") {
      let end = code.indexOf("\n", i);
      if (end < 0) end = code.length;
      out.push({ from: i, text: code.slice(i, end), cls: "cmt" });
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out.push({ from: i, text: code.slice(i, stop), cls: "cmt" });
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) {
        if (code[j] === "\\") j += 1;
        if (code[j] === "\n") break; // 落单引号（没有同行收口）按普通文本走
        j += 1;
      }
      if (j < code.length && code[j] === ch) {
        out.push({ from: i, text: code.slice(i, j + 1), cls: "str" });
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "@" && /[A-Za-z]/.test(code[i + 1] ?? "")) {
      let end = i + 1;
      while (end < code.length && /[A-Za-z0-9_.]/.test(code[end])) end += 1;
      out.push({ from: i, text: code.slice(i, end), cls: "kw" });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[0-9a-fA-FxX._lL]/.test(code[end])) end += 1;
      out.push({ from: i, text: code.slice(i, end), cls: "num" });
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[A-Za-z0-9_$]/.test(code[end])) end += 1;
      const word = code.slice(i, end);
      if (JAVA_KEYWORDS.has(word)) {
        out.push({ from: i, text: word, cls: "kw" });
      } else {
        out.push({ from: i, text: word, cls: "id" });
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 文本里第一个已收录的类名（大小写敏感；复合单元格文本逐词试库）。 */
export function classWordInText(text: string, classes: ClassLibrary): string | null {
  for (const token of text.split(/[^A-Za-z0-9_$]+/)) {
    if (token && classes.has(token)) return token;
  }
  return null;
}

export type { DdlEntry, DdlLibrary };

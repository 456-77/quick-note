/**
 * 建表语句库（0.31 用户反馈）：把 CREATE TABLE 语句集中存进仓库内一篇笔记，
 * 笔记里出现表名时悬浮显示该表的建表语句。
 *
 * ## 收录格式
 *
 * 整篇笔记全文扫描（说明文字里的 ```sql 围栏块、散落的语句都算）：每条
 * `CREATE TABLE [IF NOT EXISTS] \`tbl\` (...)` 按**表名**收录，值是从 CREATE
 * 到语句结束分号的完整文本。同名表以最后一次出现为准（手工编辑不必先删旧的）。
 *
 * ## 多项目（0.34.13 用户反馈「同时开发多个项目，存在表名复用」）
 *
 * 笔记里用 `## 项目名`（h2~h6）起段落，段落里的语句归属该项目；第一个 `##`
 * 标题之前的语句属「未分组」（project = ""，兼容老笔记——老笔记没有段落，
 * 全部语句落在这里，行为与单项目版完全一致）。同名表可以在不同项目里各存
 * 一份（悬浮弹窗里可切换）；同一项目内同名仍以最后一次出现为准。
 *
 * ## 纯函数
 *
 * 不碰 DOM、不碰 Tauri，Node 里直接断言（verify-all 的一节）。
 */

const CREATE_RE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([A-Za-z_][A-Za-z0-9_$#.]*)[`"\]]?/gi;

/** 库里的一条语句：project "" = 未分组（老笔记兼容）。 */
export interface DdlEntry {
  project: string;
  ddl: string;
}

/** 表名（小写）→ 该表在各项目里的语句（出现顺序）。 */
export type DdlLibrary = Map<string, DdlEntry[]>;

/** 一个项目段落在文本中的区间 [from, to)（to 是下一个 `##` 标题的起点或文末）。 */
export interface DdlSection {
  project: string;
  from: number;
  to: number;
}

/** `## 项目名`（h2~h6 都算；`# ` 一级标题是文档题头，不算项目段落）。 */
const SECTION_RE = /^#{2,6}[ \t]+(.+?)[ \t]*$/;

/**
 * 把笔记切成项目段落。第一个 `##` 之前的区域是「未分组」（project = ""），
 * 永远存在于返回值里（可能是空区间）。段落区间含标题行本身（合并时要往段落
 * 末尾插入，标题行只是边界参照）。
 *
 * 逐行扫描而不是全文正则：``` 围栏里的行不算标题（MySQL 的 `#` 行注释、
 * SQL 里的 `##` 开头注释不该把段落劈开）；按字符下标扫描，CRLF 也对齐。
 */
export function ddlSections(text: string): DdlSection[] {
  const sections: DdlSection[] = [{ project: "", from: 0, to: text.length }];
  let pos = 0;
  let inFence = false;
  for (;;) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : text[nl - 1] === "\r" ? nl - 1 : nl;
    const line = text.slice(pos, lineEnd);
    if (/^[ \t]*```/.test(line)) inFence = !inFence;
    const head = inFence ? null : SECTION_RE.exec(line);
    if (head) {
      const prev = sections[sections.length - 1];
      prev.to = pos;
      sections.push({ project: head[1].trim(), from: pos, to: nl < 0 ? text.length : nl + 1 });
    } else if (sections.length > 0) {
      const prev = sections[sections.length - 1];
      prev.to = nl < 0 ? text.length : nl + 1;
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  return sections;
}

/** pos 落在哪个段落里（段落按 from 升序；返回最后一个 from ≤ pos 的段落）。 */
export function sectionProjectAt(sections: DdlSection[], pos: number): string {
  let project = "";
  for (const section of sections) {
    if (section.from > pos) break;
    project = section.project;
  }
  return project;
}

/** 文本里出现过的全部项目名（按出现顺序去重；"" = 未分组，有未分组语句才含）。 */
export function ddlProjectNames(text: string): string[] {
  const names: string[] = [];
  for (const section of ddlSections(text)) {
    if (!names.includes(section.project)) names.push(section.project);
  }
  return names;
}


/**
 * 语句结束分号的位置：跳过 `'...'` 字符串与 `--` 行注释里的分号（COMMENT
 * '备注;尾巴' 这类很常见，按裸分号截会把一条语句劈成两半）。
 */
export function endOfStatement(text: string): number {
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (ch === ";") return i;
  }
  return -1;
}

/**
 * 从一段 DDL 文本（可以是整篇笔记）里抽出全部建表语句，按项目分段归组。
 *
 * `create table t (` 没有收口分号的（粘贴残段）按「到 120_000 字符」兜底收录——
 * 悬浮预览宁可多给半条，也好过给了表名却悬浮不出来。0.37.2 用户反馈「ddl 语句
 * 内容过长保存时被截断」：兜底此前是 4000，而无分号的完整长语句（几百行的表
 * 轻松过万）正好落进它被拦腰截断、再原样存回库里——兜底的职责是"别让残段吞掉
 * 整篇笔记"，不是限制合法语句的长度，提到远超真实语句的量级。同名表：不同项目
 * 各留一条；同一项目内以最后一次出现为准（手工编辑不必先删旧的）。
 */
export function parseDdlTables(text: string): DdlLibrary {
  const out: DdlLibrary = new Map();
  const sections = ddlSections(text);
  CREATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_RE.exec(text)) !== null) {
    const table = match[1];
    const rest = text.slice(match.index);
    const { cut, advance } = statementSpan(rest, match[0].length);
    const ddl = stripFenceLines(rest.slice(0, cut));
    if (table && ddl) {
      const key = table.toLowerCase();
      const project = sectionProjectAt(sections, match.index);
      const entries = (out.get(key) ?? []).filter((entry) => entry.project !== project);
      entries.push({ project, ddl });
      out.set(key, entries);
    }
    // 消费掉语句体再继续扫（advance ≥ 匹配头部长度，游标永远向前）
    CREATE_RE.lastIndex = match.index + advance;
  }
  return out;
}

const CREATE_LINE_RE = /^create\s+table\b/i;

/**
 * 语句的「硬边界」：从 from 起找最早的**围栏行**（``` 开头）或**下一条
 * CREATE TABLE 行**的行首（返回绝对下标）。
 *
 * 为什么需要它（0.32 用户反馈「DDL 弹窗有多余的内容」）：粘贴的残段常没有
 * 收口分号，`endOfStatement` 会一路吃到**别人家**语句的分号，把闭合围栏、
 * 说明文字、甚至下一张表的 CREATE 整段吞进悬浮内容。一条建表语句里不可能
 * 再出现一条 CREATE，围栏行也不属于语句体——它们都按语句终点处理。字符串
 * 与 `--` 注释里的围栏/create 不算边界。找不到返回 -1。
 */
export function nextStatementBoundary(text: string, from: number): number {
  let inString = false;
  let atLineStart = true;
  let lead = 0; // 行首已扫过的空白宽度
  for (let i = Math.max(0, from); i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") inString = false;
      else if (ch === "\n") {
        atLineStart = true;
        lead = 0;
      }
      continue;
    }
    if (ch === "\n") {
      atLineStart = true;
      lead = 0;
      continue;
    }
    if (atLineStart) {
      if (ch === " " || ch === "\t" || ch === "\r") {
        lead += 1;
        continue;
      }
      if (ch === "`" && text.startsWith("```", i)) return i - lead;
      if (CREATE_LINE_RE.test(text.slice(i, i + 32))) return i - lead;
      atLineStart = false;
      lead = 0;
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl - 1; // 下一轮落在 \n 上，行首标记在那里翻
      continue;
    }
  }
  return -1;
}

/** 去掉首尾整行的围栏标记（``` / ```sql）：悬浮预览只展示语句本身。 */
function stripFenceLines(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && /^\s*```/.test(lines[0])) lines.shift();
  while (lines.length > 0 && /^\s*```/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n").trim();
}

/**
 * 一条 CREATE 语句的取值范围（相对语句起点）：分号收口、硬边界、残段兜底
 * （120_000 字符，0.37.2 前是 4000——会把无分号的长语句拦腰截断，勿回调小）
 * 三者取最早；`end` 带回游标推进量（parse 与 merge 共用同一套切法）。
 */
function statementSpan(text: string, headEnd: number): { cut: number; advance: number } {
  const semi = endOfStatement(text);
  let cut = semi >= 0 ? semi + 1 : Math.min(text.length, 120_000);
  const bound = nextStatementBoundary(text, headEnd);
  if (bound >= 0 && bound < cut) cut = bound;
  return { cut, advance: Math.max(cut, headEnd) };
}

/** 一段文本里出现的全部表名（保持出现顺序，去重；小写化便于匹配）。 */
export function extractTableNames(text: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  CREATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_RE.exec(text)) !== null) {
    const table = match[1].toLowerCase();
    if (!seen.has(table)) {
      seen.add(table);
      order.push(table);
    }
  }
  return order;
}

/** 表名（CREATE 里的裸名/反引号名）→ 匹配该表 CREATE 起点的正则。 */
function tableAt(table: string, flags: string): RegExp {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 开侧包裹符（` " [ 可选）与闭侧包裹符（` " ] 可选）——与 CREATE_RE 同一套
  const open = '[`"[]?';
  const close = '[`"\\]]?';
  return new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${open}${escaped}${close}`,
    flags,
  );
}

/**
 * 把新的一批建表语句合进 DDL 笔记的现有文本（弹窗「收录」用）。
 *
 * 策略（0.34.13 多项目）：`project` 对整批语句生效（弹窗里选定的项目）。同名
 * 表的旧段在**目标项目的段落内**整段替换（旧 CREATE 到它的分号，分号定位同样
 * 跳过字符串/注释；多张表从后往前替换，位置不漂移）；段落内没有的追加到该段
 * 落末尾（下一个 `##` 标题之前），项目不存在就在文末新建 `## 项目` 段落；
 * 未分组（project = ""）没有段落时追加到文末——与单项目版行为一致。
 * 用户自己的说明文字原样保留。返回新文本；无变化返回原串（调用方据此跳过写盘）。
 */
export function mergeDdlIntoNote(existing: string, incoming: string, project = ""): string {
  const fresh = parseDdlTables(incoming);
  if (fresh.size === 0) return existing;
  // 收录弹窗选定的项目对整批生效；同表多次出现取最后一次（与旧约定一致）
  const batch = new Map<string, string>();
  for (const [table, entries] of fresh) {
    batch.set(table, entries[entries.length - 1].ddl);
  }

  let text = existing;
  const replaced = new Set<string>();
  const target = ddlSections(text).find((section) => section.project === project);
  if (target) {
    const span = text.slice(target.from, target.to);
    const hits: Array<{ at: number; headLen: number; ddl: string }> = [];
    for (const [table, ddl] of batch) {
      const at = tableAt(table, "gi").exec(span);
      if (at) {
        hits.push({ at: at.index, headLen: at[0].length, ddl });
        replaced.add(table);
      }
    }
    // 从后往前替换：前面的位置不受后面替换影响
    hits.sort((a, b) => b.at - a.at);
    for (const hit of hits) {
      const abs = target.from + hit.at;
      const { advance } = statementSpan(text.slice(abs), hit.headLen);
      text = text.slice(0, abs) + hit.ddl + text.slice(abs + advance);
    }
  }

  const pending = [...batch].filter(([table]) => !replaced.has(table)).map(([, ddl]) => ddl);
  if (pending.length === 0) return text;
  const block = pending.join("\n\n");
  const targetNow = ddlSections(text).find((section) => section.project === project);
  if (targetNow) {
    // 插到目标段落末尾：段落边界收干净空白，新语句用 ```sql 围栏块垫进去
    const insert = `\n\n\`\`\`sql\n${block}\n\`\`\`\n`;
    const head = text.slice(0, targetNow.to).replace(/\s*$/, "\n");
    const tail = text.slice(targetNow.to).replace(/^\n*/, "");
    return head + insert + tail;
  }
  // 项目还不存在：文末新建段落。未分组（""）也走到这里吗？不会——未分组
  // 段落永远存在（ddlSections 恒含 "" 段），只有具名项目才会新建
  const section = `\n\n## ${project}\n\n\`\`\`sql\n${block}\n\`\`\`\n`;
  return text.replace(/\s*$/, "") + section;
}

/** DDL 笔记的初始内容（第一次收录时创建）。 */
export function ddlNoteIntro(): string {
  return [
    "# 数据库表 DDL",
    "",
    "建表语句集中收录在这里（设置里可改路径、开关悬浮预览）。笔记里光标悬停在已收录的表名上，会浮动显示该表的建表语句；快捷键（默认 Ctrl+Alt+J，可改绑）弹窗可继续收录新的语句。",
    "",
  ].join("\n");
}

// -------------------------------------------------------- 管理面板配套（0.35.1）

/** 非全局版 CREATE 头匹配（表名反查显示名用；CREATE_RE 带 g 有 lastIndex 状态）。 */
const CREATE_ONE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([A-Za-z_][A-Za-z0-9_$#.]*)[`"\]]?/i;

/** 从语句文本里反查表名（面板显示用；库 Map 的键是小写名）。 */
export function ddlEntryName(ddl: string): string {
  return CREATE_ONE.exec(ddl)?.[1] ?? "";
}

/**
 * 在库笔记里定位某项目下某张表的语句（面板「定位/删除」用）。
 *
 * 定位口径与收录替换一致：在目标项目段落内找**最后一次**出现的 CREATE 头
 * （解析与合并都以最后一次出现为准），再按同一套 statementSpan 切出语句体。
 * 返回 span（字符区间）与 line（0 基行号，openNoteAt 的行参数口径）；
 * 段落/表都不存在返回 null。
 */
export function locateDdlEntry(
  text: string,
  table: string,
  project = "",
): { from: number; to: number; line: number } | null {
  const section = ddlSections(text).find((sec) => sec.project === project);
  if (!section || section.to <= section.from) return null;
  const span = text.slice(section.from, section.to);
  const re = tableAt(table, "gi");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(span); m !== null; m = re.exec(span)) last = m;
  if (!last) return null;
  const abs = section.from + last.index;
  const { cut } = statementSpan(text.slice(abs), last[0].length);
  return { from: abs, to: abs + cut, line: newlineCount(text, abs) };
}

/**
 * 从库笔记里删除某项目下某张表的语句（面板删除用）。
 *
 * 删语句本体 + 行尾换行 + 紧跟的整行空白行（不留双空行）；语句删空导致围栏块
 * 只剩语言标签行时把整块围栏拿掉。返回新文本与语句原所在行（0 基）；
 * 找不到返回 null（调用方提示），原文不动。
 */
export function removeDdlEntry(
  existing: string,
  table: string,
  project = "",
): { text: string; line: number } | null {
  const hit = locateDdlEntry(existing, table, project);
  if (!hit) return null;
  let end = hit.to;
  // 语句自己的行尾换行
  if (existing.startsWith("\r\n", end)) end += 2;
  else if (existing[end] === "\n") end += 1;
  // 之后的整行空白行一并吞掉（不产生连续空行；内容行/围栏行即停）
  for (;;) {
    const nl = existing.indexOf("\n", end);
    const lineEnd = nl < 0 ? existing.length : nl + 1;
    if (lineEnd === end || existing.slice(end, lineEnd).trim() !== "") break;
    end = lineEnd;
  }
  let text = existing.slice(0, hit.from) + existing.slice(end);
  text = dropEmptyFence(text, hit.from);
  return { text, line: hit.line };
}

/**
 * 删空语句后清理只剩语言标签行的空围栏块（```sql / ```java）。
 * 从 at 往前找最近的围栏开头、往后找闭合，体内只剩空白才动；找不到/还有
 * 内容一律原样返回。
 */
export function dropEmptyFence(text: string, at: number): string {
  const openAt = text.lastIndexOf("```", Math.max(0, at - 1));
  if (openAt < 0) return text;
  const closeAt = text.indexOf("```", at);
  if (closeAt < 0) return text;
  const body = text.slice(openAt + 3, closeAt);
  const nl = body.indexOf("\n");
  if (nl < 0) return text;
  if (!/^[ \t]*(sql|java)?[ \t]*$/.test(body.slice(0, nl))) return text;
  if (!/^\s*$/.test(body.slice(nl + 1))) return text;
  let start = text.lastIndexOf("\n", openAt) + 1;
  // 围栏前若正好留了一个空行，收掉一个避免双空行
  if (text.slice(0, start).endsWith("\n\n")) start -= 1;
  let end = closeAt + 3;
  if (text[end] === "\r") end += 1;
  if (text[end] === "\n") end += 1;
  return text.slice(0, start) + text.slice(end);
}

/** pos 之前的换行数（= 0 基行号；CRLF 也按一个换行算）。 */
function newlineCount(text: string, pos: number): number {
  let count = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < pos; i = text.indexOf("\n", i + 1)) count += 1;
  return count;
}

// -------------------------------------------------------- 悬浮配套纯函数
//
// 放在这个纯模块里（而不是 ddlHover.ts）：Node 侧 verify 直接断言，不必拉起
// @codemirror/view。

/**
 * 建表语句的表级 COMMENT（0.38 用户反馈「通常会有 comment 说明表的作用，考虑
 * 在弹窗标题处添加表的 comment」）：取**最后一个右括号**之后（列定义结束后的
 * 表选项区）第一个 COMMENT='…' 的值，'' 转义还原成单引号。列内 COMMENT 不算
 * （都落在末括号之前）；没有表级 COMMENT 返回 null。
 */
export function tableCommentOf(ddl: string): string | null {
  const closeAt = ddl.lastIndexOf(")");
  if (closeAt < 0) return null;
  const tail = ddl.slice(closeAt);
  const hit = /COMMENT\s*=\s*'((?:[^']|'')*)'/i.exec(tail);
  if (!hit) return null;
  const text = hit[1].replace(/''/g, "'").trim();
  return text || null;
}

/** 文本里第一个已收录的表名：单元格内容可能是「ids_task、ids_task_itf」这类
 * 复合文本，逐词试库；找不到返回 null。 */
export function tableWordInText(text: string, tables: DdlLibrary): string | null {
  for (const token of text.toLowerCase().split(/[^a-z0-9_$.]+/)) {
    if (token && tables.has(token)) return token;
  }
  return null;
}

/** SQL 着色的 token（0.32）：kw 关键字 / str 字符串 / id 反引号标识符 / num 数字 / cmt 行注释。 */
export interface SqlToken {
  /** token 起点在原文中的下标（渲染按它穿插未着色的普通文本）。 */
  from: number;
  text: string;
  cls: "kw" | "str" | "id" | "num" | "cmt";
}

const SQL_KEYWORDS = new Set([
  // 语句与约束
  "create", "table", "if", "not", "exists", "primary", "key", "unique", "foreign",
  "references", "constraint", "default", "null", "comment", "engine", "using",
  "auto_increment", "charset", "collate", "on", "delete", "update", "cascade",
  "restrict", "index", "fulltext", "partition", "by", "begin", "end",
  // 类型
  "int", "integer", "tinyint", "smallint", "mediumint", "bigint", "decimal",
  "numeric", "float", "double", "bit", "char", "varchar", "text", "tinytext",
  "mediumtext", "longtext", "blob", "tinyblob", "mediumblob", "longblob",
  "date", "datetime", "timestamp", "time", "year", "boolean", "bool", "enum",
  "json", "serial", "real",
  // 常见表选项值
  "btree", "hash", "innodb", "myisam", "memory", "current_timestamp",
  "unsigned", "zerofill", "generated", "always", "virtual", "stored", "as",
]);

/**
 * DDL 文本 → 着色 token 序列（纯函数）。规则刻意简单：`--` 行注释、'...'
 * 字符串、\`...\` 标识符、数字、关键字（词边界 + 大小写不敏感）；未分类的
 * 片段不出现在结果里（DOM 渲染时按原文顺序穿插普通文本节点）。
 */
export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      let end = sql.indexOf("\n", i);
      if (end < 0) end = sql.length;
      out.push({ from: i, text: sql.slice(i, end), cls: "cmt" });
      i = end;
      continue;
    }
    if (ch === "'" || ch === "`") {
      let end = sql.indexOf(ch, i + 1);
      while (end >= 0 && sql[end - 1] === "\\") end = sql.indexOf(ch, end + 1);
      const stop = end < 0 ? sql.length : end + 1;
      const slice = sql.slice(i, stop);
      const nl = slice.indexOf("\n");
      if (nl >= 0) {
        // 落单引号（没有同行收口）：按普通文本走
        i += nl;
        continue;
      }
      out.push({ from: i, text: slice, cls: ch === "'" ? "str" : "id" });
      i = stop;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[0-9a-fA-Fx.]/.test(sql[end])) end += 1;
      out.push({ from: i, text: sql.slice(i, end), cls: "num" });
      i = end;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      const word = sql.slice(i, end);
      if (SQL_KEYWORDS.has(word.toLowerCase())) {
        out.push({ from: i, text: word, cls: "kw" });
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

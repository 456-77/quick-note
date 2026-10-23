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
 * ## 纯函数
 *
 * 不碰 DOM、不碰 Tauri，Node 里直接断言（verify-all 的一节）。
 */

const CREATE_RE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([A-Za-z_][A-Za-z0-9_$#.]*)[`"\]]?/gi;

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
 * 从一段 DDL 文本（可以是整篇笔记）里抽出全部建表语句。
 *
 * `create table t (` 没有收口分号的（粘贴残段）按「到 4000 字符」兜底收录——
 * 悬浮预览宁可多给半条，也好过给了表名却悬浮不出来。
 */
export function parseDdlTables(text: string): Map<string, string> {
  const out = new Map<string, string>();
  CREATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_RE.exec(text)) !== null) {
    const table = match[1];
    const rest = text.slice(match.index);
    const { cut, advance } = statementSpan(rest, match[0].length);
    const ddl = stripFenceLines(rest.slice(0, cut));
    if (table && ddl) out.set(table.toLowerCase(), ddl);
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
 * 一条 CREATE 语句的取值范围（相对语句起点）：分号收口、硬边界、4000 字
 * 兜底三者取最早；`end` 带回游标推进量（parse 与 merge 共用同一套切法）。
 */
function statementSpan(text: string, headEnd: number): { cut: number; advance: number } {
  const semi = endOfStatement(text);
  let cut = semi >= 0 ? semi + 1 : Math.min(text.length, 4000);
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
 * 策略：同名表的旧段**整段替换**（旧 CREATE 到它的分号，分号定位同样跳过
 * 字符串/注释）；笔记里没有旧段的追加到文末一个 ```sql 围栏块。用户自己的
 * 说明文字原样保留。返回新文本；无变化返回原串（调用方据此跳过写盘）。
 */
export function mergeDdlIntoNote(existing: string, incoming: string): string {
  const fresh = parseDdlTables(incoming);
  if (fresh.size === 0) return existing;
  let text = existing;
  for (const [table, ddl] of fresh) {
    const at = tableAt(table, "gi").exec(text);
    if (!at) continue;
    // 替换范围与解析同源（statementSpan）：旧段没有分号时也不能吃到别人家
    // 语句的分号——否则整段替换会吞掉后面的围栏与下一张表（0.32 修复）
    const { advance } = statementSpan(text.slice(at.index), at[0].length);
    text = text.slice(0, at.index) + ddl + text.slice(at.index + advance);
  }
  // 笔记里还找不到落脚点的（前面替换过的不在此列）追加到文末
  const remaining = new Map<string, string>();
  for (const [table, ddl] of fresh) {
    if (!tableAt(table, "i").exec(text)) remaining.set(table, ddl);
  }
  const base = text.replace(/\s*$/, "");
  if (remaining.size === 0) return base === existing ? existing : base;
  const block = [...remaining.values()].join("\n\n");
  const head = base.length === 0 ? "" : base + "\n\n";
  return `${head}\`\`\`sql\n${block}\n\`\`\`\n`;
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

// -------------------------------------------------------- 悬浮配套纯函数
//
// 放在这个纯模块里（而不是 ddlHover.ts）：Node 侧 verify 直接断言，不必拉起
// @codemirror/view。

/** 文本里第一个已收录的表名：单元格内容可能是「ids_task、ids_task_itf」这类
 * 复合文本，逐词试库；找不到返回 null。 */
export function tableWordInText(text: string, tables: Map<string, string>): string | null {
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

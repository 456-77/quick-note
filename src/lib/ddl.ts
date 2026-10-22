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
    const end = endOfStatement(rest);
    const ddl = (end >= 0 ? rest.slice(0, end + 1) : rest.slice(0, 4000)).trim();
    if (table && ddl) out.set(table.toLowerCase(), ddl);
    // 消费掉语句体再继续扫（没有分号时游标已在匹配尾部，自然前进）
    if (end >= 0) CREATE_RE.lastIndex = match.index + end + 1;
  }
  return out;
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
    const end = endOfStatement(text.slice(at.index));
    const stop = end >= 0 ? at.index + end + 1 : Math.min(at.index + 4000, text.length);
    // 替换串用函数形式：DDL 里的 $& / $1 不能被当替换占位符解释
    text = text.slice(0, at.index) + ddl + text.slice(stop);
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
    "建表语句集中收录在这里（设置里可改路径、开关悬浮预览）。笔记里光标悬停在已收录的表名上，会浮动显示该表的建表语句；Ctrl+Alt+T 弹窗可继续收录新的语句。",
    "",
  ].join("\n");
}

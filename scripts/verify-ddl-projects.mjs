// 0.34.13 多项目语句库断言：ddlSections 段落切割（围栏/CRLF）、parseDdlTables
// 与 parseClassLibrary 的按项目归组、mergeDdlIntoNote / mergeClassesIntoNote 的
// 段落内替换与段落末尾追加、新项目段落落盘。跑法：node --experimental-strip-types。

import {
  ddlSections,
  ddlProjectNames,
  parseDdlTables,
  mergeDdlIntoNote,
  tableCommentOf,
  removeDdlEntry,
  locateDdlEntry,
} from "../src/lib/ddl.ts";
import { parseClassLibrary, mergeClassesIntoNote, extractClassNames } from "../src/lib/javaEntity.ts";

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };

// ---------------- ddlSections ----------------
{
  const text = "# 题头\n\n正文\n\n## 海亮\n\n```sql\nCREATE TABLE a (x int);\n```\n\n## 中粮\n\n```sql\nCREATE TABLE a (y int);\n```\n";
  const sections = ddlSections(text);
  assert(sections.length === 3, "题头未分组 + 两个项目段落");
  assert(sections[0].project === "" && sections[1].project === "海亮" && sections[2].project === "中粮", "段落名");
  assert(text.slice(sections[0].from, sections[0].to).includes("题头"), "未分组区间含题头");
  assert(text.slice(sections[1].from, sections[1].to).includes("CREATE TABLE a (x"), "海亮区间含其语句");
  assert(!text.slice(sections[1].from, sections[1].to).includes("(y"), "海亮区间不含中粮语句");

  // 围栏里的 `##` 行（MySQL # 注释风格）不算标题
  const fenced = "# T\n\n```sql\nCREATE TABLE t (x int); -- ## 注释样式\n# 也算注释\n```\n";
  assert(ddlSections(fenced).length === 1, "围栏内的 ## 行不切段落");
  // 一级标题不切段落
  assert(ddlSections("# 只有题头\nCREATE TABLE x (a int);\n").length === 1, "h1 不算段落");
}

// ---------------- parseDdlTables ----------------
{
  const text = [
    "## 海亮",
    "```sql",
    "CREATE TABLE `users` (id bigint);",
    "```",
    "",
    "## 中粮",
    "```sql",
    "CREATE TABLE `users` (id bigint, name varchar(10));",
    "CREATE TABLE `orders` (oid bigint);",
    "```",
  ].join("\n");
  const lib = parseDdlTables(text);
  assert(lib.get("users").length === 2, "同名表两个项目各一条");
  assert(lib.get("users")[0].project === "海亮", "第一条海亮");
  assert(lib.get("users")[1].ddl.includes("name varchar"), "第二条中粮且内容正确");
  assert(lib.get("orders").length === 1 && lib.get("orders")[0].project === "中粮", "orders 只在中粮");
  assert(ddlProjectNames(text).join(",") === ",海亮,中粮", "项目名清单（含未分组）");

  // 老笔记（无段落）→ 全部未分组，行为同单项目版
  const legacy = "```sql\nCREATE TABLE `t1` (a int);\nCREATE TABLE `t1` (b int);\n```";
  const legacyLib = parseDdlTables(legacy);
  assert(legacyLib.get("t1").length === 1, "同项目同名以最后一次为准");
  assert(legacyLib.get("t1")[0].project === "" && legacyLib.get("t1")[0].ddl.includes("b int"), "未分组且取后者");
}

// ---------------- mergeDdlIntoNote ----------------
{
  // 段落内整段替换：新版本落回原项目的段落，不动别的项目
  const existing = [
    "# 数据库表 DDL",
    "",
    "## 海亮",
    "",
    "```sql",
    "CREATE TABLE `users` (id bigint);",
    "```",
    "",
    "## 中粮",
    "",
    "```sql",
    "CREATE TABLE `users` (name varchar(9));",
    "```",
  ].join("\n");
  const merged = mergeDdlIntoNote(existing, "CREATE TABLE `users` (id bigint, age int);", "海亮");
  assert(merged.includes("age int"), "新版本已替换进去");
  assert(merged.includes("name varchar(9)"), "中粮的旧版保留（同名表跨项目并存）");
  const repSections = ddlSections(merged);
  const hlPart = merged.slice(repSections[1].from, repSections[1].to);
  const zlPart = merged.slice(repSections[2].from, repSections[2].to);
  assert(hlPart.includes("age int"), "替换落在海亮段落内");
  assert(zlPart.includes("name varchar(9)"), "中粮段落保持原样");

  // 段落内没有的表 → 追加到该项目段落末尾（下一个 ## 之前）
  const merged2 = mergeDdlIntoNote(existing, "CREATE TABLE `orders` (oid bigint);", "海亮");
  const s2 = ddlSections(merged2);
  assert(merged2.slice(s2[1].from, s2[1].to).includes("orders"), "orders 落在海亮段落");
  assert(!merged2.slice(s2[2].from, s2[2].to).includes("orders"), "没有落进中粮段落");

  // 新项目 → 文末新建段落
  const merged3 = mergeDdlIntoNote(existing, "CREATE TABLE `t3` (x int);", "新项目");
  assert(/## 新项目\s*\n+\s*```sql\s*\nCREATE TABLE `t3`/.test(merged3), "文末新建 ## 新项目 段落");

  // 未分组（老行为）：无段落时追加文末；有段落时插到第一个段落之前
  const merged4 = mergeDdlIntoNote(existing, "CREATE TABLE `t4` (x int);", "");
  const s4 = ddlSections(merged4);
  assert(merged4.slice(s4[0].from, s4[0].to).includes("t4"), "未分组语句插在题头区域（第一个段落前）");
}

// ---------------- parseClassLibrary / mergeClassesIntoNote ----------------
{
  const text = [
    "## 海亮",
    "```java",
    "public class User {",
    "  private Long id; // 括号 } 平衡 { 计数",
    "  private String name; /* 注释 } */",
    "}",
    "```",
    "",
    "## 中粮",
    "```java",
    "public class User {",
    "  private String name;",
    "}",
    "",
    "public enum Kind { A, B }",
    "```",
  ].join("\n");
  const lib = parseClassLibrary(text);
  assert(lib.get("User").length === 2, "同名类两个项目各一条");
  assert(lib.get("User")[0].ddl.endsWith("}"), "类体收在配对右括号");
  assert(lib.get("User")[0].ddl.includes("private Long id;"), "海亮版内容");
  assert(lib.get("Kind").length === 1 && lib.get("Kind")[0].project === "中粮", "enum 识别");
  assert(extractClassNames(text).join(",") === "User,Kind", "类名清单");

  const merged = mergeClassesIntoNote(text, "public class User { private Long id; private String phone; }", "海亮");
  const s = ddlSections(merged);
  const hl = merged.slice(s[1].from, s[1].to);
  assert(hl.includes("phone"), "替换落在海亮段落");
  assert(merged.slice(s[2].from, s[2].to).includes("private String name;"), "中粮版不动");
  assert(!hl.includes("name;") || hl.includes("phone"), "海亮段落已是新版");

  const merged2 = mergeClassesIntoNote(text, "public interface Repo { void save(); }", "新项目");
  assert(/## 新项目\s*\n+\s*```java\s*\npublic interface Repo/.test(merged2), "文末新建实体段落");
}

// ---------------- 管理面板：locate / remove（0.35.1） ----------------
{
  const { locateDdlEntry, removeDdlEntry, ddlEntryName, dropEmptyFence } = await import("../src/lib/ddl.ts");
  const { locateClassEntry, removeClassEntry } = await import("../src/lib/javaEntity.ts");

  const note = [
    "# 数据库表 DDL",
    "",
    "## 海亮",
    "",
    "```sql",
    "CREATE TABLE alpha (x int);",
    "",
    "CREATE TABLE beta (y int);",
    "```",
    "",
    "## 中粮",
    "",
    "```sql",
    "CREATE TABLE alpha (z int);",
    "```",
    "",
  ].join("\n");

  // 定位：同名表按项目各归各的；行号是 0 基（openNoteAt 口径）
  const hitA = locateDdlEntry(note, "alpha", "海亮");
  assert(hitA && note.slice(hitA.from, hitA.to).includes("(x int)"), "海亮版 alpha 定位到自己的语句");
  assert(hitA.line === 5, `海亮版 alpha 在第 5 行（0 基），实际 ${hitA?.line}`);
  const hitB = locateDdlEntry(note, "alpha", "中粮");
  assert(hitB && note.slice(hitB.from, hitB.to).includes("(z int)"), "中粮版 alpha 互不干扰");
  assert(locateDdlEntry(note, "alpha", "不存在") === null, "项目不存在 → null");

  // 删除：段落内的删除不越段落；围栏里还有别的语句时围栏保留
  const rm1 = removeDdlEntry(note, "beta", "海亮");
  assert(rm1 && !rm1.text.includes("(y int)"), "删除 beta 后语句消失");
  assert(rm1.text.includes("(x int)") && rm1.text.includes("(z int)"), "其余语句原样保留");
  assert(rm1.text.includes("```sql"), "围栏里还有语句 → 围栏保留");
  assert(!/\n{3,}/.test(rm1.text), "删除处不留连续空行");
  // 解析侧同步：删除后库映射不再含海亮的 beta
  const parsedAfter = parseDdlTables(rm1.text);
  assert(
    !(parsedAfter.get("beta") ?? []).some((entry) => entry.project === "海亮"),
    "删除后解析不到海亮的 beta",
  );

  // 删除：围栏里最后一条 → 空围栏整块拿掉
  const rm2 = removeDdlEntry(rm1.text, "alpha", "海亮");
  assert(rm2 && !rm2.text.includes("(x int)"), "海亮 alpha 删除");
  const sea = rm2.text.slice(rm2.text.indexOf("## 海亮"), rm2.text.indexOf("## 中粮"));
  assert(!sea.includes("```sql"), "段落里语句删空 → 围栏整块清掉", sea);
  assert(parseDdlTables(rm2.text).get("alpha")?.length === 1, "只剩中粮版 alpha");
  assert(removeDdlEntry(rm2.text, "alpha", "海亮") === null, "再删同一条 → null（提示已不存在）");

  // 显示名反查（库 Map 键是小写）
  assert(ddlEntryName("CREATE TABLE `UserOrder` (id int);") === "UserOrder", "反引号表名原样反查");
  assert(ddlEntryName("create table if not exists ids_task (id int);") === "ids_task", "小写输入也反查得到");

  // Java 同构
  const jn = [
    "# Java 实体",
    "",
    "```java",
    "public class Foo {",
    "  int x;",
    "}",
    "",
    "public class Bar {",
    "}",
    "```",
    "",
  ].join("\n");
  const jHit = locateClassEntry(jn, "Foo", "");
  assert(jHit && jHit.line === 3, `Foo 定位在声明行（0 基 3），实际 ${jHit?.line}`);
  const jRm1 = removeClassEntry(jn, "Foo", "");
  assert(jRm1 && jRm1.text.includes("public class Bar") && !jRm1.text.includes("int x;"), "删 Foo 留 Bar");
  assert(jRm1.text.includes("```java"), "围栏还有类 → 保留");
  const jRm2 = removeClassEntry(jRm1.text, "Bar", "");
  assert(jRm2 && !jRm2.text.includes("```java"), "最后一个类删掉 → 空围栏整块清掉", jRm2?.text);
  assert(dropEmptyFence("# T\n\n```sql\n```", 12) === "# T\n", "空围栏清理独立可用（连围栏前的空行收掉）");
  assert(dropEmptyFence("# T\n\n```sql\nCREATE TABLE a (x int);\n```", 12).includes("CREATE TABLE"), "围栏里有语句 → 不动");
}

// ---------------- 超长语句不被兜底截断（0.37.2 用户反馈「保存时被截断」） ----------------
{
  // 真实场景：几百行的大表没有收口分号（从工具里复制出来的 DDL 常不带 ;），
  // 兜底曾是 4000/8000，正好把完整语句拦腰截断、再原样存回库里
  const manyCols = Array.from({ length: 300 }, (_, i) => `  \`col_${i}\` varchar(255) DEFAULT NULL COMMENT '字段${i}'`).join(",\n");
  const longDdl = `CREATE TABLE \`big_table\` (\n${manyCols}\n) ENGINE=InnoDB COMMENT='超长无分号建表语句'`;
  assert(longDdl.length > 9000, `用例自身够长（${longDdl.length} 字符，超过旧 4000 兜底）`);
  const lib = parseDdlTables(`\`\`\`sql\n${longDdl}\n\`\`\`\n`);
  const got = lib.get("big_table")?.[0]?.ddl ?? "";
  assert(got.length === longDdl.length, `无分号长语句完整收录（${got.length} 字符，不再被 4000 截断）`);
  assert(got.endsWith("'超长无分号建表语句'"), "语句尾部完好（引擎选项没被切掉）");
  // 带分号的照旧精确收口
  const lib2 = parseDdlTables(`${longDdl};\n`);
  assert((lib2.get("big_table")?.[0]?.ddl ?? "").endsWith(";"), "有分号 → 分号收口不变");

  // Java 实体同款：超长类（花括号能配对）不再被 8000 打断
  const manyFields = Array.from({ length: 400 }, (_, i) => `  private String field${i};`).join("\n");
  const longClass = `public class HugeEntity {\n${manyFields}\n}`;
  assert(longClass.length > 9000, `用例自身够长（${longClass.length} 字符，超过旧 8000 兜底）`);
  const jlib = parseClassLibrary(`\`\`\`java\n${longClass}\n\`\`\`\n`);
  const jgot = jlib.get("HugeEntity")?.[0]?.ddl ?? "";
  assert(jgot.length === longClass.length, `超长实体类完整收录（${jgot.length} 字符，不再被 8000 截断）`);
  assert(jgot.endsWith("}"), "类尾花括号完好");
  // 真失控残段仍被兜底截住（吞不掉整篇笔记）
  const runaway = `CREATE TABLE loose (x int\n${"x".repeat(200_000)}`;
  const rlib = parseDdlTables(runaway);
  assert((rlib.get("loose")?.[0]?.ddl ?? "").length <= 120_000, "无边界残段仍被兜底上限截住");
}

console.log("DDL/实体多项目断言全部通过");

// ---------------- 表级 COMMENT 与「移动到项目」（0.38 用户反馈批） ----------------
{
  // 表级 COMMENT：弹窗标题旁要展示表的作用说明（取末括号后的表选项区）
  const withComment = "CREATE TABLE `t` (\n  `id` bigint NOT NULL COMMENT '主键',\n  `name` varchar(30) COMMENT '名称''含引号''的'\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='费用项目定义表';";
  assert(tableCommentOf(withComment) === "费用项目定义表", "表级 COMMENT 取末括号后的值", tableCommentOf(withComment));
  // 列 COMMENT 不算（都在末括号之前）
  const colOnly = "CREATE TABLE `t` (\n  `id` bigint NOT NULL COMMENT '主键'\n) ENGINE=InnoDB;";
  assert(tableCommentOf(colOnly) === null, "无表级 COMMENT → null", String(tableCommentOf(colOnly)));
  // '' 转义还原
  const escaped = "CREATE TABLE `t` (\n `a` int\n) COMMENT='it''s a test';";
  assert(tableCommentOf(escaped) === "it's a test", "COMMENT 的 '' 还原成单引号", String(tableCommentOf(escaped)));

  // 移动到项目 = 原段落定位 + 删除 + 目标段落合并（App.moveLibraryEntry 的纯函数链）
  const lib0 = "```sql\nCREATE TABLE `a` (x int);\nCREATE TABLE `b` (y int);\n```\n\n## 海亮\n\n```sql\nCREATE TABLE `c` (z int);\n```\n";
  const located = locateDdlEntry(lib0, "a", "");
  assert(located !== null, "未分组段落定位到 a");
  const stmt = lib0.slice(located.from, located.to);
  const removed = removeDdlEntry(lib0, "a", "");
  assert(removed !== null && !removed.text.includes("CREATE TABLE `a`"), "删除后 a 不在原文");
  assert(removed.text.includes("CREATE TABLE `b`"), "b 完好");
  const moved = mergeDdlIntoNote(removed.text, stmt, "海亮");
  const movedLib = parseDdlTables(moved);
  assert(!movedLib.get("a")?.some((e) => e.project === ""), "移动后未分组不再有 a");
  const movedC = movedLib.get("c")?.at(-1);
  assert(movedC?.project === "海亮", "c 仍在海亮段落");
  const movedA = movedLib.get("a")?.at(-1);
  assert(movedA?.project === "海亮", "a 落进海亮段落", JSON.stringify([...movedLib.keys()]));
  assert(moved.includes("## 海亮") && moved.indexOf("CREATE TABLE `a`") > moved.indexOf("## 海亮"), "a 语句位于海亮段落内");
}

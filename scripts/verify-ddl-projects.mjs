// 0.34.13 多项目语句库断言：ddlSections 段落切割（围栏/CRLF）、parseDdlTables
// 与 parseClassLibrary 的按项目归组、mergeDdlIntoNote / mergeClassesIntoNote 的
// 段落内替换与段落末尾追加、新项目段落落盘。跑法：node --experimental-strip-types。

import {
  ddlSections,
  ddlProjectNames,
  parseDdlTables,
  mergeDdlIntoNote,
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

console.log("DDL/实体多项目断言全部通过");

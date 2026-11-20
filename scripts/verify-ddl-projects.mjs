// 0.34.13 多项目语句库断言：ddlSections 段落切割（围栏/CRLF）、parseDdlTables
// 与 parseClassLibrary 的按项目归组、mergeDdlIntoNote / mergeClassesIntoNote 的
// 段落内替换与段落末尾追加、新项目段落落盘。跑法：node --experimental-strip-types。

import {
  collectLibraryTags,
  ddlSections,
  ddlProjectNames,
  entryTimeOf,
  extractTableNames,
  parseDdlTables,
  parseTagList,
  mergeDdlIntoNote,
  nowStamp,
  setDdlEntryTags,
  tableCommentOf,
  tableWordInText,
  ddlEntryName,
  baseTableName,
  removeDdlEntry,
  locateDdlEntry,
} from "../src/lib/ddl.ts";
import {
  parseClassLibrary,
  mergeClassesIntoNote,
  extractClassNames,
  locateClassEntry,
  removeClassEntry,
  setClassEntryTags,
} from "../src/lib/javaEntity.ts";

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

  // 老笔记（无段落）→ 全部未分组。0.39.21 语义：同项目同名**不同内容**的两份
  // 都保留（同名新增不再丢旧条目）；**内容完全相同**的手工重复仍收成一条
  const legacy = "```sql\nCREATE TABLE `t1` (a int);\nCREATE TABLE `t1` (b int);\n```";
  const legacyLib = parseDdlTables(legacy);
  assert(legacyLib.get("t1").length === 2, "同项目同名不同内容：两份都保留（0.39.21）");
  assert(
    legacyLib.get("t1")[0].project === "" &&
      legacyLib.get("t1")[0].ddl.includes("a int") &&
      legacyLib.get("t1")[1].ddl.includes("b int"),
    "未分组且按出现顺序保留",
  );
  const dupSame = "```sql\nCREATE TABLE `t9` (a int);\nCREATE TABLE `t9` (a int);\n```";
  assert(parseDdlTables(dupSame).get("t9").length === 1, "同项目同名同内容：收成一条（手工重复不吵人）");
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

// ---------------- 0.39.19 类级注解保留 + @ApiModel 实体注释 ----------------
{
  const { classCommentOf } = await import("../src/lib/javaEntity.ts");
  const annotated = [
    "## 海亮",
    "```java",
    "// @tags: A",
    '@ApiModel("检查场景")',
    "@VersionAudit",
    "@Table(",
    '        name = "ids_check_scenario"',
    ")",
    "public class CheckScenario extends AuditDomain {",
    "  private Long id;",
    "}",
    "```",
  ].join("\n");
  const lib = parseClassLibrary(annotated);
  const entry = lib.get("CheckScenario")?.[0];
  assert(entry && entry.ddl.startsWith('@ApiModel("检查场景")'), "解析含类级注解块", entry?.ddl?.slice(0, 40));
  assert(entry.ddl.includes('name = "ids_check_scenario"'), "跨行注解完整保留");
  assert(entry.tags.join(",") === "A", "元数据行仍在注解块之上", JSON.stringify(entry.tags));
  assert(classCommentOf(entry.ddl) === "检查场景", "@ApiModel 提取为实体注释");
  assert(classCommentOf("public class Foo {}") === null, "没有 ApiModel 返回 null");

  // 收录替换：旧条目带注解 → 新源码（也带注解）整块替换，元数据行不丢
  const replaced = mergeClassesIntoNote(
    annotated,
    '@ApiModel("检查场景V2")\n@VersionAudit\npublic class CheckScenario extends AuditDomain { private Long id; }',
    "海亮",
  );
  const re = parseClassLibrary(replaced).get("CheckScenario")[0];
  assert(re.ddl.startsWith('@ApiModel("检查场景V2")'), "替换整块带上新注解", re.ddl.slice(0, 40));
  assert(!replaced.includes('name = "ids_check_scenario"'), "旧跨行注解被替换掉");
  assert(re.tags.join(",") === "A", "替换后元数据行仍在", JSON.stringify(re.tags));

  // 定位跨度含注解；删除连带注解
  const loc = locateClassEntry(annotated, "CheckScenario", "海亮");
  assert(loc && annotated.slice(loc.from, loc.to).startsWith("@ApiModel"), "定位跨度含注解块");
  const rm = removeClassEntry(annotated, "CheckScenario", "海亮");
  assert(rm && !rm.text.includes("CheckScenario") && !rm.text.includes("@ApiModel"), "删除连带注解");
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

// ---------------- 表级 COMMENT 与定位/删除/合并链（0.38 用户反馈批） ----------------
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

  // 定位 + 删除 + 合并链（0.39 面板已把「移动到项目」换成标签，但这套纯函数
  // 仍是收录/删除/悬浮编辑共用的落盘基础：跨段落定位、整段摘除、合并回写）
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

// ---------------- 多标签（0.39 用户反馈「将移动归类到某个项目改成设置标签」） ----------------
{
  assert(parseTagList("运维, out，运维、third").join(",") === "运维,out,third", "标签串解析：中英文逗号/顿号 + 去重");

  // 老笔记没有 @tags 行 → 回落段落名；显式标签行覆盖段落名
  const legacy = "## 海亮\n```sql\nCREATE TABLE `users` (id bigint);\n```\n";
  const legacyEntry = parseDdlTables(legacy).get("users")[0];
  assert(legacyEntry.project === "海亮", "段落名仍是物理分组");
  assert(legacyEntry.tags.join(",") === "海亮", "无 @tags 行回落段落名（零迁移）");

  const both = [
    "## 海亮",
    "```sql",
    "-- @tags: 运维, out, 运维",
    "CREATE TABLE `users` (id bigint);",
    "// @tags: A、B",
    "CREATE TABLE `t2` (y int);",
    "```",
  ].join("\n");
  const bothLib = parseDdlTables(both);
  assert(bothLib.get("users")[0].tags.join(",") === "运维,out", "DDL 标签行解析 + 去重", JSON.stringify(bothLib.get("users")[0].tags));
  assert(bothLib.get("t2")[0].tags.join(",") === "A,B", "`// @tags:` 也认、顿号分隔", JSON.stringify(bothLib.get("t2")[0].tags));
  assert(collectLibraryTags(bothLib).join(",") === "运维,out,A,B", "库内标签顺序去重", collectLibraryTags(bothLib).join(","));

  // 写标签：未分组插入标签行、add 并集、set 覆盖
  const base = "```sql\nCREATE TABLE `t` (x int);\n```\n";
  let res = setDdlEntryTags(base, "t", "", ["运维", "out"]);
  assert(res && res.text.includes("-- @tags: 运维, out\nCREATE TABLE"), "未分组插入标签行", res?.text);
  assert(parseDdlTables(res.text).get("t")[0].tags.join(",") === "运维,out", "标签行解析回读");
  res = setDdlEntryTags(res.text, "t", "", ["新项目"], { mode: "add" });
  assert(parseDdlTables(res.text).get("t")[0].tags.join(",") === "运维,out,新项目", "add 模式取并集");
  res = setDdlEntryTags(res.text, "t", "", ["仅此一个"]);
  assert(parseDdlTables(res.text).get("t")[0].tags.join(",") === "仅此一个", "set 模式整组覆盖");
  res = setDdlEntryTags(res.text, "t", "", []);
  assert(!res.text.includes("@tags"), "未分组清空标签 → 标签行整行删除", res.text);
  assert(parseDdlTables(res.text).get("t")[0].tags.length === 0, "清空后无标签");

  // 具名段落里清空 = 写空标签行（否则会回落到段落名）
  const named = "## 海亮\n```sql\nCREATE TABLE `t` (x int);\n```\n";
  const cleared = setDdlEntryTags(named, "t", "海亮", []);
  assert(cleared.text.includes("-- @tags:\n"), "具名段落清空 → 空标签行覆盖段落名", cleared.text);
  assert(parseDdlTables(cleared.text).get("t")[0].tags.length === 0, "空标签行 = 显式无标签");

  // 无分号残段不能吞掉下一条语句的标签行（0.39：标签行也是硬边界）
  const unclosed = "```sql\nCREATE TABLE `a` (x int\n-- @tags: B\nCREATE TABLE `b` (y int);\n```\n";
  const unclosedLib = parseDdlTables(unclosed);
  assert(!(unclosedLib.get("a")?.[0]?.ddl ?? "").includes("@tags"), "无分号残段不吞下一条的标签行", unclosedLib.get("a")?.[0]?.ddl);
  assert((unclosedLib.get("b")?.[0]?.tags ?? []).join(",") === "B", "下一条语句的标签照常解析");

  // 删除语句连带删标签行；CRLF 文件中插入的标签行跟随 CRLF
  const tagged = "```sql\n-- @tags: A, B\nCREATE TABLE `t` (x int);\nCREATE TABLE `u` (y int);\n```\n";
  const removedTagged = removeDdlEntry(tagged, "t", "");
  assert(removedTagged && !removedTagged.text.includes("@tags"), "删除语句连带删标签行", removedTagged?.text);
  assert(removedTagged.text.includes("CREATE TABLE `u`"), "其它语句保留");
  const crlf = "```sql\r\nCREATE TABLE `t` (x int);\r\n```\r\n";
  const crlfTagged = setDdlEntryTags(crlf, "t", "", ["A"]).text;
  assert(crlfTagged.includes("-- @tags: A\r\nCREATE TABLE"), "CRLF 文件插入标签行不混行尾", JSON.stringify(crlfTagged));

  // Java 实体同构：解析 / 写 / 删
  const jn = "## 海亮\n```java\n// @tags: A, B\npublic class Foo { int x; }\n```\n";
  assert(parseClassLibrary(jn).get("Foo")[0].tags.join(",") === "A,B", "Java 实体标签解析");
  const jSet = setClassEntryTags(jn, "Foo", "海亮", ["C"]);
  assert(parseClassLibrary(jSet.text).get("Foo")[0].tags.join(",") === "C", "Java set 标签落盘");
  const jRm = removeClassEntry(jSet.text, "Foo", "海亮");
  assert(jRm && !jRm.text.includes("@tags"), "Java 删除连带标签行", jRm?.text);
}

// ---------------- 收录时间（0.39 二轮「ddl 也添加时间」） ----------------
{
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(nowStamp()), "nowStamp 格式 YYYY-MM-DD HH:mm", nowStamp());
  assert(entryTimeOf("2026-11-10 14:03") === new Date(2026, 10, 10, 14, 3).getTime(), "entryTimeOf 解析本地时间");
  assert(entryTimeOf("2026-11-10") === new Date(2026, 10, 10).getTime(), "entryTimeOf 兼容纯日期");
  assert(entryTimeOf(undefined) === 0 && entryTimeOf("垃圾") === 0, "无时间/坏串 → 0");

  // 收录（merge）给新语句写 @time 行；替换旧语句不动它原有的时间
  const merged = mergeDdlIntoNote(
    "```sql\nCREATE TABLE `a` (x int);\n```\n",
    "CREATE TABLE `a` (y int);\nCREATE TABLE `b` (z int);",
    "",
    { time: "2026-11-10 14:03" },
  );
  const lib = parseDdlTables(merged);
  assert((lib.get("a")?.[0]?.time ?? "") === "", "替换旧语句保留原时间（无时间→仍无）", lib.get("a")?.[0]?.time);
  const bEntry = lib.get("b")?.[0];
  assert(bEntry?.time === "2026-11-10 14:03", "新追加语句带 @time", bEntry?.time);
  assert(/@time: 2026-11-10 14:03\nCREATE TABLE `b`/.test(merged), "时间行紧贴语句上方", merged);

  // 有 @time 的语句：解析带出时间；设置标签时时间行保留（标签在前、时间在后）
  const tagged = mergeDdlIntoNote("", "CREATE TABLE `t` (x int);", "", { time: "2026-11-10 09:00" });
  const res2 = setDdlEntryTags(tagged, "t", "", ["运维"]);
  const tEntry = parseDdlTables(res2.text).get("t")?.[0];
  assert(tEntry?.time === "2026-11-10 09:00", "设置标签不丢时间", JSON.stringify(tEntry));
  assert(/- @tags: 运维\n-- @time: 2026-11-10 09:00\nCREATE TABLE/.test(res2.text), "标签行在前、时间行在后", res2.text);
  // 清空标签：时间行保留、标签行删掉
  const cleared2 = setDdlEntryTags(res2.text, "t", "", []);
  assert(!cleared2.text.includes("@tags") && cleared2.text.includes("@time"), "未分组清空标签保留时间行", cleared2.text);

  // 删除语句连带整块元数据（@tags + @time）
  const both = "```sql\n-- @tags: A\n-- @time: 2026-11-10 09:00\nCREATE TABLE `t` (x int);\nCREATE TABLE `u` (y int);\n```\n";
  const rmBoth = removeDdlEntry(both, "t", "");
  assert(rmBoth && !rmBoth.text.includes("@tags") && !rmBoth.text.includes("@time"), "删除连带 @tags/@time", rmBoth?.text);
  assert(rmBoth.text.includes("CREATE TABLE `u`"), "其它语句保留");
  // 无分号残段不吞下一条的时间行
  const unclosed2 = "```sql\nCREATE TABLE `a` (x int\n-- @time: 2026-11-10 08:00\nCREATE TABLE `b` (y int);\n```\n";
  assert(!(parseDdlTables(unclosed2).get("a")?.[0]?.ddl ?? "").includes("@time"), "残段不吞时间行");

  // Java 实体同构
  const jMerged = mergeClassesIntoNote("", "public class Foo { int x; }", "", { time: "2026-11-10 10:00" });
  const jEntry = parseClassLibrary(jMerged).get("Foo")?.[0];
  assert(jEntry?.time === "2026-11-10 10:00", "Java 收录带时间", JSON.stringify(jEntry));
  const jTag = setClassEntryTags(jMerged, "Foo", "", ["A"]);
  assert(parseClassLibrary(jTag.text).get("Foo")?.[0]?.time === "2026-11-10 10:00", "Java 设置标签保留时间");
}

console.log("多标签断言全部通过");

// ---------------- 收录弹窗多标签（0.39.8）----------------
{
  // 多于一个值 → 显式 @tags 行（标签行在前、时间行在后）；首个词=归属段落
  const m1 = mergeDdlIntoNote("", "CREATE TABLE `t1` (x int);", "海亮", {
    time: "2026-11-12 23:00",
    tags: ["海亮", "中远"],
  });
  const e1 = parseDdlTables(m1).get("t1")?.[0];
  assert(e1, "多标签收录落库");
  assert(
    JSON.stringify(e1?.tags) === JSON.stringify(["海亮", "中远"]),
    "多标签生效", JSON.stringify(e1?.tags),
  );
  assert(e1?.time === "2026-11-12 23:00", "多标签收录保留时间行");
  const lines = m1.split("\n").filter((l) => l.startsWith("-- @"));
  assert(
    lines[0]?.startsWith("-- @tags:") && lines[1]?.startsWith("-- @time:"),
    "标签行在前时间行在后", lines.join(" | "),
  );

  // 单值也写 @tags 行（0.39.17 起收录没有项目段落，单标签不再回落段落名）
  const m2 = mergeDdlIntoNote("", "CREATE TABLE `t2` (x int);", "海亮", {
    time: "2026-11-12 23:00",
    tags: ["海亮"],
  });
  const sec2 = ddlSections(m2).find((s) => s.project === "海亮");
  assert(sec2 && m2.slice(sec2.from, sec2.to).includes("-- @tags: 海亮"), "单值也写标签行（0.39.17）", m2);
  const e2 = parseDdlTables(m2).get("t2")?.[0];
  assert(JSON.stringify(e2?.tags) === JSON.stringify(["海亮"]), "单值标签解析回读");

  // Java 实体同构
  const m3 = mergeClassesIntoNote("", "public class Foo { int x; }", "海亮", {
    time: "2026-11-12 23:00",
    tags: ["海亮", "问题"],
  });
  const e3 = parseClassLibrary(m3).get("Foo")?.[0];
  assert(
    JSON.stringify(e3?.tags) === JSON.stringify(["海亮", "问题"]),
    "Java 多标签生效", JSON.stringify(e3?.tags),
  );
  assert(e3?.time === "2026-11-12 23:00", "Java 多标签保留时间行");
}

// ---------------- schema 限定名（0.39.16 用户反馈） ----------------
{
  // 裸名 / schema.表名 / 反引号包两段 → 同一个库键（裸表名小写），显示名保留 schema
  assert(baseTableName("lg_znxd.hsdt_hocr_subtask") === "hsdt_hocr_subtask", "裸 + schema 归一");
  assert(baseTableName("`lg_znxd`.`tbl`") === "tbl", "反引号两段归一");
  const lib = parseDdlTables(
    "CREATE TABLE lg_znxd.hsdt_hocr_subtask (id int);\n" +
      "CREATE TABLE `lg_znxd`.`other_tbl` (id int);\n",
  );
  assert(lib.get("hsdt_hocr_subtask")?.length === 1, "schema.表名 按裸名入库");
  assert(lib.get("other_tbl")?.length === 1, "反引号 schema.表名 按裸名入库");
  assert(lib.get("hsdt_hocr_subtask")[0].name === "lg_znxd.hsdt_hocr_subtask", "条目保留限定名显示");
  assert(ddlEntryName("CREATE TABLE `lg_znxd`.`tbl` (id int);") === "lg_znxd.tbl", "显示名去包裹符");

  // 同项目里先收裸名、再收 schema 限定名 = 同一张表，后者替换前者（不产生两行）
  const both =
    "```sql\nCREATE TABLE hsdt_hocr_subtask (a int);\n```\n\n" +
    "```sql\nCREATE TABLE lg_znxd.hsdt_hocr_subtask (b bigint);\n```\n";
  const bothLib = parseDdlTables(both);
  // 0.39.21：同项目同名**不同内容**两条都保留（裸名/限定名归一到同一条目组）
  assert(bothLib.get("hsdt_hocr_subtask")?.length === 2, "同项目同名裸名/限定名两条都保留（0.39.21）");
  assert(bothLib.get("hsdt_hocr_subtask")[1].ddl.includes("b bigint"), "限定名版按出现顺序在后");
  assert(extractTableNames("CREATE TABLE lg_znxd.tbl (id int);").join() === "tbl", "识别表名用裸名");

  // 收录合并：库里是裸名，粘贴 schema 限定名 → 原地替换，不追加副本
  const existingNote = "```sql\nCREATE TABLE tbl (old int);\n```\n";
  const merged = mergeDdlIntoNote(existingNote, "CREATE TABLE lg_znxd.tbl (fresh int);");
  assert((merged.match(/create\s+table/gi) ?? []).length === 1, "限定名收录替换同表旧语句");
  assert(merged.includes("fresh") && !merged.includes("old int"), "旧语句体被替换");

  // 定位/删除：面板显示全名或裸名都能命中
  assert(locateDdlEntry(merged, "tbl") !== null, "裸名定位到限定名语句");
  assert(locateDdlEntry(merged, "lg_znxd.tbl") !== null, "全名定位到限定名语句");
  assert(removeDdlEntry(merged, "tbl") !== null, "裸名删除限定名语句");

  // 悬浮查词：文本里写 schema.表名、库里键是裸名 → 按裸名命中
  const tl = parseDdlTables("CREATE TABLE tbl (id int);");
  assert(tableWordInText("请看 lg_znxd.tbl 这张表", tl) === "tbl", "schema.表名 悬停命中裸名键");

  // 段落切割：漏闭合围栏之后的段落标题仍要识别（旧版把下一段的 ```sql 当闭合，
  // 之后每段奇偶反相，一半项目标题丢失）。裸 ``` 之前的标题属于代码块
  // （与 CommonMark/编辑器一致），之后的必须找回
  const broken =
    "# 库\n\n```sql\nCREATE TABLE a (x int);\n\n## 项目A\n\n```sql\nCREATE TABLE b (y int);\n```\n\n## 项目B\n";
  const names = ddlProjectNames(broken);
  assert(names.includes("项目B"), `漏闭合围栏后段落仍识别：${names.join(",")}`);
  assert(!names.includes("项目A"), "裸闭合围栏之前的标题属于代码块（不当作段落）");
}

// ---------------- 0.39.17：前缀同名 + 重复项目段落 ----------------
{
  // 1) 名字前缀不能串表：`ids_task_itf` 有 @tags，`ids_task` 没有——
  //    给 ids_task 加标签必须落到 ids_task 自己头上，不能命中 ids_task_itf
  //    后被判「已经有这些标签了」（0.39.17 用户实锤症状）。
  const prefixNote = [
    "# 库",
    "",
    "```sql",
    "CREATE TABLE `ids_task` (id int);",
    "```",
    "",
    "```sql",
    "-- @tags: 海亮",
    "CREATE TABLE `ids_task_itf` (id int);",
    "```",
    "",
  ].join("\n");
  const hit = locateDdlEntry(prefixNote, "ids_task", "");
  assert(hit && prefixNote.slice(hit.from, hit.from + 24).includes("`ids_task`"), "前缀同名不串表（定位）");
  const tagged = setDdlEntryTags(prefixNote, "ids_task", "", ["海亮"], { mode: "add" });
  assert(tagged && tagged.text !== prefixNote, "给前缀同名表加标签必须真的写入");
  assert(
    tagged.text.indexOf("-- @tags: 海亮") < tagged.text.indexOf("CREATE TABLE `ids_task` ("),
    "标签落在目标语句上方",
  );
  assert(
    tagged.text.includes("CREATE TABLE `ids_task_itf` (id int);"),
    "不得改写/删除前缀同名表",
  );
  assert(
    parseDdlTables(tagged.text).get("ids_task")?.[0]?.tags.includes("海亮"),
    "加标签后解析回读正确",
  );

  // 2) 重复的项目段落：同名 `## 海亮` 出现两次，语句在后一段——
  //    定位/加标签/删除/收录替换都必须能找到（旧实现只看第一段）。
  const dup = [
    "# 库",
    "",
    "## 海亮",
    "",
    "```sql",
    "CREATE TABLE first_t (id int);",
    "```",
    "",
    "## 海亮",
    "",
    "```sql",
    "CREATE TABLE late_t (id int);",
    "```",
    "",
  ].join("\n");
  const lateHit = locateDdlEntry(dup, "late_t", "海亮");
  assert(lateHit !== null, "重复项目段落里的语句可定位");
  assert(dup.slice(lateHit.from, lateHit.from + 20).includes("late_t"), "定位到正确语句");
  const lateTagged = setDdlEntryTags(dup, "late_t", "海亮", ["运维"], { mode: "add" });
  assert(lateTagged && lateTagged.text !== dup, "重复段落里的语句可加标签");
  const lateRemoved = removeDdlEntry(dup, "late_t", "海亮");
  assert(lateRemoved && !lateRemoved.text.includes("late_t"), "重复段落里的语句可删除");
  const mergedLate = mergeDdlIntoNote(dup, "CREATE TABLE late_t (fresh int);", "海亮");
  assert((mergedLate.match(/create\s+table\s+`?late_t/gi) ?? []).length === 1, "重复段落里收录替换不追加副本");
  assert(mergedLate.includes("fresh"), "替换的是后一段落里的语句");

  // 新语句追加到最后一个同名段落（不在第一段中间插队）
  const mergedNew = mergeDdlIntoNote(dup, "CREATE TABLE brand_new (id int);", "海亮");
  const lastHead = mergedNew.lastIndexOf("## 海亮");
  const newAt = mergedNew.search(/CREATE TABLE `?brand_new/i);
  assert(newAt > lastHead, "新语句追加到最后一个同名段落");

  // 3) Java 实体同构：重复 `## 项目` 段落里的类可定位/加标签
  const javaDup = [
    "# Java",
    "",
    "## 海亮",
    "",
    "```java",
    "public class First { int a; }",
    "```",
    "",
    "## 海亮",
    "",
    "```java",
    "public class Late { int b; }",
    "```",
    "",
  ].join("\n");
  const lateClass = locateClassEntry(javaDup, "Late", "海亮");
  assert(lateClass !== null, "重复段落里的类可定位");
  const classTagged = setClassEntryTags(javaDup, "Late", "海亮", ["运维"], { mode: "add" });
  assert(classTagged && classTagged.text !== javaDup, "重复段落里的类可加标签");
}

console.log("收录多标签断言全部通过");

// ---------------- 0.39.20 收录替换补写标签（用户「设置了标签为什么还显示无标签」） ----------------
{
  const { mergeDdlIntoNote } = await import("../src/lib/ddl.ts");
  const { mergeClassesIntoNote, parseClassLibrary } = await import("../src/lib/javaEntity.ts");

  // DDL：旧表带 @tags: 海亮 + @time，替换时弹窗填了新标签 → 并集写回，时间保留
  const ddlNote = [
    "# 数据库表 DDL",
    "",
    "```sql",
    "-- @tags: 海亮",
    "-- @time: 2026-11-01 09:00",
    "CREATE TABLE alpha (x int);",
    "```",
    "",
  ].join("\n");
  const m1 = mergeDdlIntoNote(ddlNote, "CREATE TABLE alpha (x int, y int);", "", {
    time: "2026-11-18 10:00",
    tags: ["中粮"],
  });
  assert(m1.includes("-- @tags: 海亮, 中粮"), "DDL 替换补写标签=并集", m1.split("\n").slice(2, 3).join(""));
  assert(m1.includes("-- @time: 2026-11-01 09:00"), "替换保留原收录时间");
  assert(!m1.includes("2026-11-18 10:00"), "不新增时间行");

  // 弹窗标签留空 → 原标签原样保留（add 模式空标签直接返回）
  const m2 = mergeDdlIntoNote(ddlNote, "CREATE TABLE alpha (x int, y int);", "", {
    time: "2026-11-18 10:00",
    tags: [],
  });
  assert(m2.includes("-- @tags: 海亮") && !m2.includes("海亮, 中粮"), "空标签替换不动原标签");

  // 旧条目没有元数据块 → 新标签落语句上方（与追加路径布局一致）
  const m3 = mergeDdlIntoNote(
    "# 数据库表 DDL\n\n```sql\nCREATE TABLE beta (x int);\n```\n",
    "CREATE TABLE beta (x int, y int);",
    "",
    { time: "2026-11-18 10:00", tags: ["中粮"] },
  );
  assert(m3.includes("-- @tags: 中粮"), "无元数据旧条目补写新标签", m3.split("\n").slice(2, 3).join(""));

  // Java：替换带注解的旧类（元数据在注解之上）→ 新标签并集、注解跟新源码
  const javaNote = [
    "# Java 实体",
    "",
    "```java",
    "// @tags: 海亮",
    "// @time: 2026-11-01 09:00",
    '@ApiModel("检查")',
    "public class CheckScenario { private Long id; }",
    "```",
    "",
  ].join("\n");
  const j1 = mergeClassesIntoNote(
    javaNote,
    '@ApiModel("检查V2")\npublic class CheckScenario { private Long id; }',
    "",
    { time: "2026-11-18 10:00", tags: ["中粮"] },
  );
  const jEntry = parseClassLibrary(j1).get("CheckScenario")[0];
  assert(jEntry.tags.join(",") === "海亮,中粮", "Java 替换补写标签=并集", JSON.stringify(jEntry.tags));
  assert(jEntry.ddl.startsWith('@ApiModel("检查V2")'), "新注解跟着替换进来", jEntry.ddl.slice(0, 30));
  assert(jEntry.time === "2026-11-01 09:00", "Java 替换保留原时间", jEntry.time ?? "null");
}

console.log("收录替换补标签断言全部通过");

// ---------------- 0.39.21 收录同名新增（append 模式） ----------------
{
  const { mergeDdlIntoNote, parseDdlTables } = await import("../src/lib/ddl.ts");
  const { mergeClassesIntoNote, parseClassLibrary } = await import("../src/lib/javaEntity.ts");

  // DDL：同名旧条目带 @tags: 海亮，append 模式收录新版（内容不同）→ 两条并存
  const ddlNote = "# 数据库表 DDL\n\n```sql\n-- @tags: 海亮\nCREATE TABLE alpha (x int);\n```\n";
  const appended = mergeDdlIntoNote(ddlNote, "CREATE TABLE alpha (x int, y int);", "", {
    time: "2026-11-18 15:00",
    tags: ["中粮"],
    mode: "append",
  });
  const entries = parseDdlTables(appended).get("alpha") ?? [];
  assert(entries.length === 2, "append：同名两条并存", String(entries.length));
  assert(
    entries.some((e) => e.ddl.includes("x int)") || e.ddl.includes("x int);")),
    "append：旧条目原样保留",
  );
  assert(entries.some((e) => e.ddl.includes("y int")), "append：新条目落盘");
  assert(entries.some((e) => e.tags.includes("中粮")), "append：新条目带新标签", JSON.stringify(entries.map((e) => e.tags)));
  assert(entries.some((e) => e.tags.includes("海亮")), "append：旧条目标签不被改");

  // replace 模式仍是覆盖（旧行为不变）
  const replaced = mergeDdlIntoNote(ddlNote, "CREATE TABLE alpha (x int, y int);", "", {
    mode: "replace",
  });
  const repEntries = parseDdlTables(replaced).get("alpha") ?? [];
  assert(
    repEntries.length === 1 && repEntries[0].ddl.includes("y int"),
    "replace：覆盖后只剩一条新版",
    String(repEntries.length),
  );

  // Java：append 同名类两份并存
  const javaNote = "# Java 实体\n\n```java\n// @tags: 海亮\npublic class Foo { int a; }\n```\n";
  const javaAppended = mergeClassesIntoNote(javaNote, "public class Foo { int b; }", "", {
    time: "2026-11-18 15:00",
    tags: ["中粮"],
    mode: "append",
  });
  const jEntries = parseClassLibrary(javaAppended).get("Foo") ?? [];
  assert(jEntries.length === 2, "Java append：同名两份并存", String(jEntries.length));
  assert(jEntries.some((e) => e.ddl.includes("int b")), "Java append：新类体落盘");
  assert(jEntries.some((e) => e.ddl.includes("int a")), "Java append：旧类体原样保留");
  assert(
    jEntries.some((e) => e.tags.includes("海亮")),
    "Java append：旧条目标签不丢",
    JSON.stringify(jEntries.map((e) => e.tags)),
  );
}

console.log("收录同名新增/替换断言全部通过");

// ---------------- 0.39.29 ## 项目段落 → 块内 @tags 注释迁移 ----------------
{
  const { migrateDdlSectionsToTags, migrateSectionsToTagRows, mergeProjectTagAt, untaggedDdlAnchors, parseDdlTables } = await import("../src/lib/ddl.ts");
  const { migrateClassSectionsToTags, untaggedClassAnchors, parseClassLibrary } = await import("../src/lib/javaEntity.ts");

  // 1) DDL 基本迁移：具名段落 → 语句带项目标签行 + 标题删除 + 迁移幂等
  const note = [
    "# 数据库表 DDL",
    "",
    "```sql",
    "-- @tags: 海亮",
    "CREATE TABLE alpha (x int);",
    "```",
    "",
    "```sql",
    "CREATE TABLE beta (y int);",
    "```",
    "",
    "## 中远",
    "",
    "```sql",
    "CREATE TABLE gamma (z int);",
    "```",
    "",
    "## 中粮",
    "",
    "```sql",
    "-- @tags: 测试",
    "-- @time: 2026-11-01 09:00",
    "CREATE TABLE delta (w int);",
    "```",
    "",
  ].join("\n");
  const migrated = migrateDdlSectionsToTags(note);
  assert(migrated !== null, "迁移：有具名段落时返回新文本");
  assert(!migrated.includes("## 中远") && !migrated.includes("## 中粮"), "迁移：标题行被删除", migrated);
  const lib = parseDdlTables(migrated);
  assert((lib.get("gamma") ?? [])[0]?.tags.includes("中远"), "迁移：无标签行语句补项目标签", JSON.stringify([...(lib.get("gamma") ?? [])]));
  assert((lib.get("delta") ?? [])[0]?.tags.join(",") === "中粮,测试", "迁移：已有标签行并到最前", JSON.stringify([...(lib.get("delta") ?? [])]));
  assert((lib.get("delta") ?? [])[0]?.time === "2026-11-01 09:00", "迁移：@time 行原样保留");
  assert((lib.get("alpha") ?? [])[0]?.tags.includes("海亮"), "迁移：未分组区语句不动", JSON.stringify([...(lib.get("alpha") ?? [])]));
  assert(migrateDdlSectionsToTags(migrated) === null, "迁移：迁完后再次迁移=无操作（幂等）");

  // 2) 同项目标签去重：语句已有同名字标签（大小写不同）不重复并
  const dup = migrateDdlSectionsToTags("## 中粮\n\n```sql\n-- @tags: 中粮\nCREATE TABLE t (x int);\n```\n");
  assert(dup !== null && (dup.match(/@tags/g) ?? []).length === 1, "迁移：同名标签去重不重复写行", dup ?? "null");

  // 3) Java 迁移：锚点=注解块起点，标签行落在注解之上
  const jn = [
    "# Java 实体",
    "",
    "## 中粮",
    "",
    "```java",
    '@ApiModel("检查")',
    "public class Foo { int x; }",
    "```",
    "",
  ].join("\n");
  const jm = migrateClassSectionsToTags(jn);
  assert(jm !== null && !jm.includes("## 中粮"), "Java 迁移：标题删除", jm ?? "null");
  const jlib = parseClassLibrary(jm);
  const jEntry = (jlib.get("Foo") ?? [])[0];
  assert(jEntry?.tags.includes("中粮"), "Java 迁移：类带项目标签", JSON.stringify(jEntry?.tags));
  assert(jEntry?.ddl.startsWith('@ApiModel("检查")'), "Java 迁移：注解保留在语句体里");
  assert(jm.indexOf("// @tags: 中粮") < jm.indexOf("@ApiModel"), "Java 迁移：标签行落在注解之上", jm);
  assert(migrateClassSectionsToTags(jm) === null, "Java 迁移：幂等");

  // 4) mergeProjectTagAt：无标签行语句插入、@time 行保持在标签行之后
  const single = "```sql\nCREATE TABLE a (x int);\n```\n";
  const singleAt = single.indexOf("CREATE");
  const withTag = mergeProjectTagAt(single, singleAt, "海亮", "sql");
  assert(withTag.startsWith("```sql\n-- @tags: 海亮\nCREATE"), "mergeProjectTagAt：插入标签行", withTag);
  const withTime = "```sql\n-- @time: 2026-11-01 09:00\nCREATE TABLE a (x int);\n```\n";
  const withTime2 = mergeProjectTagAt(withTime, withTime.indexOf("CREATE"), "海亮", "sql");
  assert(
    withTime2.startsWith("```sql\n-- @tags: 海亮\n-- @time: 2026-11-01 09:00\n"),
    "mergeProjectTagAt：标签行插到时间行之前（协议次序 tags 前time 后）",
    withTime2,
  );

  // 5) untaggedDdlAnchors / untaggedClassAnchors：只报没有标签行的语句
  const probe = "```sql\n-- @tags: 海亮\nCREATE TABLE a (x int);\n```\n\n```sql\nCREATE TABLE b (y int);\n```\n";
  const anchors = untaggedDdlAnchors(probe);
  assert(anchors.length === 1, "untagged：只报无标签行语句", JSON.stringify(anchors));
  assert(probe.slice(anchors[0]).startsWith("CREATE TABLE b"), "untagged：锚点=语句起点", probe.slice(anchors[0], anchors[0] + 30));
  const jProbe = "```java\n// @tags: 海亮\npublic class A { }\n```\n\n```java\npublic class B { }\n```\n";
  const jAnchors = untaggedClassAnchors(jProbe);
  assert(jAnchors.length === 1, "untagged Java：只报无标签行类", JSON.stringify(jAnchors));

  // 6) 迁移后 replace 收录仍能命中（项目段落没了，matchingSections("") 覆盖全文）
  const mergedReplace = mergeDdlIntoNote(migrated, "CREATE TABLE gamma (z2 int);", "", { mode: "replace" });
  const gammaEntries = parseDdlTables(mergedReplace).get("gamma") ?? [];
  assert(
    gammaEntries.length === 1 && gammaEntries[0].ddl.includes("z2 int") && gammaEntries[0].tags.includes("中远"),
    "迁移后替换：命中且保留原标签（替换只换语句体）",
    JSON.stringify(gammaEntries.map((e) => ({ tags: e.tags, ddl: e.ddl.slice(0, 30) }))),
  );
}

console.log("项目段落→块内注释迁移断言全部通过");

// ---------------- 0.39.29 同名多份按 occurrence 定位（迁移后 (名,项目) 不再唯一） ----------------
{
  const { locateDdlEntry, removeDdlEntry, setDdlEntryTags } = await import("../src/lib/ddl.ts");
  const { locateClassEntry } = await import("../src/lib/javaEntity.ts");

  // 两份同名表都在未分组区（迁移后的常态）：@tags 区分
  const two = [
    "```sql",
    "-- @tags: 海亮",
    "CREATE TABLE twin (v1 int);",
    "```",
    "",
    "```sql",
    "-- @tags: 中远",
    "CREATE TABLE twin (v2 int);",
    "```",
    "",
  ].join("\n");
  const hit0 = locateDdlEntry(two, "twin", "", 0);
  const hit1 = locateDdlEntry(two, "twin", "", 1);
  assert(hit0 && two.slice(hit0.from, hit0.to).includes("v1"), "occurrence=0 → 第一份", hit0 ? two.slice(hit0.from, hit0.to) : "null");
  assert(hit1 && two.slice(hit1.from, hit1.to).includes("v2"), "occurrence=1 → 第二份", hit1 ? two.slice(hit1.from, hit1.to) : "null");
  assert(locateDdlEntry(two, "twin", "", 2) === null, "occurrence 越界 → null（条目已被改动）");
  // 缺省 = 最后一次出现（收录替换/悬浮保存的语义不变）
  const hitLast = locateDdlEntry(two, "twin", "");
  assert(hitLast && two.slice(hitLast.from, hitLast.to).includes("v2"), "缺省 occurrence → 最后一次出现");
  // 按序号改标签：只动第二份
  const tagged = setDdlEntryTags(two, "twin", "", ["批测"], { mode: "add", occurrence: 1 });
  assert(tagged !== null, "occurrence 定位改标签：命中");
  const tags0 = (tagged?.text.match(/@tags:[^\n]*/g) ?? []).join(" | ");
  assert(tags0.includes("海亮") && !tags0.includes("批测，") && (tagged?.text.match(/批测/g) ?? []).length === 1, "只有第二份写入新标签", tags0);
  // 按序号删除：删掉第一份后剩第二份
  const removed = removeDdlEntry(two, "twin", "", 0);
  assert(removed !== null && removed.text.includes("v2") && !removed.text.includes("v1"), "occurrence=0 删除 → 只删第一份", removed?.text ?? "null");
  // Java 同构
  const jTwo = [
    "```java",
    "// @tags: 海亮",
    "public class Twin { int a; }",
    "```",
    "",
    "```java",
    "// @tags: 中远",
    "public class Twin { int b; }",
    "```",
    "",
  ].join("\n");
  const jHit0 = locateClassEntry(jTwo, "Twin", "", 0);
  assert(jHit0 && jTwo.slice(jHit0.from, jHit0.to).includes("int a"), "Java occurrence=0 → 第一份");
  const jHit1 = locateClassEntry(jTwo, "Twin", "", 1);
  assert(jHit1 && jTwo.slice(jHit1.from, jHit1.to).includes("int b"), "Java occurrence=1 → 第二份");
}

console.log("同名 occurrence 定位断言全部通过");

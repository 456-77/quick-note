// 大纲（目录）提取的围栏状态机断言（0.39.16 用户反馈「md 文件中内容过多时，
// 目录会识别不完整吗」）。
//
// 真实故障笔记：25k 字、20 个 `## 项目` 的库笔记只列出 1 个标题。档案里有一
// 段漏了闭合围栏，旧状态机把下一段的 ` ```sql ` 开栏行当成闭合 → 之后每段
// 的围栏状态全部反相，标题都被当代码跳过。这里按 CommonMark 口径锁住行为：
// 闭合围栏只能是同一种标记、长度不小于开栏、后面除空白无内容。
import assert from "node:assert/strict";
import { outlineOf } from "../src/lib/outline.ts";

const lines = (...parts) => parts.join("\n").split("\n");
const heads = (src) => outlineOf(src).map((entry) => entry.text);

// 1) 普通 ATX 标题（含无文字标题），行号是 0 基
{
  const out = outlineOf(lines("# 顶层", "", "正文", "## 二级", "### 三级", "####### 七个井号不算"));
  assert.deepEqual(
    out.map((entry) => [entry.level, entry.text, entry.line]),
    [
      [1, "顶层", 0],
      [2, "二级", 3],
      [3, "三级", 4],
    ],
  );
}

// 2) 正常闭合的围栏里 `# 注释` 不算标题；闭合后标题照常识别
{
  const src = lines(
    "# 文档",
    "```sql",
    "# 这是 SQL 注释，不是标题",
    "CREATE TABLE t (id int);",
    "```",
    "## 下一节",
  );
  assert.deepEqual(heads(src), ["文档", "下一节"]);
}

// 3) 回归：漏了闭合的围栏 + 下一段的 ```sql 开栏 —— 带语言标签的行**不能**
//    闭合围栏（旧 bug 的触发形状）。裸 ``` 才是闭合；它之前的标题属于代码块，
//    之后的标题正常识别（与编辑器 lezer 的解析一致）
{
  const src = lines(
    "# 文档",
    "```sql",
    "CREATE TABLE a (id int);",
    "## 被吞掉的标题",
    "```sql",
    "CREATE TABLE b (id int);",
    "```",
    "## 恢复的标题",
    "```sql",
    "CREATE TABLE c (id int);",
    "```",
    "## 最后的标题",
  );
  assert.deepEqual(heads(src), ["文档", "恢复的标题", "最后的标题"]);
}

// 4) 闭合围栏比开栏长合法；不同标记的围栏不能互相闭合
{
  const src = lines(
    "# 文档",
    "```",
    "代码 # 注释",
    "`````",
    "~~~",
    "代码里的 ``` 不是闭合（标记不同）",
    "~~~",
    "## 结尾",
  );
  assert.deepEqual(heads(src), ["文档", "结尾"]);
}

// 5) 闭合围栏后面带文字不算闭合（CommonMark：只能有空白）
{
  const src = lines("# 文档", "```", "代码", "``` trailing", "## 还在代码里", "```", "## 出来");
  assert.deepEqual(heads(src), ["文档", "出来"]);
}

// 6) 用户真实笔记的重复形状：多段「标题 + ```sql + 语句 + ```」——每段标题都要在
{
  const src = ["# 数据库表 DDL"];
  for (let i = 0; i < 20; i += 1) {
    src.push(`## 项目${i}`, "```sql", `CREATE TABLE t${i} (id int);`, "```");
  }
  const got = heads(src);
  assert.equal(got.length, 21);
  assert.equal(got[0], "数据库表 DDL");
  assert.equal(got[20], "项目19");
}

// 7) Setext：`===` 是标题；`---` 一律当分隔线（0.39.31 用户反馈「分割线上面
//    一行文字会渲染成标题」——上一行不再进目录）
{
  assert.deepEqual(heads(lines("一级标题", "===", "", "普通文字", "---")), ["一级标题"]);
}

// 8) 大纲拖动移动章节（0.39.31 用户反馈「支持拖动目录，来直接移动 md 文件内容」）
{
  const { moveSectionEdit } = await import("../src/lib/outline.ts");
  const apply = (text, edit) => {
    // 按原文坐标从后往前应用（CM6 多 change 同语义）
    const sorted = [...edit.changes].sort((a, b) => b.from - a.from);
    let out = text;
    for (const change of sorted) {
      out = out.slice(0, change.from) + (change.insert ?? "") + out.slice(change.to ?? change.from);
    }
    return out;
  };
  const doc = ["# 总览", "", "## A", "内容 A", "### A1", "子内容", "", "## B", "内容 B", "", "## C", "内容 C"].join("\n");
  // B 整节（含空行）移到 A 之前
  const before = moveSectionEdit(doc, 7, 2, "before");
  assert.equal(
    apply(doc, before),
    ["# 总览", "", "## B", "内容 B", "", "## A", "内容 A", "### A1", "子内容", "", "## C", "内容 C"].join("\n"),
    "各节整体前移（B 的章节含空行一起搬）",
  );
  // A 整节（含子标题 A1）移到 C 之后 → 文末（章节自带的尾随空行一起搬走）
  const toEnd = moveSectionEdit(doc, 2, 10, "after");
  assert.equal(
    apply(doc, toEnd),
    ["# 总览", "", "## B", "内容 B", "", "## C", "内容 C", "", "## A", "内容 A", "### A1", "子内容", "", ""].join("\n"),
    "拖到最后一个条目之后 = 文末（子树一起走）",
  );
  // 拖进自己的子标题里 = 非法
  assert.equal(moveSectionEdit(doc, 2, 4, "before"), null, "拖进自己子树被拒");
  // 原地（before 自己 / after 自己）都是 no-op
  assert.equal(moveSectionEdit(doc, 7, 7, "before"), null, "原地 no-op");
  assert.equal(moveSectionEdit(doc, 7, 7, "after"), null, "拖到自己之后 no-op");
  // CRLF：搬动后分隔符保持一致
  const crlf = doc.replace(/\n/g, "\r\n");
  const crlfEdit = moveSectionEdit(crlf, 7, 2, "before");
  const crlfOut = apply(crlf, crlfEdit);
  assert.equal(crlfOut.split("\r\n").length, crlf.split("\r\n").length, "CRLF 文档行数不变");
  assert.ok(crlfOut.includes("## B\r\n内容 B"), "CRLF 章节连分隔符一起搬");
}

console.log("大纲围栏状态机断言全部通过 ✓");

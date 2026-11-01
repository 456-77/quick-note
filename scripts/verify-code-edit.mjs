// 行内代码 / 代码块切换的纯逻辑验证（无需 DOM、无需启动应用）。
//
// 覆盖 `src/lib/codeEdit.ts` 的三个纯函数：
//   - inlineCodeToggleAt：包裹 / 取消 / 不动作的三种判定；
//   - wikiLinkToggleAt：内部链接（[[目标|别名]]）的包裹 / 取消 / 不动作；
//   - codeBlockPadding：块级插入的前后补位（与 paste.ts 的 blockInsertPadding 同一套规则）。
//
// 用法：node --experimental-strip-types --no-warnings scripts/verify-code-edit.mjs

import {
  inlineCodeToggleAt,
  wikiLinkToggleAt,
  codeBlockPadding,
  headingToggleAt,
} from "../src/lib/codeEdit.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

console.log("行内代码：包裹\n");
eq(inlineCodeToggleAt("正文 code 尾", 3, 7), { wrap: [3, 7] }, "普通选中 → 两侧包裹");
eq(inlineCodeToggleAt("正文", 1, 1), { wrap: [1, 1] }, "空选区 → 插入一对反引号");
eq(
  inlineCodeToggleAt("a `code` b", 0, 1),
  { wrap: [0, 1] },
  "选区在代码段外 → 包裹（不会误删右侧的代码段）",
);

console.log("\n行内代码：取消\n");
eq(inlineCodeToggleAt("a `code` b", 2, 8), { remove: [2, 8], text: "code" }, "选中含反引号的整段 → 取消并还原内容（0.35.1 前 insert:\"\" 连内容一起删）");
eq(inlineCodeToggleAt("a `code` b", 3, 6), { remove: [2, 8], text: "code" }, "光标/选区在代码段内 → 取消那一对并保留内容");
eq(inlineCodeToggleAt("a `` b", 3, 3), { remove: [2, 4], text: "" }, "光标在空代码段（``）中间也能取消");
eq(inlineCodeToggleAt("a `code` b", 0, 1), { wrap: [0, 1] }, "光标在代码段外贴着开头 → 包裹而不是误取消");

console.log("\n行内代码：不动作\n");
eq(inlineCodeToggleAt("a `co`de` b", 3, 9), null, "选区里已有反引号 → 不包裹");

console.log("\n代码块补位\n");
const LF = ["第一行", "第二行", "第三行"];
eq(codeBlockPadding(LF, 0, 0, 0, 0), { prefix: "", suffix: "\n\n" }, "文档开头空行 → 后补空行");
eq(codeBlockPadding(LF, 1, 0, 1, 0), { prefix: "\n", suffix: "\n\n" }, "行首 → 前补 1 换行、后补空行");
eq(codeBlockPadding(LF, 1, 3, 1, 3), { prefix: "\n\n", suffix: "\n" }, "行尾 → 前补空行、后补 1 换行");
eq(codeBlockPadding(LF, 1, 1, 1, 2), { prefix: "\n\n", suffix: "\n\n" }, "行中间 → 前后各空一行");
eq(codeBlockPadding(LF, 2, 0, 2, 0), { prefix: "\n", suffix: "\n\n" }, "文档末行行首 → 与行首同一套规则");
eq(
  codeBlockPadding(["第一行", "选中甲", "选中乙", "第三行"], 1, 0, 2, 3),
  { prefix: "\n", suffix: "\n" },
  "跨行选区：前看首行行首、后看末行行尾",
);

console.log("\n标题切换\n");
{
  // 普通行 → 加前缀，光标跟着原字符右移
  eq(headingToggleAt("正文一行", 2, 2), { text: "## 正文一行", headCol: 5 }, "普通行 → ## 前缀，光标随字符右移");
  eq(headingToggleAt("", 1, 0), { text: "# ", headCol: 2 }, "空行 → `# `，光标在前缀后");
  // 已是同级别 → 取消，光标随字符左移
  eq(headingToggleAt("## 标题", 2, 5), { text: "标题", headCol: 2 }, "## 再按 → 取消标题，光标跟随");
  eq(headingToggleAt("### 多级 内容", 3, 8), { text: "多级 内容", headCol: 4 }, "### 取消后正文保留");
  // 已是其他级别 → 换级别
  eq(headingToggleAt("## 标题", 1, 5), { text: "# 标题", headCol: 4 }, "## 按 1 → 换成 #");
  eq(headingToggleAt("# 标题", 3, 2), { text: "### 标题", headCol: 4 }, "# 按 3 → 换成 ###，光标不进井号");
  // 行内标签不误伤：`#标签` 不是标题，按普通行加前缀
  eq(headingToggleAt("#标签 文字", 2, 4), { text: "## #标签 文字", headCol: 7 }, "行首标签行按普通行处理");
  // 缩进行
  eq(headingToggleAt("  缩进行", 1, 4), { text: "#   缩进行", headCol: 6 }, "缩进行也直接加前缀");
}

// ============================================================ 内部链接（0.35.1）
console.log("\n内部链接：包裹 / 取消\n");
// 文档布局："x [[aa|bb]] y"：[[在2-3，aa=4-5，|=6，bb=7-8，]]在9-10，y=12
eq(wikiLinkToggleAt("x [[aa|bb]] y", 13, 13), { wrap: [13, 13] }, "链接外空选区 → 包裹（插入 [[]]）");
eq(wikiLinkToggleAt("x [[aa|bb]] y", 4, 6), { remove: [2, 11], text: "bb" }, "选区落在链接内（跨目标与别名）→ 取消并还原显示文本");
eq(wikiLinkToggleAt("x [[aa|bb]] y", 2, 11), { remove: [2, 11], text: "bb" }, "选区=整条链接 → 同样取消还原别名");
eq(wikiLinkToggleAt("x [[aa]] y", 5, 5), { remove: [2, 8], text: "aa" }, "无别名链接取消 → 还原目标名");
eq(wikiLinkToggleAt("x [[|bb]] y", 5, 5), { remove: [2, 9], text: "bb" }, "别名态（目标空）取消 → 只留别名，不剩孤立竖线");
eq(wikiLinkToggleAt("x ![[p.png]] y", 7, 7), { remove: [2, 12], text: "p.png" }, "嵌入 ![[ ]] 里取消 → 连感叹号一起剥");
eq(wikiLinkToggleAt("x [[aa|bb]] y", 0, 1), { wrap: [0, 1] }, "光标贴着前面普通文字 → 包裹而不是误取消");
eq(wikiLinkToggleAt("x [[aa b", 0, 8), null, "选区里已有链接括号 → 不包裹");

console.log(failures === 0 ? "\n代码切换逻辑验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

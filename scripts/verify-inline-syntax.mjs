// 额外行内语法的扫描函数（纯函数，无需 DOM）。
//
// 这里的边界最容易出错：`$100` 不能当公式、`<https://…>` 不能当标签、
// 没有结束标签的 `<font>` 不能瞎渲染。所以逐条钉住。
//
// 用法：node --experimental-strip-types scripts/verify-inline-syntax.mjs

import {
  findComments,
  findHighlights,
  findInlineHtml,
  findInlineMath,
  findTags,
  parseCalloutLine,
} from "../src/lib/inlineSyntax.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

/** 对一段文本跑扫描，返回匹配到的片段原文。 */
const scan = (finder, text, excluded = []) =>
  finder(text, 0, excluded).map((item) => text.slice(item.from, item.to));

// ---------------------------------------------------------------- HTML
console.log("手写 HTML\n");
check(
  JSON.stringify(scan(findInlineHtml, "换行<br/>之后")) === JSON.stringify(["<br/>"]),
  "void 标签 <br/> 被识别",
);
check(
  JSON.stringify(scan(findInlineHtml, "换行<br>之后")) === JSON.stringify(["<br>"]),
  "void 标签 <br> 被识别",
);
check(
  JSON.stringify(scan(findInlineHtml, '图 <img src="a.png" width="20"> 结束')) ===
    JSON.stringify(['<img src="a.png" width="20">']),
  "带属性的自闭合 <img> 整段识别",
);
check(
  JSON.stringify(scan(findInlineHtml, '颜色 <font color="#c00">红字</font> 之后')) ===
    JSON.stringify(['<font color="#c00">红字</font>']),
  "成对标签连同内容和结束标签一起接管（只渲染开标签是不生效的）",
);
check(
  JSON.stringify(scan(findInlineHtml, "<span>a<span>b</span></span>")) ===
    JSON.stringify(["<span>a<span>b</span>"]),
  "遇到结束标签即收尾（不处理嵌套）",
);
check(
  JSON.stringify(scan(findInlineHtml, "<font color=red>没有结束标签")) === "[]",
  "没有结束标签时跳过（宁可按源码显示，不瞎渲染）",
);
check(
  JSON.stringify(scan(findInlineHtml, "自动链接 <https://example.com> 不算标签")) === "[]",
  "<https://…> 不被当成 HTML 标签",
);
check(
  JSON.stringify(scan(findInlineHtml, "比较 3 < 5 且 7 > 2")) === "[]",
  "数学比较符不被当成标签",
);
check(
  JSON.stringify(scan(findInlineHtml, "代码 `<br/>` 里不算", [[3, 11]])) === "[]",
  "代码区域里的标签被排除",
);

// ---------------------------------------------------------------- 公式
console.log("\n行内公式\n");
check(JSON.stringify(scan(findInlineMath, "$E = mc^2$")) === JSON.stringify(["$E = mc^2$"]), "常规公式");
check(JSON.stringify(scan(findInlineMath, "$x$")) === JSON.stringify(["$x$"]), "单字符公式");
check(
  JSON.stringify(scan(findInlineMath, "$a^2 + b^2 = c^2$。")) === JSON.stringify(["$a^2 + b^2 = c^2$"]),
  "含下标的公式",
);
check(JSON.stringify(scan(findInlineMath, "价格 $100 和 $200 元")) === "[]", "货币 $100 / $200 不当公式");
check(JSON.stringify(scan(findInlineMath, "$$块公式$$")) === "[]", "$$ 块公式不按行内处理（暂不支持）");
check(JSON.stringify(scan(findInlineMath, "转义 \\$x$ 不算")) === "[]", "转义的 \\$ 不当公式");
check(
  JSON.stringify(scan(findInlineMath, "$a\nb$ 跨行")) === "[]",
  "跨行的 $ 不当公式",
);
check(
  JSON.stringify(scan(findInlineMath, "`$x$` 代码里", [[0, 5]])) === "[]",
  "代码区域里的公式被排除",
);

// ---------------------------------------------------------------- 高亮
console.log("\n高亮\n");
check(JSON.stringify(scan(findHighlights, "==重点==")) === JSON.stringify(["==重点=="]), "常规高亮");
check(JSON.stringify(scan(findHighlights, "a==b==c")) === JSON.stringify(["==b=="]), "夹在文字中间的高亮");
check(JSON.stringify(scan(findHighlights, "==== 空内容")) === "[]", "空高亮不匹配");
check(JSON.stringify(scan(findHighlights, "==跨\n行==")) === "[]", "跨行不匹配");
check(JSON.stringify(scan(findHighlights, "`==x==`", [[0, 7]])) === "[]", "代码区域里的高亮被排除");

// ---------------------------------------------------------------- 注释
console.log("\n注释\n");
check(JSON.stringify(scan(findComments, "%%隐藏我%% 之后的文字")) === JSON.stringify(["%%隐藏我%%"]), "单行注释");
check(JSON.stringify(scan(findComments, "%%多\n行%%")) === "[]", "跨行注释不处理（插件不能替换换行符）");
check(JSON.stringify(scan(findComments, "`%%x%%`", [[0, 7]])) === "[]", "代码区域里的注释被排除");

// ---------------------------------------------------------------- 标签
console.log("\n标签\n");
check(
  JSON.stringify(scan(findTags, "正文里的 #标签 很好")) === JSON.stringify(["#标签"]),
  "普通标签",
);
check(
  JSON.stringify(scan(findTags, "子路径 #嵌套/标签 也算")) === JSON.stringify(["#嵌套/标签"]),
  "带子路径的标签",
);
check(JSON.stringify(scan(findTags, "#a1 字母数字")) === JSON.stringify(["#a1"]), "字母数字标签");
// 中文标点后也算标签：Obsidian 的规则是"前面不是字母数字"，不是"前面必须是空白"
check(
  JSON.stringify(scan(findTags, "正文、#标签、还有")) === JSON.stringify(["#标签"]),
  "中文顿号后的标签也算（放宽过的那条规则）",
);
check(JSON.stringify(scan(findTags, "(#括号里的)")) === JSON.stringify(["#括号里的"]), "括号里的标签");
check(JSON.stringify(scan(findTags, "# 我是标题")) === "[]", "ATX 标题（# 后跟空格）不算标签");
check(JSON.stringify(scan(findTags, "### 三级标题")) === "[]", "多级 ATX 标题不算标签");
check(JSON.stringify(scan(findTags, "编号 #1 不算")) === "[]", "纯数字不算标签");
check(JSON.stringify(scan(findTags, "[[笔记#小节]]")) === "[]", "wiki 链接里的小节标记不算标签");
check(JSON.stringify(scan(findTags, "`#代码里`", [[0, 5]])) === "[]", "代码区域里的不算标签");
// HTML 属性里的 #c00：排除区间由**调用方**传入（装饰层会把已被 HTML 接管的区间传进来）
const htmlText = '属性 <font color="#c00">红字</font>';
const htmlSpan = findInlineHtml(htmlText, 0, [])[0];
check(htmlSpan !== undefined, "先能扫出这段 HTML", JSON.stringify(htmlSpan?.inner));
check(
  scan(findTags, htmlText, [[htmlSpan.from, htmlSpan.to]]).length === 0,
  "把 HTML 区间排除掉之后，属性里的 #c00 不再算标签",
);

// ---------------------------------------------------------------- callout 首行
console.log("\ncallout 首行解析\n");
const note = parseCalloutLine("> [!note] 提示标题", 100);
check(note?.type === "note", "解析出类型", JSON.stringify(note?.type));
check(note?.title === "提示标题", "解析出标题");
check(
  note?.markerFrom === 102 && note?.markerTo === 109,
  "`[!note]` 标记范围准确",
  JSON.stringify([note?.markerFrom, note?.markerTo]),
);
check(note?.titleFrom === 110 && note?.titleTo === 114, "标题范围准确", JSON.stringify([note?.titleFrom, note?.titleTo]));

const noTitle = parseCalloutLine("> [!warning]", 200);
check(noTitle?.type === "warning" && noTitle?.title === "", "没有标题时 title 为空");
check(noTitle?.titleFrom === noTitle?.titleTo, "无标题时标题范围为空（不会误加粗后面的内容）");

check(parseCalloutLine("> 普通引用", 0) === null, "普通引用不被当成 callout");
check(parseCalloutLine("普通段落 [!note]", 0) === null, "不在引用里的不算 callout");
check(parseCalloutLine("> [!NOTE] 大写也行", 0)?.type === "note", "类型大小写归一化");
check(parseCalloutLine(">  [!tip]  空格多一些", 0)?.title === "空格多一些", "容忍多余空格");

console.log(failures === 0 ? "\n额外行内语法扫描验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

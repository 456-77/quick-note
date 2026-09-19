// Live Preview 装饰层的单元验证（无需 DOM、无需启动应用）。
//
// 装饰计算是这套方案里最容易出错的部分，所以核心逻辑被写成不依赖 EditorView 的
// 纯函数 buildLivePreviewDecorations，可以在这里直接断言。
//
// 装饰的分类依据 CM6 的 spec 字段（不额外塞测试专用元数据）：
//   from === to && class          → 行装饰（Decoration.line）
//   from <  to && widget          → 小部件替换
//   from <  to && class           → 内容标记（Decoration.mark）
//   from <  to && 空 spec         → 纯隐藏
//
// 注意用例的写法：断言「某片段内的隐藏装饰」要用 hidesWithin（装饰落在片段范围内），
// 不能用「覆盖整个片段」——例如标题只隐藏 `"# "` 两个字符，并不会覆盖整个标题文字。
// 行装饰的 class 是多个类名拼接（`"cm-lp-heading cm-lp-h1"`），要用 includes 判断。
//
// 用法：node scripts/verify-livepreview.mjs [file]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { buildLivePreviewDecorations, computeBlockDecorations } from "../src/lib/livePreview.ts";
import { prepareEmbedMarkdown, sliceSection } from "../src/lib/embed.ts";
import { externalUrlAt } from "../src/lib/markdownExtras.ts";
import { resolveResource, resolveWikiTarget } from "../src/lib/paths.ts";

const file = process.argv[2] ?? "test-vault/features.md";
const doc = readFileSync(file, "utf8");

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

/** 把装饰集整理成可断言的项目列表。 */
function collect(set) {
  const items = [];
  set.between(0, doc.length, (from, to, value) => {
    const spec = value.spec ?? {};
    const hasWidget = spec.widget !== undefined;
    const cls = spec.class;
    const kind = from === to ? "line" : hasWidget ? "widget" : cls ? "mark" : "hide";
    items.push({
      from,
      to,
      kind,
      cls,
      widget: spec.widget,
      widgetName: hasWidget ? spec.widget.constructor.name : null,
      block: spec.block === true,
      text: doc.slice(from, to),
    });
  });
  return items;
}

/** 构造状态并取出装饰，分类整理。 */
function decorate(cursorPos) {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursorPos },
    extensions: [markdown({ base: markdownLanguage })],
  });
  return { state, items: collect(buildLivePreviewDecorations(state, 0, doc.length)) };
}

/** 某个片段内的隐藏装饰（语法标记通常只占片段的一小部分）。 */
function hidesWithin(items, needle) {
  const at = doc.indexOf(needle);
  if (at < 0) throw new Error(`fixture 里找不到 ${JSON.stringify(needle)}`);
  return items.filter((d) => d.kind === "hide" && d.from >= at && d.to <= at + needle.length);
}

/** 加了某样式类的装饰。 */
const withClass = (items, cls) => items.filter((d) => d.cls?.includes(cls));
const widgetOf = (items, name) => items.filter((d) => d.widgetName === name);

/** 含指定文字的整行范围（用于把断言限定在"当前光标所在行"）。 */
function lineRange(needle) {
  const at = doc.indexOf(needle);
  const start = doc.lastIndexOf("\n", at - 1) + 1;
  const end = doc.indexOf("\n", at);
  return [start, end < 0 ? doc.length : end];
}

/** 与给定范围相交的装饰。 */
const overlapOf = (items, [a, b]) => items.filter((d) => d.from < b && d.to > a);

// ============================================================ 光标不在正文行
console.log("场景 A：光标停在文末（正文各行都处于渲染态）\n");
const A = decorate(doc.length);

// 1. 标题（ATX + setext 各一个）
check(withClass(A.items, "cm-lp-h1").length === 2, "一级标题行装饰：ATX 一个 + setext 一个", `实际=${withClass(A.items, "cm-lp-h1").length}`);
check(withClass(A.items, "cm-lp-h2").length === 2, "二级标题行装饰：ATX 一个 + setext 一个", `实际=${withClass(A.items, "cm-lp-h2").length}`);
check(hidesWithin(A.items, "# 语法覆盖").length === 1, "标题的 `#` 连同其后空格被隐藏");
check(hidesWithin(A.items, "## 列表与分割线").length === 1, "二级标题的 `##` 被隐藏");
// setext：正文在上一行，`=====` 独占下一行——藏掉它之后必须压掉行高，否则留空行
check(
  withClass(A.items, "cm-lp-collapsed").length === 2,
  "两个 setext 标题的下划线行都被压掉高度",
  `实际=${withClass(A.items, "cm-lp-collapsed").length}`,
);
check(
  hidesWithin(A.items, "===============").length === 1,
  "setext 的 `=====` 被隐藏",
);

// 2. 行内样式
const strongMark = A.items.find((d) => d.cls === "cm-lp-strong");
check(strongMark?.text === "粗体", "**粗体** 的内容被标为 cm-lp-strong", `实际=${strongMark?.text}`);
check(hidesWithin(A.items, "**粗体**").length === 2, "**粗体** 两侧的 `**` 都被隐藏");
check(A.items.find((d) => d.cls === "cm-lp-em")?.text === "斜体", "*斜体* 的内容被标为 cm-lp-em");
check(
  A.items.find((d) => d.cls === "cm-lp-strike")?.text === "删除线",
  "~~删除线~~ 的内容被标为 cm-lp-strike",
);
check(A.items.find((d) => d.cls === "cm-lp-code")?.text === "code", "`code` 的内容被标为 cm-lp-code");
check(hidesWithin(A.items, "`code`").length === 2, "`code` 两侧的反引号都被隐藏");

// 3. 复选框
const boxes = widgetOf(A.items, "TaskCheckboxWidget");
check(boxes.length === 2, "两个任务标记都换成了复选框", `实际=${boxes.length}`);
check(boxes[0]?.widget?.checked === false, "第一个复选框为未勾选");
check(boxes[1]?.widget?.checked === true, "第二个复选框为已勾选");
check(boxes[0]?.text === "[ ]" && boxes[1]?.text === "[x]", "复选框恰好覆盖 [ ] / [x] 标记");
check(hidesWithin(A.items, "- [ ]").length === 1, "任务项的 `-` 被隐藏（由复选框代表）");
const bullets = widgetOf(A.items, "BulletWidget");
check(bullets.length === 2, "普通列表项换成圆点小部件", `实际=${bullets.length}`);

// 4. 分割线
const rules = widgetOf(A.items, "RuleWidget");
check(rules.length === 1, "分割线换成 <hr> 小部件", `实际=${rules.length}`);
check(rules[0]?.text === "---", "分割线只替换 `---` 本身，保留行尾换行");
// 回归断言：CM6 禁止插件产生两类装饰，一旦违反会让装饰集整体抛异常、
// 编辑器渲染成空白（错误只显示在界面的提示条里，很容易漏掉）：
//   1. 块级装饰 → "Block decorations may not be specified via plugins"
//   2. 替换换行符 → "Decorations that replace line breaks may not be specified via plugins"
check(
  !A.items.some((d) => d.block === true),
  "不存在块级装饰（CM6 不允许插件产生块级装饰）",
);
check(
  !A.items.some((d) => d.kind !== "line" && d.text.includes("\n")),
  "不存在替换换行符的装饰（CM6 不允许插件替换换行符）",
  JSON.stringify(A.items.filter((d) => d.kind !== "line" && d.text.includes("\n")).map((d) => d.text)),
);

// 5. 围栏代码块。
// 注意：mermaid 块由 StateField 整块替换成图，插件会跳过它们，
// 所以这里只剩下普通代码块的装饰。
const infos = widgetOf(A.items, "CodeHeaderWidget");
check(
  infos.length === 1,
  "只有普通代码块的头部条换成小部件（语言名+复制；mermaid 已整块替换成图）",
  `实际=${infos.length}`,
);
check(infos[0]?.widget?.info === "ts", "该代码块语言为 ts", `实际=${infos[0]?.widget?.info}`);
check(
  typeof infos[0]?.widget?.code === "string" && infos[0].widget.code.includes("answer"),
  "头部条携带代码文本（复制按钮的数据源）",
  `实际=${infos[0]?.widget?.code?.slice(0, 40)}`,
);
check(
  withClass(A.items, "cm-lp-codeblock").length >= 3,
  "普通代码块各行都有底色装饰",
  `实际=${withClass(A.items, "cm-lp-codeblock").length}`,
);
check(hidesWithin(A.items, "```ts").length >= 1, "普通代码块围栏被隐藏");

// 收尾围栏行被隐藏后就成了空行，必须压掉高度，否则每个代码块底部多一条空行
/** 取某个位置所在行的整行文本（这里的 doc 是字符串，不能用 CM6 的 Text API）。 */
function lineTextAt(pos) {
  const start = doc.lastIndexOf("\n", pos - 1) + 1;
  const end = doc.indexOf("\n", pos);
  return doc.slice(start, end < 0 ? doc.length : end);
}

const fenceLines = withClass(A.items, "cm-lp-fence");
check(fenceLines.length === 1, "收尾围栏行加上压缩类", `实际=${fenceLines.length}`);
check(
  lineTextAt(fenceLines[0]?.from ?? 0) === "```",
  "被压缩的正是收尾围栏那一行",
  JSON.stringify(lineTextAt(fenceLines[0]?.from ?? 0)),
);

// 6. 链接
check(A.items.find((d) => d.cls === "cm-lp-link")?.text === "示例", "链接文字被标为 cm-lp-link");
check(
  A.items.some((d) => d.kind === "hide" && d.text === "](https://example.com)"),
  "`](https://example.com)` 被整段隐藏",
);

// 7. 图片（markdown 语法三处 + wiki 嵌入三处）
const images = widgetOf(A.items, "ImageWidget");
check(
  images.length === 6,
  "六个图片引用都换成小部件（3 个 markdown 语法 + 3 个 wiki 嵌入）",
  `实际=${images.length}`,
);

const localImage = images.find((d) => d.widget?.target === "attachments/pic.png");
check(localImage?.text === "![图](attachments/pic.png)", "图片部件覆盖整个语法片段");
check(localImage?.widget?.alt === "图", "取到 alt 文字");
// 场景 A 的状态里没有资源上下文，此时不能硬猜本地路径
check(localImage?.widget?.local === null, "没有仓库上下文时不猜路径（降级为标签）");

const remoteImage = images.find((d) => d.widget?.target === "https://example.com/remote.png");
check(remoteImage?.widget?.remote === "https://example.com/remote.png", "远程图片原样透传");
check(remoteImage?.widget?.local === null, "远程图片不做本地解析");

check(
  images.some((d) => d.widget?.target === "attachments/missing.png"),
  "指向缺失文件的引用同样渲染（是否降级由 toDOM 决定）",
);

// 8. 引用
check(hidesWithin(A.items, "> 引用块").length === 1, "引用的 `>` 被隐藏");
check(withClass(A.items, "cm-lp-quote").length === 1, "引用行加了行装饰 cm-lp-quote");

// 9. 手写 HTML：由 StateField 整块替换成清洗后的 widget
// fixture 里有三个 HTML 块：一个讲"会被清洗后渲染"，一个含脚本，一个含 <script>
const htmlBlock = collect(
  computeBlockDecorations(
    EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdown({ base: markdownLanguage })],
    }),
  ),
).filter((d) => d.widgetName === "HtmlWidget");
check(htmlBlock.length === 3, "三个 HTML 块都换成清洗后的 widget", `实际=${htmlBlock.length}`);
check(
  htmlBlock.every((d) => d.block === true),
  "HTML 块用块级替换（整行接管）",
);
check(
  htmlBlock.some((d) => d.text.includes("会被清洗后渲染")),
  "widget 拿到的是原始 HTML 源码（清洗发生在渲染时，源码不动）",
);
check(
  htmlBlock.some((d) => d.text.includes("<script>")),
  "含脚本的块同样交给 widget——清洗是渲染层的责任，源码保持不变",
);
// 插件不得在 HTML 块内部产生装饰：块级替换与内部装饰重叠会让 CM6 抛异常
const insideHtmlBlock = A.items.filter((d) =>
  htmlBlock.some((block) => d.from < block.to && d.to > block.from),
);
check(
  insideHtmlBlock.length === 0,
  "插件不在 HTML 块范围内产生装饰（避免与块级替换重叠）",
  JSON.stringify(insideHtmlBlock.map((d) => d.text)),
);

// ============================================================ 光标所在的行内元素
console.log("\n场景 B：光标停在某个行内元素内（只展开该元素，同行的其他元素照常渲染）\n");
// 0.5 起行内标记按「元素级激活」：光标在哪个元素里，就只展开哪个元素——
// 曾经光标一进行就整行退回源码，点行内代码会把同行的 `**` 全部弹出来。
const B = decorate(doc.indexOf("**粗体**") + 4); // 光标落在「粗体」两字中间

check(hidesWithin(B.items, "**粗体**").length === 0, "光标在粗体元素内：该元素的 `**` 显形");
check(
  // 只看该元素所在行：0.5.1 起 callout 内部也渲染行内样式，文档里别处的粗体有样式是正常的
  !overlapOf(B.items, lineRange("**粗体**")).some((d) => d.cls === "cm-lp-strong"),
  "光标在粗体元素内：该元素不再有粗体样式（不能「看着像源码却已加粗」）",
);
// 同行的其他元素保持渲染（元素级激活的核心）
check(hidesWithin(B.items, "`code`").length === 2, "同行的行内代码反引号照常隐藏");
check(B.items.some((d) => d.cls === "cm-lp-code"), "同行的行内代码照常有样式");
check(hidesWithin(B.items, "*斜体*").length === 2, "同行的斜体星号照常隐藏");
check(B.items.some((d) => d.cls === "cm-lp-em"), "同行的斜体照常有样式");
check(B.items.some((d) => d.cls === "cm-lp-strike"), "同行的删除线照常有样式");
check(widgetOf(B.items, "TaskCheckboxWidget").length === 2, "其他行照常渲染（复选框不受影响）");
check(hidesWithin(B.items, "# 语法覆盖").length === 1, "标题行不在光标处，`#` 仍被隐藏");
check(withClass(B.items, "cm-lp-h1").length === 2, "标题行样式不受影响（ATX + setext）");

// 光标落在行内代码里：只展开代码元素，同行的粗体照常渲染
const B2 = decorate(doc.indexOf("`code`") + 2);
check(hidesWithin(B2.items, "`code`").length === 0, "光标在行内代码内：反引号显形");
check(
  !overlapOf(B2.items, lineRange("`code`")).some((d) => d.cls === "cm-lp-code"),
  "光标在行内代码内：该元素不再有代码样式",
);
check(hidesWithin(B2.items, "**粗体**").length === 2, "同行的粗体 `**` 照常隐藏");
check(B2.items.some((d) => d.cls === "cm-lp-strong"), "同行的粗体照常有样式");

// 光标落在链接元素内时，链接退回源码
const C = decorate(doc.indexOf("[示例](https://example.com)") + 3);
check(hidesWithin(C.items, "[示例](https://example.com)").length === 0, "光标在链接元素内时不隐藏");
check(
  !overlapOf(C.items, lineRange("链接：[示例]")).some((d) => d.cls?.includes("cm-lp-link")),
  "光标在链接元素内时不加链接样式",
);
check(hidesWithin(C.items, "**粗体**").length === 2, "链接行的改动不影响其他行");

// ============================================================ 稳定性
console.log("\n场景 D：重复计算应得到相同结果（无随机性）\n");
const again = decorate(doc.length);
check(
  JSON.stringify(again.items) === JSON.stringify(A.items),
  "两次构建的装饰集完全一致",
);

// ============================================================ 表格
console.log("\n场景 E：表格（由 StateField 做块级替换）\n");
const tableText = "| 左对齐 | 居中 | 右对齐 |";
const tableStart = doc.indexOf(tableText);
const tableLastRow = "| ~~删除~~ | 普通 | 1 |";
const tableEnd = doc.indexOf(tableLastRow) + tableLastRow.length;

const stateAt = (pos) =>
  EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdown({ base: markdownLanguage })],
  });

// 光标在块外 → 表格与 mermaid 图都应被整块替换
const blockItems = collect(computeBlockDecorations(stateAt(doc.length)));
const tables = blockItems.filter((d) => d.widgetName === "TableWidget");
const mermaids = blockItems.filter((d) => d.widgetName === "MermaidWidget");
check(tables.length === 1, "产生 1 个表格块级替换", `实际=${tables.length}`);
const table = tables[0];
check(table?.block === true, "是块级替换（StateField 允许，插件不允许）");
check(table?.widgetName === "TableWidget", "替换成 TableWidget");
check(
  table?.from === doc.lastIndexOf("\n", tableStart) + 1,
  "替换范围从一个完整行开始",
);
check(table?.text.endsWith("\n"), "替换范围含行尾换行（块级装饰必须覆盖整行）");

const rows = table?.widget?.rows;
check(rows?.length === 3, "解析出 1 个表头行 + 2 个数据行", `实际=${rows?.length}`);
// rows 是三层结构：行 → 单元格 → 文本段。取文字要把一个单元格的文本段拼起来。
const cellText = (row, col) => (rows?.[row]?.[col] ?? []).map((r) => r.text).join("");
check(
  JSON.stringify([cellText(0, 0), cellText(0, 1), cellText(0, 2)]) ===
    JSON.stringify(["左对齐", "居中", "右对齐"]),
  "表头文字正确",
  JSON.stringify([cellText(0, 0), cellText(0, 1), cellText(0, 2)]),
);
check(rows?.[1]?.[0]?.[0]?.bold === true, "单元格内的 `**粗体**` 识别为加粗");
check(rows?.[1]?.[1]?.[0]?.code === true, "单元格内的反引号识别为行内代码");
check(
  rows?.[1]?.[2]?.[0]?.link === true && rows?.[1]?.[2]?.[0]?.text === "链接",
  "单元格内的链接只保留可见文字",
  JSON.stringify(rows?.[1]?.[2]),
);
check(rows?.[2]?.[0]?.[0]?.strike === true, "单元格内的 `~~删除~~` 识别为删除线");

// 只断言样式标记是不够的：必须同时断言文字里不含原始标记。
// 曾经因为漏了前一条，出现「bold=true 但文字是 `**粗体**`」也能通过的情况。
check(cellText(1, 0) === "粗体", "加粗单元格的文字不含 `**`", `实际=${JSON.stringify(cellText(1, 0))}`);
check(cellText(1, 1) === "code", "行内代码单元格的文字不含反引号", `实际=${JSON.stringify(cellText(1, 1))}`);
check(cellText(1, 2) === "链接", "链接单元格的文字不含 `](url)`", `实际=${JSON.stringify(cellText(1, 2))}`);
check(cellText(2, 0) === "删除", "删除线单元格的文字不含 `~~`", `实际=${JSON.stringify(cellText(2, 0))}`);
check(
  rows?.every((row) => row.every((cell) => cell.every((run) => !/[*`~]/.test(run.text)))),
  "所有单元格都不残留任何行内标记符号",
  JSON.stringify(rows),
);
check(
  JSON.stringify(table?.widget?.align) === JSON.stringify(["left", "center", "right"]),
  "对齐方式从分隔行解析正确",
  JSON.stringify(table?.widget?.align),
);

// 光标在表格内 → 表格不替换，退回源码
const insideTable = collect(computeBlockDecorations(stateAt(tableStart + 2))).filter(
  (d) => d.widgetName === "TableWidget",
);
check(insideTable.length === 0, "光标在表格内时不做替换（退回源码，便于改 Markdown）");

// 重叠防护：表格被块级替换时，行内装饰插件不得在表格范围内产生任何装饰，
// 否则 CM6 会因 replace 区间重叠抛异常、编辑器整体空白。
const overlapping = A.items.filter((d) => d.from < tableEnd && d.to > tableStart);
check(
  overlapping.length === 0,
  "表格被替换时插件不在表格范围内产生装饰",
  JSON.stringify(overlapping.map((d) => d.text)),
);

// ============================================================ mermaid 图
console.log("\n场景 F：mermaid 图（与表格同为块级替换）\n");

check(mermaids.length === 2, "两个 mermaid 块都被替换（含一个故意写错的）", `实际=${mermaids.length}`);

const diagram = mermaids.find((d) => (d.widget?.code ?? "").includes("graph TD"));
check(diagram !== undefined, "图表的 widget 拿到了图定义源码");
check(
  (diagram?.widget?.code ?? "").includes("A[开始] --> B[结束]"),
  "图定义内容完整",
  JSON.stringify(diagram?.widget?.code),
);
check(diagram?.block === true, "mermaid 使用块级替换");
check(diagram?.text.startsWith("```mermaid"), "替换范围从围栏行开始");
check(diagram?.text.endsWith("\n"), "替换范围含行尾换行");

// 普通代码块绝不能被当成图
const tsAt = doc.indexOf("```ts");
check(
  !blockItems.some((d) => d.from <= tsAt && d.to > tsAt),
  "ts 代码块不被替换（只有 mermaid 才渲染成图）",
);

// 光标落在某个图内时，只有它退回源码，另一个照常渲染
const mermaidAt = doc.indexOf("```mermaid");
const insideDiagram = collect(computeBlockDecorations(stateAt(mermaidAt + 15))).filter(
  (d) => d.widgetName === "MermaidWidget",
);
check(insideDiagram.length === 1, "光标所在的那个图退回源码，另一个仍渲染", `实际=${insideDiagram.length}`);

// 关键防护：被块级替换的范围内不能有任何来自插件的装饰。
// 行装饰与块级替换落在同一行会让 CM6 抛异常、编辑器整体空白。
const insideReplaced = A.items.filter(
  (d) => d.from < (diagram?.to ?? 0) && d.to > (diagram?.from ?? 0),
);
check(
  insideReplaced.length === 0,
  "mermaid 块被替换时插件不在其范围内产生任何装饰（含行装饰）",
  JSON.stringify(insideReplaced.map((d) => d.cls ?? d.text)),
);

// ============================================================ 图片路径解析
console.log("\n场景 G：图片路径解析（纯字符串，不需要 DOM）\n");

const ctx = { vaultPath: "H:/vault", notePath: "notes/sub/a.md" };
const at = (url, context = ctx) => resolveResource(context, url);

check(at("pic.png").local === "H:/vault/notes/sub/pic.png", "相对路径按笔记所在目录解析", at("pic.png").local);
check(at("attachments/pic.png").local === "H:/vault/notes/sub/attachments/pic.png", "多级相对路径");
check(at("/attachments/pic.png").local === "H:/vault/attachments/pic.png", "以 / 开头按仓库根解析");
check(at("../pic.png").local === "H:/vault/notes/pic.png", "`..` 正确回退一层");
check(at("../../pic.png").local === "H:/vault/pic.png", "多级 `..` 回退");
check(at("./pic.png").local === "H:/vault/notes/sub/pic.png", "`./` 前缀被忽略");
check(at("my%20pic.png").local === "H:/vault/notes/sub/my pic.png", "URL 编码（%20）会解码");
check(
  at("https://example.com/b.png").remote === "https://example.com/b.png" &&
    at("https://example.com/b.png").local === null,
  "http 地址原样透传，不做本地解析",
);
check(at("data:image/png;base64,AAAA").remote === "data:image/png;base64,AAAA", "data URL 原样透传");
check(at("blob:abc").remote === "blob:abc", "blob URL 原样透传");
check(at("pic.png", { vaultPath: null, notePath: null }).local === null, "没有仓库路径时返回 null");
check(at("pic.png", { vaultPath: "H:/vault", notePath: null }).local === "H:/vault/pic.png", "笔记在仓库根时直接拼在根下");
check(
  at("pic.png", { vaultPath: "H:\\vault\\", notePath: "a.md" }).local === "H:/vault/pic.png",
  "反斜杠与结尾斜杠被规范化",
);
check(
  at("a/%2E%2E/pic.png").local === "H:/vault/notes/sub/pic.png",
  "编码后的 `..` 也会还原并回退（只抵消 `a` 一层）",
  at("a/%2E%2E/pic.png").local,
);
// 安全边界：`..` 不能把路径带出仓库（asset 白名单是第二道防线，但解析本身就该夹住）
check(
  at("../../../../../../Windows/System32/x.png").local === "H:/vault/Windows/System32/x.png",
  "`..` 不允许越过仓库根",
  at("../../../../../../Windows/System32/x.png").local,
);

// ============================================================ Obsidian wiki 语法
console.log("\n场景 H：Obsidian wiki 语法\n");

// `![[x]]` 会被 Markdown 解析器拆成一个目标为空的 Image 节点，
// 这正是最初"图片只显示成 [Pasted image ...] 占位标签"的原因。wiki 分支必须接管它。
const wikiImages = images.filter((d) => d.widget?.target === "pic.png");
check(wikiImages.length === 3, "三个 wiki 嵌入都渲染成图片部件", `实际=${wikiImages.length}`);
check(
  wikiImages.every((d) => d.text.startsWith("![[") && d.text.endsWith("]]")),
  "替换范围覆盖整个 `![[...]]`",
  JSON.stringify(wikiImages.map((d) => d.text)),
);

const plainEmbed = wikiImages.find((d) => d.text === "![[pic.png]]");
check(plainEmbed !== undefined, "无修饰的嵌入被识别", JSON.stringify(wikiImages.map((d) => d.text)));
check(
  plainEmbed?.widget?.width === null && plainEmbed?.widget?.alt === "",
  "无修饰的嵌入没有宽度、没有 alt",
);

const sized = wikiImages.find((d) => d.widget?.width === 80);
check(sized !== undefined, "`![[pic.png|80]]` 的数字被识别为宽度", JSON.stringify(wikiImages.map((d) => d.widget?.width)));
check(sized?.widget?.alt === "", "宽度数字不会被误当成 alt");

const captioned = wikiImages.find((d) => d.widget?.alt === "示意图");
check(captioned !== undefined, "`![[pic.png|示意图]]` 的文字被识别为 alt");
check(captioned?.widget?.width === null, "文字说明不会被误当成宽度");

// 笔记嵌入（内容嵌入 transclusion）
const noteEmbeds = widgetOf(A.items, "NoteEmbedWidget");
check(noteEmbeds.length === 4, "四处笔记嵌入都换成嵌入部件", `实际=${noteEmbeds.length}`);
const embedTargets = noteEmbeds.map((d) => d.widget?.target);
check(embedTargets.includes("嵌入目标"), "整篇嵌入的目标正确", JSON.stringify(embedTargets));
check(embedTargets.includes("嵌入目标#小节甲"), "小节嵌入的目标正确");
check(embedTargets.includes("嵌入目标#^blockid"), "块引用嵌入的目标正确");
check(embedTargets.includes("并不存在的笔记"), "不存在的目标也生成部件（渲染时才报错）");
check(
  noteEmbeds.find((d) => d.widget?.target === "嵌入目标#小节甲")?.widget?.text === "嵌入目标 › 小节甲",
  "小节嵌入的标题带上小节名",
  noteEmbeds.find((d) => d.widget?.target === "嵌入目标#小节甲")?.widget?.text,
);
check(
  noteEmbeds.every((d) => typeof d.widget?.generation === "number"),
  "嵌入部件带代际（内容变化后据此重建）",
);

// wiki 链接：只隐藏方括号，文字保留为可编辑文本
check(
  hidesWithin(A.items, "[[某笔记]]").length === 2,
  "`[[某笔记]]` 两侧方括号被隐藏",
  JSON.stringify(hidesWithin(A.items, "[[某笔记]]").map((d) => d.text)),
);
check(
  A.items.some((d) => d.cls?.includes("cm-lp-link") && d.text === "某笔记"),
  "wiki 链接文字加了链接样式",
  JSON.stringify(A.items.filter((d) => d.cls?.includes("cm-lp-link")).map((d) => d.text)),
);
check(
  A.items.some((d) => d.cls?.includes("cm-lp-link") && d.text === "别名"),
  "`[[某笔记|别名]]` 只显示别名",
);
check(hidesWithin(A.items, "[[某笔记|别名]]").length === 2, "别名写法也隐藏了方括号");

// 代码区域里的不算语法
const codeMarker = doc.indexOf("行内代码里不算语法");
check(
  !A.items.some((d) => d.from > codeMarker && (d.widgetName === "ImageWidget" || d.widgetName === "NoteEmbedWidget")),
  "行内代码里的 `![[...]]` 不被当作 wiki 语法",
  JSON.stringify(A.items.filter((d) => d.from > codeMarker && d.widgetName).map((d) => d.text)),
);

// 按文件名在全库索引里解析（Obsidian 的查找方式）
const wikiCtx = {
  vaultPath: "H:/vault",
  notePath: "notes/a.md",
  embedIndex: new Map([["pic.png", "attachments/pic.png"]]),
};
check(
  resolveWikiTarget(wikiCtx, "pic.png").local === "H:/vault/attachments/pic.png",
  "wiki 目标按文件名在全库索引里解析",
  resolveWikiTarget(wikiCtx, "pic.png").local,
);
check(
  resolveWikiTarget(wikiCtx, "missing.png").local === "H:/vault/notes/missing.png",
  "索引里找不到时退回相对笔记目录（不崩）",
  resolveWikiTarget(wikiCtx, "missing.png").local,
);
check(
  resolveWikiTarget(wikiCtx, "sub/a.png").local === "H:/vault/notes/sub/a.png",
  "带路径分隔符的目标按路径解析",
  resolveWikiTarget(wikiCtx, "sub/a.png").local,
);
check(
  resolveWikiTarget(wikiCtx, "https://x/y.png").remote === "https://x/y.png",
  "远程目标原样透传",
);
// 索引的键统一是小写（由 App 建立索引时归一化），但笔记里可能写成别的大小写
check(
  resolveWikiTarget(wikiCtx, "PIC.PNG").local === "H:/vault/attachments/pic.png",
  "笔记里的大小写与文件名不一致也能找到",
  resolveWikiTarget(wikiCtx, "PIC.PNG").local,
);

// ============================================================ 内容嵌入
console.log("\n场景 I：内容嵌入的切片与预处理\n");

const embedded = readFileSync(join(dirname(file), "嵌入目标.md"), "utf8");

// sliceSection：整篇 / 标题小节 / 块引用 / 找不到
check(sliceSection(embedded, "") === embedded, "不指定小节时返回整篇");
const sectionA = sliceSection(embedded, "小节甲");
check(sectionA.startsWith("## 小节甲"), "小节从标题行开始", JSON.stringify(sectionA.slice(0, 20)));
check(sectionA.includes("小节甲的内容"), "小节内容被取出");
check(!sectionA.includes("小节乙的内容"), "下一个同级标题之后的内容被排除");
check(
  sliceSection(embedded, "  小节甲  ") === sectionA,
  "小节名首尾空格被忽略",
);
const sectionB = sliceSection(embedded, "小节乙");
check(sectionB.includes("小节乙的内容"), "第二个小节也能取到");
check(sectionB.includes("| 表头 | 值 |"), "小节里的表格一并取出");
check(sectionB.includes("子节内容"), "更深的标题不会截断小节（只有同级或更高级才截断）");
// 小节乙是文件里最后一个二级标题，因此它一直取到文件末尾——这是符合预期的行为
check(sectionB.includes("结尾段落"), "最后一个小节会取到文件末尾");
check(sliceSection(embedded, "不存在的标题") === "", "找不到小节返回空串");
check(
  sliceSection(embedded, "^blockid").includes("按块引用"),
  "块引用取到包含标记的段落",
  JSON.stringify(sliceSection(embedded, "^blockid")),
);
check(!sliceSection(embedded, "^blockid").includes("结尾段落"), "块引用不会取到后面的段落");
check(sliceSection(embedded, "^nosuchblock") === "", "找不到块引用返回空串");

// prepareEmbedMarkdown：把嵌入内容里的 wiki 语法转成 Markdown
const prepared = prepareEmbedMarkdown(
  "图 ![[pic.png]] 宽 ![[pic.png|80]] 说明 ![[pic.png|图说]]\n笔记 ![[嵌入目标]] 链接 [[某笔记|别名]]",
);
check(prepared.includes("![](<wiki:pic.png>)"), "wiki 图片转成 Markdown 图片（无修饰时 alt 为空）", prepared);
check(prepared.includes("![80](<wiki:pic.png>)"), "宽度保留在 alt 里（纯数字即宽度）");
check(prepared.includes("![图说](<wiki:pic.png>)"), "说明文字保留在 alt 里");
check(prepared.includes("[📄 嵌入目标](<wiki-link:嵌入目标>)"), "嵌套的笔记嵌入转成占位（不递归展开）");
check(prepared.includes("[别名](<wiki-link:某笔记>)"), "wiki 链接用别名作为显示文字");

// ============================================================ 链接、callout、标签
console.log("\n场景 J：裸链接 / callout / 标签\n");

// 裸链接（GFM 自动链接）：38% 的笔记里有，必须当链接处理
const bareLinks = A.items.filter((d) => d.cls?.includes("cm-lp-link") && d.text.startsWith("http"));
check(bareLinks.length === 2, "两个裸链接都被标成链接", `实际=${bareLinks.length}`);
check(
  bareLinks.every((d) => (d.widget === undefined ? true : true)) && bareLinks.some((d) => d.text === "https://example.com/bare"),
  "裸链接 `https://example.com/bare` 被识别",
);
check(
  A.items.some((d) => d.cls?.includes("cm-lp-link") && d.text === "外链"),
  "普通 Markdown 链接的文字仍按链接渲染",
);

// callout：整块容器 + 图标标签 + 标题
const noteLines = withClass(A.items, "cm-lp-callout-note");
const warnLines = withClass(A.items, "cm-lp-callout-warning");
check(noteLines.length === 3, "note callout 的三行都加了容器样式", `实际=${noteLines.length}`);
check(warnLines.length === 2, "warning callout 的两行都加了容器样式", `实际=${warnLines.length}`);
const calloutLabels = widgetOf(A.items, "CalloutLabelWidget");
check(calloutLabels.length === 2, "两个 callout 的 `[!type]` 都换成了标签", `实际=${calloutLabels.length}`);
check(
  calloutLabels.some((d) => d.widget?.type === "note" && d.widget?.title === "提示标题"),
  "带标题的 callout 取到了标题文字",
  JSON.stringify(calloutLabels.map((d) => d.widget)),
);
check(
  calloutLabels.some((d) => d.widget?.type === "warning" && d.widget?.title === ""),
  "没写标题时 title 为空（由 widget 回落到默认标题）",
);
check(
  withClass(A.items, "cm-lp-quote").length === 1,
  "callout 行不会同时拿到普通引用样式（只有文末那个真引用）",
  `实际=${withClass(A.items, "cm-lp-quote").length}`,
);
check(
  A.items.filter((d) => d.kind === "hide" && d.text.startsWith(">")).length === 6,
  "callout 的 5 个 `>` 与文末引用的 1 个 `>` 都被隐藏",
  `实际=${A.items.filter((d) => d.kind === "hide" && d.text.startsWith(">")).length}`,
);

// 反斜杠转义（`\$`、`\*`）：渲染态藏掉反斜杠、被转义字符回普通正文色
// （盖掉 escape 语法主题的橙色，对齐 Obsidian 的转义观感）
const escapes = withClass(A.items, "cm-lp-plain");
check(
  escapes.some((d) => d.text === "$") && escapes.some((d) => d.text === "*"),
  "被转义的 `$` 与 `*` 保留并标为普通正文色",
  JSON.stringify(escapes.map((d) => d.text)),
);
check(
  hidesWithin(A.items, "\\$5").some((d) => d.text === "\\"),
  "`\\$` 的反斜杠被隐藏",
);
check(
  !withClass(A.items, "cm-lp-strong").some((d) => d.text === "5"),
  "转义的星号不会产生粗体样式",
);
const Besc = decorate(doc.indexOf("\\$5") + 1); // 光标落在反斜杠上
check(
  hidesWithin(Besc.items, "\\$5").length === 0 && withClass(Besc.items, "cm-lp-plain").length === 0,
  "光标在转义上：显出源码可编辑",
);

// 标签
const tags = withClass(A.items, "cm-lp-tag");
check(tags.length === 3, "三个标签都加了样式", `实际=${tags.length}`);
check(
  JSON.stringify(tags.map((d) => d.text)) === JSON.stringify(["#标签", "#嵌套/标签", "#a1"]),
  "标签范围正确（含中文、子路径与字母数字）",
  JSON.stringify(tags.map((d) => d.text)),
);
check(
  !tags.some((d) => d.text.startsWith("### ")),
  "ATX 标题的 `#` 没有被当成标签",
);

// Ctrl+点击链接时用：从文档位置反查 URL（纯函数）
const urlState = EditorState.create({
  doc,
  extensions: [markdown({ base: markdownLanguage })],
});
check(
  externalUrlAt(urlState, doc.indexOf("https://example.com/bare") + 3) ===
    "https://example.com/bare",
  "从裸链接位置反查到 URL",
);
check(
  externalUrlAt(urlState, doc.indexOf("[外链]") + 2) === "https://example.com/normal",
  "从 Markdown 链接文字反查到 URL",
);
check(externalUrlAt(urlState, doc.indexOf("普通项目一")) === null, "普通文字位置反查不到 URL");
check(
  externalUrlAt(urlState, doc.indexOf("attachments/pic.png")) === null,
  "本地图片路径不会被当成外部链接",
);

console.log(failures === 0 ? "\nLive Preview 装饰层验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

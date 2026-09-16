// 表格结构编辑与大纲提取的纯逻辑（无需 DOM、无需 Tauri）。
//
// 覆盖重点是那些"写错了不会报错、只会静默产生错误结果"的地方：
//   · 管道对齐按显示宽度算（CJK 两格）——按 JS 字符串长度算的话中文表格永远对不齐
//   · 行列增删后管道仍对齐、单元格内容一个字符都不丢
//   · 单元格区间扫描（Tab 导航的依据）
//   · 大纲：围栏代码块里的 # 不是标题、setext 与分隔线/列表的区分
//
// 用法：node --experimental-strip-types --no-warnings scripts/verify-tables.mjs

import {
  alignOf,
  cellSpansInLine,
  charWidth,
  deleteColumn,
  deleteRow,
  displayWidth,
  formatTable,
  insertColumn,
  insertRow,
  isDelimiterLine,
  isTableRowLine,
  joinRow,
  normalizeColumns,
  parseTableBlock,
  splitRow,
  tableSpans,
} from "../src/lib/table.ts";
import { isNewer } from "../src/lib/updater.ts";
import { outlineOf } from "../src/lib/outline.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};
const lines = (text) => text.split("\n");

// ---------------------------------------------------------------- 表格解析

console.log("表格解析\n");

{
  check(isTableRowLine("| a | b |"), "标准行是表格行");
  check(!isTableRowLine("a | b"), "没有首管道不是表格行");
  check(isDelimiterLine("| --- | :--: |"), "分隔行识别");
  check(!isDelimiterLine("| a | b |"), "普通行不是分隔行");
  check(isDelimiterLine("| - | - |"), "单个 - 也是分隔行（cmark 规则：一个连字符即可）");

  const block = parseTableBlock(lines("| 名称 | 数量 |\n| --- | ---: |\n| 苹果 | 3 |\n| 梨 | 12 |"));
  check(block !== null, "合法块解析成功");
  check(block.header.join(",") === "名称,数量", "表头切分");
  check(block.rows.length === 2, "数据行数量");
  check(alignOf(block.delimiter[1]) === "right", "对齐标记 `-:` = 右对齐");

  check(parseTableBlock(lines("| a | b |")) === null, "没有分隔行 = 不是表格");
  check(parseTableBlock(lines("| a | b |\n| --- |")) !== null, "列数不齐也解析（交给 normalize）");
}

// ---------------------------------------------------------------- 管道对齐

console.log("\n管道对齐（CJK 显示宽度）\n");

{
  check(charWidth("中".codePointAt(0)) === 2, "CJK 算 2 格");
  check(charWidth("a".codePointAt(0)) === 1, "拉丁算 1 格");
  check(displayWidth("中文ab") === 6, "混合宽度合计");

  const block = {
    header: ["命令", "说明"],
    delimiter: ["---", ":---:"],
    rows: [
      ["git status", "查看状态"],
      ["短", "ok"],
    ],
  };
  const out = formatTable(block);
  check(out.length === 4, "输出行数 = 表头 + 分隔 + 2 数据");
  // 每行显示宽度必须一致，管道才竖成一条线
  const widths = out.map((line) => displayWidth(line));
  check(
    widths.every((w) => w === widths[0]),
    "所有行的显示宽度一致（管道对齐）",
    JSON.stringify(out),
  );
  // 内容不丢
  const back = out.map(splitRow);
  check(back[0].join("|") === "命令|说明", "表头内容不变");
  check(back[2][0] === "git status" && back[2][1] === "查看状态", "数据内容不变");
  check(out[1].startsWith("| ---"), "分隔行补齐 -");
  check(out[1].includes(":"), "居中对齐保留冒号");

  // 居中补白：奇数差额时左少右多
  check(alignOf("---") === "left" && alignOf(":-:") === "center" && alignOf("-:") === "right", "三种对齐标记");
}

// ---------------------------------------------------------------- 行列变换

console.log("\n行列增删（内容一个字符都不丢）\n");

{
  const block = parseTableBlock(lines("| a | b |\n| --- | --- |\n| 1 | 2 |"));

  // afterRowIndex 语义："插在哪个数据行之后"；-1 = 表头与分隔行之间
  const withRow = insertRow(block, -1, ["x", "y"]);
  check(withRow.length === 4, "插入一行后 4 行");
  check(splitRow(withRow[2]).join(",") === "x,y", "afterRowIndex=-1 插到第一行数据");
  check(splitRow(withRow[3]).join(",") === "1,2", "原数据行下移");
  const afterFirst = insertRow(block, 0, ["x", "y"]);
  check(splitRow(afterFirst[2]).join(",") === "1,2", "afterRowIndex=0 插在第一行数据之后");
  check(splitRow(afterFirst[3]).join(",") === "x,y", "新行落在其后");

  // 模板缺列时补空
  const withShortRow = insertRow(block, -1, ["只有一列"]);
  const cells = splitRow(withShortRow[2]);
  check(cells.length === 2 && cells[1] === "", "缺列的新行补空单元格");

  const withCol = insertColumn(block, 1);
  const colCells = withCol.map(splitRow);
  check(colCells[0].join(",") === "a,,b", "中间插列");
  check(colCells[2].join(",").startsWith("1,"), "数据行同样插列");

  const firstCol = insertColumn(block, 0);
  check(splitRow(firstCol[0])[0] === "", "列首插入得到空列");

  // 表格至少要保留一行数据（只有表头+分隔行的块不是合法 GFM），单行删除被忽略
  const twoRows = parseTableBlock(lines("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"));
  const minusRow = deleteRow(twoRows, 0);
  check(minusRow.length === 3 && splitRow(minusRow[2]).join(",") === "3,4", "删除数据行");
  check(deleteRow(twoRows, 5).length === 4, "越界删除原样返回");
  check(deleteRow(parseTableBlock(lines("| a |\n| --- |")), 0).length === 2, "无数据行的块删除被忽略（原样返回）");

  const minusCol = deleteColumn(block, 0);
  check(splitRow(minusCol[0]).join(",") === "b", "删除首列");
  check(deleteColumn(parseTableBlock(lines("| a |\n| --- |")), 0).length === 2, "仅一列时删除被忽略");
}

console.log("\n列数规范化\n");

{
  const ragged = parseTableBlock(lines("| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |"));
  const normalized = normalizeColumns(ragged);
  check(normalized.rows[0].length === 4, "短行补空到最宽");
  check(normalized.rows[1].length === 4, "长行保留（不丢内容）");
  const out = formatTable(ragged);
  check(out.map(splitRow).every((cells) => cells.length === 4), "格式化后所有行列数一致");
}

// ---------------------------------------------------------------- 单元格区间（Tab 导航）

console.log("\n单元格区间（Tab 导航的依据）\n");

{
  const spans = tableSpans(["| a | bb |", "| --- | --- |", "| 1 | 2 |"]).rows;
  check(spans.length === 3, "行数");
  check(spans[0].cells.length === 2, "单元格数");
  // "| a | bb |"：区间是**两根管道之间**（含补白空格）：a 在 [1,4]，bb 在 [5,9]
  check(spans[0].cells[0].start === 1 && spans[0].cells[0].end === 4, "第一格区间");
  check(spans[0].cells[1].start === 5 && spans[0].cells[1].end === 9, "第二格区间（含末管道前的空格）");
  const empty = tableSpans(["||"]).rows[0].cells;
  check(empty.length === 1 && empty[0].start === empty[0].end, "`||` 也占一格（空区间）");

  check(joinRow(["a", "b"]) === "| a | b |", "拼行格式");
}

// ---------------------------------------------------------------- 大纲

console.log("\n大纲提取\n");

{
  const doc = lines(
    "# 标题一\n正文\n\n## 小节\n### 深一点\n```\n# 代码块里不是标题\n~~~\n# 波浪栏里也不是\n~~~\n```\n" +
      "Setext 一级\n===\nSetext 二级\n---\n- 列表项\n---\n没有空行的#不是标题#尾\n####四级",
  );

  const entries = outlineOf(doc);
  const heads = entries.map((e) => `${e.level}:${e.text}`).join(" | ");
  check(entries[0].level === 1 && entries[0].text === "标题一" && entries[0].line === 0, "ATX 一级");
  check(heads.includes("2:小节"), "ATX 二级");
  check(heads.includes("3:深一点"), "ATX 三级");
  check(!heads.includes("代码块里"), "围栏代码块里的 # 不是标题");
  check(!heads.includes("波浪栏里"), "~~~ 围栏同样跳过");
  check(heads.includes("1:Setext 一级"), "setext 一级（===）");
  check(heads.includes("2:Setext 二级"), "setext 二级（---）");
  // 列表项后面跟 ---：列表行不是 setext 标题
  check(!heads.includes("列表项"), "列表行不因后面的 --- 变成标题");

  check(outlineOf(["这一行只是提到 # 标签"]).length === 0, "行中出现的 # 不是标题");
  check(outlineOf(["#无空格"]).length === 0, "# 后必须有空格才算标题");

  const crlf = outlineOf(lines("# 标题\r\n正文\r\n## 小节\r\n"));
  check(crlf.length === 2 && crlf[1].text === "小节", "CRLF 行尾被剥掉");
  check(crlf[1].line === 2, "行号与文档一致");

  // 空文字标题（`##` 后无字）也进大纲，显示为占位
  const blank = outlineOf(lines("##"));
  check(blank.length === 1 && blank[0].text === "", "空标题占位");
}

console.log("\n版本比较（检查更新用）\n");

{
  check(isNewer("0.1.0", "0.2.0") === true, "0.1.0 < 0.2.0");
  check(isNewer("0.2.0", "0.1.0") === false, "0.2.0 > 0.1.0 → 不更新");
  check(isNewer("0.1.0", "0.1.0") === false, "相等 → 不更新");
  check(isNewer("0.1.9", "0.10.0") === true, "按数值比较而不是字符串");
  check(isNewer("0.2.0", "v0.3.0") === true, "latest 的 v 前缀被剥掉");
}

console.log(failures === 0 ? "\n表格与大纲逻辑验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

// 列表切换 / 日记改名日期 / 待办日期前缀的纯逻辑验证（无需 DOM、无需启动应用）。
//
// 覆盖：
//   - codeEdit.ts 的 listMarkerOf / listToggleLine（列表标记解析与增删换）；
//   - daily.ts 的 dailyRenameName（含「输入自带日期 → 日记改到那一天」）；
//   - daily.ts 的 parseTodoDateInput（明天 / MM-DD / YYYY-MM-DD 前缀）。
//
// 用法：node --experimental-strip-types --no-warnings scripts/verify-lists-daily.mjs

import { listMarkerOf, listToggleLine } from "../src/lib/codeEdit.ts";
import { dailyRenameName, parseTodoDateInput } from "../src/lib/daily.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};
const eq = (a, b, label) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

console.log("列表标记解析\n");
eq(listMarkerOf("- 任务"), { indent: "", kind: "bullet", markerLen: 2, content: "任务" }, "无序项");
eq(listMarkerOf("1. 第一"), { indent: "", kind: "ordered", markerLen: 3, content: "第一" }, "有序项");
eq(listMarkerOf("2) 第二"), { indent: "", kind: "ordered", markerLen: 3, content: "第二" }, "右括号序号");
eq(listMarkerOf("  - 嵌套"), { indent: "  ", kind: "bullet", markerLen: 2, content: "嵌套" }, "带缩进");
eq(listMarkerOf("- [ ] 待办"), { indent: "", kind: "bullet", markerLen: 2, content: "[ ] 待办" }, "任务项内容含勾选框");
eq(listMarkerOf("-没有空格"), null, "标记后无空格不是列表");
eq(listMarkerOf("普通文本"), null, "普通行不是列表");

console.log("\n列表切换（add / remove / 换类型）\n");
eq(listToggleLine("正文", "bullet", "add"), { text: "- 正文", delta: 2 }, "普通行加无序");
eq(listToggleLine("正文", "ordered", "add"), { text: "1. 正文", delta: 3 }, "普通行加有序");
eq(
  listToggleLine("正文", "ordered", "add", "2. "),
  { text: "2. 正文", delta: 3 },
  "普通行加有序（递增序号 2.）",
);
eq(
  listToggleLine("1. 旧序号", "ordered", "add", "2. "),
  { text: "2. 旧序号", delta: 0 },
  "已有 1. 归一成 2.（等宽序号 delta 0）",
);
eq(
  listToggleLine("1. 保持", "ordered", "add", "1. "),
  null,
  "序号已是目标值不动作",
);
eq(listToggleLine("- 正文", "bullet", "remove"), { text: "正文", delta: -2 }, "无序项去掉标记");
eq(listToggleLine("1. 正文", "ordered", "remove"), { text: "正文", delta: -3 }, "有序项去掉序号");
eq(listToggleLine("- [ ] 任务", "bullet", "remove"), { text: "任务", delta: -6 }, "任务项连勾选框一起摘");
eq(listToggleLine("- [x] 完成", "ordered", "add"), { text: "1. [x] 完成", delta: 1 }, "换类型保留勾选框");
eq(listToggleLine("1. 正文", "bullet", "add"), { text: "- 正文", delta: -1 }, "有序换无序");
eq(listToggleLine("- 正文", "bullet", "add"), null, "已是目标类型不动作");
eq(listToggleLine("- 正文", "bullet", "remove"), { text: "正文", delta: -2 }, "remove 模式对目标类型摘标记");
eq(listToggleLine("", "bullet", "add"), { text: "- ", delta: 2 }, "空行可加标记（光标行空行）");
eq(listToggleLine("普通", "bullet", "remove"), null, "非列表行删标记不动作");

console.log("\n日记改名（日期前缀保护 / 改日期）\n");
// 契约（与 verify-daily.mjs 一致）：输入不带 .md 就不补 .md
eq(
  dailyRenameName("日记/2026-09-18.md", "复盘", "YYYY-MM-DD"),
  { name: "2026-09-18 复盘", kept: true, date: undefined },
  "丢日期自动补回",
);
eq(
  dailyRenameName("日记/2026-09-18 复盘.md", "总结", "YYYY-MM-DD"),
  { name: "2026-09-18 总结", kept: true, date: undefined },
  "换名字保留原日期",
);
eq(
  dailyRenameName("日记/2026-09-18 复盘.md", "2026-09-18总结", "YYYY-MM-DD"),
  { name: "2026-09-18 总结", kept: true, date: undefined },
  "缺空格补齐（输入不带 .md 就不补）",
);
eq(
  dailyRenameName("日记/2026-09-18 复盘.md", "2026-09-25 复盘.md", "YYYY-MM-DD"),
  { name: "2026-09-25 复盘.md", kept: true, date: "2026-09-25" },
  "输入新日期 → 日记改到那一天",
);
eq(
  dailyRenameName("日记/2026-09-18.md", "2026-09-20", "YYYY-MM-DD"),
  { name: "2026-09-20", kept: true, date: "2026-09-20" },
  "只给新日期 → 改到那天",
);
eq(
  dailyRenameName("日记/2026-09-18 复盘.md", "2026-13-45 乱写.md", "YYYY-MM-DD"),
  { name: "2026-09-18 2026-13-45 乱写.md", kept: true, date: undefined },
  "非法日期当普通文字，日期照旧保护",
);
eq(
  dailyRenameName("普通笔记.md", "新名字", "YYYY-MM-DD"),
  { name: "新名字", kept: false, date: undefined },
  "非日记不改名",
);

console.log("\n待办日期前缀（未来待办）\n");
const TODAY = "2026-09-22";
eq(parseTodoDateInput("明天 买礼物", "YYYY-MM-DD", TODAY), { date: "2026-09-23", text: "买礼物" }, "明天");
eq(parseTodoDateInput("后天交房租", "YYYY-MM-DD", TODAY), { date: "2026-09-24", text: "交房租" }, "后天无空格");
eq(parseTodoDateInput("大后天 面试", "YYYY-MM-DD", TODAY), { date: "2026-09-25", text: "面试" }, "大后天");
eq(
  parseTodoDateInput("10-01 出发", "YYYY-MM-DD", TODAY),
  { date: "2026-10-01", text: "出发" },
  "MM-DD 补当前年",
);
eq(
  parseTodoDateInput("2026-11-11 写总结", "YYYY-MM-DD", TODAY),
  { date: "2026-11-11", text: "写总结" },
  "完整日期",
);
eq(parseTodoDateInput("2026-13-45 乱写", "YYYY-MM-DD", TODAY), null, "非法日期不当地址语法");
eq(parseTodoDateInput("2026-10-01", "YYYY-MM-DD", TODAY), null, "只有日期没有正文不当语法");
eq(parseTodoDateInput("正常待办", "YYYY-MM-DD", TODAY), null, "普通待办");
eq(
  parseTodoDateInput("明天 买礼物", "YYYY/MM/DD", "2026/09/22"),
  { date: "2026/09/23", text: "买礼物" },
  "自定义日期格式",
);

console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败 ✗`}`);
process.exit(failures === 0 ? 0 : 1);

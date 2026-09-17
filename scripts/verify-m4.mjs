// M4 增强功能的纯逻辑测试（无需 DOM、无需 Tauri）。
//
// 覆盖重点：识别/格式化这类"错了不报错、只静默出怪结果"的函数边界——
//   · 粘贴语言识别：特征足够时才出手，普通文字绝不能被包成代码块
//   · 周回顾：与插件逐行一致的输出格式（标题/统计口径/待办分桶）
//   · 提醒：到点触发一次、当天不重复、次日复位、非法时间不误触
//   · 天气：WMO 文案、frontmatter 后插入、失败路径
//   · 图片引用清理：围栏跳过、整行移除、无引用返回 null
//   · 共享配置：M4 新键的补丁式写回（插件专有键原样保留）
//
// 用法：node --experimental-strip-types --no-warnings scripts/verify-m4.mjs

import moment from "moment";
import { detectLanguage } from "../src/lib/languageDetect.ts";
import { buildWeeklyReview, recentWeeks, weekdayZh } from "../src/lib/weeklyReview.ts";
import { dueReminders, initialFiredMarks, isValidTime } from "../src/lib/reminders.ts";
import {
  WMO_WEATHER,
  formatWeather,
  forecastUrl,
  geocodingUrl,
  insertWeatherLine,
} from "../src/lib/weather.ts";
import { blobTypeOf, isImageRef, removeImageReferences } from "../src/lib/imageOps.ts";
import { blockInsertPadding, fencedBlock, isInsideFence } from "../src/lib/paste.ts";
import {
  looksLikeMarkdownTable,
  normalizePastedText,
  tsvToMarkdownTable,
} from "../src/lib/pasteTransforms.ts";
import {
  parseDailyConfig,
  serializeDailyConfig,
} from "../src/lib/dailyConfig.ts";
import { defaultDailySettings } from "../src/lib/daily.ts";

let failures = 0;
let total = 0;
const check = (ok, label, detail = "") => {
  total += 1;
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};
const eq = (a, b, label) => check(a === b, label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

// ---------------------------------------------------------------- 语言识别

{
  const python = `import os\n\ndef main():\n    print(os.path.join("a", "b"))\n    if __name__ == "__main__":\n        main()\n`;
  eq(detectLanguage(python, true), "python", "识别：python");

  const java = `public class Main {\n    public static void main(String[] args) {\n        System.out.println("hi");\n    }\n}\n`;
  eq(detectLanguage(java, true), "java", "识别：java");

  const js = `const x = 1;\nfunction add(a, b) {\n  console.log(a + b);\n}\n`;
  eq(detectLanguage(js, true), "javascript", "识别：javascript");

  const bash = `#!/bin/bash\ncd /tmp\nrm -rf build\necho done\n`;
  eq(detectLanguage(bash, true), "bash", "识别：bash");

  const sql = `SELECT id, name FROM users WHERE age > 18 ORDER BY name;\n`;
  eq(detectLanguage(sql, true), "sql", "识别：sql");

  eq(detectLanguage(`{"a": 1, "b": [2, 3], "c": {"d": true}}`, true), "json", "识别：json（整段可解析直接判定）");

  const mermaid = `graph TD\n    A[开始] --> B{判断}\n    B -->|是| C[结束]\n`;
  eq(detectLanguage(mermaid, true), "mermaid", "识别：mermaid");

  const go = `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n`;
  eq(detectLanguage(go, true), "go", "识别：go");

  // 普通文字绝不能被当成代码（这是该功能最大的风险：把日记段落包进围栏）
  eq(detectLanguage(`今天天气不错，适合出去走走，顺便买一杯咖啡。`, true), null, "排除：中文散文");
  eq(
    detectLanguage(
      "Meeting notes from Monday:\n- review the new design\n- ship the release\n- go home early\n",
      true,
    ),
    null,
    "排除：普通英文清单",
  );
  eq(detectLanguage("total = 3", false), null, "排除：单行弱特征（阈值 4.5）");
  eq(detectLanguage("<?php\necho 1;", true), "php", "识别：php（<?php 独占 5 分）");
}

// ---------------------------------------------------------------- 粘贴补位

{
  // 行尾插入：前空一行，后由下一行提供内容
  const lines = ["第一段文字。", "", "第二段。"];
  const pad = blockInsertPadding(lines, 0, lines[0].length);
  eq(pad.prefix, "\n\n", "补位：行尾 prefix 两换行");
  eq(pad.suffix, "", "补位：行尾 suffix 为空（下一行本来就是空行）");

  const mid = blockInsertPadding(["前后都有字"], 0, 2);
  eq(mid.prefix, "\n\n", "补位：行中间 prefix 两换行");
  eq(mid.mid ?? (mid.suffix === "\n\n" ? "\n\n" : null), "\n\n", "补位：行中间 suffix 两换行");

  eq(fencedBlock("a\r\nb\r\n", "js"), "```js\na\nb\n```", "围栏：CRLF 规范化 + 去尾换行");

  eq(isInsideFence(["```", "code", "```", "x"], 1), true, "围栏内判定：开围栏之后");
  eq(isInsideFence(["```", "code", "```", "x"], 3), false, "围栏内判定：闭围栏之后");
  eq(isInsideFence(["~~~", "x"], 1), true, "围栏内判定：波浪围栏");
}

// ---------------------------------------------------------------- 周回顾

{
  const format = "YYYY-MM-DD";
  const monday = moment("2026-09-14", format); // 周一
  const text = buildWeeklyReview({
    start: monday,
    end: monday.clone().add(6, "day"),
    isCurrent: true,
    diaries: [
      { dateKey: "2026-09-14", title: "2026-09-14 周一", words: 100 },
      { dateKey: "2026-09-16", title: "2026-09-16 周三", words: 50 },
    ],
    todos: {
      "2026-09-14": [
        { id: "1", text: "写周报", done: true, updatedAt: 1 },
        { id: "2", text: "跑步", done: false, updatedAt: 2 },
      ],
      "2026-09-15": [{ id: "3", text: "多行\n待办", done: true, updatedAt: 3 }],
      "2026-09-20": [{ id: "4", text: "已删除", done: false, deleted: true, updatedAt: 4 }],
    },
    dateFormat: format,
    weekdayLabel: weekdayZh,
  });

  const lines = text.split("\n");
  eq(lines[0], "## 本周回顾（9月14日 ~ 9月20日）", "回顾：标题（本周）");
  eq(lines[2], "### 本周日记（2 天，共 150 字）", "回顾：日记统计（篇数与去空白字数）");
  check(text.includes("- 09-14 周一《2026-09-14 周一》"), "回顾：日记行带星期");
  check(text.includes("### 待办完成（2 项）"), "回顾：完成计数");
  check(text.includes("- [x] 写周报（09-14 周一）"), "回顾：完成行带日期与星期");
  check(text.includes("- [x] 多行 / 待办（09-15 周二）"), "回顾：多行待办压平");
  check(text.includes("### 待办未完成（1 项）"), "回顾：墓碑不进统计（1 项而非 2 项）");
  check(!text.includes("已删除"), "回顾：墓碑条目不出现");

  // 非本周：标题用 ISO 周号年（GGGG）
  const other = buildWeeklyReview({
    start: monday,
    end: monday.clone().add(6, "day"),
    isCurrent: false,
    diaries: [],
    todos: {},
    dateFormat: format,
    weekdayLabel: weekdayZh,
  });
  check(other.startsWith("## 2026-W38 回顾"), `回顾：非本周标题用周号`, other.split("\n")[0]);
  check(other.includes("### 本周日记（0 天，共 0 字）") && other.includes("- 本周没有写日记"), "回顾：空日记兜底文案");

  // 12 周选择器：本周在前，跨年不错格
  const weeks = recentWeeks(moment("2027-01-01", format));
  eq(weeks.length, 12, "选周：12 周");
  eq(weeks[0].weekKey, isoWeekOf("2027-01-01"), "选周：锚定周含当天（2027-01-01 属 2026-W53）");
  eq(weeks[1].weekKey, "2026-W52", "选周：往前一周");
}

/** 独立实现一次 ISO 周号（不复刻生产代码，用作互校）。 */
function isoWeekOf(dateStr) {
  const d = moment(dateStr, "YYYY-MM-DD").startOf("isoWeek");
  return d.format("GGGG-[W]WW");
}

// ---------------------------------------------------------------- 提醒

{
  const mk = (h, m) => new Date(2026, 8, 17, h, m, 0, 0);
  const config = { todoEnabled: true, todoTime: "08:00", checkEnabled: true, checkTime: "21:00" };

  let due = dueReminders(mk(7, 59), config, { todo: "", check: "" });
  eq(due.todo, false, "提醒：未到点不触发（todo）");
  eq(due.check, false, "提醒：未到点不触发（check）");

  due = dueReminders(mk(8, 0), config, { todo: "", check: "" });
  eq(due.todo, true, "提醒：到点触发");
  eq(due.next.todo, "2026-09-17", "提醒：触发后记当天");

  // 同一天第二次轮询不重复
  due = dueReminders(mk(8, 30), config, due.next);
  eq(due.todo, false, "提醒：当天不重复触发");

  // 次日复位
  const nextDay = new Date(2026, 8, 18, 8, 0, 0, 0);
  due = dueReminders(nextDay, config, due.next);
  eq(due.todo, true, "提醒：次日复位再触发");

  // 启动时时间点已过 → 当天不再补提醒（语义在初始化标记里，与插件一致）
  const initMarks = initialFiredMarks(mk(9, 0), config);
  eq(initMarks.todo, "2026-09-17", "提醒：启动时已过时间点直接标记为已提醒");
  due = dueReminders(mk(9, 0), config, initMarks);
  eq(due.todo, false, "提醒：初始化后不补提醒");
  // 时间点还没到则不标记，到点照常触发
  const early = initialFiredMarks(mk(7, 0), config);
  eq(early.todo, "", "提醒：启动早于时间点不标记");
  eq(dueReminders(mk(8, 0), config, early).todo, true, "提醒：初始化后到点仍会触发");

  // 非法时间不误触
  due = dueReminders(mk(9, 0), { ...config, todoTime: "8:00" }, { todo: "", check: "" });
  eq(due.todo, false, "提醒：非法时间视为未启用");
  eq(isValidTime("08:00"), true, "提醒：合法时间 08:00");
  eq(isValidTime("24:00"), false, "提醒：24:00 非法");
  eq(isValidTime("08:60"), false, "提醒：08:60 非法");

  // 关闭的通道不触发
  due = dueReminders(mk(8, 0), { ...config, todoEnabled: false }, { todo: "", check: "" });
  eq(due.todo, false, "提醒：开关关闭不触发");
}

// ---------------------------------------------------------------- 天气

{
  eq(WMO_WEATHER[0].desc, "晴", "天气：WMO 0 是晴");
  eq(WMO_WEATHER[95].icon, "⛈️", "天气：WMO 95 雷暴");
  check(!(99 in WMO_WEATHER) === false, "天气：WMO 99 在表内");

  const geo = { results: [{ latitude: 39.9, longitude: 116.4 }] };
  const forecast = {
    current: { temperature_2m: 24.6, weather_code: 1 },
    daily: { temperature_2m_max: [27.4], temperature_2m_min: [17.5] },
  };
  eq(formatWeather(geo, forecast), "🌤️ 基本晴朗 25°C（18~27°C）", "天气：文案格式（四舍五入）");
  eq(formatWeather({}, forecast), null, "天气：城市未命中返回 null");
  check(formatWeather(geo, { current: { weather_code: 999 } })?.includes("未知") === true, "天气：未知代码兜底不抛错");

  check(geocodingUrl("北 京").includes("%E5%8C%97%20%E4%BA%AC"), "天气：城市名 URL 编码");
  check(forecastUrl(1, 2).includes("latitude=1&longitude=2"), "天气：预报 URL 参数");

  // 插入位置：frontmatter 之后（天气串本身不带 "> "，由插入函数加）
  const withFm = insertWeatherLine("---\ntitle: x\n---\n\n# 2026-09-17\n", "☀️ 晴");
  eq(
    withFm,
    "---\ntitle: x\n---\n> ☀️ 晴\n\n# 2026-09-17\n",
    "天气：有 frontmatter 插到其后",
  );
  eq(insertWeatherLine("# 标题\n", "雨"), "# 标题\n> 雨\n", "天气：无 frontmatter 插到首行后");
}

// ---------------------------------------------------------------- 图片引用清理

{
  const file = "attachments/pasted image 1.png";
  const name = "pasted image 1.png";

  eq(isImageRef("attachments/Pasted image 1.png", file, name), true, "引用：完整路径（忽略大小写）");
  eq(isImageRef("pasted image 1.png", file, name), true, "引用：纯文件名匹配");
  eq(isImageRef("attachments/other.png", file, name), false, "引用：别的图不匹配");

  const doc = [
    "# 笔记",
    "看这张图 ![[pasted image 1.png|300]] 很好",
    "![说明](attachments/pasted%20image%201.png \"标题\")",
    "整行引用下一行只剩它时会被一起删掉",
    "![[pasted image 1.png]]",
    "普通链接 [[其他笔记]] 不动",
    "```",
    "代码里的 ![[pasted image 1.png]] 是示例",
    "```",
    "",
  ].join("\n");
  const next = removeImageReferences(doc, file, name);
  check(next !== null, "引用：有引用时返回新内容");
  check(next.includes("看这张图  很好"), "引用：行内还有文字时保留该行（只删引用本体）");
  check(!next.includes("![[pasted image 1.png|300]]"), "引用：wiki 嵌入被移除");
  check(!next.includes("pasted%20image"), "引用：markdown 图片（URL 编码路径）被移除");
  check(
    next.includes("整行引用下一行只剩它时会被一起删掉\n普通链接"),
    "引用：引用删空的行整行移除",
  );
  check(next.includes("[[其他笔记]]"), "引用：wiki 链接保留");
  check(next.includes("代码里的 ![[pasted image 1.png]] 是示例"), "引用：围栏代码块内不处理");

  eq(removeImageReferences("没有引用的笔记", file, name), null, "引用：无引用返回 null（跳过写盘）");

  eq(blobTypeOf("a.JPG"), "image/jpeg", "MIME：jpg");
  eq(blobTypeOf("a.webp"), "image/webp", "MIME：webp");
  eq(blobTypeOf("a.png"), "image/png", "MIME：png");
}

// ---------------------------------------------------------------- 粘贴变换

{
  // 换行符规范化：CRLF 剪贴板进 LF 文档不留裸 \r（红色 CR 角标就是这么来的）
  eq(normalizePastedText("a\r\nb\rc\n", "\n"), "a\nb\nc\n", "粘贴：CRLF/CR → LF");
  eq(normalizePastedText("a\nb\r\nc", "\r\n"), "a\r\nb\r\nc", "粘贴：LF → CRLF");
  eq(normalizePastedText("a\r\nb", "\r"), "a\rb", "粘贴：→ 孤 CR");

  // TSV → Markdown 表格
  const tsv = "插件\t描述\nclean\t清理\ncompiler\t编译";
  const converted = tsvToMarkdownTable(tsv);
  check(converted !== null, "TSV：两列多行识别为表格");
  eq(
    converted?.join("\n"),
    "| 插件 | 描述 |\n| --- | --- |\n| clean | 清理 |\n| compiler | 编译 |",
    "TSV：转换结果（表头 + 分隔行 + 数据行）",
  );
  check(tsvToMarkdownTable("只有\t一行") === null, "TSV：单行不转");
  check(tsvToMarkdownTable("a\tb\n没有tab") === null, "TSV：存在无 tab 的行不转");
  check(tsvToMarkdownTable("\t缩进\n\t缩进") === null, "TSV：行首 tab 是缩进（Makefile 一类）不转");
  check(tsvToMarkdownTable("a\tb|c\nd\te") !== null, "TSV：单元格里的竖线被转义而不是破坏结构");
  check(converted?.every((line) => !line.includes("b|c")) === true, "TSV：竖线已转义");
  check(tsvToMarkdownTable("a\t\tb\nc\t\td") !== null, "TSV：空单元格保留为空");

  // 本身就是 Markdown 表格的文本保持原样（绝不再被改写）
  const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  eq(looksLikeMarkdownTable(md), true, "MD 表：识别为已是表格");
  eq(looksLikeMarkdownTable("a\tb\nc\td"), false, "MD 表：TSV 不是");
  eq(looksLikeMarkdownTable("| 只有\n| 一列的一部分"), false, "MD 表：行不完整不算");
}

// ---------------------------------------------------------------- 共享配置：M4 新键

{
  // 插件专有键原样保留 + M4 键补丁式写回
  const raw = JSON.stringify({
    emailAccessKey: "KEY-123",
    weatherProvider: "open-meteo",
    folder: "日记",
    dateFormat: "YYYY-MM-DD",
    todos: {},
    todoReminderEnabled: true,
    todoReminderTime: "09:30",
    bgOpacity: 0.5,
  });
  const state = parseDailyConfig(raw);
  eq(state.settings.todoReminderEnabled, true, "配置：读插件的提醒开关");
  eq(state.settings.todoReminderTime, "09:30", "配置：读插件的提醒时间");
  eq(state.settings.autoDetectCodeLang, true, "配置：缺省时语言识别开启");
  eq(state.settings.weatherCity, "", "配置：缺省城市为空");

  const update = serializeDailyConfig(state, {
    settings: { ...state.settings, weatherEnabled: true, weatherCity: "上海" },
  });
  const parsed = JSON.parse(update);
  eq(parsed.emailAccessKey, "KEY-123", "配置：插件专有键保留");
  eq(parsed.weatherProvider, "open-meteo", "配置：未知键保留");
  eq(parsed.bgOpacity, 0.5, "配置：设备本机键也不清掉");
  eq(parsed.weatherEnabled, true, "配置：新键写入");
  eq(parsed.weatherCity, "上海", "配置：城市写入");
  eq(parsed.todoReminderEnabled, true, "配置：原有提醒开关不动");

  // 非法时间串不写坏：读入时兜底
  const bad = parseDailyConfig(JSON.stringify({ todoReminderTime: "9:30" }));
  eq(bad.settings.todoReminderTime, "08:00", "配置：非法时间兜底为默认值");

  // 全新文件：OWNED_KEYS 顺序，包含 M4 键
  const fresh = serializeDailyConfig(parseDailyConfig(null), {
    settings: defaultDailySettings(),
  });
  const freshParsed = JSON.parse(fresh);
  check("autoDetectCodeLang" in freshParsed, "配置：新文件含语言识别键");
  check("weatherEnabled" in freshParsed, "配置：新文件含天气键");
  check("checkReminderTime" in freshParsed, "配置：新文件含检查时间键");
}

console.log(`\n共 ${total} 项断言，失败 ${failures} 项`);
if (failures > 0) process.exit(1);

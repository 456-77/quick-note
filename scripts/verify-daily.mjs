// 日记与日历的纯逻辑（无需 DOM、无需 Tauri）。
//
// 覆盖的重点是那些"写错了也不会报错、只会静默产生错误文件名"的地方：
// ISO 周号跨年、日期格式串、周记与日记的区分、模板占位符、统计口径、
// 以及库内配置的**补丁式写回**（写坏它等于清空用户的插件配置）。
//
// 用法：node scripts/verify-daily.mjs

import moment from "moment";
import {
  baseNameOf,
  dailyFolderFiles,
  dailyNotePath,
  dailyNotesOn,
  dailyTitle,
  dateFormatOf,
  defaultNoteContent,
  diaryDateSet,
  expandTemplate,
  findDailyNote,
  findWeeklyNote,
  isWeeklyName,
  isoWeekKey,
  monthDiaryCount,
  monthGrid,
  monthTitle,
  normalizeFolder,
  parseDateStrict,
  streakDays,
  underFolder,
  validateDailyName,
  weekCellLabel,
  weeklyKeySet,
  weeklyNotePath,
  weeklyTitle,
  wordCount,
} from "../src/lib/daily.ts";
import {
  carryOver,
  hasCarriedOver,
  liveItems,
  normalizeTodos,
  orderedTodos,
  pendingCount,
  stripCarryPrefix,
  carryPrefix,
} from "../src/lib/todos.ts";
import { parseDailyConfig, serializeDailyConfig } from "../src/lib/dailyConfig.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};
const settings = (patch = {}) => ({
  folder: "",
  dateFormat: "YYYY-MM-DD",
  dailyTemplateEnabled: false,
  dailyTemplatePath: "",
  weeklyTemplateEnabled: false,
  weeklyTemplatePath: "",
  ...patch,
});

// ---------------------------------------------------------------- 日期格式
console.log("日期格式（配置里是 moment 语法，必须与插件解释一致）\n");
check(dateFormatOf("") === "YYYY-MM-DD", "空格式串兜底成默认值（否则文件名会带前导空格）");
check(dateFormatOf("  ") === "YYYY-MM-DD", "只有空白的格式串同样兜底");
check(dateFormatOf("YYYYMMDD") === "YYYYMMDD", "自定义格式原样使用");

{
  const day = moment(new Date(2026, 8, 15));
  check(moment(day).format("YYYYMMDD") === "20260915", "YYYYMMDD 能按紧凑写法格式化");
  check(moment(day).format("YYYY年M月D日") === "2026年9月15日", "中文占位符格式可用");
  check(
    parseDateStrict("20260915", "YYYYMMDD").format("YYYY-MM-DD") === "2026-09-15",
    "严格解析能还原自定义格式写出的日期",
  );
}

// ---------------------------------------------------------------- ISO 周
console.log("\nISO 周号\n");
check(isoWeekKey(moment(new Date(2026, 8, 15))) === "2026-W38", "2026-09-15 属于 2026-W38");
check(
  isoWeekKey(moment(new Date(2027, 0, 1))) === "2026-W53",
  "跨年边界用 ISO 周号年：2027-01-01 属于 2026-W53（用 YYYY 拼 WW 会得到 2027-W53）",
  isoWeekKey(moment(new Date(2027, 0, 1))),
);
check(isoWeekKey(moment(new Date(2026, 0, 1))) === "2026-W01", "2026-01-01 属于 2026-W01");
check(weekCellLabel(moment(new Date(2026, 1, 9))) === "7", "W 列显示去前导零（W07 → 7）");
check(weekCellLabel(moment(new Date(2026, 8, 15))) === "38", "两位周号原样显示");

// ---------------------------------------------------------------- 命名与路径
console.log("\n命名与路径\n");
check(dailyTitle("2026-09-15", "项目周报") === "2026-09-15 项目周报", "日记标题 = 日期 + 空格 + 名字");
check(
  dailyNotePath(settings({ folder: "日记" }), "2026-09-15", "项目周报") ===
    "日记/2026-09-15 项目周报.md",
  "日记路径拼在配置的目录下",
);
check(
  dailyNotePath(settings(), "2026-09-15", "周报") === "2026-09-15 周报.md",
  "目录为空时落在仓库根",
);
check(weeklyTitle("2026-W37") === "2026-W37 周记", "周记标题固定为「周标识 + 周记」");
check(
  weeklyNotePath(settings({ folder: "日记" }), "2026-W37") === "日记/2026-W37 周记.md",
  "周记路径",
);
check(normalizeFolder(" 日记 ") === "日记", "目录名去首尾空格");
check(normalizeFolder("/日记/") === "日记", "目录名去首尾斜杠");
check(normalizeFolder("日记//子目录") === "日记/子目录", "折叠重复分隔符");
check(normalizeFolder("日记\\子目录") === "日记/子目录", "反斜杠转正斜杠");
check(underFolder("日记", "a.md") === "日记/a.md", "拼接目录与文件名");
check(defaultNoteContent("2026-09-15 周报") === "# 2026-09-15 周报\n", "无模板时的默认内容是一级标题 + 换行");

// 名字校验：每一条都对应一个具体的静默失败，不是形式主义的白名单
check(validateDailyName("项目周报") === null, "普通名字合法");
check(validateDailyName("  ") !== null, "纯空白名字被拒绝");
check(
  validateDailyName("子/名字") !== null,
  "含 `/` 被拒绝：它会被拼成子目录，而日记的发现只看直接子文件——建了也不会打点",
);
check(validateDailyName("子\\名字") !== null, "含反斜杠被拒绝");
check(validateDailyName(".hidden") !== null, "点开头的名字被拒绝（仓库枚举会跳过隐藏项）");
check(
  validateDailyName("a:b") !== null && validateDailyName("a?b") !== null,
  "Windows 禁用字符被拒绝（否则失败信息来自系统调用，看不出是名字的问题）",
);
check(validateDailyName("2026-09-15 会议") === null, "名字里可以有空格、数字与连字符");
check(validateDailyName("周报（含括号）") === null, "中文全角括号是合法字符");

// ---------------------------------------------------------------- 发现
console.log("\n日记与周记的发现\n");
const files = [
  "日记/2026-09-14 日记.md",
  "日记/2026-09-14 会议.md", // 同一天多篇
  "日记/2026-09-14.md", // 手工建的、没有名字
  "日记/2026-09-140.md", // 前缀相似但不是同一天
  "日记/2026-W37 周记.md",
  "日记/2026-W37.md",
  "日记/2026-W370.md",
  "日记/测试代码.md",
  "日记/子目录/2026-09-14 嵌套.md", // 子目录里的不算
  "其他/2026-09-14 别的目录.md",
];
const inFolder = dailyFolderFiles(files, settings({ folder: "日记" }));
check(
  !inFolder.includes("日记/子目录/2026-09-14 嵌套.md"),
  "日记只认目录的**直接**子文件，不递归",
  JSON.stringify(inFolder),
);
check(
  !inFolder.includes("其他/2026-09-14 别的目录.md"),
  "别的目录里的文件不算日记",
);
check(
  inFolder.includes("日记/2026-09-14.md") && inFolder.includes("日记/2026-W37 周记.md"),
  "日记目录下的 md 全部纳入",
);

check(
  JSON.stringify(dailyNotesOn(inFolder, "2026-09-14")) ===
    JSON.stringify([
      "日记/2026-09-14 会议.md",
      "日记/2026-09-14 日记.md",
      "日记/2026-09-14.md",
    ]),
  "同一天的多篇都能找到，并按文件名排序",
  JSON.stringify(dailyNotesOn(inFolder, "2026-09-14")),
);
check(
  !dailyNotesOn(inFolder, "2026-09-14").includes("日记/2026-09-140.md"),
  "「2026-09-140」不算 2026-09-14 的日记（前缀必须是空格或结束）",
);
check(
  findDailyNote(inFolder, "2026-09-14") === "日记/2026-09-14 会议.md",
  "多篇时取排序第一篇（与插件一致）",
  findDailyNote(inFolder, "2026-09-14"),
);
check(findDailyNote(inFolder, "2026-09-15") === null, "没有日记时返回 null");

check(isWeeklyName(baseNameOf("日记/2026-W37 周记.md")), "识别出周记文件名");
check(!isWeeklyName("2026-09-14"), "日期名不会被当成周记");
check(!isWeeklyName("2026-W370"), "「2026-W370」不是合法的周标识");

{
  const dates = diaryDateSet(inFolder);
  check(
    !dates.has("2026-W37"),
    "打点集合排除周记（否则会多算一天）",
    JSON.stringify([...dates]),
  );
  // 「2026-W370」这种畸形名会漏进来，这与插件完全一致（它的排除正则也要求周号后是
  // 空格或结尾）。不去"修好"它：打点集合一旦和插件不一致，两边看到的日历就不一样。
  // 真正兜住它的是统计处的严格解析。
  check(
    !dates.has("2026-W38") && dates.has("2026-W370"),
    "非法周号不比正常周记少排除，也不被误当成某一天的日记",
  );
  check(dates.has("2026-09-14"), "日期取自文件名的第一个空格之前");
  check(dates.has("测试代码"), "非常规命名的文件也贡献一个键（与插件一致）");
  // 「2026-09-140」会自成一件（与插件一致）：它进不了某一天的日记，
  // 但会作为一个独立的日期键存在，统计时被严格解析挡掉。
  check(dates.has("2026-09-140"), "「2026-09-140」自成一件，不会被并进 2026-09-14");
  check(
    monthDiaryCount(new Set(["2026-09-140"]), "YYYY-MM-DD", moment(new Date(2026, 8, 15))) === 0,
    "非常规日期串不进「本月天数」（统计处做严格解析）",
  );

  const weeks = weeklyKeySet(inFolder);
  check(weeks.has("2026-W37"), "周记集合取出周标识");
  check(!weeks.has("2026-W370"), "非法的周标识不进集合");
  check(findWeeklyNote(inFolder, "2026-W37") === "日记/2026-W37 周记.md", "找到某周的周记");
  check(findWeeklyNote(inFolder, "2026-W36") === null, "没有该周周记时返回 null");
}

// ---------------------------------------------------------------- 模板
console.log("\n模板占位符\n");
{
  const day = moment(new Date(2026, 8, 15, 14, 30, 5));
  const expanded = expandTemplate(
    "{{title}}|{{date}}|{{date:YYYY年M月D日}}|{{week}}|{{time}}|{{未知}}",
    { title: "2026-09-15 周报", dateMoment: day, now: day },
    "YYYY-MM-DD",
  );
  check(
    expanded === "2026-09-15 周报|2026-09-15|2026年9月15日||14:30|{{未知}}",
    "五个占位符都展开；日记的 {{week}} 展开成空串；未知占位符原样保留",
    expanded,
  );
  check(
    expandTemplate("# {{title}}\n", { title: "周记", dateMoment: day, week: "2026-W37", now: day }, "YYYY-MM-DD") ===
      "# 周记\n",
    "{{title}} 直接替换",
  );
  check(
    expandTemplate("{{week}}", { title: "t", dateMoment: day, week: "2026-W37", now: day }, "YYYY-MM-DD") ===
      "2026-W37",
    "周记的 {{week}} 是 ISO 周标识",
  );
  // {{date:格式}} 先于 {{date}} 替换：否则 {{date:...}} 会被拆成 {{date}} + 残余
  check(
    expandTemplate("{{date:YYYY}}", { title: "t", dateMoment: day, now: day }, "YYYY-MM-DD") === "2026",
    "带格式的日期先展开",
  );
  // moment 对**空格式串**的规定行为是返回 toISOString()，插件调的是同一个函数，
  // 所以这里保持一致（不去"修好"它——两边对同一个模板必须展开出同样的内容）。
  check(
    /^\d{4}-\d{2}-\d{2}T/.test(
      expandTemplate("{{date:}}", { title: "t", dateMoment: day, now: day }, "YYYY-MM-DD"),
    ),
    "空格式串的 {{date:}} 得到 ISO 时间串（moment 的规定行为）",
    expandTemplate("{{date:}}", { title: "t", dateMoment: day, now: day }, "YYYY-MM-DD"),
  );
  // 字符串替换里 $& 有特殊含义，函数替换能挡住这个改写
  check(
    expandTemplate("{{title}}", { title: "成本$&收益", dateMoment: day, now: day }, "YYYY-MM-DD") ===
      "成本$&收益",
    "标题里的 $& 不被当成替换模式（插件的字符串替换版本会在这里改坏模板）",
  );
  check(
    expandTemplate("{{title}} 与 {{date}}", { title: "含{{date}}的标题", dateMoment: day, now: day }, "YYYY-MM-DD") ===
      "含2026-09-15的标题 与 2026-09-15",
    "{{title}} 先替换，所以标题里若含 {{date}} 字样也会被后续步骤展开（与插件的顺序一致）",
    expandTemplate("{{title}} 与 {{date}}", { title: "含{{date}}的标题", dateMoment: day, now: day }, "YYYY-MM-DD"),
  );
  check(
    parseDateStrict("不是日期", "YYYY-MM-DD", day).format("YYYY-MM-DD") === "2026-09-15",
    "严格解析失败时退回给定时间，而不是产生 Invalid date",
  );
}

// ---------------------------------------------------------------- 日历网格
console.log("\n日历网格\n");
{
  const grid = monthGrid(moment(new Date(2026, 8, 15)), "YYYY-MM-DD", "2026-09-15");
  check(grid.length === 6, "固定 6 行（切换月份高度不跳）");
  check(grid.every((row) => row.days.length === 7), "每行 7 天");
  check(grid[0].days[0].key === "2026-08-31", "首格是当月 1 号所在周的周一", grid[0].days[0].key);
  check(grid[0].weekKey === "2026-W36", "首行的 ISO 周标识", grid[0].weekKey);
  check(grid[0].weekLabel === "36", "W 列显示周号（去前导零）");
  check(grid[0].mondayKey === "2026-08-31", "行的周一日期的供模板使用");
  check(
    grid.flatMap((row) => row.days).filter((day) => day.inMonth).length === 30,
    "9 月有 30 天（i 标记的格数）",
  );
  check(
    grid.flatMap((row) => row.days).filter((day) => day.isToday).length === 1,
    "恰好一格标记为今天",
  );
  check(
    grid.flatMap((row) => row.days).find((day) => day.isToday)?.key === "2026-09-15",
    "标记为今天的那一格就是今天",
  );
  check(monthTitle(moment(new Date(2026, 8, 15))) === "2026年9月", "标题写法");
  // 逐日连续、无重复（周起点算错就会出现重复或跳号）
  const keys = grid.flatMap((row) => row.days.map((day) => day.key));
  check(new Set(keys).size === 42, "42 天互不重复");
  const expected = Array.from({ length: 42 }, (_, index) =>
    moment(new Date(2026, 7, 31)).add(index, "day").format("YYYY-MM-DD"),
  );
  check(JSON.stringify(keys) === JSON.stringify(expected), "42 天连续无跳号");

  // 跨年：12 月的网格要延伸到次年 1 月，且周标识用 ISO 周号年
  const december = monthGrid(moment(new Date(2026, 11, 1)), "YYYY-MM-DD", "2026-12-01");
  check(
    december[5].days[0].key === "2027-01-04",
    "12 月的网格延伸到次年 1 月",
    december[5].days[0].key,
  );
  check(
    december[5].weekKey === "2027-W01",
    "跨年的那一行用 ISO 周号年（2027-W01，而不是 2026-W53）",
    december[5].weekKey,
  );
}

// ---------------------------------------------------------------- 统计
console.log("\n统计口径\n");
{
  const format = "YYYY-MM-DD";
  const set = new Set(["2026-09-13", "2026-09-14", "2026-09-15", "2026-08-31", "测试代码"]);
  check(
    monthDiaryCount(set, format, moment(new Date(2026, 8, 15))) === 3,
    "本月天数只数当前显示月份、且能严格解析的日期（测试代码 被排除）",
    String(monthDiaryCount(set, format, moment(new Date(2026, 8, 15)))),
  );
  check(
    monthDiaryCount(set, format, moment(new Date(2026, 7, 15))) === 1,
    "换到 8 月就只数 8 月",
  );
  check(streakDays(set, format, moment(new Date(2026, 8, 15))) === 3, "连续天数从今天往回数");
  check(
    streakDays(set, format, moment(new Date(2026, 8, 12))) === 0,
    "今天没写就是 0（哪怕之前连续写过）",
  );
  check(
    streakDays(new Set(), format, moment(new Date(2026, 8, 15))) === 0,
    "一条都没有时是 0",
  );
  check(
    streakDays(new Set(["2026-09-15"]), format, moment(new Date(2026, 8, 15)), 1) === 1,
    "上限参数能截断（防御异常数据导致的死循环）",
  );

  check(wordCount("abc") === 3, "字数：拉丁按字母算");
  check(wordCount("你好世界") === 4, "字数：CJK 一字算一个");
  check(wordCount("a b\nc\td") === 4, "字数：所有空白都不计入");
  check(wordCount("") === 0, "空内容 0 字");
  check(wordCount("你好，世界！") === 6, "字数：标点计入");
}

// ---------------------------------------------------------------- 待办
console.log("\n待办模型\n");
{
  const now = 1_800_000_000_000;
  const items = [
    { id: "a", text: "甲", done: false, updatedAt: 1 },
    { id: "b", text: "乙", done: true, updatedAt: 2 },
    { id: "c", text: "丙", done: false, updatedAt: 3, deleted: true },
  ];
  check(liveItems(items).length === 2, "墓碑不进 liveItems");
  check(pendingCount(items) === 1, "未完成数不含墓碑与已完成");

  const ordered = orderedTodos(items);
  check(
    JSON.stringify(ordered.map((row) => row.item.id)) === JSON.stringify(["a", "b"]),
    "未完成排在已完成上面",
  );
  check(
    JSON.stringify(ordered.map((row) => row.index)) === JSON.stringify([0, 1]),
    "下标是**原始数组**下标（墓碑之后的下标不能错位）",
    JSON.stringify(ordered.map((row) => row.index)),
  );
  // 墓碑排在最前，最容易暴露"先过滤再取下标"的写法
  const withTombstoneFirst = [{ id: "z", text: "z", done: false, updatedAt: 1, deleted: true }, ...items];
  check(
    JSON.stringify(orderedTodos(withTombstoneFirst).map((row) => row.index)) ===
      JSON.stringify([1, 2]),
    "首位是墓碑时下标仍然指向原始数组",
    JSON.stringify(orderedTodos(withTombstoneFirst).map((row) => row.index)),
  );

  check(carryPrefix("2026-09-07", "YYYY-MM-DD") === "[09-07 遗留]", "遗留前缀用 MM-DD");
  check(
    carryPrefix("不是日期", "YYYY-MM-DD") === "[不是日期 遗留]",
    "源日期解析不出来时退回原文（不显示 Invalid date）",
  );
  check(stripCarryPrefix("[09-07 遗留] 学习") === "学习", "剥掉遗留前缀");
  check(
    stripCarryPrefix("[09-06 遗留] [09-07 遗留] 学习") === "学习",
    "叠加的多个前缀一并剥掉（连续顺延不会让前缀越滚越长）",
  );
  check(stripCarryPrefix("学习") === "学习", "没有前缀时原样返回");
  check(hasCarriedOver([{ id: "a", text: "[09-07 遗留] 学习", done: false, updatedAt: 1 }]), "认出已顺延");
  check(!hasCarriedOver([{ id: "a", text: "学习", done: false, updatedAt: 1 }]), "普通待办不算已顺延");

  const source = [
    { id: "a", text: "未完成甲", done: false, updatedAt: 1 },
    { id: "b", text: "已完成乙", done: true, updatedAt: 2 },
    { id: "c", text: "未完成丙", done: false, updatedAt: 3 },
  ];
  const result = carryOver(source, [{ id: "t", text: "今天原有的", done: false, updatedAt: 4 }], "2026-09-07", "YYYY-MM-DD", now);
  check(result.moved === 2, "顺延了 2 项未完成");
  check(
    result.to.map((item) => item.text).join("|") === "今天原有的|[09-07 遗留] 未完成甲|[09-07 遗留] 未完成丙",
    "目标日期追加带前缀的新条目，原有条目不受影响",
    result.to.map((item) => item.text).join("|"),
  );
  check(
    result.to.every((item) => item.done === false),
    "顺延过来的条目一律未完成",
  );
  check(
    result.from.filter((item) => !item.deleted).map((item) => item.id).join(",") === "b",
    "源日期：被顺延的打墓碑，已完成的留下",
  );
  check(
    result.from.every((item) => (item.deleted ? item.updatedAt === now : true)),
    "墓碑带上修改时间（M3 合并要用）",
  );
  check(
    result.to.filter((item) => item.text.includes("遗留")).every((item) => !source.some((s) => s.id === item.id)),
    "顺延条目用**新 id**：同一个 id 出现在两个日期里会让合并无法判断归属",
  );
  check(source[0].deleted === undefined, "carryOver 不改动传入的原数组（纯函数）");

  const repeat = carryOver(result.from, result.to, "2026-09-07", "YYYY-MM-DD", now + 1);
  check(repeat.moved === 0, "再顺延一次不会再搬（源日期已无 live 的未完成项）");
  check(
    carryOver(undefined, undefined, "2026-09-07", "YYYY-MM-DD", now).moved === 0,
    "没有待办时安全返回",
  );
}

// ---------------------------------------------------------------- 旧数据迁移
console.log("\n旧格式待办的规范化\n");
{
  const legacy = {
    "2026-09-07": [
      { text: "早期版本只有 text 与 done", done: true },
      { text: "已经升级过的", done: false, id: "keep", updatedAt: 123 },
    ],
  };
  const { todos, repaired } = normalizeTodos(legacy, 999);
  check(repaired === 1, "只补齐了缺字段的那一条", String(repaired));
  check(typeof todos["2026-09-07"][0].id === "string" && todos["2026-09-07"][0].id !== "", "补上 id");
  check(
    todos["2026-09-07"][0].updatedAt === 999,
    "updatedAt 用该侧的最后修改时间兜底，**不是 now**（否则升级瞬间就会在合并里压掉别的设备）",
    String(todos["2026-09-07"][0].updatedAt),
  );
  check(
    todos["2026-09-07"][1].id === "keep" && todos["2026-09-07"][1].updatedAt === 123,
    "已有的 id/updatedAt 原样保留（幂等）",
  );
  check(todos["2026-09-07"][0].done === true, "done 保留");

  const broken = normalizeTodos(
    { a: "不是数组", b: [null, 3, { 无text: true }, { text: "好的一条" }] },
    0,
  );
  // 值不是数组的分桶整个丢弃（那种值里没有任何可用的待办数据），
  // 形状正确的分桶保留下来——一条坏数据不至于让整个日历面板打不开。
  check(
    Object.keys(broken.todos).join(",") === "b" && broken.todos.a === undefined,
    "值不是数组的分桶被丢弃，其余分桶照常保留",
    Object.keys(broken.todos).join(","),
  );
  check(broken.todos.b.length === 1 && broken.todos.b[0].text === "好的一条", "只留下形状正确的条目");
  check(broken.repaired === 5, "修补计数能反映丢弃量（用于提示升级了旧数据）", String(broken.repaired));
  check(
    JSON.stringify(normalizeTodos(null, 0).todos) === "{}" && normalizeTodos(undefined, 0).repaired === 0,
    "没有待办字段时返回空映射，不算异常",
  );
  check(normalizeTodos([], 0).repaired === 1, "todos 是数组时整个丢弃（形状不对）");
  check(
    normalizeTodos({ d: [{ text: "x", done: 1, id: "i", updatedAt: 5 }] }, 0).todos.d[0].done === false,
    "done 只认真正的布尔 true",
  );
  check(
    normalizeTodos(
      { d: [{ text: "x", done: true, id: "i", updatedAt: 5, deleted: true }] },
      0,
    ).todos.d[0].deleted === true,
    "墓碑标记保留",
  );
}

// ---------------------------------------------------------------- 库内配置
console.log("\n库内配置（quick-daily-note.json）\n");
{
  const empty = parseDailyConfig(null);
  check(empty.broken === false && empty.raw === null, "文件不存在不是错误（首次使用时按默认值）");
  check(empty.settings.folder === "" && empty.settings.dateFormat === "YYYY-MM-DD", "默认值是插件的那一套");

  const pluginFile = JSON.stringify({
    folder: "日记",
    dateFormat: "YYYY-MM-DD",
    todos: { "2026-09-07": [{ text: "旧条目", done: false }] },
    todosUpdatedAt: 555,
    emailAccessKey: "秘钥",
    weatherCity: "北京",
    todoReminderEnabled: true,
    bgEnabled: true,
    "未知配置": 1,
  });
  const state = parseDailyConfig(pluginFile);
  check(!state.broken, "正常解析");
  check(state.settings.folder === "日记", "读出日记目录");
  check(state.repaired === 1, "旧格式待办被规范化");

  const written = serializeDailyConfig(state, { settings: state.settings });
  check(written.includes('"emailAccessKey": "秘钥"'), "**未知键原样保留**（写坏它等于清空用户的插件配置）");
  check(written.includes('"weatherCity": "北京"'), "其他插件配置同样保留");
  check(written.includes('"bgEnabled": true'), "不认识的布尔键也保留");
  check(written.includes('"todoReminderEnabled": true'), "提醒开关保留");
  const reparsed = JSON.parse(written);
  // 已有键**就地替换**，键序不变；本次新引入的键（原文件里没有的）追加在末尾。
  // 重排已有键会让整份文件在 diff 与同步里全变。
  const originalOrder = Object.keys(JSON.parse(pluginFile));
  check(
    Object.keys(reparsed)
      .filter((key) => originalOrder.includes(key))
      .join(",") === originalOrder.join(","),
    "已有键的相对顺序不变（重排会让整份文件在 diff 与同步里全变）",
    Object.keys(reparsed).join(","),
  );
  check(
    Object.keys(reparsed).slice(0, originalOrder.length).join(",") === originalOrder.join(","),
    "未知键仍在原位，新引入的键追加在末尾",
    Object.keys(reparsed).join(","),
  );
  check(
    reparsed.dailyTemplateEnabled === false && reparsed.weeklyTemplateEnabled === false,
    "补上的模板开关是插件的默认值 false（不会因为写了一次设置就让模板突然生效）",
  );
  check(written === JSON.stringify(reparsed, null, 2), "序列化用 2 空格缩进，与插件一致");
  check(!written.endsWith("\n"), "无尾随换行（插件同样不写）");

  const todoWrite = serializeDailyConfig(state, {
    todos: { "2026-09-08": [{ id: "x", text: "新", done: false, updatedAt: 7 }] },
    todosUpdatedAt: 777,
  });
  const todoParsed = JSON.parse(todoWrite);
  check(todoParsed.todos["2026-09-08"][0].text === "新", "待办写入生效");
  check(todoParsed.todosUpdatedAt === 777, "写入待办时一并更新 todosUpdatedAt");
  check(todoParsed.folder === "日记", "只改待办时设置字段原样保留");
  check(todoParsed.emailAccessKey === "秘钥", "只改待办时未知键同样保留");
  check(!todoWrite.includes('"2026-09-07"'), "整份替换待办映射（旧分桶被新映射取代）");

  const settingsWrite = serializeDailyConfig(state, {
    settings: { ...state.settings, folder: "日记/子目录" },
  });
  check(JSON.parse(settingsWrite).folder === "日记/子目录", "改设置生效");
  check(
    JSON.stringify(JSON.parse(settingsWrite).todos) === JSON.stringify(state.todos),
    "改设置时待办原样保留",
  );
  check(
    JSON.parse(settingsWrite).todosUpdatedAt === 555,
    "改设置**不**动 todosUpdatedAt（刷成现在会让 M3 的快照哈希每轮都变）",
    String(JSON.parse(settingsWrite).todosUpdatedAt),
  );

  // 新建文件：只有我们管的键，且按插件的键序
  const fresh = serializeDailyConfig(parseDailyConfig(null), {
    settings: settings({ folder: "日记" }),
    todos: {},
    todosUpdatedAt: 1,
  });
  check(
    Object.keys(JSON.parse(fresh)).join(",") ===
      "folder,dateFormat,todos,todosUpdatedAt,dailyTemplateEnabled,dailyTemplatePath,weeklyTemplateEnabled,weeklyTemplatePath",
    "新建文件按插件的键序排布",
    Object.keys(JSON.parse(fresh)).join(","),
  );

  // 坏文件：解析失败必须**拒绝写回**
  const brokenState = parseDailyConfig("{ 这不是 JSON");
  check(brokenState.broken === true, "无法解析时置 broken（不会拿默认值去覆盖用户文件）");
  check(parseDailyConfig("[1,2,3]").broken === true, "顶层是数组也算不合法");
  check(parseDailyConfig("null").broken === true, "顶层是 null 也算不合法");
  check(parseDailyConfig("").broken === true, "空文件算不合法");

  // 模板开关只认显式 true
  const loose = parseDailyConfig(JSON.stringify({ dailyTemplateEnabled: "true", weeklyTemplateEnabled: 1 }));
  check(
    loose.settings.dailyTemplateEnabled === false && loose.settings.weeklyTemplateEnabled === false,
    "模板开关只认真正的布尔 true（字符串 \"true\" 不该让模板突然生效）",
  );
  check(
    parseDailyConfig(JSON.stringify({ dailyTemplateEnabled: true })).settings.dailyTemplateEnabled === true,
    "显式 true 生效",
  );
  // dateFormat 被手改成空串
  check(
    parseDailyConfig(JSON.stringify({ dateFormat: "" })).settings.dateFormat === "",
    "空 dateFormat 原样读出（由 dateFormatOf 在生效处兜底，而不是在这里悄悄改掉用户的值）",
  );
}

console.log(failures === 0 ? "\n日记与日历逻辑验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

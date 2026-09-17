/**
 * 日记 / 周记的日期、命名、模板与日历计算。
 *
 * 全部是纯函数，不依赖 EditorView、React 或 Tauri，可直接在 Node 里断言
 * （`scripts/verify-daily.mjs`）。命名与打点规则必须与 Obsidian 插件
 * `quick-daily-note` 完全一致——两边共用同一个仓库，规则一旦分叉，
 * 插件创建的日记在 Quick Note 里就不算"当天有日记"，反之亦然。
 *
 * ## 为什么用 moment
 *
 * 库内配置 `quick-daily-note.json` 里的 `dateFormat` 是 **moment 格式串**，这份配置
 * 与插件共用。共用一份配置就必须共用同一个格式化引擎：手写一个"常用记号子集"
 * 在 `YYYY-MM-DD` 上看起来是对的，但用户把它改成 `YYYY年M月D日` 或 `YYYYMMDD` 时
 * 会静默生成插件找不到的文件名——那不是显示问题，是同一篇日记被劈成两处。
 *
 * ISO 周号同理：`2027-01-01` 属于 **2026-W53**（ISO 周号年与日历年不同）。这类跨年
 * 边界手写极易出错，而周记文件名写错一个数就等于丢一整周的记录。
 */

import moment from "moment";
import type { Moment } from "moment";

/** 库内状态文件。插件刻意不带前导点——Remotely Save 这类同步工具会跳过点开头的路径。 */
export const DAILY_CONFIG_FILE = "quick-daily-note.json";

export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";

export interface DailySettings {
  /** 日记存放目录（仓库内相对路径，空串表示仓库根）。 */
  folder: string;
  /** moment 日期格式串。它同时决定文件名里的日期写法与待办分桶的键。 */
  dateFormat: string;
  /** 创建日记时套用模板。 */
  dailyTemplateEnabled: boolean;
  /** 日记模板文件（仓库内相对路径）。 */
  dailyTemplatePath: string;
  /** 创建周记时套用模板。 */
  weeklyTemplateEnabled: boolean;
  weeklyTemplatePath: string;
  /**
   * 粘贴附件的保存目录（仓库内相对路径）。
   *
   * 与 Obsidian 插件共用同一个键（`pastedImageFolder`）、同一份文件：两边换用时这一项
   * 不用再手工设两次，同步一开多台设备自动一致。M1 时它放在本机 localStorage，M3 统一到这里
   * （本机那份仅在读取时作一次性迁移的来源，见 `settings.ts`）。
   */
  pastedImageFolder: string;
  /**
   * 粘贴代码时自动识别语言并生成代码块。
   *
   * 插件把它放在共享配置（非设备本机），这里保持同键同文件——两边对同一条粘贴
   * 的行为才会一致。
   */
  autoDetectCodeLang: boolean;
  /** 每天到点提醒「添加待办」。 */
  todoReminderEnabled: boolean;
  /** 提醒时间（HH:mm）。 */
  todoReminderTime: string;
  /** 每天到点检查当日未完成待办并提醒。 */
  checkReminderEnabled: boolean;
  /** 检查提醒时间（HH:mm）。 */
  checkReminderTime: string;
  /** 新建日记时抓取天气并写进正文。 */
  weatherEnabled: boolean;
  /** 天气查询的城市名（Open-Meteo 地理编码）。 */
  weatherCity: string;
}

export function defaultDailySettings(): DailySettings {
  return {
    folder: "",
    dateFormat: DEFAULT_DATE_FORMAT,
    dailyTemplateEnabled: false,
    dailyTemplatePath: "",
    weeklyTemplateEnabled: false,
    weeklyTemplatePath: "",
    pastedImageFolder: "attachments",
    autoDetectCodeLang: true,
    todoReminderEnabled: false,
    todoReminderTime: "08:00",
    checkReminderEnabled: false,
    checkReminderTime: "21:00",
    weatherEnabled: false,
    weatherCity: "",
  };
}

/**
 * 取出生效的日期格式串。
 *
 * 配置里的空串会让 moment 输出一个空字符串，文件名就变成 ` 名字.md`（前导空格，
 * 在 Windows 上还是个麻烦名字）。插件在设置面板里强制 `|| "YYYY-MM-DD"`，这里
 * 也要兜住——配置文件可能被手改，也可能来自更早的版本。
 */
export function dateFormatOf(format: string): string {
  return format.trim() || DEFAULT_DATE_FORMAT;
}

export function formatDate(day: Moment, format: string): string {
  return day.clone().format(format);
}

/** 今天（或任一时刻）在该格式下的日期串。 */
export function dateKey(day: Moment, settings: DailySettings): string {
  return formatDate(day, dateFormatOf(settings.dateFormat));
}

// ------------------------------------------------------------------ 命名

/**
 * 日记标题：**日期 + 一个空格 + 名字**。
 *
 * 名字必填（插件的创建弹窗不允许空名字），所以不存在"只有日期"的日记标题；
 * 但发现逻辑仍然接受 `2026-09-14.md` 这种没有名字的文件（用户手工建的）。
 */
export function dailyTitle(dateStr: string, name: string): string {
  return `${dateStr} ${name}`;
}

/** 周记标题固定为 `<ISO 周标识> 周记`，如 `2026-W37 周记`。 */
export function weeklyTitle(weekKey: string): string {
  return `${weekKey} 周记`;
}

/** 规范化目录写法：去掉首尾斜杠、折叠重复分隔符、反斜杠转正斜杠。 */
export function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

/** 把目录与文件名拼成仓库相对路径。 */
export function underFolder(folder: string, filename: string): string {
  const clean = normalizeFolder(folder);
  return clean ? `${clean}/${filename}` : filename;
}

export function dailyNotePath(settings: DailySettings, dateStr: string, name: string): string {
  return underFolder(settings.folder, `${dailyTitle(dateStr, name)}.md`);
}

export function weeklyNotePath(settings: DailySettings, weekKey: string): string {
  return underFolder(settings.folder, `${weeklyTitle(weekKey)}.md`);
}

// ------------------------------------------------------------------ ISO 周

/**
 * ISO 周标识，如 `2026-W37`。
 *
 * `GGGG` 是 **ISO 周号年**，不是日历年：`2027-01-01` 属于 `2026-W53`。
 * 用 `YYYY` 拼 `WW` 会在每年第一周和最后一周错一格。
 */
export function isoWeekKey(day: Moment): string {
  return day.clone().format("GGGG-[W]WW");
}

/** 日历 W 列显示的数字：去掉前导零（`07` → `7`）。 */
export function weekCellLabel(day: Moment): string {
  return day.clone().format("WW").replace(/^0/, "");
}

// ------------------------------------------------------------------ 发现

export function fileNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** 去掉 `.md` 扩展名的文件名（插件里叫 `basename`）。 */
export function baseNameOf(path: string): string {
  const name = fileNameOf(path);
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/** 周记的命名特征：`2026-W37` 或 `2026-W37 名字`。 */
export function isWeeklyName(basename: string): boolean {
  return /^\d{4}-W\d{2}(?: |$)/.test(basename);
}

/**
 * 日记目录**直接**子文件里的 `.md`（插件只看 `folder.children`，不递归）。
 *
 * 递归会把 `日记/2026/09-15.md` 之类也算成日记，打点与统计立刻就不对了。
 */
export function dailyFolderFiles(paths: string[], settings: DailySettings): string[] {
  const clean = normalizeFolder(settings.folder);
  return paths.filter((path) => {
    if (!path.toLowerCase().endsWith(".md")) return false;
    const slash = path.lastIndexOf("/");
    const parent = slash === -1 ? "" : path.slice(0, slash);
    return parent === clean;
  });
}

/** 某一天的日记（`日期.md` 或 `日期 名字.md` 前缀），按文件名排序。 */
export function dailyNotesOn(files: string[], dateStr: string): string[] {
  return files
    .filter((path) => {
      const name = fileNameOf(path);
      return name === `${dateStr}.md` || name.startsWith(`${dateStr} `);
    })
    .sort((a, b) => fileNameOf(a).localeCompare(fileNameOf(b)));
}

/** 某一天的日记里排序第一篇（插件的行为：多篇时打开名字排序第一篇）。 */
export function findDailyNote(files: string[], dateStr: string): string | null {
  return dailyNotesOn(files, dateStr)[0] ?? null;
}

export function weeklyNotesIn(files: string[], weekKey: string): string[] {
  return files
    .filter((path) => {
      const name = fileNameOf(path);
      return name === `${weekKey}.md` || name.startsWith(`${weekKey} `);
    })
    .sort((a, b) => fileNameOf(a).localeCompare(fileNameOf(b)));
}

export function findWeeklyNote(files: string[], weekKey: string): string | null {
  return weeklyNotesIn(files, weekKey)[0] ?? null;
}

/**
 * 「有日记的日期」集合，供日历打点与统计。
 *
 * 取文件名里第一个空格之前的部分作为日期串。**周记必须排除**：`2026-W37 周记`
 * 的第一个词是周标识，混进来会让打点与"本月天数"多算。
 *
 * 注意这里不做日期校验——`测试代码.md` 也会贡献一个 `测试代码` 键。这是刻意的
 * （与插件一致）：校验只发生在统计处（用严格解析），否则打点会漏掉用户手工建的
 * 非常规命名日记。
 */
export function diaryDateSet(files: string[]): Set<string> {
  const set = new Set<string>();
  for (const path of files) {
    const base = baseNameOf(path);
    if (isWeeklyName(base)) continue;
    const first = base.split(" ")[0];
    if (first) set.add(first);
  }
  return set;
}

/** 「有周记的周」集合，值为 `2026-W37` 这样的周标识。 */
export function weeklyKeySet(files: string[]): Set<string> {
  const set = new Set<string>();
  for (const path of files) {
    const matched = /^(\d{4}-W\d{2})(?: |$)/.exec(baseNameOf(path));
    if (matched?.[1]) set.add(matched[1]);
  }
  return set;
}

// ------------------------------------------------------------------ 模板

export interface TemplateVars {
  /** 笔记标题（不含 `.md`），也是 `{{title}}` 的值。 */
  title: string;
  /** `{{date}}` / `{{date:格式}}` 用的日期。日记是当天，周记是该周**周一**。 */
  dateMoment: Moment;
  /** ISO 周标识。日记不传，`{{week}}` 于是展开成空串（与插件一致）。 */
  week?: string;
  /** `{{time}}` 用的时间，默认取当前时刻。 */
  now?: Moment;
}

/**
 * 展开模板里的占位符。
 *
 * 支持 `{{title}}`、`{{date}}`、`{{date:格式}}`、`{{week}}`、`{{time}}`。
 * 替换顺序是刻意的（与插件一致）：`{{title}}` 最先，所以标题里若含 `{{date}}`
 * 字样，它也会被后续步骤展开。
 *
 * **未知占位符原样保留**，不做兜底清理——留在文件里才能被用户看见，
 * 悄悄清掉反而像是"模板没生效"。
 *
 * 与插件的一处差异：这里一律用**函数替换**。`String.replace` 的字符串替换里
 * `$&`、`$1`、`$$` 有特殊含义，日记名字里一旦出现这些字符（如 `成本$&收益`）
 * 就会把模板内容改坏。插件那版是字符串替换，属于它的一个漏洞；这里不复制它。
 */
export function expandTemplate(content: string, vars: TemplateVars, format: string): string {
  const time = formatDate(vars.now ?? moment(), "HH:mm");
  return content
    .replace(/\{\{title\}\}/g, () => vars.title)
    .replace(/\{\{date:([^}]*)\}\}/g, (_match, fmt: string) => formatDate(vars.dateMoment, fmt))
    .replace(/\{\{date\}\}/g, () => formatDate(vars.dateMoment, format))
    .replace(/\{\{week\}\}/g, () => vars.week ?? "")
    .replace(/\{\{time\}\}/g, () => time);
}

/** 没有模板时的默认内容：一级标题 + 换行（与插件逐字节一致）。 */
export function defaultNoteContent(title: string): string {
  return `# ${title}\n`;
}

/**
 * 校验日记/周记的名字，返回 `null` 表示合法。
 *
 * 名字会直接拼进文件名，所以这几条必须挡住——每一条都有具体的失败表现：
 *
 * - **含 `/`**：会被拼成一个子目录（`日记/2026-09-15 子/名字.md`）。而日记的发现只看
 *   目录的**直接**子文件，于是这篇日记在日历上既不打点、也算不进字数，用户看到的是
 *   "明明建了却没反应"。
 * - **点开头**：仓库枚举会把它当成隐藏项跳过（`.trash` 就是靠这条躲开文件树与索引的），
 *   文件在资源管理器里存在，在应用里永远不出现。
 * - **Windows 禁用字符**：写盘会直接失败，错误信息来自系统调用，读起来与"名字打错了"
 *   没有关系。
 */
export function validateDailyName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名字不能为空";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "名字里不能有路径分隔符";
  if (trimmed.startsWith(".")) return "名字不能以点开头（会被当成隐藏文件）";
  if (/[<>:"|?*]/.test(trimmed)) return '名字里不能有 < > : " | ? * 这些字符';
  return null;
}

/**
 * 用配置里的格式**严格**解析日期串；解析不出来时退回 `fallback`（默认当前时间）。
 *
 * 严格模式（第三个参数 `true`）是必需的：宽松模式会把 `2026-09-14 日记` 里的
 * `2026` 也当成合法输入，于是模板里的 `{{date}}` 悄悄变成另一个日子。
 * 插件同样用严格模式，回调也是同样的行为。
 */
export function parseDateStrict(value: string, format: string, fallback?: Moment): Moment {
  const parsed = moment(value, format, true);
  if (parsed.isValid()) return parsed;
  return (fallback ?? moment()).clone();
}

// ------------------------------------------------------------------ 日历

export interface CalendarDay {
  /** 该格的日期（克隆出来的，调用方可以安全修改）。 */
  date: Moment;
  /** 按 dateFormat 格式化后的日期串，用于与文件名比较。 */
  key: string;
  /** 属于当前显示的月份（否则是上/下月补格）。 */
  inMonth: boolean;
  isToday: boolean;
}

export interface CalendarRow {
  /** 该行的 ISO 周标识，如 `2026-W37`。 */
  weekKey: string;
  /** W 列显示的数字（去前导零）。 */
  weekLabel: string;
  /** 该行周一的日期串，周记模板的 `{{date}}` 用它。 */
  mondayKey: string;
  days: CalendarDay[];
}

/** 日历固定 6 行：切换月份时网格高度不跳动。 */
export const CALENDAR_ROWS = 6;

/**
 * 月历网格：从该月 1 号所在周的**周一**开始，连续 6 周 × 7 天。
 *
 * 首日固定为周一（ISO 周），不提供设置项——周记按 ISO 周记，两者必须一致，
 * 否则日历上 W 列的数字与那一行的实际日期对不上。
 */
export function monthGrid(viewMonth: Moment, format: string, todayKey: string): CalendarRow[] {
  const start = viewMonth.clone().startOf("month").startOf("isoWeek");
  const monthKey = viewMonth.clone().format("YYYY-MM");
  const rows: CalendarRow[] = [];

  for (let row = 0; row < CALENDAR_ROWS; row += 1) {
    const monday = start.clone().add(row * 7, "day");
    const days: CalendarDay[] = [];
    for (let col = 0; col < 7; col += 1) {
      const date = monday.clone().add(col, "day");
      const key = formatDate(date, format);
      days.push({
        date,
        key,
        inMonth: date.clone().format("YYYY-MM") === monthKey,
        isToday: key === todayKey,
      });
    }
    rows.push({
      weekKey: isoWeekKey(monday),
      weekLabel: weekCellLabel(monday),
      mondayKey: formatDate(monday, format),
      days,
    });
  }

  return rows;
}

/** 日历标题，如 `2026年9月`。 */
export function monthTitle(viewMonth: Moment): string {
  return viewMonth.clone().format("YYYY年M月");
}

// ------------------------------------------------------------------ 统计

/**
 * 本月写日记的天数。
 *
 * 用严格解析过滤"看起来像日期"的文件名：库里真实存在 `日记/测试代码.md`
 * 这类文件，它的日期键是 `测试代码`，宽松解析会把它算进某一天。
 */
export function monthDiaryCount(
  dateSet: Set<string>,
  format: string,
  viewMonth: Moment,
): number {
  const monthKey = viewMonth.clone().format("YYYY-MM");
  let count = 0;
  for (const value of dateSet) {
    const day = moment(value, format, true);
    if (day.isValid() && day.format("YYYY-MM") === monthKey) count += 1;
  }
  return count;
}

/**
 * 连续写日记的天数：从今天往回数，遇到第一个没有日记的日子就停。
 *
 * 因此"今天还没写"就是 0，哪怕之前连续写了很久——这是插件的口径，
 * 也符合"连续"这个词的直觉（断了就是断了）。
 *
 * `limit` 是防御性的上界：日期集合若被异常数据填满（例如某个脚本生成了
 * 几千年的日期串），没有上界就是一个死循环。
 */
export function streakDays(
  dateSet: Set<string>,
  format: string,
  today: Moment,
  limit = 730,
): number {
  let streak = 0;
  const cursor = today.clone();
  for (let guard = 0; guard < limit; guard += 1) {
    if (!dateSet.has(formatDate(cursor, format))) break;
    streak += 1;
    cursor.subtract(1, "day");
  }
  return streak;
}

/**
 * 字数口径：**去掉所有空白字符后的长度**，与插件完全一致。
 *
 * 这个口径不少见但要清楚它的含义：CJK 一字算一个，拉丁文按**字母**算（不是单词），
 * 标点计入，emoji 这类星平面字符算 2（JS 的 `length` 是 UTF-16 码元数）。
 * 换成"按词计数"会让同一个数字在两边显示成不同的值，那比口径粗糙更难受。
 */
export function wordCount(content: string): number {
  return content.replace(/\s+/g, "").length;
}

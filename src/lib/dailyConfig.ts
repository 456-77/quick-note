/**
 * 库内配置 `quick-daily-note.json` 的解析与写回（纯函数，可在 Node 里断言）。
 *
 * ## 这份文件不是 Quick Note 的私有配置
 *
 * 它由 Obsidian 插件 `quick-daily-note` 创建并维护，里面有大量 Quick Note 不认识的键：
 * `emailAccessKey`、天气、背景、提醒时间、各种开关。所以：
 *
 * - 解析时保留原对象的**全部键与键序**（`JSON.parse` 保序，字符串键按插入顺序）；
 * - 写回时**只动我们管的那几个键**，其余原样序列化。
 *
 * 反例（也就是不能采用的做法）：把配置建成一个 TS 对象再整份写回。那样用户插件里
 * 的邮箱 access key、背景设置、提醒开关会在某次 Quick Note 改日记目录时被静默清空。
 * 这不是理论风险——`Object.assign({}, DEFAULT_SETTINGS, ...)` 这种写法在这个项目里
 * 已经踩过一次（插件侧 `sync.ts` 的浅拷贝共享默认 Map）。
 *
 * 序列化用 `JSON.stringify(obj, null, 2)`，与插件逐字节一致（**没有尾随换行**）。
 */

import { normalizeTodos, type TodoMap } from "./todos.ts";
import { defaultDailySettings, type DailySettings } from "./daily.ts";

export interface DailyConfigState {
  /**
   * 原始对象，但**已被规整**：`todos` 换成规范化后的映射，`todosUpdatedAt` 归一成数字。
   *
   * 这样定义是为了让 `raw` 成为"我们理解的这份文件的规整形式"：序列化时不必再区分
   * `update` 里有没有 todos，内存状态与将要写出的内容始终一致。
   * 反例是让 raw 保持解析原样——那样"只改了日记目录"的一次写回会把未升级的旧待办
   * 原封不动留在文件里，而界面上显示的是升级后的版本，两边从此悄悄分叉。
   */
  raw: Record<string, unknown> | null;
  settings: DailySettings;
  todos: TodoMap;
  /**
   * 待办最后修改时间。**同步快照的 `updatedAt` 用它**：内容必须稳定，否则快照哈希
   * 每轮都变，本机会不停地推送、并把别的设备更新的数据压掉。
   */
  todosUpdatedAt: number;
  /** 文件存在但不是一个合法的 JSON 对象：此时**禁止写回**（见下）。 */
  broken: boolean;
  /** 旧格式待办被补齐的条数（仅用于提示）。 */
  repaired: number;
}

/** 写回时允许改动的键，其余一概不碰。 */
const OWNED_KEYS = [
  "folder",
  "dateFormat",
  "todos",
  "todosUpdatedAt",
  "dailyTemplateEnabled",
  "dailyTemplatePath",
  "weeklyTemplateEnabled",
  "weeklyTemplatePath",
  // 粘贴附件目录：插件与 Quick Note 各写各的，两边换用就要设两次。
  // M3 统一到库内配置（与插件同一个键名），同步一开，两边自动一致。
  "pastedImageFolder",
  // M4：粘贴语言识别、定时提醒、天气。插件把这些键也放在这份共享文件里
  // （只有背景设置是每设备独立的），所以这里保持同键同文件。
  "autoDetectCodeLang",
  "todoReminderEnabled",
  "todoReminderTime",
  "checkReminderEnabled",
  "checkReminderTime",
  "weatherEnabled",
  "weatherCity",
] as const;

function readText(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

/** 时间键兜底：非法/缺失时回默认值，"HH:mm" 的字典序比较才不会错格。 */
function readTime(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = readText(raw, key);
  return value && /^\d{2}:\d{2}$/.test(value) ? value : fallback;
}

function settingsFrom(raw: Record<string, unknown>): DailySettings {
  const defaults = defaultDailySettings();
  const text = (key: string) => readText(raw, key);
  return {
    folder: text("folder") ?? defaults.folder,
    dateFormat: text("dateFormat") ?? defaults.dateFormat,
    // 只有显式 true 才算启用：配置文件里写 "true"（字符串）或 1 都不该让模板生效，
    // 一个"意外套用模板"会在用户没预期的时候写进一堆模板文字。
    dailyTemplateEnabled: raw.dailyTemplateEnabled === true,
    dailyTemplatePath: text("dailyTemplatePath") ?? defaults.dailyTemplatePath,
    weeklyTemplateEnabled: raw.weeklyTemplateEnabled === true,
    weeklyTemplatePath: text("weeklyTemplatePath") ?? defaults.weeklyTemplatePath,
    pastedImageFolder: text("pastedImageFolder") ?? defaults.pastedImageFolder,
    autoDetectCodeLang: raw.autoDetectCodeLang !== false,
    todoReminderEnabled: raw.todoReminderEnabled === true,
    todoReminderTime: readTime(raw, "todoReminderTime", defaults.todoReminderTime),
    checkReminderEnabled: raw.checkReminderEnabled === true,
    checkReminderTime: readTime(raw, "checkReminderTime", defaults.checkReminderTime),
    weatherEnabled: raw.weatherEnabled === true,
    weatherCity: text("weatherCity") ?? defaults.weatherCity,
  };
}

/**
 * 解析库内配置。
 *
 * `content` 为 `null` 表示文件不存在（首次使用）——那不是错误，按默认值走，
 * 等用户真的改了设置再创建文件。打开仓库就凭空造一个配置文件出来，会让同步
 * 多出一份"谁都没改过"的差异。
 *
 * 解析失败（不是合法 JSON、或不是一个对象）时把 `broken` 置位：**此时拒绝写回**。
 * 理由很直接——我们读不懂这份文件，就无从知道里面有什么，写回去等于把用户的插件
 * 配置整体覆盖掉。宁可提示"配置无法解析、本次修改不会保存"。
 */
export function parseDailyConfig(content: string | null): DailyConfigState {
  const empty: DailyConfigState = {
    raw: null,
    settings: defaultDailySettings(),
    todos: {},
    todosUpdatedAt: 0,
    broken: false,
    repaired: 0,
  };
  if (content === null) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ...empty, broken: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...empty, broken: true };
  }

  const raw: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  const fallbackAt = typeof raw.todosUpdatedAt === "number" ? raw.todosUpdatedAt : 0;
  const { todos, repaired } = normalizeTodos(raw.todos, fallbackAt);
  raw.todos = todos;
  raw.todosUpdatedAt = fallbackAt;
  return {
    raw,
    settings: settingsFrom(raw),
    todos,
    todosUpdatedAt: fallbackAt,
    broken: false,
    repaired,
  };
}

export interface DailyConfigUpdate {
  settings?: DailySettings;
  todos?: TodoMap;
  /**
   * 待办最后修改时间。
   *
   * 只在待办真的变了时才更新。同步快照的内容由它生成——每轮都刷成当前时间，
   * 快照的哈希就会每轮都变，于是本机会不停地推送、并把别的设备更新的数据压掉。
   * 这条同样是插件里踩过之后的结论。
   */
  todosUpdatedAt?: number;
}

/**
 * 生成写回用的 JSON 文本。
 *
 * 只写 `update` 里给出的字段，其余键原样保留。
 *
 * 键序上有个刻意的区分：**已有文件就地替换**（同名键保持原位置，新增键追加到末尾），
 * 只有**新建文件**才按插件的键序排布。重排已有文件的键序，会让整份文件在 diff 里
 * 全变，也会让同步看到一次毫无必要的大改动。
 */
export function serializeDailyConfig(state: DailyConfigState, update: DailyConfigUpdate): string {
  const values: Record<string, unknown> = {};
  const settings = update.settings;
  if (settings) {
    values.folder = settings.folder;
    values.dateFormat = settings.dateFormat;
    values.dailyTemplateEnabled = settings.dailyTemplateEnabled;
    values.dailyTemplatePath = settings.dailyTemplatePath;
    values.weeklyTemplateEnabled = settings.weeklyTemplateEnabled;
    values.weeklyTemplatePath = settings.weeklyTemplatePath;
    values.pastedImageFolder = settings.pastedImageFolder;
    values.autoDetectCodeLang = settings.autoDetectCodeLang;
    values.todoReminderEnabled = settings.todoReminderEnabled;
    values.todoReminderTime = settings.todoReminderTime;
    values.checkReminderEnabled = settings.checkReminderEnabled;
    values.checkReminderTime = settings.checkReminderTime;
    values.weatherEnabled = settings.weatherEnabled;
    values.weatherCity = settings.weatherCity;
  }
  if (update.todos) values.todos = update.todos;
  if (typeof update.todosUpdatedAt === "number") values.todosUpdatedAt = update.todosUpdatedAt;

  const raw: Record<string, unknown> = {};
  if (state.raw) {
    for (const [key, value] of Object.entries(state.raw)) raw[key] = value;
    for (const [key, value] of Object.entries(values)) raw[key] = value;
  } else {
    for (const key of OWNED_KEYS) {
      if (key in values) raw[key] = values[key];
    }
  }

  return JSON.stringify(raw, null, 2);
}

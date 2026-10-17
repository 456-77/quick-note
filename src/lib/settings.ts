/**
 * 应用设置，存在 localStorage。
 *
 * 为什么用「模块级可变对象 + 订阅」而不是纯 React 状态：粘贴处理发生在 CodeMirror 的
 * 事件回调里，拿不到 React 的 props，它需要一个"总是读到最新值"的入口。
 */

import type { ThemeMode } from "./theme.ts";

export interface Settings {
  /**
   * 附件保存目录（仓库内相对路径）。
   *
   * **已废弃**：M3 起它统一到库内配置的 `pastedImageFolder`（与 Obsidian 插件共用同一个
   * 键、同一份文件），两边换用不用设两次，同步一开多台设备自动一致。字段保留只为让
   * 旧 localStorage 里已有的自定义值能被一次性迁移（见 {@link migrateLegacyFolder}），
   * 迁移后不再读取。
   */
  attachmentFolder?: string;
  /** 插入链接的写法。 */
  linkFormat: "wiki" | "markdown";
  /** 粘贴图片/文件时是否保存为附件。 */
  savePastedAttachments: boolean;
  /** 界面主题。默认跟随系统。 */
  theme: ThemeMode;
  /**
   * 从文件树/搜索打开一篇**未打开过**的笔记时的行为：
   * - `replace`（默认，Obsidian 同款）：替换当前标签的内容，标签数不增长；
   * - `newTab`：每次都新开一个标签（多标签并存）。
   * 已打开过的笔记永远切回已有标签，两种模式一致。
   */
  openNoteMode: "replace" | "newTab";
  /** 编辑器是否显示行号数字（默认关：笔记不是代码）。 */
  showLineNumbers: boolean;
  /**
   * 新建笔记时写入 `# 文件名` 一级标题；重命名笔记/日记时把正文
   * **第一个一级标题**同步改成新名字。重命名只改已存在的 `# 标题` 行，不会凭空补标题。
   */
  syncRenameHeading: boolean;
  /**
   * 快速笔记（收件箱）：不切换仓库的速记落点。
   * vault 为绝对路径，空串 = 未配置（快捷键会提示先去设置里选）。
   * file 是收件仓库内的相对路径，支持 `{{date}}` 占位（按日记文件名一样落一天一篇）。
   */
  quickCaptureVault: string;
  quickCaptureFile: string;
  /** 新建笔记时自动打上的标签（标签仪表盘里集中整理）；空串 = 不打。 */
  autoTagNewNote: boolean;
  autoTagName: string;
  /**
   * 全局截图快捷键（OS 级，应用不在前台也响应；0.20 用户需求）。
   * 格式 `Ctrl+Alt+G` 这类；空串 = 关闭。截图后在弹窗里框选区域、识别文字或存进笔记。
   * 默认避开 Ctrl+Alt+A/Q（微信/QQ 截图的常见占用）。
   */
  screenshotHotkey: string;
  /**
   * Markdown 渲染风格：
   * - `default`：内置的深色高级观感；
   * - `blueTopaz`：Blue Topaz 同源的渲染观感（彩色标题、tint 表头、重 callout）。
   */
  renderStyle: "default" | "blueTopaz";
  /**
   * 导出落点（仓库内相对路径）：导出 PDF / mermaid 图片默认保存到这个目录，
   * 保存对话框也会预填它。空串 = 仓库根。
   */
  exportFolder: string;
  /**
   * 打开其他仓库（含点击最近仓库列表）时的行为：
   * - `ask`（默认）：每次弹窗问「当前窗口打开还是新窗口」；
   * - `current`：总是当前窗口替换（Obsidian 式）；
   * - `newWindow`：总是另起一个应用窗口打开新仓库。
   * 选择弹窗里勾「记住选择」即写入这里；设置页可随时改回。
   */
  vaultOpenMode: "ask" | "current" | "newWindow";
  /**
   * 全局搜索（Ctrl+K）的内容结果悬停时显示笔记上下文预览卡（0.21 用户反馈，
   * 可关）。跳转定位的关键词高亮不受此开关影响。
   */
  searchHoverPreview: boolean;
  /**
   * 搜索命中高亮的颜色（0.26 用户反馈"高亮颜色可以在设置中进行设置"）。
   * #RRGGBB；文件内搜索面板（cm-searchMatch）、渲染表格内的命中、全局搜索
   * 跳转高亮都从 CSS 变量 --qn-hit 取色。默认红（0.23 用户指定的醒目红）。
   */
  searchHitColor: string;
  // ---- 全局背景 ----
  // 归属演变（0.26 用户反馈"不同仓库为什么公用同一套背景图"）：背景图改为
  // **每仓库一份**（键是仓库绝对路径），仍存本机、不进仓库、不随同步走——
  // 图是从当前仓库里选的，换仓库连图带参数一起换才符合直觉。
  // 下面的扁平 bg* 字段是 0.25 及以前的旧存储：不再直接读写，作为还没有
  // per-vault 条目的仓库的**种子值**（升级后各仓库仍显示原来的背景，改哪篇
  // 哪篇开始分叉），某个仓库第一次调整背景时即落下自己的条目。

  /** 启用全局背景图片。 */
  bgEnabled: boolean;
  /** 背景图片路径（仓库内相对路径）。 */
  bgImagePath: string;
  /** 不透明度 0–1。 */
  bgOpacity: number;
  /** 模糊半径（px）。 */
  bgBlur: number;
  /** 亮度（%）。 */
  bgBrightness: number;
  /** 对比度（%）。 */
  bgContrast: number;
  /** 水平位置（%）。 */
  bgPosX: number;
  /** 垂直位置（%）。 */
  bgPosY: number;
  /** 缩放（%，100 = 原始大小，配合 cover/contain 使用）。 */
  bgScale: number;
  /** 适配方式：cover = 铺满裁剪，contain = 完整显示。 */
  bgFit: "cover" | "contain";
  /** per-vault 背景设置（键：仓库绝对路径）。没有条目的仓库用扁平字段的旧值兜底。 */
  bgPerVault?: Record<string, BgSettings>;
}

/** 背景图的全部可调参数（扁平 bg* 字段与 per-vault 条目共用同一形状）。 */
export type BgSettings = Pick<
  Settings,
  | "bgEnabled"
  | "bgImagePath"
  | "bgOpacity"
  | "bgBlur"
  | "bgBrightness"
  | "bgContrast"
  | "bgPosX"
  | "bgPosY"
  | "bgScale"
  | "bgFit"
>;

const STORAGE_KEY = "quicknote.settings";

const DEFAULTS: Settings = {
  // 默认 wiki：Obsidian 开启 wikilink 时（默认）粘贴图片写的就是 ![[图.png]]
  linkFormat: "wiki",
  savePastedAttachments: true,
  // 默认深色：这套界面按"深色高级"设计（浅色仍可在设置里切换/跟随系统）
  theme: "dark",
  // 默认 Obsidian 式：打开笔记替换当前标签；要并存才切 newTab
  openNoteMode: "replace",
  showLineNumbers: false,
  syncRenameHeading: true,
  quickCaptureVault: "",
  quickCaptureFile: "Inbox.md",
  autoTagNewNote: true,
  autoTagName: "待整理",
  screenshotHotkey: "Ctrl+Alt+G",
  renderStyle: "default",
  exportFolder: "导出",
  vaultOpenMode: "ask",
  searchHoverPreview: true,
  searchHitColor: "#ff5252",
  bgEnabled: false,
  bgImagePath: "",
  bgOpacity: 0.35,
  bgBlur: 0,
  bgBrightness: 100,
  bgContrast: 100,
  bgPosX: 50,
  bgPosY: 50,
  bgScale: 100,
  bgFit: "cover",
};

function load(): Settings {
  // 单测环境没有 localStorage，直接给默认值
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

let current: Settings = load();
const listeners = new Set<(settings: Settings) => void>();

export function getSettings(): Settings {
  return current;
}

/**
 * 取出旧版存在本机的附件目录（若有），供打开仓库时一次性迁入库内配置。
 *
 * 迁移的条件是"用户真的改过"（不是默认值 `attachments`）：默认值没必要写盘——
 * 库内配置读不出这个键时就按同一个默认值走。迁移是**只读**的：写入库内由
 * useDaily 的正常设置通道完成，这里不碰仓库。
 */
export function takeLegacyAttachmentFolder(): string | null {
  const value = current.attachmentFolder;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "attachments") return null;
  return trimmed;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch };
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  }
  for (const listener of listeners) listener(current);
  return current;
}

export function onSettingsChange(listener: (settings: Settings) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 背景参数的默认值（扁平 DEFAULTS 里 bg* 部分的同源副本）。 */
export function defaultBgSettings(): BgSettings {
  const { bgEnabled, bgImagePath, bgOpacity, bgBlur, bgBrightness, bgContrast, bgPosX, bgPosY, bgScale, bgFit } =
    DEFAULTS;
  return { bgEnabled, bgImagePath, bgOpacity, bgBlur, bgBrightness, bgContrast, bgPosX, bgPosY, bgScale, bgFit };
}

/**
 * 当前生效的背景参数：优先取该仓库自己的 per-vault 条目；没有条目的仓库
 * 用旧扁平字段兜底（升级无感，见 bgPerVault 注释），连旧值都没有（全新安装）
 * 就是纯默认。仓库没开时给默认值——背景图本来就是仓库内图片，没仓库必然没有。
 */
export function bgSettingsFor(vault: string | null, settings: Settings = current): BgSettings {
  if (vault && settings.bgPerVault?.[vault]) return { ...settings.bgPerVault[vault] };
  const legacy: BgSettings = {
    bgEnabled: settings.bgEnabled,
    bgImagePath: settings.bgImagePath,
    bgOpacity: settings.bgOpacity,
    bgBlur: settings.bgBlur,
    bgBrightness: settings.bgBrightness,
    bgContrast: settings.bgContrast,
    bgPosX: settings.bgPosX,
    bgPosY: settings.bgPosY,
    bgScale: settings.bgScale,
    bgFit: settings.bgFit,
  };
  // 全新安装（旧字段全是默认值且没图）与旧值无差别，统一走旧值兜底即可
  return legacy;
}

/** 把一批改动落进指定仓库的 per-vault 条目（以生效值为基底合并）。返回新 Settings。 */
export function updateBgSettings(vault: string | null, patch: Partial<BgSettings>): Settings {
  if (!vault) return current;
  const merged: BgSettings = { ...bgSettingsFor(vault), ...patch };
  return updateSettings({
    bgPerVault: { ...(current.bgPerVault ?? {}), [vault]: merged },
  });
}

// 跨窗口热加载（0.23 用户反馈）：每个仓库窗口是独立进程，另一窗口改设置只写了
// localStorage，本窗口的内存副本不会自己变——截图快捷键因此出现"两个窗口各持
// 一个组合"的冲突。storage 事件只在**别的**窗口触发，正好用来把新值拉进来。
// 同一窗口自己的写入不触发 storage 事件，不会形成回环。
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const previous = JSON.stringify(current);
    current = load();
    if (JSON.stringify(current) === previous) return;
    for (const listener of listeners) listener(current);
  });
}

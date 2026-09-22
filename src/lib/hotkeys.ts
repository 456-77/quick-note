/**
 * 可重绑定的全局快捷键（Obsidian「设置 → 快捷键」同思路）。
 *
 * 结构：一份**命令清单**（id + 中文名 + 默认键位）+ 一份**用户覆盖**（localStorage，
 * 本机偏好不进仓库）。匹配器把 KeyboardEvent 归一成 `Mod-Shift-B` 这样的组合串再比对，
 * Mod 在 Windows/Linux 是 Ctrl、macOS 是 Cmd——同一份配置跨平台语义一致。
 *
 * 设置面板的「捕获下一次按键」会临时挂起全局匹配（{@link isCapturing}），
 * 否则按 Ctrl+B 重绑时文件栏会先被切一下。编辑器内部的键位（Tab 跳格、Ctrl+S 保存）
 * 不在本模块管辖内——那些属于 CodeMirror 的 keymap，与此互不干扰。
 */

/** 快捷键的功能分组（设置页按此分组展示；空组不显示）。 */
export type HotkeyGroupId = "edit" | "file" | "markdown" | "nav" | "view" | "misc";

export const HOTKEY_GROUPS: { id: HotkeyGroupId; label: string }[] = [
  { id: "edit", label: "编辑" },
  { id: "file", label: "文件" },
  { id: "markdown", label: "Markdown" },
  { id: "nav", label: "导航" },
  { id: "view", label: "视图" },
  { id: "misc", label: "其他" },
];

export interface CommandKeys {
  id: string;
  /** 短名称（列表主文案，保持单行）。 */
  label: string;
  /** 辅助说明（名称下方弱化展示；完整说明也可 tooltip 查看）。 */
  desc?: string;
  group: HotkeyGroupId;
  /** 默认键位，`Mod-K` 形式；空数组 = 默认没有快捷键（仍可自定义绑定）。 */
  keys: string[];
}

/** 支持重绑定的命令清单。顺序即设置面板里的展示顺序。 */
export const COMMAND_KEYS: CommandKeys[] = [
  { id: "save", label: "保存当前笔记", desc: "立即落盘一次（平时自动保存）", group: "edit", keys: ["Mod-S"] },
  { id: "newNote", label: "新建笔记", desc: "可写 子目录/名称", group: "edit", keys: ["Mod-N"] },
  { id: "newDiary", label: "新建今日日记", desc: "按日期命名，落到日记目录", group: "edit", keys: [] },
  { id: "newFolder", label: "新建文件夹", group: "edit", keys: [] },
  { id: "toggleInlineCode", label: "切换行内代码", desc: "选中则包裹，再按取消", group: "edit", keys: ["Mod-`"] },
  { id: "toggleCodeBlock", label: "切换代码块", desc: "围栏包裹选区或插入空块", group: "edit", keys: ["Mod-Shift-`"] },
  { id: "toggleBulletList", label: "切换无序列表", desc: "选中多行整体加/去「- 」标记", group: "markdown", keys: ["Mod-Shift-8"] },
  { id: "toggleNumberList", label: "切换有序列表", desc: "选中多行整体加/去「1. 」序号", group: "markdown", keys: ["Mod-Shift-9"] },
  { id: "openVaultPicker", label: "打开其他仓库…", group: "file", keys: [] },
  { id: "heading1", label: "标题 1", desc: "在光标行切换标题级别，再按取消", group: "markdown", keys: ["Mod-1"] },
  { id: "heading2", label: "标题 2", desc: "在光标行切换标题级别，再按取消", group: "markdown", keys: ["Mod-2"] },
  { id: "heading3", label: "标题 3", desc: "在光标行切换标题级别，再按取消", group: "markdown", keys: ["Mod-3"] },
  { id: "heading4", label: "标题 4", desc: "在光标行切换标题级别，再按取消", group: "markdown", keys: ["Mod-4"] },
  { id: "heading5", label: "标题 5", desc: "在光标行切换标题级别，再按取消", group: "markdown", keys: ["Mod-5"] },
  { id: "heading6", label: "标题 6", desc: "在光标行切换标题级别，再按取消", group: "markdown", keys: ["Mod-6"] },
  { id: "palette", label: "命令面板 / 全局搜索", desc: "搜索笔记、全文或执行命令", group: "nav", keys: ["Mod-K", "Mod-P"] },
  { id: "toggleLeft", label: "收起 / 展开文件栏", group: "nav", keys: ["Mod-B"] },
  { id: "toggleRight", label: "收起 / 展开右侧面板", group: "nav", keys: ["Mod-Shift-B"] },
  { id: "zen", label: "专注模式", desc: "隐藏两侧栏与状态栏", group: "nav", keys: ["Mod-Shift-F"] },
  { id: "toggleMode", label: "切换实时 / 源码", group: "view", keys: ["Mod-E"] },
  { id: "openSettings", label: "打开设置", group: "misc", keys: ["Mod-,"] },
  { id: "syncNow", label: "立即同步", group: "misc", keys: [] },
];

const STORAGE_KEY = "quicknote.hotkeys";

type Overrides = Record<string, string[]>;

function loadOverrides(): Overrides {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Overrides) : {};
  } catch {
    return {};
  }
}

let overrides: Overrides = loadOverrides();
const listeners = new Set<() => void>();

/** 命令当前生效的键位（默认 + 覆盖）。 */
export function bindingFor(id: string): string[] {
  const override = overrides[id];
  if (override) return override;
  return COMMAND_KEYS.find((cmd) => cmd.id === id)?.keys ?? [];
}

/** 全部命令与当前键位（面板渲染用，返回新数组，可直接当 state 用）。 */
export function allBindings(): CommandKeys[] {
  return COMMAND_KEYS.map((cmd) => ({ ...cmd, keys: bindingFor(cmd.id) }));
}

/** 写入一条覆盖；传 null/空数组恢复默认。没有覆盖时清掉存储键。 */
export function setBinding(id: string, keys: string[] | null): void {
  const def = COMMAND_KEYS.find((cmd) => cmd.id === id);
  if (!def) return;
  if (!keys || keys.length === 0 || keys.join(",") === def.keys.join(",")) {
    delete overrides[id];
  } else {
    overrides[id] = keys;
  }
  if (typeof localStorage !== "undefined") {
    try {
      if (Object.keys(overrides).length === 0) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      // 存不进去只影响下次启动的绑定，本次会话照常生效
    }
  }
  for (const listener of listeners) listener();
}

export function onHotkeysChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 把 event.key 归一成组合串里的键名：字母统一大写，其余保留专名。 */
function keyName(key: string): string {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (key === " ") return "Space";
  if (key === "Escape") return "Esc";
  return key;
}

/** 从键盘事件算出与键位串同口径的组合（`Mod-Shift-B`）。 */
export function comboOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(keyName(event.key));
  return parts.join("-");
}

/**
 * 用 `event.code` 归一的组合串；无法归一时返回 null。
 *
 * Shift 会改写 `event.key`（Shift+反引号是 `~`、Shift+8 是 `*`），按 key 匹配会让
 * 「切换代码块」的 `Mod-Shift-\``、「切换无序列表」的 `Mod-Shift-8` 永远打不中。
 * code（物理键位）与键盘布局无关，捕获与匹配两侧都要用它兜底。
 */
const CODE_KEY_NAMES: Record<string, string> = {
  Backquote: "`",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Digit0: "0",
  Minus: "-",
  Equal: "=",
};

export function comboOfCode(event: KeyboardEvent): string | null {
  const name = CODE_KEY_NAMES[event.code];
  if (!name) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(name);
  return parts.join("-");
}

// ---------------------------------------------------------------- 捕获模式

let capturing = false;

/** 设置面板正在「捕获下一次按键」时，全局快捷键必须让路。 */
export function isCapturing(): boolean {
  return capturing;
}

export function setCapturing(value: boolean): void {
  capturing = value;
}

// ---------------------------------------------------------------- 匹配与显示

/** 命中键位的命令；没有绑定或正在捕获时返回 null。 */
export function matchCommand(
  event: KeyboardEvent,
  commands: readonly CommandKeys[] = allBindings(),
): CommandKeys | null {
  if (capturing) return null;
  const combo = comboOf(event);
  return commands.find((cmd) => cmd.keys.includes(combo)) ?? null;
}

export function resetAllBindings(): void {
  overrides = {};
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 同 setBinding：清不掉只影响下次启动
    }
  }
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------- 导入 / 导出

/** 导出当前自定义键位为 JSON 文本（只含用户改动；恢复默认的键不占条目）。 */
export function exportBindings(): string {
  return JSON.stringify({ version: 1, bindings: loadOverrides() }, null, 2);
}

/**
 * 从 JSON 文本导入键位覆盖，返回导入的条数。
 * 无法解析、条目指向不存在的命令、键位值不是字符串数组时抛错（调用方提示）。
 */
export function importBindings(text: string): number {
  const parsed: unknown = JSON.parse(text);
  const record =
    parsed && typeof parsed === "object" && "bindings" in parsed
      ? (parsed as { bindings: unknown }).bindings
      : parsed;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("文件里没有键位配置");
  }
  const known = new Set(COMMAND_KEYS.map((c) => c.id));
  const entries = Object.entries(record as Record<string, unknown>);
  for (const [id, keys] of entries) {
    if (!known.has(id)) throw new Error(`未知命令：${id}`);
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) {
      throw new Error(`命令 ${id} 的键位格式不正确`);
    }
  }
  for (const [id, keys] of entries) {
    setBinding(id, keys as string[]);
  }
  return entries.length;
}

// ---------------------------------------------------------------- 键帽显示

const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** 单个键位的展示名：Mac 用 ⌘⌥⇧，Windows 用 Ctrl Alt Shift。 */
function keyDisplayName(part: string): string {
  if (part === "Mod") return IS_MAC ? "⌘" : "Ctrl";
  if (part === "Alt") return IS_MAC ? "⌥" : "Alt";
  if (part === "Shift") return IS_MAC ? "⇧" : "Shift";
  const arrows: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  return arrows[part] ?? part;
}

/**
 * 把组合串拆成键帽序列：`Mod-Shift-\`` → ["Ctrl", "Shift", "`"]（Mac 为 ⌘⇧`）。
 * 供设置页的键帽渲染；状态栏/命令面板的文本提示仍用 {@link formatKey}。
 */
export function keycapParts(combo: string): string[] {
  const parts = combo.split("-").filter((part) => part !== "");
  if (parts.length === 0) return [combo];
  return parts.map(keyDisplayName);
}

/** `Mod-Comma` → `Ctrl ,`（macOS 上 Mod 显示为 Cmd）。给界面上的 kbd 标签用。 */
export function formatKey(combo: string): string {
  const mod = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
  return combo.replace(/^Mod-/, `${mod} `).replace(/-/g, " ");
}

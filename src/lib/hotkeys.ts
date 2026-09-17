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

export interface CommandKeys {
  id: string;
  label: string;
  /** 默认键位，`Mod-K` 形式；空数组 = 默认没有快捷键（仍可自定义绑定）。 */
  keys: string[];
}

/** 支持重绑定的命令清单。顺序即设置面板里的展示顺序。 */
export const COMMAND_KEYS: CommandKeys[] = [
  { id: "palette", label: "命令面板 / 全局搜索", keys: ["Mod-K", "Mod-P"] },
  { id: "newNote", label: "新建笔记", keys: ["Mod-N"] },
  { id: "newDiary", label: "新建今日日记", keys: [] },
  { id: "newFolder", label: "新建文件夹", keys: [] },
  { id: "save", label: "保存当前笔记", keys: ["Mod-S"] },
  { id: "toggleMode", label: "切换 实时 / 源码", keys: ["Mod-E"] },
  { id: "toggleLeft", label: "收起 / 展开文件栏", keys: ["Mod-B"] },
  { id: "toggleRight", label: "收起 / 展开右侧面板", keys: ["Mod-Shift-B"] },
  { id: "zen", label: "专注模式（隐藏侧栏）", keys: ["Mod-Shift-F"] },
  { id: "openSettings", label: "打开设置", keys: ["Mod-,"] },
  { id: "syncNow", label: "立即同步", keys: [] },
  { id: "openVaultPicker", label: "打开其他仓库…", keys: [] },
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

/** `Mod-Comma` → `Ctrl ,`（macOS 上 Mod 显示为 Cmd）。给界面上的 kbd 标签用。 */
export function formatKey(combo: string): string {
  const mod = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
  return combo.replace(/^Mod-/, `${mod} `).replace(/-/g, " ");
}

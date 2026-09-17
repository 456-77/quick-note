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
}

const STORAGE_KEY = "quicknote.settings";

const DEFAULTS: Settings = {
  // 默认 wiki：Obsidian 开启 wikilink 时（默认）粘贴图片写的就是 ![[图.png]]
  linkFormat: "wiki",
  savePastedAttachments: true,
  // 默认深色：这套界面按"深色高级"设计（浅色仍可在设置里切换/跟随系统）
  theme: "dark",
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

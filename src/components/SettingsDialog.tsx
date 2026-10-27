/**
 * 设置面板：左侧分类导航 + 右侧配置区，顶部搜索框实时过滤设置项。
 *
 * 结构上的硬约束来自 GUI 验收脚本（它们按 DOM 契约驱动面板）：
 *   - 根节点类名必须是 `.settings-panel`（开合判断）；
 *   - 所有设置行都是 `.settings-row` 且第一个 span 是标签文本（按标签找控件）；
 *   - 「粘贴时保存附件」的复选框必须是面板里**第一个** checkbox（DOM 顺序：
 *     通用 → 外观 → 日记与附件 → 云同步 → 快捷键 → 关于）；
 *   - 分区先后与行标签文案保持稳定（脚本按 `[data-sec] .settings-row` + 标签
 *     文本定位控件），改版只动布局与说明文案的呈现方式。
 * 非激活分区**渲染但隐藏**：脚本是程序化赋值，隐藏元素照样能触发 onChange。
 *
 * 0.26 按用户 13 节规范重排 UI（不改任何设置项与含义）：
 *   - 分组标题 + 一行说明 + 右侧控件的统一行结构（长说明收进 title tooltip）；
 *   - 主题改为浅色/深色/跟随系统分段选项卡；背景区带实时预览，参数**每仓库一份**；
 *   - 日记与附件按 附件/日记/提醒/天气 分组；存储页补数据统计与缓存清理；
 *   - 关于页给 Logo、版本、更新与资源入口；设置搜索命中可点击跳转。
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { bgFilterCss } from "../lib/background";
import { DAILY_CONFIG_FILE } from "../lib/daily";
import { clearWebviewCache, pickDirectory, listVaults, webviewCacheStat, type AppDataPaths, type DirStat } from "../lib/api";
import { bgSettingsFor, type BgSettings, type Settings } from "../lib/settings";
import type { DailyController } from "../lib/useDaily";
import type { SyncController } from "../lib/useSync";
import { isMobile } from "../lib/platform";
import { setCapturing } from "../lib/hotkeys";
import HotkeysPane from "./HotkeysPane";
import {
  IconCalendarPlus,
  IconCheck,
  IconChevronDown,
  IconLibrary,
  IconListTree,
  IconChevronLeft,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSparkles,
} from "./icons";

type SectionId = "general" | "appearance" | "daily" | "sync" | "storage" | "shortcuts" | "about";

const SECTIONS: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "general", label: "通用", icon: <IconSettings size={14} /> },
  { id: "appearance", label: "外观", icon: <IconSparkles size={14} /> },
  { id: "daily", label: "日记与附件", icon: <IconCalendarPlus size={14} /> },
  { id: "sync", label: "云同步", icon: <IconRefresh size={14} /> },
  { id: "storage", label: "存储", icon: <IconLibrary size={14} /> },
  { id: "shortcuts", label: "快捷键", icon: <IconListTree size={14} /> },
  { id: "about", label: "关于", icon: <span className="settings-nav-logo">i</span> },
];

/** 搜索高亮颜色的预设（0.26 用户反馈"高亮颜色可以在设置中设置"）。 */
const HIT_COLOR_PRESETS = ["#ff5252", "#ffb300", "#4caf50", "#2196f3", "#ba68c8"];

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  applySettings: (patch: Partial<Settings>) => void;
  /** 当前仓库（背景图按仓库取参数；null = 未开仓库，背景区不可用）。 */
  vault: string | null;
  /** 仓库内的图片路径（背景图下拉框的候选）。 */
  imagePaths: string[];
  daily: DailyController;
  sync: SyncController;
  /** 应用数据目录信息（「存储」分区展示与操作）。 */
  dataPaths: AppDataPaths | null;
  onPickDataDir: () => void;
  onClearDataDir: () => void;
  /** 移动端仓库基础目录（null = 未设置/桌面端）；onOpenVaultPage 弹出仓库列表页。 */
  vaultHome: string | null;
  onOpenVaultPage: () => void;
  /** 0.33.1 用户反馈：主页打开的设置**只提供全局设置**——按仓库的分区
      （日记与附件）与区块（外观的全局背景、云同步的按仓库字段）整体隐藏，
      而不是渲染成禁用/提示态。 */
  globalOnly?: boolean;
  customCssDraft: string;
  onCustomCssChange: (value: string) => void;
  appVersion: string;
  updateCheck: {
    state: "idle" | "checking" | "done" | "error" | "downloading" | "installing";
    message: string;
    url?: string;
    /** 插件检查发现可用更新：出现「立即更新」按钮（应用内下载安装重启）。 */
    available?: boolean;
  };
  checkUpdate: () => void;
  installUpdate: () => void;
  openReleasePage: (url?: string) => void;
  /** 仓库里的笔记数量（存储页统计；null = 还没统计出来）。 */
  noteCount: number | null;
  /** 仓库附件目录里的文件数量。 */
  attachmentCount: number | null;
  /** Android 系统返回消费（0.34.6 用户反馈：二级详情页按返回应回到分类列表，
      而不是直接退出设置）——二级页时消费返回 true，一级页返回 false 让外层关面板。 */
  backConsumerRef?: MutableRefObject<(() => boolean) | null>;
}

/** 设置行：标签 + 一句话说明 + 右侧控件；完整说明放 title tooltip。
 * 第一个 span 恒为标签文本——GUI 验收按 `row.querySelector("span").textContent` 找行。 */
function Row({
  label,
  desc,
  tip,
  keywords,
  children,
}: {
  label: string;
  /** 一句话说明（标签下方弱化展示；控件说明压缩到此为止）。 */
  desc?: string;
  /** 完整规则（title tooltip；不占版面）。 */
  tip?: string;
  /** 设置搜索的补充关键词（如 不透明度 → "背景 淡"）。 */
  keywords?: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-row" data-keywords={keywords} title={tip ?? desc}>
      <span>{label}</span>
      {desc && <span className="settings-row-desc">{desc}</span>}
      {children}
    </label>
  );
}

/**
 * 设置里的下拉框：触发器 + 自绘菜单（0.28 用户反馈"下拉框改现代些"）。
 *
 * 原生 `<select>` 的弹出层由系统绘制，CSS 完全管不到——截图里那种白底高亮、
 * 直角边框的旧式列表就是它。这里按钮与菜单都用界面自己的 token 绘制；同时
 * **保留一个视觉隐藏的原生 select**（display 不设 none，保持可程序化赋值）：
 * 键盘读屏与 GUI 验收脚本都还按 select 找控件、写 value、派发 change。
 * 菜单用 portal + fixed：设置区是可滚动容器，绝对定位的菜单会被裁掉。
 */
function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 菜单与触发器**右缘对齐**（left = rect.right - width）。宽度必须算死：
    // 此前只给 minWidth，长选项（背景图的 attachments/Pasted image … 路径）
    // 会把菜单往右撑出窗口，列表被整个裁掉（0.29 用户反馈"下拉框截断"）。
    // 上限 440 保证长路径靠省略号收住，hover 有 title 看全文。
    const width = Math.max(200, Math.min(Math.max(rect.width, 200), 440, rect.right - 8));
    const menuHeight = Math.min(280, options.length * 34 + 10);
    let left = rect.right - width;
    if (left < 8) left = 8;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    // 空间不够就翻到触发器上方，避免菜单被窗口底边截断
    const below = rect.bottom + 6;
    const top = below + menuHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menuHeight - 6) : below;
    setAnchor({ left, top, width });
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (event: Event) => {
      // 拖动设置区滚动条时菜单会与触发器脱节，直接收起最干净
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const choose = (next: T) => {
    setOpen(false);
    onChange(next);
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <span className={`settings-select${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`settings-select-trigger${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          place();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            place();
            setOpen(true);
          }
        }}
      >
        <span className="settings-select-label">{current?.label ?? ""}</span>
        <IconChevronDown size={12} />
      </button>
      {/* 原生 select（视觉隐藏）：GUI 验收与读屏仍按 select 操作 */}
      <select
        className="settings-select-native"
        value={value}
        disabled={disabled}
        tabIndex={-1}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {open &&
        anchor &&
        createPortal(
          <div
            ref={menuRef}
            className="settings-select-menu"
            role="listbox"
            aria-label={ariaLabel}
            style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`settings-select-option${option.value === value ? " is-on" : ""}`}
                title={option.label}
                onClick={() => choose(option.value)}
              >
                <span>{option.label}</span>
                {option.value === value && <IconCheck size={12} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * 云同步的两个动作 + 旁边的实时状态（0.28 用户反馈：点同步后旁边要显示状态，
 * 未完成时不能重复点）。
 *
 * 状态直接取 useSync 的 status：引擎在真正开工前先 onStatus("syncing")，所以
 * 点下去立刻变「同步中…」并禁用两个按钮；完成/失败再切回。状态条同时给了
 * 上次成功时间与错因，不用再低头看状态栏。
 */
function SyncActions({ sync }: { sync: SyncController }) {
  const syncing = sync.status === "syncing";
  const time = (() => {
    if (!sync.lastSyncAt) return "";
    const when = new Date(sync.lastSyncAt);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  })();
  const statusText = syncing
    ? "同步中…"
    : sync.status === "error"
      ? `同步失败：${sync.error ?? "未知原因"}`
      : sync.status === "ok"
        ? time
          ? `已同步 ${time}`
          : "已同步"
        : sync.config.enabled
          ? "等待同步"
          : "自动同步已关闭";
  return (
    <div className="settings-actions settings-sync-actions">
      <button
        type="button"
        className={`btn btn-primary${syncing ? " is-busy" : ""}`}
        disabled={syncing}
        onClick={() => sync.syncNow()}
      >
        {syncing ? "同步中…" : "立即同步"}
      </button>
      <button
        type="button"
        className="btn"
        disabled={syncing}
        onClick={() => sync.resetCursorAndSync()}
        title="游标归零后重新全量拉取一次；本地状态异常时用它"
      >
        重置游标并重拉
      </button>
      <span
        className={`settings-sync-status is-${sync.status}${syncing ? " is-busy" : ""}`}
        data-sync-status={sync.status}
        title={sync.status === "error" ? sync.error ?? "" : statusText}
        role="status"
        aria-live="polite"
      >
        <span className="settings-sync-dot" aria-hidden />
        {statusText}
      </span>
    </div>
  );
}

/** 分组标题：小号强调字 + 分隔线（规范：分组标题 ────────────）。 */
function Group({ children }: { children: ReactNode }) {
  return <div className="settings-group">{children}</div>;
}

/**
 * 把按键事件归一成 OS 全局快捷键串（`Ctrl+Alt+G`，与 Rust 端解析同一格式）。
 * 只收 字母/数字/F1–F12 做主键；主键是字母/数字时必须带至少一个修饰键
 * （裸键会被系统快捷键吞掉，也不符合全局热键惯例）。不合法返回 null。
 */
function osHotkeyOf(event: KeyboardEvent): string | null {
  const key = event.key;
  let main: string | null = null;
  if (/^[a-zA-Z]$/.test(key)) main = key.toUpperCase();
  else if (/^F\d{1,2}$/.test(key)) main = key;
  else if (/^[0-9]$/.test(key)) main = key;
  if (!main) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  if (parts.length === 0 && !main.startsWith("F")) return null;
  return [...parts, main].join("+");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function SettingsDialog({
  open,
  onClose,
  settings,
  applySettings,
  vault,
  imagePaths,
  daily,
  sync,
  dataPaths,
  onPickDataDir,
  onClearDataDir,
  vaultHome,
  onOpenVaultPage,
  globalOnly = false,
  customCssDraft,
  onCustomCssChange,
  appVersion,
  updateCheck,
  checkUpdate,
  installUpdate,
  openReleasePage,
  noteCount,
  attachmentCount,
  backConsumerRef,
}: Props) {
  const [active, setActive] = useState<SectionId>("general");
  /**
   * 移动端二级结构：true = 分类列表页，false = 分类详情页。
   * 打开面板时回到列表；点分类进详情；详情页头部「‹」返回。
   * 桌面端此状态无效（CSS 只在移动断点消费 is-detail）。
   */
  const [mobileDetail, setMobileDetail] = useState(false);
  // Android 系统返回：二级详情页先回分类列表（消费这次返回），一级页交给外层
  // 关掉整个设置面板（0.34.6 用户反馈「二级页面按返回直接退出了软件」）
  useEffect(() => {
    if (!backConsumerRef) return;
    backConsumerRef.current = () => {
      if (mobileDetail) {
        setMobileDetail(false);
        return true;
      }
      return false;
    };
    return () => {
      backConsumerRef.current = null;
    };
  }, [backConsumerRef, mobileDetail]);
  /** 移动端收件仓库候选（基础目录下发现的仓库）。 */
  const [inboxVaultOptions, setInboxVaultOptions] = useState<Array<{ path: string; name: string }> | null>(null);
  const [query, setQuery] = useState("");
  /** 改动落盘后的轻反馈：「已保存」闪现 1.6s */
  const [savedFlash, setSavedFlash] = useState(false);
  /**
   * 截图快捷键的按键录入态（0.21 用户反馈：不该手填文本）。录入期间挂起全局
   * 快捷键（同 HotkeysPane 的捕获），Enter 确认 / Esc 取消；null = 还没捕获到
   * 合法组合，"" = 按了个不合法的键（提示语由渲染层给出）。
   */
  const [shotRecording, setShotRecording] = useState(false);
  const [shotPending, setShotPending] = useState<string | null>(null);
  /** 搜索结果点击后的跳转目标：落位后滚到那一行并闪一次（规范：点击直接跳转）。 */
  const [jumpTarget, setJumpTarget] = useState<{ sec: SectionId; label: string } | null>(null);
  /** WebView 缓存体积（存储页统计；进入 storage 分区时取一次）。 */
  const [cacheStat, setCacheStat] = useState<DirStat | null>(null);
  /** 清理缓存的进行中/结果提示。 */
  const [cacheBusy, setCacheBusy] = useState(false);
  const savedTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 0.34.6 相册选壁纸：qnAndroid.pickBackgroundImage 发起后等原生回调
  // __qnBgPickDone(ok, relPathOrError)。bgPicking 驱动按钮「等待相册…」；
  // bgBridgeReady 探测桥是否存在（桌面/未注入时按钮禁用）。
  const [bgPicking, setBgPicking] = useState(false);
  const [bgBridgeReady] = useState(
    () => typeof (window as unknown as Record<string, unknown>).qnAndroid === "object",
  );
  /** 相册选壁纸的结果提示（与 savedFlash 同位展示，1.6s 后消失）。 */
  const [bgNotice, setBgNotice] = useState("");
  const bgNoticeTimer = useRef<number | null>(null);
  const bgPickTimer = useRef<number | null>(null);

  /** applySettings 的包装：闪一次「已保存」。所有设置改动都走这里。 */
  const saveWithFlash: typeof applySettings = useCallback(
    (patch) => {
      applySettings(patch);
      setSavedFlash(true);
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSavedFlash(false), 1600);
    },
    [applySettings],
  );

  /** 背景参数（当前仓库生效值）；没开仓库时给默认值，控件渲染为禁用。 */
  const bg = bgSettingsFor(vault, settings);
  /** 把一批背景改动写进当前仓库的 per-vault 条目。 */
  const saveBg = useCallback(
    (patch: Partial<BgSettings>) => {
      if (!vault) return;
      saveWithFlash({
        bgPerVault: { ...(settings.bgPerVault ?? {}), [vault]: { ...bg, ...patch } },
      });
    },
    [vault, settings.bgPerVault, bg, saveWithFlash],
  );

  // 0.34.6 相册选壁纸的原生回调：挂 __qnBgPickDone（桥在 MainActivity 注入）。
  // 必须在 saveBg 之后注册——成功回调里要写 bgImagePath + 启用背景
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__qnBgPickDone = (ok: boolean, result: string) => {
      if (bgPickTimer.current !== null) {
        window.clearTimeout(bgPickTimer.current);
        bgPickTimer.current = null;
      }
      setBgPicking(false);
      if (bgNoticeTimer.current !== null) window.clearTimeout(bgNoticeTimer.current);
      setBgNotice(ok ? `已拷入 ${result} 并设为背景` : result ? `壁纸保存失败：${result}` : "");
      if (ok || result) bgNoticeTimer.current = window.setTimeout(() => setBgNotice(""), 2600);
      if (ok) saveBg({ bgImagePath: result, bgEnabled: true });
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__qnBgPickDone;
      if (bgPickTimer.current !== null) window.clearTimeout(bgPickTimer.current);
      if (bgNoticeTimer.current !== null) window.clearTimeout(bgNoticeTimer.current);
    };
  }, [saveBg]);

  // 面板打开时 Ctrl/Cmd+F 聚焦「搜索设置」（拦掉浏览器默认页内搜索）
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 截图快捷键的按键录入：实时回显，Enter 确认 / Esc 取消（同 HotkeysPane 手感）
  useEffect(() => {
    if (!shotRecording) return;
    setCapturing(true);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setShotRecording(false);
        setShotPending(null);
        return;
      }
      if (event.key === "Enter") {
        if (shotPending) saveWithFlash({ screenshotHotkey: shotPending });
        setShotRecording(false);
        setShotPending(null);
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
        setShotPending(null);
        return;
      }
      setShotPending(osHotkeyOf(event));
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setCapturing(false);
    };
  }, [shotRecording, shotPending, saveWithFlash]);

  // 面板关掉时录入态一并收场（避免全局快捷键被一直挂起）
  useEffect(() => {
    if (!open && shotRecording) {
      setShotRecording(false);
      setShotPending(null);
    }
  }, [open, shotRecording]);

  // 打开时重置到第一页并清空搜索（快捷键分区的录入态随其组件卸载自动结束）
  useEffect(() => {
    if (open) {
      setActive("general");
      setQuery("");
      setJumpTarget(null);
    }
  }, [open]);

  // 进入存储分区时取一次缓存体积（递归扫描有成本，不随面板常驻跑）
  useEffect(() => {
    if (!open || active !== "storage") return;
    webviewCacheStat()
      .then(setCacheStat)
      .catch(() => setCacheStat(null));
  }, [open, active]);

  /** 清理 WebView 缓存：完成后刷新统计并提示释放量。 */
  const clearCacheNow = useCallback(async () => {
    setCacheBusy(true);
    try {
      const freed = await clearWebviewCache();
      setCacheStat(await webviewCacheStat().catch(() => null));
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
      window.alert(`已释放 ${formatBytes(freed)} 缓存空间`);
    } catch {
      window.alert("清理缓存失败：部分文件可能被占用，稍后再试");
    } finally {
      setCacheBusy(false);
    }
  }, []);

  // 搜索过滤：匹配行标签、一句话说明、补充关键词与分组标题；命中行显示在
  // 全部分区里（分区标题随命中行显隐），点击命中行跳转到所在分区并定位。
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      // 还原：行全部显示，分区只显示激活的那个（由下面的 render 分支控制）
      root.querySelectorAll<HTMLElement>(".settings-sec").forEach((sec) => {
        sec
          .querySelectorAll<HTMLElement>(".settings-row, .settings-hint, .settings-actions, .settings-group, .settings-block, .settings-stat")
          .forEach((row) => {
            row.style.display = "";
          });
      });
      return;
    }
    root.querySelectorAll<HTMLElement>(".settings-sec").forEach((sec) => {
      let visibleRows = 0;
      sec
        .querySelectorAll<HTMLElement>(".settings-row, .settings-hint, .settings-actions, .settings-group, .settings-block, .settings-stat")
        .forEach((row) => {
          const label = row.classList.contains("settings-group")
            ? (row.textContent ?? "")
            : (row.querySelector("span")?.textContent ?? row.textContent ?? "");
          const extra = `${row.dataset.keywords ?? ""} ${row.textContent ?? ""}`.toLowerCase();
          const hit = label.toLowerCase().includes(q) || extra.includes(q);
          row.style.display = hit ? "" : "none";
          if (hit && row.classList.contains("settings-row")) visibleRows += 1;
        });
      sec.style.display = visibleRows > 0 ? "" : "none";
    });
  }, [query, active, open]);

  // 搜索结果点击跳转：切到目标分区、清掉搜索词，然后把那一行滚进视口并闪一次
  useEffect(() => {
    if (!jumpTarget) return;
    const { sec, label } = jumpTarget;
    if (active !== sec || query.trim() !== "") return;
    const frame = requestAnimationFrame(() => {
      const root = bodyRef.current;
      const secEl = root?.querySelector<HTMLElement>(`.settings-sec[data-sec="${sec}"]`);
      const row = [...(secEl?.querySelectorAll<HTMLElement>(".settings-row") ?? [])].find(
        (candidate) => candidate.querySelector("span")?.textContent === label,
      );
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("is-flash");
        window.setTimeout(() => row.classList.remove("is-flash"), 1500);
      }
      setJumpTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpTarget, active, query]);

  /** 搜索模式下点命中行：跳到所在分区（控件自身的点击行为照常发生）。 */
  const onBodyClick = useCallback(
    (event: ReactMouseEvent) => {
      if (query.trim() === "") return;
      const row = (event.target as HTMLElement).closest<HTMLElement>(".settings-row");
      if (!row) return;
      const sec = row.closest<HTMLElement>(".settings-sec")?.dataset.sec as SectionId | undefined;
      const label = row.querySelector("span")?.textContent ?? "";
      if (!sec || !label) return;
      if (sec !== active) {
        setActive(sec);
        setMobileDetail(true);
      }
      setQuery("");
      setJumpTarget({ sec, label });
    },
    [query, active],
  );

  // 移动端（触屏）：目录选择器不可用，收件仓库等改用列表选择。
  const mobilePick = isMobile();
  useEffect(() => {
    if (!open) setMobileDetail(false);
  }, [open]);

  // 移动端打开面板时取收件仓库候选（Android 目录选择器不可用）
  useEffect(() => {
    if (!open || !mobilePick) return;
    void listVaults()
      .then((list) => setInboxVaultOptions(list.map((v) => ({ path: v.path, name: v.name }))))
      .catch(() => setInboxVaultOptions([]));
  }, [open, mobilePick]);

  if (!open) return null;

  const searching = query.trim() !== "";

  return (
    <div className={`settings-panel${mobileDetail ? " is-detail" : ""}`} role="dialog" aria-label="设置">
      <div className="settings-nav">
        <div className="settings-nav-head">
          {/* 0.34.1 用户反馈：一级标题去掉「/xx」后缀——分类名由下面的导航列表
              呈现，一级页头只保留「设置」（桌面与移动端同步生效） */}
          <span className="settings-nav-title">设置</span>
          {savedFlash && <span className="settings-saved">已保存</span>}
          {/* 0.33.0 停点3：关闭入口也用 ‹（移动端习惯），不用 × */}
          <button
            type="button"
            className="icon-btn settings-close"
            onClick={onClose}
            title="关闭设置（Esc）"
            aria-label="关闭设置"
          >
            <IconChevronLeft size={15} />
          </button>
        </div>
        <div className="settings-search">
          <IconSearch size={13} />
          {/* type=search：GUI 验收按「面板里第一个 input[type=text] = 附件目录」定位控件 */}
          <input
            ref={searchInputRef}
            type="search"
            placeholder="搜索设置…（Ctrl+F）"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
          />
        </div>
        {SECTIONS.filter((section) => !(globalOnly && section.id === "daily")).map((section) => (
          <button
            key={section.id}
            type="button"
            data-sec-nav={section.id}
            className={`settings-nav-item${!searching && active === section.id ? " is-on" : ""}${
              section.id === "about" ? " is-about" : ""
            }`}
            onClick={() => {
              setActive(section.id);
              setMobileDetail(true);
              setQuery("");
            }}
          >
            {section.icon}
            <span>{section.label}</span>
          </button>
        ))}
      </div>

      <div className="settings-body" ref={bodyRef} onClick={onBodyClick}>
        {/* 移动端详情页头：返回分类列表 + 关闭（桌面 CSS 隐藏） */}
        <div className="settings-mobile-head">
          {/* 0.33.0 停点3 反馈：返回用 ‹ 图标（移动端习惯），纯图标不叠文字；
              关闭设置的 × 只留在一级页头部——二级页出现两个叉/箭头会混淆
              返回与关闭 */}
          <button type="button" className="settings-back" onClick={() => setMobileDetail(false)} aria-label="返回设置目录">
            <IconChevronLeft size={20} />
          </button>
          <span className="settings-mobile-title">{SECTIONS.find((sec) => sec.id === active)?.label}</span>
        </div>
        {/* 顺序即 DOM 顺序：gui 验收依赖「第一个 checkbox 是粘贴开关」，不要调整分区先后。 */}
        <section className="settings-sec" data-sec="general" style={{ display: searching || active === "general" ? undefined : "none" }}>
          <Group>链接与附件</Group>
          <Row label="插入链接写法" desc="粘贴图片/文件时插入的链接格式。">
            <SettingsSelect
              ariaLabel="插入链接写法"
              value={settings.linkFormat}
              options={[
                { value: "wiki", label: "Wiki：![[图.png]]" },
                { value: "markdown", label: "Markdown：![](/attachments/图.png)" },
              ]}
              onChange={(value) => saveWithFlash({ linkFormat: value })}
            />
          </Row>
          <Row
            label="粘贴时保存附件"
            desc="粘贴图片/文件自动存进附件目录并在光标处插入链接。"
            tip="重名自动加序号，不覆盖已有文件。附件目录在「日记与附件」分组里设置，与 Obsidian 插件共用；同步开启后贴的图会自动上传。"
          >
            <input
              type="checkbox"
              checked={settings.savePastedAttachments}
              onChange={(event) =>
                saveWithFlash({ savePastedAttachments: event.target.checked })
              }
            />
          </Row>
          <Row
            label="粘贴代码自动识别语言"
            desc="粘贴代码时自动识别语言并包成围栏代码块。"
            tip="支持 30+ 种语言；已带围栏的代码、代码块内部的粘贴不会被改写。开关存在库内配置里（与 Obsidian 插件共用）。"
          >
            <input
              type="checkbox"
              checked={daily.settings.autoDetectCodeLang}
              onChange={(event) =>
                daily.updateSettings({ autoDetectCodeLang: event.target.checked })
              }
            />
          </Row>

          <Group>导出</Group>
          <Row
            label="导出目录"
            desc="导出 PDF / mermaid 图表的默认保存位置。"
            tip="仓库内相对路径，默认「导出」= 仓库根的导出文件夹。保存对话框会预填这个目录；手动选过一次位置后以手动选择优先。"
          >
            <span className="settings-inline">
              <input
                type="text"
                className="settings-text"
                value={settings.exportFolder}
                placeholder="导出"
                onChange={(event) => saveWithFlash({ exportFolder: event.target.value })}
              />
              <button
                type="button"
                className="btn btn-mini"
                title="在仓库里选一个目录作为导出目录（取所选目录名）"
                onClick={async () => {
                  const picked = await pickDirectory("选择导出目录");
                  if (picked) {
                    const folder = picked.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
                    saveWithFlash({ exportFolder: folder });
                  }
                }}
              >
                选择…
              </button>
              <button
                type="button"
                className="btn btn-mini"
                title="恢复默认（仓库根的「导出」）"
                onClick={() => saveWithFlash({ exportFolder: "导出" })}
              >
                重置
              </button>
            </span>
          </Row>

          <Group>打开行为</Group>
          <Row
            label="全局截图快捷键"
            desc="OS 级全局热键，应用在后台也响应。"
            tip="点「录入」后直接按组合键（Enter 确认、Esc 取消），不再手填。按下后抓取整个屏幕：可拖动框选、识别文字（Windows OCR）或存进当前笔记。留空 = 关闭；提示“被其他程序占用”说明该组合已被微信/QQ 等占用，换一个即可。多个 Quick Note 窗口同时开时由最先打开的窗口响应。"
            keywords="截图 ocr 屏幕捕捉"
          >
            <span className="settings-inline shot-hotkey-row">
              {shotRecording ? (
                <span className="shot-hotkey-capture" title="Enter 确认 · Esc 取消">
                  {shotPending === null
                    ? "按下组合键…"
                    : shotPending === ""
                      ? "需含 Ctrl/Alt/Shift/Win + 字母、数字或功能键"
                      : shotPending}
                </span>
              ) : (
                <kbd className="shot-hotkey-display" title="点击「录入」重新捕获">
                  {settings.screenshotHotkey || "未启用"}
                </kbd>
              )}
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => {
                  setShotPending(null);
                  setShotRecording((value) => !value);
                }}
              >
                {shotRecording ? "取消" : "录入"}
              </button>
              <button
                type="button"
                className="btn btn-mini"
                title="清空 = 关闭全局快捷键（命令面板仍可截图）"
                onClick={() => saveWithFlash({ screenshotHotkey: "" })}
              >
                关闭
              </button>
              <button
                type="button"
                className="btn btn-mini"
                title="恢复默认 Ctrl+Alt+G"
                onClick={() => saveWithFlash({ screenshotHotkey: "Ctrl+Alt+G" })}
              >
                重置
              </button>
            </span>
          </Row>
          <Row
            label="打开其他仓库时"
            desc="点最近仓库/选择其他仓库时在当前窗口还是新窗口打开。"
            tip="「每次询问」在切换仓库时弹窗让你选；勾过「记住我的选择」后会跳过询问，在这里改回「每次询问」即可恢复。目标仓库已在别的窗口开着时会直接把那个窗口切到前台。"
          >
            <SettingsSelect
              ariaLabel="打开其他仓库时"
              value={settings.vaultOpenMode}
              options={[
                { value: "ask", label: "每次询问（在新窗口或当前窗口打开）" },
                { value: "current", label: "总是当前窗口" },
                { value: "newWindow", label: "总是新窗口" },
              ]}
              onChange={(value) => saveWithFlash({ vaultOpenMode: value })}
            />
          </Row>
          <Row
            label="打开笔记时"
            desc="打开**没打开过**的笔记时替换当前标签还是新开标签。"
            tip="替换当前标签（Obsidian 式）标签数不增长，点文件树就像翻页；已打开过的笔记永远切回原有标签，两种模式一致。标签多时可以在标签栏上用滚轮左右滑动。"
          >
            <SettingsSelect
              ariaLabel="打开笔记时"
              value={settings.openNoteMode}
              options={[
                { value: "replace", label: "替换当前标签（Obsidian 式）" },
                { value: "newTab", label: "新开一个标签页" },
              ]}
              onChange={(value) => saveWithFlash({ openNoteMode: value })}
            />
          </Row>
          <Row
            label="新建/重命名时同步一级标题"
            desc="新建或重命名笔记时，同步更新正文中的一级标题。"
            tip="新建笔记时自动写入 `# 文件名` 一级标题；重命名笔记或日记后，把正文**第一个** `# 一级标题` 行同步改成新名字（不会凭空补标题；标题里有时间时也会跟着日期一起变）。重命名只影响设置后的改动。"
          >
            <input
              type="checkbox"
              checked={settings.syncRenameHeading}
              onChange={(event) =>
                saveWithFlash({ syncRenameHeading: event.target.checked })
              }
            />
          </Row>

          <Group>搜索</Group>
          <Row
            label="全局搜索悬停预览"
            desc="在搜索结果中显示当前笔记的上下文预览。"
            tip="命令面板（Ctrl+K）里鼠标悬停「内容」搜索结果时，侧边显示该笔记命中行前后的上下文预览（0.21 新增，可在此关闭）。点开笔记后还会自动高亮所有命中的关键词。"
          >
            <input
              type="checkbox"
              checked={settings.searchHoverPreview}
              onChange={(event) =>
                saveWithFlash({ searchHoverPreview: event.target.checked })
              }
            />
          </Row>
          <Row
            label="内容结果展示上限"
            desc="全局搜索的内容结果一次显示的文件数，滚到底部自动追加下一批。"
            keywords="搜索 数量 上限 分页 滚动"
          >
            <span className="settings-slider">
              <input
                type="range" min={20} max={300} step={10}
                value={settings.paletteContentLimit}
                onChange={(event) =>
                  saveWithFlash({ paletteContentLimit: Number(event.target.value) })
                }
              />
              <span className="settings-slider-value">{settings.paletteContentLimit} 个文件</span>
            </span>
          </Row>
          <Row
            label="搜索高亮颜色"
            desc="文件内搜索与全局搜索命中高亮的颜色。"
            keywords="颜色 红色 高亮 background"
          >
            <span className="settings-inline">
              <input
                type="color"
                className="settings-color"
                value={/^#[0-9a-fA-F]{6}$/.test(settings.searchHitColor) ? settings.searchHitColor : "#ff5252"}
                onChange={(event) => saveWithFlash({ searchHitColor: event.target.value })}
                title="自定义命中高亮颜色"
              />
              {HIT_COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`settings-swatch${settings.searchHitColor === color ? " is-on" : ""}`}
                  style={{ background: color }}
                  title={color}
                  aria-label={`使用 ${color} 作为高亮颜色`}
                  onClick={() => saveWithFlash({ searchHitColor: color })}
                />
              ))}
            </span>
          </Row>

          <Group>建表语句悬浮（0.31 新增）</Group>
          <Row
            label="表名悬浮预览"
            desc="光标悬停在已收录的表名上，浮动显示该表的建表语句。"
            tip="先把建表语句收进仓库内的 DDL 笔记（默认「数据库表DDL.md」）：快捷键（默认 Ctrl+Alt+J）弹窗粘贴 CREATE TABLE 自动识别表名，或直接在那篇笔记里手写。之后笔记里悬停表名（如 ids_check_scenario）约 0.3 秒，会弹出该表的完整建表语句，类似数据库 IDE。"
            keywords="DDL 建表 表名 悬浮 数据库"
          >
            <input
              type="checkbox"
              checked={settings.ddlHover}
              onChange={(event) => saveWithFlash({ ddlHover: event.target.checked })}
            />
          </Row>
          <Row
            label="DDL 笔记路径"
            desc="收录建表语句的仓库内笔记路径。"
            tip="仓库内相对路径。整篇笔记里的 CREATE TABLE 语句都会被扫描（说明文字随意写）；同名表以最后一次出现为准。改路径后悬浮库在下次仓库刷新/收录时切换到新文件。"
            keywords="DDL 建表 路径"
          >
            <span className="settings-inline">
              <input
                type="text"
                className="settings-text"
                value={settings.ddlFilePath}
                placeholder="数据库表DDL.md"
                onChange={(event) => saveWithFlash({ ddlFilePath: event.target.value })}
              />
              <button
                type="button"
                className="btn btn-mini"
                title="恢复默认路径"
                onClick={() => saveWithFlash({ ddlFilePath: "数据库表DDL.md" })}
              >
                重置
              </button>
            </span>
          </Row>

          <Group>新建与整理</Group>
          <Row
            label="新笔记自动打标签"
            desc="新建笔记时自动添加指定标签。"
            tip="标签在左侧栏「标签」仪表盘里集中整理——写的时候不用先想分类，回头在仪表盘把标签一键清掉即可。"
          >
            <input
              type="checkbox"
              checked={settings.autoTagNewNote}
              onChange={(event) => saveWithFlash({ autoTagNewNote: event.target.checked })}
            />
          </Row>
          <Row
            label="自动标签名"
            desc="自动追加的标签名；留空或不合法（含空格等）不打。"
          >
            <input
              type="text"
              className="settings-text"
              value={settings.autoTagName}
              placeholder="待整理"
              onChange={(event) => saveWithFlash({ autoTagName: event.target.value })}
            />
          </Row>

          <Group>快速笔记（收件箱）</Group>
          <Row
            label="收件仓库"
            desc="速记的落点仓库，不随当前窗口切换。"
            keywords="快速笔记 速记 收件箱"
          >
            <span className="settings-inline">
              <input
                type="text"
                className="settings-text"
                value={settings.quickCaptureVault}
                placeholder="未选择"
                readOnly
                title={settings.quickCaptureVault || "尚未选择收件仓库"}
              />
              {mobilePick ? (
                /* Android 没有可用的目录选择器：从基础目录发现的仓库里选 */
                <select
                  className="btn btn-mini"
                  value=""
                  onChange={async (event) => {
                    const picked = event.target.value;
                    if (picked) saveWithFlash({ quickCaptureVault: picked });
                  }}
                >
                  <option value="">选择仓库…</option>
                  {(inboxVaultOptions ?? []).map((v) => (
                    <option key={v.path} value={v.path}>
                      {v.name}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={async () => {
                    const picked = await pickDirectory("选择快速笔记的收件仓库");
                    if (picked) saveWithFlash({ quickCaptureVault: picked });
                  }}
                >
                  选择…
                </button>
              )}
              <button
                type="button"
                className="btn btn-mini btn-danger-soft"
                title="清除收件仓库（快速笔记将不可用）"
                onClick={() => saveWithFlash({ quickCaptureVault: "" })}
              >
                清除
              </button>
            </span>
          </Row>
          <Row
            label="落点文件"
            desc="速记追加进这个文件，{{date}} 展开为当天日期。"
            tip="如 {{date}}.md = 一天一篇；每条速记带「日期 时间」前缀逐行追加。快捷键默认 Ctrl+Alt+N（设置 → 快捷键 可改），写完继续干活，不用切换仓库。"
          >
            <input
              type="text"
              className="settings-text"
              value={settings.quickCaptureFile}
              placeholder="Inbox.md"
              onChange={(event) => saveWithFlash({ quickCaptureFile: event.target.value })}
            />
          </Row>
        </section>

        <section className="settings-sec" data-sec="appearance" style={{ display: searching || active === "appearance" ? undefined : "none" }}>
          <Group>外观</Group>
          <Row
            label="主题"
            desc="深色是默认主题；「跟随系统」随系统明暗自动切换。"
            keywords="浅色 深色 dark light"
          >
            <span className="settings-segmented" role="tablist" aria-label="主题">
              {(
                [
                  ["light", "浅色"],
                  ["dark", "深色"],
                  ["system", "跟随系统"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={settings.theme === value}
                  className={`settings-segment${settings.theme === value ? " is-on" : ""}`}
                  onClick={() => saveWithFlash({ theme: value })}
                >
                  {label}
                </button>
              ))}
            </span>
          </Row>
          <Row
            label="Markdown 渲染风格"
            desc="正文渲染观感：默认 / Blue Topaz 风。"
            tip="Blue Topaz 风仿照 Obsidian 社区主题 Blue Topaz 的正文观感：彩色标题层级、蓝色标题下划线、着色表头与加重的 callout / 引用块。只影响渲染样式，不改任何文件内容；与「自定义样式」叠加生效（自定义的优先级更高）。"
          >
            <SettingsSelect
              ariaLabel="Markdown 渲染风格"
              value={settings.renderStyle}
              options={[
                { value: "default", label: "默认" },
                { value: "blueTopaz", label: "Blue Topaz 风" },
              ]}
              onChange={(value) => saveWithFlash({ renderStyle: value })}
            />
          </Row>
          <Row
            label="显示行号数字"
            desc="打开后编辑区左缘显示行号，与当前行高亮联动。默认关闭（笔记不是代码）。"
          >
            <input
              type="checkbox"
              checked={settings.showLineNumbers}
              onChange={(event) => saveWithFlash({ showLineNumbers: event.target.checked })}
            />
          </Row>
          {/* 0.33.0 批C：移动端字号缩放（阅读/编辑分离配套）。仅手机端渲染——
              桌面 --qn-edit-scale 恒缺省 1，本行不出现 */}
          {mobilePick && (
            <Row
              label="字体大小"
              desc="编辑器正文与标题整体缩放，仅手机端生效（85%～130%）。"
              keywords="字号 缩放 正文大小"
            >
              <span className="settings-slider">
                <input
                  type="range"
                  min={0.85}
                  max={1.3}
                  step={0.05}
                  value={settings.mobileFontScale || 1}
                  onChange={(event) => saveWithFlash({ mobileFontScale: Number(event.target.value) })}
                />
                <span className="settings-slider-value">{Math.round((settings.mobileFontScale || 1) * 100)}%</span>
              </span>
            </Row>
          )}

          {/* 0.33.1：globalOnly 下隐藏按仓库的区块（全局背景每仓库一份）与
              按仓库的行（云端仓库名、同步动作操作当前仓库） */}
          {!globalOnly && (
          <>
          <Group>全局背景（每仓库一份，存本机）</Group>
          {!vault && <p className="settings-hint">打开仓库后才能选择与预览背景图片（图片来自仓库内部）。</p>}
          {bgNotice && <p className="settings-hint">{bgNotice}</p>}
          <Row
            label="启用背景图片"
            desc="把仓库里的一张图垫在界面最底层营造氛围。"
            tip="开启后顶栏、侧栏与编辑器卡片会变为半透明让背景透出。支持静态图片；刻意不支持视频动态壁纸（常驻解码是内存杀手，与「轻量」目标相反）。背景参数按仓库各存一份（存本机，不进仓库）。"
            keywords="背景 壁纸 图片 不透明度 模糊"
          >
            <input
              type="checkbox"
              checked={bg.bgEnabled}
              disabled={!vault}
              onChange={(event) => saveBg({ bgEnabled: event.target.checked })}
            />
          </Row>
          <Row
            label="背景图片"
            desc="从当前仓库的图片里选；想用新图先拷进仓库附件目录。"
            keywords="背景 壁纸"
          >
            <SettingsSelect
              ariaLabel="背景图片"
              value={bg.bgImagePath}
              disabled={!vault}
              options={[
                { value: "", label: "（无背景图）" },
                ...(bg.bgImagePath && !imagePaths.includes(bg.bgImagePath)
                  ? [{ value: bg.bgImagePath, label: `${bg.bgImagePath}（文件不在仓库里）` }]
                  : []),
                ...imagePaths.map((path) => ({ value: path, label: path })),
              ]}
              onChange={(value) =>
                saveBg({
                  bgImagePath: value,
                  // 选了图顺手启用；选回「无」就一并关掉，避免开着背景却没图的悬空状态
                  bgEnabled: value ? true : false,
                })
              }
            />
          </Row>
          {isMobile() && (
            <Row
              label="从相册选择壁纸"
              desc="调系统相册选一张图，自动拷入当前仓库的附件目录并设为背景。"
              tip="应用暂不支持在库内直接添加图片，这里从系统相册选取：选中的原图会拷贝到 仓库/attachments/background.<扩展名>，随后自动设为背景图片（0.34.6 用户反馈）。"
              keywords="相册 壁纸 背景 图片 添加"
            >
              <button
                type="button"
                className="btn"
                disabled={!vault || !bgBridgeReady || bgPicking}
                onClick={() => {
                  if (!vault) return;
                  setBgPicking(true);
                  const bridge = (window as unknown as Record<string, unknown>).qnAndroid as
                    | { pickBackgroundImage?: (dir: string) => void }
                    | undefined;
                  if (!bridge?.pickBackgroundImage) {
                    setBgPicking(false);
                    return;
                  }
                  bgPickTimer.current = window.setTimeout(() => {
                    setBgPicking(false);
                  }, 120000);
                  bridge.pickBackgroundImage(vault.replace(/[\\/]+$/, ""));
                }}
              >
                {bgPicking ? "等待相册…" : "从相册选择"}
              </button>
            </Row>
          )}
          {/* 壁纸轮换（0.32 用户需求）：目录里的图定时换，随机或按文件名顺序。
              开启后背景图来自该目录（绝对路径），上面的「背景图片」选择暂时让位；
              关掉轮换自动落回仓库内选的图。 */}
          <Row
            label="壁纸轮换"
            desc="从选定的目录定时换背景图，可随机也可按文件名顺序。"
            tip="目录可以是电脑上的任意文件夹（不必在仓库里）。开启后背景图由轮换接管；界面浓度、模糊等参数照常生效。"
            keywords="背景 壁纸 轮换 换图 随机 顺序"
          >
            <input
              type="checkbox"
              checked={bg.bgRotateEnabled}
              disabled={!vault || !bg.bgRotateDir}
              onChange={(event) => saveBg({ bgRotateEnabled: event.target.checked })}
            />
          </Row>
          <Row
            label="壁纸目录"
            desc={bg.bgRotateDir ? bg.bgRotateDir : "选择一个放壁纸图片的文件夹（png/jpg/webp/gif/bmp）。"}
            keywords="背景 壁纸 目录 文件夹"
          >
            <span className="settings-inline">
              <button
                type="button"
                className="btn"
                disabled={!vault}
                onClick={async () => {
                  const picked = await pickDirectory("选择壁纸图片目录");
                  if (!picked) return;
                  // 换目录后清掉当前图：轮换立即从头选一张新目录里的图
                  saveBg({ bgRotateDir: picked, bgImageAbsPath: "" });
                }}
              >
                选择目录…
              </button>
              {bg.bgRotateDir && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => saveBg({ bgRotateDir: "", bgRotateEnabled: false, bgImageAbsPath: "" })}
                >
                  清除
                </button>
              )}
            </span>
          </Row>
          <Row label="轮换间隔" desc="每隔多少分钟换一张（1–1440）。" keywords="背景 轮换 间隔 时间 分钟">
            <input
              type="number"
              min={1}
              max={1440}
              step={1}
              value={bg.bgRotateMinutes}
              disabled={!vault || !bg.bgRotateDir}
              onChange={(event) => saveBg({ bgRotateMinutes: Number(event.target.value) || 30 })}
              onBlur={(event) => {
                const raw = Number(event.target.value);
                if (raw < 1 || raw > 1440 || !Number.isFinite(raw)) saveBg({ bgRotateMinutes: 30 });
              }}
              style={{ width: "72px" }}
            />
            <span style={{ marginLeft: 6, color: "var(--text-faint)" }}>分钟</span>
          </Row>
          <Row label="轮换方式" desc="随机挑一张（不与当前重复）或按文件名顺序下一张。" keywords="背景 轮换 随机 顺序">
            <SettingsSelect
              ariaLabel="轮换方式"
              value={bg.bgRotateMode}
              disabled={!vault || !bg.bgRotateDir}
              options={[
                { value: "random", label: "随机" },
                { value: "sequential", label: "按文件名顺序" },
              ]}
              onChange={(value) => saveBg({ bgRotateMode: value })}
            />
          </Row>
          {/* 背景预览：按当前参数实时渲染（0.26 规范五），开仓库且有图时出现。
              0.28 修：棋盘格此前是 z-index:-1 的 ::before，父级一加 filter 形成
              层叠上下文后，负层级子元素反而画在父级背景图之上，整块预览只剩
              棋盘格（用户反馈"预览失效"）。现在棋盘格是容器底色、图片是独立
              子层，层级写死不靠负 z-index。 */}
          {vault && (bg.bgRotateEnabled ? bg.bgImageAbsPath : bg.bgImagePath) && (
            <div className="settings-block bg-preview-block" data-keywords="背景 预览">
              <div className="bg-preview">
                <div
                  className="bg-preview-img"
                  style={{
                    // 轮换开着预览轮换当前图（绝对路径），否则仓库内选图——与
                    // background.ts 的取图优先级同口径
                    backgroundImage: `url("${convertFileSrc(
                      bg.bgRotateEnabled && bg.bgImageAbsPath
                        ? bg.bgImageAbsPath.trim()
                        : `${vault.replace(/[\\/]+$/, "")}/${bg.bgImagePath.trim().replace(/\\/g, "/")}`,
                    )}")`,
                    backgroundSize: bg.bgFit === "contain" ? "contain" : "cover",
                    backgroundPosition: `${bg.bgPosX}% ${bg.bgPosY}%`,
                    opacity: bg.bgOpacity,
                    // 与 background.ts 同口径（含 0.28 的锐化）
                    filter: bgFilterCss(bg),
                    transform: bg.bgScale !== 100 ? `scale(${bg.bgScale / 100})` : undefined,
                    transformOrigin: `${bg.bgPosX}% ${bg.bgPosY}%`,
                  }}
                />
                <span className="bg-preview-hint">背景预览（实际观感以界面为准）</span>
              </div>
            </div>
          )}
          <Row label="适配方式" desc="铺满裁剪（cover）/ 完整显示（contain）。" keywords="背景">
            <SettingsSelect
              ariaLabel="适配方式"
              value={bg.bgFit}
              disabled={!vault}
              options={[
                { value: "cover", label: "铺满裁剪（cover）" },
                { value: "contain", label: "完整显示（contain）" },
              ]}
              onChange={(value) => saveBg({ bgFit: value })}
            />
          </Row>
          <Row label="不透明度" desc="背景图整体的可见程度。" keywords="背景 淡 透明">
            <span className="settings-slider">
              <input
                type="range" min={0} max={100} step={5}
                value={Math.round(bg.bgOpacity * 100)}
                disabled={!vault}
                onChange={(event) => saveBg({ bgOpacity: Number(event.target.value) / 100 })}
              />
              <span className="settings-slider-value">{Math.round(bg.bgOpacity * 100)}%</span>
            </span>
          </Row>
          <Row label="模糊" desc="背景图的高斯模糊半径。" keywords="背景">
            <span className="settings-slider">
              <input
                type="range" min={0} max={30} step={1}
                value={bg.bgBlur}
                disabled={!vault}
                onChange={(event) => saveBg({ bgBlur: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{bg.bgBlur}px</span>
            </span>
          </Row>
          <Row
            label="清晰度"
            desc="锐化边缘，抵消低分辨率图片放大后的发虚。"
            keywords="背景 清晰 锐化"
            tip="背景图被 cover 放大到窗口尺寸后，浏览器插值会让边缘发软。这里用 3×3 卷积做锐化（不是单纯提对比度）；滑杆越大边缘越硬，拉满会有轻微白边。若整体仍觉得雾蒙蒙，多半是被界面浓度盖住了——把下面的「界面浓度」调低更直接。"
          >
            <span className="settings-slider">
              <input
                type="range" min={0} max={100} step={5}
                value={bg.bgSharpen}
                disabled={!vault}
                onChange={(event) => saveBg({ bgSharpen: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{bg.bgSharpen}%</span>
            </span>
          </Row>
          <Row label="亮度" desc="背景图的明暗。" keywords="背景">
            <span className="settings-slider">
              <input
                type="range" min={30} max={150} step={5}
                value={bg.bgBrightness}
                disabled={!vault}
                onChange={(event) => saveBg({ bgBrightness: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{bg.bgBrightness}%</span>
            </span>
          </Row>
          <Row label="对比度" desc="背景图的浓淡对比。" keywords="背景">
            <span className="settings-slider">
              <input
                type="range" min={30} max={150} step={5}
                value={bg.bgContrast}
                disabled={!vault}
                onChange={(event) => saveBg({ bgContrast: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{bg.bgContrast}%</span>
            </span>
          </Row>
          <Row label="水平位置" desc="图片的横向焦点。" keywords="背景">
            <span className="settings-slider">
              <input
                type="range" min={0} max={100} step={5}
                value={bg.bgPosX}
                disabled={!vault}
                onChange={(event) => saveBg({ bgPosX: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{bg.bgPosX}%</span>
            </span>
          </Row>
          <Row label="垂直位置" desc="图片的纵向焦点。" keywords="背景">
            <span className="settings-slider">
              <input
                type="range" min={0} max={100} step={5}
                value={bg.bgPosY}
                disabled={!vault}
                onChange={(event) => saveBg({ bgPosY: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{bg.bgPosY}%</span>
            </span>
          </Row>
          <Row label="缩放" desc="在适配基础上再放大/缩小。" keywords="背景">
            <span className="settings-slider">
              <input
                type="range" min={50} max={200} step={5}
                value={bg.bgScale}
                disabled={!vault}
                onChange={(event) => saveBg({ bgScale: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{bg.bgScale}%</span>
            </span>
          </Row>
          <Row
            label="界面浓度"
            desc="顶栏/侧栏/编辑器表面底色的浓度，调低背景更透出来。"
            keywords="背景 淡 透明 遮罩 看不见"
            tip="背景图上盖着一层半透明的界面底色保证正文可读——「不透明度」拉满背景还是淡，就是被它盖住了（0.29 用户反馈）。80 是默认观感；调低各表面更透、背景更明显，正文可读性随之下降，按自己眼睛的舒适度取值。"
          >
            <span className="settings-slider">
              <input
                type="range" min={0} max={100} step={5}
                value={bg.bgSurface ?? 80}
                disabled={!vault}
                onChange={(event) => saveBg({ bgSurface: Number(event.target.value) })}
              />
              <span className="settings-slider-value">{bg.bgSurface ?? 80}%</span>
            </span>
          </Row>
          </>
          )}
          <Group>自定义样式</Group>
          <div className="settings-block">
            <textarea
              className="custom-css-input"
              rows={6}
              spellCheck={false}
              value={customCssDraft}
              placeholder={"/* 覆盖 Markdown 渲染样式，例如： */\n.cm-lp-heading { font-weight: 500; }\n.cm-lp-table { font-size: 12px; }"}
              onChange={(event) => onCustomCssChange(event.target.value)}
            />
            <p className="settings-hint">
              即时注入并保存在本机（不进仓库），微调 Markdown 渲染。常用选择器：
              <code>.cm-content</code> 正文、<code>.cm-lp-heading</code> 标题、
              <code>.cm-lp-table</code> 表格、<code>.cm-lp-mermaid</code> 图。清空即恢复默认。
            </p>
          </div>
        </section>

        {/* 0.33.1：globalOnly（主页入口）下整个分区隐藏——日记目录/模板/提醒
            全是按仓库的设置 */}
        {!globalOnly && (
        <section className="settings-sec" data-sec="daily" style={{ display: searching || active === "daily" ? undefined : "none" }}>
          <Group>附件</Group>
          <Row
            label="附件保存目录"
            desc="粘贴图片/文件的保存目录（仓库内相对路径，留空即仓库根）。"
            tip="存在库内配置里（键名与插件相同：pastedImageFolder），两边换用不用设两次；同步开启后多台设备自动一致。改这里会写入库内文件。"
          >
            <input
              type="text"
              value={daily.settings.pastedImageFolder}
              placeholder="attachments（留空即仓库根目录）"
              onChange={(event) => daily.updateSettings({ pastedImageFolder: event.target.value })}
            />
          </Row>

          <Group>日记</Group>
          <Row label="日记目录" desc="日记按日期落在这个目录（仓库内相对路径）。">
            <input
              type="text"
              value={daily.settings.folder}
              placeholder="日记（留空即仓库根目录）"
              onChange={(event) => daily.updateSettings({ folder: event.target.value })}
            />
          </Row>
          <Row
            label="日期格式"
            desc="moment 语法，同时决定日记文件名与待办分桶。"
            tip="与插件同一套 moment 语法。模板支持 {{title}}、{{date}}、{{date:格式}}、{{week}}、{{time}}；未知占位符原样保留。日记与模板相关配置与插件共用一份，改动会写到库内文件。"
          >
            <input
              type="text"
              value={daily.settings.dateFormat}
              placeholder="YYYY-MM-DD"
              onChange={(event) => daily.updateSettings({ dateFormat: event.target.value })}
            />
          </Row>
          <Row label="启用日记模板" desc="新建日记时按模板初始化内容。">
            <input
              type="checkbox"
              checked={daily.settings.dailyTemplateEnabled}
              onChange={(event) =>
                daily.updateSettings({ dailyTemplateEnabled: event.target.checked })
              }
            />
          </Row>
          <Row label="日记模板文件" desc="模板路径（仓库内相对路径）。">
            <input
              type="text"
              value={daily.settings.dailyTemplatePath}
              placeholder="模板/日记模板.md"
              onChange={(event) => daily.updateSettings({ dailyTemplatePath: event.target.value })}
            />
          </Row>
          <Row label="启用周记模板" desc="新建周记时按模板初始化内容。">
            <input
              type="checkbox"
              checked={daily.settings.weeklyTemplateEnabled}
              onChange={(event) =>
                daily.updateSettings({ weeklyTemplateEnabled: event.target.checked })
              }
            />
          </Row>
          <Row label="周记模板文件" desc="模板路径（仓库内相对路径）。">
            <input
              type="text"
              value={daily.settings.weeklyTemplatePath}
              placeholder="模板/周记模板.md"
              onChange={(event) => daily.updateSettings({ weeklyTemplatePath: event.target.value })}
            />
          </Row>

          <Group>提醒</Group>
          <Row label="每天提醒添加待办" desc="到点用系统通知提醒记当日待办。">
            <input
              type="checkbox"
              checked={daily.settings.todoReminderEnabled}
              onChange={(event) =>
                daily.updateSettings({ todoReminderEnabled: event.target.checked })
              }
            />
          </Row>
          <Row label="提醒时间" desc="每日提醒的触发时刻（HH:mm）。">
            <input
              type="text"
              value={daily.settings.todoReminderTime}
              placeholder="08:00"
              onChange={(event) => daily.updateSettings({ todoReminderTime: event.target.value })}
            />
          </Row>
          <Row label="到点检查未完成待办" desc="只在当日确有未完成待办时触发。">
            <input
              type="checkbox"
              checked={daily.settings.checkReminderEnabled}
              onChange={(event) =>
                daily.updateSettings({ checkReminderEnabled: event.target.checked })
              }
            />
          </Row>
          <Row
            label="检查时间"
            desc="检查未完成待办的触发时刻（HH:mm）。"
            tip="两条提醒都以系统通知 + 界面提示的形式出现。启用时如果当天时间点已过，当天不再补提醒（从次日生效）。"
          >
            <input
              type="text"
              value={daily.settings.checkReminderTime}
              placeholder="21:00"
              onChange={(event) => daily.updateSettings({ checkReminderTime: event.target.value })}
            />
          </Row>

          <Group>天气</Group>
          <Row
            label="新建日记时写入天气"
            desc="以引用行（> ☀️ 晴 25°C）插在 frontmatter 之后。"
            tip="数据来自 Open-Meteo（免费、无需 API key）。新建日记时抓取一次；抓取失败会静默跳过，绝不阻塞日记创建。"
          >
            <input
              type="checkbox"
              checked={daily.settings.weatherEnabled}
              onChange={(event) => daily.updateSettings({ weatherEnabled: event.target.checked })}
            />
          </Row>
          <Row label="城市" desc="天气查询的城市名。">
            <input
              type="text"
              value={daily.settings.weatherCity}
              placeholder="北京"
              onChange={(event) => daily.updateSettings({ weatherCity: event.target.value })}
            />
          </Row>
          <p className="settings-hint">
            附件、日记与提醒配置写入库内 {DAILY_CONFIG_FILE}，与 Obsidian 插件共用。
          </p>
        </section>
        )}

        <section className="settings-sec" data-sec="sync" style={{ display: searching || active === "sync" ? undefined : "none" }}>
          <Group>云同步（本机设置，不会写进仓库）</Group>
          <Row label="启用自动同步" desc="与 Obsidian 插件共用同一个云端仓库。">
            <input
              type="checkbox"
              checked={sync.config.enabled}
              onChange={(event) => sync.updateConfig({ enabled: event.target.checked })}
            />
          </Row>
          <Row label="服务端地址" desc="自建同步服务的地址（http(s)://host:port）。">
            <input
              type="text"
              value={sync.config.serverUrl}
              placeholder="http://your-server:8080"
              onChange={(event) => sync.updateConfig({ serverUrl: event.target.value })}
            />
          </Row>
          <Row label="账号" desc="登录同步服务的账号。">
            <input
              type="text"
              value={sync.config.username}
              autoComplete="off"
              onChange={(event) => sync.updateConfig({ username: event.target.value })}
            />
          </Row>
          <Row label="密码" desc="登录同步服务的密码（只存本机）。">
            <input
              type="password"
              value={sync.config.password}
              autoComplete="off"
              onChange={(event) => sync.updateConfig({ password: event.target.value })}
            />
          </Row>
          <Row label="推送范围" desc="仅日记目录或整个仓库。">
            <SettingsSelect
              ariaLabel="推送范围"
              value={sync.config.scope}
              options={[
                { value: "folder", label: "仅日记目录" },
                { value: "vault", label: "整个仓库" },
              ]}
              onChange={(value) => sync.updateConfig({ scope: value })}
            />
          </Row>
          {/* 0.33.1：globalOnly 下隐藏——云端仓库名是按仓库的字段、同步动作
              操作当前仓库（主页视角没有当前仓库） */}
          {!globalOnly && (
          <>
          <Row
            label="云端仓库名"
            desc="留空即用仓库文件夹名。"
            tip="仓库名要与插件所在库的名字一致，否则会同步到另一个云端仓库（表现为「同步成功但数据没过来」）。正文、待办与附件（按笔记引用上传、本地缺的从云端补下）都会同步；服务端地址、账号与密码只存在本机，不会写进仓库。"
          >
            <input
              type="text"
              value={sync.config.vaultName}
              placeholder={`留空即用仓库文件夹名：${sync.vaultName}`}
              onChange={(event) => sync.updateConfig({ vaultName: event.target.value })}
            />
          </Row>
          <SyncActions sync={sync} />
          </>
          )}
        </section>

        <section className="settings-sec" data-sec="storage" style={{ display: searching || active === "storage" ? undefined : "none" }}>
          {vaultHome !== null && (
            <>
              <Group>仓库基础目录</Group>
              <div className="settings-row storage-row">
                <span>仓库基础目录</span>
                <span className="settings-value storage-path">{vaultHome}</span>
              </div>
              <div className="settings-actions">
                <button type="button" className="btn" onClick={onOpenVaultPage}>
                  打开仓库列表…
                </button>
              </div>
              <p className="settings-hint">
                它里面的每个子文件夹都是一个独立仓库，与电脑端共用同一份文件。
                换基础目录在仓库列表页的「更改基础目录」里操作。
              </p>
            </>
          )}
          <Group>数据目录</Group>
          <div className="settings-row storage-row" data-keywords="数据目录 配置目录 路径">
            <span>当前数据目录</span>
            <span className="settings-value storage-path">{dataPaths?.webview_data_dir ?? "…"}</span>
          </div>
          <div className="settings-row storage-row" data-keywords="数据目录 自定义">
            <span>自定义数据目录</span>
            <span className="settings-value storage-path">
              {dataPaths?.custom_data_dir ?? "（未设置，使用默认位置）"}
            </span>
          </div>
          <div className="settings-row storage-row" data-keywords="配置目录 同步状态">
            <span>配置目录</span>
            <span className="settings-value storage-path">{dataPaths?.config_dir ?? "…"}</span>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="btn"
              title="在系统资源管理器中打开数据目录"
              onClick={() => {
                const dir = dataPaths?.webview_data_dir;
                if (dir) void import("@tauri-apps/plugin-opener").then(({ openPath }) => openPath(dir));
              }}
            >
              打开目录
            </button>
            <button type="button" className="btn" onClick={onPickDataDir}>
              选择目录…
            </button>
            <button
              type="button"
              className="btn"
              onClick={onClearDataDir}
              disabled={!dataPaths?.custom_data_dir}
            >
              恢复默认
            </button>
          </div>
          <p className="settings-hint">
            应用设置、快捷键、收藏、最近打开与缓存都在「数据目录」里。选定自定义位置后
            <b>重启应用生效</b>，启用时会自动把现有数据搬过去；「恢复默认」同样重启后回原位。
            笔记永远保存在仓库目录里，不受这个设置影响。
          </p>
          <Group>数据统计</Group>
          <div className="settings-row storage-row" data-keywords="统计 笔记 数量">
            <span>笔记数量</span>
            <span className="settings-value">{noteCount ?? "…"}</span>
          </div>
          <div className="settings-row storage-row" data-keywords="统计 附件 数量">
            <span>附件数量</span>
            <span className="settings-value">{attachmentCount ?? "…"}</span>
          </div>
          <div className="settings-row storage-row" data-keywords="缓存 大小 清理">
            <span>缓存大小</span>
            <span className="settings-value">
              {cacheStat ? `${formatBytes(cacheStat.bytes)}（${cacheStat.files} 个文件）` : "…"}
            </span>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="btn"
              disabled={cacheBusy || !cacheStat}
              onClick={() => void clearCacheNow()}
              title="清理 WebView 的 HTTP/代码/GPU 缓存（登录态与本地数据不受影响）"
            >
              {cacheBusy ? "清理中…" : "清理缓存"}
            </button>
          </div>
        </section>

                {active === "shortcuts" && (
          <section className="settings-sec" data-sec="shortcuts">
            <HotkeysPane />
          </section>
        )}

        <section className="settings-sec" data-sec="about" style={{ display: searching || active === "about" ? undefined : "none" }}>
          <div className="settings-block about-hero" data-keywords="版本 logo 简介">
            <img src="/qn-icon.png" alt="" className="about-logo" aria-hidden />
            <div className="about-hero-text">
              <span className="about-name">Quick Note</span>
              <span className="about-version">v{appVersion || "…"}</span>
              <span className="about-tagline">一个本地优先的个人知识管理系统</span>
            </div>
          </div>
          <Group>软件更新</Group>
          <div className="settings-row storage-row" data-keywords="更新 版本 检查">
            <span>当前版本</span>
            <span className="settings-value">v{appVersion || "…"}</span>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={updateCheck.state === "checking" || updateCheck.state === "downloading"}
              onClick={() => void checkUpdate()}
            >
              {updateCheck.state === "checking" ? "检查中…" : "检查更新"}
            </button>
            {updateCheck.available && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={updateCheck.state === "downloading"}
                onClick={() => void installUpdate()}
              >
                {updateCheck.state === "downloading"
                  ? "下载中…"
                  : updateCheck.state === "error"
                    ? "重试更新"
                    : "立即更新"}
              </button>
            )}
          </div>
          {updateCheck.state !== "idle" && (
            <p className={`settings-hint${updateCheck.state === "error" ? " hint-error" : ""}`}>
              {updateCheck.message}
            </p>
          )}
          <Group>资源</Group>
          <div className="settings-actions about-links" data-keywords="github 文档 反馈 许可">
            <button type="button" className="btn" onClick={() => void openReleasePage("https://github.com/456-77/quick-note")}>
              GitHub
            </button>
            <button type="button" className="btn" onClick={() => void openReleasePage()}>
              发布页
            </button>
            <button type="button" className="btn" onClick={() => void openReleasePage("https://github.com/456-77/quick-note#readme")}>
              使用文档
            </button>
            <button type="button" className="btn" onClick={() => void openReleasePage("https://github.com/456-77/quick-note/issues")}>
              问题反馈
            </button>
          </div>
          <p className="settings-hint">
            Quick Note — 本地优先的个人知识管理系统。文件保持纯 Markdown，
            可与 Obsidian 及 quick-daily-note 插件共用同一个仓库并同步。
          </p>
        </section>
      </div>
    </div>
  );
}

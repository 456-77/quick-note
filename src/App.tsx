import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import moment from "moment";
import type { Moment } from "moment";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CalendarPanel from "./components/CalendarPanel";
import CommandPalette, { type PaletteAction } from "./components/CommandPalette";
import FilePreview from "./components/FilePreview";
import FileTree from "./components/FileTree";
import ImageCropDialog from "./components/ImageCropDialog";
import OutlinePanel from "./components/OutlinePanel";
import SettingsDialog from "./components/SettingsDialog";
import StatsPanel from "./components/StatsPanel";
import TagPopover from "./components/TagPopover";
import WeekReviewDialog from "./components/WeekReviewDialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  IconCalendar,
  IconCalendarPlus,
  IconChart,
  IconClock,
  IconCode,
  IconCopy,
  IconEye,
  IconFocus,
  IconFolderPlus,
  IconLibrary,
  IconListTree,
  IconMinus,
  IconPanelLeft,
  IconPanelRight,
  IconPin,
  IconPlus,
  IconSave,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSquare,
  IconStar,
  IconTag,
  IconX,
} from "./components/icons";
import { allowAssetDir, appDataPaths, copyEntry, copyExternalIntoVault, copyPathsToClipboard, createFolder, createNote, deleteEntry, listEntries, moveEntry, onVaultChanged, pickDirectory, pickVault, readBinary, readClipboardFilePaths, readNote, readNoteOptional, renameEntry, searchVault, setCustomDataDir, startupFile, startupVault, watchVault, writeAttachment, writeNote } from "./lib/api";
import type { AppDataPaths, EntryMeta, NoteContent } from "./lib/api";
import { applyMode, applyDarkTheme, createEditor, createEditorState, type ViewMode } from "./lib/editor";
import { editorLanguageOf, fileKindOf, isMarkdownPath } from "./lib/fileTypes";
import { normalizeTagName, noteTags, tagAddEdit, tagRemoveEdit } from "./lib/tags";
import { toBase64 } from "./lib/paste";
import { lineEndingLabel } from "./lib/lineEndings";
import { clearEmbedCache } from "./lib/embed";
import { requestDecorationRefresh, setMermaidNotice } from "./lib/livePreview";
import { blockInsertPadding, type CodePasteOptions } from "./lib/paste";
import { resolveWikiRelative, type LivePreviewContext } from "./lib/paths";
import { menuRefClampedToViewport } from "./lib/menuClamp";
import { getSettings, updateSettings, takeLegacyAttachmentFolder, type Settings } from "./lib/settings";
import { allBindings, formatKey, matchCommand, onHotkeysChange } from "./lib/hotkeys";
import { checkForUpdate, checkViaPlugin, installAndRelaunch, type Update } from "./lib/updater";
import { applyCustomCss, getCustomCss, saveCustomCss } from "./lib/customCss";
import { getVersion } from "@tauri-apps/api/app";
import { applyTheme, resolveTheme, watchSystemTheme } from "./lib/theme";
import { applyBackground } from "./lib/background";
import { dueReminders, initialFiredMarks, type ReminderFired } from "./lib/reminders";
import { fetchWeather, insertWeatherLine } from "./lib/weather";
import { blobTypeOf, removeImageReferences } from "./lib/imageOps";
import { buildWeeklyReview, weekdayZh, type ReviewDiary } from "./lib/weeklyReview";
import { exportNoteToPdf } from "./lib/printExport";
import { baseNameOf, wordCount } from "./lib/daily";
import { liveItems } from "./lib/todos";
import {
  DAILY_CONFIG_FILE,
  dailyNotePath,
  dailyRenameName,
  dailyTitle,
  defaultNoteContent,
  expandTemplate,
  parseDateStrict,
  validateDailyName,
  weeklyNotePath,
  weeklyTitle,
} from "./lib/daily";
import {
  deleteColumnAtCursor,
  deleteRowAtCursor,
  formatTableAtCursor,
  insertColumnLeft,
  insertColumnRight,
  insertRowAbove,
  insertRowBelow,
  isCursorInTable,
} from "./lib/tableEdit";
import { useDaily } from "./lib/useDaily";
import { useSync, type SyncController } from "./lib/useSync";
import "./styles.css";

const VAULT_KEY = "quicknote.vault";
const FAVORITES_V2_KEY = "quicknote.favorites.v2";
/** 固定标签页的存储键（按仓库分桶，同收藏）。 */
const PINNED_TABS_KEY = "quicknote.ui.pinnedTabs";

const MODE_KEY = "quicknote.mode";
const SIDEBAR_KEY = "quicknote.sidebar";
/** 停止输入多久后自动保存。写盘前会比较内容，未变则不触碰文件。 */
const AUTOSAVE_DELAY = 1200;

export default function App() {
  const [vault, setVault] = useState<string | null>(null);
  /** 仓库条目（含目录与非 md 文件）。一份数据供文件树、wiki 索引、计数共用。 */
  const [entries, setEntries] = useState<EntryMeta[]>([]);
  /**
   * 打开的标签页（顺序即显示顺序）。
   *
   * 每个标签的**未保存内容与撤销历史**存在它的 EditorState 里（stateStore），
   * meta（路径/哈希/换行符等）存在这里；`current` 是激活标签的 meta。
   */
  const [openTabs, setOpenTabs] = useState<NoteContent[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [roundTrip, setRoundTrip] = useState<string | null>(null);
  /** 外部改动与未保存编辑冲突时的磁盘版本，等待用户抉择。 */
  const [conflict, setConflict] = useState<NoteContent | null>(null);
  const [mode, setMode] = useState<ViewMode>(() =>
    localStorage.getItem(MODE_KEY) === "source" ? "source" : "live",
  );
  const [settings, setSettings] = useState<Settings>(getSettings);
  const [showSettings, setShowSettings] = useState(false);
  /** 正在新建的类型；null 表示输入行未展开。diary = 按日期命名的新日记。 */
  const [creating, setCreating] = useState<"note" | "folder" | "diary" | null>(null);
  /** 右键「新建笔记」指定的目标目录；空串 = 按当前笔记所在目录（或仓库根）。 */
  const [createFolderOverride, setCreateFolderOverride] = useState("");
  /** 正在重命名的条目路径；与 creating 共用同一行输入。 */
  const [renaming, setRenaming] = useState<string | null>(null);
  /**
   * 重命名输入行渲染在哪一侧：tree = 左侧栏（文件树发起），daily = 右侧面板
   * （当天日记发起）。此前不区分——从右面板点重命名，输入框却出现在左栏，
   * 左栏收起时用户根本找不到输入框。
   */
  const [renameOwner, setRenameOwner] = useState<"tree" | "daily">("tree");
  const [draft, setDraft] = useState("");
  /** 右键菜单：条目路径 + 是否目录 + 鼠标位置 + 发起面板（重命名输入行跟发起处走）。 */
  const [menu, setMenu] = useState<{
    path: string;
    isDir: boolean;
    x: number;
    y: number;
    origin?: "tree" | "daily";
  } | null>(null);
  /** 待确认的删除。删笔记不可逆，先问一次。 */
  const [pendingDelete, setPendingDelete] = useState<{ path: string; isDir: boolean } | null>(null);
  /**
   * 右侧面板当前页签：日历 / 目录 / 统计。
   *
   * 布局与 Obsidian 对齐：文件树常驻左侧；围绕当前笔记的面板（日记、目录）
   * 与知识库统计放右侧。
   */
  const [rightPanel, setRightPanel] = useState<"daily" | "outline" | "stats">(() => {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    return stored === "outline" || stored === "stats" ? stored : "daily";
  });
  /** 左侧文件树的名称过滤（空串 = 显示完整目录树）。 */
  const [treeFilter, setTreeFilter] = useState("");
  /** 全局命令面板（Ctrl+K）开关。 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 左栏视图：知识库 / 收藏 / 最近。 */
  const [leftView, setLeftView] = useState<"files" | "favorites" | "recents">("files");
  /** 收藏的笔记（本机 localStorage，**按仓库分桶**：切换仓库各看各的收藏）。 */
  const [favorites, setFavorites] = useState<string[]>([]);
  /** 最近打开的笔记（本机 localStorage，新的在前）。 */
  const [recents, setRecents] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("quicknote.recents");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  /** 最近打开的仓库（本机 localStorage，新的在前）。顶栏仓库下拉的候选。 */
  const [vaultRecents, setVaultRecents] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("quicknote.vaultRecents");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  /** 顶栏仓库下拉菜单（打开状态 + 锚点位置）。 */
  const [vaultMenu, setVaultMenu] = useState<{ x: number; y: number } | null>(null);
  /** 应用数据目录信息（设置 → 存储）。 */
  const [dataPaths, setDataPaths] = useState<AppDataPaths | null>(null);
  /** 预览窗格：打开的 pdf/docx/xlsx 路径（不进标签，独立浮层）。 */
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  /** 知识库内"复制"的文件（Ctrl+V 粘贴进选中的目录；同时已写入系统剪贴板）。 */
  const [treeClipboard, setTreeClipboard] = useState<{ path: string; isDir: boolean } | null>(null);
  /** 左侧树当前选中的目录（粘贴目标）。 */
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  /** 专注模式：隐藏两侧栏与状态栏（Ctrl+Shift+F）。 */
  const [zen, setZen] = useState(false);
  /** 光标是否在表格块内（表格工具栏的显示依据）。 */
  const [inTable, setInTable] = useState(false);
  /** 光标所在行（0 基；目录面板高亮当前标题）。 */
  const [cursorLine, setCursorLine] = useState(0);
  /** 左右栏收起状态（Obsidian 式；持久化）。 */
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem("quicknote.ui.leftCollapsed") === "1",
  );
  const [rightCollapsed, setRightCollapsed] = useState(
    () => localStorage.getItem("quicknote.ui.rightCollapsed") === "1",
  );
  /** 自定义样式内容（设置面板 textarea 的值）。 */
  const [customCssDraft, setCustomCssDraft] = useState(() => getCustomCss());
  /** 周回顾的选周弹窗（M4）。 */
  const [weekDialogOpen, setWeekDialogOpen] = useState(false);
  /** 正在裁剪的图片（仓库相对路径；null = 弹窗关闭）。 */
  const [cropPath, setCropPath] = useState<string | null>(null);
  /** 标签页右键菜单（固定 / 关闭左侧·右侧·其他·全部）。 */
  const [tabMenu, setTabMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  /** 固定的标签页路径（本机 localStorage 按仓库分桶）。固定 = 置顶显示、不可误关。 */
  const [pinnedTabs, setPinnedTabs] = useState<string[]>([]);

  /** 激活标签的 meta。其余标签的未保存内容在各自的 EditorState 里。 */
  const current = useMemo(
    () => openTabs.find((tab) => tab.path === activeTab) ?? null,
    [openTabs, activeTab],
  );

  const pinnedSet = useMemo(() => new Set(pinnedTabs), [pinnedTabs]);
  /** 标签栏显示顺序：固定标签置顶（其余保持打开顺序）。右键菜单的左右侧也按它算。 */
  const orderedOpenTabs = useMemo(() => {
    if (pinnedSet.size === 0) return openTabs;
    const pinned = openTabs.filter((tab) => pinnedSet.has(tab.path));
    const rest = openTabs.filter((tab) => !pinnedSet.has(tab.path));
    return pinned.length > 0 ? [...pinned, ...rest] : rest;
  }, [openTabs, pinnedSet]);

  const applySettings = useCallback((patch: Partial<Settings>) => {
    setSettings(updateSettings(patch));
  }, []);

  // ---------------------------------------------------------------- 窗口控制

  /** 无边框窗口：自绘最小化 / 最大化（还原）/ 关闭，顶栏即标题栏。 */
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void appWindow
      .isMaximized()
      .then((value) => {
        if (!cancelled) setMaximized(value);
      })
      .catch(() => {});
    appWindow
      .onResized(() => {
        void appWindow
          .isMaximized()
          .then(setMaximized)
          .catch(() => {});
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appWindow]);

  // 窗口置顶（悬浮钉住）：持久化在 localStorage，启动时恢复。
  const [alwaysOnTop, setAlwaysOnTop] = useState(() => localStorage.getItem("quicknote.alwaysOnTop") === "1");
  useEffect(() => {
    localStorage.setItem("quicknote.alwaysOnTop", alwaysOnTop ? "1" : "0");
    appWindow.setAlwaysOnTop(alwaysOnTop).catch(() => {});
  }, [alwaysOnTop, appWindow]);

  // ---------------------------------------------------------------- 收藏与最近

  // 收藏按仓库分桶存储（键 = 仓库绝对路径），切换仓库各看各的收藏。
  // 旧版是扁平数组（不区分仓库，切仓后互相串）：首次遇到某仓库时把旧数据
  // 整体迁移给它——旧收藏本来就主要是在主仓库里攒的。
  useEffect(() => {
    if (!vault) return;
    try {
      const raw = localStorage.getItem(FAVORITES_V2_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      if (map[vault]) {
        setFavorites(map[vault]);
        return;
      }
      const legacy = localStorage.getItem("quicknote.favorites");
      const list = legacy ? (JSON.parse(legacy) as string[]) : [];
      map[vault] = list;
      localStorage.setItem(FAVORITES_V2_KEY, JSON.stringify(map));
      setFavorites(list);
    } catch {
      setFavorites([]);
    }
  }, [vault]);

  // 固定标签与收藏一样按仓库分桶：切仓库各看各的固定。
  useEffect(() => {
    if (!vault) return;
    try {
      const raw = localStorage.getItem(PINNED_TABS_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      setPinnedTabs(map[vault] ?? []);
    } catch {
      setPinnedTabs([]);
    }
  }, [vault]);

  // 固定列表变化就写回分桶存储（rename/move 的换键也走这里落盘）
  useEffect(() => {
    if (!vault) return;
    try {
      const raw = localStorage.getItem(PINNED_TABS_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      map[vault] = pinnedTabs;
      localStorage.setItem(PINNED_TABS_KEY, JSON.stringify(map));
    } catch {
      // 存不进去只影响下次启动的固定状态
    }
  }, [pinnedTabs, vault]);

  const persistFavorites = useCallback(
    (next: string[]) => {
      try {
        const raw = localStorage.getItem(FAVORITES_V2_KEY);
        const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
        if (vault) map[vault] = next;
        localStorage.setItem(FAVORITES_V2_KEY, JSON.stringify(map));
      } catch {
        // 存不进去只影响下次启动的列表，不打断操作
      }
      setFavorites(next);
    },
    [vault],
  );

  const toggleFavorite = useCallback(
    (path: string) => {
      const wasFavorite = favorites.includes(path);
      const next = wasFavorite ? favorites.filter((p) => p !== path) : [...favorites, path];
      setFavorites(next);
      persistFavorites(next);
      setStatus(wasFavorite ? "已取消收藏" : "已收藏");
    },
    [favorites, persistFavorites],
  );

  /** 固定/取消固定标签：固定后置顶显示、不响应关闭，直到取消固定。 */
  const togglePinTab = useCallback((path: string) => {
    setPinnedTabs((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  }, []);

  /**
   * 当前仓库里真实存在的文件路径（收藏只对这些有意义）。
   *
   * 收藏是本机 localStorage 持久化的相对路径：换电脑、换仓库路径、别的机器上
   * 删过文件，都会让存量收藏指向已不存在的文件——收藏列表只显示还存在的，
   * 但角标如果直接数 favorites.length 就会对不上（迁移来的旧数据尤其明显）。
   * 收藏不限于 md：pdf/docx/图片等预览类文件同样可收藏。
   */
  const existingNotePaths = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDir) set.add(entry.path);
    }
    return set;
  }, [entries]);

  /** 去重 + 只保留真实存在条目的收藏列表：角标与收藏视图都用它。 */
  const visibleFavorites = useMemo(() => {
    const seen = new Set<string>();
    return favorites.filter((p) => {
      if (seen.has(p) || !existingNotePaths.has(p)) return false;
      seen.add(p);
      return true;
    });
  }, [favorites, existingNotePaths]);

  const recordRecent = useCallback((path: string) => {
    setRecents((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 15);
      try {
        localStorage.setItem("quicknote.recents", JSON.stringify(next));
      } catch {
        // 同上：列表丢一次不如打断打开笔记
      }
      return next;
    });
  }, []);

  /** 记录一个仓库到「最近打开的仓库」（顶栏下拉的候选，最多 8 个）。 */
  const recordVault = useCallback((dir: string) => {
    setVaultRecents((prev) => {
      const next = [dir, ...prev.filter((p) => p !== dir)].slice(0, 8);
      try {
        localStorage.setItem("quicknote.vaultRecents", JSON.stringify(next));
      } catch {
        // 存不进去只影响下次启动的下拉列表
      }
      return next;
    });
  }, []);

  // ---------------------------------------------------------------- 软件更新

  const [appVersion, setAppVersion] = useState("");
  const [updateCheck, setUpdateCheck] = useState<{
    state: "idle" | "checking" | "done" | "error" | "downloading" | "installing";
    message: string;
    url?: string;
    /** 插件检查发现的新版本（拿到 Update 对象才能走应用内安装）。 */
    available?: boolean;
    /** 新版本介绍（latest.json 的 notes / GitHub release body），更新弹窗展示。 */
    notes?: string;
    /** 更新提示条是否被用户关掉（关掉后本次启动不再弹）。 */
    dismissed?: boolean;
  }>({ state: "idle", message: "" });
  /** updater 插件的 Update 对象：下载安装必须用它。 */
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

  // 自定义样式：启动注入一次，之后由设置面板即时更新
  useEffect(() => {
    applyCustomCss(getCustomCss());
  }, []);

  useEffect(() => {
    localStorage.setItem("quicknote.ui.leftCollapsed", leftCollapsed ? "1" : "0");
  }, [leftCollapsed]);

  // 展开左栏时把水平滚动复位。收起状态下（宽 0、内容仍占位）焦点可能把容器的
  // scrollLeft 顶开，展开后表现为面板内容整体左移、右侧"被截断"，重启才恢复。
  useEffect(() => {
    if (!leftCollapsed) sidebarLeftRef.current?.scrollTo({ left: 0 });
  }, [leftCollapsed]);

  useEffect(() => {
    localStorage.setItem("quicknote.ui.rightCollapsed", rightCollapsed ? "1" : "0");
  }, [rightCollapsed]);

  const checkUpdate = useCallback(async () => {
    setUpdateCheck({ state: "checking", message: "正在检查更新…" });
    try {
      // 先走 updater 插件（latest.json）：发现新版本时能直接在应用内安装
      const update = await checkViaPlugin();
      if (update) {
        updateRef.current = update;
        setUpdateCheck({
          state: "done",
          message: `发现新版本 v${update.version}（当前 v${appVersion}），可直接更新`,
          available: true,
          notes: update.body ?? "",
        });
        return;
      }
    } catch {
      // 插件检查失败（端点还没有 latest.json 等）——回退到 GitHub API 比较
    }
    try {
      const info = await checkForUpdate(appVersion || "0.0.0");
      setUpdateCheck(
        info.newer
          ? { state: "done", message: `发现新版本 v${info.latest}（当前 v${appVersion}），可到发布页下载`, url: info.url, notes: info.body }
          : { state: "done", message: `已是最新版本（最新发布 v${info.latest}）` },
      );
    } catch (e) {
      setUpdateCheck({ state: "error", message: `检查更新失败：${e}` });
    }
  }, [appVersion]);

  /** 应用内更新：下载（带进度）→ 静默安装 → 重启。 */
  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    try {
      await installAndRelaunch(update, (pct) => {
        setUpdateCheck({ state: "downloading", message: `正在下载更新… ${pct}%`, available: true });
      });
    } catch (e) {
      setUpdateCheck({ state: "error", message: `更新失败：${e}` });
    }
  }, []);

  // 启动后延迟几秒自动检查一次更新（静默；发现新版本时弹提示条）
  useEffect(() => {
    const timer = setTimeout(() => {
      void checkUpdate();
    }, 4000);
    return () => clearTimeout(timer);
  }, [checkUpdate]);

  const openReleasePage = useCallback(async (url?: string) => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url ?? "https://github.com/456-77/quick-note/releases/latest");
    } catch (e) {
      setError(`打开发布页失败：${e}`);
    }
  }, []);

  /**
   * 状态提示。日历面板（配置读写、待办升级）与编辑器共用同一条提示通道，
   * 否则那些消息会没有落脚处。
   */
  const notice = useCallback((message: string, kind?: "info" | "error") => {
    if (kind === "error") setError(message);
    else setStatus(message);
  }, []);

  /** 仓库内的 `.md` 路径：日历靠它发现日记、打点与统计。 */
  const mdFiles = useMemo(
    () =>
      entries
        .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md"))
        .map((entry) => entry.path),
    [entries],
  );

  /** 仓库内的图片（背景图下拉框的候选）。 */
  const vaultImages = useMemo(
    () =>
      entries
        .filter((entry) => !entry.isDir && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(entry.name))
        .map((entry) => entry.path)
        .sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    [entries],
  );

  // 待办的改动回调要在 useSync 之前挂上，所以先用一个占位 ref 接住它（回调是
  // 惰性读取的，等真正触发时 ref 早已填好）。
  const syncRef = useRef<SyncController | null>(null);
  // 编辑器引用要提前声明：useDaily 的 liveWords 回调（今日字数实时源）在渲染期
  // 就要读激活的编辑器状态，而编辑器实例在下面的 effect 里才创建。
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sidebarLeftRef = useRef<HTMLElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const daily = useDaily({
    vault,
    files: mdFiles,
    notice,
    // 待办不落盘、没有文件事件，改完要主动通知同步引擎（它按内容哈希决定推不推）
    onTodosChanged: () => syncRef.current?.touchVirtual(),
    // 今日字数实时源：激活标签是今天那篇日记时，直接按编辑器内容计算
    liveWords: {
      path: current?.path ?? null,
      getWords: () => {
        const view = viewRef.current;
        return view ? wordCount(view.state.sliceDoc()) : null;
      },
    },
  });

  const sync = useSync({
    vault,
    folder: daily.settings.folder,
    todoSnapshot: daily.todoSnapshot,
    mergeTodoSnapshot: daily.mergeTodoSnapshot,
    // 背景图片是纯观感文件（且往往不小），不参与云同步
    excludedSyncPaths: () => {
      const p = settings.bgImagePath?.trim();
      return p ? [p] : [];
    },
    notice,
  });

  // 文件监听的回调只订阅一次，所以要经 ref 读最新的控制器（它的回调每次都新建）。
  const dailyRef = useRef(daily);
  useEffect(() => {
    dailyRef.current = daily;
  }, [daily]);

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  // 主题：应用设置里的模式，并在「跟随系统」时跟着系统变。
  // 「跟随系统」在这里解析成具体明暗，CSS 里就只需要一份深色色板。
  useEffect(() => {
    const sync = () => {
      const resolved = applyTheme(getSettings().theme);
      const view = viewRef.current;
      if (view) applyDarkTheme(view, resolved === "dark");
    };
    sync();
    const unwatch = watchSystemTheme(sync);
    return () => unwatch();
  }, [settings.theme]);

  // 全局背景（M4）：设置或仓库变化时重铺；图片走 asset 协议，路径是仓库内的相对路径。
  useEffect(() => {
    applyBackground(settings, vault);
  }, [settings, vault]);

  // 行号显示开关：gutter 的显隐走 html 类（CSS 见 styles.css 的 qn-line-numbers）。
  useEffect(() => {
    document.documentElement.classList.toggle("qn-line-numbers", settings.showLineNumbers);
  }, [settings.showLineNumbers]);

  // Markdown 渲染风格（默认 / Blue Topaz 风）：同样走 html 类切换整套覆盖样式。
  useEffect(() => {
    document.documentElement.classList.toggle(
      "qn-style-bluetopaz",
      settings.renderStyle === "blueTopaz",
    );
  }, [settings.renderStyle]);

  /**
   * 粘贴附件的配置。刻意用读实时设置的函数而不是快照值：扩展在编辑器状态创建时
   * 就固化了，用快照的话改设置要重开文件才生效。
   *
   * 附件目录读**库内配置**（与插件共用 `pastedImageFolder`）：两边换用不用设两次。
   * 粘贴开关与链接写法是 Quick Note 自己的行为偏好，仍在本机设置里。
   */
  const attachmentOptions = useMemo(
    () => ({
      enabled: () => getSettings().savePastedAttachments,
      folder: () => dailyRef.current.settings.pastedImageFolder,
      linkFormat: () => getSettings().linkFormat,
      notice: (message: string, kind?: "info" | "error") => {
        if (kind === "error") setError(message);
        else setStatus(message);
      },
    }),
    [],
  );

  /**
   * 粘贴代码自动识别（M4）。开关读**库内配置**（与插件同一份 `autoDetectCodeLang`），
   * 与附件粘贴同一套「实时读取」约定。
   */
  const codePasteOptions = useMemo<CodePasteOptions>(
    () => ({
      enabled: () => dailyRef.current.settings.autoDetectCodeLang,
      notice: (message: string) => setStatus(message),
    }),
    [],
  );

  // mermaid 导出等图表操作的提示走统一的通知通道
  useEffect(() => {
    setMermaidNotice((message, kind) => {
      if (kind === "error") setError(message);
      else setStatus(message);
    });
  }, []);

  const saveRef = useRef<() => void>(() => {});
  // 事件回调里要读最新状态，但又不想因此反复重新订阅，所以用 ref 镜像。
  const currentRef = useRef<NoteContent | null>(null);
  const dirtyRef = useRef(false);
  const changeHandlerRef = useRef<(paths: string[]) => void>(() => {});
  const refreshTimer = useRef<number | null>(null);

  /**
   * 每个标签一份 EditorState：未保存内容、光标、撤销历史都在里面。
   * 切换标签 = view.setState(存量状态)，这是多标签下"离开再回来内容还在"的全部机制。
   * 滚动位置 State 不携带，单独存。
   */
  const stateStore = useRef(new Map<string, EditorState>());
  const scrollStore = useRef(new Map<string, number>());
  /** 后台标签的文件在外部被改过：等它再次激活时与磁盘对账（见 openNote 的 stale 分支）。 */
  const staleTabs = useRef(new Set<string>());
  /** 有未保存内容的标签。激活中的那份记在 dirty state；后台的记在这里。 */
  const dirtyTabs = useRef(new Set<string>());
  const activeTabRef = useRef<string | null>(null);
  /**
   * 视图当前显示的是哪个路径的内容。**同步更新**，不等 React 提交——
   * currentRef/activeTabRef 要到渲染后才对齐，重命名换键这类同步流程需要
   * 「此刻编辑器里的内容属于谁」的准确答案（见 handleDocChanged 与 submitRename）。
   */
  const viewOwnerRef = useRef<string | null>(null);
  const openTabsRef = useRef<NoteContent[]>([]);
  /** 固定标签的实时镜像：closeTab 等回调里避免为它重建闭包。 */
  const pinnedTabsRef = useRef<Set<string>>(new Set());
  const modeRef = useRef(mode);
  /**
   * 编辑器状态里携带的资源上下文。
   *
   * 刻意用**同一个可变对象**：facet 在状态创建时就捕获了这个引用，之后要更新仓库路径、
   * 文件索引或代际，只能就地改字段；换成新对象不会生效。
   */
  const resourcesRef = useRef<LivePreviewContext>({
    vaultPath: null,
    notePath: null,
    embedIndex: new Map(),
    generation: 0,
  });

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  useEffect(() => {
    pinnedTabsRef.current = pinnedSet;
  }, [pinnedSet]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const handleDocChanged = useCallback(() => {
    const view = viewRef.current;
    const path = viewOwnerRef.current;
    // 每次文档变更都把**实时** EditorState 回写 stateStore：stateStore[path] 必须
    // 始终等于编辑器里的内容。此前只在切走时捕获，激活中的标签一直是打开那一刻的
    // 旧对象——重命名换键搬走的是旧内容（界面上"写好的内容消失"），实时状态却被
    // 存进已换掉的旧路径键下（之后用旧名新建就"复用"了它的内容）。
    if (path && view) {
      stateStore.current.set(path, view.state);
      dirtyTabs.current.add(path);
    }
    setDirty(true);
    setRevision((r) => r + 1);
  }, []);

  // 编辑器实例只建一次；切换文件用 setState 整体换状态——lineSeparator 是 facet，
  // 必须随状态一起重建才能对新文件生效。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = createEditor(host, EditorState.create({}));
    viewRef.current = handle.view;
    return () => {
      handle.destroy();
      viewRef.current = null;
    };
  }, []);

  // ---------------------------------------------------------------- 标签
  // 标签本体是正文里的 `#标签`（lib/tags.ts 负责增删的纯文本编辑）。
  // 入口在标题栏的标签按钮（浮层管理，不占编辑区空间）；补全词表按仓库
  // 分桶渐进积累：打开/编辑过的笔记里出现过的标签都会被记住。

  /** 标签管理浮层开关。 */
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);

  /** 当前激活笔记的标签（revision 随文档变更/切换递增，是这里的响应源）。 */
  const noteTagList = useMemo(
    () =>
      current && isMarkdownPath(current.path)
        ? noteTags(viewRef.current?.state.doc.toString() ?? "")
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, revision],
  );

  /** 词表：{ 仓库路径: 标签[] }。 */
  const [tagVocab, setTagVocab] = useState<string[]>([]);
  useEffect(() => {
    if (!vault) {
      setTagVocab([]);
      return;
    }
    try {
      const map = JSON.parse(localStorage.getItem("quicknote.tags.v2") ?? "{}") as Record<string, string[]>;
      setTagVocab(map[vault] ?? []);
    } catch {
      setTagVocab([]);
    }
  }, [vault]);
  useEffect(() => {
    if (!vault || noteTagList.length === 0) return;
    setTagVocab((prev) => {
      const known = new Set(prev);
      const added = noteTagList.filter((tag) => !known.has(tag));
      if (added.length === 0) return prev;
      try {
        const map = JSON.parse(localStorage.getItem("quicknote.tags.v2") ?? "{}") as Record<string, string[]>;
        map[vault] = [...new Set([...(map[vault] ?? []), ...noteTagList])].sort((a, b) =>
          a.localeCompare(b, "zh"),
        );
        localStorage.setItem("quicknote.tags.v2", JSON.stringify(map));
      } catch {
        // 词表丢一次更新无伤大雅，别打断编辑
      }
      return [...prev, ...added];
    });
  }, [vault, noteTagList]);

  const addNoteTag = useCallback((input: string) => {
    const name = normalizeTagName(input);
    const view = viewRef.current;
    if (!name || !view) return;
    const text = view.state.doc.toString();
    const edit = tagAddEdit(text, name, view.state.lineBreak);
    if (edit) view.dispatch({ changes: { from: edit.at, to: edit.to, insert: edit.insert } });
  }, []);
  const removeNoteTag = useCallback((tag: string) => {
    const view = viewRef.current;
    if (!view) return;
    const edit = tagRemoveEdit(view.state.doc.toString(), tag);
    if (edit) view.dispatch({ changes: { from: edit.at, to: edit.to, insert: edit.insert } });
  }, []);

  const refresh = useCallback(async (dir: string) => {
    const list = await listEntries(dir);
    setEntries(list);

    // 「小写文件名 → 仓库相对路径」索引，供 wiki 语法（![[图片.png]] / ![[笔记]]）解析。
    const resources = resourcesRef.current;
    resources.vaultPath = dir;
    const index = resources.embedIndex;
    index.clear();
    const put = (key: string, path: string) => {
      const existing = index.get(key);
      // 同名时保留路径最短的，近似 Obsidian 的"离当前笔记最近"
      if (!existing || path.length < existing.length) index.set(key, path);
    };
    for (const entry of list) {
      if (entry.isDir) continue; // 索引只关心文件
      const base = entry.name.toLowerCase();
      put(base, entry.path);
      // `[[某笔记]]` 写的是不带扩展名的名字
      if (base.endsWith(".md")) put(base.slice(0, -3), entry.path);
    }

    // 代际 +1：让嵌入 widget 的 eq 判定为"不等"从而重建 DOM；渲染缓存也要清掉，
    // 否则目标笔记改了内容、界面上还是旧的。
    resources.generation += 1;
    clearEmbedCache();

    const view = viewRef.current;
    if (view) requestDecorationRefresh(view);
  }, []);

  /** 笔记数量（目录与非 md 文件不计入）。 */
  const noteCount = useMemo(
    () => entries.filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md")).length,
    [entries],
  );

  /** 仓库目录名（顶栏胶囊按钮上只显示名字，不显示全路径）。 */
  const vaultName = useMemo(
    () => (vault ? vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || vault : null),
    [vault],
  );

  /** 外部改动可能成批到达，合并成一次列表刷新。 */
  const scheduleRefresh = useCallback(
    (dir: string) => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void refresh(dir);
      }, 300);
    },
    [refresh],
  );

  /** 打开仓库时要做的两件事：授权读取库内图片、启动文件监听。 */
  const activateVault = useCallback((dir: string) => {
    allowAssetDir(dir).catch((e) => setError(`授权图片访问失败：${e}`));
    watchVault(dir).catch((e) => setError(`启动文件监听失败：${e}`));
  }, []);

  /** 用磁盘上的内容替换**激活标签**，尽量保住光标位置。 */
  const adoptFromDisk = useCallback(
    (note: NoteContent) => {
      const view = viewRef.current;
      const anchor = view ? view.state.selection.main.anchor : 0;
      // 嵌入内容里的相对路径要相对"当前笔记"解析，所以先更新上下文
      resourcesRef.current.notePath = note.path;
      const newState = createEditorState(note.content, {
        lineEnding: note.lineEnding,
        mode: isMarkdownPath(note.path) ? mode : "source",
        language: editorLanguageOf(note.path),
        onDocChanged: handleDocChanged,
        onSave: () => void saveRef.current(),
        resources: resourcesRef.current,
        attachment: attachmentOptions,
        codePaste: codePasteOptions,
        dark: resolveTheme(getSettings().theme) === "dark",
        onCursorInTable: setInTable,
          onCursorLine: setCursorLine,
      });
      view?.setState(newState);
      view?.dispatch({ selection: { anchor: Math.min(anchor, view.state.doc.length) } });
      stateStore.current.set(note.path, newState);
      viewOwnerRef.current = note.path;
      staleTabs.current.delete(note.path);
      dirtyTabs.current.delete(note.path);
      setOpenTabs((prev) =>
        prev.some((tab) => tab.path === note.path)
          ? prev.map((tab) => (tab.path === note.path ? note : tab))
          : [...prev, note],
      );
      setActiveTab(note.path);
      setDirty(false);
      setConflict(null);
    },
    [mode, handleDocChanged],
  );

  /**
   * 激活一个已打开的标签：换上它存量的 EditorState（未保存内容/光标/撤销历史都在），
   * 恢复滚动位置，再把模式、主题、嵌入路径、装饰对齐到这个标签。
   */
  const activateTab = useCallback(
    (path: string) => {
      const view = viewRef.current;
      const stored = stateStore.current.get(path);
      if (!view || !stored) return;
      // 捕获用 viewOwnerRef 而非 currentRef：后者要等渲染才对齐，重命名换键后的
      // 同步换页里它还指向旧路径——把实时状态写进死键，之后用旧名新建会复活旧内容。
      const prev = viewOwnerRef.current;
      if (prev && prev !== path) {
        stateStore.current.set(prev, view.state);
        scrollStore.current.set(prev, view.scrollDOM.scrollTop);
        if (dirtyRef.current) dirtyTabs.current.add(prev);
      }
      view.setState(stored);
      viewOwnerRef.current = path;
      view.scrollDOM.scrollTop = scrollStore.current.get(path) ?? 0;
      resourcesRef.current.notePath = path;
      // 存量状态的 Compartment 是它创建那一刻的模式/主题，切回来要对齐当前选择
      applyMode(view, modeRef.current);
      applyDarkTheme(view, resolveTheme(getSettings().theme) === "dark");
      requestDecorationRefresh(view);
      setInTable(isCursorInTable(view.state));
      setActiveTab(path);
      setDirty(dirtyTabs.current.has(path));
      setConflict(null);
    },
    [],
  );

  /** 表格工具栏按钮统一入口。命令内部找不到表格会返回 false，静默即可。 */
  const runTableCmd = useCallback((run: (view: EditorView) => boolean) => {
    const view = viewRef.current;
    if (view) run(view);
  }, []);

  /** 目录跳转：定位到标题行行首并滚动到视口顶部。 */
  const jumpToLine = useCallback((line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const target = view.state.doc.line(Math.min(Math.max(line + 1, 1), view.state.doc.lines));
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "start" }),
    });
    view.focus();
  }, []);

  /** 关闭标签。有未保存内容先落盘（后台标签直接用它存量的状态写，不用先激活）。 */
  const closeTab = useCallback(
    async (path: string) => {
      // 固定标签不响应任何关闭入口（中键/关闭钮已被 UI 隐藏，这里兜底逻辑入口）
      if (pinnedTabsRef.current.has(path)) return;
      if (dirtyTabs.current.has(path)) {
        const state = stateStore.current.get(path);
        const meta =
          path === activeTabRef.current
            ? currentRef.current
            : openTabsRef.current.find((tab) => tab.path === path);
        if (state && meta && vault) {
          try {
            await writeNote(vault, path, state.sliceDoc(), meta.hasBom);
          } catch (e) {
            setError(`关闭前保存失败：${e}`);
            return; // 保存失败就不关，免得丢内容
          }
        }
      }
      dirtyTabs.current.delete(path);
      staleTabs.current.delete(path);
      stateStore.current.delete(path);
      scrollStore.current.delete(path);
      const previous = openTabsRef.current;
      const index = previous.findIndex((tab) => tab.path === path);
      const next = previous.filter((tab) => tab.path !== path);
      setOpenTabs(next);
      if (activeTabRef.current === path) {
        const neighbor = next[Math.min(Math.max(index, 0), next.length - 1)]?.path ?? null;
        if (neighbor) {
          activateTab(neighbor);
        } else {
          setActiveTab(null);
          setDirty(false);
          setInTable(false);
          resourcesRef.current.notePath = null;
          viewRef.current?.setState(EditorState.create({}));
          viewOwnerRef.current = null;
        }
      } else {
        // 关的是后台标签，激活者不变；但 dirty 标记可能在脏集合里，同步一次显示
        setDirty(dirtyTabs.current.has(activeTabRef.current ?? ""));
      }
    },
    [vault, activateTab],
  );

  /**
   * 批量关闭标签（标签右键菜单：关闭左侧/右侧/其他/全部）。
   *
   * 不能循环调 closeTab：它读的 openTabsRef 要等 React 渲染后才更新，连关两个
   * 会拿同一份旧列表各滤一次，把已关的标签"复活"。这里一次性算好目标集合再动手。
   */
  const closeTabsBatch = useCallback(
    async (targets: string[]) => {
      const targetSet = new Set(targets);
      if (targetSet.size === 0) return;
      for (const path of targets) {
        if (!dirtyTabs.current.has(path)) continue;
        const state = stateStore.current.get(path);
        const meta =
          path === activeTabRef.current
            ? currentRef.current
            : openTabsRef.current.find((tab) => tab.path === path);
        if (state && meta && vault) {
          try {
            await writeNote(vault, path, state.sliceDoc(), meta.hasBom);
          } catch (e) {
            setError(`关闭前保存失败：${e}`);
            return; // 保存失败就不关，免得丢内容
          }
        }
      }
      for (const path of targets) {
        dirtyTabs.current.delete(path);
        staleTabs.current.delete(path);
        stateStore.current.delete(path);
        scrollStore.current.delete(path);
      }
      const previous = openTabsRef.current;
      const index = previous.findIndex((tab) => tab.path === activeTabRef.current);
      const next = previous.filter((tab) => !targetSet.has(tab.path));
      setOpenTabs(next);
      if (activeTabRef.current && targetSet.has(activeTabRef.current)) {
        const neighbor = next[Math.min(Math.max(index, 0), next.length - 1)]?.path ?? null;
        if (neighbor) {
          activateTab(neighbor);
        } else {
          setActiveTab(null);
          setDirty(false);
          setInTable(false);
          resourcesRef.current.notePath = null;
          viewRef.current?.setState(EditorState.create({}));
          viewOwnerRef.current = null;
        }
      } else {
        setDirty(dirtyTabs.current.has(activeTabRef.current ?? ""));
      }
    },
    [vault, activateTab],
  );

  const saveNow = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !vault || !current) return;
    try {
      const result = await writeNote(vault, current.path, view.state.sliceDoc(), current.hasBom);
      setOpenTabs((prev) =>
        prev.map((tab) =>
          tab.path === current.path ? { ...tab, sha256: result.sha256, size: result.bytes } : tab,
        ),
      );
      dirtyTabs.current.delete(current.path);
      setDirty(false);
      if (conflict) {
        // 保存即意味着用我的版本覆盖磁盘上的外部改动。
        setStatus("已保存并覆盖磁盘上的外部改动");
        setConflict(null);
      } else {
        setStatus(result.changed ? `已保存 ${result.bytes} 字节` : "内容未变，未落盘");
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [vault, current, conflict]);

  /**
   * 处理外部改动（来自 Obsidian、同步进程或其他编辑器）。
   *
   * 关键点：自己保存后监听器也会收到事件，必须靠内容哈希把它区分掉，
   * 否则会把自己的写入当成外部改动、来回刷新。
   */
  const handleVaultChanged = useCallback(
    async (paths: string[]) => {
      if (!vault) return;
      scheduleRefresh(vault);

      // 库内配置（日记目录/模板/待办）也可能被插件或同步进程改动，它由 useDaily
      // 自己按哈希判断是不是自己刚写的那一次。
      if (paths.includes(DAILY_CONFIG_FILE)) void dailyRef.current.handleVaultChange(paths);

      // 同步引擎按同一批路径排队推送（自己写入产生的回声靠内容哈希跳过）。
      syncRef.current?.handleVaultChange(paths);

      // 后台标签：只标记"文件被外部改过"，等它再次激活时与磁盘对账（openNote 的 stale 分支）
      for (const tab of openTabsRef.current) {
        if (tab.path !== activeTabRef.current && paths.includes(tab.path)) {
          staleTabs.current.add(tab.path);
        }
      }

      const open = currentRef.current;
      if (!open || !paths.includes(open.path)) return;

      let fresh: NoteContent;
      try {
        fresh = await readNote(vault, open.path);
      } catch (e) {
        setError(`文件在外部被改动后无法读取：${e}`);
        return;
      }

      // 哈希一致 → 就是自己刚保存产生的回声，忽略。
      if (fresh.sha256 === open.sha256) return;

      if (dirtyRef.current) {
        // 有未保存的编辑，不能直接覆盖，交给用户决定。
        setConflict(fresh);
        return;
      }

      adoptFromDisk(fresh);
      setStatus("已跟随外部改动");
    },
    [vault, scheduleRefresh, adoptFromDisk],
  );

  useEffect(() => {
    changeHandlerRef.current = (paths) => void handleVaultChanged(paths);
  }, [handleVaultChanged]);

  // 只订阅一次，回调经 ref 转发，避免每次状态变化都重新订阅。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onVaultChanged((paths) => changeHandlerRef.current(paths))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // 拿不到事件通道不影响编辑，只是不会自动跟随外部改动。
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    saveRef.current = () => void saveNow();
  }, [saveNow]);

  // 启动时确定仓库：**命令行显式指定的优先**，其次才是上次记住的。
  // 反过来的话，`quick-note.exe <目录>` 会被历史记录盖掉，看起来像参数没生效。
  useEffect(() => {
    const useVault = (dir: string) => {
      localStorage.setItem(VAULT_KEY, dir);
      recordVault(dir);
      setVault(dir);
      activateVault(dir);
      refresh(dir).catch((e) => setError(String(e)));
      // 旧版本把附件目录存在本机；M3 起它归库内配置管。用户改过的话一次性搬过去
      // （走正常的设置通道落盘，与手改等效）；没改过就什么都不做，不为迁移写文件。
      const legacy = takeLegacyAttachmentFolder();
      if (legacy) dailyRef.current.updateSettings({ pastedImageFolder: legacy });
    };

    startupVault()
      .catch(() => null) // 拿不到启动参数不影响使用，用户手动选目录即可
      .then((dir) => dir ?? localStorage.getItem(VAULT_KEY))
      .then((dir) => {
        if (!dir) return;
        useVault(dir);
        // 资源管理器双击 .md（「打开方式 → Quick Note」）：进仓库后自动打开这一篇。
        // openEntry 经 ref 取**最新**实例——本 effect 只跑一次，直接闭包会捕获
        // vault 尚为 null 的初始版本。树刷新完成后路径才存在，等一轮再开。
        void startupFile()
          .catch(() => null)
          .then((file) => {
            if (!file) return;
            const normalized = file.replace(/\\/g, "/");
            if (!normalized.toLowerCase().endsWith(".md")) {
              setPreviewPath(normalized);
              return;
            }
            const prefix = dir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
            const relative = normalized.toLowerCase().startsWith(prefix.toLowerCase())
              ? normalized.slice(prefix.length)
              : normalized;
            window.setTimeout(() => void openEntryRef.current(relative), 600);
          });
      });
  }, [refresh, activateVault, recordVault]);

  // 自动保存：revision 每次改动递增，从而重置防抖计时。
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void saveNow(), AUTOSAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [dirty, revision, saveNow]);

  /** 切换到指定仓库（清空全部标签与状态；启动与下拉/对话框共用这一条路径）。 */
  const switchVault = useCallback(
    async (picked: string) => {
      setError(null);
      localStorage.setItem(VAULT_KEY, picked);
      recordVault(picked);
      setVault(picked);
      setPreviewPath(null);
      setSelectedPath(null);
      setTreeClipboard(null);
      // 换仓库必须把所有标签与编辑器一起清掉：CodeMirror 的状态还挂着上一篇的话，
      // 旧内容继续显示，下一次输入还会试图写回旧仓库的路径
      setOpenTabs([]);
      setActiveTab(null);
      stateStore.current.clear();
      scrollStore.current.clear();
      staleTabs.current.clear();
      dirtyTabs.current.clear();
      viewOwnerRef.current = null;
      setDirty(false);
      setRoundTrip(null);
      setConflict(null);
      setStatus("");
      setInTable(false);
      resourcesRef.current.notePath = null;
      viewRef.current?.setState(EditorState.create({}));
      activateVault(picked);
      try {
        await refresh(picked);
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh, activateVault, recordVault],
  );

  const openVault = useCallback(async () => {
    const picked = await pickVault();
    if (!picked) return;
    await switchVault(picked);
  }, [switchVault]);

  /** 换到最近打开的某个仓库（顶栏下拉）。 */
  const openRecentVault = useCallback(
    (dir: string) => {
      setVaultMenu(null);
      if (dir !== vault) void switchVault(dir);
    },
    [vault, switchVault],
  );

  // ------------------------------------------------------------------ 数据目录

  // 设置面板要展示数据目录；启动时查一次，改动后由回调就地更新。
  useEffect(() => {
    appDataPaths()
      .then(setDataPaths)
      .catch(() => {
        // 查不到就显示"…"，不影响其他功能
      });
  }, []);

  const pickDataDir = useCallback(async () => {
    const picked = await pickDirectory("选择自定义数据目录");
    if (!picked) return;
    try {
      const next = await setCustomDataDir(picked);
      setDataPaths(next);
      setStatus("数据目录已设置，重启应用后生效（现有数据会自动迁移）");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const clearDataDir = useCallback(async () => {
    try {
      const next = await setCustomDataDir(null);
      setDataPaths(next);
      setStatus("已恢复默认数据目录，重启应用后生效");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const openNote = useCallback(
    async (path: string) => {
      if (!vault) return;
      // 打开任何笔记都收起预览窗格（预览与编辑互斥，对齐 Obsidian 的点击语义）
      setPreviewPath(null);
      // 已是这个标签且没有外部改动：什么都不做（重置会丢光标位置）
      if (path === activeTabRef.current && !staleTabs.current.has(path)) return;
      recordRecent(path);
      if (dirtyRef.current) await saveNow();
      // 存量状态且文件没被外部改过：直接换上去，未保存内容与撤销历史都在
      if (stateStore.current.has(path) && !staleTabs.current.has(path)) {
        activateTab(path);
        setRoundTrip(null);
        return;
      }
      try {
        const note = await readNote(vault, path);
        // 嵌入内容里的相对路径要相对"当前笔记"解析，所以先更新上下文
        resourcesRef.current.notePath = note.path;
        const stored = stateStore.current.get(path);
        if (stored) {
          // 标签已存在但后台文件被外部改过：与标签里的内容对账。
          // 一致 → 只更新 meta（保住光标）；不一致且没改过 → 采纳磁盘；改过 → 交冲突面板
          const local = stored.sliceDoc();
          const dirtyTab = dirtyTabs.current.has(path);
          if (local !== note.content && dirtyTab) {
            staleTabs.current.delete(path);
            setOpenTabs((prev) =>
              prev.map((tab) => (tab.path === path ? note : tab)),
            );
            activateTab(path);
            setConflict(note);
            return;
          }
          if (local === note.content) {
            staleTabs.current.delete(path);
            setOpenTabs((prev) =>
              prev.map((tab) => (tab.path === path ? note : tab)),
            );
            activateTab(path);
            return;
          }
          staleTabs.current.delete(path);
        }
        const newState = createEditorState(note.content, {
          lineEnding: note.lineEnding,
          mode: isMarkdownPath(note.path) ? mode : "source",
          language: editorLanguageOf(note.path),
          onDocChanged: handleDocChanged,
          onSave: () => void saveRef.current(),
          resources: resourcesRef.current,
          attachment: attachmentOptions,
          codePaste: codePasteOptions,
          dark: resolveTheme(getSettings().theme) === "dark",
          onCursorInTable: setInTable,
          onCursorLine: setCursorLine,
        });
        // 「替换当前」模式（Obsidian 默认）：新笔记顶掉当前标签的位置，标签数不增长。
        // 被顶掉的标签存量状态一并清掉，否则下次打开还会从 stateStore 里复活。
        // 已打开过的笔记在前面就走 activateTab 了，两种模式一致。
        const replaceCurrent =
          getSettings().openNoteMode === "replace" &&
          activeTabRef.current !== null &&
          activeTabRef.current !== path;
        const previousPath = activeTabRef.current;
        if (replaceCurrent && previousPath) {
          stateStore.current.delete(previousPath);
          scrollStore.current.delete(previousPath);
          dirtyTabs.current.delete(previousPath);
          staleTabs.current.delete(previousPath);
        }
        stateStore.current.set(note.path, newState);
        dirtyTabs.current.delete(path);
        setOpenTabs((prev) => {
          if (prev.some((tab) => tab.path === note.path)) {
            return prev.map((tab) => (tab.path === note.path ? note : tab));
          }
          if (replaceCurrent && previousPath) {
            const index = prev.findIndex((tab) => tab.path === previousPath);
            if (index >= 0) {
              const next = prev.slice();
              next[index] = note;
              return next;
            }
          }
          return [...prev, note];
        });
        setActiveTab(note.path);
        viewRef.current?.setState(newState);
        viewOwnerRef.current = note.path;
        viewRef.current?.scrollDOM.scrollTop !== undefined &&
          (viewRef.current.scrollDOM.scrollTop = 0);
        setDirty(false);
        setRoundTrip(null);
        setStatus("");
        setError(null);
        setConflict(null);
        viewRef.current?.focus();
      } catch (e) {
        setError(String(e));
      }
    },
    [vault, saveNow, handleDocChanged, mode, activateTab],
  );

  /**
   * 文件树的打开入口（按类型路由）：预览类（pdf/docx/xlsx）开预览窗格，
   * markdown 与数据文件（json/sql/yaml 等）进编辑器。
   */
  const openEntry = useCallback(
    async (path: string) => {
      const kind = fileKindOf(path);
      console.log("[openEntry]", path, kind);
      if (kind === "pdf" || kind === "docx" || kind === "ppt" || kind === "spreadsheet" || kind === "html" || kind === "image") {
        setSelectedPath(path);
        setPreviewPath(path);
        // 预览类文件同样进「最近」列表（此前只记笔记，最近里永远看不到 pdf/docx）
        recordRecent(path);
        return;
      }
      // 打开编辑类文件时关掉预览（与 Obsidian 一致：点击文件切换内容）
      setPreviewPath(null);
      setSelectedPath(path);
      await openNote(path);
    },
    [openNote, recordRecent],
  );

  /** 最新 openEntry：启动参数「双击 .md 打开」的 effect 只跑一次，用它避免旧闭包。 */
  const openEntryRef = useRef(openEntry);
  useEffect(() => {
    openEntryRef.current = openEntry;
  }, [openEntry]);

  /**
   * 读取模板文件并展开占位符。
   *
   * 未启用、路径为空、文件不存在都返回 `null`，由调用方回退到默认内容——
   * 模板是个便利功能，不该因为路径写错就让"新建日记"整个失败。
   */
  const templateContent = useCallback(
    async (
      enabled: boolean,
      path: string,
      vars: { title: string; dateMoment: Moment; week?: string },
    ): Promise<string | null> => {
      if (!vault || !enabled) return null;
      const target = path.trim();
      if (!target) return null;
      const note = await readNoteOptional(vault, target);
      if (!note) {
        notice(`模板文件不存在，已使用默认内容：${target}`, "error");
        return null;
      }
      return expandTemplate(note.content, vars, daily.dateFormat);
    },
    [vault, daily.dateFormat, notice],
  );

  /**
   * 抓取天气并插进日记正文（M4）。城市未配置或抓取失败都原样返回内容——
   * 天气是锦上添花，宁可缺一瓣也不能挡住「新建日记」。
   */
  const prependWeather = useCallback(
    async (content: string, city: string): Promise<string> => {
      const trimmed = city.trim();
      if (!trimmed) return content;
      const weather = await fetchWeather(trimmed);
      if (!weather) return content;
      return insertWeatherLine(content, weather);
    },
    [],
  );

  /**
   * 打开某天的日记：已有就打开，没有就用模板新建再打开。
   *
   * 「同名直接打开、不覆盖」是硬规则：日记是按日期命名的，重名意味着"这一天的
   * 日记已经在了"，此时把内容覆盖成模板等于删掉当天的记录。
   *
   * 名字由调用方（日历面板的输入行）收集——插件的规则是名字必填。
   */
  const openDaily = useCallback(
    async (dateStr: string, name: string) => {
      if (!vault) return;
      const title = dailyTitle(dateStr, name);
      const path = dailyNotePath(daily.settings, dateStr, name);
      try {
        if (await readNoteOptional(vault, path)) {
          await openNote(path);
          notice(`已有同名日记，已打开：${title}`);
          return;
        }
        const content =
          (await templateContent(
            daily.settings.dailyTemplateEnabled,
            daily.settings.dailyTemplatePath,
            { title, dateMoment: parseDateStrict(dateStr, daily.dateFormat) },
          )) ?? defaultNoteContent(title);
        // 天气（M4）：创建时抓取一次并插进正文，失败静默——不能让天气挡住日记。
        // 落盘前并入内容，文件只写一次，也就不会有"先建再补写"的监听回声。
        const withWeather = daily.settings.weatherEnabled
          ? await prependWeather(content, daily.settings.weatherCity)
          : content;
        await writeNote(vault, path, withWeather, false);
        await refresh(vault);
        await openNote(path);
        notice(`已新建日记「${title}」`);
      } catch (e) {
        notice(String(e), "error");
      }
    },
    [vault, daily.settings, daily.dateFormat, openNote, refresh, notice, templateContent],
  );

  /**
   * 打开或创建某周的周记。一周一篇、命名固定（`2026-W37 周记`），所以不需要输入名字。
   *
   * 模板里的 `{{date}}` 用该周**周一**的日期，不是"今天"：否则同一周的周记会因为
   * 创建时间不同而写出不同的日期，周回顾对不上。
   */
  const openWeekly = useCallback(
    async (weekKey: string, mondayKey: string) => {
      if (!vault) return;
      const existing = daily.weeklyNotesIn(weekKey)[0];
      if (existing) {
        await openNote(existing);
        return;
      }
      const title = weeklyTitle(weekKey);
      const path = weeklyNotePath(daily.settings, weekKey);
      try {
        const content =
          (await templateContent(
            daily.settings.weeklyTemplateEnabled,
            daily.settings.weeklyTemplatePath,
            { title, dateMoment: parseDateStrict(mondayKey, daily.dateFormat), week: weekKey },
          )) ?? defaultNoteContent(title);
        await writeNote(vault, path, content, false);
        await refresh(vault);
        await openNote(path);
        notice(`已新建周记「${title}」`);
      } catch (e) {
        notice(String(e), "error");
      }
    },
    [vault, daily.settings, daily.dateFormat, daily.weeklyNotesIn, openNote, refresh, notice, templateContent],
  );

  /** 新建的目标目录：当前打开笔记所在的目录；没打开笔记就放仓库根。 */
  const createTargetFolder = useCallback(() => {
    const path = currentRef.current?.path;
    if (!path || !path.includes("/")) return "";
    return path.slice(0, path.lastIndexOf("/"));
  }, []);

  /** 右键「新建笔记」的落点：目录用本身，文件用所在目录。 */
  const parentFolderOf = useCallback((path: string) => {
    if (!path.includes("/")) return "";
    return path.slice(0, path.lastIndexOf("/"));
  }, []);

  const beginCreate = useCallback((kind: "note" | "folder" | "diary", folder = "") => {
    setCreating(kind);
    setCreateFolderOverride(folder);
    setDraft("");
    setError(null);
  }, []);

  const cancelCreate = useCallback(() => {
    setCreating(null);
    setCreateFolderOverride("");
    setDraft("");
  }, []);

  const cancelRename = useCallback(() => {
    setRenaming(null);
    setDraft("");
  }, []);

  const submitCreate = useCallback(async () => {
    if (!creating || !vault) return;
    const name = draft.trim();
    if (!name) return;
    // 日记与插件同一个规则：名字必填，非法名挡在输入行里直接改
    if (creating === "diary") {
      const problem = validateDailyName(name);
      if (problem) {
        setError(problem);
        return;
      }
      cancelCreate();
      await openDaily(daily.today, name);
      return;
    }
    try {
      if (creating === "note") {
        const path = await createNote(vault, createFolderOverride || createTargetFolder(), name);
        cancelCreate();
        await refresh(vault);
        // 新建后直接打开，省掉再去树里找一次
        await openNote(path);
      } else {
        const path = await createFolder(vault, createFolderOverride || createTargetFolder(), name);
        cancelCreate();
        await refresh(vault);
        setStatus(`已新建文件夹「${path}」`);
      }
      setError(null);
    } catch (e) {
      // 输入行保持展开，用户可以直接改名重试
      setError(String(e));
    }
  }, [creating, vault, draft, createFolderOverride, createTargetFolder, refresh, openNote, daily.today, openDaily, cancelCreate]);

  /** 打开右键菜单。origin 记录发起面板：重命名输入行渲染在发起处，而不是按文件类型猜。 */
  const openContextMenu = useCallback(
    (path: string, isDir: boolean, x: number, y: number, origin: "tree" | "daily" = "tree") => {
      setMenu({ path, isDir, x, y, origin });
    },
    [],
  );

  const beginRename = useCallback((path: string, owner: "tree" | "daily" = "tree") => {
    setRenaming(path);
    setRenameOwner(owner);
    setDraft(path.slice(path.lastIndexOf("/") + 1));
    setMenu(null);
    setError(null);
  }, []);

  /**
   * 打开标签/状态存储/收藏/最近列表里所有以 oldPath 为前缀的键换成 newPath。
   * 重命名与拖拽移动共用这套簿记：路径是标签与状态存储的主键，漏换键的话
   * 下一次自动保存会把内容写回旧路径。活动标签被波及时换键后重新打开。
   */
  const rekeyEntryPaths = useCallback(
    async (oldPath: string, newPath: string) => {
      const openPath = currentRef.current?.path;
      const affectedOpen =
        openPath !== undefined && (openPath === oldPath || openPath.startsWith(`${oldPath}/`));
      const remap = (p: string) =>
        p === oldPath ? newPath : `${newPath}${p.slice(oldPath.length)}`;
      const affected = (p: string) => p === oldPath || p.startsWith(`${oldPath}/`);
      for (const tab of openTabsRef.current) {
        if (!affected(tab.path)) continue;
        const nextPath = remap(tab.path);
        const state = stateStore.current.get(tab.path);
        if (state) {
          stateStore.current.delete(tab.path);
          stateStore.current.set(nextPath, state);
        }
        // 视图正在显示被改名标签的内容：换键后内容属于新路径，要及时改口，
        // 否则随后的 activateTab 会把实时状态捕获进已不存在的旧路径键下
        if (viewOwnerRef.current === tab.path) {
          viewOwnerRef.current = nextPath;
        }
        if (scrollStore.current.has(tab.path)) {
          const value = scrollStore.current.get(tab.path);
          scrollStore.current.delete(tab.path);
          if (value !== undefined) scrollStore.current.set(nextPath, value);
        }
        if (dirtyTabs.current.has(tab.path)) {
          dirtyTabs.current.delete(tab.path);
          dirtyTabs.current.add(nextPath);
        }
        staleTabs.current.delete(tab.path);
      }
      setOpenTabs((prev) =>
        prev.map((tab) => (affected(tab.path) ? { ...tab, path: remap(tab.path) } : tab)),
      );
      // 固定标签跟着换键，否则固定状态指向不存在的旧路径
      setPinnedTabs((prev) => prev.map((p) => (affected(p) ? remap(p) : p)));
      // 收藏与最近列表跟着换键，否则指向不存在的旧路径
      setFavorites((prev) => {
        const next = prev.map((p) => (affected(p) ? remap(p) : p));
        persistFavorites(next);
        return next;
      });
      setRecents((prev) => {
        const next = prev.map((p) => (affected(p) ? remap(p) : p));
        try {
          localStorage.setItem("quicknote.recents", JSON.stringify(next));
        } catch {
          // 忽略：与 recordRecent 同一容错
        }
        return next;
      });
      if (affectedOpen && openPath) {
        const nextPath = remap(openPath);
        resourcesRef.current.notePath = nextPath;
        setActiveTab(nextPath);
        await openNote(nextPath);
      }
    },
    [openNote, persistFavorites],
  );

  /**
   * 把正文**第一个一级标题**改成新名字（「重命名时同步一级标题」设置）。
   *
   * 三种存放位置各走各路：激活中的标签直接在视图里改（保住撤销历史）并立即落盘；
   * 后台标签改它存量的 EditorState（标脏，交给关闭/自动保存写回）；没打开的
   * 读盘-改-写回。找不到一级标题（或文档只有未闭合的 frontmatter）就不动内容，
   * 不会凭空补标题。返回是否有改动。
   */
  const syncFirstHeading = useCallback(
    async (path: string, title: string): Promise<boolean> => {
      if (!vault) return false;
      /** 找第一个 H1 行的下标（跳过 YAML frontmatter；未闭合的 frontmatter 不动）。 */
      const findHeadingLine = (lines: string[]): number | null => {
        let start = 0;
        if (lines[0]?.trim() === "---") {
          let closed = false;
          for (let i = 1; i < lines.length; i += 1) {
            if (lines[i].trim() === "---") {
              start = i + 1;
              closed = true;
              break;
            }
          }
          if (!closed) return null;
        }
        for (let i = start; i < lines.length; i += 1) {
          if (/^\s*#[ \t]+\S/.test(lines[i])) return i;
        }
        return null;
      };

      const view = viewRef.current;
      if (view && viewOwnerRef.current === path) {
        const doc = view.state.doc;
        const lines: string[] = [];
        for (let n = 1; n <= doc.lines; n += 1) lines.push(doc.line(n).text);
        const index = findHeadingLine(lines);
        if (index === null) return false;
        const line = doc.line(index + 1);
        const match = /^(\s*)#[ \t]*/.exec(line.text);
        if (!match) return false;
        const insert = `${match[1]}# ${title}`;
        if (insert === line.text) return false;
        view.dispatch({ changes: { from: line.from, to: line.to, insert } });
        // 改完立即落盘：重命名刚换过路径键，别把脏内容留给下一轮自动保存
        const meta = openTabsRef.current.find((tab) => tab.path === path);
        if (meta) {
          try {
            const result = await writeNote(vault, path, view.state.sliceDoc(), meta.hasBom);
            setOpenTabs((prev) =>
              prev.map((tab) =>
                tab.path === path ? { ...tab, sha256: result.sha256, size: result.bytes } : tab,
              ),
            );
            dirtyTabs.current.delete(path);
            setDirty(false);
          } catch (e) {
            setError(String(e));
          }
        }
        return true;
      }

      const stored = stateStore.current.get(path);
      if (stored) {
        const lines: string[] = [];
        for (let n = 1; n <= stored.doc.lines; n += 1) lines.push(stored.doc.line(n).text);
        const index = findHeadingLine(lines);
        if (index === null) return false;
        const line = stored.doc.line(index + 1);
        const match = /^(\s*)#[ \t]*/.exec(line.text);
        if (!match) return false;
        const insert = `${match[1]}# ${title}`;
        if (insert === line.text) return false;
        stateStore.current.set(
          path,
          stored.update({ changes: { from: line.from, to: line.to, insert } }).state,
        );
        dirtyTabs.current.add(path);
        return true;
      }

      const note = await readNoteOptional(vault, path);
      if (!note) return false;
      const lines = note.content.split("\n");
      const index = findHeadingLine(lines);
      if (index === null) return false;
      const raw = lines[index];
      const match = /^(\s*)#[ \t]*/.exec(raw);
      if (!match) return false;
      // CRLF 文件按 \n 切开后行尾带着 \r，替换时要原样保留
      const cr = raw.endsWith("\r") ? "\r" : "";
      lines[index] = `${match[1]}# ${title}${cr}`;
      if (lines[index] === raw) return false;
      await writeNote(vault, path, lines.join("\n"), note.hasBom);
      return true;
    },
    [vault],
  );

  /** 重命名。被改名的笔记（或所在目录）如果正开着，要跟着换到新路径，否则下次保存会写回旧路径。 */
  const submitRename = useCallback(async () => {
    if (!renaming || !vault) return;
    let name = draft.trim();
    if (!name) return;

    // 日记改名保留日期前缀。日记靠「文件名以日期开头」挂在日历上（当天列表、
    // 打点、今日字数都依赖它）；把「2026-09-18.md」改成「复盘.md」会让日记从
    // 当天列表消失，还会被「新建日记」当成当天没写过再建一篇空的。这里把前缀补回去。
    // 输入自带合法日期前缀（「2026-09-25 复盘」）时尊重输入：日记整体改到那一天。
    let dateKept = false;
    let dateMoved: string | undefined;
    const renamePlan = dailyRenameName(renaming, name, daily.dateFormat);
    if (renamePlan.kept && daily.folderFiles.includes(renaming)) {
      name = renamePlan.name;
      dateKept = true;
      dateMoved = renamePlan.date;
    }

    try {
      if (dirty) await saveNow();
      const result = await renameEntry(vault, renaming, name);
      setRenaming(null);
      setDraft("");
      await refresh(vault);
      await rekeyEntryPaths(renaming, result.path);
      // 设置开启时，把正文第一个一级标题同步成新名字
      let headingSynced = false;
      if (getSettings().syncRenameHeading && result.path.toLowerCase().endsWith(".md")) {
        const title = (result.path.split("/").pop() ?? "").replace(/\.md$/i, "");
        if (title) headingSynced = await syncFirstHeading(result.path, title);
      }
      const suffix = headingSynced ? "，并同步了第一个一级标题" : "";
      setStatus(
        dateMoved
          ? `已改名为「${name.replace(/\.md$/i, "")}」，日记已改到 ${dateMoved}${suffix}`
          : dateKept
            ? `已重命名为「${name.replace(/\.md$/i, "")}」（已保留日期前缀，日记才会出现在当天列表）${suffix}`
            : result.updated.length > 0
              ? `已重命名为「${name}」，并更新了 ${result.updated.length} 篇笔记里的引用${suffix}`
              : `已重命名为「${name}」${suffix}`,
      );
      setError(null);
    } catch (e) {
      // 输入行保持展开，方便换个名字重试
      setError(String(e));
    }
  }, [renaming, vault, draft, dirty, saveNow, refresh, rekeyEntryPaths, syncFirstHeading, daily.dateFormat, daily.folderFiles]);

  /** 执行删除（移入仓库内的 .trash，可找回）。 */
  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !vault) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      const trashed = await deleteEntry(vault, target.path);
      // 附件（图片）删除后清理各笔记里的引用：不留一堆破图链接。
      // 候选集用全文搜索圈定（文件名是足够独特的关键词），再按引用语法精确匹配。
      let cleanedNotes = 0;
      if (!target.isDir && !target.path.toLowerCase().endsWith(".md")) {
        const fileName = target.path.split("/").pop() ?? "";
        if (fileName) {
          try {
            const hits = await searchVault(vault, fileName, 100);
            for (const hit of hits) {
              if (!hit.path.toLowerCase().endsWith(".md")) continue;
              const note = await readNoteOptional(vault, hit.path);
              if (!note) continue;
              const next = removeImageReferences(note.content, target.path, fileName);
              if (next !== null) {
                await writeNote(vault, hit.path, next, note.hasBom);
                cleanedNotes += 1;
              }
            }
          } catch {
            // 引用清理失败不回滚删除——文件已在 .trash，引用可以手动补
          }
        }
      }
      // 删掉的笔记（或目录下的笔记）开着标签就关掉：留着的话，
      // 接下来的一次自动保存会把文件重新写回来
      const affected = openTabsRef.current.filter(
        (tab) => tab.path === target.path || tab.path.startsWith(`${target.path}/`),
      );
      for (const tab of affected) {
        dirtyTabs.current.delete(tab.path);
        staleTabs.current.delete(tab.path);
        stateStore.current.delete(tab.path);
        scrollStore.current.delete(tab.path);
      }
      if (affected.length > 0) {
        const remaining = openTabsRef.current.filter(
          (tab) => !affected.some((hit) => hit.path === tab.path),
        );
        setOpenTabs(remaining);
        if (affected.some((tab) => tab.path === activeTabRef.current)) {
          const index = openTabsRef.current.findIndex((tab) => tab.path === activeTabRef.current);
          const neighbor =
            remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.path ?? null;
          setConflict(null);
          if (neighbor) {
            activateTab(neighbor);
          } else {
            setActiveTab(null);
            setDirty(false);
            setInTable(false);
            resourcesRef.current.notePath = null;
            viewRef.current?.setState(EditorState.create({}));
            viewOwnerRef.current = null;
          }
        }
      }
      await refresh(vault);
      // 删掉的笔记从收藏与最近列表里移除，免得点开 404
      setFavorites((prev) => {
        const next = prev.filter(
          (p) => p !== target.path && !p.startsWith(`${target.path}/`),
        );
        persistFavorites(next);
        return next;
      });
      // 固定状态同理：文件没了固定也没有意义
      setPinnedTabs((prev) =>
        prev.filter((p) => p !== target.path && !p.startsWith(`${target.path}/`)),
      );
      setRecents((prev) => {
        const next = prev.filter(
          (p) => p !== target.path && !p.startsWith(`${target.path}/`),
        );
        try {
          localStorage.setItem("quicknote.recents", JSON.stringify(next));
        } catch {
          // 忽略
        }
        return next;
      });
      setStatus(
        cleanedNotes > 0
          ? `已移入回收目录：${trashed}，并清理了 ${cleanedNotes} 篇笔记中的引用`
          : `已移入回收目录：${trashed}（可以找回）`,
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [pendingDelete, vault, refresh, activateTab]);

  /** 切换视图模式。用 Compartment 重配置，撤销历史与光标位置都保留。 */
  const changeMode = useCallback(    (next: ViewMode) => {
      // 数据文件（json/sql/yaml…）只有源码视图：实时预览的 Markdown 装饰对它们没意义
      if (current && !isMarkdownPath(current.path)) {
        setStatus("该文件类型仅支持源码查看");
        return;
      }
      setMode(next);
      localStorage.setItem(MODE_KEY, next);
      const view = viewRef.current;
      if (view && current) applyMode(view, next);
    },
    [current],
  );

  const changeRightPanel = useCallback((next: "daily" | "outline" | "stats") => {
    setRightPanel(next);
    localStorage.setItem(SIDEBAR_KEY, next);
  }, []);

  /** 打开笔记并跳到指定行（全局搜索的「内容」结果用）；行号省略时只打开。 */
  const openNoteAt = useCallback(
    async (path: string, line?: number) => {
      await openNote(path);
      if (line !== undefined) jumpToLine(line);
    },
    [openNote, jumpToLine],
  );

  /** 导出 PDF：渲染整篇笔记为打印视图，弹出系统打印对话框（选「另存为 PDF」）。 */
  const exportPdf = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !currentRef.current) {
      notice("请先打开一个笔记，再导出 PDF", "error");
      return;
    }
    try {
      await exportNoteToPdf(view.state, resourcesRef.current);
      setStatus("已打开打印对话框：目标打印机选「另存为 PDF」即可导出");
    } catch (e) {
      setError(`导出 PDF 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [notice]);

  /**
   * 导出 PDF 文件（落盘）：笔记渲染成独立 HTML → 无头浏览器打印成 PDF。
   * 保存对话框预填「上次导出目录 + 笔记名.pdf」；未选位置则取消。
   * 上次目录记在 localStorage（跨会话）。
   */
  const exportPdfFile = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !currentRef.current || !vault) {
      notice("请先打开一个笔记，再导出 PDF", "error");
      return;
    }
    const title = currentRef.current.path.slice(currentRef.current.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    // 预填目录优先级：用户上次的导出目录 > 设置里的导出目录（默认仓库根「导出」）。
    // 默认目录不存在时先建出来，保存对话框才能直接定位进去。
    let lastDir = localStorage.getItem("quicknote.pdfExportDir") ?? "";
    if (!lastDir && settings.exportFolder) {
      lastDir = `${vault}/${settings.exportFolder}`;
      try {
        await createFolder(vault, "", settings.exportFolder);
      } catch {
        // 已存在等情况的失败无所谓，save 对话框仍能预填路径
      }
    }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { firstExistingPath, writeTextFile, exportPdfViaBrowser } = await import("./lib/api");
      const { buildStandalonePrintHtml } = await import("./lib/printExport");
      const { applyTheme } = await import("./lib/theme");

      // 候选浏览器：Edge（Windows 自带）→ Chrome
      const candidates = [
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      ];
      const browser = await firstExistingPath(candidates);
      if (!browser) {
        setError("没有找到 Edge 或 Chrome，无法生成 PDF 文件（可用「导出 PDF」走打印对话框）");
        return;
      }

      setStatus("正在渲染导出内容…");
      const html = await buildStandalonePrintHtml(view.state, resourcesRef.current);
      const tempHtml = `${await import("@tauri-apps/api/path").then((m) => m.tempDir())}quick-note-export-${Date.now()}.html`;
      await writeTextFile(tempHtml, html);

      // 保存对话框：预填上次目录；取消则不导出
      const picked = await save({
        defaultPath: `${lastDir ? `${lastDir.replace(/[\\/]+$/, "")}/` : ""}${title}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof picked !== "string") {
        setStatus("已取消导出");
        return;
      }
      const dir = picked.slice(0, Math.max(picked.lastIndexOf("/"), picked.lastIndexOf("\\")));
      if (dir) localStorage.setItem("quicknote.pdfExportDir", dir);

      // 无头浏览器对 file:// 图片等的加载需要一点时间；交给它自己完成后校验产物
      setStatus("正在生成 PDF 文件…");
      await exportPdfViaBrowser(browser, tempHtml, picked);

      // 深浅色：无头浏览器读不到应用主题，导出的内容本身就带浅色打印样式，无需处理
      void applyTheme;
      setStatus(`已导出 PDF：${picked}`);
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(picked);
    } catch (e) {
      setError(`导出 PDF 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [vault, notice, settings.exportFolder]);

  // ------------------------------------------------------------------ 周回顾

  /**
   * 生成一周的回顾并插入当前笔记光标处（M4）。
   *
   * `mondayISO` 是该周周一；`isCurrent` 决定标题用「本周回顾」还是「2026-W37 回顾」。
   * 日记内容逐篇读取算字数——一周最多几篇，直接读比建索引划算。
   */
  const insertWeeklyReview = useCallback(
    async (mondayISO: string, isCurrent: boolean) => {
      const view = viewRef.current;
      if (!vault || !view || !currentRef.current) {
        notice("请先打开一个笔记，回顾内容会插入到光标处", "error");
        return;
      }
      const start = moment(mondayISO, "YYYY-MM-DD", true).startOf("isoWeek");
      if (!start.isValid()) return;
      const end = start.clone().endOf("isoWeek");
      const format = dailyRef.current.dateFormat;

      const diaries: ReviewDiary[] = [];
      for (let d = start.clone(); d.isBefore(end) || d.isSame(end, "day"); d.add(1, "day")) {
        const key = d.format(format);
        for (const path of dailyRef.current.dailyNotesOn(key)) {
          try {
            const note = await readNote(vault, path);
            diaries.push({ dateKey: key, title: baseNameOf(path), words: wordCount(note.content) });
          } catch {
            // 单篇读不出来就跳过，不让整个回顾失败
          }
        }
      }

      const text = buildWeeklyReview({
        start,
        end,
        isCurrent,
        diaries,
        todos: dailyRef.current.todos,
        dateFormat: format,
        weekdayLabel: weekdayZh,
      });

      // 插入光标处，前后补空行让标题独立成段（与代码块粘贴同一套补位规则）
      const pos = view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos);
      const lines = view.state.doc.toString().split("\n");
      const { prefix, suffix } = blockInsertPadding(lines, line.number - 1, pos - line.from);
      view.dispatch(view.state.replaceSelection(`${prefix}${text}${suffix}`));
      view.focus();
      setStatus(isCurrent ? "已插入本周回顾" : `已插入周回顾（${start.format("GGGG-[W]WW")}）`);
    },
    [vault, notice],
  );

  // ------------------------------------------------------------------ 定时提醒

  /** 当天已触发的提醒标记（进程内记忆，与插件一致：重启后时间点已过就不再补提醒）。 */
  const firedReminders = useRef<ReminderFired>({ todo: "", check: "" });

  // 系统通知。权限没批或插件不可用时静默降级为界面提示——提醒不该报错。
  const sendSystemNotification = useCallback(async (body: string) => {
    try {
      const notification = await import("@tauri-apps/plugin-notification");
      let granted = await notification.isPermissionGranted();
      if (!granted) granted = (await notification.requestPermission()) === "granted";
      if (granted) notification.sendNotification({ title: "Quick Note", body });
    } catch {
      // 忽略：通知只是提醒的一种形态
    }
  }, []);

  // 30 秒轮询一次（与插件同周期）。配置经 dailyRef 读最新值；配置变化时重挂
  // 定时器并重置「已过时间点视为已提醒」的初始标记（插件的 setupReminderTimer 语义）。
  useEffect(() => {
    if (!daily.ready) return;
    firedReminders.current = initialFiredMarks(new Date(), {
      todoEnabled: daily.settings.todoReminderEnabled,
      todoTime: daily.settings.todoReminderTime,
      checkEnabled: daily.settings.checkReminderEnabled,
      checkTime: daily.settings.checkReminderTime,
    });
    const timer = window.setInterval(() => {
      const config = dailyRef.current.settings;
      const due = dueReminders(
        new Date(),
        {
          todoEnabled: config.todoReminderEnabled,
          todoTime: config.todoReminderTime,
          checkEnabled: config.checkReminderEnabled,
          checkTime: config.checkReminderTime,
        },
        firedReminders.current,
      );
      firedReminders.current = due.next;
      if (due.todo) {
        sendSystemNotification("该添加今天的待办事项了");
        setStatus("提醒：该添加今天的待办事项了（可在右侧日历面板录入）");
      }
      if (due.check) {
        const today = dailyRef.current.today;
        const pending = liveItems(dailyRef.current.todos[today]).filter((item) => !item.done);
        if (pending.length > 0) {
          sendSystemNotification(`今天还有 ${pending.length} 项待办未完成`);
          setStatus(`提醒：今天还有 ${pending.length} 项待办未完成`);
        }
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [daily.ready, daily.settings, sendSystemNotification]);

  // ------------------------------------------------------------------ 图片工具栏

  /** 把图片复制到系统剪贴板（统一转成 PNG，Chromium 剪贴板对它支持最稳）。 */
  const copyImageToClipboard = useCallback(
    async (relativePath: string) => {
      if (!vault) return;
      try {
        const data = await readBinary(vault, relativePath);
        const binary = atob(data.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        let pngBlob: Blob = new Blob([bytes], { type: "image/png" });
        if (!relativePath.toLowerCase().endsWith(".png")) {
          // 非 PNG 先经画布转码，ClipboardItem 只保证认 image/png
          const url = URL.createObjectURL(new Blob([bytes], { type: blobTypeOf(relativePath) }));
          try {
            const image = new Image();
            await new Promise<void>((resolve, reject) => {
              image.onload = () => resolve();
              image.onerror = () => reject(new Error("图片解码失败"));
              image.src = url;
            });
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Canvas 不可用");
            ctx.drawImage(image, 0, 0);
            const converted = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob(resolve, "image/png"),
            );
            if (!converted) throw new Error("图片转码失败");
            pngBlob = converted;
          } finally {
            URL.revokeObjectURL(url);
          }
        }
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
        setStatus("已复制图片到剪贴板");
      } catch (e) {
        setError(`复制图片失败：${e}`);
      }
    },
    [vault],
  );

  /**
   * 在系统资源管理器中定位仓库内的文件/目录（revealItemInDir 会高亮它本身）。
   * 文件树的 Alt+点击、右键菜单与编辑器里的 Alt+点击增强共用这一条通道。
   */
  const revealInExplorer = useCallback(
    async (relativePath: string) => {
      if (!vault) {
        setError("尚未打开仓库，无法定位");
        return;
      }
      const clean = relativePath.replace(/[\\/]+$/, "");
      if (!clean) return;
      try {
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
        await revealItemInDir(`${vault.replace(/[\/]+$/, "")}/${clean}`);
        setStatus(`已在资源管理器中显示：${clean}`);
      } catch (e) {
        setError(`定位失败：${e}`);
      }
    },
    [vault],
  );

  // Alt+点击增强的动作注入（行内代码复制 / 资源管理器定位）。
  useEffect(() => {
    resourcesRef.current.altActions = {
      copyText: (text) => {
        void navigator.clipboard.writeText(text).then(() => setStatus(`已复制：${text}`), () => setError("复制失败：剪贴板不可用"));
      },
      revealFile: async (target) => {
        const relative = resolveWikiRelative(resourcesRef.current, target);
        if (!relative) {
          setError(`定位失败：在仓库里找不到「${target}」`);
          return;
        }
        await revealInExplorer(relative);
      },
    };
  }, [vault, notice, revealInExplorer]);

  // ---------------------------------------------------------------- 文件复制粘贴

  const selectedPathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  /**
   * 复制树里的文件/目录：**两边同时生效**——
   * 写入系统剪贴板（资源管理器里 Ctrl+V 粘贴文件），并记入应用内剪贴板
   * （在左侧树选中目录后 Ctrl+V 粘贴进知识库）。
   */
  const copyTreeFile = useCallback(
    async (path: string, isDir: boolean) => {
      if (!vault) return;
      setTreeClipboard({ path, isDir });
      try {
        await copyPathsToClipboard([`${vault.replace(/[\\/]+$/, "")}/${path}`]);
        setStatus(
          isDir
            ? "已复制文件夹：可在资源管理器 Ctrl+V 粘贴；选中目录后 Ctrl+V 粘贴进知识库"
            : "已复制文件：可在资源管理器 Ctrl+V 粘贴；选中目录后 Ctrl+V 粘贴进知识库",
        );
      } catch (e) {
        // 系统剪贴板失败不拦着应用内粘贴：内部剪贴板已经记下了
        setStatus("已复制（系统剪贴板不可用，仍可粘贴进知识库）");
        setError(`写入系统剪贴板失败：${e}`);
      }
    },
    [vault],
  );

  /** 把应用内剪贴板的文件/目录粘贴到指定目录。 */
  const pasteIntoDir = useCallback(
    async (destDir: string) => {
      if (!vault) {
        setError("尚未打开仓库");
        return;
      }
      if (!treeClipboard) {
        setStatus("剪贴板里还没有从知识库复制的文件（右键 → 复制）");
        return;
      }
      try {
        const dest = await copyEntry(vault, treeClipboard.path, destDir);
        await refresh(vault);
        setStatus(`已粘贴到「${destDir || "仓库根目录"}」：${dest}`);
      } catch (e) {
        setError(String(e));
      }
    },
    [vault, treeClipboard, refresh],
  );

  /** 拖拽移动（剪切）树条目到目标目录，随后把打开标签/收藏/最近列表换键。 */
  const moveTreeEntry = useCallback(
    async (path: string, destDir: string) => {
      if (!vault) return;
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent === destDir) {
        setStatus("文件已在目标目录中");
        return;
      }
      if (destDir === path || destDir.startsWith(`${path}/`)) {
        setError("不能把目录移动到它自己内部");
        return;
      }
      try {
        // 正开着的笔记先落盘再移动：拖走的是磁盘文件，未保存内容会留在旧路径
        if (dirty) await saveNow();
        const nextPath = await moveEntry(vault, path, destDir);
        await refresh(vault);
        await rekeyEntryPaths(path, nextPath);
        setStatus(`已移动到「${destDir || "仓库根目录"}」`);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [vault, dirty, saveNow, refresh, rekeyEntryPaths],
  );

  /** 拖拽复制树条目到目标目录（按住 Ctrl 拖）。 */
  const copyTreeTo = useCallback(
    async (path: string, destDir: string) => {
      if (!vault) return;
      if (destDir === path || destDir.startsWith(`${path}/`)) {
        setError("不能把目录复制到它自己内部");
        return;
      }
      try {
        const dest = await copyEntry(vault, path, destDir);
        await refresh(vault);
        setStatus(`已复制到「${destDir || "仓库根目录"}」：${dest}`);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [vault, refresh],
  );

  // 资源管理器 → 知识库：在编辑器/输入框以外按 Ctrl+V 时，把系统剪贴板里的
  // 文件写进「选中的目录」（无选中则用当前笔记所在目录）。
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".cm-editor, input, textarea, select, [contenteditable='true']")) return;
      if (!vault) return;
      const currentPath = currentRef.current?.path;
      // 粘贴目标：选中的目录本身；选中的是文件则落其所在目录；都没有则当前笔记目录
      const picked = selectedPathRef.current;
      const pickedIsDir = picked
        ? (entries.find((entry) => entry.path === picked)?.isDir ?? false)
        : false;
      const dir = picked
        ? pickedIsDir
          ? picked
          : picked.includes("/")
            ? picked.slice(0, picked.lastIndexOf("/"))
            : ""
        : currentPath && currentPath.includes("/")
          ? currentPath.slice(0, currentPath.lastIndexOf("/"))
          : "";
      event.preventDefault();
      void (async () => {
        const saved: string[] = [];
        const failed: string[] = [];
        for (const file of Array.from(files)) {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const dest = await writeAttachment(vault, dir, file.name, toBase64(bytes));
            saved.push(dest);
          } catch (e) {
            failed.push(`${file.name}：${e}`);
          }
        }
        await refresh(vault);
        if (saved.length > 0) {
          setStatus(`已粘贴 ${saved.length} 个文件到「${dir || "仓库根目录"}」`);
        }
        if (failed.length > 0) {
          setError(`粘贴失败：${failed.join("；")}`);
        }
      })();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [vault, refresh, entries]);

  // Ctrl+C / Ctrl+V：焦点在编辑器和输入框之外（文件树、空白区）时，
  // 对「选中的树条目」执行复制/粘贴——与 Obsidian 的文件列表一致。
  // 内部剪贴板为空时不拦截 Ctrl+V，让资源管理器文件的粘贴事件照常走。
  const treeClipboardRef = useRef<{ path: string; isDir: boolean } | null>(null);
  useEffect(() => {
    treeClipboardRef.current = treeClipboard;
  }, [treeClipboard]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (!vault) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest("input, textarea, select, [contenteditable='true']")) return;
      const inEditor = !!active?.closest(".cm-editor");
      const key = event.key.toLowerCase();
      if (key === "c") {
        if (!selectedPathRef.current) return;
        // 编辑器里选中了文本 → 让编辑器自己复制；光标悬空（常见：点开笔记后焦点
        // 在编辑器里）→ 复制树选中项，省得用户必须再点一次文件树
        if (inEditor && !viewRef.current?.state.selection.main.empty) return;
        event.preventDefault();
        const pickedIsDir =
          entries.find((entry) => entry.path === selectedPathRef.current)?.isDir ?? false;
        void copyTreeFile(selectedPathRef.current, pickedIsDir);
      } else if (key === "v") {
        // 编辑器内 Ctrl+V 永远是粘贴文本；文件粘贴只在编辑器以外生效
        if (inEditor) return;
        event.preventDefault();
        const picked = selectedPathRef.current;
        const pickedIsDir = picked
          ? (entries.find((entry) => entry.path === picked)?.isDir ?? false)
          : false;
        const dir = picked
          ? pickedIsDir
            ? picked
            : picked.includes("/")
              ? picked.slice(0, picked.lastIndexOf("/"))
              : ""
          : "";
        void (async () => {
          // 系统剪贴板优先：资源管理器复制的文件直接落库。应用内「复制」也写系统
          // 剪贴板（copyTreeFile），所以一条路径同时覆盖两种来源；读不到文件列表
          // （PowerShell 失败、剪贴板被占用）再回落应用内剪贴板。
          try {
            const sources = await readClipboardFilePaths();
            if (sources.length > 0) {
              const result = await copyExternalIntoVault(vault, sources, dir);
              await refresh(vault);
              if (result.copied.length > 0) {
                setStatus(`已粘贴 ${result.copied.length} 个文件到「${dir || "仓库根目录"}」`);
              }
              if (result.failed.length > 0) {
                setError(`粘贴失败：${result.failed.join("；")}`);
              }
              return;
            }
          } catch {
            // 读系统剪贴板失败：走应用内剪贴板的回落
          }
          if (!treeClipboardRef.current) {
            setStatus("剪贴板里没有可粘贴的文件");
            return;
          }
          await pasteIntoDir(dir);
        })();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vault, entries, treeClipboard, copyTreeFile, pasteIntoDir]);


  // 按住 Alt 时编辑区出现「+」光标：这是 WebView2 的原生悬停表现，但 Alt+点击
  // 在这里的语义是「复制代码 / 定位文件」，用 pointer 提示可点更贴切。
  // Alt 是无处的键盘状态，keydown/keyup 都在 window 上跟踪；失焦时清掉。
  useEffect(() => {
    const setHeld = (held: boolean) => document.documentElement.classList.toggle("qn-alt-held", held);
    const down = (event: KeyboardEvent) => {
      if (event.key === "Alt") setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Alt") setHeld(false);
    };
    const clear = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      setHeld(false);
    };
  }, []);

  // 图片工具栏的动作注入（widget 经上下文读到；仓库切换时这里重挂最新闭包）。
  useEffect(() => {
    resourcesRef.current.imageActions = {
      copy: (relativePath) => void copyImageToClipboard(relativePath),
      crop: (relativePath) => setCropPath(relativePath),
      rename: (relativePath) => beginRename(relativePath),
      remove: (relativePath) => setPendingDelete({ path: relativePath, isDir: false }),
    };
  }, [copyImageToClipboard, beginRename]);

  // ------------------------------------------------------------------ 快捷键

  /** 在编辑器光标处插入文本（插入时间/日期快捷键的实现基底）。 */
  const insertAtCursor = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  }, []);

  /** 快捷键动作表。命令面板按同一份文案生成动作项，这里集中定义避免两处漂移。 */
  const shortcuts = useMemo(
    () => ({
      palette: () => setPaletteOpen((value) => !value),
      newNote: () => beginCreate("note"),
      newDiary: () => beginCreate("diary"),
      newFolder: () => beginCreate("folder"),
      save: () => void saveRef.current(),
      toggleMode: () => changeMode(modeRef.current === "live" ? "source" : "live"),
      toggleLeft: () => setLeftCollapsed((value) => !value),
      toggleRight: () => setRightCollapsed((value) => !value),
      openSettings: () => setShowSettings((value) => !value),
      openVaultPicker: () => void openVault(),
      syncNow: () => syncRef.current?.syncNow(),
      zen: () => setZen((value) => !value),
      insertDate: () => insertAtCursor(daily.today),
      insertTime: () => insertAtCursor(moment().format("HH:mm")),
      toggleTags: () => {
        if (!currentRef.current || !isMarkdownPath(currentRef.current.path)) {
          notice("请先打开一篇笔记再打标签", "error");
          return;
        }
        setTagPopoverOpen((value) => !value);
      },
    }),
    // 这些回调内部要么读 ref、要么函数式 setState，身份变化不会造成额外开销
    [beginCreate, changeMode, openVault, insertAtCursor, daily.today, notice],
  );

  // 快捷键绑定（Obsidian 式可重绑定）：设置面板改绑定后这里经版本号重算。
  const [hotkeysEpoch, setHotkeysEpoch] = useState(0);
  useEffect(() => onHotkeysChange(() => setHotkeysEpoch((n) => n + 1)), []);
  const bindings = useMemo(() => allBindings(), [hotkeysEpoch]);

  // 全局快捷键。CM 的键位只管编辑器内部；这里的键在任何焦点下都要生效。
  // 具体键位在「设置 → 快捷键」里可改，这里只认绑定表。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = matchCommand(event, bindings);
      if (!command) return;
      const run = shortcuts[command.id as keyof typeof shortcuts] as (() => void) | undefined;
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts, bindings]);

  // 全局 Esc 兜底：重命名/新建输入行、右键菜单。此前 Esc 只挂在输入框自身的
  // onKeyDown 上，焦点一点走（比如去点别的面板）Esc 就再也关不掉重命名了。
  // 输入框内的 Esc 由输入框自己处理（冒泡到这里时 activeElement 还在行内，直接放过）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".create-row")) return;
      if (tabMenu) {
        setTabMenu(null);
        return;
      }
      if (vaultMenu) {
        setVaultMenu(null);
        return;
      }
      if (menu) {
        setMenu(null);
        return;
      }
      if (renaming) {
        cancelRename();
        return;
      }
      if (creating) cancelCreate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [renaming, creating, menu, vaultMenu, tabMenu, cancelRename, cancelCreate]);

  /** 命令面板的动作清单在 verifyRoundTrip 之后定义（动作里引用了它）。 */

  /**
   * M0 验收用：写盘后立刻回读，比较哈希与内容是否与原样一致。
   * 这是"字节精确往返"的现场证明。
   */
  const verifyRoundTrip = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !vault || !current) return;
    try {
      const content = view.state.sliceDoc();
      const written = await writeNote(vault, current.path, content, current.hasBom);
      const reread = await readNote(vault, current.path);
      const same = reread.sha256 === written.sha256 && reread.content === content;
      setRoundTrip(same ? `一致 ✓ ${written.sha256.slice(0, 12)}` : "不一致 ✗");
      setOpenTabs((prev) =>
        prev.map((tab) =>
          tab.path === current.path ? { ...tab, sha256: reread.sha256, size: reread.size } : tab,
        ),
      );
      dirtyTabs.current.delete(current.path);
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [vault, current]);

  /** 命令面板动作上的键位提示：跟随「设置 → 快捷键」里的当前绑定。 */
  const keyHint = useCallback(
    (id: string): string | undefined => {
      const keys = bindings.find((cmd) => cmd.id === id)?.keys;
      return keys && keys.length > 0 ? formatKey(keys[0]) : undefined;
    },
    [bindings],
  );

  /** 命令面板的动作清单（快捷操作组）。 */
  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: "new-note", title: "新建笔记", hint: keyHint("newNote"), icon: "📝", run: shortcuts.newNote },
      { id: "new-diary", title: "新建今日日记", icon: "📅", run: shortcuts.newDiary },
      { id: "new-folder", title: "新建文件夹", icon: "📁", run: shortcuts.newFolder },
      { id: "save", title: "保存当前笔记", hint: keyHint("save"), icon: "💾", run: shortcuts.save },
      { id: "mode", title: mode === "live" ? "切换到源码模式" : "切换到实时预览", hint: keyHint("toggleMode"), icon: "🔀", run: shortcuts.toggleMode },
      { id: "left", title: leftCollapsed ? "展开文件栏" : "收起文件栏", hint: keyHint("toggleLeft"), icon: "◧", run: shortcuts.toggleLeft },
      { id: "right", title: rightCollapsed ? "展开右侧面板" : "收起右侧面板", hint: keyHint("toggleRight"), icon: "◨", run: shortcuts.toggleRight },
      { id: "zen", title: zen ? "退出专注模式" : "专注模式（隐藏侧栏）", hint: keyHint("zen"), icon: "🎯", run: shortcuts.zen },
      { id: "review-week", title: "生成本周回顾（插入光标处）", icon: "🗓️", run: () => void insertWeeklyReview(moment().startOf("isoWeek").format("YYYY-MM-DD"), true) },
      { id: "review-pick", title: "生成选定周的回顾…", icon: "🗓️", run: () => setWeekDialogOpen(true) },
      { id: "sync", title: "立即同步", icon: "☁️", run: shortcuts.syncNow },
      { id: "vault", title: "打开其他仓库…", icon: "📂", run: shortcuts.openVaultPicker },
      { id: "settings", title: "打开设置", hint: keyHint("openSettings"), icon: "⚙️", run: shortcuts.openSettings },
      { id: "export-pdf", title: "导出 PDF（打印对话框，选「另存为 PDF」）", icon: "🖨️", run: () => void exportPdf() },
      { id: "export-pdf-file", title: "导出 PDF 文件（选定位置，直接落盘）", icon: "📄", run: () => void exportPdfFile() },
      { id: "roundtrip", title: "校验字节往返（写后读比对）", icon: "🧪", run: () => void verifyRoundTrip() },
    ],
    [shortcuts, mode, leftCollapsed, rightCollapsed, zen, verifyRoundTrip, insertWeeklyReview, keyHint, exportPdf, exportPdfFile, vault],
  );

  return (
    <div className={`app${zen ? " zen" : ""}`}>
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar-side">
          <button
            type="button"
            className={`icon-btn${leftCollapsed ? "" : " is-on"}`}
            onClick={shortcuts.toggleLeft}
            title="文件栏（Ctrl+B）"
            aria-pressed={leftCollapsed}
          >
            <IconPanelLeft size={16} />
          </button>
          <div className="brand" data-tauri-drag-region>
            <IconSparkles size={15} className="brand-mark" />
            <span>Quick Note</span>
          </div>
          <button
            type="button"
            className={`vault-pill${vaultMenu ? " is-open" : ""}`}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setVaultMenu({ x: rect.left, y: rect.bottom + 6 });
            }}
            title={vault ?? "点击选择仓库（最近的仓库会列在下拉里）"}
          >
            {vaultName ?? "未选择仓库"}
          </button>
        </div>

        <button
          type="button"
          className="searchbox"
          onClick={shortcuts.palette}
          title="全局搜索笔记与内容，或执行命令（Ctrl+K）"
        >
          <IconSearch size={14} />
          <span className="searchbox-placeholder">搜索笔记、全文内容，或输入命令…</span>
          <kbd className="searchbox-kbd">Ctrl K</kbd>
        </button>

        <div className="topbar-side topbar-end">
          <div className="mode-switch" role="group" aria-label="视图模式">
            <button
              type="button"
              className={`seg${mode === "live" ? " is-on" : ""}`}
              onClick={() => changeMode("live")}
              title="渲染语法标记，光标所在行显示源码（Ctrl+E 切换）"
            >
              <IconEye size={13} />
              实时
            </button>
            <button
              type="button"
              className={`seg${mode === "source" ? " is-on" : ""}`}
              onClick={() => changeMode("source")}
              title="显示 Markdown 原文（Ctrl+E 切换）"
            >
              <IconCode size={13} />
              源码
            </button>
          </div>
          <span
            className={`save-chip${dirty ? " is-dirty" : ""}`}
            title={dirty ? "有未保存改动，1 秒左右自动保存（Ctrl+S 立即保存）" : "所有改动已保存"}
          >
            <span className="save-chip-dot" />
            {dirty ? "未保存" : "已保存"}
          </span>
          {current && dirty && (
            <button
              type="button"
              className="icon-btn"
              onClick={shortcuts.save}
              title="立即保存（Ctrl+S）"
            >
              <IconSave size={16} />
            </button>
          )}
          {current && isMarkdownPath(current.path) && (
            <button
              type="button"
              className={`icon-btn${tagPopoverOpen ? " is-on" : ""}`}
              onClick={() => setTagPopoverOpen((value) => !value)}
              title={noteTagList.length > 0 ? `标签（${noteTagList.length}）` : "添加标签"}
              aria-pressed={tagPopoverOpen}
            >
              <IconTag size={16} />
            </button>
          )}
          <button
            type="button"
            className={`icon-btn${showSettings ? " is-on" : ""}`}
            onClick={shortcuts.openSettings}
            title={keyHint("openSettings") ? `设置（${keyHint("openSettings")}）` : "设置"}
          >
            <IconSettings size={16} />
          </button>
          <button
            type="button"
            className={`icon-btn${zen ? " is-on" : ""}`}
            onClick={shortcuts.zen}
            title="专注模式（Ctrl+Shift+F）"
            aria-pressed={zen}
          >
            <IconFocus size={16} />
          </button>
          <button
            type="button"
            className={`icon-btn${rightCollapsed ? "" : " is-on"}`}
            onClick={shortcuts.toggleRight}
            title="侧栏（Ctrl+Shift+B）"
            aria-pressed={rightCollapsed}
          >
            <IconPanelRight size={16} />
          </button>
          <div className="window-controls" data-tauri-drag-region>
            <button
              type="button"
              className={`win-btn${alwaysOnTop ? " is-on" : ""}`}
              title={alwaysOnTop ? "取消窗口置顶" : "窗口置顶（悬浮不被遮挡）"}
              aria-pressed={alwaysOnTop}
              onClick={() => setAlwaysOnTop((value) => !value)}
            >
              <IconPin size={14} />
            </button>
            <button
              type="button"
              className="win-btn"
              title="最小化"
              onClick={() => void appWindow.minimize()}
            >
              <IconMinus size={14} />
            </button>
            <button
              type="button"
              className="win-btn"
              title={maximized ? "向下还原" : "最大化"}
              onClick={() => void appWindow.toggleMaximize()}
            >
              {maximized ? <IconCopy size={13} /> : <IconSquare size={13} />}
            </button>
            <button
              type="button"
              className="win-btn win-close"
              title="关闭"
              onClick={() => void appWindow.close()}
            >
              <IconX size={14} />
            </button>
          </div>
        </div>
      </header>

      {tagPopoverOpen && current && isMarkdownPath(current.path) && (
        <TagPopover
          tags={noteTagList}
          vocabulary={tagVocab}
          onAdd={addNoteTag}
          onRemove={removeNoteTag}
          onClose={() => setTagPopoverOpen(false)}
        />
      )}

      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        applySettings={applySettings}
        imagePaths={vaultImages}
        daily={daily}
        sync={sync}
        dataPaths={dataPaths}
        onPickDataDir={() => void pickDataDir()}
        onClearDataDir={() => void clearDataDir()}
        customCssDraft={customCssDraft}
        onCustomCssChange={(value) => {
          setCustomCssDraft(value);
          saveCustomCss(value);
          applyCustomCss(value);
        }}
        appVersion={appVersion}
        updateCheck={updateCheck}
        checkUpdate={checkUpdate}
        installUpdate={() => void installUpdate()}
        openReleasePage={(url) => void openReleasePage(url)}
      />

      {/* 发现新版本的弹窗：启动自动检查或手动检查发现可用更新时出现，展示新版本介绍 */}
      {updateCheck.available && !updateCheck.dismissed && updateCheck.state !== "downloading" && updateCheck.state !== "installing" && (
        <>
          <div className="menu-backdrop" onClick={() => setUpdateCheck((prev) => ({ ...prev, dismissed: true }))} />
          <div className="update-dialog" role="alertdialog" aria-label="发现新版本">
            <div className="update-dialog-head">
              <span className="update-dialog-title">{updateCheck.message}</span>
              <button
                type="button"
                className="icon-btn"
                title="稍后再说"
                onClick={() => setUpdateCheck((prev) => ({ ...prev, dismissed: true }))}
              >
                <IconX size={14} />
              </button>
            </div>
            {updateCheck.notes && (
              <div className="update-dialog-notes">{updateCheck.notes}</div>
            )}
            <div className="update-dialog-actions">
              <button type="button" className="btn" onClick={() => void installUpdate()}>
                立即更新
              </button>
              {updateCheck.url && (
                <button type="button" className="btn btn-ghost" onClick={() => void openReleasePage(updateCheck.url!)}>
                  查看发布页
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setUpdateCheck((prev) => ({ ...prev, dismissed: true }))}
              >
                稍后
              </button>
            </div>
          </div>
        </>
      )}
      {updateCheck.state === "downloading" && (
        <div className="update-banner" role="status">
          <span>{updateCheck.message}（完成后应用将自动重启）</span>
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}
      {daily.configError && (
        <div className="banner banner-error">
          <span>{daily.configError}</span>
          <button type="button" className="btn btn-ghost" onClick={() => daily.reload()}>
            重新读取
          </button>
        </div>
      )}
      {sync.stateError && (
        <div className="banner banner-error">
          <span>{sync.stateError}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => sync.reloadState()}
            title="重新读一次状态文件；如果只是暂时读不到，这样就能恢复"
          >
            重新读取
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => sync.resetState()}
            title="游标与哈希会清空，下次同步从零开始（本地笔记不受影响）"
          >
            重置同步状态
          </button>
        </div>
      )}
      {sync.saveError && (
        <div className="banner banner-warn">
          <span>{sync.saveError}（同步仍在进行，只是下次启动会退回上次落盘的状态）</span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => sync.dismissSaveError()}>
            知道了
          </button>
        </div>
      )}
      {sync.conflicts.length > 0 && (
        <div className="banner banner-warn">
          <div>
            <div>
              云同步：本地与云端都改动过 {sync.conflicts.length} 个文件，已保留本地版本并重新上传。
            </div>
            <ul className="conflict-list">
              {sync.conflicts.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => sync.dismissConflicts()}>
            知道了
          </button>
        </div>
      )}
      {current?.mixedLineEndings && (
        <div className="banner banner-warn">
          该文件混用了多种换行符。保存不会改写它们，但编辑时显示可能异常。
        </div>
      )}
      {conflict && (
        <div className="banner banner-warn">
          <span>该文件已被外部修改，而你本地有未保存的编辑，我没有直接覆盖。</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => adoptFromDisk(conflict)}>
            加载磁盘版本
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setConflict(null)}
            title="保留当前编辑；下次保存会覆盖磁盘上的版本"
          >
            保留我的编辑
          </button>
        </div>
      )}

      {pendingDelete && (
        <div className="banner banner-warn">
          <span>
            确定把「{pendingDelete.path}」移入回收目录吗？文件会进仓库内的 .trash，可以找回。
          </span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => void confirmDelete()}>
            移入回收目录
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setPendingDelete(null)}>
            取消
          </button>
        </div>
      )}

      {vaultMenu && (
        <>
          {/* 点空白处关闭菜单 */}
          <div className="menu-backdrop" onClick={() => setVaultMenu(null)} onContextMenu={(event) => {
            event.preventDefault();
            setVaultMenu(null);
          }} />
          <div className="context-menu vault-menu" ref={menuRefClampedToViewport(vaultMenu.x, vaultMenu.y)} style={{ left: vaultMenu.x, top: vaultMenu.y }}>
            {vaultRecents.filter((p) => p !== vault).length === 0 && (
              <div className="vault-menu-empty">还没有最近打开的仓库</div>
            )}
            {vaultRecents
              .filter((p) => p !== vault)
              .slice(0, 8)
              .map((p) => (
                <button
                  key={p}
                  type="button"
                  title={p}
                  onClick={() => openRecentVault(p)}
                >
                  <IconLibrary size={13} />
                  <span className="vault-menu-name">{vaultDisplayName(p)}</span>
                </button>
              ))}
            <div className="vault-menu-sep" />
            <button
              type="button"
              onClick={() => {
                setVaultMenu(null);
                void openVault();
              }}
            >
              选择其他仓库…
            </button>
          </div>
        </>
      )}

      {menu && (
        <>
          {/* 点空白处关闭菜单 */}
          <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(event) => {
            event.preventDefault();
            setMenu(null);
          }} />
          <div className="context-menu" ref={menuRefClampedToViewport(menu.x, menu.y)} style={{ left: menu.x, top: menu.y }}>
            {!menu.isDir && (
              <button
                type="button"
                onClick={() => {
                  toggleFavorite(menu.path);
                  setMenu(null);
                }}
              >
                {favorites.includes(menu.path) ? "取消收藏" : "收藏"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                // 新建落点：选中的目录；选中文件时是其所在目录
                beginCreate("note", menu.isDir ? menu.path : parentFolderOf(menu.path));
                setMenu(null);
              }}
            >
              新建笔记
            </button>
            <button
              type="button"
              onClick={() => beginRename(menu.path, menu.origin === "daily" ? "daily" : "tree")}
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => {
                void copyTreeFile(menu.path, menu.isDir);
                setMenu(null);
              }}
            >
              复制
            </button>
            {menu.isDir && treeClipboard && (
              <button
                type="button"
                onClick={() => {
                  void pasteIntoDir(menu.path);
                  setMenu(null);
                }}
              >
                粘贴到此目录
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void revealInExplorer(menu.path);
                setMenu(null);
              }}
            >
              在资源管理器中显示
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setPendingDelete({ path: menu.path, isDir: menu.isDir });
                setMenu(null);
              }}
            >
              删除…
            </button>
          </div>
        </>
      )}

      {tabMenu &&
        (() => {
          const index = orderedOpenTabs.findIndex((tab) => tab.path === tabMenu.path);
          const closable = (tab: NoteContent) => !pinnedSet.has(tab.path);
          const left = orderedOpenTabs.slice(0, index).filter(closable);
          const right = orderedOpenTabs.slice(index + 1).filter(closable);
          const others = orderedOpenTabs.filter((tab) => tab.path !== tabMenu.path && closable(tab));
          const all = orderedOpenTabs.filter(closable);
          const isPinned = pinnedSet.has(tabMenu.path);
          return (
            <>
              <div
                className="menu-backdrop"
                onClick={() => setTabMenu(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setTabMenu(null);
                }}
              />
              <div
                className="context-menu"
                ref={menuRefClampedToViewport(tabMenu.x, tabMenu.y)}
                style={{ left: tabMenu.x, top: tabMenu.y }}
              >
                <button
                  type="button"
                  onClick={() => {
                    togglePinTab(tabMenu.path);
                    setTabMenu(null);
                  }}
                >
                  {isPinned ? "取消固定" : "固定标签"}
                </button>
                <button
                  type="button"
                  disabled={left.length === 0}
                  onClick={() => {
                    void closeTabsBatch(left.map((tab) => tab.path));
                    setTabMenu(null);
                  }}
                >
                  关闭左侧标签{left.length > 0 ? `（${left.length}）` : ""}
                </button>
                <button
                  type="button"
                  disabled={right.length === 0}
                  onClick={() => {
                    void closeTabsBatch(right.map((tab) => tab.path));
                    setTabMenu(null);
                  }}
                >
                  关闭右侧标签{right.length > 0 ? `（${right.length}）` : ""}
                </button>
                <button
                  type="button"
                  disabled={others.length === 0}
                  onClick={() => {
                    void closeTabsBatch(others.map((tab) => tab.path));
                    setTabMenu(null);
                  }}
                >
                  关闭其他标签
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={all.length === 0}
                  onClick={() => {
                    void closeTabsBatch(all.map((tab) => tab.path));
                    setTabMenu(null);
                  }}
                >
                  关闭全部标签
                </button>
              </div>
            </>
          );
        })()}

      <div className={`body${leftCollapsed ? " left-collapsed" : ""}${rightCollapsed ? " right-collapsed" : ""}`}>
        <aside className="sidebar sidebar-left" ref={sidebarLeftRef}>
          <div className="panel-head">
            <span className="panel-title">知识库</span>
            <span className="panel-count" title="仓库内笔记数">{noteCount}</span>
            <span className="spacer" />
            <button
              type="button"
              className="icon-btn"
              disabled={!vault}
              onClick={() => beginCreate("diary")}
              title="新建今天的日记（按日期命名）"
            >
              <IconCalendarPlus size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={!vault}
              onClick={() => beginCreate("folder")}
              title="新建文件夹"
            >
              <IconFolderPlus size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={!vault}
              onClick={() => beginCreate("note")}
              title="新建笔记（Ctrl+N）"
            >
              <IconPlus size={15} />
            </button>
          </div>
          <div className="left-view" role="tablist" aria-label="导航视图">
            <button
              type="button"
              role="tab"
              aria-selected={leftView === "files"}
              className={`left-view-tab${leftView === "files" ? " is-on" : ""}`}
              onClick={() => setLeftView("files")}
            >
              <IconLibrary size={13} />
              知识库
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={leftView === "favorites"}
              className={`left-view-tab${leftView === "favorites" ? " is-on" : ""}`}
              onClick={() => setLeftView("favorites")}
            >
              <IconStar size={13} />
              收藏{visibleFavorites.length > 0 ? ` ${visibleFavorites.length}` : ""}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={leftView === "recents"}
              className={`left-view-tab${leftView === "recents" ? " is-on" : ""}`}
              onClick={() => setLeftView("recents")}
            >
              <IconClock size={13} />
              最近
            </button>
          </div>
          {leftView === "files" && (
            <div className="sidebar-filter">
              <IconSearch size={13} />
              <input
                type="text"
                value={treeFilter}
                placeholder="筛选笔记名…"
                onChange={(event) => setTreeFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setTreeFilter("");
                }}
              />
              {treeFilter && (
                <button
                  type="button"
                  className="icon-btn filter-clear"
                  onClick={() => setTreeFilter("")}
                  title="清除筛选"
                >
                  <IconX size={11} />
                </button>
              )}
            </div>
          )}
          {(creating || (renaming && renameOwner === "tree")) && (
            <div className="create-row">
              <input
                autoFocus
                type="text"
                value={draft}
                placeholder={
                  renaming
                    ? "新名称"
                    : creating === "diary"
                      ? "日记名字（今天：" + daily.today + "）"
                      : creating === "note"
                        ? "笔记名称，可写 子目录/名称"
                        : "文件夹名称"
                }
                onChange={(event) => setDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void (renaming ? submitRename() : submitCreate());
                  if (event.key === "Escape") (renaming ? cancelRename : cancelCreate)();
                }}
              />
              <div className="create-hint">
                {renaming
                  ? `重命名 ${renaming.slice(renaming.lastIndexOf("/") + 1)} · Enter 确认 / Esc 取消`
                  : creating === "diary"
                    ? `新建到 ${daily.settings.folder || "仓库根目录"} · 文件名 = 日期 + 空格 + 名字 · Enter 确认 / Esc 取消`
                    : `新建到 ${(creating === "note" ? createFolderOverride : "") || createTargetFolder() || "仓库根目录"} · Enter 确认 / Esc 取消`}
              </div>
            </div>
          )}
          <FileTree
            entries={entries}
            activePath={current?.path ?? null}
            filter={treeFilter}
            view={leftView}
            favorites={visibleFavorites}
            recents={recents}
            selectedPath={selectedPath}
            onSelectPath={setSelectedPath}
            onOpen={(p) => void openEntry(p)}
            onContext={openContextMenu}
            onReveal={(p) => void revealInExplorer(p)}
            onMoveEntry={(p, dest) => void moveTreeEntry(p, dest)}
            onCopyEntry={(p, dest) => void copyTreeTo(p, dest)}
          />
        </aside>
        <main className="editor-pane">
          {openTabs.length > 0 && (
            <div
              className="tabbar"
              role="tablist"
              aria-label="打开的笔记"
              onWheel={(event) => {
                // 标签多到溢出时，纵向滚轮横着滚标签栏（触控板 deltaX 本来就是横向的）。
                // 不 preventDefault：这里没有别的纵向滚动可抢，React 的 wheel 监听是被动式
                const el = event.currentTarget;
                const delta =
                  Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
                if (delta !== 0) el.scrollLeft += delta;
              }}
            >
              {orderedOpenTabs.map((tab) => {
                const isPinned = pinnedSet.has(tab.path);
                return (
                  <div
                    key={tab.path}
                    role="tab"
                    aria-selected={tab.path === activeTab}
                    tabIndex={0}
                    className={`tab${tab.path === activeTab ? " is-active" : ""}${
                      dirtyTabs.current.has(tab.path) ? " is-dirty" : ""
                    }${isPinned ? " is-pinned" : ""}`}
                    title={isPinned ? `${tab.path}（已固定）` : tab.path}
                    onClick={() => void openNote(tab.path)}
                    onAuxClick={(event) => {
                      // 中键关闭（固定标签不响应）
                      if (event.button === 1) {
                        event.preventDefault();
                        if (!isPinned) void closeTab(tab.path);
                      }
                    }}
                    onContextMenu={(event) => {
                      // 浏览器式的标签页菜单：固定 / 关闭左侧·右侧·其他·全部
                      event.preventDefault();
                      setTabMenu({ path: tab.path, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="tab-title">{baseName(tab.path)}</span>
                    {!isPinned && (
                      <button
                        type="button"
                        className="tab-close"
                        aria-label={`关闭 ${baseName(tab.path)}`}
                        title="关闭（有改动会先保存）"
                        onClick={(event) => {
                          event.stopPropagation();
                          void closeTab(tab.path);
                        }}
                      >
                        <IconX size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {inTable && current && (
            <div className="table-toolbar" aria-label="表格工具栏">
              <span className="table-toolbar-label">表格</span>
              <button type="button" className="mini-btn" onClick={() => runTableCmd(insertRowAbove)} title="在上方插入一行">
                上插行
              </button>
              <button type="button" className="mini-btn" onClick={() => runTableCmd(insertRowBelow)} title="在下方插入一行">
                下插行
              </button>
              <button type="button" className="mini-btn" onClick={() => runTableCmd(deleteRowAtCursor)} title="删除光标所在行">
                删行
              </button>
              <button type="button" className="mini-btn" onClick={() => runTableCmd(insertColumnLeft)} title="在左侧插入一列">
                左插列
              </button>
              <button type="button" className="mini-btn" onClick={() => runTableCmd(insertColumnRight)} title="在右侧插入一列">
                右插列
              </button>
              <button type="button" className="mini-btn" onClick={() => runTableCmd(deleteColumnAtCursor)} title="删除光标所在列">
                删列
              </button>
              <button type="button" className="mini-btn" onClick={() => runTableCmd(formatTableAtCursor)} title="对齐所有管道（按显示宽度，中文算两格）">
                对齐
              </button>
              <span className="table-toolbar-hint">Tab 下一格 · 单元格可直接编辑 · 右键单元格插入/删除行列</span>
            </div>
          )}
          <div
            className={`editor-host${mode === "live" && (!current || isMarkdownPath(current.path)) ? " is-live" : " is-source"}`}
            ref={hostRef}
          />
          {previewPath && vault && (
            <FilePreview vault={vault} path={previewPath} onClose={() => setPreviewPath(null)} />
          )}
          {/* 空状态只在**确实没有任何标签**时渲染：曾经 activeTab 与 openTabs
              短暂错位时（替换式打开的中间帧），这层会叠在上一篇内容上透出 */}
          {!current && openTabs.length === 0 && (
            <div className="editor-empty">
              <div className="editor-empty-logo">
                <IconSparkles size={26} />
              </div>
              <h2>Quick Note</h2>
              <p>在左侧选择一篇笔记开始编辑，或从下面的快捷操作开始。</p>
              <div className="editor-empty-actions">
                <button type="button" className="btn" onClick={shortcuts.newNote}>
                  <IconPlus size={14} /> 新建笔记
                </button>
                <button type="button" className="btn" onClick={shortcuts.newDiary}>
                  <IconCalendarPlus size={14} /> 今日日记
                </button>
                <button type="button" className="btn btn-ghost" onClick={shortcuts.palette}>
                  <IconSearch size={14} /> 全局搜索
                </button>
              </div>
              <div className="editor-empty-keys">
                <span><kbd>Ctrl K</kbd> 命令面板</span>
                <span><kbd>Ctrl N</kbd> 新建笔记</span>
                <span><kbd>Ctrl E</kbd> 切换实时 / 源码</span>
              </div>
            </div>
          )}
          {leftCollapsed && (
            <button
              type="button"
              className="sidebar-restore"
              onClick={() => setLeftCollapsed(false)}
              title="展开文件栏（Ctrl+B）"
            >
              »
            </button>
          )}
          {rightCollapsed && (
            <button
              type="button"
              className="sidebar-restore sidebar-restore-right"
              onClick={() => setRightCollapsed(false)}
              title="展开面板（Ctrl+Shift+B）"
            >
              «
            </button>
          )}
        </main>
        <aside className="sidebar sidebar-right">
          <div className="sidebar-tabs" role="tablist" aria-label="右侧面板">
            <button
              type="button"
              role="tab"
              aria-selected={rightPanel === "daily"}
              className={`sidebar-tab${rightPanel === "daily" ? " is-on" : ""}`}
              onClick={() => changeRightPanel("daily")}
            >
              <IconCalendar size={13} />
              日历
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightPanel === "outline"}
              className={`sidebar-tab${rightPanel === "outline" ? " is-on" : ""}`}
              onClick={() => changeRightPanel("outline")}
            >
              <IconListTree size={13} />
              目录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightPanel === "stats"}
              className={`sidebar-tab${rightPanel === "stats" ? " is-on" : ""}`}
              onClick={() => changeRightPanel("stats")}
            >
              <IconChart size={13} />
              统计
            </button>
          </div>
          {rightPanel === "daily" && (
            <CalendarPanel
              controller={daily}
              onOpen={(p) => void openEntry(p)}
              onCreateDaily={(dateStr, name) => void openDaily(dateStr, name)}
              onOpenWeekly={(weekKey, mondayKey) => void openWeekly(weekKey, mondayKey)}
              onContext={openContextMenu}
              renaming={
                renaming && renameOwner === "daily"
                  ? {
                      path: renaming,
                      draft,
                      hint: `重命名 ${renaming.slice(renaming.lastIndexOf("/") + 1)} · Enter 确认 / Esc 取消`,
                    }
                  : null
              }
              onRenameDraft={setDraft}
              onRenameSubmit={() => void submitRename()}
              onRenameCancel={cancelRename}
            />
          )}
          {rightPanel === "outline" && (
            <OutlinePanel
              getView={() => viewRef.current}
              revision={revision}
              activeKey={activeTab}
              cursorLine={cursorLine}
              onJump={jumpToLine}
            />
          )}
          {rightPanel === "stats" && (
            <StatsPanel entries={entries} daily={daily} onOpen={(p) => void openEntry(p)} />
          )}
        </aside>
      </div>

      <footer className="statusbar">
        <span className="status-cell">{current?.path ?? "未打开文件"}</span>
        {current && (
          <>
            <span className="status-cell">
              换行符 {lineEndingLabel(current.lineEnding)}
            </span>
            <span className="status-cell">BOM {current.hasBom ? "有" : "无"}</span>
            <span className="status-cell">{current.size} 字节</span>
            <span className="status-cell mono" title={current.sha256}>
              sha256 {current.sha256.slice(0, 12)}
            </span>
          </>
        )}
        <span className="spacer" />
        {roundTrip && <span className="status-cell status-ok">往返校验 {roundTrip}</span>}
        {status && <span className="status-cell">{status}</span>}
        <button
          type="button"
          className={`status-cell sync-status is-${sync.status}`}
          onClick={() => sync.syncNow()}
          title={
            sync.error ??
            "点一下立即同步（自动同步每 5 分钟一次，改动后 3 秒推送）"
          }
        >
          {syncLabel(sync.status, sync.lastSyncAt, sync.error)}
        </button>
        <span className="status-cell muted">{noteCount} 篇</span>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        entries={entries}
        vault={vault}
        onOpenNote={(path, line) => void openNoteAt(path, line)}
        actions={paletteActions}
      />

      <WeekReviewDialog
        open={weekDialogOpen}
        onClose={() => setWeekDialogOpen(false)}
        onPick={(mondayISO) => void insertWeeklyReview(mondayISO, false)}
      />

      <ImageCropDialog
        open={cropPath !== null}
        vault={vault ?? ""}
        path={cropPath ?? ""}
        onClose={() => setCropPath(null)}
        notice={notice}
      />
    </div>
  );
}

/** 取路径的文件名（标签页标题）。 */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 取仓库路径的目录名（最近仓库下拉里显示用的短名）。 */
function vaultDisplayName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** 状态栏上的同步指示文案。 */
function syncLabel(status: string, lastSyncAt: number, error: string | null): string {
  if (status === "off") return "同步未启用";
  if (status === "syncing") return "同步中…";
  if (status === "error") return `同步失败：${error ?? "未知原因"}`;
  if (lastSyncAt === 0) return "同步已就绪";
  const when = new Date(lastSyncAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `已同步 ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

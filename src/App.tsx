import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import moment from "moment";
import type { Moment } from "moment";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CalendarPanel from "./components/CalendarPanel";
import CommandPalette, { type PaletteAction } from "./components/CommandPalette";
import FilePreview from "./components/FilePreview";
import FileTree, { topLevelDirs } from "./components/FileTree";
import HeadingLevelDialog from "./components/HeadingLevelDialog";
import ImageCropDialog from "./components/ImageCropDialog";
import OutlinePanel from "./components/OutlinePanel";
import QuickCaptureDialog from "./components/QuickCaptureDialog";
import RecentFilesDialog from "./components/RecentFilesDialog";
import QuickTodoDialog from "./components/QuickTodoDialog";
import AddWordDialog from "./components/AddWordDialog";
import DdlDialog from "./components/DdlDialog";
import SplitPane from "./components/SplitPane";
import CaptureManager from "./components/CaptureManager";
import ScreenshotDialog from "./components/ScreenshotDialog";
import SettingsDialog from "./components/SettingsDialog";
import StatsPanel from "./components/StatsPanel";
import VocabularyPanel from "./components/VocabularyPanel";
import TagDashboard from "./components/TagDashboard";
import TagPopover from "./components/TagPopover";
import WeekReviewDialog from "./components/WeekReviewDialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  IconCalendar,
  IconCalendarPlus,
  IconArrowLeft,
  IconArrowRight,
  IconChart,
  IconCheck,
  IconClock,
  IconCode,
  IconCopy,
  IconDots,
  IconEye,
  IconFocus,
  IconFolder,
  IconFolderPlus,
  IconCloud,
  IconHome,
  IconLibrary,
  IconListTree,
  IconMenu,
  IconMinus,
  IconPanelLeft,
  IconPanelRight,
  IconPenLine,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSave,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSquare,
  IconStar,
  IconTag,
  IconX,
} from "./components/icons";
import { allowAssetAnyDir, allowAssetDir, appDataPaths, copyEntry, copyExternalIntoVault, copyPathsToClipboard, createFolder, createNote, defaultVaultDir, deleteEntry, focusVaultWindow, ensureDirectory, listDirImages, listVaults, localSyncedVaults, listEntries, moveEntry, onScreenshotHotkey, onVaultChanged, openedVaults, pickDirectory, pickVault, readBinary, readClipboardFilePaths, readNote, readNoteOptional, registerOpenVault, renameEntry, openNewWindow, screenshotCapture, searchVault, setCustomDataDir, setScreenshotHotkey, startupFile, startupVault, unregisterOpenVault, vaultHomeGet, watchVault, writeAttachment, writeNote } from "./lib/api";
import { isMobile } from "./lib/platform";
import { MobileVaultGate, vaultHomeSkipped } from "./components/MobileVaultGate";
import type { AppDataPaths, EntryMeta, NoteContent, VaultInfo } from "./lib/api";
import { applyDarkTheme, applyEditable, applyLivePreviewContext, applyMode, createEditor, createEditorState, type ViewMode } from "./lib/editor";
import { editorLanguageOf, fileKindOf, isMarkdownPath } from "./lib/fileTypes";
import { normalizeTagName, noteTags, tagAddEdit, tagRemoveEdit, tagRenameEdits } from "./lib/tags";
import { buildCaptureLines, detectEol } from "./lib/capture";
import { attachmentNameFor, linkTextFor } from "./lib/attachments";
import { saveAndLink, toBase64 } from "./lib/paste";
import { readBinaryFile } from "./lib/api";
import type { CaptureImage } from "./components/QuickCaptureDialog";
import { lineEndingLabel } from "./lib/lineEndings";
import { clearEmbedCache, renderMarkdownToHtml, splitEmbedTarget } from "./lib/embed";
import { applyMermaidTheme, clearMermaidCache, requestDecorationRefresh, setMermaidNotice, toggleableBlockAt } from "./lib/livePreview";
import { blockInsertPadding, type CodePasteOptions } from "./lib/paste";
import { EMPTY_CONTEXT, absoluteInVault, resolveWikiRelative, type LivePreviewContext } from "./lib/paths";
import { menuRefClampedToViewport } from "./lib/menuClamp";
import { bgSettingsFor, getSettings, onSettingsChange, updateBgSettings, updateSettings, takeLegacyAttachmentFolder, type Settings } from "./lib/settings";
import { allBindings, COMMAND_KEYS, formatKey, matchCommand, onHotkeysChange } from "./lib/hotkeys";
import { closeSearchPanelIfOpen, openSearchPanelOn, searchPanelFindNext } from "./lib/searchPanel";
import { VOCAB_FILENAME, addVocabEntry, updateVocabEntry } from "./lib/vocabulary";
import { vocabLookup } from "./lib/api";
import { loadVocabularyContent, saveVocabularyContent } from "./lib/vocabStore";
import { onVocabRemoteChange, setVocabSyncEnabled, syncVocabNow } from "./lib/vocabSync";
import { checkForUpdate, checkViaPlugin, installAndRelaunch, type Update } from "./lib/updater";
import { applyCustomCss, getCustomCss, saveCustomCss } from "./lib/customCss";
import { getVersion } from "@tauri-apps/api/app";
import { applyTheme, resolveTheme, watchSystemTheme } from "./lib/theme";
import { applyBackground } from "./lib/background";
import { clampRotateMinutes, nextRandom, nextSequential } from "./lib/bgRotate";
import { deleteProgress, loadProgress, saveProgress } from "./lib/readProgress";
import { ddlNoteIntro, extractTableNames, mergeDdlIntoNote, parseDdlTables } from "./lib/ddl";
import { closeDdlTip, installDdlCellHover, setDdlSaver } from "./lib/ddlHover";
import { notifyDdlLibraryUpdated } from "./lib/ddlMark";
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
import { clampHeadings, codeAtCursor, toggleBold, toggleBulletList, toggleCodeBlock, toggleHeading, toggleInlineCode, toggleNumberList, toggleTaskList } from "./lib/codeEdit";
import { formatJsonText } from "./lib/formatJson";
import { useDaily } from "./lib/useDaily";
import { useSync, type SyncController } from "./lib/useSync";
import "./styles.css";

const VAULT_KEY = "quicknote.vault";

/**
 * 无笔记空态的编辑器状态：editable=false。0.34.6 用户反馈「没打开任何文件时，
 * 内容区域可以编辑」（桌面/移动都能聚焦出光标+软键盘，0.33.0 只把启动首帧
 * 的裸 create 禁了编辑）——关空标签/批量关全部/切仓库/删笔记后的空态走的是
 * 空 extensions 的 EditorState.create，CM 默认可编辑。四处统一走这里。
 */
const emptyEditorState = () =>
  EditorState.create({ extensions: [EditorView.editable.of(false)] });
const FAVORITES_V2_KEY = "quicknote.favorites.v2";
/** 收藏置顶的存储键（按仓库分桶，同收藏；0.21 用户反馈：收藏栏要能置顶）。 */
const FAVORITES_PIN_KEY = "quicknote.favorites.pin.v2";
/** 标签列表置顶的存储键（按仓库分桶；0.27 用户反馈：标签也要置顶+重命名）。 */
const TAGS_PIN_KEY = "quicknote.tags.pin.v1";
/** 固定标签页的存储键（按仓库分桶，同收藏）。 */
const PINNED_TABS_KEY = "quicknote.ui.pinnedTabs";
/** 目录筛选的存储键：仓库 → 被隐藏的一级目录列表（0.20 用户反馈：目录太多干扰阅读）。 */
const HIDDEN_DIRS_KEY = "quicknote.tree.hiddenDirs";

const MODE_KEY = "quicknote.mode";
const SIDEBAR_KEY = "quicknote.sidebar";
/** 停止输入多久后自动保存。写盘前会比较内容，未变则不触碰文件。 */
const AUTOSAVE_DELAY = 1200;

/** 嵌套编辑宿主（表格单元格等）的选择器：值与 livePreview 写入的一致。 */
const NESTED_EDITABLE = '[contenteditable="true"], [contenteditable="plaintext-only"]';

/** DOM 选区/焦点是否落在嵌套编辑宿主（渲染表格的单元格）里。 */
function selectionInNestedHost(): boolean {
  const sel = window.getSelection();
  const host = sel?.anchorNode?.parentElement?.closest<HTMLElement>(NESTED_EDITABLE) ?? null;
  return !!host && !host.classList.contains("cm-content");
}

/**
 * 收词/搜索预填的取词（0.26）：焦点在嵌套宿主（表格单元格）里时，CM 选区是
 * 进表格前的旧值绝不能用——按 DOM 选区取（非折叠取选中文本、折叠取光标所在词）；
 * 普通正文按 CM 选区 → DOM 选区 → CM 光标所在词的顺序兜底。
 */
function captureWordTerm(view: EditorView): string {
  if (selectionInNestedHost()) {
    return domSelectionText() || domWordAtCaretInNestedHost();
  }
  const selection = view.state.selection.main;
  let word = selection.empty ? "" : view.state.sliceDoc(selection.from, selection.to).trim();
  if (!word) word = domSelectionText();
  if (!word) {
    const found = view.state.wordAt(selection.head);
    word = found ? view.state.sliceDoc(found.from, found.to).trim() : "";
  }
  return word;
}

/** 取当前 DOM 选区的文本：多行只取第一行、截断（与搜索预填同一口径）；空选区返回空串。 */
function domSelectionText(max = 200): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
  const text = sel.toString();
  const newline = text.search(/\r\n|\r|\n/);
  return (newline >= 0 ? text.slice(0, newline) : text).trim().slice(0, max);
}

/**
 * DOM 光标所在词（收词兜底用）：选区折叠且锚点落在**嵌套编辑宿主**（表格
 * 单元格）的文本节点里时，从宿主文本里挖出光标处的词。普通正文编辑时 CM 的
 * wordAt 已经覆盖，这里的锚点限定就是为了不跟它抢。
 */
function domWordAtCaretInNestedHost(): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return "";
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return "";
  const host = node.parentElement?.closest<HTMLElement>(NESTED_EDITABLE);
  if (!host || host.classList.contains("cm-content")) return "";
  const text = node.nodeValue ?? "";
  const offset = Math.min(sel.anchorOffset, text.length);
  const isWord = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);
  let from = offset;
  let to = offset;
  while (from > 0 && isWord(text[from - 1])) from -= 1;
  while (to < text.length && isWord(text[to])) to += 1;
  return text.slice(from, to).trim();
}

/**
 * 更新弹窗的新版本介绍（0.23 用户反馈：别显示 Markdown 源码）。用应用同款
 * markdown-it 管线渲染（html:false 转义原始 HTML，链接不可导航——安全口径与
 * 嵌入/PDF 导出一致）。EMPTY_CONTEXT：更新说明与仓库无关，资源链接退化为占位。
 */
function UpdateNotes({ markdown }: { markdown: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let alive = true;
    void renderMarkdownToHtml(markdown, EMPTY_CONTEXT)
      .then((rendered) => {
        if (alive) setHtml(rendered);
      })
      .catch(() => {
        if (alive) setHtml("");
      });
    return () => {
      alive = false;
    };
  }, [markdown]);
  if (!html) return null;
  return (
    <div
      className="update-dialog-notes update-dialog-notes-md"
      // markdown-it html:false 已转义原始 HTML，这里的内容是渲染产物
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function App() {
  const [vault, setVault] = useState<string | null>(null);
  // 最新仓库路径的 ref：事件回调（如回前台重扫）闭包捕获不到最新 state 时读它
  const vaultRef = useRef<string | null>(null);
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
  /**
   * 移动端阅读/编辑分离（0.33.0 批C）：打开笔记默认阅读态（EditorView.editable
   * 重配为 false，任务勾选/链接/复制照常）；点顶栏「编辑」进编辑态（解禁 +
   * 聚焦弹键盘 + 工具栏）；编辑区点一下进沉浸阅读（上下栏滑出，body.m-zen），
   * 顶部热区点回。打开/切换笔记一律回阅读态、栏可见。桌面不参与。
   */
  const [mobileEdit, setMobileEdit] = useState(false);
  const [mobileZen, setMobileZen] = useState(false);
  const mobileEditRef = useRef(false);
  useEffect(() => {
    mobileEditRef.current = mobileEdit;
  }, [mobileEdit]);
  /**
   * 移动端生效视图模式（0.33.1 用户反馈「显示的是源码，切换编辑模式也没用」）：
   * mode 持久化在 localStorage，工具栏 </> 切过 source 后**阅读态也显示源码**，
   * 而「编辑」toggle 只切 editable 不切 mode——怎么切都是源码。阅读态恒 live
   * 渲染（勾选/链接/复制照常），编辑态尊重工具栏选择的 live/source。桌面不
   * 参与，原样返回。
   */
  const effectiveViewMode = useCallback(
    (m: ViewMode): ViewMode => (isMobile() && !mobileEditRef.current ? "live" : m),
    [],
  );
  // ---------------------------------------------------------------- 0.34.0 移动端 Obsidian 化壳层
  // 顶栏/底部导航退场，改浮动药丸 + 底部工具条 + 三个底部 sheet（动作菜单/
  // 标签页切换/仓库切换）。全部移动端专用状态，桌面不读不写。
  /** ☰ 动作菜单 sheet（底部滑入）。 */
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  /** 0.34.1：右上 ⋮ = 当前笔记菜单（Obsidian 语义——都是笔记属性类操作），
      与底条 ☰ 的应用级动作菜单分开。 */
  const [noteMenuOpen, setNoteMenuOpen] = useState(false);
  /** [N] 标签页切换 sheet。 */
  const [tabSheetOpen, setTabSheetOpen] = useState(false);
  /** 仓库切换 radio sheet（抽屉底部仓库名点开）。 */
  const [vaultSheetOpen, setVaultSheetOpen] = useState(false);
  /** 0.34.1 用户反馈：抽屉分区卡默认收起成胶囊，点击展开、切换后收起。 */
  const [drawerSectionsOpen, setDrawerSectionsOpen] = useState(false);
  /** radio sheet 的仓库清单：打开时拉一次（与仓库主页同源 listVaults）。 */
  const [vaultSheetList, setVaultSheetList] = useState<VaultInfo[]>([]);
  /** 左抽屉分区：文件列表 / 搜索 / 标签 / 单词本 / 日历（Obsidian 分区卡模型）。 */
  const [drawerView, setDrawerView] = useState<"files" | "search" | "tags" | "vocab" | "calendar">("files");
  /** 「定位当前文件」请求（0.34.6，IDEA 式 Select Opened File）：FileTree 沿途
      展开目录并把当前笔记行滚到视口中央闪烁。seq 让同一文件能连续定位两次。 */
  const [treeReveal, setTreeReveal] = useState<{ path: string; seq: number } | null>(null);
  /** 发起定位：请求 2.5s 后自动清掉——闪烁只该亮这一次；请求一直挂着的话，
      之后切视图/进分区导致的树重挂会把上一次的目标再闪一遍（0.34.6 用户
      反馈「高亮的是上次点按钮时的文件，不是当前打开的文件」）。 */
  const revealCurrentNote = useCallback(() => {
    const path = currentRef.current?.path;
    if (!path) return;
    setTreeReveal({ path, seq: Date.now() });
    window.setTimeout(() => setTreeReveal(null), 2500);
  }, []);
  /**
   * 笔记导航历史（底栏 ‹ ›）：浏览器式栈 + 指针。activeTab 一变就压栈（去重、
   * 截断前进分支），程序性装载不特判——切仓库时整个重置，启动首篇自然成为
   * 第 0 项。只记主编辑器：分屏激活不动 activeTab，移动端也几乎不用分屏。
   */
  const [navHistory, setNavHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const navHistoryRef = useRef(navHistory);
  useEffect(() => {
    navHistoryRef.current = navHistory;
  }, [navHistory]);
  // 压栈只认 activeTab：无论 openNote 走存量激活还是 readNote 装载、还是标签
  // sheet 手动切换，主编辑器路径一变就记一笔；历史跳转时 index 已先指到目标，
  // 这里比对栈顶相等自然不重复入栈
  useEffect(() => {
    if (!activeTab) return;
    setNavHistory((prev) => {
      if (prev.stack[prev.index] === activeTab) return prev;
      const stack = prev.stack.slice(0, prev.index + 1);
      stack.push(activeTab);
      if (stack.length > 100) stack.shift();
      return { stack, index: stack.length - 1 };
    });
  }, [activeTab]);
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
  const [rightPanel, setRightPanel] = useState<"daily" | "outline" | "stats" | "vocab">(() => {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    return stored === "outline" || stored === "stats" || stored === "vocab" ? stored : "daily";
  });
  /**
   * 单词本代际（0.24 用户反馈：快捷键收词后右侧面板不刷新）：面板只靠 revision
   * （编辑器文档变更）重读，而收词不经过编辑器。收词落盘、单词本被外部改动
   * （同步/另一窗口）时 bump，面板据此重读。
   */
  const [vocabVersion, setVocabVersion] = useState(0);
  /** 左侧文件树的名称过滤（空串 = 显示完整目录树）。 */
  const [treeFilter, setTreeFilter] = useState("");
  /**
   * 目录筛选：被隐藏的一级目录（按仓库分桶，localStorage）。
   * 只影响文件树展示，收藏/最近/搜索不受影响。
   */
  const [hiddenDirsMap, setHiddenDirsMap] = useState<Record<string, string[]>>(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_DIRS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    } catch {
      return {};
    }
  });
  const [dirFilterOpen, setDirFilterOpen] = useState(false);
  const hiddenDirs = useMemo(
    () => new Set(hiddenDirsMap[vault ?? ""] ?? []),
    [hiddenDirsMap, vault],
  );
  const toggleHiddenDir = useCallback(
    (dir: string, hidden: boolean) => {
      if (!vault) return;
      setHiddenDirsMap((prev) => {
        const current = new Set(prev[vault] ?? []);
        if (hidden) current.add(dir);
        else current.delete(dir);
        const next = { ...prev, [vault]: [...current] };
        try {
          localStorage.setItem(HIDDEN_DIRS_KEY, JSON.stringify(next));
        } catch {
          // 存不进去只影响下次启动
        }
        return next;
      });
    },
    [vault],
  );
  /** 全局命令面板（Ctrl+K）开关。 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 左栏视图：知识库 / 收藏 / 最近 / 标签。 */
  const [leftView, setLeftView] = useState<"files" | "favorites" | "recents" | "tags">("files");
  /** 收藏的笔记（本机 localStorage，**按仓库分桶**：切换仓库各看各的收藏）。 */
  const [favorites, setFavorites] = useState<string[]>([]);
  /** 置顶的收藏（按仓库分桶，同收藏；收藏视图里排在最前）。 */
  const [pinnedFavorites, setPinnedFavorites] = useState<string[]>([]);
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
  const selectedPathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);
  /** 专注模式：隐藏两侧栏与状态栏（Ctrl+Shift+F）。 */
  const [zen, setZen] = useState(false);
  /** 光标是否在表格块内（表格工具栏的显示依据）。 */
  const [inTable, setInTable] = useState(false);
  /** 光标所在行（0 基；目录面板高亮当前标题）。 */
  const [cursorLine, setCursorLine] = useState(0);
  /** 左右栏收起状态（Obsidian 式；持久化）。 */
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    // 移动端抽屉形态：冷启动**总是**从收起开始（会话内打开，不跨会话记忆展开态）
    if (isMobile()) return true;
    const saved = localStorage.getItem("quicknote.ui.leftCollapsed");
    return saved === null ? false : saved === "1";
  });
  const [rightCollapsed, setRightCollapsed] = useState(() => {
    if (isMobile()) return true;
    const saved = localStorage.getItem("quicknote.ui.rightCollapsed");
    return saved === null ? false : saved === "1";
  });
  /** 自定义样式内容（设置面板 textarea 的值）。 */
  const [customCssDraft, setCustomCssDraft] = useState(() => getCustomCss());
  /** 周回顾的选周弹窗（M4）。 */
  const [weekDialogOpen, setWeekDialogOpen] = useState(false);
  /** 选区标题归一的级别选择弹窗（编辑器键位 / 命令面板触发）。 */
  const [headingDialogOpen, setHeadingDialogOpen] = useState(false);
  /** 全局截图（OS 级快捷键或命令面板触发）：弹窗展示的 PNG base64。 */
  const [screenshotImage, setScreenshotImage] = useState<string | null>(null);
  const [screenshotOpen, setScreenshotOpen] = useState(false);
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

  // 跨窗口热加载（0.23）：另一窗口改设置 → settings.ts 经 storage 事件重载并
  // 广播，这里把广播接进 React 状态——主题、热键（重注册）、背景图等所有
  // `settings.*` 依赖项随之在别的窗口即时生效，不用重启。
  useEffect(() => onSettingsChange((next) => setSettings({ ...next })), []);

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

  // 收藏置顶：按仓库分桶读（0.21 用户反馈：收藏栏给文件添加置顶选项）
  useEffect(() => {
    if (!vault) return;
    try {
      const raw = localStorage.getItem(FAVORITES_PIN_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      setPinnedFavorites(Array.isArray(map[vault]) ? map[vault] : []);
    } catch {
      setPinnedFavorites([]);
    }
  }, [vault]);

  // 置顶列表变化写回分桶存储；顺手剔除已不在收藏里的路径（取消收藏连着取消置顶）
  useEffect(() => {
    if (!vault) return;
    const next = pinnedFavorites.filter((p) => favorites.includes(p));
    if (next.length !== pinnedFavorites.length) {
      setPinnedFavorites(next);
      return;
    }
    try {
      const raw = localStorage.getItem(FAVORITES_PIN_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      map[vault] = next;
      localStorage.setItem(FAVORITES_PIN_KEY, JSON.stringify(map));
    } catch {
      // 存不进去只影响下次启动的置顶状态
    }
  }, [pinnedFavorites, favorites, vault]);

  /** 置顶/取消置顶一条收藏：置顶的在收藏视图排在最前。 */
  const togglePinFavorite = useCallback((path: string) => {
    setPinnedFavorites((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  }, []);

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
    /** 最新 release 的 .apk 直链（移动端应用内安装用，GitHub 回退路径才解析）。 */
    apkUrl?: string;
    /** 下载进度 0-100（0.34.2 用户反馈：更新要显示百分比进度）。 */
    progress?: number;
  }>({ state: "idle", message: "" });
  /** updater 插件的 Update 对象：下载安装必须用它。 */
  const updateRef = useRef<Update | null>(null);
  /** 更新下载进行中的重入闸：弹窗/设置页双击、移动端重试都不会叠出第二路下载。 */
  const updatingRef = useRef(false);
  /** 弹窗是否处于关闭状态（下载中关窗 = 后台下载，进度改走系统通知）。 */
  const updateDismissedRef = useRef(false);
  useEffect(() => {
    updateDismissedRef.current = updateCheck.dismissed === true;
  }, [updateCheck.dismissed]);

  /** 后台下载时的系统通知（0.34.2：窗口关了也能从通知里看到进度/结果）。 */
  const notifyUpdateBackground = useCallback(async (body: string) => {
    try {
      const notification = await import("@tauri-apps/plugin-notification");
      let granted = await notification.isPermissionGranted();
      if (!granted) granted = (await notification.requestPermission()) === "granted";
      if (granted) notification.sendNotification({ title: "Quick Note 更新", body });
    } catch {
      // 通知失败无所谓：进度还在横幅/设置页里
    }
  }, []);

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
    // 移动端（0.27 反馈：手机版要在应用内直接更新）不走 updater 插件路径：
    // 插件路径拿不到 APK 直链，按钮会退化成「打开发布页」。GitHub API 路径
    // 顺带解析 release 里的 .apk 资产（apkUrl），交给 qnAndroid 桥下载安装。
    if (!isMobile()) {
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
    }
    try {
      const info = await checkForUpdate(appVersion || "0.0.0");
      setUpdateCheck(
        info.newer
          ? {
              state: "done",
              message: `发现新版本 v${info.latest}（当前 v${appVersion}），可在应用内更新`,
              // available 不能漏（0.33.0 用户反馈：手机上检查到新版本却没有更新
              // 按钮——GitHub 路径漏设它，设置页按钮与更新提示条都按它渲染）
              available: true,
              url: info.url,
              notes: info.body,
              apkUrl: info.apkUrl,
            }
          : { state: "done", message: `已是最新版本（最新发布 v${info.latest}）` },
      );
    } catch (e) {
      setUpdateCheck({ state: "error", message: `检查更新失败：${e}` });
    }
  }, [appVersion]);

  /** 应用内更新：下载（带进度）→ 静默安装 → 重启。失败后按钮变「重试更新」，原地再下。 */
  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update || updatingRef.current) return;
    updatingRef.current = true;
    // 0.34.8 用户反馈「点击更新后按钮还存在且还可以点」：点下瞬间就切进度态——
    // 原先要等首个进度事件（网络 Started 往返）才切，慢网时按钮停留数秒像没反应
    setUpdateCheck((prev) => ({ ...prev, state: "downloading", message: "正在下载更新… 0%", progress: 0 }));
    // 弹窗关着（或下载中途关掉）= 后台下载：进度按 25% 一档发系统通知
    let background = updateDismissedRef.current;
    let notifiedAt = 0;
    try {
      await installAndRelaunch(update, (pct) => {
        background = background || updateDismissedRef.current;
        setUpdateCheck((prev) => ({
          ...prev,
          state: "downloading",
          message: `正在下载更新… ${pct}%`,
          available: true,
          progress: pct,
        }));
        if (background && pct > notifiedAt && (pct >= 100 || pct - notifiedAt >= 25)) {
          notifiedAt = pct;
          void notifyUpdateBackground(
            pct >= 100 ? "更新下载完成，应用即将重启安装" : `更新下载中 ${pct}%`,
          );
        }
      });
    } catch (e) {
      // 保留 available/notes/url：错误提示归位后「立即更新」（此时显示为
      // 「重试更新」）和更新弹窗仍在，用户可以直接再试，不必去发布页
      if (background) void notifyUpdateBackground(`更新下载失败：${e}`);
      setUpdateCheck((prev) => ({
        ...prev,
        state: "error",
        message: `更新下载失败：${e}`,
        available: true,
        progress: undefined,
      }));
    } finally {
      updatingRef.current = false;
    }
  }, [notifyUpdateBackground]);

  /**
   * 移动端应用内更新：qnAndroid 桥下载 APK → 拉起系统安装器。
   * 未授权「安装未知应用」时先跳授权页，回来再点一次。
   */
  const installUpdateMobile = useCallback(() => {
    const bridge = (window as unknown as Record<string, unknown>).qnAndroid as
      | { canRequestInstall: () => boolean; requestInstallPermission: () => void; installUpdate: (url: string) => void }
      | undefined;
    const url = updateCheck.apkUrl;
    if (!bridge || !url) {
      // 桥不在（非 Android 或旧包）或缺 APK 资产：退回发布页
      void openReleasePage(updateCheck.url);
      return;
    }
    if (!bridge.canRequestInstall()) {
      bridge.requestInstallPermission();
      // 0.34.10 用户反馈「点击更新按钮不会立马消失」：跳授权页只发了一条
      // 底部状态提示，弹窗纹丝不动，用户不知道发生了什么。把引导直接写进
      // 弹窗标题（state=error 保持三按钮，回来再点一次即可）
      setUpdateCheck((prev) => ({
        ...prev,
        state: "error",
        message: "需要「安装未知应用」权限：已打开系统设置，请允许后回来再点「下载并安装」",
        available: true,
      }));
      return;
    }
    if (updatingRef.current) return;
    updatingRef.current = true;
    (window as unknown as Record<string, unknown>).__qnUpdateDone = (ok: boolean, msg: string) => {
      updatingRef.current = false;
      setUpdateCheck((prev) =>
        ok
          ? // 0.34.10 用户反馈「下载好之后直接装，回来按钮还在」：安装器已拉起，
            // 流程结束——顺手关掉弹窗，不再把三个按钮摆回来
            { ...prev, state: "done", message: `更新包已下载：${msg}，按系统提示完成安装`, available: true, progress: undefined, dismissed: true }
          : { ...prev, state: "error", message: `更新失败：${msg}（网络不稳可重试，或到发布页下载 APK）`, available: true, progress: undefined },
      );
    };
    // 0.34.2：Kotlin 侧下载进度回调（百分比）
    (window as unknown as Record<string, unknown>).__qnUpdateProgress = (pct: number) => {
      setUpdateCheck((prev) =>
        prev.state === "downloading"
          ? { ...prev, progress: pct, message: `正在下载更新包… ${pct}%` }
          : prev,
      );
    };
    setUpdateCheck((prev) => ({ ...prev, state: "downloading", message: "正在下载更新包… 0%", progress: 0 }));
    bridge.installUpdate(url);
  }, [updateCheck.apkUrl, updateCheck.url]);

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

  // ---- 单词本的账户级云同步（0.29 用户反馈：daily sync 支持同步单词本）----
  // 引擎自己管理生命周期：账号已配置且当前仓库开着同步才跑；账号配置变化会
  // 传指纹进去重建引擎；远端词库合并进来后 bump vocabVersion 刷新单词面板。
  const vocabCredentialsKey = `${sync.config.serverUrl}|${sync.config.username}|${sync.config.password}`;
  useEffect(() => {
    const configured =
      sync.ready &&
      !sync.stateError &&
      sync.config.serverUrl.trim() !== "" &&
      sync.config.username.trim() !== "" &&
      sync.config.password !== "";
    setVocabSyncEnabled(configured && sync.config.enabled, notice, vocabCredentialsKey);
  }, [sync.ready, sync.stateError, sync.config, vocabCredentialsKey, notice]);

  useEffect(() => onVocabRemoteChange(() => setVocabVersion((value) => value + 1)), []);

  // 文件监听的回调只订阅一次，所以要经 ref 读最新的控制器（它的回调每次都新建）。
  const dailyRef = useRef(daily);
  useEffect(() => {
    dailyRef.current = daily;
  }, [daily]);

  useEffect(() => {
    vaultRef.current = vault;
  }, [vault]);

  // Android 返回键的消费链（MainActivity.onBackPressed 会先问这里）。
  // **视觉在最上层的先关**：快速笔记弹窗（z 950）> 命令面板 > 仓库页 > 设置，
  // 然后才是抽屉——按固定优先级的话，设置开着时按返回会先关设置而用户看到
  // 的是弹窗还开着（用户实测反馈过）。
  const backConsumeRef = useRef<() => boolean>(() => false);
  /** 单词面板注册的返回键消费者（详情弹层 → 添加区 → 搜索态，先于抽屉收起）。 */
  const vocabBackRef = useRef<(() => boolean) | null>(null);
  /** 设置面板的系统返回消费（0.34.6：二级详情页返回=回分类列表）。 */
  const settingsBackRef = useRef<(() => boolean) | null>(null);
  backConsumeRef.current = () => {
    if (quickCaptureOpen) {
      setQuickCaptureOpen(false);
      return true;
    }
    if (addWordDialog !== null) {
      setAddWordDialog(null);
      return true;
    }
    if (paletteOpen) {
      setPaletteOpen(false);
      return true;
    }
    // 0.34.0 底部 sheet 三兄弟（z 86 > 设置 85 > 主页 84）：按视觉层叠先关
    if (mobileMenuOpen) {
      setMobileMenuOpen(false);
      return true;
    }
    if (tabSheetOpen) {
      setTabSheetOpen(false);
      return true;
    }
    if (vaultSheetOpen) {
      setVaultSheetOpen(false);
      return true;
    }
    if (noteMenuOpen) {
      setNoteMenuOpen(false);
      return true;
    }
    // 0.33.1 主页重构：设置盖在主页之上（z 85>84）——back 先关设置再关主页，
    // 顺序与视觉层叠一致（主页开着时按返回：先回仓库界面，再按才关仓库页）。
    // 0.34.6：设置内部二级详情页先返回分类列表（面板自消费）
    if (showSettings) {
      if (settingsBackRef.current?.()) return true;
      setShowSettings(false);
      return true;
    }
    if (vaultGateOpen) {
      setVaultGateOpen(false);
      return true;
    }
    // 单词面板的内层状态（详情/添加/搜索）视觉上盖在抽屉内容之上，先于抽屉关闭。
    // 0.34.0 起单词本也挂左抽屉分区——任一抽屉开着且挂着单词面板就先消费
    if ((!leftCollapsed || !rightCollapsed) && vocabBackRef.current?.()) {
      return true;
    }
    if (!leftCollapsed) {
      setLeftCollapsed(true);
      return true;
    }
    if (!rightCollapsed) {
      setRightCollapsed(true);
      return true;
    }
    // 都没开着：有未保存改动时先落盘（消费这次 back；再按一次才真正退出——
    // 落盘是异步的，evaluateJavascript 的同步判定等不了它）
    if (dirtyRef.current) {
      saveRef.current?.();
      return true;
    }
    return false;
  };
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__qnConsumeBack = () => backConsumeRef.current();
  }, []);

  // 键盘避让：visualViewport 缩水超过 150px 视为键盘弹出，body.kbd-open
  // 让 CSS 隐藏底栏（工具栏贴键盘），收起时恢复。
  useEffect(() => {
    if (!isMobile()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      document.body.classList.toggle("kbd-open", window.innerHeight - vv.height > 150);
    };
    vv.addEventListener("resize", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      document.body.classList.remove("kbd-open");
    };
  }, []);

  // 系统栏全幅（0.34.8 用户反馈「顶部和底部的系统栏没有渲染背景图片，很突兀」）：
  // Kotlin 侧 WebView 纵向不再 margin 让出系统栏，背景图层跟着铺到栏后；内容
  // （药丸/底条/抽屉/横幅等）的避让走 --qn-inset-top/bottom CSS 变量——启动经
  // qnAndroid 桥同步拉一次（useLayoutEffect 保证首帧就位，不闪跳），之后原生在
  // insets 变化（旋转/键盘）时经 window.__qnApplyInsets 推。桌面无桥，零影响。
  useLayoutEffect(() => {
    if (!isMobile()) return;
    const apply = (top: number, bottom: number) => {
      const root = document.documentElement;
      root.style.setProperty("--qn-inset-top", `${top}px`);
      root.style.setProperty("--qn-inset-bottom", `${bottom}px`);
    };
    (window as unknown as Record<string, unknown>).__qnApplyInsets = (ins: { top: number; bottom: number }) => {
      if (typeof ins?.top === "number" && typeof ins?.bottom === "number") apply(ins.top, ins.bottom);
    };
    try {
      const raw = (window as unknown as { qnAndroid?: { insets?: () => string } }).qnAndroid?.insets?.();
      if (raw) {
        const parsed = JSON.parse(raw) as { top?: number; bottom?: number };
        apply(parsed.top ?? 0, parsed.bottom ?? 0);
      }
    } catch {
      // 桥未就绪（老包/非安卓路径）：等原生推
    }
  }, []);

  // 启动动画收尾（0.34.8「在手机上添加启动动画」）：index.html 里的静态 splash
  // 在 bundle 加载前就显示（主题经内联脚本先行落盘，无闪白）；应用挂载、首帧
  // 绘制后再淡出并移除。最少停留 700ms——快启动时入场动画不至于一闪而过。
  // 桌面上 splash 本就 display:none，这里顺手清节点即可。
  useLayoutEffect(() => {
    const splash = document.getElementById("qn-splash");
    if (!splash) return;
    const startedAt = (window as unknown as { __qnSplashAt?: number }).__qnSplashAt ?? Date.now();
    const timer = window.setTimeout(
      () => {
        requestAnimationFrame(() => {
          splash.classList.add("is-done");
          window.setTimeout(() => splash.remove(), 420);
        });
      },
      Math.max(0, 700 - (Date.now() - startedAt)),
    );
    return () => window.clearTimeout(timer);
  }, []);

  // 0.34.1 内容区滑动手势（用户拍板：边缘留给系统返回，不做边缘带）：双抽屉
  // 都关时，内容区**右滑开左抽屉、左滑开右抽屉**；有抽屉开着时保留 0.34.0 的
  // 关闭语义——左抽屉左滑关、右抽屉右滑关。纯观察监听（passive、不
  // preventDefault，完全不挡编辑器触摸）：横向位移占优且 >60px 才触发，
  // 开抽屉另有时间门与三道防误触守卫（见 onStart）；sheet/设置/主页等浮层
  // 盖着时不响应。抽屉开关经 ref 读最新值，监听器只装一次。
  const leftCollapsedRef = useRef(leftCollapsed);
  const rightCollapsedRef = useRef(rightCollapsed);
  useEffect(() => {
    leftCollapsedRef.current = leftCollapsed;
  }, [leftCollapsed]);
  useEffect(() => {
    rightCollapsedRef.current = rightCollapsed;
  }, [rightCollapsed]);
  useEffect(() => {
    if (!isMobile()) return;
    // 从触点向上找「实际横向溢出且 overflow-x 为 auto/scroll」的祖先：宽表
    // （.cm-tb-scroll）、放大后的 mermaid 块（.cm-lp-mermaid）等都算。走到 body
    // 为止；cm-scroller 的 overflow-x 是 hidden（硬禁页面横滚），不会误伤正文
    // 横滑开抽屉的主路径
    const inHorizontalScroller = (start: Element): boolean => {
      for (let el: Element | null = start; el && el !== document.body; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth + 1) {
          const overflowX = getComputedStyle(el).overflowX;
          if (overflowX === "auto" || overflowX === "scroll") return true;
        }
      }
      return false;
    };
    let sx = 0;
    let sy = 0;
    let st = 0;
    let intent: "open-content" | "close-left" | "close-right" | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      intent = null;
      st = e.timeStamp;
      // 浮层（sheet/设置/面板/主页/速记/右键菜单）盖在抽屉上时，滑动属于浮层。
      // target 必须 instanceof Element：合成事件派发在 document 上时 target 是
      // Document，没有 closest 方法（批测的 TouchEvent 直接派发到 document）
      const target = e.target;
      if (target instanceof Element && target.closest(".m-sheet, .settings-panel, .palette-overlay, .vault-home-page, .quick-capture, .update-dialog, .context-menu, .menu-backdrop, .qn-lightbox, .qn-mermaid-overlay")) {
        sx = t.clientX;
        sy = t.clientY;
        return;
      }
      if (leftCollapsedRef.current && rightCollapsedRef.current) {
        // 双抽屉都关：内容区横滑开抽屉（0.34.1 用户拍板：不是边缘带——边缘
        // 留给系统返回手势）。右滑 = 开左抽屉、左滑 = 开右抽屉，方向在 onEnd
        // 按位移正负定。三道守卫防误触（正文是编辑器，横滑可能是在操作文本）：
        // ① 编辑态 / 键盘弹出时不响应——防和光标、选词操作打架；
        // ② 起手点在交互元素（按钮/输入框/药丸/底条/工具栏）上不响应；
        // ③ 编辑器已有文本选区时不响应——拖选择柄调选区是横向的长拖。
        // ④ 0.34.8 用户反馈「mermaid 灯箱里左右滑动触发抽屉」：起手点在横向
        //    可滚区域内（宽表 .cm-tb-scroll、放大后的 mermaid 块等）时，这次
        //    横滑属于内容平移，不开抽屉。
        // 另外 onEnd 有时间门（<400ms）——长按选词本身就占 ~500ms，慢拖不算滑。
        const editing =
          document.body.classList.contains("m-editing") ||
          document.documentElement.classList.contains("qn-ime-open");
        const selecting = typeof window.getSelection === "function" && (window.getSelection()?.toString().length ?? 0) > 0;
        const onInteractive = target instanceof Element && target.closest("button, input, textarea, select, a, label, .m-top-pills, .m-bottom-bar, .mobile-md-toolbar");
        const inHScroll = target instanceof Element && inHorizontalScroller(target);
        if (!editing && !selecting && !onInteractive && !inHScroll) intent = "open-content";
      } else if (!leftCollapsedRef.current) {
        intent = "close-left"; // 左抽屉开着：任意位置左滑关
      } else {
        intent = "close-right"; // 只有右抽屉开着：任意位置右滑关
      }
      sx = t.clientX;
      sy = t.clientY;
    };
    const onEnd = (e: TouchEvent) => {
      if (!intent) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      const dt = e.timeStamp - st;
      const horizontal = Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 60;
      if (intent === "open-content" && horizontal && dt < 400) {
        if (dx > 0) setLeftCollapsed(false);
        else setRightCollapsed(false);
      }
      if (intent === "close-left" && dx < 0 && horizontal) setLeftCollapsed(true);
      if (intent === "close-right" && dx > 0 && horizontal) setRightCollapsed(true);
      intent = null;
    };
    const onCancel = () => {
      intent = null;
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    // 0.34.1：系统手势接管时 WebView 收到 touchcancel（touchend 不来）——
    // 清掉意图，避免残留到下一次触摸误触发
    document.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, []);

  // Android 系统分享接收（MainActivity 轮询派发）：文本预填 + 可选图片
  // （Kotlin 落缓存目录，经 read_binary_file 读同沙箱路径转附件）。
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__qnShareReceive = (text: string, imagePath?: string, imageMime?: string) => {
      setShareDraft(text);
      if (imagePath) {
        const ext = imagePath.split(".").pop()?.toLowerCase() ?? "png";
        void readBinaryFile(imagePath)
          .then((base64: string) => {
            setShareImages([{ name: `shared-image-${Date.now()}.${ext}`, type: imageMime || "image/png", base64 }]);
          })
          .catch((e: unknown) => setError(`读取分享图片失败：${e}`));
      } else {
        setShareImages([]);
      }
      setQuickCaptureOpen(true);
    };
  }, []);

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
      // 分屏视图同步明暗（0.32 双编辑器）
      const splitView = splitViewRef.current;
      if (splitView) applyDarkTheme(splitView, resolved === "dark");
      // mermaid 的主题配色与导出/放大都要跟明暗一致（缓存的旧 svg 一并作废）
      applyMermaidTheme();
      // 系统栏配色（0.33.1 用户反馈「顶部/底部颜色要和系统面板匹配」）：
      // edge-to-edge 下系统栏条纹透出原生 windowBackground，与应用表面不一致
      // 就是黑条——把 --panel 表面色和图标深浅同步给原生（桥见 MainActivity
      // setChromeBackground）。桌面无此桥，静默跳过
      if (isMobile()) {
        const panel = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
        if (panel) {
          (window as unknown as {
            qnAndroid?: { setChromeBackground?: (color: string, dark: boolean) => void };
          }).qnAndroid?.setChromeBackground?.(panel, resolved === "dark");
        }
      }
    };
    sync();
    const unwatch = watchSystemTheme(sync);
    return () => unwatch();
  }, [settings.theme]);

  // 全局背景（M4）：设置或仓库变化时重铺；图片走 asset 协议，路径是仓库内的相对路径。
  // 参数按仓库取（bgSettingsFor）：每个仓库一份自己的背景（0.26 用户反馈）。
  useEffect(() => {
    applyBackground(bgSettingsFor(vault, settings), vault);
  }, [settings, vault]);

  // 壁纸轮换（0.32 用户需求）：目录授权 → 定时换图。写入走 updateBgSettings
  // （bgImageAbsPath 进 per-vault 条目），上面的背景重铺 effect 跟着 settings
  // 变化自动换图——这里只负责「到点选下一张」。每次轮换写盘都会让本 effect
  // 重跑一遍（清旧定时器、重新列目录），目录里的增删下一轮就能被看到。
  useEffect(() => {
    const bg = bgSettingsFor(vault, settings);
    if (!vault || !bg.bgRotateEnabled || !bg.bgRotateDir.trim()) return;
    const dir = bg.bgRotateDir.trim();
    let alive = true;
    let stopTimer: (() => void) | null = null;
    const pickNext = () => {
      listDirImages(dir)
        .then((fresh) => {
          if (!alive || fresh.length === 0) return;
          const next =
            bg.bgRotateMode === "sequential"
              ? nextSequential(fresh, bg.bgImageAbsPath)
              : nextRandom(fresh, bg.bgImageAbsPath);
          if (next && next !== bg.bgImageAbsPath) {
            updateBgSettings(vault, { bgImageAbsPath: next });
          }
        })
        .catch(() => {
          // 目录被移走/拔盘：保持当前图，下个周期再试
        });
    };
    // 目录在仓库外也行：先加进 asset 白名单（运行时授权，不持久化）
    void allowAssetAnyDir(dir)
      .then(() => (alive ? listDirImages(dir) : Promise.resolve([] as string[])))
      .then((images) => {
        if (!alive || images.length === 0) return;
        // 首次开启（还没有当前图）立即选一张，不等第一个周期
        if (!bg.bgImageAbsPath) pickNext();
        const timer = window.setInterval(pickNext, clampRotateMinutes(bg.bgRotateMinutes) * 60_000);
        stopTimer = () => window.clearInterval(timer);
      })
      .catch(() => {
        // 授权/列目录失败：轮换静默不启动（设置页保存时已提示过目录问题）
      });
    return () => {
      alive = false;
      stopTimer?.();
    };
  }, [settings, vault]);

  // 行号显示开关：gutter 的显隐走 html 类（CSS 见 styles.css 的 qn-line-numbers）。
  useEffect(() => {
    document.documentElement.classList.toggle("qn-line-numbers", settings.showLineNumbers);
  }, [settings.showLineNumbers]);

  // 搜索命中高亮颜色（0.26 用户反馈）：文件内搜索、渲染表格内的命中、全局搜索
  // 跳转高亮统一从 --qn-hit 取色（styles.css），这里把设置值写到根节点。
  // 非法值（手改 localStorage）退回默认红，绝不能让高亮消失。
  useEffect(() => {
    const color = /^#[0-9a-fA-F]{6}$/.test(settings.searchHitColor.trim())
      ? settings.searchHitColor.trim()
      : "#ff5252";
    document.documentElement.style.setProperty("--qn-hit", color);
  }, [settings.searchHitColor]);

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
  /**
   * 每个标签最近一次被激活的时间戳（0.31）。closeTab 关脏标签要先 await 落盘，
   * 挂起期间用户可能又把同一篇点开（openNote 命中存量状态直接 activateTab）——
   * 恢复后若无脑继续关，会把「正在显示的笔记」从标签栏除名，留下编辑区有内容、
   * 状态栏「未打开文件」的错位（0.30 用户反馈的偶发复用旧标签）。关闭流程用
   * 开始时间对比激活时间戳即可区分「正常关闭激活标签」与「关闭中途被重开」。
   */
  const tabActivatedAt = useRef(new Map<string, number>());
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

  /**
   * 文档变更回调（0.32 起按 view 路由）：主编辑器与分屏编辑器共用 stateStore，
   * 存量 EditorState 会在两边流转——写回必须跟着**发生变更的视图**走，否则在
   * 分屏里打字会把内容写进主编辑器当前路径的键下（静默串内容）。
   */
  const handleDocChanged = useCallback((changed: EditorView) => {
    if (changed === splitViewRef.current) {
      // 右栏：每次文档变更都把实时 EditorState 回写 stateStore + 标脏
      const splitPathNow = splitActiveRef.current;
      if (splitPathNow) {
        stateStore.current.set(splitPathNow, changed.state);
        dirtyTabs.current.add(splitPathNow);
      }
      setSplitDirty(true);
      setRevision((value) => value + 1);
      return;
    }
    const view = viewRef.current;
    if (changed !== view) return;
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

  /** Mod-S 的统一入口：哪个视图按的保存哪边（0.32 分屏）。 */
  const handleEditorSave = useCallback((changed: EditorView) => {
    if (changed === splitViewRef.current) void splitSaveRef.current();
    else void saveRef.current();
  }, []);

  /** 光标进/出表格（工具栏）：只有主编辑器有工具栏，分屏忽略。 */
  const handleCursorInTable = useCallback((inside: boolean, changed: EditorView) => {
    if (changed !== splitViewRef.current) setInTable(inside);
  }, []);

  /** 光标行（目录高亮）：按视图路由到主/分屏的光标行状态。 */
  const handleCursorLine = useCallback((line: number, changed: EditorView) => {
    if (changed === splitViewRef.current) setSplitCursorLine(line);
    else setCursorLine(line);
  }, []);

  // 编辑器实例只建一次；切换文件用 setState 整体换状态——lineSeparator 是 facet，
  // 必须随状态一起重建才能对新文件生效。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 0.33.0 停点3：空状态直接禁编辑——这个裸 create 不带 editableCompartment，
    // applyEditable 的重配对它无效（装真笔记前它一直可编辑），空仓库时点击
    // 正文会聚焦出光标+软键盘（真机实测图2）。装载真笔记换上的状态自带
    // Compartment，重配恢复正常。桌面同样禁（空状态本就不接受输入）。
    const handle = createEditor(host, EditorState.create({ extensions: [EditorView.editable.of(false)] }));
    viewRef.current = handle.view;
    // 阅读位置实时落库（0.31）：滚动停 800ms 记一次，读到一半关软件也有值。
    // 切标签的捕获走 activateTab/openNote，这里兜住「一直读、没切过标签」。
    let progressTimer: number | null = null;
    const onScroll = () => {
      if (progressTimer !== null) window.clearTimeout(progressTimer);
      progressTimer = window.setTimeout(() => {
        progressTimer = null;
        const dir = vaultRef.current;
        const path = viewOwnerRef.current;
        if (!dir || !path) return;
        const top = handle.view.scrollDOM.scrollTop;
        scrollStore.current.set(path, top);
        saveProgress(window.localStorage, dir, path, top);
      }, 800);
    };
    handle.view.scrollDOM.addEventListener("scroll", onScroll);
    return () => {
      if (progressTimer !== null) window.clearTimeout(progressTimer);
      handle.view.scrollDOM.removeEventListener("scroll", onScroll);
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

  // ---------------------------------------------------------------- 快速笔记
  // 不切换仓库的速记：追加到「收件仓库」的一个文件里（设置 → 通用 配置落点）。
  // 文件名支持 {{date}} 占位（一天一篇，与日记同思路）；文件不存在时按
  // 「# 文件名」建头，与新建笔记的标题规则一致。

  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  /** 最近文件弹窗（0.27：类 IDEA 的 Ctrl+Shift+E）。 */
  const [recentFilesOpen, setRecentFilesOpen] = useState(false);
  /** 快速添加待办弹窗（0.27：Ctrl+Alt+D）。 */
  const [quickTodoOpen, setQuickTodoOpen] = useState(false);
  /** 手动添加单词弹窗（0.26）：string = 打开并预填（可为空串），null = 关闭。 */
  const [addWordDialog, setAddWordDialog] = useState<string | null>(null);
  /** 建表语句收录弹窗（0.31；默认键 0.32.1 起 Ctrl+Alt+J，可改绑）。 */
  const [ddlDialogOpen, setDdlDialogOpen] = useState(false);
  /**
   * 分栏（0.31 只读渲染 → 0.32 双编辑器 → 0.32.2 Obsidian 式分栏）：标签栏
   * 随窗格分成两段——左栏（主标签栏 + 主编辑器）与右栏（自己的标签栏 + 第二
   * 编辑器），每个标签归属一组，右栏激活自己的标签。「分屏」= 把标签移到另一
   * 组（标签唯一，天然不会同文件双开）。openTabs 仍是全部标签的唯一清单，
   * `rightTabPaths` 只记归属右栏的那些（有序）。
   */
  const [rightTabPaths, setRightTabPaths] = useState<string[]>([]);
  const rightTabsRef = useRef<string[]>([]);
  useEffect(() => {
    rightTabsRef.current = rightTabPaths;
  }, [rightTabPaths]);
  /** 右栏的激活标签（null = 右栏关着；恒 ∈ rightTabPaths）。 */
  const [splitActiveTab, setSplitActiveTab] = useState<string | null>(null);
  const splitActiveRef = useRef<string | null>(null);
  useEffect(() => {
    splitActiveRef.current = splitActiveTab;
  }, [splitActiveTab]);
  /** 最后聚焦的窗格（0.32.2）：文件树/搜索打开新笔记落在哪一栏由它决定。 */
  const focusedPaneRef = useRef<"main" | "split">("main");
  /**
   * 右栏编辑器视图的就绪代际（0.32.2 加固）：SplitPane 的 onReady 建视图后
   * +1——装载 effect 依赖它，视图晚于激活切换创建时（挂载竞态）也能重触发，
   * 不再出现右栏空白。
   */
  const [splitViewEpoch, setSplitViewEpoch] = useState(0);
  /** 目录面板跟随「最后聚焦的窗格」（0.31）：编辑器 / 分屏窗格。 */
  const [outlineFollow, setOutlineFollow] = useState<"editor" | "split">("editor");
  /** 分屏窗格有未保存内容（自动保存的驱动源，与主编辑器的 dirty 同构）。 */
  const [splitDirty, setSplitDirty] = useState(false);
  const splitDirtyRef = useRef(false);
  useEffect(() => {
    splitDirtyRef.current = splitDirty;
  }, [splitDirty]);
  /** 分屏编辑器实例（SplitPane 挂载时经 onReady 交上来）。 */
  const splitViewRef = useRef<EditorView | null>(null);
  /** 右栏装载失败提示（null = 正常；读盘重试后仍失败时显示在右栏内）。 */
  const [splitError, setSplitError] = useState<string | null>(null);
  /**
   * 分屏编辑器的资源上下文：主上下文的可变字段（embedIndex/ddlTables/动作表）
   * 按**引用**共享，notePath 换成分屏文件。loadDdlLibrary 更新 ddlTables 时
   * 两边一起改（spread 拷贝存的是值快照，换 Map 不传播）。
   */
  const splitCtxRef = useRef<LivePreviewContext | null>(null);
  /** 分屏光标行（目录面板跟随分屏时高亮当前标题）。 */
  const [splitCursorLine, setSplitCursorLine] = useState(-1);
  /**
   * 右栏宽度占比（%，28–72，默认 42）。分界线拖动调整；会话间持久化在
   * localStorage（0.32.2 用户需求「拖动中间分界线调整左右窗口大小」）。
   */
  const SPLIT_RATIO_KEY = "quicknote.splitRatio";
  const [splitPct, setSplitPct] = useState(() => {
    try {
      const raw = Number(localStorage.getItem(SPLIT_RATIO_KEY));
      if (Number.isFinite(raw) && raw >= 28 && raw <= 72) return raw;
    } catch {}
    return 42;
  });
  /** 分界线拖动：pointerdown 起，move/up 挂 **window**（分界线只有 5px 宽，
      pointer capture 在部分输入通道下不重定向——window 监听对真实鼠标与
      合成事件都可靠）→ 按容器宽度换算比例 → up 落盘。 */
  const paneDividerRef = useRef<HTMLDivElement | null>(null);
  const onPaneDividerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = event.currentTarget.parentElement;
      if (!container) return;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const startX = event.clientX;
      const startPct = splitPct;
      const total = container.getBoundingClientRect().width || 1;
      let latest = startPct;
      const onMove = (move: PointerEvent) => {
        // 右栏在右侧：向右拖 → 右栏变窄（占比减小）
        const dxPct = ((move.clientX - startX) / total) * 100;
        latest = Math.min(72, Math.max(28, startPct - dxPct));
        setSplitPct(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        try {
          localStorage.setItem(SPLIT_RATIO_KEY, String(Math.round(latest)));
        } catch {
          // 存不进去只影响下次启动的初始宽度
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [splitPct],
  );

  /**
   * 0.32.2 分栏：左右两栏各自的标签（顺序沿用 orderedOpenTabs，固定置顶对两栏
   * 分别生效）。同步流程（右键菜单守卫等）读 rightTabsRef 拿最新值。
   */
  const leftTabs = useMemo(
    () => orderedOpenTabs.filter((tab) => !rightTabPaths.includes(tab.path)),
    [orderedOpenTabs, rightTabPaths],
  );
  const rightTabs = useMemo(
    () => orderedOpenTabs.filter((tab) => rightTabPaths.includes(tab.path)),
    [orderedOpenTabs, rightTabPaths],
  );
  /** 释义自动补全的串行队列：接连添加的词读-改-写不交叠（0.30）。 */
  const vocabFillChain = useRef<Promise<void>>(Promise.resolve());
  /** 系统分享带入的预填文本（MainActivity 轮询派发到 __qnShareReceive）。 */
  const [shareDraft, setShareDraft] = useState("");
  /** 系统分享带入的图片（base64，随弹窗提交一并落附件目录）。 */
  const [shareImages, setShareImages] = useState<CaptureImage[]>([]);
  /** 移动端相册/文件选图的隐藏 input（wry onShowFileChooser 桥接 SAF）。 */
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  /** 速记管理视图（占据编辑区；命令面板 / Ctrl+Alt+M 打开，Esc 退出）。 */
  const [captureManagerOpen, setCaptureManagerOpen] = useState(false);
  /** Inbox 的扫描统计（CaptureManager 上报；右侧「今日整理」面板渲染用）。 */
  const [inboxStats, setInboxStats] = useState<{
    pending: number;
    todayNew: number;
    recentTags: string[];
  } | null>(null);
  // Inbox 视图用 display:none 隐藏笔记区（编辑器 DOM 常驻）；display 切换后
  // CM6 的尺寸缓存是 0，回来必须重测量一次，否则行号/选区/滚动整体漂移
  useEffect(() => {
    if (!captureManagerOpen) viewRef.current?.requestMeasure();
  }, [captureManagerOpen]);

  const submitQuickCapture = useCallback(
    async (
      text: string,
      tags: string[],
      images: { name: string; type: string; base64: string }[] = [],
    ): Promise<boolean> => {
      const cfg = getSettings();
      const inboxVault = cfg.quickCaptureVault.trim();
      if (!inboxVault) {
        notice("先在 设置 → 通用 里选择快速笔记的收件仓库", "error");
        return false;
      }
      const raw = (cfg.quickCaptureFile.trim() || "Inbox.md").replace(
        /\{\{date\}\}/g,
        moment().format("YYYY-MM-DD"),
      );
      const name = raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`;
      try {
        // 图片先落盘到收件仓库的附件目录（与编辑器粘贴同一份库内配置），再以
        // wiki 嵌入写进速记行——归档到目标笔记时嵌入跟着正文走
        let content = text;
        if (images.length > 0) {
          const folder = dailyRef.current.settings.pastedImageFolder;
          const date = new Date();
          const links: string[] = [];
          for (let index = 0; index < images.length; index += 1) {
            const image = images[index];
            const filename = attachmentNameFor(
              { name: image.name, type: image.type },
              date,
              index,
            );
            const relative = await writeAttachment(inboxVault, folder, filename, image.base64);
            links.push(linkTextFor(relative, "wiki"));
          }
          content = content ? `${content} ${links.join(" ")}` : links.join(" ");
        }
        const note = await readNoteOptional(inboxVault, name);
        const eol = note ? detectEol(note.content) : "\n";
        // 来源追溯：速记时所在的仓库（+ 当前打开的笔记），速记管理里展示
        const openPath = currentRef.current?.path;
        const source = vault
          ? `${vaultDisplayName(vault)}${openPath ? `/${openPath.slice(openPath.lastIndexOf("/") + 1)}` : ""}`
          : null;
        const lines = buildCaptureLines({
          timestamp: moment().format("YYYY-MM-DD HH:mm"),
          source,
          tags,
          text: content,
        });
        let next: string;
        if (!note) {
          const title = name.replace(/\.md$/i, "");
          next = `# ${title}${eol}${eol}${lines.join(eol)}${eol}`;
        } else {
          const sep = note.content.endsWith("\n") ? "" : eol;
          next = `${note.content}${sep}${lines.join(eol)}${eol}`;
        }
        await writeNote(inboxVault, name, next, note?.hasBom ?? false);
        // 速记管理面板开着时立即重扫（面板监听这个事件）
        window.dispatchEvent(new CustomEvent("qn-capture-written"));
        notice(`已记到 ${name}（${vaultDisplayName(inboxVault)}）`);
        return true;
      } catch (e) {
        notice(`快速笔记写入失败：${e}`, "error");
        return false;
      }
    },
    [notice, vault],
  );

  /**
   * 归档携带附件：速记正文里的 `![[图.png]]` 按文件名解析在**收件仓库**，归档到
   * 别的仓库时嵌入会失效——这里把引用到的文件复制进目标仓库的附件目录（重名自动
   * 加序号），返回 嵌入名 → 实际落盘文件名 的映射（没改名时键值相同），调用方
   * 据此改写链接。收件仓库没配置、与目标同库、正文没有嵌入时返回空表；单个文件
   * 找不到或复制失败只跳过该文件，不阻塞归档。
   */
  const carryAttachmentsForArchive = useCallback(
    async (texts: string[], targetVault: string): Promise<Map<string, string>> => {
      const carried = new Map<string, string>();
      const inboxVault = getSettings().quickCaptureVault.trim();
      if (!inboxVault || inboxVault === targetVault) return carried;
      const names = new Set<string>();
      for (const text of texts) {
        for (const match of text.matchAll(/!\[\[([^\]|]+?)\]\]/g)) {
          const name = match[1].trim();
          if (name) names.add(name);
        }
      }
      if (names.size === 0) return carried;
      // wiki 语法按文件名全库解析：拿收件仓库的 文件名 → 相对路径 索引定位附件
      let index: Map<string, string>;
      try {
        index = new Map(
          (await listEntries(inboxVault))
            .filter((entry) => !entry.isDir)
            .map((entry) => [entry.name, entry.path]),
        );
      } catch {
        return carried;
      }
      const folder = dailyRef.current.settings.pastedImageFolder;
      for (const name of names) {
        if (carried.has(name)) continue; // 一批里多条速记引同一张图只带一份
        const source = index.get(name);
        if (!source) continue;
        try {
          const binary = await readBinary(inboxVault, source);
          const written = await writeAttachment(
            targetVault,
            folder,
            name.slice(name.lastIndexOf("/") + 1),
            binary.base64,
          );
          carried.set(name, written.slice(written.lastIndexOf("/") + 1));
        } catch {
          // 找不到或复制失败：链接原样保留
        }
      }
      return carried;
    },
    [],
  );

  // ---------------------------------------------------------------- 标签仪表盘
  // 全仓库的标签索引：切到「标签」视图时扫描一遍（读文件 → 数标签），文件名
  // 变化（refresh 换了 entries 身份）或显式 token 递增（移除标签后）才重扫。
  // 扫描有 600ms 防抖——打字触发的自动保存会让 entries 频繁换身份，别每键全库重读。

  const [tagIndex, setTagIndex] = useState<{
    loading: boolean;
    tags: { name: string; notes: string[] }[];
    noteTags: Record<string, string[]>;
  }>({ loading: false, tags: [], noteTags: {} });
  const [tagDashTag, setTagDashTag] = useState<string | null>(null);
  const [tagScanToken, setTagScanToken] = useState(0);
  /** 标签列表置顶的标签名（按仓库分桶；0.27 用户反馈）。 */
  const [pinnedTagNames, setPinnedTagNames] = useState<string[]>([]);

  // 标签置顶按仓库分桶读写（与收藏置顶同一套模式）
  useEffect(() => {
    if (!vault) return;
    try {
      const raw = localStorage.getItem(TAGS_PIN_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      setPinnedTagNames(Array.isArray(map[vault]) ? map[vault] : []);
    } catch {
      setPinnedTagNames([]);
    }
  }, [vault]);

  useEffect(() => {
    if (!vault) return;
    try {
      const raw = localStorage.getItem(TAGS_PIN_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      map[vault] = pinnedTagNames;
      localStorage.setItem(TAGS_PIN_KEY, JSON.stringify(map));
    } catch {
      // 存不进去只影响下次启动的置顶状态
    }
  }, [pinnedTagNames, vault]);

  const toggleTagPin = useCallback((name: string) => {
    setPinnedTagNames((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }, []);

  useEffect(() => {
    if (leftView !== "tags" || !vault) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setTagIndex((prev) => ({ ...prev, loading: true }));
      const paths = entries.filter((entry) => !entry.isDir && isMarkdownPath(entry.path)).map((entry) => entry.path);
      const map: Record<string, string[]> = {};
      let cursor = 0;
      const worker = async () => {
        // 小并发逐篇读：一次性把几百个 IPC 全打出去反而更慢，也容易占满通道
        while (!cancelled) {
          const index = cursor;
          cursor += 1;
          if (index >= paths.length) break;
          try {
            const note = await readNoteOptional(vault, paths[index]);
            if (note) map[paths[index]] = noteTags(note.content);
          } catch {
            // 单篇读失败不影响整体：它只是不进索引
          }
        }
      };
      await Promise.all(Array.from({ length: 8 }, () => worker()));
      if (cancelled) return;
      const byTag = new Map<string, string[]>();
      for (const [path, tags] of Object.entries(map)) {
        for (const tag of tags) {
          const bucket = byTag.get(tag);
          if (bucket) bucket.push(path);
          else byTag.set(tag, [path]);
        }
      }
      const pinnedAuto = getSettings().autoTagName.trim();
      const list = [...byTag.entries()]
        .map(([name, notes]) => ({ name, notes }))
        .sort((a, b) => {
          if (pinnedAuto && a.name === pinnedAuto) return -1;
          if (pinnedAuto && b.name === pinnedAuto) return 1;
          return b.notes.length - a.notes.length || a.name.localeCompare(b.name, "zh");
        });
      setTagIndex({ loading: false, tags: list, noteTags: map });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [leftView, vault, entries, tagScanToken]);

  /**
   * 从仪表盘移除某篇笔记的标签。三种存放位置各走各路（与 syncFirstHeading 同纪律）：
   * 激活中的笔记在视图里改（保住撤销历史，自动保存落盘）；后台标签改它的存量
   * EditorState 并标脏；没打开的读盘-改-写回。改完递增扫描 token 让列表即时刷新。
   */
  const removeTagFromNote = useCallback(
    async (path: string, tag: string) => {
      if (!vault) return;
      const bump = () => setTagScanToken((value) => value + 1);
      const view = viewRef.current;
      if (view && viewOwnerRef.current === path) {
        removeNoteTag(tag);
        bump();
        return;
      }
      const stored = stateStore.current.get(path);
      if (stored) {
        const text = stored.doc.toString();
        const edit = tagRemoveEdit(text, tag);
        if (!edit) return;
        stateStore.current.set(
          path,
          stored.update({ changes: { from: edit.at, to: edit.to, insert: edit.insert } }).state,
        );
        dirtyTabs.current.add(path);
        bump();
        return;
      }
      try {
        const note = await readNoteOptional(vault, path);
        if (!note) return;
        const text = note.content;
        const edit = tagRemoveEdit(text, tag);
        if (!edit) return;
        await writeNote(vault, path, text.slice(0, edit.at) + edit.insert + text.slice(edit.to), note.hasBom);
        bump();
      } catch (e) {
        setError(String(e));
      }
    },
    [vault, removeNoteTag],
  );

  /**
   * 标签列表的展示序：自动标签（「待整理」类）最前，用户置顶的标签紧随其后
   * （0.27），其余按笔记数。派生而非重扫——置顶/取消置顶不该把全仓库再读一遍。
   */
  const sortedTagIndex = useMemo(() => {
    const pinnedAuto = getSettings().autoTagName.trim();
    const pinnedSet = new Set(pinnedTagNames);
    const tags = [...tagIndex.tags].sort((a, b) => {
      if (pinnedAuto && a.name === pinnedAuto) return -1;
      if (pinnedAuto && b.name === pinnedAuto) return 1;
      const pa = pinnedSet.has(a.name) ? 1 : 0;
      const pb = pinnedSet.has(b.name) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.notes.length - a.notes.length || a.name.localeCompare(b.name, "zh");
    });
    return { ...tagIndex, tags };
  }, [tagIndex, pinnedTagNames]);

  /**
   * 重命名标签（0.27）：对索引里带这个标签的每一篇笔记做 `#from → #to` 的
   * 多区间替换。三种存放位置与 removeTagFromNote 同纪律：激活中的走视图
   * （一步撤销）；后台标签改存量 EditorState 并标脏；未打开的读盘-改-写回。
   * 全部完成后重扫标签索引；置顶状态跟着改名迁移。
   */
  const renameTag = useCallback(
    async (from: string, to: string) => {
      if (!vault || from === to) return;
      const paths = Object.entries(tagIndex.noteTags)
        .filter(([, tags]) => tags.includes(from))
        .map(([path]) => path);
      if (paths.length === 0) return;
      let changed = 0;
      for (const path of paths) {
        const bumpChanged = () => {
          changed += 1;
        };
        const view = viewRef.current;
        if (view && viewOwnerRef.current === path) {
          const edits = tagRenameEdits(view.state.doc.toString(), from, to);
          if (edits.length > 0) {
            view.dispatch({ changes: edits.map((edit) => ({ from: edit.at, to: edit.to, insert: edit.insert })) });
            bumpChanged();
          }
          continue;
        }
        const stored = stateStore.current.get(path);
        if (stored) {
          const edits = tagRenameEdits(stored.doc.toString(), from, to);
          if (edits.length > 0) {
            stateStore.current.set(
              path,
              stored.update({ changes: edits.map((edit) => ({ from: edit.at, to: edit.to, insert: edit.insert })) }).state,
            );
            dirtyTabs.current.add(path);
            bumpChanged();
          }
          continue;
        }
        try {
          const note = await readNoteOptional(vault, path);
          if (!note) continue;
          const edits = tagRenameEdits(note.content, from, to);
          if (edits.length === 0) continue;
          let text = note.content;
          for (let i = edits.length - 1; i >= 0; i -= 1) {
            const edit = edits[i];
            text = text.slice(0, edit.at) + edit.insert + text.slice(edit.to);
          }
          await writeNote(vault, path, text, note.hasBom);
          bumpChanged();
        } catch (e) {
          setError(`重命名标签写 ${path} 失败：${e}`);
        }
      }
      // 置顶状态跟着新名字走
      setPinnedTagNames((prev) =>
        prev.includes(from) ? prev.map((n) => (n === from ? to : n)) : prev,
      );
      setTagScanToken((value) => value + 1);
      if (tagDashTag === from) setTagDashTag(to);
      if (changed > 0) setStatus(`已把「#${from}」重命名为「#${to}」（${changed} 篇笔记）`);
    },
    [vault, tagIndex.noteTags, tagDashTag],
  );

  /**
   * 建表语句悬浮库（0.31）：读仓库内的 DDL 笔记 → 「表名 → 语句」映射塞进资源
   * 上下文（就地改字段，同一可变对象约定）。打开仓库、DDL 笔记变化、收录弹窗
   * 保存后都要走一遍。文件不存在/解析为空都清空映射（悬浮随之失活）。
   */
  const loadDdlLibrary = useCallback(async (dir: string) => {
    try {
      const path = getSettings().ddlFilePath.trim() || "数据库表DDL.md";
      const note = await readNoteOptional(dir, path);
      const tables = note ? parseDdlTables(note.content) : new Map();
      resourcesRef.current.ddlTables = tables;
      // 分屏上下文是 spread 拷贝（notePath 不同）：换 Map 的赋值不传播，手动同步
      if (splitCtxRef.current) splitCtxRef.current.ddlTables = tables;
    } catch {
      resourcesRef.current.ddlTables = new Map();
      if (splitCtxRef.current) splitCtxRef.current.ddlTables = new Map();
    } finally {
      // 库变了没有文档事务：通知表名着色插件重扫（0.34.2 表名变色）
      notifyDdlLibraryUpdated();
    }
  }, []);

  // 表格单元格的 DDL 悬浮（0.32 用户反馈「光标在表格内容上无法唤起弹窗」）：
  // document 层委托，主编辑器与分屏编辑器的表格 widget 一并覆盖
  useEffect(() => installDdlCellHover(), []);

  const refresh = useCallback(
    async (dir: string) => {
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

      // DDL 笔记可能在别的窗口/外部被改过，顺手重载悬浮库（读一次文件，开销小）
      void loadDdlLibrary(dir);

      const view = viewRef.current;
      if (view) requestDecorationRefresh(view);
    },
    [loadDdlLibrary],
  );

  /**
   * DDL 语句落盘：读 DDL 笔记 → 同名表整段替换（新表追加文末）→ 写回 →
   * 重载悬浮库。收录弹窗（Ctrl+Alt+J）与悬浮卡「编辑」（0.34.2 用户反馈
   * 「支持在这个视图中直接修改 DDL 语句」）共用这一条通道。
   */
  const saveDdlStatements = useCallback(
    async (ddlText: string) => {
      const dir = vaultRef.current;
      if (!dir) throw new Error("打开仓库后才能保存建表语句");
      const path = getSettings().ddlFilePath.trim() || "数据库表DDL.md";
      const existing = await readNoteOptional(dir, path);
      const base = existing?.content ?? ddlNoteIntro();
      const merged = mergeDdlIntoNote(base, ddlText);
      await writeNote(dir, path, merged, existing?.hasBom ?? false);
      await loadDdlLibrary(dir);
      void refresh(dir);
      const names = extractTableNames(ddlText);
      return `已保存 ${names.length} 张表 → ${path}`;
    },
    [loadDdlLibrary, refresh],
  );

  // 悬浮卡的「编辑」走模块级钩子注入（ddlHover.ts 的 saver；卸载时清除）
  useEffect(() => {
    setDdlSaver((_table, ddl) => saveDdlStatements(ddl));
    return () => setDdlSaver(null);
  }, [saveDdlStatements]);

  /** 笔记数量（目录与非 md 文件不计入）。 */
  const noteCount = useMemo(
    () => entries.filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md")).length,
    [entries],
  );

  /**
   * 附件数量（设置 → 存储的数据统计）：附件目录（库内配置 pastedImageFolder，
   * 默认 attachments）下的文件；目录为空按仓库根的一级文件算。
   */
  const attachmentCount = useMemo(() => {
    const folder = daily.settings.pastedImageFolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const prefix = folder ? `${folder}/` : "";
    return entries.filter(
      (entry) => !entry.isDir && (prefix ? entry.path.startsWith(prefix) : !entry.path.includes("/")),
    ).length;
  }, [entries, daily.settings.pastedImageFolder]);

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

  // 移动端「回前台重扫」：仓库在共享存储（基础目录模型）后，外部改动源存在
  // （电脑 USB 拷贝、网盘/Syncthing 同步）；Android 上 notify 的 inotify 对 FUSE
  // 不完全可靠，回前台时整目录刷新一次是最稳的兜底（桌面有监听，不需要）。
  useEffect(() => {
    if (!isMobile()) return;
    // 回前台重扫（共享存储有外部改动源）+ 回后台超时清理（内存治理，对齐
    // 桌面「失焦 3 分钟降档」的思路：mermaid SVG 缓存是纯内存开销，下次
    // 渲染按需重建）
    let hideTimer: number | null = null;
    const onVisible = () => {
      const dir = vaultRef.current;
      if (document.visibilityState === "visible") {
        if (hideTimer !== null) {
          window.clearTimeout(hideTimer);
          hideTimer = null;
        }
        if (dir) refresh(dir).catch(() => {});
      } else if (dir) {
        hideTimer = window.setTimeout(() => {
          clearMermaidCache();
          hideTimer = null;
        }, 3 * 60 * 1000);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (hideTimer !== null) window.clearTimeout(hideTimer);
    };
  }, [refresh]);

  /** 用磁盘上的内容替换**激活标签**，尽量保住光标位置。 */
  const adoptFromDisk = useCallback(
    (note: NoteContent) => {
      const view = viewRef.current;
      const anchor = view ? view.state.selection.main.anchor : 0;
      // 嵌入内容里的相对路径要相对"当前笔记"解析，所以先更新上下文
      resourcesRef.current.notePath = note.path;
      const newState = createEditorState(note.content, {
        lineEnding: note.lineEnding,
        mode: isMarkdownPath(note.path) ? effectiveViewMode(modeRef.current) : "source",
        language: editorLanguageOf(note.path),
        onDocChanged: handleDocChanged,
        onSave: handleEditorSave,
        resources: resourcesRef.current,
        attachment: attachmentOptions,
        codePaste: codePasteOptions,
        dark: resolveTheme(getSettings().theme) === "dark",
        onCursorInTable: handleCursorInTable,
          onCursorLine: handleCursorLine,
      });
      view?.setState(newState);
      view?.dispatch({ selection: { anchor: Math.min(anchor, view.state.doc.length) } });
      stateStore.current.set(note.path, newState);
      viewOwnerRef.current = note.path;
      tabActivatedAt.current.set(note.path, Date.now());
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
      // 0.34.6 用户反馈：切标签同切笔记——DDL 悬浮卡/编辑浮层一并收掉
      closeDdlTip();
      // 归属右栏的标签不在主编辑器激活（0.32.2 分栏）：路由到右栏（openNote
      // 正常都先路由过，这里兜直连调用者）
      if (rightTabsRef.current.includes(path)) {
        setSplitActiveTab(path);
        return;
      }
      // 捕获用 viewOwnerRef 而非 currentRef：后者要等渲染才对齐，重命名换键后的
      // 同步换页里它还指向旧路径——把实时状态写进死键，之后用旧名新建会复活旧内容。
      const prev = viewOwnerRef.current;
      if (prev && prev !== path) {
        stateStore.current.set(prev, view.state);
        scrollStore.current.set(prev, view.scrollDOM.scrollTop);
        if (dirtyRef.current) dirtyTabs.current.add(prev);
        // 阅读位置落库（0.31）：切走标签时把它最后的位置持久化
        const dir = vaultRef.current;
        if (dir) saveProgress(window.localStorage, dir, prev, view.scrollDOM.scrollTop);
      }
      view.setState(stored);
      // 存量状态可能带着分屏的上下文（分屏里编辑过的实时状态）：装进主编辑器
      // 时换回主上下文（0.32 分屏，notePath 归属随视图走）
      applyLivePreviewContext(view, resourcesRef.current);
      viewOwnerRef.current = path;
      tabActivatedAt.current.set(path, Date.now());
      // 会话内存量优先（刚才还在读的位置），没有再回持久化的阅读位置（0.31）
      const dirNow = vaultRef.current;
      view.scrollDOM.scrollTop =
        scrollStore.current.get(path) ??
        (dirNow ? loadProgress(window.localStorage, dirNow, path) ?? 0 : 0);
      resourcesRef.current.notePath = path;
      // 存量状态的 Compartment 是它创建那一刻的模式/主题，切回来要对齐当前选择
      applyMode(view, effectiveViewMode(modeRef.current));
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
      // 居中滚动（0.23 用户反馈：跳转目标要自动展示在屏幕中间）
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    view.focus();
  }, []);

  /** 关闭标签。有未保存内容先落盘（后台标签直接用它存量的状态写，不用先激活）。 */
  const closeTab = useCallback(
    async (path: string) => {
      // 固定标签不响应任何关闭入口（中键/关闭钮已被 UI 隐藏，这里兜底逻辑入口）
      if (pinnedTabsRef.current.has(path)) return;
      const startedAt = Date.now();
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
      // await 范围内它被重新打开并激活（点关闭后又立刻点了同一篇）：放弃这次关闭。
      // 继续关的话会把正在显示的笔记除名——编辑区有内容、状态栏却是「未打开文件」
      // （0.30 用户反馈的偶发复用旧标签）。内容刚落过盘，标签保持打开即最新意图。
      if ((tabActivatedAt.current.get(path) ?? 0) > startedAt) return;
      dirtyTabs.current.delete(path);
      staleTabs.current.delete(path);
      stateStore.current.delete(path);
      scrollStore.current.delete(path);
      tabActivatedAt.current.delete(path);
      const previous = openTabsRef.current;
      const index = previous.findIndex((tab) => tab.path === path);
      // 函数式过滤：await 期间 openNote 可能已把别的标签 append 进列表，
      // 非函数式写回会拿陈旧快照把它覆盖掉
      setOpenTabs((prev) => prev.filter((tab) => tab.path !== path));
      // 0.32.2 分栏：右栏标签的归属与激活同步收缩；右栏最后一个标签关掉时
      // 右栏随之收起（视图卸载由渲染驱动）
      const wasRight = rightTabsRef.current.includes(path);
      if (wasRight) {
        const rightAfter = rightTabsRef.current.filter((p) => p !== path);
        rightTabsRef.current = rightAfter;
        setRightTabPaths(rightAfter);
        if (splitActiveRef.current === path) {
          setSplitActiveTab(rightAfter.length > 0 ? rightAfter[rightAfter.length - 1] : null);
          setSplitDirty(dirtyTabs.current.has(rightAfter[rightAfter.length - 1] ?? ""));
        }
      }
      if (!wasRight && (activeTabRef.current === path || viewOwnerRef.current === path)) {
        // 邻居只在**左栏**里找（右栏标签归右栏激活）；左栏被关空而右栏还有标签时，
        // 把右栏标签整体搬回左栏并激活第一个（不让主编辑区悬空）
        const nextLeft = previous.filter(
          (tab) => tab.path !== path && !rightTabsRef.current.includes(tab.path),
        );
        const neighborIndex = Math.min(Math.max(index, 0), nextLeft.length - 1);
        const neighbor = neighborIndex >= 0 ? nextLeft[neighborIndex]?.path ?? null : null;
        if (neighbor && stateStore.current.has(neighbor)) {
          activateTab(neighbor);
        } else if (rightTabsRef.current.length > 0) {
          const moving = rightTabsRef.current;
          rightTabsRef.current = [];
          setRightTabPaths([]);
          setSplitActiveTab(null);
          setOutlineFollow("editor");
          if (stateStore.current.has(moving[0])) activateTab(moving[0]);
        } else {
          setActiveTab(null);
          setDirty(false);
          setInTable(false);
          resourcesRef.current.notePath = null;
          viewRef.current?.setState(emptyEditorState());
          viewOwnerRef.current = null;
        }
      } else if (!wasRight) {
        // 关的是左栏后台标签，激活者不变；但 dirty 标记可能在脏集合里，同步一次显示
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
      const startedAt = Date.now();
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
      // 落盘窗口里被重新打开并激活的标签从关闭集合里剔除（同 closeTab 的对账）
      for (const path of targets) {
        if ((tabActivatedAt.current.get(path) ?? 0) > startedAt) targetSet.delete(path);
      }
      if (targetSet.size === 0) return;
      for (const path of targetSet) {
        dirtyTabs.current.delete(path);
        staleTabs.current.delete(path);
        stateStore.current.delete(path);
        scrollStore.current.delete(path);
        tabActivatedAt.current.delete(path);
      }
      const previous = openTabsRef.current;
      const index = previous.findIndex((tab) => tab.path === activeTabRef.current);
      setOpenTabs((prev) => prev.filter((tab) => !targetSet.has(tab.path)));
      // 0.32.2 分栏：右栏归属收缩 + 右栏激活的邻居（右栏空了收起）
      const rightAfter = rightTabsRef.current.filter((p) => !targetSet.has(p));
      const rightChanged = rightAfter.length !== rightTabsRef.current.length;
      if (rightChanged) {
        rightTabsRef.current = rightAfter;
        setRightTabPaths(rightAfter);
        if (splitActiveRef.current && targetSet.has(splitActiveRef.current)) {
          setSplitActiveTab(rightAfter.length > 0 ? rightAfter[rightAfter.length - 1] : null);
        }
      }
      if (activeTabRef.current && targetSet.has(activeTabRef.current)) {
        // 邻居只在左栏里找；左栏关空而右栏还有标签 → 整体搬回左栏激活第一个
        const nextLeft = previous.filter(
          (tab) => !targetSet.has(tab.path) && !rightTabsRef.current.includes(tab.path),
        );
        const neighbor = nextLeft[Math.min(Math.max(index, 0), nextLeft.length - 1)]?.path ?? null;
        if (neighbor && stateStore.current.has(neighbor)) {
          activateTab(neighbor);
        } else if (rightTabsRef.current.length > 0) {
          const moving = rightTabsRef.current;
          rightTabsRef.current = [];
          setRightTabPaths([]);
          setSplitActiveTab(null);
          setOutlineFollow("editor");
          if (stateStore.current.has(moving[0])) activateTab(moving[0]);
        } else {
          setActiveTab(null);
          setDirty(false);
          setInTable(false);
          resourcesRef.current.notePath = null;
          viewRef.current?.setState(emptyEditorState());
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
      // 手工编辑 DDL 笔记后，悬浮库跟着更新（0.31）
      if (current.path === (getSettings().ddlFilePath.trim() || "数据库表DDL.md")) {
        void loadDdlLibrary(vault);
      }
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
  }, [vault, current, conflict, loadDdlLibrary]);

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

      // 单词本是「单词」面板的数据源：外部改动（另一窗口/同步回写）也要让面板重读
      if (paths.some((path) => path === VOCAB_FILENAME || path.endsWith(`/${VOCAB_FILENAME}`))) {
        setVocabVersion((value) => value + 1);
      }

      // 同步引擎按同一批路径排队推送（自己写入产生的回声靠内容哈希跳过）。
      syncRef.current?.handleVaultChange(paths);

      // 后台标签：只标记"文件被外部改过"，等它再次激活时与磁盘对账（openNote 的 stale 分支）
      for (const tab of openTabsRef.current) {
        if (tab.path !== activeTabRef.current && paths.includes(tab.path)) {
          staleTabs.current.add(tab.path);
        }
      }

      // 右栏文件的外部改动（0.32 分屏可编辑）：干净就采纳磁盘版（保滚动），
      // 有未保存编辑则提示——下次保存以本窗口为准（主编辑器的冲突横幅机制
      // 不覆盖右栏，这里用状态栏提示 + stale 标记兜底）
      const splitPathNow = splitActiveRef.current;
      if (splitPathNow && paths.includes(splitPathNow) && splitViewRef.current) {
        try {
          const freshSplit = await readNote(vault, splitPathNow);
          const splitMeta = openTabsRef.current.find((tab) => tab.path === splitPathNow);
          if (splitMeta && freshSplit.sha256 === splitMeta.sha256) {
            // 自己保存的回声
          } else if (splitDirtyRef.current) {
            staleTabs.current.add(splitPathNow);
            setStatus("分屏文件被外部修改，保存时以本窗口内容为准");
          } else {
            const splitView = splitViewRef.current;
            const top = splitView.scrollDOM.scrollTop;
            const adopted = createSplitState(freshSplit);
            stateStore.current.set(splitPathNow, adopted);
            splitView.setState(adopted);
            applyMode(splitView, effectiveViewMode(modeRef.current));
            applyDarkTheme(splitView, resolveTheme(getSettings().theme) === "dark");
            splitView.scrollDOM.scrollTop = top;
            staleTabs.current.delete(splitPathNow);
            setOpenTabs((prev) =>
              prev.map((tab) => (tab.path === splitPathNow ? freshSplit : tab)),
            );
            setStatus("分屏已跟随外部改动");
          }
        } catch {
          // 读失败保持现状
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

    /** 启动时确定打开哪个仓库。移动端：基础目录 → 上次仓库（须在基础目录下）；
        未设基础目录且没跳过过 → 返回 null（空状态里出引导页）。桌面链路不变。 */
    const bootVault = async (): Promise<string | null> => {
      const explicit = await startupVault().catch(() => null);
      if (explicit) return explicit;
      if (isMobile()) {
        const home = await vaultHomeGet().catch(() => null);
        if (!home) {
          return vaultHomeSkipped() ? defaultVaultDir().catch(() => null) : null;
        }
        const last = localStorage.getItem(VAULT_KEY);
        return last && last.startsWith(home) ? last : null;
      }
      return localStorage.getItem(VAULT_KEY);
    };

    bootVault()
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

  // 窗口关闭时把**本窗口**的仓库写回 VAULT_KEY（0.31）：localStorage 是所有
  // 窗口共享的，多窗口各开各的仓库时，任何一次切仓都会改写它——下次启动恢复
  // 的就成了「另一个窗口最后切到的仓库」而不是「最后关闭的窗口所在的仓库」
  // （0.30 用户反馈：重开软件显示的不是上次关闭时的仓库）。beforeunload 同步
  // 写一份；Tauri 的关闭请求事件再补一份（WebView2 销毁时 beforeunload 不保证触发）。
  //
  // 0.32.1「无法关闭软件」修复：Tauri 的 onCloseRequested 包装层是
  // 处理器 → 未 preventDefault → destroy()——处理器链上任何异常都会让
  // destroy 被跳过，窗口从此点 ✕ 没反应。两道保险：
  //   1. 这里显式兜底 destroy（与包装层自己的 destroy 双关无害）；
  //   2. 顶栏 ✕ 按钮直接 destroy（绕过事件链，见 window-controls）。
  const persistVaultKey = useCallback(() => {
    const dir = vaultRef.current;
    if (!dir) return;
    try {
      localStorage.setItem(VAULT_KEY, dir);
    } catch {
      // 写不进去也绝不能挡住关闭
    }
  }, []);
  useEffect(() => {
    window.addEventListener("beforeunload", persistVaultKey);
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested(() => {
        persistVaultKey();
        void getCurrentWindow().destroy().catch(() => {});
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {});
    return () => {
      window.removeEventListener("beforeunload", persistVaultKey);
      unlisten?.();
    };
  }, [persistVaultKey]);

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
      setTagDashTag(null);
      setTreeClipboard(null);
      // 右栏先收起（0.32.2 分栏：视图持有旧仓库内容，stateStore 也要清）
      splitViewRef.current = null;
      splitActiveRef.current = null;
      rightTabsRef.current = [];
      splitCtxRef.current = null;
      setRightTabPaths([]);
      setSplitActiveTab(null);
      setSplitDirty(false);
      setOutlineFollow("editor");
      focusedPaneRef.current = "main";
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
      // 导航历史按仓库清（历史里全是旧仓库的路径，留着只会 ‹ 回去打不开）
      setNavHistory({ stack: [], index: -1 });
      resourcesRef.current.notePath = null;
      viewRef.current?.setState(emptyEditorState());
      activateVault(picked);
      try {
        await refresh(picked);
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh, activateVault, recordVault],
  );

  const [vaultGateOpen, setVaultGateOpen] = useState(false);

  const [syncBatchLabel, setSyncBatchLabel] = useState("");
  /** 批量同步中失败的仓库（列表页显示「重试失败仓库」入口）。 */
  const [syncFailedPaths, setSyncFailedPaths] = useState<string[]>([]);
  /** 仓库列表多选同步：逐仓库跑独立引擎（不切 UI），结果实时进标签；
      每仓两轮——第二轮接住第一轮被下载额度（50MB/轮）推迟的附件；
      每仓 90s 上限（连不上的仓库不拖死整批）。 */
  const syncSelectedVaults = useCallback(
    async (paths: string[]) => {
      const results: string[] = [];
      const failed: string[] = [];
      for (let i = 0; i < paths.length; i += 1) {
        const name = paths[i].replace(/[\/]+$/, "").split(/[\/]/).pop() ?? paths[i];
        setSyncBatchLabel(
          `正在同步 ${name}（${i + 1}/${paths.length}）… ${results.join(" · ")}`,
        );
        let ok = true;
        let message = "";
        try {
          await Promise.race([
            (async () => {
              await sync.syncVaultOnce(paths[i]);
              // 第二轮：附件下载每轮 50MB 上限，没下完的这轮接着下
              await sync.syncVaultOnce(paths[i]);
            })(),
            new Promise((_, reject) =>
              window.setTimeout(() => reject(new Error("超时（90 秒）")), 90_000),
            ),
          ]);
        } catch (e) {
          ok = false;
          message = String(e);
          setError(`同步 ${name} 失败：${message}`);
        }
        results.push(ok ? `${name} ✓` : `${name} ✗`);
        if (!ok) failed.push(paths[i]);
      }
      setSyncFailedPaths(failed);
      setSyncBatchLabel(
        failed.length === 0 ? "" : `完成，但有问题：${results.join(" · ")}`,
      );
      if (failed.length === 0) {
        setStatus(`批量同步完成（${paths.length} 个仓库）`);
      }
    },
    [sync],
  );

  /** 仓库列表页的「开启同步」：切到该仓库（同步状态跟仓库走）→ 启用自动同步 →
      立即同步一轮 → 回到列表页。 */
  const [pendingEnableVault, setPendingEnableVault] = useState<string | null>(null);
  const enableVaultSync = useCallback(
    async (path: string) => {
      await switchVault(path);
      // 不能在这里直接 updateConfig：useSync 对新仓库的异步加载还没完成，
      // 现在写入会被加载完成后的 setState 覆盖掉。等 ready 后由下面的 effect 补写。
      setPendingEnableVault(path);
      setVaultGateOpen(true);
    },
    [switchVault],
  );

  useEffect(() => {
    if (!pendingEnableVault || !sync.ready || !vault) return;
    if (vault.replace(/[\\/]+$/, "").toLowerCase() !== pendingEnableVault.replace(/[\\/]+$/, "").toLowerCase()) return;
    setPendingEnableVault(null);
    sync.updateConfig({ enabled: true });
    void sync.syncNow();
  }, [pendingEnableVault, sync, vault]);

  // ---------------------------------------------------------------- 已打开仓库

  /** 仓库路径同判：正斜杠、结尾分隔符与大小写（Windows）不影响判定。 */
  const sameVaultPath = (a: string, b: string): boolean =>
    a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

  /**
   * 目标仓库已在别的窗口打开时把它调到前台。
   * 登记表由各窗口进程维护（Rust 侧 open_vaults），崩溃的窗口按 pid 清理。
   * 返回三态：focused = 已切换过去；absent = 登记表里没有（没开或已退出）；
   * focus-failed = 确认别窗口开着、但系统拒绝切换（调用方绝不能默不作声地
   * 再开一份——那就是 0.26 用户反馈的"点击已打开的仓库会新开窗口"）。
   */
  const revealOpenVault = useCallback(
    async (picked: string): Promise<"focused" | "absent" | "focus-failed"> => {
      const others = await openedVaults();
      if (!others.some((dir) => sameVaultPath(dir, picked))) return "absent";
      const focused = await focusVaultWindow(picked);
      if (!focused) return "focus-failed";
      setStatus(`仓库已在其他窗口打开，已切换过去：${vaultDisplayName(picked)}`);
      return "focused";
    },
    [],
  );

  // 本窗口打开的仓库登记到跨进程登记表；换仓库（vault 状态变化）自动刷新，
  // 退出时尽力注销——没来得及注销（强杀/崩溃）的条目由 Rust 读取时按 pid 兜底。
  // 窗口聚焦/pageshow/切回前台时补一次登记：登记表还是热键仲裁的信号之一，
  // WebView 后台重载（beforeunload 会先注销）或登记失败后，这里是无重试开销的
  // 自愈点（0.24 用户反馈；0.25 再补 pageshow/visibilitychange——后台重载发生时
  // 窗口没有 focus 事件，只有这两个能补上）。
  useEffect(() => {
    if (!vault) return;
    void registerOpenVault(vault);
    const onFocus = () => void registerOpenVault(vault);
    const onShow = () => void registerOpenVault(vault);
    const onVisible = () => {
      if (document.visibilityState === "visible") void registerOpenVault(vault);
    };
    const onUnload = () => {
      void unregisterOpenVault();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [vault]);

  const openVault = useCallback(async () => {
    // 移动端不走 SAF 选取：仓库来自基础目录的发现列表，弹出仓库页
    if (isMobile()) {
      setVaultGateOpen(true);
      return;
    }
    const picked = await pickVault();
    if (!picked) return;
    if (vault && sameVaultPath(picked, vault)) return;
    // 已在其他窗口打开：不再问「当前窗口还是新窗口」，直接切到那个窗口；
    // 切换失败时也绝不静默新开一份，交回弹窗让用户显式选择
    const reveal = await revealOpenVault(picked);
    if (reveal === "focused") return;
    if (reveal === "focus-failed") {
      setStatus("仓库已在其他窗口打开，但自动切换失败——请手动切换，或选择打开方式");
      setVaultChoice({ picked, remember: false });
      return;
    }
    // 打开方式：设置里固定了就直接走；默认（ask）弹窗让用户选当前窗口/新窗口
    const mode = getSettings().vaultOpenMode;
    if (mode === "newWindow") {
      try {
        await openNewWindow(picked);
        setStatus(`已在新窗口打开：${picked}`);
      } catch (e) {
        setError(`在新窗口打开失败：${e}`);
      }
      return;
    }
    if (mode === "current") {
      await switchVault(picked);
      return;
    }
    setVaultChoice({ picked, remember: false });
  }, [pickVault, vault, switchVault, revealOpenVault]);

  /** 「打开其他仓库」的方式选择弹窗（vaultOpenMode = ask 时出现）。 */
  const [vaultChoice, setVaultChoice] = useState<{ picked: string; remember: boolean } | null>(null);
  const chooseVaultOpen = useCallback(
    async (way: "current" | "newWindow", remember: boolean) => {
      const picked = vaultChoice?.picked;
      setVaultChoice(null);
      if (!picked) return;
      if (remember) applySettings({ vaultOpenMode: way });
      if (way === "newWindow") {
        try {
          await openNewWindow(picked);
          setStatus(`已在新窗口打开：${picked}`);
        } catch (e) {
          setError(`在新窗口打开失败：${e}`);
        }
        return;
      }
      await switchVault(picked);
    },
    [vaultChoice, applySettings, switchVault],
  );
  // 弹窗键盘：Enter = 推荐操作（在新窗口打开），Esc = 取消
  useEffect(() => {
    if (!vaultChoice) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void chooseVaultOpen("newWindow", vaultChoice.remember);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setVaultChoice(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vaultChoice, chooseVaultOpen]);

  /** 换到最近打开的某个仓库（顶栏下拉）：与「选择其他仓库」一样按 vaultOpenMode 走（默认弹窗问当前窗口还是新窗口）。 */
  const openRecentVault = useCallback(
    async (dir: string) => {
      setVaultMenu(null);
      // 路径同判用归一化比较：登记表/最近列表/当前仓库的来源不同（目录选择框、
      // argv、localStorage），尾部分隔符与大小写可能漂移，精确比较会漏判
      if (vault && sameVaultPath(dir, vault)) return;
      const reveal = await revealOpenVault(dir);
      if (reveal === "focused") return;
      if (reveal === "focus-failed") {
        setStatus("仓库已在其他窗口打开，但自动切换失败——请手动切换，或选择打开方式");
        setVaultChoice({ picked: dir, remember: false });
        return;
      }
      const mode = getSettings().vaultOpenMode;
      if (mode === "newWindow") {
        try {
          await openNewWindow(dir);
          setStatus(`已在新窗口打开：${dir}`);
        } catch (e) {
          setError(`在新窗口打开失败：${e}`);
        }
        return;
      }
      if (mode === "current") {
        await switchVault(dir);
        return;
      }
      setVaultChoice({ picked: dir, remember: false });
    },
    [vault, switchVault, revealOpenVault],
  );

  // ------------------------------------------------------------------ 云端仓库（0.32.2）
  //
  // 仓库下拉里列出服务器上可同步的仓库（listCloudVaults）：已在本机的（最近
  // 仓库里目录名与云端名一致）直接打开；没有的点击后引导选择落地位置——目录
  // 名沿用云端名（同步的 vaultName 由此对上），落地 = 空目录 + 开启同步，首轮
  // 同步自动把云端内容全量拉下来。

  const [cloudVaults, setCloudVaults] = useState<{
    loading: boolean;
    list: Array<{ name: string; version: number }> | null;
    error: string | null;
  }>({ loading: false, list: null, error: null });

  // 菜单打开时拉一次（有同步账号才拉）；关闭即重置，下次打开重新取
  useEffect(() => {
    if (!vaultMenu) {
      setCloudVaults({ loading: false, list: null, error: null });
      return;
    }
    if (!sync.config.serverUrl || !sync.config.username || !sync.config.password) return;
    let alive = true;
    setCloudVaults({ loading: true, list: null, error: null });
    sync
      .listCloudVaults()
      .then((list) => {
        if (alive) setCloudVaults({ loading: false, list, error: null });
      })
      .catch((e) => {
        if (alive) setCloudVaults({ loading: false, list: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultMenu, sync.config.serverUrl, sync.config.username, sync.config.password]);

  /**
   * 本机同步状态里出现过的云端仓库名（0.32.2 修复「列表没过滤本地已有仓库」：
   * 只比对最近仓库的目录名不够——Windows 反斜杠路径此前根本没切开（永远不匹配），
   * 而且本地目录名与云端名可以不同。这里扫本机全部 sync-state*.json 的
   * vaultName 字段，开过同步的仓库无论目录名都能识别）。菜单打开时拉一次。
   */
  const [localSyncedNames, setLocalSyncedNames] = useState<string[]>([]);
  useEffect(() => {
    if (!vaultMenu) return;
    let alive = true;
    localSyncedVaults()
      .then((names) => {
        if (alive) setLocalSyncedNames(names);
      })
      .catch(() => {
        if (alive) setLocalSyncedNames([]);
      });
    return () => {
      alive = false;
    };
  }, [vaultMenu]);

  /** 云端仓库是否已在本机：最近仓库里有同名目录（路径先归一成正斜杠再切），或
   * 本机同步状态里出现过同名 vaultName。 */
  const localVaultForCloud = useCallback(
    (name: string) =>
      vaultRecents.find(
        (p) =>
          (
            p
              .replace(/\\/g, "/")
              .replace(/\/+$/, "")
              .split("/")
              .pop() ?? ""
          ).toLowerCase() === name.toLowerCase(),
      ),
    [vaultRecents],
  );
  const cloudIsLocal = useCallback(
    (name: string) =>
      !!localVaultForCloud(name) ||
      localSyncedNames.some((n) => n.toLowerCase() === name.toLowerCase()),
    [localVaultForCloud, localSyncedNames],
  );

  /** 云端仓库里**未在本机**的那些（0.32.2 用户需求：列表过滤掉本地已有的——
   * 已在本机的走上面的「最近仓库」组打开，不在这里重复出现）。 */
  const cloudNotLocal = useMemo(
    () => (cloudVaults.list ?? []).filter((item) => !cloudIsLocal(item.name)),
    [cloudVaults.list, cloudIsLocal],
  );

  /** 落地流程：已在本机 → 直接打开；否则引导选位置 → 空目录校验 → 开同步拉全量。 */
  const openCloudVault = useCallback(
    async (name: string) => {
      const local = localVaultForCloud(name);
      if (local) {
        setStatus(`「${name}」已在本机，直接打开`);
        await openRecentVault(local);
        return;
      }
      try {
        const picked = await pickDirectory(`选择「${name}」的落地位置（将在其中创建同名空目录）`);
        if (!picked) return;
        const base = picked.replace(/[\/\\]+$/, "");
        const sameName =
          (base.split(/[\\/]/).pop() ?? "").toLowerCase() === name.toLowerCase();
        const landing = sameName ? base : `${base}/${name}`;
        // 0.34.2 用户反馈「莫名其妙重复添加了这些文件，还把软件搞卡死了」：
        // 落地位置选到已有仓库内部（或就是它、或它的祖先）时，全量拉取会把
        // 一整套文件嵌进现有仓库——监听风暴+同名文件成山+界面卡死。落地点必须
        // 与一切已知仓库无父子关系。
        const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
        const landingNorm = norm(landing);
        const known = [...new Set([vault, ...vaultRecents])].filter(Boolean) as string[];
        for (const item of known) {
          const itemNorm = norm(item);
          if (
            landingNorm === itemNorm ||
            landingNorm.startsWith(`${itemNorm}/`) ||
            itemNorm.startsWith(`${landingNorm}/`)
          ) {
            setError(
              `落地位置「${landing}」与已有仓库「${item}」重叠——选一个跟现有仓库无关的空目录`,
            );
            return;
          }
        }
        const entries = await ensureDirectory(landing);
        if (entries > 0) {
          setError(`落地目录不是空的（${landing}，已有 ${entries} 项）——换个空位置，避免把本地内容混进云端仓库`);
          return;
        }
        setVaultMenu(null);
        setStatus(`正在落地云端仓库「${name}」：${landing}`);
        // 不走 enableVaultSync：它带移动端仓库门的副作用（会弹 MobileVaultGate 盖住
        // 桌面界面）。落地 = 切到空仓库 + pendingEnableVault——等 useSync 对新仓库
        // 加载完自动「开启同步 + 立即同步一轮」，首轮把云端内容全量拉下来。
        await switchVault(landing);
        setPendingEnableVault(landing);
      } catch (e) {
        setError(`落地云端仓库失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [localVaultForCloud, openRecentVault, switchVault],
  );

  // ------------------------------------------------------------------ 数据目录

  const [vaultHome, setVaultHome] = useState<string | null>(null);

  // 设置面板要展示数据目录；启动时查一次，改动后由回调就地更新。
  useEffect(() => {
    appDataPaths()
      .then(setDataPaths)
      .catch(() => {
        // 查不到就显示"…"，不影响其他功能
      });
    // 移动端同时取仓库基础目录（存储分区展示；桌面端该命令虽存在但语义不同，
    // 这里统一查询、桌面返回 null 不展示）
    vaultHomeGet()
      .then(setVaultHome)
      .catch(() => {});
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

  // —— 右栏状态创建与保存通道（从分栏区前移：openNote 的右栏分支要直接引用，
  //    声明必须早于它；其余分栏逻辑仍在「分栏」区） ——
  /**
   * 为右栏文件建 EditorState。回调与主编辑器**同一套**（handleDocChanged 等
   * 都按 view 路由，见其注释）——stateStore 里的同一份状态在两栏之间流转时
   * 行为一致；差别只有资源上下文（notePath = 右栏文件）。
   */
  const createSplitState = useCallback(
    (note: NoteContent) => {
      const ctx: LivePreviewContext = { ...resourcesRef.current, notePath: note.path };
      splitCtxRef.current = ctx;
      return createEditorState(note.content, {
        lineEnding: note.lineEnding,
        mode: isMarkdownPath(note.path) ? effectiveViewMode(modeRef.current) : "source",
        language: editorLanguageOf(note.path),
        onDocChanged: handleDocChanged,
        onSave: handleEditorSave,
        resources: ctx,
        attachment: attachmentOptions,
        codePaste: codePasteOptions,
        dark: resolveTheme(getSettings().theme) === "dark",
        onCursorInTable: handleCursorInTable,
        onCursorLine: handleCursorLine,
      });
    },
    [mode, handleDocChanged, handleEditorSave, handleCursorInTable, handleCursorLine, attachmentOptions, codePasteOptions],
  );

  const splitSaveRef = useRef<() => Promise<void>>(async () => {});
  const splitSaveNow = useCallback(async () => {
    const view = splitViewRef.current;
    const path = splitActiveRef.current;
    if (!view || !vault || !path) return;
    const meta = openTabsRef.current.find((tab) => tab.path === path);
    try {
      const result = await writeNote(vault, path, view.state.sliceDoc(), meta?.hasBom ?? false);
      setOpenTabs((prev) =>
        prev.map((tab) =>
          tab.path === path ? { ...tab, sha256: result.sha256, size: result.bytes } : tab,
        ),
      );
      dirtyTabs.current.delete(path);
      setSplitDirty(false);
      staleTabs.current.delete(path);
      // 右栏里编辑 DDL 笔记，悬浮库跟着更新（与主编辑器保存同一条规则）
      if (path === (getSettings().ddlFilePath.trim() || "数据库表DDL.md")) {
        void loadDdlLibrary(vault);
      }
      setStatus(result.changed ? `分屏已保存 ${result.bytes} 字节` : "分屏内容未变，未落盘");
    } catch (e) {
      setError(String(e));
    }
  }, [vault, loadDdlLibrary]);
  useEffect(() => {
    splitSaveRef.current = () => splitSaveNow();
  }, [splitSaveNow]);

  // 右栏自动保存：与主编辑器同一防抖节奏
  useEffect(() => {
    if (!splitDirty) return;
    const timer = window.setTimeout(() => void splitSaveNow(), AUTOSAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [splitDirty, revision, splitSaveNow]);

  const openNote = useCallback(
    async (path: string) => {
      if (!vault) return;
      // 打开任何笔记都收起预览窗格（预览与编辑互斥，对齐 Obsidian 的点击语义）；
      // 收件箱面板同理——它盖住编辑区（display:none），不收起的话用户在左侧树里
      // 点笔记毫无反应，看起来像"点不动、要手动关面板"（0.20 用户反馈）。
      setPreviewPath(null);
      setCaptureManagerOpen(false);
      // 0.32.2 分栏路由：标签唯一归属一栏——右栏的标签在右栏激活，左栏的在左栏
      // 激活；还没有标签的新文件落在**最后聚焦的窗格**（Obsidian 语义）。
      const isRight = rightTabsRef.current.includes(path);
      const targetSide: "main" | "split" = isRight
        ? "split"
        : focusedPaneRef.current === "split" && rightTabsRef.current.length > 0
          ? "split"
          : "main";
      // 已是这一栏的激活标签且没有外部改动：什么都不做（重置会丢光标位置）
      if (targetSide === "main" && path === activeTabRef.current && !staleTabs.current.has(path)) return;
      if (targetSide === "split" && path === splitActiveRef.current && !staleTabs.current.has(path)) return;
      // 切笔记时收起文件内搜索面板（0.23 用户反馈：搜索框只属于它打开的那篇，
      // 挂到别的笔记上会带着上一次的高亮，看起来像"搜索框坏了"）
      closeSearchPanelIfOpen();
      // 0.34.6 用户反馈「DDL 弹窗在切换页面或者切换笔记后要自动隐藏」：body 层的
      // 单元格悬浮卡/脱管编辑浮层不会跟着旧笔记消失，切页时一并收掉
      closeDdlTip();
      recordRecent(path);
      // 要切走的那一栏先落盘（0.32.2：两栏各有独立的脏状态与保存通道）
      if (targetSide === "main") {
        if (dirtyRef.current) await saveNow();
      } else if (splitDirtyRef.current) {
        await splitSaveRef.current();
      }
      // 离开当前标签前把它的滚动位置留下（readNote 分支不走 activateTab 的捕获）：
      // 会话内存量 + 持久化阅读位置各记一份（0.31）。右栏的滚动由右栏装载
      // effect 在换激活时捕获，这里只管左栏。
      if (targetSide === "main") {
        const leaving = viewOwnerRef.current;
        if (leaving && leaving !== path && viewRef.current) {
          const leavingTop = viewRef.current.scrollDOM.scrollTop;
          scrollStore.current.set(leaving, leavingTop);
          saveProgress(window.localStorage, vault, leaving, leavingTop);
        }
      }
      /** 在目标栏激活（存量状态直接换上，未保存内容与撤销历史都在）。 */
      const activateInSide = () => {
        if (targetSide === "split") setSplitActiveTab(path);
        else activateTab(path);
      };
      // 存量状态且文件没被外部改过：直接换上去
      if (stateStore.current.has(path) && !staleTabs.current.has(path)) {
        activateInSide();
        setRoundTrip(null);
        return;
      }
      try {
        const note = await readNote(vault, path);
        const stored = stateStore.current.get(path);
        if (stored) {
          // 标签已存在但后台文件被外部改过：与标签里的内容对账。
          // 一致 → 只更新 meta（保住光标）；不一致且没改过 → 采纳磁盘；改过 → 起冲突
          const local = stored.sliceDoc();
          const dirtyTab = dirtyTabs.current.has(path);
          if (local !== note.content && dirtyTab) {
            staleTabs.current.delete(path);
            setOpenTabs((prev) =>
              prev.map((tab) => (tab.path === path ? note : tab)),
            );
            if (targetSide === "split") {
              // 右栏不走左栏的冲突横幅（横幅的采纳通道固定作用于左栏）：标脏提示，
              // 下次保存以本窗口为准（与右栏外部改动的兜底口径一致）
              setSplitActiveTab(path);
              setStatus("分屏文件被外部修改，保存时以本窗口内容为准");
            } else {
              activateTab(path);
              setConflict(note);
            }
            return;
          }
          if (local === note.content) {
            staleTabs.current.delete(path);
            setOpenTabs((prev) =>
              prev.map((tab) => (tab.path === path ? note : tab)),
            );
            activateInSide();
            return;
          }
          staleTabs.current.delete(path);
        }
        // 「替换当前」模式（Obsidian 默认）：新笔记顶掉**目标栏**激活标签的位置，
        // 标签数不增长；被顶掉的标签存量状态一并清掉，否则下次打开还会复活。
        // 已打开过的笔记在前面就走激活了，两种模式一致。
        const sideActive = targetSide === "split" ? splitActiveRef.current : activeTabRef.current;
        const replaceCurrent =
          getSettings().openNoteMode === "replace" &&
          sideActive !== null &&
          sideActive !== path;
        const previousPath = sideActive;
        if (replaceCurrent && previousPath) {
          stateStore.current.delete(previousPath);
          scrollStore.current.delete(previousPath);
          dirtyTabs.current.delete(previousPath);
          staleTabs.current.delete(previousPath);
        }
        if (targetSide === "split") {
          // 右栏新开：状态进 stateStore + 挂进右栏标签，视图装载交给右栏 effect
          //（它读 stateStore 装内容并对齐模式/主题/滚动，创建即激活）
          const newState = createSplitState(note);
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
          const rightBase = rightTabsRef.current;
          const nextRight = rightBase.includes(note.path)
            ? rightBase
            : replaceCurrent && previousPath && rightBase.includes(previousPath)
              ? rightBase.map((p) => (p === previousPath ? note.path : p))
              : [...rightBase, note.path];
          rightTabsRef.current = nextRight;
          setRightTabPaths(nextRight);
          splitActiveRef.current = note.path;
          setSplitActiveTab(note.path);
          tabActivatedAt.current.set(note.path, Date.now());
          setSplitDirty(false);
          setRoundTrip(null);
          setError(null);
          return;
        }
        resourcesRef.current.notePath = note.path;
        const newState = createEditorState(note.content, {
          lineEnding: note.lineEnding,
          mode: isMarkdownPath(note.path) ? effectiveViewMode(modeRef.current) : "source",
          language: editorLanguageOf(note.path),
          onDocChanged: handleDocChanged,
          onSave: handleEditorSave,
          resources: resourcesRef.current,
          attachment: attachmentOptions,
          codePaste: codePasteOptions,
          dark: resolveTheme(getSettings().theme) === "dark",
          onCursorInTable: handleCursorInTable,
          onCursorLine: handleCursorLine,
        });
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
        tabActivatedAt.current.set(note.path, Date.now());
        // 恢复上次的阅读位置（0.31）：会话内存量优先，没有再回持久化值。
        // 新文档 setState 后高度图还是上一篇的实测值，scrollTop 可能被
        // 当时的最大滚动范围钳掉——等两帧真实测量落地后再校一次（同 openNoteAt）。
        const resumeTop =
          scrollStore.current.get(note.path) ??
          loadProgress(window.localStorage, vault, note.path) ??
          0;
        const viewNow = viewRef.current;
        if (viewNow) {
          viewNow.scrollDOM.scrollTop = resumeTop;
          if (resumeTop > 0) {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                if (viewRef.current === viewNow && viewOwnerRef.current === note.path) {
                  viewRef.current.scrollDOM.scrollTop = resumeTop;
                }
              }),
            );
          }
        }
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
    [vault, saveNow, handleDocChanged, mode, activateTab, createSplitState],
  );

  /**
   * 文件树的打开入口（按类型路由）：预览类（pdf/docx/xlsx）开预览窗格，
   * markdown 与数据文件（json/sql/yaml 等）进编辑器。
   */
  const openEntry = useCallback(
    async (path: string) => {
      const kind = fileKindOf(path);
      if (kind === "pdf" || kind === "docx" || kind === "ppt" || kind === "spreadsheet" || kind === "html" || kind === "image") {
        // 预览与收件箱面板互斥：面板开着时点附件，把面板收起来让预览可见
        setCaptureManagerOpen(false);
        // 切到预览页同样收起文件内搜索面板（0.23 用户反馈：换页面不残留）
        closeSearchPanelIfOpen();
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

  /**
   * 新建的目标目录：树里选中的文件夹 > 当前打开笔记所在目录 > 仓库根。
   * 选中项是文件时不算数（点开笔记也会顺手选中它），此时落到当前笔记所在目录。
   */
  const createTargetFolder = useCallback(() => {
    const sel = selectedPathRef.current;
    if (sel && entries.some((entry) => entry.path === sel && entry.isDir)) return sel;
    const path = currentRef.current?.path;
    if (!path || !path.includes("/")) return "";
    return path.slice(0, path.lastIndexOf("/"));
  }, [entries]);

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
    // 0.33.0 停点3：移动端输入行在文件抽屉顶部——抽屉收着时点「新建笔记/
    // 今日日记」毫无可见反馈（真机实测）。顺手展开抽屉让输入行进入视野。
    if (isMobile()) {
      setLeftCollapsed(false);
      // 0.34.6 用户反馈「跳转到左抽屉页面时，功能选择没有自动变化到文件」：
      // 抽屉记着上次停留的分区/页签（单词本/日历/收藏…）时，新建输入行虽然
      // 在顶部，脚下却不是文件树——把分区卡和页签都带回文件列表
      setDrawerView("files");
      setLeftView("files");
    }
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

  // 0.34.1 用户反馈「新建笔记/日记/文件时输入框会一直存在，需要手动关闭」：
  // 移动端输入行打开期间，点击输入行以外的任何元素（文件行/分区卡/按钮/遮罩）
  // 自动取消——捕获阶段监听，同一击的 click 照常执行（点文件行 = 关输入 + 开
  // 笔记一次完成）。桌面保持原样：Esc / ✕ 手动关。
  useEffect(() => {
    if (!isMobile()) return;
    const inputting = creating !== null || (renaming !== null && renameOwner === "tree");
    if (!inputting) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".create-row")) return;
      if (renaming !== null) cancelRename();
      else cancelCreate();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [creating, renaming, renameOwner, cancelCreate, cancelRename]);

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
      // 0.33.0 停点3：与新建笔记一致——打开后收抽屉
      if (isMobile()) setLeftCollapsed(true);
      return;
    }
    try {
      if (creating === "note") {
        const path = await createNote(vault, createFolderOverride || createTargetFolder(), name);
        cancelCreate();
        // 新建即写入「# 文件名」一级标题（与重命名共用同步设置；同名测序号
        // 会改文件名，所以标题取返回路径的基名，不能用输入原文），并可自动
        // 打上「待整理」标签——标签仪表盘里集中整理，写笔记时不用想分类。
        const title = (path.split("/").pop() ?? "").replace(/\.md$/i, "");
        const cfg = getSettings();
        let content = cfg.syncRenameHeading && title ? `# ${title}\n` : "";
        const autoTag = cfg.autoTagNewNote ? normalizeTagName(cfg.autoTagName) : null;
        if (autoTag) {
          content = `${content}${content ? "\n" : ""}#${autoTag}\n`;
        }
        if (content) {
          try {
            await writeNote(vault, path, content, false);
          } catch (e) {
            setError(String(e));
          }
        }
        await refresh(vault);
        // 新建后直接打开，省掉再去树里找一次
        await openNote(path);
        // 0.33.0 停点3：移动端创建走的抽屉，打开笔记后收掉，别让文件树挡正文
        if (isMobile()) setLeftCollapsed(true);
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

  /** 复制条目路径（绝对 = 仓库目录 + 相对路径，Windows 风格分隔符）。 */
  const copyEntryPaths = useCallback(
    async (path: string, kind: "absolute" | "relative") => {
      const value =
        kind === "relative"
          ? path
          : vault
            ? `${vault.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`
            : path;
      try {
        await navigator.clipboard.writeText(value);
        setStatus(kind === "absolute" ? `已复制绝对路径：${value}` : `已复制相对路径：${value}`);
      } catch {
        setError("复制失败：剪贴板不可用");
      }
    },
    [vault],
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
      // 右栏的标签被改名：归属、激活键与上下文跟着换（标签唯一，重命名只在
      // 它所在的那一栏生效）
      const rightNow = rightTabsRef.current;
      if (rightNow.some((p) => affected(p))) {
        const nextRight = rightNow.map((p) => (affected(p) ? remap(p) : p));
        rightTabsRef.current = nextRight;
        setRightTabPaths(nextRight);
        const splitNow = splitActiveRef.current;
        if (splitNow && affected(splitNow)) {
          const nextSplit = remap(splitNow);
          splitActiveRef.current = nextSplit;
          setSplitActiveTab(nextSplit);
          if (splitCtxRef.current) splitCtxRef.current.notePath = nextSplit;
        }
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
        tabActivatedAt.current.delete(tab.path);
        // 文件已删，阅读位置一并清掉（关标签不清——重开还要恢复，0.31）
        deleteProgress(window.localStorage, vault, tab.path);
      }
      if (affected.length > 0) {
        const affectedSet = new Set(affected.map((tab) => tab.path));
        const remaining = openTabsRef.current.filter((tab) => !affectedSet.has(tab.path));
        // 函数式过滤：deleteEntry/searchVault 的 await 窗口里 openNote 可能已把
        // 新标签 append 进列表，非函数式写回会用陈旧快照覆盖（同 closeTab）
        setOpenTabs((prev) => prev.filter((tab) => !affectedSet.has(tab.path)));
        if (affected.some((tab) => tab.path === activeTabRef.current)) {
          const index = openTabsRef.current.findIndex((tab) => tab.path === activeTabRef.current);
          const neighbor =
            remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.path ?? null;
          setConflict(null);
          if (neighbor && stateStore.current.has(neighbor)) {
            activateTab(neighbor);
          } else {
            setActiveTab(null);
            setDirty(false);
            setInTable(false);
            resourcesRef.current.notePath = null;
            viewRef.current?.setState(emptyEditorState());
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
      if (view && current) applyMode(view, effectiveViewMode(next));
      // 右栏视图同一套模式（0.32 双编辑器；右栏仅桌面，包装无副作用）
      const splitView = splitViewRef.current;
      if (splitView && splitActiveRef.current) applyMode(splitView, effectiveViewMode(next));
    },
    [current],
  );

  // ---------------- 移动端阅读/编辑分离（0.33.0 批C） ----------------

  /** 顶栏「编辑」：解禁输入 + 聚焦弹键盘（工具栏由 body.m-editing 显示）。 */
  const enterMobileEdit = useCallback(() => {
    setMobileEdit(true);
    setMobileZen(false);
    const view = viewRef.current;
    if (view) {
      applyEditable(view, true);
      view.focus();
    }
  }, []);

  /** 工具栏「✓ 完成」：收键盘 + 回阅读态（保持沉浸与否由用户接下来点哪决定）。 */
  const exitMobileEdit = useCallback(() => {
    const view = viewRef.current;
    const path = viewOwnerRef.current;
    if (view) {
      view.contentDOM.blur();
      applyEditable(view, false);
      // 回写缓存：编辑态期间的 dispatch/自动保存会把 editable=true 的状态存进
      // stateStore，完成后若不回写，「再点同一篇笔记」的重装载（activateTab 是
      // 命令式 setState，activeTab 不变、重配 effect 不跑）会把可编辑态带回来
      if (path) stateStore.current.set(path, view.state);
    }
    setMobileEdit(false);
  }, []);

  // body 类：m-editing（工具栏显隐）/ m-zen（上下栏滑出）
  useEffect(() => {
    if (!isMobile()) return;
    document.body.classList.toggle("m-editing", mobileEdit);
    document.body.classList.toggle("m-zen", mobileZen);
  }, [mobileEdit, mobileZen]);

  // 打开/切换笔记 = 回阅读态、栏可见（阅读是移动端的默认姿态）
  useEffect(() => {
    if (!isMobile()) return;
    setMobileEdit(false);
    setMobileZen(false);
  }, [activeTab]);

  // 0.34.1 用户反馈「没有打开任何文件还是能够进入编辑态」：关掉最后一篇后
  // m-editing 残留会让空状态挂着 Markdown 工具栏——没笔记时编辑/沉浸一律回位
  useEffect(() => {
    if (!isMobile()) return;
    if (current) return;
    setMobileEdit(false);
    setMobileZen(false);
  }, [current]);

  // 可编辑性集中重配：装载（view.setState 先于 React setState 执行）与
  // mobileEdit 切换都经这里——stateStore 缓存的状态 editable 初值恒 true，
  // 阅读态下换装任何存量状态后都要重新压成 false。
  // 0.33.1：阅读态还要把视图模式压成 live（effectiveViewMode）——mode=source
  // 持久时阅读态显示源码正是「切编辑也没用」的另一半；编辑态恢复用户选择。
  useEffect(() => {
    if (!isMobile()) return;
    const view = viewRef.current;
    if (!view) return;
    applyEditable(view, mobileEditRef.current);
    applyMode(view, effectiveViewMode(modeRef.current));
    requestDecorationRefresh(view);
  }, [mobileEdit, activeTab, mode, effectiveViewMode]);

  // 编辑器字号缩放（仅移动端消费；桌面 --qn-edit-scale 恒缺省 1）
  useEffect(() => {
    if (!isMobile()) return;
    document.documentElement.style.setProperty(
      "--qn-edit-scale",
      String(settings.mobileFontScale || 1),
    );
  }, [settings.mobileFontScale]);

  // 沉浸进出伴随容器高度变化：过渡结束后补一次测量，防高度图陈旧导致
  // 行号/点击整体漂移（CM6 异步变高必须 requestMeasure 的铁律）
  useEffect(() => {
    if (!mobileZen) return;
    const timer = window.setTimeout(() => viewRef.current?.requestMeasure(), 320);
    return () => window.clearTimeout(timer);
  }, [mobileZen]);

  const changeRightPanel = useCallback((next: "daily" | "outline" | "stats" | "vocab") => {
    setRightPanel(next);
    localStorage.setItem(SIDEBAR_KEY, next);
  }, []);

  // ---------------------------------------------------------------- 0.34.0 移动端壳层助手

  /** 移动端浮层互斥：任何药丸/sheet 打开前先把其他浮层与对侧抽屉收掉
      （0.33 起的约定——抽屉与浮层并存时浮层被压住，全屏叠全屏不该存在）。 */
  const mobileOverlayGone = useCallback(() => {
    setShowSettings(false);
    setPaletteOpen(false);
    setQuickCaptureOpen(false);
    setMobileMenuOpen(false);
    setNoteMenuOpen(false);
    setTabSheetOpen(false);
    setVaultSheetOpen(false);
    setRightCollapsed(true);
  }, []);

  /** 抽屉底部仓库名点开 radio sheet：清单现拉一次（过滤掉被移除隐藏的仓库）。 */
  const openVaultSheet = useCallback(() => {
    setVaultSheetOpen(true);
    listVaults()
      .then((list) => {
        let hidden: string[] = [];
        try {
          hidden = JSON.parse(localStorage.getItem("quicknote.vaults.hidden") ?? "[]") as string[];
        } catch {
          // 解析不了就当没隐藏过
        }
        const hiddenSet = new Set(hidden);
        setVaultSheetList(list.filter((v) => !hiddenSet.has(v.path)));
      })
      .catch((e: unknown) => setError(`读取仓库列表失败：${e}`));
  }, []);

  /** Rust list_vaults 返回原生反斜杠路径，vault 状态恒正斜杠——比对/判同前归一
      （否则 radio sheet 的当前仓库高亮与「点了当前仓库」判断永远不中）。 */
  const normVaultPath = useCallback((p: string) => p.replace(/\\/g, "/").replace(/[\\/]+$/, ""), []);

  // 移动端右抽屉只留 大纲/统计（日历/单词本搬去左抽屉分区，0.34.0）：持久化的
  // 旧页签落在被搬走的分区上时纠正一次，避免右抽屉打开是空白
  useEffect(() => {
    if (!isMobile()) return;
    setRightPanel((prev) => (prev === "daily" || prev === "vocab" ? "outline" : prev));
  }, []);

  /**
   * 打开笔记并跳到指定行（全局搜索的「内容」结果用）；行号省略时只打开。
   * 带关键词时（0.21 用户反馈：定位后突出不明显）打开自定义搜索面板预填——
   * 全文命中高亮 + 计数 + Enter 下一处，并把该行上的命中词设为选区。
   *
   * 0.23：滚动居中；命中落在表格里时光标放到块外——光标留在块内会把整张表
   * 打成源码（用户反馈"定位到表格时不要显示源码"），表格保持渲染态。
   */
  const openNoteAt = useCallback(
    async (path: string, line?: number, term?: string) => {
      await openNote(path);
      if (line === undefined) return;
      // 0.32.2 分栏：openNote 会把文件落到它归属/聚焦的那一栏——定位操作跟着
      // 落位视图走（右栏的文件在右栏选区滚动），别默认左栏
      const isRightNow = rightTabsRef.current.includes(path);
      const view = isRightNow ? splitViewRef.current : viewRef.current;
      if (!view) return;
      const target = view.state.doc.line(
        Math.min(Math.max(line + 1, 1), view.state.doc.lines),
      );
      if (!term) {
        jumpToLine(line);
        return;
      }
      openSearchPanelOn(view, term);
      let scrollPos = target.from;
      const block = toggleableBlockAt(view.state, target.from);
      if (block && target.from >= block.from && target.from <= block.to) {
        // 命中在表格/图表块里：与行号点击的「切渲染」同一招，光标挪出块
        const outside = block.from > 0 ? block.from - 1 : Math.min(block.to + 1, view.state.doc.length);
        view.dispatch({
          selection: { anchor: outside },
          effects: EditorView.scrollIntoView(block.from, { y: "center" }),
        });
        scrollPos = block.from;
      } else {
        const at = target.text.toLowerCase().indexOf(term.toLowerCase());
        const anchor = at >= 0 ? target.from + at : target.from;
        const head = at >= 0 ? anchor + term.length : anchor;
        view.dispatch({
          selection: { anchor, head },
          effects: EditorView.scrollIntoView(anchor, { y: "center" }),
        });
      }
      view.focus();
      // 首次打开的笔记在 setState 后行高图还带着上一篇的实测值（文档前缀近似
      // 被误沿用），上面的滚动按错误高度算 scrollTop，目标会停在视口外（0.30
      // 批测：切到未打开的笔记欠滚 ~460px）。等两帧让真实测量落地，再按同一
      // 目标校一次；期间用户切走了就不动。
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if ((isRightNow ? splitViewRef.current : viewRef.current) === view) {
            view.dispatch({ effects: EditorView.scrollIntoView(scrollPos, { y: "center" }) });
          }
        }),
      );
    },
    [openNote, jumpToLine],
  );

  /** 最新一轮渲染的 openNoteAt：跨仓库打开在切完仓库后必须用新仓库的实例。 */
  const openNoteAtRef = useRef(openNoteAt);
  useEffect(() => {
    openNoteAtRef.current = openNoteAt;
  });

  /** 底栏 ‹ ›（0.34.0）：沿导航历史回退/前进。index 已在点击时指到目标，
      activeTab 压栈 effect 比对栈顶相等不会重复入栈。 */
  const historyBack = useCallback(() => {
    const hist = navHistoryRef.current;
    if (hist.index <= 0) return;
    const target = hist.stack[hist.index - 1];
    setNavHistory({ stack: hist.stack, index: hist.index - 1 });
    void openNote(target).catch(() => setStatus("历史里的笔记已打不开"));
  }, [openNote]);

  const historyForward = useCallback(() => {
    const hist = navHistoryRef.current;
    if (hist.index >= hist.stack.length - 1) return;
    const target = hist.stack[hist.index + 1];
    setNavHistory({ stack: hist.stack, index: hist.index + 1 });
    void openNote(target).catch(() => setStatus("历史里的笔记已打不开"));
  }, [openNote]);

  // ---------------------------------------------------------------- 分栏（0.32.2 Obsidian 式）
  //
  // 右栏 = 第二个完整编辑器 + 自己的标签栏；状态进同一个 stateStore（按路径键）。
  // 标签唯一（一个标签只属于一栏），openTabs 仍是全部标签的唯一清单，
  // rightTabPaths 记右栏归属——「分屏」就是把标签移到另一栏（移过去它就归那栏
  // 的编辑器管），不存在同文件双开。

  /**
   * 把标签移到另一栏（标签右键「分屏到右侧 / 移回左侧」）。守卫：移走后原栏
   * 至少留一个标签（左栏空了主编辑区就没有可显示的标签，右栏空了右栏收起）。
   * 移走的若是原栏的激活标签，原栏激活切到相邻标签；新栏激活切到它。
   */
  const moveTabAcross = useCallback(
    (path: string) => {
      const rightNow = rightTabsRef.current;
      if (rightNow.includes(path)) {
        // 右 → 左：右栏少一个标签；右栏空了就收起（closeRightPane 的标签语义）。
        // ref 立即同步：同帧内的后续判定（openNote/菜单守卫）不能再拿旧归属
        const remaining = rightNow.filter((p) => p !== path);
        rightTabsRef.current = remaining;
        setRightTabPaths(remaining);
        if (splitActiveRef.current === path) {
          if (remaining.length === 0) setSplitActiveTab(null);
          else {
            // 右栏内的相邻标签：按右栏自己的顺序取后一个，没有则最后一个
            const index = rightNow.indexOf(path);
            setSplitActiveTab(remaining[Math.min(index, remaining.length - 1)]);
          }
        }
        return;
      }
      // 左 → 右：左栏至少留一个标签
      const leftCount = openTabsRef.current.filter((tab) => !rightNow.includes(tab.path)).length;
      if (leftCount <= 1) {
        setStatus("左栏只剩这一个标签了，先再开一个才能把它移去分屏");
        return;
      }
      const nextRight = [...rightNow, path];
      rightTabsRef.current = nextRight;
      setRightTabPaths(nextRight);
      setSplitActiveTab(path);
      // 移走的若正是左栏激活：左栏激活切到相邻的左栏标签（顺序同 closeTab 的取法）
      if (activeTabRef.current === path) {
        const leftTabs = orderedOpenTabs.filter(
          (tab) => tab.path !== path && !rightNow.includes(tab.path),
        );
        if (leftTabs.length > 0) activateTab(leftTabs[0].path);
      }
    },
    [activateTab, orderedOpenTabs],
  );

  /**
   * 收起右栏（右栏标签栏的 ✕ / Esc）：右栏的标签**全部移回左栏**（不关标签、
   * 不丢内容），右栏激活的脏内容先落盘。
   */
  const closeRightPane = useCallback(() => {
    const view = splitViewRef.current;
    const path = splitActiveRef.current;
    if (view && path) {
      scrollStore.current.set(path, view.scrollDOM.scrollTop);
      if (splitDirtyRef.current) void splitSaveRef.current();
    }
    // 搜索面板可能挂在右栏视图上：视图即将销毁，先正常关面板（清高亮、清
    // panelView），不留悬空引用
    closeSearchPanelIfOpen();
    rightTabsRef.current = [];
    setRightTabPaths([]);
    splitActiveRef.current = null;
    setSplitActiveTab(null);
    setOutlineFollow("editor");
  }, []);


  /** 右栏激活标签离开时留下的滚动位置（load effect 换内容前捕获）。 */
  const splitPrevActiveRef = useRef<string | null>(null);

  /**
   * 给右栏视图装内容：stateStore 存量优先（未保存内容/光标/撤销历史都在），
   * 否则读盘新建（失败重试 3 次——同步/杀毒瞬时占用文件时窗口很短，一次失败
   * 就放弃会让右栏停在空白，0.32.2 修「分屏内容为空」）。
   *
   * 依赖里的 splitViewEpoch：视图创建（SplitPane 挂载）晚于激活变化时靠它重触发，
   * 不再出现「激活了右栏标签但视图还没建、effect 白跑一次、右栏永远空白」。
   */
  useEffect(() => {
    const view = splitViewRef.current;
    if (!view || !vault || !splitActiveTab) return;
    // 换右栏激活标签前，把上一个标签的滚动位置留下（此刻视图还是旧内容）
    const prevActive = splitPrevActiveRef.current;
    if (prevActive && prevActive !== splitActiveTab) {
      scrollStore.current.set(prevActive, view.scrollDOM.scrollTop);
    }
    splitPrevActiveRef.current = splitActiveTab;
    splitCtxRef.current = { ...resourcesRef.current, notePath: splitActiveTab };
    setSplitError(null);
    let alive = true;
    const align = () => {
      applyMode(view, effectiveViewMode(modeRef.current));
      applyDarkTheme(view, resolveTheme(getSettings().theme) === "dark");
      view.scrollDOM.scrollTop =
        scrollStore.current.get(splitActiveTab) ??
        (vault ? loadProgress(window.localStorage, vault, splitActiveTab) ?? 0 : 0);
      // 新文档 setState 后高度图还是旧的，两帧真实测量落地后再校一次（同 openNote）
      const top = view.scrollDOM.scrollTop;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (splitViewRef.current === view) view.scrollDOM.scrollTop = top;
      }));
      setSplitDirty(dirtyTabs.current.has(splitActiveTab));
      setSplitCursorLine(view.state.doc.lineAt(view.state.selection.main.head).number - 1);
    };
    const stored = stateStore.current.get(splitActiveTab);
    // 空 doc 的存量视为无效（真实空文件从盘上读也是空，结果一致）——防脏数据
    // 把右栏卡成空白
    if (stored && stored.doc.length > 0 && !staleTabs.current.has(splitActiveTab)) {
      view.setState(stored);
      // 存量状态可能是在左栏创建的：上下文按**当前视图**重配（回调本身按 view
      // 路由，只需换上下文）
      applyLivePreviewContext(view, splitCtxRef.current!);
      align();
      return;
    }
    const load = (attempt: number) => {
      readNote(vault, splitActiveTab)
        .then((note) => {
          if (!alive || splitViewRef.current !== view || splitActiveRef.current !== splitActiveTab) return;
          staleTabs.current.delete(splitActiveTab);
          const state = createSplitState(note);
          stateStore.current.set(splitActiveTab, state);
          view.setState(state);
          align();
          // 目录跟随右栏：文档源换了要重算
          setRevision((value) => value + 1);
        })
        .catch((e) => {
          if (!alive) return;
          if (attempt < 3) {
            window.setTimeout(() => {
              if (alive) load(attempt + 1);
            }, 200);
            return;
          }
          // 右栏内显式报错（0.32.2：不再静默空白）
          setSplitError(`打开失败（重试 3 次）：${e instanceof Error ? e.message : String(e)}`);
        });
    };
    load(0);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitActiveTab, vault, splitViewEpoch]);

  /**
   * 打开**其他仓库**的笔记（0.29 全局搜索跨仓库命中）：先切仓库，再在新仓库的
   * 上下文里打开并定位。openNote 捕获的是本轮渲染的 vault——切仓库后直接调用
   * 拿到的还是旧仓库的闭包，所以要等状态提交后经 ref 调最新一轮的 openNoteAt
   * （与启动时的 openEntryRef 同一模式）。
   */
  const openNoteInVault = useCallback(
    async (target: string, path: string, line?: number, term?: string) => {
      if (target === vault) {
        await openNoteAt(path, line, term);
        return;
      }
      await switchVault(target);
      // 等 React 提交到 vaultRef（switchVault await 返回后渲染可能还在下一帧），
      // 再打开定位。此前固定 120ms：首开大仓库渲染慢，openNoteAtRef 捕获的还是
      // 旧仓库的 openNote 闭包 → 笔记开不出来也定位不了，表现为「搜索别的仓库
      // 只会定位到标题」（0.34.2 用户反馈）。
      const deadline = Date.now() + 4000;
      while (vaultRef.current !== target && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await openNoteAtRef.current(path, line, term);
    },
    [vault, openNoteAt, switchVault],
  );

  /** 全局搜索的仓库范围（0.29）：当前仓库 + 最近仓库，当前仓库恒排第一。 */
  const paletteVaults = useMemo(
    () =>
      (vault ? [vault, ...vaultRecents.filter((item) => item !== vault)] : vaultRecents).slice(0, 9),
    [vault, vaultRecents],
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
        // 目标可能带 `#标题` / `^块`（Obsidian 笔记引用）——定位只关心文件本身
        const { path } = splitEmbedTarget(target);
        const relative = resolveWikiRelative(resourcesRef.current, path);
        if (!relative) {
          setError(`定位失败：在仓库里找不到「${path}」`);
          return;
        }
        await revealInExplorer(relative);
      },
    };
  }, [vault, notice, revealInExplorer]);

  // ---------------------------------------------------------------- wiki 引用点击跟随
  // Obsidian 式：单击引用文字打开目标笔记（带 #标题/^块 时打开后跳转）。
  // 委托挂在 **document 捕获阶段**：编辑器 widget 内的 mousedown 走 CM 内部事件流，
  // 时机不可控（实测 domEventHandlers 收不到 HtmlWidget 内的合成点击）；捕获阶段
  // 最先执行，preventDefault 后 CM 不会放置光标，行装饰保持渲染态。
  const openWikiTarget = useCallback(    (target: string) => {
      const { path: notePath, section } = splitEmbedTarget(target);
      const relative = resolveWikiRelative(resourcesRef.current, notePath);
      if (!relative) {
        setError(`找不到笔记「${notePath}」`);
        return;
      }
      void openEntryRef.current(relative).then(() => {
        if (!section) return;
        // 内容就位后跳到标题/块：按标题文本（忽略大小写）或块尾标记搜索
        window.setTimeout(() => {
          const view = viewRef.current;
          if (!view) return;
          const doc = view.state.doc;
          const wanted = section.replace(/^\^/, "").toLowerCase();
          for (let n = 1; n <= doc.lines; n += 1) {
            const line = doc.line(n);
            const hit = section.startsWith("^")
              ? line.text.trimEnd().toLowerCase().endsWith(`^${wanted}`)
              : new RegExp(`^#{1,6}\\s+${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(
                  line.text.trim(),
                );
            if (hit) {
              view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
              return;
            }
          }
          setStatus(`没在笔记里找到「${section}」，已打开整篇`);
        }, 500);
      });
    },
    [],
  );

  /**
   * 跟随 Markdown 内部链接（0.23 用户反馈：`[文字](文件)` 的语法支持）。
   * 属性里是装饰时解析好的仓库相对路径（相对来源笔记），这里只管打开：
   * `.md` 进应用内编辑器（带小节跳转）；其他文件交给系统默认程序；
   * `#锚点` 在当前笔记内跳标题。
   */
  const openMdLinkTarget = useCallback(
    (raw: string) => {
      const target = raw.trim();
      if (!target) return;
      if (target.startsWith("#")) {
        // 页内锚点：在当前笔记里找标题跳过去
        const view = viewRef.current;
        if (!view) return;
        const wanted = target.slice(1).toLowerCase();
        const doc = view.state.doc;
        for (let n = 1; n <= doc.lines; n += 1) {
          const line = doc.line(n);
          if (
            new RegExp(`^#{1,6}\\s+${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(
              line.text.trim(),
            )
          ) {
            view.dispatch({
              selection: { anchor: line.from },
              effects: EditorView.scrollIntoView(line.from, { y: "center" }),
            });
            return;
          }
        }
        setStatus(`没在笔记里找到「${target.slice(1)}」`);
        return;
      }
      const { path: noteTarget, section } = splitEmbedTarget(target);
      if (!/\.md$/i.test(noteTarget)) {
        // 非笔记文件（图片/pdf/任何附件）：系统默认程序打开
        if (!vaultRef.current) {
          setError("尚未打开仓库，无法打开链接的文件");
          return;
        }
        const absolute = absoluteInVault(vaultRef.current, noteTarget);
        import("@tauri-apps/plugin-opener")
          .then(({ openPath }) => openPath(absolute))
          .then(() => setStatus(`已用系统程序打开：${noteTarget}`))
          .catch((e) => setError(`打开文件失败：${e}`));
        return;
      }
      void openEntryRef.current(noteTarget).then(() => {
        if (!section) return;
        window.setTimeout(() => {
          const view = viewRef.current;
          if (!view) return;
          const doc = view.state.doc;
          const wanted = section.replace(/^\^/, "").toLowerCase();
          for (let n = 1; n <= doc.lines; n += 1) {
            const line = doc.line(n);
            const hit = section.startsWith("^")
              ? line.text.trimEnd().toLowerCase().endsWith(`^${wanted}`)
              : new RegExp(`^#{1,6}\\s+${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(
                  line.text.trim(),
                );
            if (hit) {
              view.dispatch({
                selection: { anchor: line.from },
                effects: EditorView.scrollIntoView(line.from, { y: "center" }),
              });
              return;
            }
          }
          setStatus(`没在笔记里找到「${section}」，已打开整篇`);
        }, 500);
      });
    },
    [],
  );
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const link = (event.target as HTMLElement | null)?.closest?.(
        "[data-wiki-target],[data-md-link]",
      );
      if (!link) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const isMd = link.hasAttribute("data-md-link");
      const onUp = (up: MouseEvent) => {
        window.removeEventListener("mouseup", onUp);
        // 位移明显是拖选文字，不跟随
        if (Math.hypot(up.clientX - startX, up.clientY - startY) > 5) return;
        if (isMd) openMdLinkTarget(link.getAttribute("data-md-link") ?? "");
        else openWikiTarget(link.getAttribute("data-wiki-target") ?? "");
      };
      window.addEventListener("mouseup", onUp);
      event.preventDefault();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [openWikiTarget, openMdLinkTarget]);

  // ---------------------------------------------------------------- 文件复制粘贴

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
        // 有 DOM 文字选区（docx/PDF 文字层、HTML 预览等）→ 让原生复制走：
        // 焦点在预览里时 activeElement 是 body，不放假行会把选中文字复制成文件路径
        const domSelection = window.getSelection();
        if (domSelection && domSelection.toString().trim() !== "") return;
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

  // ---------------------------------------------------------------- 全局截图

  /** 抓屏并打开截图浮层（OS 全局快捷键与命令面板共用；0.20 用户需求）。
   *  0.23：全屏冻结浮层取代小弹窗；热键触发时窗口多半在后台，抓完先把窗口
   *  带到前台，冻结画面才立即可见。 */
  const runScreenshot = useCallback(async () => {
    if (isMobile()) return;
    try {
      const shot = await screenshotCapture();
      setScreenshotImage(shot.imageBase64);
      setScreenshotOpen(true);
      void getCurrentWindow()
        .setFocus()
        .catch(() => {
          // 聚焦失败（部分窗口管理器拒绝转移前台）不影响浮层本身
        });
      setStatus("");
    } catch (e) {
      setError(`截屏失败：${e}`);
    }
  }, []);

  // 全局截图快捷键：启动注册、设置里改了立即重注册（空串 = 关闭）。
  // 命令只在桌面存在；移动端不调用。被其他程序占用时提示去设置里换组合。
  // 多窗口让位（Rust 侧对自家兄弟进程静默跳过）后注册不在此进程：让位时置
  // "未持有"标志——兄弟窗口关闭后这里窗口一聚焦就重试一次，把热键接回来
  // （0.23 修复：此前让位也算"成功"，兄弟一关热键就成了孤儿，没人响应）。
  const hotkeyFailedRef = useRef(false);
  useEffect(() => {
    if (isMobile()) return;
    const hotkey = getSettings().screenshotHotkey;
    setScreenshotHotkey(hotkey).then(
      (registered) => {
        hotkeyFailedRef.current = !registered;
      },
      (e) => {
        hotkeyFailedRef.current = true;
        setError(`注册截图快捷键失败：${e}。可在 设置 → 通用 里换一个组合。`);
      },
    );
  }, [settings.screenshotHotkey]);

  // 拥有热键的兄弟窗口关闭后，本窗口重新聚焦时尝试接管
  useEffect(() => {
    if (isMobile()) return;
    const onFocus = () => {
      if (!hotkeyFailedRef.current) return;
      setScreenshotHotkey(getSettings().screenshotHotkey).then(
        (registered) => {
          hotkeyFailedRef.current = !registered;
        },
        () => {
          // 还是占着（兄弟窗口还活着）：不弹错误，保持静默让位
        },
      );
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // 快捷键按下 → 抓屏 → 弹窗
  useEffect(() => {
    if (isMobile()) return;
    let unlisten: (() => void) | null = null;
    void onScreenshotHotkey(() => void runScreenshot()).then((off) => {
      unlisten = off as () => void;
    });
    return () => {
      unlisten?.();
    };
  }, [runScreenshot]);

  /** 截图存为当前仓库附件（截图弹窗的落库通道；目录随粘贴附件配置）。 */
  const saveScreenshotAttachment = useCallback(
    async (name: string, base64: string): Promise<string | null> => {
      if (!vault) return null;
      return writeAttachment(vault, dailyRef.current.settings.pastedImageFolder, name, base64);
    },
    [vault],
  );

  /**
   * 添加单词后自动补全在线释义（0.30 用户反馈"添加单词时自动搜索在线释义"）：
   * 收词/手动弹窗都只落词本身，保持"记完继续干活"的手感；查询在后台跑，查到
   * 就把释义与音标回填进词条。失败不写任何东西——详情卡里的「查询在线释义」
   * 仍可兜底。补全是读-改-写，接连添加的词串到同一条 promise 链上，写不交叠。
   */
  const autoFillVocabMeaning = useCallback((word: string) => {
    vocabFillChain.current = vocabFillChain.current.then(async () => {
      try {
        const result = await vocabLookup(word);
        if (!result.meaning && !result.phonetic) return;
        const content = await loadVocabularyContent(vaultRef.current);
        const next = updateVocabEntry(content, word, {
          meaning: result.meaning,
          phonetic: result.phonetic,
        }).content;
        if (next === content) return; // 词条已被删掉或手动改过，不强行写回
        await saveVocabularyContent(next);
        setVocabVersion((value) => value + 1);
        notice(`已自动补全「${word}」在线释义`);
      } catch (e) {
        notice(`「${word}」在线释义查询失败：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }, [notice]);

  /**
   * 单词本（0.23 用户反馈，交互对齐 IDEA 的「保存到词典」）：把选中的词（或
   * 光标所在词）记进账户级单词本（所有仓库共用）。重复词不重录；右侧「单词」页签翻看。
   * 0.30 起落盘后自动在线补全释义（后台查询，不挡收词）。
   */
  const addWordToVocabulary = useCallback(async () => {
    const view = viewRef.current;
    if (!view) {
      notice("请先打开一篇笔记再记单词", "error");
      return;
    }
    // 取词统一走 captureWordTerm：正文按 CM 选区，表格单元格按 DOM 选区
    let word = captureWordTerm(view).trim();
    if (!word || /\s/.test(word)) {
      notice("选中一个词（或把光标放在词上），再加入单词本", "error");
      return;
    }
    // 词统一转小写（0.26 用户反馈）：收词是"记词汇"不是"记原文"，Scenario 与
    // scenario 只留一条；去重本来就是大小写不敏感的，这里统一落盘形态
    word = word.toLowerCase();
    try {
      // 0.28：单词本是账户级（应用配置目录，所有仓库共用），不再依赖当前仓库
      const content = await loadVocabularyContent(vaultRef.current);
      const source = currentRef.current?.path ?? "";
      const from = source ? source.slice(source.lastIndexOf("/") + 1).replace(/\.md$/i, "") : "";
      const result = addVocabEntry(content, word, `${dailyRef.current.today} · ${from || "手动添加"}`);
      if (!result.added) {
        notice(`单词本里已有「${word}」`);
        return;
      }
      await saveVocabularyContent(result.content);
      // 「单词」面板只靠编辑器文档变更刷新，收词不走编辑器——这里显式 bump
      setVocabVersion((value) => value + 1);
      void autoFillVocabMeaning(word);
      notice(`已加入单词本：${word}，正在查询在线释义…`);
    } catch (e) {
      notice(`加入单词本失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [notice, autoFillVocabMeaning]);

  /**
   * 速记归档后的同步联动（0.24 用户反馈）：归档写到的仓库里开着自动同步的，
   * 立即各跑一轮——当前仓库走常驻引擎的完整轮（冲突由既有横幅接手），其他
   * 仓库走 per-vault 临时轮（跨仓库归档此前要等"下次打开它"才同步），临时轮
   * 撞出的冲突直接提醒用户打开仓库裁决。仓库开关是异步判定的（可能要读
   * per-vault 状态文件），整个联动挂到后台跑，不阻塞归档本身。
   */
  const handleArchiveSync = useCallback(
    (involved: string[]) => {
      const sync = syncRef.current;
      if (!sync) return;
      void (async () => {
        for (const target of [...new Set(involved)].filter(Boolean)) {
          let enabled = false;
          try {
            enabled = await sync.enabledForVault(target);
          } catch {
            enabled = false;
          }
          if (!enabled) continue;
          if (vault && target === vault) {
            sync.syncNow();
            continue;
          }
          const name = target.replace(/^.*[\\/]/, "");
          await sync
            .syncVaultOnce(target, (paths) => {
              setError(`同步「${name}」发现 ${paths.length} 个冲突文件：请打开该仓库手动处理`);
            })
            .then(
              () => setStatus(`已自动同步仓库：${name}`),
              (e) => setError(`归档后同步「${name}」失败：${e}`),
            );
        }
      })();
    },
    [vault],
  );

  /** 光标跳到当前笔记的最后一行并滚到可视区（长笔记不用滚轮翻到底）。 */
  const gotoDocEnd = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    view.focus();
    // 长笔记滚动后，上方刚进视口的装饰件（表格/代码块 widget）会比源码行高，
    // 内容整体下移、结尾停在视口外——两帧后装饰量完再校一次（与 openNoteAt
    // 的首开欠滚同一根因，0.30 批测「Ctrl+End 末行可见」偶发失败抓出）。
    // 校正只带滚动 effect，不动选区（这两帧里用户可能已经开始输入）。
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (viewRef.current === view) {
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.doc.length, { y: "end" }),
          });
        }
      }),
    );
  }, []);

  /**
   * 打开命令面板。0.34.2 用户反馈「已经选中内容然后再打开全局搜索能够自动
   * 搜索选中内容」：编辑器里有选中文本时把第一个非空行（≤80 字）作为种子词
   * 带给面板。所有打开入口（快捷键/顶栏搜索框/移动端药丸/抽屉全文搜索/
   * ☰ 菜单）都走 shortcuts.palette 或本函数。
   */
  const paletteSeedRef = useRef("");
  const openPalette = useCallback(() => {
    const view = viewRef.current;
    let seed = "";
    if (view) {
      const { from, to } = view.state.selection.main;
      if (from !== to) {
        const firstLine = view.state.sliceDoc(from, to).split(/\r?\n/)[0].trim();
        seed = firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine;
      }
    }
    paletteSeedRef.current = seed;
    setPaletteOpen((value) => !value);
  }, []);

  /** 快捷键动作表。命令面板按同一份文案生成动作项，这里集中定义避免两处漂移。 */
  const shortcuts = useMemo(
    () => ({
      palette: () => openPalette(),
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
      gotoEnd: gotoDocEnd,
      quickCapture: () => setQuickCaptureOpen(true),
      recentFiles: () => setRecentFilesOpen((value) => !value),
      quickTodo: () => {
        if (!vault) {
          notice("打开仓库后才能记待办", "error");
          return;
        }
        setQuickTodoOpen(true);
      },
      captureManager: () => setCaptureManagerOpen((value) => !value),
      toggleTags: () => {
        if (!currentRef.current || !isMarkdownPath(currentRef.current.path)) {
          notice("请先打开一篇笔记再打标签", "error");
          return;
        }
        setTagPopoverOpen((value) => !value);
      },
      addWord: () => void addWordToVocabulary(),
      addWordDialog: () => {
        // 弹窗预填当前选词（与收词同一取词口径：表格单元格里的选区也算）
        const view = viewRef.current;
        setAddWordDialog(view ? captureWordTerm(view).trim() : "");
      },
      ddlCapture: () => {
        if (!vault) {
          notice("打开仓库后才能收录建表语句", "error");
          return;
        }
        setDdlDialogOpen(true);
      },
    }),
    // 这些回调内部要么读 ref、要么函数式 setState，身份变化不会造成额外开销
    [beginCreate, changeMode, openVault, insertAtCursor, gotoDocEnd, daily.today, notice, addWordToVocabulary, vault, openPalette],
  );

  /** 编辑器内命令的统一分发：命令面板搜到的快捷键命令（标题/列表/行内代码等）从这里走。 */
  const runEditorCommand = useCallback(
    (id: string) => {
      const view = viewRef.current;
      if (!view) return;
      // 选区标题归一：0.20 起改为弹窗选级别（不再每级一条命令）
      if (id === "clampHeading") {
        setHeadingDialogOpen(true);
        return;
      }
      const headingMatch = /^heading([1-6])$/.exec(id);
      if (headingMatch) {
        toggleHeading(view, Number(headingMatch[1]));
        return;
      }
      if (id === "formatJson") {
        // 0.34.6 用户反馈「创建一个脚本用来格式化 json」：排查接口数据时贴的
        // 压缩 JSON 一键展开。只认选区——无选区/非法 JSON 都明说
        const sel = view.state.selection.main;
        if (sel.empty) {
          notice("先选中要格式化的 JSON 文本", "error");
          return;
        }
        const raw = view.state.sliceDoc(sel.from, sel.to);
        const result = formatJsonText(raw);
        if (!result.ok) {
          notice(`不是合法 JSON：${result.error}`, "error");
          return;
        }
        if (result.text !== raw) {
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: result.text },
            selection: { anchor: sel.from },
          });
        }
        notice("已格式化 JSON（2 空格缩进）");
        return;
      }
      switch (id) {
        case "toggleInlineCode":
          toggleInlineCode(view);
          return;
        case "toggleCodeBlock":
          toggleCodeBlock(view);
          return;
        case "toggleBold":
          toggleBold(view);
          return;
        case "copyCode": {
          const hit = codeAtCursor(view.state);
          if (!hit) {
            notice("光标不在行内代码或代码块里", "error");
            return;
          }
          void navigator.clipboard.writeText(hit.text).then(
            () =>
              notice(
                hit.kind === "block"
                  ? `已复制代码块（${hit.text.split("\n").length} 行）`
                  : "已复制行内代码",
              ),
            () => notice("复制失败：剪贴板不可用", "error"),
          );
          return;
        }
        case "toggleBulletList":
          toggleBulletList(view);
          return;
        case "toggleNumberList":
          toggleNumberList(view);
          return;
        case "insertDate":
          insertAtCursor(daily.today);
          return;
        case "insertTime":
          insertAtCursor(moment().format("HH:mm"));
          return;
        case "toggleTags":
          shortcuts.toggleTags();
          return;
        case "addWord":
          shortcuts.addWord();
          return;
        case "addWordDialog":
          shortcuts.addWordDialog();
          return;
        case "ddlCapture":
          shortcuts.ddlCapture();
          return;
      }
    },
    [insertAtCursor, daily.today, shortcuts],
  );

  // 编辑器键位触发的选区标题归一：keymap 在 CM 内部，弹窗由这里（React 侧）打开。
  useEffect(() => {
    const open = () => {
      if (viewRef.current) setHeadingDialogOpen(true);
    };
    window.addEventListener("qn-clamp-heading", open);
    return () => window.removeEventListener("qn-clamp-heading", open);
  }, []);

  // 编辑器内部（editor.ts 键位）发起的轻提示：那里拿不到 React 回调，走事件桥。
  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; kind?: "info" | "error" }>).detail;
      if (detail?.message) notice(detail.message, detail.kind);
    };
    window.addEventListener("qn-notice", onNotice);
    return () => window.removeEventListener("qn-notice", onNotice);
  }, [notice]);

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

  // Ctrl+F 统一收进自定义搜索面板（0.21 用户反馈：焦点不在编辑器时弹出了
  // WebView2 的原生查找栏）。CM 的 Mod-f 键位只在编辑器聚焦时生效；事件漏到
  // 浏览器层，WebView2 的加速键会打开自己的查找条（灰色原生样式）。捕获阶段
  // 先拦掉，再路由：焦点在编辑器 → 交给 CM 自己的键位（有选区预填）；焦点在
  // 其他输入框（弹窗/树过滤）→ 只拦截不抢焦点；其余 → 直接唤起面板。
  // F3 / Ctrl+G 顺带路由为「下一处」（面板开着时），与浏览器查找习惯一致。
  // 设置面板打开时让路（它有自己的 Ctrl+F：聚焦设置搜索框）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey) return;
      const key = event.key.toLowerCase();
      const isFind = (event.ctrlKey || event.metaKey) && !event.shiftKey && key === "f";
      const isNext =
        key === "f3" || ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === "g");
      if (!isFind && !isNext) return;
      // 目标视图按焦点选（0.32 分屏双编辑器）：焦点在分屏窗格里就走分屏视图
      // （文件内搜索面板同一时刻只属于一个视图，openPanel 会自动迁移）。
      const focusInSplit = (() => {
        const splitView = splitViewRef.current;
        return !!splitView && !!splitView.dom.contains(document.activeElement);
      })();
      const view = (focusInSplit ? splitViewRef.current : viewRef.current) ?? viewRef.current;
      if (isNext) {
        // F3/Ctrl+G 跟着已打开的搜索面板走（面板可能在另一个视图上）
        let handled = false;
        if (view) handled = searchPanelFindNext(view);
        if (!handled && view !== viewRef.current && viewRef.current) {
          handled = searchPanelFindNext(viewRef.current);
        }
        if (handled) event.preventDefault();
        return;
      }
      if (showSettings) return;
      // 弹层类 UI（命令面板/速记管理）盖在编辑区上：编辑器可能被隐藏，
      // 面板无处挂载——只拦掉原生查找，不抢焦点
      if (paletteOpen || captureManagerOpen) {
        event.preventDefault();
        return;
      }
      const target = event.target as HTMLElement | null;
      const nestedHost = target?.closest<HTMLElement>(NESTED_EDITABLE) ?? null;
      if (nestedHost && nestedHost !== view?.contentDOM) {
        // 嵌套编辑宿主（渲染表格的单元格等就地编辑区）：焦点不在 CM 的
        // contentDOM 上，CM 的 Mod-f 键位收不到这个事件，拦不掉就会漏给
        // WebView2 的加速键弹出**原生查找条**（0.26 用户反馈截图）。这里就地
        // 接管：把宿主内的 DOM 选区预填进搜索面板（无选区就只开面板）。
        event.preventDefault();
        if (view) openSearchPanelOn(view, domSelectionText() || undefined);
        return;
      }
      if (target?.closest(".cm-content")) return; // 编辑器内：CM 的 Mod-f 键位处理
      event.preventDefault();
      if (!view) return;
      const active = document.activeElement as HTMLElement | null;
      const inOtherInput =
        active &&
        active !== document.body &&
        !active.closest(".cm-content") &&
        active.matches("input, textarea, select, [contenteditable]");
      if (!inOtherInput) openSearchPanelOn(view);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showSettings, paletteOpen, captureManagerOpen]);

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
      if (captureManagerOpen) {
        setCaptureManagerOpen(false);
        return;
      }
      if (addWordDialog !== null) {
        setAddWordDialog(null);
        return;
      }
      if (ddlDialogOpen) {
        setDdlDialogOpen(false);
        return;
      }
      if (rightTabPaths.length > 0) {
        closeRightPane();
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
  }, [renaming, creating, menu, vaultMenu, tabMenu, captureManagerOpen, addWordDialog, ddlDialogOpen, rightTabPaths, cancelRename, cancelCreate, closeRightPane]);

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
      { id: "goto-end", title: "跳到笔记末尾", hint: keyHint("gotoEnd"), icon: "⏬", run: shortcuts.gotoEnd },
      { id: "quick-capture", title: "快速笔记（收件箱）", hint: keyHint("quickCapture"), icon: "📥", run: shortcuts.quickCapture },
      { id: "quick-todo", title: "快速添加待办…", hint: keyHint("quickTodo"), icon: "✅", run: shortcuts.quickTodo },
      { id: "ddl-capture", title: "收录建表语句…", hint: keyHint("ddlCapture"), icon: "🗄️", run: shortcuts.ddlCapture },
      { id: "recent-files", title: "最近文件…", hint: keyHint("recentFiles"), icon: "🕘", run: shortcuts.recentFiles },
      { id: "capture-manager", title: "速记管理（收件箱整理）", hint: keyHint("captureManager"), icon: "🗂️", run: shortcuts.captureManager },
      { id: "mode", title: mode === "live" ? "切换到源码模式" : "切换到实时预览", hint: keyHint("toggleMode"), icon: "🔀", run: shortcuts.toggleMode },
      { id: "left", title: leftCollapsed ? "展开文件栏" : "收起文件栏", hint: keyHint("toggleLeft"), icon: "◧", run: shortcuts.toggleLeft },
      { id: "right", title: rightCollapsed ? "展开右侧面板" : "收起右侧面板", hint: keyHint("toggleRight"), icon: "◨", run: shortcuts.toggleRight },
      { id: "zen", title: zen ? "退出专注模式" : "专注模式（隐藏侧栏）", hint: keyHint("zen"), icon: "🎯", run: shortcuts.zen },
      { id: "review-week", title: "生成本周回顾（插入光标处）", icon: "🗓️", run: () => void insertWeeklyReview(moment().startOf("isoWeek").format("YYYY-MM-DD"), true) },
      { id: "review-pick", title: "生成选定周的回顾…", icon: "🗓️", run: () => setWeekDialogOpen(true) },
      { id: "screenshot", title: "截图并识别文字（OCR）", icon: "📷", run: () => void runScreenshot() },
      { id: "sync", title: "立即同步", icon: "☁️", run: shortcuts.syncNow },
      { id: "vault", title: "打开其他仓库…", icon: "📂", run: shortcuts.openVaultPicker },
      { id: "settings", title: "打开设置", hint: keyHint("openSettings"), icon: "⚙️", run: shortcuts.openSettings },
      { id: "export-pdf", title: "导出 PDF（打印对话框，选「另存为 PDF」）", icon: "🖨️", run: () => void exportPdf() },
      { id: "export-pdf-file", title: "导出 PDF 文件（选定位置，直接落盘）", icon: "📄", run: () => void exportPdfFile() },
      { id: "format-json", title: "格式化选中的 JSON", keywords: ["json", "格式化", "format"], icon: "{}", run: () => runEditorCommand("formatJson") },
      { id: "roundtrip", title: "校验字节往返（写后读比对）", icon: "🧪", run: () => void verifyRoundTrip() },
      // 快捷键设置里的其余命令也进面板：Ctrl+K 应能搜到「设置 → 快捷键」里的
      // 每个功能（标题/列表/行内代码、插入日期时间等编辑器内命令为主）。
      // 上面已显式列出的与面板自身不再重复生成。
      ...(() => {
        const covered = new Set([
          "newNote", "newDiary", "newFolder", "save", "gotoEnd", "quickCapture",
          "captureManager", "toggleMode", "toggleLeft", "toggleRight", "zen",
          "syncNow", "openVaultPicker", "openSettings", "palette",
          "recentFiles", "quickTodo",
        ]);
        const icons: Record<string, string> = {
          heading1: "#", heading2: "#", heading3: "#", heading4: "#", heading5: "#", heading6: "#",
          clampHeading: "⇕",
          toggleInlineCode: "</>", toggleCodeBlock: "{}",
          toggleBulletList: "•", toggleNumberList: "1.",
          insertDate: "📅", insertTime: "🕐", toggleTags: "🏷️",
        };
        return COMMAND_KEYS.filter((cmd) => !covered.has(cmd.id)).map((cmd) => ({
          id: `cmd-${cmd.id}`,
          title: cmd.label,
          keywords: [cmd.desc ?? "", cmd.id],
          detail: cmd.desc,
          hint: keyHint(cmd.id),
          icon: icons[cmd.id] ?? "⌨️",
          run: () => runEditorCommand(cmd.id),
        }));
      })(),
    ],
    [shortcuts, mode, leftCollapsed, rightCollapsed, zen, verifyRoundTrip, insertWeeklyReview, keyHint, exportPdf, exportPdfFile, vault, runEditorCommand, runScreenshot],
  );

  /** 速记管理的仓库候选：当前仓库 + 最近仓库 + 已配置的收件仓库（去重）。 */
  const captureVaultOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    const push = (value: string | null) => {
      if (!value) return;
      const clean = value.replace(/[\\/]+$/, "");
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      options.push({ value: clean, label: vaultDisplayName(clean) });
    };
    push(vault);
    for (const dir of vaultRecents) push(dir);
    push(settings.quickCaptureVault);
    return options;
  }, [vault, vaultRecents, settings]);

  // 0.34.0 移动端左抽屉分区化后，桌面侧栏与移动抽屉共用同一批内容组件——
  // Props 只写一份，两个分支各取所需。
  const renderTree = (view: "files" | "favorites" | "recents") => (
    <FileTree
      entries={entries}
      activePath={current?.path ?? null}
      filter={treeFilter}
      view={view}
      favorites={visibleFavorites}
      pinnedFavorites={pinnedFavorites}
      recents={recents}
      hiddenDirs={hiddenDirs}
      selectedPath={selectedPath}
      reveal={treeReveal}
      onSelectPath={setSelectedPath}
      onOpen={(p) => void openEntry(p)}
      onContext={openContextMenu}
      onReveal={(p) => void revealInExplorer(p)}
      onMoveEntry={(p, dest) => void moveTreeEntry(p, dest)}
      onCopyEntry={(p, dest) => void copyTreeTo(p, dest)}
    />
  );
  const tagDashboardEl = (
    <TagDashboard
      loading={tagIndex.loading}
      tags={sortedTagIndex.tags}
      noteTags={tagIndex.noteTags}
      activeTag={tagDashTag}
      pinnedTags={pinnedTagNames}
      onTogglePin={toggleTagPin}
      onRename={(from, to) => void renameTag(from, to)}
      onPickTag={setTagDashTag}
      onBack={() => setTagDashTag(null)}
      activePath={current?.path ?? null}
      onOpen={(p) => void openEntry(p)}
      onRemoveTag={(p, tag) => void removeTagFromNote(p, tag)}
    />
  );
  const vocabPanelEl = (
    <VocabularyPanel
      vault={vault}
      revision={revision}
      version={vocabVersion}
      notice={notice}
      backConsumerRef={vocabBackRef}
    />
  );
  const calendarPanelEl = (
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
  );
  // 移动端文件分区顶部的小页签（知识库/收藏/最近；标签升级成了独立分区）。
  // 桌面持久化的 leftView 停在被搬走的「tags」上时归位到知识库。
  const mobileLeftView = leftView === "tags" ? "files" : leftView;
  // 抽屉底行的文件夹计数（Obsidian 图3：仓库名下挂「N 个文件, N 个文件夹」）
  const dirCount = useMemo(() => entries.filter((e) => e.isDir).length, [entries]);
  // 移动端抽屉分区清单（Obsidian 图3 底部卡）：文件列表/搜索/标签/单词本/日历
  const drawerSections = [
    { key: "files" as const, label: "文件列表", icon: <IconFolder size={17} /> },
    { key: "search" as const, label: "搜索", icon: <IconSearch size={17} /> },
    { key: "tags" as const, label: "标签", icon: <IconTag size={17} /> },
    { key: "vocab" as const, label: "单词本", icon: <IconLibrary size={17} /> },
    { key: "calendar" as const, label: "日历", icon: <IconCalendar size={17} /> },
  ];

  return (
    <div
      className={`app${zen ? " zen" : ""}${captureManagerOpen ? " inbox-open" : ""}${
        /* 0.34.0 Obsidian 语义：任一抽屉开着时浮动药丸/底条整体让位（否则叠在
           抽屉页签与仓库底行上面）；CSS 由 .m-drawer-open 收走 */
        isMobile() && (!leftCollapsed || !rightCollapsed) ? " m-drawer-open" : ""
      }`}
    >
      {/* 0.34.0 Obsidian 化：移动端不再有常驻顶栏（顶部浮动药丸替代，见下方
          m-top-pills）。顶栏整个只在桌面渲染——桌面 DOM 与样式零变化 */}
      {!isMobile() && (
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
          {isMobile() ? (
            /* 0.33.1 主页重构：仓库名 pill 换成主页图标——主页承接仓库切换/
               同步状态/远程仓库；打开前先收拢一切浮层（原 pill 直达逻辑） */
            <button
              type="button"
              className="icon-btn vault-home-btn"
              onClick={() => {
                setShowSettings(false);
                setPaletteOpen(false);
                setQuickCaptureOpen(false);
                setLeftCollapsed(true);
                setRightCollapsed(true);
                setVaultGateOpen(true);
              }}
              title="仓库主页：查看同步状态与远程仓库"
            >
              <IconHome size={16} />
            </button>
          ) : (
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
          )}
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
          {isMobile() && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                // 弹层不与抽屉共存：先收抽屉再开命令面板
                setLeftCollapsed(true);
                setRightCollapsed(true);
                shortcuts.palette();
              }}
              title="全局搜索笔记与内容，或执行命令（Ctrl+K）"
            >
              <IconSearch size={16} />
            </button>
          )}
          {isMobile() ? (
            /* 0.33.0 批C：视图模式（live/源码）移动端退场——阅读/编辑分离模型：
               打开即阅读，这里只留「编辑」入口；编辑态固定 live 所见即所得。
               停点2 反馈修正：再点一次=完成（toggle 退出，不再只认工具栏 ✓）；
               没打开笔记时禁用（空编辑器不该弹光标和键盘） */
            <button
              type="button"
              className={`seg mode-toggle${mobileEdit ? " is-on" : ""}`}
              onClick={() => (mobileEdit ? exitMobileEdit() : enterMobileEdit())}
              disabled={!current}
              title={mobileEdit ? "完成编辑" : "编辑这篇笔记"}
              aria-pressed={mobileEdit}
            >
              {mobileEdit ? <IconCheck size={16} /> : <IconPenLine size={16} />}
            </button>
          ) : (
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
          )}
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
            onClick={() => {
              // 弹层不与抽屉共存（移动端）：先收抽屉再开设置
              if (isMobile()) {
                setLeftCollapsed(true);
                setRightCollapsed(true);
              }
              shortcuts.openSettings();
            }}
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
              onClick={() => {
                // 直接 destroy（0.32.1「无法关闭软件」修复）：close() 要绕一圈
                // close-requested 事件 → JS 处理器 → destroy 的链路，链上任何
                // 异常都会把窗口卡在「点 ✕ 没反应」。destroy 跳过事件链必关；
                // 关闭回写 VAULT_KEY 在这里同步补一份。
                persistVaultKey();
                void appWindow.destroy();
              }}
            >
              <IconX size={14} />
            </button>
          </div>
        </div>
      </header>
      )}

      {/* 0.34.0 Obsidian 化移动壳层：顶部两颗药丸（左=抽屉，右=编辑toggle+⋮）+
          底部工具条（‹ › 搜索 ＋ [标签数] ☰）。沉浸/编辑态由 body.m-zen /
          body.m-editing 类在 CSS 里收走，这里无条件渲染。所有键开合前先跑
          mobileOverlayGone 互斥（浮层不与抽屉/彼此共存）。 */}
      {isMobile() && (
        <>
          <div className="m-top-pills">
            <button
              type="button"
              className={`m-pill${leftCollapsed ? "" : " is-on"}`}
              onClick={() => {
                mobileOverlayGone();
                setLeftCollapsed(!leftCollapsed);
              }}
              title="文件抽屉"
              aria-pressed={!leftCollapsed}
            >
              <IconPanelLeft size={18} />
            </button>
            <div className="m-pill-group">
              <button
                type="button"
                className="m-pill"
                onClick={() => (mobileEdit ? exitMobileEdit() : enterMobileEdit())}
                disabled={!current}
                title={mobileEdit ? "完成编辑" : "编辑这篇笔记"}
                aria-pressed={mobileEdit}
              >
                {mobileEdit ? <IconCheck size={17} /> : <IconPenLine size={17} />}
              </button>
              <button
                type="button"
                className={`m-pill${noteMenuOpen ? " is-on" : ""}`}
                onClick={() => {
                  mobileOverlayGone();
                  setNoteMenuOpen(true);
                }}
                disabled={!current}
                title="当前笔记操作"
              >
                <IconDots size={17} />
              </button>
            </div>
          </div>
          <div className="m-bottom-bar">
            <button
              type="button"
              className="m-pill"
              onClick={historyBack}
              disabled={navHistory.index <= 0}
              title="后退"
            >
              <IconArrowLeft size={17} />
            </button>
            <button
              type="button"
              className="m-pill"
              onClick={historyForward}
              disabled={navHistory.index >= navHistory.stack.length - 1}
              title="前进"
            >
              <IconArrowRight size={17} />
            </button>
            <button
              type="button"
              className="m-pill"
              onClick={() => {
                mobileOverlayGone();
                openPalette();
              }}
              title="快速切换与全文搜索"
            >
              <IconSearch size={17} />
            </button>
            <button
              type="button"
              className="m-pill"
              onClick={() => {
                mobileOverlayGone();
                setDrawerView("files");
                beginCreate("note");
              }}
              title="新建笔记"
            >
              <IconPlus size={17} />
            </button>
            <button
              type="button"
              className={`m-pill m-tabcount${dirty ? " is-dirty" : ""}`}
              onClick={() => {
                mobileOverlayGone();
                setTabSheetOpen(true);
              }}
              title={`标签页（${openTabs.length}）`}
            >
              {openTabs.length}
            </button>
            <button
              type="button"
              className="m-pill"
              onClick={() => {
                mobileOverlayGone();
                setMobileMenuOpen(true);
              }}
              title="更多"
            >
              <IconMenu size={17} />
            </button>
          </div>
        </>
      )}

      {tagPopoverOpen && current && isMarkdownPath(current.path) && (
        <TagPopover
          tags={noteTagList}
          vocabulary={tagVocab}
          onAdd={addNoteTag}
          onRemove={removeNoteTag}
          onClose={() => setTagPopoverOpen(false)}
        />
      )}

      {quickCaptureOpen && (
        <QuickCaptureDialog
          initialDraft={shareDraft}
          initialImages={shareImages}
          target={
            settings.quickCaptureVault
              ? `${settings.quickCaptureFile.trim() || "Inbox.md"} · ${vaultDisplayName(settings.quickCaptureVault)}`
              : ""
          }
          onSubmit={submitQuickCapture}
          tagSuggestions={tagVocab}
          onClose={() => {
            setQuickCaptureOpen(false);
            setShareDraft("");
            setShareImages([]);
          }}
          onOpenSettings={() => {
            setQuickCaptureOpen(false);
            setShowSettings(true);
          }}
        />
      )}

      {/* 最近文件弹窗（0.27：类 IDEA，搜索 + 一级目录筛选） */}
      {recentFilesOpen && (
        <RecentFilesDialog
          recents={recents}
          entries={entries}
          activePath={current?.path ?? null}
          onOpen={(path) => void openEntry(path)}
          onClose={() => setRecentFilesOpen(false)}
        />
      )}

      {/* 快速添加待办（0.27）：走日历面板同一套 addTodo（含前缀日期语法） */}
      {quickTodoOpen && (
        <QuickTodoDialog
          dateFormat={daily.dateFormat}
          today={daily.today}
          onSubmit={(date, text) => {
            daily.addTodo(date, text);
            setStatus(`已记待办（${date}）：${text}`);
          }}
          onClose={() => setQuickTodoOpen(false)}
        />
      )}

      {addWordDialog !== null && (
        <AddWordDialog
          initialWord={addWordDialog}
          onClose={() => setAddWordDialog(null)}
          onSubmit={async (word) => {
            const content = await loadVocabularyContent(vaultRef.current);
            const result = addVocabEntry(content, word, `${dailyRef.current.today} · 手动添加`);
            if (!result.added) return `单词本里已有「${word}」`;
            await saveVocabularyContent(result.content);
            // 收词不走编辑器，显式 bump 让「单词」面板重读
            setVocabVersion((value) => value + 1);
            // 0.30：释义后台自动查询回填，弹窗不等待、可连续录入
            void autoFillVocabMeaning(word);
            return `已加入单词本：${word}，正在查询在线释义…`;
          }}
        />
      )}

      {/* 建表语句收录：合并进仓库内 DDL 笔记并重载悬浮库（默认键 Ctrl+Alt+J） */}
      {ddlDialogOpen && (
        <DdlDialog
          ddlPath={getSettings().ddlFilePath.trim() || "数据库表DDL.md"}
          onClose={() => setDdlDialogOpen(false)}
          onSubmit={async (ddlText) => {
            const message = await saveDdlStatements(ddlText);
            setStatus(message);
            return message;
          }}
        />
      )}

      {vaultChoice && (
        <>
          <div className="menu-backdrop" onClick={() => setVaultChoice(null)} />
          <div className="vault-choice" role="dialog" aria-label="打开仓库">
            <h3>是否在新窗口中打开此仓库？</h3>
            <div className="vault-choice-path" title={vaultChoice.picked}>
              <code>{vaultChoice.picked}</code>
              <button
                type="button"
                className="vault-choice-copy"
                title="复制路径"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(vaultChoice.picked)
                    .then(() => setStatus("已复制仓库路径"), () => setError("复制失败：剪贴板不可用"));
                }}
              >
                <IconCopy size={13} />
              </button>
            </div>
            <ul className="vault-choice-reasons">
              <li>当前窗口打开：将替换已打开的笔记。</li>
              <li>
                新窗口打开：另起一个实例，两边互不影响。<kbd>Enter</kbd>
              </li>
            </ul>
            <div className="vault-choice-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void chooseVaultOpen("newWindow", vaultChoice.remember)}
              >
                在新窗口打开
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void chooseVaultOpen("current", vaultChoice.remember)}
              >
                当前窗口打开
              </button>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-ghost"
                title="取消 (Esc)"
                onClick={() => setVaultChoice(null)}
              >
                取消
              </button>
            </div>
            <label className="vault-choice-remember">
              <input
                type="checkbox"
                checked={vaultChoice.remember}
                onChange={(event) =>
                  setVaultChoice((prev) => (prev ? { ...prev, remember: event.target.checked } : prev))
                }
              />
              记住我的选择，不再询问（可在 设置 → 通用 里改回）
            </label>
          </div>
        </>
      )}

      {/* 0.33.1 主页重构：移动端 = 全屏仓库主页（覆盖层——仓库界面保持挂载，
          「保留现场」：再进同一仓库直达原位）；桌面保持原浮层卡片 */}
      {vaultGateOpen &&
        (isMobile() ? (
          <div className="vault-home-page">
            <MobileVaultGate
              /* 0.33.1 用户反馈：主页不要关闭按钮——点仓库名（含当前仓库）就
                  是返回方式；设置从齿轮进且不销毁主页（关设置回到主页） */
              onOpenSettings={() => setShowSettings(true)}
              onOpen={(p) => {
                // 同一仓库 = 仅返回现场；不同仓库 = 切换后返回
                if (vault && sameVaultPath(p, vault)) {
                  setVaultGateOpen(false);
                  return;
                }
                setVaultGateOpen(false);
                void switchVault(p);
              }}
              onEnableSync={enableVaultSync}
              syncConfigured={Boolean(sync.config.serverUrl)}
              isVaultSyncEnabled={(p) => syncRef.current?.enabledForVault(p) ?? Promise.resolve(false)}
              onConfigureSync={(server, username, password) =>
                sync.updateConfig({ serverUrl: server, username, password })
              }
              onSyncSelected={(paths) => syncSelectedVaults(paths)}
              syncBatchLabel={syncBatchLabel}
              syncFailedPaths={syncFailedPaths}
              onRetrySyncFailed={() => void syncSelectedVaults(syncFailedPaths)}
              listCloudVaults={sync.listCloudVaults}
              appVersion={appVersion}
            />
          </div>
        ) : (
          <div className="mv-overlay" onClick={(e) => { if (e.target === e.currentTarget) setVaultGateOpen(false); }}>
            <div className="mv-overlay-card">
              <MobileVaultGate
                onClose={() => setVaultGateOpen(false)}
                onOpen={(p) => {
                  setVaultGateOpen(false);
                  void switchVault(p);
                }}
                onEnableSync={enableVaultSync}
                syncConfigured={Boolean(sync.config.serverUrl)}
                isVaultSyncEnabled={(p) => syncRef.current?.enabledForVault(p) ?? Promise.resolve(false)}
                onConfigureSync={(server, username, password) =>
                  sync.updateConfig({ serverUrl: server, username, password })
                }
                onSyncSelected={(paths) => syncSelectedVaults(paths)}
                syncBatchLabel={syncBatchLabel}
                syncFailedPaths={syncFailedPaths}
                onRetrySyncFailed={() => void syncSelectedVaults(syncFailedPaths)}
                listCloudVaults={sync.listCloudVaults}
                appVersion={appVersion}
              />
            </div>
          </div>
        ))}

      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        backConsumerRef={settingsBackRef}
        settings={settings}
        applySettings={applySettings}
        /* 0.33.1 用户反馈：主页打开的设置**只显示全局设置**（按仓库的分区与
            区块整体隐藏，不是禁用态），且关设置回到主页——主页开着时以无仓库
            视角渲染 */
        vault={vaultGateOpen ? null : vault}
        globalOnly={vaultGateOpen}
        imagePaths={vaultImages}
        daily={daily}
        sync={sync}
        dataPaths={dataPaths}
        vaultHome={vaultHome}
        onOpenVaultPage={() => {
          setShowSettings(false);
          setVaultGateOpen(true);
        }}
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
        installUpdate={() => (isMobile() ? installUpdateMobile() : void installUpdate())}
        openReleasePage={(url) => void openReleasePage(url)}
        noteCount={noteCount}
        attachmentCount={attachmentCount}
      />

      {/* 发现新版本的弹窗：启动自动检查或手动检查发现可用更新时出现，展示新版本介绍。
          0.34.2 用户反馈：下载中弹窗保留（百分比进度条），✕ 关闭后转入后台继续下载，
          进度经系统通知播报；重复点击由 updatingRef 重入闸挡住。 */}
      {updateCheck.available && !updateCheck.dismissed && updateCheck.state !== "installing" && (
        <>
          <div className="menu-backdrop" onClick={() => setUpdateCheck((prev) => ({ ...prev, dismissed: true }))} />
          <div className="update-dialog" role="alertdialog" aria-label="发现新版本">
            <div className="update-dialog-head">
              <span className="update-dialog-title">{updateCheck.message}</span>
              <button
                type="button"
                className="icon-btn"
                title={updateCheck.state === "downloading" ? "关闭窗口，下载在后台继续" : "稍后再说"}
                onClick={() => setUpdateCheck((prev) => ({ ...prev, dismissed: true }))}
              >
                <IconX size={14} />
              </button>
            </div>
            {updateCheck.notes && <UpdateNotes markdown={updateCheck.notes} />}
            {updateCheck.state === "downloading" ? (
              <div className="update-progress" role="status">
                <div className="update-progress-bar" aria-hidden>
                  <span style={{ width: `${updateCheck.progress ?? 0}%` }} />
                </div>
                <div className="update-progress-row">
                  <span className="update-progress-pct">{updateCheck.progress ?? 0}%</span>
                  <span className="update-progress-hint">可以关闭此窗口，下载在后台继续（完成后应用自动重启）</span>
                </div>
              </div>
            ) : (
              <div className="update-dialog-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => (isMobile() ? installUpdateMobile() : void installUpdate())}
                >
                  {updateCheck.state === "error" ? "重试更新" : isMobile() ? "下载并安装" : "立即更新"}
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
            )}
          </div>
        </>
      )}
      {/* 下载中且弹窗已关（后台模式）：细横幅继续播百分比 */}
      {updateCheck.state === "downloading" && updateCheck.dismissed && (
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
              云同步：{sync.conflicts.length} 个文件本地与云端都有改动，已暂停同步这些文件——请逐个选择保留哪一边。
            </div>
            <ul className="conflict-list">
              {sync.conflicts.map((item) => (
                <li key={item.path} className="conflict-row">
                  <span className="conflict-row-path" title={item.path}>
                    {item.path}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => sync.resolveConflict(item.path, "remote")}
                    title="丢弃本地改动，以云端版本为准"
                  >
                    用云端覆盖
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => sync.resolveConflict(item.path, "local")}
                    title="保留本地改动并上传，覆盖云端版本"
                  >
                    本地覆盖云端
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => sync.dismissConflicts()}>
            稍后处理
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
            {vaultRecents.filter((p) => !(vault && sameVaultPath(p, vault))).length === 0 && (
              <div className="vault-menu-empty">还没有最近打开的仓库</div>
            )}
            {vaultRecents
              .filter((p) => !(vault && sameVaultPath(p, vault)))
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
            {/* 服务器仓库（0.32.2）：云端可同步仓库一键落地/打开 */}
            <div className="vault-menu-sep" />
            <div className="vault-menu-caption">服务器仓库</div>
            {!sync.config.serverUrl || !sync.config.username || !sync.config.password ? (
              <button
                type="button"
                onClick={() => {
                  setVaultMenu(null);
                  setShowSettings(true);
                }}
                title="在设置 → 云同步里配置服务器与账号后，可以在这里直接选择云端仓库"
              >
                <IconCloud size={13} />
                <span className="vault-menu-name">配置云同步后可从服务器选择仓库…</span>
              </button>
            ) : cloudVaults.loading ? (
              <div className="vault-menu-empty">正在获取服务器仓库…</div>
            ) : cloudVaults.error ? (
              <div className="vault-menu-empty" title={cloudVaults.error}>
                获取失败：{cloudVaults.error}
              </div>
            ) : (cloudVaults.list ?? []).length === 0 ? (
              <div className="vault-menu-empty">服务器上还没有仓库</div>
            ) : cloudNotLocal.length === 0 ? (
              <div className="vault-menu-empty">云端的仓库都已在本机</div>
            ) : (
              cloudNotLocal.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  title={`从服务器落地「${item.name}」到本机（选择一个空目录）`}
                  onClick={() => {
                    setVaultMenu(null);
                    void openCloudVault(item.name);
                  }}
                >
                  <IconCloud size={13} />
                  <span className="vault-menu-name">{item.name}</span>
                </button>
              ))
            )}
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
            {!menu.isDir && favorites.includes(menu.path) && (
              <button
                type="button"
                onClick={() => {
                  togglePinFavorite(menu.path);
                  setMenu(null);
                }}
              >
                {pinnedFavorites.includes(menu.path) ? "取消置顶" : "置顶"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void copyEntryPaths(menu.path, "absolute");
                setMenu(null);
              }}
            >
              复制绝对路径
            </button>
            <button
              type="button"
              onClick={() => {
                void copyEntryPaths(menu.path, "relative");
                setMenu(null);
              }}
            >
              复制仓库相对路径
            </button>
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
                  disabled={
                    rightTabPaths.includes(tabMenu.path)
                      ? rightTabPaths.length <= 1
                      : openTabs.filter((tab) => !rightTabPaths.includes(tab.path)).length <= 1
                  }
                  title={
                    (rightTabPaths.includes(tabMenu.path)
                      ? rightTabPaths.length <= 1
                      : openTabs.filter((tab) => !rightTabPaths.includes(tab.path)).length <= 1)
                      ? "原栏至少要留一个标签"
                      : undefined
                  }
                  onClick={() => {
                    // 0.32.2 Obsidian 式分栏：「分屏」= 把标签移到另一栏
                    moveTabAcross(tabMenu.path);
                    setTabMenu(null);
                  }}
                >
                  {rightTabPaths.includes(tabMenu.path) ? "移回左侧" : "分屏到右侧"}
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
        {/* 移动端抽屉遮罩：任一侧栏打开时盖住内容，点击收起（桌面渲染了也被 CSS 隐藏？不——
            只在移动端渲染，桌面 DOM 不出现） */}
        {isMobile() && (!leftCollapsed || !rightCollapsed) && (
          <div
            className="drawer-backdrop"
            onClick={() => {
              setLeftCollapsed(true);
              setRightCollapsed(true);
            }}
          />
        )}
          <aside
            className={`sidebar sidebar-left${creating || (renaming && renameOwner === "tree") ? " m-inputting" : ""}`}
            ref={sidebarLeftRef}
            onClick={(event) => {
              // 移动端：点中笔记/目录行后自动收抽屉（事件委托，不逐行改回调）
              if (!isMobile()) return;
              const target = event.target as HTMLElement;
              if (target.closest(".tree-file")) setLeftCollapsed(true);
            }}
          >
            {isMobile() ? (
              /* 0.34.0 Obsidian 化左抽屉（用户拍板结构）：内容区随分区切换
                 （文件列表/搜索/标签/单词本/日历）+ 动作行（新建笔记/新建文件夹/
                 关闭）+ 底部分区卡 + 仓库名/计数/齿轮。桌面分支见下方 else，
                 DOM 一字不动。 */
              <>
                {(creating || (renaming && renameOwner === "tree")) && (
                  <div className="create-row">
                    <input
                      autoFocus
                      type="text"
                      value={draft}
                      enterKeyHint="send"
                      placeholder={
                        renaming
                          ? "新名称"
                          : creating === "diary"
                            ? "日记名字（今天：" + daily.today + "）"
                            : creating === "folder"
                              ? "文件夹名称"
                              : "笔记名称，可写 子目录/名称"
                      }
                      onChange={(event) => setDraft(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
                        // 0.34.6 用户反馈「点输入法面板的发送键没反应，创建不了」：
                        // 部分输入法派发的 Enter 带不走 event.key（或动作键被页面
                        // 多输入框改写成「下一步」）——补 keyCode 13 判定；组词中
                        // 确认候选的 Enter（isComposing）不提交
                        if ((event.key === "Enter" || event.keyCode === 13) && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void (renaming ? submitRename() : submitCreate());
                        }
                        if (event.key === "Escape") (renaming ? cancelRename : cancelCreate)();
                      }}
                      onBlur={() => {
                        // 0.34.6 用户反馈「点下一步光标进入下一个输入框，原先的
                        // 新建输入框不会消失」：移动端焦点离开输入行=放弃本次
                        // 新建，收起输入行（桌面仍走 Esc/✕/Enter，不动）
                        if (isMobile()) (renaming ? cancelRename : cancelCreate)();
                      }}
                    />
                    <button
                      type="button"
                      className="icon-btn create-cancel"
                      title="取消"
                      aria-label="取消"
                      onClick={() => (renaming ? cancelRename() : cancelCreate())}
                    >
                      <IconX size={13} />
                    </button>
                    <div className="create-hint">
                      {renaming
                        ? `重命名 ${renaming.slice(renaming.lastIndexOf("/") + 1)} · Enter 确认 / Esc 取消`
                        : creating === "diary"
                          ? `新建到 ${daily.settings.folder || "仓库根目录"} · 文件名 = 日期 + 空格 + 名字 · Enter 确认 / Esc 取消`
                          : `新建到 ${createFolderOverride || createTargetFolder() || "仓库根目录"} · Enter 确认 / Esc 取消`}
                    </div>
                  </div>
                )}
                <div className="m-drawer-content">
                  {drawerView === "files" && (
                    <>
                      <div className="left-view" role="tablist" aria-label="文件视图">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mobileLeftView === "files"}
                          className={`left-view-tab${mobileLeftView === "files" ? " is-on" : ""}`}
                          onClick={() => setLeftView("files")}
                        >
                          <IconLibrary size={13} />
                          知识库
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mobileLeftView === "favorites"}
                          className={`left-view-tab${mobileLeftView === "favorites" ? " is-on" : ""}`}
                          onClick={() => setLeftView("favorites")}
                        >
                          <IconStar size={13} />
                          收藏{visibleFavorites.length > 0 ? ` ${visibleFavorites.length}` : ""}
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mobileLeftView === "recents"}
                          className={`left-view-tab${mobileLeftView === "recents" ? " is-on" : ""}`}
                          onClick={() => setLeftView("recents")}
                        >
                          <IconClock size={13} />
                          最近
                        </button>
                      </div>
                      {renderTree(mobileLeftView)}
                    </>
                  )}
                  {drawerView === "search" && (
                    <>
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
                      <button
                        type="button"
                        className="m-fulltext-btn"
                        onClick={() => {
                          setLeftCollapsed(true);
                          openPalette();
                        }}
                      >
                        <IconSearch size={14} />
                        全文搜索（标题与内容）
                      </button>
                      {renderTree("files")}
                    </>
                  )}
                  {drawerView === "tags" && tagDashboardEl}
                  {drawerView === "vocab" && vocabPanelEl}
                  {drawerView === "calendar" && calendarPanelEl}
                </div>
                {/* 0.34.1 用户反馈：动作行只属于文件列表分区（新建笔记/文件夹），
                    其他分区用不到也不显示；✕ 关闭按钮删除——关抽屉走系统返回/
                    点文件/仓库切换（Obsidian 移动端同款，全屏抽屉无关闭钮） */}
                {drawerView === "files" && (
                  <div className="m-drawer-actions">
                    <button
                      type="button"
                      disabled={!current}
                      onClick={revealCurrentNote}
                      title="定位当前文件"
                    >
                      <IconListTree size={16} />
                    </button>
                    <button
                      type="button"
                      disabled={!vault}
                      onClick={() => beginCreate("note")}
                      title="新建笔记"
                    >
                      <IconPlus size={16} />
                    </button>
                    <button
                      type="button"
                      disabled={!vault}
                      onClick={() => beginCreate("folder")}
                      title="新建文件夹"
                    >
                      <IconFolderPlus size={16} />
                    </button>
                  </div>
                )}
                {/* 0.34.1 用户反馈：分区卡默认收起成胶囊（当前分区 + ⇅），点击
                    展开五行、选中后收回——对齐 Obsidian 移动端的分区切换器 */}
                <div className="m-drawer-sections">
                  {!drawerSectionsOpen ? (
                    <button
                      type="button"
                      className="m-drawer-section is-on m-drawer-section-collapsed"
                      onClick={() => setDrawerSectionsOpen(true)}
                      title="展开分区列表"
                    >
                      {drawerSections.find((s) => s.key === drawerView)?.icon}
                      {drawerSections.find((s) => s.key === drawerView)?.label}
                      <span className="m-drawer-section-caret" aria-hidden="true" />
                    </button>
                  ) : (
                    drawerSections.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        role="tab"
                        aria-selected={drawerView === s.key}
                        className={`m-drawer-section${drawerView === s.key ? " is-on" : ""}`}
                        onClick={() => {
                          setDrawerView(s.key);
                          setDrawerSectionsOpen(false);
                        }}
                      >
                        {s.icon}
                        {s.label}
                      </button>
                    ))
                  )}
                </div>
                <div className="m-drawer-foot">
                  <button
                    type="button"
                    className="m-drawer-vault"
                    onClick={openVaultSheet}
                    title="切换仓库"
                  >
                    <span className="m-drawer-vault-name">{vaultName ?? "未选择仓库"}</span>
                    <span className="m-drawer-vault-meta">
                      {noteCount} 篇 · {dirCount} 个文件夹
                    </span>
                  </button>
                  <button
                    type="button"
                    className="m-drawer-gear"
                    onClick={() => {
                      setLeftCollapsed(true);
                      shortcuts.openSettings();
                    }}
                    title="设置"
                  >
                    <IconSettings size={17} />
                  </button>
                </div>
              </>
            ) : (
              <>
          {/* 0.33.1 用户反馈：功能选项（视图页签）与新建按钮行上下互换——页签
              在顶（样式向右侧面板的 .sidebar-tabs 看齐），标题行在下；新建
              笔记/日记/文件夹只在知识库视图显示（收藏/最近/标签用不到） */}
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
            <button
              type="button"
              role="tab"
              aria-selected={leftView === "tags"}
              className={`left-view-tab${leftView === "tags" ? " is-on" : ""}`}
              onClick={() => setLeftView("tags")}
              title="标签仪表盘：集中查看与整理标签"
            >
              <IconTag size={13} />
              标签
            </button>
          </div>
          <div className="panel-head">
            <span className="panel-title">
              {leftView === "files" ? "知识库" : leftView === "favorites" ? "收藏" : leftView === "recents" ? "最近" : "标签"}
            </span>
            {leftView === "files" && (
              <>
                <span className="panel-count" title="仓库内笔记数">{noteCount}</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  disabled={!current}
                  onClick={revealCurrentNote}
                  title="定位当前文件：在文件树中展开并高亮"
                >
                  <IconListTree size={15} />
                </button>
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
              </>
            )}
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
              <button
                type="button"
                className={`icon-btn dir-filter-btn${hiddenDirs.size > 0 ? " has-filter" : ""}`}
                onClick={() => setDirFilterOpen((value) => !value)}
                title="目录筛选：只显示勾选的一级目录"
              >
                <IconFolder size={13} />
              </button>
              {dirFilterOpen && (
                <DirFilterPopover
                  dirs={topLevelDirs(entries)}
                  hiddenDirs={hiddenDirs}
                  onToggle={toggleHiddenDir}
                  onClose={() => setDirFilterOpen(false)}
                />
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
                  // 0.34.6：与移动端输入行同款兜底——keyCode 13 + 组词中不提交
                  if ((event.key === "Enter" || event.keyCode === 13) && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void (renaming ? submitRename() : submitCreate());
                  }
                  if (event.key === "Escape") (renaming ? cancelRename : cancelCreate)();
                }}
              />
              <button
                type="button"
                className="icon-btn create-cancel"
                title="取消"
                aria-label="取消"
                onClick={() => (renaming ? cancelRename() : cancelCreate())}
              >
                <IconX size={13} />
              </button>
              <div className="create-hint">
                {renaming
                  ? `重命名 ${renaming.slice(renaming.lastIndexOf("/") + 1)} · Enter 确认 / Esc 取消`
                  : creating === "diary"
                    ? `新建到 ${daily.settings.folder || "仓库根目录"} · 文件名 = 日期 + 空格 + 名字 · Enter 确认 / Esc 取消`
                    : `新建到 ${createFolderOverride || createTargetFolder() || "仓库根目录"} · Enter 确认 / Esc 取消`}
              </div>
            </div>
          )}
          {leftView === "tags" ? tagDashboardEl : renderTree(leftView)}
              </>
            )}
        </aside>
        <main className="editor-pane">
          {/* 笔记内容**常驻挂载**（Inbox 打开时仅 CSS 隐藏）：条件卸载会让一次性
              创建的 EditorView 附着在已销毁的 host div 上，返回笔记后编辑器空白 */}
          <div className={`editor-pane-notes${captureManagerOpen ? " is-hidden" : ""}`}>
          {/* 0.32.2 Obsidian 式分栏：标签栏随窗格分成两段——左栏管自己的标签，
              右栏（开着时）有自己的标签栏；每个标签唯一归属一栏 */}
          <div className="editor-main">
            <div className="editor-pane-col">
          {leftTabs.length > 0 && (
            <div
              className="tabbar"
              role="tablist"
              aria-label="打开的笔记"
              onMouseDown={() => {
                focusedPaneRef.current = "main";
                if (outlineFollow === "split") setOutlineFollow("editor");
              }}
              onWheel={(event) => {
                // 标签多到溢出时，纵向滚轮横着滚标签栏（触控板 deltaX 本来就是横向的）。
                // 不 preventDefault：这里没有别的纵向滚动可抢，React 的 wheel 监听是被动式
                const el = event.currentTarget;
                const delta =
                  Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
                if (delta !== 0) el.scrollLeft += delta;
              }}
            >
              {leftTabs.map((tab) => {
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
            <div
              className={`editor-host${mode === "live" && (!current || isMarkdownPath(current.path)) ? " is-live" : " is-source"}`}
              ref={hostRef}
              onMouseDown={() => {
                // 焦点窗格与目录跟随（0.32.2 分栏）：点左栏把它记为聚焦窗格
                focusedPaneRef.current = "main";
                if (outlineFollow === "split") setOutlineFollow("editor");
                // 0.33.0 批C：阅读态点正文 = 进沉浸阅读；0.34.1 用户反馈改为
                // **双向 toggle**（Obsidian 移动端语义）——沉浸中再点一次正文
                // 唤回浮动药丸与底条，不再依赖顶部热区
                if (isMobile() && !mobileEditRef.current) setMobileZen((v) => !v);
              }}
            />
            </div>
            {rightTabs.length > 0 && (
              <div
                className="pane-divider"
                ref={paneDividerRef}
                onPointerDown={onPaneDividerDown}
                title="拖动调整左右分栏宽度"
                role="separator"
                aria-orientation="vertical"
              />
            )}
            {rightTabs.length > 0 && (
              <div className="editor-pane-col is-split" style={{ flexBasis: `${splitPct}%` }}>
                <div
                  className="tabbar is-split"
                  role="tablist"
                  aria-label="分屏栏的笔记"
                  onMouseDown={() => {
                    focusedPaneRef.current = "split";
                    if (outlineFollow !== "split") setOutlineFollow("split");
                  }}
                  onWheel={(event) => {
                    const el = event.currentTarget;
                    const delta =
                      Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
                    if (delta !== 0) el.scrollLeft += delta;
                  }}
                >
                  {rightTabs.map((tab) => {
                    const isPinned = pinnedSet.has(tab.path);
                    return (
                      <div
                        key={tab.path}
                        role="tab"
                        aria-selected={tab.path === splitActiveTab}
                        tabIndex={0}
                        className={`tab${tab.path === splitActiveTab ? " is-active" : ""}${
                          dirtyTabs.current.has(tab.path) ? " is-dirty" : ""
                        }${isPinned ? " is-pinned" : ""}`}
                        title={isPinned ? `${tab.path}（已固定）` : tab.path}
                        onClick={() => void openNote(tab.path)}
                        onAuxClick={(event) => {
                          if (event.button === 1) {
                            event.preventDefault();
                            if (!isPinned) void closeTab(tab.path);
                          }
                        }}
                        onContextMenu={(event) => {
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
                  <button
                    type="button"
                    className="tabbar-pane-close"
                    title="收起分屏栏（标签移回左侧，Esc 也可）"
                    aria-label="收起分屏栏"
                    onClick={closeRightPane}
                  >
                    <IconX size={12} />
                  </button>
                </div>
                <SplitPane
                  hostClass={`editor-host${mode === "live" && (!splitActiveTab || isMarkdownPath(splitActiveTab)) ? " is-live" : " is-source"}`}
                  onPaneFocus={() => {
                    focusedPaneRef.current = "split";
                    if (outlineFollow !== "split") setOutlineFollow("split");
                  }}
                  onReady={(view) => {
                    splitViewRef.current = view;
                    // 视图就绪代际 +1：装载 effect 据此（重）触发（0.32.2 加固）
                    setSplitViewEpoch((n) => n + 1);
                  }}
                  onDestroy={() => {
                    splitViewRef.current = null;
                  }}
                />
                {splitError && <div className="split-pane-error">{splitError}</div>}
              </div>
            )}
          </div>
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
          {isMobile() && (
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                const view = viewRef.current;
                if (files.length === 0 || !view) return;
                void saveAndLink(view, files, attachmentOptions);
              }}
            />
          )}
          {isMobile() && current && (
            <div className="mobile-md-toolbar" aria-label="Markdown 工具栏">
              {(
                [
                  { label: "H", title: "标题", run: () => viewRef.current && toggleHeading(viewRef.current, 1) },
                  { label: "B", title: "粗体", run: () => viewRef.current && toggleBold(viewRef.current) },
                  { label: "</>", title: "行内代码", run: () => viewRef.current && toggleInlineCode(viewRef.current) },
                  { label: "•", title: "无序列表", run: () => viewRef.current && toggleBulletList(viewRef.current) },
                  { label: "☑", title: "待办", run: () => viewRef.current && toggleTaskList(viewRef.current) },
                  { label: "{}", title: "代码块", run: () => viewRef.current && toggleCodeBlock(viewRef.current) },
                ] as const
              ).map((item) => (
                <button
                  key={item.label}
                  type="button"
                  title={item.title}
                  onMouseDown={(event) => {
                    // 阻止焦点离开编辑器（工具栏点击不打断输入法组合）
                    event.preventDefault();
                    item.run();
                  }}
                >
                  {item.label}
                </button>
              ))}
              {/* 相册/文件选图：wry 的 onShowFileChooser 原生桥接 SAF 选择器，
                  File 对象走与桌面粘贴同一条附件管线 */}
              <button
                type="button"
                title="插入图片（相册/文件）"
                onMouseDown={(event) => {
                  event.preventDefault();
                  imageInputRef.current?.click();
                }}
              >
                📷
              </button>
              {/* 0.33.0 批C：编辑态唯一的退出入口——收键盘回阅读态（不回退
                  沉浸与否，由用户接下来点哪决定） */}
              <button
                type="button"
                className="mobile-md-done"
                title="完成编辑"
                onMouseDown={(event) => {
                  event.preventDefault();
                  exitMobileEdit();
                }}
              >
                <IconCheck size={15} />
              </button>
            </div>
          )}
          {previewPath && vault && (
            <FilePreview vault={vault} path={previewPath} onClose={() => setPreviewPath(null)} />
          )}
          {/* 空状态只在**确实没有任何标签**时渲染：曾经 activeTab 与 openTabs
              短暂错位时（替换式打开的中间帧），这层会叠在上一篇内容上透出 */}
          {!current && openTabs.length === 0 && (
            isMobile() && !vault ? (
              /* 0.33.1 主页重构：无仓库时主页就是软件主页面（全屏，设置从
                  这里的齿轮进）；桌面空状态不变 */
              <div className="vault-home-page">
                <MobileVaultGate
                  onOpenSettings={() => setShowSettings(true)}
                  onOpen={(p) => void switchVault(p)}
                  onEnableSync={enableVaultSync}
                  syncConfigured={Boolean(sync.config.serverUrl)}
                  isVaultSyncEnabled={(p) => syncRef.current?.enabledForVault(p) ?? Promise.resolve(false)}
                  onConfigureSync={(server, username, password) =>
                    sync.updateConfig({ serverUrl: server, username, password })
                  }
                  onSyncSelected={(paths) => syncSelectedVaults(paths)}
                  syncBatchLabel={syncBatchLabel}
                  syncFailedPaths={syncFailedPaths}
                  onRetrySyncFailed={() => void syncSelectedVaults(syncFailedPaths)}
                  listCloudVaults={sync.listCloudVaults}
                  appVersion={appVersion}
                />
              </div>
            ) : (
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
            )
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
          </div>
          {captureManagerOpen && (
            <CaptureManager
              inboxVault={settings.quickCaptureVault}
              onInboxVaultChange={(value) => applySettings({ quickCaptureVault: value })}
              vaultOptions={captureVaultOptions}
              currentVault={vault}
              onClose={() => setCaptureManagerOpen(false)}
              notice={notice}
              onNewCapture={() => setQuickCaptureOpen(true)}
              onStats={setInboxStats}
              carryAttachments={carryAttachmentsForArchive}
              imageFolder={daily.settings.pastedImageFolder}
              onArchiveSync={handleArchiveSync}
            />
          )}
        </main>
        {captureManagerOpen ? (
          <aside className="sidebar sidebar-right">
            <div className="inbox-side">
              <div className="inbox-side-title">今日整理</div>
              <div className="inbox-side-stats">
                <div className="inbox-side-stat">
                  <span className="inbox-side-num">{inboxStats?.pending ?? 0}</span>
                  <span className="inbox-side-label">待处理</span>
                </div>
                <div className="inbox-side-stat">
                  <span className="inbox-side-num">{inboxStats?.todayNew ?? 0}</span>
                  <span className="inbox-side-label">今日新增</span>
                </div>
              </div>
              <div className="inbox-side-title">最近标签</div>
              <div className="inbox-side-tags">
                {(inboxStats?.recentTags ?? []).map((tag) => (
                  <span key={tag} className="cm-tag">
                    #{tag}
                  </span>
                ))}
                {(inboxStats?.recentTags ?? []).length === 0 && (
                  <span className="inbox-side-hint">还没有带标签的速记</span>
                )}
              </div>
              <div className="inbox-side-hint">
                日历 / 目录 / 统计在关闭 Inbox（Esc 或 ✕）后照常可用。
              </div>
            </div>
          </aside>
        ) : (
        <aside className="sidebar sidebar-right">
          <div className="sidebar-tabs" role="tablist" aria-label="右侧面板">
            {/* 0.34.0：日历/单词本搬进移动端左抽屉分区——移动端只留 目录/统计 */}
            {!isMobile() && (
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
            )}
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
            {!isMobile() && (
              <button
                type="button"
                role="tab"
                aria-selected={rightPanel === "vocab"}
                className={`sidebar-tab${rightPanel === "vocab" ? " is-on" : ""}`}
                onClick={() => changeRightPanel("vocab")}
              >
                <IconLibrary size={13} />
                单词
              </button>
            )}
          </div>
          {rightPanel === "daily" && !isMobile() && calendarPanelEl}
          {rightPanel === "outline" && (
            <OutlinePanel
              getDoc={() => {
                // 0.32 分屏可编辑：目录跟随「最后聚焦的窗格」——分屏聚焦时列分屏
                // 编辑器自己的文档（实时状态），否则列主编辑器文档。
                // 两侧都必须走 sliceDoc（facet 会把换行替换成文件自己的 CRLF），
                // doc.toString() 永远输出 \n——CRLF 笔记 split 会失效、大纲全空
                if (outlineFollow === "split" && splitActiveTab) {
                  const splitView = splitViewRef.current;
                  if (!splitView) return null;
                  return {
                    text: splitView.state.sliceDoc(0, splitView.state.doc.length),
                    lineBreak: splitView.state.lineBreak,
                  };
                }
                const view = viewRef.current;
                if (!view) return null;
                const state = view.state;
                return { text: state.sliceDoc(0, state.doc.length), lineBreak: state.lineBreak };
              }}
              revision={revision}
              // 预览 pdf/docx 等文件时编辑器还装着上一篇 md，大纲继续显示它会误导
              // （0.20 用户反馈"预览 pdf 时右侧目录还显示 md 的目录"），清空让空态接管
              activeKey={previewPath ? null : outlineFollow === "split" ? splitActiveTab : activeTab}
              cursorLine={outlineFollow === "split" ? splitCursorLine : cursorLine}
              onJump={(line) => {
                // 分屏模式下点击标题：在**分屏编辑器内**定位（0.32——此前只读时代
                // 是在主编辑器重开该文件，会把并排的另一篇顶掉，用户明确不要）
                if (outlineFollow === "split" && splitActiveTab) {
                  const splitView = splitViewRef.current;
                  if (!splitView) return;
                  const target = splitView.state.doc.line(
                    Math.min(Math.max(line + 1, 1), splitView.state.doc.lines),
                  );
                  splitView.dispatch({
                    selection: { anchor: target.from },
                    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
                  });
                  splitView.focus();
                  return;
                }
                jumpToLine(line);
              }}
            />
          )}
          {rightPanel === "stats" && (
            <StatsPanel entries={entries} daily={daily} onOpen={(p) => void openEntry(p)} />
          )}
          {rightPanel === "vocab" && !isMobile() && vocabPanelEl}
        </aside>
        )}
      </div>

      {/* 0.34.1：沉浸唤回热区（m-zen-peek）已移除——点正文即双向 toggle，
          沉浸中再点一次正文就唤回浮动药丸与底条 */}

      {/* 0.34.0 ☰ 动作菜单 sheet（Obsidian 图2 样式）：grabber + 分组行。
          打开前浮层互斥已在药丸处做过；back 链里它排在设置之前。 */}
      {isMobile() && mobileMenuOpen && (
        <>
          <div className="m-sheet-backdrop" onClick={() => setMobileMenuOpen(false)} />
          <div className="m-sheet" role="menu" aria-label="更多操作">
            <div className="m-sheet-grabber" />
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setMobileMenuOpen(false);
                openPalette();
              }}
            >
              <IconSearch size={17} />
              快速切换与全文搜索
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setMobileMenuOpen(false);
                // 0.34.1 用户拍板：不用免输入的纯日期名——走自己的日记命名流程
                //（日期 + 空格 + 名字，输入行必填；同名直接打开不覆盖）
                setDrawerView("files");
                beginCreate("diary");
              }}
            >
              <IconCalendarPlus size={17} />
              打开/创建今天的日记
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setMobileMenuOpen(false);
                setQuickCaptureOpen(true);
              }}
            >
              <IconSparkles size={17} />
              速记（收件箱）
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setMobileMenuOpen(false);
                shortcuts.addWordDialog();
              }}
            >
              <IconLibrary size={17} />
              添加单词
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setMobileMenuOpen(false);
                setCaptureManagerOpen(true);
              }}
            >
              <IconClock size={17} />
              速记管理
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setMobileMenuOpen(false);
                sync.syncNow();
                syncVocabNow();
              }}
            >
              <IconRefresh size={17} />
              立即同步
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setMobileMenuOpen(false);
                // 右抽屉打开前收左抽屉：双全屏抽屉叠着没有意义（0.34.1）
                setLeftCollapsed(true);
                setRightCollapsed(false);
              }}
            >
              <IconPanelRight size={17} />
              右侧面板（大纲 / 统计）
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setMobileMenuOpen(false);
                setLeftCollapsed(true);
                setRightCollapsed(true);
                shortcuts.openSettings();
              }}
            >
              <IconSettings size={17} />
              设置
            </button>
          </div>
        </>
      )}

      {/* 0.34.1 右上 ⋮ = 当前笔记菜单（Obsidian 移动端语义：用户反馈右上三点
          与右下横杆不该同功能——这一份全是笔记属性/状态类操作，应用级动作在
          底条 ☰）。行集对齐 Obsidian 中可映射项：阅读/编辑、实时/源码、固定
          标签页、重命名、收藏、标签、关闭、保存。 */}
      {isMobile() && noteMenuOpen && current && (
        <>
          <div className="m-sheet-backdrop" onClick={() => setNoteMenuOpen(false)} />
          <div className="m-sheet" role="menu" aria-label="当前笔记操作">
            <div className="m-sheet-grabber" />
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setNoteMenuOpen(false);
                if (mobileEdit) exitMobileEdit();
                else enterMobileEdit();
              }}
            >
              {mobileEdit ? <IconEye size={17} /> : <IconPenLine size={17} />}
              {mobileEdit ? "回到阅读视图" : "编辑这篇笔记"}
            </button>
            <button
              type="button"
              className="m-sheet-row"
              disabled={!isMarkdownPath(current.path)}
              onClick={() => {
                setNoteMenuOpen(false);
                changeMode(modeRef.current === "live" ? "source" : "live");
              }}
            >
              <IconCode size={17} />
              切换实时 / 源码渲染
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setNoteMenuOpen(false);
                togglePinTab(current.path);
              }}
            >
              <IconPin size={17} />
              {pinnedSet.has(current.path) ? "取消固定标签页" : "固定标签页"}
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setNoteMenuOpen(false);
                // 重命名输入行在抽屉顶部（0.33.0 停点3 同款）：先展开抽屉再命名
                setDrawerView("files");
                setLeftCollapsed(false);
                beginRename(current.path);
              }}
            >
              <IconPenLine size={17} />
              重命名
            </button>
            <button
              type="button"
              className="m-sheet-row"
              onClick={() => {
                setNoteMenuOpen(false);
                toggleFavorite(current.path);
              }}
            >
              <IconStar size={17} />
              {favorites.includes(current.path) ? "取消收藏" : "收藏"}
            </button>
            <button
              type="button"
              className="m-sheet-row"
              disabled={!isMarkdownPath(current.path)}
              onClick={() => {
                setNoteMenuOpen(false);
                shortcuts.toggleTags();
              }}
            >
              <IconTag size={17} />
              当前笔记标签
            </button>
            <button
              type="button"
              className="m-sheet-row"
              disabled={pinnedSet.has(current.path)}
              onClick={() => {
                setNoteMenuOpen(false);
                void closeTab(current.path);
              }}
            >
              <IconX size={17} />
              关闭标签页
            </button>
            <button
              type="button"
              className={`m-sheet-row${dirty ? " is-dirty" : ""}`}
              onClick={() => {
                setNoteMenuOpen(false);
                shortcuts.save();
              }}
            >
              <IconSave size={17} />
              {dirty ? "保存当前笔记（有未保存改动）" : "保存当前笔记"}
            </button>
          </div>
        </>
      )}

      {/* 0.34.0 [N] 标签页切换 sheet：移动端标签栏隐藏后的唯一标签入口。
          行点击走 openNote（自带按栏路由），✕ 直关（closeTab 有落盘守卫）。
          脏标记读 ref（面板只在打开瞬间渲染，无需订阅）。 */}
      {isMobile() && tabSheetOpen && (
        <>
          <div className="m-sheet-backdrop" onClick={() => setTabSheetOpen(false)} />
          <div className="m-sheet" role="menu" aria-label="标签页">
            <div className="m-sheet-grabber" />
            <div className="m-sheet-title">标签页（{openTabs.length}）</div>
            {openTabs.length === 0 && <div className="m-sheet-empty">还没有打开的笔记</div>}
            {openTabs.map((tab) => {
              const isDirtyTab = dirtyTabs.current.has(tab.path) || (tab.path === activeTab && dirty);
              const name = tab.path.split("/").pop() ?? tab.path;
              return (
                <div key={tab.path} className={`m-tab-row${tab.path === activeTab ? " is-active" : ""}`}>
                  <button
                    type="button"
                    className="m-tab-main"
                    onClick={() => {
                      setTabSheetOpen(false);
                      void openNote(tab.path);
                    }}
                  >
                    <span className="m-tab-name">{name}</span>
                    {rightTabPaths.includes(tab.path) && <span className="m-tab-pane">分屏</span>}
                    {isDirtyTab && <span className="m-tab-dirty" title="未保存" />}
                  </button>
                  <button
                    type="button"
                    className="m-tab-close"
                    title="关闭标签"
                    onClick={() => void closeTab(tab.path)}
                  >
                    <IconX size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* 0.34.0 仓库切换 radio sheet（Obsidian 图4）：抽屉底部仓库名点开，
          当前行高亮圈；最后一行「管理仓库…」进仓库主页。 */}
      {isMobile() && vaultSheetOpen && (
        <>
          <div className="m-sheet-backdrop" onClick={() => setVaultSheetOpen(false)} />
          <div className="m-sheet m-vault-sheet" role="menu" aria-label="切换仓库">
            <div className="m-sheet-grabber" />
            {vaultSheetList.map((v) => (
              <button
                key={v.path}
                type="button"
                className="m-vault-row"
                onClick={() => {
                  setVaultSheetOpen(false);
                  setLeftCollapsed(true);
                  if (normVaultPath(v.path) !== vault) void switchVault(v.path);
                }}
              >
                <span className="m-vault-name">{v.name || vaultDisplayName(v.path)}</span>
                <span className={`m-radio${normVaultPath(v.path) === vault ? " is-on" : ""}`} />
              </button>
            ))}
            <button
              type="button"
              className="m-vault-row"
              onClick={() => {
                setVaultSheetOpen(false);
                setLeftCollapsed(true);
                setRightCollapsed(true);
                setVaultGateOpen(true);
              }}
            >
              <span className="m-vault-name">管理仓库…</span>
              <span className="m-radio" />
            </button>
          </div>
        </>
      )}

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
          onClick={() => {
            sync.syncNow();
            // 单词本走自己的账户级引擎，手动同步时带上它
            syncVocabNow();
          }}
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
        vaults={paletteVaults}
        onOpenNote={(path, line, term) => void openNoteAt(path, line, term)}
        onOpenNoteInVault={(target, path, line, term) => void openNoteInVault(target, path, line, term)}
        actions={paletteActions}
        hoverPreview={settings.searchHoverPreview}
        seed={paletteOpen ? paletteSeedRef.current : ""}
        contentLimit={settings.paletteContentLimit}
      />

      <WeekReviewDialog
        open={weekDialogOpen}
        onClose={() => setWeekDialogOpen(false)}
        onPick={(mondayISO) => void insertWeeklyReview(mondayISO, false)}
      />

      <HeadingLevelDialog
        open={headingDialogOpen}
        onClose={() => setHeadingDialogOpen(false)}
        onPick={(level) => {
          const view = viewRef.current;
          if (view) clampHeadings(view, level);
        }}
      />

      <ScreenshotDialog
        open={screenshotOpen}
        imageBase64={screenshotImage}
        onClose={() => {
          setScreenshotOpen(false);
          // 顺手放掉整屏 PNG 的 base64（多联屏整屏好几 MB；0.21 用户反馈关注内存）
          setScreenshotImage(null);
        }}
        notice={(message, kind) => {
          if (kind === "error") setError(message);
          else setStatus(message);
        }}
        insertText={insertAtCursor}
        saveAttachment={saveScreenshotAttachment}
        linkFormat={() => getSettings().linkFormat}
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

/** 目录筛选弹层：勾选一级目录，取消勾选的整枝从文件树里藏起来（按仓库记忆）。 */
function DirFilterPopover({
  dirs,
  hiddenDirs,
  onToggle,
  onClose,
}: {
  dirs: string[];
  hiddenDirs: ReadonlySet<string>;
  onToggle: (dir: string, hidden: boolean) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="dir-filter-backdrop" onClick={onClose} />
      <div className="dir-filter-pop" role="dialog" aria-label="目录筛选">
        <div className="dir-filter-head">
          <span>只显示勾选的目录</span>
          {hiddenDirs.size > 0 && (
            <button
              type="button"
              className="dir-filter-clear"
              onClick={() => dirs.forEach((dir) => hiddenDirs.has(dir) && onToggle(dir, false))}
            >
              全部显示
            </button>
          )}
        </div>
        {dirs.length === 0 ? (
          <div className="dir-filter-empty">仓库根目录下还没有文件夹。</div>
        ) : (
          <div className="dir-filter-list">
            {dirs.map((dir) => (
              <label key={dir} className="dir-filter-item" title={dir}>
                <input
                  type="checkbox"
                  checked={!hiddenDirs.has(dir)}
                  onChange={(event) => onToggle(dir, !event.target.checked)}
                />
                <span>{baseName(dir)}</span>
              </label>
            ))}
          </div>
        )}
        {hiddenDirs.size > 0 && (
          <div className="dir-filter-note">已隐藏 {hiddenDirs.size} 个目录；收藏、最近与搜索不受影响。</div>
        )}
      </div>
    </>
  );
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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Moment } from "moment";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CalendarPanel from "./components/CalendarPanel";
import FileTree from "./components/FileTree";
import OutlinePanel from "./components/OutlinePanel";
import { allowAssetDir, createFolder, createNote, deleteEntry, listEntries, onVaultChanged, pickVault, readNote, readNoteOptional, renameEntry, startupVault, watchVault, writeNote } from "./lib/api";
import type { EntryMeta, NoteContent } from "./lib/api";
import { applyMode, applyDarkTheme, createEditor, createEditorState, type ViewMode } from "./lib/editor";
import { lineEndingLabel } from "./lib/lineEndings";
import { clearEmbedCache } from "./lib/embed";
import { requestDecorationRefresh } from "./lib/livePreview";
import type { LivePreviewContext } from "./lib/paths";
import { getSettings, updateSettings, takeLegacyAttachmentFolder, type Settings } from "./lib/settings";
import { checkForUpdate } from "./lib/updater";
import { getVersion } from "@tauri-apps/api/app";
import { applyTheme, resolveTheme, watchSystemTheme } from "./lib/theme";
import {
  DAILY_CONFIG_FILE,
  dailyNotePath,
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
  const [draft, setDraft] = useState("");
  /** 右键菜单：条目路径 + 是否目录 + 鼠标位置。 */
  const [menu, setMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(
    null,
  );
  /** 待确认的删除。删笔记不可逆，先问一次。 */
  const [pendingDelete, setPendingDelete] = useState<{ path: string; isDir: boolean } | null>(null);
  /** 侧栏当前页签：文件树 / 日历 / 目录。 */
  const [sidebar, setSidebar] = useState<"files" | "daily" | "outline">(() => {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    return stored === "daily" || stored === "outline" ? stored : "files";
  });
  /** 光标是否在表格块内（表格工具栏的显示依据）。 */
  const [inTable, setInTable] = useState(false);

  /** 激活标签的 meta。其余标签的未保存内容在各自的 EditorState 里。 */
  const current = useMemo(
    () => openTabs.find((tab) => tab.path === activeTab) ?? null,
    [openTabs, activeTab],
  );

  const applySettings = useCallback((patch: Partial<Settings>) => {
    setSettings(updateSettings(patch));
  }, []);

  // ---------------------------------------------------------------- 软件更新

  const [appVersion, setAppVersion] = useState("");
  const [updateCheck, setUpdateCheck] = useState<{
    state: "idle" | "checking" | "done" | "error";
    message: string;
    url?: string;
  }>({ state: "idle", message: "" });

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

  const checkUpdate = useCallback(async () => {
    setUpdateCheck({ state: "checking", message: "正在检查更新…" });
    try {
      const info = await checkForUpdate(appVersion || "0.0.0");
      setUpdateCheck(
        info.newer
          ? { state: "done", message: `发现新版本 v${info.latest}（当前 v${appVersion}），可到发布页下载`, url: info.url }
          : { state: "done", message: `已是最新版本（最新发布 v${info.latest}）` },
      );
    } catch (e) {
      setUpdateCheck({ state: "error", message: `检查更新失败：${e}` });
    }
  }, [appVersion]);

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

  // 待办的改动回调要在 useSync 之前挂上，所以先用一个占位 ref 接住它（回调是
  // 惰性读取的，等真正触发时 ref 早已填好）。
  const syncRef = useRef<SyncController | null>(null);

  const daily = useDaily({
    vault,
    files: mdFiles,
    notice,
    // 待办不落盘、没有文件事件，改完要主动通知同步引擎（它按内容哈希决定推不推）
    onTodosChanged: () => syncRef.current?.touchVirtual(),
  });

  const sync = useSync({
    vault,
    folder: daily.settings.folder,
    todoSnapshot: daily.todoSnapshot,
    mergeTodoSnapshot: daily.mergeTodoSnapshot,
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

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
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
  const openTabsRef = useRef<NoteContent[]>([]);
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
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const handleDocChanged = useCallback(() => {
    const path = currentRef.current?.path;
    if (path) dirtyTabs.current.add(path);
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
        mode,
        onDocChanged: handleDocChanged,
        onSave: () => void saveRef.current(),
        resources: resourcesRef.current,
        attachment: attachmentOptions,
        dark: resolveTheme(getSettings().theme) === "dark",
        onCursorInTable: setInTable,
      });
      view?.setState(newState);
      view?.dispatch({ selection: { anchor: Math.min(anchor, view.state.doc.length) } });
      stateStore.current.set(note.path, newState);
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
      const prev = currentRef.current?.path;
      if (prev && prev !== path) {
        stateStore.current.set(prev, view.state);
        scrollStore.current.set(prev, view.scrollDOM.scrollTop);
        if (dirtyRef.current) dirtyTabs.current.add(prev);
      }
      view.setState(stored);
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
        }
      } else {
        // 关的是后台标签，激活者不变；但 dirty 标记可能在脏集合里，同步一次显示
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
        if (dir) useVault(dir);
      });
  }, [refresh, activateVault]);

  // 自动保存：revision 每次改动递增，从而重置防抖计时。
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void saveNow(), AUTOSAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [dirty, revision, saveNow]);

  const openVault = useCallback(async () => {
    setError(null);
    const picked = await pickVault();
    if (!picked) return;
    localStorage.setItem(VAULT_KEY, picked);
    setVault(picked);
    // 换仓库必须把所有标签与编辑器一起清掉：CodeMirror 的状态还挂着上一篇的话，
    // 旧内容继续显示，下一次输入还会试图写回旧仓库的路径
    setOpenTabs([]);
    setActiveTab(null);
    stateStore.current.clear();
    scrollStore.current.clear();
    staleTabs.current.clear();
    dirtyTabs.current.clear();
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
  }, [refresh, activateVault]);

  const openNote = useCallback(
    async (path: string) => {
      if (!vault) return;
      // 已是这个标签且没有外部改动：什么都不做（重置会丢光标位置）
      if (path === activeTabRef.current && !staleTabs.current.has(path)) return;
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
          mode,
          onDocChanged: handleDocChanged,
          onSave: () => void saveRef.current(),
          resources: resourcesRef.current,
          attachment: attachmentOptions,
          dark: resolveTheme(getSettings().theme) === "dark",
          onCursorInTable: setInTable,
        });
        stateStore.current.set(note.path, newState);
        dirtyTabs.current.delete(path);
        setOpenTabs((prev) =>
          prev.some((tab) => tab.path === note.path)
            ? prev.map((tab) => (tab.path === note.path ? note : tab))
            : [...prev, note],
        );
        setActiveTab(note.path);
        viewRef.current?.setState(newState);
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
        await writeNote(vault, path, content, false);
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

  /** 打开右键菜单。 */
  const openContextMenu = useCallback((path: string, isDir: boolean, x: number, y: number) => {
    setMenu({ path, isDir, x, y });
  }, []);

  const beginRename = useCallback((path: string) => {
    setRenaming(path);
    setDraft(path.slice(path.lastIndexOf("/") + 1));
    setMenu(null);
    setError(null);
  }, []);

  /** 重命名。被改名的笔记（或所在目录）如果正开着，要跟着换到新路径，否则下次保存会写回旧路径。 */
  const submitRename = useCallback(async () => {
    if (!renaming || !vault) return;
    const name = draft.trim();
    if (!name) return;

    const openPath = currentRef.current?.path;
    const affectedOpen =
      openPath !== undefined && (openPath === renaming || openPath.startsWith(`${renaming}/`));

    try {
      if (dirty) await saveNow();
      const result = await renameEntry(vault, renaming, name);
      setRenaming(null);
      setDraft("");
      await refresh(vault);
      // 所有受影响的标签（含后台）都要换键：路径是标签与状态存储的主键
      const remap = (p: string) =>
        p === renaming ? result.path : `${result.path}${p.slice(renaming.length)}`;
      const affected = (p: string) => p === renaming || p.startsWith(`${renaming}/`);
      for (const tab of openTabsRef.current) {
        if (!affected(tab.path)) continue;
        const nextPath = remap(tab.path);
        const state = stateStore.current.get(tab.path);
        if (state) {
          stateStore.current.delete(tab.path);
          stateStore.current.set(nextPath, state);
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
      if (affectedOpen && openPath) {
        const nextPath = remap(openPath);
        resourcesRef.current.notePath = nextPath;
        setActiveTab(nextPath);
        await openNote(nextPath);
      }
      setStatus(
        result.updated.length > 0
          ? `已重命名为「${name}」，并更新了 ${result.updated.length} 篇笔记里的引用`
          : `已重命名为「${name}」`,
      );
      setError(null);
    } catch (e) {
      // 输入行保持展开，方便换个名字重试
      setError(String(e));
    }
  }, [renaming, vault, draft, dirty, saveNow, refresh, openNote]);

  /** 执行删除（移入仓库内的 .trash，可找回）。 */
  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !vault) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      const trashed = await deleteEntry(vault, target.path);
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
          }
        }
      }
      await refresh(vault);
      setStatus(`已移入回收目录：${trashed}（可以找回）`);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [pendingDelete, vault, refresh, activateTab]);

  /** 切换视图模式。用 Compartment 重配置，撤销历史与光标位置都保留。 */
  const changeMode = useCallback(    (next: ViewMode) => {
      setMode(next);
      localStorage.setItem(MODE_KEY, next);
      const view = viewRef.current;
      if (view && current) applyMode(view, next);
    },
    [current],
  );

  const changeSidebar = useCallback((next: "files" | "daily" | "outline") => {
    setSidebar(next);
    localStorage.setItem(SIDEBAR_KEY, next);
  }, []);

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

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">Quick Note</div>
        <button type="button" className="btn" onClick={() => void openVault()}>
          打开仓库
        </button>
        <button
          type="button"
          className="btn"
          disabled={!vault}
          onClick={() => vault && void refresh(vault).catch((e) => setError(String(e)))}
        >
          刷新列表
        </button>
        <span className="vault-path" title={vault ?? ""}>
          {vault ?? "尚未选择仓库"}
        </span>
        <span className="spacer" />
        <div className="mode-switch" role="group" aria-label="视图模式">
          <button
            type="button"
            className={`seg${mode === "live" ? " is-on" : ""}`}
            onClick={() => changeMode("live")}
            title="渲染语法标记，光标所在行显示源码"
          >
            Live Preview
          </button>
          <button
            type="button"
            className={`seg${mode === "source" ? " is-on" : ""}`}
            onClick={() => changeMode("source")}
            title="显示 Markdown 原文"
          >
            源码
          </button>
        </div>
        {current && (
          <>
            <button
              type="button"
              className="btn"
              disabled={!dirty}
              onClick={() => void saveNow()}
              title="Ctrl/Cmd + S"
            >
              保存
            </button>
            <button type="button" className="btn" onClick={() => void verifyRoundTrip()}>
              校验往返
            </button>
          </>
        )}
        <span
          className={`dirty-dot${dirty ? " is-dirty" : ""}`}
          title={dirty ? "有未保存改动" : "已保存"}
        />
        <button
          type="button"
          className={`btn${showSettings ? " is-on" : ""}`}
          onClick={() => setShowSettings((value) => !value)}
        >
          设置
        </button>
      </header>

      {showSettings && (
        <div className="settings-panel">
          <label className="settings-row">
            <span>主题</span>
            <select
              value={settings.theme}
              onChange={(event) =>
                applySettings({ theme: event.target.value as Settings["theme"] })
              }
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label className="settings-row">
            <span>插入链接写法</span>
            <select
              value={settings.linkFormat}
              onChange={(event) =>
                applySettings({ linkFormat: event.target.value as Settings["linkFormat"] })
              }
            >
              <option value="wiki">Wiki：![[图.png]]</option>
              <option value="markdown">Markdown：![](/attachments/图.png)</option>
            </select>
          </label>
          <label className="settings-row">
            <span>粘贴时保存附件</span>
            <input
              type="checkbox"
              checked={settings.savePastedAttachments}
              onChange={(event) =>
                applySettings({ savePastedAttachments: event.target.checked })
              }
            />
          </label>
          <Hint>
            粘贴图片或文件会保存到附件目录（重名自动加序号，不覆盖已有文件），并在光标处插入链接。
            附件目录在下方「日记与附件」分组里设置，与 Obsidian 插件共用；同步开启后贴的图会自动上传。
          </Hint>

          {/* 日记设置存在库内文件里，与 Obsidian 插件共用；上面几项存在本机。
              两处混在一个面板里会让人以为"都是应用设置"，所以用标题把落点写清楚。 */}
          <div className="settings-group">日记与附件（写入库内 {DAILY_CONFIG_FILE}，与 Obsidian 插件共用）</div>
          <label className="settings-row">
            <span>附件保存目录</span>
            <input
              type="text"
              value={daily.settings.pastedImageFolder}
              placeholder="attachments（留空即仓库根目录）"
              onChange={(event) => daily.updateSettings({ pastedImageFolder: event.target.value })}
            />
          </label>
          <Hint>
            附件目录在库内配置里（键名与插件相同：pastedImageFolder），两边换用不用设两次；
            同步开启后多台设备自动一致。改这里会写入库内文件。
          </Hint>
          <label className="settings-row">
            <span>日记目录</span>
            <input
              type="text"
              value={daily.settings.folder}
              placeholder="日记（留空即仓库根目录）"
              onChange={(event) => daily.updateSettings({ folder: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>日期格式</span>
            <input
              type="text"
              value={daily.settings.dateFormat}
              placeholder="YYYY-MM-DD"
              onChange={(event) => daily.updateSettings({ dateFormat: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>启用日记模板</span>
            <input
              type="checkbox"
              checked={daily.settings.dailyTemplateEnabled}
              onChange={(event) =>
                daily.updateSettings({ dailyTemplateEnabled: event.target.checked })
              }
            />
          </label>
          <label className="settings-row">
            <span>日记模板文件</span>
            <input
              type="text"
              value={daily.settings.dailyTemplatePath}
              placeholder="模板/日记模板.md"
              onChange={(event) => daily.updateSettings({ dailyTemplatePath: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>启用周记模板</span>
            <input
              type="checkbox"
              checked={daily.settings.weeklyTemplateEnabled}
              onChange={(event) =>
                daily.updateSettings({ weeklyTemplateEnabled: event.target.checked })
              }
            />
          </label>
          <label className="settings-row">
            <span>周记模板文件</span>
            <input
              type="text"
              value={daily.settings.weeklyTemplatePath}
              placeholder="模板/周记模板.md"
              onChange={(event) => daily.updateSettings({ weeklyTemplatePath: event.target.value })}
            />
          </label>
          <Hint>
            日期格式是 moment 语法（插件同一套），它同时决定日记文件名与待办分桶。模板支持
            {" "}<code>{"{{title}}"}</code>、<code>{"{{date}}"}</code>、<code>{"{{date:格式}}"}</code>、
            <code>{"{{week}}"}</code>、<code>{"{{time}}"}</code>；未知占位符原样保留。
            这几项与插件共用一份配置，改动会写到库内文件。
          </Hint>

          {/* 同步配置存在**本机**（应用配置目录），不进仓库：里面有服务端密码与令牌，
              同步出去等于把凭据送到服务端、再经接口回到浏览器。 */}
          <div className="settings-group">云同步（本机设置，不会写进仓库）</div>
          <label className="settings-row">
            <span>启用自动同步</span>
            <input
              type="checkbox"
              checked={sync.config.enabled}
              onChange={(event) => sync.updateConfig({ enabled: event.target.checked })}
            />
          </label>
          <label className="settings-row">
            <span>服务端地址</span>
            <input
              type="text"
              value={sync.config.serverUrl}
              placeholder="http://your-server:8080"
              onChange={(event) => sync.updateConfig({ serverUrl: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>账号</span>
            <input
              type="text"
              value={sync.config.username}
              autoComplete="off"
              onChange={(event) => sync.updateConfig({ username: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>密码</span>
            <input
              type="password"
              value={sync.config.password}
              autoComplete="off"
              onChange={(event) => sync.updateConfig({ password: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>推送范围</span>
            <select
              value={sync.config.scope}
              onChange={(event) =>
                sync.updateConfig({ scope: event.target.value as "folder" | "vault" })
              }
            >
              <option value="folder">仅日记目录</option>
              <option value="vault">整个仓库</option>
            </select>
          </label>
          <label className="settings-row">
            <span>云端仓库名</span>
            <input
              type="text"
              value={sync.config.vaultName}
              placeholder={`留空即用仓库文件夹名：${sync.vaultName}`}
              onChange={(event) => sync.updateConfig({ vaultName: event.target.value })}
            />
          </label>
          <Hint>
            与 Obsidian 插件共用同一个云端仓库。仓库名要与插件所在库的名字一致，否则会同步到
            另一个云端仓库（表现为「同步成功但数据没过来」）。正文、待办与<b>附件</b>（按笔记
            引用上传、本地缺的从云端补下）都会同步；服务端地址、账号与密码只存在本机，
            不会写进仓库。
          </Hint>
          <div className="settings-actions">
            <button type="button" className="btn" onClick={() => sync.syncNow()}>
              立即同步
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sync.resetCursorAndSync()}
              title="游标归零后重新全量拉取一次；本地状态异常时用它"
            >
              重置游标并重拉
            </button>
          </div>

          {/* 版本与更新。检查走 GitHub 公开接口（匿名限额足够手动检查用）；
              不做应用内自动安装——那需要签名密钥与更新清单服务器，现阶段带用户去发布页即可。 */}
          <div className="settings-group">软件更新</div>
          <div className="settings-row">
            <span>当前版本</span>
            <span className="settings-value">v{appVersion || "…"}</span>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="btn"
              disabled={updateCheck.state === "checking"}
              onClick={() => void checkUpdate()}
            >
              {updateCheck.state === "checking" ? "检查中…" : "检查更新"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void openReleasePage(updateCheck.url)}
              title="在系统浏览器中打开 GitHub 发布页"
            >
              打开发布页
            </button>
          </div>
          {updateCheck.state !== "idle" && (
            <p className={`settings-hint${updateCheck.state === "error" ? " hint-error" : ""}`}>
              {updateCheck.message}
            </p>
          )}
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

      {menu && (
        <>
          {/* 点空白处关闭菜单 */}
          <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(event) => {
            event.preventDefault();
            setMenu(null);
          }} />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
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
            <button type="button" onClick={() => beginRename(menu.path)}>
              重命名
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

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-tabs" role="tablist" aria-label="侧栏">
            <button
              type="button"
              role="tab"
              aria-selected={sidebar === "files"}
              className={`sidebar-tab${sidebar === "files" ? " is-on" : ""}`}
              onClick={() => changeSidebar("files")}
            >
              文件
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebar === "daily"}
              className={`sidebar-tab${sidebar === "daily" ? " is-on" : ""}`}
              onClick={() => changeSidebar("daily")}
            >
              日记
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebar === "outline"}
              className={`sidebar-tab${sidebar === "outline" ? " is-on" : ""}`}
              onClick={() => changeSidebar("outline")}
            >
              目录
            </button>
          </div>

          {sidebar === "files" ? (
            <>
              <div className="sidebar-head">
                <span className="sidebar-title">文件</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="mini-btn"
                  disabled={!vault}
                  onClick={() => beginCreate("diary")}
                  title="新建今天的日记（按日期命名，想建普通笔记请在树里右键 → 新建笔记）"
                >
                  ＋日记
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={!vault}
                  onClick={() => beginCreate("folder")}
                  title="新建文件夹"
                >
                  ＋文件夹
                </button>
              </div>
              {(creating || renaming) && (
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
                      ? `重命名 ${renaming} · Enter 确认 / Esc 取消`
                      : creating === "diary"
                        ? `新建到 ${daily.settings.folder || "仓库根目录"} · 文件名 = 日期 + 空格 + 名字 · Enter 确认 / Esc 取消`
                        : `新建到 ${(creating === "note" ? createFolderOverride : "") || createTargetFolder() || "仓库根目录"} · Enter 确认 / Esc 取消`}
                  </div>
                </div>
              )}
              <FileTree
                entries={entries}
                activePath={current?.path ?? null}
                onOpen={(p) => void openNote(p)}
                onContext={openContextMenu}
              />
            </>
          ) : sidebar === "daily" ? (
            <CalendarPanel
              controller={daily}
              onOpen={(p) => void openNote(p)}
              onCreateDaily={(dateStr, name) => void openDaily(dateStr, name)}
              onOpenWeekly={(weekKey, mondayKey) => void openWeekly(weekKey, mondayKey)}
              onContext={openContextMenu}
            />
          ) : (
            <OutlinePanel
              getView={() => viewRef.current}
              revision={revision}
              activeKey={activeTab}
              onJump={jumpToLine}
            />
          )}
        </aside>
        <main className="editor-pane">
          {openTabs.length > 0 && (
            <div className="tabbar" role="tablist" aria-label="打开的笔记">
              {openTabs.map((tab) => (
                <div
                  key={tab.path}
                  role="tab"
                  aria-selected={tab.path === activeTab}
                  tabIndex={0}
                  className={`tab${tab.path === activeTab ? " is-active" : ""}${
                    dirtyTabs.current.has(tab.path) ? " is-dirty" : ""
                  }`}
                  title={tab.path}
                  onClick={() => void openNote(tab.path)}
                  onAuxClick={(event) => {
                    // 中键关闭
                    if (event.button === 1) {
                      event.preventDefault();
                      void closeTab(tab.path);
                    }
                  }}
                >
                  <span className="tab-title">{baseName(tab.path)}</span>
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
                    ×
                  </button>
                </div>
              ))}
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
              <span className="table-toolbar-hint">Tab 下一格 · Shift+Tab 上一格</span>
            </div>
          )}
          <div className="editor-host" ref={hostRef} />
          {!current && (
            <div className="editor-empty">
              <h2>Quick Note</h2>
              <p>选择仓库目录后，点击左侧笔记开始编辑。</p>
            </div>
          )}
        </main>
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
    </div>
  );
}

/** 取路径的文件名（标签页标题）。 */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
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

/**
 * 设置面板里的说明文字：默认只显示一个「?」，点击才展开。
 *
 * 提示是给第一次用的人看的；天天用的人只需要控件本身。四段说明常驻的话，
 * 面板会高得离谱（曾经为此出过"面板挡住状态栏"的问题），折叠是共同解。
 */
function Hint({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <p className="settings-hint">
      <button
        type="button"
        className="hint-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={open ? "收起说明" : "查看说明"}
      >
        ?
      </button>
      {open && <span className="hint-body">{children}</span>}
    </p>
  );
}

/**
 * 库内配置（`quick-daily-note.json`）与待办的读写。
 *
 * ## 为什么是 hook 而不是像 settings.ts 那样的模块级对象
 *
 * 附件目录、主题那些是**每台设备一份**的设置（localStorage），模块级对象合适。
 * 这份配置不同：它是**每个仓库一份**的文件，切仓库要整份换掉，还要跟文件监听
 * 打交道——区分"自己刚写的那一次"和"插件/同步进程改的"。有生命周期的状态跟着
 * React 走更清楚。
 *
 * 纯逻辑（解析、补丁式序列化、顺延、统计、命名）都在 `daily.ts` / `todos.ts` /
 * `dailyConfig.ts` 里，能在 Node 里直接断言。这里只做 IO 与状态编排。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import moment from "moment";
import { readNoteOptional, writeNote } from "./api.ts";
import {
  DAILY_CONFIG_FILE,
  dailyFolderFiles,
  dailyNotesOn,
  dateFormatOf,
  defaultDailySettings,
  diaryDateSet,
  findDailyNote,
  weeklyKeySet,
  weeklyNotesIn,
  wordCount,
  type DailySettings,
} from "./daily.ts";
import {
  parseDailyConfig,
  serializeDailyConfig,
  type DailyConfigState,
  type DailyConfigUpdate,
} from "./dailyConfig.ts";
import { carryOver, buildSnapshot, newTodoId, type TodoItem, type TodoMap } from "./todos.ts";
import { mergeTodoSnapshot as mergeRemoteTodoSnapshot } from "./sync.ts";

/** 设置输入框的落盘防抖：每敲一个字符就写一次文件既没必要，还会把同步刷爆。 */
const SETTINGS_DEBOUNCE = 600;

/** 没有配置时的设置对象。**模块级常量**：内联字面量每次渲染都是新身份，
 *  会让依赖它的 useMemo 全部失效。 */
const NO_SETTINGS: DailySettings = defaultDailySettings();

export interface DailyController {
  /** 配置已从磁盘读出（或按默认值兜底）。 */
  ready: boolean;
  settings: DailySettings;
  /** 生效的日期格式串（空串已兜底）。 */
  dateFormat: string;
  /** 今天的日期串。 */
  today: string;
  todos: TodoMap;
  /** 当前选中的日期（待办列表与统计的对象）。 */
  selectedDate: string;
  /** 日记目录下的 `.md`（直接子文件，不递归）。 */
  folderFiles: string[];
  /** 有日记的日期集合，供日历打点与统计。 */
  dateSet: Set<string>;
  /** 有周记的周集合（值为 `2026-W37` 这样的周标识）。 */
  weeklySet: Set<string>;
  /** 某天的日记文件（排序第一篇）。 */
  dailyNoteOn: (dateStr: string) => string | null;
  /** 某天的**全部**日记文件（同一天可以有多篇）。 */
  dailyNotesOn: (dateStr: string) => string[];
  /** 某周的全部周记文件。 */
  weeklyNotesIn: (weekKey: string) => string[];
  /** 今天的字数；今天还没写日记则为 null。 */
  todayWords: number | null;
  /** 配置读写遇到的问题。为 null 表示一切正常。 */
  configError: string | null;
  /** 重新从磁盘读取配置（配置文件被手改、或上次读取失败后用它重试）。 */
  reload: () => void;
  setSelectedDate: (value: string) => void;
  updateSettings: (patch: Partial<DailySettings>) => void;
  addTodo: (dateStr: string, text: string) => void;
  toggleTodo: (dateStr: string, index: number) => void;
  deleteTodo: (dateStr: string, index: number) => void;
  /** 把源日期未完成的待办顺延到目标日期；返回顺延了几项。 */
  moveTodo: (fromDate: string, toDate: string) => number;
  /** App 收到 `vault-changed` 时调用；内部按哈希区分自己刚写的那一次。 */
  handleVaultChange: (paths: string[]) => void;
  /**
   * 同步用：当前待办的云端快照。
   *
   * 内容**只在待办真的变了时才变**（`updatedAt` 用 `todosUpdatedAt`，不是当前时间）。
   * 每轮同步都生成一份新的字符串没问题，但内容必须稳定——否则快照哈希每轮都不同，
   * 本机会不停地推送，并把别的设备更新的数据压掉。
   */
  todoSnapshot: () => string;
  /**
   * 同步用：把云端快照并进本地待办。返回本地是否因此有改动（有改动就要回推）。
   *
   * 返回 `false` 有两种情况，都不需要回推：快照版本不认识（只推不拉），
   * 或合并结果与本地一致。改动走与手动勾选**同一条落盘路径**（`apply`），
   * 因此界面立刻跟着变、并立即写回库内配置。
   */
  mergeTodoSnapshot: (content: string) => boolean;
}

export function useDaily(options: {
  vault: string | null;
  /** 仓库内所有 `.md` 路径（用于发现日记、打点与统计）。 */
  files: string[];
  notice: (message: string, kind?: "info" | "error") => void;
  /**
   * 用户**手动**改动了待办（增删勾选、顺延）后调用。
   *
   * 待办不落盘，没有文件事件，同步引擎只能靠这个信号入队推送。
   * 刻意**不**在"云端快照合并进本地"时调用：那条路径的推送由同步引擎自己按
   * "本地是否因此改变"决定，而且新设备首次同步时若在这里推一次，会把云端已有的
   * 待办覆盖成空的（本地还没有那份数据）。
   */
  onTodosChanged?: () => void;
}): DailyController {
  const { vault, files, notice, onTodosChanged } = options;

  const [state, setState] = useState<DailyConfigState | null>(null);
  const [todayWords, setTodayWords] = useState<number | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  /** 递增它来强制重读库内配置（配置文件被外部修正后重试）。 */
  const [reloadToken, setReloadToken] = useState(0);

  // 事件回调与异步落盘里要读最新值，又不想到处重订阅，所以用 ref 镜像
  // （与 App 里处理当前笔记的方式一致）。
  const stateRef = useRef<DailyConfigState | null>(null);
  const vaultRef = useRef<string | null>(null);
  /** 我们已知的磁盘内容哈希：用它把自己写入产生的监听回声认出来。 */
  const shaRef = useRef<string | null>(null);
  const pendingRef = useRef<DailyConfigUpdate>({});
  const timerRef = useRef<number | null>(null);
  const noticeRef = useRef(notice);
  const todosChangedRef = useRef(onTodosChanged);

  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);

  useEffect(() => {
    todosChangedRef.current = onTodosChanged;
  }, [onTodosChanged]);

  const settings = state?.settings ?? NO_SETTINGS;
  const dateFormat = dateFormatOf(settings.dateFormat);
  const today = moment().format(dateFormat);

  /** 日记目录下**直接**子文件里的 md（打点与统计只看这一层，与插件一致）。 */
  const folderFiles = useMemo(() => dailyFolderFiles(files, settings), [files, settings]);
  const dateSet = useMemo(() => diaryDateSet(folderFiles), [folderFiles]);
  const weeklySet = useMemo(() => weeklyKeySet(folderFiles), [folderFiles]);

  const dailyNoteOn = useCallback(
    (dateStr: string) => findDailyNote(folderFiles, dateStr),
    [folderFiles],
  );
  const dailyNotesFor = useCallback(
    (dateStr: string) => dailyNotesOn(folderFiles, dateStr),
    [folderFiles],
  );
  const weeklyNotesFor = useCallback(
    (weekKey: string) => weeklyNotesIn(folderFiles, weekKey),
    [folderFiles],
  );

  // ------------------------------------------------------------------ 读取

  useEffect(() => {
    vaultRef.current = vault;
    stateRef.current = null;
    shaRef.current = null;
    pendingRef.current = {};
    setState(null);
    setConfigError(null);
    setTodayWords(null);
    if (!vault) return;

    let cancelled = false;
    readNoteOptional(vault, DAILY_CONFIG_FILE)
      .then((note) => {
        if (cancelled) return;
        const next = parseDailyConfig(note?.content ?? null);
        shaRef.current = note?.sha256 ?? null;
        stateRef.current = next;
        setState(next);
        setSelectedDate(moment().format(dateFormatOf(next.settings.dateFormat)));
        if (next.broken) {
          setConfigError(
            `${DAILY_CONFIG_FILE} 不是一个合法的配置对象，已按默认值显示；改动不会写回，以免覆盖插件里的设置。`,
          );
        } else if (next.repaired > 0) {
          noticeRef.current(`已升级 ${next.repaired} 条旧格式待办（补齐 id 与修改时间）`);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        // 读不出来也要让日历可用：按默认值走，并把问题说出来。
        const fallback = parseDailyConfig(null);
        stateRef.current = fallback;
        setState(fallback);
        setSelectedDate(moment().format(dateFormatOf(fallback.settings.dateFormat)));
        setConfigError(`读取 ${DAILY_CONFIG_FILE} 失败：${e}`);
      });

    return () => {
      cancelled = true;
    };
  }, [vault, reloadToken]);

  // ------------------------------------------------------------------ 落盘

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const target = vaultRef.current;
    const current = stateRef.current;
    const update = pendingRef.current;
    pendingRef.current = {};
    if (!target || !current || Object.keys(update).length === 0) return;

    if (current.broken) {
      setConfigError(`${DAILY_CONFIG_FILE} 无法解析，改动没有写回`);
      return;
    }

    const text = serializeDailyConfig(current, update);
    try {
      const result = await writeNote(target, DAILY_CONFIG_FILE, text, false);
      shaRef.current = result.sha256;
      // 写回后重新解析：内存状态必须与磁盘逐字段一致，否则下一次基于内存状态的
      // 补丁会把这次没写进去的字段弄丢。
      const next = parseDailyConfig(text);
      stateRef.current = next;
      setState(next);
      setConfigError(null);
    } catch (e) {
      // 内存里保留用户的改动（界面不为一次写盘失败回退），并用横幅明确告知。
      // 下一次任何改动都会把我们管的那几个字段整份重写，因此是自愈的。
      setConfigError(`写入 ${DAILY_CONFIG_FILE} 失败：${e}`);
    }
  }, []);

  /** 把一次改动同时应用到内存与磁盘。`delay > 0` 时合并连续改动后再落盘。 */
  const apply = useCallback(
    (update: DailyConfigUpdate, delay: number) => {
      const current = stateRef.current;
      if (!current) return;
      if (current.broken) {
        setConfigError(`${DAILY_CONFIG_FILE} 无法解析，改动没有生效`);
        return;
      }
      const next = parseDailyConfig(serializeDailyConfig(current, update));
      stateRef.current = next;
      setState(next);
      pendingRef.current = { ...pendingRef.current, ...update };
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flush(), delay);
    },
    [flush],
  );

  const updateSettings = useCallback(
    (patch: Partial<DailySettings>) => {
      const current = stateRef.current;
      if (!current) return;
      apply({ settings: { ...current.settings, ...patch } }, SETTINGS_DEBOUNCE);
    },
    [apply],
  );

  // ------------------------------------------------------------------ 待办

  /**
   * 改待办并落盘。
   *
   * 待办改动**不走防抖**：勾选是明确的用户动作，丢一次就是丢一条记录，
   * 没有理由为了少写几个字节冒这个风险。设置输入框那种连续键入才需要防抖。
   */
  const mutateTodos = useCallback(
    (dateStr: string, mutate: (items: TodoItem[]) => TodoItem[]) => {
      const current = stateRef.current;
      if (!current) return;
      const todos: TodoMap = {
        ...current.todos,
        [dateStr]: mutate(current.todos[dateStr] ?? []),
      };
      apply({ todos, todosUpdatedAt: Date.now() }, 0);
      // 待办不落盘、没有文件事件，得主动告诉同步引擎"该推了"
      todosChangedRef.current?.();
    },
    [apply],
  );

  const addTodo = useCallback(
    (dateStr: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const now = Date.now();
      mutateTodos(dateStr, (items) => [
        ...items,
        { id: newTodoId(), text: trimmed, done: false, updatedAt: now },
      ]);
    },
    [mutateTodos],
  );

  const toggleTodo = useCallback(
    (dateStr: string, index: number) => {
      mutateTodos(dateStr, (items) =>
        items.map((item, position) =>
          position === index ? { ...item, done: !item.done, updatedAt: Date.now() } : item,
        ),
      );
    },
    [mutateTodos],
  );

  /**
   * 删除待办：**打墓碑，不是物理移除**。
   *
   * 直接从数组里删掉，另一台设备合并时看不到这条，会把它当成"云端新增"又加回来。
   * 墓碑不参与渲染（`liveItems` 会滤掉），由同步侧在 30 天后清理。
   */
  const deleteTodo = useCallback(
    (dateStr: string, index: number) => {
      mutateTodos(dateStr, (items) =>
        items.map((item, position) =>
          position === index ? { ...item, deleted: true, updatedAt: Date.now() } : item,
        ),
      );
    },
    [mutateTodos],
  );

  const moveTodo = useCallback(
    (fromDate: string, toDate: string) => {
      const current = stateRef.current;
      if (!current) return 0;
      const result = carryOver(
        current.todos[fromDate],
        current.todos[toDate],
        fromDate,
        dateFormatOf(current.settings.dateFormat),
        Date.now(),
      );
      if (result.moved === 0) return 0;
      apply(
        {
          todos: { ...current.todos, [fromDate]: result.from, [toDate]: result.to },
          todosUpdatedAt: Date.now(),
        },
        0,
      );
      todosChangedRef.current?.();
      return result.moved;
    },
    [apply],
  );

  // ------------------------------------------------------------- 字数统计

  /**
   * 今日字数。
   *
   * 依赖 `files` 的数组身份：每次文件树刷新（保存后、外部改动）都会重读一次今日
   * 日记。一次小文件读取换回"字数跟着编辑走"，这个代价是划算的。
   */
  const todayNote = findDailyNote(folderFiles, today);
  useEffect(() => {
    if (!vault || !todayNote) {
      setTodayWords(null);
      return;
    }
    let cancelled = false;
    readNoteOptional(vault, todayNote)
      .then((note) => {
        if (!cancelled) setTodayWords(note ? wordCount(note.content) : null);
      })
      .catch(() => {
        if (!cancelled) setTodayWords(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vault, todayNote, files]);

  // ------------------------------------------------------------------ 监听

  const handleVaultChange = useCallback(async (paths: string[]) => {
    const target = vaultRef.current;
    if (!target || !paths.includes(DAILY_CONFIG_FILE)) return;
    try {
      const note = await readNoteOptional(target, DAILY_CONFIG_FILE);
      if (!note) return;
      // 哈希一致 → 就是自己刚写完的那次，忽略。
      // 不区分的话，每次改待办都会触发一次"已跟随外部改动"的自问自答。
      if (note.sha256 === shaRef.current) return;
      const next = parseDailyConfig(note.content);
      shaRef.current = note.sha256;
      stateRef.current = next;
      setState(next);
      if (next.broken) {
        setConfigError(`${DAILY_CONFIG_FILE} 无法解析，已按默认值显示，改动不会写回`);
      } else {
        setConfigError(null);
        noticeRef.current("已跟随外部改动：日记配置与待办");
      }
    } catch (e) {
      setConfigError(`读取 ${DAILY_CONFIG_FILE} 失败：${e}`);
    }
  }, []);

  // ------------------------------------------------------------------ 同步

  /**
   * 待办的云端快照。
   *
   * `updatedAt` 用 `todosUpdatedAt`（待办最后一次真正改动的时间）而不是当前时间：
   * 它是快照内容的一部分，跟着当前时间走会让哈希每轮都变。
   */
  const todoSnapshot = useCallback(
    () => buildSnapshot(stateRef.current?.todos ?? {}, stateRef.current?.todosUpdatedAt ?? 0),
    [],
  );

  /**
   * 把云端快照并进本地待办，返回是否产生了改动。
   *
   * 走 `apply(..., 0)` 而不是直接改 state：合并结果与手动勾选是同一种变更，
   * 必须同一条落盘路径——否则会出现"界面变了、磁盘没变"，下次同步又把它推回去。
   */
  const mergeTodoSnapshot = useCallback(
    (content: string): boolean => {
      const current = stateRef.current;
      if (!current || current.broken) return false;
      const merged = mergeRemoteTodoSnapshot(content, current.todos);
      if (!merged || !merged.changed) return false;
      // 与插件一致：整份替换成合并结果（墓碑不进结果，由快照自己带 30 天）
      apply({ todos: merged.todos, todosUpdatedAt: Date.now() }, 0);
      return true;
    },
    [apply],
  );

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  return {
    ready: state !== null,
    settings,
    dateFormat,
    today,
    todos: state?.todos ?? {},
    selectedDate,
    folderFiles,
    dateSet,
    weeklySet,
    dailyNoteOn,
    dailyNotesOn: dailyNotesFor,
    weeklyNotesIn: weeklyNotesFor,
    todayWords,
    configError,
    reload,
    setSelectedDate,
    updateSettings,
    addTodo,
    toggleTodo,
    deleteTodo,
    moveTodo,
    handleVaultChange,
    todoSnapshot,
    mergeTodoSnapshot,
  };
}

/**
 * 云同步在界面侧的状态与生命周期。
 *
 * ## 为什么同步状态存在**应用配置目录的文件**里，而不是 localStorage
 *
 * 游标与各文件哈希是"这台设备看到过什么"的记录。localStorage 会被 WebView 的数据目录
 * 清理（换 identifier、清缓存、重装）一起抹掉；那时每篇笔记都会被判成"本地改过"，
 * 与云端撞成一片冲突。放成一个文件更经得起折腾，用户也能直接看、直接备份。
 *
 * 还有一条更硬的理由：**服务端密码与 refreshToken 在里面**。它们只能留在设备本地，
 * 绝不能进仓库（那会被同步出去，也能被别的设备覆盖）。
 *
 * ## 配置与状态同源
 *
 * 服务端地址、账号、开关、范围、仓库名与游标/哈希放在**同一份状态**里（与插件的
 * data.json 一致）。分成两处就得处理"配置改了但状态没跟上"这类同步问题，
 * 而它们本来就是一起读写的。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { syncStateLoad, syncStateSave } from "./api.ts";
import {
  DEFAULT_SYNC_STATE,
  adaptStateToVault,
  defaultVaultName,
  normalizeSyncState,
  type SyncDeviceState,
  type SyncStatusKind,
} from "./sync.ts";
import { SyncEngine, type SyncHost } from "./syncEngine.ts";
import { TODO_SYNC_PATH } from "./todos.ts";

/** 提示消息的类型（与编辑器的提示通道对齐）。 */
type Notice = (message: string, kind?: "info" | "error") => void;

export interface SyncController {
  /** 同步状态已从磁盘读出（或按默认值兜底）。 */
  ready: boolean;
  /** 用户可改的部分（服务端地址、账号、开关、范围、仓库名）。 */
  config: SyncConfig;
  /** 生效的云端仓库名（config.vaultName 为空时取仓库文件夹名）。 */
  vaultName: string;
  status: SyncStatusKind;
  /** 状态栏用的错因（账号密码错误、网络失败等）。 */
  error: string | null;
  /** 上次成功同步的时间（ms），0 表示从未。 */
  lastSyncAt: number;
  /** 最近一次同步里"本地胜出"的冲突文件。 */
  conflicts: string[];
  /** 读到状态文件失败时的原因（此时按默认值走，改动不会写回）。 */
  stateError: string | null;
  /** 状态**落盘**失败的原因（只警告，同步继续）。 */
  saveError: string | null;
  /** 关掉落盘失败的警告。 */
  dismissSaveError: () => void;
  updateConfig: (patch: Partial<SyncConfig>) => void;
  /** 立即同步一次（设置里改完、或用户点状态栏）。 */
  syncNow: () => void;
  /** 重置游标并全量拉取（自愈入口）。 */
  resetCursorAndSync: () => void;
  /**
   * 丢弃本机同步状态重新开始（游标归零、哈希清空）。
   * 状态文件损坏时用它——那是唯一的出路，详见实现处的说明。
   */
  resetState: () => void;
  /** 从磁盘重读同步状态（读取失败多半是暂时的，不该逼用户清空状态）。 */
  reloadState: () => void;
  /** 关掉冲突横幅（本地版本已经推上去了，这条只是告知）。 */
  dismissConflicts: () => void;
  /** 文件变化通知（App 收到 `vault-changed` 时转发）。 */
  handleVaultChange: (paths: string[]) => void;
  /** 待办发生变化后通知（待办不落盘，没有文件事件）。 */
  touchVirtual: () => void;
}

/** 用户可见的同步配置。 */
export interface SyncConfig {
  serverUrl: string;
  username: string;
  password: string;
  enabled: boolean;
  scope: "folder" | "vault";
  /** 云端仓库名；留空即用仓库文件夹名（与 Obsidian 的 `vault.getName()` 一致）。 */
  vaultName: string;
}

export function useSync(options: {
  vault: string | null;
  /** 日记目录（`scope=folder` 时的推送前缀）。 */
  folder: string;
  /** 待办的云端快照（内容稳定，见 `useDaily.todoSnapshot`）。 */
  todoSnapshot: () => string;
  /** 把云端快照并进本地待办；返回是否有改动。 */
  mergeTodoSnapshot: (content: string) => boolean;
  /** 不参与同步的文件（仓库相对路径）。背景图这类纯观感文件由此排除。 */
  excludedSyncPaths?: () => string[];
  notice: Notice;
}): SyncController {
  const { vault, folder, todoSnapshot, mergeTodoSnapshot, excludedSyncPaths, notice } = options;

  const excludedPathsRef = useRef(excludedSyncPaths ?? (() => []));
  useEffect(() => {
    excludedPathsRef.current = excludedSyncPaths ?? (() => []);
  }, [excludedSyncPaths]);

  const [state, setState] = useState<SyncDeviceState>(() => ({ ...DEFAULT_SYNC_STATE }));
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SyncStatusKind>("off");
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState(0);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [stateError, setStateError] = useState<string | null>(null);
  /** 状态**落盘**失败（盘满、权限）。它只警告，不停同步——状态还在内存里，同步照跑。 */
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * 两个计数器，职责必须分开：
   *
   * - `reloadToken`：**从磁盘重读**状态（状态文件损坏被修好后重试）。
   * - `engineToken`：只**重建引擎**，不动内存里的状态（改配置、重置状态）。
   *
   * 早先把它们合成一个，结果是：改一个配置项 → 重读磁盘 → 而那时改动还在 300ms 的
   * 落盘防抖窗口里 → 把刚填的地址与账号又读回成空。表现为"点上开关没反应，
   * 点立即同步说请先填写服务端地址"，查起来像界面没接上。
   */
  const [reloadToken, setReloadToken] = useState(0);
  const [engineToken, setEngineToken] = useState(0);

  /** 引擎与各项回调都要读到最新值，又不想到处重订阅，所以用 ref 镜像。 */
  const stateRef = useRef<SyncDeviceState>(state);
  const engineRef = useRef<SyncEngine | null>(null);
  const vaultRef = useRef<string | null>(null);
  const folderRef = useRef(folder);
  const todoSnapshotRef = useRef(todoSnapshot);
  const mergeRef = useRef(mergeTodoSnapshot);
  const noticeRef = useRef(notice);
  /** 待处理的落盘（合并连续改动）。 */
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    folderRef.current = folder;
  }, [folder]);
  useEffect(() => {
    todoSnapshotRef.current = todoSnapshot;
  }, [todoSnapshot]);
  useEffect(() => {
    mergeRef.current = mergeTodoSnapshot;
  }, [mergeTodoSnapshot]);
  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);

  /** 状态落盘。合并 300ms 内的连续改动——同步一轮可能更新几十个文件的哈希。 */
  const persist = useCallback(async (next: SyncDeviceState) => {
    stateRef.current = next;
    setState({ ...next });
    setLastSyncAt(next.lastSyncAt);
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const snapshot = stateRef.current;
      void syncStateSave(JSON.stringify(snapshot, null, 2)).then(
        () => setSaveError(null),
        // 只警告，**不停同步**（engineToken 与 stateError 都不动）：
        // 游标与哈希还在内存里，这一轮同步是有效的，只是重启后会退回上次落盘的状态
        // ——那是"多拉一次"的代价，比"写到一半就不同步了"轻得多。
        (e) => setSaveError(`保存同步状态失败：${e}`),
      );
    }, 300);
  }, []);

  // ------------------------------------------------------------------ 读状态

  useEffect(() => {
    vaultRef.current = vault;
    engineRef.current?.destroy();
    engineRef.current = null;
    setReady(false);
    setStatus("off");
    setError(null);
    setConflicts([]);
    setLastSyncAt(0);
    setStateError(null);
    if (!vault) return;

    let cancelled = false;
    syncStateLoad()
      .then((text) => {
        if (cancelled) return;
        let next = { ...DEFAULT_SYNC_STATE };
        if (text) {
          try {
            // 换过仓库就丢掉游标与哈希：它们是"我在这个仓库里看到过什么"的记录，
            // 带到另一个仓库会把同名文件误判成本地改动或云端删除。
            next = adaptStateToVault(
              normalizeSyncState(JSON.parse(text) as Partial<SyncDeviceState>),
              vault,
            );
          } catch (e) {
            // 状态文件坏了不能静默按默认值继续：那样游标归零会被当成"全新设备"，
            // 把库里的文件当成本地新增全推一遍。宁可停下来让用户决定。
            setStateError(`同步状态文件无法解析（${e}）。已暂停同步，可点「重置同步状态」重新开始。`);
            stateRef.current = next;
            setState(next);
            setReady(true);
            return;
          }
        } else {
          next = { ...next, vault };
        }
        stateRef.current = next;
        setState(next);
        setLastSyncAt(next.lastSyncAt);
        setReady(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setStateError(`读取同步状态失败：${e}`);
        setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [vault, reloadToken]);

  // ------------------------------------------------------------------ 引擎

  useEffect(() => {
    const target = vault;
    if (!target || !ready || stateError) return;

    const host: SyncHost = {
      getFolder: () => folderRef.current,
      getVaultName: () => {
        const configured = stateRef.current.vaultName.trim();
        return configured !== "" ? configured : defaultVaultName(target);
      },
      excludedSyncPaths: () => excludedPathsRef.current(),
      getVirtualFiles: () => ({ [TODO_SYNC_PATH]: todoSnapshotRef.current() }),
      mergeVirtualFile: (_path, content) => mergeRef.current(content),
      onStatus: (kind, detail) => {
        setStatus(kind);
        setError(detail ?? null);
      },
      onNotice: (message, kind) => noticeRef.current(message, kind),
      onConflicts: (files) => setConflicts(files.slice(0, 5)),
      persist,
    };

    const engine = new SyncEngine(target, stateRef.current, host);
    engineRef.current = engine;
    engine.start();
    engine.beginStartupSync();

    return () => {
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [vault, ready, stateError, engineToken, persist]);

  // ------------------------------------------------------------------ 对外

  const updateConfig = useCallback(
    (patch: Partial<SyncConfig>) => {
      // 状态对象在这里被整个换掉，所以引擎必须跟着重建——它还攥着旧对象，
      // 而它写回的游标与哈希要落在同一个对象上，否则会被下一次 persist 覆盖掉。
      void persist({ ...stateRef.current, ...patch });
      setEngineToken((value) => value + 1);
    },
    [persist],
  );

  const syncNow = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) {
      noticeRef.current("云同步：请先选择仓库", "error");
      return;
    }
    void engine.syncNow("manual");
  }, []);

  const resetCursorAndSync = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.resetCursorAndSync();
  }, []);

  /**
   * 丢弃本机同步状态，从头再来（游标归零、哈希清空）。
   *
   * 状态文件损坏时唯一的出路，所以必须给出来：损坏时我们**不**默默按默认值继续
   * ——游标归零会被服务端当成"全新设备"，把本地文件当新增全推一遍，那是把一次读取
   * 失败放大成一次全库覆盖。用户确认后手动重置，才是知情的选择。
   */
  const resetState = useCallback(() => {
    setStateError(null);
    setSaveError(null);
    // 记下当前仓库：游标与哈希本来就是空的，vault 必须写上，否则下次启动会被当成"换了仓库"
    void persist(adaptStateToVault({ ...DEFAULT_SYNC_STATE }, vaultRef.current ?? ""));
    // 不走 reloadToken：内存里这一份就是全新的默认状态，再去读一遍磁盘只会读到
    // 那份坏文件（落盘还在防抖窗口里）
    setEngineToken((value) => value + 1);
  }, [persist]);

  /** 从磁盘重读状态（读取失败是暂时的——文件被锁、盘刚挂上——就不该逼用户清空状态）。 */
  const reloadState = useCallback(() => setReloadToken((value) => value + 1), []);

  const dismissConflicts = useCallback(() => setConflicts([]), []);
  const dismissSaveError = useCallback(() => setSaveError(null), []);

  const handleVaultChange = useCallback((paths: string[]) => {
    engineRef.current?.touchPaths(paths);
  }, []);

  const touchVirtual = useCallback(() => {
    engineRef.current?.touchVirtual();
  }, []);

  const vaultName = useMemo(
    () => (state.vaultName.trim() !== "" ? state.vaultName.trim() : defaultVaultName(vault ?? "")),
    [state.vaultName, vault],
  );

  const config = useMemo<SyncConfig>(
    () => ({
      serverUrl: state.serverUrl,
      username: state.username,
      password: state.password,
      enabled: state.enabled,
      scope: state.scope,
      vaultName: state.vaultName,
    }),
    [state],
  );

  return {
    ready,
    config,
    vaultName,
    status,
    error,
    lastSyncAt,
    conflicts,
    stateError,
    saveError,
    updateConfig,
    syncNow,
    resetCursorAndSync,
    resetState,
    reloadState,
    dismissConflicts,
    dismissSaveError,
    handleVaultChange,
    touchVirtual,
  };
}

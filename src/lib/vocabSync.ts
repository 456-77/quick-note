/**
 * 单词本的账户级云同步（0.29 用户反馈：daily sync 添加支持同步单词本）。
 *
 * 单词本 0.28 起就是**账户级**的（应用配置目录的 `vocabulary.md`，与仓库无关），
 * 所以它不挂在任何仓库的同步引擎上——那会把每份词库推到各仓库自己的云端 vault，
 * 账户级语义就没了。这里用 SyncEngine 的**纯虚拟模式**（`virtualOnly`）跑一个
 * 独立引擎：不扫本地文件、只同步一个虚拟路径，推拉都落在一个专用的云端仓库
 * `quick-note-vocab` 里（服务端按 (用户, 仓库名) 隐式创建，**无需新增端点**）。
 *
 * - 凭据来自账号级的共享同步配置（`sync-state.json` 薄文件）；游标与文件哈希
 *   存独立的 `sync-state-vocab.json`（复用 per-vault 状态文件的机制，多窗口
 *   互覆的代价只是多拉一轮，按词合并是幂等的）。
 * - **合并语义 = 只加新词**（同词保留本地条目，与 0.28 的旧库迁移同源）：
 *   云端拉回来的词并进本地，合并结果回推。删除不跨设备传播——这是刻意的：
 *   单词本没有墓碑机制，union 合并保证任何一端的词永远不会被同步弄丢。
 * - 触发点：本机改词（saveVocabularyContent → 落盘监听 → 防抖推送）、启动
 *   首同步、5 分钟周期轮、状态栏「立即同步」。开关跟随当前仓库的同步开关
 *   （同步整体关着时，这个窗口不再为单词本跑引擎；别的窗口开着就归它们管）。
 *
 * 与笔记同步的状态/横幅完全隔离：不产生冲突面板（虚拟合并不会冲突）、不进
 * 状态栏状态机，错误走同一条 notice 通道（引擎自带同错去重）。
 */

import {
  readAppText,
  syncStateLoad,
  syncStateLoadFor,
  syncStateSaveFor,
} from "./api.ts";
import { DEFAULT_SYNC_STATE, normalizeSyncState, type SyncDeviceState } from "./sync.ts";
import { SyncEngine, type SyncHost } from "./syncEngine.ts";
import { VOCAB_GLOBAL_FILE, onVocabSaved, saveVocabularyContent } from "./vocabStore.ts";
import { mergeVocabulary } from "./vocabulary.ts";

/** 单词本专用的云端仓库名（服务端隐式创建；与任何笔记仓库隔离）。 */
export const VOCAB_SYNC_VAULT = "quick-note-vocab";
/** 词库在云端仓库里的路径（服务端要求 .md/.json 后缀）。 */
export const VOCAB_SYNC_PATH = "vocabulary.md";
/** 本机同步状态文件键（→ sync-state-vocab.json）。 */
const VOCAB_STATE_KEY = "vocab";

type Notice = (message: string, kind?: "info" | "error") => void;

let engine: SyncEngine | null = null;
/** 内存中的最新词库内容（推送与合并的基底；落盘监听与远端合并共同维护）。 */
let contentCache: string | null = null;
let noticeRef: Notice = () => {};
let enabled = false;
/** 当前引擎用的凭据指纹：账号配置改了就重建引擎（引擎构造时攥死状态对象）。 */
let credentialsKey = "";
/** 防止 enable 抖动期间并发启动两个引擎。 */
let starting: Promise<void> | null = null;
/** 远端合并改动了本地词库后的界面回调（App 用来刷新单词面板）。 */
const remoteListeners = new Set<() => void>();

/** 订阅「云端词库合并进了本地」事件（返回退订函数）。 */
export function onVocabRemoteChange(listener: () => void): () => void {
  remoteListeners.add(listener);
  return () => {
    remoteListeners.delete(listener);
  };
}

/**
 * 设置单词本同步的启停。`enabled` 由 App 按账号配置与当前仓库的同步开关算出；
 * `key` 是凭据指纹（服务端地址+账号+密码）——指纹变了说明用户改了账号配置，
 * 引擎要重建才拿得到新凭据。重复传入相同组合是安全的（生命周期不抖动）。
 */
export function setVocabSyncEnabled(next: boolean, notice: Notice, key = ""): void {
  noticeRef = notice;
  if (next === enabled && key === credentialsKey && (engine !== null || !next)) return;
  enabled = next;
  credentialsKey = key;
  if (engine) {
    engine.destroy();
    engine = null;
  }
  if (next) void ensureEngine();
}

/** 立即同步一轮（状态栏「立即同步」、设置页共用）。 */
export function syncVocabNow(): void {
  if (engine && enabled) void engine.syncNow("manual");
}

/** 本机词库变化后的推送触发（vocabStore 落盘监听转发）。 */
function touchFromLocalSave(content: string): void {
  contentCache = content;
  if (engine && enabled) engine.touchVirtual();
}

async function ensureEngine(): Promise<void> {
  if (engine || starting) return;
  starting = (async () => {
    try {
      // 账号级凭据在共享薄配置里；没配账号就静默不启（单词本继续当本机文件用）
      const sharedRaw = await syncStateLoad().catch(() => null);
      let shared: SyncDeviceState | null = null;
      if (sharedRaw) {
        try {
          shared = normalizeSyncState(JSON.parse(sharedRaw) as Partial<SyncDeviceState>);
        } catch {
          shared = null;
        }
      }
      if (!shared || !shared.serverUrl || !shared.username || !shared.password) return;

      // 自己的游标/哈希/refreshToken；凭据永远以共享配置为准
      let state = { ...DEFAULT_SYNC_STATE };
      const ownRaw = await syncStateLoadFor(VOCAB_STATE_KEY).catch(() => null);
      if (ownRaw) {
        try {
          state = normalizeSyncState(JSON.parse(ownRaw) as Partial<SyncDeviceState>);
        } catch {
          state = { ...DEFAULT_SYNC_STATE };
        }
      }
      state.serverUrl = shared.serverUrl;
      state.username = shared.username;
      state.password = shared.password;
      if (!state.refreshToken) state.refreshToken = shared.refreshToken;
      state.enabled = true; // 启停由本模块的门闸管，不靠 state.enabled
      state.vault = "";
      state.vaultName = "";

      // 内容缓存：先把磁盘上的现值读进来，之后由落盘监听维护
      const disk = await readAppText(VOCAB_GLOBAL_FILE).catch(() => null);
      if (disk !== null) contentCache = disk;

      const host: SyncHost = {
        getFolder: () => "",
        getVaultName: () => VOCAB_SYNC_VAULT,
        excludedSyncPaths: () => [],
        getVirtualFiles: () =>
          (contentCache !== null ? { [VOCAB_SYNC_PATH]: contentCache } : {}) as Record<string, string>,
        mergeVirtualFile: (_path, incoming) => mergeFromRemote(incoming),
        onStatus: () => {},
        onNotice: (message, kind) => noticeRef(message, kind),
        onConflicts: () => {},
        persist: (next) =>
          syncStateSaveFor(VOCAB_STATE_KEY, JSON.stringify(next, null, 2)).then(
            () => {},
            () => {}, // 状态写不上只影响下轮游标，同步照跑
          ),
      };

      const instance = new SyncEngine("", state, host, { virtualOnly: true });
      instance.start();
      instance.beginStartupSync();
      // 启动是异步的：期间被停用就直接销毁，别把引擎留在门外
      if (!enabled) {
        instance.destroy();
        return;
      }
      engine = instance;
    } finally {
      starting = null;
    }
  })();
  await starting;
}

/** 远端内容并进本地：只加新词，合并结果落盘并回推（返回 true 引擎才回推）。 */
function mergeFromRemote(incoming: string): boolean {
  const base = contentCache ?? "";
  const merged = mergeVocabulary(base, incoming);
  if (merged === base) return false;
  contentCache = merged;
  void saveVocabularyContent(merged).catch(() => {});
  for (const listener of [...remoteListeners]) {
    try {
      listener();
    } catch {
      // 界面刷新失败不影响同步
    }
  }
  return true;
}

// 模块级订阅：本机任何一次词库落盘（编辑/迁移合并）都刷新缓存并排推送
onVocabSaved((content) => touchFromLocalSave(content));

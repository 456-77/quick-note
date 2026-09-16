/**
 * 云同步（daily-sync 服务）的编排层：扫描 → 拉取应用 → 推送。
 *
 * 这是对 Obsidian 插件 `sync.ts` 的移植，协议与阈值逐条对齐。**纯逻辑**（状态形状、
 * 范围判定、冲突决策、URL 归一化）在 `sync.ts` 里，这里只做"读盘/写盘/发请求"的编排
 * ——于是冲突策略那部分能在 Node 里逐分支断言，而编排层由 `scripts/gui-sync.mjs`
 * 用真实应用 + 桩后端端到端验证。
 *
 * ## 协议要点（与后端 M2/M5.1/M7 对应）
 *
 * - 推送 `POST /api/v1/sync?vault=`：批量幂等上传（≤200 条/批，单条 ≤1MB）。
 * - 拉取 `GET /api/v1/sync?vault=&since=&limit=`：按**仓库版本号**增量；
 *   游标是版本号而不是时间戳，`hasMore` 时用"末条 version - 1"翻页并按 path 去重。
 * - 删除以墓碑（`deleted=true`）下发。
 * - 鉴权：账号密码换 accessToken（JWT，约 2 小时），请求带 `Authorization: Bearer`；
 *   401 时先用 refreshToken 换新对（一次性轮换），refresh 也失效才重新登录。
 * - 仓库名：服务端按 `(用户, 仓库名)` 定位，不存在自动创建。
 *
 * ## 与插件的两处实现差异（都不改变协议）
 *
 * 1. **HTTP 在 Rust 侧**：后端没有 CORS 响应头，渲染进程的 `fetch` 发不出去；
 *    而且账号密码与 JWT 不该放在页面脚本能直接读到的地方。走 `api.httpRequest`。
 * 2. **文件操作走 M1 的仓库命令**（`readNote` / `writeNote` / `listEntries`），
 *    因此附带一个明确的收获：**写盘仍是字节精确的**——观测到的 BOM 原样补回，
 *    写入前比较内容、一致则不触碰文件（不刷 mtime）。插件的 `vault.modify` 会把
 *    BOM 丢掉。
 *
 * ## 附件的同步策略（与插件一致）
 *
 * 附件走独立的字节接口（`/api/v1/sync/attachments`，一条一个请求）：
 *
 * - **按引用扫，不按目录扫**：只同步被范围内笔记引用到的附件。粘贴图片的落点取决于
 *   用户配置，盯目录必然漏；按引用扫与落点无关。没被引用的图片不上云——不镜像无用的
 *   二进制。引用的解析（名字 → 路径，同目录优先 → 最短路径 → 字典序）在 Rust 侧完成，
 *   与服务端 `AttachmentService.resolveByName` 同一套顺序。
 * - **本地缺的图按文件名去云端补**。本地没有这个文件时引用是解析不到的，所以"本地缺图"
 *   恰好只会表现为"引用得到名字、找不到文件"；按名去问，服务端用 `X-Attachment-Path`
 *   回真实路径——必须落到那个路径上，否则下一轮扫描会把它当成另一个附件重复上传。
 * - 上传与下载都有每轮上限（条数 + 字节），被推迟的下一轮由引用重新推导出来继续，不会漏。
 * - 同步过、但现在既没被引用、本地也没了的附件推墓碑；只删引用、文件还留着的不推——
 *   云端那份留着更保守，用户日后重新引用无需重传。
 */

import {
  deleteEntry,
  httpRequest,
  listEntries,
  readBinary,
  readNoteOptional,
  syncScan,
  syncScanAttachments,
  writeBinary,
  writeNote,
  type HttpResponse,
} from "./api.ts";
import { TODO_SYNC_PATH } from "./todos.ts";
import { sha256Hex } from "./hash.ts";
import {
  MAX_BATCH,
  MAX_ATTACHMENT_BYTES,
  MAX_CONTENT_CHARS,
  MAX_PATH_CHARS,
  PULL_LIMIT,
  PUSH_DEBOUNCE_MS,
  STARTUP_DELAY_MS,
  SYNC_INTERVAL_MS,
  DownloadBudget,
  attachmentStamp,
  baseUrl,
  conflictLabel,
  decideRecord,
  headerValue,
  inScope,
  isAttachmentPath,
  type SyncDeviceState,
  type SyncStatusKind,
} from "./sync.ts";

/** 拉取返回的正文记录。 */
interface RemoteRecord {
  path: string;
  content: string;
  deleted: boolean;
  version: number;
}

/** 拉取返回的附件元数据（与正文共用同一条 version 游标）。 */
interface RemoteAttachment {
  path: string;
  name: string;
  sha256: string;
  size: number;
  deleted: boolean;
  version: number;
}

/** 附件的待处理操作：`mod` 上传/覆盖、`del` 墓碑、`get` 从云端补下本地缺的那个。 */
type AttachmentOp = "mod" | "del" | "get";

/** 附件在客户端的真名（AuthError 等），与服务端 404 的预期区分开。 */
class AttachmentMissingError extends Error {}

interface SyncPullData {
  vaultVersion: number;
  hasMore: boolean;
  records: RemoteRecord[];
  /** 老版本服务端可能不带这个字段。 */
  attachments?: RemoteAttachment[];
}

interface TokenPairData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** 401：账号密码被拒，或 refresh 失效且登录失败。**不要**当成网络错误反复重试。 */
export class SyncAuthError extends Error {
  constructor() {
    super("账号或密码错误");
    this.name = "SyncAuthError";
  }
}

export interface SyncHost {
  /** 日记文件夹（`scope=folder` 时的推送前缀）。 */
  getFolder(): string;
  /** 云端仓库名。 */
  getVaultName(): string;
  /**
   * 需要同步但**不在库内落盘**的内容（路径 -> 文本），目前只有待办快照。
   * 这些路径不写文件：内容由宿主维护，云端拉回来的交给 {@link mergeVirtualFile}。
   */
  getVirtualFiles(): Record<string, string>;
  /**
   * 云端虚拟文件内容回流：由宿主并进自己的数据，
   * 返回 `true` 表示本地因此有改动、需要回推（双向同步的关键一步）。
   */
  mergeVirtualFile(path: string, content: string): boolean;
  onStatus(kind: SyncStatusKind, detail?: string): void;
  /** 给用户看的消息。与编辑器的提示共用一条通道。 */
  onNotice(message: string, kind?: "info" | "error"): void;
  /** 冲突文件（本地胜的那些），同步结束时汇报一次。 */
  onConflicts(files: string[], at: number): void;
  /** 持久化同步状态（含游标与各文件哈希）。 */
  persist(state: SyncDeviceState): Promise<void>;
}

export class SyncEngine {
  private readonly vault: string;
  private readonly state: SyncDeviceState;
  private readonly host: SyncHost;

  private intervalId: number | null = null;
  private flushTimer: number | null = null;
  private startupTimer: number | null = null;
  private configTimer: number | null = null;

  /** 待推送队列：path -> 最新操作。 */
  private dirty = new Map<string, "mod" | "del">();
  /** 附件的待处理队列：path -> 操作（`get` 表示从云端补下本地缺的那个）。 */
  private dirtyAttachments = new Map<string, AttachmentOp>();
  /** 本周期「被引用但本地没有」的附件：文件名 -> 引用它的笔记路径。 */
  private missingAttachments = new Map<string, string>();
  /** 每轮附件下载的记账器。 */
  private downloadBudget = new DownloadBudget();
  /** 一个同步周期进行中（拉取+应用+推送整体互斥）。 */
  private syncing = false;
  /** 周期内又收到触发（如手动点了立即同步）：周期结束后补一轮。 */
  private rerun = false;
  private disposed = false;
  /** 错误提示去重：同一错误只提示一次，成功后复位。 */
  private lastErrorNotice = "";
  /** 内存中的 accessToken；丢了/过期就重新走 refresh → 登录。 */
  private accessToken: string | null = null;
  /** 本周期认定的虚拟文件路径（不落盘，应用时交给宿主合并）。 */
  private virtualPaths = new Set<string>();
  /** 已经报告过"无法同步"的文件，避免每个周期重复提示同一件事。 */
  private reportedSkips = new Set<string>();

  constructor(vault: string, state: SyncDeviceState, host: SyncHost) {
    this.vault = vault;
    this.state = state;
    this.host = host;
  }

  /** 服务端地址与账号密码都已配置。 */
  get configured(): boolean {
    return (
      this.state.serverUrl.trim() !== "" &&
      this.state.username.trim() !== "" &&
      this.state.password !== ""
    );
  }

  /** 注册周期定时器与启动首同步（应用就绪后调用）。 */
  start(): void {
    if (this.disposed) return;
    this.intervalId = window.setInterval(() => {
      if (this.state.enabled && this.configured) void this.syncNow("interval");
    }, SYNC_INTERVAL_MS);
    this.refreshStatus();
  }

  /**
   * 启动后延迟首同步。
   *
   * 延迟是必要的：刚开仓库时文件索引还在建、库内配置刚读进来，立刻同步会拿一份
   * 不完整的本地状态去比对，制造一堆虚假的"本地新增"。
   */
  beginStartupSync(): void {
    if (this.disposed || !this.state.enabled || !this.configured) return;
    this.startupTimer = window.setTimeout(() => {
      this.startupTimer = null;
      if (!this.disposed && this.state.enabled) void this.syncNow("startup");
    }, STARTUP_DELAY_MS);
  }

  /** 设置改了之后调用：防抖后做一次同步以验证连通性。 */
  onConfigChanged(): void {
    if (this.configTimer !== null) window.clearTimeout(this.configTimer);
    this.configTimer = window.setTimeout(() => {
      this.configTimer = null;
      if (this.disposed) return;
      if (this.state.enabled && this.configured) void this.syncNow("startup");
      else this.refreshStatus();
    }, 2500);
  }

  /** 重置游标并全量拉取（本地状态异常时的自愈入口）。 */
  resetCursorAndSync(): void {
    this.state.cursor = 0;
    void this.syncNow("manual");
  }

  /**
   * 仓库文件变了（来自编辑器保存或文件监听）。
   *
   * 这里**不需要**区分"是不是自己刚写的"：推送前会比内容哈希，一致就跳过。
   * 插件的 `applyingRemote` 计数器在那边是必要的（它的文件事件是同步回调，
   * 会把应用远端时的每一次写入再排进推送队列）；我们的事件经过 notify 与 250ms
   * 去抖，早已错过那个窗口，靠哈希判定反而更可靠——M1 处理"自己写入的回声"
   * 用的就是同一招。
   *
   * 附件（粘贴图片等）同样从这条路径入队：只排 `.md` 的话，粘贴图片要等到下一次
   * 手动同步或周期扫描才会上云——网页端在那几分钟里看到的是裂图。
   */
  touchPaths(paths: string[]): void {
    if (!this.state.enabled || !this.configured) return;
    let touched = false;
    for (const path of paths) {
      if (path.endsWith(".md") && inScope(path, this.state.scope, this.host.getFolder())) {
        this.dirty.set(path, "mod");
        touched = true;
      } else if (isAttachmentPath(path)) {
        this.dirtyAttachments.set(path, "mod");
        touched = true;
      }
    }
    if (touched) this.armFlushTimer();
  }

  /** 虚拟文件内容变化后调用（待办增删改）。它们不落盘，没有文件事件。 */
  touchVirtual(): void {
    if (!this.state.enabled || !this.configured) return;
    for (const path of Object.keys(this.host.getVirtualFiles())) {
      this.dirty.set(path, "mod");
    }
    this.armFlushTimer();
  }

  /** 卸载：清定时器，并尽力把未发出的变更推上去。 */
  destroy(): void {
    this.disposed = true;
    for (const [timer, clear] of [
      [this.intervalId, window.clearInterval],
      [this.flushTimer, window.clearTimeout],
      [this.startupTimer, window.clearTimeout],
      [this.configTimer, window.clearTimeout],
    ] as const) {
      if (timer !== null) clear(timer);
    }
    this.intervalId = null;
    this.flushTimer = null;
    this.startupTimer = null;
    this.configTimer = null;
    if (this.dirty.size > 0 && this.configured) void this.flushPushes();
  }

  /** 完整同步周期：扫描本地差异 → 拉取应用 → 推送本地变更。 */
  async syncNow(trigger: "manual" | "startup" | "interval" | "retry"): Promise<void> {
    if (this.disposed) return;
    if (!this.configured) {
      this.refreshStatus();
      if (trigger === "manual") {
        this.host.onNotice("云同步：请先在设置里填写服务端地址与账号密码", "error");
      }
      return;
    }
    if (this.syncing) {
      this.rerun = true;
      return;
    }
    this.syncing = true;
    try {
      this.host.onStatus("syncing");
      // 每轮重置下载额度：上一轮被上限推迟的附件在这一轮接着下
      this.downloadBudget.reset();
      await this.scanLocalFiles();
      await this.pullAndApply();
      await this.doFlush();
      this.state.lastSyncAt = Date.now();
      this.lastErrorNotice = "";
      this.host.onStatus("ok");
      if (this.downloadBudget.deferred > 0) {
        this.host.onNotice(
          `云同步：还有附件本轮未下载完（单轮有上限），下个周期继续`,
        );
      }
    } catch (err) {
      this.notifyError(err);
      this.host.onStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      this.syncing = false;
      await this.host.persist(this.state).catch(() => {});
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        void this.syncNow("retry");
      }
    }
  }

  /** 防抖期结束/卸载时的推送入口（轻量：只发不等）。 */
  async flushPushes(): Promise<void> {
    if (
      this.dirty.size === 0 &&
      this.dirtyAttachments.size === 0 &&
      this.missingAttachments.size === 0
    ) {
      return;
    }
    if (!this.configured) return;
    if (this.syncing) return; // 周期结束时会统一带上这些变更
    this.syncing = true;
    try {
      await this.doFlush();
      this.state.lastSyncAt = Date.now();
      this.host.onStatus("ok");
    } catch (err) {
      this.notifyError(err);
      this.host.onStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      this.syncing = false;
      await this.host.persist(this.state).catch(() => {});
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        void this.syncNow("retry");
      }
    }
  }

  private armFlushTimer(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flushPushes();
    }, PUSH_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------ 扫描本地差异

  /**
   * 扫描本地文件与上次同步哈希的差异（首台设备上传既有日记、离线期间的修改都靠它入队）。
   * 拉取应用阶段认定的冲突也会写 dirty，与这里互不冲突（Map 后写覆盖）。
   */
  private async scanLocalFiles(): Promise<void> {
    const result = await syncScan(this.vault, this.state.scope, this.host.getFolder());
    for (const file of result.files) {
      if (this.state.hashes[file.path] !== file.syncSha256) {
        this.dirty.set(file.path, "mod");
      }
    }
    // 不能同步的文件必须说出来：静默跳过在界面上就是"这篇永远不同步"。
    // 按路径去重，只在第一次遇到时提示，不每个周期刷一遍。
    for (const skip of result.skipped) {
      if (this.reportedSkips.has(skip.path)) continue;
      this.reportedSkips.add(skip.path);
      this.host.onNotice(`云同步：${skip.path} 未参与同步（${skip.reason}）`, "error");
    }

    // 本地删除的传播。
    //
    // 扫描只看得见"还在范围内的文件"，所以"上次同步过、这次不在扫描结果里"这件事有
    // 两种成因，必须分开：
    //
    // - **文件真的没了**（用户在应用里删了、在资源管理器里删了、改名了）→ 推墓碑。
    //   插件的 deletion 事件能直接告诉它；我们的文件监听只报路径、不报操作类型，
    //   所以用"哈希表里有、磁盘上没有"来判定。少了这一步，本地删除永远不会同步出去。
    // - **只是离开了推送范围**（用户把日记目录从「日记」改到「日记/新」）→ **什么都不做**。
    //   这里若也推墓碑，改一次日记目录就会把云端上整个旧目录的笔记删掉——正是插件
    //   注释里记着的那次事故（游标/哈希错位导致"全部文件被判成本地离线删除"）。
    //
    // 因此这里必须问一次完整的文件表（含范围外的文件），而不是拿扫描结果当全集。
    const hashed = Object.keys(this.state.hashes).filter((path) => path !== TODO_SYNC_PATH);
    if (hashed.length > 0) {
      const entries = await listEntries(this.vault);
      const onDisk = new Set(entries.filter((entry) => !entry.isDir).map((entry) => entry.path));
      for (const path of hashed) {
        if (!onDisk.has(path)) this.dirty.set(path, "del");
      }
    }

    // 虚拟文件（待办数据）不在库里，单独比对内存内容的哈希
    const virtual = this.host.getVirtualFiles();
    this.virtualPaths = new Set(Object.keys(virtual));
    for (const [path, content] of Object.entries(virtual)) {
      if (this.state.hashes[path] !== (await sha256Hex(content))) this.dirty.set(path, "mod");
    }

    await this.scanAttachments();
  }

  /**
   * 扫描被引用的附件：本地缺的排「取」，有变化的排「传」。
   *
   * 「本地缺 → 主动去云端取」是附件能拉下来的关键。只靠拉取流下发元数据是不够的：
   * 拉取有游标，任何一台设备用旧版客户端拉过一轮，游标就越过了那些附件的版本号，
   * 之后增量里再也不会出现它们。由**本地日记的引用**反推需要什么、直接按路径去要，
   * 游标跳没跳过都不影响。
   */
  private async scanAttachments(): Promise<void> {
    const result = await syncScanAttachments(this.vault, this.state.scope, this.host.getFolder());

    // 本地有的：mtime+size 没变就跳过重读（哈希拿上次的），变了才算一次哈希、比对入队
    for (const item of result.referenced) {
      const stamp = attachmentStamp(item.modified, item.size);
      const known = this.state.attachmentHashes[item.path];
      if (this.state.attachmentStamps[item.path] === stamp && known !== undefined) continue;
      const content = await readBinary(this.vault, item.path);
      this.state.attachmentStamps[item.path] = stamp;
      if (known !== content.sha256) this.dirtyAttachments.set(item.path, "mod");
    }

    // 本地缺的：记下名字与来源，flush 阶段按名去云端问（这是附件拉下来的主通道）
    this.missingAttachments = new Map(result.missing.map((item) => [item.name, item.from]));

    // 同步过、但现在既没被引用、本地也没了的 → 推墓碑，让其他设备跟着清掉。
    // 只删引用、文件还留着的**不**推墓碑：云端那份留着更保守，用户日后重新引用无需重传。
    // 文件名仍被引用着（哪怕链接解析不到）也不删：交给"按名取回"去把它补回来。
    const referencedPaths = new Set(result.referenced.map((item) => item.path));
    const missingNames = new Set(result.missing.map((item) => item.name));
    for (const path of Object.keys(this.state.attachmentHashes)) {
      if (referencedPaths.has(path)) continue;
      if (missingNames.has(basename(path))) continue;
      if (await this.pathExists(path)) continue;
      this.dirtyAttachments.set(path, "del");
    }
  }

  // ---------------------------------------------------------------- 推送

  /**
   * 把正文与附件两个队列的变更发出（调用方需已持有 syncing 锁）。
   *
   * 附件先行：正文里的 `![[图]]` 一落地就该有图可显示，先传图再传正文能少一次
   * "图裂开"的瞬间。正文每批 ≤200 条（服务端限制）；附件一条一个请求——
   * 服务端"一次上传占一个版本号"而正文"一批占一个版本号"，同一版本号下只有一类行，
   * 拉取时两表归并才不会歧义。
   */
  private async doFlush(): Promise<void> {
    await this.flushAttachments();
    while (this.dirty.size > 0) {
      const items: { path: string; content: string | null; deleted: boolean; hash: string | null }[] =
        [];
      const batchPaths: string[] = [];
      for (const [path, op] of this.dirty) {
        if (items.length >= MAX_BATCH) break;
        if (op === "del") {
          items.push({ path, content: null, deleted: true, hash: null });
          batchPaths.push(path);
          continue;
        }
        if (path.length > MAX_PATH_CHARS) {
          this.host.onNotice(`云同步：路径超过 ${MAX_PATH_CHARS} 字符，本条已跳过：${path}`, "error");
          this.dirty.delete(path);
          continue;
        }
        // 虚拟文件（待办数据）的内容在内存里，库里没有对应文件
        const virtualContent = this.host.getVirtualFiles()[path];
        if (virtualContent !== undefined) {
          const virtualHash = await sha256Hex(virtualContent);
          if (this.state.hashes[path] === virtualHash) {
            this.dirty.delete(path);
            continue;
          }
          // 拉取阶段的 mergeVirtualFile 已经把云端内容并进本地，
          // 所以这里推的就是合并结果（同时含两侧改动），不再需要「云端更新就跳过」
          items.push({ path, content: virtualContent, deleted: false, hash: virtualHash });
          batchPaths.push(path);
          continue;
        }
        const note = await readNoteOptional(this.vault, path);
        if (!note) {
          // 防抖窗口内文件又被删了（或从来不存在）：转为墓碑
          items.push({ path, content: null, deleted: true, hash: null });
          batchPaths.push(path);
          continue;
        }
        if (note.content.length > MAX_CONTENT_CHARS) {
          this.host.onNotice(`云同步：${path} 超过 1MB 上限，本条已跳过`, "error");
          this.dirty.delete(path);
          continue;
        }
        if (this.state.hashes[path] === note.syncSha256) {
          this.dirty.delete(path); // 与上次同步一致，无需上传
          continue;
        }
        items.push({ path, content: note.content, deleted: false, hash: note.syncSha256 });
        batchPaths.push(path);
      }
      if (items.length === 0) break;
      await this.api("POST", undefined, {
        items: items.map((it) =>
          it.deleted ? { path: it.path, deleted: true } : { path: it.path, content: it.content },
        ),
      });
      for (const it of items) {
        if (it.deleted) delete this.state.hashes[it.path];
        else this.state.hashes[it.path] = it.hash as string;
      }
      for (const path of batchPaths) this.dirty.delete(path);
    }
  }

  // ------------------------------------------------------------ 拉取与应用

  /**
   * 增量拉取并应用到本地（分页规则见文件头，同一 path 取最新版本）。
   *
   * 游标要把**附件**的版本号一起算进来——附件与正文共用同一条版本计数器：只看 records
   * 的话，游标会停在一堆附件版本号之前，同一页每次都被重新拉取，`hasMore` 永远为真。
   * 附件元数据在拉取流里"主动告知"是补充路径；主要的下载入口是按引用反推
   * （见 {@link scanAttachments}），所以游标越过附件版本号也不会漏图。
   */
  private async pullAndApply(): Promise<void> {
    const applied = new Map<string, RemoteRecord>();
    const appliedAttachments = new Map<string, RemoteAttachment>();
    let since = this.state.cursor;
    let finalCursor = this.state.cursor;
    for (;;) {
      const data = await this.api<SyncPullData>("GET", since);
      const attachments = data.attachments ?? [];
      for (const record of data.records) applied.set(record.path, record);
      for (const attachment of attachments) appliedAttachments.set(attachment.path, attachment);
      for (const record of data.records) {
        if (record.version > finalCursor) finalCursor = record.version;
      }
      for (const attachment of attachments) {
        if (attachment.version > finalCursor) finalCursor = attachment.version;
      }
      if (data.vaultVersion > finalCursor) finalCursor = data.vaultVersion;
      if (!data.hasMore) break;
      // 页尾是本页最大版本号（服务端按 version 归并后截断），所以要取两侧的较大者；
      // 回退一个版本让同版本组整组重取，客户端按 path 去重，重复是预期行为
      const lastRecord = data.records.length > 0 ? data.records[data.records.length - 1].version : 0;
      const lastAttachment =
        attachments.length > 0 ? attachments[attachments.length - 1].version : 0;
      const next = Math.max(lastRecord, lastAttachment) - 1;
      if (next <= since) break; // 防御：正常不会发生
      since = next;
    }

    const conflicts: string[] = [];
    // 附件先落地再落正文：正文里的 ![[图]] 一出现就该有图可看，不用等下一轮
    for (const attachment of appliedAttachments.values()) {
      await this.applyAttachment(attachment, conflicts);
    }
    for (const record of applied.values()) {
      await this.applyRecord(record, conflicts);
    }
    if (conflicts.length > 0) this.host.onConflicts(conflicts, Date.now());
    this.state.cursor = finalCursor;
  }

  /** 应用单条远端记录（冲突时本地胜：保留本地并标记重推）。 */
  private async applyRecord(record: RemoteRecord, conflicts: string[]): Promise<void> {
    if (this.virtualPaths.has(record.path)) {
      if (record.deleted) return;
      if (this.host.mergeVirtualFile(record.path, record.content)) {
        // 合并改动了本地 → 本轮 doFlush 会把它推回去，让其他设备也拿到合并结果
        this.dirty.set(record.path, "mod");
      }
      return;
    }

    // 墓碑先清掉本地记录的哈希（与插件一致），再按决策处理
    const knownHash = this.state.hashes[record.path];
    const note = await readNoteOptional(this.vault, record.path);
    if (record.deleted) delete this.state.hashes[record.path];

    const remoteHash = record.deleted ? null : await sha256Hex(record.content);
    const action = decideRecord({
      remoteDeleted: record.deleted,
      remoteHash,
      knownHash,
      local: { exists: note !== null, hash: note?.syncSha256 ?? null },
    });

    switch (action) {
      case "noop-identical":
        if (remoteHash !== null) this.state.hashes[record.path] = remoteHash;
        return;
      case "adopt-remote":
      case "create-local": {
        // 采纳远端内容时**保留本地文件原有的 BOM**：BOM 不参与同步哈希，
        // 保留它比抹掉它对本地字节更不具破坏性（新建的文件自然没有 BOM）。
        const hasBom = action === "adopt-remote" ? (note?.hasBom ?? false) : false;
        try {
          await writeNote(this.vault, record.path, record.content, hasBom);
        } catch (e) {
          // 同路径被目录占用之类：跳过并说明，不要让整轮同步失败
          this.host.onNotice(`云同步：写入 ${record.path} 失败（${e}）`, "error");
          return;
        }
        this.state.hashes[record.path] = remoteHash as string;
        return;
      }
      case "delete-local": {
        try {
          await deleteEntry(this.vault, record.path);
        } catch (e) {
          this.host.onNotice(`云同步：删除 ${record.path} 失败（${e}）`, "error");
        }
        return;
      }
      case "keep-local":
      case "resurrect-local": {
        const label = conflictLabel(action, record.path);
        if (label) conflicts.push(label);
        this.dirty.set(record.path, "mod");
        return;
      }
      case "push-delete":
        this.dirty.set(record.path, "del");
        return;
    }
  }

  // ------------------------------------------------------------ 附件的推送与补下

  /**
   * 处理附件队列：上传/覆盖、墓碑、以及从云端补下本地缺的。
   *
   * 上传前先刷新引用集：文件事件只能说明"某个二进制文件动了"，它该不该上云由
   * "有没有被范围内日记引用"决定。不在引用集里就从队列丢掉，免得用户往库里丢了
   * 一堆还没打算用的图片也全推上去。
   *
   * 单条失败不拖垮整轮：记下第一个错误继续处理剩下的，最后再抛出，让状态栏如实报错。
   */
  private async flushAttachments(): Promise<void> {
    if (this.dirtyAttachments.size === 0 && this.missingAttachments.size === 0) return;
    const referenced = new Set(
      (await syncScanAttachments(this.vault, this.state.scope, this.host.getFolder()))
        .referenced
        .map((item) => item.path),
    );
    let firstError: Error | null = null;
    // 遍历快照：处理过程中可能有新事件入队，让它们留给下一轮
    for (const [path, op] of [...this.dirtyAttachments]) {
      if (this.disposed) return;
      this.dirtyAttachments.delete(path);
      if (op === "mod" && !referenced.has(path)) continue;
      try {
        if (op === "del") await this.deleteAttachment(path);
        else if (op === "get") await this.fetchAttachment(path);
        else await this.uploadAttachment(path);
      } catch (err) {
        if (firstError === null) firstError = err instanceof Error ? err : new Error(String(err));
      }
    }
    // 再处理"日记引用着、本地根本没有"的那些：拿文件名去云端问（附件拉下来的主通道）
    for (const [name, from] of [...this.missingAttachments]) {
      if (this.disposed) return;
      this.missingAttachments.delete(name);
      // 上面几轮操作（拉取流的应用）可能已经把它补下来了，或本地本来就有同名的——
      // 不设这道闸会每个周期重复下载同一个文件
      if (await this.hasLocalFileNamed(name)) continue;
      try {
        await this.fetchAttachmentByName(name, from);
      } catch (err) {
        if (err instanceof AttachmentMissingError) continue; // 云端也没有：预期内，静默
        if (firstError === null) firstError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (firstError !== null) throw firstError;
  }

  /** 从云端补下一个「日记还引用着、本地却没有」的附件。云端没有就是 404，属预期。 */
  private async fetchAttachment(path: string): Promise<void> {
    // 同一轮里 applyAttachment 可能刚把它补下来，别再下一次
    if (await this.pathExists(path)) return;
    const bytes = await this.downloadAttachment(path);
    if (bytes) await this.saveAttachmentBytes(path, bytes);
  }

  /** 上传单个附件。与正文同样的幂等姿势：哈希一致就不发请求。 */
  private async uploadAttachment(path: string): Promise<void> {
    if (!(await this.pathExists(path))) {
      await this.deleteAttachment(path); // 防抖窗口内文件又被删了：转为墓碑
      return;
    }
    const content = await readBinary(this.vault, path);
    if (content.size > MAX_ATTACHMENT_BYTES) {
      this.host.onNotice(`云同步：附件 ${path} 超过 10MB 上限，已跳过`, "error");
      return;
    }
    this.state.attachmentStamps[path] = attachmentStamp(content.modified, content.size);
    if (this.state.attachmentHashes[path] === content.sha256) return;
    await this.attachmentRequest(
      "POST",
      `&path=${encodeURIComponent(path)}`,
      content.base64,
    );
    this.state.attachmentHashes[path] = content.sha256;
  }

  private async deleteAttachment(path: string): Promise<void> {
    await this.attachmentRequest("DELETE", `&path=${encodeURIComponent(path)}`);
    delete this.state.attachmentHashes[path];
    delete this.state.attachmentStamps[path];
  }

  /**
   * 应用单条远端附件元数据（冲突策略与正文一致：本地改过就本地胜并重推）。
   *
   * 这是"云端主动告知"的补充路径；主要下载入口是按引用反推（见 scanAttachments）。
   */
  private async applyAttachment(rec: RemoteAttachment, conflicts: string[]): Promise<void> {
    const exists = await this.pathExists(rec.path);
    const knownHash = this.state.attachmentHashes[rec.path];

    if (rec.deleted) {
      delete this.state.attachmentHashes[rec.path];
      delete this.state.attachmentStamps[rec.path];
      if (exists) {
        // 附件没有"内容哈希即本地哈希"的正文式比对机会吗？有——但要读文件。
        // 只有本地确实改过（哈希对不上 knownHash）才保留并重推；不知道就跟随删除。
        let localHash: string | null = null;
        try {
          localHash = (await readBinary(this.vault, rec.path)).sha256;
        } catch {
          localHash = null;
        }
        if (knownHash === undefined || localHash === knownHash) {
          try {
            await deleteEntry(this.vault, rec.path);
          } catch (e) {
            this.host.onNotice(`云同步：删除附件 ${rec.path} 失败（${e}）`, "error");
          }
        } else {
          conflicts.push(`${rec.path}（云端已删除，本地有修改，已恢复上传）`);
          this.dirtyAttachments.set(rec.path, "mod");
        }
      }
      return;
    }

    if (exists) {
      const local = await readBinary(this.vault, rec.path);
      if (local.sha256 === rec.sha256) {
        this.state.attachmentHashes[rec.path] = rec.sha256; // 已一致
        return;
      }
      if (knownHash === undefined || local.sha256 === knownHash) {
        // 本地自上次同步后未改 -> 云端覆盖
        await this.downloadInto(rec.path);
      } else {
        conflicts.push(`${rec.path}（本地与云端都修改过，已保留本地并重新上传）`);
        this.dirtyAttachments.set(rec.path, "mod");
      }
      return;
    }

    if (knownHash !== undefined && knownHash === rec.sha256) {
      // 上次同步的就是这份而本地文件已不在 -> 本地删除未推送，以墓碑同步
      this.dirtyAttachments.set(rec.path, "del");
      return;
    }
    await this.downloadInto(rec.path);
  }

  /**
   * 按文件名向云端要一个本地缺的附件，落到**服务端告诉我们的那个路径**上
   * （响应头 X-Attachment-Path）。
   *
   * 为什么要问服务端而不是自己拼路径：日记里写的是 `![[Pasted image x.png]]` 这种
   * 不带目录的名字，它真正在库里的位置只有服务端知道（同目录优先 → 最短路径 → 字典序）。
   * 落错位置的话，下一轮扫描会把同一个文件当成另一个附件重复上传，云端就多出一份。
   */
  private async fetchAttachmentByName(name: string, from: string): Promise<void> {
    if (this.downloadBudget.exhausted()) return;
    const query = `&name=${encodeURIComponent(name)}&from=${encodeURIComponent(from)}`;
    let response: HttpResponse;
    try {
      response = await this.attachmentRequest("GET", query);
    } catch (err) {
      if (err instanceof AttachmentMissingError) return; // 云端也没有：预期内，静默
      // 其他错误（网络抖动等）只告警：一张图取不到不该让整轮同步失败
      this.host.onNotice(`云同步：按名取附件 ${name} 失败（${String(err)}）`, "error");
      return;
    }
    // 响应头名的大小写没有保证，必须大小写无关地取
    const rawPath = headerValue(response.headers, "x-attachment-path");
    if (!rawPath) {
      // 没有落盘位置就宁可不下：凭空造一个路径会让云端多出一份重复附件
      this.host.onNotice(`云同步：附件响应缺少落盘路径，已跳过 ${name}`, "error");
      return;
    }
    const targetPath = decodeURIComponent(rawPath);
    await this.saveAttachmentBytes(targetPath, atobToBytes(response.bodyBase64));
  }

  /** 把云端附件按路径补到本地（受每轮上限约束）。404 静默跳过，不打断整轮。 */
  private async downloadInto(path: string): Promise<void> {
    if (this.downloadBudget.exhausted()) return;
    const bytes = await this.downloadAttachment(path);
    if (!bytes) return;
    await this.saveAttachmentBytes(path, bytes);
  }

  /** 下载附件原始字节。404（云端没有）返回 null；凭证问题照旧上抛。 */
  private async downloadAttachment(path: string): Promise<Uint8Array | null> {
    try {
      const response = await this.attachmentRequest("GET", `&path=${encodeURIComponent(path)}`);
      return atobToBytes(response.bodyBase64);
    } catch (err) {
      if (err instanceof AttachmentMissingError) return null;
      this.host.onNotice(`云同步：附件下载失败 ${path}（${String(err)}）`, "error");
      return null;
    }
  }

  /** 落盘并记下哈希。不记的话下一轮会把它当成"没同步过"而重复下载。 */
  private async saveAttachmentBytes(path: string, bytes: Uint8Array): Promise<void> {
    const written = await writeBinary(this.vault, path, bytesToBase64(bytes));
    this.state.attachmentHashes[path] = written.sha256;
    // mtime 已变，别让下一轮命中旧 stamp
    delete this.state.attachmentStamps[path];
    this.downloadBudget.record(written.bytes);
  }

  /** 路径上有没有文件（目录、不存在都算没有）。 */
  private async pathExists(path: string): Promise<boolean> {
    // readBinary 对目录/缺失路径会报错，用它一次拿两个答案
    try {
      await readBinary(this.vault, path);
      return true;
    } catch {
      return false;
    }
  }

  /** 本地是否已有同名文件（按文件名比，跨目录也算）。 */
  private async hasLocalFileNamed(name: string): Promise<boolean> {
    const lower = name.toLowerCase();
    const entries = await listEntries(this.vault);
    return entries.some((entry) => !entry.isDir && entry.name.toLowerCase() === lower);
  }

  // ------------------------------------------------------------ HTTP 与鉴权

  /**
   * 调正文同步接口（JSON）：自动带 Bearer accessToken；401（过期/失效）时强制换新令牌后
   * 重试一次，仍 401 才视为账号密码有问题。所有调用都在 syncing 锁内串行，无并发抢号问题。
   */
  private async api<T = unknown>(method: "GET" | "POST", since?: number, body?: unknown): Promise<T> {
    const vault = encodeURIComponent(this.host.getVaultName());
    const url =
      method === "GET"
        ? `${baseUrl(this.state.serverUrl)}/api/v1/sync?vault=${vault}&since=${since ?? 0}&limit=${PULL_LIMIT}`
        : `${baseUrl(this.state.serverUrl)}/api/v1/sync?vault=${vault}`;
    const payload = method === "POST" ? JSON.stringify(body) : undefined;

    let response = await this.send(url, method, await this.ensureAccessToken(), payload);
    if (response.status === 401) {
      response = await this.send(url, method, await this.ensureAccessToken(true), payload);
      if (response.status === 401) throw new SyncAuthError();
    }
    if (response.status !== 200) throw new Error(`服务器返回 HTTP ${response.status}`);

    const json = this.parseJson<{ code?: number; message?: string; data?: T }>(response);
    if (!json || json.code !== 0 || json.data === undefined) {
      throw new Error(json?.message || "响应格式错误");
    }
    return json.data;
  }

  private async send(
    url: string,
    method: "GET" | "POST",
    accessToken: string,
    bodyText: string | undefined,
  ): Promise<HttpResponse> {
    try {
      return await httpRequest({
        method,
        url,
        headers: [
          { name: "Content-Type", value: "application/json" },
          { name: "Authorization", value: `Bearer ${accessToken}` },
        ],
        bodyText,
      });
    } catch (e) {
      // Rust 侧的传输失败消息已经写成"无法连接同步服务器（…）"，不再包一层
      throw new Error(String(e));
    }
  }

  /** 响应体解析：非 JSON（或空体）返回 null，由调用方按"响应格式错误"处理。 */
  private parseJson<T>(response: HttpResponse): T | null {
    if (!response.bodyBase64) return null;
    try {
      return JSON.parse(new TextDecoder().decode(atobToBytes(response.bodyBase64))) as T;
    } catch {
      return null;
    }
  }

  /**
   * 调附件接口（原始字节，与正文同步同一套仓库定位与续期逻辑）。
   *
   * 404 单独抛 {@link AttachmentMissingError}：对下载侧那是预期结果
   * （该附件可能只在别的设备上、或已被删除），要静默跳过，不能当成错误刷提示。
   * 其他非 200 按服务端 message 抛——那句"只同步 png / …"有信息量，别丢了。
   */
  private async attachmentRequest(
    method: "GET" | "POST" | "DELETE",
    query: string,
    bodyBase64?: string,
  ): Promise<HttpResponse> {
    const url = `${baseUrl(this.state.serverUrl)}/api/v1/sync/attachments?vault=${encodeURIComponent(
      this.host.getVaultName(),
    )}${query}`;
    const sendOnce = async () =>
      httpRequest({
        method,
        url,
        headers: [
          { name: "Content-Type", value: "application/octet-stream" },
          { name: "Authorization", value: `Bearer ${await this.ensureAccessToken()}` },
        ],
        bodyBase64,
      });
    let response = await sendOnce().catch((e) => {
      throw new Error(String(e));
    });
    if (response.status === 401) {
      // 重建请求（新令牌在 headers 里）
      response = await httpRequest({
        method,
        url,
        headers: [
          { name: "Content-Type", value: "application/octet-stream" },
          { name: "Authorization", value: `Bearer ${await this.ensureAccessToken(true)}` },
        ],
        bodyBase64,
      }).catch((e) => {
        throw new Error(String(e));
      });
      if (response.status === 401) throw new SyncAuthError();
    }
    if (response.status === 404) throw new AttachmentMissingError(`附件不在云端: ${query}`);
    if (response.status !== 200) {
      const json = this.parseJson<{ message?: string }>(response);
      throw new Error(`附件同步失败（HTTP ${response.status}）${json?.message ? "：" + json.message : ""}`);
    }
    return response;
  }

  /**
   * 拿可用的 accessToken：
   * 有缓存直接用；`force`（401 后）或无缓存时先试 refreshToken 换新对
   * （服务端一次性轮换，旧 refresh 立即作废），refresh 不可用（过期/作废/网络异常）
   * 一律落到账号密码登录——登录被拒才是真正的凭证问题，抛 SyncAuthError。
   */
  private async ensureAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken) return this.accessToken;
    if (this.state.refreshToken) {
      try {
        const data = await this.tokenRequest("/api/v1/auth/refresh", {
          refreshToken: this.state.refreshToken,
        });
        this.applyTokenPair(data);
        return this.accessToken as string;
      } catch {
        // refresh 已过期/被轮换作废（或暂时连不上——登录请求会给出真实原因）
        this.state.refreshToken = "";
      }
    }
    const data = await this.tokenRequest("/api/v1/auth/login", {
      username: this.state.username.trim(),
      password: this.state.password,
    });
    this.applyTokenPair(data);
    return this.accessToken as string;
  }

  /** 登录/刷新接口：非 200 一律按服务端 message 抛错，401 视为凭证问题。 */
  private async tokenRequest(path: string, payload: unknown): Promise<TokenPairData> {
    let response: HttpResponse;
    try {
      response = await httpRequest({
        method: "POST",
        url: `${baseUrl(this.state.serverUrl)}${path}`,
        headers: [{ name: "Content-Type", value: "application/json" }],
        bodyText: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error(String(e));
    }
    const json = this.parseJson<{ code?: number; message?: string; data?: TokenPairData }>(response);
    if (response.status === 401 || json?.code === 401) throw new SyncAuthError();
    if (response.status !== 200 || !json || json.code !== 0 || !json.data) {
      throw new Error(json?.message || `登录接口返回 HTTP ${response.status}`);
    }
    return json.data;
  }

  /** 记下新的令牌对。refreshToken 落到状态里，周期结束统一持久化。 */
  private applyTokenPair(data: TokenPairData): void {
    this.accessToken = data.accessToken;
    this.state.refreshToken = data.refreshToken;
    void this.host.persist(this.state).catch(() => {});
  }

  // ------------------------------------------------------------ 状态与提示

  private refreshStatus(): void {
    if (this.configured && this.state.enabled) this.host.onStatus("ok");
    else this.host.onStatus("off");
  }

  /** 错误提示去重：同一错误只提示一次，成功后复位（避免周期重试刷屏）。 */
  private notifyError(err: unknown): void {
    const isAuth = err instanceof SyncAuthError;
    const key = isAuth ? "auth" : err instanceof Error ? err.message : String(err);
    if (key === this.lastErrorNotice) return;
    this.lastErrorNotice = key;
    this.host.onNotice(
      isAuth ? "云同步失败：账号或密码错误，请在设置中更新" : `云同步失败：${key}`,
      "error",
    );
  }
}

/** base64 -> 字节（附件字节的传输格式）。 */
function atobToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 字节 -> base64（writeBinary 的入参格式）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** 取路径的文件名部分。 */
function basename(path: string): string {
  return path.substring(path.lastIndexOf("/") + 1);
}

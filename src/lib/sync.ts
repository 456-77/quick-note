/**
 * 同步的纯逻辑：状态形状、范围判定、以及**冲突决策**。
 *
 * 这里刻意不放任何 IO。冲突策略（"本地改过没有、云端改过没有、谁赢"）是同步里唯一
 * 会造成数据丢失的部分，把它压成几个纯函数，才能在 Node 里把每个分支都断言到；
 * 真正读盘、写盘、发请求的编排在 `syncEngine.ts` 里。
 *
 * 协议与阈值逐条对齐 Obsidian 插件（`quick-daily-note/sync.ts`），因为两边共用同一个
 * 服务端与同一份仓库：常量一旦分叉，最轻的后果是两边互相把对方推的变更又推一遍。
 */

import { mergeTodos, parseSnapshot, type TodoMap } from "./todos.ts";

/** 本设备独立的同步配置与状态（落盘在应用配置目录，**不进仓库**）。 */
export interface SyncDeviceState {
  /**
   * 这份状态属于哪个仓库（仓库目录的绝对路径）。
   *
   * 状态文件是**按设备一份**的，而游标与各文件哈希是"我在**这个**仓库里看到过什么"。
   * 换仓库时如果把它们带过去，路径相同的文件（`日记/2026-09-15.md` 这种在两边都常见）
   * 会被当成"本地改过"而全推一遍，或更糟——被当成"云端已删"而误删本地文件。
   * 所以换仓库时游标与哈希必须归零，由 {@link adaptStateToVault} 统一处理。
   */
  vault: string;
  /** 后端地址，如 http://your-server:8080 */
  serverUrl: string;
  /** 服务端账号（与 Web 登录同一套用户体系）。 */
  username: string;
  /** 服务端密码。**明文，与插件一样**；它必须在设备本地，绝不能进仓库。 */
  password: string;
  /** 自动同步开关（关掉后只有手动触发）。 */
  enabled: boolean;
  /** 推送范围：folder=日记文件夹，vault=整个库（均限 `.md`，且排除点开头目录）。 */
  scope: "folder" | "vault";
  /**
   * 服务端仓库名。
   *
   * 服务端按 `(用户, 仓库名)` 定位，Obsidian 插件填的是 `app.vault.getName()`
   * （即库文件夹的名字）。Quick Note 打开的是同一个目录，名字默认就取文件夹名；
   * 留空即走默认。允许显式改，是为了应对"文件夹名与 Obsidian 库名不一致"
   * （边同步边改名、或库根被移动过）——那时不写清楚就会同步到**另一个**云端仓库，
   * 表现为"同步成功了，但数据没过来"。
   */
  vaultName: string;
  /** 拉取游标（已同步到的仓库版本号），0 表示全新。 */
  cursor: number;
  /** path -> 上次同步时的内容同步哈希。冲突判定与"跳过无变化推送"的依据。 */
  hashes: Record<string, string>;
  /**
   * 附件 path -> 上次同步时的内容 SHA-256。与 `hashes` 分开存：
   * 正文参与冲突判定，附件有自己的上传方式与体积上限（10MB），
   * 混在一起会让「本地改过没有」的判断在两类文件之间串味。
   */
  attachmentHashes: Record<string, string>;
  /**
   * 附件 path -> `${mtime}:${size}`，纯属省算力的旁路缓存：附件动辄几 MB，
   * 每个周期把所有被引用的附件读一遍重算哈希太浪费，时间戳与大小都没变就跳过读取。
   * 它只是优化——缺失或过期只会多算一次哈希，判定始终以 `attachmentHashes` 为准。
   */
  attachmentStamps: Record<string, string>;
  /** 上次成功同步的时间戳（ms），0=从未。 */
  lastSyncAt: number;
  /** 服务端签发的 refreshToken（30 天滚动轮换），用于静默续期 accessToken。 */
  refreshToken: string;
}

/** 附件同步（M3 范围外）也要用到的占位状态，保持与插件同一份字段，便于将来接上。 */
export const DEFAULT_SYNC_STATE: SyncDeviceState = {
  vault: "",
  serverUrl: "",
  username: "",
  password: "",
  enabled: false,
  scope: "folder",
  vaultName: "",
  cursor: 0,
  hashes: {},
  attachmentHashes: {},
  attachmentStamps: {},
  lastSyncAt: 0,
  refreshToken: "",
};

/**
 * 把状态对齐到当前仓库：换过仓库就丢掉游标与哈希。
 *
 * 保留的只有与仓库无关的部分：服务端地址、账号密码、开关、范围、仓库名、
 * refreshToken（它是**账号级**的，不是仓库级的）。
 *
 * 代价是"切回上一个仓库会重新全量拉取一次"。这比带着别的仓库的哈希去比对安全得多
 * ——后者会让同名文件被误判成本地改动或云端删除。
 */
export function adaptStateToVault(state: SyncDeviceState, vault: string): SyncDeviceState {
  if (state.vault === vault && vault !== "") return state;
  return {
    ...state,
    vault,
    cursor: 0,
    hashes: {},
    attachmentHashes: {},
    attachmentStamps: {},
    lastSyncAt: 0,
  };
}

/**
 * 从持久化数据恢复同步状态。
 *
 * `hashes` 必须**深拷贝**：`{ ...DEFAULT_SYNC_STATE }` 是浅拷贝，多个实例会共享同一个
 * 默认表对象——插件侧因为这条踩过一次事故（一台设备的状态"串"到另一台，新设备把全部
 * 文件误判为本地离线删除而推墓碑）。这里同样不能省。
 *
 * 返回的状态**尚未对齐仓库**，调用方应当接着走 {@link adaptStateToVault}。
 */
export function normalizeSyncState(raw: Partial<SyncDeviceState> | null | undefined): SyncDeviceState {
  return {
    ...DEFAULT_SYNC_STATE,
    ...raw,
    vault: typeof raw?.vault === "string" ? raw.vault : "",
    hashes: { ...(raw?.hashes ?? {}) },
    attachmentHashes: { ...(raw?.attachmentHashes ?? {}) },
    attachmentStamps: { ...(raw?.attachmentStamps ?? {}) },
    scope: raw?.scope === "vault" ? "vault" : "folder",
    cursor: typeof raw?.cursor === "number" && raw.cursor >= 0 ? raw.cursor : 0,
    lastSyncAt: typeof raw?.lastSyncAt === "number" ? raw.lastSyncAt : 0,
  };
}

export type SyncStatusKind = "off" | "syncing" | "ok" | "error";

/** 本地修改后延迟推送的静默期：防抖合并连续输入。 */
export const PUSH_DEBOUNCE_MS = 3000;
/** 周期性全量同步间隔。 */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** 启动后延迟首同步，等界面与文件索引就绪。 */
export const STARTUP_DELAY_MS = 5000;
/** 服务端限制：单批 ≤200 条。 */
export const MAX_BATCH = 200;
/** 服务端限制：单条内容 ≤1MB（按 Java String 长度，即 UTF-16 代码单元数）。 */
export const MAX_CONTENT_CHARS = 1_048_576;
/** 拉取分页大小（服务端上限 500，取满即 hasMore=true）。 */
export const PULL_LIMIT = 500;
/** 服务端限制：path ≤255 字符。 */
export const MAX_PATH_CHARS = 255;

/**
 * 允许同步的附件扩展名（与后端 `AttachmentService.ALLOWED_EXTENSIONS` 一一对应）。
 *
 * 刻意不含 svg：svg 能内联脚本，浏览器直出等于开了一条 XSS 通道。
 * 白名单必须与服务端一致——不一致的话本地会把注定被 400 拒的文件反复往上推。
 */
export const ATTACHMENT_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "pdf"] as const;
/** 服务端单文件上限 10MB。本地先挡一道，省一次注定被 413 拒的上传。 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/**
 * 每个同步周期最多补下多少个附件、多少字节。
 *
 * 新设备首次同步时云端可能挂着上百张图，一口气拉完会让界面卡住几分钟；分轮完成，
 * 被跳过的下一轮（5 分钟）继续，引用还在不会漏。
 */
export const ATTACHMENT_DOWNLOAD_PER_CYCLE = 20;
export const ATTACHMENT_DOWNLOAD_BYTES_PER_CYCLE = 50 * 1024 * 1024;

/** 取路径的文件名部分。 */
export function basenameOf(path: string): string {
  return path.substring(path.lastIndexOf("/") + 1);
}

/**
 * 路径是否在推送范围内。
 *
 * 与 Rust 侧 `vault::in_sync_scope` 同一套规则，两处都留着是因为判定发生的位置不同：
 * Rust 在扫描时过滤（避免为不该同步的文件算哈希），这里在拉取应用前判断（决定一条
 * 远端记录该不该落到本地）。两边都**区分 `.md` 大小写**——服务端的扩展名白名单是
 * `endsWith(".md")`，`笔记.MD` 推上去会让整批 400 被拒。
 */
export function inScope(path: string, scope: SyncDeviceState["scope"], folder: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (path.split("/").some((segment) => segment.startsWith("."))) return false;
  if (scope === "vault") return true;
  const trimmed = folder.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (trimmed === "") return true;
  return path.startsWith(`${trimmed}/`);
}

/** 服务端地址归一化：去掉尾部斜杠；没写协议就按 http 补（本地联调常只写 ip:port）。 */
export function baseUrl(serverUrl: string): string {
  const base = serverUrl.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(base) ? base : `http://${base}`;
}

/**
 * 从响应头里取值，**大小写无关**。
 *
 * 键的大小写没有契约保证（Node/浏览器普遍小写化，但服务端框架未必），
 * 所以一律按小写比对，别用 `headers["x-xxx"]` 直接取。附件同步（下一步）要用它
 * 读 `X-Attachment-Path`——服务端按"同目录优先 → 最短路径 → 字典序"解析出的真实路径。
 */
export function headerValue(
  headers: { name: string; value: string }[],
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (header.name.toLowerCase() === wanted) return header.value;
  }
  return undefined;
}

/**
 * 从仓库路径推出默认的云端仓库名：取最后一段目录名。
 *
 * 与 Obsidian 的 `app.vault.getName()` 对齐（它返回的就是库文件夹的名字）。
 * 末尾的分隔符（`D:\notes\`）先去掉，否则会取到空串。
 */
export function defaultVaultName(vaultPath: string): string {
  const trimmed = vaultPath.trim().replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

// ---------------------------------------------------------------- 冲突决策

/** 本地此刻的状态（由调用方查出来，本模块不做 IO）。 */
export interface LocalFileState {
  /** 路径上**存在文件**。 */
  exists: boolean;
  /** 本地内容的同步哈希；文件不存在时为 null。 */
  hash: string | null;
}

/** 一条远端记录要做什么。 */
export type RecordAction =
  /** 内容已一致，只记下哈希。 */
  | "noop-identical"
  /** 云端胜：把远端内容写到本地。 */
  | "adopt-remote"
  /** 本地胜（双边都改过）：保留本地，重新推送。 */
  | "keep-local"
  /** 跟随云端删除（进回收目录）。 */
  | "delete-local"
  /** 云端已删而本地改过：本地胜，重新推送复活。 */
  | "resurrect-local"
  /** 本地文件已不在、而上次同步的正是远端这份：推墓碑。 */
  | "push-delete"
  /** 云端新增（或本地没有这个文件）：在本地重建。 */
  | "create-local";

export interface RecordDecisionInput {
  remoteDeleted: boolean;
  /** 远端内容的同步哈希（墓碑时为 null）。 */
  remoteHash: string | null;
  /** 本字段（`state.hashes[path]`）：上次同步时双方一致的那一份。undefined = 本设备不知道它。 */
  knownHash: string | undefined;
  local: LocalFileState;
}

/**
 * 冲突策略（**本地改动胜出 + 回推**），与插件逐条一致，只有一处刻意的差别（见下）。
 *
 * 判断的依据只有三个哈希：**上次同步时的**（`knownHash`）、**本地的**、**远端的**。
 * 三种关系对应三种处理：
 *
 * - 本地 == 远端 → 无事可做；
 * - 本地 == 上次同步值（本地没动过） → 采纳云端；
 * - 以上都不是（本地动过、云端也动过） → 本地胜，重新推送。
 *
 * 之所以用"本地 == 上次同步值"而不是记录修改时间：时间戳跨设备不可比（时钟偏差、
 * 时区、夏令时），而哈希是内容本身的指纹。
 *
 * ## 与插件的唯一差别：`knownHash === undefined` 且本地有文件时，本地胜
 *
 * 插件把这个情况当成"本地没动过"，用云端内容直接覆盖本地。它这么做是乐观假设
 * "本设备不认识这个文件 = 这个文件不是我的改动"。但在我们的应用里有个高概率场景
 * 会踩中它：**同步状态损坏后点「重置同步状态」**（哈希全清）。那一刻每个本地文件都
 * 变成"不认识"，云端内容会成片覆盖本地——把一次读取失败放大成一次全库回滚。
 *
 * 反过来（本地胜）不会死循环：本地内容先推上去，对方的 `knownHash` 等于它自己的
 * 旧内容，于是对方采纳我们的版本，两侧收敛。代价只是"两边都改过又都失忆"时由本地赢。
 */
export function decideRecord(input: RecordDecisionInput): RecordAction {
  const { remoteDeleted, remoteHash, knownHash, local } = input;

  if (remoteDeleted) {
    if (!local.exists) {
      // 本地也没有：什么都不用做（哈希由调用方清除）
      return "noop-identical";
    }
    if (knownHash === undefined || local.hash === knownHash) {
      // 本地未改动（或本设备不认识它）-> 跟随云端删除
      return "delete-local";
    }
    // 本地有未同步的修改 + 云端已删 -> 本地胜，重新推送复活
    return "resurrect-local";
  }

  if (local.exists) {
    if (local.hash === remoteHash) return "noop-identical";
    if (knownHash !== undefined && local.hash === knownHash) return "adopt-remote";
    return "keep-local";
  }

  if (knownHash !== undefined && knownHash === remoteHash) {
    // 上次同步的就是这一份、而本地文件已不在 -> 本地删除没推上去，补一个墓碑
    return "push-delete";
  }
  // 云端新文件（或云端改过而本地没有）-> 云端胜，重建
  return "create-local";
}


/** 冲突提示里那一行话（决定动作是本地胜时才会用到）。 */
export function conflictLabel(action: RecordAction, path: string): string | null {
  if (action === "keep-local") return `${path}（本地与云端都修改过，已保留本地并重新上传）`;
  if (action === "resurrect-local") return `${path}（云端已删除，本地有修改，已恢复上传）`;
  return null;
}

// ---------------------------------------------------------------- 附件

/** 附件路径是否值得考虑同步：白名单扩展名 + 不在任何点开头的目录里。 */
export function isAttachmentPath(path: string): boolean {
  if (path.endsWith(".md") || path.endsWith(".json")) return false;
  if (path.split("/").some((segment) => segment.startsWith("."))) return false;
  return (ATTACHMENT_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/** 取路径的扩展名（小写）；目录名里的点不算。 */
export function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash + 1 ? path.substring(dot + 1).toLowerCase() : "";
}

/** 附件的旁路缓存键：mtime 与 size 都没变就跳过重读重算。 */
export function attachmentStamp(mtimeMs: number, size: number): string {
  return `${mtimeMs}:${size}`;
}

/** 每轮附件下载的记账器。 */
export class DownloadBudget {
  private count = 0;
  private bytes = 0;
  /** 因额度用完被推迟的次数（只用于提示一次，实际下载留给下个周期）。 */
  deferred = 0;
  private readonly maxCount: number;
  private readonly maxBytes: number;

  constructor(
    maxCount: number = ATTACHMENT_DOWNLOAD_PER_CYCLE,
    maxBytes: number = ATTACHMENT_DOWNLOAD_BYTES_PER_CYCLE,
  ) {
    this.maxCount = maxCount;
    this.maxBytes = maxBytes;
  }

  /** 重置每轮额度（上一轮被推迟的附件在这一轮接着下）。 */
  reset(): void {
    this.count = 0;
    this.bytes = 0;
    this.deferred = 0;
  }

  /** 记一笔已完成的下载。 */
  record(bytes: number): void {
    this.count += 1;
    this.bytes += bytes;
  }

  /** 额度是否已用完；用完就记一笔推迟（下一轮扫描会从引用重新推导出来）。 */
  exhausted(): boolean {
    if (this.count >= this.maxCount || this.bytes >= this.maxBytes) {
      this.deferred += 1;
      return true;
    }
    return false;
  }
}

/**
 * 把云端待办快照并进本地（`SyncHost.mergeVirtualFile` 的实现体）。
 *
 * 返回 `null` 表示**这份快照不能用**：解析失败，或版本不是当前版本。
 * 旧格式（条目没有 `id`）无法按条目对齐，此时只推不拉——等本机推上去把云端
 * 覆盖成新格式，比强行整表覆盖安全得多。
 */
export function mergeTodoSnapshot(
  content: string,
  local: TodoMap,
): { todos: TodoMap; changed: boolean } | null {
  const snapshot = parseSnapshot(content);
  if (!snapshot) return null;
  return mergeTodos(local, snapshot.todos);
}

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

/** 仓库内的一个条目：目录或文件。 */
export interface EntryMeta {
  /** 仓库内相对路径，始终 `/` 分隔。 */
  path: string;
  name: string;
  /** 目录条目。空目录同样会出现。 */
  isDir: boolean;
  /** 目录为 0。 */
  size: number;
  modified: number;
}

/** 读取结果。content 已剥离 BOM，换行符保持文件原样。 */
export interface NoteContent {
  path: string;
  content: string;
  /**
   * **原始字节**（含 BOM）的 SHA-256。用于界面显示，以及"这次写入是不是我自己产生的
   * 事件"这类本机内判断。**不要拿它做同步比对**。
   */
  sha256: string;
  /** **同步口径**的哈希：已剥 BOM 的正文 UTF-8 字节，见 `syncScan` 的说明。 */
  syncSha256: string;
  /** crlf | lf | cr | none */
  lineEnding: string;
  mixedLineEndings: boolean;
  hasBom: boolean;
  size: number;
  modified: number;
}

/** 同步扫描到的一个文件（不含内容，只给哈希与元信息）。 */
export interface SyncFileMeta {
  path: string;
  syncSha256: string;
  hasBom: boolean;
  size: number;
  modified: number;
}

/** 扫描到了但不能同步的文件。 */
export interface SyncSkip {
  path: string;
  reason: string;
}

export interface SyncScanResult {
  files: SyncFileMeta[];
  skipped: SyncSkip[];
}

/** 一次 HTTP 响应：状态码与字节全部原样带回，由调用方解释。 */
export interface HttpResponse {
  status: number;
  /** **含大小写**的原样响应头，取值用 `headerValue` 按小写比对。 */
  headers: { name: string; value: string }[];
  bodyBase64: string;
}

export interface HttpRequestOptions {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers?: { name: string; value: string }[];
  /** JSON 等文本请求体。 */
  bodyText?: string;
  /** 二进制请求体（附件用）。与 bodyText 二选一。 */
  bodyBase64?: string;
  timeoutMs?: number;
}

export interface WriteResult {
  sha256: string;
  bytes: number;
  /** 内容与磁盘一致时为 false，此时文件未被触碰。 */
  changed: boolean;
}

/**
 * 列出仓库内的目录与文件（不含隐藏路径）。
 *
 * 一份数据同时供三处使用：文件树（**含空目录**）、wiki 语法的「文件名 → 路径」索引、
 * 笔记计数。目录条目不可少——空目录如果不返回，文件树里就根本没有这个节点。
 */
export const listEntries = (vault: string) => invoke<EntryMeta[]>("list_entries", { vault });

export const readNote = (vault: string, path: string) =>
  invoke<NoteContent>("read_note", { vault, path });

/**
 * 读取一个可能不存在的文件；不存在时返回 `null` 而不是报错。
 *
 * 库内配置 `quick-daily-note.json`、模板文件都属于"可有可无"：用 `readNote` 会让
 * "没有这个文件"和"文件读不出来"走同一条错误路径，前端就没法区分该按默认值继续，
 * 还是该提示用户。
 */
export const readNoteOptional = (vault: string, path: string) =>
  invoke<NoteContent | null>("read_note_optional", { vault, path });

/** 全文搜索的一个命中。 */
export interface SearchHit {
  path: string;
  /** 命中行（0 基）。 */
  line: number;
  /** 命中行文本（Rust 侧已截断超长行）。 */
  text: string;
}

/**
 * 仓库内全文搜索（大小写不敏感，空格分隔多个关键词，全部命中才算）。
 *
 * Rust 侧逐文件扫描，个人库量级下是毫秒级的；调用方自行防抖即可。
 */
export const searchVault = (vault: string, query: string, limit = 60) =>
  invoke<SearchHit[]>("search_vault", { vault, query, limit });

export const writeNote = (vault: string, path: string, content: string, hasBom: boolean) =>
  invoke<WriteResult>("write_note", { vault, path, content, hasBom });

/**
 * 写入一个附件（二进制走 base64），返回实际写入的仓库相对路径。
 *
 * 重名时 Rust 侧会自动加序号，不会覆盖已有文件。
 */
export const writeAttachment = (
  vault: string,
  folder: string,
  filename: string,
  dataBase64: string,
) => invoke<string>("write_attachment", { vault, folder, filename, dataBase64 });

/**
 * 新建笔记（空文件），返回新文件的仓库相对路径。
 *
 * `name` 缺 `.md` 会自动补；重名自动加序号，不会覆盖已有笔记。
 */
export const createNote = (vault: string, folder: string, name: string) =>
  invoke<string>("create_note", { vault, folder, name });

/** 新建文件夹，返回新目录的仓库相对路径。重名自动加序号。 */
export const createFolder = (vault: string, folder: string, name: string) =>
  invoke<string>("create_folder", { vault, folder, name });

export interface RenameResult {
  /** 新的仓库相对路径。 */
  path: string;
  /** 引用被改写的其他笔记（wiki 语法按文件名解析，改名必须同步更新）。 */
  updated: string[];
}

/**
 * 重命名文件或目录，并更新其他笔记里对它的 wiki 引用。
 *
 * 只改名称、不支持移动位置；目标已存在时报错（不覆盖、也不静默加序号）。
 */
export const renameEntry = (vault: string, path: string, newName: string) =>
  invoke<RenameResult>("rename_entry", { vault, path, newName });

/**
 * 删除文件或目录：移进仓库内的 `.trash/` 而不是直接抹掉，返回回收位置。
 * 误删笔记不可逆，先保证能找回。
 */
export const deleteEntry = (vault: string, path: string) =>
  invoke<string>("delete_entry", { vault, path });

/** 把一组绝对路径放入系统剪贴板（资源管理器语义的"复制文件"，可粘贴到 Explorer）。 */
export const copyPathsToClipboard = (paths: string[]) =>
  invoke<void>("copy_paths_to_clipboard", { paths });

/** 复制仓库内文件/目录到目标目录（重名自动加序号），返回新仓库相对路径。 */
export const copyEntry = (vault: string, path: string, destDir: string) =>
  invoke<string>("copy_entry", { vault, path, destDir });

/** 移动仓库内文件/目录到目标目录（拖拽"剪切"），返回新仓库相对路径。 */
export const moveEntry = (vault: string, path: string, destDir: string) =>
  invoke<string>("move_entry", { vault, path, destDir });

/** 读取系统剪贴板里的文件/目录绝对路径列表（资源管理器"复制文件"语义）；没有则空数组。 */
export const readClipboardFilePaths = () => invoke<string[]>("read_clipboard_file_paths");

export interface CopyExternalResult {
  /** 成功拷入的仓库相对路径。 */
  copied: string[];
  /** 拷入失败的来源（文件消失、占用等）。 */
  failed: string[];
}

/** 把一组绝对路径的文件/目录复制进仓库目标目录（重名自动加序号）。 */
export const copyExternalIntoVault = (vault: string, sources: string[], destDir: string) =>
  invoke<CopyExternalResult>("copy_external_into_vault", { vault, sources, destDir });

/** 弹出目录选择框；取消返回 null。 */
export async function pickVault(): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    title: "选择笔记仓库目录",
  });
  return typeof picked === "string" ? picked : null;
}

/** 弹出目录选择框（通用）。取消返回 null。 */
export async function pickDirectory(title: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

/** 命令行参数指定的仓库目录（没有则为 null）。 */
export const startupVault = () => invoke<string | null>("startup_vault");

/** 移动端默认仓库（app 私有数据目录下的 vault）。桌面恒为 null——仓库由用户选择。 */
export const defaultVaultDir = () => invoke<string | null>("default_vault_dir");

/** 移动端仓库列表里的一项（基础目录下的一级子目录）。 */
export interface VaultInfo {
  /** 仓库绝对路径（真实路径，可直接当 vault 参数用）。 */
  path: string;
  /** 目录名（= 默认云端仓库名）。 */
  name: string;
  /** 深度限定的 .md 数量。 */
  noteCount: number;
  /** 最新一篇 .md 的修改时间（毫秒），空仓库为 0。 */
  lastModified: number;
  /** 有 quick-daily-note.json 或 .obsidian（强仓库特征）。 */
  hasVaultMarker: boolean;
}

/** 移动端仓库基础目录（未设置返回 null）。 */
export const vaultHomeGet = () => invoke<string | null>("vault_home_get");

/** 用 SAF 目录选择器返回的 URI 设置基础目录（换算真实路径 + 建目录 + 可写探测）。 */
export const vaultHomeSetFromUri = (uri: string) =>
  invoke<string>("vault_home_set_from_uri", { uri });

/** 直接用真实路径设置基础目录（Android 引导页「建议目录」通道）。 */
export const vaultHomeSetFromPath = (path: string) =>
  invoke<string>("vault_home_set_from_path", { path });

/** 清除基础目录设置（回引导页；仓库文件不动）。 */
export const vaultHomeClear = () => invoke<void>("vault_home_clear");

/** 列出基础目录下的仓库（未设置基础目录时为空列表）。 */
export const listVaults = () => invoke<VaultInfo[]>("list_vaults");

/** 在基础目录下新建仓库，返回其路径。 */
export const createVault = (name: string) => invoke<string>("create_vault", { name });

/** 存储/基础目录可写性探测（「所有文件访问」授权后回查用）。 */
export const storageWritable = () => invoke<boolean>("storage_writable");

/** 启动参数里的笔记文件（资源管理器双击 .md / 打开方式）：进仓库后自动打开。 */
export const startupFile = () => invoke<string | null>("startup_file");

/** 另起一个应用窗口打开指定仓库（「在新窗口打开」）。 */
export const openNewWindow = (vault: string) => invoke<void>("open_new_window", { vault });

/** 登记本窗口正打开的仓库（跨进程登记表，识别「已在其他窗口打开」用）。 */
export const registerOpenVault = async (vault: string): Promise<void> => {
  try {
    await invoke("open_vaults_register", { vault });
  } catch {
    // 登记失败只影响「跳过弹窗直接聚焦」这一处体验
  }
};

/** 注销本窗口的仓库登记（退出时调用；崩溃条目由 Rust 侧按 pid 清理兜底）。 */
export const unregisterOpenVault = async (): Promise<void> => {
  try {
    await invoke("open_vaults_unregister");
  } catch {
    // 尽力而为
  }
};

/** 其他窗口正打开着的仓库列表。 */
export const openedVaults = async (): Promise<string[]> => {
  try {
    return await invoke<string[]>("open_vaults_list");
  } catch {
    return [];
  }
};

/** 把已在其他窗口打开的仓库调到前台；失败（平台不支持/登记过期）返回 false。 */
export const focusVaultWindow = async (vault: string): Promise<boolean> => {
  try {
    return await invoke<boolean>("open_vaults_focus", { vault });
  } catch {
    return false;
  }
};

/** 应用数据目录信息（设置面板「存储」分区用）。 */
export interface AppDataPaths {
  /** 配置目录：同步状态与数据目录指针文件所在。 */
  config_dir: string;
  /** 默认数据目录的上级（WebView 数据默认在它的 EBWebView 子目录）。 */
  local_data_dir: string;
  /** 当前生效的 WebView 数据目录（自定义 > 默认）。 */
  webview_data_dir: string;
  /** 自定义数据目录；未设置时为 null。 */
  custom_data_dir: string | null;
}

export const appDataPaths = () => invoke<AppDataPaths>("app_data_paths");

/** 设置/清除自定义数据目录（null = 恢复默认）。改动重启后生效。 */
export const setCustomDataDir = (path: string | null) =>
  invoke<AppDataPaths>("set_custom_data_dir", { path });

/** 读取用户经系统对话框选择的文本文件（UTF-8）。快捷键配置导入用。 */
/** 读取任意二进制文件（base64；分享图片经 Kotlin 落缓存目录后用）。上限 10MB。 */
export const readBinaryFile = (path: string) => invoke<string>("read_binary_file", { path });

export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });

/** 写入文本文件（UTF-8，覆盖）。路径来自系统保存对话框。快捷键配置导出用。 */
export const writeTextFile = (path: string, contents: string) =>
  invoke<void>("write_text_file", { path, contents });

/** 返回候选路径里第一个存在的（探测 Edge/Chrome 安装位置）。 */
export const firstExistingPath = (paths: string[]) =>
  invoke<string | null>("first_existing_path", { paths });

/** 用无头浏览器把本地 HTML 打印成 PDF 文件（导出 PDF 文件的落盘通道）。 */
export const exportPdfViaBrowser = (browserPath: string, htmlPath: string, pdfPath: string) =>
  invoke<void>("export_pdf_via_browser", { browserPath, htmlPath, pdfPath });

/** 开始监听仓库变化（Rust 侧 notify，带去抖）。 */
export const watchVault = (vault: string) => invoke<void>("watch_vault", { vault });

/** 把仓库目录加入 asset 协议白名单，供加载库内图片。 */
export const allowAssetDir = (vault: string) => invoke<void>("allow_asset_dir", { vault });

/**
 * 扫描同步范围内的笔记，返回每个文件的同步哈希（**不返回内容**）。
 *
 * 同步口径 = 已剥离 BOM 的正文 UTF-8 字节的 SHA-256，这是与 Obsidian 插件对齐过的
 * 结果（详见 `docs/M3-实现说明.md`）。逐文件读盘与哈希都在 Rust 侧做完，前端一次
 * IPC 拿到整张表。
 */
export const syncScan = (vault: string, scope: string, folder: string) =>
  invoke<SyncScanResult>("sync_scan", { vault, scope, folder });

/**
 * 发一次 HTTP 请求。
 *
 * 走 Rust 而不是渲染进程的 `fetch`：后端没有配置 CORS 响应头，WebView 的源
 * （`http://tauri.localhost`）不在白名单里，页面里发不出去。而且同步要带账号密码
 * 与 JWT，放在页面脚本能直接读到的地方也没必要。
 *
 * 这一层**不解释业务状态码**：401 要不要续期、404 是不是"云端没有这个附件"，
 * 都是同步逻辑的事。
 */
export const httpRequest = (options: HttpRequestOptions) =>
  invoke<HttpResponse>("http_request", {
    method: options.method,
    url: options.url,
    headers: options.headers ?? [],
    bodyText: options.bodyText ?? null,
    bodyBase64: options.bodyBase64 ?? null,
    timeoutMs: options.timeoutMs ?? null,
  });

/** 读取本机同步状态（JSON 文本）。不存在返回 null（首次使用不是错误）。 */
export const syncStateLoad = () => invoke<string | null>("sync_state_load");

/** 写入本机同步状态。 */
/** 批量同步：读取某个仓库的独立同步状态（不存在返回 null）。 */
export const syncStateLoadFor = (name: string) => invoke<string | null>("sync_state_load_for", { name });

/** 批量同步：写某个仓库的独立同步状态（原子写）。 */
export const syncStateSaveFor = (name: string, state: string) =>
  invoke<void>("sync_state_save_for", { name, state: state });

export const syncStateSave = (text: string) => invoke<void>("sync_state_save", { text });

/** 被范围内笔记引用到、且本地存在的附件（已解析出路径）。 */
export interface ReferencedAttachment {
  path: string;
  name: string;
  size: number;
  modified: number;
}

/** 被引用、但本地没有的附件：只能带着文件名去云端问。 */
export interface MissingAttachment {
  name: string;
  /** 引用它的笔记路径。服务端解析同名文件时优先看这个目录（与 Obsidian 一致）。 */
  from: string;
}

export interface AttachmentScanResult {
  referenced: ReferencedAttachment[];
  missing: MissingAttachment[];
}

/**
 * 扫描被范围内笔记引用到的附件：本地有的给路径，本地缺的给名字。
 *
 * 与插件同一套策略——按引用扫，不按目录扫：粘贴图片的落点取决于用户配置，盯目录必然
 * 漏；按引用扫与落点无关。没被任何笔记引用的图片不上云，不镜像无用的二进制。
 */
export const syncScanAttachments = (vault: string, scope: string, folder: string) =>
  invoke<AttachmentScanResult>("sync_scan_attachments", { vault, scope, folder });

/** 附件的原始字节（base64）与哈希。同步上传用。 */
export interface BinaryContent {
  path: string;
  base64: string;
  sha256: string;
  size: number;
  modified: number;
}

/** 读取附件的原始字节。不做任何规范化。 */
export const readBinary = (vault: string, path: string) =>
  invoke<BinaryContent>("read_binary", { vault, path });

/** 把附件写到**指定路径**（允许覆盖、逐级建目录），返回实际写入的哈希。 */
export const writeBinary = (vault: string, path: string, dataBase64: string) =>
  invoke<{ path: string; sha256: string; bytes: number }>("write_binary", {
    vault,
    path,
    dataBase64,
  });

/**
 * 订阅仓库变化事件。回调收到的是仓库相对路径列表（已去抖、已排序）。
 * 返回取消订阅函数。
 */
export function onVaultChanged(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>("vault-changed", (event) => handler(event.payload));
}

//! 仓库（vault）文件操作。
//!
//! 设计原则：**Rust 侧不做任何内容规范化**。换行符、BOM、尾随换行都由文件本身决定，
//! 读进来什么样，写回去就什么样。原因是同步协议用内容的 SHA-256 判断增量，
//! 任何隐式改写都会制造虚假改动与虚假冲突。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 目录递归深度上限，防止符号链接成环导致无限递归。
const MAX_DEPTH: usize = 32;

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMeta {
    /// 仓库内相对路径，始终用 `/` 分隔。
    pub path: String,
    pub name: String,
    /// 目录条目。**空目录也必须返回**——否则文件树里根本不存在这个节点。
    pub is_dir: bool,
    /// 目录为 0。
    pub size: u64,
    /// 修改时间，Unix 毫秒。
    pub modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub path: String,
    /// 已剥离 BOM 的正文；换行符保持文件原样。
    pub content: String,
    /// **原始字节**（含 BOM）的 SHA-256。用于界面显示与"这次写入是不是我自己产生的事件"
    /// 这类**本机内**的判断，不参与同步。
    pub sha256: String,
    /// **同步口径**的 SHA-256：正文（已剥 BOM）UTF-8 字节的哈希，见 [`sync_hash`]。
    pub sync_sha256: String,
    /// `crlf` | `lf` | `cr` | `none`
    pub line_ending: String,
    /// 文件内混用了多种换行符；UI 应提示。
    pub mixed_line_endings: bool,
    pub has_bom: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    /// 实际落盘内容的哈希（含 BOM）。
    pub sha256: String,
    pub bytes: usize,
    /// 内容与磁盘一致时为 false，此时不会触碰文件（mtime 不变）。
    pub changed: bool,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// **同步口径**的内容哈希：正文（已剥离 BOM 的 UTF-8 文本）字节的 SHA-256。
///
/// 为什么不是原始文件字节：同步的对端是 Obsidian 插件，它的哈希算在 `vault.read()`
/// 的返回值上，而 Obsidian 的实现是 `fs.readFile(path, "utf8")` **再剥掉开头的 BOM**
/// （见 `obsidian.asar` 里 `Vault.prototype.read` 的 `65279 === charCodeAt(0)`），
/// 换行符不做任何规范化。于是两侧口径是：
///
/// - 剥 BOM ✅（`read_note` 返回的 content 本来就已剥掉，这里直接哈希它）
/// - CRLF / 单独 CR / 混合换行 ✅ 原样，双方都不规范化
/// - 尾随换行 ✅ 原样
///
/// 差异只在"含 BOM 的文件"上体现：按原始字节算会得到另一个值，那会让所有带 BOM 的
/// 文件在双方之间反复被判成"已改动"。这条口径已用插件真实库里的 9 个文件交叉验证过
/// （插件存下的哈希与按本函数算出的值逐条相同）。
///
/// 注意：写盘时 BOM 仍然原样保留（`write_note` 按 `has_bom` 补回），同步不影响文件的
/// 字节精度——BOM 只是不参与哈希与上传内容。
fn sync_hash(content: &str) -> String {
    sha256_hex(content.as_bytes())
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 判断换行符风格。返回 (首选分隔符, 是否混用)。
///
/// 混用文件也能无损往返：CodeMirror 配置 lineSeparator 后只把该分隔符当换行，
/// 其余分隔符会作为普通字符留在行内，写回时原样保留。
fn detect_line_ending(s: &str) -> (&'static str, bool) {
    let crlf = s.matches("\r\n").count();
    let total_lf = s.matches('\n').count();
    let total_cr = s.matches('\r').count();
    let lone_lf = total_lf - crlf;
    let lone_cr = total_cr - crlf;

    let kinds = [crlf > 0, lone_lf > 0, lone_cr > 0].iter().filter(|b| **b).count();
    if kinds == 0 {
        return ("none", false);
    }
    let mixed = kinds > 1;
    // 首选：文件中最先出现的分隔符，减少编辑器里的观感异常。
    let first = match (s.find("\r\n"), s.find('\n'), s.find('\r')) {
        (Some(a), _, Some(c)) => {
            if a <= c {
                "crlf"
            } else {
                "cr"
            }
        }
        (Some(_), _, None) => "crlf",
        (None, Some(_), Some(c)) => {
            if s.find('\n').unwrap() < c {
                "lf"
            } else {
                "cr"
            }
        }
        (None, Some(_), None) => "lf",
        (None, None, Some(_)) => "cr",
        (None, None, None) => "none",
    };
    (first, mixed)
}

/// 校验相对路径：拒绝绝对路径、反斜杠、`..`/`.`、隐藏（点开头）路径段。
fn validate_rel(rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("路径为空".into());
    }
    if rel.contains('\\') {
        return Err(format!("路径不能含反斜杠: {rel}"));
    }
    if rel.starts_with('/') {
        return Err(format!("路径必须是相对路径: {rel}"));
    }
    let mut out = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(s) => {
                let s = s.to_str().ok_or_else(|| format!("路径含非法字符: {rel}"))?;
                if s.is_empty() {
                    continue;
                }
                if s.starts_with('.') {
                    return Err(format!("不允许访问隐藏路径: {rel}"));
                }
                out.push(s);
            }
            _ => return Err(format!("非法路径: {rel}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    Ok(out)
}

pub(crate) fn vault_root(vault: &str) -> Result<PathBuf, String> {
    if vault.trim().is_empty() {
        return Err("未选择仓库目录".into());
    }
    let c = PathBuf::from(vault)
        .canonicalize()
        .map_err(|e| format!("仓库目录不可访问: {e}"))?;
    if !c.is_dir() {
        return Err(format!("仓库路径不是目录: {vault}"));
    }
    Ok(c)
}

/// 解析一个已存在的文件路径，并确认没有越出仓库。
fn resolve_existing(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let full = root.join(validate_rel(rel)?);
    let c = full
        .canonicalize()
        .map_err(|e| format!("文件不可访问: {} ({e})", full.display()))?;
    if !c.starts_with(root) {
        return Err(format!("路径越出仓库范围: {rel}"));
    }
    Ok(c)
}

/// 解析一个可能尚不存在的文件路径，必要时创建父目录。
fn resolve_new(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let full = root.join(validate_rel(rel)?);
    let parent = full.parent().ok_or_else(|| format!("非法路径: {rel}"))?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    let cp = parent
        .canonicalize()
        .map_err(|e| format!("目录不可访问: {e}"))?;
    if !cp.starts_with(root) {
        return Err(format!("路径越出仓库范围: {rel}"));
    }
    Ok(full)
}

/// 递归收集仓库内的目录与文件（跳过点开头的隐藏项）。
///
/// 目录也会作为条目返回，**包括空目录**：文件树需要它们，否则"新建了一个空文件夹"
/// 在界面上完全看不到。非 `.md` 文件同样返回（界面上以弱化样式列出，不可编辑）。
fn walk_entries(dir: &Path, root: &Path, out: &mut Vec<EntryMeta>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        // 单个子目录不可读（权限等）不应让整次列举失败。
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 跳过点开头的文件与目录：.obsidian / .git / .trash 等。
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let relative = rel.to_string_lossy().replace('\\', "/");
        let meta = entry.metadata().ok();

        if file_type.is_dir() {
            out.push(EntryMeta {
                path: relative,
                name,
                is_dir: true,
                size: 0,
                modified: meta.as_ref().map(mtime_ms).unwrap_or(0),
            });
            walk_entries(&path, root, out, depth + 1);
        } else if file_type.is_file() {
            out.push(EntryMeta {
                path: relative,
                name,
                is_dir: false,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.as_ref().map(mtime_ms).unwrap_or(0),
            });
        }
    }
}

/// 校验并净化附件文件名：只允许单纯的文件名，不接受路径分隔符或隐藏名。
fn sanitize_attachment_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("附件文件名为空".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!("附件文件名不能含路径分隔符: {trimmed}"));
    }
    if trimmed.starts_with('.') {
        return Err(format!("附件文件名不能以点开头: {trimmed}"));
    }
    if trimmed.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return Err(format!("附件文件名含非法字符: {trimmed}"));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("附件文件名含控制字符".into());
    }
    Ok(trimmed.to_string())
}

/// 在目录里找一个不冲突的文件名：`a.png` → `a 1.png` → `a 2.png` …
///
/// 在沙箱里检查再写入无法完全避免竞态，但足以应付"同一秒粘贴多张"这类常见情况，
/// 而且不覆盖已有文件是这里最重要的性质。新建笔记/文件夹也复用它。
fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, extension) = match filename.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (filename.to_string(), String::new()),
    };
    for index in 1..10_000 {
        let next = dir.join(format!("{stem} {index}{extension}"));
        if !next.exists() {
            return next;
        }
    }
    candidate
}

/// 校验并净化用户输入的笔记/文件夹名称。
///
/// 允许 `子目录/名称` 的写法：逐段校验，最后一段再按文件名规则净化。
/// 拒绝隐藏名（点开头）与路径越界，其余交给 `resolve_new` 兜底。
fn sanitize_new_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名称不能为空".into());
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    let mut segments: Vec<String> = Vec::with_capacity(parts.len());

    for (index, part) in parts.iter().enumerate() {
        let segment = part.trim();
        if segment.is_empty() {
            return Err("名称里有空的路径段".into());
        }
        if index == parts.len() - 1 {
            segments.push(sanitize_attachment_name(segment)?);
        } else {
            if segment.starts_with('.') {
                return Err(format!("不允许创建隐藏目录: {segment}"));
            }
            if segment.contains(['\\', ':', '*', '?', '"', '<', '>', '|']) {
                return Err(format!("目录名含非法字符: {segment}"));
            }
            segments.push(segment.to_string());
        }
    }
    Ok(segments.join("/"))
}

/// 把「上级目录 + 名称」拼成仓库相对路径，并做与笔记相同的路径校验。
fn join_relative(folder: &str, name: &str) -> Result<String, String> {
    let parent = folder.trim().trim_matches('/');
    if parent.is_empty() {
        return Ok(name.to_string());
    }
    let checked = validate_rel(parent)?;
    Ok(format!(
        "{}/{}",
        checked.to_string_lossy().replace('\\', "/"),
        name
    ))
}

/// 相对路径取回绝对路径（用于返回给前端的仓库相对路径）。
fn to_relative(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|_| "结果越出仓库范围".to_string())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

/// 新建笔记（空文件）。名称缺 `.md` 自动补；重名自动加序号，不覆盖已有笔记。
///
/// 返回新文件的仓库相对路径。
#[tauri::command]
pub fn create_note(vault: String, folder: String, name: String) -> Result<String, String> {
    let root = vault_root(&vault)?;
    let clean = sanitize_new_name(&name)?;
    let filename = if clean.to_lowercase().ends_with(".md") {
        clean
    } else {
        format!("{clean}.md")
    };

    let full = resolve_new(&root, &join_relative(&folder, &filename)?)?;
    let parent = full.parent().ok_or_else(|| format!("非法路径: {filename}"))?;
    let leaf = full
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "名称含非法字符".to_string())?
        .to_string();

    let target = unique_path(parent, &leaf);
    fs::write(&target, b"").map_err(|e| format!("新建笔记失败: {e}"))?;
    to_relative(&root, &target)
}

/// 新建文件夹。重名自动加序号。返回新建目录的仓库相对路径。
#[tauri::command]
pub fn create_folder(vault: String, folder: String, name: String) -> Result<String, String> {
    let root = vault_root(&vault)?;
    let clean = sanitize_new_name(&name)?;
    if clean.to_lowercase().ends_with(".md") {
        return Err("文件夹名称不要以 .md 结尾".into());
    }

    let full = resolve_new(&root, &join_relative(&folder, &clean)?)?;
    let parent = full.parent().ok_or_else(|| format!("非法路径: {clean}"))?;
    let leaf = full
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "名称含非法字符".to_string())?
        .to_string();

    let target = unique_path(parent, &leaf);
    fs::create_dir(&target).map_err(|e| format!("新建文件夹失败: {e}"))?;
    to_relative(&root, &target)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    /// 新的仓库相对路径。
    pub path: String,
    /// 引用被改写的其他笔记（仓库相对路径）。
    pub updated: Vec<String>,
}

/// 把 wiki 语法里的目标名替换掉。
///
/// 只处理 `[[旧名]]` / `![[旧名]]` / `[[旧名|别名]]` / `[[旧名#小节]]` 这类写法——
/// wiki 语法是**按文件名解析**的，所以改名必须同步更新，否则引用会静默失效。
/// Markdown 的相对路径链接不动（那是路径，改名后本就该由用户自己决定怎么处理）。
fn replace_wiki_targets(content: &str, old_stem: &str, new_stem: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut cursor = 0usize;
    let mut index = 0usize;

    while index < content.len() {
        if content[index..].starts_with("[[") {
            if let Some(offset) = content[index + 2..].find("]]") {
                let end = index + 2 + offset;
                let inner = &content[index + 2..end];
                let (target, rest) = match inner.find(['|', '#']) {
                    Some(position) => (&inner[..position], &inner[position..]),
                    None => (inner, ""),
                };
                if target.trim().eq_ignore_ascii_case(old_stem) {
                    out.push_str(&content[cursor..index]);
                    out.push_str("[[");
                    out.push_str(new_stem);
                    out.push_str(rest);
                    out.push_str("]]");
                    cursor = end + 2;
                    index = end + 2;
                    continue;
                }
            }
        }
        // 按字符前进，保证 index 始终落在 UTF-8 边界上
        index += content[index..]
            .chars()
            .next()
            .map(|character| character.len_utf8())
            .unwrap_or(1);
    }

    out.push_str(&content[cursor..]);
    out
}

/// 扫描仓库内所有笔记，把指向 `old_name` 的 wiki 引用改成 `new_name`。
/// 返回被改动的笔记（仓库相对路径）。
fn update_wiki_references(
    root: &Path,
    old_name: &str,
    new_name: &str,
) -> Result<Vec<String>, String> {
    let old_stem = old_name.trim_end_matches(".md");
    let new_stem = new_name.trim_end_matches(".md");
    if old_stem == new_stem {
        return Ok(Vec::new());
    }

    let mut notes = Vec::new();
    walk_entries(root, root, &mut notes, 0);

    let mut updated = Vec::new();
    for note in notes {
        if note.is_dir || !note.name.to_lowercase().ends_with(".md") {
            continue;
        }
        let full = root.join(&note.path);
        let Ok(content) = fs::read_to_string(&full) else {
            continue; // 非 UTF-8 等异常文件跳过，不影响改名本身
        };
        let replaced = replace_wiki_targets(&content, old_stem, new_stem);
        if replaced != content {
            fs::write(&full, replaced.as_bytes())
                .map_err(|e| format!("更新引用失败（{}）: {e}", note.path))?;
            updated.push(note.path);
        }
    }
    Ok(updated)
}

/// 重命名文件或目录，并同步更新其他笔记里对它的 wiki 引用。
///
/// 只改名称、不支持移动位置（想移动就改父目录，属于另一件事）。目标已存在时报错，
/// 不覆盖、也不静默加序号——重命名是"改名"，名字被占用应当让用户知道。
#[tauri::command]
pub fn rename_entry(vault: String, path: String, new_name: String) -> Result<RenameResult, String> {
    let root = vault_root(&vault)?;
    let source = resolve_existing(&root, &path)?;

    let clean = sanitize_new_name(&new_name)?;
    if clean.contains('/') {
        return Err("重命名只能改名称，不能改所在位置".into());
    }

    let is_dir = source.is_dir();
    let old_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "原名称含非法字符".to_string())?
        .to_string();

    let filename = if is_dir || clean.to_lowercase().ends_with(".md") {
        clean
    } else {
        format!("{clean}.md")
    };
    if filename == old_name {
        return Ok(RenameResult {
            path,
            updated: Vec::new(),
        });
    }

    let parent = source.parent().ok_or_else(|| "非法路径".to_string())?;
    let target = parent.join(&filename);
    if target.exists() {
        return Err(format!("「{filename}」已存在，请换个名字"));
    }

    fs::rename(&source, &target).map_err(|e| format!("重命名失败: {e}"))?;

    // 笔记改名要同步引用；目录改名后里面的文件路径变了，但 wiki 引用按文件名解析，不受影响
    let updated = if !is_dir && old_name.to_lowercase().ends_with(".md") {
        update_wiki_references(&root, &old_name, &filename).unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(RenameResult {
        path: to_relative(&root, &target)?,
        updated,
    })
}

/// 删除文件或目录：移进仓库内的 `.trash/`，**不是直接 unlink**。
///
/// 误删笔记是不可逆的损失，先保证能找回来是底线。`.trash` 是隐藏目录，不会出现在
/// 文件树与 wiki 索引里（枚举时跳过点开头的路径）。
/// （Obsidian 允许改为"移到系统回收站"，那需要额外的平台 API，暂未提供。）
#[tauri::command]
pub fn delete_entry(vault: String, path: String) -> Result<String, String> {
    let root = vault_root(&vault)?;
    let source = resolve_existing(&root, &path)?;

    if source == root {
        return Err("不能删除仓库根目录".into());
    }

    let trash = root.join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("创建回收目录失败: {e}"))?;

    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "名称含非法字符".to_string())?
        .to_string();
    let target = unique_path(&trash, &name);

    fs::rename(&source, &target).map_err(|e| format!("删除失败: {e}"))?;
    to_relative(&root, &target)
}

/// 写入一个附件（图片等二进制文件），返回实际写入的**仓库相对路径**。
///
/// 文件名冲突时自动加序号，不覆盖已有文件——粘贴附件属"新增"，静默覆盖用户文件
/// 是不可接受的。
#[tauri::command]
pub fn write_attachment(
    vault: String,
    folder: String,
    filename: String,
    data_base64: String,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let root = vault_root(&vault)?;
    let bytes = STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("附件数据解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("附件内容为空".into());
    }
    // 上限 64MB：足够放截图与照片，同时挡住误操作
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(format!("附件过大（{} 字节）", bytes.len()));
    }

    let name = sanitize_attachment_name(&filename)?;
    let folder_rel = folder.trim().trim_matches('/').to_string();
    let rel = if folder_rel.is_empty() {
        name.clone()
    } else {
        // folder 走与笔记相同的路径校验（拒绝隐藏目录与越界）
        let checked = validate_rel(&folder_rel)?;
        format!("{}/{}", checked.to_string_lossy().replace('\\', "/"), name)
    };

    let full = resolve_new(&root, &rel)?;
    let parent = full.parent().ok_or_else(|| format!("非法路径: {rel}"))?;
    let target = unique_path(parent, &name);

    fs::write(&target, &bytes).map_err(|e| format!("写入附件失败: {e}"))?;

    let relative = target
        .strip_prefix(&root)
        .map_err(|_| "写入结果越出仓库范围".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(relative)
}

/// 列出仓库内的目录与文件（不含隐藏路径）。
///
/// 前端用一份数据同时做三件事：渲染文件树（**含空目录**）、建立 wiki 语法的
/// 「文件名 → 相对路径」索引、统计笔记数量。因此目录与非 `.md` 文件都要返回。
#[tauri::command]
pub fn list_entries(vault: String) -> Result<Vec<EntryMeta>, String> {
    let root = vault_root(&vault)?;
    let mut out = Vec::new();
    walk_entries(&root, &root, &mut out, 0);
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(out)
}

fn read_note_at(root: &Path, path: &str) -> Result<NoteContent, String> {
    let full = resolve_existing(root, path)?;
    let bytes = fs::read(&full).map_err(|e| format!("读取失败: {e}"))?;
    let meta = fs::metadata(&full).map_err(|e| format!("读取元信息失败: {e}"))?;

    let has_bom = bytes.starts_with(UTF8_BOM);
    let body = if has_bom { &bytes[UTF8_BOM.len()..] } else { &bytes[..] };

    // 严格 UTF-8：不是 UTF-8 的文本文件宁可报错，也不要静默替换字符（会破坏内容）。
    let content = std::str::from_utf8(body)
        .map_err(|e| format!("文件不是合法 UTF-8（偏移 {}）", e.valid_up_to()))?
        .to_string();

    let (line_ending, mixed) = detect_line_ending(&content);

    Ok(NoteContent {
        path: path.to_string(),
        sync_sha256: sync_hash(&content),
        content,
        sha256: sha256_hex(&bytes),
        line_ending: line_ending.to_string(),
        mixed_line_endings: mixed,
        has_bom,
        size: meta.len(),
        modified: mtime_ms(&meta),
    })
}

#[tauri::command]
pub fn read_note(vault: String, path: String) -> Result<NoteContent, String> {
    let root = vault_root(&vault)?;
    read_note_at(&root, &path)
}

/// 读取一个**可能不存在**的文件：不存在时返回 `None`，而不是报错。
///
/// 库内配置 `quick-daily-note.json` 属于可有可无的文件——用户可能从没用过
/// Obsidian 插件，也可能是第一次用 Quick Note。用 `read_note` 会让"配置不存在"
/// 走报错路径，与"读盘失败"混成同一件事，前端就没法区分"没有配置"（按默认值走、
/// 首次修改时创建）和"配置读不出来"（应当提示用户）。
#[tauri::command]
pub fn read_note_optional(vault: String, path: String) -> Result<Option<NoteContent>, String> {
    let root = vault_root(&vault)?;
    let full = root.join(validate_rel(&path)?);
    if !full.is_file() {
        return Ok(None);
    }
    read_note_at(&root, &path).map(Some)
}

#[tauri::command]
pub fn write_note(
    vault: String,
    path: String,
    content: String,
    has_bom: bool,
) -> Result<WriteResult, String> {
    let root = vault_root(&vault)?;
    let full = resolve_new(&root, &path)?;

    let mut bytes = Vec::with_capacity(content.len() + UTF8_BOM.len());
    if has_bom {
        bytes.extend_from_slice(UTF8_BOM);
    }
    bytes.extend_from_slice(content.as_bytes());

    // 内容一致则不落盘：避免无谓地更新 mtime，触发同步与文件监听的连锁反应。
    if let Ok(existing) = fs::read(&full) {
        if existing == bytes {
            return Ok(WriteResult {
                sha256: sha256_hex(&bytes),
                bytes: bytes.len(),
                changed: false,
            });
        }
    }

    // 原子写：先写临时文件再改名。直接覆盖的话，并发读者（Obsidian、同步进程、
    // 验收脚本）可能读到半截 JSON/Markdown。
    let temp = full.with_extension("qntmp");
    fs::write(&temp, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&temp, &full).map_err(|e| format!("替换文件失败: {e}"))?;

    Ok(WriteResult {
        sha256: sha256_hex(&bytes),
        bytes: bytes.len(),
        changed: true,
    })
}

/// 同步扫描的一个文件。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileMeta {
    pub path: String,
    /// 同步口径的哈希，见 [`sync_hash`]。
    pub sync_sha256: String,
    pub has_bom: bool,
    pub size: u64,
    pub modified: u64,
}

/// 扫描到了但**不能同步**的文件。必须如实报告：静默跳过在界面上就是"这篇永远不同步"。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScanResult {
    pub files: Vec<SyncFileMeta>,
    pub skipped: Vec<SyncSkip>,
}

/// 是否在同步范围内。
///
/// 与插件 `inScope` 逐条对齐，其中两条是**刻意**的：
///
/// - `.md` 后缀**区分大小写**：服务端的扩展名白名单是 `path.endsWith(".md")`，
///   `笔记.MD` 推上去会让整批 400 被拒。少同步一个文件，好过让整批推送失败。
/// - 点开头的路径段跳过（`walk_entries` 已经做了），`.obsidian`、`.trash` 不会出去。
fn in_sync_scope(path: &str, scope: &str, folder: &str) -> bool {
    if !path.ends_with(".md") {
        return false;
    }
    if scope != "folder" {
        return true;
    }
    let folder = folder
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if folder.is_empty() {
        return true;
    }
    path.starts_with(&format!("{folder}/"))
}

/// 扫描同步范围内的笔记，返回每个文件的同步哈希（**不返回内容**——内容只在真要推送时读）。
///
/// 一次调用把"哪些文件与上次同步不一样"的原料全部取回，避免前端为每个文件来回一次
/// IPC；读盘与哈希都在这里做完，渲染进程只拿到一张小表。
///
/// 不是合法 UTF-8 的文件**跳过并报告**，不当成错误：Obsidian 读这种文件会把非法字节
/// 替换成 U+FFFD 再推上去，等于把文件改坏；我们宁可不同步它，也不制造这个改写。
#[tauri::command]
pub async fn sync_scan(
    vault: String,
    scope: String,
    folder: String,
) -> Result<SyncScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = vault_root(&vault)?;
        let mut entries = Vec::new();
        walk_entries(&root, &root, &mut entries, 0);

        let mut files = Vec::new();
        let mut skipped = Vec::new();
        for entry in entries {
            if entry.is_dir || !in_sync_scope(&entry.path, &scope, &folder) {
                continue;
            }
            let full = root.join(&entry.path);
            let bytes = match fs::read(&full) {
                Ok(value) => value,
                Err(e) => {
                    skipped.push(SyncSkip {
                        path: entry.path,
                        reason: format!("读取失败: {e}"),
                    });
                    continue;
                }
            };
            let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(&bytes);
            let content = match std::str::from_utf8(body) {
                Ok(value) => value,
                Err(e) => {
                    skipped.push(SyncSkip {
                        path: entry.path,
                        reason: format!("不是合法 UTF-8（偏移 {}）", e.valid_up_to()),
                    });
                    continue;
                }
            };
            files.push(SyncFileMeta {
                path: entry.path,
                sync_sha256: sync_hash(content),
                has_bom: bytes.starts_with(UTF8_BOM),
                size: entry.size,
                modified: entry.modified,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        skipped.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(SyncScanResult { files, skipped })
    })
    .await
    .map_err(|e| format!("扫描线程失败: {e}"))?
}

/// 读取一个附件（二进制）供同步上传。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryContent {
    pub path: String,
    /// 原始字节的 base64（附件不走文本，也不做任何编码转换）。
    pub base64: String,
    /// 原始字节的 SHA-256。与同步服务端的哈希口径一致（都是对文件字节）。
    pub sha256: String,
    pub size: u64,
    pub modified: u64,
}

/// 读取附件的原始字节。**不做任何规范化**——图片被改写一个字节，云端就多一份新版本。
#[tauri::command]
pub fn read_binary(vault: String, path: String) -> Result<BinaryContent, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let root = vault_root(&vault)?;
    let full = resolve_existing(&root, &path)?;
    let bytes = fs::read(&full).map_err(|e| format!("读取附件失败: {e}"))?;
    let meta = fs::metadata(&full).map_err(|e| format!("读取元信息失败: {e}"))?;
    Ok(BinaryContent {
        path,
        base64: STANDARD.encode(&bytes),
        sha256: sha256_hex(&bytes),
        size: meta.len(),
        modified: mtime_ms(&meta),
    })
}

/// 写入结果：实际写出的字节数与哈希。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryWriteResult {
    pub path: String,
    pub sha256: String,
    pub bytes: usize,
}

/// 把附件写到**指定路径**（同步用），返回实际写入的哈希。
///
/// 与 `write_attachment` 的区别是**不自动加序号**：那个是"粘贴新附件"，重名必须让路、
/// 绝不覆盖用户文件；这个是"把云端那份原样落回来"，路径由服务端指定，写偏了下一轮扫描
/// 就会把它当成另一个附件重复上传。所以这里允许覆盖，且逐级创建父目录。
#[tauri::command]
pub fn write_binary(vault: String, path: String, data_base64: String) -> Result<BinaryWriteResult, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let root = vault_root(&vault)?;
    let bytes = STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("附件数据解码失败: {e}"))?;
    // 与服务端同一条上限（10MB），本地再挡一道，省一次注定被 413 拒绝的请求。留了点余量。
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(format!("附件过大（{} 字节）", bytes.len()));
    }

    let full = resolve_new(&root, &path)?;
    fs::write(&full, &bytes).map_err(|e| format!("写入附件失败: {e}"))?;

    Ok(BinaryWriteResult {
        path: to_relative(&root, &full)?,
        sha256: sha256_hex(&bytes),
        bytes: bytes.len(),
    })
}

// ---------------------------------------------------------------- 附件引用扫描

/// 允许同步的附件扩展名（与后端 `AttachmentService.ALLOWED_EXTENSIONS` 一一对应）。
///
/// 刻意不含 svg：svg 能内联脚本，浏览器直出等于开了一条 XSS 通道。
/// 白名单必须与服务端一致——不一致的话本地会把注定被 400 拒的文件反复往上推。
const ATTACHMENT_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "pdf"];

/// 取路径的扩展名（小写）；目录名里的点不算。
fn extension_of(path: &str) -> String {
    let dot = path.rfind('.');
    let slash = path.rfind('/');
    match dot {
        Some(dot) if slash.map(|slash| dot > slash + 1).unwrap_or(true) => {
            path[dot + 1..].to_lowercase()
        }
        _ => String::new(),
    }
}

fn is_attachment_path(path: &str) -> bool {
    if path.ends_with(".md") || path.ends_with(".json") {
        return false;
    }
    if path.split('/').any(|segment| segment.starts_with('.')) {
        return false;
    }
    ATTACHMENT_EXTENSIONS.contains(&extension_of(path).as_str())
}

/// 取路径的文件名部分。
fn basename_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[index + 1..],
        None => path,
    }
}

/// 解码 `%XX`（markdown 链接里的中文/空格会写成这个形式）。
///
/// 非法序列**原样保留**而不是报错：一段坏链接不该让整轮扫描失败。
/// `+` 不当作空格——URL 路径里它是字面量（与服务端 `URLEncoder` 后的 `%20` 约定一致）。
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 去掉行内的代码片段（反引号包裹的部分）。
///
/// 笔记里讲用法的示例文本（```![[图.png]]```）不该被当成真引用，否则每轮同步都会为
/// 一张根本不存在的图发一次请求。判定办法：把成对的反引号之间的内容丢掉。
fn strip_inline_code(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find('`') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let ticks = after.chars().take_while(|c| *c == '`').count();
        let marker: String = std::iter::repeat('`').take(ticks).collect();
        let body_start = ticks;
        match after[body_start..].find(&marker) {
            Some(end) => {
                out.push(' ');
                rest = &after[body_start + end + ticks..];
            }
            None => {
                // 没有闭合：按普通文本处理（与 markdown 的宽容行为一致）
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// 从一行文本里收集附件引用的文件名（wiki 与 markdown 两种写法）。
fn collect_names_from_line(line: &str, out: &mut Vec<String>) {
    let text = strip_inline_code(line);
    let bytes = text.as_bytes();
    let mut index = 0;

    while index + 3 < bytes.len() {
        // `![[名字]]` / `![[名字|宽度]]`
        if bytes[index] == b'!' && bytes[index + 1] == b'[' && bytes[index + 2] == b'[' {
            let start = index + 3;
            if let Some(offset) = text[start..].find("]]") {
                let inner = &text[start..start + offset];
                let target = match inner.find('|') {
                    Some(pipe) => &inner[..pipe],
                    None => inner,
                };
                let name = basename_of(target.trim());
                if !name.is_empty() {
                    out.push(name.to_string());
                }
                index = start + offset + 2;
                continue;
            }
        }
        // `![](路径/名字.png)`，跳过外链
        if bytes[index] == b'!' && bytes[index + 1] == b'[' {
            if let Some(close) = text[index + 2..].find(']') {
                let after = index + 2 + close + 1;
                if after < bytes.len() && bytes[after] == b'(' {
                    let target_start = after + 1;
                    let rest = &text[target_start..];
                    let end = rest
                        .find(|c: char| c == ')' || c.is_whitespace())
                        .unwrap_or(rest.len());
                    let raw = &rest[..end];
                    // 外链（http:、data: 等）不碰
                    let is_external = raw
                        .find(':')
                        .map(|colon| {
                            colon > 0
                                && raw[..colon].chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
                                && raw[..colon]
                                    .chars()
                                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
                        })
                        .unwrap_or(false);
                    if !is_external && !raw.is_empty() {
                        let decoded = percent_decode(raw);
                        let name = basename_of(&decoded);
                        if !name.is_empty() {
                            out.push(name.to_string());
                        }
                    }
                    index = target_start + end;
                    continue;
                }
            }
        }
        index += 1;
    }
}

/// 从一篇笔记的正文里提取所有附件引用的文件名（跳过围栏代码块与行内代码）。
fn extract_attachment_names(content: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut fence: Option<char> = None;
    for line in content.split('\n') {
        let trimmed = line.trim_start();
        let fence_char = if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        if let Some(marker) = fence_char {
            // 只用同一种字符的围栏才能闭合（与 markdown 一致）
            if fence.is_none() {
                fence = Some(marker);
            } else if fence == Some(marker) {
                fence = None;
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        collect_names_from_line(line, &mut names);
    }
    names
}

/// 被范围内笔记引用到的附件。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferencedAttachment {
    /// 解析出的库内路径（本地确实存在这个文件）。
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: u64,
}

/// 被引用、但本地没有这个文件：只能带着文件名去云端问。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingAttachment {
    pub name: String,
    /// 引用它的笔记路径。服务端解析同名文件时优先看这个目录（与 Obsidian 一致）。
    pub from: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentScanResult {
    /// 被引用且本地存在的附件（**已解析出路径**，与 Obsidian 的 resolvedLinks 等价）。
    pub referenced: Vec<ReferencedAttachment>,
    /// 被引用但本地没有的（等价于 Obsidian 的 unresolvedLinks）。
    pub missing: Vec<MissingAttachment>,
}

/// 在候选路径里挑一个：**同目录优先 → 最短路径 → 字典序**。
///
/// 这套顺序必须与**服务端**（`AttachmentService.resolveByName`）一致。不一致的后果不是
/// 显示问题：按名字取回的文件会落到另一个路径上，而下一轮扫描会把它当成另一个附件
/// 重复上传，云端就多出一份。
fn resolve_by_name(candidates: &[String], name: &str, from: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let matching: Vec<&String> = candidates
        .iter()
        .filter(|path| basename_of(path).to_lowercase() == lower)
        .collect();
    if matching.is_empty() {
        return None;
    }
    // 同目录优先
    if let Some(slash) = from.rfind('/') {
        let dir = &from[..slash + 1];
        let same_dir = format!("{dir}{name}");
        if let Some(found) = matching
            .iter()
            .find(|path| path.to_lowercase() == same_dir.to_lowercase())
        {
            return Some((*found).clone());
        }
    }
    let mut sorted = matching;
    sorted.sort_by(|a, b| {
        a.chars()
            .count()
            .cmp(&b.chars().count())
            .then_with(|| a.cmp(b))
    });
    sorted.first().map(|path| (*path).clone())
}

/// 扫描被范围内笔记引用到的附件：本地有的给路径，本地缺的给名字。
///
/// 与插件同一套策略——**按引用扫，不按目录扫**。粘贴图片的落点取决于用户配置
/// （`pastedImageFolder`，或 Obsidian 原生的附件目录），盯目录必然漏；而按引用扫
/// 与落点无关。代价是没被任何笔记引用的图片不会上云，这正是要的效果：不镜像无用的二进制。
///
/// 这里是"从云端把图拉下来"唯一的入口：本地没有这个文件时，笔记里的链接在 Obsidian 里
/// 是**解析不到**的，所以"本地缺图"这件事恰好只会表现为"引用得到名字、却找不到文件"。
#[tauri::command]
pub async fn sync_scan_attachments(
    vault: String,
    scope: String,
    folder: String,
) -> Result<AttachmentScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = vault_root(&vault)?;
        let mut entries = Vec::new();
        walk_entries(&root, &root, &mut entries, 0);

        // 全库的附件路径（含范围外的目录：图片常躺在附件目录里，而那是日记目录之外）
        let candidates: Vec<String> = entries
            .iter()
            .filter(|entry| !entry.is_dir && is_attachment_path(&entry.path))
            .map(|entry| entry.path.clone())
            .collect();
        let meta_of = |path: &str| {
            entries
                .iter()
                .find(|entry| entry.path == path)
                .map(|entry| (entry.size, entry.modified))
                .unwrap_or((0, 0))
        };

        let mut referenced: Vec<ReferencedAttachment> = Vec::new();
        let mut missing: Vec<MissingAttachment> = Vec::new();
        let mut seen_referenced: HashSet<String> = HashSet::new();

        for entry in &entries {
            if entry.is_dir || !in_sync_scope(&entry.path, &scope, &folder) {
                continue;
            }
            let Ok(bytes) = fs::read(root.join(&entry.path)) else {
                continue;
            };
            let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(&bytes);
            let Ok(content) = std::str::from_utf8(body) else {
                continue; // 不是合法 UTF-8 的笔记已在 sync_scan 里报告过
            };
            for name in extract_attachment_names(content) {
                if !ATTACHMENT_EXTENSIONS.contains(&extension_of(&name).as_str()) {
                    continue;
                }
                match resolve_by_name(&candidates, &name, &entry.path) {
                    Some(path) => {
                        if seen_referenced.insert(path.clone()) {
                            let (size, modified) = meta_of(&path);
                            referenced.push(ReferencedAttachment {
                                path,
                                name,
                                size,
                                modified,
                            });
                        }
                    }
                    None => {
                        // 同一个名字在多篇笔记里被引用时只取第一处（服务端只需要一个"从哪来"）
                        if !missing.iter().any(|item| item.name == name) {
                            missing.push(MissingAttachment {
                                name,
                                from: entry.path.clone(),
                            });
                        }
                    }
                }
            }
        }

        referenced.sort_by(|a, b| a.path.cmp(&b.path));
        missing.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(AttachmentScanResult {
            referenced,
            missing,
        })
    })
    .await
    .map_err(|e| format!("扫描线程失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_hash_ignores_bom_but_keeps_line_endings() {
        let lf = "# 标题\n正文\n";
        let crlf = "# 标题\r\n正文\r\n";
        let cr = "# 标题\r正文\r";

        // 换行符风格不同 -> 哈希不同（两侧都不规范化，这正是要的）
        assert_ne!(sync_hash(lf), sync_hash(crlf));
        assert_ne!(sync_hash(lf), sync_hash(cr));
        assert_eq!(sync_hash(lf), sync_hash(lf));
        // 尾随换行参与哈希
        assert_ne!(sync_hash("a\n"), sync_hash("a"));
        // 与 sha256 库的已知值一致（空串）
        assert_eq!(
            sync_hash(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sync_scope_matches_plugin_rules() {
        assert!(in_sync_scope("日记/2026-09-15 测试.md", "folder", "日记"));
        assert!(in_sync_scope("日记/2026-09-15 测试.md", "folder", "日记/"));
        assert!(in_sync_scope("日记/2026-09-15 测试.md", "folder", " 日记 "));
        assert!(in_sync_scope("日记/2026-09-15 测试.md", "folder", "日记\\"));
        assert!(in_sync_scope("anywhere/at/all.md", "vault", "日记"));
        // 根目录（folder 为空）时整个库都在范围内——与插件的 `folder === ""` 一致
        assert!(in_sync_scope("a.md", "folder", ""));

        // 日记目录之外的不推
        assert!(!in_sync_scope("笔记/a.md", "folder", "日记"));
        // 前缀相同但不是子目录
        assert!(!in_sync_scope("日记本/a.md", "folder", "日记"));
        // 只推 .md；.MD 会被服务端整批拒绝，刻意与插件一致地放过它
        assert!(!in_sync_scope("日记/a.txt", "folder", "日记"));
        assert!(!in_sync_scope("日记/a.MD", "folder", "日记"));
        assert!(!in_sync_scope("quick-daily-note.json", "vault", ""));
    }

    #[test]
    fn rejects_traversal_and_hidden_paths() {
        assert!(validate_rel("notes/a.md").is_ok());
        assert!(validate_rel("../secret.md").is_err());
        assert!(validate_rel("notes/../../secret.md").is_err());
        assert!(validate_rel("/etc/passwd").is_err());
        assert!(validate_rel("notes\\a.md").is_err());
        assert!(validate_rel("").is_err());
        // 点开头的路径段一律拒绝
        assert!(validate_rel(".obsidian/app.json").is_err());
        assert!(validate_rel("notes/.hidden/a.md").is_err());
        // 文件名本身以点开头也算隐藏
        assert!(validate_rel("notes/.keep.md").is_err());
    }

    #[test]
    fn detects_line_endings() {
        assert_eq!(detect_line_ending("a\nb\n"), ("lf", false));
        assert_eq!(detect_line_ending("a\r\nb\r\n"), ("crlf", false));
        assert_eq!(detect_line_ending("a\rb\r"), ("cr", false));
        assert_eq!(detect_line_ending("no newline"), ("none", false));
        assert_eq!(detect_line_ending("a\r\nb\n"), ("crlf", true));
    }

    // ------------------------------------------------------------ 附件

    /// 引用提取：**围栏与行内代码里的示例不算引用**。
    ///
    /// 这一条直接决定"每轮同步会不会为一张不存在的图发请求"，而且笔记里讲用法的示例
    /// 恰恰最常写这种文本。
    #[test]
    fn extracts_attachment_names_but_skips_code() {
        let names = extract_attachment_names("![[图.png]]");
        assert_eq!(names, vec!["图.png"]);

        // 带宽度、带别名、带目录、带百分号编码
        assert_eq!(
            extract_attachment_names("![[图.png|300]]"),
            vec!["图.png"],
            "wiki 的 |宽度 写法"
        );
        assert_eq!(
            extract_attachment_names("![[image/图.png]]"),
            vec!["图.png"],
            "wiki 目标带目录时只看文件名"
        );
        assert_eq!(
            extract_attachment_names("![](attachments/%E5%9B%BE.png)"),
            vec!["图.png"],
            "markdown 链接里的百分号编码要解码"
        );
        assert_eq!(
            extract_attachment_names("![](attachments/a%20b.png)"),
            vec!["a b.png"],
            "空格在链接里是百分号编码的"
        );
        // 裸空格是 markdown 的「标题分隔符」，不是路径的一部分（`![](a b.png)` 的目标是 a）。
        // 这里**刻意与插件一致**：两边都按空格截断，于是"带空格的文件名"在两种写法下
        // 都解析不到——那本来就不是合法的 markdown 链接。
        assert_eq!(extract_attachment_names("![](a b.png)"), vec!["a"]);

        // 围栏代码块里的示例不算
        let fenced = "```\n![[示例.png]]\n```\n![[真的.png]]\n";
        assert_eq!(extract_attachment_names(fenced), vec!["真的.png"]);
        let tildes = "~~~\n![[示例.png]]\n~~~\n";
        assert!(extract_attachment_names(tildes).is_empty(), "~~~ 围栏同样要跳过");
        // 围栏内外的引号不配对时不能把整篇吞掉
        let unbalanced = "```\n![[示例.png]]\n";
        assert!(extract_attachment_names(unbalanced).is_empty());

        // 行内代码里的示例不算
        assert_eq!(
            extract_attachment_names("写成 `![[示例.png]]` 才是嵌入"),
            Vec::<String>::new()
        );
        assert_eq!(
            extract_attachment_names("`![[示例.png]]` 与 ![[真的.png]]"),
            vec!["真的.png"],
            "行内代码之外的引用仍然要认出来"
        );

        // 外链不碰（那不是一个库内文件）
        assert!(extract_attachment_names("![](https://example.com/a.png)").is_empty());
        assert!(extract_attachment_names("![](data:image/png;base64,AAAA)").is_empty());
        // 提取只管"名字"，不管扩展名——白名单过滤在扫描处做（与插件同构），
        // 但 .md 是 wiki 链接的正常形态，提取层同样交出去
        assert_eq!(extract_attachment_names("![[笔记.md]]"), vec!["笔记.md"]);
        assert_eq!(extract_attachment_names("![[图.svg]]"), vec!["图.svg"]);
    }

    /// 同名文件的解析顺序必须与**服务端**一致，否则取回的图会落到另一个路径上，
    /// 下一轮扫描把它当成另一个附件重复上传。
    #[test]
    fn resolves_referenced_name_same_dir_then_shortest() {
        let candidates = vec![
            "deep/nested/dir/a.png".to_string(),
            "attachments/a.png".to_string(),
            "日记/a.png".to_string(),
        ];
        // 同目录优先（哪怕它不是最短的）
        assert_eq!(
            resolve_by_name(&candidates, "a.png", "日记/2026-09-15.md").unwrap(),
            "日记/a.png"
        );
        // 没有同目录的 -> 最短路径（按字符数，与后端 CHAR_LENGTH 一致）
        assert_eq!(
            resolve_by_name(&candidates, "a.png", "别的/x.md").unwrap(),
            "日记/a.png"
        );
        // 大小写不敏感（Windows 上文件名本来就不区分）
        assert_eq!(
            resolve_by_name(&candidates, "A.PNG", "attachments/x.md").unwrap(),
            "attachments/a.png"
        );
        // 找不到就是找不到
        assert!(resolve_by_name(&candidates, "没有.png", "a.md").is_none());
        // 路径里的目录不参与匹配：调用方应当已经取了 basename
        assert!(resolve_by_name(&candidates, "sub/a.png", "a.md").is_none());
    }

    #[test]
    fn classifies_attachment_paths() {
        assert!(is_attachment_path("attachments/图.png"));
        assert!(is_attachment_path("图.JPEG"), "扩展名大小写不敏感");
        assert!(is_attachment_path("a/b/c.pdf"));
        // 正文与配置不算附件
        assert!(!is_attachment_path("日记/a.md"));
        assert!(!is_attachment_path("quick-daily-note.json"));
        // 点开头的目录整体不同步（.trash 里的东西不该上云）
        assert!(!is_attachment_path(".trash/图.png"));
        assert!(!is_attachment_path("a/.hidden/图.png"));
        // 白名单之外
        assert!(!is_attachment_path("图.svg"), "svg 能内联脚本，刻意不支持");
        assert!(!is_attachment_path("a.txt"));
        assert!(!is_attachment_path("没有扩展名"));
    }

    #[test]
    fn percent_decoding_keeps_broken_sequences() {
        assert_eq!(percent_decode("%E5%9B%BE.png"), "图.png");
        assert_eq!(percent_decode("a%20b.png"), "a b.png");
        assert_eq!(percent_decode("50%25.png"), "50%.png");
        // 坏的序列原样保留：一段坏链接不该让整轮扫描失败
        assert_eq!(percent_decode("a%zz.png"), "a%zz.png");
        assert_eq!(percent_decode("a%2.png"), "a%2.png");
        assert_eq!(percent_decode("%"), "%");
    }
}

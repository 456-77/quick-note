//! 移动端仓库基础目录（vault home）：多仓库模型的根。
//!
//! ## 模型
//!
//! Android 上不把仓库固定在私有沙箱，而是让用户选一个**基础目录**（如
//! `Documents/QuickNote/`，也可以是网盘客户端同步出真实文件的目录），其下的
//! 一级子目录各是一个仓库。选目录走 SAF 选择器，但**只取路径**：把返回的
//! `content://` 树 URI 换算成真实路径（`primary:QuickNote` →
//! `/storage/emulated/0/QuickNote`），之后全部读写走原生 `std::fs`，
//! `vault.rs` 的路径模型零改动。前提是「所有文件访问」权限
//! （`MANAGE_EXTERNAL_STORAGE`，侧载分发无商店审核约束）。
//!
//! ## 为什么存指针文件而不是 localStorage
//!
//! 与桌面 `data_dir.rs` 的指针文件同一套理由：基础目录是**设备级**事实，
//! localStorage 会随 WebView 数据清理一起消失，而这不该让用户重新选目录。
//! 指针放应用配置目录（`vault-home.txt`），坏了就当未设置，回退引导页。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 指针文件名（放应用配置目录下）。
const POINTER_FILE: &str = "vault-home.txt";
/// 主存储卷的挂载点（SAF 树 URI 里 `primary:` 对应的物理路径）。
const PRIMARY_ROOT: &str = "/storage/emulated/0";
/// 仓库发现的探测深度：子目录里的 .md 也算（日记/子目录结构），再深就不再翻了。
const DISCOVER_DEPTH: usize = 3;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// 仓库绝对路径（真实路径，可直接当 vault 参数用）。
    pub path: String,
    /// 目录名（= 默认云端仓库名，与插件 `app.vault.getName()` 同语义）。
    pub name: String,
    /// 深度限定的 .md 数量（列表展示用，不追求精确）。
    pub note_count: u32,
    /// 最新一篇 .md 的修改时间（毫秒）；空仓库为 0。
    pub last_modified: u64,
    /// 目录里有 quick-daily-note.json 或 .obsidian（强仓库特征，空目录不算）。
    pub has_vault_marker: bool,
}

// ------------------------------------------------------------------ 指针文件

fn pointer_path(app: &AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(POINTER_FILE))
        .map_err(|e| format!("无法定位配置目录: {e}"))
}

/// 读基础目录指针。内容为空、文件不存在或路径不是目录都算「未设置」。
fn read_home(app: &AppHandle) -> Option<PathBuf> {
    let path = pointer_path(app).ok()?;
    let text = fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let dir = PathBuf::from(trimmed);
    if dir.is_dir() {
        Some(dir)
    } else {
        None // 目录被用户删了：回退引导页重新选，指针会在重设时覆盖
    }
}

// ------------------------------------------------------------------ SAF URI → 真实路径

/// 把 SAF 目录选择器返回的树 URI 换算成真实文件路径。
///
/// `…/tree/primary%3AQuickNote` 与 `…/document/primary%3AQuickNote` 两种形态都认；
/// 只支持主存储卷（`primary:`，即 `/storage/emulated/0/`）——扩展卡/OTG 的挂载点
/// 因机型而异，v1 不做（选了会明确报错，而不是悄悄写错地方）。
pub fn saf_uri_to_real_path(uri: &str) -> Result<String, String> {
    let decoded = uri
        .replace("%3A", ":")
        .replace("%3a", ":")
        .replace("%2F", "/")
        .replace("%2f", "/");
    // 只认系统文件选择器（DocumentsUI）对本地存储的标准 provider；
    // 其他 provider（第三方网盘的 DocumentsProvider 等）没有 primary 卷语义
    if !decoded.starts_with("content://com.android.externalstorage.documents/") {
        return Err(format!("只支持系统文件选择器返回的本地存储目录: {uri}"));
    }
    // 目录选择器返回的是完整形态 `tree/primary:X/document/primary:X`：基础目录的
    // 语义在 tree/ 段里，先截掉尾随的 document 段再取卷与路径
    let tree_part = decoded.split("/document/").next().unwrap_or(&decoded);
    let marker = if let Some(pos) = tree_part.find("tree/primary:") {
        pos + "tree/primary:".len()
    } else if let Some(pos) = decoded.find("document/primary:") {
        pos + "document/primary:".len()
    } else {
        return Err(format!("只支持主存储（内部存储）里的目录：{uri}"));
    };
    let rest = tree_part[marker..].trim_matches('/');
    if rest.is_empty() {
        return Ok(PRIMARY_ROOT.to_string());
    }
    // 剩余部分必须是普通路径段（不含 `:`/`?`——那些意味着这不是纯文件路径）
    if rest.contains(':') || rest.contains('?') {
        return Err(format!("无法换算成真实路径: {uri}"));
    }
    Ok(format!("{PRIMARY_ROOT}/{rest}"))
}

// ------------------------------------------------------------------ 可写探测

/// 探测目录可写：真实建一个临时文件再删掉。权限有没有，应以文件系统为准——
/// 「所有文件访问」在系统设置里授予，Rust 侧没有可靠的查询 API，探测即真值。
fn probe_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(format!(".qn-probe-{}", std::process::id()));
    fs::write(&probe, b"ok")
        .map_err(|e| format!("目录不可写（可能缺少「所有文件访问」权限）: {e}"))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

// ------------------------------------------------------------------ 仓库发现

/// 深度限定的 .md 统计与最新修改时间。顺带判定强仓库特征。
fn scan_vault_dir(dir: &Path, depth: usize, state: &mut (u32, u64, bool)) {
    if depth > DISCOVER_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            if name == ".obsidian" {
                state.2 = true;
            }
            continue;
        }
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => scan_vault_dir(&path, depth + 1, state),
            Ok(kind) if kind.is_file() => {
                if name == "quick-daily-note.json" {
                    state.2 = true;
                }
                let is_md = name.to_ascii_lowercase().ends_with(".md");
                if is_md {
                    state.0 += 1;
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(mtime) = meta.modified() {
                            if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                                state.1 = state.1.max(dur.as_millis() as u64);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// 列出基础目录下的仓库（一级子目录，深度限定扫描）。
#[tauri::command]
pub fn list_vaults(app: AppHandle) -> Result<Vec<VaultInfo>, String> {
    let Some(home) = read_home(&app) else {
        return Ok(Vec::new()); // 未设置：空列表，前端显示引导
    };
    let mut vaults = Vec::new();
    let Ok(entries) = fs::read_dir(&home) else {
        return Err(format!("基础目录不可读: {}", home.display()));
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let mut state = (0u32, 0u64, false);
        scan_vault_dir(&path, 0, &mut state);
        vaults.push(VaultInfo {
            path: path.to_string_lossy().into_owned(),
            name: name.to_string(),
            note_count: state.0,
            last_modified: state.1,
            has_vault_marker: state.2,
        });
    }
    vaults.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(vaults)
}

/// 在基础目录下新建一个仓库（空目录即合法仓库），返回其路径。
#[tauri::command]
pub fn create_vault(app: AppHandle, name: String) -> Result<String, String> {
    let Some(home) = read_home(&app) else {
        return Err("尚未设置基础目录".into());
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("仓库名不能为空".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.starts_with('.') {
        return Err(format!("仓库名不能含路径分隔符或以点开头: {trimmed}"));
    }
    let dir = home.join(trimmed);
    if dir.exists() {
        return Err(format!("同名目录已存在: {trimmed}（直接从列表打开即可）"));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建仓库失败: {e}"))?;
    probe_writable(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ 命令

/// 查询基础目录（未设置返回 null）。设置页「存储」分区与引导页共用。
#[tauri::command]
pub fn vault_home_get(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_home(&app).map(|p| p.to_string_lossy().into_owned()))
}

/// 用 SAF 选择器返回的 URI 设置基础目录（换算真实路径后走 set_from_path）。
#[tauri::command]
pub fn vault_home_set_from_uri(app: AppHandle, uri: String) -> Result<String, String> {
    let real = saf_uri_to_real_path(&uri)?;
    vault_home_set_from_path(app, real)
}

/// 直接用真实路径设置基础目录（Android 引导页的「建议目录」通道——
/// 「所有文件访问」授权后原生 fs 直达，不需要 SAF）。
#[tauri::command]
pub fn vault_home_set_from_path(app: AppHandle, path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录不能为空".into());
    }
    if !trimmed.starts_with('/') {
        return Err(format!("目录必须是绝对路径: {trimmed}"));
    }
    let dir = PathBuf::from(trimmed);
    fs::create_dir_all(&dir).map_err(|e| format!("创建基础目录失败: {e}"))?;
    probe_writable(&dir)?;
    let pointer = pointer_path(&app)?;
    if let Some(parent) = pointer.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    fs::write(&pointer, trimmed).map_err(|e| format!("写入基础目录指针失败: {e}"))?;
    Ok(trimmed.to_string())
}

/// 清除基础目录（回引导页）。仓库文件不动。
#[tauri::command]
pub fn vault_home_clear(app: AppHandle) -> Result<(), String> {
    let pointer = pointer_path(&app)?;
    if pointer.is_file() {
        fs::remove_file(pointer).map_err(|e| format!("清除基础目录设置失败: {e}"))?;
    }
    Ok(())
}

/// 权限/目录可写性探测：无基础目录时探测主存储根，有则探测基础目录本身。
/// 前端在授权引导后（用户从系统设置回来）调用它重查。
#[tauri::command]
pub fn storage_writable(app: AppHandle) -> Result<bool, String> {
    let dir = read_home(&app).unwrap_or_else(|| PathBuf::from(PRIMARY_ROOT));
    if !dir.is_dir() {
        return Ok(false);
    }
    Ok(probe_writable(&dir).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saf_uri_primary_tree() {
        assert_eq!(
            saf_uri_to_real_path(
                "content://com.android.externalstorage.documents/tree/primary%3AQuickNote/document/primary%3AQuickNote"
            )
            .unwrap(),
            "/storage/emulated/0/QuickNote"
        );
        assert_eq!(
            saf_uri_to_real_path(
                "content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FQuickNote"
            )
            .unwrap(),
            "/storage/emulated/0/Documents/QuickNote"
        );
        // 根目录本身
        assert_eq!(
            saf_uri_to_real_path("content://com.android.externalstorage.documents/tree/primary%3A")
                .unwrap(),
            PRIMARY_ROOT
        );
    }

    #[test]
    fn saf_uri_rejects_non_primary() {
        // 扩展卡卷（如 0000-0000）与下载 URI 都不支持
        assert!(saf_uri_to_real_path(
            "content://com.android.externalstorage.documents/tree/0000-0000%3ANotes"
        )
        .is_err());
        assert!(saf_uri_to_real_path("content://some.other.provider/tree/primary%3AX").is_err());
    }
}

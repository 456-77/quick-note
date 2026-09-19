//! 应用数据目录：查询与自定义位置。
//!
//! ## 数据都在哪
//!
//! - **WebView 数据目录**（localStorage：应用设置、快捷键、收藏、最近打开；以及
//!   浏览器缓存）：默认 `%LOCALAPPDATA%/<identifier>/EBWebView`。
//! - **配置目录**（本机同步状态 `sync-state.json`、数据目录指针文件）：
//!   `%APPDATA%/<identifier>`（Tauri 的 `app_config_dir`）。
//! - **笔记本身**：用户选择的仓库目录，与本模块无关——换数据目录绝不碰仓库。
//!
//! ## 自定义位置怎么生效
//!
//! 指针文件 `<config_dir>/data-dir.txt` 存自定义目录的路径。WebView 创建**之前**
//! 读它并设置 `WEBVIEW2_USER_DATA_FOLDER`，把整个 WebView 数据目录（含 localStorage）
//! 挪过去。首次启用时把默认位置的 `EBWebView` 搬到新位置（同盘 rename，跨盘复制），
//! 设置与收藏无缝跟过去。改动**重启后生效**。

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 数据目录指针文件（放配置目录下）。
const POINTER_FILE: &str = "data-dir.txt";
/// WebView2 在用户数据目录下实际存放配置与缓存的子目录名。
const WEBVIEW_SUBDIR: &str = "EBWebView";
/// 应用标识。pre-builder 阶段拿不到 AppHandle，只能与 tauri.conf.json 保持一致。
const IDENTIFIER: &str = "com.quicknote.app";

#[derive(serde::Serialize)]
pub struct AppDataPaths {
    /// 配置目录：同步状态与指针文件所在（`app_config_dir`）。
    pub config_dir: String,
    /// 默认数据目录的上级（`app_local_data_dir`，WebView 数据默认在它的 EBWebView 子目录）。
    pub local_data_dir: String,
    /** 当前生效的 WebView 数据目录（自定义 > 默认）。 */
    pub webview_data_dir: String,
    /// 自定义数据目录（指针文件的内容）；未设置时为 null。
    pub custom_data_dir: Option<String>,
}

// ------------------------------------------------------------------ 指针文件

fn pointer_path(config_dir: &Path) -> PathBuf {
    config_dir.join(POINTER_FILE)
}

/// 读指针文件。内容为空或目录不存在都算"未设置"。
fn read_pointer(config_dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(pointer_path(config_dir)).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn write_pointer(config_dir: &Path, value: &Path) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    fs::write(pointer_path(config_dir), value.to_string_lossy().as_bytes())
        .map_err(|e| format!("写入数据目录指针失败: {e}"))
}

// ------------------------------------------------------------------ pre-builder

/// pre-builder 阶段可用的配置目录（与 Tauri `app_config_dir` 同一位置）。
fn config_dir_raw() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|base| PathBuf::from(base).join(IDENTIFIER))
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            if Path::new(&xdg).is_absolute() {
                return Some(PathBuf::from(xdg).join(IDENTIFIER));
            }
        }
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join(IDENTIFIER))
    }
}

/// pre-builder 阶段可用的默认 WebView 数据目录（与 Tauri v2 的默认一致）。
fn default_webview_data_dir_raw() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|base| PathBuf::from(base).join(IDENTIFIER).join(WEBVIEW_SUBDIR))
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// 递归复制目录（跨盘迁移用；源与目标不同盘时 rename 会失败）。
pub(crate) fn copy_dir_all(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_dir_all(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

/// 启动早期调用：读指针文件，必要时迁移旧数据，然后设置 WebView2 的数据目录。
///
/// 任何失败都静默回退到默认位置——数据目录是"锦上添花"的设置，
/// 不能因为它让应用起不来。
pub fn configure_webview_data_dir() {
    let Some(config_dir) = config_dir_raw() else {
        return;
    };
    let Some(custom) = read_pointer(&config_dir) else {
        return;
    };
    let Ok(custom) = custom.canonicalize() else {
        return; // 目录被手动删了：回退默认，指针留着（建好目录后重启即再生效）
    };

    // 旧数据迁移：默认位置有数据、新位置还没有 → 整体搬过去。
    // 两边都不是同一目录才动（自定义目录选成默认目录本身时不能自我吞噬）。
    if let Some(default_dir) = default_webview_data_dir_raw() {
        if let (Ok(source), Ok(target_parent)) = (default_dir.canonicalize(), custom.canonicalize())
        {
            let target = target_parent.join(WEBVIEW_SUBDIR);
            let same = source == target;
            if !same && source.is_dir() && !target.exists() {
                let moved = fs::rename(&source, &target).or_else(|_| {
                    copy_dir_all(&source, &target).and_then(|_| fs::remove_dir_all(&source))
                });
                let _ = moved; // 失败不阻塞启动：用户可以重建目录后重试
            }
        }
    }

    if fs::create_dir_all(&custom).is_ok() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &custom);
    }
}

// ------------------------------------------------------------------ 命令

fn paths_of(app: &AppHandle) -> Result<AppDataPaths, String> {
    let config = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    let local = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    let custom = read_pointer(&config);
    Ok(AppDataPaths {
        config_dir: config.to_string_lossy().into_owned(),
        local_data_dir: local.to_string_lossy().into_owned(),
        webview_data_dir: custom
            .clone()
            .unwrap_or_else(|| local.join(WEBVIEW_SUBDIR))
            .to_string_lossy()
            .into_owned(),
        custom_data_dir: custom.map(|p| p.to_string_lossy().into_owned()),
    })
}

/// 查询应用数据目录（设置面板「存储」分区用）。
#[tauri::command]
pub fn app_data_paths(app: AppHandle) -> Result<AppDataPaths, String> {
    paths_of(&app)
}

/// 设置/清除自定义数据目录。改动重启后生效；返回最新路径表。
#[tauri::command]
pub fn set_custom_data_dir(app: AppHandle, path: Option<String>) -> Result<AppDataPaths, String> {
    let config = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    match path {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("数据目录不能为空".into());
            }
            let dir = PathBuf::from(trimmed);
            if !dir.is_dir() {
                fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
            }
            write_pointer(&config, &dir)?;
        }
        None => {
            let pointer = pointer_path(&config);
            if pointer.is_file() {
                fs::remove_file(&pointer).map_err(|e| format!("清除数据目录设置失败: {e}"))?;
            }
        }
    }
    paths_of(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quick-note-data-dir-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pointer_roundtrip_and_empty() {
        let dir = temp_dir("pointer");
        assert!(read_pointer(&dir).is_none());

        write_pointer(&dir, Path::new("D:\\qn-data")).unwrap();
        assert_eq!(
            read_pointer(&dir).unwrap(),
            PathBuf::from("D:\\qn-data")
        );

        // 空内容视为未设置
        fs::write(pointer_path(&dir), "  \n").unwrap();
        assert!(read_pointer(&dir).is_none());
    }

    #[test]
    fn copies_recursively() {
        let dir = temp_dir("copy");
        let source = dir.join("src");
        fs::create_dir_all(source.join("nested/deep")).unwrap();
        fs::write(source.join("a.txt"), "a").unwrap();
        fs::write(source.join("nested/b.txt"), "b").unwrap();
        fs::write(source.join("nested/deep/c.txt"), "c").unwrap();

        let target = dir.join("dst");
        copy_dir_all(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "a");
        assert_eq!(fs::read_to_string(target.join("nested/b.txt")).unwrap(), "b");
        assert_eq!(
            fs::read_to_string(target.join("nested/deep/c.txt")).unwrap(),
            "c"
        );
    }
}

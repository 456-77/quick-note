//! 每台设备独立的同步状态（游标、各文件上次同步的内容哈希、令牌、账号）。
//!
//! ## 为什么不放在仓库里
//!
//! 与插件的 `data.json` 同一个理由：这些是**每台设备各一份**的东西。写进仓库会被
//! 同步出去、被别的设备覆盖——最典型的翻车是"新设备把全部文件误判为本地离线删除
//! 而推墓碑"（插件的 `normalizeSyncState` 注释里记着这次事故）。
//!
//! ## 为什么不放在 localStorage
//!
//! WebView 的数据目录被清一次（换 identifier、清缓存、重装），游标与哈希就没了；
//! 那时每篇笔记都会被判成"本地改过"，与云端撞成一片冲突。放成一个文件更经得起折腾，
//! 用户也能直接看、直接备份。
//!
//! ## 格式由前端决定
//!
//! 这里只当作一段不透明文本存取（`String` 进、`String` 出），不解析、不理解字段。
//! 同步状态的形状全在 `src/lib/sync.ts` 里定义，那边能在 Node 里直接断言；
//! 在 Rust 里再造一份 schema 只会让两边慢慢分叉。
//!
//! ⚠️ 文件里含服务端密码（明文，与插件的 data.json 一样）。它必须在设备本地配置文件
//! 目录下，**绝不能**放进仓库——那会把凭据同步到服务端。

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const STATE_FILE: &str = "sync-state.json";

/// 状态文件路径（配置文件目录，随 identifier 走）。
///
/// 测试变体用了独立 identifier，因此 GUI 测试读写的是它自己的状态文件，
/// 不会碰到日常使用的那一份。
fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    Ok(dir.join(STATE_FILE))
}

/// 读取同步状态。文件不存在返回 `None`（首次使用不是错误）。
#[tauri::command]
pub fn sync_state_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("读取同步状态失败: {e}"))
}

/// 写入同步状态（先写临时文件再改名，避免中途断电留下半截 JSON）。
#[tauri::command]
pub fn sync_state_save(app: AppHandle, text: String) -> Result<(), String> {
    let path = state_path(&app)?;
    save_at(&path, &text)
}

fn save_at(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text.as_bytes()).map_err(|e| format!("写入同步状态失败: {e}"))?;
    fs::rename(&temp, path).map_err(|e| format!("替换同步状态失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quick-note-sync-store-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_and_replaces_atomically() {
        let dir = temp_dir("basic");
        let path = dir.join(STATE_FILE);

        save_at(&path, "{\"cursor\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"cursor\":1}");

        save_at(&path, "{\"cursor\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"cursor\":2}");
        // 临时文件不留下
        assert!(!path.with_extension("json.tmp").exists());
    }
}

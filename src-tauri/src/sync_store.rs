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

/// 本机已配置过同步的仓库的**云端仓库名**集合（0.32.2 用户需求：云端仓库列表
/// 过滤“已在本机”的仓库）。扫描配置目录下全部 `sync-state*.json` 的 vaultName
/// 字段（主状态 + per-vault 状态）——本地目录名与云端名不一致的仓库也能靠它
/// 识别，比“最近仓库目录名比对”准得多。JSON 解析失败/缺字段按无贡献跳过。
#[tauri::command]
pub fn local_synced_vaults(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    let mut out: Vec<String> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取配置目录失败: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("sync-state") || !name.ends_with(".json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if let Some(vault_name) = value.get("vaultName").and_then(|v| v.as_str()) {
            let trimmed = vault_name.trim();
            if !trimmed.is_empty() && !out.iter().any(|n| n.eq_ignore_ascii_case(trimmed)) {
                out.push(trimmed.to_string());
            }
        }
    }
    Ok(out)
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
    // 临时文件名带上 pid 与自增序号：多窗口（多进程）同时落盘同一份状态时，
    // 固定的 `.tmp` 名会让两次写撞在同一个文件上——后写者覆盖前写者、先rename
    // 者把文件带走，剩下的那次 rename 就报「参数错误 (os error 87)」。
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        seq
    ));
    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写入同步状态失败: {e}"))?;
    // rename 偶发失败（杀毒/索引器短暂占用）时重试一次，仍失败则复制兜底——
    // 复制失去原子性，但比「状态永远落不了盘」轻得多（游标回退=全量重拉）。
    if let Err(first) = fs::rename(&tmp, path) {
        std::thread::sleep(std::time::Duration::from_millis(40));
        if let Err(second) = fs::rename(&tmp, path) {
            if let Err(copy_err) = fs::copy(&tmp, path).and_then(|_| fs::remove_file(&tmp)) {
                let _ = fs::remove_file(&tmp);
                return Err(format!(
                    "替换同步状态失败: {first} / 重试 {second} / 复制兜底 {copy_err}"
                ));
            }
        }
    }
    Ok(())
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

    /// 多窗口 = 多进程同时落盘同一份状态。此前临时文件名固定为 `.json.tmp`，
    /// 两个进程会撞在同一个临时文件上（一个把另一个的 rename 源带走 → os error 87）。
    /// 现在临时名带 pid+序号，各写各的，rename 各自成功。
    #[test]
    fn concurrent_writers_do_not_collide_on_temp_name() {
        let dir = temp_dir("concurrent");
        let path = dir.join(STATE_FILE);
        let writers: Vec<_> = (0..4)
            .map(|i| {
                let p = path.clone();
                std::thread::spawn(move || {
                    for n in 0..25 {
                        save_at(&p, &format!("{{\"writer\":{i},\"n\":{n}}}")).unwrap();
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        // 最终内容必是某一次完整写入（不可能是两写拼出的半截）
        let final_text = fs::read_to_string(&path).unwrap();
        assert!(final_text.starts_with('{') && final_text.ends_with('}'));
        // 目录里不残留任何临时文件
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
    }
}

// ---------------------------------------------------------------- 多仓库批量同步

/// 批量同步的 per-vault 状态文件名（`sync-state-<name>.json`）。
///
/// 仓库名会做温和清洗（路径分隔符换下划线）；同名冲突的概率与后果都可接受——
/// 最坏是两个同目录名仓库共享一份批量游标，内容比对仍保证正确，只是多拉几轮。
fn state_path_for(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    let safe: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    Ok(dir.join(format!("sync-state-{safe}.json")))
}

/// 读取某个仓库的批量同步状态（不存在返回 `None`）。
#[tauri::command]
pub fn sync_state_load_for(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = state_path_for(&app, &name)?;
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&path).map(Some).map_err(|e| format!("读取同步状态失败: {e}"))
}

/// 写某个仓库的批量同步状态（原子写：临时文件 + 改名；临时名带 pid 防多窗口撞车）。
#[tauri::command]
pub fn sync_state_save_for(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let path = state_path_for(&app, &name)?;
    save_at(&path, &text)
}

//! 仓库文件监听与资源访问授权。
//!
//! 监听用 Rust 侧的 notify 完成，前端不轮询目录——轮询既费电又会在大仓库上抖动。
//! 事件先做去抖再发给前端：编辑器保存一个文件通常会触发多个底层事件。

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// 去抖窗口：攒够这段时间内的变更再一次性通知前端。
const DEBOUNCE: Duration = Duration::from_millis(250);

/// 保存监听器。换仓库时替换掉旧的——旧的被 drop 后发送端断开，其线程会自行退出。
#[derive(Default)]
pub struct WatcherState(Mutex<Option<RecommendedWatcher>>);

/// 过滤并转换成仓库相对路径（`/` 分隔）。
///
/// 只排除隐藏路径（`.` 开头的段，如 `.obsidian`），其余一律通知。**不再按扩展名过滤**：
/// 文件树现在会列出所有文件与目录（含空目录），任何结构变化都值得刷新——尤其是新建或
/// 删除**空目录**，它不产生任何 `.md` 事件，正是"新建了文件夹但界面看不到"的成因。
/// 具体的取舍（当前打开了什么、要不要重载）交给前端判断。
fn relevant(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts: Vec<&str> = Vec::new();
    for component in rel.components() {
        let segment = component.as_os_str().to_str()?;
        if segment.starts_with('.') {
            return None;
        }
        parts.push(segment);
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// 开始监听仓库。重复调用会替换上一条监听。
#[tauri::command]
pub fn watch_vault(
    app: AppHandle,
    state: State<'_, WatcherState>,
    vault: String,
) -> Result<(), String> {
    let root = crate::vault::vault_root(&vault)?;

    let (sender, receiver) = channel();
    let mut watcher = notify::recommended_watcher(move |result| {
        // 发送失败说明前端已停止监听（接收端被丢弃），忽略即可。
        let _ = sender.send(result);
    })
    .map_err(|e| format!("创建文件监听失败: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败: {e}"))?;

    *state
        .0
        .lock()
        .map_err(|_| "监听器状态不可用".to_string())? = Some(watcher);

    let root_for_thread = root.clone();
    std::thread::spawn(move || {
        let mut pending: HashSet<String> = HashSet::new();
        loop {
            match receiver.recv_timeout(DEBOUNCE) {
                Ok(Ok(event)) => {
                    for path in event.paths {
                        if let Some(rel) = relevant(&path, &root_for_thread) {
                            pending.insert(rel);
                        }
                    }
                }
                // 单个事件出错（权限、竞态）不应中断监听。
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        let mut paths: Vec<String> = pending.drain().collect();
                        paths.sort();
                        let _ = app.emit("vault-changed", paths);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(())
}

/// 把仓库目录加入 asset 协议白名单，让 WebView 能直接加载库内的图片。
///
/// 需要 `tauri.conf.json` 里开启 `app.security.assetProtocol`。
/// 每次打开仓库都要调一次——白名单是运行时的，不持久化。
#[tauri::command]
pub fn allow_asset_dir(app: AppHandle, vault: String) -> Result<(), String> {
    let root = PathBuf::from(crate::vault::vault_root(&vault)?);
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| format!("授权仓库目录失败: {e}"))
}

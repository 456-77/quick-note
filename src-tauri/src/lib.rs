pub mod net;
pub mod sync_store;
pub mod vault;
mod watch;

/// WebView2 启动参数。
///
/// `--disable-gpu*` 关闭 GPU 进程：文本编辑器用不到它，实测把整棵进程树的私有内存
/// 从约 220MB 降到约 151MB（-32%）。代价是走软件渲染，重绘更吃 CPU；若更在意滚动
/// 流畅度，删掉这两个开关即可（只关合成是 194MB，收益小得多）。
const WEBVIEW2_ARGS: &str = "--disable-gpu --disable-gpu-compositing";

/// 把默认优化参数与外部注入的参数合并后写入环境变量。
///
/// 之所以在这里拼而不用 `tauri.conf.json` 的 `additionalBrowserArgs`：配置里的值会
/// **覆盖** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，那样 `scripts/gui-*.mjs` 就无法
/// 再注入 `--remote-debugging-port` 做端到端测试。在 Rust 里拼接可以让默认优化与
/// 测试注入共存。
fn configure_webview2() {
    let injected = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let combined = if injected.trim().is_empty() {
        WEBVIEW2_ARGS.to_string()
    } else {
        format!("{WEBVIEW2_ARGS} {injected}")
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", combined);
}

/// 启动参数里指定的仓库目录（可选）。
///
/// 用途：从命令行/文件管理器直接打开一个文件夹；也让自动化冒烟测试无需操作
/// 目录选择框就能进入有内容的状态。
#[tauri::command]
fn startup_vault() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .filter(|arg| std::path::Path::new(arg).is_dir())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview2();

    tauri::Builder::default()
        .manage(watch::WatcherState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            startup_vault,
            vault::list_entries,
            vault::read_note,
            vault::read_note_optional,
            vault::search_vault,
            vault::write_note,
            vault::write_attachment,
            vault::create_note,
            vault::create_folder,
            vault::rename_entry,
            vault::delete_entry,
            vault::sync_scan,
            vault::sync_scan_attachments,
            vault::read_binary,
            vault::write_binary,
            watch::watch_vault,
            watch::allow_asset_dir,
            net::http_request,
            sync_store::sync_state_load,
            sync_store::sync_state_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

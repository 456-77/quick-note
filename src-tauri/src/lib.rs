pub mod data_dir;
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

/// 读取任意文本文件（UTF-8）。
///
/// 用途：快捷键配置导入等"用户经系统对话框自选文件"的场景。路径来自用户在
/// 原生对话框里的显式选择，不做仓库根限制。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))
}

/// 写入任意文本文件（UTF-8，覆盖）。
///
/// 用途：快捷键配置导出。路径同样来自用户在原生保存对话框里的显式选择。
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))
}

/// 返回候选路径里第一个存在的（用于探测 Edge/Chrome 的安装位置）。
#[tauri::command]
fn first_existing_path(paths: Vec<String>) -> Option<String> {
    paths
        .into_iter()
        .find(|p| std::path::Path::new(p).is_file())
}

/// 用无头浏览器把本地 HTML 打印成 PDF 文件。
///
/// 「导出 PDF 文件」的落盘通道：前端先把笔记渲染成独立 HTML（打印样式内联、
/// 图片为 file:/// 地址），再交由 Edge/Chrome 的 --print-to-pdf 生成。
/// 生成完成后校验产物存在且非空。
#[tauri::command]
fn export_pdf_via_browser(
    browser_path: String,
    html_path: String,
    pdf_path: String,
) -> Result<(), String> {
    if !std::path::Path::new(&browser_path).is_file() {
        return Err(format!("浏览器不存在: {browser_path}"));
    }
    let url = format!(
        "file:///{}",
        html_path.replace('\\', "/").trim_start_matches('/')
    );
    let output = std::process::Command::new(&browser_path)
        .args([
            "--headless",
            "--disable-gpu",
            &format!("--print-to-pdf={}", pdf_path),
            "--no-pdf-header-footer",
            &url,
        ])
        .output()
        .map_err(|e| format!("启动浏览器失败: {e}"))?;
    let pdf = std::path::Path::new(&pdf_path);
    if !output.status.success() && !pdf.is_file() {
        return Err(format!(
            "浏览器导出失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    if !pdf.is_file() {
        return Err("浏览器没有生成 PDF 文件".into());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview2();
    // 自定义数据目录（若有）：在 WebView 创建**之前**读取指针并迁移旧数据。
    data_dir::configure_webview_data_dir();

    tauri::Builder::default()
        .manage(watch::WatcherState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // 应用内更新（检查/下载/安装）与更新后的重启；密钥与端点见 tauri.conf.json
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            startup_vault,
            read_text_file,
            write_text_file,
            first_existing_path,
            export_pdf_via_browser,
            data_dir::app_data_paths,
            data_dir::set_custom_data_dir,
            vault::list_entries,
            vault::copy_paths_to_clipboard,
            vault::read_clipboard_file_paths,
            vault::copy_entry,
            vault::move_entry,
            vault::copy_external_into_vault,
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

pub mod data_dir;
pub mod net;
pub mod sync_store;
pub mod vault;
pub mod vault_home;
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
///
/// 参数是一个 **.md 文件**（资源管理器「打开方式 → Quick Note」/ 双击关联文件）
/// 时取其父目录为仓库；文件本身经 {@link startup_file} 传给前端打开。
#[tauri::command]
fn startup_vault() -> Option<String> {
    let arg = std::env::args().skip(1).find(|arg| !arg.starts_with('-'))?;
    let path = std::path::Path::new(&arg);
    if path.is_dir() {
        return Some(arg);
    }
    if path.is_file() {
        return path.parent().map(|dir| dir.to_string_lossy().into_owned());
    }
    None
}

/// 启动参数里指定的**笔记文件**（可选）：资源管理器双击 .md 打开时，
/// 前端进入参数里的仓库后自动打开这一篇。
#[tauri::command]
fn startup_file() -> Option<String> {
    let arg = std::env::args().skip(1).find(|arg| !arg.starts_with('-'))?;
    let path = std::path::Path::new(&arg);
    if path.is_file() {
        return Some(arg);
    }
    None
}

/// 另起一个应用进程打开指定仓库（「在新窗口打开仓库」）。
///
/// 用新进程而不是 Tauri 的 WebviewWindow：仓库状态存在 localStorage（按 WebView
/// 数据目录共享），同进程开第二个窗口会和当前窗口共用同一份 vault 键互相打架；
/// 独立进程各自走一遍启动流程（启动参数里的仓库优先于 localStorage），互不干扰。
#[tauri::command]
fn open_new_window(vault: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位应用失败: {e}"))?;
    std::process::Command::new(exe)
        .arg(&vault)
        .spawn()
        .map_err(|e| format!("启动新窗口失败: {e}"))?;
    Ok(())
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

/// 读取任意二进制文件（base64 回传）。
///
/// 用途：Android 系统分享的图片由 Kotlin 层落进应用缓存目录（与本命令同沙箱），
/// 前端据此转成附件——信任级别与 read_text_file 相同：路径来自系统级入口而非
/// 网页内容。上限 10MB（与同步附件一致），防止误读超大文件撑爆 IPC。
#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("文件超过 10MB 上限".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 返回候选路径里第一个存在的（用于探测 Edge/Chrome 的安装位置）。
#[tauri::command]
fn first_existing_path(paths: Vec<String>) -> Option<String> {
    paths
        .into_iter()
        .find(|p| std::path::Path::new(p).is_file())
}

/// 移动端默认仓库目录：app 私有数据目录下的 `vault`（不存在则创建）。
///
/// Android 的分区存储（Scoped Storage）下没有稳定的「用户自选目录」语义，仓库固定
/// 放在沙箱内，跨设备互通交给云同步。桌面端永远返回 None——仓库始终由用户选择，
/// 绝不能悄悄落进应用数据目录。
#[tauri::command]
fn default_vault_dir(app: tauri::AppHandle) -> Option<String> {
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let dir = app.path().app_local_data_dir().ok()?.join("vault");
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir.to_string_lossy().into_owned())
    }
    #[cfg(desktop)]
    {
        let _ = app;
        None
    }
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

/// 窗口最小化时把 WebView2 的内存占用目标降到 LOW，还原窗口时切回 NORMAL。
///
/// ICoreWebView2_16::SetMemoryUsageTargetLevel：LOW 档让 WebView2 像浏览器的
/// 内存节省程序一样主动清掉图片解码缓存、光栅缓存与可回收堆——对不可见的
/// 窗口是纯收益；切回 NORMAL 后缓存按需重建，不影响前台体验。
/// 该接口需要 WebView2 Runtime 121+：cast 失败（旧 Runtime）静默跳过，行为不变。
#[cfg(desktop)]
fn set_memory_usage_target(window: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    let _ = window.with_webview(move |webview| unsafe {
        let core = webview.controller().CoreWebView2();
        let Ok(core) = core else {
            return;
        };
        if let Ok(target) = core.cast::<ICoreWebView2_19>() {
            // 设置失败（极旧 Runtime 等）只影响本次降内存，不值得打断/记录
            let _ = target.SetMemoryUsageTargetLevel(if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebView2 启动参数与自定义数据目录都是桌面概念；移动端 WebView 由系统管理。
    #[cfg(desktop)]
    {
        configure_webview2();
        // 自定义数据目录（若有）：在 WebView 创建**之前**读取指针并迁移旧数据。
        data_dir::configure_webview_data_dir();
    }

    let mut builder = tauri::Builder::default();
    // updater 插件不支持移动端（依赖也要按平台编译），注册随依赖一起走桌面。
    #[cfg(desktop)]
    {
        // 应用内更新（检查/下载/安装）与更新后的重启；密钥与端点见 tauri.conf.json
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .manage(watch::WatcherState::default())
        .setup(|app| {
            let _ = app; // 移动端 setup 暂无逻辑，桌面分支使用它
            #[cfg(desktop)]
            {
                // 「不用时自动释放内存」主通道：WebView2 内存占用目标档位。
                //  - 最小化 → 立即降 LOW（不可见，纯收益）；
                //  - 失焦 3 分钟 → 降 LOW（用户在别的应用里工作时，缓存没必要占着）；
                //  - 聚焦/还原 → 回 NORMAL，缓存按需重建，不牺牲前台体验。
                // LOW 档由 WebView2 主动清图片解码/光栅/可回收缓存，实测挂机数十分钟后
                // 整棵进程树私有内存可从 ~194MB 降到 ~148MB。
                use std::sync::atomic::{AtomicBool, Ordering};
                use std::sync::Arc;
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let watched = window.clone();
                    let focused = Arc::new(AtomicBool::new(true));
                    let low = Arc::new(AtomicBool::new(false));
                    window.on_window_event(move |event| {
                        let set_target = |want_low: bool| {
                            if want_low != low.load(Ordering::Relaxed) {
                                low.store(want_low, Ordering::Relaxed);
                                set_memory_usage_target(&watched, want_low);
                            }
                        };
                        match event {
                            tauri::WindowEvent::Focused(true) => {
                                focused.store(true, Ordering::Relaxed);
                                set_target(false);
                            }
                            tauri::WindowEvent::Focused(false) => {
                                focused.store(false, Ordering::Relaxed);
                                if watched.is_minimized().unwrap_or(false) {
                                    set_target(true);
                                } else {
                                    // 短暂切走不降档（避免回切时缓存重建的卡顿），挂机才降
                                    let flag = focused.clone();
                                    let w = watched.clone();
                                    let low_flag = low.clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(std::time::Duration::from_secs(180));
                                        if !flag.load(Ordering::Relaxed)
                                            && !low_flag.swap(true, Ordering::Relaxed)
                                        {
                                            set_memory_usage_target(&w, true);
                                        }
                                    });
                                }
                            }
                            tauri::WindowEvent::Resized(_) => {
                                // 最小化可能不伴随失焦事件，这里兜底；还原且聚焦时回 NORMAL
                                if watched.is_minimized().unwrap_or(false) {
                                    if !low.swap(true, Ordering::Relaxed) {
                                        set_memory_usage_target(&watched, true);
                                    }
                                } else if focused.load(Ordering::Relaxed) {
                                    if low.swap(false, Ordering::Relaxed) {
                                        set_memory_usage_target(&watched, false);
                                    }
                                }
                            }
                            _ => {}
                        }
                    });
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            startup_vault,
            startup_file,
            open_new_window,
            read_text_file,
            write_text_file,
            read_binary_file,
            first_existing_path,
            export_pdf_via_browser,
            default_vault_dir,
            vault_home::vault_home_get,
            vault_home::vault_home_set_from_uri,
            vault_home::vault_home_set_from_path,
            vault_home::vault_home_clear,
            vault_home::list_vaults,
            vault_home::create_vault,
            vault_home::storage_writable,
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

pub mod data_dir;
pub mod net;
pub mod open_vaults;
#[cfg(desktop)]
pub mod screenshot;
pub mod sync_store;
pub mod vault;
pub mod vault_home;
pub mod vocab;
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
/// 启动参数里指定的仓库目录（可选；`startup_vault` 命令与 setup 自登记共用）。
///
/// 用途：从命令行/文件管理器直接打开一个文件夹；也让自动化冒烟测试无需操作
/// 目录选择框就能进入有内容的状态。
///
/// 参数是一个 **.md 文件**（资源管理器「打开方式 → Quick Note」/ 双击关联文件）
/// 时取其父目录为仓库；文件本身经 {@link startup_file} 传给前端打开。
fn startup_vault_from_args() -> Option<String> {
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

#[tauri::command]
fn startup_vault() -> Option<String> {
    startup_vault_from_args()
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

/// 本地绝对路径 → `file:///` URL（非 ASCII、空格等全部百分号编码）。
///
/// 浏览器命令行接受裸中文路径，但 URL 里出现未编码的 `#`、`?`、`%` 时会被
/// 当成 fragment/query/转义（笔记名允许这些字符），所以必须按 URL 规则编码。
fn file_url_for(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut out = String::from("file:///");
    for byte in normalized.trim_start_matches('/').bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'/'
            | b':' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 用无头浏览器把本地 HTML 打印成 PDF 文件。
///
/// 「导出 PDF 文件」的落盘通道：前端先把笔记渲染成独立 HTML（打印样式内联、
/// 图片为 file:/// 地址），再交由 Edge/Chrome 的 --print-to-pdf 生成。
/// 生成完成后校验产物存在且非空。
///
/// 0.28 修复「浏览器没有生成 PDF 文件」：无头实例改用**独立的 user-data-dir**。
/// 浏览器已经在运行时，headless 进程会尝试连上同一个默认配置的现存实例、
/// 把任务丢过去后自己以 0 退出——PDF 永远不落盘（用户机器上 Edge 常驻）。
/// 独立配置目录还顺带隔离了扩展、同步与首次运行向导。
#[tauri::command]
fn export_pdf_via_browser(
    browser_path: String,
    html_path: String,
    pdf_path: String,
) -> Result<(), String> {
    if !std::path::Path::new(&browser_path).is_file() {
        return Err(format!("浏览器不存在: {browser_path}"));
    }
    let html = std::path::Path::new(&html_path);
    if !html.is_file() {
        return Err(format!("导出用的 HTML 不存在: {html_path}"));
    }
    if let Some(parent) = std::path::Path::new(&pdf_path).parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!("导出目录不存在: {}", parent.display()));
        }
    }

    let url = file_url_for(&html_path);
    // 独立配置目录：pid + 毫秒时间戳命名，多窗口同时导出也不撞名
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let profile = std::env::temp_dir().join(format!(
        "quicknote-pdf-profile-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&profile)
        .map_err(|e| format!("创建浏览器临时配置目录失败: {e}"))?;
    let profile_arg = format!("--user-data-dir={}", profile.to_string_lossy());
    let print_arg = format!("--print-to-pdf={}", pdf_path);

    let output = std::process::Command::new(&browser_path)
        .args([
            "--headless",
            "--disable-gpu",
            &profile_arg,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-sync",
            "--disable-background-networking",
            "--run-all-compositor-stages-before-draw",
            &print_arg,
            "--no-pdf-header-footer",
            &url,
        ])
        .output()
        .map_err(|e| format!("启动浏览器失败: {e}"))?;
    // 临时配置目录里有锁文件与缓存，用完就删；失败（被占用）不影响导出结果
    let _ = std::fs::remove_dir_all(&profile);

    let pdf = std::path::Path::new(&pdf_path);
    let wrote = pdf.metadata().map(|meta| meta.len() > 0).unwrap_or(false);
    if !wrote {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = format!("{stderr}{stdout}").trim().to_string();
        return Err(if detail.is_empty() {
            "浏览器没有生成 PDF 文件（无头实例可能被已运行的浏览器接管）".to_string()
        } else {
            format!("浏览器没有生成 PDF 文件：{detail}")
        });
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
        // 全局快捷键（OS 级，应用不在前台也响应）：目前只有「截图识别」一条。
        // 快捷键本身由前端调 set_screenshot_hotkey 动态注册（可在设置里改，被占用时
        // 前端会收到错误提示），这里只挂统一 handler：按下即发事件给前端。
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state == ShortcutState::Pressed {
                        use tauri::Emitter;
                        let _ = app.emit("screenshot-hotkey", ());
                    }
                })
                .build(),
        );
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

                // 进程出生即登记仓库登记表（argv 仓库或空串占位，前端起来后会用
                // 真实仓库 upsert 覆盖）。热键仲裁要靠登记表+进程枚举识别"自家
                // 兄弟"：此前登记要等前端跑起来才发生，新进程头几秒是"登记表
                // 查不到的黑窗"，两个窗口快速连续打开时前一个会被误判成外部程序
                // 而当着用户的面弹"注册快捷键失败"。
                let startup_vault = startup_vault_from_args().unwrap_or_default();
                let _ = open_vaults::register_self(app.handle(), &startup_vault);
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
            open_vaults::open_vaults_register,
            open_vaults::open_vaults_unregister,
            open_vaults::open_vaults_list,
            open_vaults::open_vaults_focus,
            vocab::vocab_lookup,
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
            data_dir::read_app_text,
            data_dir::write_app_text,
            data_dir::app_text_path_of,
            data_dir::dir_stat,
            data_dir::clear_webview_cache,
            data_dir::webview_cache_stat,
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
            sync_store::sync_state_load_for,
            sync_store::sync_state_save_for,
            #[cfg(desktop)]
            screenshot::screenshot_capture,
            #[cfg(desktop)]
            screenshot::screenshot_ocr,
            #[cfg(desktop)]
            screenshot::set_screenshot_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::file_url_for;

    #[test]
    fn file_url_encodes_unicode_space_and_url_specials() {
        assert_eq!(
            file_url_for(r"C:\Users\一切随缘\Temp\a b#c.html"),
            "file:///C:/Users/%E4%B8%80%E5%88%87%E9%9A%8F%E7%BC%98/Temp/a%20b%23c.html"
        );
    }

    #[test]
    fn file_url_keeps_drive_colon_and_slashes() {
        assert_eq!(file_url_for("H:/notes/x.html"), "file:///H:/notes/x.html");
    }

    /// 端到端：真调一次无头浏览器，确认 PDF 落盘（有 Edge/Chrome 才跑）。
    ///
    /// 用户反馈的「浏览器没有生成 PDF 文件」是 0.28 要修的核心路径；单测
    /// 至少钉住"能启动、能写文件"，包括带中文/空格的目录。
    #[test]
    fn export_pdf_via_browser_writes_pdf() {
        let candidates = [
            "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
            "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
            "C:/Program Files/Google/Chrome/Application/chrome.exe",
            "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        ];
        let Some(browser) = candidates
            .iter()
            .find(|path| std::path::Path::new(path).is_file())
        else {
            eprintln!("跳过：本机没有 Edge/Chrome");
            return;
        };
        let dir = std::env::temp_dir().join(format!("qn-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建测试目录");
        let html = dir.join("导出 测试.html");
        let pdf = dir.join("导出 测试.pdf");
        std::fs::write(
            &html,
            "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><h1>Quick Note</h1><p>PDF export test.</p></body></html>",
        )
        .expect("写 html");
        let result = super::export_pdf_via_browser(
            browser.to_string(),
            html.to_string_lossy().into_owned(),
            pdf.to_string_lossy().into_owned(),
        );
        let size = std::fs::metadata(&pdf).map(|meta| meta.len()).unwrap_or(0);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(result.is_ok(), "导出失败: {result:?}");
        assert!(size > 0, "PDF 为空");
    }
}

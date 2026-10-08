//! 当前打开着的仓库登记表（跨窗口/跨进程）。
//!
//! 「在新窗口打开仓库」是 spawn 一个独立进程（见 lib.rs 的 open_new_window），
//! 进程之间互相不知道对方打开了哪个仓库。这份登记表让「选择其他仓库」能识别
//! 「目标仓库已经在别的窗口开着」，从而跳过「当前窗口还是新窗口」的询问，
//! 直接把那个窗口调到前台——切换语义，而不是再开一份。
//!
//! ## 文件与进程
//!
//! 登记表是配置目录下的 `open-vaults.json`：`[{ vault, pid }]`。实例在启动与
//! 切换仓库时 upsert 自己的条目，退出时尽力删除。进程崩溃会留下尸条目——
//! 读取时按 PID 存活检查清理（Windows 用 OpenProcess 探测，类 Unix 看 /proc），
//! 尸条目最多存活到下一次查询。
//!
//! 并发写是「读-改-写整份文件」，两个窗口同时换仓库时后写者会丢一次对方的
//! 更新；换仓库是低频操作，且下一轮 register/list 会自愈，不值得上文件锁。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const REGISTRY_FILE: &str = "open-vaults.json";

#[derive(Serialize, Deserialize, Clone)]
struct OpenVault {
    vault: String,
    pid: u32,
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    Ok(dir.join(REGISTRY_FILE))
}

fn load_at(path: &Path) -> Vec<OpenVault> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 原子落盘（临时文件 + 改名，与 sync-state 相同的纪律）。
fn save_at(path: &Path, entries: &[OpenVault]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string(entries).map_err(|e| format!("序列化登记表失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写登记表失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("提交登记表失败: {e}"))
}

/// 进程是否还活着。
fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        unsafe {
            // 权限只查状态不读内存；拿得到句柄即认为活着（pid 复用的误判窗口极小，
            // 后果只是少弹一次/多弹一次询问，无伤大雅）
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .map(|handle| {
                    let _ = CloseHandle(handle);
                    true
                })
                .unwrap_or(false)
        }
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
}

/// 路径同判：统一正斜杠与结尾分隔符；Windows 再忽略大小写。
fn same_path(a: &str, b: &str) -> bool {
    let normalize = |value: &str| value.replace('\\', "/").trim_end_matches('/').to_string();
    #[cfg(windows)]
    {
        normalize(a).to_lowercase() == normalize(b).to_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalize(a) == normalize(b)
    }
}

/// 读取并清理：剔除死进程条目，返回存活条目（含自己的）。
fn load_pruned(path: &Path) -> Vec<OpenVault> {
    load_at(path)
        .into_iter()
        .filter(|entry| pid_alive(entry.pid))
        .collect()
}

/// 登记本进程正打开的仓库（启动与切换仓库时调用；同仓库重复调用即刷新）。
#[tauri::command]
pub fn open_vaults_register(app: AppHandle, vault: String) -> Result<(), String> {
    let path = registry_path(&app)?;
    let mut entries: Vec<OpenVault> = load_pruned(&path)
        .into_iter()
        .filter(|entry| entry.pid != std::process::id())
        .collect();
    entries.push(OpenVault { vault, pid: std::process::id() });
    save_at(&path, &entries)
}

/// 注销本进程的登记（窗口退出时调用；崩溃留下的条目靠读取时的 PID 清理兜底）。
#[tauri::command]
pub fn open_vaults_unregister(app: AppHandle) -> Result<(), String> {
    let path = registry_path(&app)?;
    let entries: Vec<OpenVault> = load_pruned(&path)
        .into_iter()
        .filter(|entry| entry.pid != std::process::id())
        .collect();
    save_at(&path, &entries)
}

/// 其他进程窗口正打开着的仓库列表（本窗口自己的不算）。
#[tauri::command]
pub fn open_vaults_list(app: AppHandle) -> Result<Vec<String>, String> {
    let path = registry_path(&app)?;
    let entries: Vec<OpenVault> = load_pruned(&path)
        .into_iter()
        .filter(|entry| entry.pid != std::process::id())
        .collect();
    // 顺手把清理结果写回去，让尸条目最多活一轮查询
    let _ = save_at(&path, &entries);
    Ok(entries.into_iter().map(|entry| entry.vault).collect())
}

/// 把已在其他进程窗口打开的指定仓库调到前台。成功聚焦返回 true；
/// 没找到目标（登记表过期、非 Windows 平台、系统拒绝前台切换）返回 false，
/// 调用方回落到常规的打开流程。
#[tauri::command]
pub fn open_vaults_focus(app: AppHandle, vault: String) -> Result<bool, String> {
    let path = registry_path(&app)?;
    let target = load_pruned(&path)
        .into_iter()
        .find(|entry| entry.pid != std::process::id() && same_path(&entry.vault, &vault));
    let Some(entry) = target else {
        return Ok(false);
    };
    Ok(focus_window_of_pid(entry.pid))
}

/// 枚举目标进程的可见主窗口并把它调到前台。
///
/// 直接 SetForegroundWindow 会被系统的前台锁拒绝（前台进程才有权转移），
/// 经典解法是 AttachThreadInput 把自己临时接进前台线程与目标线程的输入队列，
/// 借共享队列的权限完成切换，再拆开。
#[cfg(windows)]
fn focus_window_of_pid(pid: u32) -> bool {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindowLongPtrW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
        GWL_EXSTYLE, SW_RESTORE, WS_EX_TOOLWINDOW,
    };

    static TARGET_PID: AtomicU32 = AtomicU32::new(0);
    // 枚举回调不能捕获环境：候选 HWND 走 thread_local，目标 PID 走静态原子量
    thread_local! {
        static FOUND: RefCell<Vec<isize>> = const { RefCell::new(Vec::new()) };
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, _lparam: LPARAM) -> windows_core::BOOL {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid != TARGET_PID.load(Ordering::Relaxed) {
            return true.into();
        }
        let visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
        // 工具窗口（托盘图标、隐藏的辅助窗）不是用户要去的窗口
        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        let tool = (ex_style & WS_EX_TOOLWINDOW.0) != 0;
        if visible && !tool {
            FOUND.with(|found| found.borrow_mut().push(hwnd.0 as isize));
        }
        true.into()
    }

    TARGET_PID.store(pid, Ordering::Relaxed);
    FOUND.with(|found| found.borrow_mut().clear());
    unsafe {
        if EnumWindows(Some(enum_proc), LPARAM(0)).is_err() {
            return false;
        }
    }
    let hwnd = match FOUND.with(|found| found.borrow().first().copied()) {
        Some(raw) => HWND(raw as *mut _),
        None => return false,
    };

    unsafe {
        // 目标进程已退出（枚举与聚焦之间）：不再尝试
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => {
                let _ = CloseHandle(handle);
            }
            Err(_) => return false,
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let foreground = GetForegroundWindow();
        let this_thread = GetCurrentThreadId();
        let foreground_thread = if !foreground.0.is_null() {
            GetWindowThreadProcessId(foreground, None)
        } else {
            0
        };
        let target_thread = GetWindowThreadProcessId(hwnd, None);
        if foreground_thread != 0 && foreground_thread != this_thread {
            let _ = AttachThreadInput(this_thread, foreground_thread, true);
        }
        if target_thread != 0 && target_thread != this_thread {
            let _ = AttachThreadInput(this_thread, target_thread, true);
        }
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if foreground_thread != 0 && foreground_thread != this_thread {
            let _ = AttachThreadInput(this_thread, foreground_thread, false);
        }
        if target_thread != 0 && target_thread != this_thread {
            let _ = AttachThreadInput(this_thread, target_thread, false);
        }
        let focused = GetForegroundWindow() == hwnd;
        focused
    }
}

/// 非 Windows 桌面平台：暂不做跨进程聚焦，调用方回落到常规打开流程。
#[cfg(not(windows))]
fn focus_window_of_pid(_pid: u32) -> bool {
    false
}

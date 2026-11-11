//! 测试版更新通道（M9 门户配套，仅桌面——updater 插件本身不支持移动端）。
//!
//! updater 插件的端点固化在 tauri.conf.json（指向 GitHub 稳定版清单），JS API
//! 的 `check()` 换不了端点；而测试版清单在 daily-sync 服务器上（明文 HTTP）。
//! 所以检查与安装都在 Rust 侧用 `UpdaterBuilder::endpoints` 覆盖端点完成。
//! 签名公钥仍来自 tauri.conf.json——服务器上的 .sig 与本地签名私钥配对，
//! 传上去的包签名对不上就装不进来。

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// 检查结果：available=false 表示服务器清单无更新（含测试通道为空）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BetaCheckInfo {
    pub available: bool,
    pub version: String,
    pub notes: String,
}

/// 指向测试版清单（daily-sync 的 /api/v1/downloads/tauri-manifest?channel=beta）
/// 构建 updater。HTTP 端点依赖 tauri.conf.json 里 plugins.updater 的
/// dangerousInsecureTransportProtocol——服务器是明文 HTTP，不开这个 endpoints()
/// 会直接拒绝；稳定版端点是 https，不受该开关影响。
fn updater_at(app: &AppHandle, manifest_url: &str) -> Result<Updater, String> {
    let url: Url = manifest_url
        .parse()
        .map_err(|e| format!("清单地址无效：{e}"))?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("清单地址无效：{e}"))?
        .build()
        .map_err(|e| format!("更新器初始化失败：{e}"))
}

async fn check_at(app: &AppHandle, manifest_url: &str) -> Result<Option<Update>, String> {
    updater_at(app, manifest_url)?
        .check()
        .await
        .map_err(|e| format!("检查测试版失败：{e}"))
}

/// 用清单地址的 origin 重写下载直链的 origin。
///
/// 服务端拼下载直链时按请求 Host 反推对外地址，而反代（nginx）转发时不带端口，
/// Spring 拿到的 Host 是裸域名 → 清单里的 url 缺 `:8080` → updater 去连 80 端口
/// （另一套 nginx）→ 404。0.39.3 用户反馈「软件内更新时报错 404 Not Found」根因。
/// 清单地址是前端按用户配置的服务端地址拼的，必然带对端口——以它为准。
fn rewrite_download_origin(update: &mut Update, manifest_url: &str) {
    let Ok(manifest) = manifest_url.parse::<Url>() else {
        return;
    };
    let Some(host) = manifest.host_str().map(str::to_owned) else {
        return;
    };
    let mut url = update.download_url.clone();
    if url.set_scheme(manifest.scheme()).is_err() {
        return;
    }
    if url.set_host(Some(&host)).is_err() {
        return;
    }
    let set_port = match manifest.port() {
        Some(port) => url.set_port(Some(port)),
        None => url.set_port(None),
    };
    if set_port.is_ok() {
        update.download_url = url;
    }
}

/// 检查测试版是否有更新（不下载）。清单解析失败/网络不通都以 Err 返回，
/// 前端显示原因；「无更新」不是错误，走 available=false。
#[tauri::command]
pub async fn beta_update_check(app: AppHandle, manifest_url: String) -> Result<BetaCheckInfo, String> {
    Ok(match check_at(&app, &manifest_url).await? {
        Some(update) => BetaCheckInfo {
            available: true,
            version: update.version,
            notes: update.body.unwrap_or_default(),
        },
        None => BetaCheckInfo {
            available: false,
            version: String::new(),
            notes: String::new(),
        },
    })
}

/// 下载并安装测试版。下载进度按百分点发 `qn-beta-update-progress` 事件（前端
/// 监听后驱动更新弹窗的进度条）；装完退出当前进程——Windows 上 NSIS 安装器
/// 在等本进程退出，收尾后按 restart_after_install（默认 true）自动拉起新版本，
/// 与稳定版 JS 链路 downloadAndInstall + relaunch 的语义一致。
#[tauri::command]
pub async fn beta_update_install(app: AppHandle, manifest_url: String) -> Result<(), String> {
    let mut update = check_at(&app, &manifest_url)
        .await?
        .ok_or_else(|| "服务器上没有可安装的测试版".to_string())?;
    rewrite_download_origin(&mut update, &manifest_url);

    let progress_app = app.clone();
    let downloaded = AtomicU64::new(0);
    let last_pct = AtomicU64::new(0);
    update
        .download_and_install(
            move |chunk_len, total| {
                let done =
                    downloaded.fetch_add(chunk_len as u64, Ordering::Relaxed) + chunk_len as u64;
                if let Some(total) = total {
                    if total == 0 {
                        return;
                    }
                    // 只在百分点变化时发事件：几万个小 chunk 逐个 emit 会把事件总线刷爆
                    let pct = done.min(total) * 100 / total;
                    if pct != last_pct.swap(pct, Ordering::Relaxed) {
                        let _ = progress_app.emit("qn-beta-update-progress", pct);
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载安装测试版失败：{e}"))?;
    let _ = app.emit("qn-beta-update-progress", 100u64);
    app.restart();
}

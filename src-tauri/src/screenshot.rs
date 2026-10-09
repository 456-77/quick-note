//! 全局快捷键截图 + 图内文字识别（OCR）。仅桌面（Windows 优先，0.20 用户需求）。
//!
//! 截屏与 OCR 都走 PowerShell，不引入 Rust 侧的截屏/WinRT 依赖：
//! - 截屏：`System.Windows.Forms` 的 VirtualScreen + `CopyFromScreen`，覆盖多显示器，
//!   PNG base64 回传（前端用 data URL 展示与裁剪，绕开 asset 协议白名单）；
//! - OCR：`Windows.Media.Ocr`（WinRT）。PS 5.1 自带 WindowsRuntime 投影，内联脚本
//!   直接调；语言包缺失时退回 zh-Hans-CN / en-US，再不行返回空串。
//!
//! 两条链路都对手动触发不敏感（PS 冷启动 ~0.5s），换稳定与零依赖是划算的；
//! 仓库里 PowerShell 调用已有先例（vault.rs 的剪贴板命令），错误处理同口径。
//! 脚本全部 `-Command` 内联：.ps1 文件在 PS 5.1 下必须 UTF-8 with BOM（见
//! docs/M0-实现说明.md），内联可绕开这个坑。输出统一先切 UTF-8（中文系统默认
//! GBK 代码页，中文文字会被弄乱）。

use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// 跑一段 PowerShell，返回 stdout 文本（UTF-8）。非零退出视为失败。
fn run_powershell(script: &str) -> Result<String, String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("无法启动 PowerShell：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(format!("PowerShell 执行失败：{}", detail.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")] // 前端按 imageBase64 读；serde 默认保留 snake_case
pub struct ScreenCapture {
    /// PNG 内容的 base64（`data:image/png;base64,` 前缀由前端拼）。
    pub image_base64: String,
    /// 虚拟屏幕宽（物理像素），前端按它换算选区到原始坐标。
    pub width: u32,
    /// 虚拟屏幕高。
    pub height: u32,
}

/// 抓取整个虚拟屏幕为 PNG。DPI：CopyFromScreen 取的是物理像素（进程不感知 DPI 时
/// Windows 会给虚拟化的坐标——SystemInformation.VirtualScreen 同源，宽高与抓图一致，
/// 前端只拿这组数换算，不会错位）。
fn capture_blocking() -> Result<ScreenCapture, String> {
    let script = concat!(
        "$ErrorActionPreference='Stop';",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
        "$bmp=New-Object Drawing.Bitmap $b.Width,$b.Height;",
        "$g=[Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size);",
        "$ms=New-Object IO.MemoryStream;",
        "$bmp.Save($ms,[Drawing.Imaging.ImageFormat]::Png);",
        "Write-Output (\"{0}x{1}\" -f $b.Width,$b.Height);",
        "Write-Output ([Convert]::ToBase64String($ms.ToArray()));",
    );
    let stdout = run_powershell(script)?;
    let mut lines = stdout.lines().filter(|l| !l.trim().is_empty());
    let (width, height) = lines
        .next()
        .and_then(|head| {
            let mut parts = head.trim().splitn(2, 'x');
            let w = parts.next()?.parse::<u32>().ok()?;
            let h = parts.next()?.parse::<u32>().ok()?;
            Some((w, h))
        })
        .ok_or("截屏输出无法解析（缺尺寸行）")?;
    let image_base64 = lines.next().ok_or("截屏输出无法解析（缺图片数据）")?.trim().to_string();
    Ok(ScreenCapture { image_base64, width, height })
}

/// 对一段 PNG（base64）做 OCR，返回识别出的纯文本。
fn ocr_blocking(image_base64: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64.trim())
        .map_err(|e| format!("图片数据无法解码：{e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("quicknote-ocr-{stamp}.png"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
    let result = ocr_file(&tmp);
    let _ = std::fs::remove_file(&tmp);
    result
}

/// 对一个图片文件做 OCR（WinRT：StorageFile → BitmapDecoder → OcrEngine）。
///
/// 三个实测踩出来的点（PS 5.1 / Win10-zh-CN 验证）：
/// 1. `System.WindowsRuntimeSystemExtensions` 在 `System.Runtime.WindowsRuntime`
///    程序集里，不 Add-Type 就找不到 AsTask；
/// 2. `BitmapDecoder::CreateAsync(IStorageFile)` 重载绑定不上（StorageFile 不是
///    IRandomAccessStream），必须先 `OpenAsync` 拿流再建解码器；
/// 3. 输出先切 UTF-8，中文识别结果才不乱码。
fn ocr_file(path: &Path) -> Result<String, String> {
    // 单引号字符串里反斜杠不需要转义；路径里出现单引号的概率可以忽略
    let file = path.to_string_lossy();
    let script = format!(
        concat!(
            "$ErrorActionPreference='Stop';",
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
            "Add-Type -AssemblyName System.Runtime.WindowsRuntime;",
            "[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null;",
            "[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null;",
            "[Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null;",
            "[Windows.Storage.Streams.IRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null;",
            "[Windows.Storage.FileAccessMode,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null;",
            "[Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null;",
            "$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }})[0];",
            "function Await($op,$t){{ $task=$asTask.MakeGenericMethod($t).Invoke($null,@($op)); $task.Wait(); $task.Result }}",
            "$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{file}')) ([Windows.Storage.StorageFile]);",
            "$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]);",
            "$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]);",
            "$bmp=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]);",
            "$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();",
            "if(-not $engine){{ $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN')) }};",
            "if(-not $engine){{ $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }};",
            "if(-not $engine){{ Write-Output ''; exit }}",
            "$result=Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult]);",
            "Write-Output $result.Text",
        ),
        file = file,
    );
    let stdout = run_powershell(&script)?;
    // 识别文本原样回传（可能是多行）；去掉结尾换行
    Ok(stdout.trim_end().to_string())
}

#[tauri::command]
pub async fn screenshot_capture() -> Result<ScreenCapture, String> {
    tauri::async_runtime::spawn_blocking(capture_blocking)
        .await
        .map_err(|e| format!("截屏任务中断：{e}"))?
}

#[tauri::command]
pub async fn screenshot_ocr(image_base64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ocr_blocking(image_base64))
        .await
        .map_err(|e| format!("OCR 任务中断：{e}"))?
}

/// 注册/更换全局截图快捷键。空串 = 取消注册。
/// 快捷键格式与 tauri-plugin-global-shortcut 一致：`Ctrl+Alt+A` / `CommandOrControl+Shift+S`。
/// 按下时由插件的统一 handler 发 `screenshot-hotkey` 事件给前端。
///
/// **必须是同步命令**（主线程执行）：插件内部维护一张已注册表，register/unregister
/// 都要回主线程结账；异步命令跑在运行时线程上，`unregister_all` 之后紧接 `register`
/// 会出现"旧表还没清完、新注册撞 already registered"的时序（实测踩过）。
#[tauri::command]
pub fn set_screenshot_hotkey(app: tauri::AppHandle, hotkey: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let manager = app.global_shortcut();
    manager.unregister_all().map_err(|e| format!("注销旧快捷键失败：{e}"))?;
    let Some(raw) = hotkey else { return Ok(()) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let parsed: tauri_plugin_global_shortcut::Shortcut = trimmed
        .to_lowercase()
        .parse()
        .map_err(|e| format!("无法识别快捷键「{trimmed}」：{e}"))?;
    manager
        .register(parsed)
        .map_err(|e| format!("注册快捷键失败（可能被其他程序占用）：{e}"))?;
    Ok(())
}

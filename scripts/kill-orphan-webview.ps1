# 杀掉父进程已死的 msedgewebview2 孤儿（taskkill /F 只杀 quick-note 主进程时产生）。
# 孤儿会占住批测的固定 CDP 调试端口——新实例的浏览器进程绑定失败后，
# 批测会连到僵尸页面：DOM 断言照常过、一切 Tauri invoke 永久悬挂
# （2026-11-05 门禁三轮怪象排查中固化；0.34.3「WebView2 残留抢占调试端口」同族）。
$all = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
$orphans = @($all | Where-Object { $_.ParentProcessId -and $null -eq (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) })
if ($orphans.Count -eq 0) { Write-Output "no orphan webview"; exit 0 }
foreach ($o in $orphans) {
  Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "killed orphan webview $($o.ProcessId)"
}

# 测量应用及其子进程树的内存占用。
#
#   powershell -ExecutionPolicy Bypass -File scripts/measure-rss.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/measure-rss.ps1 -ProcessName Obsidian
#
# 输出三个指标。**它们经常给出互相矛盾的结论，务必看清口径再引用**：
#
#   WorkingSet（工作集）
#       含与其他进程共享的页面。Chromium/WebView2 的 DLL 被多个进程共享，
#       这里会在每个进程里各算一遍，因此对多进程的浏览器内核应用严重偏高。
#
#   PrivateBytes（私有提交内存）
#       不含共享页，但**包含已被换出到页面文件的部分**。长时间运行的应用提交量
#       很大，其中相当一部分并不占物理内存，因此对这类应用严重偏高。
#
#   PrivateWorkingSet（私有工作集）
#       物理内存中真正属于该应用、且不与别人共享的部分。三者中最接近"这个应用
#       实际吃掉多少内存"的口径，**跨应用对比建议用它**。
#
# 本机实测同一时刻，工作集口径会得出"Quick Note 比 Obsidian 更费内存"的相反
# 结论，原因就是上述偏差。详见 docs/M0-实现说明.md。

param(
    [string]$ProcessName = "quick-note",
    [int]$ProcessId = 0
)

$ErrorActionPreference = "Stop"

$instances = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (-not $instances) {
    Write-Host "未找到进程 '$ProcessName'。请先启动应用；若刚启动请稍等几秒再试。" -ForegroundColor Yellow
    exit 1
}

# 多实例时必须只测一棵进程树：按进程名取根会把所有实例的 WebView2 子进程一并算进来，
# 数字严重虚高（实测踩过：混进另一个实例后变成 15 个进程、358MB）。
if ($ProcessId -ne 0) {
    $root = $instances | Where-Object { $_.Id -eq $ProcessId }
    if (-not $root) { Write-Host "找不到 PID $ProcessId" -ForegroundColor Yellow; exit 1 }
} else {
    $root = $instances | Sort-Object StartTime | Select-Object -Last 1
    if (@($instances).Count -gt 1) {
        Write-Host "检测到 $(@($instances).Count) 个 '$ProcessName' 实例，只测量最新的 PID $($root.Id)（要测指定实例用 -ProcessId <pid>）。" -ForegroundColor Yellow
        Write-Host ""
    }
}

# 按 ParentProcessId 递归收集整棵进程树。
# 对 Tauri：应用进程 → WebView2 浏览器进程 → 渲染/GPU/工具进程。
# 对 Electron：子进程与主进程同名，Get-Process 已能取到全部，树遍历只起去重作用。
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$tree = New-Object System.Collections.Generic.List[int]
$queue = New-Object System.Collections.Generic.Queue[int]
$queue.Enqueue([int]$root.Id)
while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if ($tree.Contains($current)) { continue }
    $tree.Add($current)
    foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $current })) {
        $queue.Enqueue([int]$child.ProcessId)
    }
}

$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process

$rows = foreach ($id in $tree) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $p = $perf | Where-Object { $_.IDProcess -eq $id } | Select-Object -First 1
    [pscustomobject]@{
        PID        = $proc.Id
        Name       = $proc.ProcessName
        WorkingSet = [math]::Round($proc.WorkingSet64 / 1MB, 1)
        Private    = [math]::Round($proc.PrivateMemorySize64 / 1MB, 1)
        PrivateWS  = if ($p) { [math]::Round($p.WorkingSetPrivate / 1MB, 1) } else { 0 }
    }
}

$rows | Sort-Object PrivateWS -Descending | Format-Table -AutoSize

$ws = [math]::Round((($rows | Measure-Object WorkingSet -Sum).Sum), 1)
$pv = [math]::Round((($rows | Measure-Object Private -Sum).Sum), 1)
$pws = [math]::Round((($rows | Measure-Object PrivateWS -Sum).Sum), 1)

Write-Host ""
Write-Host "应用: $ProcessName    进程数: $($rows.Count)"
Write-Host ("工作集合计 (WorkingSet):        {0,8} MB   含共享页，偏高" -f $ws)
Write-Host ("私有提交合计 (PrivateBytes):    {0,8} MB   含已换出，偏高" -f $pv)
Write-Host ("私有工作集合计 (PrivateWS):     {0,8} MB   <- 建议对比口径" -f $pws) -ForegroundColor Green
Write-Host ""
Write-Host "注意：跨应用对比必须同一时刻、同一口径。更严谨的做法是两者都冷启动、"
Write-Host "打开同样的笔记后再测——运行时长与工作负载会显著影响结果。"

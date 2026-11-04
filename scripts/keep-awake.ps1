# 让显示器/系统在套件运行期间保持唤醒（缺省 25 分钟后自动放行）。
# 凌晨跑门禁时显示器休眠会让全屏切换（截图冻结浮层）死锁主线程：
# Responding=False、全部 Tauri invoke 悬挂（0.37.2 门禁三轮怪象根因）。
param([int]$Minutes = 25)
$code = @'
using System;
using System.Runtime.InteropServices;
public static class KeepAwake {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
Add-Type -TypeDefinition $code
$ES_CONTINUOUS = 0x80000000u
$ES_SYSTEM_REQUIRED = 0x1u
$ES_DISPLAY_REQUIRED = 0x2u
[KeepAwake]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED)
Write-Output "keep-awake on for $Minutes min"
Start-Sleep -Seconds ($Minutes * 60)
[KeepAwake]::SetThreadExecutionState($ES_CONTINUOUS)
Write-Output "keep-awake off"

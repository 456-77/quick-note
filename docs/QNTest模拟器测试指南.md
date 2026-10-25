# QNTest 模拟器测试指南

> 2026-10-25 整理。QNTest 是本项目的 Android 测试虚拟机（x86_64 镜像跑 aarch64 APK
> 靠转译，冷启动首帧 >8s 属正常）。`env(safe-area-inset-*)` 恒为 0，真机安全区行为
> 用 `scripts/qn-gap-repro.mjs` 注入模拟；系统栏条纹与沉浸等真机差异仍需真机复核。
> 所有命令在 Git Bash 里执行。

## 一、启动模拟器（已开则跳过）

```bash
# 保持窗口开着；ANDROID_AVD_HOME 必须指到 H 盘 AVD 目录
ANDROID_AVD_HOME=H:/develop/android-sdk/avd \
  H:/develop/android-sdk/emulator/emulator.exe -avd QNTest
```

另开一个终端确认设备就绪（`device` 状态才可用）：

```bash
export MSYS_NO_PATHCONV=1        # adb forward 的路径参数必须加，防 MSYS 改写
ADB=H:/develop/android-sdk/platform-tools/adb.exe
$ADB devices                      # 应看到 emulator-5554   device
```

## 二、构建 / 安装 / 启动

```bash
cd /h/develop/project/quick-note

# 改了代码后重打 debug APK（增量构建约 3-5 分钟）
source scripts/android-env.sh && npx tauri android build --debug --target aarch64
# 产物 src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# 安装（-r 保留应用数据）+ 冷启动
$ADB install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
$ADB shell am start -n com.quicknote.app/.MainActivity

# 其他常用控制
$ADB shell am force-stop com.quicknote.app   # 杀进程（排缓存问题用）
$ADB shell pm clear com.quicknote.app        # 清应用数据（回首次启动引导，慎用）
```

## 三、调试通道

### 截图（看当前画面）

```bash
$ADB exec-out screencap -p > /tmp/qn-screen.png
```

### CDP 网页调试口（批测/探针脚本都走这里）

```bash
PID=$($ADB shell pidof com.quicknote.app | tr -d '\r')
$ADB forward tcp:9223 localabstract:webview_devtools_remote_$PID
# 之后 http://127.0.0.1:9223/json/list 就是页面目标（9223 端口可换任意空闲口）
```

注意：**注入 localStorage 不执行**（WebView 安全限制），改设置要走脚本里的
`localStorage.setItem + Page.reload`（CDP）或应用内设置界面。

### 日志

```bash
$ADB logcat --pid=$($ADB shell pidof com.quicknote.app | tr -d '\r') | grep -iE "quicknote|panic|error"
```

### 程序化点击/输入（快速复现路径，坐标 = screencap 像素坐标）

```bash
$ADB shell input tap 75 123          # 点按
$ADB shell input swipe 8 420 110 424   # 左缘右滑开左抽屉
$ADB shell input swipe 300 420 140 424 # 左抽屉内左滑关闭
$ADB shell input swipe 120 420 260 424 # 右抽屉内右滑关闭（先经 ☰ 菜单开右抽屉）
```

裸坐标易误触（点透到下层元素），**验证页面内部状态建议走 CDP evaluate**，
参考 `scripts/gui-035-batch.mjs` 的 cdp/evaluate 封装。

## 四、脚本与坑位速查

| 事项 | 说明 |
|---|---|
| `scripts/qn-vm-verify.mjs` | 主页/头部几何实测——**0.34.0 壳层重构后未适配**（还在断言顶栏 48px），直接跑会假失败 |
| `scripts/qn-gap-repro.mjs 9496` | 设置页缝隙复现（注入 40px 模拟 env，真机安全区行为模拟） |
| `scripts/gui-035-batch.mjs 9465` | 移动端批测——**走桌面 gui-test 实例 + CDP 伪造 Android，不需要模拟器**（前置：`npm run tauri build -- --no-bundle --config '{"identifier":"com.quicknote.gui-test"}'`） |
| 同步隔离 | 模拟器连真实同步服务器前想清楚；纯 UI 测试不受影响，状态栏会显示「同步未启用」 |
| 转译运行 | x86_64 镜像跑 aarch64 包靠 libhoudini/NDK 转译，启动慢、偶发卡顿是环境特性不是 bug |
| `MSYS_NO_PATHCONV=1` | 所有含 `/` 开头路径参数的 adb 命令（forward、shell 里写文件）都要加 |

## 五、测试后交付

手测确认没问题后走发版流程（见 `docs/开发指南.md` 与仓库根 README）：
版本号四处 bump → commit + tag → `bash scripts/release-android.sh <版本>` 签名
release APK → `gh release upload` → latest.json 端点验证。

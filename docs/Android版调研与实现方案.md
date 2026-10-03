# Quick Note Android 版调研与实现方案

> 调研时间：2026-10。基线：quick-note 0.19.0（Tauri 2 + React 19 + CM6，Windows 桌面端）。

## 0. 结论（TL;DR）

**推荐用 Tauri 2 的 Android 目标做移动端，同一个代码库，不做原生重写。**

核心依据：

- quick-note 本来就是 Tauri 2 应用。Tauri 2 自 2024-10 起官方支持 Android/iOS，当前
  （2026-10，v2.12）移动端已是稳定特性，可直接在同一仓库里 `tauri android init` 起步。
- 前端约 **2 万行 TS/TSX**（CM6 Live Preview、同步引擎、日记/待办/速记、表格编辑）
  与 Rust 约 **2600 行**核心（仓库读写、同步哈希/扫描、HTTP 通道）几乎原样复用；
  换任何其他技术栈都意味着从零重写这套久经验证（verify-all 500+ 断言 + GUI 验收）的逻辑。
- 行业先例：Obsidian 移动端就是「WebView 壳 + 同一套 CM6 编辑器」，证明这条路在
  Android 上是可行的；本项目与 Obsidian 的语法兼容性设计（wiki、callout、库内配置）
  也意味着移动端交互可以大量参照 Obsidian mobile。

**最大的工作量在移动 UI 改造**（三栏 → 抽屉导航、悬停交互 → 触摸交互），
**最大的技术风险在移动端键盘/IME 与 WebView 细节**（A0 阶段必须最先真机验证）。

分四~五个阶段推进（详见 §6）：A0 脚手架真机闭环 → A1 核心功能 → A2 移动 UI →
A3 平台集成与发布 → A4 验收回归。

---

## 1. 候选方案对比

| 维度 | **Tauri 2 Android**（推荐） | Capacitor | Kotlin 原生 (Compose) | Flutter | PWA |
|---|---|---|---|---|---|
| 前端复用 | **全部**（CM6/React 原样跑） | 全部（换壳） | 0（重写 UI） | 0（且 CM6 不可用） | 部分（无文件系统） |
| Rust 核心复用 | **vault/net/sync_store 原样** | 0（要 TS 重写数据层） | 0 | 0 | 0 |
| 同步引擎 | **syncEngine.ts 原样** | 可复用 | 重写 | 重写 | 部分 |
| 文件系统 | 直接 `std::fs`（app 私有目录） | 插件 bridging，逐命令重写 | 原生 | 原生 | 受限（OPFS/SAF） |
| 工作量估计 | 中（改造 ~6-10 周） | 中偏大（数据层重写+双份维护） | 大（数月） | 大 | 小但不满足需求 |
| 风险 | 移动端粗糙边、IME 细节 | 双份逻辑漂移、与桌面测试资产脱节 | 人力不可承受 | 编辑器无解 | vault 语义不成立 |

几个判断点：

- **Capacitor 是 Plan B**：如果 A0 阶段 Tauri Android 出现阻断性问题（见 §8 风险），
  Capacitor 壳 + TS 重写 vault 层（`hash.ts`/`sync.ts` 纯函数都在 TS，理论可行）是唯一
  备胎；但会把 Rust 侧带测试守护的字节精确往返逻辑变成第二份实现，长期双维护。
- **Kotlin/Flutter 原生**：CM6 没有等价物，Live Preview 装饰层、表格就地编辑、
  自动配对这些积累全部作废，不做考虑。
- **PWA**：浏览器无法提供「目录即仓库」的文件语义与可靠后台同步，与产品形态冲突。
- 桌面端继续走 Tauri Windows 不受影响：平台差异用条件编译/运行时分支隔离（§3），
  不引入 fork 级的分叉。

---

## 2. 现状盘点：逐模块复用评估

### 2.1 前端（src/，~20k 行）

| 层 | 模块 | 复用 | 说明 |
|---|---|---|---|
| 纯函数层 | `paths.ts` `attachments.ts` `daily.ts` `todos.ts` `dailyConfig.ts` `capture.ts` `sync.ts` `hash.ts` `table.ts` `outline.ts` `autoPairs.ts` `lineEndings.ts` `languageDetect.ts` `weeklyReview.ts` `reminders.ts` `weather.ts` 等 | **100% 原样** | 不依赖平台；配套 verify-*.mjs 纯逻辑测试一并复用 |
| 编辑器/渲染 | `editor.ts` `livePreview.ts` `embed.ts` `inlineSyntax.ts` `syntaxTheme.ts` `markdownExtras.ts` `tableEdit.ts` `codeEdit.ts` `paste.ts` `pasteTransforms.ts` `searchPanel.ts` | **~100%** | CM6 装配与装饰层平台无关；触摸/IME 相关问题集中在这里（§4.6） |
| 平台调用层 | `api.ts` | **部分** | 全部 Rust 命令的类型化封装都过这里，单点改造；个别桌面命令要加平台分支 |
| 生命周期/宿主 | `useSync.ts` `useDaily.ts` `updater.ts` `background.ts` `settings.ts` | 大部分 | updater 移动端禁用；同步生命周期要接移动端前后台事件（§4.5） |
| UI 组件 | 14 个组件 + App.tsx + styles.css | **改造为主** | 三栏布局、悬停交互、快捷键、右键菜单都要移动化（§4.7，最大工作量） |

### 2.2 Rust（src-tauri/，~2.6k 行）

| 模块 | 复用 | 说明 |
|---|---|---|
| `vault.rs`（1717 行） | **基本原样** | `std::fs` 在 Android app 私有目录下完全可用；路径越界检查、BOM/CRLF 处理、同步扫描、附件原子写全部保留。`cargo test`（roundtrip/create/sync）可在宿主机原样跑 |
| `net.rs` | 小改 | 逻辑不变；TLS provider 按平台切换（§4.2） |
| `sync_store.rs` | 原样 | 路径经 `app_config_dir()` 获取，Android 上自动映射到 app 私有目录 |
| `watch.rs` | 移动端不启用 | Android 上 vault 独占于本进程，没有外部改动源；改为「回前台时重扫」（§4.3） |
| `data_dir.rs` | 桌面专属 | WebView2 数据目录机制 Windows 专属，整体 `#[cfg(desktop)]`；Android 由系统管理 |
| `lib.rs` | 部分裁剪 | `open_new_window`/`startup_vault`/`startup_file`/`export_pdf_via_browser`/WebView2 内存 COM 调用均为桌面专属，cfg 隔离 |
| 依赖 | 调整 | `webview2-com`/`windows-core` 桌面专属；`tauri-plugin-updater` 仅桌面注册；ureq 换 TLS feature（§4.2） |

### 2.3 测试资产

- `verify-all.sh` 的 12 步（500+ 断言）：**几乎全部原样复用**——跑在 Node/Rust 宿主上，
  与目标平台无关。这是选 Tauri 方案最有分量的一条理由。
- `verify-gui.sh`：CDP 驱动 WebView2 的模式可以平移到 Android（debug 构建的 WebView
  支持 Chrome DevTools 协议，`adb forward tcp:9222` 后同一套 mjs 脚本思路可改），
  归入 A4 而非前置。

---

## 3. 目标架构

```
┌──────────────────────────────────────────────┐
│              同一份前端 (React + CM6)          │
│   platform.ts 运行时分支（UI 布局 / 交互方式）   │
├──────────────────────────────────────────────┤
│              同一套 Tauri 命令 (api.ts)        │
├──────────────────────┬───────────────────────┤
│  Windows (现状)       │  Android (新增)        │
│  WebView2 + COM 优化  │  System WebView        │
│  notify 文件监听      │  无监听→回前台重扫       │
│  updater 自更新       │  应用内检查→APK 下载     │
│  边框窗口/多窗口      │  全屏单窗/无多窗口       │
└──────────────────────┴───────────────────────┘
```

分支原则（三条纪律，避免腐化）：

1. **Rust 侧只用 cfg**：`#[cfg(desktop)]` / `#[cfg(mobile)]`，禁止 `#[cfg(windows)]` 与
   `#[cfg(target_os = "android")]` 混写导致四象限遗漏。
2. **capabilities 按平台拆文件**：现有 `default.json` 改名 `desktop.json`（标
   `"platforms": ["windows","macOS","linux"]`），新增 `mobile.json`（notification、
   core 默认集；window minimize/maximize 等桌面权限不进移动端）。
3. **TS 侧收敛到 `lib/platform.ts` 单点**：导出 `isMobile`、能力探测
   （hover 有无、触屏、安全区），UI 代码禁止散落 `navigator.userAgent` 判断。

### 仓库（vault）在 Android 上的位置 —— 本文档最重要的产品决策

> **A0 后修订（2026-10-03，用户需求驱动）**：原「固定单一私有仓库 + zip 导入导出」
> 升级为「**用户选择基础目录 + 多仓库发现**」：
>
> 1. **首次启动引导**：申请「所有文件访问」权限（`MANAGE_EXTERNAL_STORAGE`，
>    侧载分发无商店审核问题）→ 用户选一个**基础目录**（SAF 选择器只用来取路径，
>    选中即把 `content://` 树 URI 换算成真实路径，如 `primary:QuickNote` →
>    `/storage/emulated/0/QuickNote`）；权限被拒则回退 app 私有目录，功能不挡死。
> 2. **仓库发现**：基础目录下一级子目录中，含 `.md` 或 `quick-daily-note.json` /
>    `.obsidian` 标记者识别为仓库；「新建仓库」= 基础目录下建子目录。
>    之后全部读写走原生 `std::fs`，`vault.rs` **零改动**（Syncthing 等应用同款机制）。
> 3. **仓库列表页**（移动端首页）：仓库卡片；配置了同步账号后显示各仓库的
>    「已开启同步」徽标；点仓库打开；对某仓库开启同步后自动同步
>    （沿用桌面 per-vault 同步开关与「切仓库默认停自动同步」语义）。
> 4. **限制提示**：网盘客户端的「虚拟文件/仅在线」目录不落真实字节，不能当仓库，
>    引导页文案说明；v1 只支持主存储（`primary:` 卷）。
>
> 原 zip 导入导出方案取消（基础目录本身可达，不再需要）；原「固定私有目录」降级为
> 权限被拒时的回退路径。桌面端语义不变（仓库始终用户选择，不走基础目录模型）。

**移动端仓库固定使用 app 私有目录**（`filesDir/vault`）为回退方案，**不支持把仓库放在 SD 卡或
用户自选目录**的原始理由（SAF 逐文件代理慢、URI 授权回收、wiki 相对路径碎裂）仅针对
「直接把仓库建在 SAF URI 上」；上面的修订通过「选择器取路径 + 全量文件权限 + 真实路径
读写」绕开了这三点，因此成立。

---

## 4. 关键技术决策与难点（逐条：问题 → 决策）

### 4.1 依赖与 cfg 隔离

- `webview2-com`、`windows-core`：`#[cfg(desktop)]` 收进现有内存优化模块。
  Android 内存治理见 §4.8。
- `tauri-plugin-updater`：仅桌面注册与初始化；移动端 `updater.ts` 走「检查版本 →
  提示 → 打开 Releases 页/下载 APK」的自建流程（§4.4）。
- `tauri-plugin-dialog`：移动端可用（文件/目录选择映射到系统 SAF 选择器），
  但仅用于**导入/导出**场景，不做 vault 直选（§3 决策）。
- `tauri-plugin-notification`：移动端支持即时通知（Android 13+ 需在 manifest 声明
  `POST_NOTIFICATIONS` 并动态请求权限）；**计划通知仅 iOS**，提醒语义适配见 §4.5。
- `tauri-plugin-opener`：`open_path`（系统浏览器打开链接）移动端映射到 intent；
  `revealItemInDir`（资源管理器定位）桌面专属，移动端对应入口隐藏。
- `tauri-plugin-process`：restart 仅桌面；移动端隐藏相关命令。

### 4.2 同步的 TLS 栈（net.rs）

现状：`ureq` + `native-tls`（Windows 上 = SChannel）。**native-tls 没有 Android 后端**，
不处理则 Android 构建直接失败。

决策：feature 分平台——

```toml
[target.'cfg(desktop)'.dependencies]
ureq = { version = "3", default-features = false, features = ["native-tls"] }
[target.'cfg(mobile)'.dependencies]
ureq = { version = "3", default-features = false, features = ["rustls"] }
```

`net.rs::build_agent` 相应改为：桌面 `TlsProvider::NativeTls`，移动
`TlsProvider::Rustls` + **WebPki 根证书**（捆绑的 Mozilla 根集）。Android 系统信任库
没有暴露在 rustls-native-certs 期望的标准路径上，WebPki 根集对 Let's Encrypt 等主流
CA 足够；daily-sync 服务端是标准证书，无自签需求。现 net.rs 已有注释与 `#[ignore]`
测试守住「provider 必须显式指认」的坑，改法同源。若日后需要信任用户安装的 CA
（公司代理等），再评估 ureq 的 platform-verifier 路径，A1 不做。

### 4.3 文件监听（watch.rs）→ 回前台重扫

桌面端 notify 监听是为了「Obsidian/同步进程/其他编辑器」改文件后界面跟上。Android 上
vault 是本应用独占的私有目录，**不存在外部改动源**（同步引擎与本进程是同一家）。

决策：`watch_vault` 在移动端返回成功但为 no-op（保持 api.ts 无分支）；新增
「Activity onResume → 前端 `rescan_vault()`（`list_vault`/增量刷新现有命令）」。
顺带规避 notify 在 Android 上的 inotify watch 数上限问题。

### 4.4 更新与分发

updater 插件仅支持桌面（Android 由应用商店机制接管，插件文档明确不支持移动端）。
分发渠道对比：

| 渠道 | 优点 | 代价 |
|---|---|---|
| **GitHub Releases APK 直装**（推荐起步） | 与桌面同一发布节奏、无审核、零成本 | 用户需允许安装未知来源；自己处理升级提示 |
| Google Play | 自动更新、信任度高 | $25 开发者账号、审核、隐私政策/数据安全表单 |

决策：A0–A3 用 GitHub Releases APK。应用内更新（A3）做「设置→关于→检查更新」：
打 GitHub Releases API（net.rs 现成通道）比对版本 → 下载 APK 到私有目录 →
intent 触发安装（manifest 需 `REQUEST_INSTALL_PACKAGES` 权限，用户首次需授权
「安装未知应用」）。版本号沿用发版流程四处（package.json / Cargo.toml /
tauri.conf.json / latest.json），Android 另有 `versionCode` 整数（由 version 推导，
发版脚本补一步即可）。

### 4.5 定时提醒与后台同步（Android 后台限制）

Android 对后台进程/定时器的限制远严于桌面（Doze 模式、进程随时可杀）：

- **提醒**：桌面模型是「应用运行中到点检查 + 系统通知」。移动端沿用运行中检查，
  并把「当天时间点已过不再补提醒」的既有初始化语义扩展为**冷启动补检查**（打开应用
  时若当日有未完成待办且已过提醒时刻，补一条本地通知）。真正的后台定时推送留待
  WorkManager 插件或自定义插件（A3 之后评估，不影响核心可用）。
- **后台同步**：不做后台常驻同步（电量与系统限制都不友好）。同步时机 =
  启动首同步（现有逻辑）+ 回前台触发一轮 + 改动防抖推送（前台期间照常）。
  离线编辑无碍：防抖推送失败有现有重试/游标机制兜底。

### 4.6 键盘、IME 与 WebView（最高风险项，A0 首验）

CM6 对移动端有官方支持（composition/IME 处理是 6.x 的重点，Obsidian mobile 背书），
但组合细节必须真机验证：

- **窗口缩放**：targetSdk 35（Play 2025-08 起强制）默认 edge-to-edge，键盘不再自动
  resize。三件套：manifest `android:windowSoftInputMode="adjustResize"` +
  `index.html` viewport 改为
  `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content`
  + 安全区 padding（`env(safe-area-inset-*)`，刘海屏/手势条）。A0 用「编辑器聚焦时
  光标不被键盘遮挡」作为验收断言。
- **中文输入法**（Gboard/搜狗/三星）：组合输入中的装饰层行为、退格、光标周边点击。
  验证清单写进 A0；发现 CM6 层 bug 以降级策略保底（问题模式关闭对应装饰/自动配对，
  配置开关已有先例）。
- **无物理键盘**：Ctrl+K/Ctrl+N 等全局快捷键在移动端无入口——命令面板改为顶栏搜索
  按钮唤起（现有组件已支持点击），高频 Markdown 操作补移动工具栏（标题/粗体/列表/
  待办/表格/代码块，A2）。快捷键设置页在移动端隐藏。
- **WebView 兼容下限**：前端用了容器查询（cqw，Chrome 105+）与 `color-mix`
  （Chrome 111+）。Android System WebView 经 Play 可更新，Android 8+ 设备基本满足；
  启动时检测 WebView 主版本 < 111 时提示升级 WebView 而不是白屏。

### 4.7 移动 UI 改造（最大工作量，A2 主体）

现有 UI 的桌面假设与移动端改造点：

| 现状 | 移动端方案 |
|---|---|
| 三栏 PKM 布局（文件树 / 编辑器 / 日历-目录-统计） | **抽屉导航**：文件树 = 左抽屉；右栏三页签 = 底部 sheet 或底部导航；专注模式天然贴合 |
| 悬停交互（行尾 ⋯、图片/mermaid 工具栏、表格结构菜单） | 触摸化：`@media (hover: none)` 下改为**长按**或常驻小按钮（menuClamp 已有防溢出逻辑可复用） |
| 无边框窗口/自绘标题栏/最小化最大化 | 整层隐藏（移动端 WebView 全屏，无窗口概念） |
| 右键菜单（文件树/表格） | 与悬停 ⋯ 同一菜单组件，长按唤起 |
| 多标签页 | 保留（移动端纵向标签条或「标签列表」下拉；打开方式设置默认「替换当前标签」已是移动友好值） |
| 命令面板/搜索框 | 顶栏按钮唤起；全文搜索入口保留 |
| 设置面板 660×580 固定尺寸 | 全屏化改造，分类导航不变 |
| 快速笔记（Ctrl+Alt+N） | 移动端成为**一级入口**（底栏 ＋ 按钮）；配合分享接入（§4.9）是移动端最有价值的场景 |
| PDF 导出（系统打印对话框 / Edge 无头） | 移动端隐藏（Android 打印框架体验差、无 Edge 通道）；保留 Markdown 源与渲染即可 |
| 全局背景图 | 保留，注意大图内存（§4.8） |

响应式基础已有（cm-* 三档断言、顶栏梯度退场），但移动断点要新建
`@media (max-width: 600px)` 一档并配合 hover:none，工作量大头在交互替换而非布局重画。

### 4.8 内存治理（对齐桌面纪律）

桌面有 WebView2 COM 释放缓存 + 挂机降到 ~148MB 的实测基线。移动端：

- `webview2-com` COM 路径不可用（Windows 专属）；Android 上挂接 Activity 生命周期
  （onStop/onTrimMemory），策略对齐桌面「失焦 3 分钟释放」：回后台超时后通知前端做
  深度清理（mermaid SVG 缓存、懒预览关闭——现有 2 分钟闲置清理逻辑可复用）。
- 大文档 + mermaid 在移动端是内存大头：mermaid 缓存上限再收紧（12 → 6 或按设备内存
  分档：`ActivityManager.isLowRamDevice`），图片 lightbox 与 PDF 懒渲染纪律已有，
  保持即可。
- 验收口径改为 Android Studio Profiler / `adb shell dumpsys meminfo`，目标：常规编辑
  私有内存 ≤ 200MB（桌面为 160MB 基线 + WebView 差异余量）。

### 4.9 平台集成加分项（A3）

- **系统分享接入**：任意应用「分享 → Quick Note」直接进快速笔记弹窗（带来源记录）。
  Tauri 2 无官方 share-receive 插件；用 deep-link（`tauri-plugin-deep-link`）+
  一个 ~50 行的自定义 Activity/manifest intent-filter 兜内容 URI 读取。这是移动端
  相对桌面端的**增量价值**，优先做。
- **图片附件**：系统相册/拍照经 SAF 选择 → 复制进 attachments（复用现有
  `write_attachment` 原子写与命名逻辑）；相机拍摄需要 `CAMERA` 权限（可选）。
- **桌面快捷方式/小组件**：不做（第一版）。

### 4.10 凭据存储

现状 `sync-state.json` 明文存密码与令牌（桌面现状，位于用户配置目录）。Android 上
`app_config_dir` 映射到 app 私有目录（沙箱内，root 之外不可读），**安全水位不低于
桌面现状**，A1 可接受。中期加固（A3+）：凭据迁 Android Keystore 加密的
EncryptedSharedPreferences，Rust 侧经插件读取；列为 backlog 不阻塞。

---

## 5. 工程组织与构建

- **环境**（Windows 开发机增量）：Android Studio（SDK + Platform-Tools + NDK）+
  JDK 17 + `rustup target add aarch64-linux-android armv7-linux-androideabi
  x86_64-linux-android i686-linux-android`。首次 `npm run tauri android init`
  生成 `src-tauri/gen/android`（提交入库；本地签名配置不提交）。
- **日常开发**：`npm run tauri android dev`（USB/无线 ADB 真机或模拟器），
  前端仍走 vite 热更新；桌面 `npm run tauri dev` 流程不变。
- **目标架构**：首版只出 `arm64-v8a`（2019 年后设备全覆盖，Play 也只要求 64 位）；
  `armeabi-v7a` 按需后补。产物：`app-universal-release.apk`（签名后发 Releases）。
- **签名**：生成独立 keystore（丢失即无法再更新，备份进密码管理器）；发布脚本在
  现有发版流程上追加 Android 构建/签名/上传步骤。
- **CI（可选）**：GitHub Actions 加 android 构建 job（`tauri-action` 支持移动目标），
  缺了也能本地出包。
- **版本与兼容**：minSdk 24（Tauri 默认，Android 7）；WebView 主版本检测提示升级
  （§4.6）。

---

## 6. 里程碑计划

> 每阶段有明确验收线；A0 的 IME 真机验证是 go/no-go 门（失败则转 Capacitor Plan B 重评）。

### A0 脚手架与真机闭环（~1 周）

- 环境搭建；`tauri android init`；cfg 隔离桌面专属代码直至 Android 构建通过
  （net.rs TLS、webview2-com、data_dir、updater、open_new_window、startup_*）
- vault 指向 `filesDir/vault`；应用启动进空仓库；手动放一篇 md 能打开编辑保存
- **真机验证清单**：中文 IME 组合输入、退格、光标点击定位、键盘弹出时光标可见、
  Live Preview 基本渲染、深浅主题
- 验收：真机上完整完成「打开 → 输入中文 → 自动保存 → 重开不丢」

### A1 核心可用（~2-3 周，2026-10-03 修订：仓库模型改为基础目录 + 多仓库）

- **仓库模型落地**：`MANAGE_EXTERNAL_STORAGE` 权限接入（manifest + 可写性探测 +
  授权引导）、基础目录设置（SAF 取路径 → 真实路径换算，存 Rust 配置目录）、
  `list_vaults` / `create_vault` 命令、首次启动引导页、**仓库列表页（移动端首页，
  含同步徽标与一键开启同步）**
- 文件树（基础目录下各仓库全量列目录）、多标签、自动保存、回收站 `.trash`
- 同步全流程：登录/续期/推送/拉取/冲突（syncEngine.ts 原样 + rustls）；对桩后端
  跑一轮验收（同 gui-sync 思路）
- 附件：SAF 相册导入、粘贴（Android 剪贴板）、图片 asset 协议加载
- 日记/待办/库内配置（与插件共写）、命令面板、全局搜索
- 验收：纯逻辑 verify-all 全绿 + 模拟器完成「引导选目录 → 建仓库 → 写日记 →
  云端 ↔ 桌面互通」

### A2 移动 UI（~2-4 周）

- 抽屉导航 + 底部导航布局；`hover: none` 交互改造（长按菜单/常驻按钮）
- Markdown 工具栏、编辑器触摸体验（选择手柄、滚动性能）、返回键语义
 （弹窗 → 关弹窗；抽屉 → 收抽屉；否则退后台）
- 设置面板全屏化、日记/日历/待办/速记管理视图移动适配、快速笔记底栏入口
- 验收：不接键盘完成全部高频操作；verify-gui 思路的首个移动冒烟脚本（adb + CDP）

### A3 平台集成与发布（~1-2 周）

- 系统分享接入快速笔记；通知权限与冷启动补提醒；图片裁剪/删除适配
- 签名 keystore、发版脚本追加 Android、GitHub Releases 发 APK、应用内检查更新
- 内存基线实测与治理（onStop 清理、低内存设备降档）
- 验收：从 Releases 页安装 → 配置同步 → 与桌面互通的完整用户旅程

### A4 验收回归（~1 周）

- verify-all 常态化（CI 跑宿主侧）；移动 GUI 冒烟脚本集（关键路径 20+ 断言）
- 电量/流量观测（一轮同步的字节数与已有上限一致）；机型回归（2-3 台不同品牌）
- 发 1.0.0-android 或并入统一版本号

总量估计：**全职 6-10 周**（单人、含桌面并行维护的缓冲）。

---

## 7. 测试与验收策略（最大化复用现有资产）

| 层 | 手段 | 复用情况 |
|---|---|---|
| 纯逻辑 | `verify-all.sh` 12 步 | **原样**（Node/Rust 宿主执行） |
| Rust 集成 | `cargo test`（roundtrip/create/sync） | **原样**（`std::fs` 不依赖 Android 运行时） |
| 同步端到端 | 桩后端（gui-sync 模式） | 脚本改造：CDP 目标改为 adb 转发的 Android WebView |
| GUI 移动冒烟 | debug 构建开 WebView 远程调试 → `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` → 现有 CDP mjs 思路 | 新写，覆盖：编辑/保存/同步/日记/速记/抽屉导航 |
| 真机清单 | IME、不同键盘、深浅色、刘海屏、弱网同步失败重试 | 人工回归单 |

纪律沿用：两层测试缺一不可；GUI 断言前先滚进视口；内存回归用固定口径工具
（Android 用 `dumpsys meminfo` 私有 dirty，对标桌面 measure-rss 的私有工作集口径）。

---

## 8. 风险清单

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| CM6 + 国产输入法 IME 边角 bug（组合中装饰错位/丢字） | 中 | 高 | A0 最先真机验证；可按模式降级装饰/自动配对；Obsidian mobile 同栈先例 |
| Tauri Android 粗糙边（升级破坏、插件移动缺口） | 中 | 中 | 锁定 2.x 小版本升级节奏；A0 结论决定是否转 Capacitor Plan B |
| WebView 版本碎片化（老设备 color-mix 等不支持） | 低 | 中 | 启动检测 + 提示升级 WebView；minSdk 24 但兼容下限按 111 宣传 |
| 移动 UI 改造低估（hover→touch 面广） | 中 | 中 | A2 拆成组件级任务逐个验收；menuClamp/命令面板等现成资产复用 |
| 大文档 + mermaid 移动端内存/性能 | 中 | 中 | 缓存分档（isLowRamDevice）；预览懒加载纪律已有；统计口径进 A3 验收 |
| SAF 边做边设计导致返工 | 低 | 高 | 本文档已锁定「私有目录 vault + 导入导出 zip」决策，SAF 只进设置页 |
| Android 后台限制使提醒/后台同步不达预期 | 高 | 低 | 已按前台模型设计语义；真后台列 backlog |
| 单人双端并行，桌面回归被挤占 | 中 | 中 | Android 不动共享纯函数层；桌面发版前 verify-all 必跑；版本线分开 |

---

## 9. 桌面功能在移动端的取舍（明确不做/延后）

| 功能 | 移动端处置 |
|---|---|
| 无边框窗口/自绘标题栏/最小化最大化/多窗口 | 不做（无窗口概念） |
| 文件关联双击打开、启动参数、最近仓库下拉 | 不做（仓库固定私有目录） |
| 自定义数据目录（data-dir 指针） | 不做（系统沙箱） |
| updater 插件静默自更新 | 换「检查更新 → APK 安装」流程 |
| Edge/Chrome 无头导出 PDF | 不做（可后续评估 Android 打印框架） |
| 全局快捷键设置 | 不做（无全局键盘），命令面板保留 |
| 文件监听 | no-op（回前台重扫替代） |
| 在资源管理器中显示 | 不做（无此概念）；导出 zip 替代 |

---

## 参考

- Tauri 2 稳定版与移动支持公告：https://v2.tauri.app/blog/ ，当前 2.x 稳定线（2.12，2026-09）
- Tauri 移动端成熟度讨论（社区实测反馈）：https://github.com/tauri-apps/tauri/discussions/10197
- updater 插件平台支持（仅桌面）：https://v2.tauri.app/plugin/updater/
- ureq 3 TLS provider / 根证书机制：https://docs.rs/ureq/3
- CM6 移动端 IME 支持背景：https://codemirror.net/docs/ （6.x composition/mobile 支持；
  Obsidian mobile 为同栈生产先例）

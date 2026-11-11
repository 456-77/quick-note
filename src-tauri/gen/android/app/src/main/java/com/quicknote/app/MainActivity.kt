package com.quicknote.app

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : TauriActivity() {
  /** 待派发的分享文本（冷启动时 WebView 尚未就绪，先存 here）。 */
  private var pendingShareText: String? = null
  /** 待派发的分享图片：Kotlin 已从 content:// 拷进应用缓存（前端经 Rust 读同沙箱文件）。 */
  private var pendingShareImagePath: String? = null
  private var pendingShareImageMime: String? = null
  private var webViewRef: WebView? = null
  /** 最新系统栏 inset（0.34.8 全幅架构：前端启动经 qnAndroid.insets() 拉取）。 */
  private var insetJson: String = "{\"top\":0,\"bottom\":0}"
  private val mainHandler = Handler(Looper.getMainLooper())
  /** 相册选壁纸的回调（SAF）：用户选完/取消后回 JS（0.34.6 壁纸从相册选）。 */
  private var pendingBgPick = false
  /** 待拷贝的目标仓库目录（SAF 结果回来时用）。 */
  private var bgPickVaultDir: String? = null

  companion object {
    /** SAF 相册选壁纸的请求码。 */
    private const val REQ_PICK_BG = 4201
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQ_PICK_BG || !pendingBgPick) return
    pendingBgPick = false
    val webView = webViewRef ?: return
    val uri = data?.data
    if (resultCode != RESULT_OK || uri == null) {
      notifyBgPick(webView, false, "")
      return
    }
    val vaultDir = bgPickVaultDir
    if (vaultDir.isNullOrBlank()) {
      notifyBgPick(webView, false, "目标仓库目录为空")
      return
    }
    // 拷贝放 IO 线程（大图可能几 MB）；结果回 UI 线程再 evaluateJavascript
    Thread {
      try {
        val dir = File(vaultDir, "attachments").apply { mkdirs() }
        // 扩展名从 mime 推断（content:// 没有真实路径）
        val ext = when (contentResolver.getType(uri)) {
          "image/png" -> "png"
          "image/webp" -> "webp"
          "image/gif" -> "gif"
          else -> "jpg"
        }
        val dest = File(dir, "background.$ext")
        contentResolver.openInputStream(uri)?.use { input ->
          dest.outputStream().use { output -> input.copyTo(output) }
        } ?: throw IOException("无法读取所选图片")
        val relPath = "attachments/${dest.name}"
        mainHandler.post { notifyBgPick(webView, true, relPath) }
      } catch (e: Exception) {
        val msg = (e.message ?: "拷贝失败").replace("\"", "'")
        mainHandler.post { notifyBgPick(webView, false, msg) }
      }
    }.start()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 0.39.1 用户反馈「下载完没装的安装包要保留一段时间，超期自动删除」：
    // 更新包保留 3 天——期间再次点更新命中同大小包就免重下直接装；超期清理。
    File(filesDir, "update").takeIf { it.isDirectory }?.let { dir ->
      val cutoff = System.currentTimeMillis() - 3L * 24 * 60 * 60 * 1000
      dir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    }
    captureShare(intent)
    // window 背景取主题的 windowBackground——edge-to-edge 下系统栏透明，
    // 透出应用配色而不是刺眼白色
    val bg = TypedValue()
    theme.resolveAttribute(android.R.attr.windowBackground, bg, true)
    if (bg.resourceId != 0) {
      window.decorView.setBackgroundResource(bg.resourceId)
    }
  }

  /** 应用已在运行时的二次分享（singleTask：走 onNewIntent）。 */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    captureShare(intent)
    dispatchPendingShare()
  }

  private fun captureShare(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    val mime = intent.type ?: return
    when (mime) {
      "text/plain" -> {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (!text.isNullOrBlank()) pendingShareText = text
      }
      "image/png", "image/jpeg", "image/webp" -> captureShareImage(intent, mime)
    }
  }

  /** 分享图片：content:// 流拷进 cacheDir（与 Rust/前端同沙箱，前端可读）。 */
  private fun captureShareImage(intent: Intent, mime: String) {
    val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
    try {
      val ext = if (mime == "image/jpeg") "jpg" else if (mime == "image/webp") "webp" else "png"
      val dest = File(cacheDir, "shared-image-${System.currentTimeMillis()}.$ext")
      contentResolver.openInputStream(uri)?.use { input ->
        dest.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
      } ?: return
      if (dest.exists() && dest.length() > 0) {
        pendingShareImagePath = dest.absolutePath
        pendingShareImageMime = mime
      }
    } catch (e: Exception) {
      // 分享图片失败不阻塞文本分享；前端不会有图片参数
    }
  }

  /**
   * 分享派发：WebView 就绪 ≠ 前端已注册接收器（React 挂载要几秒），
   * 轮询直到 __qnShareReceive 存在（300ms × 50 次 = 15s 上限），派发后清 pending。
   */
  private fun dispatchPendingShare() {
    val webView = webViewRef ?: return
    mainHandler.postDelayed(object : Runnable {
      private var attempts = 0
      override fun run() {
        val text = pendingShareText
        if (text == null) return
        if (attempts >= 50) {
          pendingShareText = null
          return
        }
        attempts += 1
        webView.evaluateJavascript("(typeof window.__qnShareReceive === 'function') ? 'ready' : 'no'") { r ->
          if (r == "\"ready\"") {
            val json = text
              .replace("\\", "\\\\").replace("\"", "\\\"")
              .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
            webView.evaluateJavascript("window.__qnShareReceive(\"$json\")", null)
            pendingShareText = null
          } else {
            mainHandler.postDelayed(this, 300)
          }
        }
      }
    }, 300)
  }

  override fun onWebViewCreate(webView: WebView) {
    webViewRef = webView
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      // 键盘（ime）必须参与：API 35 edge-to-edge 下系统不再为 IME 缩放窗口，
      // WebView 的 interactive-widget 也不生效——不把 ime 算进 margin 的话，
      // 键盘会直接盖住输入区和底部工具栏。
      val bars: Insets = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime: Insets = insets.getInsets(WindowInsetsCompat.Type.ime())
      // 0.33.1 用户反馈「输入内容时会保持底部功能栏」：键盘弹出时给前端一个
      // 开关类，CSS 据此隐藏底栏（Markdown 工具栏保留），编辑区直达键盘上缘
      webView.evaluateJavascript(
        "document.documentElement.classList.toggle('qn-ime-open', ${ime.bottom > 0})",
        null,
      )
      val lp = webView.layoutParams
      if (lp is ViewGroup.MarginLayoutParams) {
        // 0.34.8 用户反馈「顶部和底部的系统栏没有渲染背景图片，很突兀」：
        // 纵向不再 margin 让出系统栏——WebView 全幅铺满，背景图层（#qn-bg-layer，
        // fixed inset 0）跟着铺到栏后；内容避让改由前端按 --qn-inset-top/bottom
        // CSS 变量处理。横向仍让出（刘海/挖孔侧缘），键盘照旧 margin 顶住
        lp.setMargins(bars.left, 0, bars.right, ime.bottom)
        webView.layoutParams = lp
      }
      // inset 喂给前端：底部在键盘弹出时归零（导航栏被键盘盖住，WebView 底缘
      // 就是键盘顶缘，内容不再需要让出导航栏高度）。
      // ⚠ insets 是**物理像素**，前端 CSS 变量要的是 dp——0.34.8 首发直接把 px
      // 写进 CSS，被 DPR（2.6~3x）放大成天文数字，表现为「上下空白很大」
      // （0.34.8 用户反馈）。这里换算成 dp；120dp 是保险钳（正常 24~48dp，
      // 防 ROM 虚报直接撑爆布局）。
      val density = resources.displayMetrics.density
      val topDp = (bars.top / density).toInt().coerceIn(0, 120)
      val bottomDp = if (ime.bottom > 0) 0 else (bars.bottom / density).toInt().coerceIn(0, 120)
      insetJson = "{\"top\":$topDp,\"bottom\":$bottomDp}"
      webView.evaluateJavascript(
        "(window.__qnApplyInsets || function(){})($insetJson)",
        null,
      )
      insets
    }

    // JS → 原生的上行通道（仅此一个受控入口）：应用内更新下载与安装。
    webView.addJavascriptInterface(UpdateBridge(), "qnAndroid")

    // 分享派发轮询（同 dispatchPendingShare 的注释）
    mainHandler.postDelayed(object : Runnable {
      private var attempts = 0
      override fun run() {
        val text = pendingShareText
        if (text == null) return
        if (attempts >= 50) {
          pendingShareText = null
          return
        }
        attempts += 1
        webView.evaluateJavascript("(typeof window.__qnShareReceive === 'function') ? 'ready' : 'no'") { r ->
          if (r == "\"ready\"") {
            val json = text
              .replace("\\", "\\\\").replace("\"", "\\\"")
              .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
            webView.evaluateJavascript("window.__qnShareReceive(\"$json\")", null)
            pendingShareText = null
          } else {
            mainHandler.postDelayed(this, 300)
          }
        }
      }
    }, 500)

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(
          "(typeof window.__qnConsumeBack === 'function' && window.__qnConsumeBack()) ? 'consumed' : 'exit'"
        ) { result ->
          if (result != "\"consumed\"") {
            // 放行：禁用自己再触发 dispatcher，轮到 wry 的 callback（后退/退出），
            // 然后重新启用，下次 back 再走前端消费链
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    })
  }

  /**
   * 暴露给 JS 的更新桥（qnAndroid.*）。方法都在非 UI 线程被调（JavascriptInterface
   * 约定），网络 IO 直接做，回调 UI 用 mainHandler。
   */
  inner class UpdateBridge {
    /**
     * 系统栏（0.34.8 全幅架构）：WebView 纵向不再让出系统栏，栏后透出的就是
     * WebView 自己的内容（背景图层全幅铺到栏后），着色反而会把图盖住——栏
     * 保持全透明，只按主题调状态栏/导航栏图标的深浅。color 参数保留兼容旧
     * 调用方（0.33.1 的配色语义已由全幅内容取代）。
     */
    @JavascriptInterface
    fun setChromeBackground(color: String, dark: Boolean) {
      mainHandler.post {
        try {
          window.statusBarColor = Color.TRANSPARENT
          window.navigationBarColor = Color.TRANSPARENT
          val controller = WindowInsetsControllerCompat(window, window.decorView)
          controller.isAppearanceLightStatusBars = !dark
          controller.isAppearanceLightNavigationBars = !dark
        } catch (_: Exception) {
        }
      }
    }

    /**
     * 当前系统栏 inset（0.34.8 全幅架构）：前端启动时拉一次（qnAndroid.insets()），
     * 之后原生在 insets 变化（旋转/键盘）时经 window.__qnApplyInsets 推。
     * 返回 JSON：{"top":dp,"bottom":dp}（dp 单位、已含键盘归零与 120dp 钳制，
     * 见监听器——CSS 变量要 dp，物理 px 会被 DPR 放大）。
     */
    @JavascriptInterface
    fun insets(): String = insetJson

    /** 是否已拥有「所有文件访问」授权（真值 = 主存储可写探测，与 Rust probe 同哲学）。 */
    @JavascriptInterface
    fun canAccessAllFiles(): Boolean {
      return tryProbePrimaryStorage()
    }

    /** 跳到系统的「所有文件访问」授权页（引导页第一步）。 */
    @JavascriptInterface
    fun requestAllFilesAccess() {
      mainHandler.post {
        try {
          startActivity(
            Intent(
              android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
              Uri.parse("package:$packageName")
            )
          )
        } catch (e: Exception) {
          // 个别 ROM 没有 per-app 页时退回总开关页
          startActivity(Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
      }
    }

    /** 主存储可写探测（真实建删一个临时文件）。 */
    private fun tryProbePrimaryStorage(): Boolean {
      return try {
        val probe = File("/storage/emulated/0/.qn-probe-${hashCode()}")
        probe.writeText("ok")
        probe.delete()
        true
      } catch (e: Exception) {
        false
      }
    }

    /** 是否已拥有「安装未知应用」授权（没有则 JS 先引导用户去开）。 */
    @JavascriptInterface
    fun canRequestInstall(): Boolean {
      return packageManager.canRequestPackageInstalls()
    }

    /**
     * 从系统相册选一张图作为壁纸（0.34.6 用户反馈：应用还不支持直接在库中
     * 添加图片，壁纸该能从相册选）。启动 SAF 图片选择器；用户选完后把原图
     * 拷贝到 vaultDir/attachments/background.<扩展名> 并回调
     * __qnBgPickDone(ok, relPathOrError)。vaultDir 由前端传（当前仓库绝对路径），
     * 应用已有所有文件访问权，直接写主存储。
     */
    @JavascriptInterface
    fun pickBackgroundImage(vaultDir: String) {
      val webView = webViewRef ?: return
      mainHandler.post {
        try {
          bgPickVaultDir = vaultDir
          pendingBgPick = true
          val intent = Intent(Intent.ACTION_PICK)
          intent.type = "image/*"
          startActivityForResult(intent, REQ_PICK_BG)
        } catch (e: Exception) {
          notifyBgPick(webView, false, "无法打开相册：${e.message}")
        }
      }
    }

    /** 跳到系统的「安装未知应用」授权页（安装前一次性授权）。 */
    @JavascriptInterface
    fun requestInstallPermission() {
      mainHandler.post {
        val intent = Intent(
          android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:$packageName")
        )
        startActivity(intent)
      }
    }

    /**
     * 下载 APK 到私有目录并拉起系统安装器。完成/失败经 __qnUpdateDone(ok, message)
     * 回报前端；下载中经 __qnUpdateProgress(pct) 播百分比（0.34.2 用户反馈
     * 「更新要显示进度」）。弱网/代理环境一条连接常被中途掐断（真机
     * 「Software caused connection abort」）：最多试 3 次、间隔 1.2s。
     * 重复调用被 downloading 闸挡住——前端双击/重试不会叠出多路下载。
     */
    @JavascriptInterface
    fun installUpdate(url: String) {
      val webView = webViewRef ?: return
      if (!downloading.compareAndSet(false, true)) {
        notifyUpdateDone(webView, false, "已有下载在进行中，请稍候")
        return
      }
      // 0.38.4 用户反馈「点击下载后状态不变、无进度条、整个页面卡住，下载完才
      // 见结果」：JavascriptInterface 方法与 JS 主线程是**同步**调用——在这里
      // 内联下载会把 JS 线程堵到下载结束（点击前排队的 setState 渲染不出来、
      // __qnUpdateProgress 全排在被堵的线程上、任何按钮无响应）。下载挪后台
      // 线程，本方法立即返回；进度/结果照旧经 mainHandler 回前端。
      Thread {
        try {
          val dir = File(filesDir, "update").apply { mkdirs() }
          val dest = File(dir, "quick-note-update.apk")
          // 0.39.4 用户反馈「安装时系统报解析错误」：HEAD 服务器当前包大小提前到
          // 下载决策之前——复用/续传/重下三种走向都要以它为准。
          val remoteLen = headContentLength(url)
          // 0.39.1 用户反馈「下载完没装的话安装包会被自动删掉，不可能一直等在页面」：
          // 已下载完成且与服务器当前包**同大小**的，直接复用拉起安装器（免重下，
          // 秒进安装页）。0.39.4 起复用还要求是合法 ZIP（同长度的坏包不重演解析错误）。
          if (dest.exists() && dest.length() > 0L && remoteLen != null &&
              remoteLen == dest.length() && looksLikeApk(dest)
          ) {
            mainHandler.post { launchInstaller(webView, dest) }
            return@Thread
          }
          val meta = File(dir, dest.name + ".meta")
          // 半包比服务器当前包还长：要么是换过版本的残包，要么长度坏掉——续传必
          // 416/拼出跨版本杂合包，先清掉（0.39.4）
          if (dest.exists() && remoteLen != null && dest.length() > remoteLen) {
            dest.delete()
            meta.delete()
          }
          dir.listFiles()?.forEach { if (it != dest && it != meta) it.delete() }
          var lastError: IOException? = null
          var attempts = 0
          while (attempts < 3) {
            attempts += 1
            try {
              downloadApk(webView, url, dest, remoteLen, meta)
              lastError = null
              break
            } catch (e: IOException) {
              lastError = e
              if (attempts < 3) {
                try {
                  Thread.sleep(1200)
                } catch (_: InterruptedException) {
                }
              }
            }
          }
          val err = lastError
          if (err != null) {
            notifyUpdateDone(
              webView,
              false,
              "下载失败（已重试 $attempts 次）：${err.message}。网络不稳可再试（已支持断点续传），或到发布页直接下载 APK"
            )
            return@Thread
          }
          if (!dest.exists() || dest.length() == 0L) {
            notifyUpdateDone(webView, false, "下载失败：文件为空")
            return@Thread
          }
          mainHandler.post {
            launchInstaller(webView, dest)
          }
        } finally {
          downloading.set(false)
        }
      }.start()
    }

    /**
     * APK 最小完整性检查（0.39.4「解析错误」防御）：文件头是 ZIP 魔数 PK\x03\x04，
     * 且文件尾 64KB+22 字节内找得到 ZIP 的 EOCD（0x06054b50）——被掐断的半包
     * 没有 EOCD，长度校验漏掉的坏包在这里拦住，不让它到系统安装器那里才炸。
     */
    private fun looksLikeApk(file: File): Boolean {
      return try {
        java.io.RandomAccessFile(file, "r").use { raf ->
          val len = raf.length()
          if (len < 22L) return false
          val head = ByteArray(4)
          raf.seek(0)
          raf.readFully(head)
          if (!(head[0] == 0x50.toByte() && head[1] == 0x4B.toByte() &&
                head[2] == 0x03.toByte() && head[3] == 0x04.toByte())
          ) return false
          val tailLen = minOf(len, 65536L + 22L).toInt()
          val tail = ByteArray(tailLen)
          raf.seek(len - tailLen)
          raf.readFully(tail)
          (0..tailLen - 4).any { i ->
            tail[i] == 0x50.toByte() && tail[i + 1] == 0x4B.toByte() &&
                tail[i + 2] == 0x05.toByte() && tail[i + 3] == 0x06.toByte()
          }
        }
      } catch (_: Exception) {
        false
      }
    }

    /** 用 FileProvider 拉起系统安装器（下载完成与「复用已下载的包」共用一条路）。 */
    private fun launchInstaller(webView: WebView, dest: File) {
      try {
        val uri: Uri = FileProvider.getUriForFile(
          this@MainActivity,
          "$packageName.fileprovider",
          dest
        )
        val install = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(install)
        notifyUpdateDone(webView, true, "已开始安装")
      } catch (e: Exception) {
        notifyUpdateDone(webView, false, "拉起安装器失败：${e.message}")
      }
    }

    /**
     * HEAD 探服务器安装包大小（复用已下载包的校验依据）。失败返回 null——
     * 探不到就照旧走下载（断点续传兜底），不因为预检失败堵死更新。
     */
    private fun headContentLength(url: String): Long? {
      return try {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "HEAD"
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.instanceFollowRedirects = true
        val len = connection.contentLengthLong
        connection.disconnect()
        if (len > 0) len else null
      } catch (_: Exception) {
        null
      }
    }

    /** 下载互斥闸：同一时刻只允许一路下载（0.34.2 用户反馈「可能会下载多次」）。 */
    private val downloading = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * 下载 APK 本体；进度经 __qnUpdateProgress(pct) 回前端（300ms 节流）。
     * 0.38.4 用户反馈「自部署服务器怎么还会下载失败」：弱网/运营商 NAT 常把
     * 长连接中途掐断（0.34.2 实锤 Software caused connection abort），此前每次
     * 重试都从头拉整个 APK。服务端下载端点已带 `Accept-Ranges: bytes`——
     * 半包续传：带 Range 重试，206 追加、200 重下。
     *
     * 0.39.4「解析错误」两道闸：收尾校验总长+APK 结构（干净 EOF 的残包不再
     * 冒充成功）；meta 边车记着半包所属的服务器总长，续传前比对——半包是
     * 旧版本下载的话，拼出来的是长度恰好正确的跨版本杂合包，光比长度拦不住。
     */
    private fun downloadApk(
      webView: WebView,
      url: String,
      dest: File,
      remoteLen: Long?,
      meta: File
    ) {
      val resumeFrom = if (dest.exists()) dest.length() else 0L
      val connection = URL(url).openConnection() as HttpURLConnection
      connection.connectTimeout = 15_000
      connection.readTimeout = 60_000
      connection.instanceFollowRedirects = true
      if (resumeFrom > 0) {
        connection.setRequestProperty("Range", "bytes=$resumeFrom-")
      }
      connection.connect()
      val code = connection.responseCode
      if (code == 416 && resumeFrom > 0) {
        // 半包比服务器当前文件还长（服务器上的包换过版本）：Range 起点越界会
        // 一直 416——清掉半包抛错，下一发重试从零下
        connection.disconnect()
        dest.delete()
        meta.delete()
        throw IOException("续传起点越界（服务器安装包已更换），已清半包重下")
      }
      if (code !in 200..299) {
        throw IOException("HTTP $code")
      }
      val resuming = code == 206 && resumeFrom > 0
      if (!resuming) {
        // 服务器不支持续传（200 重下）或上一轮无半包：清掉旧内容从零写
        if (dest.exists()) dest.delete()
      }
      val base = if (resuming) resumeFrom else 0L
      val total = if (resuming) base + connection.contentLengthLong else connection.contentLengthLong
      // 半包归属校验：meta 记着它初次下载时的服务器总长，与服务器当前包（或本次
      // 响应推得的总长）对不上 = 跨版本残包，清掉重来
      if (resuming) {
        val metaTotal = meta.takeIf { it.isFile }?.readText()?.trim()?.toLongOrNull()
        if (metaTotal == null || (remoteLen != null && metaTotal != remoteLen) ||
            (total > 0 && metaTotal != total)
        ) {
          connection.disconnect()
          dest.delete()
          meta.delete()
          throw IOException("半包与服务器安装包不一致，已清半包重下")
        }
      }
      if (total > 0) {
        try { meta.writeText(total.toString()) } catch (_: Exception) {}
      }
      connection.inputStream.use { input ->
        java.io.FileOutputStream(dest, resuming).use { output ->
          val buffer = ByteArray(64 * 1024)
          var done = 0L
          var lastPct = -2
          var lastSent = 0L
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            done += read
            val now = System.currentTimeMillis()
            if (total > 0 && now - lastSent >= 300) {
              lastSent = now
              val pct = (((base + done) * 100) / total).toInt().coerceIn(0, 99)
              if (pct != lastPct) {
                lastPct = pct
                mainHandler.post {
                  webView.evaluateJavascript(
                    "window.__qnUpdateProgress && window.__qnUpdateProgress($pct)",
                    null
                  )
                }
              }
            }
          }
        }
      }
      // 0.39.4 用户反馈「安装时解析包出现问题」：连接被掐时 read 会"干净地"
      // 返回 -1，循环正常退出、文件比服务器短——旧代码到这就当成功拉安装器，
      // 残包必然解析错误（且 IOException 重试根本不触发）。收尾必须校验总长
      // 一致 + ZIP 结构；不一致当失败上抛，让外层重试（下一发带 Range 续传）。
      val expected = if (total > 0) total else -1L
      if (expected > 0 && dest.length() != expected) {
        throw IOException("下载不完整（已收 ${dest.length()} / 共 $expected 字节）")
      }
      if (!looksLikeApk(dest)) {
        throw IOException("下载内容不是有效的安装包")
      }
    }
  }

  private fun notifyUpdateDone(webView: WebView, ok: Boolean, message: String) {
    mainHandler.post {
      val msg = message.replace("\\", "\\\\").replace("\"", "\\\"")
      webView.evaluateJavascript("window.__qnUpdateDone && window.__qnUpdateDone($ok, \"$msg\")", null)
    }
  }

  /** 相册选壁纸结果回 JS（ok=false 且 message 为空 = 用户取消，前端静默）。 */
  private fun notifyBgPick(webView: WebView, ok: Boolean, message: String) {
    mainHandler.post {
      val msg = message.replace("\\", "\\\\").replace("\"", "\\\"")
      webView.evaluateJavascript("window.__qnBgPickDone && window.__qnBgPickDone($ok, \"$msg\")", null)
    }
  }
}

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
      // 就是键盘顶缘，内容不再需要让出导航栏高度）
      insetJson = "{\"top\":${bars.top},\"bottom\":${if (ime.bottom > 0) 0 else bars.bottom}}"
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
     * 之后原生在 insets 变化（旋转/键盘）时经 window.__qnApplyInsets 推送。
     * 返回 JSON：{"top":px,"bottom":px}（bottom 已含键盘归零逻辑，见监听器）。
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
      try {
        val dir = File(filesDir, "update").apply { mkdirs() }
        // 清旧包：只保留本次下载
        dir.listFiles()?.forEach { it.delete() }
        val dest = File(dir, "quick-note-update.apk")
        var lastError: IOException? = null
        var attempts = 0
        while (attempts < 3) {
          attempts += 1
          try {
            downloadApk(webView, url, dest)
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
            "下载失败（已重试 $attempts 次）：${err.message}。网络不稳可再试，或到发布页直接下载 APK"
          )
          return
        }
        if (!dest.exists() || dest.length() == 0L) {
          notifyUpdateDone(webView, false, "下载失败：文件为空")
          return
        }
        mainHandler.post {
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
      } finally {
        downloading.set(false)
      }
    }

    /** 下载互斥闸：同一时刻只允许一路下载（0.34.2 用户反馈「可能会下载多次」）。 */
    private val downloading = java.util.concurrent.atomic.AtomicBoolean(false)

    /** 下载 APK 本体；进度经 __qnUpdateProgress(pct) 回前端（300ms 节流）。 */
    private fun downloadApk(webView: WebView, url: String, dest: File) {
      val connection = URL(url).openConnection() as HttpURLConnection
      connection.connectTimeout = 15_000
      connection.readTimeout = 60_000
      connection.instanceFollowRedirects = true
      connection.connect()
      val code = connection.responseCode
      if (code !in 200..299) {
        throw IOException("HTTP $code")
      }
      val total = connection.contentLengthLong
      connection.inputStream.use { input ->
        dest.outputStream().use { output ->
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
              val pct = ((done * 100) / total).toInt().coerceIn(0, 99)
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

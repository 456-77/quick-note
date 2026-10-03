package com.quicknote.app

import android.content.Intent
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
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : TauriActivity() {
  /** 待派发的分享文本（冷启动时 WebView 尚未就绪，先存 here）。 */
  private var pendingShareText: String? = null
  private var webViewRef: WebView? = null
  private val mainHandler = Handler(Looper.getMainLooper())

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
    if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
      val text = intent.getStringExtra(Intent.EXTRA_TEXT)
      if (!text.isNullOrBlank()) pendingShareText = text
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
      // 键盘（ime）不参与：viewport 的 interactive-widget=resizes-content
      // 已经处理键盘避让，加进去会双重收缩。只取系统栏与挖孔。
      val bars: Insets = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val lp = webView.layoutParams
      if (lp is ViewGroup.MarginLayoutParams) {
        lp.setMargins(bars.left, bars.top, bars.right, bars.bottom)
        webView.layoutParams = lp
      }
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
    /** 是否已拥有「安装未知应用」授权（没有则 JS 先引导用户去开）。 */
    @JavascriptInterface
    fun canRequestInstall(): Boolean {
      return packageManager.canRequestPackageInstalls()
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
     * 回报前端。网络 IO 在桥线程；intent 必须回 UI 线程。
     */
    @JavascriptInterface
    fun installUpdate(url: String) {
      val webView = webViewRef ?: return
      try {
        val dir = File(filesDir, "update").apply { mkdirs() }
        // 清旧包：只保留本次下载
        dir.listFiles()?.forEach { it.delete() }
        val dest = File(dir, "quick-note-update.apk")
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.instanceFollowRedirects = true
        connection.connect()
        val code = connection.responseCode
        if (code !in 200..299) {
          notifyUpdateDone(webView, false, "下载失败：HTTP $code")
          return
        }
        connection.inputStream.use { input ->
          dest.outputStream().use { output ->
            input.copyTo(output, bufferSize = 64 * 1024)
          }
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
      } catch (e: IOException) {
        notifyUpdateDone(webView, false, "下载失败：${e.message}")
      }
    }
  }

  private fun notifyUpdateDone(webView: WebView, ok: Boolean, message: String) {
    mainHandler.post {
      val msg = message.replace("\\", "\\\\").replace("\"", "\\\"")
      webView.evaluateJavascript("window.__qnUpdateDone && window.__qnUpdateDone($ok, \"$msg\")", null)
    }
  }
}

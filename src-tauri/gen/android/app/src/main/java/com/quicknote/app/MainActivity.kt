package com.quicknote.app

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

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

    // 分享派发：WebView 就绪 ≠ 前端已注册接收器（React 挂载要几秒），
    // 轮询直到 __qnShareReceive 存在（300ms × 50 次 = 15s 上限），派发后清 pending。
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
}

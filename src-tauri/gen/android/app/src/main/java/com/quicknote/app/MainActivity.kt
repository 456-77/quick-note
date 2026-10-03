package com.quicknote.app

import android.os.Bundle
import android.util.TypedValue
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // edge-to-edge 下系统栏透明，透出的是 window 背景——不给的话是白色，
    // 与应用的深色主题割裂（系统栏区域一条白）。跟随当前主题的窗口背景。
    val bg = TypedValue()
    theme.resolveAttribute(android.R.attr.windowBackground, bg, true)
    if (bg.resourceId != 0) {
      window.decorView.setBackgroundResource(bg.resourceId)
    }
  }

  /**
   * 把系统栏 insets 转成 WebView 的 padding：应用内容从状态栏下方开始、到手势条
   * 上方结束，不再与系统状态栏重叠。不用 CSS env(safe-area-inset-*)——Android
   * WebView 里它们经常恒为 0，原生 insets 才是可靠通道。
   *
   * onWebViewCreate 晚于 super.onCreate 的视图创建，在这里拿 WebView 挂监听。
   */
  override fun onWebViewCreate(webView: WebView) {
    // 挂在 decorView 根上（dispatch 链源头必经）：挂 WebView 本身实测收不到
    // insets（中间某层已消费/拦截）。用 **margin** 而不是 padding——
    // WebView 忽略自身 padding（网页内容不收缩），margin 才真正把视图挪出系统栏。
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

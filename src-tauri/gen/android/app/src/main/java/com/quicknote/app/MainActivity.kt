package com.quicknote.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * 返回键语义：前端先消费（设置/命令面板/速记/仓库页/抽屉，谁开着关谁）；
   * 没有可消费的才放行给 wry 的默认处理（webview 历史后退，历史尽头退出应用）。
   *
   * 用 OnBackPressedCallback 而不是覆写 onBackPressed：wry 在 setWebView 时也注册
   * 了同款 callback（canGoBack→goBack，否则 finish），dispatcher 后注册者优先——
   * onWebViewCreate 晚于 setWebView 的注册，我们的 callback 会先被问到；
   * 覆写 onBackPressed 则永远不会被调到（wry 以限定 this 调用它自己的实现）。
   */
  override fun onWebViewCreate(webView: WebView) {
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

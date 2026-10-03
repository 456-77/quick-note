/**
 * 平台探测：桌面与移动端的能力差异收敛到这一个模块。
 *
 * UI 代码禁止散落 userAgent 判断——要加新的能力开关，在这里加语义化导出。
 * 检测用 UA 同步判定：Tauri 的 Android WebView UA 含 "Android"（及 "wv"），
 * 桌面 WebView2 / WKWebView 不含；比 `platform()`（异步）适合启动即分支的场景。
 */
export function isMobile(): boolean {
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** 悬停交互是否存在（移动端触摸屏没有 hover，⋯菜单/工具栏要走长按或常驻按钮）。 */
export function hasHover(): boolean {
  return window.matchMedia("(hover: hover)").matches;
}

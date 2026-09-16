/**
 * 用户自定义样式（针对 Markdown 渲染效果）。
 *
 * 存 localStorage（本机偏好，不进仓库——放进仓库会被同步出去，写坏一份 CSS
 * 等于让所有设备的界面一起坏）。注入方式是往 document 里放一个固定 id 的
 * `<style>`，排在应用样式之后，因此同特异性下用户规则赢。
 *
 * 常用选择器（写进设置面板的提示里）：
 *   .cm-content            正文文本
 *   .cm-lp-heading         标题行（.cm-lp-h1 ~ h6 区分级别的容器）
 *   .cm-lp-table           渲染后的表格
 *   .cm-lp-callout-note    callout 容器（-tip/-warning/-danger 等同类）
 *   .cm-lp-mermaid         mermaid 图容器
 */

const STORAGE_KEY = "quicknote.customCss";
const STYLE_ID = "qn-custom-css";

export function getCustomCss(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCustomCss(css: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, css);
  } catch {
    /* 存储不可用（隐私模式等）：本次会话内样式仍然生效 */
  }
}

/** 把自定义 CSS 注入/更新到页面。幂等：重复调用只更新内容。 */
export function applyCustomCss(css: string): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

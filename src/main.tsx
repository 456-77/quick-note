import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getSettings } from "./lib/settings";
import { applyTheme } from "./lib/theme";
import { PRINT_CSS } from "./lib/printStyles";

// 渲染前先定主题，否则深色模式用户会看到一瞬白底闪烁
applyTheme(getSettings().theme);

// 打印样式（PDF 导出）：此前在 styles.css 里，现单独维护并在此注入
//（「导出 PDF 文件」时同一份样式内联进导出 HTML，两处永不漂移）
const printStyle = document.createElement("style");
printStyle.id = "qn-print-style";
printStyle.textContent = PRINT_CSS;
document.head.appendChild(printStyle);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

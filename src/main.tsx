import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getSettings } from "./lib/settings";
import { applyTheme } from "./lib/theme";

// 渲染前先定主题，否则深色模式用户会看到一瞬白底闪烁
applyTheme(getSettings().theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

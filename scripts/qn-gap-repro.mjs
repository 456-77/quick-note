// 临时复现脚本：设置页二级头与状态栏之间的缝隙——模拟 env(safe-area-inset-top)=40px
// （桌面 WebView env 恒 0，注入 padding-top 模拟真机几何）+ 模拟壁纸，对比
// 当前 sticky top:0 与旧行为 top:40px 滚动后的表现。复用 m-preview 的启动模式。
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9496";
const root = process.cwd();
const exe = join(root, "src-tauri", "target", "release", "quick-note.exe");

const work = join(tmpdir(), `qn-gap-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "gap-vault").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });
writeFileSync(join(vault, "笔记一.md"), "# 笔记一\n\n正文。\n", "utf8");
// 竖版长内容，保证详情页能滚起来
const rows = Array.from({ length: 40 }, (_, i) => `| 参数${i} | 数值${i} |`).join("\n");
writeFileSync(join(vault, "设置垫.md"), `# 长\n\n${rows}\n`, "utf8");

spawn(exe, [vault], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: udf,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: "ignore",
});

const configDir = join(process.env.APPDATA ?? "", "com.quicknote.gui-test");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "vault-home.txt"), work.replace(/\\/g, "/"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;
const cdp = (ws, method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (ws, expression) => {
  const r = await cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`页面内异常: ${r.exceptionDetails.exception?.description ?? ""}`);
  return r.result.value;
};
const screenshot = async (ws, file) => {
  const r = await cdp(ws, "Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  📷 ${file}`);
};

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36";

let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) {
  await sleep(1000);
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    ready = list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  } catch {}
}
if (!ready) throw new Error("应用页面没有就绪");
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
});
await cdp(ws, "Page.bringToFront");
await cdp(ws, "Network.setUserAgentOverride", { userAgent: ANDROID_UA });
await cdp(ws, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2.75, mobile: true });
await cdp(ws, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await evaluate(ws, `localStorage.setItem('quicknote.settings', JSON.stringify({ theme: 'dark' }))`);
await cdp(ws, "Page.reload");
await sleep(2500);

// 进设置-外观详情
await evaluate(ws, `document.querySelector('.topbar .icon-btn')?.blur(); true`);
await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true }))`);
await sleep(600);
const opened = await evaluate(ws, `!!document.querySelector('.settings-panel')`);
if (!opened) throw new Error("设置面板没打开（Ctrl+,）");
await evaluate(
  ws,
  `(() => { const n = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('外观')); n?.click(); return !!n; })()`,
);
await sleep(600);

// 模拟真机 env(safe-area-inset-top)=40px + 模拟壁纸（鲜艳渐变，代替 #qn-bg-layer 的真实图）。
// 新架构：状态栏条由二级头自己的 padding 承担（面板不再留 env 顶距）
await evaluate(ws, `(() => {
  const st = document.createElement('style');
  st.id = 'gap-repro';
  st.textContent = \`
    .settings-mobile-head { padding-top: 40px !important; height: calc(56px + 40px) !important; }
    #qn-bg-layer { display: block !important; background: linear-gradient(180deg, #ff8a3d 0%, #e74bd8 30%, #3d6bff 60%, #101322 100%) !important; }
  \`;
  document.head.appendChild(st);
  return true;
})()`);
await sleep(300);

// 状态 A：当前构建（头部从屏幕顶盖下来），滚到中部
await evaluate(ws, `document.querySelector('.settings-body').scrollTop = 260; true`);
await sleep(400);
await screenshot(ws, join(work, "A-current-top0-scrolled.png"));

// 状态 B：旧行为复刻（面板 env 顶距 + 头部 sticky top 叠 env + body padding 阻挡）
await evaluate(ws, `(() => {
  document.querySelector('#gap-repro').textContent += ' .settings-panel { padding-top: 40px !important; } .settings-mobile-head { top: 40px !important; padding-top: 0 !important; height: 56px !important; } .settings-panel.is-detail .settings-body { padding-top: 12px !important; }';
  return true;
})()`);
await sleep(400);
await screenshot(ws, join(work, "B-old-top40-scrolled.png"));

console.log("完成。目录：" + work);
process.exit(0);

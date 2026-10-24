// QNTest 虚拟机真机验证：adb forward webview CDP → 设置页头部几何实测。
// 只读操作（打开设置/滚动/截图），不改任何设置。用法：先
//   adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
// 再 node scripts/qn-vm-verify.mjs 9223 <输出目录>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9223";
const outDir = process.argv[3] ?? join(tmpdir(), `qn-vm-verify-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

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

let ready = false;
for (let i = 0; i < 30 && !ready; i += 1) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    ready = list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  } catch {}
  if (!ready) await sleep(1000);
}
if (!ready) throw new Error("webview CDP 没就绪——检查 adb forward");
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
});

await sleep(1500);
// 虚拟机真实的安全区高度
const envTop = await evaluate(ws, `(() => {
  const d = document.createElement('div');
  d.style.height = 'env(safe-area-inset-top, 0px)';
  document.body.appendChild(d);
  const h = d.getBoundingClientRect().height;
  d.remove();
  return Math.round(h);
})()`);
console.log(`  虚拟机 env(safe-area-inset-top) = ${envTop}px`);
const vw = await evaluate(ws, `innerWidth + 'x' + innerHeight`);
console.log(`  视口 = ${vw}`);

// 若仓库页 gate 挡着，点第一个本地仓库卡进入
const inGate = await evaluate(ws, `!!document.querySelector('.mv-card')`);
if (inGate) {
  await evaluate(ws, `document.querySelector('.mv-card')?.click(); true`);
  await sleep(3000);
  console.log("  已从仓库页进入：" + (await evaluate(ws, `!!document.querySelector('.cm-editor')`)));
}

// 打开设置（Ctrl+,）→ 外观详情
await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true }))`);
await sleep(1200);
const opened = await evaluate(ws, `!!document.querySelector('.settings-panel')`);
if (!opened) throw new Error("设置面板没打开");
await evaluate(
  ws,
  `(() => { const n = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('外观')); n?.click(); return !!n; })()`,
);
await sleep(1200);

const detail = await evaluate(ws, `(() => {
  const head = document.querySelector('.settings-mobile-head');
  const panel = document.querySelector('.settings-panel');
  return {
    headTop: head ? Math.round(head.getBoundingClientRect().top) : -1,
    headH: head ? Math.round(head.getBoundingClientRect().height) : -1,
    headPadTop: head ? getComputedStyle(head).paddingTop : "",
    panelPadTop: panel ? getComputedStyle(panel).paddingTop : "",
  };
})()`);
console.log(`  详情页头部：top=${detail.headTop} 高=${detail.headH} paddingTop=${detail.headPadTop} 面板paddingTop=${detail.panelPadTop}`);

// 滚到中部再量
const stick = await evaluate(ws, `(() => {
  const body = document.querySelector('.settings-body');
  body.scrollTop = 400;
  return new Promise((res) => requestAnimationFrame(() => {
    const t = document.querySelector('.settings-mobile-head').getBoundingClientRect().top;
    res(Math.round(t));
  }));
})()`);
console.log(`  滚动后头部 top = ${stick}px（期望 0）`);
await sleep(300);
await screenshot(ws, join(outDir, "vm-detail-scrolled.png"));

// 返回一级页，量 ‹ 与标题
await evaluate(ws, `document.querySelector('.settings-body').scrollTop = 0; true`);
await evaluate(ws, `document.querySelector('.settings-back')?.click(); true`);
await sleep(1000);
const listHead = await evaluate(ws, `(() => {
  const close = document.querySelector('.settings-nav-head .settings-close')?.getBoundingClientRect();
  const title = document.querySelector('.settings-nav-title')?.getBoundingClientRect();
  return {
    adjacentGap: close && title ? Math.round(title.left - close.right) : -1,
    titleLeft: title ? Math.round(title.left) : -1,
    titleRight: title ? Math.round(title.right) : -1,
    vw: innerWidth,
  };
})()`);
console.log(`  一级头：‹→标题间距 ${listHead.adjacentGap}px，标题 ${listHead.titleLeft}~${listHead.titleRight} / 视口宽 ${listHead.vw}`);
await screenshot(ws, join(outDir, "vm-first-level.png"));
console.log("完成：" + outDir);
process.exit(0);

// A1 移动端仓库模型冒烟：基础目录 → 仓库发现 → 打开 → 写盘到共享存储。
//
// 与 gui-android-smoke.mjs 的差别：仓库在 /sdcard 共享存储（基础目录模型），
// 磁盘断言直接 `adb shell cat`（不再需要 run-as）。
//
// SAF 选择器本身是系统 UI 无法自动化，但设置基础目录走的是**真实 Rust 命令**
// （页面内 __TAURI_INTERNALS__.invoke），换算/建目录/可写探测全部真实执行；
// SAF URI→真实路径的解析已有 Rust 单测覆盖。
//
// 用法：node scripts/gui-android-vaulthome.mjs

import { execFileSync } from "node:child_process";

const ENDPOINT = "http://127.0.0.1:9222/json/list";
const HOME_URI =
  "content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FQuickNote/document/primary%3ADocuments%2FQuickNote";
const HOME_REAL = "/storage/emulated/0/Documents/QuickNote";
const SEEDED_VAULT = `${HOME_REAL}/我的笔记`;
const PROBE_TEXT = "\n\nA1 探针：仓库模型落盘。`代码` 与 **加粗** 原样。";

let nextId = 1;

function cdp(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面内异常: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`);
  }
  return result.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(cmd) {
  return execFileSync("adb", ["shell", cmd], { encoding: "utf8" }).replace(/\r/g, "");
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function connect() {
  const list = await (await fetch(ENDPOINT)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有页面目标");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  return ws;
}

const ws = await connect();

// 1. 未设基础目录 → 引导页
for (let i = 0; i < 20 && !(await evaluate(ws, "!!document.querySelector('.mv-gate')")); i++) await sleep(500);
const onboarding = await evaluate(ws, `document.querySelector('.mv-gate')?.innerText ?? ""`);
if (!onboarding.includes("基础目录")) fail(`引导页没有出现：${onboarding.slice(0, 80)}`);
console.log("✓ 引导页出现（基础目录未设置）");

// 2. 走真实 Rust 命令设置基础目录（SAF URI → 真实路径 → 建目录 → 可写探测）
const home = await evaluate(
  ws,
  `window.__TAURI_INTERNALS__.invoke("vault_home_set_from_uri", { uri: ${JSON.stringify(HOME_URI)} })`,
);
if (home !== HOME_REAL) fail(`基础目录换算错误: ${home}`);
console.log(`✓ 基础目录已设置（SAF URI → ${home}，可写探测通过）`);

// 3. 引导页仍挂着旧状态：整页重载走新 bootstrap（home 已设 → 上次仓库不在 home 下 → 列表）
await cdp(ws, "Page.enable");
await cdp(ws, "Page.reload");
await sleep(4000);
for (let i = 0; i < 20 && !(await evaluate(ws, `!!document.querySelector('.mv-list')`)); i++) await sleep(500);
const cards = await evaluate(
  ws,
  `[...document.querySelectorAll('.mv-card .mv-card-name')].map((el) => el.textContent.trim())`,
);
if (!cards.some((n) => n.includes("我的笔记"))) fail(`仓库列表没有发现预置仓库: ${JSON.stringify(cards)}`);
console.log(`✓ 仓库列表发现预置仓库: ${JSON.stringify(cards)}`);

// 4. 点卡片打开仓库
await evaluate(
  ws,
  `[...document.querySelectorAll('.mv-card')].find((c) => c.textContent.includes("我的笔记")).click()`,
);
let vault = null;
for (let i = 0; i < 16; i++) {
  vault = await evaluate(ws, `localStorage.getItem('quicknote.vault')`);
  if (vault === SEEDED_VAULT) break;
  await sleep(500);
}
if (vault !== SEEDED_VAULT) fail(`仓库没有打开: ${vault}`);
console.log(`✓ 仓库已打开: ${vault}`);

// 5. 通过快速操作新建笔记并写入探针（编辑器 → 自动保存 → 共享存储）
await evaluate(ws, `[...document.querySelectorAll('button')].find((b) => (b.title || '').includes("新建笔记"))?.click()`);
await sleep(800);
const named = await evaluate(ws, `(() => {
  const input = document.querySelector('.create-row input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'a1探针');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`);
if (!named) fail("新建笔记的内联输入框没有出现");
let opened = false;
for (let i = 0; i < 20; i++) {
  opened = await evaluate(ws, `window.__qnView && window.__qnView.state.doc.toString().includes("a1探针")`);
  if (opened) break;
  await sleep(500);
}
if (!opened) fail("新建笔记没有打开");
await evaluate(ws, `(() => {
  const view = window.__qnView;
  view.dispatch({ changes: { from: view.state.doc.length, insert: ${JSON.stringify(PROBE_TEXT)} } });
})()`);

// 6. 自动保存 → 直接 cat /sdcard（共享存储，无需 run-as）
let disk = "";
for (let i = 0; i < 20; i++) {
  await sleep(500);
  disk = adb(`cat '${SEEDED_VAULT}/a1探针.md'`);
  if (disk.includes("A1 探针")) break;
}
if (!disk.includes("A1 探针")) fail("探针内容没有落盘到共享存储");
if (!disk.includes("**加粗**")) fail("行内语法被改写");
console.log("✓ 探针落盘共享存储，行内语法原样（字节精确往返）");

console.log("VAULTHOME_OK");
ws.close();

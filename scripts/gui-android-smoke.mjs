// Android 端 A0 冒烟测试：通过 CDP 驱动模拟器上真实运行的应用。
//
// 与桌面 gui-*.mjs 的差别：
//   - CDP 经 adb 转发进来（`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`），
//     应用重启后 pid 变化，需要重新 forward（由调用方的 bash 负责）；
//   - 磁盘断言走 `adb shell run-as com.quicknote.app`（debug 包可 run-as），
//     桌面版是直接读文件系统；
//   - 新建笔记用「＋日记」单按钮路径（移动端没有快捷键，名字输入框也省了）。
//
// 用法：
//   node scripts/gui-android-smoke.mjs create   # 阶段一：建日记 + 写中文 + 等自动保存 + 验磁盘
//   node scripts/gui-android-smoke.mjs verify   # 阶段二（重启后）：内容还在
//
// 前置：模拟器运行中、应用已启动、`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` 已建。

import { execFileSync } from "node:child_process";

const phase = process.argv[2] ?? "create";
const ENDPOINT = "http://127.0.0.1:9222/json/list";
const PROBE_TEXT = "你好，Android A0 冒烟。Mixed 中英与符号：**加粗**、`代码`。";
const NOTE_PREFIX = "日记/";

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

async function connect() {
  const list = await (await fetch(ENDPOINT)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error(`没有页面目标: ${JSON.stringify(list.map((t) => t.type))}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  return ws;
}

function adb(cmd) {
  // execFileSync 整条远程命令作为单个参数传给 adb——文件名里的空格不会被
  // Windows shell / adb 两层拆参打散（execSync + 双引号会丢引号）
  return execFileSync("adb", ["shell", cmd], { encoding: "utf8" }).replace(/\r/g, "");
}

/** run-as 读私有 vault 里的全部笔记路径（应用数据根目录下的 vault/）。 */
function vaultFiles() {
  const out = adb(`run-as com.quicknote.app find vault -type f -name "*.md"`);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------ 阶段一

async function create(ws) {
  // 仓库必须是移动端沙箱私有目录（app_local_data_dir 在 Android = /data/user/0/<id>），
  // 而不是桌面上一次记住的 Windows 路径
  const vault = await evaluate(ws, "localStorage.getItem('quicknote.vault')");
  if (!vault || !/^\/data\/(user|data)\/0\/com\.quicknote\.app\/vault$/.test(vault)) {
    fail(`仓库路径不是移动端私有目录: ${vault}`);
  }
  console.log(`✓ vault = ${vault}`);

  // 等 __qnView 调试句柄（编辑器装配完成）
  for (let i = 0; i < 20 && !(await evaluate(ws, "!!window.__qnView")); i++) await sleep(500);
  if (!(await evaluate(ws, "!!window.__qnView"))) fail("window.__qnView 不存在（编辑器未装配）");

  // 点「＋日记」→ 文件树出现内联命名输入框（React 受控）→ 填名字回车
  const clicked = await evaluate(ws, `(() => {
    const buttons = [...document.querySelectorAll('button')];
    const daily = buttons.find((b) => (b.title || '').includes('新建今天的日记'));
    if (!daily) return false;
    daily.click();
    return true;
  })()`);
  if (!clicked) {
    const titles = await evaluate(ws, `[...document.querySelectorAll('button')].map((b) => b.title || b.textContent.trim()).filter(Boolean).slice(0, 30).join(' | ')`);
    fail(`找不到「＋日记」按钮。现有按钮: ${titles}`);
  }
  const named = await evaluate(ws, `(() => {
    const input = document.querySelector('.create-row input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '冒烟测试');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  if (!named) fail("内联命名输入框没有出现（beginCreate 未生效）");

  // 等日记真正创建并打开：编辑器文档出现今天的标题。右栏「日历/目录/统计」
  // 页签的类名也含 tab，不能拿来当打开判据（这是 A0 验证踩过的坑）
  const today = new Date().toISOString().slice(0, 10);
  let opened = false;
  for (let i = 0; i < 20; i++) {
    opened = await evaluate(ws, `window.__qnView && window.__qnView.state.doc.toString().includes(${JSON.stringify("# " + today)})`);
    if (opened) break;
    await sleep(500);
  }
  if (!opened) fail("＋日记后编辑器没有打开（创建失败或未自动打开）");

  // 写入中文 + 行内语法（模拟 IME 提交的字节级落点：直接进 CM6 事务，追加到文末）
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    view.dispatch({ changes: { from: view.state.doc.length, insert: ${JSON.stringify(PROBE_TEXT)} } });
  })()`);

  // 自动保存 1.2s 防抖 + 落盘，轮询磁盘
  let disk = "";
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const files = vaultFiles();
    if (files.length === 0) continue;
    disk = adb(`run-as com.quicknote.app cat '${files[0]}'`);
    if (disk.includes("Android A0 冒烟")) break;
  }
  if (!disk.includes("Android A0 冒烟")) fail(`磁盘上没有探针内容。vault 文件: ${vaultFiles().join(", ") || "无"}`);
  if (!disk.includes("**加粗**")) fail("行内语法被改写（字节精确往返被破坏）");
  console.log(`✓ 自动保存落盘成功（含中文与行内语法原文）`);
  console.log("CREATE_OK");
}

// ------------------------------------------------------------------ 阶段二

async function verify(ws) {
  for (let i = 0; i < 20 && !(await evaluate(ws, "!!window.__qnView")); i++) await sleep(500);
  const files = vaultFiles();
  if (files.length === 0) fail("重启后 vault 是空的");
  const disk = adb(`run-as com.quicknote.app cat '${files[0]}'`);
  if (!disk.includes("Android A0 冒烟")) fail("重启后磁盘内容丢了");

  // 界面重新打开同一篇并断言内容一致（冷启动恢复路径）
  const reopened = await evaluate(ws, `(() => {
    const view = window.__qnView;
    return view ? view.state.doc.toString().includes("Android A0 冒烟") : null;
  })()`);
  if (reopened !== true) {
    // A0 没做「启动恢复上次标签」，内容在磁盘、界面可能空着——这不算失败，提示人工确认
    console.log(`△ 编辑器未自动重开上一篇（A0 未实现恢复，属预期）；磁盘内容完整`);
  } else {
    console.log(`✓ 重启后编辑器内容完整`);
  }
  console.log("VERIFY_OK");
}

const ws = await connect();
try {
  if (phase === "create") await create(ws);
  else if (phase === "verify") await verify(ws);
  else fail(`未知阶段: ${phase}`);
} finally {
  ws.close();
}

// 0.32.2 批次验收：本轮 3 条反馈的自测脚本（发版前在用户手工测试后并入全量）。
// 前置：gui-test 变体 exe 已构建。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 +
// 临时仓库），结束时自清理。
//
// 覆盖：
// - 窗口关闭（0.32.2 修复「无法关闭软件」）：点 ✕ → destroy 直达，进程必须退出
// - 收录建表语句新默认键 Ctrl+Alt+J（旧默认 Ctrl+Alt+L 常被 QQ「锁定」等全局占用）
// - Obsidian 分栏细节：右栏标签可切多标签、右栏标签 ✕ 单独关、左栏守卫提示

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9443";
const root = process.cwd();
const exe = join(root, "src-tauri", "target", "release", "quick-note.exe");
if (!existsSync(exe)) {
  console.error(`找不到 ${exe}——先跑 verify-gui.sh 的构建步骤（gui-test 变体）`);
  process.exit(2);
}

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
  const r = await Promise.race([
    cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate 超时（10s）")), 10000)),
  ]);
  if (r.exceptionDetails) {
    throw new Error(`页面内异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
  }
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

const waitFor = async (ws, expression, timeoutMs, pollMs = 400) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};

const key = (ws, combo, code, keyCode) =>
  cdp(ws, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: combo.mod,
    key: combo.key,
    code,
    windowsVirtualKeyCode: keyCode,
  }).then(() =>
    cdp(ws, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: combo.mod,
      key: combo.key,
      code,
      windowsVirtualKeyCode: keyCode,
    }),
  );
const CTRL_ALT = 3;

// ------------------------------------------------ 自备数据：临时仓库

const work = join(tmpdir(), `qn-033-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "关闭库").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

for (const name of ["qn33甲.md", "qn33乙.md", "qn33丙.md"]) {
  writeFileSync(join(vault, name), [`# ${name.replace(".md", "")}`, "", `${name} 的内容。`].join("\n"), "utf8");
}

const spawnInstance = () =>
  spawn(exe, [vault], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: udf,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
    detached: false,
  });

const connectPage = async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  if (!page) throw new Error("没有找到 page 目标");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  return ws;
};

const bootAndConnect = async () => {
  const child = spawnInstance();
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      ready = list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    } catch {}
  }
  if (!ready) throw new Error("应用页面没有就绪");
  const ws = await connectPage();
  const treeOk = await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 30000);
  if (!treeOk) throw new Error("文件树没有就绪（仓库未打开？）");
  return { child, ws };
};

const openFromTree = async (ws, name) => {
  await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)})); t?.click(); return !!t; })()`);
};

let child = null;
let ws = null;
let exited = false;

try {
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });

  ({ child, ws } = await bootAndConnect());
  child.on("exit", () => {
    exited = true;
  });

  // ============================================== 1. 分栏细节（右栏多标签/单标签关闭/左栏守卫）
  {
    // newTab 模式打开三篇（reload 生效）
    await evaluate(ws, `(() => { const k='quicknote.settings'; const s=JSON.parse(localStorage.getItem(k) ?? '{}'); s.openNoteMode='newTab'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
    await evaluate(ws, `location.reload()`);
    await sleep(2500);
    try { ws.close(); } catch {}
    {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("ws 重连失败")), { once: true });
      });
      await cdp(ws, "Page.bringToFront");
      await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 20000);
    }
    for (const name of ["qn33甲", "qn33乙", "qn33丙"]) {
      await openFromTree(ws, name);
      await waitFor(ws, `(window.__qnView?.state.doc.toString() ?? '').includes('${name}')`, 8000);
    }
    // 甲 → 右栏
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tabbar:not(.is-split) [role="tab"]')].find((el) => el.textContent.includes('qn33甲')); t?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 120 })); return !!t; })()`);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏到右侧')); b?.click(); return !!b; })()`);
    const up1 = await waitFor(ws, `!!window.__qnSplitView && (window.__qnSplitView.state.doc.toString() ?? '').includes('qn33甲')`, 8000);
    check(up1, "甲移到右栏（右栏编辑器装上甲）");
    // 乙 → 右栏（右栏多标签）
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tabbar:not(.is-split) [role="tab"]')].find((el) => el.textContent.includes('qn33乙')); t?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 120 })); return !!t; })()`);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏到右侧')); b?.click(); return !!b; })()`);
    const up2 = await waitFor(ws, `(window.__qnSplitView?.state.doc.toString() ?? '').includes('qn33乙')`, 8000);
    check(up2, "乙也移过去（右栏多标签，激活切到乙）");
    const rightBar = await evaluate(ws, `[...document.querySelectorAll('.tabbar.is-split [role="tab"]')].map((el) => el.textContent).join('|')`);
    check(rightBar.includes("qn33甲") && rightBar.includes("qn33乙"), "右栏标签栏列出甲乙两个标签", rightBar);
    // 右栏内点甲标签切回甲
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tabbar.is-split [role="tab"]')].find((el) => el.textContent.includes('qn33甲')); t?.click(); return !!t; })()`);
    const switched = await waitFor(ws, `(window.__qnSplitView?.state.doc.toString() ?? '').includes('qn33甲')`, 8000);
    check(switched, "右栏标签栏内点击切换激活（右栏自己的标签栏可用）");
    // 右栏标签自己的 ✕ 关掉乙（不动甲）
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tabbar.is-split [role="tab"]')].find((el) => el.textContent.includes('qn33乙')); const b = t?.querySelector('.tab-close'); b?.click(); return !!b; })()`);
    await sleep(600);
    const rightAfter = await evaluate(ws, `[...document.querySelectorAll('.tabbar.is-split [role="tab"]')].map((el) => el.textContent).join('|')`);
    check(rightAfter.includes("qn33甲") && !rightAfter.includes("qn33乙"), "右栏单独关掉乙（甲保留，右栏不收起）", rightAfter);
    // 左栏只剩丙：右键「分屏到右侧」置灰（左栏守卫）
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tabbar:not(.is-split) [role="tab"]')].find((el) => el.textContent.includes('qn33丙')); t?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 120 })); return !!t; })()`);
    const guard = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏到右侧')); return b ? { disabled: b.disabled } : null; })()`, 5000);
    check(!!guard && guard.disabled, "左栏只剩丙时「分屏到右侧」置灰（左栏至少留一个）", JSON.stringify(guard));
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    // 还原设置
    await evaluate(ws, `(() => { const k='quicknote.settings'; const s=JSON.parse(localStorage.getItem(k) ?? '{}'); s.openNoteMode='replace'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  }

  // ============================================== 2. DDL 收录弹窗新默认键 Ctrl+Alt+J
  {
    await key(ws, { mod: CTRL_ALT, key: "j" }, "KeyJ", 74);
    let dialogUp = await waitFor(ws, `!!document.querySelector('.ddl-textarea')`, 2500);
    for (let i = 0; i < 3 && !dialogUp; i += 1) {
      await key(ws, { mod: CTRL_ALT, key: "j" }, "KeyJ", 74);
      dialogUp = await waitFor(ws, `!!document.querySelector('.ddl-textarea')`, 2500);
    }
    check(dialogUp, "Ctrl+Alt+J 弹出收录建表语句弹窗（0.32.2 新默认键）");
    // 设置页里该命令的键位描述也换过去了（快捷键面板可改绑）
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);
    const bindingText = await evaluate(ws, `(() => { try { const raw = localStorage.getItem('quicknote.hotkeys.v1'); return raw ? raw.includes('Mod-Alt-J') : '默认绑定（未自定义）'; } catch { return 'n/a'; } })()`);
    check(bindingText === "默认绑定（未自定义）" || bindingText === true, "旧默认 Ctrl+Alt+L 不再占用（无自定义绑定时用新默认）", String(bindingText));
  }

  // ============================================== 3. 窗口关闭：点 ✕ 进程必须退出
  {
    // 点击顶栏 ✕（React onClick → persist + destroy，绕过 close-requested 链）
    await evaluate(ws, `(() => { const b = document.querySelector('.win-close'); if (!b) return false; b.click(); return true; })()`);
    // 进程退出 = 窗口真关了（此前 close() 链路异常会让窗口卡死关不掉）
    let closed = false;
    for (let i = 0; i < 20 && !closed; i += 1) {
      closed = exited || !(await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true).catch(() => false));
      if (!closed) await sleep(500);
    }
    check(closed, "点 ✕ 后窗口关闭、进程退出（0.32.2 修复「无法关闭软件」）");
    try { ws.close(); } catch {}
    child = null;
  }
} catch (error) {
  failures += 1;
  console.error(`批测异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    ws?.close();
  } catch {}
  child?.kill();
  await sleep(800);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

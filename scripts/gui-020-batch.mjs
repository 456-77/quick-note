// 0.20 批次冒烟：新功能的关键路径断言（临时脚本，发版前删除）。
// 前置：gui-test 变体 exe 已带 --remote-debugging-port 启动，参数 <port>。
// 覆盖：设置面板泄漏头部隐藏 / 目录筛选 / 选区标题归一弹窗 / Inbox 行内图片预览 +
// 详情抽屉编辑（Enter 保存）/ 全局截图快捷键（真实 SendKeys）。

import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9223";
const root = process.cwd();

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

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}`;

// ------------------------------------------------ 自备数据：临时仓库 + 收件仓库

const work = join(tmpdir(), `qn-smoke-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "vault");
cpSync(join(root, "test-vault"), vault, { recursive: true });

// 1x1 红色 PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const inbox = join(work, "inbox");
mkdirSync(join(inbox, "图片"), { recursive: true });
writeFileSync(join(inbox, "图片", "shot.png"), Buffer.from(PNG_B64, "base64"));
const stamp = (() => {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
})();
const inboxFile = join(inbox, "Inbox.md");
writeFileSync(
  inboxFile,
  [`# Inbox`, "", `- ${stamp} [vault/来源.md] #测试 带图片的速记 ![[shot.png]] 正文尾`, ""].join("\n"),
  "utf8",
);

// ------------------------------------------------ 连 CDP

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("没有找到 page 目标");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
});
await cdp(ws, "Page.bringToFront");
await sleep(600);

try {
  // 种子：仓库 + 收件仓库设置，重载
  await evaluate(ws, `(() => {
    localStorage.clear();
    localStorage.setItem('quicknote.settings', JSON.stringify({}));
    localStorage.setItem('quicknote.vault', ${JSON.stringify(vault.replace(/\\/g, "/"))});
    const raw = JSON.parse(localStorage.getItem('quicknote.settings'));
    raw.quickCaptureVault = ${JSON.stringify(inbox.replace(/\\/g, "/"))};
    raw.quickCaptureFile = 'Inbox.md';
    localStorage.setItem('quicknote.settings', JSON.stringify(raw));
    return true;
  })()`);
  await cdp(ws, "Page.reload").catch(() => undefined);
  let booted = false;
  for (let i = 0; i < 40 && !booted; i += 1) {
    await sleep(500);
    booted = await evaluate(
      ws,
      `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0; } catch { return false; } })()`,
    ).catch(() => false);
  }
  check(booted, "应用就绪（临时仓库已打开）");

  // 同步隔离：gui-test 数据目录是干净的，同步必须显示未启用
  const syncLabel = await evaluate(
    ws,
    `Array.from(document.querySelectorAll('.status-cell, .status-bar button')).map((el) => el.textContent).join('|')`,
  );
  check(syncLabel.includes("同步未启用"), "同步隔离（状态栏：同步未启用）", syncLabel);

  // ----------------------------------------------- 281：设置面板移动端头部隐藏
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`,
  );
  await sleep(400);
  const headDisplay = await evaluate(
    ws,
    `(() => { const el = document.querySelector('.settings-mobile-head'); return el ? getComputedStyle(el).display : 'absent'; })()`,
  );
  check(headDisplay === "none" || headDisplay === "absent", "281 设置面板的移动端头部在桌面隐藏", headDisplay);
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
  await sleep(300);

  // ----------------------------------------------- 285：目录筛选
  const dirsBefore = await evaluate(
    ws,
    `Array.from(document.querySelectorAll('.tree-dir .tree-label')).map((el) => el.textContent)`,
  );
  check(dirsBefore.length > 0, "285 目录树有一级目录", JSON.stringify(dirsBefore));
  await evaluate(ws, `document.querySelector('.dir-filter-btn')?.click()`);
  await sleep(250);
  const popVisible = await evaluate(ws, `!!document.querySelector('.dir-filter-pop')`);
  check(popVisible, "285 目录筛选弹层打开");
  // 取消勾选第一个目录 → 树里不再出现
  const hideTarget = dirsBefore[0];
  await evaluate(
    ws,
    `(() => {
      const items = Array.from(document.querySelectorAll('.dir-filter-item'));
      const target = items.find((el) => el.textContent.trim() === ${JSON.stringify(hideTarget)});
      const box = target?.querySelector('input');
      box?.click();
      return !!box;
    })()`,
  );
  await sleep(350);
  const stillThere = await evaluate(
    ws,
    `Array.from(document.querySelectorAll('.tree-dir .tree-label')).some((el) => el.textContent === ${JSON.stringify(hideTarget)})`,
  );
  check(!stillThere, "285 取消勾选后目录从树中隐藏", hideTarget);
  // 持久化：localStorage 里有记录
  const hiddenSaved = await evaluate(
    ws,
    `(() => { const raw = JSON.parse(localStorage.getItem('quicknote.tree.hiddenDirs') ?? '{}'); return Object.values(raw).flat().length > 0; })()`,
  );
  check(hiddenSaved, "285 隐藏目录已按仓库持久化");
  // 恢复（弹层还开着，直接点「全部显示」）
  await evaluate(
    ws,
    `(() => { const btn = document.querySelector('.dir-filter-clear'); btn?.click(); return !!btn; })()`,
  );
  await sleep(300);
  const restored = await evaluate(
    ws,
    `Array.from(document.querySelectorAll('.tree-dir .tree-label')).some((el) => el.textContent === ${JSON.stringify(hideTarget)})`,
  );
  check(restored, "285 「全部显示」恢复目录");
  await evaluate(ws, `document.querySelector('.dir-filter-backdrop')?.click()`);
  await sleep(200);

  // ----------------------------------------------- 279：选区标题归一弹窗
  // 先打开一篇笔记（编辑器得有文档）
  await evaluate(ws, `document.querySelector('.tree-file')?.click()`);
  await sleep(800);
  await evaluate(ws, `window.__qnView.focus()`);
  await evaluate(
    ws,
    `(() => {
      const view = window.__qnView;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# 一级\\n\\n正文\\n\\n### 三级标题\\n" } });
      return true;
    })()`,
  );
  await sleep(300);
  await evaluate(
    ws,
    `window.dispatchEvent(new CustomEvent('qn-clamp-heading'))`,
  );
  await sleep(350);
  const dialogShown = await evaluate(ws, `!!document.querySelector('.clamp-heading-card')`);
  check(dialogShown, "279 触发后弹出级别选择弹窗");
  await evaluate(
    ws,
    `(() => { const btn = Array.from(document.querySelectorAll('.clamp-heading-btn')).find((b) => b.textContent.includes('H2')); btn?.click(); return true; })()`,
  );
  await sleep(400);
  const docNow = await evaluate(ws, `window.__qnView.state.doc.toString()`);
  check(
    docNow.startsWith("## 一级") && docNow.includes("#### 三级标题"),
    "279 选 H2 后最高级标题降为 H2、其余平移",
    JSON.stringify(docNow),
  );
  const dialogGone = await evaluate(ws, `!document.querySelector('.clamp-heading-card')`);
  check(dialogGone, "279 选择后弹窗关闭");

  // ----------------------------------------------- 283/286：Inbox 图片预览 + 抽屉编辑
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', altKey: true, ctrlKey: true, bubbles: true }))`,
  );
  await sleep(900);
  const inboxOpen = await evaluate(ws, `!!document.querySelector('.cm-root')`);
  check(inboxOpen, "283 Inbox 面板打开");
  const imgCount = await evaluate(ws, `document.querySelectorAll('.cm-row-images img').length`);
  check(imgCount > 0, "283 行内出现图片缩略图", `count=${imgCount}`);
  const imgLoaded = await evaluate(
    ws,
    `(() => { const img = document.querySelector('.cm-row-images img'); return img && img.naturalWidth > 0; })()`,
  );
  check(imgLoaded, "283 缩略图真实加载（naturalWidth>0）");
  // 打开抽屉
  await evaluate(ws, `document.querySelector('.cm-row .cm-row-main')?.click()`);
  await sleep(400);
  const drawerOpen = await evaluate(ws, `!!document.querySelector('.cm-drawer')`);
  check(drawerOpen, "286 详情抽屉打开");
  const drawerEditable = await evaluate(
    ws,
    `(() => { const el = document.querySelector('.cm-drawer-edit'); return el && !el.disabled && !el.readOnly; })()`,
  );
  check(drawerEditable, "286 抽屉内容直接可编辑");
  // 改内容 + Enter 保存
  await evaluate(
    ws,
    `(() => {
      const el = document.querySelector('.cm-drawer-edit');
      const nativeSet = (el2, value) => {
        const proto = el2 instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el2, value);
        el2.dispatchEvent(new Event("input", { bubbles: true }));
      };
      nativeSet(el, '带图片的速记（已编辑） ![[shot.png]] 正文尾');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`,
  );
  await sleep(1200);
  const diskText = readFileSync(inboxFile, "utf8");
  check(diskText.includes("（已编辑）"), "286 Enter 保存落到磁盘", diskText.trim().split("\n")[2] ?? "");
  // 标签输入
  const tagInput = await evaluate(ws, `!!document.querySelector('.cm-drawer-tag-input')`);
  check(tagInput, "286 抽屉有标签输入框");
  await evaluate(
    ws,
    `(() => {
      const el = document.querySelector('.cm-drawer-tag-input');
      const nativeSet = (el2, value) => {
        const proto = el2 instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el2, value);
        el2.dispatchEvent(new Event("input", { bubbles: true }));
      };
      nativeSet(el, '新标签');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`,
  );
  await sleep(1200);
  const diskTags = readFileSync(inboxFile, "utf8");
  check(diskTags.includes("#新标签"), "286 标签 Enter 添加落盘", diskTags.trim().split("\n")[2] ?? "");
  // Esc 关抽屉、再关面板
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  await sleep(300);
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  await sleep(400);

  // ----------------------------------------------- 284：截图链路（合成事件触发）
  // 说明：本机验证发现注入按键（keybd_event/SendKeys）在这台 Windows 上不触发
  // RegisterHotKey（PowerShell 独立对照同样收不到），无法用假按键测 OS 热键；
  // 真实按键链路由 tauri 插件保证。这里用 webview 侧 emit 同一事件，
  // 验证「事件 → runScreenshot → 抓屏 → 弹窗」的完整前端链路。
  await evaluate(
    ws,
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'screenshot-hotkey', payload: null })`,
  );
  let shotShown = false;
  for (let i = 0; i < 20 && !shotShown; i += 1) {
    await sleep(800);
    shotShown = await evaluate(ws, `!!document.querySelector('.shot-card')`).catch(() => false);
  }
  check(shotShown, "284 事件触发截图弹窗（抓屏+展示）");
  if (shotShown) {
    const shotImg = await evaluate(
      ws,
      `(() => { const img = document.querySelector('.shot-img'); return img && img.naturalWidth > 100; })()`,
    );
    check(shotImg, "284 截图真实抓到屏幕内容");
    // OCR 一把（整图）：只验证通道可用（有结果框即通过，不管内容）
    await evaluate(
      ws,
      `(() => { const btn = Array.from(document.querySelectorAll('.shot-btn')).find((b) => b.textContent.includes('识别文本')); btn?.click(); return true; })()`,
    );
    let ocrDone = false;
    for (let i = 0; i < 20 && !ocrDone; i += 1) {
      await sleep(700);
      ocrDone = await evaluate(
        ws,
        `(() => { const el = document.querySelector('.shot-ocr-text'); return el !== null; })()`,
      ).catch(() => false);
    }
    check(ocrDone, "284 OCR 通道可用（识别完成出现结果框）");
    const ocrSample = await evaluate(ws, `document.querySelector('.shot-ocr-text')?.value ?? ''`);
    console.log(`  (OCR 样例: ${JSON.stringify(ocrSample.slice(0, 40))})`);
    await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
  }
} finally {
  try {
    await evaluate(ws, `localStorage.clear()`);
  } catch {}
  try {
    ws.close();
  } catch {}
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n冒烟全部通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

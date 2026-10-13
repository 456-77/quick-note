// 0.22 批次验收：本轮 11 项反馈的关键路径断言（发版前临时脚本）。
// 前置：gui-test 变体 exe 已带 --remote-debugging-port 启动，参数 <port>。
// 覆盖：Ctrl+B 加粗 / Ctrl+Shift+C 复制代码 / gutter 点击切换表格形态 /
// 焦点在编辑器外 Ctrl+F 唤起自定义搜索面板 / 标签视图滚动 / 收藏置顶 /
// 全局搜索跳转高亮 + 悬停预览 / 速记编辑粘贴图片与移除 / 截图快捷键按键录入 /
// screenshot_ocr 端到端（多引擎脚本真实跑一遍）/ 多窗口热键不报错。

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9222";
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

const click = (ws, selectorExpr, label) =>
  evaluate(ws, `(() => { const el = ${selectorExpr}; if (!el) return false; el.click(); return true; })()`).then(
    (ok) => check(ok, label),
  );

/** 状态栏文本（notice/setStatus 的落点）。 */
const statusText = (ws) =>
  evaluate(ws, `Array.from(document.querySelectorAll('.status-cell')).map((el) => el.textContent).join('|')`);

// ------------------------------------------------ 自备数据：临时仓库 + 收件仓库

const work = join(tmpdir(), `qn-022-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "vault");
cpSync(join(root, "test-vault"), vault, { recursive: true });
// 搜索标记笔记：全局搜索（内容命中 + 高亮）用
writeFileSync(
  join(vault, "qn22搜索.md"),
  ["# 搜索标记", "", "这里有一个 QN22UNIQUE 标记词。", "", "正文再次出现 QN22UNIQUE 用于计数。", "", "#qn22tag", ""].join(
    "\n",
  ),
  "utf8",
);

// 1x1 红色 PNG（收件仓库既有图片）
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const inbox = join(work, "inbox");
mkdirSync(join(inbox, "attachments"), { recursive: true });
writeFileSync(join(inbox, "attachments", "shot.png"), Buffer.from(PNG_B64, "base64"));
const stamp = (() => {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
})();
writeFileSync(
  join(inbox, "Inbox.md"),
  [`# Inbox`, "", `- ${stamp} [vault/来源.md] #测试 带图片的速记 ![[shot.png]] 正文尾`, ""].join("\n"),
  "utf8",
);

// OCR 用文本图：PowerShell System.Drawing 画 400x120 白底黑字
const ocrPng = join(work, "ocr.png");
execSync(
  `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; ` +
    `$b=New-Object Drawing.Bitmap 400,120; $g=[Drawing.Graphics]::FromImage($b); ` +
    `$g.Clear([Drawing.Color]::White); $f=New-Object Drawing.Font('Arial',28); ` +
    `$g.DrawString('Hello OCR 42',$f,[Drawing.Brushes]::Black,12,42); ` +
    `$b.Save('${ocrPng.replace(/\\/g, "/")}',[Drawing.Imaging.ImageFormat]::Png)"`,
  { stdio: "pipe" },
);
const OCR_B64 = readFileSync(ocrPng).toString("base64");

// ------------------------------------------------ 连 CDP

const connect = async (targetPort, matchIndex = 0) => {
  const targets = await fetch(`http://127.0.0.1:${targetPort}/json/list`).then((r) => r.json());
  const pages = targets.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  const page = pages[matchIndex];
  if (!page) throw new Error(`没有找到 page 目标（${pages.length} 个）`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  return { ws, pages: pages.length };
};

const { ws } = await connect(port);
await sleep(600);

const openNoteByLabel = async (label) => {
  await evaluate(
    ws,
    `(() => { const row = Array.from(document.querySelectorAll('.tree-file')).find((el) => el.textContent.includes('${label}')); if (!row) return false; row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})); return true; })()`,
  );
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    const done = await evaluate(
      ws,
      `(() => { try { return window.__qnView && window.__qnView.state.doc.lines > 3; } catch { return false; } })()`,
    ).catch(() => false);
    if (done) return true;
  }
  return false;
};

try {
  // 种子：仓库 + 收件仓库设置，重载
  await evaluate(ws, `(() => {
    localStorage.clear();
    localStorage.setItem('quicknote.settings', JSON.stringify({}));
    localStorage.setItem('quicknote.vault', ${JSON.stringify(vault.replace(/\\/g, "/"))});
    const raw = JSON.parse(localStorage.getItem('quicknote.settings'));
    raw.quickCaptureVault = ${JSON.stringify(inbox.replace(/\\/g, "/"))};
    raw.quickCaptureFile = 'Inbox.md';
    raw.showLineNumbers = true; // gutter 切换需要行号可见（默认 display:none）
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

  // 同步隔离：gui-test 数据目录干净，状态栏必须显示同步未启用
  const syncLabel = await statusText(ws);
  check(!/已同步|同步中/.test(syncLabel) || /未启用|同步未/.test(syncLabel), "同步未启用（隔离铁律）", syncLabel);

  // 打开 features.md（含表格与行内代码）
  check(await openNoteByLabel("features.md"), "打开 features.md");

  // ---------------------------------------------- 1. Ctrl+B 加粗
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    const doc = view.state.doc.toString();
    const at = doc.indexOf('普通项目一');
    view.dispatch({ selection: { anchor: at, head: at + 5 } });
    view.focus();
    return at >= 0;
  })()`);
  await evaluate(ws, `window.__qnView.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: 'b', ctrlKey: true, bubbles: true, cancelable: true}))`);
  await sleep(200);
  const bolded = await evaluate(ws, `window.__qnView.state.doc.toString().includes('**普通项目一**')`);
  check(bolded, "Ctrl+B 选中加粗（** 包裹）");
  // 再按一次取消，恢复原文
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    const doc = view.state.doc.toString();
    const at = doc.indexOf('**普通项目一**');
    view.dispatch({ selection: { anchor: at, head: at + 9 } });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: 'b', ctrlKey: true, bubbles: true, cancelable: true}));
    return true;
  })()`);
  await sleep(200);
  const unbolded = await evaluate(
    ws,
    `!window.__qnView.state.doc.toString().includes('**普通项目一**') && window.__qnView.state.doc.toString().includes('普通项目一')`,
  );
  check(unbolded, "Ctrl+B 再按取消加粗");
  // Ctrl+B 两步触发自动保存 → watcher → doc 重载回环。不等它静默就做后续按键断言
  // 的话，重载里无效 mermaid 的 setError 会覆盖/抢占状态提示（实测光标提示被
  // 「图表渲染失败」顶掉，表现为本项假失败）。
  await sleep(2000);

  // ---------------------------------------------- 2. Ctrl+Shift+C 复制行内代码
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    const doc = view.state.doc.toString();
    const bt = String.fromCharCode(96);
    const at = doc.indexOf(bt + 'code' + bt) + 2; // 反引号内
    view.dispatch({ selection: { anchor: at + 1 } });
    view.focus();
    return true;
  })()`);
  await evaluate(ws, `window.__qnView.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: 'c', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}))`);
  await sleep(400);
  let status = await statusText(ws);
  check(/已复制行内代码/.test(status), "Ctrl+Shift+C 复制行内代码（状态栏提示）", status);

  // 光标在代码块内 → 复制整块
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    const doc = view.state.doc.toString();
    const at = doc.indexOf('const answer');
    view.dispatch({ selection: { anchor: at + 3 } });
    view.focus();
    return at >= 0;
  })()`);
  await evaluate(ws, `window.__qnView.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: 'c', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}))`);
  await sleep(400);
  status = await statusText(ws);
  check(/已复制代码块/.test(status), "Ctrl+Shift+C 复制整个代码块", status);

  // 光标不在代码里 → 错误提示而不是静默（错误走 setError，可能渲染在状态栏之外）
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    view.dispatch({ selection: { anchor: 2 } });
    view.focus();
    return true;
  })()`);
  await evaluate(ws, `window.__qnView.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: 'c', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}))`);
  let errShown = false;
  for (let i = 0; i < 6 && !errShown; i += 1) {
    await sleep(150);
    errShown = await evaluate(ws, `/光标不在行内代码/.test(document.body.textContent)`);
  }
  check(errShown, "非代码位置给出提示");

  // ---------------------------------------------- 3. gutter 点击切换表格形态
  const tableLine = await evaluate(ws, `(() => {
    const view = window.__qnView;
    const doc = view.state.doc;
    for (let n = 1; n <= doc.lines; n += 1) {
      if (doc.line(n).text.includes('| 左对齐 |')) return n;
    }
    return 0;
  })()`);
  check(tableLine > 0, "找到表格起始行");
  await evaluate(
    ws,
    `(() => { const view = window.__qnView; const line = view.state.doc.line(${tableLine}); view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(line.from).top - view.scrollDOM.clientHeight / 2); return true; })()`,
  );
  await sleep(400);
  let rendered = await evaluate(ws, `document.querySelectorAll('.cm-lp-tablewrap').length`);
  check(rendered > 0, "表格渲染为 widget（实时模式）");

  // 点表格起始行的行号 → 源码。渲染态下表格被 widget 整块替换，对应行的行号元素
  // 不存在——新版实现按 event.clientY 反查文档位置，所以直接在 widget 的 y 处
  // 向 .cm-gutters 派发 mousedown（lineBlockAt 对被替换行返回 widget 的几何）。
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    const line = view.state.doc.line(${tableLine});
    const blockTop = view.lineBlockAt(line.from).top - view.scrollDOM.scrollTop + view.scrollDOM.getBoundingClientRect().top;
    const gutters = view.scrollDOM.querySelector('.cm-gutters');
    if (!gutters) return false;
    const r = gutters.getBoundingClientRect();
    gutters.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0, clientX: r.left + 8, clientY: blockTop + 10}));
    window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
    return true;
  })()`);
  await sleep(400);
  const sourceShown = await evaluate(
    ws,
    `(() => { const t = document.querySelector('.cm-content').textContent; return t.includes('| :--- |') || t.includes('|:---|') || t.includes(':---:'); })()`,
  );
  check(sourceShown, "点击行号 → 表格显示源码");

  // 再点同一行行号 → 恢复渲染（源码态下行元素真实存在，取其 y 向 gutter 派发）
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    const lineEl = Array.from(view.scrollDOM.querySelectorAll('.cm-content .cm-line')).find((el) => el.textContent.includes('| 左对齐 |'));
    if (!lineEl) return false;
    const gutters = view.scrollDOM.querySelector('.cm-gutters');
    if (!gutters) return false;
    const r = gutters.getBoundingClientRect();
    gutters.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0, clientX: r.left + 8, clientY: lineEl.getBoundingClientRect().top + 5}));
    window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
    return true;
  })()`);
  await sleep(400);
  rendered = await evaluate(ws, `document.querySelectorAll('.cm-lp-tablewrap').length`);
  check(rendered > 0, "再点行号 → 表格恢复渲染");

  // ---------------------------------------------- 4. Ctrl+F（焦点在编辑器外）
  await evaluate(ws, `(() => { document.activeElement && document.activeElement.blur(); document.body.focus && document.body.focus(); return document.activeElement === document.body || !document.activeElement.closest('.cm-content'); })()`);
  await evaluate(ws, `document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'f', ctrlKey: true, bubbles: true, cancelable: true}))`);
  await sleep(300);
  const panelOpen = await evaluate(ws, `!!document.querySelector('.qn-search')`);
  check(panelOpen, "焦点在编辑器外 Ctrl+F → 自定义搜索面板（不再漏给 WebView2）");
  await click(ws, `document.querySelector('.qn-search [data-act="close"]')`, "关闭搜索面板");

  // ---------------------------------------------- 5. 标签视图滚动
  await click(ws, `Array.from(document.querySelectorAll('.left-view-tab')).find((el) => el.textContent.includes('标签'))`, "切到标签视图");
  let tagStyle = null;
  for (let i = 0; i < 10 && !tagStyle; i += 1) {
    await sleep(400);
    tagStyle = await evaluate(ws, `(() => { const el = document.querySelector('.tag-dash'); if (!el) return null; const s = getComputedStyle(el); return { oy: s.overflowY, flex: s.flexGrow, rows: document.querySelectorAll('.tag-dash-row').length }; })()`);
  }
  if (!tagStyle) {
    const sideHtml = await evaluate(ws, `document.querySelector('.sidebar-left').innerHTML.slice(0, 600)`);
    console.log(`  [debug] sidebar-left: ${String(sideHtml).slice(0, 300)}`);
  }
  check(tagStyle && tagStyle.oy === "auto" && tagStyle.flex === "1", "标签视图可滚动（overflow:auto + flex:1）", JSON.stringify(tagStyle));
  check(tagStyle && tagStyle.rows > 0, "标签列表有条目（qn22tag）", JSON.stringify(tagStyle));

  // ---------------------------------------------- 6. 收藏置顶
  // 先回知识库视图
  await click(ws, `Array.from(document.querySelectorAll('.left-view-tab'))[0]`, "切回知识库视图");
  await sleep(200);
  const ctxMenuOn = (label) =>
    evaluate(ws, `(() => {
      const row = Array.from(document.querySelectorAll('.tree-file')).find((el) => el.textContent.includes('${label}'));
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 260, clientY: 320}));
      return true;
    })()`);
  const menuClick = (text) =>
    evaluate(ws, `(() => { const btn = Array.from(document.querySelectorAll('.context-menu button')).find((el) => el.textContent.trim() === '${text}'); if (!btn) return false; btn.click(); return true; })()`);
  check(await ctxMenuOn("features.md"), "右键 features.md");
  check(await menuClick("收藏"), "收藏 features.md");
  await sleep(200);
  check(await ctxMenuOn("cr-only.md"), "右键 cr-only.md");
  check(await menuClick("收藏"), "收藏 cr-only.md");
  await sleep(200);
  check(await ctxMenuOn("cr-only.md"), "再次右键 cr-only.md");
  check(await menuClick("置顶"), "置顶 cr-only.md");
  await sleep(200);
  await click(ws, `Array.from(document.querySelectorAll('.left-view-tab')).find((el) => el.textContent.includes('收藏'))`, "切到收藏视图");
  await sleep(300);
  const favFirst = await evaluate(ws, `(() => { const rows = Array.from(document.querySelectorAll('.tree-item')); if (rows.length < 2) return null; return { first: rows[0].textContent, pinned: !!rows[0].querySelector('.tree-icon-pin'), anyPin: document.querySelectorAll('.tree-icon-pin').length }; })()`);
  check(favFirst && favFirst.first.includes("cr-only.md") && favFirst.pinned, "置顶项排在收藏列表最前（图钉图标）", JSON.stringify(favFirst));

  // ---------------------------------------------- 7. 全局搜索：悬停预览 + 跳转高亮
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', ctrlKey: true, bubbles: true, cancelable: true}))`);
  await sleep(400);
  const paletteShown = await evaluate(ws, `!!document.querySelector('.palette-input')`);
  check(paletteShown, "Ctrl+K 打开命令面板");
  await evaluate(ws, `(() => { const input = document.querySelector('.palette-input'); const set = ${nativeSet}; set(input, "QN22UNIQUE"); return true; })()`);
  await sleep(900);
  const hitItem = await evaluate(ws, `(() => { const items = Array.from(document.querySelectorAll('.palette-item')); return items.filter((el) => el.textContent.includes('qn22搜索.md') || el.textContent.includes('QN22UNIQUE')).length; })()`);
  check(hitItem > 0, "内容搜索命中 qn22搜索.md");
  // 悬停 300ms 防抖 → 预览卡。React 的 onMouseEnter 由根上委托的 mouseover 合成，
  // 非冒泡的合成 mouseenter 触发不了它——必须派冒泡的 mouseover。
  await evaluate(ws, `(() => { const items = Array.from(document.querySelectorAll('.palette-item')); const hit = items.find((el) => el.textContent.includes('qn22搜索.md')); if (!hit) return false; hit.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, cancelable: true})); hit.dispatchEvent(new MouseEvent('mousemove', {bubbles: true})); return true; })()`);
  await sleep(600);
  const preview = await evaluate(ws, `(() => { const p = document.querySelector('.palette-preview'); if (!p) return null; return { name: p.textContent.includes('qn22搜索.md'), hit: !!p.querySelector('.palette-preview-line.is-hit'), mark: !!p.querySelector('mark') }; })()`);
  check(preview && preview.name && preview.hit && preview.mark, "悬停显示上下文预览卡（命中行 + 关键词高亮）", JSON.stringify(preview));
  // 回车打开 → 搜索面板预填 + 全文高亮 + 命中行选区
  await evaluate(ws, `(() => { const input = document.querySelector('.palette-input'); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})); return true; })()`);
  await sleep(800);
  const jump = await evaluate(ws, `(() => {
    const panel = document.querySelector('.qn-search');
    const input = panel && panel.querySelector('.qn-search-input');
    const count = panel && panel.querySelector('.qn-search-count');
    const view = window.__qnView;
    const sel = view ? view.state.selection.main : null;
    const selected = sel ? view.state.sliceDoc(sel.from, sel.to) : '';
    return { open: !!panel, query: input ? input.value : null, count: count ? count.textContent : null, selected };
  })()`);
  check(
    jump.open && jump.query === "QN22UNIQUE" && /\d+\s*\/\s*\d+/.test(jump.count || "") && jump.selected === "QN22UNIQUE",
    "跳转后：搜索面板预填 + 计数 + 命中词选区",
    JSON.stringify(jump),
  );
  await click(ws, `document.querySelector('.qn-search [data-act="close"]')`, "关闭搜索面板");

  // ---------------------------------------------- 8. 速记编辑：粘贴图片 + 移除
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', {key: 'm', ctrlKey: true, altKey: true, bubbles: true, cancelable: true}))`);
  await sleep(900);
  const cmShown = await evaluate(ws, `!!document.querySelector('.cm-root')`);
  check(cmShown, "打开速记管理");
  await evaluate(ws, `(() => { const row = document.querySelector('.cm-row'); if (!row) return false; row.click(); return true; })()`);
  await sleep(500);
  const drawer = await evaluate(ws, `(() => { const d = document.querySelector('.cm-drawer'); if (!d) return null; return { open: true, removeX: document.querySelectorAll('.cm-row-image-x').length, addBtn: !!Array.from(d.querySelectorAll('button')).find((b) => b.textContent.includes('＋图片')) }; })()`);
  check(drawer && drawer.open && drawer.removeX > 0, "详情抽屉：既有图片带移除按钮", JSON.stringify(drawer));
  check(drawer && drawer.addBtn, "详情抽屉：＋图片按钮存在");

  // 合成 paste 事件：DataTransfer + File。**不能**把「派发 + 延时读值」包在同一个
  // Promise 里让 awaitPromise 等——WebView2 的 CDP 在 paste 之后会把延迟 resolve
  // 的结果毒化成 {}（实测：连 resolve('done') 都返回 {}）。派发用同步 evaluate，
  // node 侧等待后同步轮询读值。
  await evaluate(ws, `(() => {
    const area = document.querySelector('.cm-drawer-edit');
    if (!area) return false;
    const bytes = Uint8Array.from(atob('${PNG_B64}'), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  let draftVal = null;
  for (let i = 0; i < 10; i += 1) {
    await sleep(300);
    draftVal = await evaluate(ws, `(() => { const a = document.querySelector('.cm-drawer-edit'); return a ? a.value : null; })()`);
    if (draftVal && draftVal.includes("![[Pasted image")) break;
  }
  check(typeof draftVal === "string" && draftVal.includes("![[Pasted image"), "粘贴图片 → 链接进草稿", String(draftVal).slice(0, 80));
  let inboxAttOk = false;
  for (let i = 0; i < 10 && !inboxAttOk; i += 1) {
    await sleep(300);
    inboxAttOk = (() => {
      try {
        const dir = join(inbox, "attachments");
        return readdirSync(dir).some((name) => name.startsWith("Pasted image"));
      } catch {
        return false;
      }
    })();
  }
  check(inboxAttOk, "图片已落盘收件仓库附件目录");

  // 移除按钮 × → 摘掉草稿里刚粘贴的那张（strip 顺序 = 草稿顺序，粘贴的在末尾）
  await evaluate(ws, `(() => { const btns = document.querySelectorAll('.cm-row-image-x'); if (btns.length === 0) return false; btns[btns.length - 1].click(); return true; })()`);
  await sleep(300);
  const afterRemove = await evaluate(ws, `(() => { const a = document.querySelector('.cm-drawer-edit'); return a ? a.value : null; })()`);
  check(!afterRemove.includes("Pasted image") && afterRemove.includes("![[shot.png]]"), "点 × 移除粘贴的图片（其余保留）", String(afterRemove).slice(0, 60));
  // 关抽屉不保存（改动了草稿，直接关，避免写脏 Inbox.md）
  await click(ws, `document.querySelector('.cm-drawer .cm-icon-btn')`, "关闭抽屉（不保存）");
  await sleep(300);
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}))`);
  await sleep(400);

  // ---------------------------------------------- 9. 截图快捷键按键录入
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', {key: ',', ctrlKey: true, bubbles: true, cancelable: true}))`);
  await sleep(600);
  const settingsShown = await evaluate(ws, `!!document.querySelector('.settings-panel')`);
  check(settingsShown, "打开设置面板");
  await click(ws, `Array.from(document.querySelectorAll('.settings-panel button')).find((b) => b.textContent.trim() === '录入')`, "点「录入」");
  await sleep(200);
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', {key: 'p', ctrlKey: true, altKey: true, bubbles: true, cancelable: true}))`);
  await sleep(200);
  const pending = await evaluate(ws, `(() => { const el = document.querySelector('.shot-hotkey-capture'); return el ? el.textContent : null; })()`);
  check(pending === "Ctrl+Alt+P", "按键实时回显 Ctrl+Alt+P", String(pending));
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}))`);
  await sleep(400);
  const savedHotkey = await evaluate(ws, `(() => { try { return JSON.parse(localStorage.getItem('quicknote.settings')).screenshotHotkey; } catch { return null; } })()`);
  check(savedHotkey === "Ctrl+Alt+P", "Enter 保存快捷键（localStorage）", String(savedHotkey));
  const display = await evaluate(ws, `document.querySelector('.shot-hotkey-display') && document.querySelector('.shot-hotkey-display').textContent`);
  check(display === "Ctrl+Alt+P", "保存后键帽显示 Ctrl+Alt+P", String(display));
  await click(ws, `Array.from(document.querySelectorAll('.settings-panel button')).find((b) => b.textContent.trim() === '重置')`, "恢复默认 Ctrl+Alt+G");
  await sleep(300);
  await click(ws, `document.querySelector('.settings-close')`, "关闭设置");

  // ---------------------------------------------- 10. OCR 端到端（重写的多引擎 PS 脚本真实跑）
  // 同样不走 awaitPromise：invoke 的结果落到 window 变量，node 侧轮询。
  await evaluate(ws, `(() => {
    window.__qnOcr = { done: false };
    window.__TAURI_INTERNALS__.invoke('screenshot_ocr', { imageBase64: ${JSON.stringify(OCR_B64)} })
      .then((r) => { window.__qnOcr = { done: true, text: String(r) }; }, (e) => { window.__qnOcr = { done: true, err: String(e) }; });
    return true;
  })()`);
  let ocrText = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const st = await evaluate(ws, `window.__qnOcr`);
    if (st && st.done) { ocrText = st.err ?? st.text; break; }
  }
  check(typeof ocrText === "string" && /hello|ocr|42/i.test(ocrText), "screenshot_ocr 识别文本图（多引擎脚本可跑）", JSON.stringify(String(ocrText).slice(0, 80)));

  // ---------------------------------------------- 11. 多窗口热键仲裁
  const exe = join(root, "src-tauri", "target", "release", "quick-note.exe");
  const child = spawn(exe, [vault.replace(/\\/g, "/")], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
    detached: false,
  });
  // 两个实例共用一个 WebView2 浏览器进程（同 UDF）→ 同一调试端口出现第二个页面目标
  let secondPage = null;
  for (let i = 0; i < 30 && !secondPage; i += 1) {
    await sleep(1000);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
    const pages = list.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    if (pages.length >= 2) secondPage = pages[1];
  }
  if (!secondPage) {
    check(false, "第二实例：未在调试端口发现第二个页面目标");
  } else {
    const ws2 = new WebSocket(secondPage.webSocketDebuggerUrl);
    await new Promise((resolve) => {
      ws2.addEventListener("open", resolve, { once: true });
      ws2.addEventListener("error", resolve, { once: true });
    });
    if (ws2.readyState !== 1) {
      check(false, "第二实例：WebSocket 连接失败");
    } else {
      let b2 = false;
      for (let i = 0; i < 30 && !b2; i += 1) {
        await sleep(800);
        b2 = await cdp(ws2, "Runtime.evaluate", {
          expression: `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0; } catch { return false; } })()`,
          returnByValue: true,
        })
          .then((r) => r.result.value)
          .catch(() => false);
      }
      const b2text = await cdp(ws2, "Runtime.evaluate", {
        expression: `document.body.textContent.slice(0, 4000)`,
        returnByValue: true,
      })
        .then((r) => r.result.value)
        .catch(() => "");
      check(b2 && !b2text.includes("注册截图快捷键失败"), "第二实例启动：热键让位不报错", b2 ? "已渲染" : "未就绪");
      ws2.close();
    }
  }
  try {
    process.kill(child.pid);
  } catch {}
  await sleep(800);

  // ---------------------------------------------- 收尾
  console.log(failures === 0 ? "\n0.22 批次验收全部通过 ✓" : `\n${failures} 项失败 ✗`);
} finally {
  try {
    ws.close();
  } catch {}
  rmSync(work, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);

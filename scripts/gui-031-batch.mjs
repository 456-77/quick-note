// 0.31 批次验收：本轮 9 项反馈的桌面端关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 + 临时
// 仓库），结束时自清理。
//
// 覆盖：
// - 表格内 ==高亮== 渲染（mark.cm-lp-highlight 出现在单元格富文本里）
// - 表格内行内代码快捷复制：Alt+点击 与 Ctrl+Shift+C（单元格是独立编辑宿主，
//   CM 的 copyCode 键位收不到——0.31 在单元格自身补齐两条通道）
// - 标签页分屏查看：标签右键「分屏查看」→ 只读渲染窗格 + 目录跟随最后聚焦窗格
// - 建表语句收录弹窗（Ctrl+Alt+L）：粘贴 CREATE TABLE 自动识别表名合并进 DDL 笔记
// - 表名悬浮预览：光标停在已收录表名上浮动显示建表语句
// - 空状态背景：背景开着时欢迎页不再是不透明纯色块（qn-bg-on 透出背景图）
// - 阅读位置记忆：滚动停 800ms 落库，重开同一笔记恢复到上次位置
// - 重启恢复上次仓库：切到别的仓库再关再开，显示的是最后所在仓库

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9421";
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
// Chromium CDP modifiers 位：Alt=1 Ctrl=2 Meta=4 Shift=8
const CTRL = 2;
const CTRL_ALT = 3;
const CTRL_SHIFT = 10;

const mouse = (ws, type, x, y, extra = {}) =>
  cdp(ws, "Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra });

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}`;

// ------------------------------------------------ 自备数据：临时仓库

const work = join(tmpdir(), `qn-031-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vaultA = join(work, "主库A").replace(/\\/g, "/");
const vaultB = join(work, "副库B").replace(/\\/g, "/");
mkdirSync(vaultA, { recursive: true });
mkdirSync(vaultB, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

// 表格 + 高亮 + 行内代码（Bug1/Bug2 的主角）
writeFileSync(
  join(vaultA, "qn31表格.md"),
  [
    "# qn31表格",
    "",
    "| 名称 | 说明 |",
    "| --- | --- |",
    "| ==重点标记== | `ids_qn31_tab` 建表 |",
    "| 普通 | 无 |",
    "",
  ].join("\n"),
  "utf8",
);
// 长文（阅读位置恢复）
writeFileSync(
  join(vaultA, "qn31长文.md"),
  ["# qn31长文", "", ...Array.from({ length: 160 }, (_, i) => `第 ${i + 1} 行：内容填充，滚动定位用。`)].join("\n"),
  "utf8",
);
// 分屏对照 + hover 表名
writeFileSync(
  join(vaultA, "qn31对照.md"),
  ["# qn31对照", "", "## 甲节", "", "对照内容一。", "", "## 乙节", "", "查询要用 ids_qn31_tab 这张表。", ""].join("\n"),
  "utf8",
);
// 背景图（1x1 蓝色 PNG）
const png1px = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
writeFileSync(join(vaultA, "qn31bg.png"), png1px);
// 副库（重启恢复仓库断言用）
writeFileSync(join(vaultB, "副库笔记.md"), ["# 副库笔记", "", "内容。"].join("\n"), "utf8");

const spawnInstance = (vaultArg) =>
  spawn(exe, vaultArg ? [vaultArg] : [], {
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

const bootAndConnect = async (vaultArg) => {
  const child = spawnInstance(vaultArg);
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

const closeGracefully = async (ws) => {
  // 优雅退出：触发 beforeunload 让 VAULT_KEY 落盘（0.31 关闭回写路径）
  await evaluate(ws, `window.close ? (() => { try { window.close(); return true; } catch { return false; } })() : false`).catch(() => false);
  await sleep(400);
};

let child = null;
let ws = null;

try {
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });

  ({ child, ws } = await bootAndConnect(vaultA));

  // ============================================== 1. 表格内高亮渲染
  {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn31表格')); t?.click(); return !!t; })()`);
    await waitFor(ws, `!!document.querySelector('.cm-lp-tablewrap table')`, 10000);
    await sleep(500);
    const mark = await evaluate(ws, `(() => {
      const cell = [...document.querySelectorAll('.cm-lp-cell')].find((el) => (el.innerText ?? '').includes('重点标记'));
      const mark = cell?.querySelector('mark.cm-lp-highlight');
      return { hasCell: !!cell, hasMark: !!mark, markText: mark?.textContent ?? null, raw: cell?.dataset.raw ?? null };
    })()`);
    check(mark.hasCell && mark.hasMark && mark.markText === "重点标记", "表格单元格里 ==高亮== 渲染成 mark（0.31）", JSON.stringify(mark));
    check((mark.raw ?? "").includes("==重点标记=="), "单元格原文保留 == 标记（编辑写回不丢语法）", mark.raw);
  }

  // ============================================== 2. 表格内行内代码 Alt+点击复制
  {
    // CDP Input.dispatchMouseEvent 的 modifiers 在 WebView2 上不落进合成事件的
    // altKey（0.23 已知 Input 层怪癖），页面内构造 MouseEvent 直发验证 handler——
    // 单元格自己的 mousedown 就地完成复制（0.31），不再依赖冒泡到 contentDOM
    const sent = await evaluate(ws, `(() => {
      const chip = [...document.querySelectorAll('.cm-lp-cell .cm-lp-code')].find((el) => (el.textContent ?? '').includes('ids_qn31_tab'));
      if (!chip) return false;
      chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true, button: 0 }));
      return true;
    })()`);
    check(sent, "单元格里的行内代码 chip 找得到（渲染态）");
    const noticed = await waitFor(ws, `[...document.querySelectorAll('.status-cell')].some((c) => (c.textContent ?? '').includes('已复制：ids_qn31_tab'))`, 5000);
    check(noticed, "Alt+点击单元格内行内代码 → 复制并提示（就地通道）", await evaluate(ws, `[...document.querySelectorAll('.status-cell')].map((c) => c.textContent).join('|')`));
  }

  // ============================================== 3. 表格内 Ctrl+Shift+C 复制
  {
    // 聚焦 + 按键全部页面内合成（CDP Input 层的 modifiers/焦点行为不稳定）：
    // cell.focus() 触发原生 focus（切原文编辑态），光标放进反引号内的词中间，
    // 再发 Ctrl+Shift+C 的 keydown——单元格自己的 copyCode 通道（0.31）
    const done = await evaluate(ws, `(() => {
      const cell = [...document.querySelectorAll('.cm-lp-cell')].find((el) => ((el.innerText ?? '') + (el.dataset.raw ?? '')).includes('ids_qn31_tab'));
      if (!cell) return 'NO_CELL';
      cell.focus();
      return 'FOCUSED';
    })()`);
    check(done === "FOCUSED", "焦点进入单元格（独立编辑宿主）", done);
    const placed = await evaluate(ws, `(() => {
      const cell = document.activeElement;
      if (!cell || !cell.classList.contains('cm-lp-cell')) return 'NOT_FOCUSED';
      const text = cell.textContent ?? '';
      const at = Math.min(text.indexOf('ids_qn31_tab') + 4, text.length - 1);
      const node = cell.firstChild;
      if (!node) return 'NO_NODE';
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(node, at);
      range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
      return 'PLACED:' + at;
    })()`);
    check(String(placed).startsWith("PLACED"), "光标放进原文态的反引号词内", String(placed));
    await evaluate(ws, `(() => {
      const cell = document.activeElement;
      cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`);
    const noticed = await waitFor(ws, `[...document.querySelectorAll('.status-cell')].some((c) => (c.textContent ?? '').includes('已复制：ids_qn31_tab'))`, 5000);
    check(noticed, "单元格内 Ctrl+Shift+C 复制光标处行内代码（原文态反引号定位）", await evaluate(ws, `[...document.querySelectorAll('.status-cell')].map((c) => c.textContent).join('|')`));
    await evaluate(ws, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
    await sleep(300);
  }

  // ============================================== 4. 分栏（0.32.2 Obsidian 式）+ 目录跟随
  {
    // 0.32.2：标签栏随窗格分成两段，右栏有自己的标签栏；「分屏」= 把标签移到
    // 另一栏（标签唯一，不存在同文件双开）。
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn31对照')); t?.click(); return !!t; })()`);
    await waitFor(ws, `[...document.querySelectorAll('.cm-line')].some((el) => (el.innerText ?? '').includes('对照内容一'))`, 10000);

    // 4a. 左栏只剩一个标签：「分屏到右侧」置灰（移过去左栏就空了）
    const opened = await evaluate(ws, `(() => {
      const tabs = [...document.querySelectorAll('.tabbar:not(.is-split) [role="tab"]')];
      const target = tabs.find((el) => (el.textContent ?? '').includes('qn31对照'));
      if (!target) return { ok: false, count: tabs.length, names: tabs.map((t) => t.textContent) };
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 120 }));
      return { ok: true };
    })()`);
    check(opened.ok, "右键标签弹菜单（找到 qn31对照 标签）", JSON.stringify(opened));
    const guard = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏到右侧')); return b ? { text: b.textContent, disabled: b.disabled } : null; })()`, 5000);
    check(!!guard, "菜单含「分屏到右侧」（0.32.2 移动语义）", JSON.stringify(guard));
    check(!!guard && guard.disabled, "左栏只剩这一个标签时置灰（左栏至少留一个）", JSON.stringify(guard));
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);

    // 4b. 再开一个标签，右键其中非激活标签「分屏到右侧」：右栏出现，
    //     标签栏分成两段，各管各的（localStorage 直写设置须 reload 生效）
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
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn31表格')); t?.click(); return !!t; })()`);
    await waitFor(ws, `!!document.querySelector('.cm-lp-tablewrap')`, 8000);
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn31对照')); t?.click(); return !!t; })()`);
    await waitFor(ws, `[...document.querySelectorAll('.cm-line')].some((el) => (el.innerText ?? '').includes('对照内容一'))`, 8000);
    await evaluate(ws, `(() => {
      const tabs = [...document.querySelectorAll('.tabbar:not(.is-split) [role="tab"]')];
      const target = tabs.find((el) => (el.textContent ?? '').includes('qn31表格'));
      target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 120 }));
      return !!target;
    })()`);
    const menuOk = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏到右侧')); return b && !b.disabled; })()`, 5000);
    check(menuOk, "左栏两个标签时「分屏到右侧」可点");
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏到右侧')); b?.click(); return !!b; })()`);
    const splitUp = await waitFor(ws, `!!document.querySelector('.editor-pane-col.is-split') && !!window.__qnSplitView`, 5000);
    check(splitUp, "右栏出现（第二编辑器 __qnSplitView 就绪）");
    const splitDoc = await waitFor(ws, `(window.__qnSplitView?.state.doc.toString() ?? '').includes('重点标记')`, 8000);
    check(splitDoc, "右栏编辑器装的是被移过去的标签（qn31表格 内容）");
    const rightBar = await evaluate(ws, `[...document.querySelectorAll('.tabbar.is-split [role="tab"]')].map((el) => el.textContent).join('|')`);
    check(rightBar.includes("qn31表格"), "右栏标签栏列出移过去的标签（标签栏分成两段）", rightBar);
    const leftBar = await evaluate(ws, `[...document.querySelectorAll('.tabbar:not(.is-split) [role="tab"]')].map((el) => el.textContent).join('|')`);
    check(leftBar.includes("qn31对照") && !leftBar.includes("qn31表格"), "左栏标签栏只剩左栏自己的标签", leftBar);
    const mainStill = await evaluate(ws, `(window.__qnView?.state.doc.toString() ?? '').includes('对照内容一')`);
    check(mainStill, "主编辑器仍显示左栏激活文件（不被分屏顶掉）");

    // 4c. 目录跟随：点右栏 → 目录列右栏文件的大纲；点大纲项在**右栏内**定位
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.sidebar-tab')].find((el) => (el.textContent ?? '').includes('目录')); b?.click(); return !!b; })()`);
    await evaluate(ws, `(() => { document.querySelector('.editor-pane-col.is-split .split-editor-host')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
    await sleep(400);
    const outlineSplit = await evaluate(ws, `[...document.querySelectorAll('.outline-item')].map((el) => el.textContent).join('|')`);
    check(outlineSplit.includes("qn31表格") && !outlineSplit.includes("乙节"), "目录跟随右栏（列右栏文件大纲）", outlineSplit);
    await evaluate(ws, `(() => { const it = [...document.querySelectorAll('.outline-item')].find((el) => (el.textContent ?? '').includes('qn31表格')); it?.click(); return !!it; })()`);
    await sleep(400);
    const jump = await evaluate(ws, `(() => ({
      splitFocused: !!(window.__qnSplitView?.contentDOM && window.__qnSplitView.contentDOM.contains(document.activeElement)),
      splitHead: window.__qnSplitView ? window.__qnSplitView.state.selection.main.head : -1,
      mainDoc: window.__qnView ? window.__qnView.state.doc.toString().slice(0, 30) : '',
    }))()`);
    check(jump.splitFocused && jump.splitHead >= 0, "点大纲项在右栏编辑器内定位（不重开文件）", JSON.stringify(jump));
    check((jump.mainDoc ?? "").includes("qn31对照"), "左栏文件未被覆盖（目录点击不顶掉并排文件）", jump.mainDoc);

    // 4d. 点左栏 → 目录回到左栏文件大纲
    await evaluate(ws, `(() => { document.querySelector('.tabbar:not(.is-split)')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
    await sleep(400);
    const outlineMain = await evaluate(ws, `[...document.querySelectorAll('.outline-item')].map((el) => el.textContent).join('|')`);
    check(outlineMain.includes("甲节") && outlineMain.includes("乙节"), "点左栏后目录跟随回来（列左栏文件大纲）", outlineMain);

    // 4e. Esc 收起右栏：标签整体移回左栏（不丢标签）
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    const splitGone = await waitFor(ws, `!document.querySelector('.editor-pane-col.is-split') && !window.__qnSplitView`, 5000);
    check(splitGone, "Esc 收起右栏（调试句柄一并清理）");
    const leftAfter = await evaluate(ws, `[...document.querySelectorAll('.tabbar:not(.is-split) [role="tab"]')].map((el) => el.textContent).join('|')`);
    check(leftAfter.includes("qn31表格") && leftAfter.includes("qn31对照"), "右栏标签移回左栏（收起不丢标签）", leftAfter);
    // 还原打开方式设置，避免影响后续小节
    await evaluate(ws, `(() => { const k='quicknote.settings'; const s=JSON.parse(localStorage.getItem(k) ?? '{}'); s.openNoteMode='replace'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  }

  // ============================================== 5. DDL 收录弹窗（默认键 Ctrl+Alt+J，0.32.2 起）
  {
    // CDP Input 偶发丢第一批按键（同 0.30 批测的兜底），没弹起再按
    await key(ws, { mod: CTRL_ALT, key: "j" }, "KeyJ", 74);
    let dialogUp = await waitFor(ws, `!!document.querySelector('.ddl-textarea')`, 2500);
    for (let i = 0; i < 3 && !dialogUp; i += 1) {
      await key(ws, { mod: CTRL_ALT, key: "j" }, "KeyJ", 74);
      dialogUp = await waitFor(ws, `!!document.querySelector('.ddl-textarea')`, 2500);
    }
    check(dialogUp, "Ctrl+Alt+L 弹出建表语句收录弹窗");
    await evaluate(ws, `(() => {
      const area = document.querySelector('.ddl-textarea');
      const set = ${nativeSet}; set(area, "CREATE TABLE ids_qn31_tab (\\n  id bigint NOT NULL COMMENT '主键',\\n  name varchar(64) COMMENT '名称;含分号'\\n) COMMENT='批测表';");
      return true;
    })()`);
    const recognized = await waitFor(ws, `(document.querySelector('.quick-capture-help')?.textContent ?? '').includes('1 张表')`, 5000);
    check(recognized, "粘贴后自动识别表名", await evaluate(ws, `document.querySelector('.quick-capture-help')?.textContent ?? ''`));
    await key(ws, { mod: CTRL, key: "Enter" }, "Enter", 13);
    const saved = await waitFor(ws, `(document.querySelector('.add-word-message')?.textContent ?? '').includes('已保存')`, 6000);
    check(saved, "收录成功提示（0.34.2 文案=已保存）", await evaluate(ws, `document.querySelector('.add-word-message')?.textContent ?? ''`));
    const ddlFile = join(vaultA, "数据库表DDL.md");
    let fileOk = false;
    for (let i = 0; i < 20 && !fileOk; i += 1) {
      fileOk = existsSync(ddlFile);
      if (!fileOk) await sleep(300);
    }
    check(fileOk, "仓库根出现「数据库表DDL.md」");
    if (fileOk) {
      const text = readFileSync(ddlFile, "utf8");
      check(text.includes("CREATE TABLE ids_qn31_tab") && text.includes("批测表"), "DDL 笔记含完整语句");
      check(text.includes("名称;含分号"), "COMMENT 里的分号未被截断");
    }
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);
  }

  // ============================================== 6. 表名悬浮预览
  {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn31对照')); t?.click(); return !!t; })()`);
    await waitFor(ws, `[...document.querySelectorAll('.cm-line')].some((el) => (el.innerText ?? '').includes('这张表'))`, 10000);
    await sleep(400);
    // 光标移到表名词上（多次 mousemove 模拟悬停；hoverTime 350ms）
    const wordPos = await evaluate(ws, `(() => {
      const view = window.__qnView;
      if (!view) return null;
      const doc = view.state.doc.toString();
      const lineNo = doc.split('\\n').findIndex((l) => l.includes('ids_qn31_tab'));
      const lineText = doc.split('\\n')[lineNo];
      const at = view.state.doc.line(lineNo + 1).from + lineText.indexOf('ids_qn31_tab') + 4;
      const coords = view.coordsAtPos(at);
      if (!coords) return null;
      const host = view.dom.getBoundingClientRect();
      return { x: Math.round(coords.left - host.left + 30), y: Math.round((coords.top + coords.bottom) / 2 - host.top) };
    })()`);
    check(!!wordPos, "取到表名词的编辑器内坐标（__qnView 调试句柄）", JSON.stringify(wordPos));
    if (wordPos) {
      const scroller = await evaluate(ws, `(() => { const s = document.querySelector('.editor-host .cm-scroller'); const r = s.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
      const gx = scroller.x + wordPos.x;
      const gy = scroller.y + wordPos.y;
      for (let i = 0; i < 4; i += 1) {
        await mouse(ws, "mouseMoved", gx + i, gy);
        await sleep(120);
      }
      // tooltip 本体是 cm-tooltip cm-tooltip-hover，qn-ddl-tip 是它的内容子节点
      const tip = await waitFor(ws, `!!document.querySelector('.qn-ddl-tip')`, 4000);
      const head = await evaluate(ws, `document.querySelector('.qn-ddl-tip-head')?.textContent ?? ''`);
      // 0.34.2：悬浮卡直接可编辑——App 注入 saver 后是 textarea，只读 pre 只在无 saver 时出现
      const body = await evaluate(ws, `(() => {
        const input = document.querySelector('.qn-ddl-tip .qn-ddl-tip-input');
        if (input) return input.value;
        return document.querySelector('.qn-ddl-tip .qn-ddl-tip-pre')?.textContent ?? '';
      })()`);
      const editable = await evaluate(ws, `!!document.querySelector('.qn-ddl-tip .qn-ddl-tip-input') && !!document.querySelector('.qn-ddl-tip .qn-ddl-tip-save')`);
      check(tip && head.includes("ids_qn31_tab"), "悬停表名浮出建表语句卡（Table: 标题）", head);
      check(body.includes("CREATE TABLE") && body.includes("批测表"), "悬浮卡内容为完整 DDL", body.slice(0, 60));
      check(editable, "悬浮卡直接可编辑且有保存钮（0.34.2）");
      // 0.34.4 大面板：0.34.2 起 textarea 固有宽度只有 ~20 列，容器收缩适应
      // 缩成 ~200px 小窗；显式宽度后这里量的是根节点（CM 会把它包进
      // cm-tooltip-hover 外层）
      const wide = await evaluate(ws, `(() => { const t = document.querySelector('.qn-ddl-tip'); return t ? Math.round(t.getBoundingClientRect().width) : 0; })()`);
      check(wide > 500, `悬浮卡大面板宽度（0.34.4，实际 ${wide}px）`, String(wide));
    }
  }

  // ============================================== 7. 阅读位置记忆
  {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn31长文')); t?.click(); return !!t; })()`);
    await waitFor(ws, `[...document.querySelectorAll('.cm-line')].some((el) => (el.innerText ?? '').includes('第 100 行')) || document.querySelectorAll('.cm-line').length > 50`, 10000);
    await sleep(600);
    await evaluate(ws, `(() => { const s = document.querySelector('.editor-host .cm-scroller'); s.scrollTop = 1600; s.dispatchEvent(new Event('scroll')); return s.scrollTop; })()`);
    // 防抖 800ms + 余量落库
    const stored = await waitFor(ws, `(() => { try { const db = JSON.parse(localStorage.getItem('quicknote.readprogress.v1') ?? '{}'); const bucket = db[Object.keys(db).find((k) => k.includes('主库A')) ?? '']; return Object.values(bucket ?? {}).some((v) => v > 1000); } catch { return false; } })()`, 5000);
    check(stored, "滚动停止后阅读位置落库（localStorage）");
    // 关标签重开：恢复位置
    await evaluate(ws, `(() => { const btn = [...document.querySelectorAll('.tabbar [role="tab"], .tabbar .tab')].find((el) => (el.textContent ?? '').includes('qn31长文'))?.querySelector('.tab-close, button[title*="关闭"]'); btn?.click(); return !!btn; })()`);
    await waitFor(ws, `!document.querySelector('.cm-lp-tablewrap') && document.querySelectorAll('.cm-line').length < 5`, 5000).catch(() => {});
    await sleep(400);
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn31长文')); t?.click(); return !!t; })()`);
    await waitFor(ws, `document.querySelectorAll('.cm-line').length > 50`, 10000);
    await sleep(900); // 两帧校正 + 状态稳定
    const resumed = await evaluate(ws, `(() => { const s = document.querySelector('.editor-host .cm-scroller'); return Math.round(s.scrollTop); })()`);
    check(resumed > 1000, `重开恢复到上次阅读位置（scrollTop=${resumed}）`, String(resumed));
  }

  // ============================================== 8. 空状态背景图（欢迎页不再纯黑）
  {
    // 开背景图：设置 → 背景。直接走 localStorage 的 per-vault 设置 + reload 最稳
    await evaluate(ws, `(() => {
      const key = 'quicknote.settings';
      const s = JSON.parse(localStorage.getItem(key) ?? '{}');
      const vault = Object.keys(JSON.parse(localStorage.getItem('quicknote.readprogress.v1') ?? '{}')).find((k) => k.includes('主库A'));
      s.bgEnabled = true; s.bgImagePath = 'qn31bg.png'; s.bgOpacity = 0.9; s.bgSurface = 60;
      localStorage.setItem(key, JSON.stringify(s));
      return vault;
    })()`);
    await evaluate(ws, `location.reload()`);
    await sleep(2500);
    // 重新连接（reload 会断 ws）
    try { ws.close(); } catch {}
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("ws 重连失败")), { once: true });
    });
    await cdp(ws, "Page.bringToFront");
    await waitFor(ws, `document.documentElement.classList.contains('qn-bg-on')`, 15000);
    // 关掉所有标签 → 空状态
    await evaluate(ws, `(() => {
      const tabs = [...document.querySelectorAll('.tabbar [role="tab"], .tabbar .tab')];
      for (const tab of tabs) tab.querySelector('.tab-close, button[title*="关闭"]')?.click();
      return tabs.length;
    })()`);
    const emptyUp = await waitFor(ws, `!!document.querySelector('.editor-empty')`, 5000);
    check(emptyUp, "关闭全部标签后空状态出现");
    const bg = await evaluate(ws, `(() => {
      const el = document.querySelector('.editor-empty');
      const cs = getComputedStyle(el);
      const layer = document.getElementById('qn-bg-layer');
      return { color: cs.backgroundColor, hasLayer: !!layer, layerOpacity: layer ? getComputedStyle(layer).opacity : null };
    })()`);
    check(bg.color === "rgba(0, 0, 0, 0)", "空状态底色透明（qn-bg-on 下背景透出，0.31）", JSON.stringify(bg));
    check(bg.hasLayer && Number(bg.layerOpacity) > 0.5, "背景图层在欢迎页可见", JSON.stringify(bg));
  }

  // ============================================== 9. 关闭回写仓库 + 重启恢复
  {
    // a) 回写语义：KEY 被污染成别的仓库，关闭（beforeunload）应把它纠正回
    //    **本窗口当前仓库**（0.31 修复：多窗口下重启恢复最后所在窗口的仓库）
    const polluted = await evaluate(ws, `(() => { localStorage.setItem('quicknote.vault', ${JSON.stringify(vaultB)}); return localStorage.getItem('quicknote.vault'); })()`);
    check(polluted === vaultB, "先污染 VAULT_KEY 为副库B");
    await closeGracefully(ws); // window.close() → beforeunload 回写主库A
    try { ws.close(); } catch {}
    child.kill();
    await sleep(1500);
    try { rmSync(join(udf, "SingletonLock"), { force: true }); } catch {}

    const second = await bootAndConnect(null);
    child = second.child;
    ws = second.ws;
    const backToA = await waitFor(ws, `[...document.querySelectorAll('.tree-item')].some((el) => (el.textContent ?? '').includes('qn31表格'))`, 12000);
    check(backToA, "关闭回写生效：污染值被纠正，重启回到主库A（最后所在仓库）");

    // b) 恢复语义：上次最后所在仓库是副库B（直接 kill 不触发回写 = 模拟外部
    //    写入的 KEY），重启后进入副库B
    await evaluate(ws, `(() => { localStorage.setItem('quicknote.vault', ${JSON.stringify(vaultB)}); return true; })()`);
    try { ws.close(); } catch {}
    child.kill(); // 直接杀：不触发 beforeunload，KEY 保持副库B
    await sleep(1500);
    try { rmSync(join(udf, "SingletonLock"), { force: true }); } catch {}

    const third = await bootAndConnect(null);
    child = third.child;
    ws = third.ws;
    const treeHasB = await waitFor(ws, `[...document.querySelectorAll('.tree-item')].some((el) => (el.textContent ?? '').includes('副库笔记'))`, 12000);
    check(treeHasB, "重启恢复 VAULT_KEY 记录的仓库（副库B）");
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

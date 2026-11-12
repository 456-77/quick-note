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

import { mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as XLSX from "xlsx";

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
// Excel 预览 + 列筛选夹具（0.39：两列三行，部门列用于筛选）
{
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["姓名", "部门"],
    ["张三", "研发"],
    ["李四", "财务"],
    ["王五", "研发"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "人员");
  XLSX.writeFile(wb, join(vaultA, "qn31表格.xlsx"));
}
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
      // 0.34.5 关键字高亮：着色层垫底（qn-sql-kw 关键字 token）
      const hlOk = await evaluate(ws, `!!document.querySelector('.qn-ddl-tip .qn-ddl-tip-hl .qn-sql-kw')`);
      check(hlOk, "悬浮卡着色层有关键字高亮（0.34.5）");
      // ---- 0.38 用户反馈批：表 comment / 内容搜索 / 点击不放大 ----
      const cmt = await evaluate(ws, `document.querySelector('.qn-ddl-tip-comment')?.textContent ?? ''`);
      check(cmt.includes("批测表"), "标题行展示表级 COMMENT（0.38）", cmt);
      const searchUp = await evaluate(ws, `(() => {
        const s = document.querySelector('.qn-ddl-tip-search');
        if (!s) return false;
        const set = ${nativeSet}; set(s, "主键");
        return true;
      })()`);
      await sleep(250);
      const hitN = await evaluate(ws, `document.querySelectorAll('.qn-ddl-tip .qn-ddl-tip-hl .qn-sql-hit').length`);
      check(searchUp && hitN >= 1, `弹窗内容搜索 → 着色层垫出 ${hitN} 处命中高亮（0.38）`, String(hitN));
      const hitsInfo = await evaluate(ws, `document.querySelector('.qn-ddl-tip-hits')?.textContent ?? ''`);
      check(/^\d+\/\d+$/.test(hitsInfo), "命中计数显示（当前/共几处，0.38）", hitsInfo);
      await evaluate(ws, `(() => { const s = document.querySelector('.qn-ddl-tip-search'); if (s) { const set = ${nativeSet}; set(s, ""); } return true; })()`);
      await sleep(150);
      // 0.34.5 编辑态锁：聚焦即脱管为 body 浮层 + 打编辑态标记
      const sizeBefore = await evaluate(ws, `(() => { const t = document.querySelector('.qn-ddl-tip'); const r = t.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      // 0.38.1 用户反馈「点击 ↑↓ 按钮弹窗直接消失」：弹窗内任何 mousedown 先脱管
      // （捕获阶段），CM 收起的只是空壳。先验 mousedown 路径（真实点击按钮的通道）
      const mdDetach = await evaluate(ws, `(() => {
        const tip = document.querySelector('.qn-ddl-tip');
        tip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return { detached: tip.classList.contains('qn-ddl-detached'), inBody: tip.parentElement === document.body };
      })()`);
      check(mdDetach.detached && mdDetach.inBody, "弹窗内 mousedown 即脱管（0.38.1 点击按钮不再消失）", JSON.stringify(mdDetach));
      const sizeAfterMd = await evaluate(ws, `(() => { const t = document.querySelector('.qn-ddl-tip'); const r = t.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      check(Math.abs(sizeBefore.w - sizeAfterMd.w) <= 2 && Math.abs(sizeBefore.h - sizeAfterMd.h) <= 2, `mousedown 脱管前后尺寸一致（0.38.1：${sizeBefore.w}x${sizeBefore.h} → ${sizeAfterMd.w}x${sizeAfterMd.h}）`);
      // 浮层已脱管：focus 路径重入（detached 已置位）→ 只补编辑态标记（0.34.5 原断言链）
      const focusInfo = await evaluate(ws, `(() => {
        const tip = document.querySelector('.qn-ddl-tip');
        const input = tip?.querySelector('.qn-ddl-tip-input');
        input?.focus();
        return { detached: tip?.classList.contains('qn-ddl-detached') ?? false, editing: tip?.classList.contains('qn-ddl-editing') ?? false, inBody: tip?.parentElement === document.body };
      })()`);
      check(focusInfo.detached && focusInfo.editing && focusInfo.inBody, "聚焦即脱管为编辑浮层并打编辑态标记（0.34.5）", JSON.stringify(focusInfo));
      // 0.38 用户反馈「点击后弹窗为什么要变化，直接用悬浮时的弹窗不行吗」：
      // 脱管时钉死当前尺寸——点击前后宽高一致
      const sizeAfter = await evaluate(ws, `(() => { const t = document.querySelector('.qn-ddl-tip'); const r = t.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      const sizeSame = Math.abs(sizeBefore.w - sizeAfter.w) <= 2 && Math.abs(sizeBefore.h - sizeAfter.h) <= 2;
      check(sizeSame, `点击编辑不改变弹窗尺寸（0.38：${sizeBefore.w}x${sizeBefore.h} → ${sizeAfter.w}x${sizeAfter.h}）`, JSON.stringify({ sizeBefore, sizeAfter }));
      // 编辑态下滚动编辑器不收起
      await evaluate(ws, `(() => { document.querySelector('.editor-host .cm-scroller')?.dispatchEvent(new Event('scroll')); return true; })()`);
      await sleep(400);
      const aliveOnScroll = await evaluate(ws, `!!document.querySelector('.qn-ddl-tip.qn-ddl-editing')`);
      check(aliveOnScroll, "编辑态下滚动不收起（0.34.5）");
      // 点弹窗外部收起
      await evaluate(ws, `document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
      await sleep(300);
      const goneAfterOutside = await evaluate(ws, `!document.querySelector('.qn-ddl-tip')`);
      check(goneAfterOutside, "编辑态点弹窗外部收起（0.34.5）");
    }
  }

  // ============================================== 6b. 多项目语句库（0.34.13：收录带项目 + Java 实体 + 弹窗项目切换）
  {
    // 1) 收录弹窗带项目：粘贴 Java 类 + 项目「测试项目A」→ 自动路由进实体库落盘
    await key(ws, { mod: CTRL_ALT, key: "j" }, "KeyJ", 74);
    let dlg2 = await waitFor(ws, `!!document.querySelector('.ddl-textarea')`, 2500);
    for (let i = 0; i < 3 && !dlg2; i += 1) {
      await key(ws, { mod: CTRL_ALT, key: "j" }, "KeyJ", 74);
      dlg2 = await waitFor(ws, `!!document.querySelector('.ddl-textarea')`, 2500);
    }
    check(dlg2, "收录弹窗再次弹出（6b）");
    await evaluate(ws, `(() => {
      const set = ${nativeSet};
      set(document.querySelector('.ddl-textarea'), "public class Qn31User {\\n  private Long id; // 主键\\n}");
      set(document.querySelector('.ddl-project-row input'), "测试项目A");
      return true;
    })()`);
    const recognizedJava = await waitFor(ws, `(document.querySelector('.quick-capture-help')?.textContent ?? '').includes('1 个类')`, 5000);
    check(recognizedJava, "粘贴类源码自动识别（双库路由 0.34.13）", await evaluate(ws, `document.querySelector('.quick-capture-help')?.textContent ?? ''`));
    await key(ws, { mod: CTRL, key: "Enter" }, "Enter", 13);
    const savedJava = await waitFor(ws, `(document.querySelector('.add-word-message')?.textContent ?? '').includes('已保存')`, 6000);
    check(savedJava, "类收录成功", await evaluate(ws, `document.querySelector('.add-word-message')?.textContent ?? ''`));
    const javaFile = join(vaultA, "Java实体.md");
    let javaOk = false;
    let javaText = "";
    for (let i = 0; i < 20 && !javaOk; i += 1) {
      javaOk = existsSync(javaFile);
      if (javaOk) {
        javaText = readFileSync(javaFile, "utf8");
        javaOk = javaText.includes("## 测试项目A") && javaText.includes("public class Qn31User");
      }
      if (!javaOk) await sleep(300);
    }
    check(javaOk, "Java实体.md 落盘且带 ## 测试项目A 段落", javaText.slice(0, 80));
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);

    // 2) 悬浮类名 → Class: 卡（java 高亮）
    const inserted = await evaluate(ws, `(() => {
      const view = window.__qnView;
      if (!view) return false;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\\n\\n实体类 Qn31User 悬停试卡。" } });
      return true;
    })()`);
    await sleep(500);
    const classPos = await evaluate(ws, `(() => {
      const view = window.__qnView;
      if (!view) return null;
      const doc = view.state.doc.toString();
      const lineNo = doc.split('\\n').findIndex((l) => l.includes('Qn31User'));
      if (lineNo < 0) return null;
      const lineText = doc.split('\\n')[lineNo];
      const at = view.state.doc.line(lineNo + 1).from + lineText.indexOf('Qn31User') + 4;
      const coords = view.coordsAtPos(at);
      if (!coords) return null;
      const host = view.dom.getBoundingClientRect();
      return { x: Math.round(coords.left - host.left + 30), y: Math.round((coords.top + coords.bottom) / 2 - host.top) };
    })()`);
    if (inserted && classPos) {
      const scroller2 = await evaluate(ws, `(() => { const s = document.querySelector('.editor-host .cm-scroller'); const r = s.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
      for (let i = 0; i < 4; i += 1) {
        await mouse(ws, "mouseMoved", scroller2.x + classPos.x + i, scroller2.y + classPos.y);
        await sleep(120);
      }
      const classTip = await waitFor(ws, `!!document.querySelector('.qn-ddl-tip')`, 4000);
      const classHead = await evaluate(ws, `document.querySelector('.qn-ddl-tip-head')?.textContent ?? ''`);
      check(classTip && classHead.includes("Class: Qn31User"), "悬停类名浮出实体卡（Class: 标题）", classHead);
      // CM hoverTooltip 只认真实鼠标移出来收（body mousedown 对它无效）；
      // 大面板 46vh 会盖住表名区域，不收掉后面悬停表名永远打在弹窗上
      await mouse(ws, "mouseMoved", 6, 6);
      await waitFor(ws, `!document.querySelector('.qn-ddl-tip')`, 3000);
      await sleep(200);
    } else {
      check(false, "悬浮类名坐标取到（6b）", JSON.stringify({ inserted, classPos }));
    }

    // 3) 双项目 chips：往 DDL 库追加「测试项目B」段落（同表名），悬停出现切换 chips；
    //    给当前笔记打 #测试项目B 标签 → 默认选中 B（笔记标签指定项目）
    appendFileSync(join(vaultA, "数据库表DDL.md"), "\n## 测试项目B\n\n```sql\nCREATE TABLE ids_qn31_tab (\n  name varchar(10) COMMENT 'B项目版'\n);\n```\n");
    await evaluate(ws, `(() => {
      const view = window.__qnView;
      view?.dispatch({ changes: { from: 0, to: 0, insert: "标签行 #测试项目B\\n" } });
      return true;
    })()`);
    // 标签索引扫描（600ms 防抖）+ 文件监听重载库，等 chips 出现
    let chipsOk = false;
    for (let i = 0; i < 15 && !chipsOk; i += 1) {
      const wordPos2 = await evaluate(ws, `(() => {
        const view = window.__qnView;
        if (!view) return null;
        const doc = view.state.doc.toString();
        const lineNo = doc.split('\\n').findIndex((l) => l.includes('ids_qn31_tab'));
        if (lineNo < 0) return null;
        const lineText = doc.split('\\n')[lineNo];
        const at = view.state.doc.line(lineNo + 1).from + lineText.indexOf('ids_qn31_tab') + 4;
        const coords = view.coordsAtPos(at);
        if (!coords) return null;
        const host = view.dom.getBoundingClientRect();
        return { x: Math.round(coords.left - host.left + 30), y: Math.round((coords.top + coords.bottom) / 2 - host.top) };
      })()`);
      if (!wordPos2) { await sleep(600); continue; }
      const scroller3 = await evaluate(ws, `(() => { const s = document.querySelector('.editor-host .cm-scroller'); const r = s.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
      for (let k = 0; k < 4; k += 1) {
        await mouse(ws, "mouseMoved", scroller3.x + wordPos2.x + k, scroller3.y + wordPos2.y);
        await sleep(120);
      }
      // hoverTime 350ms：最后一次移动后弹窗要再等一个悬停周期才出现——必须
      // waitFor，否则检查跑在弹窗出现之前（门禁首跑踩中，永远差半拍）
      const tipUp = await waitFor(ws, `!!document.querySelector('.qn-ddl-tip')`, 4000);
      // 0.39.8：多项目切换从标题行下的 chips 行改为标题行内嵌下拉 select
      chipsOk = !!tipUp && await evaluate(ws, `document.querySelectorAll('.qn-ddl-tip-project-select option').length >= 2`);
      if (!chipsOk && i >= 12) {
        // 诊断：磁盘上的库文件 vs 页面里弹窗的实态（门禁排查用，不影响判定）
        const ddlOnDisk = readFileSync(join(vaultA, "数据库表DDL.md"), "utf8");
        const diag = await evaluate(ws, `({
          tip: !!document.querySelector('.qn-ddl-tip'),
          options: document.querySelectorAll('.qn-ddl-tip-project-select option').length,
          head: document.querySelector('.qn-ddl-tip-head')?.textContent ?? '',
          value: (document.querySelector('.qn-ddl-tip .qn-ddl-tip-input')?.value ?? '').slice(0, 60),
        })`);
        console.log(`  [diag i=${i}] 盘里含B段=${ddlOnDisk.includes("测试项目B")} 页面=${JSON.stringify(diag)}`);
      }
      if (!chipsOk) {
        // 收卡走真实鼠标移开（CM tooltip 不理 body mousedown），别让它盖住下一轮目标
        await mouse(ws, "mouseMoved", 6, 6);
        await waitFor(ws, `!document.querySelector('.qn-ddl-tip')`, 2500);
        await sleep(300);
      }
    }
    check(chipsOk, "同表名双项目时悬浮标题行出现项目切换下拉（0.39.8）");
    if (chipsOk) {
      const chipInfo = await evaluate(ws, `({
        labels: [...document.querySelectorAll('.qn-ddl-tip-project-select option')].map((c) => c.textContent),
        selected: document.querySelector('.qn-ddl-tip-project-select')?.selectedOptions?.[0]?.textContent ?? '',
        value: document.querySelector('.qn-ddl-tip .qn-ddl-tip-input')?.value ?? '',
      })`);
      // 默认选中：笔记刚打了 #测试项目B 标签 → 应落在 B（若标签索引还没扫到则退回第一条，这里两者都提示）
      check(chipInfo.labels.length >= 2, "下拉选项含两个项目", chipInfo.labels.join("|"));
      const bIndex = chipInfo.labels.findIndex((l) => l === "测试项目B");
      if (bIndex >= 0) {
        // 原生 select 用赋值 + change 事件切换（合成点击打不开弹层）
        await evaluate(ws, `(() => {
          const select = document.querySelector('.qn-ddl-tip-project-select');
          if (!select) return false;
          select.value = String(${bIndex});
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await sleep(300);
        const switched = await evaluate(ws, `document.querySelector('.qn-ddl-tip .qn-ddl-tip-input')?.value ?? ''`);
        check(switched.includes("B项目版"), "切换下拉切到对应项目的语句", switched.slice(0, 50));
      }
      await mouse(ws, "mouseMoved", 6, 6);
      await waitFor(ws, `!document.querySelector('.qn-ddl-tip')`, 3000);
      await sleep(200);
    }
  }

  // ============================================== 6c. 语句库整页（0.39：完全复用 Inbox 的 cm-* 面板）
  {
    await key(ws, { mod: CTRL_ALT, key: 'k' }, 'KeyK', 75);
    const mgrPage = await waitFor(ws, `!!document.querySelector('.cm-root.lib-page')`, 3000);
    check(mgrPage, '语句库以 Inbox 式整页打开（0.39）');
    const noShell = await evaluate(ws, `!document.querySelector('.tab-special') && !document.querySelector('.ddl-manager-page')`);
    check(noShell, '不占标签页外壳，旧 ddl-manager-page 设计已移除');
    const notesHidden = await evaluate(ws, `!!document.querySelector('.editor-pane-notes.is-hidden')`);
    check(notesHidden, '整页打开时笔记区 display:none 隐藏（不卸载）');
    const headInfo = await evaluate(ws, `({
      title: document.querySelector('.lib-page .cm-title')?.textContent ?? '',
      subtitle: document.querySelector('.lib-page .cm-subtitle')?.textContent ?? '',
      segs: [...document.querySelectorAll('.lib-page .cm-seg-btn')].map((b) => b.textContent),
    })`);
    check(headInfo.title.includes('语句库') && headInfo.subtitle.includes('数据表'), 'Inbox 同款页头（标题 / 副标题）', JSON.stringify(headInfo));
    check(headInfo.segs.some((s) => s.includes('数据表')) && headInfo.segs.some((s) => s.includes('Java 实体')), 'cm-seg 分段含 数据表 / Java 实体', headInfo.segs.join('|'));
    const ddlOn = await evaluate(ws, `[...document.querySelectorAll('.lib-page .cm-seg-btn')].find((b) => b.textContent.includes('数据表'))?.classList.contains('is-on') ?? false`);
    check(ddlOn, '默认选中「数据表」分段');
    const ddlRows = await evaluate(ws, `document.querySelectorAll('.lib-page .cm-row').length`);
    check(ddlRows >= 2, '数据表库列出两条（6b 收录 + 测试项目B 同名）', String(ddlRows));
    const rowInfo = await evaluate(ws, `[...document.querySelectorAll('.lib-page .cm-row')].map((r) => ({
      name: r.querySelector('.lib-row-name')?.textContent ?? '',
      preview: r.querySelector('.lib-row-preview')?.textContent ?? '',
      tags: [...r.querySelectorAll('.cm-tag')].map((t) => t.textContent),
      time: r.querySelector('.cm-row-time')?.textContent ?? '',
      hasCheck: !!r.querySelector('.cm-check'),
    }))`);
    check(rowInfo.every((r) => r.hasCheck && r.name.includes('ids_qn31_tab') && r.preview.includes('CREATE TABLE')), 'Inbox 同款行：勾选框 + 表名 + 语句预览', JSON.stringify(rowInfo));
    check(rowInfo.some((r) => r.tags.some((t) => t.includes('测试项目B'))), '行内显示标签 chips', JSON.stringify(rowInfo.map((r) => r.tags)));
    check(rowInfo.every((r) => /^\d{2}:\d{2}$/.test(r.time)), '行上显示收录时间（@time 行，0.39 二轮）', JSON.stringify(rowInfo.map((r) => r.time)));
    // 工具栏四件套对齐速记：筛选 / 标签 / 日期 / 排序（0.39 二轮）
    const toolBtns = await evaluate(ws, `[...document.querySelectorAll('.lib-page .cm-toolbar .cm-tool-btn')].map((b) => b.textContent)`);
    check(['筛选', '标签', '日期', '排序'].every((label) => toolBtns.some((t) => t.includes(label))), '工具栏 筛选/标签/日期/排序 四件套（对齐速记）', toolBtns.join('|'));
    const groupPopUp = await evaluate(ws, `(() => { [...document.querySelectorAll('.lib-page .cm-toolbar .cm-tool-btn')].find((b) => b.textContent.includes('筛选'))?.click(); return true; })()`);
    await sleep(200);
    const groupPopRows = await evaluate(ws, `[...document.querySelectorAll('.lib-page .cm-pop .cm-pop-row')].map((r) => r.textContent)`);
    check(groupPopUp && groupPopRows.some((t) => t.includes('未分组')), '「筛选」弹层按分组列出（含未分组）', groupPopRows.join('|'));
    await evaluate(ws, `document.querySelector('.cm-pop-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(150);
    // Java 实体分段
    await evaluate(ws, `(() => { [...document.querySelectorAll('.lib-page .cm-seg-btn')].find((b) => b.textContent.includes('Java 实体'))?.click(); return true; })()`);
    await sleep(300);
    const javaInfo = await evaluate(ws, `({ rows: document.querySelectorAll('.lib-page .cm-row').length, name: document.querySelector('.lib-page .lib-row-name')?.textContent ?? '', on: [...document.querySelectorAll('.lib-page .cm-seg-btn')].find((b) => b.textContent.includes('Java 实体'))?.classList.contains('is-on') ?? false })`);
    check(javaInfo.rows === 1 && javaInfo.name === 'Qn31User' && javaInfo.on, '切换到 Java 实体分段（单独列出）', JSON.stringify(javaInfo));
    // 回数据表 + 标签筛选 popover（Inbox 同款 cm-pop）
    await evaluate(ws, `(() => { [...document.querySelectorAll('.lib-page .cm-seg-btn')].find((b) => b.textContent.includes('数据表'))?.click(); return true; })()`);
    await sleep(300);
    await evaluate(ws, `(() => { [...document.querySelectorAll('.lib-page .cm-toolbar .cm-tool-btn')].find((b) => b.textContent.includes('标签'))?.click(); return true; })()`);
    await sleep(200);
    const tagPop = await waitFor(ws, `!!document.querySelector('.lib-page .cm-pop')`, 2000).catch(() => false);
    check(tagPop, '「标签」筛选工具弹出 Inbox 同款 cm-pop（0.39）');
    const tagRows = await evaluate(ws, `[...document.querySelectorAll('.lib-page .cm-pop .cm-pop-row')].map((r) => r.textContent)`);
    check(tagRows.some((t) => t.includes('测试项目B')) && tagRows.some((t) => t.includes('无标签')), '标签弹层列出各标签 + 无标签计数', tagRows.join('|'));
    await evaluate(ws, `(() => { const row = [...document.querySelectorAll('.lib-page .cm-pop .cm-pop-row')].find((r) => r.textContent.includes('测试项目B')); row?.querySelector('input')?.click(); return true; })()`);
    await sleep(300);
    const onlyB = await evaluate(ws, `({ rows: document.querySelectorAll('.lib-page .cm-row').length, name: document.querySelector('.lib-page .lib-row-name')?.textContent ?? '', chips: [...document.querySelectorAll('.lib-page .cm-chip')].map((c) => c.textContent) })`);
    check(onlyB.rows === 1 && onlyB.name.includes('ids_qn31_tab') && onlyB.chips.some((c) => c.includes('测试项目B')), '标签多选筛选生效 + active chip 出现（0.39）', JSON.stringify(onlyB));
    // 关弹层 → 再开 → 取消勾选
    await evaluate(ws, `document.querySelector('.cm-pop-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(150);
    await evaluate(ws, `(() => { [...document.querySelectorAll('.lib-page .cm-toolbar .cm-tool-btn')].find((b) => b.textContent.includes('标签'))?.click(); return true; })()`);
    await sleep(150);
    await evaluate(ws, `(() => { const row = [...document.querySelectorAll('.lib-page .cm-pop .cm-pop-row')].find((r) => r.textContent.includes('测试项目B')); row?.querySelector('input')?.click(); return true; })()`);
    await sleep(250);
    await evaluate(ws, `document.querySelector('.cm-pop-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(150);
    const allBack = await evaluate(ws, `document.querySelectorAll('.lib-page .cm-row').length`);
    check(allBack >= 2, '取消标签筛选恢复全部行', String(allBack));
    // 行点击 → Inbox 同款详情抽屉；抽屉内加/删标签
    const openDrawer = await evaluate(ws, `(() => { const row = [...document.querySelectorAll('.lib-page .cm-row')].find((r) => r.textContent.includes('测试项目B')); row?.click(); return !!row; })()`);
    const drawerUp = await waitFor(ws, `!!document.querySelector('.lib-page .cm-drawer')`, 2000).catch(() => false);
    check(openDrawer && drawerUp, '点击行打开 cm-drawer 详情抽屉（0.39）');
    const drawerInfo = await evaluate(ws, `({
      title: document.querySelector('.lib-page .cm-drawer-title')?.textContent ?? '',
      fields: [...document.querySelectorAll('.lib-page .cm-drawer .cm-field-label')].map((el) => el.textContent),
      code: document.querySelector('.lib-page .lib-drawer-code')?.textContent ?? '',
      tags: [...document.querySelectorAll('.lib-page .cm-drawer .cm-tag')].map((el) => el.textContent),
    })`);
    check(drawerInfo.title.includes('ids_qn31_tab') && drawerInfo.fields.some((f) => f.includes('标签')) && drawerInfo.code.includes('CREATE TABLE'), '抽屉展示库 / 分组 / 标签 / 语句（0.39）', JSON.stringify(drawerInfo.fields));
    check(drawerInfo.fields.some((f) => f.includes('收录时间')), '抽屉展示收录时间（0.39 二轮）', JSON.stringify(drawerInfo.fields));
    const hlOk = await evaluate(ws, `(() => {
      const code = document.querySelector('.lib-page .lib-drawer-code');
      return { kw: !!code?.querySelector('.qn-sql-kw'), cmt: !!code?.querySelector('.qn-sql-cmt, .qn-sql-str') };
    })()`);
    check(hlOk.kw, '抽屉语句关键字高亮（tokenizeSql 与悬浮卡同款，0.39 二轮）', JSON.stringify(hlOk));
    check(drawerInfo.tags.some((t) => t.includes('测试项目B')), '抽屉预选当前标签（复用同一份 DDL 的起点）', drawerInfo.tags.join('|'));
    await evaluate(ws, `(() => { const i = document.querySelector('.lib-page .cm-drawer-tag-input'); i.focus(); const set = ${nativeSet}; set(i, "批测标签C"); return true; })()`);
    await sleep(150);
    await key(ws, { mod: 0, key: 'Enter' }, 'Enter', 13);
    const tagSaved = await waitFor(ws, `(document.querySelector('.lib-page .cm-toast')?.textContent ?? '').includes('标签')`, 6000).catch(() => false);
    check(tagSaved, '抽屉内 Enter 添加标签 → 落盘提示（0.39）', await evaluate(ws, `document.querySelector('.lib-page .cm-toast')?.textContent ?? ''`));
    await sleep(400);
    const ddlDisk1 = readFileSync(join(vaultA, "数据库表DDL.md"), "utf8");
    check(/- @tags: 测试项目B, 批测标签C/.test(ddlDisk1), '标签行落盘 -- @tags: 测试项目B, 批测标签C（0.39）', ddlDisk1.match(/@tags:[^\n]*/g)?.join(' | ') ?? '');
    // 抽屉里 × 移除刚加的标签
    const removeTag = await evaluate(ws, `(() => { const tag = [...document.querySelectorAll('.lib-page .cm-drawer .cm-tag')].find((el) => el.textContent.includes('批测标签C')); tag?.querySelector('.cm-tag-x')?.click(); return !!tag; })()`);
    const removed = await waitFor(ws, `![...document.querySelectorAll('.lib-page .cm-drawer .cm-tag')].some((el) => el.textContent.includes('批测标签C'))`, 4000).catch(() => false);
    check(removeTag && removed, '抽屉内 × 移除标签（0.39）', await evaluate(ws, `document.querySelector('.lib-page .cm-toast')?.textContent ?? ''`));
    await evaluate(ws, `document.querySelector('.lib-page .cm-drawer-head .cm-icon-btn')?.click()`);
    await sleep(250);
    // 行上「标签」按钮 = Inbox 同款行内输入框（0.39 二轮）
    const rowTagInput = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('.lib-page .cm-row')].find((r) => r.textContent.includes('测试项目B'));
      const btn = [...(row?.querySelectorAll('.cm-row-tool .cm-row-quick') ?? [])].find((b) => b.textContent.trim() === '标签');
      btn?.click();
      return !!document.querySelector('.lib-page .cm-row-tag-input');
    })()`);
    check(rowTagInput, '行上「标签」按钮出现行内输入框（对齐速记，0.39 二轮）');
    await evaluate(ws, `(() => { const i = document.querySelector('.lib-page .cm-row-tag-input'); i.focus(); const set = ${nativeSet}; set(i, "批测行内标签"); return true; })()`);
    await key(ws, { mod: 0, key: 'Enter' }, 'Enter', 13);
    const rowTagSaved = await waitFor(ws, `(document.querySelector('.lib-page .cm-toast')?.textContent ?? '').includes('批测行内标签')`, 6000).catch(() => false);
    check(rowTagSaved, '行内输入 Enter 添加标签 → 落盘（0.39 二轮）', await evaluate(ws, `document.querySelector('.lib-page .cm-toast')?.textContent ?? ''`));
    await sleep(300);
    const ddlDiskRow = readFileSync(join(vaultA, "数据库表DDL.md"), "utf8");
    check(/- @tags: .*批测行内标签/.test(ddlDiskRow), '行内标签落盘', ddlDiskRow.match(/@tags:[^\n]*/g)?.join(' | ') ?? '');
    await sleep(250);
    // 批量：勾选两条 → 批量栏（cm-toolbar.is-batch）→ 添加标签
    await evaluate(ws, `(() => { const boxes = [...document.querySelectorAll('.lib-page .cm-row .cm-check')].filter((b) => !b.checked); boxes[0]?.click(); return true; })()`);
    await sleep(150);
    await evaluate(ws, `(() => { const boxes = [...document.querySelectorAll('.lib-page .cm-row .cm-check')].filter((b) => !b.checked); boxes[0]?.click(); return true; })()`);
    await sleep(200);
    const batchUp = await waitFor(ws, `(document.querySelector('.lib-page .cm-toolbar.is-batch')?.textContent ?? '').includes('已选择 2 条')`, 3000).catch(() => false);
    check(batchUp, '勾选两条 → Inbox 同款批量栏（0.39）');
    await evaluate(ws, `(() => { [...document.querySelectorAll('.lib-page .cm-toolbar.is-batch .cm-btn')].find((b) => b.textContent.trim() === '添加标签')?.click(); return true; })()`);
    await sleep(150);
    const bulkInput = await waitFor(ws, `!!document.querySelector('.lib-page .cm-batch-tag-input')`, 2000).catch(() => false);
    check(bulkInput, '批量栏「添加标签」原位输入（Inbox 同款，0.39）');
    await evaluate(ws, `(() => { const i = document.querySelector('.lib-page .cm-batch-tag-input'); i.focus(); const set = ${nativeSet}; set(i, "批测批量标签"); return true; })()`);
    await key(ws, { mod: 0, key: 'Enter' }, 'Enter', 13);
    const bulkSaved = await waitFor(ws, `(document.querySelector('.lib-page .cm-toast')?.textContent ?? '').includes('添加标签')`, 6000).catch(() => false);
    check(bulkSaved, '批量添加标签成功（0.39）', await evaluate(ws, `document.querySelector('.lib-page .cm-toast')?.textContent ?? ''`));
    await sleep(300);
    const ddlDisk2 = readFileSync(join(vaultA, "数据库表DDL.md"), "utf8");
    const tagLines = ddlDisk2.match(/@tags:[^\n]*/g) ?? [];
    check(tagLines.filter((line) => line.includes('批测批量标签')).length === 2, '两条语句都写入批量标签（0.39）', tagLines.join(' | '));
    check(ddlDisk2.includes('## 测试项目B') && !ddlDisk2.includes('## 批测批量项目'), '标签操作不搬动语句 / 段落（0.39）');
    // Esc 回编辑器；Ctrl+Alt+K 再按开合
    await key(ws, { mod: 0, key: 'Escape' }, 'Escape', 27);
    const editorBack = await waitFor(ws, `!document.querySelector('.editor-pane-notes.is-hidden') && !document.querySelector('.lib-page')`, 2500);
    check(editorBack, 'Esc 回编辑器（笔记区恢复、整页退场）');
    await key(ws, { mod: CTRL_ALT, key: 'k' }, 'KeyK', 75);
    await waitFor(ws, `!!document.querySelector('.lib-page')`, 2500);
    await key(ws, { mod: CTRL_ALT, key: 'k' }, 'KeyK', 75);
    const toggledOff = await waitFor(ws, `!document.querySelector('.lib-page')`, 2500);
    check(toggledOff, 'Ctrl+Alt+K 再按一次 = 回编辑器（toggle 语义）');
  }

  // ============================================== 6d. Excel 预览 + 列筛选（0.39 用户反馈）
  {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn31表格.xlsx')); t?.click(); return !!t; })()`);
    const tableUp = await waitFor(ws, `document.querySelectorAll('.xlsx-table tbody tr').length >= 3`, 8000).catch(() => false);
    check(tableUp, "xlsx 预览渲染成表格（0.39 结构化预览）", await evaluate(ws, `document.querySelectorAll('.xlsx-table tbody tr').length`));
    const headText = await evaluate(ws, `[...document.querySelectorAll('.xlsx-table thead th')].map((th) => th.textContent.replace('▾', '').trim())`);
    check(headText.join(",").includes("姓名") && headText.join(",").includes("部门"), "表头显示（姓名 / 部门）", headText.join("|"));
    // 部门列 ▾ → 筛选面板
    const filterBtn = await evaluate(ws, `(() => {
      const ths = [...document.querySelectorAll('.xlsx-table thead th')];
      const th = ths.find((el) => el.textContent.includes('部门'));
      const b = th?.querySelector('.xlsx-filter-btn');
      b?.click();
      return !!b;
    })()`);
    await sleep(250);
    const popUp = await waitFor(ws, `!!document.querySelector('.xlsx-filter-pop')`, 2000).catch(() => false);
    check(filterBtn && popUp, "点表头 ▾ 打开列筛选面板（0.39）");
    // 取消「财务」→ 应用 → 只剩研发两行
    const uncheck = await evaluate(ws, `(() => {
      const label = [...document.querySelectorAll('.xlsx-filter-pop .xlsx-filter-value')].find((el) => el.textContent.includes('财务'));
      const box = label?.querySelector('input');
      if (!box) return false;
      box.click();
      return true;
    })()`);
    await evaluate(ws, `(() => { [...document.querySelectorAll('.xlsx-filter-pop button')].find((b) => b.textContent.trim() === '应用')?.click(); return true; })()`);
    await sleep(300);
    const after = await evaluate(ws, `({ rows: document.querySelectorAll('.xlsx-table tbody tr').length, chip: document.querySelector('.xlsx-filter-chip')?.textContent ?? '' })`);
    check(uncheck && after.rows === 2 && after.chip.includes('部门'), "列筛选生效：财务行被过滤 + 出现筛选 chip（0.39）", JSON.stringify(after));
    // 清除筛选恢复全部
    await evaluate(ws, `(() => { [...document.querySelectorAll('.xlsx-toolbar button')].find((b) => b.textContent.includes('清除筛选'))?.click(); return true; })()`);
    await sleep(250);
    const cleared = await evaluate(ws, `({ rows: document.querySelectorAll('.xlsx-table tbody tr').length, chips: document.querySelectorAll('.xlsx-filter-chip').length })`);
    check(cleared.rows === 3 && cleared.chips === 0, "清除筛选恢复全部行（0.39）", JSON.stringify(cleared));
    await key(ws, { mod: 0, key: 'Escape' }, 'Escape', 27);
    await sleep(500);
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

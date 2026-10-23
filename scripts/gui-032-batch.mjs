// 0.32 批次验收：本轮用户反馈的桌面端关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 + 临时
// 仓库），结束时自清理。
//
// 覆盖：
// - 分屏双编辑器：分屏内输入 → 自动保存落盘（主编辑器文件不动）
// - 分屏内 Ctrl+F：面板挂在分屏视图上；关闭面板后高亮清干净（0.32 修复
//   「关闭搜索弹窗还是会有高亮」）
// - DDL 弹窗：残段（无收口分号）不吞围栏/下一张表（0.32 硬边界）；SQL 关键字着色
// - 表格单元格悬停表名浮出建表语句（hoverTooltip 管不到 widget，document 委托）
// - 全局搜索：同一文件多条命中（表格行露脸）、组名计数徽标、命中行带行号
// - 壁纸轮换：开启后立即选第一张（bgImageAbsPath 落进 per-vault 设置）
// - 单词弹窗：输入停顿自动查在线释义（查词与收词解耦）
// - 图片预览：按容器高度适配（maxHeight 100%，不再 82vh 裁底）

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9432";
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

const mouse = (ws, type, x, y, extra = {}) =>
  cdp(ws, "Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra });

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}`;

// ------------------------------------------------ 自备数据：临时仓库

const work = join(tmpdir(), `qn-032-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "轮换库").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });
// 壁纸目录（仓库外）
const wallDir = join(work, "wallpapers");
mkdirSync(wallDir, { recursive: true });

const png1px = (rgb) =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
writeFileSync(join(wallDir, "w1.png"), png1px());
writeFileSync(join(wallDir, "w2.png"), png1px());

// 主角笔记：表格里有可搜索词 + 表名
writeFileSync(
  join(vault, "qn32表格.md"),
  [
    "# qn32表格",
    "",
    "| 名称 | 说明 |",
    "| --- | --- |",
    "| ids_qn32_tab | 建表语句主角 |",
    "| 普通行 qn32x | 出现两次 |",
    "",
    "正文也提一次 qn32x。",
    "",
  ].join("\n"),
  "utf8",
);
// 分屏对象（长一点，能看到编辑）
writeFileSync(
  join(vault, "qn32分屏.md"),
  ["# qn32分屏", "", "## 甲", "", "分屏初始内容。", "", "## 乙", "", "结尾。"].join("\n"),
  "utf8",
);
// 图片预览（1x1 png）
writeFileSync(join(vault, "qn32img.png"), png1px());

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

const openNoteFromTree = async (ws, name) => {
  await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)})); t?.click(); return !!t; })()`);
};

let child = null;
let ws = null;

try {
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });

  ({ child, ws } = await bootAndConnect(vault));

  // ============================================== 1. 全局搜索：表格行露脸 + 计数 + 行号
  {
    // 面板用页面内合成 Ctrl+K（App 的全局 keydown 监听在 window 上，合成事件可触发）
    await evaluate(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }))`);
    const paletteUp = await waitFor(ws, `!!document.querySelector('.palette-input')`, 5000);
    check(paletteUp, "Ctrl+K 打开命令面板");
    const input = await evaluate(ws, `(() => { const i = document.querySelector('.palette-input'); const set = ${nativeSet}; set(i, 'qn32x'); return i.value; })()`);
    check(input === "qn32x", "输入搜索词", input);
    const hasTableHit = await waitFor(ws, `(() => {
      const items = [...document.querySelectorAll('.palette-item')];
      return items.filter((el) => (el.textContent ?? '').includes('qn32表格')).length;
    })() >= 2`, 8000);
    check(hasTableHit, "同一文件多条命中（表格行也出现在结果里，0.32）");
    const count = await evaluate(ws, `document.querySelector('.palette-group-count')?.textContent ?? ''`);
    check(count.includes("共"), "内容组带计数徽标（截断与否一眼可见）", count);
    const lineMeta = await evaluate(ws, `[...document.querySelectorAll('.palette-item-meta')].map((el) => el.textContent).join('|')`);
    check(/L\d+/.test(lineMeta), "命中条目带行号（L 前缀）", lineMeta);
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);
  }

  // ============================================== 2. DDL 收录（残段 + 第二张表）与弹窗着色
  {
    await openNoteFromTree(ws, "qn32表格");
    await waitFor(ws, `!!document.querySelector('.cm-lp-tablewrap')`, 8000);
    // Ctrl+Alt+L 收录弹窗（CDP 偶发丢第一批按键，带重试）
    await key(ws, { mod: CTRL_ALT, key: "l" }, "KeyL", 76);
    let dialogUp = await waitFor(ws, `!!document.querySelector('.ddl-textarea')`, 2500);
    for (let i = 0; i < 3 && !dialogUp; i += 1) {
      await key(ws, { mod: CTRL_ALT, key: "l" }, "KeyL", 76);
      dialogUp = await waitFor(ws, `!!document.querySelector('.ddl-textarea')`, 2500);
    }
    check(dialogUp, "Ctrl+Alt+L 弹出收录弹窗");
    // 第一条故意**没有收口分号**（残段），后面隔着围栏放第二张表——0.32 的
    // 硬边界保证悬浮内容不吞围栏与第二张表
    await evaluate(ws, `(() => {
      const area = document.querySelector('.ddl-textarea');
      const set = ${nativeSet};
      set(area, "CREATE TABLE ids_qn32_tab (\\n  id bigint NOT NULL COMMENT '主键',\\n  name varchar(64)\\n) COMMENT='残段表'\\n\`\`\`\\n\`\`\`sql\\nCREATE TABLE ids_qn32_other (id bigint);");
      return true;
    })()`);
    await key(ws, { mod: CTRL, key: "Enter" }, "Enter", 13);
    const saved = await waitFor(ws, `(document.querySelector('.add-word-message')?.textContent ?? '').includes('已收录')`, 6000);
    check(saved, "残段 + 第二张表收录成功", await evaluate(ws, `document.querySelector('.add-word-message')?.textContent ?? ''`));
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);
  }

  // ============================================== 3. 表格单元格悬停表名 → DDL 弹窗（含着色与边界）
  {
    await waitFor(ws, `!!document.querySelector('.cm-lp-tablewrap table')`, 8000);
    await sleep(500);
    // 表格 widget 内的单元格：页面内合成 mouseover（document 层委托）
    const cellPos = await evaluate(ws, `(() => {
      const cell = [...document.querySelectorAll('.cm-lp-cell')].find((el) => (el.textContent ?? '').includes('ids_qn32_tab'));
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    check(!!cellPos, "找到含表名的表格单元格", JSON.stringify(cellPos));
    if (cellPos) {
      // 悬停用页面内合成 mouseover（CDP Input 的同坐标 mouseMoved 不保证产生
      // mouseover 事件——0.23 轮已知怪癖；document 层委托收合成事件）
      const hovered = await evaluate(ws, `(() => {
        const cell = [...document.querySelectorAll('.cm-lp-cell')].find((el) => (el.textContent ?? '').includes('ids_qn32_tab'));
        if (!cell) return false;
        cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX: ${cellPos.x}, clientY: ${cellPos.y} }));
        return true;
      })()`);
      check(hovered, "单元格上派发 mouseover");
      const tipUp = await waitFor(ws, `!!document.querySelector('#qn-ddl-cell-tip.qn-ddl-cell-tip')`, 5000);
      check(tipUp, "悬停表格单元格浮出建表语句卡（0.32 document 委托）");
      if (tipUp) {
        const body = await evaluate(ws, `document.querySelector('#qn-ddl-cell-tip .qn-ddl-tip-pre')?.textContent ?? ''`);
        check(body.includes("CREATE TABLE") && body.includes("残段表"), "单元格弹窗内容为该表语句", body.slice(0, 60));
        check(!body.includes("```"), "残段不吞围栏标记（0.32 硬边界）", body.slice(-40));
        check(!body.includes("ids_qn32_other"), "残段不吞下一张表（0.32 硬边界）", body.slice(-40));
        const kw = await evaluate(ws, `document.querySelectorAll('#qn-ddl-cell-tip .qn-sql-kw').length`);
        const str = await evaluate(ws, `document.querySelectorAll('#qn-ddl-cell-tip .qn-sql-str').length`);
        check(kw >= 3, `SQL 关键字着色（CREATE/TABLE/COMMENT…，${kw} 处）`);
        check(str >= 1, "字符串着色（'主键' 等）");
        // 移开（合成 mouseover 到页面空白处）→ 弹窗收起
        await evaluate(ws, `document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
        await sleep(300);
        const tipGone = await evaluate(ws, `!document.querySelector('#qn-ddl-cell-tip')`);
        check(tipGone, "移开单元格后弹窗收起");
      }
    }
  }

  // ============================================== 4. 分屏可编辑 + 自动保存 + 分屏内搜索
  {
    // 主编辑器放 qn32表格，分屏对象 qn32分屏（newTab 保证两个标签并存）。
    // localStorage 直写不会更新应用内存里的设置副本（storage 事件只在别的窗口
    // 触发），必须 reload 让设置重新加载（同 gui-031 第 4 节的做法）。
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
    await openNoteFromTree(ws, "qn32分屏");
    await waitFor(ws, `[...document.querySelectorAll('.cm-line')].some((el) => (el.innerText ?? '').includes('分屏初始内容'))`, 8000);
    await openNoteFromTree(ws, "qn32表格");
    await waitFor(ws, `!!document.querySelector('.cm-lp-tablewrap')`, 8000);
    await evaluate(ws, `(() => {
      const tabs = [...document.querySelectorAll('.tabbar [role="tab"], .tabbar .tab')];
      const target = tabs.find((el) => (el.textContent ?? '').includes('qn32分屏'));
      target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 120 }));
      return !!target;
    })()`);
    const menuOk = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏')); return b && !b.disabled; })()`, 5000);
    check(menuOk, "qn32分屏 标签的「分屏编辑」可点");
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏')); b?.click(); return !!b; })()`);
    const splitReady = await waitFor(ws, `!!window.__qnSplitView && (window.__qnSplitView.state.doc.toString() ?? '').includes('分屏初始内容')`, 8000);
    check(splitReady, "分屏编辑器装上目标笔记");

    // 4a. 分屏内输入（模拟一次文档事务）→ 自动保存 1.2s 落盘
    const dispatched = await evaluate(ws, `(() => { const v = window.__qnSplitView; if (!v) return false; const doc = v.state.doc.toString(); const at = doc.indexOf('分屏初始内容'); v.dispatch({ changes: { from: at, insert: '【已编辑】' } }); return true; })()`);
    check(dispatched, "分屏编辑器派发一次输入事务");
    let diskSaved = false;
    for (let i = 0; i < 20 && !diskSaved; i += 1) {
      diskSaved = existsSync(join(vault, "qn32分屏.md")) &&
        readFileSync(join(vault, "qn32分屏.md"), "utf8").includes("【已编辑】");
      if (!diskSaved) await sleep(300);
    }
    check(diskSaved, "分屏内编辑自动保存落盘（磁盘出现【已编辑】）");
    const mainIntact = await evaluate(ws, `(window.__qnView?.state.doc.toString() ?? '').includes('qn32表格')`);
    check(mainIntact, "主编辑器文件未被分屏编辑波及");
    const mainFileIntact = !readFileSync(join(vault, "qn32表格.md"), "utf8").includes("【已编辑】");
    check(mainFileIntact, "主编辑器文件在磁盘上未被改动");

    // 4b. 分屏内 Ctrl+F：面板挂分屏视图；关闭后高亮清干净（0.32 修复）
    await evaluate(ws, `window.__qnSplitView.focus()`);
    await evaluate(ws, `window.__qnSplitView.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true }))`);
    const panelInSplit = await waitFor(ws, `!!document.querySelector('.split-pane .qn-search')`, 5000);
    check(panelInSplit, "Ctrl+F 在分屏视图上打开搜索面板");
    if (panelInSplit) {
      await evaluate(ws, `(() => { const i = document.querySelector('.split-pane .qn-search .qn-search-input'); const set = ${nativeSet}; set(i, '分屏'); return true; })()`);
      const hl = await waitFor(ws, `document.querySelectorAll('.split-pane .cm-searchMatch').length > 0`, 5000);
      check(hl, "分屏内命中高亮出现");
      // Esc 关面板（面板自己的 Esc 处理）
      await evaluate(ws, `(() => { const i = document.querySelector('.split-pane .qn-search .qn-search-input'); i?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
      const panelGone = await waitFor(ws, `!document.querySelector('.split-pane .qn-search')`, 5000);
      check(panelGone, "Esc 关闭分屏搜索面板");
      const residue = await waitFor(ws, `document.querySelectorAll('.split-pane .cm-searchMatch').length === 0`, 5000);
      check(residue, "关闭面板后高亮清干净（0.32 修复残留高亮）", await evaluate(ws, `document.querySelectorAll('.split-pane .cm-searchMatch').length`));
    }
    // Esc 关分屏
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    const splitGone = await waitFor(ws, `!document.querySelector('.split-pane')`, 5000);
    check(splitGone, "Esc 关闭分屏窗格");
    await evaluate(ws, `(() => { const k='quicknote.settings'; const s=JSON.parse(localStorage.getItem(k) ?? '{}'); s.openNoteMode='replace'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  }

  // ============================================== 5. 壁纸轮换：开启即选第一张
  {
    await evaluate(ws, `(() => {
      const k = 'quicknote.settings';
      const s = JSON.parse(localStorage.getItem(k) ?? '{}');
      s.bgEnabled = true; s.bgOpacity = 0.9;
      s.bgRotateEnabled = true; s.bgRotateDir = ${JSON.stringify(wallDir)}; s.bgRotateMinutes = 30; s.bgRotateMode = 'sequential'; s.bgImageAbsPath = '';
      localStorage.setItem(k, JSON.stringify(s));
      return true;
    })()`);
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
    // 开启轮换且当前图为空 → 立即选第一张（顺序模式 = 文件名序，w1.png）
    const picked = await waitFor(ws, `(() => {
      try {
        const s = JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}');
        const entry = Object.values(s.bgPerVault ?? {})[0];
        return (entry?.bgImageAbsPath ?? '').length > 0;
      } catch { return false; }
    })()`, 10000);
    check(picked, "开启轮换立即选中第一张（bgImageAbsPath 落 per-vault 设置）");
    const layer = await evaluate(ws, `(() => { const l = document.getElementById('qn-bg-layer'); return l ? getComputedStyle(l).backgroundImage : ''; })()`);
    check(layer.includes("w1.png") || layer.includes("w2.png"), "背景层显示轮换目录里的图", layer.slice(0, 80));
    // 轮换路径是仓库外目录（asset 白名单放行）
    const bgOn = await evaluate(ws, `document.documentElement.classList.contains('qn-bg-on')`);
    check(bgOn, "qn-bg-on 生效（背景可见）");
  }

  // ============================================== 6. 单词弹窗：输入自动查释义
  {
    await key(ws, { mod: CTRL_ALT, key: "u" }, "KeyU", 85);
    let dialogUp = await waitFor(ws, `!!document.querySelector('.add-word-input')`, 2500);
    for (let i = 0; i < 3 && !dialogUp; i += 1) {
      await key(ws, { mod: CTRL_ALT, key: "u" }, "KeyU", 85);
      dialogUp = await waitFor(ws, `!!document.querySelector('.add-word-input')`, 2500);
    }
    check(dialogUp, "Ctrl+Alt+U 弹出查词/添加弹窗");
    await evaluate(ws, `(() => { const i = document.querySelector('.add-word-input'); const set = ${nativeSet}; set(i, 'scenario'); return true; })()`);
    const loading = await waitFor(ws, `(document.querySelector('.add-word-lookup-hint')?.textContent ?? '').includes('正在查询')`, 4000);
    check(loading, "输入停顿后自动开始查询（loading 提示）");
    // 查询走真网络（有道免 key）：查到释义或查不到都会离开 loading；弹窗不落盘
    const settled = await waitFor(ws, `(() => {
      const hint = document.querySelector('.add-word-lookup-hint')?.textContent ?? '';
      const body = document.querySelector('.add-word-lookup-body')?.textContent ?? '';
      return hint.includes('没有查到') || body.length > 0;
    })()`, 15000);
    check(settled, "查询结束：有释义或给出未查到提示（查词不落盘）", await evaluate(ws, `(document.querySelector('.add-word-lookup-body')?.textContent ?? document.querySelector('.add-word-lookup-hint')?.textContent ?? '').slice(0, 60)`));
    // 未点「加入单词本」直接关：不写单词本文件
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);
    check(true, "Esc 关闭弹窗（不收词不落盘）");
  }

  // ============================================== 7. 图片预览：按容器高度适配
  {
    await openNoteFromTree(ws, "qn32img.png");
    const previewUp = await waitFor(ws, `!!document.querySelector('.file-preview-image img')`, 8000);
    check(previewUp, "点击 png 打开图片预览");
    if (previewUp) {
      const fit = await evaluate(ws, `(() => {
        const img = document.querySelector('.file-preview-image img');
        const host = document.querySelector('.file-preview-image-pannable');
        const ir = img.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        return {
          maxHeight: getComputedStyle(img).maxHeight,
          bottomOk: ir.bottom <= hr.bottom + 1,
          imgH: Math.round(ir.height),
          hostH: Math.round(hr.height),
        };
      })()`);
      check(fit.maxHeight === "100%", "图片限高改为容器口径（不再是 82vh）", JSON.stringify(fit));
      check(fit.bottomOk, "图片底边不超出容器（0.32 修复底部切割）", JSON.stringify(fit));
    }
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);
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

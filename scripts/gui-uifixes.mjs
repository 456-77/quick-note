// GUI 端到端验证本次 UI 修复与新功能：
//   1. 编辑区 900px 居中（此前被 CM6 运行时注入的 margin:0 覆盖，整个编辑区靠左）
//   2. 代码块全出血背景左右对称
//   3. 表格外层不再常驻横向滚动条（滚动收进内层 .cm-tb-scroll）
//   4. 渲染态表格右键菜单：插入/删除行列，真实写回源码
//   5. 设置面板固定尺寸；背景图片下拉框；显示行号开关；Blue Topaz 渲染风格
//   6. 快捷键：捕获新绑定（Ctrl+J）并真实触发命令
//
// 前置：应用以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动。
// 用法：node scripts/gui-uifixes.mjs <vaultDir> [port]

import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const TARGET = "features.md";

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
  if (r.exceptionDetails) throw new Error(`页面内异常: ${r.exceptionDetails.text}`);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev2s = (ws, expression) =>
  cdp(ws, "Runtime.evaluate", { expression, returnByValue: true }).then((r) => r.result.value);



let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("未找到页面目标，请确认应用已启动并开启调试端口。");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener("open", res, { once: true }));
{
  // 后台窗口会被 Chromium 节流（React 提交/渲染延迟，读取到旧状态），先置前
  const t2 = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const p2t = t2.find((t) => t.type === "page");
  const ws2 = new WebSocket(p2t.webSocketDebuggerUrl);
  await new Promise((res) => ws2.addEventListener("open", res, { once: true }));
  ws2.send(JSON.stringify({ id: 999999, method: "Page.bringToFront" }));
  await new Promise((r) => setTimeout(r, 400));
  ws2.close();
  console.log("brought to front");
}
// 等文件树 → 打开 features.md → 光标移到文档最前（避开所有渲染块）
for (let i = 0; i < 40; i += 1) {
  if (await evaluate(ws, `document.querySelectorAll('.tree-file').length > 0`)) break;
  await sleep(250);
}
await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(TARGET)}); if (b) b.click(); return true; })()`,
);
await sleep(800);
await evaluate(
  ws,
  `(() => {
     const view = document.querySelector('.cm-content');
     view.focus();
     const sel = window.getSelection();
     const range = document.createRange();
     range.setStart(view, 0);
     range.collapse(true);
     sel.removeAllRanges();
     sel.addRange(range);
  })()`,
);
await sleep(400);
// 把代码块滚到视口中央：贴着折叠线的 widget 不会被 CM 物化，测量会拿到 undefined
await evaluate(
  ws,
  `(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(e => (e.innerText ?? '').includes('const answer'));
    const s = document.querySelector('.cm-scroller');
    if (line) s.scrollTop = Math.max(0, line.offsetTop - s.clientHeight / 2);
  })()`,
);
await sleep(600);

// ---------- 1 & 2. 居中 + 代码块全出血对称 ----------
const geo = await evaluate(
  ws,
  `(() => {
    const scroller = document.querySelector('.cm-scroller');
    const content = document.querySelector('.cm-content');
    const s = scroller.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const block = document.querySelector('.cm-lp-codeblock');
    const b = block ? block.getBoundingClientRect() : null;
    return {
      leftGap: Math.round(c.left - s.left),
      rightGap: Math.round(s.right - c.right),
      contentLeft: Math.round(c.left),
      contentWidth: Math.round(c.width),
      block: b ? { left: Math.round(b.left), width: Math.round(b.width) } : null,
    };
  })()`,
);
check(
  Math.abs(geo.leftGap - geo.rightGap) <= 30,
  `编辑区内容水平居中（左 ${geo.leftGap}px / 右 ${geo.rightGap}px）`,
);

// 代码框与正文同宽（0.5 起撤销「全出血」：背景带不再铺满编辑区），
// 且左缘与正文对齐。曾经 CM 运行时注入的 `.cm-line` padding 短语把这里的
// padding 与 margin 全部压掉，宽窗格下表现为背景带铺满、文本凸出正文——都被断言拦住。
check(
  geo.block
    ? Math.abs(geo.block.width - geo.contentWidth) <= 10 &&
        Math.abs(geo.block.left - geo.contentLeft) <= 8
    : false,
  `代码框与正文同宽且左缘对齐（框 ${geo.block?.width}px @${geo.block?.left} / 正文 ${geo.contentWidth}px @${geo.contentLeft}）`,
);

// ---------- 3. 表格滚动容器 ----------
const tableScroll = await evaluate(
  ws,
  `(() => {
    const wrap = document.querySelector('.cm-lp-tablewrap');
    if (!wrap) return null;
    const inner = wrap.querySelector('.cm-tb-scroll');
    return {
      wrapOverflow: getComputedStyle(wrap).overflowX,
      hasInnerScroll: !!inner,
      wrapHScroll: wrap.offsetWidth - wrap.clientWidth,
    };
  })()`,
);
check(
  tableScroll && tableScroll.wrapOverflow === "visible" && tableScroll.hasInnerScroll,
  "表格外层不再 overflow-x:auto（滚动收进 .cm-tb-scroll）",
);

// ---------- 4. 右键菜单删行/删列（真实鼠标） ----------
// 上游脚本（gui-sync）会留着开着的设置面板：它绝对定位在右侧、盖住表格区域，
// 右键会打在面板上而不是单元格上。表格测试前必须确保面板关闭。
await evaluate(
  ws,
  `(() => {
     if (document.querySelector('.settings-panel')) {
       document.querySelector('.settings-nav-head button, .settings-nav-head .icon-btn')?.click();
     }
     return true;
   })()`,
);
await sleep(400);

const rightClickCell = async (needle) => {
  const pos = await evaluate(
    ws,
    `(() => {
      const cell = [...document.querySelectorAll('.cm-lp-table th, .cm-lp-table td')].find(t => t.innerText.trim() === ${JSON.stringify(needle)});
      if (!cell) return null;
      cell.scrollIntoView({ block: 'center' });
      const r = cell.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  if (!pos) return false;
  await sleep(300);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp(ws, "Input.dispatchMouseEvent", { type, x: pos.x, y: pos.y, button: "right", clickCount: 1 });
  }
  await sleep(350);
  return true;
};
const clickMenuItem = async (label) =>
  evaluate(
    ws,
    `(() => {
      const btn = [...document.querySelectorAll('body > .context-menu button')].find(b => b.textContent === ${JSON.stringify(label)} && !b.disabled);
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
  );
const rowCount = () =>
  evaluate(ws, `document.querySelectorAll('.cm-lp-table tbody tr').length`);
const colCount = () =>
  evaluate(ws, `document.querySelectorAll('.cm-lp-table thead th').length`);

// 光标必须在表格之外（否则表格处于源码态，没有 widget 可点）
await evaluate(
  ws,
  `(() => {
     const view = document.querySelector('.cm-content');
     view.focus();
     const sel = window.getSelection();
     const range = document.createRange();
     range.setStart(view, 0);
     range.collapse(true);
     sel.removeAllRanges();
     sel.addRange(range);
  })()`,
);
await sleep(300);

const rowsBefore = await rowCount();
const opened = await rightClickCell("删除");
check(opened, "右键表格单元格弹出结构菜单");
check(await clickMenuItem("删除行"), "菜单含「删除行」");
await sleep(600);
const rowsAfter = await rowCount();
check(rowsAfter === rowsBefore - 1, `删除行写回源码（${rowsBefore} → ${rowsAfter} 行）`);
// 撤销，恢复 fixture
await evaluate(ws, `document.querySelector('.cm-content').focus()`);
await sleep(150);
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "z", windowsVirtualKeyCode: 90 });
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "z", windowsVirtualKeyCode: 90 });
await sleep(600);
check((await rowCount()) === rowsBefore, "Ctrl+Z 撤销删行");

const colsBefore = await colCount();
// 撤销后光标落在表格里（表格处于源码态），先点表格外中性位置再右键
await evaluate(
  ws,
  `(() => {
     const view = document.querySelector('.cm-content');
     view.focus();
     const line = [...document.querySelectorAll('.cm-line')].find(e => (e.innerText ?? '').includes('语法覆盖'));
     const sel = window.getSelection();
     const range = document.createRange();
     if (line) { range.setStart(line, 0); } else { range.selectNodeContents(view); range.collapse(true); }
     sel.removeAllRanges();
     sel.addRange(range);
  })()`,
);
await sleep(300);
// 重试最多 3 次：右键 → 菜单出现 → 点「删除列」；列数没变就重来
let deleted = false;
for (let attempt = 0; attempt < 3 && !deleted; attempt += 1) {
  // 光标在表格里时表格是源码态（没有 widget 可点）：先点表格外中性行
  await evaluate(
    ws,
    `(() => {
       const view = document.querySelector('.cm-content');
       const line = [...document.querySelectorAll('.cm-line')].find(e => (e.innerText ?? '').includes('语法覆盖'));
       if (!line) return;
       line.scrollIntoView({ block: 'center' });
       view.focus();
       const sel = window.getSelection();
       const range = document.createRange();
       range.setStart(line, 0);
       range.collapse(true);
       sel.removeAllRanges();
       sel.addRange(range);
    })()`,
  );
  await sleep(350);
  await rightClickCell("居中");
  await sleep(250);
  if (await clickMenuItem("删除列")) {
    await sleep(600);
    if ((await colCount()) === colsBefore - 1) deleted = true;
  }
  if (!deleted) {
    // 诊断：转储此刻的状态
    const dump = await ev2s(ws, `(() => ({
      attempt: ${attempt},
      hasWidget: !!document.querySelector('.cm-lp-table'),
      cols: document.querySelectorAll('.cm-lp-table thead th').length,
      menu: !!document.querySelector('body > .context-menu'),
      activeLine: document.querySelector('.cm-activeLine')?.innerText?.slice(0, 20) ?? null,
      cursorInTable: (() => {
        const sel = window.getSelection();
        if (!sel.rangeCount) return false;
        const n = sel.getRangeAt(0).startContainer;
        return !! (n.parentElement && n.parentElement.closest('.cm-lp-table'));
      })(),
    }))()`);
    console.log(`attempt ${attempt} 未生效:`, JSON.stringify(dump));
    // 收起可能残留的菜单，Esc 后重试
    await evaluate(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(250);
  }
}
check(deleted, "删除列写回源码");
await evaluate(ws, `document.querySelector('.cm-content').focus()`);
await sleep(150);
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "z", windowsVirtualKeyCode: 90 });
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "z", windowsVirtualKeyCode: 90 });
await sleep(600);
check((await colCount()) === colsBefore, "Ctrl+Z 撤销删列");

// 菜单保护：表头行不可删行
await rightClickCell("左对齐");
const headerRowDisabled = await evaluate(
  ws,
  `(() => {
    const btn = [...document.querySelectorAll('body > .context-menu button')].find(b => b.textContent === '删除行');
    return btn ? btn.disabled : null;
  })()`,
);
check(headerRowDisabled === true, "表头行的「删除行」置灰保护");
await evaluate(ws, `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`);
await sleep(200);

// ---------- 5. 设置面板 ----------
// 设置面板开合是「切换」语义：先看当前状态再决定点不点。套件里上游脚本
// （gui-sync）可能留着开着的面板，盲目点一下会把它关掉。
const ensureSettings = async (open) => {
  await evaluate(
    ws,
    `(() => {
       const isOpen = document.querySelector('.settings-panel') !== null;
       if (isOpen !== ${open ? "true" : "false"}) {
         document.querySelector('.topbar .icon-btn[title^="设置"]')?.click();
       }
       return true;
     })()`,
  );
  await sleep(400);
};

await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('快捷键')); if (b) b.click(); })()`,
);
await sleep(300);
// 若因上游残留而开在别的页，先关再按 ensure 流程重开到干净状态
await ensureSettings(false);
await ensureSettings(true);
await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('快捷键')); if (b) b.click(); })()`,
);
await sleep(300);
// 快捷键页对「固定尺寸」断言也成立（面板尺寸不随内容变化）
await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('外观')); if (b) b.click(); })()`,
);
await sleep(300);
const panelSize = () =>
  evaluate(
    ws,
    `(() => { const p = document.querySelector('.settings-panel'); const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`,
  );
const size1 = await panelSize();
await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('快捷键')); if (b) b.click(); })()`,
);
await sleep(300);
const size2 = await panelSize();
check(
  size1.w === size2.w && size1.h === size2.h && size1.w >= 500 && size1.h >= 400,
  `设置面板尺寸固定（${size1.w}×${size1.h}，切页不变）`,
);

await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('外观')); if (b) b.click(); })()`,
);
await sleep(300);
// 背景图片下拉框
const bgOptions = await evaluate(
  ws,
  `(() => {
    const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find(r => r.querySelector('span')?.textContent === '背景图片');
    const sel = row?.querySelector('select');
    return sel ? [...sel.options].filter(o => o.value).length : -1;
  })()`,
);
check(bgOptions > 0, `背景图片下拉框列出仓库图片（${bgOptions} 个候选）`);
// 行号开关
await evaluate(
  ws,
  `(() => {
    const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find(r => r.querySelector('span')?.textContent === '显示行号数字');
    row.querySelector('input[type=checkbox]').click();
  })()`,
);
await sleep(900);
const gutterOn = await evaluate(
  ws,
  `(() => {
    const g = document.querySelector('.cm-gutters');
    return g ? getComputedStyle(g).display : 'none';
  })()`,
);
check(gutterOn === "flex", "打开「显示行号数字」后 gutter 显示");
await evaluate(
  ws,
  `(() => {
    const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find(r => r.querySelector('span')?.textContent === '显示行号数字');
    row.querySelector('input[type=checkbox]').click();
  })()`,
);
await sleep(900);
const gutterOff = await evaluate(
  ws,
  `(() => {
    const g = document.querySelector('.cm-gutters');
    return g ? getComputedStyle(g).display : 'none';
  })()`,
);
check(gutterOff !== "flex", "关闭「显示行号数字」后 gutter 隐藏");
// Blue Topaz 渲染风格
await evaluate(
  ws,
  `(() => {
    const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find(r => r.querySelector('span')?.textContent === 'Markdown 渲染风格');
    const sel = row.querySelector('select');
    sel.value = 'blueTopaz';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`,
);
await sleep(400);
const btOn = await evaluate(ws, `document.documentElement.classList.contains('qn-style-bluetopaz')`);
await evaluate(
  ws,
  `(() => {
    document.querySelector('.settings-nav-head .icon-btn')?.click();
    // 光标离开第一行，H1 才会回到渲染态（挂 cm-lp-h1）
    const view = document.querySelector('.cm-content');
    view.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(view);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`,
);
await sleep(400);
const h1Color = await evaluate(
  ws,
  `(() => {
    const h = [...document.querySelectorAll('.cm-line')].find(e => e.classList.contains('cm-lp-h1'));
    return h ? getComputedStyle(h).color : null;
  })()`,
);
check(btOn && h1Color && h1Color !== "rgb(255, 255, 255)", `Blue Topaz 风格生效（H1 颜色 ${h1Color}）`);
// 切回默认
await ensureSettings(true);
await evaluate(
  ws,
  `(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('外观')); if (b) b.click();
    const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find(r => r.querySelector('span')?.textContent === 'Markdown 渲染风格');
    const sel = row.querySelector('select');
    sel.value = 'default';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.settings-nav-head .icon-btn')?.click();
  })()`,
);
await sleep(400);

// ---------- 6. 快捷键捕获 ----------
await ensureSettings(true);
await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('快捷键')); if (b) b.click(); })()`,
);
await sleep(300);
const addBtnClicked = await evaluate(
  ws,
  `(() => {
    const row = [...document.querySelectorAll('[data-sec="shortcuts"] .settings-row')].find(r => r.textContent.includes('新建今日日记'));
    const btn = row?.querySelector('.shortcut-add');
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
);
check(addBtnClicked, "未绑定命令显示「添加快捷键」入口");
await sleep(200);
check(!!(await evaluate(ws, `!!document.querySelector('.shortcut-capture')`)), "进入捕获态（按任意键组合…）");
// 真实键盘：Ctrl+J
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "j", windowsVirtualKeyCode: 74 });
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "j", windowsVirtualKeyCode: 74 });
await sleep(400);
const bound = await evaluate(
  ws,
  `(() => {
    const row = [...document.querySelectorAll('[data-sec="shortcuts"] .settings-row')].find(r => r.textContent.includes('新建今日日记'));
    return { text: row.textContent, hasReset: !!row.querySelector('.shortcut-reset') };
  })()`,
);
check(bound.text.includes("Ctrl J") && bound.hasReset, "捕获 Ctrl+J 写入绑定");
// 触发验证：Ctrl+J 应展开日记输入行
await evaluate(ws, `document.querySelector('.settings-nav-head .icon-btn')?.click()`);
await sleep(300);
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "j", windowsVirtualKeyCode: 74 });
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "j", windowsVirtualKeyCode: 74 });
await sleep(400);
check(
  !!(await evaluate(ws, `!!document.querySelector('.create-row input')`)),
  "重绑定后的 Ctrl+J 真实触发「新建今日日记」",
);
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });
await sleep(200);
// 恢复默认
await ensureSettings(true);
await evaluate(
  ws,
  `(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('快捷键')); if (b) b.click();
    const row = [...document.querySelectorAll('[data-sec="shortcuts"] .settings-row')].find(r => r.textContent.includes('新建今日日记'));
    row.querySelector('.shortcut-reset').click();
    document.querySelector('.settings-nav-head .icon-btn')?.click();
  })()`,
);
await sleep(300);
check(
  (await evaluate(ws, `localStorage.getItem('quicknote.hotkeys')`)) === null,
  "恢复默认后本机绑定清空",
);

// 清理：确保设置回到默认（行号关、默认风格），不留脏状态给后续步骤
await evaluate(
  ws,
  `(() => {
    const s = JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}');
    s.showLineNumbers = false; s.renderStyle = 'default';
    localStorage.setItem('quicknote.settings', JSON.stringify(s));
  })()`,
);

console.log(failures === 0 ? "\nUI 修复与新功能 GUI 验收全部通过 ✓" : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);

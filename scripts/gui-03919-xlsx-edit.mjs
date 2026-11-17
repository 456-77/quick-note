// 0.39.19 批测：Excel 预览单元格编辑（用户反馈「对于 excel 文件，添加功能：
// 可以编辑单元格内容」）。
//
// 覆盖链路：UI（双击/右键进入编辑）→ React 提交 → Tauri edit_xlsx_cell →
// zip/XML 外科手术 → calamine 校验 → 原子写盘 → 表格原地更新。
// 自起 gui-test 实例（独立 UDF + 临时仓库），结束时自清理；断言同时看 DOM 与磁盘。
import { mkdirSync, copyFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as XLSX from "xlsx";

const port = process.argv[2] ?? "9481";
const root = process.cwd();
// 默认走 verify-gui.sh 第 1 步构建的 release 变体；本地快速冒烟可用 QN_EXE 覆盖
// （debug 变体走 devUrl，需要先起 `npm run dev` 的 1420 端口）
const exe =
  process.env.QN_EXE ?? join(root, "src-tauri", "target", "release", "quick-note.exe");
if (!existsSync(exe)) {
  console.error(`找不到 ${exe}——先构建 gui-test 变体`);
  process.exit(2);
}
/** release 嵌入资源是 tauri.localhost；debug 走 devUrl 是 localhost:1420。 */
const isAppPage = (target) =>
  target.type === "page" &&
  (target.url.includes("tauri.localhost") || target.url.includes("localhost:1420"));

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
    throw new Error(
      `页面内异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`,
    );
  }
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
};

const waitFor = async (ws, expression, timeoutMs, pollMs = 250) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};

// ------------------------------------------------ 自备数据：临时仓库
const work = join(tmpdir(), `qn-xlsxedit-${Date.now()}`);
const vault = join(work, "表格编辑仓库").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });
const xlsxPath = join(vault, "测试表.xlsx");
copyFileSync(join(root, "src-tauri", "tests", "fixtures", "parse-sample.xlsx"), xlsxPath);

// 多行表：验证 Tab/Enter 移动 + SheetJS sharedStrings 单元格的改写
const navPath = join(vault, "导航表.xlsx");
const navWb = XLSX.utils.book_new();
const navWs = XLSX.utils.aoa_to_sheet([
  ["名称", "数量", "备注"],
  ["甲", 1, ""],
  ["乙", 2, ""],
  ["丙", 3, ""],
]);
XLSX.utils.book_append_sheet(navWb, navWs, "导航");
XLSX.writeFile(navWb, navPath);

const configDir = join(process.env.APPDATA ?? "", "com.quicknote.gui-test");
mkdirSync(configDir, { recursive: true });
// 共享 sync-state 残留会连旧桩端口，先清掉（0.27 起的坑）
for (const name of ["sync-state.json"]) {
  try {
    rmSync(join(configDir, name), { force: true });
  } catch {}
}
try {
  const entries = await import("node:fs").then((fs) => fs.readdirSync(configDir));
  for (const name of entries) {
    if (name.startsWith("sync-state-")) rmSync(join(configDir, name), { force: true });
  }
} catch {}

const child = spawn(exe, [vault], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: udf,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: "ignore",
  detached: false,
});

let ws = null;
try {
  // 启动就绪
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      ready = list.some(isAppPage);
    } catch {}
  }
  if (!ready) throw new Error("应用页面没有就绪");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find(isAppPage);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  for (let i = 0; i < 30; i += 1) {
    const docReady = await evaluate(
      ws,
      `(() => { try { localStorage.getItem('__qn_probe'); return (location.host === 'tauri.localhost' || location.port === '1420') && document.readyState !== 'loading'; } catch { return false; } })()`,
    ).catch(() => false);
    if (docReady) break;
    await sleep(500);
  }
  await waitFor(ws, `document.querySelectorAll('.tree-file').length > 0`, 20000);

  // ---- 打开表格
  const opened = await evaluate(
    ws,
    `(() => {
      const row = [...document.querySelectorAll('.tree-file')].find(
        (el) => el.querySelector('.tree-label')?.textContent === '测试表.xlsx',
      );
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`,
  );
  check(opened, "树里点开 测试表.xlsx");
  const tableUp = await waitFor(
    ws,
    `!!document.querySelector('.xlsx-table.is-fixed')`,
    30000,
  );
  check(tableUp, "表格渲染（列宽钉死）");

  const hint = await evaluate(
    ws,
    `document.querySelector('.xlsx-toolbar-note')?.textContent ?? ''`,
  );
  check(hint.includes("Enter 下移") && hint.includes("Tab 右移"), "工具栏出现编辑/导航提示", hint);

  const dbl = (selector) =>
    evaluate(
      ws,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        return true;
      })()`,
    );

  const editorValue = () =>
    evaluate(ws, `document.querySelector('.xlsx-cell-input')?.value ?? null`);

  /** 原生 setter + input 事件（React 受控输入必须走这一套），再按指定键提交。 */
  const typeAndKey = (text, key) =>
    evaluate(
      ws,
      `(() => {
        const input = document.querySelector('.xlsx-cell-input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }),
        );
        return true;
      })()`,
    );

  /** 只输入不提交（用于 blur 场景）。 */
  const typeOnly = (text) =>
    evaluate(
      ws,
      `(() => {
        const input = document.querySelector('.xlsx-cell-input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );

  /** 同一个任务里 input + blur（模拟输入法/极快切格，React state 可能滞后）。 */
  const typeAndBlur = (text) =>
    evaluate(
      ws,
      `(() => {
        const input = document.querySelector('.xlsx-cell-input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.blur();
        return true;
      })()`,
    );

  /** 真鼠标点击（CDP Input 域，走真实的 focus/blur 顺序）。 */
  const realClickCell = async (row, col) => {
    const point = await evaluate(
      ws,
      `(() => {
        const el = document.querySelector('.xlsx-table tbody td[data-row="${row}"][data-col="${col}"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
    );
    if (!point) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp(ws, "Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
    }
    return true;
  };

  /** 向当前焦点元素（td 或编辑输入框）派发按键。 */
  const pressKey = (key, shiftKey = false) =>
    evaluate(
      ws,
      `(() => {
        const el = document.activeElement;
        if (!el) return false;
        el.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ${JSON.stringify(key)},
            shiftKey: ${shiftKey},
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      })()`,
    );

  /** 当前焦点格 "row:col"（td 的 data-row/data-col），不是 td 时返回标签名。 */
  const activeCell = () =>
    evaluate(
      ws,
      `(() => {
        const el = document.activeElement;
        if (el?.tagName === 'TD') return el.dataset.row + ':' + el.dataset.col;
        return el?.tagName ?? 'none';
      })()`,
    );

  // ---- 1) 表头格 A1："文本" → "自动化"
  await dbl('.xlsx-table thead th[data-col="0"] .xlsx-th-label');
  check((await editorValue()) === "文本", "双击表头进入编辑且带原值", await editorValue());
  await typeAndKey("自动化", "Enter");
  const headerSaved = await waitFor(
    ws,
    `document.querySelector('.xlsx-table thead th[data-col="0"] .xlsx-th-label')?.textContent === '自动化'`,
    15000,
  );
  check(headerSaved, "表头编辑保存并原地更新");
  // watcher 静默重读后不能被旧值回冲
  await sleep(1800);
  const headerStable = await evaluate(
    ws,
    `document.querySelector('.xlsx-table thead th[data-col="0"] .xlsx-th-label')?.textContent ?? ''`,
  );
  check(headerStable === "自动化", "外部重读后仍显示新值", headerStable);

  // ---- 2) 数据格 F2（原为空）：插入新格 + 数字类型
  await dbl('.xlsx-table tbody td[data-row="1"][data-col="5"]');
  check((await editorValue()) === "", "双击空数据格进入编辑");
  await typeAndKey("3.75", "Enter");
  const bodySaved = await waitFor(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="5"]')?.textContent === '3.75'`,
    15000,
  );
  check(bodySaved, "空单元格插入并显示 3.75");

  // ---- 3) 日期格式格 B1："2025-01-21" → 输入 2025/2/3 仍是日期
  await dbl('.xlsx-table thead th[data-col="1"] .xlsx-th-label');
  check((await editorValue()) === "2025-01-21", "日期格带入显示值", await editorValue());
  await typeAndKey("2025/2/3", "Enter");
  const dateSaved = await waitFor(
    ws,
    `document.querySelector('.xlsx-table thead th[data-col="1"] .xlsx-th-label')?.textContent === '2025-02-03'`,
    15000,
  );
  check(dateSaved, "日期输入按原格式显示 2025-02-03");

  // ---- 3b) blur 提交：编辑文本后直接点别的单元格（用户反馈「编辑完切到
  // 其他单元格，刚才编辑的单元格显示空白」的复现路径）
  await dbl('.xlsx-table tbody td[data-row="1"][data-col="0"]');
  check((await editorValue()) === "合并区", "双击文本数据格带入原值", await editorValue());
  await typeOnly("点击提交的文本");
  await realClickCell(1, 5);
  const blurSaved = await waitFor(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="0"]')?.textContent === '点击提交的文本'`,
    15000,
  );
  const blurText = await evaluate(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="0"]')?.textContent ?? '(missing)'`,
  );
  check(blurSaved, "点击其他单元格（blur）提交文本", blurText);

  // ---- 4) Esc 取消：不落盘、不改显示
  await dbl('.xlsx-table tbody td[data-row="1"][data-col="5"]');
  await typeAndKey("不应保存", "Escape");
  const escaped = await waitFor(ws, `!document.querySelector('.xlsx-cell-input')`, 5000);
  check(escaped, "Esc 退出编辑框");
  const afterEsc = await evaluate(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="5"]')?.textContent ?? ''`,
  );
  check(afterEsc === "3.75", "Esc 取消不改变显示", afterEsc);

  // ---- 5) 右键菜单「编辑单元格」
  await evaluate(
    ws,
    `(() => {
      const el = document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="5"]');
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + 4, clientY: rect.top + 4,
      }));
      return true;
    })()`,
  );
  const menuUp = await waitFor(
    ws,
    `[...document.querySelectorAll('.context-menu button')].some((b) => b.textContent.trim() === '编辑单元格')`,
    3000,
  );
  check(menuUp, "右键菜单出现「编辑单元格」");
  await evaluate(
    ws,
    `(() => {
      [...document.querySelectorAll('.context-menu button')]
        .find((b) => b.textContent.trim() === '编辑单元格')?.click();
      return true;
    })()`,
  );
  const menuEdit = await waitFor(ws, `!!document.querySelector('.xlsx-cell-input')`, 3000);
  check(menuEdit, "菜单进入编辑框");
  await typeAndKey("3.75", "Escape");

  // ---- 6) Tab/Enter 单元格导航（多行表）
  await evaluate(
    ws,
    `(() => {
      const row = [...document.querySelectorAll('.tree-file')].find(
        (el) => el.querySelector('.tree-label')?.textContent === '导航表.xlsx',
      );
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`,
  );
  const navUp = await waitFor(
    ws,
    `[...document.querySelectorAll('.xlsx-table thead th')].some((th) => th.textContent.includes('名称'))`,
    20000,
  );
  check(navUp, "打开多行导航表");

  // B2 输入 10，Tab：保存并右移到 C2
  await dbl('.xlsx-table tbody td[data-row="1"][data-col="1"]');
  await typeAndKey("10", "Tab");
  const tabRight = await waitFor(ws, `document.activeElement?.tagName === 'TD' && document.activeElement.dataset.row === '1' && document.activeElement.dataset.col === '2'`, 10000);
  check(tabRight, "编辑中 Tab：保存并右移到 C2", await activeCell());
  const b2Text = await evaluate(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="1"]')?.textContent ?? ''`,
  );
  check(b2Text === "10", "Tab 保存的值显示为 10", b2Text);

  // C2（空）Tab：越过最后一列 → 下一行第一列 A3
  await pressKey("Tab");
  const wrapNext = await waitFor(ws, `document.activeElement?.dataset?.row === '2' && document.activeElement?.dataset?.col === '0'`, 5000);
  check(wrapNext, "行末 Tab 跳到下一行首列（A3）", await activeCell());

  // A3 Enter → A4；Shift+Enter → 回到 A3
  await pressKey("Enter");
  const enterDown = await waitFor(ws, `document.activeElement?.dataset?.row === '3' && document.activeElement?.dataset?.col === '0'`, 5000);
  check(enterDown, "选中格 Enter 下移到 A4", await activeCell());
  await pressKey("Enter", true);
  const shiftUp = await waitFor(ws, `document.activeElement?.dataset?.row === '2' && document.activeElement?.dataset?.col === '0'`, 5000);
  check(shiftUp, "Shift+Enter 上移回 A3", await activeCell());

  // A3 文本改成「乙改」，Enter 保存后落到 A4
  await dbl('.xlsx-table tbody td[data-row="2"][data-col="0"]');
  await typeAndKey("乙改", "Enter");
  const a3Saved = await waitFor(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="2"][data-col="0"]')?.textContent === '乙改'`,
    15000,
  );
  check(a3Saved, "Enter 保存文本 A3 = 乙改");
  const enterAfterSave = await waitFor(ws, `document.activeElement?.dataset?.row === '3' && document.activeElement?.dataset?.col === '0'`, 5000);
  check(enterAfterSave, "保存后 Enter 下移到 A4", await activeCell());

  // A2 文本改「甲改」，直接点 C2（blur 提交）
  await dbl('.xlsx-table tbody td[data-row="1"][data-col="0"]');
  await typeOnly("甲改");
  await realClickCell(1, 2);
  const a2Blur = await waitFor(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="0"]')?.textContent === '甲改'`,
    15000,
  );
  const a2Text = await evaluate(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="0"]')?.textContent ?? '(missing)'`,
  );
  check(a2Blur, "点击其他格（blur）提交文本 A2 = 甲改", a2Text);

  // ---- 6b) input + blur 同一任务：提交必须读输入框 DOM 值（state 可能滞后）
  await dbl('.xlsx-table tbody td[data-row="1"][data-col="2"]');
  await typeAndBlur("同步提交");
  const syncBlur = await waitFor(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="2"]')?.textContent === '同步提交'`,
    15000,
  );
  check(syncBlur, "input+blur 同任务仍提交 DOM 当前值");

  // ---- 7) 筛选下的行号映射（用户实锤：筛选后编辑读到/写到错误行，显示空白）
  await evaluate(
    ws,
    `(() => {
      const btn = document.querySelector('.xlsx-table thead th[data-col="0"] .xlsx-filter-btn');
      btn?.click();
      return !!btn;
    })()`,
  );
  await waitFor(ws, `!!document.querySelector('.xlsx-filter-pop')`, 3000);
  // 勾选状态是 React state，应用按钮必须等这一轮渲染落地后再点（同一任务里
  // 点完 checkbox 立刻点应用，读到的还是旧 chosen = 全选 = 不筛）
  await evaluate(
    ws,
    `(() => {
      for (const label of document.querySelectorAll('.xlsx-filter-pop .xlsx-filter-value')) {
        const text = label.querySelector('.xlsx-filter-value-text')?.textContent ?? '';
        // 只留「丙」（A2/A3 在前面步骤已被改成甲改/乙改）
        if (text !== '丙') label.querySelector('input')?.click();
      }
      return true;
    })()`,
  );
  await sleep(300);
  await evaluate(
    ws,
    `(() => {
      [...document.querySelectorAll('.xlsx-filter-pop button')]
        .find((b) => b.textContent.trim() === '应用')?.click();
      return true;
    })()`,
  );
  const oneRow = await waitFor(
    ws,
    `document.querySelectorAll('.xlsx-table tbody tr:not(.xlsx-vspacer)').length === 1`,
    5000,
  );
  const rowCountNow = await evaluate(
    ws,
    `document.querySelectorAll('.xlsx-table tbody tr:not(.xlsx-vspacer)').length`,
  );
  check(oneRow, "筛选到只剩 1 行（丙）", String(rowCountNow));
  await dbl('.xlsx-table tbody td[data-row="3"][data-col="1"]');
  const filteredValue = await editorValue();
  check(
    filteredValue === "3",
    "筛选后双击读到正确行（B4=3，不是 B2 的 10）",
    filteredValue,
  );
  await typeAndKey("30", "Enter");
  const filteredSaved = await waitFor(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="3"][data-col="1"]')?.textContent === '30'`,
    15000,
  );
  check(filteredSaved, "筛选行编辑保存并显示 30");
  await evaluate(ws, `document.querySelector('.xlsx-filter-chip-x')?.click()`);
  await waitFor(ws, `!document.querySelector('.xlsx-filter-chip')`, 3000);
  const b2After = await evaluate(
    ws,
    `document.querySelector('.xlsx-table tbody td[data-row="1"][data-col="1"]')?.textContent ?? '(missing)'`,
  );
  check(b2After === "10", "筛选编辑没有误写 B2（仍为 10）", b2After);

  // 导航表磁盘真值
  const navSheet = XLSX.read(readFileSync(navPath), { type: "buffer" }).Sheets["导航"];
  check(navSheet?.B2?.v === 10, "磁盘 B2 = 数字 10", JSON.stringify(navSheet?.B2));
  check(navSheet?.A2?.v === "甲改", "磁盘 A2 = 甲改", JSON.stringify(navSheet?.A2));
  check(navSheet?.A3?.v === "乙改", "磁盘 A3 = 乙改", JSON.stringify(navSheet?.A3));
  check(navSheet?.B4?.v === 30, "磁盘 B4 = 30（筛选编辑落对行）", JSON.stringify(navSheet?.B4));
  check(navSheet?.C2?.v === "同步提交", "磁盘 C2 = 同步提交", JSON.stringify(navSheet?.C2));

  // ---- 磁盘真值（SheetJS 独立读回）
  const wb = XLSX.read(readFileSync(xlsxPath), { type: "buffer" });
  const sheet = wb.Sheets["数据"];
  check(sheet?.A1?.v === "自动化", "磁盘 A1 = 自动化", JSON.stringify(sheet?.A1));
  check(
    sheet?.A2?.v === "点击提交的文本",
    "磁盘 A2 = 点击提交的文本（blur 提交）",
    JSON.stringify(sheet?.A2),
  );
  check(sheet?.F2?.v === 3.75 && sheet?.F2?.t === "n", "磁盘 F2 = 数字 3.75", JSON.stringify(sheet?.F2));
  check(
    sheet?.B1?.v === 45691 && sheet?.B1?.w === "2025-02-03",
    "磁盘 B1 = 日期序列 45691（仍按日期格式显示）",
    JSON.stringify(sheet?.B1),
  );

  // ---- 整体无错误提示
  const statusText = await evaluate(ws, `document.querySelector('.statusbar')?.textContent ?? ''`);
  check(!statusText.includes("保存失败"), "状态栏无保存失败提示", statusText);

  // 收尾：关闭预览标签（Esc 不应误触；这里直接点标签上的关闭钮）
  await evaluate(
    ws,
    `(() => {
      const tab = [...document.querySelectorAll('.tab, .preview-tab')].find(
        (el) => el.textContent.includes('测试表.xlsx'),
      );
      tab?.querySelector('.tab-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`,
  ).catch(() => {});
} catch (err) {
  failures += 1;
  console.error("✗ 批测异常:", err?.message ?? err);
} finally {
  try {
    ws?.close();
  } catch {}
  try {
    child.kill();
  } catch {}
  await sleep(800);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "\nXLSX 单元格编辑冒烟全部通过 ✓" : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);

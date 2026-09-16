// GUI 验证：多标签页与目录面板。
//
// 多标签的核心机制在 App 里：每个标签一份 EditorState（未保存内容/光标/撤销历史），
// 切换 = view.setState(存量状态)。这里验证的是这条机制的真实行为——
// 在标签 B 里键入不保存、切到 A 再切回来，内容必须还在；关 dirty 标签必须先落盘。
//
// 目录面板验证"标题提取 → 点击跳转"这条链路（提取逻辑本身在 verify-tables.mjs）。
//
// 前置：应用以 --remote-debugging-port 启动，仓库由 make-test-vault.sh 生成。
// 用法：node scripts/gui-tabs.mjs <vaultDir> [port]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";

const NOTE_A = "features.md";
const NOTE_B = "empty.md";
/** 在 B 里键入的标记（不保存，靠标签的 EditorState 存活）。 */
const MARKER = "ZZ_TAB_MARKER";
const OUTLINE_NOTE = "日记/2026-W37 周记.md"; // fixture 里有 H1 标题

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
  const r = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(`页面内异常: ${r.exceptionDetails.text}`);
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

/** 点击文件树里的某个笔记（真实鼠标事件）。 */
async function openNote(ws, path) {
  const ok = await evaluate(
    ws,
    `(() => {
       const row = [...document.querySelectorAll('.tree-file')].find(e => e.title === ${JSON.stringify(path)});
       if (!row) return false;
       const r = row.getBoundingClientRect();
       const events = ["mousePressed","mouseReleased"].map(type => new MouseEvent(type === "mousePressed" ? "mousedown" : "click", { bubbles: true, clientX: r.left + 10, clientY: r.top + 5 }));
       events.forEach(e => row.dispatchEvent(e));
       return true;
     })()`,
  );
  await sleep(500);
  return ok;
}

/** 点击某个标签页，并确认它真的变成了激活标签（React 渲染是异步的）。 */
async function clickTab(ws, path) {
  const clicked = await evaluate(
    ws,
    `(() => {
       const tab = [...document.querySelectorAll('.tab')].find(t => t.title === ${JSON.stringify(path)});
       if (!tab) return false;
       tab.click();
       return true;
     })()`,
  );
  if (!clicked) return false;
  for (let i = 0; i < 15; i += 1) {
    const active = await evaluate(ws, `document.querySelector('.tab.is-active .tab-title')?.textContent ?? ''`);
    if (active === path.split("/").pop()) return true;
    await sleep(150);
  }
  return false;
}

const tabCount = (ws) => evaluate(ws, `document.querySelectorAll('.tab').length`);
const activeTabTitle = (ws) =>
  evaluate(ws, `document.querySelector('.tab.is-active .tab-title')?.textContent ?? ''`);
const tabIsDirty = async (ws, path) =>
  evaluate(
    ws,
    `[...document.querySelectorAll('.tab')].some(t => t.title === ${JSON.stringify(path)} && t.classList.contains('is-dirty'))`,
  );
const statusText = (ws) => evaluate(ws, `document.querySelector('.statusbar')?.innerText ?? ''`);
const editorText = (ws) => evaluate(ws, `document.querySelector('.cm-content')?.innerText ?? ''`);

/** 真实键盘输入。 */
async function typeText(ws, text) {
  await cdp(ws, "Input.insertText", { text });
  await sleep(200);
}

// ---------------------------------------------------------------- 连接

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
await sleep(600);
await evaluate(
  ws,
  `(() => {
     window.__tabErrs = [];
     window.addEventListener('error', (e) => window.__tabErrs.push(String(e.message)));
     window.addEventListener('unhandledrejection', (e) => window.__tabErrs.push(String(e.reason)));
     return true;
   })()`,
);

try {
  // ---------------------------------------------------------------- 标签页
  console.log("多标签页\n");

  // 脚本跑在 verify-gui 序列的后段：前面步骤可能开着标签，标签数断言全部写成相对的。
  // 文件树常驻左栏，无需切换任何页签。
  const tabsBefore = await tabCount(ws);
  const existed = async (path) =>
    evaluate(
      ws,
      `[...document.querySelectorAll('.tab')].some(t => t.title === ${JSON.stringify(path)})`,
    );
  const aExisted = await existed(NOTE_A);
  const bExisted = await existed(NOTE_B);
  // 打开两篇后的期望值：每个"原本没开"的文件各贡献一个新标签
  const expectedAfterBoth = tabsBefore + (aExisted ? 0 : 1) + (bExisted ? 0 : 1);

  check(await openNote(ws, NOTE_A), `打开 ${NOTE_A}`);
  check((await activeTabTitle(ws)) === NOTE_A.split("/").pop(), "激活标签是它");

  check(await openNote(ws, NOTE_B), `打开 ${NOTE_B}`);
  check(
    (await tabCount(ws)) === expectedAfterBoth,
    "打开第二篇后标签数按预期变化",
    `${tabsBefore} → ${await tabCount(ws)}（期望 ${expectedAfterBoth}）`,
  );
  check((await activeTabTitle(ws)) === NOTE_B.split("/").pop(), "激活标签切到第二篇");

  // 在 B 里键入不保存 → 切到 A → 切回来，内容必须还在
  await evaluate(ws, `document.querySelector('.cm-content').click()`);
  await sleep(200);
  await typeText(ws, MARKER);
  check(
    (await editorText(ws)).includes(MARKER),
    "B 里键入了标记",
  );
  check(await tabIsDirty(ws, NOTE_B), "B 的标签显示未保存圆点");

  check(await clickTab(ws, NOTE_A), "切到标签 A");
  check(
    !(await editorText(ws)).includes(MARKER),
    "A 里看不到 B 的未保存内容（状态隔离）",
  );
  check(await clickTab(ws, NOTE_B), "切回标签 B");
  check(
    (await editorText(ws)).includes(MARKER),
    "切回 B 后未保存内容还在（每标签一份 EditorState）",
  );

  // 关 dirty 的 B：必须先落盘
  const closeButtons = await evaluate(
    ws,
    `[...document.querySelectorAll('.tab')].find(t => t.title === ${JSON.stringify(NOTE_B)})?.querySelector('.tab-close') !== null`,
  );
  check(closeButtons, "标签上有关闭按钮");
  await evaluate(
    ws,
    `[...document.querySelectorAll('.tab')].find(t => t.title === ${JSON.stringify(NOTE_B)})?.querySelector('.tab-close')?.click()`,
  );
  await sleep(1200); // 落盘 + React 更新
  check(await tabCount(ws) === expectedAfterBoth - 1, "关闭后标签数减一");
  const diskB = readFileSync(join(vault, NOTE_B), "utf8");
  check(diskB.includes(MARKER), "关闭 dirty 标签前内容已落盘", diskB.slice(0, 80));
  const activeAfterClose = await activeTabTitle(ws);
  check(
    activeAfterClose !== NOTE_B.split("/").pop(),
    "激活标签不再是 B（落到相邻标签或无标签）",
    activeAfterClose,
  );

  // 还原 B（fixture 字节基线盯着它）
  writeFileSync(join(vault, NOTE_B), "");

  // ---------------------------------------------------------------- 目录
  console.log("\n目录面板\n");

  check(await openNote(ws, OUTLINE_NOTE), `打开 ${OUTLINE_NOTE}`);
  await evaluate(
    ws,
    `(() => {
       const tab = [...document.querySelectorAll('.sidebar-tab')].find(b => b.textContent === '目录');
       tab?.click();
       return true;
     })()`,
  );
  await sleep(400);

  const items = await evaluate(
    ws,
    `[...document.querySelectorAll('.outline-item')].map(e => e.querySelector('.outline-text')?.textContent ?? '')`,
  );
  check(items.length > 0, "目录列出了标题条目", JSON.stringify(items));
  // fixture 的日记里有"本周总结"这类小节标题；标题级别缩进由 class 表达
  check(
    await evaluate(ws, `!!document.querySelector('.outline-item.outline-h1, .outline-item.outline-h2')`),
    "条目带级别样式（缩进依据）",
  );

  // 点击条目 → 光标跳到标题行（statusbar 不变，用选区影响不到的途径验证：滚动位置或焦点）
  // 这里用可观察的途径：跳转后编辑器获得焦点
  await evaluate(ws, `[...document.querySelectorAll('.outline-item')][0]?.click()`);
  await sleep(300);
  check(
    await evaluate(ws, `!!document.activeElement?.closest('.cm-editor')`),
    "点击目录条目后焦点进入编辑器（跳转完成）",
  );

  check(
    await evaluate(ws, `!!document.querySelector('.tree-file')`),
    "文件树仍在左栏可见（文件列表不依赖页签）",
  );
} catch (err) {
  failures += 1;
  console.error("脚本异常：", err);
} finally {
  try {
    const errs = await evaluate(ws, `window.__tabErrs ?? []`);
    if (errs.length > 0) console.log("页面错误：", JSON.stringify(errs));
  } catch {
    /* 连接已关 */
  }
  ws.close();
}

console.log(failures === 0 ? "\n标签页与目录界面验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

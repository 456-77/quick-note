// GUI 验证：文件监听与外部改动处理。
//
// 为什么需要它：这套逻辑的核心是「Rust 的 notify 事件 → 前端判断是回声还是真外部改动」，
// 单元测试完全覆盖不到（涉及进程间事件与磁盘状态）。
//
// 时序陷阱：自动保存的防抖是 1.2 秒。若「先输入、再改文件」，自动保存可能先把冲突冲掉。
// 所以这里持续小幅输入让防抖不断重置，让编辑器稳定处于「有未保存编辑」状态。
//
// 前置：应用以 --remote-debugging-port 启动，仓库里有 日记/2026-09-14.md。
// 用法：node scripts/gui-external-change.mjs <vaultDir> [port]

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const TARGET = "日记/2026-09-14.md";
const filePath = join(vault, TARGET);

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

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

async function clickAt(ws, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
  }
}

const editorText = (ws) => evaluate(ws, `document.querySelector('.cm-content').textContent`);
const bannerText = (ws) => evaluate(ws, `document.querySelector('.banner-warn')?.textContent ?? null`);
const isDirty = (ws) =>
  evaluate(ws, `document.querySelector('.save-chip')?.classList.contains('is-dirty') ?? false`);

const original = readFileSync(filePath, "utf8");

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("未找到页面目标，请确认应用已启动并开启调试端口。");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")), { once: true });
});

for (let i = 0; i < 40; i += 1) {
  if (await evaluate(ws, `document.querySelectorAll('.tree-file').length > 0`)) break;
  await sleep(250);
}
const opened = await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(TARGET)}); if (!b) return false; b.click(); return true; })()`,
);
check(opened === true, `打开 ${TARGET}`);
await sleep(800);

// ---------------------------------------------------------------- 场景一：无未保存编辑
const EXTERNAL_ONE = "外部追加：来自另一个程序\n";
appendFileSync(filePath, EXTERNAL_ONE, "utf8");

let adopted = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(200);
  if ((await editorText(ws)).includes("外部追加：来自另一个程序")) {
    adopted = true;
    break;
  }
}
check(adopted, "外部改动在无未保存编辑时被自动采纳（编辑器已更新）");
check((await isDirty(ws)) === false, "自动采纳后不标记为未保存");
check((await bannerText(ws)) === null, "此时不弹冲突提示");

// 光标位置不应被重置到文首
const activeLine = await evaluate(ws, `document.querySelector('.cm-activeLine')?.innerText ?? null`);
check(activeLine !== null, "采纳外部改动后编辑器仍有活动行", `实际=${JSON.stringify(activeLine)}`);

// ---------------------------------------------------------------- 场景二：有未保存编辑
// 持续输入让自动保存防抖一直重置，编辑器稳定保持 dirty。
let conflictSeen = false;
let conflictText = null;
for (let i = 0; i < 12; i += 1) {
  await cdp(ws, "Input.insertText", { text: `${i}` });
  if (i === 2) {
    appendFileSync(filePath, "外部追加：第二次改动\n", "utf8");
  }
  await sleep(350);
  const banner = await bannerText(ws);
  if ((banner ?? "").includes("已被外部修改")) {
    conflictSeen = true;
    conflictText = banner;
    break;
  }
}
check(conflictSeen, "有未保存编辑时弹出冲突提示，而不是直接覆盖", JSON.stringify(conflictText));
check((await isDirty(ws)) === true, "冲突期间本地编辑仍在（未被覆盖）");
check(
  !(await editorText(ws)).includes("外部追加：第二次改动"),
  "冲突期间编辑器内容没有被外部版本顶掉",
);

const buttons = await evaluate(
  ws,
  `[...document.querySelectorAll('.banner-warn button')].map(b => b.textContent)`,
);
check(
  Array.isArray(buttons) && buttons.length === 2 && buttons.some((b) => b.includes("加载磁盘版本")),
  "冲突提示提供两个选择",
  JSON.stringify(buttons),
);

// 选择「加载磁盘版本」
await evaluate(
  ws,
  `[...document.querySelectorAll('.banner-warn button')].find(b => b.textContent.includes('加载磁盘版本')).click()`,
);
await sleep(500);
check((await bannerText(ws)) === null, "选择后冲突提示消失");
check((await editorText(ws)).includes("外部追加：第二次改动"), "编辑器内容换成磁盘版本");
check((await isDirty(ws)) === false, "采纳后不再是未保存状态");

// ---------------------------------------------------------------- 场景三：外部新增文件
writeFileSync(join(vault, "外部新建.md"), "# 外部新建的笔记\n", "utf8");
let treeHasNew = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(200);
  const titles = await evaluate(ws, `[...document.querySelectorAll('.tree-file')].map(b => b.title)`);
  if ((titles ?? []).includes("外部新建.md")) {
    treeHasNew = true;
    break;
  }
}
check(treeHasNew, "外部新建的文件出现在文件树里（列表自动刷新）");

// 收尾：还原被这次测试改动的文件由调用方负责，这里只把追加内容去掉
writeFileSync(filePath, original, "utf8");
await sleep(500);

ws.close();
console.log(failures === 0 ? "\n外部改动处理验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

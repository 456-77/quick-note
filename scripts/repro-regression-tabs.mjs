// 针对 stateStore 修复的针对性回归：标签往返内容保持 + 快速关闭脏标签落盘正确。
// 用法：node scripts/repro-regression-tabs.mjs <port>
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const port = process.argv[2] ?? "9222";
const vault = "H:/develop/project/quick-note/test-vault";
const A = "features.md";
const B = "empty.md";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;
const cdp = (ws, method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (ws, expression) => {
  const r = await cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("PAGE ERR: " + r.exceptionDetails.text);
  return r.result.value;
};

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes("1420"));
if (!page) throw new Error("app page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", () => rej(new Error("ws fail")), { once: true });
});
await cdp(ws, "Page.bringToFront");

const clickTree = (path) => evaluate(ws, `(() => {
  const el = [...document.querySelectorAll('.tree-file,.tree-dir')].find(x => (x.title || "").startsWith(${JSON.stringify(path)}));
  if (!el) return "NO_ROW:" + ${JSON.stringify(path)};
  el.click();
  return "OK";
})()`);

let fails = 0;
const check = (ok, label, detail = "") => {
  console.log((ok ? "✓ " : "✗ ") + label + (detail ? `  ${detail}` : ""));
  if (!ok) fails += 1;
};

// 等应用就绪
for (let i = 0; i < 30; i += 1) {
  if (await evaluate(ws, `document.querySelectorAll('.tree-file').length > 0 && !!window.__qnView`)) break;
  await sleep(400);
}

// 1) 打开 A（features.md）
check((await clickTree(A)) === "OK", `树中打开 ${A}`);
await sleep(900);
const originalA = await evaluate(ws, `window.__qnView.state.sliceDoc()`);
check(originalA.length > 0, "A 内容非空", `${originalA.length} chars`);

// 2) 在 A 里键入标记，立即（自动保存窗口内）切到 B
await evaluate(ws, `window.__qnView.dispatch({ changes: { from: 0, insert: "ZZ_REG_MARKER\\n" } })`);
await sleep(120);
check((await clickTree(B)) === "OK", `切换到 ${B}`);
await sleep(900);

// 3) 切回 A：stateStore 存量状态必须带着标记（此前只在切走时捕获，激活期间 stateStore 是旧对象）
check((await clickTree(A)) === "OK", `切回 ${A}`);
await sleep(900);
const backA = await evaluate(ws, `window.__qnView.state.sliceDoc()`);
check(backA.includes("ZZ_REG_MARKER"), "切回后标记仍在（stateStore 往返）", backA.slice(0, 40));
check(backA.startsWith(originalA) || backA.includes(originalA.slice(0, 30)), "原有内容未丢");

// 4) 等 2 秒让自动保存落盘，再校验磁盘
await sleep(2200);
const diskA = readFileSync(join(vault, A), "utf8");
check(diskA.includes("ZZ_REG_MARKER"), "自动保存已落盘");
const diskAWithoutMarker = diskA.replace("ZZ_REG_MARKER\n", "");

// 5) 快速关闭脏标签（closeTab 的陈旧写修复）：再键入一点内容，立即点 ✕，磁盘必须是**实时**内容
await evaluate(ws, `window.__qnView.dispatch({ changes: { from: 0, insert: "QQ_QUICK_CLOSE\\n" } })`);
await sleep(120);
check((await evaluate(ws, `(() => { const b = document.querySelector('.tab.is-active .tab-close'); if (!b) return "NO"; b.click(); return "OK"; })()`)) === "OK", "立即关闭脏标签");
await sleep(1200);
const diskAfterClose = readFileSync(join(vault, A), "utf8");
check(diskAfterClose.includes("QQ_QUICK_CLOSE"), "关闭前实时内容已落盘（closeTab 陈旧写修复）");

// 还原 A 的原始内容，保持 fixture 基线
writeFileSync(join(vault, A), diskAWithoutMarker, "utf8");
check(!readFileSync(join(vault, A), "utf8").includes("ZZ_REG_MARKER"), "fixture 已还原");

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

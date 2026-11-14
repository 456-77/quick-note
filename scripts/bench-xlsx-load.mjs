// 表格加载端到端基准（诊断用，0.39.9）：gui-test release exe + CDP 页内计时。
// 用法：node scripts/bench-xlsx-load.mjs
// 量什么：点树文件 → 表格可见（.xlsx-table）→ 列宽钉死（.is-fixed）的毫秒差，
// 以及页内劫持 invoke 记录 parse_xlsx 的纯耗时（区分首次/缓存命中）。

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const repo = "H:/develop/project/quick-note";
const exe = join(repo, "src-tauri/target/release/quick-note.exe");
const port = 9233;
const udf = "H:/tmp/qn-bench-udf";
const vault = "H:/tmp/qn-bench-vault";

const files = [
  "RPT027-通用费用报销-导入结果-20261113-v3.xlsx",
  "REQ001-出差行前报告-导入结果-20261113.xlsx",
  "REQ003-异地返家预订申请-导入结果-20261113.xlsx",
];
const srcDir = "H:/develop/shuiyi_code/运维/数据文件/结果-11-13";

// ---- 夹具 ----
rmSync(udf, { recursive: true, force: true });
rmSync(vault, { recursive: true, force: true });
mkdirSync(vault, { recursive: true });
mkdirSync(join(vault, "数据文件"), { recursive: true });
for (const f of files) copyFileSync(join(srcDir, f), join(vault, "数据文件", f));

if (!existsSync(exe)) {
  console.error("没有 gui-test release exe：先跑 npm run tauri build -- --no-bundle --config '{\"identifier\":\"com.quicknote.gui-test\"}'");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = (ws, method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        ws.removeEventListener("message", onMessage);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (ws, expression) => {
  const r = await cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate 失败");
  return r.result.value;
};

const waitFor = async (ws, expr, timeoutMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(ws, expr)) return true;
    await sleep(40);
  }
  return false;
};

// ---- 起应用 ----
const child = spawn(exe, [vault], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: udf,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: "ignore",
});
let ws = null;
for (let i = 0; i < 60 && !ws; i += 1) {
  await sleep(1000);
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
      });
    }
  } catch {}
}
if (!ws) {
  console.error("应用页面没就绪");
  process.exit(1);
}
const mark = (tag) => {
  try {
    appendFileSync("H:/tmp/bench-progress.txt", `${tag} @ ${Math.round(performance.now())}\n`);
  } catch {}
};
mark("connect ok");
await cdp(ws, "Page.bringToFront");
mark("tree wait start");
await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 30000);
await sleep(1500); // 树稳定

// 展开所有折叠的目录（夹具文件都在 数据文件/ 里）
await evaluate(ws, `(() => {
  const dirs = [...document.querySelectorAll('.tree-item')].filter((el) => el.querySelector('.tree-dir, .tree-caret') || el.classList.contains('tree-dir'));
  dirs.forEach((d) => d.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  return dirs.length;
})()`);
await waitFor(ws, `document.querySelectorAll('.tree-file').length > 0`, 10000);
await sleep(800);

// ---- 页内计时器：劫持 invoke 记录 parse_xlsx 耗时 ----
await evaluate(ws, `(() => {
  window.__bench = { native: [], render: [] };
  const internals = window.__TAURI_INTERNALS__;
  const raw = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    if (cmd === 'parse_xlsx') {
      const t0 = performance.now();
      const p = raw.call(internals, cmd, args, options);
      p.then(() => window.__bench.native.push(Math.round(performance.now() - t0))).catch(() => {});
      return p;
    }
    return raw.call(internals, cmd, args, options);
  };
  return 'invoke wrapped';
})()`);

const openAndMeasure = async (fileLabel) => {
  const t0 = await evaluate(ws, `(() => {
    window.__bench.render = [];
    const item = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes(${JSON.stringify(fileLabel)}));
    if (!item) return -1;
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return performance.now();
  })()`);
  if (t0 < 0) return { error: "树里没找到该文件" };
  const tableUp = await waitFor(ws, `!!document.querySelector('.xlsx-table')`, 30000);
  const tTable = await evaluate(ws, `performance.now()`);
  const fixedUp = await waitFor(ws, `!!document.querySelector('.xlsx-table.is-fixed')`, 10000);
  const tFixed = await evaluate(ws, `performance.now()`);
  await sleep(300);
  const native = await evaluate(ws, `window.__bench.native`);
  const rowCount = await evaluate(ws, `document.querySelectorAll('.xlsx-table tbody tr').length`);
  return { tableUp, visible: Math.round(tTable - t0), pinned: Math.round(tFixed - t0), fixedUp, nativeMs: native, rowCount };
};

mark("before cold opens @ ")
console.log("=== 首次打开（冷）===");
for (const f of files) {
  const r = await openAndMeasure(f);
  console.log(f.slice(0, 12), JSON.stringify(r));
  // 关掉预览标签回编辑器（下一个文件从头走加载路径）
  await evaluate(ws, `(() => { const b = document.querySelector('.tab-special.is-active .tab-close'); b?.click(); return true; })()`);
  await sleep(400);
}

console.log("=== 第二次打开（缓存命中）===");
for (const f of files.slice(0, 2)) {
  const r = await openAndMeasure(f);
  console.log(f.slice(0, 12), JSON.stringify(r));
  await evaluate(ws, `(() => { document.querySelector('.tab-special.is-active .tab-close')?.click(); return true; })()`);
  await sleep(400);
}

child.kill();
process.exit(0);

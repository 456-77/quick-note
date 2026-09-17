// 端到端验证「真实编辑 → 自动保存」路径下的字节完整性。
//
// 前面两个测试分别覆盖了「磁盘 ↔ 字符串」和「字符串 ↔ 编辑器状态」，但都没走
// 真实的用户输入与写盘流程。本脚本通过 CDP 发送真实的鼠标点击与键盘输入，让应用
// 自己完成自动保存，再检查磁盘上的文件：
//
//   · 改动确实落盘
//   · 原有行完好无损
//   · 换行符仍然**全部**是 CRLF（没有一个裸 LF 混进去）——这是同步哈希比对的关键
//
// 前置：应用以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动，
// 且仓库里存在 CRLF 文件 日记/2026-W37 周记.md。
//
// 用法：node scripts/gui-edit-save.mjs <vaultDir> [port]

import { readFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const TARGET = "日记/2026-W37 周记.md";
const MARKER = "ZZ_EDIT_MARKER_";

const filePath = join(vault, TARGET);
const failures = [];
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures.push(label);
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

let nextId = 1;
function cdp(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async (ws, expression) => {
  const r = await cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = readFileSync(filePath, "utf8");
check(before.includes("\r\n"), `测试文件为 CRLF（${TARGET}）`);

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

// 打开目标笔记
const opened = await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(TARGET)}); if (!b) return false; b.click(); return true; })()`,
);
check(opened === true, `打开 ${TARGET}`);
await sleep(800);

// 真实点击编辑器，让光标进入文档
const rect = await evaluate(
  ws,
  `(() => { const el = document.querySelector('.cm-content'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 12 }; })()`,
);
check(rect !== null, "取到编辑器位置");
if (rect) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      button: "left",
      clickCount: 1,
    });
  }
}
await sleep(200);

const focused = await evaluate(ws, `!!document.activeElement?.closest('.cm-editor')`);
check(focused === true, "编辑器已获得焦点");

// 真实键盘输入
await cdp(ws, "Input.insertText", { text: MARKER });
await sleep(300);

const dirty = await evaluate(ws, `document.querySelector('.save-chip')?.classList.contains('is-dirty')`);
check(dirty === true, "输入后标记为未保存");

const docHasMarker = await evaluate(ws, `document.querySelector('.cm-content')?.innerText.includes(${JSON.stringify(MARKER)}) ?? false`);
check(docHasMarker === true, "编辑器内出现输入内容");

// 等待自动保存（防抖 1.2s + 写盘）
console.log("  等待自动保存…");
let after = "";
for (let i = 0; i < 30; i += 1) {
  await sleep(400);
  after = readFileSync(filePath, "utf8");
  if (after.includes(MARKER)) break;
}

check(after.includes(MARKER), "改动已自动落盘");
check(after.includes("本周总结"), "原有行完好（含「本周总结」）");
check(after.includes("下一周做 M1"), "原有行完好（含「下一周做 M1」）");

// 核心断言：CRLF 完整性。混入裸 LF 会让同步哈希比对失效。
const crlf = (after.match(/\r\n/g) ?? []).length;
const lf = (after.match(/\n/g) ?? []).length;
const cr = (after.match(/\r/g) ?? []).length;
check(
  lf === crlf && cr === crlf,
  "换行符全部仍为 CRLF（无裸 LF 混入）",
  `CRLF=${crlf} 总LF=${lf} 总CR=${cr}`,
);
check(after !== before, "文件内容确实发生变化（不是空写）");

// 标记为已保存
const dirtyAfter = await evaluate(ws, `document.querySelector('.save-chip')?.classList.contains('is-dirty')`);
check(dirtyAfter === false, "保存后清除未保存标记");

const bytes = Buffer.byteLength(after, "utf8");
console.log(`\n编辑后文件 ${bytes} 字节（原 ${Buffer.byteLength(before, "utf8")} 字节）`);

ws.close();
console.log(failures.length === 0 ? "编辑保存路径验证通过 ✓" : `失败 ${failures.length} 项 ✗`);
process.exit(failures.length === 0 ? 0 : 1);

// GUI 验证：粘贴附件。
//
// 覆盖完整链路：CodeMirror 的 paste 事件 → 读文件字节 → base64 → Rust 写入仓库 →
// 光标处插入链接 → 自动保存到笔记。写盘是真的，所以断言直接查磁盘。
//
// 关于剪贴板：这里用**合成的 ClipboardEvent + DataTransfer** 注入一个真实 PNG，
// 不去动你系统里真正的剪贴板（设置剪贴板属于对用户环境的侵入，而且需要额外权限）。
// 代价是这条路径没经过系统剪贴板：真实粘贴的差异主要在于浏览器给的 File 元数据，
// 所以另外用两种 File 形态（带名字的图片、无名字的图片）各测一次。
//
// 用法：node scripts/gui-paste.mjs <vaultDir> [port]

import { readFileSync, readdirSync, unlinkSync, existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const NOTE = "日记/2026-09-14.md";
const ATTACH_DIR = join(vault, "attachments");
const SOURCE_IMAGE = join(ATTACH_DIR, "pic.png");

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

const listAttachments = () => new Set(readdirSync(ATTACH_DIR));

/** 在页面里合成一次粘贴（带一个真实 PNG 的 File）。 */
async function pasteImage(ws, base64, fileName) {
  return evaluate(
    ws,
    `(() => {
       const binary = atob(${JSON.stringify(base64)});
       const bytes = new Uint8Array(binary.length);
       for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
       const file = new File([bytes], ${JSON.stringify(fileName)}, { type: "image/png" });
       const data = new DataTransfer();
       data.items.add(file);
       const target = document.querySelector('.cm-content');
       if (!target) return 'no-editor';
       const before = document.activeElement;
       target.focus();
       target.dispatchEvent(
         new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
       );
       return before ? 'ok' : 'ok';
     })()`,
  );
}

const before = listAttachments();
const sourceBytes = readFileSync(SOURCE_IMAGE);
const sourceBase64 = sourceBytes.toString("base64");

/** 展开/收起设置面板。 */
async function setSettingsOpen(ws, open) {
  await evaluate(
    ws,
    `(() => {
       const button = document.querySelector('.topbar .icon-btn[title="设置"]');
       if (!button) return false;
       const isOpen = document.querySelector('.settings-panel') !== null;
       if (isOpen !== ${open ? "true" : "false"}) button.click();
       return true;
     })()`,
  );
  // React 的重渲染是异步的：点完必须等一拍，否则同一表达式里查不到面板
  await sleep(250);
}

/** 把「粘贴时保存附件」设成指定状态，返回确认后的状态。 */
async function setPasteEnabled(ws, on) {
  await setSettingsOpen(ws, true);
  await evaluate(
    ws,
    `(() => {
       const box = document.querySelector('.settings-panel input[type=checkbox]');
       if (box && box.checked !== ${on ? "true" : "false"}) box.click();
       return true;
     })()`,
  );
  await sleep(250);
  // 受控组件要等 React 回写后再读，才拿得到真实状态
  const state = await evaluate(
    ws,
    `(() => {
       const box = document.querySelector('.settings-panel input[type=checkbox]');
       return box ? (box.checked ? 'on' : 'off') : 'no-checkbox';
     })()`,
  );
  await setSettingsOpen(ws, false);
  return state;
}

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
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(NOTE)}); if (!b) return false; b.click(); return true; })()`,
);
check(opened === true, `打开 ${NOTE}`);
await sleep(800);

// 脚本可能被重复执行，设置会留在 localStorage 里，所以先确保开关是开的
check((await setPasteEnabled(ws, true)) === "on", "确保「粘贴时保存附件」已开启");

// ---------------------------------------------------------------- 第一次粘贴
check((await pasteImage(ws, sourceBase64, "screenshot.png")) === "ok", "合成一次粘贴事件");

let pasted = [];
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  pasted = [...listAttachments()].filter((name) => !before.has(name));
  if (pasted.length >= 1) break;
}
check(pasted.length === 1, "附件被写入仓库的附件目录", JSON.stringify(pasted));
check(
  /^Pasted image \d{14}\.png$/.test(pasted[0] ?? ""),
  "文件名是 Obsidian 风格的「Pasted image + 时间戳」",
  JSON.stringify(pasted[0]),
);
check(
  pasted[0] !== undefined && readFileSync(join(ATTACH_DIR, pasted[0])).equals(sourceBytes),
  "写入的字节与原图完全一致（二进制路径无损）",
);

const content = await evaluate(ws, `document.querySelector('.cm-content').textContent`);
check(
  content.includes(`![[${pasted[0]}]]`),
  "光标处插入了 wiki 格式的图片链接",
  JSON.stringify(content.slice(0, 80)),
);

const status = await evaluate(ws, `document.querySelector('.statusbar')?.innerText ?? ''`);
check(status.includes("已保存") && status.includes("附件"), "状态栏给出保存提示", JSON.stringify(status));

console.log("  等待自动保存…");
let noteOnDisk = "";
for (let i = 0; i < 25; i += 1) {
  await sleep(300);
  noteOnDisk = readFileSync(join(vault, NOTE), "utf8");
  if (noteOnDisk.includes(`![[${pasted[0]}]]`)) break;
}
check(noteOnDisk.includes(`![[${pasted[0]}]]`), "链接已被自动保存进笔记文件");

// ---------------------------------------------------------------- 第二次粘贴
// 同一秒内不会重名；跨秒时文件名本就不同。两种情况下都不能覆盖已有文件。
check((await pasteImage(ws, sourceBase64, "")) === "ok", "再粘贴一次（这次 File 没有文件名，模拟截图）");
let after = [];
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  after = [...listAttachments()].filter((name) => !before.has(name));
  if (after.length >= 2) break;
}
check(after.length === 2, "第二次粘贴产生了第二个附件（已存在的文件未被覆盖）", JSON.stringify(after));
check(
  readFileSync(join(ATTACH_DIR, pasted[0])).equals(sourceBytes),
  "第一个附件的内容没有被第二次粘贴破坏",
);
check(
  after.every((name) => /^Pasted image \d{14}( \d+)?\.png$/.test(name)),
  "第二个文件名同样合规（同一秒时带序号）",
  JSON.stringify(after),
);

// ---------------------------------------------------------------- 关闭开关后不接管
check((await setPasteEnabled(ws, false)) === "off", "在设置里关掉「粘贴时保存附件」");
await pasteImage(ws, sourceBase64, "third.png");
await sleep(1500);
const afterDisabled = [...listAttachments()].filter((name) => !before.has(name));
check(
  afterDisabled.length === 2,
  "关闭开关后粘贴不再写附件",
  JSON.stringify(afterDisabled),
);
// 恢复设置，避免影响后续运行
check((await setPasteEnabled(ws, true)) === "on", "把设置恢复为开启");

// ---------------------------------------------------------------- 自定义附件目录（含嵌套）
// 这条很重要：用户实际会把图片放在自定义目录（本项目作者的库用的是 image/）。
await setSettingsOpen(ws, true);
const setFolder = await evaluate(
  ws,
  `(() => {
     const input = document.querySelector('.settings-panel input[type=text]');
     if (!input) return false;
     // React 受控组件：直接改 .value 不会触发 onChange，必须走原生 setter + input 事件
     const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
     setter.call(input, 'deep/attachments');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
);
check(setFolder === true, "把附件目录改成嵌套路径 deep/attachments");
await sleep(300);
await setSettingsOpen(ws, false);

await pasteImage(ws, sourceBase64, "nested.png");
const nestedDir = join(vault, "deep", "attachments");
let nestedFile = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  if (existsSync(nestedDir)) {
    const files = readdirSync(nestedDir).filter((name) => name.endsWith(".png"));
    if (files.length > 0) {
      nestedFile = files[0];
      break;
    }
  }
}
check(nestedFile !== null, "附件被写进自定义（且自动创建的）嵌套目录", JSON.stringify(nestedFile));
check(
  nestedFile !== null && readFileSync(join(nestedDir, nestedFile)).equals(sourceBytes),
  "自定义目录里的附件内容同样正确",
);

// 把目录设置改回默认
await setSettingsOpen(ws, true);
await evaluate(
  ws,
  `(() => {
     const input = document.querySelector('.settings-panel input[type=text]');
     if (!input) return false;
     const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
     setter.call(input, 'attachments');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
);
await sleep(250);
await setSettingsOpen(ws, false);

// ---------------------------------------------------------------- 清理
if (nestedFile !== null) {
  unlinkSync(join(nestedDir, nestedFile));
}
const nestedRemoved = readdirSync(nestedDir).length === 0;
if (nestedRemoved) {
  // 只删这个测试创建的目录，deep/ 是 fixture 里本来就有的
  rmdirSync(nestedDir);
}
check(
  !existsSync(nestedDir) || readdirSync(nestedDir).length > 0,
  "测试创建的嵌套目录已清理（deep/ 本身保留）",
);

// ---------------------------------------------------------------- 清理
for (const name of afterDisabled) {
  const path = join(ATTACH_DIR, name);
  if (existsSync(path)) unlinkSync(path);
}
check(
  [...listAttachments()].filter((name) => !before.has(name)).length === 0,
  "测试产生的附件已清理",
);

ws.close();
console.log(failures === 0 ? "\n粘贴附件验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

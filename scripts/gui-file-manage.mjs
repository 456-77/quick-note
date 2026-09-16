// GUI 验证：文件管理——新建、重命名、删除。
//
// 用**真实键盘输入**（CDP 的 insertText + Enter 键），而不是直接改 input.value——
// 后者绕过了 React 的受控更新，测不到真实路径。
//
// 测试产物集中创建在一个可整体删除的位置，结束时清理干净（fixture 的字节基线要守住）。
//
// 用法：node scripts/gui-create.mjs <vaultDir> [port]

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const NOTE = "日记/2026-09-14.md";
/** 新建目标目录 = 当前打开笔记所在目录。 */
const TARGET_DIR = "日记";
const NOTE_A = `${TARGET_DIR}/创建测试笔记.md`;
const NOTE_B = `${TARGET_DIR}/创建测试笔记 1.md`;
const NESTED = `${TARGET_DIR}/创建子目录/嵌套笔记.md`;
const FOLDER = `${TARGET_DIR}/创建测试目录`;

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

async function clickButton(ws, text) {
  return evaluate(
    ws,
    `(() => {
       const button = [...document.querySelectorAll('.sidebar button')].find(b => b.textContent.includes(${JSON.stringify(text)}));
       if (!button) return false;
       button.click();
       return true;
     })()`,
  );
}

/** 用真实键盘往输入行里打字并回车。 */
async function typeName(ws, name, confirm = true) {
  await cdp(ws, "Input.insertText", { text: name });
  await sleep(150);
  if (confirm) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp(ws, "Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    }
  }
  await sleep(700);
}

async function pressEscape(ws) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await cdp(ws, "Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
  await sleep(250);
}

/** 在某个树节点上派发右键事件，打开上下文菜单。 */
async function openContextMenu(ws, path) {
  const opened = await evaluate(
    ws,
    `(() => {
       const row = [...document.querySelectorAll('.tree-item')].find(e => e.title === ${JSON.stringify(path)});
       if (!row) return false;
       const rect = row.getBoundingClientRect();
       row.dispatchEvent(new MouseEvent('contextmenu', {
         bubbles: true,
         cancelable: true,
         clientX: rect.left + 20,
         clientY: rect.top + 5,
       }));
       return true;
     })()`,
  );
  await sleep(250);
  return opened;
}

/** 点击上下文菜单里的某一项。 */
async function clickMenuItem(ws, text) {
  const clicked = await evaluate(
    ws,
    `(() => {
       const button = [...document.querySelectorAll('.context-menu button')]
         .find(b => b.textContent.includes(${JSON.stringify(text)}));
       if (!button) return false;
       button.click();
       return true;
     })()`,
  );
  await sleep(250);
  return clicked;
}

const treeTitles = (ws) =>
  evaluate(ws, `[...document.querySelectorAll('.tree-file')].map(b => b.title)`);
const statusText = (ws) => evaluate(ws, `document.querySelector('.statusbar')?.innerText ?? ''`);
const errorText = (ws) => evaluate(ws, `document.querySelector('.banner-error')?.innerText ?? null`);
const inputOpen = (ws) => evaluate(ws, `document.querySelector('.create-row') !== null`);
const clearError = (ws) =>
  evaluate(ws, `(() => {
     const button = [...document.querySelectorAll('.banner-error button')][0];
     if (button) button.click();
     return true;
   })()`);

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
// 打开一篇笔记，让新建的目标目录是它所在目录（而不是仓库根）
const opened = await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(NOTE)}); if (!b) return false; b.click(); return true; })()`,
);
check(opened === true, `打开 ${NOTE}`);
await sleep(800);

// ---------------------------------------------------------------- 新建文件夹
// 先建文件夹：此时打开的笔记在 日记/ 下，目标目录确定是 日记/。
// （新建的笔记会被立刻打开，目标目录会随之下沉到该笔记所在目录——后面的断言按此调整。）
check(await clickButton(ws, "＋文件夹"), "点击「＋文件夹」");
await typeName(ws, "创建测试目录");
check(
  existsSync(join(vault, FOLDER)) && statSync(join(vault, FOLDER)).isDirectory(),
  "文件夹已创建",
  FOLDER,
);

// 回归断言：**空文件夹必须出现在文件树里**。
// 此前文件树是从 md 文件路径反推出来的，空目录不产生任何节点，于是"资源管理器里能看到、
// 软件里看不到"。现在目录由 Rust 直接返回（含空目录）。
let treeDirs = [];
for (let i = 0; i < 20; i += 1) {
  treeDirs = await evaluate(ws, `[...document.querySelectorAll('.tree-dir')].map(b => b.title)`);
  if (treeDirs.includes(FOLDER)) break;
  await sleep(250);
}
check(treeDirs.includes(FOLDER), "新建的空文件夹出现在文件树里", JSON.stringify(treeDirs));
check(
  treeDirs.includes("attachments"),
  "只放附件、不含笔记的目录同样可见",
  JSON.stringify(treeDirs),
);
check(
  (await evaluate(ws, `[...document.querySelectorAll('.tree-other')].map(e => e.textContent)`)).some(
    (text) => text.includes("notes.txt"),
  ),
  "非 Markdown 文件也会列出（不可编辑，仅反映仓库结构）",
);

// ---------------------------------------------------------------- 新建笔记
check(await clickButton(ws, "＋笔记"), "点击「＋笔记」展开输入行");
check(await inputOpen(ws), "输入行已展开");
check(
  ((await evaluate(ws, `document.querySelector('.create-hint')?.textContent ?? ''`)) ?? "").includes(TARGET_DIR),
  "提示里写明新建到哪个目录",
  await evaluate(ws, `document.querySelector('.create-hint')?.textContent ?? ''`),
);

await typeName(ws, "创建测试笔记");
check(existsSync(join(vault, NOTE_A)), "笔记文件已在磁盘上创建", NOTE_A);
check(statSync(join(vault, NOTE_A)).size === 0, "新笔记是空文件");
check(!(await inputOpen(ws)), "创建后输入行自动收起");
check((await treeTitles(ws)).includes(NOTE_A), "新笔记出现在文件树里");
check((await statusText(ws)).includes(NOTE_A), "新笔记被直接打开（状态栏显示路径）", await statusText(ws));
check((await errorText(ws)) === null, "创建过程无报错");

// 同名再建一次：应当加序号，而不是覆盖或报错
check(await clickButton(ws, "＋笔记"), "再次点击「＋笔记」");
await typeName(ws, "创建测试笔记");
check(existsSync(join(vault, NOTE_B)), "同名笔记自动加序号，不覆盖已有文件", NOTE_B);

// 名称里带子目录：中间目录自动创建
check(await clickButton(ws, "＋笔记"), "第三次点击「＋笔记」");
await typeName(ws, "创建子目录/嵌套笔记");
check(existsSync(join(vault, NESTED)), "名称含子目录时会自动创建中间目录", NESTED);

// 重新打开一篇 日记/ 下的笔记，让后续新建回到确定的目标目录
await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(NOTE)}); if (b) b.click(); return true; })()`,
);
await sleep(600);

// ---------------------------------------------------------------- 非法名称
await clearError(ws);
check(await clickButton(ws, "＋笔记"), "再次点击「＋笔记」（准备测非法名称）");
await typeName(ws, ".隐藏笔记");
const error = await errorText(ws);
check((error ?? "").includes("隐藏"), "隐藏名称被拒绝并给出提示", JSON.stringify(error));
check(!existsSync(join(vault, TARGET_DIR, ".隐藏笔记.md")), "非法名称没有产生文件");
check(await inputOpen(ws), "报错后输入行保持展开，便于改名重试");

// Esc 取消
await pressEscape(ws);
check(!(await inputOpen(ws)), "Esc 可以取消新建");

// ---------------------------------------------------------------- 重命名
// 先造一个"引用者"笔记（直接写盘，模拟别的程序），用来验证改名会同步更新 wiki 引用
const REFERENCER = `${TARGET_DIR}/引用者.md`;
writeFileSync(
  join(vault, REFERENCER),
  "引用：[[创建测试笔记]] 与 ![[创建测试笔记#小节]]，还有 [[无关笔记]]。\n",
  "utf8",
);
await sleep(900); // 等文件监听刷新

// 打开被改名的笔记：顺带验证"编辑器会跟着换到新路径"
await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(NOTE_A)}); if (b) b.click(); return true; })()`,
);
await sleep(600);

const RENAMED = `${TARGET_DIR}/改名后.md`;
check(await openContextMenu(ws, NOTE_A), "在笔记上右键打开菜单");
check(await clickMenuItem(ws, "重命名"), "点击「重命名」");
check(await inputOpen(ws), "重命名输入行已展开");
check(
  ((await evaluate(ws, `document.querySelector('.create-row input')?.value ?? ''`)) ?? "").includes(
    "创建测试笔记",
  ),
  "输入行预填了当前名称",
  await evaluate(ws, `document.querySelector('.create-row input')?.value ?? ''`),
);
// 输入框聚焦即全选，所以这里的输入会替换掉原名称
await typeName(ws, "改名后");

check(existsSync(join(vault, RENAMED)), "文件已在磁盘上改名", RENAMED);
check(!existsSync(join(vault, NOTE_A)), "旧文件已不存在");
let titles = await treeTitles(ws);
check(titles.includes(RENAMED), "文件树显示新名称", JSON.stringify(titles.slice(0, 6)));
check(!titles.includes(NOTE_A), "文件树不再显示旧名称");
check((await statusText(ws)).includes(RENAMED), "编辑器跟着换到了新路径", await statusText(ws));

const referencer = readFileSync(join(vault, REFERENCER), "utf8");
check(referencer.includes("[[改名后]]"), "其他笔记里的 wiki 引用被同步更新", referencer);
check(referencer.includes("![[改名后#小节]]"), "带小节的嵌入也被更新");
check(referencer.includes("[[无关笔记]]"), "无关引用保持原样");
check((await statusText(ws)).includes("引用"), "状态栏说明更新了几处引用", await statusText(ws));

// 改名冲突：目标已存在时应当报错，而不是覆盖
await clearError(ws);
check(await openContextMenu(ws, RENAMED), "再次右键打开菜单");
check(await clickMenuItem(ws, "重命名"), "点击「重命名」");
await typeName(ws, "创建测试笔记 1"); // NOTE_B 已存在
check((await errorText(ws)) !== null, "改成已存在的名称会报错", JSON.stringify(await errorText(ws)));
check(await inputOpen(ws), "报错后输入行保持展开");
check(existsSync(join(vault, RENAMED)), "原文件未被破坏");
check(existsSync(join(vault, NOTE_B)), "已存在的文件未被覆盖");
await pressEscape(ws);
await clearError(ws);

// ---------------------------------------------------------------- 删除
check(await openContextMenu(ws, RENAMED), "在笔记上右键");
check(await clickMenuItem(ws, "删除"), "点击「删除…」");
check(
  ((await evaluate(ws, `document.querySelector('.banner-warn')?.textContent ?? ''`)) ?? "").includes(
    "回收",
  ),
  "先弹出删除确认（删笔记不可逆）",
);
await evaluate(
  ws,
  `[...document.querySelectorAll('.banner-warn button')].find(b => b.textContent.includes('移入回收目录'))?.click()`,
);
await sleep(900);

check(!existsSync(join(vault, RENAMED)), "文件已从仓库移走");
check(existsSync(join(vault, ".trash", "改名后.md")), "文件在仓库内的 .trash 里，可以找回");
titles = await treeTitles(ws);
check(!titles.includes(RENAMED), "文件树里不再显示被删除的文件");
check((await statusText(ws)).includes("回收"), "状态栏说明移入了回收目录", await statusText(ws));
check((await statusText(ws)).includes("未打开文件"), "删除当前笔记后编辑器已关闭");

// 关键：编辑器若不关闭，接下来的一次自动保存会把刚删掉的文件写回来
await sleep(2000);
check(!existsSync(join(vault, RENAMED)), "等待后文件没有被自动保存重新写回来");

// 删除文件夹（连同内容）
check(await openContextMenu(ws, FOLDER), "在文件夹上右键");
check(await clickMenuItem(ws, "删除"), "点击「删除…」");
await evaluate(
  ws,
  `[...document.querySelectorAll('.banner-warn button')].find(b => b.textContent.includes('移入回收目录'))?.click()`,
);
await sleep(900);
check(!existsSync(join(vault, FOLDER)), "文件夹已移走");
check(existsSync(join(vault, ".trash", "创建测试目录")), "整个文件夹进了回收目录");

// ---------------------------------------------------------------- 清理
await clearError(ws);
if (existsSync(join(vault, ".trash"))) {
  rmSync(join(vault, ".trash"), { recursive: true, force: true });
}
for (const path of [NOTE_A, NOTE_B, FOLDER, REFERENCER, `${TARGET_DIR}/创建子目录`]) {
  const full = join(vault, path);
  if (existsSync(full)) rmSync(full, { recursive: true, force: true });
}
const leftovers = [
  NOTE_A,
  NOTE_B,
  NESTED,
  FOLDER,
  REFERENCER,
  RENAMED,
  `${TARGET_DIR}/.trash`,
].filter((path) => existsSync(join(vault, path)));
check(leftovers.length === 0, "测试创建的文件与目录已清理", JSON.stringify(leftovers));
check(
  readdirSync(join(vault, TARGET_DIR)).some((name) => name === "2026-09-14.md"),
  "fixture 原有文件未被误删",
);

ws.close();
console.log(failures === 0 ? "\n文件管理验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

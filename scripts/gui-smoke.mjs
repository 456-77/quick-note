// 通过 Chrome DevTools Protocol 对真实运行的应用做端到端冒烟测试。
//
// 为什么不用截图：本机环境的屏幕捕获不可用，而 UI Automation 也读不到窗口。
// 走 WebView2 的远程调试端口可以直接读取**渲染后的 DOM**，验证的是完整链路
// （Rust 命令 → IPC → React → CodeMirror 渲染），比截图更精确、也能断言。
//
// 前置：以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动应用。
//
// 用法：node scripts/gui-smoke.mjs [port]

const port = process.argv[2] ?? "9222";
const ENDPOINT = `http://127.0.0.1:${port}/json/list`;

/** 期望出现在文件树里的笔记（相对路径）。 */
const EXPECTED = [
  "cr-only.md",
  "deep/nested/folder/note.md",
  "empty.md",
  "features.md",
  "mixed-endings.md",
  "no-trailing-newline.md",
  "with-bom.md",
  "嵌入目标.md",
  "模板/周记模板.md",
  "模板/日记模板.md",
  "日记/2026-09-14.md",
  "日记/2026-W37 周记.md",
];
/** 不应出现：隐藏文件、.obsidian 下的文件、非 md 文件。 */
const FORBIDDEN = [".hidden-note.md", "app.json", "notes.txt"];

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

async function evaluate(ws, expression) {
  const result = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面内异常: ${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(ok, label, detail = "") {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
}

const targets = await fetch(ENDPOINT).then((r) => r.json()).catch((e) => {
  console.error(`无法连接调试端口 ${port}：${e.message}`);
  console.error("请确认应用已带 --remote-debugging-port 启动。");
  process.exit(1);
});

const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("没有找到 page 目标：", targets.map((t) => t.type).join(", "));
  process.exit(1);
}
console.log(`已连接页面: ${page.title || "(无标题)"}  ${page.url}\n`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
});

// 1) React 应用是否挂载
await sleep(500);
const rootHtmlLength = await evaluate(ws, `document.getElementById('root')?.innerHTML.length ?? 0`);
check(rootHtmlLength > 500, "React 应用已渲染", `#root 内容长度=${rootHtmlLength}`);

// 2) 品牌与工具栏
const brand = await evaluate(ws, `document.querySelector('.brand')?.textContent ?? ''`);
check(brand === "Quick Note", `标题正确（${brand}）`);

// 3) 仓库路径（来自命令行参数，经 Rust 命令返回）
const vaultPath = await evaluate(ws, `document.querySelector('.vault-path')?.textContent ?? ''`);
check(vaultPath.includes("test-vault"), `仓库路径已载入（${vaultPath}）`);

// 4) 文件树内容（证明 list_notes 经 IPC 返回并渲染）
const fileTitles = await evaluate(
  ws,
  `[...document.querySelectorAll('.tree-file')].map(b => b.title)`,
);
// fixture 另外还会生成两篇**按当天日期命名**的日记（今天与昨天），用于日历打点
// 与字数统计。它们的文件名随运行日期变化，所以只能计入数量、不能列进 EXPECTED。
const DATED_DAILY_NOTES = 2;
check(
  Array.isArray(fileTitles) && fileTitles.length === EXPECTED.length + DATED_DAILY_NOTES,
  `文件树条目数 = ${EXPECTED.length + DATED_DAILY_NOTES}`,
  `实际=${fileTitles?.length}`,
);
for (const want of EXPECTED) {
  check(fileTitles?.includes(want), `树中包含 ${want}`);
}
for (const bad of FORBIDDEN) {
  check(!fileTitles?.some((t) => t.includes(bad)), `树中不包含 ${bad}`);
}

// 5) 打开一篇 CRLF 笔记，验证编辑器渲染内容（走 read_note）
const target = "日记/2026-W37 周记.md";
const clicked = await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(target)}); if (!b) return false; b.click(); return true; })()`,
);
check(clicked === true, `点击了 ${target}`);
await sleep(700);

const editorText = await evaluate(ws, `document.querySelector('.cm-content')?.innerText ?? ''`);
check(editorText.includes("本周总结"), "编辑器渲染出文件内容（包含「本周总结」）");
check(editorText.includes("下一周做 M1"), "编辑器渲染出最后一行");

// 6) 状态栏应报告 CRLF（证明 Rust 探测结果贯通到界面）
const statusText = await evaluate(ws, `document.querySelector('.statusbar')?.innerText ?? ''`);
check(/CRLF/.test(statusText), `状态栏报告换行符为 CRLF`);
check(/BOM\s*无/.test(statusText), "状态栏报告无 BOM");

// 7) 未做任何编辑，不应标记为脏
const dirty = await evaluate(ws, `document.querySelector('.dirty-dot')?.classList.contains('is-dirty')`);
check(dirty === false, "仅打开文件不产生未保存状态");

ws.close();

console.log(failures.length === 0 ? "\nGUI 冒烟测试全部通过 ✓" : `\n失败 ${failures.length} 项 ✗`);
process.exit(failures.length === 0 ? 0 : 1);

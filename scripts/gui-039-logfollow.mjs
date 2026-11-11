// 0.39.3 批测：.log 日志文件的外部追加实时跟随 + 关闭标签无残留（用户反馈
// 「日志文件显示并没有实现实时更新」「关闭日志文件会残留，和主页面显示重叠」）。
// 自起 gui-test 实例（独立 UDF + 临时仓库），结束时自清理。
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9471";
const root = process.cwd();
const exe = join(root, "src-tauri", "target", "release", "quick-note.exe");
if (!existsSync(exe)) {
  console.error(`找不到 ${exe}——先构建 gui-test 变体`);
  process.exit(2);
}

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
    throw new Error(`页面内异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
  }
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
};

const waitFor = async (ws, expression, timeoutMs, pollMs = 300) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};

// ------------------------------------------------ 自备数据：临时仓库
const work = join(tmpdir(), `qn-logfollow-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "日志仓库").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });
writeFileSync(join(vault, "笔记一.md"), "# 笔记一\n\n正文内容。\n", "utf8");
const LOG_MARK = "RUN-XYZ-2026";
writeFileSync(
  join(vault, "rpt001_full_run.log"),
  Array.from({ length: 50 }, (_, i) => `line ${i} ${LOG_MARK}`).join("\n") + "\n",
  "utf8",
);
const logPath = join(vault, "rpt001_full_run.log");

const configDir = join(process.env.APPDATA ?? "", "com.quicknote.gui-test");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "vault-home.txt"), work.replace(/\\/g, "/"), "utf8");

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
      ready = list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    } catch {}
  }
  if (!ready) throw new Error("应用页面没有就绪");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  for (let i = 0; i < 30; i += 1) {
    const docReady = await evaluate(
      ws,
      `(() => { try { localStorage.getItem('__qn_probe'); return location.host === 'tauri.localhost' && document.readyState !== 'loading'; } catch { return false; } })()`,
    ).catch(() => false);
    if (docReady) break;
    await sleep(500);
  }
  // 等文件树出现（仓库加载完成）
  await waitFor(ws, `document.querySelectorAll('.tree-file').length > 0`, 20000);

  // ---- 打开日志（树行点击）
  await evaluate(
    ws,
    `(() => {
      const row = [...document.querySelectorAll('.tree-file')].find((el) => el.querySelector('.tree-label')?.textContent === 'rpt001_full_run.log');
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`,
  ).then((ok) => check(ok, "树里点开 rpt001_full_run.log"));
  await waitFor(
    ws,
    `window.__qnView && window.__qnView.state.doc.toString().includes('${LOG_MARK}')`,
    10000,
  );
  check(
    await evaluate(ws, `window.__qnView.state.doc.toString().includes('${LOG_MARK}')`),
    "日志内容进编辑器",
  );
  await sleep(400);

  // ---- 实时跟随：停在底部，外部追加一行，等 watch 去抖+读盘
  await evaluate(ws, `(() => { const s = window.__qnView.scrollDOM; s.scrollTop = s.scrollHeight; return s.scrollTop; })()`);
  const APPEND_MARK = `TAIL-MARKER-${Date.now()}`;
  appendFileSync(logPath, `${APPEND_MARK} appended externally\n`, "utf8");
  await sleep(2000);
  const followed = await evaluate(
    ws,
    `window.__qnView.state.doc.toString().includes('${APPEND_MARK}')`,
  );
  check(followed, "外部追加实时跟随（active 标签）");
  if (followed) {
    const atBottom = await evaluate(
      ws,
      `(() => { const s = window.__qnView.scrollDOM; return s.scrollHeight - s.scrollTop - s.clientHeight < 12; })()`,
    );
    check(atBottom, "跟随后仍贴底（tail 观感）");
  }

  // ---- 关闭日志标签：残留检查
  // 关闭前再追加一次（后台跟随路径在关闭后不应再影响界面）
  await evaluate(
    ws,
    `(() => {
      const tab = [...document.querySelectorAll('.tab')].find((el) => el.textContent.includes('rpt001_full_run.log'));
      if (!tab) return 'no-tab';
      const btn = tab.querySelector('.tab-close');
      if (!btn) return 'no-close-btn';
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'clicked';
    })()`,
  ).then((r) => check(r === "clicked", "点日志标签的关闭钮", String(r)));
  await sleep(800);
  const closedState = await evaluate(ws, `({
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
    docHead: (window.__qnView ? window.__qnView.state.doc.toString() : '').slice(0, 40),
  })`);
  check(
    !closedState.tabs.some((t) => t.includes("rpt001_full_run.log")),
    "标签栏里日志标签已消失",
    JSON.stringify(closedState.tabs),
  );
  // 残留检查：页面上任何**可见**元素都不该再带着日志内容
  const residue = await evaluate(
    ws,
    `(() => {
      const hits = [];
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
        if (own.includes('${LOG_MARK}') || own.includes('${APPEND_MARK}')) {
          hits.push(el.className ? String(el.className) : el.tagName);
        }
      }
      return hits;
    })()`,
  );
  check(residue.length === 0, "关闭后无日志内容残留（可见元素）", JSON.stringify(residue));

  // ---- 关闭后再追加：编辑器不该有任何变化，也不该有新弹层盖住正文
  appendFileSync(logPath, `AFTER-CLOSE-${Date.now()}\n`, "utf8");
  await sleep(1500);
  const after = await evaluate(ws, `({
    doc: window.__qnView.state.doc.toString(),
    overlays: [...document.querySelectorAll('.qn-mermaid-overlay, .qn-lightbox, .file-preview')].length,
  })`);
  check(
    !after.doc.includes("AFTER-CLOSE-") && !after.doc.includes(APPEND_MARK),
    "关闭后追加不再进入编辑器",
  );
  check(after.overlays === 0, "关闭后无浮层盖住主页面", String(after.overlays));
} catch (e) {
  console.error("批测异常:", e.message);
  failures += 1;
} finally {
  try { ws?.close(); } catch {}
  child.kill();
  await sleep(600);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

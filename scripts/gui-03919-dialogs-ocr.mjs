// 0.39.19 反馈批冒烟：弹窗拖动+置顶 / 图片 OCR（预览+灯箱）/ 代码块括号彩虹。
// 需求源 = inbox/2026-11-17.md 的 22:53 / 11:33 / 22:57 三条（22:38 去序号光标
// 与 23:01 速记自动同步走纯逻辑/既有通道，不在 GUI 层断言）。
// 自起 gui-test 实例（独立 UDF + 临时仓库），结束时自清理。
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9499";
const root = process.cwd();
const exe =
  process.env.QN_EXE ?? join(root, "src-tauri", "target", "release", "quick-note.exe");
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
    throw new Error(
      `页面内异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`,
    );
  }
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ${String(detail).slice(0, 160)}`}`);
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
/** 真鼠标（CDP Input 域）。 */
const mouse = async (ws, type, x, y, extra = {}) => {
  await cdp(ws, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
};

// ------------------------------------------------ 自备数据：临时仓库
const work = join(tmpdir(), `qn-dialogs-ocr-${Date.now()}`);
const vault = join(work, "弹窗仓库").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
mkdirSync(join(work, "udf"), { recursive: true });
writeFileSync(
  join(vault, "note.md"),
  [
    "# 弹窗冒烟",
    "",
    "```json",
    '{"a": {"b": [1, 2]}}',
    "```",
    "",
    "![[shot.png]]",
    "",
    "",
  ].join("\n"),
  "utf8",
);
copyFileSync(join(root, "src-tauri", "icons", "32x32.png"), join(vault, "shot.png"));

const configDir = join(process.env.APPDATA ?? "", "com.quicknote.gui-test");
mkdirSync(configDir, { recursive: true });
for (const name of ["sync-state.json"]) {
  try {
    rmSync(join(configDir, name), { force: true });
  } catch {}
}

const child = spawn(exe, [vault], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: join(work, "udf"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: "ignore",
  detached: false,
});

let ws = null;
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      ready = list.some(
        (t) => t.type === "page" && (t.url.includes("tauri.localhost") || t.url.includes("localhost:1420")),
      );
    } catch {}
  }
  if (!ready) throw new Error("应用页面没有就绪");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find(
    (t) => t.type === "page" && (t.url.includes("tauri.localhost") || t.url.includes("localhost:1420")),
  );
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  await waitFor(ws, `document.querySelectorAll('.tree-file').length > 0`, 20000);

  // ---- 打开笔记（编辑器渲染代码块）
  await evaluate(
    ws,
    `(() => {
      const row = [...document.querySelectorAll('.tree-file')].find(
        (el) => el.querySelector('.tree-label')?.textContent === 'note.md',
      );
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`,
  );
  await waitFor(ws, `window.__qnView && !!document.querySelector('.editor-host .cm-lp-codeblock')`, 20000);

  // ---- 1) 代码块括号彩虹：多层各档都有 span
  const rainbow = await evaluate(
    ws,
    `(() => ({
      l1: document.querySelectorAll('.editor-host .cm-lp-codeblock .qn-bracket-1').length,
      l2: document.querySelectorAll('.editor-host .cm-lp-codeblock .qn-bracket-2').length,
      l3: document.querySelectorAll('.editor-host .cm-lp-codeblock .qn-bracket-3').length,
    }))()`,
  );
  check(rainbow.l1 >= 2 && rainbow.l2 >= 2 && rainbow.l3 >= 2, "代码块括号按深度挂 1/2/3 档", JSON.stringify(rainbow));

  // ---- 2) JSON 弹窗：打开（编辑器聚焦后 Ctrl+Alt+F）
  await evaluate(
    ws,
    `(() => {
      const content = document.querySelector('.editor-host .cm-content');
      if (!content) return false;
      content.focus();
      return true;
    })()`,
  );
  await sleep(300);
  await evaluate(
    ws,
    `(() => {
      const content = document.querySelector('.editor-host .cm-content');
      content?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f', code: 'KeyF', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
      }));
      return true;
    })()`,
  );
  const jsonUp = await waitFor(ws, `!!document.querySelector('.jsonfmt')`, 5000);
  check(jsonUp, "Ctrl+Alt+F 打开 JSON 弹窗");

  // ---- 3) 头部拖动（真鼠标 + pointer capture）
  const before = await evaluate(ws, `document.querySelector('.jsonfmt').getBoundingClientRect().left`);
  const head = await evaluate(ws, `(() => {
    const rect = document.querySelector('.jsonfmt-head').getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 };
  })()`);
  await mouse(ws, "mousePressed", head.x, head.y);
  for (let step = 1; step <= 6; step += 1) {
    await mouse(ws, "mouseMoved", head.x + step * 20, head.y + step * 12);
    await sleep(40);
  }
  await mouse(ws, "mouseReleased", head.x + 120, head.y + 72);
  await sleep(200);
  const after = await evaluate(ws, `document.querySelector('.jsonfmt').getBoundingClientRect().left`);
  check(after - before > 80, "拖动头部移动弹窗", `left ${before} → ${after}`);

  // ---- 4) 📌 固定：弹窗常驻（点外不关、遮罩移除可点背后应用）——**不动窗口置顶**
  //（0.39.19 用户二轮反馈「我要的只是弹窗固定，而不是整个软件界面都固定」）
  await evaluate(ws, `document.querySelector('.jsonfmt .quick-capture-pin')?.click()`);
  await sleep(300);
  const pinned = await evaluate(
    ws,
    `({
      backdrop: !!document.querySelector('.menu-backdrop'),
      win: !!document.querySelector('.win-btn.is-on'),
    })`,
  );
  check(
    pinned.backdrop === false && pinned.win === false,
    "📌 固定：遮罩移除且不动窗口置顶",
    JSON.stringify(pinned),
  );
  // 固定后点弹窗外的编辑器区域：弹窗不关
  const editorPoint = await evaluate(ws, `(() => {
    const el = document.querySelector('.editor-host .cm-content');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left + 40, y: rect.top + 20 };
  })()`);
  if (!editorPoint) throw new Error("编辑器没找到");
  await mouse(ws, "mousePressed", editorPoint.x, editorPoint.y);
  await mouse(ws, "mouseReleased", editorPoint.x, editorPoint.y);
  await sleep(300);
  const stillOpen = await evaluate(ws, `!!document.querySelector('.jsonfmt')`);
  check(stillOpen, "固定后点击其他区域弹窗不关");

  await evaluate(ws, `document.querySelector('.jsonfmt .quick-capture-pin')?.click()`);
  await sleep(300);
  const unpinned = await evaluate(
    ws,
    `({ backdrop: !!document.querySelector('.menu-backdrop') })`,
  );
  check(unpinned.backdrop === true, "再点 📌 取消固定：遮罩恢复", JSON.stringify(unpinned));

  // ---- 5) 关闭弹窗（取消固定后点遮罩 = 点外关闭）
  const backdropPoint = await evaluate(ws, `(() => {
    const el = document.querySelector('.menu-backdrop');
    if (!el) return null;
    return { x: 30, y: Math.min(window.innerHeight - 30, (el.getBoundingClientRect().bottom || window.innerHeight) - 20) };
  })()`);
  if (!backdropPoint) throw new Error("遮罩没找到");
  await mouse(ws, "mousePressed", backdropPoint.x, backdropPoint.y);
  await mouse(ws, "mouseReleased", backdropPoint.x, backdropPoint.y);
  const jsonClosed = await waitFor(ws, `!document.querySelector('.jsonfmt')`, 3000);
  check(jsonClosed, "取消固定后点外关闭 JSON 弹窗");

  // ---- 6) 图片预览 OCR：框选识别（0.39.19 二轮澄清「不是全部识别而是识别
  // 框定的范围内的内容」）
  await evaluate(
    ws,
    `(() => {
      const row = [...document.querySelectorAll('.tree-file')].find(
        (el) => el.querySelector('.tree-label')?.textContent === 'shot.png',
      );
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`,
  );
  const ocrBtnUp = await waitFor(ws, `!!document.querySelector('.file-preview-ocr-btn')`, 15000);
  check(ocrBtnUp, "图片预览出现「框选识别」钮");
  await evaluate(ws, `document.querySelector('.file-preview-ocr-btn')?.click()`);
  const framingUp = await waitFor(ws, `!!document.querySelector('.file-preview-image.is-framing')`, 3000);
  check(framingUp, "进入框选态（十字光标 + 提示）");
  // 在图上拖一个框（真鼠标）：按下 → 分步移动 → 松手
  const imgPoint = await evaluate(
    ws,
    `(() => {
      const img = document.querySelector('.file-preview-image img');
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (!imgPoint) throw new Error("预览图没找到");
  await mouse(ws, "mousePressed", imgPoint.x, imgPoint.y);
  for (let step = 1; step <= 5; step += 1) {
    await mouse(ws, "mouseMoved", imgPoint.x + step * 18, imgPoint.y + step * 12);
    await sleep(40);
  }
  await mouse(ws, "mouseReleased", imgPoint.x + 90, imgPoint.y + 60);
  const ocrPanel = await waitFor(ws, `!!document.querySelector('.file-preview-ocr')`, 20000);
  check(ocrPanel, "框选后 OCR 结果面板出现", await evaluate(ws, `document.querySelector('.file-preview-ocr-text')?.value ?? ''`));
  await evaluate(ws, `[...document.querySelectorAll('.file-preview-ocr-head button')].find((b) => b.textContent === '关闭')?.click()`);
  await waitFor(ws, `!document.querySelector('.file-preview-ocr')`, 3000);

  // ---- 7) 灯箱 OCR（笔记内嵌图的 ⤢ 放大 → 框选）
  await evaluate(
    ws,
    `(() => {
      const row = [...document.querySelectorAll('.tree-file')].find(
        (el) => el.querySelector('.tree-label')?.textContent === 'note.md',
      );
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`,
  );
  await waitFor(ws, `!!document.querySelector('.editor-host .qn-img-toolbar')`, 15000);
  await evaluate(ws, `document.querySelector('.editor-host .qn-img-toolbar .qn-img-btn')?.click()`);
  const boxUp = await waitFor(ws, `!!document.querySelector('.qn-lightbox')`, 5000);
  check(boxUp, "⤢ 打开图片灯箱");
  await evaluate(
    ws,
    `(() => {
      [...document.querySelectorAll('.qn-lightbox-bar .qn-lightbox-btn')]
        .find((b) => b.textContent === '识别')?.click();
      return true;
    })()`,
  );
  const boxFraming = await waitFor(ws, `!!document.querySelector('.qn-lightbox.is-framing')`, 3000);
  check(boxFraming, "灯箱进入框选态");
  const boxImg = await evaluate(
    ws,
    `(() => {
      const img = document.querySelector('.qn-lightbox img');
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (!boxImg) throw new Error("灯箱图没找到");
  await mouse(ws, "mousePressed", boxImg.x, boxImg.y);
  for (let step = 1; step <= 5; step += 1) {
    await mouse(ws, "mouseMoved", boxImg.x + step * 16, boxImg.y + step * 10);
    await sleep(40);
  }
  await mouse(ws, "mouseReleased", boxImg.x + 80, boxImg.y + 50);
  const boxOcr = await waitFor(ws, `!!document.querySelector('.qn-lightbox-ocr')`, 20000);
  check(boxOcr, "灯箱框选后 OCR 面板出现");
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

console.log(failures === 0 ? "\n弹窗/OCR/括号彩虹冒烟全部通过 ✓" : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);

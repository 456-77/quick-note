// GUI 验证：速记管理视图（收件仓库整理工作台）。
//
// 覆盖：Ctrl+Alt+M 打开独立视图（占据编辑区）、收件仓库扫描（新格式 + 旧格式 +
// 已归档行）、标签聚合多选筛选、范围多选（Shift+点选）、批量加标签、跨仓库选
// 目标笔记批量归档（源行打 ^archived、目标笔记按时间正序追加）、撤销归档、
// Esc 退出。带标签的速记走快速笔记弹窗（Ctrl+Alt+N）写一行验证来源与标签落盘。
//
// 自备数据：临时收件仓库（3 条速记）+ features.md 备份，结束时全部清理还原。
//
// 用法：node scripts/gui-capture-manager.mjs <vaultDir> [port]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";

const absVault = join(process.cwd(), vault);
const inbox = join(tmpdir(), `qn-capture-inbox-${Date.now()}`);
mkdirSync(inbox, { recursive: true });
const INBOX_FILE = join(inbox, "Inbox.md");
writeFileSync(
  INBOX_FILE,
  [
    "# Inbox",
    "",
    "- 2026-09-28 09:00 旧格式速记（没有来源和标签）",
    "- 2026-09-29 10:00 [test-vault/部署.md] #想法 先把归档做出来",
    "- 2026-09-27 08:30 [test-vault] #待办 旧的一条 ^archived",
    "",
  ].join("\n"),
  "utf8",
);

const FEATURES = join(absVault, "features.md");
const featuresBackup = existsSync(FEATURES) ? readFileSync(FEATURES, "utf8") : null;

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

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}`;

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
await cdp(ws, "Page.bringToFront");
await sleep(600);

/** try 之前的种子值（finally 里要还原；const 在 try 块内 finally 看不见）。 */
let settingsBefore = null;

try {
  // ------------------------------------------------ 种子收件仓库设置并重载
  settingsBefore = await evaluate(ws, `localStorage.getItem('quicknote.settings')`);
  await evaluate(
    ws,
    `(() => {
      const raw = JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}');
      raw.quickCaptureVault = ${JSON.stringify(inbox)};
      raw.quickCaptureFile = 'Inbox.md';
      localStorage.setItem('quicknote.settings', JSON.stringify(raw));
      return true;
    })()`,
  );
  await cdp(ws, "Page.reload").catch(() => undefined);
  let booted = false;
  for (let i = 0; i < 40 && !booted; i += 1) {
    await sleep(500);
    booted = await evaluate(
      ws,
      `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0; } catch { return false; } })()`,
    ).catch(() => false);
  }
  check(booted, "应用就绪（收件仓库已配置）");

  // ------------------------------------------------ 打开速记管理（Ctrl+Alt+M）
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, altKey: true, bubbles: true }))`,
  );
  await sleep(1500); // 打开 + 600ms 防抖扫描
  check(await evaluate(ws, `!!document.querySelector('.capture-manager')`), "Ctrl+Alt+M 打开速记管理视图");
  const meta = (await evaluate(ws, `document.querySelector('.capture-scan-meta')?.textContent ?? ''`)) ?? "";
  check(meta.includes("3 条速记"), "扫描到收件仓库的 3 条速记（含旧格式与已归档）", meta);
  const tagNames = await evaluate(
    ws,
    `[...document.querySelectorAll('.capture-tag-row .capture-tag-name')].map(x => x.textContent)`,
  );
  check(tagNames.includes("#想法") && tagNames.includes("#待办"), "标签聚合列出 #想法 与 #待办", JSON.stringify(tagNames));
  const srcBadge = await evaluate(ws, `document.querySelector('.capture-row-src')?.textContent ?? ''`);
  check(srcBadge.includes("test-vault"), "来源徽标显示速记时的仓库", srcBadge);

  // ------------------------------------------------ 批量归档（全新打开后最先做：
  // 组件挂载即加载目标笔记列表；先做筛选/加标签等交互再归档会踩到列表被清空的
  // 竞态，故把归档放在所有交互之前）
  await evaluate(
    ws,
    `(() => {
      const selects = document.querySelectorAll('.capture-target-select');
      const vaultSelect = selects[0];
      vaultSelect.value = ${JSON.stringify(absVault)};
      vaultSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  // 轮询等目标笔记列表加载（最多 5s；挂载后首次 IPC 偶发慢半拍）
  for (let i = 0; i < 25; i += 1) {
    const opts = await evaluate(
      ws,
      `document.querySelectorAll('.capture-target-select')[1]?.options.length ?? 0`,
    );
    if (opts > 1) break;
    await sleep(200);
  }
  await evaluate(ws, `document.querySelectorAll('.capture-row-check')[0].click()`);
  await sleep(350); // 两次勾选之间等一次渲染（连续 click 会撞重渲染竞态）
  await evaluate(ws, `document.querySelectorAll('.capture-row-check')[1].click()`);
  await sleep(400);
  await evaluate(
    ws,
    `(() => {
      const selects = document.querySelectorAll('.capture-target-select');
      const noteSelect = selects[1];
      noteSelect.value = 'features.md';
      noteSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  await sleep(300);
  const diag = await evaluate(ws, `(() => {
    const selects = document.querySelectorAll('.capture-target-select');
    const btn = document.querySelector('.capture-archive-btn');
    return JSON.stringify({
      vaultVal: selects[0]?.value ?? null,
      noteVal: selects[1]?.value ?? null,
      noteOpts: selects[1] ? selects[1].options.length : 0,
      btnDisabled: btn ? btn.disabled : null,
      checks: [...document.querySelectorAll('.capture-row-check')].map((box) => box.checked),
    });
  })()`);
  console.log("  diag:", diag);
  await evaluate(ws, `document.querySelector('.capture-archive-btn')?.click()`);
  await sleep(1800);
  const features = existsSync(FEATURES) ? readFileSync(FEATURES, "utf8") : "";
  check(
    (features.match(/^- 2026-09-\d{2} /gm) ?? []).length === 2,
    "目标笔记末尾追加 2 条速记（剥掉归档标记）",
    JSON.stringify(features.slice(-260)),
  );
  check(!features.includes("^archived"), "目标笔记里没有归档标记");
  const inboxAfterArchive = readFileSync(INBOX_FILE, "utf8");
  check(
    inboxAfterArchive.split("\n").filter((line) => line.includes("^archived")).length === 3,
    "源速记行打上 ^archived（2 条新归档 + 1 条旧的）",
    JSON.stringify(inboxAfterArchive),
  );

  // ------------------------------------------------ 已归档视图 + 撤销归档
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.capture-scope-tab')].find(x => x.textContent.includes('已归档')); tab?.click(); return true; })()`,
  );
  await sleep(600);
  const archivedRows = await evaluate(ws, `document.querySelectorAll('.capture-row').length`);
  check(archivedRows === 3, "已归档视图显示 3 条", String(archivedRows));
  await evaluate(ws, `[...document.querySelectorAll('.capture-row-act')].find(b => b.textContent.includes('撤销归档'))?.click()`);
  await sleep(1400);
  const afterUndo = readFileSync(INBOX_FILE, "utf8");
  check(
    afterUndo.split("\n").filter((line) => line.includes("^archived")).length === 2,
    "撤销归档剥掉一条源行标记",
    JSON.stringify(afterUndo),
  );

  // ------------------------------------------------ 标签筛选（切到全部视图；多选 = 任一命中）
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.capture-scope-tab')].find(x => x.textContent.includes('全部')); tab?.click(); return true; })()`,
  );
  await sleep(400);
  await evaluate(
    ws,
    `(() => { const row = [...document.querySelectorAll('.capture-tag-row')].find(x => x.textContent.includes('#想法')); row?.querySelector('input')?.click(); return true; })()`,
  );
  await sleep(400);
  const filteredByTag = await evaluate(ws, `document.querySelectorAll('.capture-row').length`);
  check(filteredByTag === 1, "勾选 #想法 后只剩 1 条", String(filteredByTag));
  await evaluate(ws, `document.querySelector('.capture-clear')?.click()`);
  await sleep(300);

  // ------------------------------------------------ 范围多选（Shift+点选；未归档 2 条）
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.capture-scope-tab')].find(x => x.textContent.includes('未归档')); tab?.click(); return true; })()`,
  );
  await sleep(400);
  // 注意：querySelectorAll 返回的 NodeList 不能整包 returnByValue（循环引用会炸
  // "Object reference chain is too long"），要用只取数量的表达式或页面内取值。
  await evaluate(ws, `document.querySelectorAll('.capture-row-check')[0].click()`);
  await evaluate(
    ws,
    `(() => {
      const boxes = document.querySelectorAll('.capture-row-check');
      boxes[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      return true;
    })()`,
  );
  await sleep(400);
  const archiveLabel = (await evaluate(ws, `document.querySelector('.capture-archive-btn')?.textContent ?? ''`)) ?? "";
  check(archiveLabel.includes("(2)"), "Shift+点选范围多选了 2 条", archiveLabel);

  // ------------------------------------------------ 批量加标签
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.capture-tag-input'); (${nativeSet})(el, '整理'); return true; })()`,
  );
  await evaluate(ws, `[...document.querySelectorAll('.capture-side .btn')].find(b => b.textContent.includes('加标签'))?.click()`);
  await sleep(1200);
  const inboxAfterTag = readFileSync(INBOX_FILE, "utf8");
  check(
    inboxAfterTag.split("\n").filter((line) => line.includes("#整理")).length === 2,
    "批量加标签写入 2 条速记行",
    JSON.stringify(inboxAfterTag),
  );

  // ------------------------------------------------ 带标签速记走弹窗落盘
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.capture-scope-tab')].find(x => x.textContent.includes('未归档')); tab?.click(); return true; })()`,
  );
  await evaluate(ws, `document.querySelector('.capture-manager .icon-btn[title="返回笔记 (Esc)"]')?.click()`);
  await sleep(500);
  check(!(await evaluate(ws, `!!document.querySelector('.capture-manager')`)), "返回笔记按钮退出速记管理");
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, altKey: true, bubbles: true }))`,
  );
  await sleep(500);
  check(await evaluate(ws, `!!document.querySelector('.quick-capture')`), "快速笔记弹窗唤起");
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.quick-capture textarea'); (${nativeSet})(el, '带标签的新速记'); return true; })()`,
  );
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.quick-capture-tags'); (${nativeSet})(el, '想法 项目A'); return true; })()`,
  );
  await evaluate(
    ws,
    `document.querySelector('.quick-capture textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  await sleep(1500);
  const inboxFinal = readFileSync(INBOX_FILE, "utf8");
  check(
    /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[test-vault\] #想法 #项目A 带标签的新速记$/m.test(inboxFinal),
    "速记行带来源与标签落盘",
    JSON.stringify(inboxFinal.split("\n").filter((line) => line.includes("带标签的新速记"))),
  );

  // ------------------------------------------------ Esc 退出速记管理
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, altKey: true, bubbles: true }))`,
  );
  await sleep(1200);
  check(await evaluate(ws, `!!document.querySelector('.capture-manager')`), "再次打开速记管理");
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  check(!(await evaluate(ws, `!!document.querySelector('.capture-manager')`)), "Esc 退出速记管理回笔记");
} finally {
  // ------------------------------------------------------------- 清理
  rmSync(inbox, { recursive: true, force: true });
  if (featuresBackup !== null) writeFileSync(FEATURES, featuresBackup, "utf8");
  else rmSync(FEATURES, { force: true });
  if (settingsBefore !== null) {
    await evaluate(ws, `localStorage.setItem('quicknote.settings', ${JSON.stringify(settingsBefore)}); true`).catch(
      () => undefined,
    );
  }
  ws.close();
}

console.log(failures === 0 ? "\n速记管理验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

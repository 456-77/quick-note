// GUI 验证：顺延提醒、跳到末尾、代码块语义色、快速笔记、标签仪表盘。
//
// 顺延提示回看**所有**往日待办（不止昨天——放几天假回来昨天没有待办也要提示）；
// Ctrl+End 滚到笔记末尾；代码块按围栏 info 上语义色（log 报错红 / yaml 等配置青，
// log 块 ERROR 行仍按行着色）；Ctrl+Alt+N 速记追加进收件仓库；新笔记自动打
// 「待整理」标签并在标签仪表盘置顶、可一键移除。
//
// 自备数据：种一条 3 天前的未完成待办、临时收件仓库、两篇 zz-*.md，结束时全部
// 清理并还原配置与设置。
//
// 前置：gui-test 变体已启动（CDP 9222），test-vault 已生成。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";

const absVault = join(process.cwd(), vault);
const inbox = join(tmpdir(), `qn-inbox-${Date.now()}`);
mkdirSync(inbox, { recursive: true });
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const pastDay = (() => {
  const d = new Date(Date.now() - 3 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const mmdd = pastDay.slice(5).replace("-", "-");

const CONFIG = join(absVault, "quick-daily-note.json");
const configBackup = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : null;
const settingsBackup = [];

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

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}`;

const clickTreeFile = (path) =>
  evaluate(
    ws,
    `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title.startsWith(${JSON.stringify(path)})); if (!b) return false; b.click(); return true; })()`,
  );

try {
  // ---------- 种子设置（收件仓库）并重载 ----------
  settingsBackup.push(await evaluate(ws, `localStorage.getItem('quicknote.settings')`));
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

  // ---------- 1. 顺延提示：往日待办（昨天没有、3 天前有） ----------
  const cfg = configBackup ? JSON.parse(configBackup) : {};
  cfg.dateFormat = cfg.dateFormat ?? "YYYY-MM-DD";
  cfg.todos = cfg.todos ?? {};
  cfg.todos[pastDay] = [
    ...(cfg.todos[pastDay] ?? []).filter((t) => !t.deleted),
    { id: `tmp-${pastDay}`, text: "顺延验证待办", done: false, updatedAt: 0 },
  ];
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
  await sleep(1600); // 文件监听 → 配置重载

  const carryVisible = await evaluate(ws, `!!document.querySelector('.cal-carryover')`);
  const carryText = (await evaluate(ws, `document.querySelector('.cal-carryover')?.textContent ?? ''`)) ?? "";
  check(carryVisible, "往日有未完成待办时顺延提示出现（昨天没有也提示）", carryText);
  check(carryText.includes("待办未完成"), "提示文案说明未完成数", carryText);
  await evaluate(ws, `document.querySelector('.cal-carryover-btn')?.click()`);
  await sleep(1200);
  const todoAll = await evaluate(
    ws,
    `[...document.querySelectorAll('.cal-todo')].map(x => x.textContent).join('\\n')`,
  );
  check(
    todoAll.includes("顺延验证待办") && todoAll.split("\n").some((row) => row.includes("顺延验证待办") && row.includes("遗留")),
    "一键顺延后今天出现带「遗留」前缀的条目",
    todoAll,
  );
  const cfgAfter = JSON.parse(readFileSync(CONFIG, "utf8"));
  const movedSource = (cfgAfter.todos[pastDay] ?? []).find((t) => t.text === "顺延验证待办");
  check(Boolean(movedSource?.deleted), "源日期条目已打墓碑");

  // ---------- 2. 跳到笔记末尾 ----------
  const LONG = "zz-跳转测试.md";
  writeFileSync(join(absVault, LONG), "# 长笔记\n\n" + Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行内容。`).join("\n") + "\n", "utf8");
  await sleep(1400);
  check(await clickTreeFile(LONG), "打开长笔记");
  await sleep(900);
  const scroll = await evaluate(
    ws,
    `(() => {
      const scroller = document.querySelector('.cm-scroller');
      if (!scroller) return null;
      return { before: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight };
    })()`,
  );
  await sleep(400);
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true }))`,
  );
  await sleep(700);
  const after = await evaluate(
    ws,
    `(() => {
      const scroller = document.querySelector('.cm-scroller');
      if (!scroller) return null;
      const lines = scroller.querySelectorAll('.cm-line');
      const last = lines[lines.length - 1];
      if (!last) return null;
      // 判据是「最后一行进入可视区」：scroller 底部有留白，scrollTop 到不了 max
      const visible = last.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().bottom + 2;
      return { visible, top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight };
    })()`,
  );
  check(
    scroll && after && scroll.before < 40 && after.visible,
    "Ctrl+End 滚动到笔记末尾（最后一行可见）",
    JSON.stringify({ scroll, after }),
  );

  // ---------- 3. 代码块语义色 ----------
  const CODE = "zz-代码块样式.md";
  writeFileSync(
    join(absVault, CODE),
    [
      "# 代码块样式",
      "",
      "```yaml",
      "server:",
      "  port: 8080",
      "```",
      "",
      "```log",
      "2026-09-29 10:00:00 ERROR o.a.c.C.ContainerBase 服务异常",
      "at com.foo.Bar.baz(Bar.java:42)",
      "2026-09-29 10:00:01 INFO  o.a.c.C.ContainerBase 已恢复",
      "```",
      "",
      "```java",
      "int x = 1;",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  await sleep(1400);
  check(await clickTreeFile(CODE), "打开代码块样式测试笔记");
  await sleep(1200);
  const counts = await evaluate(
    ws,
    `(() => ({
      config: document.querySelectorAll('.cm-line.cm-lp-codeblock-config').length,
      log: document.querySelectorAll('.cm-line.cm-lp-codeblock-log').length,
      logErrorRow: document.querySelectorAll('.cm-line.cm-lp-log-error').length,
      plain: document.querySelectorAll('.cm-line.cm-lp-codeblock:not(.cm-lp-codeblock-log):not(.cm-lp-codeblock-config)').length,
    }))()`,
  );
  check(counts.config >= 3, "yaml 块有配置语义色行", JSON.stringify(counts));
  check(counts.log >= 4, "log 块有报错语义色行", JSON.stringify(counts));
  check(counts.logErrorRow >= 2, "log 块 ERROR/栈帧行仍按行级别着色（特异性修复）", JSON.stringify(counts));
  check(counts.plain >= 2, "java 块走默认样式", JSON.stringify(counts));
  // 截图供人工目检
  const shot = await cdp(ws, "Page.captureScreenshot", { format: "png" });
  writeFileSync(join(tmpdir(), "qn-codeblock-style.png"), Buffer.from(shot.data, "base64"));
  console.log(`  （代码块截图：${join(tmpdir(), "qn-codeblock-style.png")}）`);

  // ---------- 4. 快速笔记捕获 ----------
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, altKey: true, bubbles: true }))`,
  );
  await sleep(500);
  check(await evaluate(ws, `!!document.querySelector('.quick-capture')`), "快捷键唤起快速笔记弹窗");
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.quick-capture textarea'); (${nativeSet})(el, '快速笔记验证条目'); return true; })()`,
  );
  await evaluate(
    ws,
    `document.querySelector('.quick-capture textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  await sleep(1500);
  const inboxFile = join(inbox, "Inbox.md");
  const inboxContent = existsSync(inboxFile) ? readFileSync(inboxFile, "utf8") : "";
  check(inboxContent.includes("快速笔记验证条目"), "速记写入收件文件", JSON.stringify(inboxContent));
  check(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} 快速笔记验证条目$/m.test(inboxContent), "速记带日期时间前缀");
  check(inboxContent.startsWith("# Inbox"), "收件文件自动建「# Inbox」头");
  check(!(await evaluate(ws, `!!document.querySelector('.quick-capture')`)), "写入成功后弹窗关闭");

  // ---------- 5. 自动「待整理」标签 + 标签仪表盘 ----------
  await evaluate(
    ws,
    `(() => { const b = [...document.querySelectorAll('.sidebar .panel-head button')].find(x => (x.title || '').includes('新建笔记')); if (!b) return false; b.click(); return true; })()`,
  );
  await sleep(400);
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.create-row input'); (${nativeSet})(el, '待整理验证笔记'); return true; })()`,
  );
  await evaluate(
    ws,
    `document.querySelector('.create-row input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  await sleep(1500);
  const autoNote = join(absVault, "待整理验证笔记.md");
  const autoContent = existsSync(autoNote) ? readFileSync(autoNote, "utf8") : "";
  check(autoContent === "# 待整理验证笔记\n\n#待整理\n", "新笔记自动带标题与「待整理」标签", JSON.stringify(autoContent));

  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.left-view-tab')].find(x => x.textContent.includes('标签')); if (!tab) return false; tab.click(); return true; })()`,
  );
  await sleep(2000); // 600ms 防抖 + 扫描
  const firstTag = await evaluate(ws, `document.querySelector('.tag-dash-row .tree-label')?.textContent ?? ''`);
  check(firstTag === "待整理", "「待整理」标签置顶", firstTag);
  await evaluate(ws, `[...document.querySelectorAll('.tag-dash-row')].find(x => x.textContent.includes('待整理'))?.click()`);
  await sleep(500);
  const noteRow = await evaluate(ws, `[...document.querySelectorAll('.tag-dash .tree-file')].length`);
  check(noteRow >= 1, "点标签看到带它的笔记列表", String(noteRow));
  // 从仪表盘移除标签（笔记当前是激活标签 → 走编辑器路径，等自动保存落盘）
  await evaluate(ws, `document.querySelector('.tag-dash-chip-x')?.click()`);
  await sleep(2600);
  const afterRemove = existsSync(autoNote) ? readFileSync(autoNote, "utf8") : "";
  check(!afterRemove.includes("#待整理"), "仪表盘一键移除标签后文件已落盘更新", JSON.stringify(afterRemove));
} finally {
  // ---------- 清理 ----------
  for (const name of ["zz-跳转测试.md", "zz-代码块样式.md", "待整理验证笔记.md"]) {
    rmSync(join(absVault, name), { force: true });
  }
  rmSync(inbox, { recursive: true, force: true });
  if (configBackup !== null) writeFileSync(CONFIG, configBackup, "utf8");
  else rmSync(CONFIG, { force: true });
  if (settingsBackup[0] !== null) {
    await evaluate(ws, `localStorage.setItem('quicknote.settings', ${JSON.stringify(settingsBackup[0])}); true`).catch(() => undefined);
  }
  ws.close();
}

console.log(failures === 0 ? "\n0929 批次验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

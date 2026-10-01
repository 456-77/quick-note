// GUI 验证：Inbox（速记管理）视图——新 UI（cm-* 命名空间）。
//
// 覆盖：Ctrl+Alt+M 打开、顶栏（标题/统计/搜索/更多菜单）、分段切换（计数）、
// 筛选 Popover（来源/标签/日期/排序）、筛选 chips、日期分组（今天/昨天/更早）、
// 行结构（checkbox + 2 行截断 + meta）、行内编辑、批量栏（选择后浮出：目标
// 仓库/笔记 + 加标签 + 归档 + 删除 + 取消）、归档 Toast（已归档到…+ 撤销）、
// 详情抽屉（时间/内容/标签/来源/归档目标 + 删除/归档）、空状态（Inbox 已清空）、
// Esc 逐层退出。快速笔记弹窗带标签落盘走 gui-capture-and-tags.mjs，不在此重复。
//
// 自备数据：临时收件仓库（3 条速记，时间分布今天/昨天/更早）+ features.md 备份，
// 结束时全部清理还原。
//
// 用法：node scripts/gui-capture-manager.mjs <vaultDir> [port]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";

// 规范成正斜杠：批量栏的仓库 <select> 候选来自应用侧（正斜杠风格），
// 赋值 .value 时必须与 option 值逐字一致才选得上（fs 调用两种写法都认）。
const absVault = join(process.cwd(), vault).replace(/\\/g, "/");
const inbox = join(tmpdir(), `qn-capture-inbox-${Date.now()}`);
mkdirSync(inbox, { recursive: true });
const INBOX_FILE = join(inbox, "Inbox.md");

/** 今天 / 昨天 / 更早 各一条（本地时区；今天那条用于分组与统计断言）。 */
const dayStamp = (offsetDays, hhmm) => {
  const d = new Date(Date.now() - offsetDays * 86400000);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${day} ${hhmm}`;
};

const ENTRY_TODAY = dayStamp(0, "15:58");
const ENTRY_YESTERDAY = dayStamp(1, "09:30");
const ENTRY_EARLIER = dayStamp(5, "08:30");
writeFileSync(
  INBOX_FILE,
  [
    "# Inbox",
    "",
    `- ${ENTRY_TODAY} [test-vault/部署.md] #想法 #项目A 给快速笔记添加一个页面`,
    `- ${dayStamp(0, "09:00")} [test-vault] #测试 Redis 配置`,
    `- ${ENTRY_YESTERDAY} [test-vault] #待办 Maven 镜像配置`,
    `- ${ENTRY_EARLIER} 旧格式速记（没有来源和标签） ^archived`,
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

/** try 外的种子值（finally 里要还原）。 */
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

  // ------------------------------------------------ 打开 Inbox（Ctrl+Alt+M）
  await evaluate(
    ws,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, altKey: true, bubbles: true }))`,
  );
  await sleep(1800);
  check(await evaluate(ws, `!!document.querySelector('.cm-root')`), "Ctrl+Alt+M 打开 Inbox 视图");
  check(
    ((await evaluate(ws, `document.querySelector('.cm-title')?.textContent ?? ''`)) ?? "") === "Inbox",
    "顶栏标题为 Inbox",
  );
  const stats = (await evaluate(ws, `document.querySelector('.cm-head-stats')?.textContent ?? ''`)) ?? "";
  check(
    stats.includes("未归档 3") && stats.includes("今日新增 2") && stats.includes("今日已整理 0"),
    "轻量统计：未归档 3 · 今日新增 2 · 今日已整理 0",
    stats,
  );
  const segTexts = await evaluate(
    ws,
    `[...document.querySelectorAll('.cm-seg-btn')].map((b) => b.textContent)`,
  );
  check(
    segTexts.length === 3 && segTexts[0].includes("未归档") && segTexts[0].includes("3") && segTexts[1].includes("已归档") && segTexts[1].includes("1") && segTexts[2].includes("4"),
    "分段控制：未归档 3 / 已归档 1 / 全部 4",
    JSON.stringify(segTexts),
  );

  // ------------------------------------------------ 列表与分组
  // 先切「全部」：未归档视图里那条更早的种子速记是已归档的，看不到「更早」组
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.cm-seg-btn')].find((b) => b.textContent.includes('全部')); tab?.click(); return true; })()`,
  );
  await sleep(400);
  const groupLabels = await evaluate(
    ws,
    `[...document.querySelectorAll('.cm-group-head')].map((g) => g.textContent)`,
  );
  check(
    groupLabels.join(",") === "今天,昨天,更早",
    "按 今天/昨天/更早 分组",
    JSON.stringify(groupLabels),
  );
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.cm-seg-btn')].find((b) => b.textContent.includes('未归档')); tab?.click(); return true; })()`,
  );
  await sleep(400);
  const firstRow = await evaluate(
    ws,
    `(() => {
      const row = document.querySelector('.cm-row');
      return JSON.stringify({
        text: row?.querySelector('.cm-row-text')?.textContent ?? '',
        clamp: getComputedStyle(row?.querySelector('.cm-row-text') ?? document.body).webkitLineClamp,
        time: row?.querySelector('.cm-row-time')?.textContent ?? '',
        tags: [...(row?.querySelectorAll('.cm-tag') ?? [])].map((t) => t.textContent),
      });
    })()`,
  );
  const firstRowParsed = JSON.parse(firstRow);
  check(firstRowParsed.text.includes("给快速笔记添加一个页面"), "第一行是今天的速记", firstRow);
  check(firstRowParsed.clamp === "2", "正文 2 行截断");
  check(firstRowParsed.time === "15:58", "今天组内只显示 HH:mm", firstRowParsed.time);
  check(
    firstRowParsed.tags.join(",") === "#想法,#项目A",
    "标签 chips 显示",
    JSON.stringify(firstRowParsed.tags),
  );

  // ------------------------------------------------ 搜索
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.cm-search'); (${nativeSet})(el, '镜像'); return true; })()`,
  );
  await sleep(400);
  check((await evaluate(ws, `document.querySelectorAll('.cm-row').length`)) === 1, "搜索过滤到 1 条");
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.cm-search'); (${nativeSet})(el, ''); return true; })()`,
  );
  await sleep(300);

  // ------------------------------------------------ 标签 Popover 筛选
  await evaluate(
    ws,
    `(() => { const btn = [...document.querySelectorAll('.cm-tool-btn')].find((b) => b.textContent === '标签'); btn?.click(); return true; })()`,
  );
  await sleep(400);
  check(await evaluate(ws, `!!document.querySelector('.cm-pop')`), "标签 Popover 打开");
  await evaluate(
    ws,
    `(() => { const row = [...document.querySelectorAll('.cm-pop-row')].find((x) => x.textContent.includes('#想法')); row?.querySelector('input')?.click(); return true; })()`,
  );
  await sleep(400);
  check((await evaluate(ws, `document.querySelectorAll('.cm-row').length`)) === 1, "勾选 #想法 后只剩 1 条");
  const chipText = (await evaluate(ws, `document.querySelector('.cm-chip')?.textContent ?? ''`)) ?? "";
  check(chipText.includes("#想法"), "筛选 chip 出现", chipText);
  await evaluate(ws, `document.querySelector('.cm-chip')?.click()`);
  await sleep(300);
  await evaluate(ws, `document.querySelector('.cm-pop-backdrop')?.click()`);
  await sleep(300);

  // ------------------------------------------------ 日期与排序 Popover
  await evaluate(
    ws,
    `(() => { const btn = [...document.querySelectorAll('.cm-tool-btn')].find((b) => b.textContent === '日期'); btn?.click(); return true; })()`,
  );
  await sleep(300);
  await evaluate(
    ws,
    `(() => { const item = [...document.querySelectorAll('.cm-pop-item')].find((x) => x.textContent === '今天'); item?.click(); return true; })()`,
  );
  await sleep(300);
  check((await evaluate(ws, `document.querySelectorAll('.cm-row').length`)) === 2, "日期筛选「今天」剩 2 条（种子有两条今日速记）");
  // Popover 语义：点选项**不关闭**（便于连续调整），点按钮是 toggle、点遮罩是关闭。
  // 所以选完「今天」后 popover 仍开着——恢复「全部日期」直接点选项，再点按钮关闭。
  await evaluate(
    ws,
    `(() => { const item = [...document.querySelectorAll('.cm-pop-item')].find((x) => x.textContent === '全部日期'); item?.click(); return true; })()`,
  );
  await sleep(200);
  await evaluate(
    ws,
    `(() => { const btn = [...document.querySelectorAll('.cm-tool-btn')].find((b) => b.textContent === '日期'); btn?.click(); return true; })()`,
  );
  await sleep(200);
  check(!(await evaluate(ws, `!!document.querySelector('.cm-pop-backdrop')`)), "日期筛选恢复全部并关闭 popover");
  // ------------------------------------------------ 排序（同组内翻转：今天组有两条）
  const firstBeforeSort = (await evaluate(ws, `document.querySelector('.cm-row-time')?.textContent ?? ''`)) ?? "";
  check(firstBeforeSort === "15:58", "默认最新优先：今天组第一行是 15:58", firstBeforeSort);
  await evaluate(
    ws,
    `(() => { const btn = [...document.querySelectorAll('.cm-tool-btn')].find((b) => b.textContent === '排序'); btn?.click(); return true; })()`,
  );
  await sleep(300);
  await evaluate(
    ws,
    `(() => { const item = [...document.querySelectorAll('.cm-pop-item')].find((x) => x.textContent === '最早优先'); item?.click(); return true; })()`,
  );
  await sleep(400);
  const firstAfterSort = (await evaluate(ws, `document.querySelector('.cm-row-time')?.textContent ?? ''`)) ?? "";
  check(firstAfterSort === "09:00", "最早优先：今天组内翻转为 09:00 在前", firstAfterSort);
  // 恢复最新优先：选项点击不关 popover，先点遮罩关闭、再重开选择
  await evaluate(ws, `document.querySelector('.cm-pop-backdrop')?.click()`);
  await sleep(200);
  await evaluate(
    ws,
    `(() => { const btn = [...document.querySelectorAll('.cm-tool-btn')].find((b) => b.textContent === '排序'); btn?.click(); return true; })()`,
  );
  await sleep(300);
  await evaluate(
    ws,
    `(() => { const item = [...document.querySelectorAll('.cm-pop-item')].find((x) => x.textContent === '最新优先'); item?.click(); return true; })()`,
  );
  await sleep(300);
  await evaluate(ws, `document.querySelector('.cm-pop-backdrop')?.click()`);
  await sleep(200);

  // ------------------------------------------------ 行内编辑
  // 行 hover 快捷按钮：编辑 / 标签 / 归档；⋯ 菜单收「复制文本/删除」
  await evaluate(ws, `[...document.querySelectorAll('.cm-row-quick')].find((b) => b.textContent === '编辑')?.click()`);
  await sleep(300);
  check(await evaluate(ws, `!!document.querySelector('.cm-row-edit')`), "hover「编辑」展开行内编辑");
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.cm-row-edit'); (${nativeSet})(el, '给快速笔记添加一个页面（改）'); return true; })()`,
  );
  await evaluate(
    ws,
    `document.querySelector('.cm-row-edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  await sleep(1400);
  const inboxAfterEdit = readFileSync(INBOX_FILE, "utf8");
  check(
    inboxAfterEdit.includes("给快速笔记添加一个页面（改）"),
    "行内编辑写回收件文件（保留时间戳/来源/标签）",
    JSON.stringify(inboxAfterEdit.split("\n").find((line) => line.includes("（改）")) ?? ""),
  );

  // ------------------------------------------------ 勾选 → 批量栏
  await evaluate(ws, `document.querySelectorAll('.cm-check')[0].click()`);
  await sleep(350);
  check(await evaluate(ws, `!!document.querySelector('.cm-toolbar.is-batch')`), "勾选后工具栏切批量模式（不遮列表）");
  check(
    (await evaluate(ws, `document.querySelector('.app')?.className ?? ''`)).includes("inbox-open"),
    "Inbox 模式挂 inbox-open 类（响应式生效入口）",
  );
  const rightVisible = await evaluate(
    ws,
    `(() => { const el = document.querySelector('.sidebar-right'); return el ? getComputedStyle(el).display !== 'none' : false; })()`,
  );
  const leftVisible = await evaluate(
    ws,
    `(() => { const el = document.querySelector('.sidebar-left'); return el ? getComputedStyle(el).display !== 'none' : false; })()`,
  );
  check(leftVisible && !rightVisible, "中等窗口：左栏保留、右栏隐藏（<1400）");
  const batchCount = (await evaluate(ws, `document.querySelector('.cm-batch-count')?.textContent ?? ''`)) ?? "";
  check(batchCount.includes("已选择 1 条"), "批量栏显示已选择条数", batchCount);

  // 批量加标签
  await evaluate(ws, `[...document.querySelectorAll('.cm-toolbar.is-batch .cm-btn')].find((b) => b.textContent === '添加标签')?.click()`);
  await sleep(300);
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.cm-batch-tag-input'); (${nativeSet})(el, '整理'); return true; })()`,
  );
  await evaluate(
    ws,
    `document.querySelector('.cm-batch-tag-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  await sleep(1400);
  check(
    readFileSync(INBOX_FILE, "utf8").includes("#整理"),
    "批量加标签写入速记行",
    JSON.stringify(readFileSync(INBOX_FILE, "utf8").split("\n").find((line) => line.includes("#整理")) ?? ""),
  );

  // ------------------------------------------------ 批量归档（跨仓库目标）
  // 重新勾选两条（加标签后选择被清空并重扫）
  await evaluate(ws, `document.querySelectorAll('.cm-check')[0].click()`);
  await sleep(350);
  await evaluate(ws, `document.querySelectorAll('.cm-check')[1].click()`);
  await sleep(350);
  // 「移动到」命令面板式选择器：打开 → 仓库 chip → 搜索 → Enter 确认
  await evaluate(ws, `document.querySelector('.cm-batch-target')?.click()`);
  await sleep(500);
  check(await evaluate(ws, `!!document.querySelector('.cm-target-pop')`), "「移动到」打开命令面板式选择器");
  check(
    await evaluate(ws, `!!document.querySelector('.cm-target-search')`) &&
      (await evaluate(ws, `document.querySelectorAll('.cm-target-vault').length`)) > 1,
    "选择器含搜索框与仓库 chips",
  );
  await evaluate(
    ws,
    `(() => { const chip = [...document.querySelectorAll('.cm-target-vault')].find((b) => b.textContent === 'test-vault'); chip?.click(); return true; })()`,
  );
  await sleep(700);
  await evaluate(
    ws,
    `(() => { const el = document.querySelector('.cm-target-search'); (${nativeSet})(el, 'features'); return true; })()`,
  );
  await sleep(300);
  await evaluate(
    ws,
    `document.querySelector('.cm-target-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  await sleep(500);
  const targetLabel = (await evaluate(ws, `document.querySelector('.cm-batch-target')?.textContent ?? ''`)) ?? "";
  check(targetLabel.includes("features.md"), "Enter 确认后「移动到」显示所选笔记", targetLabel);
  await sleep(300);
  await evaluate(ws, `[...document.querySelectorAll('.cm-toolbar.is-batch .cm-btn')].find((b) => b.textContent === '归档')?.click()`);
  await sleep(1800);
  const features = existsSync(FEATURES) ? readFileSync(FEATURES, "utf8") : "";
  check(
    (features.match(/^- \d{4}-\d{2}-\d{2} /gm) ?? []).length === 2,
    "目标笔记末尾追加 2 条速记（剥掉归档标记）",
    JSON.stringify(features.slice(-240)),
  );
  check(!features.includes("^archived"), "目标笔记里没有归档标记");
  check(
    readFileSync(INBOX_FILE, "utf8").split("\n").filter((line) => line.includes("^archived")).length === 3,
    "源速记行打上 ^archived",
    JSON.stringify(readFileSync(INBOX_FILE, "utf8")),
  );
  const statsText = (await evaluate(ws, `document.querySelector('.cm-head-stats')?.textContent ?? ''`)) ?? "";
  check(statsText.includes("最近整理"), "顶栏统计出现「最近整理」", statsText);
  const selShadow = await evaluate(
    ws,
    `(() => {
      const row = document.querySelector('.cm-row.is-sel');
      return row ? getComputedStyle(row).boxShadow !== 'none' : 'no-sel-row';
    })()`,
  );
  check(selShadow === true || selShadow === "no-sel-row", "选中行有左 accent 标识或已随归档清除", String(selShadow));

  // ------------------------------------------------ Toast + 撤销
  const toastText = (await evaluate(ws, `document.querySelector('.cm-toast')?.textContent ?? ''`)) ?? "";
  check(toastText.includes("已归档") && toastText.includes("features.md"), "Toast 提示已归档到目标笔记", toastText);
  await evaluate(ws, `document.querySelector('.cm-toast-undo')?.click()`);
  await sleep(1400);
  check(
    readFileSync(INBOX_FILE, "utf8").split("\n").filter((line) => line.includes("^archived")).length === 1,
    "Toast 撤销剥掉一条归档标记",
    JSON.stringify(readFileSync(INBOX_FILE, "utf8")),
  );

  // ------------------------------------------------ 详情抽屉
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.cm-seg-btn')].find((b) => b.textContent.includes('已归档')); tab?.click(); return true; })()`,
  );
  await sleep(500);
  await evaluate(ws, `document.querySelector('.cm-row')?.click()`);
  await sleep(500);
  check(await evaluate(ws, `!!document.querySelector('.cm-drawer')`), "点击行打开详情抽屉");
  const drawerText = (await evaluate(ws, `document.querySelector('.cm-drawer')?.textContent ?? ''`)) ?? "";
  check(
    drawerText.includes("时间") && drawerText.includes("内容") && drawerText.includes("标签") && drawerText.includes("归档目标"),
    "抽屉含 时间/内容/标签/归档目标",
    drawerText.slice(0, 160),
  );
  // 抽屉里撤销归档（按钮完成操作后顺手关闭抽屉，直接回到列表）
  await evaluate(ws, `[...document.querySelectorAll('.cm-drawer-foot .cm-btn')].find((b) => b.textContent === '撤销归档')?.click()`);
  await sleep(1400);
  check(
    readFileSync(INBOX_FILE, "utf8").split("\n").filter((line) => line.includes("^archived")).length === 0,
    "抽屉撤销归档剥掉标记",
  );
  check(!(await evaluate(ws, `!!document.querySelector('.cm-drawer')`)), "抽屉操作完成后自动关闭（视图保留）");
  check(await evaluate(ws, `!!document.querySelector('.cm-root')`), "抽屉操作后 Inbox 视图仍在");

  // ------------------------------------------------ 空状态 + Esc 层级
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.cm-seg-btn')].find((b) => b.textContent.includes('未归档')); tab?.click(); return true; })()`,
  );
  await sleep(500);
  // 归档剩余未归档条目（全部 4 条）→ 空状态（需要目标笔记；沿用批量栏目标）
  for (const idx of [0, 1, 2, 3]) {
    await evaluate(ws, `document.querySelectorAll('.cm-check')[${idx}].click()`);
    await sleep(300);
  }
  await evaluate(ws, `[...document.querySelectorAll('.cm-toolbar.is-batch .cm-btn')].find((b) => b.textContent === '归档')?.click()`);
  await sleep(1600);
  const emptyText = (await evaluate(ws, `document.querySelector('.cm-empty')?.textContent ?? ''`)) ?? "";
  check(
    emptyText.includes("Inbox 已清空") && emptyText.includes("新建速记"),
    "未归档清空后显示「Inbox 已清空」空状态",
    emptyText.slice(0, 80),
  );

  // 快捷操作提示（底部常驻）
  const hints = (await evaluate(ws, `document.querySelector('.cm-hints')?.textContent ?? ''`)) ?? "";
  check(
    hints.includes("新建") && hints.includes("归档") && hints.includes("返回"),
    "底部显示快捷键提示（新建/归档/返回）",
    hints,
  );

  // Esc 第一层：取消选择（有勾选时不关视图）。空状态没有行，先切到已归档段
  await evaluate(
    ws,
    `(() => { const tab = [...document.querySelectorAll('.cm-seg-btn')].find((b) => b.textContent.includes('已归档')); tab?.click(); return true; })()`,
  );
  await sleep(500);
  await evaluate(ws, `document.querySelectorAll('.cm-check')[0]?.click()`);
  await sleep(400);
  check(await evaluate(ws, `!!document.querySelector('.cm-toolbar.is-batch')`), "重新勾选进入批量模式");
  await evaluate(ws, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  check(
    !(await evaluate(ws, `!!document.querySelector('.cm-toolbar.is-batch')`)) &&
      !!(await evaluate(ws, `!!document.querySelector('.cm-root')`)),
    "Esc 取消选择（视图保留）",
  );

  // Esc：视图内无浮层时放行给全局（关整个视图）
  await evaluate(ws, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  check(!(await evaluate(ws, `!!document.querySelector('.cm-root')`)), "Esc 退出 Inbox 视图回笔记");
  check(
    !((await evaluate(ws, `document.querySelector('.app')?.className ?? ''`)) ?? "").includes("inbox-open"),
    "关闭后 inbox-open 类摘除（侧栏恢复）",
  );
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

console.log(failures === 0 ? "\nInbox（速记管理）验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

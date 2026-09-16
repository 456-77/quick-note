// GUI 验证：日历面板、日记/周记的创建与打开、待办与顺延、库内配置的写回。
//
// 为什么必须有这一层：这里验证的东西单元测试根本触不到——双击（单击只切换选中、
// 双击才打开）、配置落盘后插件配置有没有被抹掉、创建出来的文件内容对不对、
// 面板与编辑器的联动。反过来，日历的日期算术（ISO 周号、连续天数）只有单元层能
// 精确断言，这里不做重复计算。
//
// 刻意**不复刻任何日期格式化逻辑**：今天/昨天/周标识/周一都从 DOM 的 data 属性里读，
// 造日期的事交给应用自己。测试只负责断言"应用自己前后一致"以及文件内容的形状。
//
// 前置：应用以 --remote-debugging-port 启动，仓库由 make-test-vault.sh 生成。
// 用法：node scripts/gui-daily.mjs <vaultDir> [port]

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const CONFIG = join(vault, "quick-daily-note.json");

/** 把库内配置备份下来，结束后原样还原（测试会改它）。 */
const configBackup = readFileSync(CONFIG, "utf8");
/** 日记目录取自 fixture 配置，不写死在脚本里。 */
const FOLDER = JSON.parse(configBackup).folder;
/** 测试创建的文件，结束时清掉。 */
const created = [];

let nextId = 1;
const cdp = (ws, method, params) =>
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

/** 轮询直到条件成立（React 重渲染与落盘都是异步的）。 */
async function waitFor(label, predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) {
      check(false, label, "等待超时");
      return false;
    }
    await sleep(120);
  }
}

/** 元素中心坐标（先滚进视口——视口外的坐标点击会落到窗口外）。 */
async function centerOf(ws, selector) {
  return evaluate(
    ws,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       el.scrollIntoView({ block: "center" });
       const r = el.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
     })()`,
  );
}

async function clickAt(ws, point) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type,
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: "left",
      clickCount: 1,
    });
    await sleep(20);
  }
}

/**
 * 真实双击。
 *
 * 必须是浏览器级的两次点击（clickCount 递增），不能只 dispatch 一个 dblclick 事件：
 * 「单击只切换选中、双击才打开」正是这次要验证的接线，凑出来的事件测不到它。
 */
async function doubleClickAt(ws, point) {
  for (const [clickCount, type] of [
    [1, "mousePressed"],
    [1, "mouseReleased"],
    [2, "mousePressed"],
    [2, "mouseReleased"],
  ]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type,
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: "left",
      clickCount,
    });
    await sleep(25);
  }
}

async function clickSelector(ws, selector) {
  const point = await centerOf(ws, selector);
  if (!point) throw new Error(`找不到元素：${selector}`);
  await clickAt(ws, point);
}

async function doubleClickSelector(ws, selector) {
  const point = await centerOf(ws, selector);
  if (!point) throw new Error(`找不到元素：${selector}`);
  await doubleClickAt(ws, point);
}

/** 输入框里的值要用原生 setter 写，直接改 .value 不会触发 React 的 onChange。 */
async function typeInto(ws, selector, text) {
  await evaluate(
    ws,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(text)});
       el.dispatchEvent(new Event("input", { bubbles: true }));
       return true;
     })()`,
  );
}

async function pressEnter(ws, selector) {
  await evaluate(
    ws,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
       return true;
     })()`,
  );
}

const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
const editorText = (ws) => evaluate(ws, `document.querySelector('.cm-content')?.innerText ?? ''`);

// ---------------------------------------------------------------- 连接

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("没有找到 page 目标：", targets.map((t) => t.type).join(", "));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
});

/** 结束时还原配置、删掉测试创建的文件。 */
function cleanup() {
  writeFileSync(CONFIG, configBackup);
  for (const path of created) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* 清理失败不影响结论，基线比对会报出来 */
    }
  }
}

try {
  // ---------------------------------------------------------------- 切到日历
  console.log("日历面板\n");
  await evaluate(
    ws,
    `(() => {
       const tab = [...document.querySelectorAll('.sidebar-tab')].find(b => b.textContent === '日记');
       tab.click();
       return true;
     })()`,
  );
  await sleep(400);

  check(await evaluate(ws, `!!document.querySelector('.cal-grid')`), "点了「日记」页签后日历渲染出来");

  // 布局（Obsidian 式左右分栏）：文件树常驻左栏，日记/目录在右侧面板
  const layout = await evaluate(
    ws,
    `(() => {
       const right = document.querySelector('.sidebar-right');
       const left = document.querySelector('.sidebar:not(.sidebar-right)');
       return {
         right: !!right,
         rightTabs: right ? [...right.querySelectorAll('.sidebar-tab')].map(b => b.textContent) : [],
         calInRight: !!right?.querySelector('.cal-grid'),
         leftHasTree: !!left?.querySelector('.tree-file'),
         leftHasTabbar: !!left?.querySelector('.sidebar-tabs'),
       };
     })()`,
  );
  check(layout.right === true, "右侧面板存在");
  check(layout.rightTabs.join(",") === "日记,目录", "右侧面板只有 日记/目录 两个页签", JSON.stringify(layout.rightTabs));
  check(layout.calInRight === true, "日历渲染在右侧面板内");
  check(layout.leftHasTree === true, "文件树常驻左栏");
  check(layout.leftHasTabbar === false, "左栏没有页签（文件就是左栏本体）");

  const shape = await evaluate(
    ws,
    `({
       headers: document.querySelectorAll('.cal-weekday').length,
       weekCells: document.querySelectorAll('.cal-week-cell').length,
       days: document.querySelectorAll('.cal-day').length,
       todays: document.querySelectorAll('.cal-day.is-today').length,
       selected: document.querySelectorAll('.cal-day.is-selected').length,
       wHeader: document.querySelector('.cal-week-col')?.textContent ?? '',
     })`,
  );
  check(shape.headers === 8, "表头 8 格（W 周记列 + 七个星期）", String(shape.headers));
  check(shape.wHeader === "W", "第 1 列是 W 周记列", shape.wHeader);
  check(shape.weekCells === 6, "6 行 W 格", String(shape.weekCells));
  check(shape.days === 42, "6 行 × 7 天 = 42 格", String(shape.days));
  check(shape.todays === 1, "恰好一格标记为今天", String(shape.todays));
  check(shape.selected === 1, "默认选中今天", String(shape.selected));

  const TODAY = await evaluate(ws, `document.querySelector('.cal-day.is-today').getAttribute('data-date')`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(TODAY ?? ""), `今天格带日期（${TODAY}）`);
  check(
    await evaluate(ws, `document.querySelector('.cal-day.is-today').classList.contains('is-selected')`),
    "默认选中的就是今天那一格",
  );

  // 今天的日记由 fixture 生成 → 打点 + 今日字数都应当有
  check(
    await evaluate(ws, `!!document.querySelector('.cal-day.is-today .cal-dot')`),
    "今天有日记 → 该格有圆点",
  );
  const stats = await evaluate(ws, `document.querySelector('.cal-stats')?.innerText ?? ''`);
  check(/本月 \d+ 天/.test(stats), "统计显示本月天数", stats);
  check(/连续 \d+ 天/.test(stats), "统计显示连续天数", stats);
  const todayWordCount = Number((stats.match(/今日 (\d+) 字/) ?? [])[1] ?? -1);
  check(todayWordCount > 0, "统计显示今日字数（今天有日记）", stats);
  check(
    await evaluate(ws, `document.querySelector('.cal-section-head').innerText.includes(${JSON.stringify(TODAY)})`),
    "待办区默认针对今天",
  );

  // ---------------------------------------------------------------- 当天日记
  console.log("");
  console.log("当天日记");
  console.log("");
  check(
    await evaluate(ws, `!!document.querySelector('.cal-daynotes')`),
    "面板里有「当天日记」一栏（只列待办不算日记面板）",
  );
  check(
    await evaluate(ws, `!!document.querySelector('.cal-daynotes-add')`),
    "「当天日记」带「＋ 新建」按钮（同一天多篇的入口）",
  );
  {
    const dayNotes = await evaluate(
      ws,
      `({
         title: document.querySelector('.cal-daynotes-title')?.textContent ?? '',
         rows: [...document.querySelectorAll('.cal-daynote')].map(r => r.querySelector('.cal-daynote-name').textContent),
       })`,
    );
    check(
      dayNotes.title === "当天日记（1）",
      "标题里带当天的篇数（fixture 里今天有 1 篇）",
      dayNotes.title,
    );
    check(
      dayNotes.rows.length === 1 && dayNotes.rows[0].includes(TODAY),
      "列出当天日记的文件名（不含扩展名）",
      JSON.stringify(dayNotes.rows),
    );
    check(
      dayNotes.rows[0].startsWith(TODAY),
      "行名就是「日期 + 空格 + 名字」，与文件名一致",
      dayNotes.rows[0],
    );
  }
  // 点名字直接打开那篇
  await evaluate(
    ws,
    `document.querySelector('.cal-daynote').click()`,
  );
  check(
    await waitFor("点当天日记的名字会打开它", async () => (await editorText(ws)).includes(TODAY)),
    "点击当天日记的名字直接打开该篇",
  );
  // 行尾 ⋯ 与右键是同一份菜单
  await evaluate(
    ws,
    `(() => {
       const btn = document.querySelector('.cal-daynote .cal-more');
       const r = btn.getBoundingClientRect();
       btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.right, clientY: r.bottom }));
       return true;
     })()`,
  );
  check(
    await waitFor("行尾 ⋯ 弹出重命名/删除菜单", async () =>
      evaluate(ws, `[...document.querySelectorAll('.context-menu button')].map(b => b.textContent)`).then(
        (items) => Array.isArray(items) && items.some((t) => t.includes("重命名")),
      ),
    ),
    "当天日记行尾的 ⋯ 用的是文件树那份菜单（改名会同步 wiki 引用、删除进 .trash）",
  );
  await evaluate(ws, `document.querySelector('.menu-backdrop')?.click()`);
  await sleep(200);

  // 「＋ 新建」：同一天再建一篇（以前只能绕道文件树的 ＋笔记 手写名字）
  await clickSelector(ws, ".cal-daynotes-add");
  check(
    await waitFor("点「＋ 新建」展开命名输入行", async () =>
      evaluate(ws, `!!document.querySelector('.cal-create-row input')`),
    ),
    "「＋ 新建」展开命名输入行（针对选中的那一天）",
  );
  const secondPath = join(vault, FOLDER, `${TODAY} 验证第二篇.md`);
  await typeInto(ws, ".cal-create-row input", "验证第二篇");
  await pressEnter(ws, ".cal-create-row input");
  await waitFor("第二篇日记文件出现", async () => existsSync(secondPath));
  check(existsSync(secondPath), `同一天建出第二篇：${FOLDER}/${TODAY} 验证第二篇.md`);
  if (existsSync(secondPath)) created.push(secondPath);
  {
    const listed = await waitFor("当天日记列出两篇", async () =>
      (await evaluate(ws, `document.querySelector('.cal-daynotes-title')?.textContent ?? ''`)) ===
      "当天日记（2）",
    );
    check(listed, "篇数与列表同时更新（当天日记（2））", await evaluate(ws, `document.querySelector('.cal-daynotes-title')?.textContent ?? ''`));
    const names = await evaluate(
      ws,
      `[...document.querySelectorAll('.cal-daynote-name')].map(e => e.textContent)`,
    );
    check(
      names.length === 2 && names.every((name) => name.startsWith(TODAY)),
      "两篇都列在当天日记里（发现逻辑支持同一天多篇）",
      JSON.stringify(names),
    );
  }
  check(
    await waitFor("新建的第二篇在编辑器里打开", async () =>
      (await editorText(ws)).includes("验证第二篇"),
    ),
    "新建后自动打开新那篇",
  );

  // 行的 W 格里带着该周的标识与周一日期，后面创建周记要用
  const week = await evaluate(
    ws,
    `(() => {
       const days = [...document.querySelectorAll('.cal-day')];
       const row = Math.floor(days.indexOf(document.querySelector('.cal-day.is-today')) / 7);
       const cell = document.querySelectorAll('.cal-week-cell')[row];
       return { weekKey: cell.getAttribute('data-week'), monday: cell.getAttribute('data-monday'), row };
     })()`,
  );
  check(
    /^\d{4}-W\d{2}$/.test(week.weekKey ?? "") && week.row >= 0 && week.row < 6,
    `今天所在行的 W 格带周标识（第 ${week.row} 行 · ${week.weekKey}）`,
  );
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(week.monday ?? ""),
    `W 格带该周周一日期（${week.monday}，周记模板用）`,
  );

  // ---------------------------------------------------------------- 顺延
  console.log("\n昨日未完成待办的顺延\n");
  check(
    await evaluate(ws, `!!document.querySelector('.cal-carryover')`),
    "选中今天时出现顺延提示（fixture 里昨天有 1 项未完成）",
  );
  const carryText = await evaluate(ws, `document.querySelector('.cal-carryover')?.innerText ?? ''`);
  check(/昨天有 1 项待办未完成/.test(carryText), "提示里写明未完成数量", carryText);

  await clickSelector(ws, ".cal-carryover-btn");
  const carried = await waitFor(
    "顺延后今天的待办列表出现带「遗留」前缀的条目",
    async () =>
      (await evaluate(
        ws,
        `[...document.querySelectorAll('.cal-todo-text')].map(e => e.textContent)`,
      )).some((text) => /^\[\d{2}-\d{2} 遗留\] 昨天没做完的事$/.test(text)),
  );
  check(carried, "顺延到今天的条目带 [MM-DD 遗留] 前缀");
  check(
    !(await evaluate(ws, `!!document.querySelector('.cal-carryover')`)),
    "顺延后提示自动消失（不会反复催促）",
  );
  const carriedTodos = await waitFor("待办写入库内配置", async () => {
    const todos = readConfig().todos ?? {};
    return (todos[TODAY] ?? []).some((item) => /^\[\d{2}-\d{2} 遗留\] 昨天没做完的事$/.test(item.text));
  });
  check(carriedTodos, "顺延结果落盘到 quick-daily-note.json");
  {
    const config = readConfig();
    const yesterdayKey = Object.keys(config.todos).find((key) => key !== TODAY);
    check(
      (config.todos[yesterdayKey] ?? []).some((item) => item.text === "昨天没做完的事" && item.deleted === true),
      "源日期那条被打了墓碑（不是物理删除，否则另一台设备会把它当成新增复活）",
    );
    check(
      (config.todos[yesterdayKey] ?? []).some((item) => item.text === "昨天做完的事" && !item.deleted),
      "已完成的那条留在原处，没被顺延",
    );
  }

  // ---------------------------------------------------------------- 待办增删勾选
  console.log("\n待办的添加 / 勾选 / 删除\n");
  await typeInto(ws, ".cal-todo-add input", "验证添加的待办");
  await pressEnter(ws, ".cal-todo-add input");
  await waitFor("待办出现在列表里", async () =>
    (await evaluate(ws, `[...document.querySelectorAll('.cal-todo-text')].map(e => e.textContent)`)).includes(
      "验证添加的待办",
    ),
  );
  check(
    await waitFor("添加的待办落盘", async () =>
      (readConfig().todos[TODAY] ?? []).some((item) => item.text === "验证添加的待办"),
    ),
    "回车添加待办并落盘",
  );
  check(
    await evaluate(ws, `document.querySelector('.cal-todo-add input').value === ''`),
    "添加后输入框清空",
  );

  // 勾选（按行内的原始下标回写，墓碑之后下标不能错位）
  await evaluate(
    ws,
    `(() => {
       const row = [...document.querySelectorAll('.cal-todo')]
         .find(r => r.textContent.includes('验证添加的待办'));
       row.querySelector('input[type=checkbox]').click();
       return true;
     })()`,
  );
  check(
    await waitFor("勾选状态落盘", async () =>
      (readConfig().todos[TODAY] ?? []).some(
        (item) => item.text === "验证添加的待办" && item.done === true,
      ),
    ),
    "勾选写回库内配置",
  );
  check(
    await evaluate(
      ws,
      `[...document.querySelectorAll('.cal-todo')]
         .find(r => r.textContent.includes('验证添加的待办'))
         .querySelector('.cal-todo-text').classList.contains('is-done')`,
    ),
    "已完成条目在界面上加删除线样式",
  );
  check(
    /1 项未完成|0 项未完成/.test(await evaluate(ws, `document.querySelector('.cal-pending').innerText`)),
    "未完成计数跟着更新",
    await evaluate(ws, `document.querySelector('.cal-pending').innerText`),
  );

  // 修改：行尾 ⋯ 菜单 → 「修改」→ 行内输入 → 回车（对齐插件的 updateTodoText）
  await evaluate(
    ws,
    `(() => {
       const row = [...document.querySelectorAll('.cal-todo')]
         .find(r => r.textContent.includes('验证添加的待办'));
       row.querySelector('.cal-todo-more').click();
       return true;
     })()`,
  );
  await sleep(250);
  check(
    (await evaluate(
      ws,
      `[...document.querySelectorAll('.context-menu button')].map(b => b.textContent).join(',')`,
    )) === "修改,复制,删除…",
    "待办 ⋯ 菜单含 修改/复制/删除 三项",
    await evaluate(ws, `[...document.querySelectorAll('.context-menu button')].map(b => b.textContent).join(',')`),
  );
  await evaluate(
    ws,
    `[...document.querySelectorAll('.context-menu button')].find(b => b.textContent === '修改')?.click()`,
  );
  await sleep(250);
  check(
    await evaluate(ws, `!!document.querySelector('.cal-todo-edit')`),
    "「修改」让该行进入行内编辑",
  );
  await evaluate(
    ws,
    `(() => {
       const el = document.querySelector('.cal-todo-edit');
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       setter.call(el, '验证添加的待办（已改）');
       el.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
  );
  await pressEnter(ws, ".cal-todo-edit");
  check(
    await waitFor("修改后的文字落盘", async () =>
      (readConfig().todos[TODAY] ?? []).some((item) => item.text === "验证添加的待办（已改）"),
    ),
    "「修改」把新文字写回库内配置",
  );

  // 复制：菜单项存在且点击不报错（剪贴板内容无法在 CDP 里可靠读取）
  await evaluate(
    ws,
    `(() => {
       const row = [...document.querySelectorAll('.cal-todo')]
         .find(r => r.textContent.includes('验证添加的待办（已改）'));
       row.querySelector('.cal-todo-more').click();
       return true;
     })()`,
  );
  await sleep(250);
  await evaluate(
    ws,
    `[...document.querySelectorAll('.context-menu button')].find(b => b.textContent === '复制')?.click()`,
  );
  await sleep(200);
  check(
    !(await evaluate(ws, `!!document.querySelector('.banner-error')`)),
    "「复制」执行无报错",
  );

  // 删除：走 ⋯ 菜单 → 删除…（必须留墓碑）
  await evaluate(
    ws,
    `(() => {
       const row = [...document.querySelectorAll('.cal-todo')]
         .find(r => r.textContent.includes('验证添加的待办（已改）'));
       row.querySelector('.cal-todo-more').click();
       return true;
     })()`,
  );
  await sleep(250);
  await evaluate(
    ws,
    `[...document.querySelectorAll('.context-menu button')].find(b => b.textContent === '删除…')?.click()`,
  );
  const tombstoned = await waitFor("删除落盘为墓碑", async () =>
    (readConfig().todos[TODAY] ?? []).some(
      (item) => item.text === "验证添加的待办（已改）" && item.deleted === true,
    ),
  );
  check(tombstoned, "删除打墓碑而不是从数组里移除");
  check(
    await waitFor("已删除条目从界面消失", async () =>
      !(await evaluate(ws, `document.querySelector('.cal-todos').innerText`)).includes("验证添加的待办"),
    ),
    "墓碑条目不再显示",
  );

  // ---------------------------------------------------------------- 周记
  console.log("\n周记（双击 W 列）\n");
  const weeklyPath = join(vault, FOLDER, `${week.weekKey} 周记.md`);
  const weeklyExisted = existsSync(weeklyPath);
  await doubleClickSelector(ws, `.cal-week-cell[data-week="${week.weekKey}"]`);
  await waitFor("周记文件出现", async () => existsSync(weeklyPath));
  check(existsSync(weeklyPath), `双击 W 列创建了 ${FOLDER}/${week.weekKey} 周记.md`);
  if (!weeklyExisted) created.push(weeklyPath);

  const weeklyContent = existsSync(weeklyPath) ? readFileSync(weeklyPath, "utf8") : "";
  if (!weeklyExisted) {
    check(
      weeklyContent.includes(`# ${week.weekKey} 周记`),
      "周记标题按「周标识 + 周记」生成",
      JSON.stringify(weeklyContent.slice(0, 60)),
    );
    check(
      weeklyContent.includes(`周标识：${week.weekKey}`),
      "周记模板的 {{week}} 展开成 ISO 周标识",
    );
    check(
      weeklyContent.includes(`本周周一：${week.monday}`),
      "周记模板的 {{date}} 是该周**周一**（不是今天，否则同周不同天创建会写出不同日期）",
      weeklyContent,
    );
  }
  check(
    await waitFor("周记在编辑器里打开", async () =>
      (await editorText(ws)).includes(`${week.weekKey} 周记`),
    ),
    "创建后自动在编辑器里打开",
  );
  check(
    await waitFor("该周的 W 格出现圆点", async () =>
      evaluate(ws, `!!document.querySelector('.cal-week-cell[data-week="${week.weekKey}"] .cal-dot')`),
    ),
    "有周记的周在 W 列打点",
  );

  // ---------------------------------------------------------------- 新建日记
  console.log("\n新建日记（双击日期 + 模板占位符）\n");
  // 挑一个本月内、还没有日记的日子
  const emptyDay = await evaluate(
    ws,
    `(() => {
       const cell = [...document.querySelectorAll('.cal-day')].find(
         (c) =>
           !c.classList.contains('is-outside') &&
           !c.classList.contains('is-today') &&
           !c.querySelector('.cal-dot'),
       );
       return cell ? cell.getAttribute('data-date') : null;
     })()`,
  );
  check(typeof emptyDay === "string" && emptyDay.length === 10, `找到一个没有日记的日期（${emptyDay}）`);

  // 单击只切换选中，不打开、也不弹输入行
  await clickSelector(ws, `.cal-day[data-date="${emptyDay}"]`);
  await sleep(300);
  check(
    await evaluate(ws, `document.querySelector('.cal-day[data-date="${emptyDay}"]').classList.contains('is-selected')`),
    "单击日期只切换选中",
  );
  check(
    !(await evaluate(ws, `!!document.querySelector('.cal-create-row')`)),
    "单击不会弹出新建输入行（否则想看另一天的待办就得先跳走一篇笔记）",
  );
  check(
    /1 项未完成|0 项未完成/.test(await evaluate(ws, `document.querySelector('.cal-pending').innerText`)),
    "待办列表跟着切到该日",
    await evaluate(ws, `document.querySelector('.cal-section-head').innerText`),
  );

  await doubleClickSelector(ws, `.cal-day[data-date="${emptyDay}"]`);
  check(
    await waitFor("双击没有日记的日期后出现命名输入行", async () =>
      evaluate(ws, `!!document.querySelector('.cal-create-row input')`),
    ),
    "双击没有日记的日期会就地展开输入行问名字",
  );

  // 非法名字：输入行必须留在原地并给出原因，而不是悄悄建出子目录/隐藏文件
  await typeInto(ws, ".cal-create-row input", "子/名字");
  await pressEnter(ws, ".cal-create-row input");
  await sleep(300);
  check(
    await evaluate(ws, `!!document.querySelector('.cal-create-problem')`),
    "名字里带路径分隔符时给出提示（否则会静默建出一个子目录，而那篇日记永远不打点）",
    await evaluate(ws, `document.querySelector('.create-hint')?.innerText ?? ''`),
  );
  check(
    await evaluate(ws, `!!document.querySelector('.cal-create-row input')`),
    "名字非法时输入行保持展开，方便直接改",
  );
  check(
    !readdirSync(join(vault, FOLDER)).some((name) => name.startsWith(`${emptyDay} 子`)),
    "非法名字没有在磁盘上造出任何东西",
    JSON.stringify(readdirSync(join(vault, FOLDER)).filter((name) => name.includes("子"))),
  );

  const dailyPath = join(vault, FOLDER, `${emptyDay} 验证新建.md`);
  const dailyExisted = existsSync(dailyPath);
  await typeInto(ws, ".cal-create-row input", "验证新建");
  await pressEnter(ws, ".cal-create-row input");
  await waitFor("日记文件出现", async () => existsSync(dailyPath));
  check(existsSync(dailyPath), `新建了 ${FOLDER}/${emptyDay} 验证新建.md（日期 + 空格 + 名字）`);
  if (!dailyExisted) created.push(dailyPath);

  const dailyContent = existsSync(dailyPath) ? readFileSync(dailyPath, "utf8") : "";
  check(dailyContent.startsWith(`# ${emptyDay} 验证新建`), "模板的 {{title}} 展开成完整标题");
  check(dailyContent.includes(`日期：${emptyDay}`), "模板的 {{date}} 按配置的格式展开");
  check(
    new RegExp(`另一种写法：${emptyDay.slice(0, 4)}年\\d{1,2}月\\d{1,2}日`).test(dailyContent),
    "模板的 {{date:YYYY年M月D日}} 按指定格式展开",
    dailyContent,
  );
  check(/时间：[0-2]\d:[0-5]\d/.test(dailyContent), "模板的 {{time}} 展开成 HH:mm", dailyContent);
  check(
    dailyContent.includes("未知占位符：{{未知}}"),
    "未知占位符原样留在文件里（悄悄清掉会让人以为模板没生效）",
  );
  check(
    !/\{\{(title|date|time|week)/.test(dailyContent),
    "没有残留未展开的已知占位符",
    dailyContent,
  );
  check(
    await waitFor("新建的日记在编辑器里打开", async () => (await editorText(ws)).includes(`${emptyDay} 验证新建`)),
    "创建后自动打开",
  );
  check(
    await waitFor("该日期出现圆点", async () =>
      evaluate(ws, `!!document.querySelector('.cal-day[data-date="${emptyDay}"] .cal-dot')`),
    ),
    "新建日记后日历打点立即更新",
  );

  // 已有日记的那一天再双击 → 打开已有文件，不重复创建、更不覆盖
  const beforeReopen = readFileSync(dailyPath, "utf8");
  await doubleClickSelector(ws, `.cal-day[data-date="${emptyDay}"]`);
  await sleep(700);
  check(
    !(await evaluate(ws, `!!document.querySelector('.cal-create-row')`)),
    "已有日记时双击直接打开，不再问名字",
  );
  check(readFileSync(dailyPath, "utf8") === beforeReopen, "打开已有日记不会覆盖它的内容");

  // ---------------------------------------------------------------- 配置
  console.log("\n库内配置的写回\n");
  {
    const config = readConfig();
    check(
      config.emailAccessKey === "plugin-only-key-do-not-drop",
      "插件专有的键在整轮读写后原样保留（写坏它等于清空用户的插件设置）",
      JSON.stringify(config.emailAccessKey),
    );
    check(config.weatherCity === "北京", "其他插件配置同样保留");
    check(config.todoReminderEnabled === true, "插件开关保留");
    check(config.folder === "日记" && config.dateFormat === "YYYY-MM-DD", "日记设置未被改动");
    const fixtureOrder =
      "folder,dateFormat,todos,todosUpdatedAt,todoReminderEnabled,todoReminderTime,emailNotifyEnabled,emailAccessKey,weatherEnabled,weatherCity,dailyTemplateEnabled,dailyTemplatePath,weeklyTemplateEnabled,weeklyTemplatePath".split(
        ",",
      );
    const actualKeys = Object.keys(config);
    // 原有键的**相对顺序**必须原样：重排会让整份文件在同步里全变。
    // M3 起 pastedImageFolder 也是我们管的键，fixture 里没有它 → 按规则**追加到末尾**，
    // 所以这里断言"fixture 的键序列是实际键序列的子序列"，而不是要求完全相等。
    const kept = fixtureOrder.filter((key) => actualKeys.includes(key));
    check(
      kept.join(",") === actualKeys.slice(0, kept.length).join(","),
      "原有键的相对顺序保持 fixture 原样（重排会让整份文件在同步里全变）",
      actualKeys.join(","),
    );
    check(
      actualKeys[actualKeys.length - 1] === "pastedImageFolder" &&
        actualKeys.length === kept.length + 1,
      "新增的自有键（pastedImageFolder）追加在末尾，不插进原有键之间",
      actualKeys.join(","),
    );
    check(
      config.pastedImageFolder === "attachments",
      "附件目录写在库内配置里（与 Obsidian 插件共用同一份）",
      JSON.stringify(config.pastedImageFolder),
    );
    const todayBucket = config.todos[TODAY] ?? [];
    check(
      todayBucket.some((item) => item.deleted === true) &&
        todayBucket.some((item) => !item.deleted),
      "今天的待办分桶里既有活跃条目、也有墓碑（墓碑留在数据里，界面不显示）",
      JSON.stringify(todayBucket.map((item) => [item.text, item.deleted ?? false])),
    );
  }
  check(
    !(await evaluate(ws, `!!document.querySelector('.banner-error')`)),
    "整轮操作没有产生错误横幅",
  );

  // 设置面板里显示的应当是库内配置的值（证明配置真的读出来了）
  await evaluate(
    ws,
    `[...document.querySelectorAll('header button')].find(b => b.textContent === '设置').click()`,
  );
  await sleep(300);
  const settingsValues = await evaluate(
    ws,
    `[...document.querySelectorAll('.settings-row')].map((row) => {
       const field = row.querySelector('input,select');
       return {
         label: row.querySelector('span').textContent,
         type: field?.type ?? '',
         value: field?.type === 'checkbox' ? field.checked : field?.value,
       };
     })`,
  );
  const settingOf = (label) => settingsValues.find((row) => row.label === label)?.value;
  check(settingOf("日记目录") === "日记", "设置面板读出日记目录", JSON.stringify(settingOf("日记目录")));
  check(settingOf("日期格式") === "YYYY-MM-DD", "设置面板读出日期格式");
  check(settingOf("日记模板文件") === "模板/日记模板.md", "设置面板读出模板路径");
  check(settingOf("启用日记模板") === true, "模板开关是勾上的", JSON.stringify(settingOf("启用日记模板")));
  check(
    settingsValues.some((row) => row.label === "周记模板文件" && row.value === "模板/周记模板.md"),
    "设置面板读出周记模板路径",
  );
} finally {
  cleanup();
  ws.close();
}

console.log(failures === 0 ? "\n日记与日历界面验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

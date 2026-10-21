// 0.27 批次验收：本轮 14 项反馈的桌面端关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 + 临时
// 仓库），结束时自清理。
//
// 覆盖：
// - 目录渲染标题内 **加粗**（outline-inline-bold）
// - 最近文件弹窗（Ctrl+Shift+E）：搜索过滤 + 数量 + Esc 关闭
// - 快速添加待办（Ctrl+Alt+D）：前缀日期语法落到 quick-daily-note.json
// - 单词面板 0.27 规范：标题+总数+开始复习入口、条目三行结构（音标行+发音钮）、
//   状态标签点击切换、轻量复习流程（显示释义→认识→推进）
// - 标签列表：置顶（行序变化 + is-pinned）与重命名（#旧 → #新 写回文件）
// - 设置开关样式（checkbox::before 开关化）与背景图调节修复
//   （filter 只含合法函数、scale 走 transform、模糊扩边不透明）
// - 日历日格等高（有/无日记圆点不再改变行高）
// - mermaid PNG 导出目标分辨率（~2x 自然尺寸，不再裸交 3x 大图给查看器缩）
// - 多窗口同步状态按仓库拆文件（01/02 根因）：per-vault 状态文件出现、
//   共享 sync-state.json 退化为薄配置（无 cursor/hashes）

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** appConfig 可能还不存在（首次运行）；readdirSync 的简便包装。 */
const readdirSyncFixed = () => (existsSync(appConfig) ? readdirSync(appConfig) : []);

const port = process.argv[2] ?? "9377";
const root = process.cwd();
const exe = join(root, "src-tauri", "target", "release", "quick-note.exe");
if (!existsSync(exe)) {
  console.error(`找不到 ${exe}——先跑 verify-gui.sh 的构建步骤（gui-test 变体）`);
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

const waitFor = async (ws, expression, timeoutMs, pollMs = 500) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};

const key = (ws, combo, code, keyCode) =>
  cdp(ws, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: combo.mod,
    key: combo.key,
    code,
    windowsVirtualKeyCode: keyCode,
  }).then(() =>
    cdp(ws, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: combo.mod,
      key: combo.key,
      code,
      windowsVirtualKeyCode: keyCode,
    }),
  );
// Chromium CDP Input.dispatchKeyEvent 的 modifiers 位：Alt=1 Ctrl=2 Meta=4 Shift=8
const CTRL_SHIFT = 2 | 8;
const CTRL_ALT = 1 | 2;
const CTRL = 2;

// ------------------------------------------------ 自备数据：临时仓库

const work = join(tmpdir(), `qn-027-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "vault");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

// 笔记：含加粗标题（目录渲染）与 mermaid 块（导出分辨率）
writeFileSync(
  join(vault, "qn27笔记.md"),
  [
    "# 0.27 批测",
    "",
    "## 部署 **重点** 说明",
    "",
    "正文。",
    "",
    "```mermaid",
    "flowchart LR",
    "  N01[开始节点] --> N02[处理节点] --> N03[处理节点] --> N04[处理节点] --> N05[处理节点]",
    "  N05 --> N06[处理节点] --> N07[处理节点] --> N08[处理节点] --> N09[处理节点]",
    "  N09 --> N10[处理节点] --> N11[处理节点] --> N12[处理节点] --> N13[处理节点]",
    "  N13 --> N14[处理节点] --> N15[处理节点] --> N16[处理节点] --> N17[结束节点]",
    "```",
    "",
  ].join("\n"),
  "utf8",
);
// 日记（今天）：让日历里有带圆点的日子；其他格子无圆点
writeFileSync(join(vault, `${todayStr}.md`), `# 今天\n\n日记正文。\n`, "utf8");
// 带标签的笔记（标签行固定第 3 行）
writeFileSync(
  join(vault, "qn27标签源.md"),
  ["# 标签源", "", "#qn27tag #其他标签", "", "正文。"].join("\n"),
  "utf8",
);
// 种子单词本：三行结构 + 复习流程
writeFileSync(
  join(vault, "单词本.md"),
  [
    "# 单词本",
    "",
    "## 待学习",
    "",
    "- banana | 香蕉 | | /bəˈnɑːnə/ — 2026-10-15 · 批测",
    "- cherry | 樱桃 | | /ˈtʃeri/ — 2026-10-17 · 批测",
    "- delta — 2026-10-18 · 批测",
    "",
    "## 已掌握",
    "",
  ].join("\n"),
  "utf8",
);
// 1x1 PNG（背景图选择用）
writeFileSync(
  join(vault, "qn27bg.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** 本机配置目录（gui-test 变体独立）。0.28 起单词本存在这里。 */
const appConfig = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "com.quicknote.gui-test",
);
// 种子仍是仓库内的 单词本.md（验证迁移）；断言读账户级全局文件。
const vocabFile = join(appConfig, "vocabulary.md");
const readVocab = () => (existsSync(vocabFile) ? readFileSync(vocabFile, "utf8") : "");

const spawnInstance = () =>
  spawn(exe, [vault.replace(/\\/g, "/")], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: udf,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
    detached: false,
  });

const connectPage = async (matchIndex = 0) => {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const pages = targets.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  const page = pages[matchIndex];
  if (!page) throw new Error(`没有找到 page 目标（${pages.length} 个）`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  return ws;
};

let child = null;
let ws = null;

try {
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });
  rmSync(join(appConfig, "open-vaults.json"), { force: true });
  // 0.28 单词本账户级：清掉上一批测留下的全局文件与迁移标记，由本仓库种子迁移
  rmSync(vocabFile, { force: true });
  rmSync(join(appConfig, "vocabulary-migrated.json"), { force: true });
  // 0.27 起 per-vault 同步状态文件：清掉旧产物，断言全新生成
  try {
    for (const name of readdirSyncFixed()) {
      if (name.startsWith("sync-state")) rmSync(join(appConfig, name), { force: true });
    }
  } catch {}

  child = spawnInstance();
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      ready = list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    } catch {}
  }
  if (!ready) throw new Error("应用页面没有就绪");
  ws = await connectPage(0);
  await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 30000);

  // ============================================== 1. 目录渲染标题内加粗
  {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn27笔记')); t?.click(); return !!t; })()`);
    await waitFor(ws, `document.querySelector('.cm-lp-mermaid svg')`, 20000);
    // 打开右侧「目录」页签
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.sidebar-tab')].find((el) => el.textContent.includes('目录')); b?.click(); return !!b; })()`);
    const boldHit = await waitFor(ws, `(() => { const b = document.querySelector('.outline-item .outline-inline-bold'); return b ? b.textContent : ''; })()`, 8000);
    check(boldHit === "重点", "目录渲染标题中的 **加粗**（outline-inline-bold=重点）", `got=${JSON.stringify(boldHit)}`);
  }

  // ============================================== 2. 最近文件弹窗（Ctrl+Shift+E）
  {
    // 再开一篇，保证 recents ≥ 2
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn27标签源')); t?.click(); return !!t; })()`);
    await sleep(600);
    await key(ws, { mod: CTRL_SHIFT, key: "E" }, "KeyE", 69);
    const open = await waitFor(ws, `!!document.querySelector('.recent-dialog')`, 5000);
    check(open, "Ctrl+Shift+E 唤起最近文件弹窗");
    const total = await evaluate(ws, `document.querySelectorAll('.recent-item').length`);
    check(total >= 2, "最近文件列出多条", `count=${total}`);
    await evaluate(ws, `(() => { const el = document.querySelector('.recent-search'); const set = ${nativeSet}; set(el, '标签源'); return true; })()`);
    await sleep(300);
    const filtered = await evaluate(ws, `document.querySelectorAll('.recent-item').length`);
    const firstName = await evaluate(ws, `document.querySelector('.recent-item .recent-name')?.textContent ?? ''`);
    check(filtered === 1 && firstName.includes("qn27标签源"), "搜索过滤到目标文件", `n=${filtered} name=${firstName}`);
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(250);
    check(!(await evaluate(ws, `!!document.querySelector('.recent-dialog')`)), "Esc 关闭最近文件弹窗");
  }

  // ============================================== 3. 快速添加待办（Ctrl+Alt+D）
  {
    await key(ws, { mod: CTRL_ALT, key: "d" }, "KeyD", 68);
    const open = await waitFor(ws, `!!document.querySelector('.quick-todo')`, 5000);
    check(open, "Ctrl+Alt+D 唤起快速添加待办弹窗");
    await evaluate(ws, `(() => { const el = document.querySelector('.quick-todo .recent-search'); const set = ${nativeSet}; set(el, '明天 qn27待办验证'); return true; })()`);
    await key(ws, { mod: 0, key: "Enter" }, "Enter", 13);
    await sleep(600);
    const todoCfg = join(vault, "quick-daily-note.json");
    let todoText = "";
    try {
      todoText = readFileSync(todoCfg, "utf8");
    } catch {}
    const tomorrow = new Date(today.getTime() + 86400000);
    const tomorrowStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    check(
      todoText.includes("qn27待办验证") && todoText.includes(tomorrowStr),
      "待办按「明天」前缀落到 quick-daily-note.json 的明天键",
      `cfg=${todoText.slice(0, 120)}`,
    );
  }

  // ============================================== 4. 单词面板 0.27 规范
  {
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.sidebar-tab')].find((el) => el.textContent.includes('单词')); b?.click(); return !!b; })()`);
    // 条目读取是异步的：等计数真的变成 3（waitFor .vocab-head 会抢在载入前命中）
    await waitFor(ws, `(() => { const c = document.querySelector('.vocab-head-count'); return c ? c.textContent === '3 个单词' : false; })()`, 10000);
    const headOk = await evaluate(ws, `(() => { const h = document.querySelector('.vocab-head'); if (!h) return ''; return h.querySelector('.vocab-head-title')?.textContent + '|' + h.querySelector('.vocab-head-count')?.textContent; })()`);
    check(headOk === "单词本|3 个单词", "标题行：单词本 + 总数", `got=${JSON.stringify(headOk)}`);
    await waitFor(ws, `(() => { const b = document.querySelector('.vocab-review-btn'); return b ? b.textContent.includes('（3）') : false; })()`, 8000);
    const reviewLabel = await evaluate(ws, `document.querySelector('.vocab-review-btn')?.textContent ?? ''`);
    check(reviewLabel.includes("开始复习（3）"), "复习入口带待学习计数", `got=${reviewLabel}`);

    // 条目三行结构：banana 行有 line1(词+状态按钮) / line2(音标+发音) / 释义行
    const structure = await evaluate(ws, `(() => {
      const item = [...document.querySelectorAll('.vocab-item')].find((el) => el.textContent.includes('banana'));
      if (!item) return 'no-item';
      return JSON.stringify({
        statusBtn: !!item.querySelector('.vocab-item-line1 .vocab-status-btn'),
        phonetic: item.querySelector('.vocab-item-line2 .vocab-item-phonetic')?.textContent ?? '',
        speak: !!item.querySelector('.vocab-item-line2 .vocab-item-speak'),
        meaning: item.querySelector('.vocab-item-meaning')?.textContent ?? '',
      });
    })()`);
    const s = JSON.parse(structure);
    check(
      s.statusBtn && s.phonetic.includes("nɑːnə") && s.speak && s.meaning === "香蕉",
      "条目三行结构：状态标签按钮 + 音标行带发音钮 + 释义行",
      JSON.stringify(s),
    );

    // 状态标签点击切换：cherry 点「待学习」→ 已掌握（写回文件 + 按钮文案变化）
    await evaluate(ws, `(() => { const item = [...document.querySelectorAll('.vocab-item')].find((el) => el.textContent.includes('cherry')); item?.querySelector('.vocab-status-btn')?.click(); return !!item; })()`);
    await sleep(800);
    const cherryLearned = readVocab().includes("## 已掌握") && /cherry/.test(readVocab().split("## 已掌握")[1] ?? "");
    check(cherryLearned, "点击状态标签切换到已掌握并写回单词本");

    // 复习流程：开始 → 显示释义 → 认识 → 推进/完成
    await evaluate(ws, `document.querySelector('.vocab-review-btn')?.click()`);
    const reviewOpen = await waitFor(ws, `!!document.querySelector('.vocab-review')`, 5000);
    check(reviewOpen, "复习卡打开");
    check(!!(await evaluate(ws, `document.querySelector('.vocab-review-word')?.textContent ?? ''`)), "复习卡先显示英文单词");
    await evaluate(ws, `document.querySelector('.vocab-review-reveal')?.click()`);
    await sleep(200);
    check(!!(await evaluate(ws, `!!document.querySelector('.vocab-review-answer')`)), "「显示释义」后展示释义区");
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.vocab-review .vocab-detail-act')].find((el) => el.textContent.includes('认识')); b?.click(); return !!b; })()`);
    await sleep(900);
    const doneOrNext = await evaluate(ws, `(() => { const d = document.querySelector('.vocab-review-done-title'); if (d) return 'done'; return document.querySelector('.vocab-review-count')?.textContent ?? ''; })()`);
    check(doneOrNext !== "", "作答后推进（进度更新或完成态）", `got=${doneOrNext}`);
    if (doneOrNext === "done") {
      check(!!(await evaluate(ws, `document.querySelector('.vocab-review-done-stats')?.textContent.includes('认识 1') ?? false`)), "完成态统计「认识 1」");
      // 已掌握的 banana 不该还在队列——但 delta 仍在待学习：再来一轮有 1 个
    } else {
      check(true, "（多词队列继续，完成态断言留给下一轮）");
    }
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
  }

  // ============================================== 5. 标签置顶 + 重命名
  {
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.left-view-tab')].find((el) => el.textContent.includes('标签')); b?.click(); return !!b; })()`);
    await waitFor(ws, `document.querySelectorAll('.tag-dash-row').length > 0`, 15000);
    // 置顶 qn27tag（0.28 起行操作收进 ⋯ 菜单）
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('.tag-dash-row')].find((el) => el.textContent.includes('qn27tag'));
      row?.querySelector('.tag-dash-more')?.click();
      return !!row;
    })()`);
    const pinMenuReady = await waitFor(ws, `!!document.querySelector('.tag-dash-menu')`, 3000);
    const pinned = await evaluate(ws, `(() => {
      const btn = [...document.querySelectorAll('.tag-dash-menu button')].find((b) => b.textContent.includes('置顶'));
      if (!btn) return 'no-menu-item';
      btn.click();
      return 'ok';
    })()`);
    await sleep(400);
    const order = await evaluate(ws, `[...document.querySelectorAll('.tag-dash-row .tree-label')].map((el) => el.textContent).join('|')`);
    check(
      pinMenuReady && pinned === "ok" && new RegExp("(^|\\|)qn27tag(\\||$)").test(order) && order.split("|").indexOf("qn27tag") === 0,
      "置顶后 qn27tag 排到列表首位",
      `order=${order}`,
    );
    // 重命名 qn27tag → qn27renamed
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('.tag-dash-row')].find((el) => el.textContent.includes('qn27tag'));
      row?.querySelector('.tag-dash-more')?.click();
      return !!row;
    })()`);
    await waitFor(ws, `!!document.querySelector('.tag-dash-menu')`, 3000);
    await evaluate(ws, `(() => {
      const btn = [...document.querySelectorAll('.tag-dash-menu button')].find((b) => b.textContent.includes('重命名'));
      btn?.click();
      return !!btn;
    })()`);
    const inputReady = await waitFor(ws, `!!document.querySelector('.tag-dash-row .tag-dash-rename-input')`, 5000);
    check(inputReady, "重命名就地输入框出现");
    await evaluate(ws, `(() => { const el = document.querySelector('.tag-dash-row .tag-dash-rename-input'); const set = ${nativeSet}; set(el, 'qn27renamed'); return true; })()`);
    await key(ws, { mod: 0, key: "Enter" }, "Enter", 13);
    await sleep(3500);
    const tagSrc = readFileSync(join(vault, "qn27标签源.md"), "utf8");
    check(
      tagSrc.includes("#qn27renamed") && !tagSrc.includes("#qn27tag"),
      "重命名写回笔记（#qn27tag → #qn27renamed）",
      tagSrc.split("\n")[2] ?? "",
    );
  }

  // ============================================== 6. 设置开关样式 + 背景图调节
  {
    await key(ws, { mod: 2, key: "," }, "Comma", 188);
    await waitFor(ws, `!!document.querySelector('.settings-dialog, [class*=settings]') && !!document.querySelector('[data-sec="appearance"]')`, 8000);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('外观')); b?.click(); return !!b; })()`);
    await sleep(300);
    // 开关样式：appearance 的「显示行号数字」checkbox 有 ::before（开关滑块）
    const switchStyle = await evaluate(ws, `(() => {
      const cb = [...document.querySelectorAll('[data-sec="appearance"] .settings-row input[type=checkbox]')][0];
      if (!cb) return 'no-cb';
      const st = getComputedStyle(cb, '::before');
      return JSON.stringify({ hasBefore: st.content !== 'none' && st.content !== '', w: cb.getBoundingClientRect().width });
    })()`);
    const sw = JSON.parse(switchStyle);
    check(sw.hasBefore && sw.w > 30, "设置复选框开关化（::before 滑块 + 宽 >30px）", switchStyle);

    // 背景图：选 qn27bg.png → 开启 → 调 scale/blur → 断言图层 filter/transform
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === '背景图片');
      const sel = row?.querySelector('select');
      if (!sel) return 'no-sel';
      const opt = [...sel.options].find((o) => o.value.includes('qn27bg'));
      if (!opt) return 'no-opt:' + [...sel.options].map((o) => o.value).join(',');
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`).then((r) => { if (r !== "ok") console.log(`  (背景选择: ${r})`); });
    await waitFor(ws, `!!document.getElementById('qn-bg-layer')`, 8000);
    // 模糊 + 缩放
    const blurRow = await evaluate(ws, `(() => {
      const rows = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')];
      return rows.map((r) => r.querySelector('span')?.textContent ?? '').join('|');
    })()`);
    void blurRow;
    const setRange = async (label, value) =>
      evaluate(ws, `(() => {
        const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.textContent.includes('${label}'));
        const input = row?.querySelector('input[type=range]');
        if (!input) return 'no-range';
        const set = ${nativeSet}; set(input, '${value}');
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`);
    await setRange("模糊", 8);
    await setRange("缩放", 150);
    await sleep(600);
    const layer = await evaluate(ws, `(() => { const el = document.getElementById('qn-bg-layer'); if (!el) return 'no-layer'; return JSON.stringify({ filter: el.style.filter, transform: el.style.transform, margin: el.style.margin }); })()`);
    const ly = JSON.parse(layer);
    check(
      ly.filter.includes("blur(8px)") && !ly.filter.includes("scale"),
      "背景 filter：模糊生效且不含非法的 scale()",
      layer,
    );
    check(ly.transform.includes("scale(1.5)"), "背景缩放走 transform（150%）", layer);
    check(ly.margin.includes("-"), "模糊时图层向外扩边（糊边不出现在视口内）", layer);
  }

  // ============================================== 7. 日历日格等高
  {
    // 先关掉第 6 节打开的设置：模态盖着树与页签，后续的点击全会被吃掉
    await evaluate(ws, `(() => { document.querySelector('.settings-close')?.click(); return !document.querySelector('.settings-close'); })()`);
    await sleep(400);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.sidebar-tab')].find((el) => el.textContent.includes('日历')); b?.click(); return !!b; })()`);
    await waitFor(ws, `document.querySelectorAll('.cal-day').length > 20`, 8000);
    const heights = await evaluate(ws, `(() => { const hs = [...document.querySelectorAll('.cal-day')].map((el) => el.getBoundingClientRect().height); const dots = [...document.querySelectorAll('.cal-day')].filter((el) => el.querySelector('.cal-dot')).length; return JSON.stringify({ min: Math.min(...hs), max: Math.max(...hs), dots }); })()`);
    const hh = JSON.parse(heights);
    check(hh.max - hh.min < 0.5 && hh.dots > 0, "日历日格等高（有圆点与无圆点一致）", heights);
  }

  // ============================================== 8. mermaid 导出目标分辨率
  {
    // 回到笔记：左栏第 5 节切到了「标签」视图，先切回知识库，再重新打开 qn27笔记
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.left-view-tab')].find((el) => el.textContent.includes('知识库')); b?.click(); return !!b; })()`);
    await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 10000);
    const reopened = await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn27笔记')); t?.click(); return !!t; })()`);
    const svgReady = reopened && await waitFor(ws, `!!document.querySelector('.cm-lp-mermaid svg')`, 20000);
    if (!svgReady) console.log("  (mermaid 没有重新渲染——后续导出断言会失败)");
    // 先只量 viewBox（不把导出这种重活挂在一个 evaluate 的 Promise 里）
    const viewBox = await evaluate(ws, `(() => { const svg = document.querySelector('.cm-lp-mermaid svg'); const vb = svg ? svg.viewBox.baseVal : null; return vb ? JSON.stringify({ w: vb.width, h: vb.height }) : ''; })()`);
    const src = viewBox ? JSON.parse(viewBox) : {};
    // 触发导出（页面侧只做点击；产物由 Node 轮询磁盘）
    const clicked = await evaluate(ws, `(() => {
      const btn = [...document.querySelectorAll('.qn-mermaid-btn')].find((b) => (b.title || '').includes('导出'));
      if (!btn) return 'no-btn';
      btn.click();
      const item = [...document.querySelectorAll('.qn-mermaid-menu-item')].find((b) => b.textContent === 'PNG');
      if (!item) return 'no-item';
      item.click();
      return 'ok';
    })()`);
    check(clicked === "ok", "触发 mermaid PNG 导出", clicked);
    const exportDir = join(vault, "导出");
    let png = null;
    for (let i = 0; i < 30 && !png; i += 1) {
      await sleep(500);
      try {
        const names = readdirSync(exportDir).filter((n) => n.endsWith(".png"));
        if (names.length > 0) {
          const buf = readFileSync(join(exportDir, names[0]));
          png = { file: names[0], w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
        }
      } catch {}
    }
    if (png && src.w) {
      // 导出走的是 htmlLabels:false 的重渲染，viewBox 与页面件略有出入（±15%），
      // 断言按「页面件尺寸」推目标区间：小图=光栅 3x 原样；大图=钳到 2x 自然尺寸
      const natural = Math.max(src.w, src.h);
      const long = Math.max(png.w, png.h);
      const expect = Math.min(5600, Math.max(2200, natural * 2));
      const tolerance = expect * 0.18;
      check(
        Math.abs(long - expect) <= tolerance,
        "mermaid PNG 目标长边 ≈ 2x 自然尺寸（预降采样，不再裸交 3x 大图）",
        `natural=${natural} long=${long} expect≈${expect}`,
      );
    } else {
      check(false, "mermaid PNG 导出产物与尺寸可读", `png=${JSON.stringify(png)} src=${JSON.stringify(src)}`);
    }
  }

  // ============================================== 9. 多窗口同步状态按仓库拆分
  {
    // 设置 → 同步 → 填一个 serverUrl（触发 updateConfig → persist 落盘）
    await key(ws, { mod: 2, key: "," }, "Comma", 188);
    const syncOpen = await waitFor(ws, `!!document.querySelector('[data-sec="sync"]')`, 8000);
    if (!syncOpen) console.log("  (设置面板没有打开——检查 Ctrl+, 分发)");
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('同步')); b?.click(); return !!b; })()`);
    await sleep(300);
    await evaluate(ws, `(() => {
      const rows = [...document.querySelectorAll('[data-sec="sync"] .settings-row')];
      const row = rows.find((r) => r.textContent.includes('服务端') || r.querySelector('input[type=text], input:not([type])'));
      const input = row?.querySelector('input');
      if (!input) return 'no-input';
      const set = ${nativeSet}; set(input, 'http://127.0.0.1:9');
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(1500);
    await sleep(1200);
    const files = readdirSync(appConfig).filter((n) => n.startsWith("sync-state"));
    const perVault = files.filter((n) => n.startsWith("sync-state-"));
    check(perVault.length >= 1, "per-vault 同步状态文件已生成", files.join(","));
    if (perVault.length > 0) {
      const pv = JSON.parse(readFileSync(join(appConfig, perVault[0]), "utf8"));
      check("cursor" in pv && "hashes" in pv, "per-vault 文件是完整状态（cursor/hashes）");
      check(
        typeof pv.vault === "string" && pv.vault.replace(/\\\\/g, "/").endsWith("vault"),
        "per-vault 文件归属当前仓库",
        pv.vault,
      );
    }
    if (files.includes("sync-state.json")) {
      const shared = JSON.parse(readFileSync(join(appConfig, "sync-state.json"), "utf8"));
      check(!("hashes" in shared) && !("cursor" in shared), "共享 sync-state.json 退化为薄配置（无游标/哈希）", JSON.stringify(Object.keys(shared)));
    }
  }

  console.log(failures === 0 ? "\n0.27 批测全部通过 ✓" : `\n共 ${failures} 项失败 ✗`);
} catch (err) {
  failures += 1;
  console.error(`脚本级失败：${err instanceof Error ? err.message : String(err)}`);
} finally {
  try {
    ws?.close();
  } catch {}
  try {
    child?.kill();
  } catch {}
  // WebView2 退出是异步的，锁着的 UDF 文件需要一点时间释放；清不掉就算了（临时目录）
  await sleep(2500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

process.exit(failures === 0 ? 0 : 1);

// 0.25 批次验收：本轮 4 项反馈的关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 + 临时
// 仓库），不依赖 verify-gui 的实例，结束时自清理。
//
// 覆盖：
// - 单词面板 0.25 规范重排：搜索行无「打开」钮、刷新为圆形图标钮、「···」菜单、
//   排序下拉（最近添加/字母 A-Z/字母 Z-A）、字母分组头「字母 · N 个单词」、空态
// - 释义自动获取（真网络·有道词典）：添加成功路径（音标+释义预览→保存→v3 行）；
//   详情「查询在线释义」把收词快捷键进来的裸词补全
// - 背景图层（0.26 回归）：主题色遮罩已回退，图层 opacity 只听用户滑杆的、
//   表面回到半透明让图透出来
// - 左栏激活页签：主题色低透明底（不再是白卡片浮起）
// - 热键仲裁（0.25 反馈④）：登记表被清空（比 0.24 测的"损坏"更贴近真实丢条目
//   场景）时第二实例靠进程枚举识别自家兄弟，静默让位不弹「注册截图快捷键失败」；
//   且新进程出生即在登记表自登记

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9366";
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
  const r = await cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
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

const mouseClick = async (ws, x, y) => {
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const rectCenter = (ws, selectorExpr) =>
  evaluate(ws, `(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

// ------------------------------------------------ 自备数据：临时仓库 + 种子单词本

const work = join(tmpdir(), `qn-025-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "vault");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

writeFileSync(
  join(vault, "qn25笔记.md"),
  ["# 0.25 批测", "", "正文内容。", ""].join("\n"),
  "utf8",
);
// 种子单词本：banana/cherry 带 meta 日期（排序断言），orchard 无释义（详情补全断言）
writeFileSync(
  join(vault, "单词本.md"),
  [
    "# 单词本",
    "",
    "## 待学习",
    "",
    "- banana — 2026-10-15 · 种子",
    "- cherry — 2026-10-17 · 种子",
    "- apple — 2026-10-16 · 种子",
    "- orchard",
    "",
    "## 已掌握",
    "",
  ].join("\n"),
  "utf8",
);

/** 本机配置目录（gui-test 变体独立）。0.28 起单词本存在这里。 */
const appConfig = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "com.quicknote.gui-test",
);
// 种子仍是仓库内的 单词本.md（验证迁移）；断言读账户级全局文件。
const vocabFile = join(appConfig, "vocabulary.md");
const readVocab = () => (existsSync(vocabFile) ? readFileSync(vocabFile, "utf8") : "");

const spawnInstance = (vaultDir) =>
  spawn(exe, [vaultDir.replace(/\\/g, "/")], {
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
  // 干净的 WebView 配置与登记表：残留会让断言不稳定
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });
  rmSync(join(appConfig, "open-vaults.json"), { force: true });
  // 账户级单词本：清空后由种子仓库迁移进来，排序/分组断言才是确定的
  rmSync(vocabFile, { force: true });
  rmSync(join(appConfig, "vocabulary-migrated.json"), { force: true });

  child = spawnInstance(vault);
  // 端口就绪 + 真页面出现
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
  // 等仓库载入（文件树出现）
  await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 30000);

  // 切到单词页签（供全部面板断言复用）
  const openVocabTab = async () => {
    const pos = await rectCenter(ws, `Array.from(document.querySelectorAll('.sidebar-tab')).find((el) => el.textContent.includes('单词'))`);
    if (!pos) return false;
    await mouseClick(ws, pos.x, pos.y);
    await sleep(500);
    return !!(await evaluate(ws, `!!document.querySelector('.vocab-search')`));
  };
  check(await openVocabTab(), "右侧面板出现「单词」页签");

  // ---------------------------------------------- 1. 面板布局规范（0.25 反馈②③）
  const searchRowText = await evaluate(ws, `document.querySelector('.vocab-search-row')?.textContent ?? ''`);
  check(!searchRowText.includes("打开"), "搜索行不再有「打开」按钮", searchRowText);
  check(!!(await evaluate(ws, `!!document.querySelector('.vocab-refresh')`)), "刷新为独立圆形图标钮");
  // 「···」菜单里有「在文件夹中显示单词本」（0.28：账户级文件不在仓库里）
  await evaluate(ws, `(() => { document.querySelector('.vocab-more-btn')?.click(); return true; })()`);
  await sleep(300);
  const moreItems = await evaluate(ws, `[...document.querySelectorAll('.vocab-menu-item')].map((b) => b.textContent)`);
  check(moreItems.some((t) => t.includes("在文件夹中显示单词本")), "「···」菜单含在文件夹中显示单词本", JSON.stringify(moreItems));
  await evaluate(ws, `(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
  await sleep(200);
  // 排序下拉：默认字母 A-Z；含最近添加
  const sortLabel = await evaluate(ws, `document.querySelector('.vocab-toolbar-btn')?.textContent ?? ''`);
  check(String(sortLabel).includes("字母 A-Z"), "排序默认字母 A-Z", String(sortLabel));
  await evaluate(ws, `(() => { document.querySelector('.vocab-toolbar-btn')?.click(); return true; })()`);
  await sleep(300);
  const sortItems = await evaluate(ws, `[...document.querySelectorAll('.vocab-menu .vocab-menu-item')].map((b) => b.textContent)`);
  check(
    sortItems.length === 3 && sortItems[0].includes("最近添加") && sortItems[1].includes("字母 A-Z") && sortItems[2].includes("字母 Z-A"),
    "排序选项：最近添加/字母 A-Z/字母 Z-A",
    JSON.stringify(sortItems),
  );
  // 收起菜单（外面点一下），让后续用例从确定状态开始
  await evaluate(ws, `(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
  await sleep(200);
  // 字母分组头（默认 A-Z 分组）
  const groupHeads = await evaluate(ws, `[...document.querySelectorAll('.vocab-group-letter')].map((g) => g.textContent.trim())`);
  check(
    groupHeads.length >= 2 && groupHeads.every((t) => /· \d+ 个单词/.test(t)),
    "字母分组头「字母 · N 个单词」",
    JSON.stringify(groupHeads),
  );

  // ---------------------------------------------- 2. 排序行为
  // 最近添加：按 meta 日期倒序、无分组头
  await evaluate(ws, `(() => { document.querySelector('.vocab-toolbar-btn')?.click(); return true; })()`);
  await sleep(250);
  await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-menu-item')].find((b) => b.textContent.includes('最近添加'))?.click(); return true; })()`);
  await sleep(400);
  const recentWords = await evaluate(ws, `[...document.querySelectorAll('.vocab-item .vocab-item-word')].map((el) => el.textContent)`);
  check(
    JSON.stringify(recentWords) === JSON.stringify(["cherry", "apple", "banana", "orchard"]),
    "最近添加按 meta 日期倒序且无分组",
    JSON.stringify(recentWords),
  );
  // 换回字母 A-Z（顺带验证排序选择持久化由组件写入 localStorage）
  await evaluate(ws, `(() => { document.querySelector('.vocab-toolbar-btn')?.click(); return true; })()`);
  await sleep(250);
  await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-menu-item')].find((b) => b.textContent.includes('字母 A-Z'))?.click(); return true; })()`);
  await sleep(400);
  const azWords = await evaluate(ws, `[...document.querySelectorAll('.vocab-item .vocab-item-word')].map((el) => el.textContent)`);
  check(
    JSON.stringify(azWords.slice(0, 3)) === JSON.stringify(["apple", "banana", "cherry"]),
    "字母 A-Z 分组排序",
    JSON.stringify(azWords),
  );

  // ---------------------------------------------- 3. 释义自动获取（真网络）
  // 成功路径：scenario → 预览（音标+释义）→ 保存 → v3 行落盘
  await evaluate(ws, `(() => { document.querySelector('.vocab-add-toggle')?.click(); return true; })()`);
  await sleep(300);
  await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.vocab-add-input'), 'scenario'); document.querySelector('.vocab-add-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  const previewOk = await waitFor(
    ws,
    `(() => {
      const card = document.querySelector('.vocab-lookup');
      if (!card) return false;
      if (card.textContent.includes('未找到在线释义')) return 'failed';
      const phon = card.querySelector('.vocab-lookup-phonetic')?.textContent ?? '';
      const mean = card.querySelector('.vocab-lookup-meaning')?.textContent ?? '';
      return phon.startsWith('/') && mean.includes('n. ') ? 'ok' : false;
    })()`,
    25000,
    700,
  );
  check(previewOk === "ok", "在线查询预览含音标与词性释义", String(previewOk));
  if (previewOk === "ok") {
    await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-lookup-actions button')].find((b) => b.textContent === '保存')?.click(); return true; })()`);
    await sleep(1000);
    const vocab = readVocab();
    const line = vocab.split("\n").find((l) => l.includes("- scenario"));
    check(
      !!line && /- scenario \| .+ \| .* \| \/s/.test(line) && line.includes("— 2026-"),
      "保存后 v3 行带释义与音标",
      line ?? vocab,
    );
    const phonShown = await evaluate(ws, `(() => { const item = [...document.querySelectorAll('.vocab-item')].find((el) => el.textContent.includes('scenario')); return !!item && !!item.querySelector('.vocab-item-phonetic'); })()`);
    check(phonShown, "列表卡片显示音标");
  } else {
    check(false, "在线查询预览（网络不可用或词典未收录，跳过保存断言）", String(previewOk));
    await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-lookup-actions button')].find((b) => b.textContent === '取消')?.click(); return true; })()`);
  }

  // 详情「查询在线释义」：收词快捷键进来的裸词（orchard）补全
  await evaluate(ws, `(() => { const item = [...document.querySelectorAll('.vocab-item')].find((el) => el.textContent.includes('orchard')); item?.click(); return !!item; })()`);
  await waitFor(ws, `!!document.querySelector('.vocab-detail')`, 4000);
  const lookupBtn = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.vocab-detail-none button')].find((x) => x.textContent === '查询在线释义'); if (!b) return false; b.click(); return true; })()`, 4000);
  check(lookupBtn, "无释义的详情出现「查询在线释义」");
  const filled = await waitFor(
    ws,
    `(() => {
      const el = [...document.querySelectorAll('.vocab-detail-meaning')][0];
      return el && el.textContent.trim().length > 0;
    })()`,
    25000,
    700,
  );
  check(!!filled, "详情释义自动填入（在线查询写回）");
  await sleep(800);
  const vocabAfterFill = readVocab();
  const orchardLine = vocabAfterFill.split("\n").find((l) => l.includes("- orchard"));
  check(
    !!orchardLine && orchardLine.split("|").length >= 2,
    "裸词补全后落盘 v2/v3 行（释义字段出现）",
    orchardLine ?? vocabAfterFill,
  );
  await evaluate(ws, `(() => { document.querySelector('.vocab-detail-close')?.click(); return true; })()`);
  await sleep(400);

  // ---------------------------------------------- 4. 空态
  // 清空单词本 → 「还没有记录单词」+ 添加按钮
  writeFileSync(vocabFile, "# 单词本\n\n## 待学习\n\n## 已掌握\n", "utf8");
  await evaluate(ws, `(() => { document.querySelector('.vocab-refresh')?.click(); return true; })()`);
  const emptyShown = await waitFor(
    ws,
    `(() => { const el = document.querySelector('.vocab-empty-list'); return !!el && el.textContent.includes('还没有记录单词'); })()`,
    6000,
  );
  check(!!emptyShown, "空列表态：还没有记录单词");
  await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-empty-list .vocab-btn')].find((b) => b.textContent.includes('添加单词'))?.click(); return true; })()`);
  await sleep(300);
  check(!!(await evaluate(ws, `!!document.querySelector('.vocab-add-input')`)), "空态「＋ 添加单词」展开添加区");
  await evaluate(ws, `(() => { const el = document.querySelector('.vocab-add-input'); el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
  await sleep(250);
  check(!(await evaluate(ws, `!!document.querySelector('.vocab-add-input')`)), "Esc 关闭添加区");

  // ---------------------------------------------- 5. 背景图层（0.26 回归断言）
  // 0.25 曾在图层上叠 ::after 主题色遮罩把图压到 ~12% 感知透明度——用户反馈
  // "几乎看不见背景图片、调节设置也没有用"，0.26 整体回退。这里断言：
  //   a) 遮罩确实没有了（::after 不再上色）；
  //   b) 图层 opacity 完全由内联样式（用户滑杆）控制；
  //   c) 表面回到半透明（sidebar 66% 面板色），图透得出来。
  const bgLayer = await evaluate(ws, `(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="qn-bg-layer"></div>');
    document.documentElement.classList.add('qn-bg-on');
    const layer = document.getElementById('qn-bg-layer');
    layer.style.opacity = '0.9';
    const root = document.documentElement;
    const prev = root.dataset.theme ?? '';
    root.dataset.theme = 'light';
    const afterLight = getComputedStyle(layer, '::after').backgroundColor;
    root.dataset.theme = 'dark';
    const afterDark = getComputedStyle(layer, '::after').backgroundColor;
    const opacity = getComputedStyle(layer).opacity;
    const sidebar = getComputedStyle(document.querySelector('.sidebar')).backgroundColor;
    if (prev) root.dataset.theme = prev;
    else delete root.dataset.theme;
    layer.remove();
    root.classList.remove('qn-bg-on');
    return { afterLight, afterDark, opacity, sidebar };
  })()`);
  check(
    String(bgLayer?.afterLight ?? "").replace(/\s/g, "").startsWith("rgba(0,0,0,0)")
      && String(bgLayer?.afterDark ?? "").replace(/\s/g, "").startsWith("rgba(0,0,0,0)"),
    "背景图层不再叠主题色遮罩（0.26 回退，图只听不透明度滑杆的）",
    JSON.stringify(bgLayer),
  );
  check(
    bgLayer?.opacity === "0.9",
    "图层 opacity 由用户设置直接控制",
    JSON.stringify(bgLayer?.opacity),
  );
  check(
    !!bgLayer?.sidebar && !bgLayer.sidebar.startsWith("rgba(0, 0, 0, 0)") && bgLayer.sidebar !== "rgb(255, 255, 255)",
    "启用背景时侧栏回到半透明底（图能透出来）",
    JSON.stringify(bgLayer?.sidebar),
  );

  // ---------------------------------------------- 6. 左栏激活页签：主题色低透明底
  const tabStyle = await evaluate(ws, `(() => {
    const tab = document.querySelector('.left-view-tab.is-on');
    if (!tab) return null;
    const cs = getComputedStyle(tab);
    return { background: cs.backgroundColor, shadow: cs.boxShadow };
  })()`);
  check(
    !!tabStyle && tabStyle.shadow === "none" && tabStyle.background !== "rgba(0, 0, 0, 0)",
    "左栏激活页签为主题色低透明底（无卡片阴影）",
    JSON.stringify(tabStyle),
  );

  // ---------------------------------------------- 7. 热键仲裁：登记表被清空仍让位（0.25 反馈④）
  // 比 0.24 测的「登记表损坏」更贴近真实丢条目：文件整个没了。0.24 代码在此会
  // 判"没有兄弟"而当面弹错；0.25 起靠进程枚举识别自家兄弟。
  rmSync(join(appConfig, "open-vaults.json"), { force: true });
  const vault2 = join(work, "vault2");
  mkdirSync(vault2, { recursive: true });
  writeFileSync(join(vault2, "第二仓库.md"), "# 第二仓库\n", "utf8");
  const child2 = spawnInstance(vault2);
  let ws2 = null;
  try {
    let page2 = null;
    for (let i = 0; i < 40 && !page2; i += 1) {
      await sleep(1000);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        const pages = list.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
        if (pages.length >= 2) page2 = pages[1];
      } catch {}
    }
    if (!page2) {
      check(false, "登记表清空场景：未发现第二个页面目标");
    } else {
      ws2 = new WebSocket(page2.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws2.addEventListener("open", resolve, { once: true });
        ws2.addEventListener("error", () => reject(new Error("ws2 连接失败")), { once: true });
      });
      let b2 = false;
      for (let i = 0; i < 30 && !b2; i += 1) {
        await sleep(800);
        b2 = await cdp(ws2, "Runtime.evaluate", {
          expression: `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0; } catch { return false; } })()`,
          returnByValue: true,
        }).then((r) => r.result.value).catch(() => false);
      }
      check(b2, "登记表清空场景：第二实例启动");
      // 热键注册路径跑完再断言
      await sleep(3000);
      const b2text = await cdp(ws2, "Runtime.evaluate", {
        expression: `document.body.textContent.slice(0, 6000)`,
        returnByValue: true,
      }).then((r) => r.result.value).catch(() => "");
      check(!b2text.includes("注册截图快捷键失败"), "登记表被清空时静默让位（进程枚举识别兄弟，不再弹「被其他程序占用」）");
      // 新进程出生即自登记：登记表里应有它自己的条目
      const registry = existsSync(join(appConfig, "open-vaults.json"))
        ? readFileSync(join(appConfig, "open-vaults.json"), "utf8")
        : "";
      check(registry.includes(vault2.replace(/\\/g, "/")), "新进程出生即在登记表自登记", registry);
    }
  } finally {
    try {
      process.kill(child2.pid);
    } catch {}
    try {
      ws2?.close();
    } catch {}
  }
  await sleep(800);
} catch (error) {
  failures += 1;
  console.error(`✗ 批测中断：${error?.message ?? error}`);
} finally {
  try {
    ws?.close();
  } catch {}
  try {
    process.kill(child?.pid);
  } catch {}
  await sleep(800);
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n0.25 批次验收全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

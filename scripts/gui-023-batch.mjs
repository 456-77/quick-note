// 0.23 批次验收：本轮 11 项反馈的关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 +
// 临时仓库），不依赖 verify-gui 的实例，结束时自清理。
//
// 覆盖：粘贴多表格 HTML 整篇转换 / 文件内搜索字段联动(a_b)+状态持久化 /
// 搜索面板切笔记自动隐藏 / 全局搜索跳转红色高亮+居中+表格保持渲染 /
// palette 搜索词保留 / 悬停预览鼠标移入不消失 / md 链接点击打开本地文件 /
// mermaid PNG 导出 3x 光栅化 / 单词本（面板增删+热键收词）/ 跨窗口设置热加载。

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9333";
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

/** 轮询直到 evaluate 断言为真或超时；返回最后的真值（0.25 单词面板流程用）。 */
const waitFor = async (ws, expression, timeoutMs, pollMs = 500) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}`;

const statusText = (ws) =>
  evaluate(ws, `Array.from(document.querySelectorAll('.status-cell')).map((el) => el.textContent).join('|')`);

/** CDP 真实鼠标移动/点击（合成 React enter/leave 与 document 委托需要真事件）。 */
const mouseMove = async (ws, x, y) => {
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
};
const mouseClick = async (ws, x, y) => {
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const rectCenter = (ws, selectorExpr) =>
  evaluate(ws, `(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

// ------------------------------------------------ 自备数据：临时仓库

const work = join(tmpdir(), `qn-023-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "vault");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });
/** 账户级单词本（0.28 起不再是仓库内的 单词本.md）。 */
const appConfig = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "com.quicknote.gui-test",
);
const globalVocabFile = join(appConfig, "vocabulary.md");

writeFileSync(
  join(vault, "qn23字段.md"),
  [
    "# 字段联动",
    "",
    "- 表字段：user_name VARCHAR(64)",
    "- 属性名：userName 在 JSON 里",
    "- 纯小写 username 也出现一次",
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(
  join(vault, "qn23表格.md"),
  [
    "# 表格页",
    "",
    ...Array.from({ length: 90 }, (_, i) => `垫高行 ${i + 1}，让跳转居中有意义。`),
    "",
    "| 名称 | 值 |",
    "|---|---|",
    "| alpha | QN23CELL |",
    "| beta | 2 |",
    "",
    "表格后一行。正文标记 QN23RED 供高亮断言。",
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(
  join(vault, "qn23链接.md"),
  ["# 链接页", "", "前往 [字段页](qn23字段.md) 查看字段；表格见 [表格页](qn23表格.md)。", ""].join("\n"),
  "utf8",
);
writeFileSync(
  join(vault, "qn23图.md"),
  ["# 图", "", "```mermaid", "graph LR", "A-->B", "```", ""].join("\n"),
  "utf8",
);
writeFileSync(join(vault, "qn23粘贴.md"), ["# 粘贴目标", "", "正文。", ""].join("\n"), "utf8");

// 粘贴用 HTML：标题 + 段落 + 两张表 + 代码块 + 有序列表（AI 回答的典型形状）
const PASTE_HTML = [
  "<h2>AI回答标题</h2>",
  "<p>开头一段说明 <strong>加粗词</strong> 与 <code>inline_code</code>。</p>",
  "<table><thead><tr><th>选项</th><th>作用</th></tr></thead><tbody>",
  "<tr><td>-i</td><td>忽略大小写</td></tr>",
  "<tr><td>-n</td><td>显示行号</td></tr>",
  "</tbody></table>",
  '<pre><code class="language-bash">grep -n "func" main.py</code></pre>',
  "<table><tr><td>元字符</td><td>含义</td></tr><tr><td>^</td><td>行首</td></tr></table>",
  "<ol><li>第一步</li><li>第二步</li></ol>",
].join("");
const PASTE_TEXT = "AI回答标题\n纯文本回退内容";

// ------------------------------------------------ 起实例 + 连 CDP

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

// 单词本现在是账户级：清掉上一批测留下的全局文件，断言才从空库开始
rmSync(globalVocabFile, { force: true });
rmSync(join(appConfig, "vocabulary-migrated.json"), { force: true });
const child = spawnInstance();
let ws = null;
try {
  let portReady = false;
  for (let i = 0; i < 45 && !portReady; i += 1) {
    await sleep(1000);
    portReady = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
  }
  if (!portReady) throw new Error("调试端口未就绪");
  let booted = false;
  for (let i = 0; i < 60 && !booted; i += 1) {
    ws = await connectPage(0).catch(() => null);
    if (!ws) continue;
    booted = await evaluate(
      ws,
      `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0; } catch { return false; } })()`,
    ).catch(() => false);
    if (!booted) {
      ws.close();
      ws = null;
    }
  }
  check(booted, "应用就绪（临时仓库已打开）");
  if (!booted) {
    // 诊断现场：调试端口上到底有哪些目标、页面在什么 URL
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json())
      .catch((e) => `list-failed: ${e}`);
    console.log("  启动失败现场：", JSON.stringify(targets)?.slice(0, 1200));
    throw new Error("应用没起来");
  }

  const docString = () => evaluate(ws, `window.__qnView.state.doc.toString()`);

  const openNoteByLabel = async (label) => {
    await evaluate(
      ws,
      `(() => { const row = Array.from(document.querySelectorAll('.tree-file')).find((el) => el.textContent.includes('${label}')); if (!row) return false; row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})); return true; })()`,
    );
    for (let i = 0; i < 20; i += 1) {
      await sleep(300);
      const done = await evaluate(
        ws,
        `(() => { try { return window.__qnView.state.doc.toString().includes('${label.replace(/'/g, "")}') || window.__qnView.state.doc.lines > 3; } catch { return false; } })()`,
      ).catch(() => false);
      if (done) return true;
    }
    return false;
  };

  // ---------------------------------------------- 1. 粘贴多表格 HTML → 整篇转换
  check(await openNoteByLabel("qn23粘贴.md"), "打开 qn23粘贴.md");
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
    return true;
  })()`);
  // 同步 evaluate 派发 + node 侧 sleep + 同步 evaluate 读值（0.22.1 轮教训：
  // 合成 paste 之后的 awaitPromise 会被毒化，异步读取一律轮询变量）
  await evaluate(ws, `(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', ${JSON.stringify(PASTE_HTML)});
    dt.setData('text/plain', ${JSON.stringify(PASTE_TEXT)});
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    window.__qnView.contentDOM.dispatchEvent(ev);
    return true;
  })()`);
  await sleep(800);
  const pasted = await docString();
  check(pasted.includes("## AI回答标题"), "粘贴：标题转成 Markdown", pasted.slice(-500));
  check(pasted.includes("**加粗词**") && pasted.includes("`inline_code`"), "粘贴：行内样式保留");
  check(pasted.includes("| 选项 | 作用 |") && pasted.includes("| -i | 忽略大小写 |"), "粘贴：第一张表转管道表格");
  check(pasted.includes("| 元字符 | 含义 |") && pasted.includes("| ^ | 行首 |"), "粘贴：第二张表也保留（旧实现只留一张）");
  check(pasted.includes("```bash") && pasted.includes('grep -n "func" main.py'), "粘贴：代码块带语言围栏");
  check(pasted.includes("1. 第一步") && pasted.includes("2. 第二步"), "粘贴：有序列表");

  // ---------------------------------------------- 2. 字段联动（a_b 开关）
  check(await openNoteByLabel("qn23字段.md"), "打开 qn23字段.md");
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    view.dispatch({ selection: { anchor: 0 } });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    view.focus();
    return true;
  })()`);
  await sleep(400);
  let panelOn = await evaluate(ws, `!!document.querySelector('.qn-search')`);
  check(panelOn, "Ctrl+F 打开文件内搜索面板");
  if (panelOn) {
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.qn-search-input'), 'userName'); return true; })()`);
    await sleep(300);
    const offCount = await evaluate(ws, `document.querySelector('.qn-search-count')?.textContent ?? ''`);
    check(/\/\s*2$/.test(offCount.trim()), "联动关：userName 只命中 2 处（驼峰+小写）", offCount);
    await evaluate(ws, `(() => { const b = document.querySelector('.qn-search [data-toggle="fieldMode"]'); b?.click(); return !!b; })()`);
    await sleep(300);
    const onCount = await evaluate(ws, `document.querySelector('.qn-search-count')?.textContent ?? ''`);
    check(/\/\s*3$/.test(onCount.trim()), "联动开：user_name/userName/username 一并命中（3 处）", onCount);
    const toggledClass = await evaluate(
      ws,
      `document.querySelector('.qn-search [data-toggle="fieldMode"]')?.classList.contains('is-on')`,
    );
    check(toggledClass, "a_b 按钮点亮");

    // ---------------------------------------------- 3. 切笔记自动隐藏（顺带验持久化）
    // 先不关面板直接切笔记
    check(await openNoteByLabel("qn23链接.md"), "切到 qn23链接.md");
    await sleep(400);
    const goneAfterSwitch = await evaluate(ws, `!document.querySelector('.qn-search')`);
    check(goneAfterSwitch, "切笔记后搜索面板自动隐藏");
    // 持久化：重载后再开面板，搜索词与联动开关都在
    await cdp(ws, "Page.reload").catch(() => undefined);
    let reloaded = false;
    for (let i = 0; i < 30 && !reloaded; i += 1) {
      await sleep(600);
      reloaded = await evaluate(
        ws,
        `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0 && !!window.__qnView; } catch { return false; } })()`,
      ).catch(() => false);
    }
    check(reloaded, "重载完成");
    check(await openNoteByLabel("qn23字段.md"), "重载后重新打开笔记");
    await sleep(400);
    await evaluate(ws, `(() => {
      const view = window.__qnView;
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
      view.focus();
      return true;
    })()`);
    await sleep(400);
    const persistedQuery = await evaluate(ws, `document.querySelector('.qn-search-input')?.value ?? ''`);
    check(persistedQuery === "userName", "搜索词跨重启保留", persistedQuery);
    const persistedToggle = await evaluate(
      ws,
      `document.querySelector('.qn-search [data-toggle="fieldMode"]')?.classList.contains('is-on')`,
    );
    check(persistedToggle, "字段联动开关跨重启保留");
    await evaluate(ws, `(() => { document.querySelector('.qn-search [data-act="close"]')?.click(); return true; })()`);
    await sleep(300);
  }

  // ---------------------------------------------- 4. 全局搜索跳转：居中+表格渲染态+红色高亮
  /** palette 里搜一个词并点「内容」命中。 */
  const searchAndPick = async (term, label) => {
    await evaluate(
      ws,
      `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`,
    );
    await sleep(500);
    if (!(await evaluate(ws, `!!document.querySelector('.palette-input')`))) return null;
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.palette-input'), ${JSON.stringify(term)}); return true; })()`);
    await sleep(900); // 防抖 250 + Rust 扫描
    const item = await evaluate(ws, `(() => {
      const item = Array.from(document.querySelectorAll('.palette-item')).find((el) => el.querySelector('.palette-item-icon')?.textContent === '🔎' && el.textContent.includes(${JSON.stringify(label)}));
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!item) return null;
    await mouseClick(ws, item.x, item.y);
    await sleep(1200); // 打开 + 跳转
    return item;
  };
  const closePalette = async () => {
    await evaluate(ws, `(() => { document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
    await sleep(400);
  };

  const picked = await searchAndPick("QN23CELL", "qn23表格.md");
  check(!!picked, "内容命中出现（qn23表格.md）");
  if (picked) {
      const jumped = await docString();
      check(jumped.includes("| alpha | QN23CELL |"), "跳转到 qn23表格.md");
      const tableVisible = await evaluate(ws, `(() => {
        const el = document.querySelector('.cm-lp-table');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const scroller = window.__qnView.scrollDOM.getBoundingClientRect();
        return r.top < scroller.bottom && r.bottom > scroller.top;
      })()`);
      check(tableVisible, "命中在表格里：表格保持渲染态（不显示源码）");
      const centered = await evaluate(ws, `(() => {
        const el = document.querySelector('.cm-lp-table');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const s = window.__qnView.scrollDOM.getBoundingClientRect();
        return Math.abs((r.top + r.bottom) / 2 - (s.top + s.bottom) / 2) < s.height * 0.42;
      })()`);
      check(centered === true, "跳转目标滚动到屏幕中间", JSON.stringify(centered));
  }
  await closePalette();

  // 红色高亮：普通文本命中的那处（表格是 widget，源码不渲染、高亮元素不在 DOM）
  // 0.26 起高亮色可配置（--qn-hit 默认 #ff5252），CSS 用 color-mix 派生——
  // 计算值不再是 rgba() 字符串而是 color(srgb …)，断言改成"红占优 + 变量就位"。
  const pickedRed = await searchAndPick("QN23RED", "qn23表格.md");
  check(!!pickedRed, "正文命中出现（QN23RED）");
  if (pickedRed) {
    const redHighlight = await evaluate(ws, `(() => {
      const all = document.querySelector('.cm-searchMatch');
      const selected = document.querySelector('.cm-searchMatch-selected');
      const norm = (value) => {
        const s = String(value ?? '');
        let m = s.match(/color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/);
        if (m) return { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255 };
        m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/);
        if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
        return null;
      };
      const redDominant = (c) => !!c && c.r > 150 && c.r > c.g * 1.8 && c.r > c.b * 1.8;
      const allBg = all ? getComputedStyle(all).backgroundColor : null;
      const selectedBg = selected ? getComputedStyle(selected).backgroundColor : null;
      const sel = norm(selectedBg);
      return {
        varHit: getComputedStyle(document.documentElement).getPropertyValue('--qn-hit').trim(),
        allBg,
        hasSelected: !!selected,
        selectedBg,
        allRed: redDominant(norm(allBg)),
        selRed: redDominant(sel),
        // 深红 = 与黑混 72%（srgb 0.72…）或旧格式的 229,57,53
        selDeep: !!sel && (String(selectedBg).includes('229, 57, 53') || Math.abs(sel.r - 255 * 0.72) < 30),
      };
    })()`);
    check(
      redHighlight.varHit === "#ff5252" && redHighlight.allRed,
      "命中高亮为红色（--qn-hit 变量 + 红占优）",
      JSON.stringify(redHighlight),
    );
    check(redHighlight.hasSelected && redHighlight.selDeep, "当前命中更深红", JSON.stringify(redHighlight));
  }
  await closePalette();

  // ---------------------------------------------- 5. palette 保留搜索词
  if (await evaluate(ws, `!!document.querySelector('.palette-input')`)) await closePalette();
  await evaluate(
    ws,
    `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`,
  );
  await sleep(500);
  if (await evaluate(ws, `!!document.querySelector('.palette-input')`)) {
    const retained = await evaluate(ws, `document.querySelector('.palette-input')?.value ?? ''`);
    check(retained === "QN23RED", "palette 搜索词保留（重开不丢）", retained);
    await closePalette();
  }

  // ---------------------------------------------- 6. 悬停预览：鼠标移进卡片不消失
  await evaluate(
    ws,
    `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`,
  );
  await sleep(500);
  if (await evaluate(ws, `!!document.querySelector('.palette-input')`)) {
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.palette-input'), 'QN23CELL'); return true; })()`);
    await sleep(900);
    const item = await rectCenter(ws, `Array.from(document.querySelectorAll('.palette-item')).find((el) => el.querySelector('.palette-item-icon')?.textContent === '🔎')`);
    if (item) {
      await mouseMove(ws, 6, 6); // 先离开此前点击停留的坐标，否则同坐标移动不触发 mouseover
      await sleep(200);
      await mouseMove(ws, item.x, item.y);
      let previewShown = false;
      for (let i = 0; i < 10 && !previewShown; i += 1) {
        await sleep(400);
        previewShown = await evaluate(ws, `!!document.querySelector('.palette-preview')`);
      }
      check(previewShown, "悬停结果行出现预览卡");
      if (previewShown) {
        // 鼠标移进预览卡：宽限期内到达 → 预览保持
        const card = await rectCenter(ws, `document.querySelector('.palette-preview')`);
        await mouseMove(ws, card.x, card.y);
        await sleep(800);
        const stillThere = await evaluate(ws, `!!document.querySelector('.palette-preview')`);
        check(stillThere, "鼠标移入预览卡后预览保持（旧实现立即消失）");
        // 移到搜索框（列表与卡片之外）→ 宽限期后撤销
        const input = await rectCenter(ws, `document.querySelector('.palette-input')`);
        await mouseMove(ws, input.x, input.y);
        await sleep(900);
        const goneNow = await evaluate(ws, `!document.querySelector('.palette-preview')`);
        check(goneNow, "移到无关区域后预览按宽限期撤销");
      }
    } else {
      check(false, "悬停预览：没找到内容命中行");
    }
    await evaluate(ws, `(() => { document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
    await sleep(300);
  }

  // ---------------------------------------------- 7. md 链接点击打开本地文件
  check(await openNoteByLabel("qn23链接.md"), "打开 qn23链接.md");
  await sleep(300);
  const linkPos = await rectCenter(ws, `Array.from(document.querySelectorAll('[data-md-link]')).find((el) => el.textContent.includes('字段页'))`);
  check(!!linkPos, "md 链接渲染为可点目标（data-md-link）");
  if (linkPos) {
    await mouseClick(ws, linkPos.x, linkPos.y);
    await sleep(1000);
    const opened = await docString();
    check(opened.includes("user_name VARCHAR"), "点击 [字段页](qn23字段.md) 打开目标笔记", opened.slice(0, 80));
  }

  // ---------------------------------------------- 8. mermaid PNG 导出 3x 光栅化
  // （0.24 起导出走「原生文本重渲染」，图尺寸与页面内 HTML 标签渲染的 viewBox
  // 不同——基准改为导出的 SVG 文件自身的 viewBox，两者同源同比例）
  check(await openNoteByLabel("qn23图.md"), "打开 qn23图.md");
  let svgInfo = null;
  for (let i = 0; i < 20 && !svgInfo; i += 1) {
    await sleep(500);
    svgInfo = await evaluate(ws, `(() => {
      const svg = document.querySelector('.cm-lp-mermaid svg');
      if (!svg || !svg.viewBox?.baseVal?.width) return null;
      return { w: svg.viewBox.baseVal.width, h: svg.viewBox.baseVal.height };
    })()`).catch(() => null);
  }
  check(!!svgInfo, "mermaid 块渲染出 SVG", JSON.stringify(svgInfo));
  if (svgInfo) {
    // 光标放回文档开头（若在图内会退回源码）
    await evaluate(ws, `(() => { const v = window.__qnView; v.dispatch({ selection: { anchor: 0 } }); v.focus(); return true; })()`);
    await sleep(600);
    const dl = await rectCenter(ws, `document.querySelector('.cm-lp-mermaid .qn-mermaid-toolbar button[title="导出 SVG / PNG"]')`);
    check(!!dl, "mermaid 工具栏出现");
    if (dl) {
      // 先导 SVG（拿基准 viewBox），再导 PNG 比对
      await mouseClick(ws, dl.x, dl.y);
      await sleep(400);
      const svgItem = await rectCenter(ws, `Array.from(document.querySelectorAll('.qn-mermaid-menu-item')).find((el) => el.textContent === 'SVG')`);
      if (svgItem) {
        await mouseClick(ws, svgItem.x, svgItem.y);
        await sleep(2500);
      }
      await mouseClick(ws, dl.x, dl.y);
      await sleep(400);
      const pngItem = await rectCenter(ws, `Array.from(document.querySelectorAll('.qn-mermaid-menu-item')).find((el) => el.textContent === 'PNG')`);
      if (pngItem) {
        await mouseClick(ws, pngItem.x, pngItem.y);
        let svgPath = null;
        let pngPath = null;
        for (let i = 0; i < 10 && !(svgPath && pngPath); i += 1) {
          await sleep(800);
          const dir = join(vault, "导出");
          if (existsSync(dir)) {
            const fsMod = await import("node:fs");
            const files = fsMod.readdirSync(dir);
            if (!svgPath && files.some((f) => f.endsWith(".svg"))) svgPath = join(dir, files.find((f) => f.endsWith(".svg")));
            if (!pngPath && files.some((f) => f.endsWith(".png"))) pngPath = join(dir, files.find((f) => f.endsWith(".png")));
          }
        }
        check(!!pngPath, "导出 PNG 落到导出目录", pngPath ?? "无文件");
        if (pngPath && svgPath) {
          const vb = /viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/.exec(readFileSync(svgPath, "utf8"));
          const buf = readFileSync(pngPath);
          const width = buf.readUInt32BE(16);
          const height = buf.readUInt32BE(20);
          const baseW = vb ? Number(vb[3]) : 0;
          const baseH = vb ? Number(vb[4]) : 0;
          check(
            baseW > 0 && Math.abs(width / baseW - 3) < 0.05 && Math.abs(height / baseH - 3) < 0.05,
            `PNG 与导出 SVG 同比例 3x 光栅化（${width}x${height} vs ${baseW}x${baseH}）`,
          );
        }
      } else {
        check(false, "导出菜单没有 PNG 项");
      }
    }
  }

  // ---------------------------------------------- 9. 单词本
  // （0.25 面板重排后：添加区默认收起（＋ 添加新单词），展开后回车先在线查询——
  // 生造词查询必失败，走「手动填写释义」兜底保存；标记掌握走详情弹层）
  const tabPos = await rectCenter(ws, `Array.from(document.querySelectorAll('.sidebar-tab')).find((el) => el.textContent.includes('单词'))`);
  check(!!tabPos, "右侧面板出现「单词」页签");
  if (tabPos) {
    await mouseClick(ws, tabPos.x, tabPos.y);
    await sleep(500);
    // 展开添加区：点「＋ 添加新单词」
    await evaluate(ws, `(() => { const el = document.querySelector('.vocab-add-toggle'); if (!el) return false; el.click(); return true; })()`);
    await sleep(400);
    await evaluate(ws, `(() => { const el = document.querySelector('.vocab-add-input'); if (!el) return false; (${nativeSet})(el, 'qn23word'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    // 生造词在线查询失败 → 预览卡出现「未找到在线释义」
    await waitFor(ws, `(() => { const el = document.querySelector('.vocab-lookup'); return !!el && el.textContent.includes('未找到在线释义'); })()`, 15000);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.vocab-lookup button')].find((x) => x.textContent === '手动填写释义'); b?.click(); return !!b; })()`);
    await sleep(300);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.vocab-lookup-actions button')].find((x) => x.textContent === '保存'); b?.click(); return !!b; })()`);
    await sleep(900);
    let vocab = existsSync(globalVocabFile) ? readFileSync(globalVocabFile, "utf8") : "";
    check(vocab.includes("- qn23word"), "面板输入加入单词 → 落盘账户级单词本", vocab);
    check(vocab.indexOf("## 待学习") < vocab.indexOf("- qn23word"), "新词落在待学习节");
    // 标记掌握：点条目 → 详情弹层 → 已掌握 → 关闭
    await evaluate(ws, `(() => { const item = Array.from(document.querySelectorAll('.vocab-item')).find((el) => el.textContent.includes('qn23word')); item?.click(); return !!item; })()`);
    await sleep(500);
    await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-detail-act')].find((b) => b.textContent === '已掌握')?.click(); return true; })()`);
    await sleep(900);
    vocab = readFileSync(globalVocabFile, "utf8");
    const doneIdx = vocab.indexOf("## 已掌握");
    const wordIdx = vocab.indexOf("- qn23word");
    check(wordIdx >= 0 && doneIdx >= 0 && wordIdx > doneIdx, "✓ 标记后移入已掌握节", vocab);
    await evaluate(ws, `(() => { document.querySelector('.vocab-detail-close')?.click(); return true; })()`);
    await sleep(400);
  }

  // 热键收词：选中词 Ctrl+Alt+V
  check(await openNoteByLabel("qn23字段.md"), "回到 qn23字段.md（热键收词）");
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    const doc = view.state.doc.toString();
    const at = doc.indexOf('user_name');
    view.dispatch({ selection: { anchor: at, head: at + 'user_name'.length } });
    view.focus();
    return at >= 0;
  })()`);
  await evaluate(
    ws,
    `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`,
  );
  await sleep(900);
  const vocab2 = existsSync(globalVocabFile) ? readFileSync(globalVocabFile, "utf8") : "";
  check(/- user_name — .* · qn23字段/.test(vocab2), "Ctrl+Alt+V 把选中的词收进单词本（带来源）", vocab2.split("\n").filter((l) => l.startsWith("- ")).join(" ; "));
  const status = await statusText(ws);
  check(/已加入单词本/.test(status), "状态栏提示已加入", status);

  // ---------------------------------------------- 10. 跨窗口设置热加载
  const child2 = spawnInstance();
  let ws2 = null;
  try {
    let page2 = null;
    for (let i = 0; i < 30 && !page2; i += 1) {
      await sleep(1000);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        const pages = list.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
        if (pages.length >= 2) page2 = pages[1];
      } catch {}
    }
    if (!page2) {
      check(false, "第二实例：未发现第二个页面目标");
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
      check(b2, "第二实例启动");
      const b2text = await cdp(ws2, "Runtime.evaluate", {
        expression: `document.body.textContent.slice(0, 4000)`,
        returnByValue: true,
      }).then((r) => r.result.value).catch(() => "");
      check(!b2text.includes("注册截图快捷键失败"), "第二实例热键让位不报错");
      const themeBefore = await cdp(ws2, "Runtime.evaluate", {
        expression: `document.documentElement.dataset.theme`,
        returnByValue: true,
      }).then((r) => r.result.value).catch(() => null);
      check(themeBefore === "dark", "第二实例初始深色主题", String(themeBefore));
      // 第一窗口直接写 localStorage（storage 事件只发给**其他**窗口）
      await evaluate(ws, `(() => {
        const raw = JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}');
        raw.theme = 'light';
        localStorage.setItem('quicknote.settings', JSON.stringify(raw));
        return true;
      })()`);
      await cdp(ws2, "Page.bringToFront").catch(() => {});
      // 两页都可能成为"写入者"（CDP 页面顺序不保证稳定）：只要除写入者之外的
      // 任一页面翻成 light 即算通过（写入者自己不收自己的 storage 事件）
      let themeAfter = null;
      for (let i = 0; i < 14 && themeAfter !== "light"; i += 1) {
        await sleep(700);
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
        const pagesNow = list.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
        for (const p of pagesNow) {
          try {
            const w = new WebSocket(p.webSocketDebuggerUrl);
            await new Promise((res, rej) => {
              w.addEventListener("open", res, { once: true });
              w.addEventListener("error", rej, { once: true });
            });
            themeAfter = (await cdp(w, "Runtime.evaluate", {
              expression: `document.documentElement.dataset.theme`,
              returnByValue: true,
            }).then((r) => r.result.value).catch(() => null)) ?? themeAfter;
            w.close();
            if (themeAfter === "light") break;
          } catch {}
        }
      }
      check(themeAfter === "light", "另一窗口改设置 → 本窗口即时生效（storage 热加载）", String(themeAfter));
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
    process.kill(child.pid);
  } catch {}
  await sleep(800);
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n0.23 批次验收全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

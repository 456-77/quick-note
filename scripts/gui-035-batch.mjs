// 0.33.0 批测（移动端界面优化全量）：桌面 gui-test 变体 + CDP 伪造 Android UA /
// 390×844 视口 / 触屏仿真——isMobile() 走 UA 分支，移动端媒体查询走 pointer:coarse
// 仿真（首个验证点）。自起实例（独立 UDF+临时仓库），结束时自清理。
//
// 覆盖：
// - 移动仿真三件套命中（媒体查询/UA 分支）
// - 批A：令牌/四级文字 --text-placeholder/卡片 16dp/:active
// - 批B：设置行 flex 三段式（开关/短控件同行、滑杆独占行、说明全宽）
// - 批B：仓库页 13 节规范（云端行/本地卡/状态标签/长名完整换行/图标不压缩）
// - 批C/D/E/F：编辑态分离、底栏变量化、文件树指示条、单词行两行、bgOpacity 移动默认 0.15
// - 停点1：侧栏近不透明（veil alpha>=0.9）
// - 停点2/3：空状态新建抽屉聚焦、设置两级头部（56px/‹ 返回/sticky top=0 从屏幕
//   最顶盖下来/面板无 env 顶距/滚动后贴顶、一级头 ‹ 与标题并排靠左）
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9465";
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

const screenshot = async (ws, file) => {
  const r = await cdp(ws, "Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  📷 ${file}`);
};

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36";

// ------------------------------------------------ 自备数据：临时仓库（长目录名验证省略）
const work = join(tmpdir(), `qn-mprev-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "一个特别长的仓库名称用来验证移动端省略号是否生效-2026").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });
for (const name of ["日记一.md", "笔记二.md"]) {
  writeFileSync(join(vault, name), `# ${name.replace(".md", "")}\n\n正文内容。\n`, "utf8");
}
// 1×1 PNG：背景图开启断言用（bgImagePath 指向仓库内相对路径）
writeFileSync(
  join(vault, "bg.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const child = spawn(exe, [vault], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: udf,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: "ignore",
  detached: false,
});

// 预写基础目录指针：vault_home_set_from_path 是 Android 专用命令（校验 / 开头），
// CDP 桌面模拟走不通；read_home 只做 is_dir 检查，直接写指针文件等效。
// gui-test 变体 identifier 独立，不碰正式版数据。
const configDir = join(process.env.APPDATA ?? "", "com.quicknote.gui-test");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "vault-home.txt"), work.replace(/\\/g, "/"), "utf8");

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

  // 移动仿真三件套 + 深色主题预置，然后整页重载让 React 以移动分支重新挂载
  await cdp(ws, "Network.setUserAgentOverride", { userAgent: ANDROID_UA });
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2.75,
    mobile: true,
  });
  await cdp(ws, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await evaluate(ws, `localStorage.setItem('quicknote.settings', JSON.stringify({ theme: 'dark' }))`);
  await cdp(ws, "Page.reload");

  const navOk = await waitFor(ws, `document.querySelectorAll('.mobile-nav button').length === 3`, 30000);
  check(navOk, "移动仿真生效：isMobile()=true 且底栏三键渲染");

  const mediaOk = await evaluate(
    ws,
    `matchMedia('(hover: none) and (pointer: coarse) and (max-width: 900px)').matches`,
  );
  check(mediaOk, "移动端媒体查询命中（pointer:coarse 仿真有效）");

  // 批D：骨架视觉——底栏 54px+选中背景块、顶栏 48px+右侧图标右对齐+编辑钮图标 16
  const skeleton = await evaluate(ws, `(() => {
    const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
    const topbar = document.querySelector('header.topbar').getBoundingClientRect();
    const lastIcon = [...document.querySelectorAll('header.topbar .topbar-end button')].filter((b) => b.getBoundingClientRect().width > 0).pop();
    const lastR = lastIcon ? lastIcon.getBoundingClientRect() : null;
    const editSvg = document.querySelector('header.topbar .mode-toggle svg');
    return {
      navH: Math.round(nav.height),
      topbarH: Math.round(topbar.height),
      lastIconRightGap: lastR ? Math.round(window.innerWidth - lastR.right) : -1,
      editIconSize: editSvg ? Math.round(editSvg.getBoundingClientRect().width) : 0,
    };
  })()`);
  check(skeleton.navH >= 54 && skeleton.navH <= 56, `批D：底栏高 ${skeleton.navH}px（54+安全区基准）`);
  check(skeleton.topbarH === 48, `批D：顶栏收敛为 48px（实际 ${skeleton.topbarH}）`);
  check(skeleton.lastIconRightGap >= 0 && skeleton.lastIconRightGap <= 16, `批D：顶栏图标组右对齐（末钮距右缘 ${skeleton.lastIconRightGap}px）`);
  check(skeleton.editIconSize === 16, `批D：编辑钮图标 16px 与顶栏图标统一（实际 ${skeleton.editIconSize}）`);
  await evaluate(ws, `document.querySelectorAll('.mobile-nav button')[0]?.click()`);
  await sleep(500);
  const navActive = await evaluate(ws, `(() => {
    const on = document.querySelector('.mobile-nav button.is-on');
    if (!on) return { found: false };
    const cs = getComputedStyle(on);
    return { found: true, bg: cs.backgroundColor, color: cs.color };
  })()`);
  check(navActive.found && navActive.bg !== "rgba(0, 0, 0, 0)", `批D：底栏选中态有背景块（${navActive.bg}）`);
  await evaluate(ws, `document.querySelectorAll('.mobile-nav button')[0]?.click()`);
  await sleep(400);

  // 停点3：空状态（仓库已开、没开笔记）编辑器禁编辑——裸空 state 曾可编辑，
  // 点正文聚焦出光标+软键盘（真机图2）；空状态点「+ 新建笔记」要开抽屉+输入行可见
  const emptyEditable = await evaluate(
    ws,
    `document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable')`,
  );
  check(emptyEditable === "false", `停点3：空状态编辑器禁编辑（contenteditable=${emptyEditable}，无光标/键盘）`);
  await evaluate(ws, `[...document.querySelectorAll('.editor-empty-actions .btn')].find((b) => b.textContent.includes('新建笔记'))?.click()`);
  await sleep(500);
  const createRow = await evaluate(ws, `(() => {
    const s = document.querySelector('aside.sidebar-left');
    const input = document.querySelector('.create-row input');
    return {
      drawerOpen: s ? getComputedStyle(s).transform === 'none' : false,
      createRow: !!input,
      focused: !!input && document.activeElement === input,
    };
  })()`);
  check(createRow.drawerOpen, `停点3：空状态点「新建笔记」自动展开文件抽屉（${JSON.stringify(createRow)}）`);
  check(createRow.createRow && createRow.focused, "停点3：标题输入行出现并聚焦");
  await evaluate(ws, `[...document.querySelectorAll('.create-row button')].find((b) => b.textContent.includes('取消'))?.click()`);
  await sleep(300);

  const treeOk = await waitFor(ws, `document.querySelectorAll('.tree-item').length >= 2`, 20000);
  check(treeOk, "临时仓库已打开（文件树渲染）");

  // ------------------------------------------------ 批C：阅读/编辑分离
  await evaluate(
    ws,
    `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.offsetParent !== null); t?.click(); return !!t; })()`,
  );
  const cmOk = await waitFor(ws, `!!document.querySelector('.editor-host .cm-content')`, 10000);
  check(cmOk, "批C：已打开笔记（编辑器渲染）");
  if (cmOk) {
    await sleep(600);
    const reading = await evaluate(ws, `(() => ({
      editable: document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable'),
      zen: document.body.classList.contains('m-zen'),
      editing: document.body.classList.contains('m-editing'),
      editBtn: [...document.querySelectorAll('header.topbar .mode-toggle')].some((b) => (b.title || '').includes('编辑这篇笔记')),
    }))()`);
    check(reading.editable === "false", `批C：阅读态默认禁编辑（contenteditable=${reading.editable}）`);
    check(!reading.zen && !reading.editing, "批C：打开笔记默认阅读态、上下栏可见");
    check(reading.editBtn, "批C：顶栏视图模式钮已换成「编辑」钮");

    const treeActive = await evaluate(ws, `(() => {
      const row = document.querySelector('.tree-file.is-active');
      if (!row) return { found: false };
      return { found: true, shadow: getComputedStyle(row).boxShadow };
    })()`);
    check(treeActive.found && treeActive.shadow !== "none", "批E：选中文件行左侧指示条（inset box-shadow）");

    // 编辑态：点编辑钮 → 解禁 + 聚焦 + 工具栏
    await evaluate(ws, `document.querySelector('header.topbar .mode-toggle')?.click()`);
    await sleep(400);
    const editing = await evaluate(ws, `(() => ({
      editable: document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable'),
      editing: document.body.classList.contains('m-editing'),
      toolbarVisible: (() => { const t = document.querySelector('.mobile-md-toolbar'); if (!t) return false; return getComputedStyle(t).display !== "none" && t.getBoundingClientRect().height > 0; })(),
      focused: document.activeElement?.classList.contains('cm-content') ?? false,
      doneBtn: !!document.querySelector('.mobile-md-done'),
    }))()`);
    check(editing.editing && editing.editable === "true", "批C：编辑钮 → 解禁编辑 + m-editing");
    check(editing.toolbarVisible && editing.doneBtn, "批C：编辑态 Markdown 工具栏显示（含 ✓ 完成钮）");
    check(editing.focused, "批C：编辑态聚焦编辑器（软键盘弹出路径）");

    // 停点2 反馈：再点一次编辑钮 = 退出编辑态（不再只认工具栏 ✓）
    await evaluate(ws, `document.querySelector('header.topbar .mode-toggle')?.click()`);
    await sleep(300);
    const toggled = await evaluate(ws, `(() => ({
      editing: document.body.classList.contains('m-editing'),
      editable: document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable'),
    }))()`);
    check(!toggled.editing && toggled.editable === "false", "批C：编辑钮再点一次可退出（toggle）");
    // 回到编辑态，让后续「工具栏 ✓ 完成」断言继续覆盖第二条退出路径
    await evaluate(ws, `document.querySelector('header.topbar .mode-toggle')?.click()`);
    await sleep(300);

    // 完成：回阅读态
    await evaluate(ws, `document.querySelector('.mobile-md-done')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await sleep(300);
    const done = await evaluate(ws, `(() => ({
      editable: document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable'),
      editing: document.body.classList.contains('m-editing'),
    }))()`);
    check(!done.editing && done.editable === "false", "批C：✓ 完成 → 回阅读态（重新禁编辑）");

    // 回归（模拟器实测抓出）：完成后「再点同一篇笔记」走 activateTab 命令式
    // 重装载，activeTab 不变、重配 effect 不跑——缓存若残留编辑态版本会把
    // editable=true 带回来。exitMobileEdit 已回写缓存，这里验证
    await evaluate(
      ws,
      `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.offsetParent !== null); t?.click(); return !!t; })()`,
    );
    await sleep(800);
    const reloadSame = await evaluate(
      ws,
      `document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable')`,
    );
    check(reloadSame === "false", `批C：完成后重开同一篇仍禁编辑（contenteditable=${reloadSame}）`);

    // 沉浸：点正文 → 上下栏滑出；热区唤回
    await evaluate(ws, `document.querySelector('.editor-host')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await sleep(500);
    const zen = await evaluate(ws, `(() => ({
      zen: document.body.classList.contains('m-zen'),
      topbarH: Math.round(document.querySelector('header.topbar')?.getBoundingClientRect().height ?? -1),
      navTransform: getComputedStyle(document.querySelector('.mobile-nav')).transform,
      peek: !!document.querySelector('.m-zen-peek'),
    }))()`);
    check(zen.zen, "批C：阅读态点正文 → 沉浸（body.m-zen）");
    check(zen.topbarH <= 2, `批C：沉浸时顶栏收起（高 ${zen.topbarH}px）`);
    check(zen.navTransform !== "none", "批C：沉浸时底栏滑出");
    check(zen.peek, "批C：沉浸时顶部唤回热区出现");
    await evaluate(ws, `document.querySelector('.m-zen-peek')?.click()`);
    await sleep(500);
    const restored = await evaluate(ws, `(() => ({
      zen: document.body.classList.contains('m-zen'),
      topbarH: Math.round(document.querySelector('header.topbar')?.getBoundingClientRect().height ?? -1),
    }))()`);
    check(!restored.zen && restored.topbarH >= 40, "批C：热区点击 → 上下栏唤回");
  }

  // 字号缩放：localStorage 直写 + reload（铁律），重开笔记后量 .cm-content
  await evaluate(
    ws,
    `(() => { const cur = JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}'); cur.mobileFontScale = 1.3; localStorage.setItem('quicknote.settings', JSON.stringify(cur)); location.reload(); return true; })()`,
  );
  await cdp(ws, "Network.setUserAgentOverride", { userAgent: ANDROID_UA });
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2.75,
    mobile: true,
  });
  await cdp(ws, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await waitFor(ws, `document.querySelectorAll('.tree-item').length >= 2`, 30000);
  await evaluate(
    ws,
    `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.offsetParent !== null); t?.click(); return !!t; })()`,
  );
  const cmOk2 = await waitFor(ws, `!!document.querySelector('.editor-host .cm-content')`, 10000);
  if (cmOk2) {
    await sleep(600);
    const font = await evaluate(
      ws,
      `parseFloat(getComputedStyle(document.querySelector('.editor-host .cm-content')).fontSize)`,
    );
    check(font >= 20, `批C：字号缩放 130% 生效（.cm-content=${font}px，基准 16）`);
  }
  // 字号设置复位，避免影响后续轮次
  await evaluate(
    ws,
    `(() => { const cur = JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}'); cur.mobileFontScale = 1; localStorage.setItem('quicknote.settings', JSON.stringify(cur)); return true; })()`,
  );

  const glow = await evaluate(
    ws,
    `getComputedStyle(document.querySelector('header.topbar')).backgroundImage.includes('rgba(0, 0, 0, 0)') || getComputedStyle(document.querySelector('header.topbar')).backgroundImage === 'none' || getComputedStyle(document.documentElement).getPropertyValue('--bg-glow').trim() === 'transparent'`,
  );
  check(glow, "批A：移动端顶栏晕染已撤除（--bg-glow=transparent）");

  await screenshot(ws, join(work, "01-main-dark.png"));

  // ------------------------------------------------ 设置：外观分区（批B 三段式）
  await evaluate(
    ws,
    `(() => { const b = [...document.querySelectorAll('header.topbar button.icon-btn')].find((el) => el.offsetParent !== null); b?.click(); return !!b; })()`,
  );
  const paletteOk = await waitFor(ws, `!!document.querySelector('.palette-overlay')`, 8000);
  check(paletteOk, "命令面板打开（顶栏搜索钮）");
  await evaluate(
    ws,
    `(() => { const it = [...document.querySelectorAll('.palette-item')].find((el) => el.textContent.includes('打开设置')); it?.click(); return !!it; })()`,
  );
  const settingsOk = await waitFor(ws, `!!document.querySelector('.settings-panel')`, 8000);
  check(settingsOk, "设置面板打开（palette → 打开设置）");
  // 程序点击不受遮挡影响，palette 开着也不拦后续点击；不用 Esc（可能误伤设置面板）
  await sleep(300);
  await evaluate(
    ws,
    `(() => { const n = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('外观')); n?.click(); return !!n; })()`,
  );
  const rowsOk = await waitFor(ws, `document.querySelectorAll('.settings-panel .settings-row').length >= 3`, 8000);
  check(rowsOk, "设置外观分区已进入（行渲染）");

  // 停点3：两级头部统一（一级/二级同高 56px、二级头 ‹ 图标返回、无 ×）
  const heads = await evaluate(ws, `(() => {
    const navHead = document.querySelector('.settings-nav-head');
    const detailHead = document.querySelector('.settings-mobile-head');
    const back = detailHead?.querySelector('.settings-back svg');
    return {
      navHeadH: navHead ? Math.round(navHead.getBoundingClientRect().height) : 0,
      detailHeadH: detailHead ? Math.round(detailHead.getBoundingClientRect().height) : 0,
      detailPos: detailHead ? getComputedStyle(detailHead).position : "",
      detailTop: detailHead ? getComputedStyle(detailHead).top : "",
      panelPadTop: getComputedStyle(document.querySelector('.settings-panel')).paddingTop,
      hasBackIcon: !!back,
      hasCloseInDetail: !!detailHead?.querySelector('.settings-close'),
    };
  })()`);
  check(
    Math.abs(heads.detailHeadH - 56) <= 2,
    `停点3：二级头高 ${heads.detailHeadH}px（统一 56）`,
  );
  check(heads.hasBackIcon && !heads.hasCloseInDetail, "停点3：二级头 = ‹ 图标返回、无 ×（关闭只留一级头）");
  check(heads.detailPos === "sticky", `停点3：二级头固定顶部（position=${heads.detailPos}）`);
  // 0.33.0 用户反馈：sticky top 不得叠 env(safe-area-inset-top)——面板 padding 已把
  // 滚动视口顶边压到安全区下方，再叠一次 = 头部上方留出等高空隙、滚动内容透出。
  // 模拟环境 env() 恒 0 区分不了新旧值，此断言是防回归的源码级护栏。
  check(heads.detailTop === "0px", `停点3：二级头 sticky top=0（不叠安全区，防滚透空隙，实际 ${heads.detailTop}）`);
  // 0.33.0 停点3 第四轮：面板不再自带 env 顶距——状态栏条改由二级头自己的
  // padding 承担（头部从屏幕最顶盖下来），面板顶距会让头部上方永远留缝
  check(heads.panelPadTop === "0px", `停点3：面板无 env 顶距（实际 ${heads.panelPadTop}）`);
  // 0.33.0 停点3 第四轮：滚动后二级头必须贴屏幕最顶——body 自己的 padding-top
  // 会把 sticky 包含块顶边压下去，头部最多吸到 padding 之内、顶部留一条缝
  const stickTop = await evaluate(ws, `(() => {
    const body = document.querySelector('.settings-body');
    body.scrollTop = 300;
    return new Promise((res) => requestAnimationFrame(() => {
      const t = document.querySelector('.settings-mobile-head').getBoundingClientRect().top;
      body.scrollTop = 0;
      res(Math.round(t));
    }));
  })()`);
  check(stickTop === 0, `停点3：二级头滚动后贴屏幕最顶（实际 ${stickTop}px；被 body padding 阻挡时为 12）`);
  // 返回一级，量一级头并复原状态供后续流程
  await evaluate(ws, `document.querySelector('.settings-back')?.click()`);
  await sleep(400);
  const listHead = await evaluate(ws, `(() => {
    const h = document.querySelector('.settings-nav-head')?.getBoundingClientRect().height ?? 0;
    const pad = parseFloat(getComputedStyle(document.querySelector('.settings-nav')).paddingTop) || 0;
    const close = document.querySelector('.settings-nav-head .settings-close')?.getBoundingClientRect();
    const title = document.querySelector('.settings-nav-title')?.getBoundingClientRect();
    return {
      h: Math.round(h + pad),
      closeLeftOfTitle: close && title ? close.left < title.left : false,
      // 0.33.0 用户反馈：‹ 与标题必须**并排靠左**（space-between 会分家成两端）
      adjacentGap: close && title ? Math.round(title.left - close.right) : -1,
    };
  })()`);
  check(Math.abs(listHead.h - heads.detailHeadH) <= 6, `停点3：一级头与二级头同高（一级 ${listHead.h} / 二级 ${heads.detailHeadH}）`);
  check(listHead.closeLeftOfTitle, "停点3：一级头 ‹ 关闭钮在标题左侧（返回箭头的习惯位置）");
  check(
    listHead.adjacentGap >= -8 && listHead.adjacentGap <= 24,
    `停点3：一级头 ‹ 与标题并排靠左（间距 ${listHead.adjacentGap}px，space-between 分家时 >100px）`,
  );
  // 回到外观详情，衔接原有断言
  await evaluate(
    ws,
    `(() => { const n = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('外观')); n?.click(); return !!n; })()`,
  );
  await waitFor(ws, `document.querySelectorAll('.settings-panel .settings-row').length >= 3`, 8000);

  // 断言：settings-row 已从 grid 覆盖为 flex
  const rowDisplay = await evaluate(
    ws,
    `getComputedStyle(document.querySelector('.settings-panel .settings-row')).display`,
  );
  check(rowDisplay === "flex", `批B：设置行 display=${rowDisplay}（期望 flex，grid 覆盖生效）`);

  // 断言：含开关的行 = 标签与开关同行、说明在下方、标签不被压成竖列
  const switchRow = await evaluate(ws, `(() => {
    const row = [...document.querySelectorAll('.settings-panel .settings-row')]
      .find((r) => r.querySelector('input[type="checkbox"]') && r.textContent.includes('背景'));
    if (!row) return { found: false };
    const label = row.querySelector(':scope > span:first-child');
    const box = row.querySelector('input[type="checkbox"]');
    const desc = row.querySelector(':scope > .settings-row-desc');
    const lr = label.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    return {
      found: true,
      sameRow: Math.abs((lr.top + lr.height / 2) - (br.top + br.height / 2)) < 12,
      labelWidth: lr.width,
      descBelow: !desc || desc.getBoundingClientRect().top >= lr.bottom - 2,
      text: label.textContent,
    };
  })()`);
  check(switchRow.found, "找到含背景开关的设置行", JSON.stringify(switchRow));
  if (switchRow.found) {
    check(switchRow.sameRow, `批B：开关与标题同行（${switchRow.text}）`);
    check(switchRow.labelWidth > 80, `批B：标题未被压成竖列（宽 ${Math.round(switchRow.labelWidth)}px）`);
    check(switchRow.descBelow, "批B：说明文字位于标题下方全宽行");
  }

  // 断言：滑杆行 = 滑杆独占一行（top 大于标题 top）
  const sliderRow = await evaluate(ws, `(() => {
    const row = [...document.querySelectorAll('.settings-panel .settings-row')]
      .find((r) => r.querySelector('.settings-slider'));
    if (!row) return { found: false };
    const label = row.querySelector(':scope > span:first-child');
    const slider = row.querySelector('.settings-slider');
    return {
      found: true,
      labelTop: label.getBoundingClientRect().top,
      sliderTop: slider.getBoundingClientRect().top,
      sliderWidth: slider.getBoundingClientRect().width,
    };
  })()`);
  check(sliderRow.found, "找到滑杆行");
  if (sliderRow.found) {
    check(sliderRow.sliderTop > sliderRow.labelTop + 4, "批B：滑杆独占一行（不与标题同行挤压）");
    check(sliderRow.sliderWidth > 300, `批B：滑杆撑满行宽（${Math.round(sliderRow.sliderWidth)}px）`);
  }

  await screenshot(ws, join(work, "02-settings-appearance-dark.png"));

  // ------------------------------------------------ 仓库页（批B 头部两行 + 云端行注入验证）
  // 基础目录指针已在 spawn 前预写；浮层 gate 是新 mount 实例，mount 时即读到列表形态
  await evaluate(ws, `(() => { const x = [...document.querySelectorAll('.settings-panel button')].find((b) => b.offsetParent && (b.textContent.trim() === '×' || b.textContent.includes('关闭'))); x?.click(); return true; })()`);
  await sleep(400);
  await evaluate(ws, `document.querySelector('header.topbar .vault-pill')?.click()`);
  const gateOk = await waitFor(ws, `!!document.querySelector('.mv-overlay .mv-gate-head')`, 8000);
  check(gateOk, "仓库页打开且为列表形态（vault-pill 直达）");

  const headLayout = await evaluate(ws, `(() => {
    const title = document.querySelector('.mv-overlay .mv-gate-title');
    const home = document.querySelector('.mv-overlay .mv-home');
    if (!title || !home) return { found: false };
    const tr = title.getBoundingClientRect();
    const hr = home.getBoundingClientRect();
    return { found: true, homeBelow: hr.top >= tr.bottom - 2, homeWidth: hr.width };
  })()`);
  check(headLayout.found && headLayout.homeBelow, "批B：仓库页头部两行（标题行 + 路径行）");

  // 注入假云端行：验证 flex 布局下按钮固定宽不重叠、长名单行省略、图标不被压小
  const cloudRow = await evaluate(ws, `(() => {
    const gate = document.querySelector('.mv-overlay .mv-gate');
    if (!gate) return { found: false };
    const row = document.createElement('div');
    row.className = 'mv-cloud-row';
    row.innerHTML =
      '<div class="mv-cloud-main"><span class="mv-cloud-name"><svg width="16" height="16"></svg><span class="mv-cloud-name-text">' +
      'very-long-cloud-vault-name-' + 'o'.repeat(120) + '</span></span>' +
      '<span class="mv-cloud-meta"><i class="mv-dot is-cloud"></i>云端版本 33</span></div>' +
      '<button type="button" class="btn mv-cloud-btn">拉取</button>';
    gate.appendChild(row);
    const main = row.querySelector('.mv-cloud-main').getBoundingClientRect();
    const btn = row.querySelector('.mv-cloud-btn').getBoundingClientRect();
    const nameEl = row.querySelector('.mv-cloud-name-text');
    const icon = row.querySelector('.mv-cloud-name > svg').getBoundingClientRect();
    return {
      found: true,
      noOverlap: btn.left >= main.right - 1,
      btnWidth: btn.width,
      btnHeight: btn.height,
      iconWidth: icon.width,
      // 0.33.0 停点1 第四轮：完整换行显示——无水平溢出（不截断），允许多行
      nameNoClip: nameEl.scrollWidth <= nameEl.clientWidth + 1,
      nameMultilineOk: nameEl.clientHeight > 10,
    };
  })()`);
  check(cloudRow.found, "云端行注入成功");
  if (cloudRow.found) {
    check(cloudRow.noOverlap, "云端行按钮与文字不重叠");
    check(Math.abs(cloudRow.btnWidth - 84) < 3, `拉取钮固定宽（${Math.round(cloudRow.btnWidth)}px）`);
    check(cloudRow.btnHeight >= 44, `拉取钮触控 ≥44dp（${Math.round(cloudRow.btnHeight)}px）`);
    check(cloudRow.nameNoClip, "云端仓库名完整换行显示（不截断）");
    check(cloudRow.iconWidth >= 15, `长名下图标不被压小（${cloudRow.iconWidth}px）`);
  }

  // 停点1 第四轮：名称完整换行 + 状态标签并入 meta 行右对齐
  const cardCheck = await evaluate(ws, `(() => {
    const list = document.querySelector('.mv-overlay .mv-list');
    if (!list) return { found: false };
    const card = document.createElement('button');
    card.className = 'mv-card';
    card.innerHTML =
      '<span class="mv-card-name"><svg width="16" height="16"></svg><span class="mv-card-name-text">' + 'x'.repeat(160) + '</span></span>' +
      '<div class="mv-card-meta"><span class="mv-card-meta-text">14 篇 · 今天编辑过</span><span class="mv-state"><i class="mv-dot is-sync"></i>同步开启</span></div>';
    list.appendChild(card);
    const nameEl = card.querySelector('.mv-card-name-text');
    const state = card.querySelector('.mv-state').getBoundingClientRect();
    const metaText = card.querySelector('.mv-card-meta-text').getBoundingClientRect();
    const icon = card.querySelector('.mv-card-name > svg').getBoundingClientRect();
    const cardR = card.getBoundingClientRect();
    return {
      found: true,
      stateSameRow: Math.abs((state.top + state.height / 2) - (metaText.top + metaText.height / 2)) < 10,
      // 0.33.0 停点1 第五轮：必须贴卡片右缘（button 的 UA align-items:flex-start
      // 曾让 meta 行收缩、状态悬在中间——此前断言拿视口坐标比卡片半宽，假通过）
      stateAtRightEdge: state.right >= cardR.right - 18,
      stateInsideCard: state.right <= cardR.right - 8,
      nameNoClip: nameEl.scrollWidth <= nameEl.clientWidth + 1,
      iconWidth: icon.width,
    };
  })()`);
  check(cardCheck.found, "本地卡注入成功");
  if (cardCheck.found) {
    check(cardCheck.stateSameRow, "状态标签与 meta 同行（停点1 第四轮）");
    check(cardCheck.stateAtRightEdge && cardCheck.stateInsideCard, "状态标签贴卡片右缘对齐（停点1 第五轮）");
    check(cardCheck.nameNoClip, "本地卡仓库名完整换行显示（不截断）");
    check(cardCheck.iconWidth >= 15, `长名下图标不缩小（${cardCheck.iconWidth}px）`);
  }

  await screenshot(ws, join(work, "03-vault-dark.png"));

  // ------------------------------------------------ 浅色主题一轮（批A 四级文字/批B 布局在浅色下复查）
  await evaluate(ws, `localStorage.setItem('quicknote.settings', JSON.stringify({ theme: 'light' }))`);
  await cdp(ws, "Page.reload");
  // reload 不保证仿真 override 全部存活，三件套重打一遍（幂等）
  await cdp(ws, "Network.setUserAgentOverride", { userAgent: ANDROID_UA });
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2.75,
    mobile: true,
  });
  await cdp(ws, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await waitFor(ws, `document.querySelectorAll('.mobile-nav button').length === 3`, 30000);
  const lightThemeState = await evaluate(
    ws,
    `({ theme: document.documentElement.dataset.theme, ph: getComputedStyle(document.documentElement).getPropertyValue('--text-placeholder').trim(), media: matchMedia('(hover: none) and (pointer: coarse) and (max-width: 900px)').matches })`,
  );
  check(lightThemeState.theme === "light", `浅色主题生效（data-theme=${lightThemeState.theme}）`);
  check(
    lightThemeState.media && lightThemeState.ph !== "",
    `批A：浅色下 --text-placeholder 有值（${lightThemeState.ph}；媒体=${lightThemeState.media}）`,
  );
  // 再开一次设置截图
  await evaluate(
    ws,
    `(() => { const b = [...document.querySelectorAll('header.topbar button.icon-btn')].find((el) => el.offsetParent !== null); b?.click(); return !!b; })()`,
  );
  await waitFor(ws, `!!document.querySelector('.palette-overlay')`, 8000);
  await evaluate(
    ws,
    `(() => { const it = [...document.querySelectorAll('.palette-item')].find((el) => el.textContent.includes('打开设置')); it?.click(); return !!it; })()`,
  );
  const lightSettingsOk = await waitFor(ws, `!!document.querySelector('.settings-panel')`, 8000);
  await sleep(300);
  await evaluate(
    ws,
    `(() => { const n = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('外观')); n?.click(); return !!n; })()`,
  );
  const lightRowsOk = await waitFor(ws, `document.querySelectorAll('.settings-panel .settings-row').length >= 3`, 8000);
  check(lightSettingsOk && lightRowsOk, "浅色下设置面板可正常进入外观分区");
  if (lightRowsOk) {
    const lightRow = await evaluate(ws, `getComputedStyle(document.querySelector('.settings-panel .settings-row')).display`);
    check(lightRow === "flex", "批B：浅色下设置行同为 flex 三段式");
    await screenshot(ws, join(work, "04-settings-light.png"));
  }

  // ------------------------------------------------ 背景图开启：移动端侧栏近不透明（停点1 反馈透字）
  // localStorage 直写扁平 bg 字段后必须整页 reload（铁律）；bg.png 已在数据段写入仓库
  await evaluate(ws, `(() => {
    const cur = JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}');
    localStorage.setItem('quicknote.settings', JSON.stringify({ ...cur, bgEnabled: true, bgImagePath: 'bg.png' }));
    location.reload();
  })()`);
  await cdp(ws, "Network.setUserAgentOverride", { userAgent: ANDROID_UA });
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2.75,
    mobile: true,
  });
  await cdp(ws, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await waitFor(ws, `document.querySelectorAll('.mobile-nav button').length === 3`, 30000);
  const bgOn = await waitFor(ws, `document.documentElement.classList.contains('qn-bg-on')`, 10000);
  check(bgOn, "背景图开启（qn-bg-on）");
  if (bgOn) {
    const veilCheck = await evaluate(ws, `(() => {
      const side = document.querySelector('aside.sidebar-left');
      const bgc = side ? getComputedStyle(side).backgroundColor : '';
      const m = bgc.match(/rgba?\\(([^)]+)\\)/);
      const alpha = m ? parseFloat(m[1].split(',')[3] ?? '1') : 1;
      const layerOpacity = document.getElementById('qn-bg-layer')?.style.opacity ?? '';
      return { bgc, alpha, layerOpacity };
    })()`);
    check(
      veilCheck.alpha >= 0.9,
      `停点1修复：背景图下移动端侧栏近不透明（alpha=${veilCheck.alpha}，桌面基准 0.66 是透字根因）`,
    );
    check(
      veilCheck.layerOpacity === "0.15",
      `批F：移动端新仓库默认背景不透明度 15%（实际 ${veilCheck.layerOpacity}，桌面默认 0.35）`,
    );
    await screenshot(ws, join(work, "05-bg-veil.png"));
  }

  if (failures === 0) {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {}
  } else {
    console.log(`\n截图留查：${work}`);
  }
  console.log(failures === 0 ? "全部通过 ✓" : `${failures} 项失败 ✗`);
} catch (error) {
  failures += 1;
  console.error(`批测异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    if (ws) await cdp(ws, "Browser.close").catch(() => {});
  } catch {}
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(800);
}
process.exit(failures === 0 ? 0 : 1);

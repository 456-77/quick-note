// 0.33.0 批测（移动端界面优化全量）：桌面 gui-test 变体 + CDP 伪造 Android UA /
// 390×844 视口 / 触屏仿真——isMobile() 走 UA 分支，移动端媒体查询走 pointer:coarse
// 仿真（首个验证点）。自起实例（独立 UDF+临时仓库），结束时自清理。
//
// 覆盖：
// - 移动仿真三件套命中（媒体查询/UA 分支）
// - 0.34.0 Obsidian 化壳层：无常驻顶栏/底导航、顶部两颗药丸、底条六键（‹›🔍＋[N]☰）、
//   ☰ 动作菜单 sheet、[N] 标签页 sheet、导航历史 ‹›、左抽屉分区化（文件/搜索/标签/
//   单词本/日历+动作行+分区卡+仓库底行）、仓库 radio sheet→管理仓库、边缘滑动开抽屉、
//   右抽屉只留目录/统计、沉浸滑出浮动件、主页品牌块（图5）
// - 批A：令牌/四级文字 --text-placeholder/卡片 16dp/:active
// - 批B：设置行 flex 三段式（开关/短控件同行、滑杆独占行、说明全宽）
// - 批B：仓库页 13 节规范（云端行/本地卡/状态标签/长名完整换行/图标不压缩）
// - 批C/D/E/F：编辑态分离、文件树指示条、单词行两行、bgOpacity 移动默认 0.15
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

  const shellOk = await waitFor(
    ws,
    `document.querySelectorAll('.m-bottom-bar button').length === 6 && document.querySelectorAll('.m-top-pills .m-pill').length === 3`,
    30000,
  );
  check(shellOk, "移动仿真生效：isMobile()=true 且 0.34.0 Obsidian 化壳层渲染（顶药丸+底条六键）");

  const mediaOk = await evaluate(
    ws,
    `matchMedia('(hover: none) and (pointer: coarse) and (max-width: 900px)').matches`,
  );
  check(mediaOk, "移动端媒体查询命中（pointer:coarse 仿真有效）");

  // 0.34.0 骨架：顶栏/底部导航退场；顶药丸（抽屉键 + 编辑/⋮组）；底条六键
  const skeleton = await evaluate(ws, `(() => {
    const topbar = document.querySelector('header.topbar');
    const nav = document.querySelector('.mobile-nav');
    const pills = document.querySelector('.m-top-pills');
    const bar = document.querySelector('.m-bottom-bar');
    const barBtns = bar ? [...bar.querySelectorAll('button')] : [];
    const pillH = barBtns[0] ? Math.round(barBtns[0].getBoundingClientRect().height) : 0;
    const tabcount = bar?.querySelector('.m-tabcount')?.textContent.trim() ?? '';
    return {
      topbarGone: !topbar,
      navGone: !nav,
      pillsOk: !!pills && pills.querySelectorAll('.m-pill').length === 3,
      barCount: barBtns.length,
      pillH,
      tabcount,
    };
  })()`);
  check(skeleton.topbarGone, "0.34.0：移动端无常驻顶栏（浮动药丸替代）");
  check(skeleton.navGone, "0.34.0：底部导航退场");
  check(skeleton.pillsOk, "0.34.0：顶部药丸三键（抽屉 + 编辑toggle + ⋮）渲染");
  check(skeleton.barCount === 6, `0.34.0：底条六键 ‹›🔍＋[N]☰（实际 ${skeleton.barCount}）`);
  check(skeleton.pillH >= 42, `0.34.0：药丸触控高度 ${skeleton.pillH}px（≥42）`);
  check(skeleton.tabcount === "0", "0.34.0：[N] 标签数徽标初始 0");

  // 抽屉开合：左上药丸 → is-on + transform none；分区卡/动作行/仓库底行齐全
  await evaluate(ws, `document.querySelector('.m-top-pills .m-pill')?.click()`);
  await sleep(500);
  const drawerOn = await evaluate(ws, `(() => {
    const pill = document.querySelector('.m-top-pills .m-pill');
    const side = document.querySelector('aside.sidebar-left');
    return {
      on: pill?.classList.contains('is-on') ?? false,
      open: side ? getComputedStyle(side).transform === 'none' : false,
      sections: document.querySelectorAll('.m-drawer-section').length,
      actions: document.querySelectorAll('.m-drawer-actions button').length,
      vaultName: document.querySelector('.m-drawer-vault-name')?.textContent ?? '',
      gear: !!document.querySelector('.m-drawer-gear'),
    };
  })()`);
  check(drawerOn.on && drawerOn.open, "0.34.0：左上药丸开抽屉（is-on + transform none）");
  check(drawerOn.sections === 1, `0.34.1：分区卡默认收起成胶囊（实际 ${drawerOn.sections} 行）`);
  // 0.34.1：动作行只属于文件列表分区且只有两键（✕ 已删，全屏抽屉走返回键关闭）
  check(drawerOn.actions === 2, `0.34.1：动作行两键（新建笔记/文件夹，实际 ${drawerOn.actions}）`);
  const fullWidth = await evaluate(ws, `Math.round(document.querySelector('aside.sidebar-left').getBoundingClientRect().width)`);
  check(Math.abs(fullWidth - 390) <= 2, `0.34.1：抽屉全屏（宽 ${fullWidth}px ≈ 视口 390）`);
  // 非文件分区不显示动作行
  await evaluate(ws, `document.querySelector('.m-drawer-section-collapsed')?.click()`);
  await sleep(300);
  await evaluate(ws, `(() => { [...document.querySelectorAll('.m-drawer-section')].find((b) => b.textContent.includes('标签'))?.click(); return true; })()`);
  await sleep(400);
  const noActions = await evaluate(ws, `!!document.querySelector('.m-drawer-actions')`);
  check(!noActions, "0.34.1：非文件分区无动作行");
  // 回到文件列表分区
  await evaluate(ws, `document.querySelector('.m-drawer-section-collapsed')?.click()`);
  await sleep(300);
  await evaluate(ws, `(() => { [...document.querySelectorAll('.m-drawer-section')].find((b) => b.textContent.includes('文件列表'))?.click(); return true; })()`);
  await sleep(400);
  check(drawerOn.vaultName.includes("2026"), `0.34.0：抽屉底行显示仓库名（${drawerOn.vaultName}）`);
  check(drawerOn.gear, "0.34.0：抽屉齿轮钮存在");
  // 展开分区卡 → 五行；切换后收回胶囊（0.34.1 用户反馈：默认收起，点击展开）
  await evaluate(ws, `document.querySelector('.m-drawer-section-collapsed')?.click()`);
  await sleep(400);
  const expanded = await evaluate(ws, `document.querySelectorAll('.m-drawer-section').length`);
  check(expanded === 5, `0.34.1：分区胶囊点击展开五行（实际 ${expanded}）`);
  await evaluate(ws, `(() => { [...document.querySelectorAll('.m-drawer-section')].find((b) => b.textContent.includes('搜索'))?.click(); return true; })()`);
  await sleep(400);
  const recollapsed = await evaluate(ws, `(() => ({
    count: document.querySelectorAll('.m-drawer-section').length,
    onLabel: document.querySelector('.m-drawer-section-collapsed')?.textContent.trim() ?? '',
  }))()`);
  check(
    recollapsed.count === 1 && recollapsed.onLabel.includes("搜索"),
    `0.34.1：选中分区后收回胶囊并显示当前分区（${recollapsed.onLabel}）`,
  );
  // 回到文件列表分区（后续树操作依赖）
  await evaluate(ws, `document.querySelector('.m-drawer-section-collapsed')?.click()`);
  await sleep(300);
  await evaluate(ws, `(() => { [...document.querySelectorAll('.m-drawer-section')].find((b) => b.textContent.includes('文件列表'))?.click(); return true; })()`);
  await sleep(400);
  const floatGone = await evaluate(ws, `(() => ({
    cls: document.querySelector('.app')?.classList.contains('m-drawer-open') ?? false,
    pillsOpacity: getComputedStyle(document.querySelector('.m-top-pills')).opacity,
  }))()`);
  check(
    floatGone.cls && floatGone.pillsOpacity === "0",
    "0.34.0：抽屉打开时浮动药丸/底条让位（m-drawer-open，不叠在页签/仓库行上）",
  );
  await evaluate(ws, `document.querySelector('.m-top-pills .m-pill')?.click()`);
  await sleep(400);

  // 0.34.1 空状态：编辑钮与当前笔记菜单钮都禁用（没打开文件不能进编辑态）
  const emptyPills = await evaluate(ws, `(() => {
    const pills = [...document.querySelectorAll('.m-top-pills .m-pill')];
    return {
      editDisabled: pills.find((b) => (b.title || '').includes('编辑'))?.disabled ?? null,
      dotsDisabled: pills.find((b) => (b.title || '') === '当前笔记操作')?.disabled ?? null,
      toolbar: (() => { const t = document.querySelector('.mobile-md-toolbar'); return t ? getComputedStyle(t).display : 'absent'; })(),
    };
  })()`);
  check(
    emptyPills.editDisabled && emptyPills.dotsDisabled && (emptyPills.toolbar === "none" || emptyPills.toolbar === "absent"),
    `0.34.1：空状态编辑/笔记菜单钮禁用、工具栏不出现（${JSON.stringify(emptyPills)}）`,
  );

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
      editBtn: [...document.querySelectorAll('.m-top-pills .m-pill')].some((b) => (b.title || '').includes('编辑这篇笔记')),
    }))()`);
    check(reading.editable === "false", `批C：阅读态默认禁编辑（contenteditable=${reading.editable}）`);
    check(!reading.zen && !reading.editing, "批C：打开笔记默认阅读态、上下栏可见");
    check(reading.editBtn, "批C：右上药丸的「编辑」钮存在");

    const treeActive = await evaluate(ws, `(() => {
      const row = document.querySelector('.tree-file.is-active');
      if (!row) return { found: false };
      return { found: true, shadow: getComputedStyle(row).boxShadow };
    })()`);
    check(treeActive.found && treeActive.shadow !== "none", "批E：选中文件行左侧指示条（inset box-shadow）");

    // 编辑态：点编辑钮 → 解禁 + 聚焦 + 工具栏
    await evaluate(ws, `[...document.querySelectorAll('.m-top-pills .m-pill')].find((b) => (b.title || '').includes('编辑'))?.click()`);
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
    await evaluate(ws, `[...document.querySelectorAll('.m-top-pills .m-pill')].find((b) => (b.title || '').includes('编辑'))?.click()`);
    await sleep(300);
    const toggled = await evaluate(ws, `(() => ({
      editing: document.body.classList.contains('m-editing'),
      editable: document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable'),
    }))()`);
    check(!toggled.editing && toggled.editable === "false", "批C：编辑钮再点一次可退出（toggle）");
    // 回到编辑态，让后续「工具栏 ✓ 完成」断言继续覆盖第二条退出路径
    await evaluate(ws, `[...document.querySelectorAll('.m-top-pills .m-pill')].find((b) => (b.title || '').includes('编辑'))?.click()`);
    await sleep(300);

    // 完成：回阅读态
    await evaluate(ws, `document.querySelector('.mobile-md-done')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await sleep(300);
    const done = await evaluate(ws, `(() => ({
      editable: document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable'),
      editing: document.body.classList.contains('m-editing'),
    }))()`);
    check(!done.editing && done.editable === "false", "批C：✓ 完成 → 回阅读态（重新禁编辑）");

    // 0.33.1 用户反馈「显示的是源码，切换编辑模式也没用」：mode=source（历史版本
    // 切过，持久化在 localStorage）时阅读态也显示源码——阅读态必须恒 live 渲染，
    // 编辑态尊重已选模式。持久化 source + 重载（模拟老用户存量状态）；顺带种子
    // 标签词表（quicknote.tags.v2 按仓库路径分桶，给后面的建议面板断言用）
    await evaluate(
      ws,
      `localStorage.setItem('quicknote.mode', 'source'); localStorage.setItem('quicknote.tags.v2', JSON.stringify({ ${JSON.stringify(vault)}: ['git', '部署', '海亮', '问题', '已解决'] })); location.reload(); true`,
    );
    await sleep(2500);
    await waitFor(ws, `!!document.querySelector('.editor-host .cm-content')`, 15000);
    // 重载后应用回空状态（不自动重开笔记）——先点开一篇再断言
    await evaluate(
      ws,
      `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.offsetParent !== null); t?.click(); return !!t; })()`,
    );
    await waitFor(ws, `!!document.querySelector('.tree-file.is-active')`, 10000);
    await sleep(800);
    const readingLive = await evaluate(ws, `(() => ({
      editing: document.body.classList.contains('m-editing'),
      editable: document.querySelector('.editor-host .cm-content')?.getAttribute('contenteditable'),
      rendered: !!document.querySelector('.editor-host .cm-line.cm-lp-heading'),
      rawHash: (document.querySelector('.editor-host .cm-content .cm-line')?.textContent ?? '').trimStart().startsWith('#'),
      mode: localStorage.getItem('quicknote.mode'),
    }))()`);
    check(
      !readingLive.editing && readingLive.editable === "false" && readingLive.rendered && !readingLive.rawHash,
      `0.33.1：mode=${readingLive.mode} 时阅读态仍 live 渲染（标题装饰=${readingLive.rendered}，无裸 #=${!readingLive.rawHash}）`,
    );
    // 编辑态：mode=source 时编辑态显示原文（尊重命令面板/快捷键的选择）
    await evaluate(ws, `[...document.querySelectorAll('.m-top-pills .m-pill')].find((b) => (b.title || '').includes('编辑'))?.click()`);
    await sleep(500);
    const srcEdit = await evaluate(ws, `(() => ({
      editing: document.body.classList.contains('m-editing'),
      rendered: !!document.querySelector('.editor-host .cm-line.cm-lp-heading'),
    }))()`);
    check(srcEdit.editing && !srcEdit.rendered, `0.33.1：mode=source 编辑态显示原文（无标题装饰=${!srcEdit.rendered}）`);
    await evaluate(ws, `[...document.querySelectorAll('.m-top-pills .m-pill')].find((b) => (b.title || '').includes('编辑'))?.click()`);
    await sleep(300);
    await evaluate(ws, `localStorage.setItem('quicknote.mode', 'live')`);

    // 0.33.1 用户反馈「标签列表透图」：.menu-backdrop 原为纯点击层无底色，
    // 移动端补遮罩——开着标签弹窗时 backdrop 必须有实际底色。
    // 0.34.1：标签入口在右上 ⋮ 当前笔记菜单（与底条 ☰ 应用级菜单分工）
    await evaluate(
      ws,
      `(() => { [...document.querySelectorAll('.m-top-pills .m-pill')].find((b) => b.title === '当前笔记操作')?.click(); return true; })()`,
    );
    await sleep(400);
    await evaluate(
      ws,
      `(() => { [...document.querySelectorAll('.m-sheet-row')].find((b) => b.textContent.includes('当前笔记标签'))?.click(); return true; })()`,
    );
    await sleep(400);
    const tagScrim = await evaluate(ws, `(() => {
      const bd = document.querySelector('.menu-backdrop');
      if (!bd) return { open: false, bg: "" };
      return { open: !!document.querySelector('.tag-popover'), bg: getComputedStyle(bd).backgroundColor };
    })()`);
    check(
      tagScrim.open && tagScrim.bg !== "rgba(0, 0, 0, 0)",
      `0.33.1：标签弹窗遮罩有底色（${tagScrim.bg}，原纯点击层=全透）`,
    );
    // 0.33.1：自绘标签建议面板替代原生 datalist（安卓 WebView 渲染成透图列表）
    // ——▼ 展开全量词表，实底面板、点选即上标签
    await evaluate(ws, `document.querySelector('.tag-popover-caret')?.click()`);
    await sleep(300);
    const suggest = await evaluate(ws, `(() => {
      const p = document.querySelector('.tag-popover-suggest');
      if (!p) return { open: false, bg: "", items: 0 };
      return { open: true, bg: getComputedStyle(p).backgroundColor, items: p.querySelectorAll('button').length };
    })()`);
    check(
      suggest.open && suggest.items >= 3 && suggest.bg !== "rgba(0, 0, 0, 0)",
      `0.33.1：标签建议自绘面板（${suggest.items} 项，bg=${suggest.bg}，替代原生 datalist）`,
    );
    const chipAdded = await evaluate(ws, `(() => {
      const btn = [...document.querySelectorAll('.tag-popover-suggest button')].find((b) => b.textContent.includes('部署'));
      btn?.click();
      return !!btn;
    })()`);
    await sleep(300);
    const chipOk = await evaluate(
      ws,
      `!!document.querySelector('.tag-popover-chips')?.textContent.includes('#部署')`,
    );
    check(chipAdded && chipOk, "0.33.1：点选建议直接上标签（#部署 芯片出现）");
    await evaluate(ws, `document.querySelector('.menu-backdrop')?.click()`);
    await sleep(300);

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

    // 沉浸：点正文 → 浮动药丸与底条滑出；0.34.1 双向 toggle——再点一次正文唤回
    await evaluate(ws, `document.querySelector('.editor-host')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await sleep(500);
    const zen = await evaluate(ws, `(() => ({
      zen: document.body.classList.contains('m-zen'),
      pillsTransform: getComputedStyle(document.querySelector('.m-top-pills')).transform,
      barTransform: getComputedStyle(document.querySelector('.m-bottom-bar')).transform,
      peekGone: !document.querySelector('.m-zen-peek'),
    }))()`);
    check(zen.zen, "批C：阅读态点正文 → 沉浸（body.m-zen）");
    check(zen.pillsTransform !== "none", "批C：沉浸时顶部药丸滑出");
    check(zen.barTransform !== "none", "批C：沉浸时底条滑出");
    check(zen.peekGone, "0.34.1：唤回热区已移除（点正文双向 toggle 取代）");
    await evaluate(ws, `document.querySelector('.editor-host')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await sleep(500);
    const restored = await evaluate(ws, `(() => ({
      zen: document.body.classList.contains('m-zen'),
      pillsOpacity: getComputedStyle(document.querySelector('.m-top-pills')).opacity,
    }))()`);
    check(!restored.zen && restored.pillsOpacity === "1", "批C：再点一次正文 → 药丸与底条唤回（双向 toggle）");
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
    `getComputedStyle(document.documentElement).getPropertyValue('--bg-glow').trim() === 'transparent'`,
  );
  check(glow, "批A：移动端晕染已撤除（--bg-glow=transparent）");

  await screenshot(ws, join(work, "01-main-dark.png"));

  // ------------------------------------------------ 设置：外观分区（批B 三段式）
  // 0.34.0：搜索入口在底条 🔍 药丸（命令面板兼快速切换/全文搜索）
  await evaluate(
    ws,
    `(() => { const b = [...document.querySelectorAll('.m-bottom-bar .m-pill')].find((el) => (el.title || '').includes('快速切换')); b?.click(); return !!b; })()`,
  );
  const paletteOk = await waitFor(ws, `!!document.querySelector('.palette-overlay')`, 8000);
  check(paletteOk, "命令面板打开（底条 🔍 药丸）");
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

  // ------------------------------------------------ 0.34.0 Obsidian 化壳层全量断言
  // 关设置回编辑区（若开着）
  await evaluate(ws, `(() => { const x = [...document.querySelectorAll('.settings-panel button')].find((b) => b.offsetParent && (b.textContent.trim() === '×' || b.textContent.includes('关闭'))); x?.click(); return true; })()`);
  await sleep(400);

  // 开一篇笔记：树行点击（抽屉若关着，行仍在 DOM 中可程序点击）
  await evaluate(
    ws,
    `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.offsetParent !== null); t?.click(); return !!t; })()`,
  );
  await waitFor(ws, `!!document.querySelector('.tree-file.is-active')`, 10000);
  await sleep(600);
  const tabcount1 = await evaluate(ws, `document.querySelector('.m-bottom-bar .m-tabcount')?.textContent.trim()`);
  check(tabcount1 === "1", `0.34.0：打开一篇后 [N] 徽标=1（实际 ${tabcount1}）`);

  // [N] 标签页 sheet：列出标签页、激活高亮、标题计数
  await evaluate(ws, `document.querySelector('.m-bottom-bar .m-tabcount')?.click()`);
  await sleep(400);
  const tabSheet = await evaluate(ws, `(() => {
    const rows = [...document.querySelectorAll('.m-tab-row')];
    return {
      open: rows.length > 0,
      count: rows.length,
      active: !!document.querySelector('.m-tab-row.is-active'),
      title: document.querySelector('.m-sheet-title')?.textContent ?? '',
    };
  })()`);
  check(tabSheet.open && tabSheet.active, `0.34.0：标签 sheet 列出标签页（${tabSheet.count} 行，激活高亮）`);
  check(tabSheet.title.includes("标签页（1）"), `0.34.0：sheet 标题计数（${tabSheet.title}）`);
  await evaluate(ws, `document.querySelector('.m-sheet-backdrop')?.click()`);
  await sleep(300);

  // 导航历史：开第二篇 → ‹ 可用、› 到头 → ‹ 回第一篇 → › 前进
  await evaluate(ws, `document.querySelector('.m-top-pills .m-pill')?.click()`);
  await sleep(500);
  const otherNote = await evaluate(ws, `(() => {
    const active = document.querySelector('.tree-file.is-active');
    const rows = [...document.querySelectorAll('.tree-file')].filter((el) => el.offsetParent !== null);
    const target = rows.find((el) => el !== active);
    const name = target?.querySelector('.tree-label')?.textContent ?? '';
    target?.click();
    return name;
  })()`);
  await sleep(900);
  const hist1 = await evaluate(ws, `(() => {
    const back = [...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '后退');
    const fwd = [...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '前进');
    return { backDisabled: back?.disabled ?? true, fwdDisabled: fwd?.disabled ?? true };
  })()`);
  check(!hist1.backDisabled && hist1.fwdDisabled, `0.34.0：开第二篇「${otherNote}」后 ‹ 可用、› 到头`);
  await evaluate(ws, `[...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '后退')?.click()`);
  await sleep(900);
  const hist2 = await evaluate(ws, `(() => ({
    active: document.querySelector('.tree-file.is-active .tree-label')?.textContent ?? '',
    backDisabled: [...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '后退')?.disabled ?? true,
  }))()`);
  check(hist2.backDisabled && hist2.active !== otherNote, `0.34.0：‹ 回到第一篇（当前 ${hist2.active}）`);
  await evaluate(ws, `[...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '前进')?.click()`);
  await sleep(900);
  const hist3 = await evaluate(ws, `document.querySelector('.tree-file.is-active .tree-label')?.textContent ?? ''`);
  check(hist3 === otherNote, `0.34.0：› 前进回第二篇（当前 ${hist3}）`);

  // ☰ 动作菜单 sheet：行清单 + grabber + 遮罩底色 → 「快速切换」行开命令面板
  await evaluate(ws, `[...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '更多')?.click()`);
  await sleep(400);
  const menuRows = await evaluate(ws, `(() => {
    const sheet = document.querySelector('.m-sheet');
    const rows = sheet ? [...sheet.querySelectorAll('.m-sheet-row')].map((r) => r.textContent.trim()) : [];
    const bd = document.querySelector('.m-sheet-backdrop');
    return {
      open: !!sheet && !!document.querySelector('.m-sheet-grabber'),
      rows,
      bdBg: bd ? getComputedStyle(bd).backgroundColor : '',
    };
  })()`);
  check(menuRows.open, "0.34.0：☰ 动作菜单 sheet 打开（含 grabber，图2）");
  // 0.34.1：标签/保存两行迁去右上 ⋮ 笔记菜单，应用级菜单剩 8 行
  check(menuRows.rows.length === 8, `0.34.1：应用级动作菜单 8 行（实际 ${menuRows.rows.length}）`);
  check(menuRows.bdBg !== "rgba(0, 0, 0, 0)", "0.34.0：sheet 遮罩有底色");
  check(
    menuRows.rows.some((r) => r.includes("今天的日记")) &&
      menuRows.rows.some((r) => r.includes("速记")) &&
      menuRows.rows.some((r) => r.includes("添加单词")) &&
      menuRows.rows.some((r) => r.includes("立即同步")) &&
      menuRows.rows.some((r) => r.includes("设置")),
    "0.34.0：菜单条目齐（日记/速记/单词/同步/设置）",
  );
  // 0.34.1 右上 ⋮ = 当前笔记菜单（阅读/源码/固定/重命名/收藏/标签/关闭/保存）
  await evaluate(ws, `(() => { [...document.querySelectorAll('.m-sheet-row')].find((b) => b.textContent.includes('设置'))?.click(); return true; })()`);
  await sleep(500);
  await evaluate(ws, `(() => { const x = [...document.querySelectorAll('.settings-panel button')].find((b) => b.offsetParent && (b.textContent.trim() === '×' || b.textContent.includes('关闭'))); x?.click(); return true; })()`);
  await sleep(400);
  await evaluate(ws, `[...document.querySelectorAll('.m-top-pills .m-pill')].find((b) => b.title === '当前笔记操作')?.click()`);
  await sleep(400);
  const noteMenu = await evaluate(ws, `(() => {
    const rows = [...document.querySelectorAll('.m-sheet-row')].map((r) => r.textContent.trim());
    return { open: rows.length > 0, rows };
  })()`);
  check(
    noteMenu.open && noteMenu.rows.length === 8,
    `0.34.1：⋮ 当前笔记菜单 8 行（实际 ${noteMenu.rows.length}）`,
  );
  check(
    noteMenu.rows.some((r) => r.includes("阅读视图") || r.includes("编辑这篇笔记")) &&
      noteMenu.rows.some((r) => r.includes("实时 / 源码")) &&
      noteMenu.rows.some((r) => r.includes("固定标签页")) &&
      noteMenu.rows.some((r) => r.includes("重命名")) &&
      noteMenu.rows.some((r) => r === "收藏" || r === "取消收藏") &&
      noteMenu.rows.some((r) => r.includes("标签")) &&
      noteMenu.rows.some((r) => r.includes("关闭标签页")) &&
      noteMenu.rows.some((r) => r.includes("保存")),
    "0.34.1：笔记菜单条目齐（阅读/源码/固定/重命名/收藏/标签/关闭/保存）",
  );
  await evaluate(ws, `document.querySelector('.m-sheet-backdrop')?.click()`);
  await sleep(300);
  // 「打开/创建今天的日记」= 用户自己的命名流程（0.34.1 拍板：日期+空格+名字，
  // 输入行必填；不做免输入的纯日期名）——重开底 ☰ 应用级菜单
  await evaluate(ws, `[...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '更多')?.click()`);
  await sleep(400);
  await evaluate(ws, `[...document.querySelectorAll('.m-sheet-row')].find((b) => b.textContent.includes('今天的日记'))?.click()`);
  await sleep(600);
  const diaryRow = await evaluate(ws, `(() => {
    const input = document.querySelector('.create-row input');
    const side = document.querySelector('aside.sidebar-left');
    return {
      input: !!input,
      placeholder: input?.placeholder ?? '',
      hint: document.querySelector('.create-row .create-hint')?.textContent ?? '',
      drawerOpen: side ? getComputedStyle(side).transform === 'none' : false,
    };
  })()`);
  check(diaryRow.input && diaryRow.drawerOpen, "0.34.0：菜单「今天的日记」→ 抽屉输入行（用户命名流程）");
  check(diaryRow.placeholder.includes("日记名字"), `0.34.0：日记输入行占位（${diaryRow.placeholder}）`);
  check(diaryRow.hint.includes("日期 + 空格 + 名字"), `0.34.0：日记命名提示（${diaryRow.hint}）`);
  await evaluate(ws, `(() => { [...document.querySelectorAll('.create-row button')].find((b) => (b.title || '') === '取消')?.click(); return true; })()`);
  await sleep(300);

  await evaluate(ws, `[...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '更多')?.click()`);
  await sleep(400);
  await evaluate(ws, `[...document.querySelectorAll('.m-sheet-row')].find((b) => b.textContent.includes('快速切换'))?.click()`);
  await sleep(400);
  check(await evaluate(ws, `!!document.querySelector('.palette-overlay')`), "0.34.0：菜单「快速切换与全文搜索」→ 命令面板");
  await evaluate(
    ws,
    `(() => { const it = [...document.querySelectorAll('.palette-item')].find((el) => el.textContent.includes('打开设置')); it?.click(); return !!it; })()`,
  );
  await waitFor(ws, `!!document.querySelector('.settings-panel')`, 8000);
  await evaluate(ws, `(() => { const x = [...document.querySelectorAll('.settings-panel button')].find((b) => b.offsetParent && (b.textContent.trim() === '×' || b.textContent.includes('关闭'))); x?.click(); return true; })()`);
  await sleep(400);

  // 右抽屉（大纲/统计）：菜单「右侧面板」打开，页签只剩 目录/统计
  await evaluate(ws, `[...document.querySelectorAll('.m-bottom-bar .m-pill')].find((b) => b.title === '更多')?.click()`);
  await sleep(400);
  await evaluate(ws, `[...document.querySelectorAll('.m-sheet-row')].find((b) => b.textContent.includes('右侧面板'))?.click()`);
  await sleep(500);
  const rightDrawer = await evaluate(ws, `(() => {
    const side = document.querySelector('aside.sidebar-right');
    const tabs = [...document.querySelectorAll('aside.sidebar-right .sidebar-tab')].map((t) => t.textContent.trim());
    return { open: side ? getComputedStyle(side).transform === 'none' : false, tabs };
  })()`);
  check(rightDrawer.open, "0.34.0：菜单「右侧面板」打开右抽屉");
  check(
    rightDrawer.tabs.length === 2 && rightDrawer.tabs.includes("目录") && rightDrawer.tabs.includes("统计"),
    `0.34.0：右抽屉只剩 目录/统计（${rightDrawer.tabs.join("/")}）`,
  );
  // 0.34.1：右抽屉右滑关闭（用户反馈：右滑关右抽屉）
  await evaluate(ws, `(() => {
    const t = (x, y) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [t(120, 420)], bubbles: true }));
    document.dispatchEvent(new TouchEvent('touchend', { changedTouches: [t(260, 424)], bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const rightClosedBySwipe = await evaluate(ws, `getComputedStyle(document.querySelector('aside.sidebar-right')).transform`);
  check(rightClosedBySwipe !== "none", "0.34.1：右抽屉右滑手势关闭");

  // 左抽屉分区切换：标签/单词本/日历/搜索/文件列表
  await evaluate(ws, `document.querySelector('.m-top-pills .m-pill')?.click()`);
  await sleep(500);
  // 0.34.1：分区卡收起成胶囊——每次切换先展开再点行（选中后自动收回）
  const pickSection = async (label) => {
    await evaluate(ws, `document.querySelector('.m-drawer-section-collapsed')?.click()`);
    await sleep(300);
    await evaluate(ws, `(() => { [...document.querySelectorAll('.m-drawer-section')].find((b) => b.textContent.includes('${label}'))?.click(); return true; })()`);
    await sleep(500);
  };
  await pickSection("标签");
  // 空仓库时 TagDashboard 早返回 .tree-empty 空态（「仓库里还没有标签」）——
  // 两种形态都算渲染成功，唯独不能还是文件树
  const secTags = await evaluate(ws, `(() => {
    const c = document.querySelector('.m-drawer-content');
    return !!c && (c.querySelector('.tag-dash') !== null || c.querySelector('.tree-empty') !== null);
  })()`);
  await pickSection("单词本");
  const secVocab = await waitFor(ws, `!!document.querySelector('.m-drawer-content .vocab-panel')`, 5000);
  await pickSection("日历");
  const secCal = await evaluate(ws, `!!document.querySelector('.m-drawer-content .calendar')`);
  await pickSection("搜索");
  const secSearch = await evaluate(
    ws,
    `(() => ({ filter: !!document.querySelector('.m-drawer-content .sidebar-filter input'), full: !!document.querySelector('.m-fulltext-btn') }))()`,
  );
  await pickSection("文件列表");
  const secFiles = await evaluate(
    ws,
    `(() => ({ tree: !!document.querySelector('.m-drawer-content .tree'), chips: document.querySelectorAll('.m-drawer-content .left-view-tab').length }))()`,
  );
  check(secTags, "0.34.0：标签分区渲染 TagDashboard");
  check(secVocab, "0.34.0：单词本分区渲染 VocabularyPanel");
  check(secCal, "0.34.0：日历分区渲染 CalendarPanel");
  check(secSearch.filter && secSearch.full, "0.34.0：搜索分区=名称筛选框+全文搜索钮");
  check(secFiles.tree && secFiles.chips === 3, `0.34.0：文件分区=树+知识库/收藏/最近页签（chips=${secFiles.chips}）`);

  // 0.34.1：全屏抽屉无关闭钮——系统返回关闭（back 消费链）
  await evaluate(ws, `window.__qnConsumeBack()`);
  await sleep(500);
  const closedByBack = await evaluate(ws, `getComputedStyle(document.querySelector('aside.sidebar-left')).transform`);
  check(closedByBack !== "none", "0.34.1：返回键消费链关闭全屏抽屉（✕ 已删）");

  // 边缘手势：左缘右滑开抽屉（合成 TouchEvent，passive 观察链）
  await evaluate(ws, `(() => {
    const t = (x, y) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [t(8, 420)], bubbles: true }));
    document.dispatchEvent(new TouchEvent('touchend', { changedTouches: [t(110, 424)], bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const swipeOpen = await evaluate(ws, `getComputedStyle(document.querySelector('aside.sidebar-left')).transform`);
  check(swipeOpen === "none", "0.34.0：左缘右滑手势打开抽屉");

  // 0.34.1：左抽屉左滑关闭（用户反馈：左滑关左抽屉）
  await evaluate(ws, `(() => {
    const t = (x, y) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [t(300, 420)], bubbles: true }));
    document.dispatchEvent(new TouchEvent('touchend', { changedTouches: [t(140, 424)], bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const leftClosedBySwipe = await evaluate(ws, `getComputedStyle(document.querySelector('aside.sidebar-left')).transform`);
  check(leftClosedBySwipe !== "none", "0.34.1：左抽屉左滑手势关闭");

  // 仓库 radio sheet（抽屉底行仓库名）→「管理仓库…」进主页（图4/图5）
  await evaluate(ws, `document.querySelector('.m-drawer-vault')?.click()`);
  await sleep(500);
  const vaultSheet = await evaluate(ws, `(() => {
    const rows = [...document.querySelectorAll('.m-vault-row')];
    return {
      open: rows.length >= 2,
      count: rows.length,
      onCount: document.querySelectorAll('.m-radio.is-on').length,
      last: rows[rows.length - 1]?.textContent.trim() ?? '',
    };
  })()`);
  check(vaultSheet.open, `0.34.0：仓库 radio sheet（${vaultSheet.count} 行）`);
  check(vaultSheet.onCount === 1, `0.34.0：当前仓库 radio 高亮（选中圈 ${vaultSheet.onCount}，路径归一后判同）`);
  check(vaultSheet.last.includes("管理仓库"), `0.34.0：末行「管理仓库…」（${vaultSheet.last}）`);
  await evaluate(ws, `[...document.querySelectorAll('.m-vault-row')].find((b) => b.textContent.includes('管理仓库'))?.click()`);
  await sleep(500);
  const gateOk = await waitFor(ws, `!!document.querySelector('.vault-home-page .mv-gate-head')`, 8000);
  check(gateOk, "0.34.0：管理仓库… → 仓库主页");
  const brand = await evaluate(ws, `(() => {
    const b = document.querySelector('.vault-home-page .mv-brand');
    return {
      found: !!b,
      name: b?.querySelector('.mv-brand-name')?.textContent ?? '',
      version: b?.querySelector('.mv-brand-version')?.textContent ?? '',
    };
  })()`);
  check(
    brand.found && brand.name === "Quick Note" && brand.version.includes("Version"),
    `0.34.0：主页品牌块（logo+名称+版本，图5；${brand.name} ${brand.version}）`,
  );

  // ------------------------------------------------ 仓库页（批B 头部两行 + 云端行注入验证）
  // 基础目录指针已在 spawn 前预写；主页是新 mount 实例，mount 时即读到列表形态

  const headLayout = await evaluate(ws, `(() => {
    const title = document.querySelector('.vault-home-page .mv-gate-title');
    const home = document.querySelector('.vault-home-page .mv-home');
    if (!title || !home) return { found: false };
    const tr = title.getBoundingClientRect();
    const hr = home.getBoundingClientRect();
    return { found: true, homeBelow: hr.top >= tr.bottom - 2, homeWidth: hr.width };
  })()`);
  check(headLayout.found && headLayout.homeBelow, "批B：仓库页头部两行（标题行 + 路径行）");

  // 注入假云端行：验证 flex 布局下按钮固定宽不重叠、长名单行省略、图标不被压小
  const cloudRow = await evaluate(ws, `(() => {
    const gate = document.querySelector('.vault-home-page .mv-gate');
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
    const list = document.querySelector('.vault-home-page .mv-list');
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
  await waitFor(ws, `document.querySelectorAll('.m-bottom-bar button').length === 6`, 30000);
  const lightThemeState = await evaluate(
    ws,
    `({ theme: document.documentElement.dataset.theme, ph: getComputedStyle(document.documentElement).getPropertyValue('--text-placeholder').trim(), media: matchMedia('(hover: none) and (pointer: coarse) and (max-width: 900px)').matches })`,
  );
  check(lightThemeState.theme === "light", `浅色主题生效（data-theme=${lightThemeState.theme}）`);
  check(
    lightThemeState.media && lightThemeState.ph !== "",
    `批A：浅色下 --text-placeholder 有值（${lightThemeState.ph}；媒体=${lightThemeState.media}）`,
  );
  // 再开一次设置截图（0.34.0：搜索入口=底条 🔍 药丸）
  await evaluate(
    ws,
    `(() => { const b = [...document.querySelectorAll('.m-bottom-bar .m-pill')].find((el) => (el.title || '').includes('快速切换')); b?.click(); return !!b; })()`,
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
  await waitFor(ws, `document.querySelectorAll('.m-bottom-bar button').length === 6`, 30000);
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

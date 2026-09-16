// GUI 验证：额外语法渲染（公式 / 高亮 / 注释 / 手写 HTML）+ 主题切换。
//
// 这里最重要的是**安全性断言**：fixture 的 HTML 块里埋了一段
// `<script>window.__pwned = true;</script>`，必须确认它没有执行、也没有留在 DOM 里。
// 同时确认清洗只作用于显示——文件内容仍由 verify-gui.sh 的字节精确基线守住。
//
// 用法：node scripts/gui-rendering.mjs <vaultDir> [port]

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const TARGET = "features.md";

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

/**
 * 逐步向下滚动，直到页面里的某个表达式成立。
 *
 * 必须按"目标元素出现"来判断，不能按"文字在 DOM 里"判断：
 * CodeMirror 会渲染视口外的一段余量，文字可能已经在 DOM 里但真正的内容还没渲染，
 * 那样滚动会提前结束（gui-livepreview 里踩过这个坑）。
 */
async function scrollUntil(ws, expression, maxSteps = 18) {
  for (let i = 0; i <= maxSteps; i += 1) {
    if (await evaluate(ws, expression)) return true;
    await evaluate(
      ws,
      `(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop += s.clientHeight * 0.6; })()`,
    );
    await sleep(300);
  }
  return evaluate(ws, expression);
}

const themeInfo = (ws) =>
  evaluate(
    ws,
    `(() => {
       const root = getComputedStyle(document.documentElement);
       const keyword = [...document.querySelectorAll('.cm-lp-codeblock span')]
         .find(e => e.textContent === 'const');
       return {
         theme: document.documentElement.dataset.theme,
         bg: root.getPropertyValue('--bg').trim(),
         panel: root.getPropertyValue('--panel').trim(),
         bodyBg: getComputedStyle(document.body).backgroundColor,
         keywordColor: keyword ? getComputedStyle(keyword).color : null,
       };
     })()`,
  );

async function setTheme(ws, value) {
  await evaluate(
    ws,
    `(() => {
       const button = [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.trim() === '设置');
       if (!button) return false;
       if (!document.querySelector('.settings-panel')) button.click();
       return true;
     })()`,
  );
  await sleep(250);
  await evaluate(
    ws,
    `(() => {
       const select = document.querySelector('.settings-panel select');
       if (!select) return false;
       const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
       setter.call(select, ${JSON.stringify(value)});
       select.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`,
  );
  await sleep(350);
  await evaluate(
    ws,
    `[...document.querySelectorAll('.toolbar button')].find(b => b.textContent.trim() === '设置')?.click()`,
  );
  await sleep(250);
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("未找到页面目标，请确认应用已启动并开启调试端口。");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")), { once: true });
});

for (let i = 0; i < 40; i += 1) {
  if (await evaluate(ws, `document.querySelectorAll('.tree-file').length > 0`)) break;
  await sleep(250);
}
check(
  (await evaluate(
    ws,
    `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(TARGET)}); if (!b) return false; b.click(); return true; })()`,
  )) === true,
  `打开 ${TARGET}`,
);
await sleep(900);

check(
  await scrollUntil(ws, `document.querySelectorAll('.cm-lp-math').length >= 2`),
  "滚动到「额外语法」段（公式已渲染）",
);

// ---------------------------------------------------------------- 公式
let math = null;
for (let i = 0; i < 60; i += 1) {
  math = await evaluate(
    ws,
    `(() => {
       const nodes = [...document.querySelectorAll('.cm-lp-math')];
       return {
         count: nodes.length,
         rendered: nodes.filter(n => n.querySelector('.katex')).length,
         loading: nodes.filter(n => n.classList.contains('is-loading')).length,
         errors: nodes.filter(n => n.classList.contains('is-error')).length,
         first: nodes[0]?.textContent?.slice(0, 20) ?? null,
       };
     })()`,
  );
  if (math.count >= 2 && math.loading === 0) break;
  await sleep(300);
}
check(math.count === 2, "两个行内公式都被接管", JSON.stringify(math));
check(math.rendered === 2, "公式渲染成了 KaTeX 结构（而不是保留 $…$ 原文）", JSON.stringify(math));
check(math.errors === 0, "没有公式渲染失败");

const money = await evaluate(
  ws,
  `(document.querySelector('.cm-content')?.textContent ?? '').includes('价格 $100 不该被当成公式')`,
);
check(money === true, "货币写法 $100 没有被当成公式（仍显示原文）");

// ---------------------------------------------------------------- 高亮与注释
const styled = await evaluate(
  ws,
  `(() => {
     const mark = document.querySelector('.cm-lp-highlight');
     return {
       highlight: mark?.textContent ?? null,
       highlightBg: mark ? getComputedStyle(mark).backgroundColor : null,
       rawHasHighlightSyntax: (document.querySelector('.cm-content')?.textContent ?? '').includes('==这是高亮=='),
       rawHasComment: (document.querySelector('.cm-content')?.textContent ?? '').includes('这是注释应当隐藏'),
       commentTailVisible: (document.querySelector('.cm-content')?.textContent ?? '').includes('后面的文字仍然可见'),
     };
   })()`,
);
check(styled.highlight === "这是高亮", "高亮文字保留", JSON.stringify(styled.highlight));
check(
  styled.highlightBg !== null && styled.highlightBg !== "rgba(0, 0, 0, 0)",
  "高亮加了底色",
  JSON.stringify(styled.highlightBg),
);
check(styled.rawHasHighlightSyntax === false, "`==` 标记已隐藏");
check(styled.rawHasComment === false, "注释内容被隐藏");
check(styled.commentTailVisible === true, "注释后面的文字仍然可见（没有误伤）");

// ---------------------------------------------------------------- 手写 HTML
const html = await evaluate(
  ws,
  `(() => {
     const inline = [...document.querySelectorAll('.cm-lp-html')];
     const font = inline.map(e => e.querySelector('font')).find(Boolean);
     const block = document.querySelector('.cm-lp-html-block');
     return {
       inlineCount: inline.length,
       fontText: font?.textContent ?? null,
       fontColor: font ? getComputedStyle(font).color : null,
       hasBr: inline.some(e => e.querySelector('br')),
       hasMark: inline.some(e => e.querySelector('mark')),
       blockText: block?.textContent?.slice(0, 30) ?? null,
       scriptTags: document.querySelectorAll('.cm-lp-html script').length,
       pwned: typeof window.__pwned !== 'undefined',
       rawDivVisible: (document.querySelector('.cm-content')?.textContent ?? '').includes('<div class="raw-html">'),
     };
   })()`,
);
check(html.inlineCount >= 3, "行内 HTML 被接管", JSON.stringify(html.inlineCount));
check(html.fontText === "红色文字", "成对标签的内容保留（<font>…</font>）", JSON.stringify(html.fontText));
check(
  html.fontColor === "rgb(204, 0, 0)",
  "<font color> 的颜色生效（说明整个成对标签都被接管并渲染了）",
  JSON.stringify(html.fontColor),
);
check(html.hasBr === true, "<br/> 渲染成了真正的换行元素");
check(html.hasMark === true, "<mark> 渲染成了标记元素");
check(
  (html.blockText ?? "").includes("会被清洗后渲染"),
  "块级 HTML 渲染出内容",
  JSON.stringify(html.blockText),
);
check(html.rawDivVisible === false, "块级 HTML 的原始标签不再直接显示");

// 安全断言：清洗必须挡住脚本，而且只挡显示、不动文件
check(html.scriptTags === 0, "清洗后 DOM 里没有 <script> 元素", JSON.stringify(html.scriptTags));
check(html.pwned === false, "HTML 里的脚本没有被执行（window.__pwned 未定义）");

// ---------------------------------------------------------------- 裸链接 / setext / callout / 标签
check(
  await scrollUntil(ws, `document.querySelectorAll('.cm-lp-callout-label').length >= 2`),
  "滚动到「链接、标题与 callout」段",
);

const extras = await evaluate(
  ws,
  `(() => {
     const links = [...document.querySelectorAll('.cm-lp-link')];
     const bare = links.find(e => e.textContent.includes('https://example.com/bare'));
     const collapsed = [...document.querySelectorAll('.cm-line.cm-lp-collapsed')];
     const labels = [...document.querySelectorAll('.cm-lp-callout-label')];
     const tags = [...document.querySelectorAll('.cm-lp-tag')];
     const note = document.querySelector('.cm-lp-callout-note');
     return {
       bareTitle: bare?.getAttribute('title') ?? null,
       bareVisible: (document.querySelector('.cm-content')?.textContent ?? '').includes('https://example.com/bare'),
       setextStyled: [...document.querySelectorAll('.cm-line.cm-lp-heading')].filter(e => e.innerText.includes('Setext')).length,
       collapsedCount: collapsed.length,
       collapsedHeight: collapsed.length ? Math.round(collapsed[0].getBoundingClientRect().height) : null,
       noteCalloutLines: document.querySelectorAll('.cm-lp-callout-note').length,
       noteBg: note ? getComputedStyle(note).backgroundColor : null,
       labelTexts: labels.map(e => e.textContent),
       tagTexts: tags.map(e => e.textContent),
       rawMarkerVisible: (document.querySelector('.cm-content')?.textContent ?? '').includes('[!note]'),
     };
   })()`,
);
check(
  (extras.bareTitle ?? "").includes("Ctrl+点击"),
  "裸链接带上了 Ctrl+点击的提示",
  JSON.stringify(extras.bareTitle),
);
check(extras.bareVisible === true, "裸链接的文字仍然可见（只是加了链接样式）");
check(extras.setextStyled === 2, "两个 setext 标题都应用了标题行样式", JSON.stringify(extras.setextStyled));
check(extras.collapsedCount >= 2, "setext 的下划线行被压掉", JSON.stringify(extras.collapsedCount));
check(
  extras.collapsedHeight !== null && extras.collapsedHeight <= 4,
  "下划线行的高度接近 0（没有留下空行）",
  JSON.stringify(extras.collapsedHeight),
);
check(extras.noteCalloutLines === 3, "note callout 的三行都套上了容器样式", JSON.stringify(extras.noteCalloutLines));
check(
  extras.noteBg !== null && extras.noteBg !== "rgba(0, 0, 0, 0)",
  "callout 有类型底色",
  JSON.stringify(extras.noteBg),
);
check(
  extras.labelTexts.some((t) => t.includes("提示标题")) &&
    extras.labelTexts.some((t) => t.includes("警告")),
  "callout 标签显示标题；没写标题时回落到类型默认名",
  JSON.stringify(extras.labelTexts),
);
check(extras.rawMarkerVisible === false, "源码里的 `[!note]` 已被图标标签替换");

// 标签那一节在 callout 之后。CM6 只渲染视口内的行——左右分栏后编辑器变窄、
// 文档因换行变高，滚到文末时标签行已经不在视口里（曾经因此收集到空数组）。
// 所以这里单独滚到标签行再收集。
// 行没渲染时拿不到它的位置（循环依赖），所以从文末向上步进搜索，直到标签行进入视口。
let tagLineVisible = false;
// 先跳到文档最底部（标签节就在文末）
await evaluate(
  ws,
  `(() => {
     const scroller = document.querySelector('.cm-scroller');
     if (scroller) scroller.scrollTop = scroller.scrollHeight;
     return true;
   })()`,
);
await sleep(400);
for (let attempt = 0; attempt < 12 && !tagLineVisible; attempt += 1) {
  tagLineVisible = await evaluate(
    ws,
    `[...document.querySelectorAll('.cm-line')].some(e => e.innerText.includes('#嵌套/标签'))`,
  );
  if (tagLineVisible) break;
  await evaluate(
    ws,
    `(() => {
       const scroller = document.querySelector('.cm-scroller');
       const viewport = scroller.clientHeight || 600;
       scroller.scrollTop = Math.max(scroller.scrollTop - viewport * 0.7, 0);
       return scroller.scrollTop;
     })()`,
  );
  await sleep(350);
}
check(tagLineVisible, "标签行进入了渲染视口");
const tagTexts = await evaluate(
  ws,
  `[...document.querySelectorAll('.cm-lp-tag')].map(e => e.textContent)`,
);
check(
  JSON.stringify(tagTexts) === JSON.stringify(["#标签", "#嵌套/标签", "#a1"]),
  "三个标签都渲染成标签样式",
  JSON.stringify(tagTexts),
);

// ---------------------------------------------------------------- 主题
// 断言语法高亮的颜色需要代码块在渲染范围内：先滚回顶部（前面为了断言 callout 已滚到文末）。
await evaluate(ws, `document.querySelector('.cm-scroller').scrollTop = 0`);
await sleep(400);
for (let i = 0; i < 20; i += 1) {
  const ready = await evaluate(
    ws,
    `[...document.querySelectorAll('.cm-lp-codeblock span')].some(e => e.textContent === 'const')`,
  );
  if (ready) break;
  await sleep(200);
}

// 注意：默认模式是「跟随系统」，所以初始主题取决于机器——这里显式指定，
// 不假设初始是浅色（第一版就是这么写错的）。
await setTheme(ws, "light");
const light = await themeInfo(ws);
check(light.theme === "light", "指定浅色后根节点标记为 light", JSON.stringify(light.theme));
check(light.bg === "#f7f7f8", "浅色背景取自色板", JSON.stringify(light.bg));
check(
  light.keywordColor === "rgb(130, 80, 223)",
  "浅色下代码关键字用的是色板里的值（说明内置的默认高亮被覆盖了）",
  JSON.stringify(light.keywordColor),
);

await setTheme(ws, "dark");
const dark = await themeInfo(ws);
check(dark.theme === "dark", "切到深色后根节点标记变为 dark", JSON.stringify(dark.theme));
check(dark.bg === "#1b1b1f", "深色背景取自深色色板", JSON.stringify(dark.bg));
check(dark.bodyBg !== light.bodyBg, "深色下页面背景真的变了", `${light.bodyBg} → ${dark.bodyBg}`);
check(
  dark.keywordColor === "rgb(199, 146, 234)",
  "深色下关键字颜色也变成深色色板的值（高亮走 CSS 变量，不是写死的色值）",
  JSON.stringify(dark.keywordColor),
);

// 「跟随系统」：解析结果应当与系统的偏好一致
await setTheme(ws, "system");
const system = await themeInfo(ws);
const osPrefersDark = await evaluate(ws, `window.matchMedia('(prefers-color-scheme: dark)').matches`);
check(
  system.theme === (osPrefersDark ? "dark" : "light"),
  "「跟随系统」解析结果与系统偏好一致",
  JSON.stringify({ resolved: system.theme, osPrefersDark }),
);

ws.close();
console.log(failures === 0 ? "\n额外语法与主题验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

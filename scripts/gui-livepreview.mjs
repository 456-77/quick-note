// GUI 端到端验证 Live Preview：读取真实渲染后的 DOM，并用真实鼠标/键盘交互。
//
// 这一层是必须的：装饰层的单元测试通过，应用却可能整个白屏。实际踩到的两个坑
// （块级装饰、替换换行符）单元测试都测不出来——它们是 CM6 对插件的运行时限制，
// 违反后装饰集整体抛异常，编辑器渲染成空白，错误只显示在界面提示条里。
// 因此本脚本第一条断言就是「界面没有报错」。
//
// 前置：应用以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动。
// 用法：node scripts/gui-livepreview.mjs <vaultDir> [port]

import { readFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const TARGET = "features.md";
const filePath = join(vault, TARGET);

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

async function clickAt(ws, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
  }
}

/** 在编辑器里真实点击「包含某段文字的那一行」，把光标放过去。 */
async function clickLine(ws, needle) {
  const rect = await evaluate(
    ws,
    `(() => {
       const el = [...document.querySelectorAll('.cm-line')].find(e => (e.innerText ?? '').includes(${JSON.stringify(needle)}));
       if (!el) return null;
       const r = el.getBoundingClientRect();
       return { x: r.left + 24, y: r.top + r.height / 2 };
     })()`,
  );
  if (!rect) return false;
  await clickAt(ws, rect.x, rect.y);
  await sleep(400);
  return true;
}

/**
 * 逐步向下滚动，直到某段文字出现在渲染后的 DOM 里。
 *
 * 注意：这个检查比"元素可见"要弱——CodeMirror 会渲染视口外的一段余量，
 * 所以文字出现在 DOM 里并不代表它真的渲染出来了。要断言元素时请用下面
 * 更严格的 scrollUntil，否则会像这次一样"没滚动就返回真"。
 */
async function ensureVisible(ws, needle, maxSteps = 14) {
  for (let i = 0; i <= maxSteps; i += 1) {
    const found = await evaluate(
      ws,
      `(document.querySelector('.cm-content')?.textContent ?? '').includes(${JSON.stringify(needle)})`,
    );
    if (found) return true;
    await evaluate(
      ws,
      `(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop += s.clientHeight * 0.75; })()`,
    );
    await sleep(300);
  }
  return false;
}

/**
 * 逐步向下滚动，直到页面里的某个表达式成立（例如"已经出现 4 个嵌入容器"）。
 *
 * 断言元素时必须用这个而不是 ensureVisible：后者只查文本是否在 DOM 里，
 * 而 CodeMirror 的视口余量会让"还没真正渲染"的文字也满足条件，
 * 于是滚动提前结束，后面的断言全部落空。
 */
async function scrollUntil(ws, expression, maxSteps = 16, step = 0.6) {
  for (let i = 0; i <= maxSteps; i += 1) {
    if (await evaluate(ws, expression)) return true;
    await evaluate(
      ws,
      `(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop += s.clientHeight * ${step}; })()`,
    );
    await sleep(300);
  }
  return evaluate(ws, expression);
}

const text = (ws) => evaluate(ws, `document.querySelector('.cm-content').textContent`);

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
const opened = await evaluate(
  ws,
  `(() => { const b = [...document.querySelectorAll('.tree-file')].find(x => x.title === ${JSON.stringify(TARGET)}); if (!b) return false; b.click(); return true; })()`,
);
check(opened === true, `打开 ${TARGET}`);
await sleep(900);

// 0. 界面上不能有报错——装饰层违反 CM6 约束时会以提示条形式暴露
const banner = await evaluate(ws, `document.querySelector('.banner-error')?.innerText ?? null`);
check(banner === null, "界面无报错提示", banner ?? "");
check((await evaluate(ws, `document.querySelectorAll('.cm-line').length`)) > 20, "编辑器渲染出多行内容");

// 光标放到二级标题行：该行在视口内且带 `##` 标记，用来验证「光标所在行显示源码」。
// 注意别选文末的引用行——文档比窗口高，文末在视口外，点击坐标会落空。
check(await clickLine(ws, "列表与分割线"), "点击二级标题行");

// 1. 语法标记已从 DOM 中移除
const content = await text(ws);
check(!content.includes("**粗体**"), "`**` 已从渲染结果中消失");
check(!content.includes("~~删除线~~"), "`~~` 已消失");
check(!content.includes("`code`"), "反引号已消失");
check(!content.includes("](https://example.com)"), "`](url)` 已整段消失");
check(
  content.includes("粗体") && content.includes("斜体") && content.includes("删除线"),
  "加粗/斜体/删除线的文字仍在",
);
check(!content.includes("# 语法覆盖"), "标题的 `#` 已消失（光标不在该行）");

// 2. 样式类确实作用到了渲染结果上。
// 注意选择器要限定在 .cm-line 内：表格单元格里的链接/代码用的是同样的类名，
// 而表格作为块级 widget 排在正文之前，不加限定会先命中表格里的那个。
const styled = await evaluate(
  ws,
  `({
     strong: document.querySelector('.cm-line .cm-lp-strong')?.textContent ?? null,
     em: document.querySelector('.cm-line .cm-lp-em')?.textContent ?? null,
     strike: document.querySelector('.cm-line .cm-lp-strike')?.textContent ?? null,
     code: document.querySelector('.cm-line .cm-lp-code')?.textContent ?? null,
     link: document.querySelector('.cm-line .cm-lp-link')?.textContent ?? null,
     h1: document.querySelectorAll('.cm-lp-heading.cm-lp-h1').length,
     h2: document.querySelectorAll('.cm-lp-heading.cm-lp-h2').length,
     bullets: document.querySelectorAll('.cm-lp-bullet').length,
     rules: document.querySelectorAll('.cm-lp-rule').length,
     codeblocks: document.querySelectorAll('.cm-lp-codeblock').length,
     codeinfo: [...document.querySelectorAll('.cm-lp-codeinfo')].map(e => e.textContent),
     tasks: document.querySelectorAll('input.cm-lp-task').length,
     tasksChecked: document.querySelectorAll('input.cm-lp-task:checked').length,
   })`,
);
check(styled.strong === "粗体", "粗体文字样式正确", `实际=${styled.strong}`);
check(styled.em === "斜体", "斜体文字样式正确", `实际=${styled.em}`);
check(styled.strike === "删除线", "删除线文字样式正确", `实际=${styled.strike}`);
check(styled.code === "code", "行内代码样式正确", `实际=${styled.code}`);
check(styled.link === "示例", "链接文字样式正确", `实际=${styled.link}`);
check(styled.h1 === 1 && styled.h2 === 1, "标题行装饰正确", `h1=${styled.h1} h2=${styled.h2}`);
check(styled.bullets === 2, "普通列表项渲染成圆点", `实际=${styled.bullets}`);
check(styled.rules === 1, "分割线渲染成 <hr>", `实际=${styled.rules}`);
// 引用行的断言放在后面滚动到位之后（它在文档末尾，初始不在渲染范围内）
check(styled.codeblocks >= 3, "普通代码块有底色", `实际=${styled.codeblocks}`);
// mermaid 块被整块替换成图，插件跳过它们，所以语言标签只剩普通代码块那个。
check(
  JSON.stringify(styled.codeinfo) === JSON.stringify(["ts"]),
  "代码块语言标签正确（mermaid 已变成图，不再显示语言标签）",
  JSON.stringify(styled.codeinfo),
);
// 图片的断言在下面 2.5 段：现在会真的加载，不再是占位标签
// 勾选数量从源码推导，避免脚本不可重复运行（上一轮会把复选框翻转）
const expectedChecked = (readFileSync(filePath, "utf8").match(/^- \[x\]/gm) ?? []).length;
check(
  styled.tasks === 2 && styled.tasksChecked === expectedChecked,
  "复选框的勾选态与源码一致",
  `tasks=${styled.tasks} checked=${styled.tasksChecked} 期望=${expectedChecked}`,
);

// 2.5 图片：库内文件应真的加载出来（这一步验证 asset 协议与目录授权都生效）。
// 加载是异步的，且失败会被降级成标签替换掉 <img>，所以要轮询。
let image = null;
for (let i = 0; i < 40; i += 1) {
  image = await evaluate(
    ws,
    `(() => {
       const imgs = [...document.querySelectorAll('img.cm-lp-image')];
       const chips = [...document.querySelectorAll('.cm-lp-image-chip')];
       return {
         count: imgs.length,
         loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
         srcs: imgs.map(i => i.getAttribute('src') ?? ''),
         alts: imgs.map(i => i.alt),
         chipTexts: chips.map(c => c.textContent),
       };
     })()`,
  );
  if (image.loaded >= 1 && image.chipTexts.length >= 1) break;
  await sleep(250);
}
// 视野内先确认 markdown 语法的那张图：真的加载出来、走 asset 协议、缺失的会降级
check(image.loaded >= 1, "库内图片真的加载出来了（markdown 语法）", JSON.stringify(image));
check(
  image.srcs.some((s) => /asset\.localhost|^asset:/.test(s)),
  "本地图片走 asset 协议地址",
  JSON.stringify(image.srcs),
);
check(image.alts.includes("图"), "图片保留了 alt 文字", JSON.stringify(image.alts));
check(
  image.chipTexts.some((t) => t.includes("缺图")),
  "指向缺失文件的图片降级成标签并显示 alt",
  JSON.stringify(image.chipTexts),
);

// ---- Obsidian wiki 语法。这段在文档后半部分，必须先滚动到可见——
// CodeMirror 只渲染视口附近的行，没渲染的内容根本不在 DOM 里。
// 阅读排版（16px/1.8）比旧版高：4 个嵌入可见时，wiki 链接行可能还在视口外
// （CM 只渲染视口附近的行）。条件里带上 wiki 链接文字，确保后面要断言的行都进了 DOM。
// 布局事实（实测）：三张 wiki 图片与 wiki 链接行在最前，其后是四个笔记嵌入容器，
// 而「整篇嵌入」渲染得很高——链接行与第 4 个容器相距超过一屏，不存在同时可见的
// 滚动位置。所以断言分两段：先停在「链接行可见」处断言图片与链接，再继续下滚
// 到「4 个容器全部渲染」处断言 transclusion。
const wikiVisible = await scrollUntil(
  ws,
  `document.querySelectorAll('.cm-lp-embed').length >= 1 &&
   (document.querySelector('.cm-content')?.textContent ?? '').includes('别名')`,
  30,
  0.3,
);
check(wikiVisible, "滚动到 wiki 图片与链接行可见");
if (wikiVisible) {
  let wikiImages = null;
  for (let i = 0; i < 30; i += 1) {
    wikiImages = await evaluate(
      ws,
      `(() => {
         const imgs = [...document.querySelectorAll('img.cm-lp-image')];
         return { count: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length };
       })()`,
    );
    if (wikiImages.loaded >= 3) break;
    await sleep(250);
  }
  check(
    wikiImages.loaded >= 3,
    "三个 wiki 嵌入都真的加载出图片（![[pic.png]] 及其带宽度/说明的写法）",
    JSON.stringify(wikiImages),
  );

  const wikiEmbedLine = await evaluate(
    ws,
    `[...document.querySelectorAll('.cm-line')].find(e => (e.innerText ?? '').includes('Wiki 嵌入'))?.innerText ?? null`,
  );
  check(
    !(wikiEmbedLine ?? "").includes("![["),
    "wiki 嵌入行的原始语法已隐藏（只剩图片）",
    JSON.stringify(wikiEmbedLine),
  );

  const visibleText = await text(ws);
  check(!visibleText.includes("[[某笔记]]"), "wiki 链接的方括号已被隐藏");
  check(visibleText.includes("某笔记") && visibleText.includes("别名"), "wiki 链接文字保留，含别名写法");

  // 继续下滚：4 个笔记嵌入容器（整篇/小节/块/错误）全部进入渲染范围
  await scrollUntil(ws, `document.querySelectorAll('.cm-lp-embed').length >= 4`, 30, 0.3);

  // 内容嵌入（transclusion）：目标笔记的内容要真的渲染进来
  let embed = null;
  for (let i = 0; i < 50; i += 1) {
    embed = await evaluate(
      ws,
      `(() => {
         const boxes = [...document.querySelectorAll('.cm-lp-embed')];
         const boxText = (target) =>
           document.querySelector('[data-embed-target="' + target + '"]')?.innerText ?? null;
         return {
           count: boxes.length,
           loading: boxes.filter(b => b.classList.contains('is-loading')).length,
           full: boxText('嵌入目标'),
           section: boxText('嵌入目标#小节甲'),
           block: boxText('嵌入目标#^blockid'),
           hasHeading: boxes.some(b => b.querySelector('h1')),
           hasTable: boxes.some(b => b.querySelector('table')),
           hasImage: boxes.some(b => b.querySelector('img')),
           errors: [...document.querySelectorAll('.cm-lp-embed-error')].map(e => e.textContent),
         };
       })()`,
    );
    if (embed.count === 4 && embed.loading === 0) break;
    await sleep(300);
  }
  check(embed.count === 4, "四处嵌入都渲染出容器", JSON.stringify({ count: embed.count }));
  check(embed.loading === 0, "嵌入内容都已加载完成");
  check(
    (embed.full ?? "").includes("这是被嵌入笔记的开头段落"),
    "整篇嵌入渲染出目标笔记的正文",
    JSON.stringify((embed.full ?? "").slice(0, 60)),
  );
  check((embed.full ?? "").includes("小节乙的内容"), "整篇嵌入包含后面小节的内容");
  check(
    (embed.section ?? "").includes("小节甲的内容") && !(embed.section ?? "").includes("小节乙的内容"),
    "只嵌入小节甲时，正好只含该小节",
    JSON.stringify((embed.section ?? "").slice(0, 60)),
  );
  check(
    (embed.block ?? "").includes("按块引用") && !(embed.block ?? "").includes("结尾段落"),
    "块引用只嵌入该段落",
    JSON.stringify((embed.block ?? "").slice(0, 60)),
  );
  check(
    embed.hasHeading && embed.hasTable && embed.hasImage,
    "嵌入内容里的标题 / 表格 / 图片都渲染出来",
    JSON.stringify({ h: embed.hasHeading, t: embed.hasTable, i: embed.hasImage }),
  );
  check(
    embed.errors.some((t) => t.includes("找不到")),
    "嵌入不存在的笔记时给出错误提示而不是崩掉",
    JSON.stringify(embed.errors),
  );
  check(visibleText.includes("![[嵌入目标]]") === false, "嵌入处的原始语法不再直接显示");

  // 该行在很高的嵌入容器之后，先滚进渲染范围再断言
  await scrollUntil(
    ws,
    `[...document.querySelectorAll('.cm-line')].some(e => (e.innerText ?? '').includes('行内代码里不算语法'))`,
    20,
    0.4,
  );
  const codeLine = await evaluate(
    ws,
    `[...document.querySelectorAll('.cm-line')].find(e => (e.innerText ?? '').includes('行内代码里不算语法'))?.innerText ?? null`,
  );
  check(
    (codeLine ?? "").includes("![[pic.png]]"),
    "行内代码里的 wiki 语法原样显示（不算语法）",
    JSON.stringify(codeLine),
  );

  // 滚回顶部，后面的交互断言依赖初始位置
  await evaluate(ws, `document.querySelector('.cm-scroller').scrollTop = 0`);
  await sleep(300);
}

// 3. 表格渲染成真正的 <table>（由 StateField 提供块级替换，插件做不到）
const table = await evaluate(
  ws,
  `(() => {
     const t = document.querySelector('table.cm-lp-table');
     if (!t) return null;
     return {
       headers: [...t.querySelectorAll('thead th')].map(e => e.textContent),
       firstDataRow: [...(t.querySelector('tbody tr')?.children ?? [])].map(td => td.textContent),
       bold: t.querySelector('tbody strong')?.textContent ?? null,
       code: t.querySelector('tbody code')?.textContent ?? null,
       link: t.querySelector('tbody .cm-lp-link')?.textContent ?? null,
       strike: t.querySelector('tbody s')?.textContent ?? null,
       align: [...t.querySelectorAll('thead th')].map(e => e.style.textAlign),
       delimiterVisible: document.querySelector('.cm-content').textContent.includes('| :--- |'),
     };
   })()`,
);
check(table !== null, "表格渲染成 <table>");
check(
  JSON.stringify(table?.headers) === JSON.stringify(["左对齐", "居中", "右对齐"]),
  "表头单元格正确",
  JSON.stringify(table?.headers),
);
check(
  JSON.stringify(table?.firstDataRow) === JSON.stringify(["粗体", "code", "链接"]),
  "数据行单元格正确（单元格内行内语法已渲染，不显示原始标记）",
  JSON.stringify(table?.firstDataRow),
);
check(
  table?.bold === "粗体" && table?.code === "code" && table?.link === "链接",
  "单元格内粗体 / 行内代码 / 链接渲染成对应元素",
  `bold=${table?.bold} code=${table?.code} link=${table?.link}`,
);
check(table?.strike === "删除", "单元格内删除线渲染成 <s>", `实际=${table?.strike}`);
check(
  JSON.stringify(table?.align) === JSON.stringify(["left", "center", "right"]),
  "列对齐方式生效",
  JSON.stringify(table?.align),
);
check(table?.delimiterVisible === false, "渲染后不再显示 `| --- |` 分隔行");

// 单击表格：保持渲染，并浮现 ＋行 / ＋列 结构按钮
const tableRect = await evaluate(
  ws,
  `(() => { const t = document.querySelector('table.cm-lp-table'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`,
);
check(tableRect !== null, "取到表格位置");
await clickAt(ws, tableRect.x, tableRect.y);
await sleep(400);
check(
  (await evaluate(ws, `document.querySelector('table.cm-lp-table') !== null`)) === true,
  "点击表格后保持渲染（不退回源码）",
);
check(
  (await evaluate(
    ws,
    `!!document.querySelector('.cm-lp-tablewrap .cm-tb-addrow') && !!document.querySelector('.cm-lp-tablewrap .cm-tb-addcol')`,
  )) === true,
  "渲染态浮现 ＋行 / ＋列 结构按钮",
);

check(await clickLine(ws, "普通项目一"), "点击表格外的行");
check(
  (await evaluate(ws, `document.querySelector('table.cm-lp-table') !== null`)) === true,
  "光标移出表格后重新渲染成表格",
);

// 底部「＋ 行」：行数 +1（tr[data-row] 由渲染组件标注）
const rowsBefore = await evaluate(
  ws,
  `document.querySelectorAll('.cm-lp-table tr[data-row]').length`,
);
await evaluate(ws, `document.querySelector('.cm-lp-tablewrap .cm-tb-addrow')?.click()`);
let rowsAfter = rowsBefore;
for (let i = 0; i < 20; i += 1) {
  await sleep(200);
  rowsAfter = await evaluate(
    ws,
    `document.querySelectorAll('.cm-lp-table tr[data-row]').length`,
  );
  if (rowsAfter === rowsBefore + 1) break;
}
check(rowsAfter === rowsBefore + 1, "底部「＋ 行」新增一行", `${rowsBefore} → ${rowsAfter}`);

// 右缘「＋ 列」：列数 +1
const colsBefore = await evaluate(
  ws,
  `document.querySelectorAll('.cm-lp-table thead th').length`,
);
await evaluate(ws, `document.querySelector('.cm-lp-tablewrap .cm-tb-addcol')?.click()`);
let colsAfter = colsBefore;
for (let i = 0; i < 20; i += 1) {
  await sleep(200);
  colsAfter = await evaluate(
    ws,
    `document.querySelectorAll('.cm-lp-table thead th').length`,
  );
  if (colsAfter === colsBefore + 1) break;
}
check(colsAfter === colsBefore + 1, "右缘「＋」新增一列", `${colsBefore} → ${colsAfter}`);

// 再双击退回源码一次，验证表格按钮/双击不破坏后续编辑
await evaluate(
  ws,
  `(() => {
     const wrap = document.querySelector('.cm-lp-tablewrap');
     if (!wrap) return false;
     const r = wrap.getBoundingClientRect();
     wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 2, clientY: r.bottom - 2 }));
     return true;
   })()`,
);
await sleep(400);

// 3.4.1 双击退回源码后的源码编辑：工具栏（下插行/删行/对齐）+ Tab 导航。
await clickAt(ws, tableRect.x, tableRect.y);
await sleep(400);
await evaluate(
  ws,
  `(() => {
     const wrap = document.querySelector('.cm-lp-tablewrap');
     if (!wrap) return false;
     const r = wrap.getBoundingClientRect();
     wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 2, clientY: r.bottom - 2 }));
     return true;
   })()`,
);
await sleep(400);
check(
  (await evaluate(ws, `!!document.querySelector('.table-toolbar')`)) === true,
  "双击进源码后出现表格工具栏",
);

/** 当前源码中以 | 开头的行（表格块）。 */
const tableLines = () =>
  evaluate(
    ws,
    `(() => {
       // .cm-line 才是逻辑行：innerText 在 pre-wrap 下把软换行也算成换行符，不能按它切分
       return [...document.querySelectorAll('.cm-line')]
         .map((l) => (l.innerText ?? '').trim())
         .filter((l) => l.startsWith('|'));
     })()`,
  );

const rowLinesBefore = await tableLines();
check(rowLinesBefore.length >= 4, "表格源码至少 4 行", JSON.stringify(rowLinesBefore.length));

// 下插行：行数 +1
await evaluate(
  ws,
  `[...document.querySelectorAll('.table-toolbar button')].find(b => b.textContent === '下插行')?.click()`,
);
await sleep(400);
const rowLinesAfter = await tableLines();
check(
  rowLinesAfter.length === rowLinesBefore.length + 1,
  "下插行后表格多一行",
  JSON.stringify(rowLinesAfter.length),
);

// 对齐：所有行的显示宽度一致（管道竖成一条直线）。
// 宽度断言只量**表头行与分隔行**：这两行没有行内标记，innerText 忠实；
// 数据行的行内标记（** ` ` []()）在光标行会被 Live Preview 隐藏，量它必然失真。
await evaluate(
  ws,
  `[...document.querySelectorAll('.table-toolbar button')].find(b => b.textContent === '对齐')?.click()`,
);
await sleep(400);
const headerDelimAligned = await evaluate(
  ws,
  `(() => {
     const width = (s) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0);
     const lines = [...document.querySelectorAll('.cm-line')]
       .map((l) => (l.innerText ?? '').trim())
       .filter((l) => l.startsWith('|'));
     if (lines.length < 2) return false;
     return width(lines[0]) === width(lines[1]);
   })()`,
);
check(headerDelimAligned === true, "对齐后表头与分隔行显示宽度一致（中文按 2 格）");

// 3.5 Mermaid 图。渲染是异步的（还要等 mermaid 的 chunk 按需加载），必须轮询。
// 阅读态排版（15px/1.7 行高）比旧版更高，第二个图在首屏外，先把图表区滚进视口。
await scrollUntil(
  ws,
  `[...document.querySelectorAll('.cm-line')].some(e => (e.innerText ?? '').includes('无效图表'))`,
  20,
  0.4,
);
await evaluate(
  ws,
  `(() => { const line = [...document.querySelectorAll('.cm-line')].find(e => e.innerText.includes('无效图表')); line?.scrollIntoView({ block: 'center' }); return !!line; })()`,
);
await sleep(300);
let mermaid = null;
for (let i = 0; i < 50; i += 1) {
  mermaid = await evaluate(
    ws,
    `(() => {
       const boxes = [...document.querySelectorAll('.cm-lp-mermaid')];
       const err = boxes.find(b => b.classList.contains('is-error'));
       return {
         boxes: boxes.length,
         svgs: boxes.filter(b => b.querySelector('svg')).length,
         loading: boxes.filter(b => b.classList.contains('is-loading')).length,
         errorText: err?.textContent ?? null,
       };
     })()`,
  );
  if (mermaid.svgs >= 1 && mermaid.loading === 0 && mermaid.errorText !== null) break;
  await sleep(300);
}
check(mermaid.boxes === 2, "两个 mermaid 块都渲染成图表容器", JSON.stringify(mermaid));
check(mermaid.svgs >= 1, "有效的流程图渲染出 SVG", JSON.stringify(mermaid));
check(mermaid.loading === 0, "没有图表卡在加载中状态", JSON.stringify(mermaid));
check(
  (mermaid.errorText ?? "").includes("图表渲染失败"),
  "无效的图定义显示错误提示而非崩溃",
  JSON.stringify(mermaid.errorText),
);
check(
  mermaid.svgs >= 1 && (mermaid.errorText ?? "") !== "",
  "一个成功一个失败，互不影响",
);
check(
  (await evaluate(ws, `document.querySelector('.banner-error') === null`)) === true,
  "图表渲染失败没有惊动编辑器（界面无报错提示条）",
);
// 渲染只是视图层，文档内容不变；但围栏不应再直接显示
check(
  (await text(ws)).includes("```mermaid") === false,
  "渲染后不再直接显示 mermaid 围栏",
);

// 收尾围栏行应被压扁（否则每个代码块底部都会多一条空行）
const heights = await evaluate(
  ws,
  `(() => {
     const fence = document.querySelector('.cm-line.cm-lp-fence');
     const code = [...document.querySelectorAll('.cm-line')].find(e => (e.innerText ?? '').includes('const answer'));
     return {
       hasFence: fence !== null,
       fence: fence?.getBoundingClientRect().height ?? null,
       code: code?.getBoundingClientRect().height ?? null,
     };
   })()`,
);
check(heights.hasFence, "收尾围栏行带压缩类");
check(
  heights.fence !== null && heights.code !== null && heights.fence < heights.code,
  "收尾围栏行高度小于代码行（空行已压掉）",
  JSON.stringify(heights),
);

// 单击图表**保持渲染**（0.3：图不该一点就消失）
await scrollUntil(
  ws,
  `[...document.querySelectorAll('.cm-line')].some(e => (e.innerText ?? '').includes('无效图表'))`,
  20,
  0.4,
);
await evaluate(
  ws,
  `(() => { const line = [...document.querySelectorAll('.cm-line')].find(e => e.innerText.includes('无效图表')); line?.scrollIntoView({ block: 'center' }); return true; })()`,
);
await sleep(300);
const diagramRect = await evaluate(
  ws,
  `(() => { const b = document.querySelector('.cm-lp-mermaid'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 12 }; })()`,
);
check(diagramRect !== null, "取到图表位置");
await clickAt(ws, diagramRect.x, diagramRect.y);
await sleep(500);
check(
  (await evaluate(ws, `document.querySelectorAll('.cm-lp-mermaid').length`)) === 2,
  "单击图表保持渲染（两个图都还在）",
);
check(
  (await text(ws)).includes("graph TD") === false,
  "单击后源码没有露出来",
);

// 双击图表：退回源码编辑
await evaluate(
  ws,
  `(() => {
     const b = document.querySelector('.cm-lp-mermaid');
     if (!b) return false;
     const r = b.getBoundingClientRect();
     b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 30, clientY: r.top + 12 }));
     return true;
   })()`,
);
await sleep(500);
check((await text(ws)).includes("graph TD"), "双击后源码可见，可编辑图定义");

// 3.6 标题点击显示源码（0.3 回归修复：# 标记曾被无条件隐藏）。
await evaluate(ws, `document.querySelector('.cm-scroller').scrollTop = 0`);
await sleep(300);
check(await clickLine(ws, "语法覆盖"), "点击一级标题行");
const h1Text = await evaluate(
  ws,
  `(() => {
     const line = [...document.querySelectorAll('.cm-line')].find(e => e.innerText.includes('语法覆盖'));
     return line?.innerText ?? '';
   })()`,
);
check(
  !h1Text.includes("#") && h1Text.includes("语法覆盖"),
  "点标题正文：标题保持渲染，`#` 不再横移（0.5 元素级激活）",
  JSON.stringify(h1Text),
);

// 4. 光标所在行显示源码。
// 注意：上面的表格交互已经把光标移走了，这里必须重新放回标题行再断言。
check(await clickLine(ws, "列表与分割线"), "把光标放到二级标题行");
const activeLine = await evaluate(
  ws,
  `document.querySelector('.cm-activeLine')?.innerText ?? null`,
);
check(
  !(activeLine ?? "").includes("##") && (activeLine ?? "").includes("列表与分割线"),
  "点二级标题正文：保持渲染、`##` 不横移（0.5 元素级激活）",
  `实际=${activeLine}`,
);
check(
  (await evaluate(ws, `document.querySelector('.cm-activeLine')?.className ?? ''`)).includes("cm-lp-h2"),
  "光标所在行仍保留标题样式",
);

// 5. 动态行为：光标移到别的行，该行应立刻退回源码
// 元素级激活：必须点进**粗体元素内部**（点行内其他位置不会让它显源码）
const strongPos = await evaluate(
  ws,
  `(() => { const s = document.querySelector('.cm-lp-strong'); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
);
if (!strongPos) throw new Error("找不到渲染态的粗体元素");
for (const type of ["mousePressed", "mouseReleased"]) {
  await cdp(ws, "Input.dispatchMouseEvent", { type, x: strongPos.x, y: strongPos.y, button: "left", clickCount: 1 });
}
await sleep(400);
check((await text(ws)).includes("**粗体**"), "点进粗体元素：该元素退回源码（`**粗体**` 可见）");
check(
  (await evaluate(ws, `document.querySelectorAll('.cm-lp-strong').length`)) === 0,
  "该元素不再有粗体样式（不能出现「看着像源码却已加粗」）",
);
// 同行的斜体/行内代码保持渲染（0.5 元素级激活：只有点进的元素显源码）
check(
  (await evaluate(ws, `document.querySelectorAll('.cm-lp-em').length`)) === 1,
  "同行的斜体照常渲染（不再整行退回源码）",
);
check(
  (await evaluate(ws, `(() => {
     const line = [...document.querySelectorAll('.cm-line')].find(e => (e.innerText ?? '').includes('粗体'));
     return line ? line.querySelectorAll('.cm-lp-code').length : -1;
   })()`)) === 1,
  "同行的行内代码照常渲染",
);

check(await clickLine(ws, "普通项目一"), "点击中性位置（表格已渲染，不能再按源码行定位）");
check(!(await text(ws)).includes("**粗体**"), "光标移开后该行重新渲染");

// 6. 模式切换
await evaluate(ws, `[...document.querySelectorAll('.seg')].find(b => b.textContent.includes('源码')).click()`);
await sleep(400);
check((await text(ws)).includes("**粗体**"), "切到源码模式后可见 `**粗体**`");
check(
  (await evaluate(ws, `document.querySelectorAll('.cm-lp-strong').length`)) === 0,
  "源码模式下装饰全部撤除",
);

await evaluate(ws, `[...document.querySelectorAll('.seg')].find(b => b.textContent.includes('实时')).click()`);
await sleep(400);
check(!(await text(ws)).includes("**粗体**"), "切回 Live Preview 后 `**` 再次隐藏");
check((await evaluate(ws, `document.querySelectorAll('.cm-lp-strong').length`)) > 0, "切回后样式装饰恢复");

// 6.5 滚动到文末：视口变化应触发装饰重建。
// 这里只断言装饰类名，不点击——文末行在 720px 窗口里位于视口边缘，
// 点击坐标不可靠（实测 y≈793 会落到窗口外）。
//
// 必须**渐进滚动**而不是一次性 scrollTop=1e6：CM6 对未渲染区域的高度是估算值，
// 且 mermaid/嵌入 widget 离开视口再进入时会重建（高度先塌成占位再长回来），
// 浏览器的滚动锚定会随之拉回 scrollTop——大幅跳跃与它互相拉扯，实测偶发
// 到不了底。渐进滚动（scrollUntil）每步等渲染稳定，widget 高度逐步落定。
const quoteFound = await scrollUntil(
  ws,
  `!!document.querySelector('.cm-line.cm-lp-quote')`,
  30,
  0.7,
);
if (!quoteFound) {
  const diag = await evaluate(
    ws,
    `(() => {
       const s = document.querySelector('.cm-scroller');
       const lines = [...document.querySelectorAll('.cm-line')];
       return {
         scrollTop: Math.round(s.scrollTop),
         max: Math.round(s.scrollHeight - s.clientHeight),
         rendered: lines.length,
         last3: lines.slice(-3).map((l) => (l.innerText || '').slice(0, 16)),
       };
     })()`,
  );
  console.log("  滚动诊断：", JSON.stringify(diag));
}
// 按类名找，不能按"引用块"这三个字找——嵌入内容里也有"被嵌入的引用块"，
// 文字匹配会命中嵌入容器而不是真正的引用行。
const readQuote = () =>
  evaluate(
    ws,
    `(() => {
       const line = document.querySelector('.cm-line.cm-lp-quote');
       return line ? { cls: line.className, text: line.innerText } : null;
     })()`,
  );
// scrollUntil 判定成功后装饰仍可能处于重建窗口，读几轮取稳定值
let quote = null;
for (let i = 0; i < 5 && !quote; i += 1) {
  quote = await readQuote();
  if (!quote) await sleep(350);
}
check(quote !== null, "滚动后文末的引用行进入渲染范围");
check(
  (quote?.cls ?? "").includes("cm-lp-quote"),
  "滚动后引用行仍有引用样式（视口变化后装饰重建正确）",
  JSON.stringify(quote),
);
check(!(quote?.text ?? "").includes(">"), "引用行的 `>` 仍处于隐藏态");
await evaluate(ws, `document.querySelector('.cm-scroller').scrollTop = 0`);
await sleep(300);

// 7. 点击复选框应改写源码并落盘。
// 断言「状态发生翻转」而不是「变成勾选」，这样脚本可重复运行（幂等）。
const before = readFileSync(filePath, "utf8");
const initialStates = await evaluate(ws, `[...document.querySelectorAll('input.cm-lp-task')].map(b => b.checked)`);
check(initialStates.length === 2, "读到两个复选框的初始状态", JSON.stringify(initialStates));
const expectedMarker = initialStates[0] ? "- [ ] 未完成任务" : "- [x] 未完成任务";

const boxRect = await evaluate(
  ws,
  `(() => { const b = document.querySelector('input.cm-lp-task'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
);
check(boxRect !== null, "取到复选框位置");
await clickAt(ws, boxRect.x, boxRect.y);
await sleep(300);

const afterStates = await evaluate(ws, `[...document.querySelectorAll('input.cm-lp-task')].map(b => b.checked)`);
check(
  afterStates[0] === !initialStates[0] && afterStates[1] === initialStates[1],
  "只有被点击的那个复选框翻转了",
  JSON.stringify(afterStates),
);

console.log("  等待自动保存…");
// 必须先等内容真正变化再断言，否则会读到旧内容造成假阳性。
let after = before;
for (let i = 0; i < 25; i += 1) {
  await sleep(400);
  after = readFileSync(filePath, "utf8");
  if (after !== before && after.includes(expectedMarker)) break;
}
check(after !== before, "文件内容确实发生了变化");
check(after.includes(expectedMarker), `点击结果已写入文件（期望 ${expectedMarker}）`);
check(after.includes("- [x] 已完成任务"), "其他任务项未被破坏");
check(after.includes("```ts"), "代码块围栏在源码中原样保留（渲染只是视图层）");

// 8. 表格：数据行的就地编辑写回**该行**，不覆盖其他行
//（data-row 写死为 1 的回归断言：曾让编辑任何数据行都写到第一行）。
{
  const beforeTable = readFileSync(filePath, "utf8");
  // 按渲染后的 <td> 定位（正文里"~~删除线~~"那段也含"删除"，按行文字找会点错行）。
  // 滚动后必须等 CM 视口重渲染稳定，再**重新读取**坐标——scrollIntoView 触发的
  // 重渲染会替换 DOM 节点，滚动前后坐标可能对不上（点错宿主会把整表替换掉）。
  // 点击后验证焦点真的落在单元格上，没落上就重取坐标重试。
  const clickCell = async (needle) => {
    await evaluate(
      ws,
      `(() => {
         const td = [...document.querySelectorAll('.cm-lp-tablewrap td, .cm-lp-tablewrap th')]
           .find((c) => (c.textContent ?? '').includes(${JSON.stringify(needle)}));
         td?.scrollIntoView({ block: 'center' });
         return !!td;
       })()`,
    );
    await sleep(500);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cellRect = await evaluate(
        ws,
        `(() => {
           const td = [...document.querySelectorAll('.cm-lp-tablewrap td, .cm-lp-tablewrap th')]
             .find((c) => (c.textContent ?? '').includes(${JSON.stringify(needle)}));
           if (!td) return null;
           const r = td.getBoundingClientRect();
           return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
         })()`,
      );
      if (!cellRect) return false;
      await clickAt(ws, cellRect.x, cellRect.y);
      await sleep(300);
      const ok = await evaluate(
        ws,
        `(() => {
           const el = document.activeElement;
           return el?.tagName === 'TD' || el?.tagName === 'TH';
         })()`,
      );
      if (ok) return true;
    }
    return false;
  };

  check(await clickCell("删除"), "点击后焦点落在单元格上（而不是表格宿主）");
  // 只圈选**本格**内容再输入才是"覆盖"（与 Tab 跳格后的行为一致）。
  // 不用 execCommand("selectAll")：焦点若在表格宿主上，它会选中整张表。
  await evaluate(
    ws,
    `(() => {
       const el = document.activeElement;
       const range = document.createRange();
       range.selectNodeContents(el);
       const selection = window.getSelection();
       selection.removeAllRanges();
       selection.addRange(range);
       return true;
     })()`,
  );
  await cdp(ws, "Input.insertText", { text: "新值" });
  await sleep(300);
  // Enter 提交（下方有格则跳格）
  await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  console.log("  等待自动保存…");
  let afterTable = beforeTable;
  for (let i = 0; i < 25; i += 1) {
    await sleep(400);
    afterTable = readFileSync(filePath, "utf8");
    if (afterTable.includes("| 新值 |")) break;
  }
  check(afterTable !== beforeTable, "表格单元格编辑写回了文件");
  // 提交走 formatTable 重新对齐（对齐补空格、右对齐尾冒号），不按字面匹配。
  // 回归信号：编辑落在所点的行（该行有 普通 和 1），而不是别的行/覆盖了别的行。
  const editedRow = afterTable.split("\n").find((l) => l.includes("新值"));
  check(
    editedRow !== undefined && editedRow.includes("普通") && /\|\s*1\s*\|/.test(editedRow),
    "编辑落在所点的数据行（不覆盖其他行）",
    editedRow ?? "",
  );
  check(afterTable.includes("| **粗体** | `code` |"), "其他数据行内容原样");

  // 8.5 Ctrl+A 两段式全选：第一次选本格，第二次升级为整张表
  {
    check(await clickCell("普通"), "点击后焦点落在单元格上（而不是表格宿主）");
    // 第一次 Ctrl+A：全选本格
    // CDP 的修饰键用 modifiers 位掩码（Ctrl=2）；`control: true` 不是有效参数
    await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(200);
    const first = await evaluate(
      ws,
      `(() => { const s = window.getSelection(); return s ? s.toString() : ""; })()`,
    );
    check(first.trim() === "普通", "第一次 Ctrl+A 只选本格内容", JSON.stringify(first));
    // 第二次 Ctrl+A：整张表
    // CDP 的修饰键用 modifiers 位掩码（Ctrl=2）；`control: true` 不是有效参数
    await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(200);
    const second = await evaluate(
      ws,
      `(() => { const s = window.getSelection(); return s ? s.toString() : ""; })()`,
    );
    check(
      second.includes("左对齐") && second.includes("普通"),
      "第二次 Ctrl+A 选中整张表",
      JSON.stringify(second.slice(0, 60)),
    );
  }

  // 9. 粘贴转换：真表格（HTML <table>）才转 Markdown 表格，纯文本（含 TSV）原样粘贴
  const pre = afterTable;
  await clickLine(ws, "语法覆盖");
  await cdp(ws, "Input.insertText", { text: "\n" });
  await sleep(200);
  await evaluate(
    ws,
    `(() => {
       const data = new DataTransfer();
       data.setData("text/plain", "名称\\t数量\\n苹果\\t3");
       document.querySelector(".cm-content").dispatchEvent(
         new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
       );
       return true;
     })()`,
  );
  await sleep(600);
  console.log("  等待自动保存…");
  let afterPaste = pre;
  for (let i = 0; i < 25; i += 1) {
    await sleep(400);
    afterPaste = readFileSync(filePath, "utf8");
    if (afterPaste.includes("苹果\t3")) break;
  }
  check(
    afterPaste.includes("名称\t数量") &&
      afterPaste.includes("苹果\t3") &&
      !afterPaste.includes("| 名称 | 数量 |"),
    "TSV 粘贴保持纯文本（不再自动转表格）",
  );

  // 9b. 剪贴板带 HTML <table>（Excel/网页复制都带）时仍然转成 Markdown 表格
  await evaluate(
    ws,
    `(() => {
       const data = new DataTransfer();
       data.setData("text/html", "<table><tr><th>名称</th><th>数量</th></tr><tr><td>香蕉</td><td>5</td></tr></table>");
       document.querySelector(".cm-content").dispatchEvent(
         new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
       );
       return true;
     })()`,
  );
  await sleep(600);
  let afterHtmlPaste = afterPaste;
  for (let i = 0; i < 25; i += 1) {
    await sleep(400);
    afterHtmlPaste = readFileSync(filePath, "utf8");
    if (afterHtmlPaste.includes("| 香蕉 | 5 |")) break;
  }
  check(
    afterHtmlPaste.includes("| 名称 | 数量 |") && afterHtmlPaste.includes("| 香蕉 | 5 |"),
    "HTML 表格粘贴自动转成 Markdown 表格",
  );

  // 10. CRLF 剪贴板文本粘贴规范化为文档换行符，不留裸 \r
  //（basicSetup 会给裸 \r 画红色角标；fixtures 里有现成的"第二行。"文案，
  //  所以标记词用不冲突的"CR甲行/CR乙行"）
  await evaluate(
    ws,
    `(() => {
       const data = new DataTransfer();
       data.setData("text/plain", "CR甲行\\r\\nCR乙行");
       document.querySelector(".cm-content").dispatchEvent(
         new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
       );
       return true;
     })()`,
  );
  await sleep(600);
  console.log("  等待自动保存…");
  let afterCr = afterPaste;
  for (let i = 0; i < 25; i += 1) {
    await sleep(400);
    afterCr = readFileSync(filePath, "utf8");
    if (afterCr.includes("CR甲行") && afterCr.includes("CR乙行")) break;
  }
  const markerLines = afterCr
    .split("\n")
    .filter((l) => l.includes("CR甲行") || l.includes("CR乙行"));
  check(
    markerLines.length === 2 && markerLines.every((l) => !l.includes("\r")),
    "CRLF 剪贴板粘贴规范化为文档换行符（无裸 CR）",
    JSON.stringify(markerLines),
  );
}

ws.close();
console.log(failures === 0 ? "\nLive Preview GUI 验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

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
async function scrollUntil(ws, expression, maxSteps = 16) {
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
const wikiVisible = await scrollUntil(ws, `document.querySelectorAll('.cm-lp-embed').length >= 4`);
check(wikiVisible, "滚动到内容嵌入可见（4 个容器已渲染）");
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

// 点击表格应切回可编辑的源码
const tableRect = await evaluate(
  ws,
  `(() => { const t = document.querySelector('table.cm-lp-table'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`,
);
check(tableRect !== null, "取到表格位置");
await clickAt(ws, tableRect.x, tableRect.y);
await sleep(400);
check(
  (await evaluate(ws, `document.querySelector('table.cm-lp-table') === null`)) === true,
  "点击表格后切回源码可编辑",
);
check((await text(ws)).includes("| :--- |"), "源码中可见表格分隔行");

check(await clickLine(ws, "普通项目一"), "点击表格外的行");
check(
  (await evaluate(ws, `document.querySelector('table.cm-lp-table') !== null`)) === true,
  "光标移出表格后重新渲染成表格",
);

// 3.5 Mermaid 图。渲染是异步的（还要等 mermaid 的 chunk 按需加载），必须轮询。
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

// 点击图表应切回源码编辑
await evaluate(ws, `document.querySelector('.cm-scroller').scrollTop = 0`);
await sleep(300);
const diagramRect = await evaluate(
  ws,
  `(() => { const b = document.querySelector('.cm-lp-mermaid'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 12 }; })()`,
);
check(diagramRect !== null, "取到图表位置");
await clickAt(ws, diagramRect.x, diagramRect.y);
await sleep(500);
check(
  (await evaluate(ws, `document.querySelectorAll('.cm-lp-mermaid').length`)) === 1,
  "点击后该图退回源码，另一个仍是图",
);
check((await text(ws)).includes("graph TD"), "源码中可见图定义");

// 4. 光标所在行显示源码。
// 注意：上面的表格交互已经把光标移走了，这里必须重新放回标题行再断言。
check(await clickLine(ws, "列表与分割线"), "把光标放到二级标题行");
const activeLine = await evaluate(
  ws,
  `document.querySelector('.cm-activeLine')?.innerText ?? null`,
);
check(
  (activeLine ?? "").includes("## 列表与分割线"),
  "光标所在行显示源码（二级标题可见 `##`）",
  `实际=${activeLine}`,
);
check(
  (await evaluate(ws, `document.querySelector('.cm-activeLine')?.className ?? ''`)).includes("cm-lp-h2"),
  "光标所在行仍保留标题样式",
);

// 5. 动态行为：光标移到别的行，该行应立刻退回源码
check(await clickLine(ws, "粗体"), "点击「粗体」所在行");
check((await text(ws)).includes("**粗体**"), "该行立刻退回源码（`**粗体**` 可见）");
check(
  (await evaluate(ws, `document.querySelectorAll('.cm-lp-strong').length`)) === 0,
  "该行不再有粗体样式（不能出现「看着像源码却已加粗」）",
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

await evaluate(ws, `[...document.querySelectorAll('.seg')].find(b => b.textContent.includes('Live Preview')).click()`);
await sleep(400);
check(!(await text(ws)).includes("**粗体**"), "切回 Live Preview 后 `**` 再次隐藏");
check((await evaluate(ws, `document.querySelectorAll('.cm-lp-strong').length`)) > 0, "切回后样式装饰恢复");

// 6.5 滚动到文末：视口变化应触发装饰重建。
// 这里只断言装饰类名，不点击——文末行在 720px 窗口里位于视口边缘，
// 点击坐标不可靠（实测 y≈793 会落到窗口外）。
await evaluate(ws, `document.querySelector('.cm-scroller').scrollTop = 1e6`);
await sleep(500);
// 按类名找，不能按"引用块"这三个字找——嵌入内容里也有"被嵌入的引用块"，
// 文字匹配会命中嵌入容器而不是真正的引用行。
const quote = await evaluate(
  ws,
  `(() => {
     const line = document.querySelector('.cm-line.cm-lp-quote');
     return line ? { cls: line.className, text: line.innerText } : null;
   })()`,
);
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

ws.close();
console.log(failures === 0 ? "\nLive Preview GUI 验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

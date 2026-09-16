/**
 * Live Preview 装饰层——Obsidian 式「富文本」观感的实现。
 *
 * 核心机制：文档缓冲区始终是 Markdown 原文，装饰层只做两件事——
 *   1. 用 `Decoration.replace` 把语法标记（`**`、`#`、`` ` ``、`](url)` 等）藏起来；
 *   2. 用 `Decoration.mark` / `Decoration.line` 给内容加样式。
 *
 * 光标所在的那一行（或选区覆盖到的行）不做隐藏，直接显示源码，方便就地修改语法。
 *
 * 之所以把 `buildLivePreviewDecorations` 写成不依赖 EditorView 的纯函数：
 * 装饰计算是这套方案里最容易出错的部分，纯函数可以直接在 Node 里单测，
 * 不必启动 GUI。见 scripts/verify-livepreview.mjs。
 *
 * 节点名不是猜的，来自 `node scripts/dump-markdown-tree.mjs` 的实际输出。
 */

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { EditorState, Range } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { convertFileSrc } from "@tauri-apps/api/core";
import { insertColumn, insertRow, parseTableBlock, type TableBlock } from "./table.ts";
import { renderEmbeddedNote } from "./embed.ts";
import {
  findComments,
  findHighlights,
  findInlineHtml,
  findInlineMath,
  findTags,
  parseCalloutLine,
} from "./inlineSyntax.ts";
import { CalloutLabelWidget, HtmlWidget, isExternalUrl, mathWidgetFor } from "./markdownExtras.ts";
import {
  EMPTY_CONTEXT,
  IMAGE_EXT,
  livePreviewContext,
  resolveResource,
  resolveWikiTarget,
  type LivePreviewContext,
} from "./paths.ts";
/** 单元格里的一段文字及其行内样式。

    把嵌套样式拍平成「带标记的文本段」，好处是可直接序列化，widget 的 eq 比较
    只需比 JSON，不必处理 DOM 树。 */
interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
}

const EMPTY_FLAGS = { bold: false, italic: false, strike: false, code: false, link: false };

/** 表格解析结果。rows 是三层结构：行 → 单元格 → 文本段；raw 是单元格的原文。 */
interface ParsedTable {
  rows: TextRun[][][];
  align: (null | "left" | "center" | "right")[];
  /** 每个单元格的**原文**（渲染态就地编辑写回时用）。 */
  raw: string[][];
  /** 分隔行的原文（写回时原样保留用户的对齐标记与间距）。 */
  delimiterLine: string;
}

/**
 * 把一个语法节点的内容拍平成带样式的文本段。
 *
 * 行内标记节点（名字以 Mark 结尾的，如 EmphasisMark / CodeMark）只是定界符，
 * 跳过即可——标记之间的正文在语法树里没有独立节点，靠位置差取出。
 */
function flattenInline(
  state: EditorState,
  parent: SyntaxNode,
  flags: Omit<TextRun, "text">,
): TextRun[] {
  const doc = state.doc;
  const runs: TextRun[] = [];
  let pos = parent.from;

  const push = (text: string) => {
    if (text) runs.push({ text, ...flags });
  };

  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.name.endsWith("Mark")) {
      // 定界符：先把它之前的正文取出，再跳过它。
      // 必须推进 pos——否则循环结束后 `pos < parent.to` 会把整段（含标记）
      // 当成一段文本推出去，表现为单元格里显示 `**粗体**`。
      if (child.from > pos) push(doc.sliceString(pos, child.from));
      pos = child.to;
      continue;
    }
    if (child.from > pos) push(doc.sliceString(pos, child.from));

    switch (child.name) {
      case "StrongEmphasis":
        runs.push(...flattenInline(state, child, { ...flags, bold: true }));
        break;
      case "Emphasis":
        runs.push(...flattenInline(state, child, { ...flags, italic: true }));
        break;
      case "Strikethrough":
        runs.push(...flattenInline(state, child, { ...flags, strike: true }));
        break;
      case "InlineCode":
        runs.push(...flattenInline(state, child, { ...flags, code: true }));
        break;
      case "Link": {
        // 链接只取可见文字，丢掉 `](url)`。
        const open = child.firstChild;
        const close = open?.nextSibling;
        const text =
          open && close
            ? doc.sliceString(open.to, close.from)
            : doc.sliceString(child.from, child.to);
        runs.push({ text, ...flags, link: true });
        break;
      }
      default:
        if (child.firstChild) runs.push(...flattenInline(state, child, flags));
        else push(doc.sliceString(child.from, child.to));
    }
    pos = child.to;
  }

  if (pos < parent.to) push(doc.sliceString(pos, parent.to));
  return runs;
}

/** 把文本段渲染进一个元素。 */
function appendRuns(target: HTMLElement, runs: TextRun[]): void {
  for (const run of runs) {
    let node: Node;
    if (run.code) {
      const code = document.createElement("code");
      code.className = "cm-lp-code";
      code.textContent = run.text;
      node = code;
    } else if (run.link) {
      const link = document.createElement("span");
      link.className = "cm-lp-link";
      link.textContent = run.text;
      node = link;
    } else {
      node = document.createTextNode(run.text);
    }

    if (run.strike) {
      const el = document.createElement("s");
      el.appendChild(node);
      node = el;
    }
    if (run.italic) {
      const el = document.createElement("em");
      el.appendChild(node);
      node = el;
    }
    if (run.bold) {
      const el = document.createElement("strong");
      el.appendChild(node);
      node = el;
    }
    target.appendChild(node);
  }
}

/** 隐藏语法标记。 */
const HIDE = Decoration.replace({});

const LINE_CLASS: Record<number, Decoration> = {
  1: Decoration.line({ class: "cm-lp-heading cm-lp-h1" }),
  2: Decoration.line({ class: "cm-lp-heading cm-lp-h2" }),
  3: Decoration.line({ class: "cm-lp-heading cm-lp-h3" }),
  4: Decoration.line({ class: "cm-lp-heading cm-lp-h4" }),
  5: Decoration.line({ class: "cm-lp-heading cm-lp-h5" }),
  6: Decoration.line({ class: "cm-lp-heading cm-lp-h6" }),
};

const MARK = {
  strong: Decoration.mark({ class: "cm-lp-strong" }),
  em: Decoration.mark({ class: "cm-lp-em" }),
  strike: Decoration.mark({ class: "cm-lp-strike" }),
  code: Decoration.mark({ class: "cm-lp-code" }),
  link: Decoration.mark({ class: "cm-lp-link" }),
  highlight: Decoration.mark({ class: "cm-lp-highlight" }),
};

/** 行内「语法标记 + 内容」型节点的样式映射。 */
const INLINE_MARKS: Record<string, Decoration> = {
  StrongEmphasis: MARK.strong,
  Emphasis: MARK.em,
  Strikethrough: MARK.strike,
  InlineCode: MARK.code,
};

// ---------------------------------------------------------------- 小部件
//
// 注意：这里不能用 TypeScript 的「参数属性」写法（`constructor(readonly x: T)`）。
// 测试脚本用 Node 的类型擦除直接加载本文件，而参数属性需要生成赋值代码，
// 不属于可擦除语法，会导致加载失败。tsconfig 里的 erasableSyntaxOnly 会守住这条。

/** 任务清单复选框：点击直接改写源码里的 `[ ]` / `[x]`。 */
class TaskCheckboxWidget extends WidgetType {
  readonly checked: boolean;
  readonly from: number;
  readonly to: number;

  constructor(checked: boolean, from: number, to: number) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    // 阻止 mousedown 的默认行为即可，避免光标被移到本行（否则本行会退回源码、
    // 复选框消失）；但**不能**阻止 click，否则浏览器不会切换勾选状态。
    box.addEventListener("mousedown", (event) => event.preventDefault());
    // 由浏览器完成切换，再把结果写回源码。比自己在 click 里翻转更可靠。
    box.addEventListener("change", () => {
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: box.checked ? "[x]" : "[ ]" },
      });
    });
    return box;
  }
}

/** 无序列表的项目符号：把 `-` / `*` / `+` 显示成圆点。 */
class BulletWidget extends WidgetType {
  eq(other: BulletWidget) {
    return other instanceof BulletWidget;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
}

/** 分割线。 */
class RuleWidget extends WidgetType {
  eq(other: RuleWidget) {
    return other instanceof RuleWidget;
  }
  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-lp-rule";
    return hr;
  }
}

/** 围栏代码块的语言标签。 */
class CodeInfoWidget extends WidgetType {
  readonly info: string;

  constructor(info: string) {
    super();
    this.info = info;
  }

  eq(other: CodeInfoWidget) {
    return other.info === this.info;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-codeinfo";
    span.textContent = this.info;
    return span;
  }
}

/** Mermaid 的渲染入口（只用到这两个方法，不必依赖它的完整类型定义）。 */
interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

/**
 * mermaid 按需加载。
 *
 * mermaid 是个很重的库（含全部图表类型），绝不能进主包——`import()` 会让打包器
 * 把它切成独立 chunk，只有文档里真的出现 mermaid 围栏块时才加载。
 * 加载后常驻内存（不重复加载），这一点接受。
 */
let mermaidLoader: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((mod) => {
      const mermaid = (mod as unknown as { default: MermaidApi }).default;
      mermaid.initialize({
        startOnLoad: false,
        // strict 会清洗标签里的 HTML/事件处理器。绝不要用 loose——
        // 笔记内容可能来自别处，loose 等于允许注入。
        securityLevel: "strict",
        theme: "neutral",
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

/** 已渲染 SVG 的缓存，避免同一张图反复解析渲染。简单的先进先出淘汰。 */
const svgCache = new Map<string, string>();
const SVG_CACHE_LIMIT = 30;
let mermaidSeq = 0;

/**
 * 判断一个围栏代码块是否为 mermaid 图，是则返回图定义源码。
 *
 * 插件与 StateField 共用这个判断，避免两处各写一份而出现不一致。
 */
function mermaidCode(state: EditorState, fenced: SyntaxNode): string | null {
  let info: string | null = null;
  let code = "";
  for (let child = fenced.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeInfo") {
      info = state.doc.sliceString(child.from, child.to).trim().toLowerCase();
    } else if (child.name === "CodeText") {
      code = state.doc.sliceString(child.from, child.to);
    }
  }
  return info === "mermaid" ? code : null;
}

/**
 * 把 mermaid 围栏块渲染成图。
 *
 * mermaid 的渲染是异步的，而 widget 的 toDOM 是同步的，所以先占位、后填充。
 * 渲染失败不能让编辑器崩掉——错误信息显示在占位框里，源码仍在（点一下即可编辑）。
 */
class MermaidWidget extends WidgetType {
  readonly code: string;
  readonly from: number;
  readonly to: number;

  constructor(code: string, from: number, to: number) {
    super();
    this.code = code;
    this.from = from;
    this.to = to;
  }

  eq(other: MermaidWidget) {
    return other.code === this.code && other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-lp-mermaid";
    box.title = "双击编辑源码";
    // 单击保持渲染（0.3：与表格一致——图不该一点就消失）。
    // 双击才把光标放进围栏块，退回源码编辑。
    box.addEventListener("dblclick", (event) => {
      event.preventDefault();
      view.dispatch({
        selection: { anchor: Math.min(this.from + 1, view.state.doc.length) },
      });
      view.focus();
    });

    const cached = svgCache.get(this.code);
    if (cached) {
      box.innerHTML = cached;
      return box;
    }

    box.textContent = "图表渲染中…";
    box.classList.add("is-loading");

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(`qn-mermaid-${(mermaidSeq += 1)}`, this.code);
        svgCache.set(this.code, svg);
        if (svgCache.size > SVG_CACHE_LIMIT) {
          const oldest = svgCache.keys().next();
          if (!oldest.done) svgCache.delete(oldest.value);
        }
        // widget 可能已被替换/移除，此时写入不影响任何可见内容。
        box.classList.remove("is-loading");
        box.innerHTML = svg;
      } catch (error) {
        box.classList.remove("is-loading");
        box.classList.add("is-error");
        const message = error instanceof Error ? error.message : String(error);
        box.textContent = `图表渲染失败：${message.split("\n")[0]}`;
      }
    })();

    return box;
  }
}

/**
 * 表格渲染成真正的 `<table>`，并且**点击保持渲染**（Obsidian 式，0.3）。
 *
 * 单击单元格不再退回源码，而是保持渲染，并在表格上浮现两个结构按钮：
 * 底部「＋ 行」追加一行、右缘「＋」追加一列——点击直接对文档做整块结构替换
 * （走 table.ts 的 insertRow / insertColumn），widget 随新内容重新渲染。
 * 不做"单元格内直接输入"：contenteditable 与 CM 的选区管理互相打架
 * （焦点会被 CM 抢回 contentDOM，输入丢字），编辑单元格内容的入口是
 * **双击**退回源码——那里有工具栏与管道对齐，编辑体验反而更稳。
 *
 * 单元格按“肉眼可见的管道”解析，转义 `\|` 与行内代码里的 `|` 不支持——与
 * Obsidian 的表格编辑器同一条边界。
 */
class TableWidget extends WidgetType {
  readonly rows: TextRun[][][];
  readonly align: (null | "left" | "center" | "right")[];
  readonly from: number;
  readonly to: number;

  constructor(
    rows: TextRun[][][],
    align: (null | "left" | "center" | "right")[],
    from: number,
    to: number,
  ) {
    super();
    this.rows = rows;
    this.align = align;
    this.from = from;
    this.to = to;
  }

  eq(other: TableWidget) {
    return (
      other.from === this.from &&
      other.to === this.to &&
      JSON.stringify(other.rows) === JSON.stringify(this.rows) &&
      JSON.stringify(other.align) === JSON.stringify(this.align)
    );
  }

  toDOM(view: EditorView) {
    console.info("[qn-tbl] toDOM from=", this.from, "cols=", this.rows[0]?.length, "to=", this.to);
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-tablewrap";

    const table = document.createElement("table");
    table.className = "cm-lp-table";

    // 列数取"分隔行管道段数"与各行单元格数的最大值：
    // lezer 对**只含空格的末尾单元格**不产出 TableCell 节点——不加这一步，
    // 「＋ 列」新加的空列会在渲染里隐形（实测 th 一直是 3）。
    const columnCount = Math.max(
      this.align.length,
      ...this.rows.map((row) => row.length),
      1,
    );

    const buildRow = (cells: TextRun[][], cellTag: "th" | "td", rowIndex: number) => {
      const tr = document.createElement("tr");
      tr.dataset.row = String(rowIndex);
      for (let index = 0; index < columnCount; index += 1) {
        const el = document.createElement(cellTag);
        const runs = cells[index];
        if (runs) appendRuns(el, runs);
        const align = this.align[index];
        if (align) el.style.textAlign = align;
        tr.appendChild(el);
      }
      return tr;
    };

    if (this.rows.length > 0) {
      const thead = document.createElement("thead");
      thead.appendChild(buildRow(this.rows[0], "th", 0));
      table.appendChild(thead);

      if (this.rows.length > 1) {
        const tbody = document.createElement("tbody");
        for (const row of this.rows.slice(1)) tbody.appendChild(buildRow(row, "td", 1));
        table.appendChild(tbody);
      }
    }

    // 单击保持渲染：不把光标放进源码（0.3 之前点击即退回源码，图/表都会消失）
    table.addEventListener("mousedown", (event) => {
      console.info("[qn-tbl] mousedown on", (event.target as HTMLElement).tagName);
      event.preventDefault();
    });

    // 双击单元格之外的空白退回源码（进阶编辑入口）；
    // 单元格内的双击是原生选词，不触发
    wrap.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest("td,th")) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      view.dispatch({
        selection: { anchor: Math.min(this.from + 1, view.state.doc.length) },
      });
      view.focus();
    });

    wrap.appendChild(table);

    // 底部「＋ 行」/ 右缘「＋ 列」：点击行为走 document 级委托
    // （见 ensureTableOpsDelegate）——按钮会随 widget 重建，挂自身不可靠。
    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "cm-tb-addrow";
    addRow.textContent = "＋ 行";
    addRow.title = "在末尾添加一行";
    addRow.addEventListener("mousedown", (event) => event.preventDefault());
    wrap.appendChild(addRow);

    const addCol = document.createElement("button");
    addCol.type = "button";
    addCol.className = "cm-tb-addcol";
    addCol.textContent = "＋";
    addCol.title = "在末尾添加一列";
    addCol.addEventListener("mousedown", (event) => event.preventDefault());
    wrap.appendChild(addCol);

    ensureTableOpsDelegate();
    tableOps.set(wrap, { view, from: this.from });

    return wrap;
  }
}

/**
 * 表格结构按钮的注册表与 document 级委托。
 *
 * 按钮的 click 监听**不**挂在按钮自身：widget 在结构变化后会整体重建，
 * "重建与点击的竞态"下按钮处理函数会丢事件（实测 +列 按钮点到旧 DOM 的
 * 克隆时处理函数根本不触发）。委托到 document 一份，按钮怎么重建都能命中。
 */
const tableOps = new WeakMap<HTMLElement, { view: EditorView; from: number }>();
let tableOpsDelegateInstalled = false;

function ensureTableOpsDelegate(): void {
  if (tableOpsDelegateInstalled || typeof document === "undefined") return;
  tableOpsDelegateInstalled = true;
  console.info("[qn-tbl] delegate installed");
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const addRowBtn = target.closest(".cm-tb-addrow");
    const addColBtn = target.closest(".cm-tb-addcol");
    if (!addRowBtn && !addColBtn) return;
    const btn = (addRowBtn ?? addColBtn) as HTMLElement;
    const wrap = btn.closest(".cm-lp-tablewrap") as HTMLElement | null;
    const info = wrap ? tableOps.get(wrap) : undefined;
    console.info("[qn-tbl] delegate click, addRow=", !!addRowBtn, "addCol=", !!addColBtn, "info=", !!info);
    if (!info) return;
    event.stopPropagation();
    if (addRowBtn) {
      withWidgetBlock(info.view, info.from, (block) =>
        insertRow(block, block.rows.length - 1, []),
      );
    } else {
      withWidgetBlock(info.view, info.from, (block) =>
        insertColumn(block, block.header.length),
      );
    }
  });
}

/** 对 widget 覆盖的表格块执行一次结构变换（整块替换，保留换行符风格）。 */
function withWidgetBlock(
  view: EditorView,
  from: number,
  transform: (block: TableBlock) => string[],
): void {
  const first = view.state.doc.lineAt(from);
  let last = first;
  for (;;) {
    const next = view.state.doc.line(last.number + 1);
    if (next.number === last.number || !isTableLineText(next.text)) break;
    last = next;
  }
  const lines: string[] = [];
  for (let n = first.number; n <= last.number; n += 1) lines.push(view.state.doc.line(n).text);
  const block = parseTableBlock(lines);
  console.info("[qn-tbl] withWidgetBlock lines=", lines.length, "block=", !!block);
  if (!block) return;
  const newLines = transform(block);
  console.info("[qn-tbl] dispatch newLines=", newLines.length, "first=", first.from, "last=", last.to);
  try {
    view.dispatch({
      changes: { from: first.from, to: last.to, insert: newLines.join(view.state.lineBreak) },
    });
    console.info("[qn-tbl] dispatched OK, doc lines now=", view.state.doc.lines);
  } catch (e) {
    console.info("[qn-tbl] DISPATCH THREW:", String(e));
    throw e;
  }
}

function isTableLineText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

/** 从 Table 语法节点提取表格内容与对齐方式。 */
function parseTable(state: EditorState, table: SyntaxNode): ParsedTable {
  const rows: TextRun[][][] = [];
  const raw: string[][] = [];
  let align: (null | "left" | "center" | "right")[] = [];
  let delimiterLine = "";

  const cellsOf = (parent: SyntaxNode): TextRun[][] => {
    const out: TextRun[][] = [];
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.name === "TableCell") {
        out.push(flattenInline(state, child, EMPTY_FLAGS));
      }
    }
    return out;
  };

  const rawCellsOf = (parent: SyntaxNode): string[] => {
    const out: string[] = [];
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.name === "TableCell") {
        out.push(state.doc.sliceString(child.from, child.to).trim());
      }
    }
    return out;
  };

  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader") {
      rows.push(cellsOf(child));
      raw.push(rawCellsOf(child));
    } else if (child.name === "TableRow") {
      rows.push(cellsOf(child));
      raw.push(rawCellsOf(child));
    } else if (child.name === "TableDelimiter") {
      // 分隔行是 Table 的直接子节点，整行一个节点，从中读对齐方式。
      delimiterLine = state.doc.sliceString(child.from, child.to);
      // 分隔行的**全部**内部段都算列（含空段=无对齐的新列）——
      // 只数非空段会让"＋ 列"新增的空列在渲染里隐形
      const segments = delimiterLine.split("|").slice(1, -1).map((cell) => cell.trim());
      align = segments.map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (left) return "left";
        if (right) return "right";
        return null;
      });
    }
  }

  return { rows, align, raw, delimiterLine };
}

/** 图片加载不出来时的降级显示。 */
function imageChip(alt: string, target: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "cm-lp-image-chip";
  chip.textContent = `🖼 ${alt || target}`;
  chip.title = target;
  return chip;
}

/** 收集某类后代节点的范围（callout 里的 `>` 标记散布在各级段落里）。 */
function collectNodes(
  node: SyntaxNode,
  name: string,
  out: Array<{ from: number; to: number }>,
): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) out.push({ from: child.from, to: child.to });
    else collectNodes(child, name, out);
  }
}

/** 外部链接的 mark 装饰：带 title 提示，便于发现 Ctrl+点击的用法。 */
function externalLinkMark(url: string): Decoration {
  return Decoration.mark({
    class: "cm-lp-link",
    attributes: { title: `Ctrl+点击用系统浏览器打开：${url}` },
  });
}

/** 一段 Obsidian wiki 语法的匹配结果。 */
interface WikiMatch {
  from: number;
  to: number;
  /** `![[...]]` 为 true，`[[...]]` 为 false。 */
  embed: boolean;
  target: string;
  /** `|` 之后的部分：链接的别名，或图片的宽度数字。 */
  label: string;
}

/**
 * 找出范围内的 Obsidian wiki 语法。
 *
 * lezer 的 Markdown 解析器不认识 `[[...]]`，会把它拆成奇怪的嵌套——`![[x.png]]`
 * 会变成一个**目标为空**的 Image 节点（这正是"图片显示成 `[Pasted image ...]`
 * 占位标签"的原因）。所以这类语法必须自己用正则找，并屏蔽解析器为它生成的节点，
 * 否则会被两套逻辑重复处理。
 *
 * 行内代码与代码块里的 `[[...]]` 不算语法。
 */
function findWikiSyntax(
  doc: { sliceString(from: number, to: number): string },
  from: number,
  to: number,
  excluded: Array<[number, number]>,
): WikiMatch[] {
  const text = doc.sliceString(from, to);
  const pattern = /(!?)\[\[([^\]\n]+?)\]\]/g;
  const out: WikiMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = from + match.index;
    const end = start + match[0].length;
    if (excluded.some(([a, b]) => start < b && end > a)) continue;
    const [target, ...rest] = match[2].split("|");
    out.push({
      from: start,
      to: end,
      embed: match[1] === "!",
      target: target.trim(),
      label: rest.join("|").trim(),
    });
  }
  return out;
}

/** `笔记#小节` → `笔记 › 小节`，用于嵌入标签的显示。 */
function wikiDisplayText(target: string): string {
  const cleaned = target.replace(/\^[^\s]*$/, "");
  const hash = cleaned.indexOf("#");
  if (hash < 0) return cleaned;
  const note = cleaned.slice(0, hash);
  const section = cleaned.slice(hash + 1);
  return section ? `${note} › ${section}` : note;
}

/** 内联图片。
 *
 * `local` 是本地绝对路径（仓库内），渲染时才转成 asset URL——`convertFileSrc`
 * 依赖 `window`，不能在装饰计算阶段调用（那样单元测试就没法在 Node 里跑）。
 * 文件缺失或目录未授权时 `error` 事件会把它降级成标签，避免留一个破图。
 */
class ImageWidget extends WidgetType {
  readonly remote: string | null;
  readonly local: string | null;
  readonly alt: string;
  readonly target: string;
  /** `![[图.png|200]]` 里的宽度（像素）；没有就是 null。 */
  readonly width: number | null;

  constructor(
    remote: string | null,
    local: string | null,
    alt: string,
    target: string,
    width: number | null = null,
  ) {
    super();
    this.remote = remote;
    this.local = local;
    this.alt = alt;
    this.target = target;
    this.width = width;
  }

  eq(other: ImageWidget) {
    return (
      other.remote === this.remote &&
      other.local === this.local &&
      other.alt === this.alt &&
      other.target === this.target &&
      other.width === this.width
    );
  }

  toDOM() {
    // 根节点用容器固定下来，只替换它的子节点。
    // 不能在 error 里替换 widget 的根节点——CM6 持有该节点的引用，
    // 换掉它会让 CM6 的 DOM 记账失效（表现为降级标签根本不出现）。
    const box = document.createElement("span");
    const source = this.local ? convertFileSrc(this.local) : this.remote;
    if (!source) {
      box.appendChild(imageChip(this.alt, this.target));
      return box;
    }

    const img = document.createElement("img");
    img.className = "cm-lp-image";
    img.alt = this.alt;
    img.title = this.target;
    if (this.width !== null) img.style.width = `${this.width}px`;
    // 文件不存在或目录未授权时退化成标签，避免留一个破图。
    img.addEventListener("error", () => {
      box.replaceChildren(imageChip(this.alt, this.target));
    });
    img.src = source;
    box.appendChild(img);
    return box;
  }
}

/**
 * `![[某笔记]]`：把目标笔记的内容渲染进来（内容嵌入 / transclusion）。
 *
 * 渲染是异步的（要读文件、按需加载 markdown-it），所以先占位再填充——与 mermaid 同一套路。
 * `generation` 参与 `eq`：索引或文件内容变化后旧 widget 会被判定为"不等"，CM6 重建 DOM
 * 并重新渲染；否则目标笔记改了、界面上还是旧内容。
 */
class NoteEmbedWidget extends WidgetType {
  readonly text: string;
  readonly target: string;
  readonly generation: number;

  constructor(text: string, target: string, generation: number) {
    super();
    this.text = text;
    this.target = target;
    this.generation = generation;
  }

  eq(other: NoteEmbedWidget) {
    return (
      other.text === this.text &&
      other.target === this.target &&
      other.generation === this.generation
    );
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-lp-embed is-loading";
    // 目标写在属性上：调试与自动化测试都要靠它区分同一篇笔记的不同嵌入方式
    box.dataset.embedTarget = this.target;
    box.textContent = `正在嵌入「${this.text}」…`;

    // 点击回到源码编辑：把光标放到嵌入语法的位置，本行随即显示源码
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
      view.focus();
    });

    void renderEmbeddedNote(view.state.facet(livePreviewContext), this.target).then((html) => {
      box.classList.remove("is-loading");
      box.innerHTML = html;
    });

    return box;
  }
}

// ---------------------------------------------------------------- 装饰计算

interface BuildContext {
  state: EditorState;
  /** 选区覆盖到的行号，这些行显示源码不做隐藏。 */
  activeLines: Set<number>;
}

/** 节点是否与当前选区同处一行（同行则显示源码）。 */
function isActive(ctx: BuildContext, from: number, to: number): boolean {
  const doc = ctx.state.doc;
  const startLine = doc.lineAt(from).number;
  const endLine = doc.lineAt(to).number;
  for (let n = startLine; n <= endLine; n += 1) {
    if (ctx.activeLines.has(n)) return true;
  }
  return false;
}

/**
 * 计算整个（或视口范围内的）装饰集。
 *
 * 纯函数，不触碰 DOM，可直接单测。
 */
export function buildLivePreviewDecorations(
  state: EditorState,
  from: number,
  to: number,
  resources: LivePreviewContext = EMPTY_CONTEXT,
): DecorationSet {
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const a = state.doc.lineAt(range.from).number;
    const b = state.doc.lineAt(range.to).number;
    for (let n = a; n <= b; n += 1) activeLines.add(n);
  }
  const ctx: BuildContext = { state, activeLines };

  const marks: Range<Decoration>[] = [];
  const replaces: Range<Decoration>[] = [];

  const hide = (from: number, to: number) => {
    if (to > from) replaces.push(HIDE.range(from, to));
  };
  const replaceWith = (from: number, to: number, widget: WidgetType) => {
    if (to > from) replaces.push(Decoration.replace({ widget }).range(from, to));
  };

  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
  const doc = state.doc;

  // 先收集"不要把里面的东西当语法"的区域：代码块、行内代码，以及手写 HTML 块。
  // HTML 块里的 `[[...]]`、`$...$` 也不该被解析——那不是 Markdown。
  const excluded: Array<[number, number]> = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (
        node.name === "FencedCode" ||
        node.name === "InlineCode" ||
        node.name === "CodeBlock" ||
        node.name === "HTMLBlock"
      ) {
        excluded.push([node.from, node.to]);
        return false;
      }
      return undefined;
    },
  });

  const slice = doc.sliceString(from, to);

  // 手写 HTML 最先注册：它是最外层的结构，重叠时应当由它接管
  // （例如 `<font color=red>[[某笔记]]</font>` 整段归 HTML）。
  const htmlSpans = findInlineHtml(slice, from, excluded);
  for (const item of htmlSpans) {
    if (isActive(ctx, item.from, item.to)) continue; // 光标所在行显示源码
    replaceWith(item.from, item.to, new HtmlWidget(item.inner));
  }

  // Obsidian 的 `[[...]]` / `![[...]]` 解析器不认识，得自己找。
  const wiki = findWikiSyntax(doc, from, to, excluded);
  const inWiki = (a: number, b: number) => wiki.some((w) => a < w.to && b > w.from);

  // wiki 语法先注册：去重时它要优先于解析器为它生成的那些节点。
  for (const item of wiki) {
    if (isActive(ctx, item.from, item.to)) continue; // 光标所在行显示源码

    if (item.embed) {
      if (IMAGE_EXT.test(item.target)) {
        const { remote, local } = resolveWikiTarget(resources, item.target);
        // `![[图.png|200]]` 里的数字是宽度，不是说明文字
        const numeric = /^\d+$/.test(item.label);
        replaceWith(
          item.from,
          item.to,
          new ImageWidget(remote, local, numeric ? "" : item.label, item.target, numeric ? Number(item.label) : null),
        );
      } else {
        // 笔记嵌入：把目标笔记的内容渲染进来
        replaceWith(
          item.from,
          item.to,
          new NoteEmbedWidget(wikiDisplayText(item.target), item.target, resources.generation),
        );
      }
      continue;
    }

    // wiki 链接：只隐藏方括号，文字保留为可编辑文本（比换成 widget 更贴近 Obsidian）
    const source = doc.sliceString(item.from, item.to);
    const pipe = item.label ? source.indexOf("|") : -1;
    const textFrom = item.from + (pipe >= 0 ? pipe + 1 : 2);
    const textTo = item.to - 2;
    if (textTo > textFrom) {
      hide(item.from, textFrom);
      hide(textTo, item.to);
      marks.push(MARK.link.range(textFrom, textTo));
    }
  }

  // 行内公式 `$...$`（21% 的笔记里都有，见 docs/M1-实现说明.md 的统计）
  // 后续扫描器要跳过已被 HTML / wiki 语法接管的区间：那些内容整体被替换掉了，
  // 里面的 `$`、`#` 都不是语法（例如 <font color="#c00"> 里的 "#c00"）。
  const taken: Array<[number, number]> = [
    ...excluded,
    ...htmlSpans.map((item) => [item.from, item.to] as [number, number]),
    ...wiki.map((item) => [item.from, item.to] as [number, number]),
  ];

  for (const item of findInlineMath(slice, from, taken)) {
    if (isActive(ctx, item.from, item.to)) continue;
    replaceWith(item.from, item.to, mathWidgetFor(item));
  }

  // 高亮 `==文字==`：藏掉两侧的 `==`，给文字加底色
  for (const item of findHighlights(slice, from, taken)) {
    if (isActive(ctx, item.from, item.to)) continue;
    hide(item.from, item.from + 2);
    hide(item.to - 2, item.to);
    if (item.to - 2 > item.from + 2) {
      marks.push(MARK.highlight.range(item.from + 2, item.to - 2));
    }
  }

  // 注释 `%%...%%`：整段隐藏（只处理单行——跨行替换换行符是插件不允许的）。
  // 光标移到本行时会显示源码，所以不会"找不回"。
  for (const item of findComments(slice, from, taken)) {
    if (isActive(ctx, item.from, item.to)) continue;
    hide(item.from, item.to);
  }

  // 标签 `#标签`：加个弱化的底色，与正文区分（点击跳转尚未实现）
  for (const item of findTags(slice, from, taken)) {
    if (isActive(ctx, item.from, item.to)) continue;
    marks.push(
      Decoration.mark({
        class: "cm-lp-tag",
        attributes: { title: `标签 #${item.name}` },
      }).range(item.from, item.to),
    );
  }

  tree.iterate({
    from,
    to,
    enter: (node) => {
      const name = node.name;
      const hidden = (a: number, b: number) => {
        if (!isActive(ctx, node.from, node.to)) hide(a, b);
      };

      // 行内「标记+内容」：把两侧标记藏起来，给内容加样式。
      // 光标在本行时整体退回源码——既不隐藏标记，也不加样式，否则会出现
      // 「`**粗体**` 看着是源码、却已经变成粗体」这种自相矛盾的显示。
      const inlineMark = INLINE_MARKS[name];
      if (inlineMark) {
        const first = node.node.firstChild;
        const second = first?.nextSibling;
        if (
          first &&
          second &&
          first.name.endsWith("Mark") &&
          second.name.endsWith("Mark") &&
          !isActive(ctx, node.from, node.to)
        ) {
          hide(first.from, first.to);
          hide(second.from, second.to);
          if (second.from > first.to) marks.push(inlineMark.range(first.to, second.from));
        }
        return false;
      }

      switch (name) {
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6": {
          const level = Number(name.slice(-1));
          const line = doc.lineAt(node.from);
          marks.push(LINE_CLASS[level].range(line.from));
          const headerMark = node.node.firstChild;
          if (
            headerMark &&
            headerMark.name === "HeaderMark" &&
            // 光标在本行时保留 # 标记：与其他语法的 isActive 保护一致，
            // 否则点击标题永远看不到源码、无法直接改级别
            !isActive(ctx, node.from, node.to)
          ) {
            // 连同标记后的一个空格一起隐藏，否则标题会残留一个缩进。
            let end = headerMark.to;
            if (doc.sliceString(end, end + 1) === " ") end += 1;
            hidden(headerMark.from, end);
          }
          return false;
        }

        case "Link": {
          // `[[笔记]]` 会被解析器拆成一个内层 Link，这里不处理，交给 wiki 分支。
          if (inWiki(node.from, node.to)) return false;
          const open = node.node.firstChild;
          const close = open?.nextSibling;
          if (
            open?.name === "LinkMark" &&
            close?.name === "LinkMark" &&
            !isActive(ctx, node.from, node.to)
          ) {
            hide(open.from, open.to);
            // 从 `]` 一路藏到节点末尾，覆盖 `](url)`。
            hide(close.from, node.to);
            if (close.from > open.to) {
              const urlNode = node.node.getChild("URL");
              const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
              marks.push(
                isExternalUrl(url)
                  ? externalLinkMark(url).range(open.to, close.from)
                  : MARK.link.range(open.to, close.from),
              );
            }
          }
          return false;
        }

        case "URL": {
          // 裸链接（GFM 自动链接）：`https://…` 直接出现在正文里。
          // Link 内部的 URL 由上面那个分支一起处理，这里跳过。
          if (node.node.parent?.name === "Link") return false;
          if (isActive(ctx, node.from, node.to)) return false;
          const bare = doc.sliceString(node.from, node.to);
          if (!isExternalUrl(bare)) return false;
          marks.push(externalLinkMark(bare).range(node.from, node.to));
          return false;
        }

        case "SetextHeading1":
        case "SetextHeading2": {
          // setext 标题：正文在上一行，`=====` / `-----` 是下一行的 HeaderMark
          const level = name === "SetextHeading1" ? 1 : 2;
          const textLine = doc.lineAt(node.from);
          marks.push(LINE_CLASS[level].range(textLine.from));
          const headerMark = node.node.firstChild;
          if (
            headerMark?.name === "HeaderMark" &&
            !isActive(ctx, node.from, node.to)
          ) {
            hide(headerMark.from, headerMark.to);
            // 下划线独占一行，藏掉文字后还要把行高压掉，否则留一条空行
            marks.push(
              Decoration.line({ class: "cm-lp-collapsed" }).range(doc.lineAt(headerMark.from).from),
            );
          }
          return false;
        }

        case "Blockquote": {
          const firstLine = doc.lineAt(node.from);
          const info = parseCalloutLine(
            doc.sliceString(firstLine.from, firstLine.to),
            firstLine.from,
          );
          if (!info) return undefined; // 普通引用：交给下面的 QuoteMark 分支

          const active = isActive(ctx, node.from, node.to);

          // 整块加容器样式（按类型区分颜色）
          const lastLineNumber = doc.lineAt(node.to).number;
          for (let n = firstLine.number; n <= lastLineNumber; n += 1) {
            marks.push(
              Decoration.line({ class: `cm-lp-callout cm-lp-callout-${info.type}` }).range(
                doc.line(n).from,
              ),
            );
          }

          // `>` 标记由这里统一藏掉：返回 false 之后不会再走 QuoteMark 分支，
          // 否则同一行会同时拿到引用样式和 callout 样式。
          const quoteMarks: Array<{ from: number; to: number }> = [];
          collectNodes(node.node, "QuoteMark", quoteMarks);

          if (!active) {
            for (const mark of quoteMarks) {
              let end = mark.to;
              if (doc.sliceString(end, end + 1) === " ") end += 1;
              hide(mark.from, end);
            }
            replaceWith(
              info.markerFrom,
              info.markerTo,
              new CalloutLabelWidget(info.type, info.title),
            );
            if (info.titleTo > info.titleFrom) {
              marks.push(
                Decoration.mark({ class: "cm-lp-callout-title" }).range(info.titleFrom, info.titleTo),
              );
            }
          }
          return false;
        }

        case "Image": {
          // `![[图.png]]` 是 wiki 嵌入，由上面的 wiki 分支处理（解析器给它的目标是空的）。
          if (inWiki(node.from, node.to)) return false;
          if (isActive(ctx, node.from, node.to)) return false;
          const alt = doc.sliceString(node.from, node.to);
          const urlNode = node.node.getChild("URL");
          const target = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
          const altText = alt.replace(/^!\[/, "").split("]")[0] ?? "";
          const { remote, local } = resolveResource(resources, target);
          replaceWith(node.from, node.to, new ImageWidget(remote, local, altText, target));
          return false;
        }

        case "HorizontalRule": {
          if (isActive(ctx, node.from, node.to)) return false;
          // 只替换 `---` 本身，保留行尾换行——该行渲染出来就是一个 <hr>。
          //
          // 这里**不能**用块级替换：CM6 禁止插件产生块级装饰
          // （"Block decorations may not be specified via plugins"），
          // 一旦使用会让整个装饰集抛异常、编辑器直接空白。
          replaceWith(node.from, node.to, new RuleWidget());
          return false;
        }

        case "ListMark": {
          const item = node.node.parent;
          if (!item) return false;
          const grand = item.parent;
          const hasTask = item.getChild("Task") !== null;
          if (hasTask) {
            // 任务项由复选框代表，项目符号隐藏。
            hidden(node.from, node.to);
          } else if (grand?.name === "BulletList") {
            if (!isActive(ctx, node.from, node.to)) {
              replaceWith(node.from, node.to, new BulletWidget());
            }
          }
          return false;
        }

        case "TaskMarker": {
          const checked = /\[[xX]\]/.test(doc.sliceString(node.from, node.to));
          // 复选框始终显示（即使光标在本行），这样才点得到。
          replaceWith(node.from, node.to, new TaskCheckboxWidget(checked, node.from, node.to));
          return false;
        }

        case "QuoteMark": {
          hidden(node.from, node.to + (doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0));
          const line = doc.lineAt(node.from);
          marks.push(Decoration.line({ class: "cm-lp-quote" }).range(line.from));
          return false;
        }

        case "FencedCode": {
          const active = isActive(ctx, node.from, node.to);
          // mermaid 图由 StateField 整块替换成图。被替换时这里必须一个装饰都不产生——
          // 行装饰与块级替换落在同一行会冲突。光标进入该块（active）时则按普通代码块
          // 处理，方便直接改图定义。
          if (!active && mermaidCode(state, node.node) !== null) return false;
          // 整块加底色，包含被隐藏的围栏行，视觉上才连续。
          const firstLine = doc.lineAt(node.from).number;
          const lastLine = doc.lineAt(node.to).number;
          for (let n = firstLine; n <= lastLine; n += 1) {
            marks.push(Decoration.line({ class: "cm-lp-codeblock" }).range(doc.line(n).from));
          }
          if (!active) {
            let closing: { from: number; to: number } | null = null;
            let child = node.node.firstChild;
            while (child) {
              if (child.name === "CodeMark") {
                hide(child.from, child.to);
                closing = { from: child.from, to: child.to };
              } else if (child.name === "CodeInfo") {
                const info = doc.sliceString(child.from, child.to);
                replaceWith(child.from, child.to, new CodeInfoWidget(info));
              }
              child = child.nextSibling;
            }
            // 收尾围栏被藏掉后，那一行就空了。若它只剩围栏本身，就把行高压掉，
            // 否则每个代码块底部都会多出一条空行。
            // 起始行不处理——那行还有语言标签，需要正常高度。
            if (closing) {
              const line = doc.lineAt(closing.from);
              if (line.from === closing.from && line.to === closing.to) {
                marks.push(Decoration.line({ class: "cm-lp-fence" }).range(line.from));
              }
            }
          }
          return false;
        }

        case "Table": {
          // 表格由 StateField 做块级替换（插件不允许块级装饰）。
          // 被替换时内部内容根本不渲染，此时必须跳过子节点——否则单元格里的
          // 行内装饰会与块级替换重叠，CM6 会直接抛异常。
          // 光标在表格内时是源码视图，正常处理子节点。
          return isActive(ctx, node.from, node.to) ? undefined : false;
        }

        default:
          return undefined;
      }
    },
  });

  // CM6 遇到重叠的 replace 装饰会抛异常，整个编辑器会挂掉。
  // 手工构造的装饰在嵌套语法下可能重叠，这里按起点排序后丢弃被包含的项。
  replaces.sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: Range<Decoration>[] = [];
  let reach = -1;
  for (const r of replaces) {
    if (r.from < reach) continue;
    kept.push(r);
    reach = r.to;
  }

  const all = [...kept, ...marks].sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(all, true);
}

/**
 * 请求重算装饰。
 *
 * 用途：资源索引（文件名 → 路径）在后台刷新后，编辑器需要重新解析图片路径。
 * 装饰只在文档/选区/视口变化时重算，索引变化不在其中，所以得显式通知一次。
 */
export const refreshDecorations = StateEffect.define<null>();

/** 让编辑器立刻按最新的资源上下文重算装饰。 */
export function requestDecorationRefresh(view: EditorView): void {
  view.dispatch({ effects: refreshDecorations.of(null) });
}

/** 从状态里取出资源上下文并计算视口内的装饰。 */
function decorationsFor(view: EditorView): DecorationSet {
  return buildLivePreviewDecorations(
    view.state,
    view.viewport.from,
    view.viewport.to,
    view.state.facet(livePreviewContext),
  );
}

/** Live Preview 扩展。装饰只在视口内计算，长文档不会因全量装饰而变慢。 */
export function livePreviewExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorationsFor(view);
      }

      update(update: ViewUpdate) {
        const forced = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshDecorations)),
        );
        if (update.docChanged || update.selectionSet || update.viewportChanged || forced) {
          this.decorations = decorationsFor(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/**
 * 需要整块替换的装饰（表格、mermaid 图）。
 *
 * 必须由 StateField 提供：CM6 不允许**插件**产生块级装饰
 * （"Block decorations may not be specified via plugins"），违反会让整个装饰集
 * 抛异常、编辑器渲染成空白。
 *
 * 代价：StateField 拿不到 `view.viewport`，只能按全文档扫描。这里只遍历语法树找
 * `Table` 与 `FencedCode` 节点，且 CM6 的语法树是增量维护的，`ensureSyntaxTree`
 * 在树已完整时立即返回，因此常态开销只是遍历节点，不涉及重新解析。
 *
 * 光标落在被替换的块内时不替换——退回源码，方便直接改语法。
 */
export function computeBlockDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const selections = state.selection.ranges;
  const touched = (from: number, to: number) =>
    selections.some((range) => range.from <= to && range.to >= from);

  const tree = ensureSyntaxTree(state, doc.length, 500) ?? syntaxTree(state);
  const ranges: Range<Decoration>[] = [];

  /** 块级替换必须覆盖完整的行（含行尾换行），否则会与行装饰冲突或残留空行。 */
  const wholeLines = (from: number, to: number): [number, number] => {
    const firstLine = doc.lineAt(from);
    const lastLine = doc.lineAt(to);
    return [firstLine.from, lastLine.to < doc.length ? lastLine.to + 1 : lastLine.to];
  };

  tree.iterate({
    enter: (node) => {
      // 手写 HTML 块：清洗后整块渲染（清洗只作用于显示，原文不动）
      if (node.name === "HTMLBlock") {
        if (touched(node.from, node.to)) return false;
        const html = doc.sliceString(node.from, node.to);
        if (!html.trim()) return false;
        const [from, to] = wholeLines(node.from, node.to);
        ranges.push(
          Decoration.replace({
            widget: new HtmlWidget(html, true),
            block: true,
          }).range(from, to),
        );
        return false;
      }

      if (node.name === "FencedCode") {
        const code = mermaidCode(state, node.node);
        if (code === null) return undefined; // 普通代码块交给装饰插件
        if (touched(node.from, node.to)) return false;

        const [from, to] = wholeLines(node.from, node.to);
        ranges.push(
          Decoration.replace({
            widget: new MermaidWidget(code, node.from, node.to),
            block: true,
          }).range(from, to),
        );
        return false;
      }

      if (node.name !== "Table") return undefined;
      if (touched(node.from, node.to)) return false;

      const parsed = parseTable(state, node.node);
      if (parsed.rows.length === 0) return false;

      const [from, to] = wholeLines(node.from, node.to);
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(parsed.rows, parsed.align, node.from, node.to),
          block: true,
        }).range(from, to),
      );
      return false;
    },
  });

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
}

/** 整块替换装饰的提供者。见 computeBlockDecorations 的说明。 */
export const blockWidgetsField = StateField.define<DecorationSet>({
  create: (state) => computeBlockDecorations(state),
  // 选区变化也要重算：光标进出表格/图表决定「渲染」还是「显示源码」。
  update: (_value, tr) => computeBlockDecorations(tr.state),
  provide: (field) => EditorView.decorations.from(field),
});

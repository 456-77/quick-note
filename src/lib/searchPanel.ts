/**
 * 自定义搜索面板（0.5 重设计）：替代 CodeMirror 默认的 Find Bar。
 *
 * 设计目标（参考 Obsidian / VS Code / Linear）：
 *  - 浮动卡片：悬在编辑器右上角，深色毛玻璃 + 圆角 + 阴影；
 *  - 搜索输入框带放大镜图标与「当前/总数」匹配计数；
 *  - 按钮图标化 + 中文 tooltip；大小写/正则/全词是 toggle 按钮；
 *  - 替换行默认隐藏，点展开钮显示；
 *  - 快捷键：Ctrl+F 打开、Enter 下一处、Shift+Enter 上一处、Esc 关闭（带缩小动画）。
 *
 * 实现：不用 CM 的默认面板 DOM，但复用 @codemirror/search 的查询状态
 * （setSearchQuery 驱动文档内高亮，findNext/findPrevious/replaceNext/replaceAll
 * 负责导航与替换）——高亮、环绕、正则/全词匹配都是现成的成熟实现。
 */

import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";

/** 面板上的可调选项。 */
interface PanelState {
  query: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
  replaceOpen: boolean;
}

const panelState: PanelState = {
  query: "",
  replace: "",
  caseSensitive: false,
  regexp: false,
  wholeWord: false,
  replaceOpen: false,
};

let panel: HTMLElement | null = null;
let panelView: EditorView | null = null;

function buildQuery(): SearchQuery {
  return new SearchQuery({
    search: panelState.query,
    replace: panelState.replace,
    caseSensitive: panelState.caseSensitive,
    regexp: panelState.regexp,
    wholeWord: panelState.wholeWord,
  });
}

/** 把当前查询同步给 CM（驱动文档内高亮与查找替换命令）。 */
function applyQuery(view: EditorView): void {
  // setSearchQuery 的效果类型不接受 null：空查询用「永不匹配」的哨兵清除高亮
  view.dispatch({
    effects: setSearchQuery.of(
      panelState.query ? buildQuery() : new SearchQuery({ search: "\u0000a^" }),
    ),
  });
}

interface MatchInfo {
  total: number;
  current: number;
  invalid: boolean;
}

/** 统计匹配总数与当前选中序号（正则非法时 invalid）。 */
function countMatches(view: EditorView): MatchInfo {
  if (!panelState.query) return { total: 0, current: 0, invalid: false };
  const query = buildQuery();
  let cursor;
  try {
    cursor = query.getCursor(view.state);
  } catch {
    return { total: 0, current: 0, invalid: true };
  }
  const head = view.state.selection.main.head;
  let total = 0;
  let current = 0;
  while (true) {
    const step = cursor.next();
    if (step.done) break;
    total += 1;
    if (step.value.from <= head && head <= step.value.to) current = total;
    if (total >= 9999) break;
  }
  return { total, current, invalid: false };
}

function updateCount(view: EditorView): void {
  if (!panel) return;
  const counter = panel.querySelector<HTMLElement>(".qn-search-count");
  if (!counter) return;
  const { total, current, invalid } = countMatches(view);
  counter.textContent = invalid ? "正则无效" : total === 0 ? "无结果" : `${current || "-"} / ${total}`;
  counter.classList.toggle("is-invalid", invalid);
}

function refresh(view: EditorView): void {
  applyQuery(view);
  updateCount(view);
}

function openReplaceRow(): void {
  panelState.replaceOpen = true;
  panel?.querySelector<HTMLElement>(".qn-search-replace")?.removeAttribute("hidden");
  panel?.querySelector<HTMLElement>('[data-act="replace-toggle"]')?.classList.add("is-on");
  panel?.querySelector<HTMLInputElement>(".qn-search-replace input")?.focus();
}

function closePanel(view: EditorView): void {
  if (!panel) return;
  const el = panel;
  panel = null;
  el.classList.add("is-closing");
  window.setTimeout(() => el.remove(), 150);
  view.contentDOM?.focus();
}

/** 面板 DOM。图标用内联 SVG，文字按钮用字符（Aa / .* / ab 是 VS Code 同款惯例）。 */
function buildPanel(view: EditorView): HTMLElement {
  const el = document.createElement("div");
  el.className = "qn-search";
  el.innerHTML = `
    <div class="qn-search-row">
      <span class="qn-search-icon">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line>
        </svg>
      </span>
      <input class="qn-search-input" type="text" placeholder="搜索（Enter 下一处）" spellcheck="false">
      <span class="qn-search-count">-</span>
      <button type="button" data-act="prev" title="上一处（Shift+Enter）">↑</button>
      <button type="button" data-act="next" title="下一处（Enter）">↓</button>
      <button type="button" data-toggle="case" title="区分大小写">Aa</button>
      <button type="button" data-toggle="regexp" title="正则表达式">.*</button>
      <button type="button" data-toggle="word" title="全词匹配">ab</button>
      <span class="qn-search-sep"></span>
      <button type="button" data-act="replace-toggle" title="替换">⇄</button>
      <button type="button" data-act="close" title="关闭（Esc）">×</button>
    </div>
    <div class="qn-search-row qn-search-replace" hidden>
      <input class="qn-search-replace-input" type="text" placeholder="替换为" spellcheck="false">
      <button type="button" data-act="replace-one" title="替换当前处">替换</button>
      <button type="button" data-act="replace-all" title="替换全部">全部替换</button>
    </div>
  `;

  const queryInput = el.querySelector<HTMLInputElement>(".qn-search-input")!;
  const replaceInput = el.querySelector<HTMLInputElement>(".qn-search-replace-input")!;

  queryInput.value = panelState.query;
  replaceInput.value = panelState.replace;
  for (const toggle of el.querySelectorAll<HTMLElement>("[data-toggle]")) {
    const key = toggle.dataset.toggle as "caseSensitive" | "regexp" | "wholeWord";
    if (panelState[key]) toggle.classList.add("is-on");
  }
  if (panelState.replaceOpen) openReplaceRow();

  queryInput.addEventListener("input", () => {
    panelState.query = queryInput.value;
    refresh(view);
  });
  queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
      updateCount(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePanel(view);
    }
  });
  replaceInput.addEventListener("input", () => {
    panelState.replace = replaceInput.value;
    applyQuery(view);
  });
  replaceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      replaceNext(view);
      refresh(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePanel(view);
    }
  });

  el.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("button");
    if (!button) return;
    const act = button.dataset.act;
    const toggle = button.dataset.toggle as "caseSensitive" | "regexp" | "wholeWord" | undefined;
    if (toggle) {
      panelState[toggle] = !panelState[toggle];
      button.classList.toggle("is-on", panelState[toggle]);
      refresh(view);
      queryInput.focus();
      return;
    }
    switch (act) {
      case "next":
        findNext(view);
        updateCount(view);
        break;
      case "prev":
        findPrevious(view);
        updateCount(view);
        break;
      case "replace-toggle":
        if (panelState.replaceOpen) {
          panelState.replaceOpen = false;
          el.querySelector<HTMLElement>(".qn-search-replace")?.setAttribute("hidden", "");
          button.classList.remove("is-on");
        } else {
          openReplaceRow();
        }
        break;
      case "replace-one":
        replaceNext(view);
        refresh(view);
        break;
      case "replace-all":
        replaceAll(view);
        refresh(view);
        break;
      case "close":
        closePanel(view);
        break;
    }
  });

  // 点面板空白不落到编辑器（否则面板后面的文档会动）
  el.addEventListener("mousedown", (event) => {
    if (!(event.target as HTMLElement).closest("input, button")) event.preventDefault();
  });

  return el;
}

/** 预填内容的长度上限：选区拖太长时只取开头，整段塞进搜索框没法用。 */
const PREFILL_MAX = 200;

/**
 * 取当前选区文本作为预填查询：多行只取第一行、超长截断。
 * 正则模式开着时转义特殊字符——预填的是「字面文本」，不能让 `(`、`*` 变成正则语法。
 */
function prefillFromSelection(view: EditorView): string {
  const range = view.state.selection.main;
  if (range.empty) return "";
  let text = view.state.sliceDoc(range.from, range.to);
  const newline = text.search(/\r\n|\r|\n/);
  if (newline >= 0) text = text.slice(0, newline);
  text = text.trim().slice(0, PREFILL_MAX);
  if (!text) return "";
  return panelState.regexp ? text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : text;
}

/**
 * 打开面板（已开则聚焦搜索框）。选区非空时用选中文本作为初始查询；
 * `init.query !== undefined` 时改用它（跳转预填优先于选区）。
 */
function openPanel(view: EditorView, init?: { query?: string }): void {
  if (init && init.query !== undefined) {
    panelState.query = init.query.slice(0, PREFILL_MAX);
    refresh(view);
  } else {
    const prefill = prefillFromSelection(view);
    if (prefill) {
      panelState.query = prefill;
      refresh(view);
    }
  }
  if (panel) {
    const input = panel.querySelector<HTMLInputElement>(".qn-search-input");
    if (input && input.value !== panelState.query) input.value = panelState.query;
    input?.focus();
    input?.select();
    return;
  }
  panelView = view;
  panel = buildPanel(view);
  view.dom.appendChild(panel);
  updateCount(view);
  const input = panel.querySelector<HTMLInputElement>(".qn-search-input")!;
  input.focus();
  input.select();
}

/**
 * 供编辑器外的地方打开面板（App 的 Ctrl+F 捕获拦截、全局搜索跳转预填关键词）。
 * 正则模式开着时按字面预填（与选区预填同规则）。
 */
export function openSearchPanelOn(view: EditorView, query?: string): void {
  const literal =
    query !== undefined && panelState.regexp
      ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : query;
  openPanel(view, literal === undefined ? undefined : { query: literal });
}

/** 面板开着时跳到下一处（F3 / Ctrl+G 从窗口层路由进来）。面板没开返回 false。 */
export function searchPanelFindNext(view: EditorView): boolean {
  if (!panel || panelView !== view) return false;
  findNext(view);
  updateCount(view);
  return true;
}

/** Esc / Ctrl+F 的关闭路径。面板没开返回 false 交给默认行为。 */
function closeIfOpen(view: EditorView): boolean {
  if (!panel) return false;
  closePanel(view);
  return true;
}

/** 搜索面板扩展：Ctrl+F 开关（Prec.high 压过 CM 默认的 Find Bar）。 */
export function customSearchPanel(): Extension {
  return [
    search(),
    // 文档或选区变化时刷新匹配计数：palette 跳转会预选命中词，光标落位后
    // current 才从 "-"（不在任何命中内）变成实际序号
    EditorView.updateListener.of((update) => {
      if ((update.docChanged || update.selectionSet) && panel && panelView === update.view) updateCount(update.view);
    }),
    Prec.high(
      keymap.of([
        { key: "Mod-f", run: (view) => (openPanel(view), true) },
        { key: "Escape", run: closeIfOpen },
      ]),
    ),
  ];
}

/** 文档变化后刷新计数（面板开着时）。供编辑器的 updateListener 调用。 */
export function notifySearchDocChanged(view: EditorView): void {
  if (panel && panelView === view) updateCount(view);
}

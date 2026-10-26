/**
 * 表名悬浮预览（0.31 用户反馈）：光标悬停在已收录的表名上，浮动显示该表的
 * CREATE TABLE 语句（DataGrip 式）。表名库来自仓库内的 DDL 笔记，经
 * LivePreviewContext.ddlTables 就地更新（见 lib/ddl.ts 的收录格式）。
 *
 * 0.32 增强：Live Preview 的表格是块级 widget，鼠标悬停其上时 CM 的
 * hoverTooltip 只能拿到块的起点坐标，解析不出单元格里的表名（用户反馈「光标
 * 在表格内容上无法唤起 DDL 弹窗」）。`installDdlCellHover` 在 document 层接管
 * 表格单元格的悬停：350ms 后查库浮出同一套弹窗（DOM 装配见 lib/ddlTip.ts）。
 *
 * 开关在设置里（ddlHover，默认开）；库没收录任何表时零开销（不进任何分支）。
 */

import { EditorView, hoverTooltip } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { livePreviewContext } from "./paths.ts";
import { getSettings } from "./settings.ts";
import { buildDdlTipDom } from "./ddlTip.ts";
import { tableWordInText } from "./ddl.ts";

/** 表名词法字符：字母数字下划线 $ # 与库名前缀的点。 */
function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_$#.]/.test(ch);
}

// -------------------------------------------------------- 悬浮卡直接编辑（0.34.2）
//
// 弹窗里的「编辑」要写回 DDL 笔记——落盘通道（读笔记→同名表替换→写回→重载库）
// 都在 App 侧，这里挂一个模块级钩子：App 挂载时 setDdlSaver 注入，两处 build
// DdlTipDom 的调用点据此决定要不要渲染编辑钮。卸载时置回 null。

export type DdlSaver = (table: string, ddl: string) => Promise<string>;

let ddlSaver: DdlSaver | null = null;

/** 注入/清除 DDL 保存通道（App 挂载时调用一次）。 */
export function setDdlSaver(fn: DdlSaver | null): void {
  ddlSaver = fn;
}

/** 带当前 saver 的弹窗装配参数（saver 不在时不渲染编辑钮）。 */
function tipOptions(): { onSave: (table: string, ddl: string) => Promise<string> } | undefined {
  const saver = ddlSaver;
  return saver ? { onSave: (table, ddl) => saver(table, ddl) } : undefined;
}

export function ddlHover(): Extension {
  return hoverTooltip(
    (view, pos) => {
      if (!getSettings().ddlHover) return null;
      const tables = view.state.facet(livePreviewContext).ddlTables;
      if (!tables || tables.size === 0) return null;
      // 光标向两侧扩成完整词（表名可能带 db. 前缀），再按小写全名查库。
      // 查不到就不显示——悬浮只在确定有货时出现，不打扰普通英文词。
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      let from = pos - line.from;
      let to = from;
      while (from > 0 && isWordChar(text[from - 1])) from -= 1;
      while (to < text.length && isWordChar(text[to])) to += 1;
      const word = text.slice(from, to).toLowerCase();
      if (!word) return null;
      const ddl = tables.get(word);
      if (!ddl) return null;
      return {
        pos: line.from + from,
        end: line.from + to,
        above: true,
        create: () => ({ dom: buildDdlTipDom(word, ddl, tipOptions()) }),
      };
    },
    // 默认 750ms 太迟钝；350ms 接近 Obsidian 的悬浮手感
    { hoverTime: 350 },
  );
}

// -------------------------------------------------------- 表格单元格悬浮

const CELL_TIP_ID = "qn-ddl-cell-tip";
const CELL_HOVER_MS = 350;
// 0.34.4 用户反馈「移动光标到ddl弹窗时，一旦脱离表名，弹窗就消失了」：弹窗
// 与单元格之间隔着 6px 定位空隙，光标横穿空隙的瞬间既不在弹窗里也不在单元格
// 上，按旧逻辑立即收起，永远到不了弹窗。mouseover 驱动的收起走 200ms 宽限，
// 光标落回弹窗/单元格就取消；滚动与点外面仍然即时收起
const LEAVE_GRACE_MS = 200;

/**
 * 表格单元格的 DDL 悬浮（0.32）：document 层 mouseover 委托，只认 Live Preview
 * 表格 widget 里的 td/th。查库走「离这个单元格最近的编辑器」的上下文——分屏
 * 双编辑器各自的 ddlTables 是同一份引用（App 的 loadDdlLibrary 同步更新两边）。
 * App 挂载时调用一次；返回卸载函数，重复调用先卸旧监听。
 */
export function installDdlCellHover(): () => void {
  if (typeof document === "undefined") return () => {};

  let timer: number | null = null;
  let hideTimer: number | null = null;

  const hide = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    document.getElementById(CELL_TIP_ID)?.remove();
  };

  const cancelHideSoon = () => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const hideSoon = () => {
    if (hideTimer !== null) return;
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      hide();
    }, LEAVE_GRACE_MS);
  };

  const show = (cell: HTMLElement, word: string, ddl: string) => {
    hide();
    const tip = buildDdlTipDom(word, ddl, tipOptions());
    tip.id = CELL_TIP_ID;
    tip.classList.add("qn-ddl-cell-tip");
    document.body.appendChild(tip);
    // 贴在单元格下方左对齐；越界时翻到上方 / 右对齐
    const rect = cell.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + box.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - box.width - 8);
    }
    if (top + box.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - box.height - 6);
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const onOver = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const openTip = document.getElementById(CELL_TIP_ID);
    // 0.34.5 编辑态锁：textarea 聚焦/组词中，hover 通道完全不参与——输入法
    // 候选窗交互要移鼠标出弹窗，任何「移出即收」都会毁掉组词
    if (openTip?.classList.contains("qn-ddl-editing")) return;
    // 0.34.4：弹窗大面板化后必然要移入内部编辑——移入弹窗内部不收起（与
    // mousedown 的放过同一逻辑），并取消宽限收起
    if (openTip && target && openTip.contains(target)) {
      cancelHideSoon();
      return;
    }
    const cell = target?.closest?.("td, th") as HTMLElement | null;
    if (!cell || !cell.closest(".cm-lp-tablewrap")) {
      // 宽限收起而非立即收起：给光标横穿 6px 定位空隙的时间
      if (openTip) hideSoon();
      return;
    }
    if (!getSettings().ddlHover) {
      if (openTip) hideSoon();
      return;
    }
    // 落回单元格：取消宽限收起
    cancelHideSoon();
    // 已在展示该单元格的弹窗：别重置计时闪掉
    const current = document.getElementById(CELL_TIP_ID);
    if (current && cell.contains(target)) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const editor = cell.closest(".cm-editor");
      const view = editor ? EditorView.findFromDOM(editor as HTMLElement) : null;
      const tables = view?.state.facet(livePreviewContext).ddlTables;
      if (!tables || tables.size === 0) return;
      const word = tableWordInText(cell.textContent ?? "", tables);
      if (!word) return;
      show(cell, word, tables.get(word)!);
    }, CELL_HOVER_MS);
  };

  const onDocMouseDown = (event: MouseEvent) => {
    // 0.34.5 编辑态锁：编辑中的弹窗（含从 CM tooltip 脱管的浮层）只有「点在
    // 弹窗外」才关；组词中连点外都不关——候选窗交互可能落下页面 mousedown
    const editingTip = document.querySelector(".qn-ddl-tip.qn-ddl-editing");
    if (editingTip) {
      const inside = event.target instanceof Node && editingTip.contains(event.target);
      const composing =
        editingTip.querySelector<HTMLTextAreaElement>(".qn-ddl-tip-input")?.dataset.composing ===
        "1";
      if (!inside && !composing) {
        if (editingTip.id === CELL_TIP_ID) hide();
        else editingTip.remove();
      }
      return;
    }
    // 0.34.2：弹窗现在直接可编辑——点击弹窗内部（文本域/保存钮）不能把它
    // 藏掉，只有点在弹窗外才收起
    const tip = document.getElementById(CELL_TIP_ID);
    if (tip && event.target instanceof Node && tip.contains(event.target)) return;
    hide();
  };

  const onScroll = (event: Event) => {
    const t = event.target;
    const openTip = document.getElementById(CELL_TIP_ID);
    // 0.34.4 用户反馈「想滑动弹窗内容」：捕获阶段的 scroll 对弹窗内部滚动
    // 也会触发——目标在弹窗里就不收起，只认弹窗外的滚动
    if (openTip && t instanceof Node && openTip.contains(t)) return;
    // 0.34.5 编辑态锁：编辑中的弹窗（含脱管浮层）不因任何滚动收起
    if (document.querySelector(".qn-ddl-tip.qn-ddl-editing")) return;
    hide();
  };

  document.addEventListener("mouseover", onOver, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("mousedown", onDocMouseDown, true);
  return () => {
    hide();
    document.removeEventListener("mouseover", onOver, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("mousedown", onDocMouseDown, true);
  };
}

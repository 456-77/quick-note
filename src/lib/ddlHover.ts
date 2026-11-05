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
import { buildDdlTipDom, revealDdlLine, type DdlTipOptions, type TipLang } from "./ddlTip.ts";
import { tableWordInText, type DdlEntry } from "./ddl.ts";

/** 表名词法字符：字母数字下划线 $ # 与库名前缀的点。 */
function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_$#.]/.test(ch);
}

/**
 * Java 实体库查词：先原名精确命中，再退到大小写不敏感匹配（0.35.3 用户反馈
 * 「光标已经聚焦到实体上，为什么没有显示弹窗」——手打的 hocrTaskItf 与库里的
 * HocrTaskItf 大小写不同；着色层 ddlMark 的交替正则带 gi 不区分大小写，悬浮
 * 查库同口径，否则出现「有下划线却不弹窗」的割裂）。撞键时取先遍历到的一条。
 */
function javaEntriesFor(classes: Map<string, DdlEntry[]> | undefined, raw: string): DdlEntry[] | undefined {
  if (!classes) return undefined;
  const exact = classes.get(raw);
  if (exact) return exact;
  const lower = raw.toLowerCase();
  for (const [key, value] of classes) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

// -------------------------------------------------------- 悬浮卡直接编辑（0.34.2）
//
// 弹窗里的「编辑」要写回库笔记——落盘通道（读笔记→同名表替换→写回→重载库）
// 都在 App 侧，这里挂一个模块级钩子：App 挂载时 setDdlSaver 注入，两处 build
// DdlTipDom 的调用点据此决定要不要渲染编辑钮。卸载时置回 null。

export type DdlSaver = (table: string, ddl: string, project: string) => Promise<string>;

let ddlSaver: DdlSaver | null = null;

/** 注入/清除 DDL 保存通道（App 挂载时调用一次）。 */
export function setDdlSaver(fn: DdlSaver | null): void {
  ddlSaver = fn;
}

/**
 * 收掉所有未处于编辑态的脱管浮层（0.36.1 用户反馈「光标已经点击别的区域，
 * 这个弹窗依然会显示」）：从 CM tooltip 脱管到 body 的编辑浮层，失焦后
 * （Esc 取消焦点/点到弹窗内其他元素导致 blur）编辑锁已摘，旧逻辑的关闭通道
 * 只认单元格卡，脱管浮层永远留到切笔记（closeDdlTip）才清。两处调用：
 * 点在弹窗外（onDocMouseDown）与新卡开出前（ddlHover 的 create，一次只留一张）。
 */
function closeIdleDetachedTips(): void {
  document
    .querySelectorAll(".qn-ddl-tip.qn-ddl-detached:not(.qn-ddl-editing)")
    .forEach((el) => el.remove());
}

/** 带当前 saver 的弹窗装配参数（saver 不在时不渲染编辑钮）。 */
function tipOptions(lang: TipLang, defaultProject?: string): DdlTipOptions | undefined {
  const saver = ddlSaver;
  if (!saver) return undefined;
  return {
    lang,
    defaultProject,
    onSave: (table, ddl, project) => saver(table, ddl, project),
  };
}

/**
 * 默认项目：当前笔记的标签里第一个命中条目项目的名字（0.34.13 用户反馈
 * 「笔记里一般会有一个标签提示属于哪个项目，默认显示标签中指定的项目」）。
 * 没有标签 / 标签对不上条目 → undefined（退回第一条）。
 */
function defaultProjectFor(view: EditorView, entries: DdlEntry[]): string | undefined {
  if (entries.length <= 1) return undefined;
  const ctx = view.state.facet(livePreviewContext);
  const tags = (ctx.noteTags?.get(ctx.notePath ?? "") ?? []).map((t) => t.toLowerCase());
  if (tags.length === 0) return undefined;
  const hit = entries.find((entry) => tags.includes(entry.project.toLowerCase()));
  return hit?.project;
}

export function ddlHover(): Extension {
  return hoverTooltip(
    (view, pos) => {
      if (!getSettings().ddlHover) return null;
      const ctx = view.state.facet(livePreviewContext);
      const tables = ctx.ddlTables;
      const classes = ctx.javaClasses;
      if ((!tables || tables.size === 0) && (!classes || classes.size === 0)) return null;
      // 光标向两侧扩成完整词（表名可能带 db. 前缀），再按全名查库。
      // 查不到就不显示——悬浮只在确定有货时出现，不打扰普通英文词。
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      let from = pos - line.from;
      let to = from;
      while (from > 0 && isWordChar(text[from - 1])) from -= 1;
      while (to < text.length && isWordChar(text[to])) to += 1;
      if (from === to) return null;
      const raw = text.slice(from, to);
      // 先查 DDL 库（小写键），再查 Java 实体库（原名→大小写不敏感兜底）
      const sqlEntries = tables?.get(raw.toLowerCase());
      const javaEntries = sqlEntries ? undefined : javaEntriesFor(classes, raw);
      const entries = sqlEntries ?? javaEntries;
      if (!entries || entries.length === 0) return null;
      const lang: TipLang = sqlEntries ? "sql" : "java";
      const word = lang === "sql" ? raw.toLowerCase() : raw;
      return {
        pos: line.from + from,
        end: line.from + to,
        above: true,
        create: () => {
          // 0.36.1：切到新的悬浮目标时先收掉失焦残留的旧脱管浮层，一次只留一张卡
          closeIdleDetachedTips();
          return {
            dom: buildDdlTipDom(word, entries, tipOptions(lang, defaultProjectFor(view, entries))),
          };
        },
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

// 悬浮计时器提为模块级：closeDdlTip（切笔记/切标签自动隐藏）要能取消它们，
// 否则切页瞬间 pending 的 350ms 计时还会把弹窗重新弹出来
let cellTimer: number | null = null;
let cellHideTimer: number | null = null;
/** 当前卡对应的单元格：show() 记入、hide()/closeDdlTip() 清空（0.36.1 换卡判断用）。 */
let cellCurrent: HTMLElement | null = null;
/** 触发计时器那次 mouseover 的最深元素（0.38：单元格里多个表名时按悬停目标取词）。 */
let cellHoverTarget: Element | null = null;

/**
 * 关掉一切 DDL 弹窗（0.34.6 用户反馈「切换页面或者切换笔记后要自动隐藏」）：
 * document 层的单元格悬浮卡 + 从 CM tooltip 脱管到 body 的编辑浮层。CM 托管的
 * tooltip 不在这里动——切笔记装载新文档时 CM 自会重评估收起。App 在 openNote /
 * activateTab 时调用。
 */
export function closeDdlTip(): void {
  if (cellTimer !== null) {
    window.clearTimeout(cellTimer);
    cellTimer = null;
  }
  if (cellHideTimer !== null) {
    window.clearTimeout(cellHideTimer);
    cellHideTimer = null;
  }
  cellCurrent = null;
  document.getElementById(CELL_TIP_ID)?.remove();
  document.querySelectorAll(".qn-ddl-tip.qn-ddl-detached").forEach((el) => el.remove());
}

/**
 * 表格单元格的 DDL 悬浮（0.32）：document 层 mouseover 委托，只认 Live Preview
 * 表格 widget 里的 td/th。查库走「离这个单元格最近的编辑器」的上下文——分屏
 * 双编辑器各自的 ddlTables 是同一份引用（App 的 loadDdlLibrary 同步更新两边）。
 * App 挂载时调用一次；返回卸载函数，重复调用先卸旧监听。
 */
export function installDdlCellHover(): () => void {
  if (typeof document === "undefined") return () => {};

  const hide = () => {
    if (cellTimer !== null) {
      window.clearTimeout(cellTimer);
      cellTimer = null;
    }
    if (cellHideTimer !== null) {
      window.clearTimeout(cellHideTimer);
      cellHideTimer = null;
    }
    cellCurrent = null;
    document.getElementById(CELL_TIP_ID)?.remove();
  };

  const cancelHideSoon = () => {
    if (cellHideTimer !== null) {
      window.clearTimeout(cellHideTimer);
      cellHideTimer = null;
    }
  };

  const hideSoon = () => {
    if (cellHideTimer !== null) return;
    cellHideTimer = window.setTimeout(() => {
      cellHideTimer = null;
      hide();
    }, LEAVE_GRACE_MS);
  };

  const show = (
    cell: HTMLElement,
    word: string,
    entries: DdlEntry[],
    lang: TipLang,
    defaultProject?: string,
  ) => {
    hide();
    const tip = buildDdlTipDom(word, entries, tipOptions(lang, defaultProject));
    tip.id = CELL_TIP_ID;
    tip.classList.add("qn-ddl-cell-tip");
    document.body.appendChild(tip);
    // 0.34.6 用户反馈「会自动滑动到ddl语句的底部，而不是定位到光标所在位置」：
    // 触发单元格的文本（列名/表名）就是锚——弹窗滚动到语句中含这个词的行并
    // 居中；语句不足一屏时本来滚不动，自然从头展示
    revealDdlLine(tip, cell.textContent ?? "");
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
    cellCurrent = cell;
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
    // 0.36.1 用户反馈「光标从下面移到上面/从上面移到下面，原弹窗不消失也不
    // 换成当前表的」：旧判断 `current && cell.contains(target)` 在**任何**弹窗
    // 开着时对**任何**单元格都早退——换目标永远不再调度 show，旧卡钉死（只在
    // 表格里出现，因为这是单元格悬浮通道）。改为按「当前卡对应的单元格」
    // 追踪：同一个单元格才跳过，换目标（含跨表）重置计时换卡
    if (cellCurrent && cellCurrent === cell) return;
    // 0.38 用户反馈「单元格只显示第一个 ddl，即使光标聚焦到第二个」：计时器
    // 回调只有 cell，此前按整格文本取第一个命中词——一格里有多个表名时永远
    // 弹第一个。把这次 mouseover 的最深元素记下来，回调优先在它的小范围文本
    // 里取词（Live Preview 的表名各自包在行内代码 chip 里，target 正好一词）
    cellHoverTarget = target;
    if (cellTimer !== null) window.clearTimeout(cellTimer);
    cellTimer = window.setTimeout(() => {
      cellTimer = null;
      const editor = cell.closest(".cm-editor");
      const view = editor ? EditorView.findFromDOM(editor as HTMLElement) : null;
      if (!view) return;
      const ctx = view.state.facet(livePreviewContext);
      const tables = ctx.ddlTables;
      const classes = ctx.javaClasses;
      if ((!tables || tables.size === 0) && (!classes || classes.size === 0)) return;
      const text = cell.textContent ?? "";
      // 优先悬停目标的小范围文本（比整格短，命中的就是光标下那个词）；目标
      // 就是单元格本身（裸文本）或范围异常大时退回整格扫描
      let zone = text;
      const zoneText = cellHoverTarget?.textContent ?? "";
      if (cellHoverTarget && cellHoverTarget !== cell && zoneText.length <= 200) {
        zone = zoneText;
      }
      // 先查 DDL 库（小写词），再查 Java 实体库（原名→大小写不敏感兜底）
      const zoneSqlWord = zone !== text && tables ? tableWordInText(zone, tables) : null;
      if (zoneSqlWord) {
        const entries = tables!.get(zoneSqlWord)!;
        show(cell, zoneSqlWord, entries, "sql", defaultProjectFor(view, entries));
        return;
      }
      const sqlWord = tables ? tableWordInText(text, tables) : null;
      if (sqlWord) {
        const entries = tables!.get(sqlWord)!;
        show(cell, sqlWord, entries, "sql", defaultProjectFor(view, entries));
        return;
      }
      if (classes) {
        const zoneTokens = zone !== text ? zone.split(/[^A-Za-z0-9_$]+/) : [];
        for (const token of zoneTokens) {
          const entries = token ? javaEntriesFor(classes, token) : undefined;
          if (entries) {
            show(cell, token, entries, "java", defaultProjectFor(view, entries));
            return;
          }
        }
        for (const token of text.split(/[^A-Za-z0-9_$]+/)) {
          const entries = token ? javaEntriesFor(classes, token) : undefined;
          if (entries) {
            show(cell, token, entries, "java", defaultProjectFor(view, entries));
            return;
          }
        }
      }
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
    // 0.36.1：失焦后（编辑锁已摘）的脱管浮层一并收掉——旧逻辑只收单元格卡，
    // 脱管浮层点外面永远关不掉，只有重新打开文件（closeDdlTip）才消失
    closeIdleDetachedTips();
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

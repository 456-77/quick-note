/**
 * DDL / Java 实体悬浮弹窗的 DOM 装配（0.32）：hoverTooltip（编辑器正文）与
 * 表格单元格悬浮（document 层）共用同一个观感。着色的 token 计算在纯函数层
 * （lib/ddl.ts 的 tokenizeSql、lib/javaEntity.ts 的 tokenizeJava），这里只负责
 * 把 token 铺成 span。
 *
 * 0.34.2 用户反馈两轮：
 * - 「支持在这个视图中直接修改 DDL 语句」→ 传 onSave 时弹窗直接是可编辑的
 *   文本域（不再先点「编辑」），点保存经 App 的落盘通道（读库笔记 →
 *   同名表整段替换 → 写回 → 重载悬浮库）。
 * - 「当前点击编辑按钮后，弹窗就消失了」→ 直接可编辑设计下没有编辑钮了；
 *   单元格悬浮的 document 级 mousedown 隐藏逻辑也要放过弹窗内部的点击
 *   （见 ddlHover.ts）。
 *
 * 0.34.4 用户反馈「现在这个数据表的ddl弹窗现在很小…」：DataGrip 式宽面板——
 * 标题行 = 表名 + 保存钮，体部一大块可编辑文本域（长行横向滚动不折行）；
 * 无 onSave 时仍是着色只读 pre（收录前的兜底展示）。
 *
 * 0.34.13 多项目（用户反馈「同时开发多个项目存在表名复用」）：同一表名在库里
 * 有多个项目条目时，标题行下方一排项目 chips，默认选中「笔记标签指定的项目」
 * （见 ddlHover），点击切换显示与保存目标。
 */

import { parseDdlTables, tokenizeSql, type DdlEntry } from "./ddl.ts";
import { parseClassLibrary, tokenizeJava } from "./javaEntity.ts";

export type TipLang = "sql" | "java";

export interface DdlTipOptions {
  /** 保存整段编辑后的语句（含声明）。返回成功文案；抛错显示在弹窗里。project = 当前选中的项目。 */
  onSave?: (table: string, ddl: string, project: string) => Promise<string>;
  /** 库语言：决定标题前缀与高亮 tokenizer（sql=建表语句，java=实体类）。 */
  lang?: TipLang;
  /** 默认选中的项目（当前笔记的标签匹配出来的，见 ddlHover）；不在条目里就退回第一条。 */
  defaultProject?: string;
}

/** 项目名显示：未分组显示「默认」。 */
export function projectLabel(project: string): string {
  return project === "" ? "默认" : project;
}

/**
 * 悬浮弹窗 DOM：标题行（表名 + [消息 + 保存钮]）+ 可编辑文本域，否则着色只读体；
 * 多项目时标题行下有一排切换 chips。
 */
export function buildDdlTipDom(
  table: string,
  entries: DdlEntry[],
  options?: DdlTipOptions,
): HTMLElement {
  const lang: TipLang = options?.lang ?? "sql";
  const onSave = options?.onSave;
  const dom = document.createElement("div");
  dom.className = "qn-ddl-tip";
  // 0.37.1 用户反馈「快速笔记弹窗开着时唤起 DDL 卡，快速笔记不消失」：弹窗
  // 互斥走窗口事件——ddlHover 两条路径（CM hover/单元格悬浮）都经这里装配，
  // App 监听后收起快速笔记弹窗
  window.dispatchEvent(new CustomEvent("qn-ddl-tip-open"));

  // ---- 标题行 ---------------------------------------------------------------
  const head = document.createElement("div");
  head.className = "qn-ddl-tip-head";
  const title = document.createElement("span");
  title.className = "qn-ddl-tip-title";
  title.textContent = `${lang === "java" ? "Class" : "Table"}: ${table}`;
  head.appendChild(title);

  const message = document.createElement("span");
  message.className = "qn-ddl-tip-message";

  let saveBtn: HTMLButtonElement | null = null;
  if (onSave) {
    saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "qn-ddl-tip-save";
    saveBtn.textContent = "保存";
    saveBtn.addEventListener("mousedown", (event) => event.stopPropagation());
    saveBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void submit();
    });
    head.append(message, saveBtn);
  }

  // ---- 多项目切换 chips（>1 条才渲染）---------------------------------------
  // 选中态是局部变量：切换只重铺体部内容，不重建弹窗
  let current = 0;
  // 0.34.13 用户反馈「笔记里一般有一个标签提示属于哪个项目，默认显示标签中
  // 指定的项目」：defaultProject 由调用方按笔记标签算好传进来
  const defaultAt = options?.defaultProject
    ? entries.findIndex((entry) => entry.project === options.defaultProject)
    : -1;
  if (defaultAt >= 0) current = defaultAt;
  // 体部渲染器按形态在后面赋值（只读 pre / 可编辑双层）；chips 闭包先建后调
  let render: () => void = () => {};
  const chips: HTMLElement[] = [];
  let projectsRow: HTMLElement | null = null;
  if (entries.length > 1) {
    const row = document.createElement("div");
    row.className = "qn-ddl-tip-projects";
    entries.forEach((entry, index) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "qn-ddl-tip-proj";
      chip.textContent = projectLabel(entry.project);
      chip.title = `查看「${projectLabel(entry.project)}」项目里的语句`;
      chip.addEventListener("mousedown", (event) => event.stopPropagation());
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        if (current === index) return;
        current = index;
        chips.forEach((c, i) => c.classList.toggle("is-on", i === current));
        render();
      });
      chips.push(chip);
      row.appendChild(chip);
    });
    chips[current]?.classList.add("is-on");
    projectsRow = row;
  }

  // ---- 体部 -----------------------------------------------------------------
  const body = document.createElement("div");
  body.className = "qn-ddl-tip-body";

  if (!onSave) {
    // 只读旧形态：着色 pre（保留同宽排版），项目切换重铺它
    const pre = document.createElement("pre");
    pre.className = "qn-ddl-tip-pre";
    render = () => {
      renderCodeHighlighted(pre, entries[current].ddl, lang);
    };
    render();
    body.replaceChildren(pre);
    if (projectsRow) dom.append(head, projectsRow, body);
    else dom.append(head, body);
    return dom;
  }

  // 0.34.5 用户反馈「ddl语句要支持关键字高亮」：textarea 本身着不了色，用
  // 「着色层垫底 + textarea 透明字叠在上面」的双层结构——textarea 仍是唯一的
  // 编辑面（输入法/撤销/选区全原生），底下的 pre 跟着值重铺 token、跟着滚动
  const hl = document.createElement("pre");
  hl.className = "qn-ddl-tip-hl";
  const input = document.createElement("textarea");
  input.className = "qn-ddl-tip-input";
  input.spellcheck = false;
  // 长行不折行（DataGrip 式横向滚动）——着色层与 textarea 都按 pre 排版才能对齐
  input.wrap = "off";
  const refreshHl = () => {
    renderCodeHighlighted(hl, input.value, lang);
    syncScroll();
  };
  const syncScroll = () => {
    hl.scrollTop = input.scrollTop;
    hl.scrollLeft = input.scrollLeft;
  };
  input.addEventListener("input", refreshHl);
  input.addEventListener("scroll", syncScroll);

  /** 项目切换/初始化时把 body 的值换成当前条目。 */
  render = () => {
    input.value = entries[current].ddl;
    // 0.34.6 用户反馈「点击弹窗会自动滑到语句底部」：脚本赋值后 textarea 的
    // 选区默认落在文本末尾，聚焦（含脱管后重打焦点）就会滚到光标处=底部。
    // 显式把选区放回开头，聚焦不再引发滚动
    input.setSelectionRange(0, 0);
    refreshHl();
  };
  render();

  // 0.34.5 用户反馈「中文输入法状态下进行输入时，弹窗就直接关闭了」：输入法
  // 候选窗交互要移鼠标出弹窗/滚页面，任何「移出即收」的通道都会毁掉组词。
  // 编辑态（聚焦或组词中）打标记在弹窗根上，ddlHover 的隐藏通道见标记即退避。
  const syncEditing = () => {
    dom.classList.toggle(
      "qn-ddl-editing",
      document.activeElement === input || input.dataset.composing === "1",
    );
  };
  input.addEventListener("focus", () => {
    // CM tooltip 生命周期（鼠标移出编辑器即收）会连输入一起销毁弹窗——
    // 一进编辑就脱管成 body 固定浮层，CM 后续的收起只作用于空壳。
    // 注意：Chromium 把「已聚焦节点 reparent」当失焦处理（blur 掉再不回来），
    // 所以脱管后必须把焦点重打回去；重入本监听时 detached 已置位
    if (!dom.dataset.detached && dom.parentElement && dom.parentElement !== document.body) {
      const rect = dom.getBoundingClientRect();
      dom.dataset.detached = "1";
      dom.classList.add("qn-ddl-detached");
      dom.style.left = `${Math.round(rect.left)}px`;
      dom.style.top = `${Math.round(rect.top)}px`;
      dom.style.width = `${Math.round(rect.width)}px`;
      document.body.appendChild(dom);
      // 0.37.1 用户反馈「点击弹窗编辑后弹窗被截断（超出屏幕底）」：编辑器路径
      // 里 CM 把可用高度写在外层 dom 上、弹窗 height:100% 跟随；脱管后该约束
      // 失效，弹窗长回内容高度（标题行+62vh 体部），原 top 若贴近屏幕底就会
      // 出屏。按脱管后的真实尺寸夹回视口。
      const grown = dom.getBoundingClientRect();
      if (grown.bottom > window.innerHeight - 8) {
        dom.style.top = `${Math.max(8, Math.round(window.innerHeight - grown.height - 8))}px`;
      }
      if (grown.right > window.innerWidth - 8) {
        dom.style.left = `${Math.max(8, Math.round(window.innerWidth - grown.width - 8))}px`;
      }
      input.focus();
      return;
    }
    syncEditing();
  });
  input.addEventListener("blur", syncEditing);
  input.addEventListener("compositionstart", () => {
    input.dataset.composing = "1";
    syncEditing();
  });
  input.addEventListener("compositionend", () => {
    input.dataset.composing = "0";
    syncEditing();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
    // Esc 不再关弹窗（0.34.2：鼠标一离开弹窗本来就会收起，Esc 留给打字者取消焦点）
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.blur();
    }
  });
  // 别让点击冒泡到编辑器/document 层的隐藏逻辑（单元格悬浮的 mousedown 捕获）
  input.addEventListener("mousedown", (event) => event.stopPropagation());

  const submit = async () => {
    // 与收录弹窗同一套校验：改完的文本里必须还能认出这条语句
    const edited = input.value.trim();
    const found =
      lang === "java"
        ? parseClassLibrary(edited).get(table)
        : parseDdlTables(edited).get(table.toLowerCase());
    const statement = found?.find((entry) => entry.project === entries[current].project)?.ddl;
    if (!statement) {
      message.className = "qn-ddl-tip-message is-error";
      message.textContent =
        lang === "java"
          ? "没有识别到这个类的定义（class/interface/enum/record）"
          : "没有识别到这张表的 CREATE TABLE 语句";
      return;
    }
    saveBtn!.disabled = true;
    saveBtn!.textContent = "保存中…";
    try {
      const ok = await onSave(table, statement, entries[current].project);
      message.className = "qn-ddl-tip-message";
      message.textContent = ok;
      entries[current] = { project: entries[current].project, ddl: statement };
      render();
    } catch (e) {
      message.className = "qn-ddl-tip-message is-error";
      message.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      saveBtn!.disabled = false;
      saveBtn!.textContent = "保存";
    }
  };

  body.append(hl, input);
  if (projectsRow) dom.append(head, projectsRow, body);
  else dom.append(head, body);
  return dom;
}

/** token 类名 → CSS 类。 */
const CLS: Record<string, string> = {
  kw: "qn-sql-kw",
  str: "qn-sql-str",
  id: "qn-sql-id",
  num: "qn-sql-num",
  cmt: "qn-sql-cmt",
};

/**
 * 把弹窗体滚动到 anchor（触发单元格文本：列名/表名）所在的行并居中。
 * 必须在弹窗插入文档后调用（要量 clientHeight）。语句不足一屏时 clamp 到 0，
 * 自然保持从头展示（0.34.6 用户反馈「内容少就不用强制居中」）。
 * anchor 找不到对应行（列名被改名/文本不符）就退回顶部。
 */
export function revealDdlLine(tip: HTMLElement, anchor: string): void {
  const input = tip.querySelector<HTMLTextAreaElement>(".qn-ddl-tip-input");
  if (!input) return;
  input.scrollTop = 0;
  const word = anchor.trim();
  if (!word) return;
  const lines = input.value.split("\n");
  // 先找带反引号的精确列名（DDL 惯例 `col`），找不到再退化成裸词
  let hit = lines.findIndex((line) => line.includes(`\`${word}\``));
  if (hit < 0) hit = lines.findIndex((line) => new RegExp(`\\b${escapeRegExp(word)}`).test(line));
  if (hit < 0) return;
  // 行高从实际排版反推（scrollHeight 含 padding，去掉）：比解析 lineHeight 字符串稳
  const style = window.getComputedStyle(input);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const lineH = (input.scrollHeight - padY) / Math.max(1, lines.length);
  const target = hit * lineH - (input.clientHeight - lineH) / 2;
  input.scrollTop = Math.max(0, Math.min(target, input.scrollHeight - input.clientHeight));
  input.scrollLeft = 0;
  // 同步着色垫底层的滚动（textarea scroll 事件没触发，手动对齐一次）
  const hl = tip.querySelector<HTMLElement>(".qn-ddl-tip-hl");
  if (hl) {
    hl.scrollTop = input.scrollTop;
    hl.scrollLeft = input.scrollLeft;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 按位置穿插普通文本节点铺满整段代码（不拼 HTML 字符串，全 textContent）。
    先清空目标——着色层随每次输入全量重铺（单条语句数 KB，开销可忽略）。 */
function renderCodeHighlighted(target: HTMLElement, code: string, lang: TipLang): void {
  const tokens = lang === "java" ? tokenizeJava(code) : tokenizeSql(code);
  target.textContent = "";
  let cursor = 0;
  for (const token of tokens) {
    if (token.from > cursor) {
      target.appendChild(document.createTextNode(code.slice(cursor, token.from)));
    }
    const span = document.createElement("span");
    span.className = CLS[token.cls];
    span.textContent = token.text;
    target.appendChild(span);
    cursor = token.from + token.text.length;
  }
  if (cursor < code.length) {
    target.appendChild(document.createTextNode(code.slice(cursor)));
  }
}

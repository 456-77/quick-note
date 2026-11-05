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

import { parseDdlTables, tableCommentOf, tokenizeSql, type DdlEntry } from "./ddl.ts";
import { parseClassLibrary, tokenizeJava } from "./javaEntity.ts";

export type TipLang = "sql" | "java";

/** 命中区间（0.38 弹窗内容搜索）：着色层把这些范围垫上高亮底。 */
type Hit = { from: number; to: number };

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

  // 0.38 用户反馈「表通常会有 comment 说明表的作用，考虑在标题处添加」：
  // 表级 COMMENT 解析出来跟在表名后面（超长省略，悬停看全文）；Java 实体没有
  // 这一协议，不渲染。项目切换后 comment 跟随当前条目重算（syncComment 在
  // current 声明后才调）
  const comment = document.createElement("span");
  comment.className = "qn-ddl-tip-comment";
  const syncComment = () => {
    const text = lang === "sql" ? tableCommentOf(entries[current].ddl) : null;
    comment.textContent = text ?? "";
    comment.title = text ?? "";
    comment.style.display = text ? "" : "none";
  };
  head.appendChild(comment);

  // 0.38 用户反馈「内容很多时观察获得需要的字段效率很慢，加个搜索框检索 DDL 内容」：
  // 输入即在着色层高亮全部命中 + 滚到第一条；Enter/Shift+Enter 在命中间循环跳。
  // 只读形态（收录前的兜底展示）没有双层结构，搜索框不渲染
  const search = onSave ? document.createElement("input") : null;
  if (search) {
    search.className = "qn-ddl-tip-search";
    search.type = "text";
    search.spellcheck = false;
    search.placeholder = "搜索内容…";
    search.addEventListener("mousedown", (event) => event.stopPropagation());
  }
  const hitsInfo = document.createElement("span");
  hitsInfo.className = "qn-ddl-tip-hits";
  hitsInfo.style.display = "none";
  head.append(search ?? "", hitsInfo);

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
      syncComment();
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
    renderCodeHighlighted(hl, input.value, lang, hits);
    syncScroll();
  };
  const syncScroll = () => {
    hl.scrollTop = input.scrollTop;
    hl.scrollLeft = input.scrollLeft;
  };
  input.addEventListener("input", refreshHl);
  input.addEventListener("scroll", syncScroll);

  // ---- 弹窗内容搜索（0.38）--------------------------------------------------
  // hits 是当前值里全部命中区间；hitIndex 是 Enter 循环跳转的游标。
  let hits: Hit[] = [];
  let hitIndex = 0;
  /** 把 search.value 在当前语句里重新扫一遍命中（项目切换后也按新内容重算）。 */
  const computeHits = () => {
    hits = [];
    hitIndex = 0;
    if (!search) return;
    const query = search.value.trim().toLowerCase();
    if (!query) return;
    const hay = input.value.toLowerCase();
    let at = hay.indexOf(query);
    while (at >= 0) {
      hits.push({ from: at, to: at + query.length });
      at = hay.indexOf(query, at + query.length);
    }
  };
  const syncHitInfo = () => {
    if (!search || !search.value.trim() || hits.length === 0) {
      hitsInfo.style.display = "none";
      return;
    }
    hitsInfo.style.display = "";
    hitsInfo.textContent = `${hitIndex + 1}/${hits.length}`;
  };
  /** 滚动体部让第 index 个命中落在视口中间（行高从实际排版反推，同 revealDdlLine）。 */
  const jumpToHit = (index: number) => {
    if (hits.length === 0) return;
    hitIndex = ((index % hits.length) + hits.length) % hits.length;
    const line = newlineCountBefore(input.value, hits[hitIndex].from);
    const style = window.getComputedStyle(input);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const lineH = (input.scrollHeight - padY) / Math.max(1, input.value.split("\n").length);
    const target = line * lineH - (input.clientHeight - lineH) / 2;
    input.scrollTop = Math.max(0, Math.min(target, input.scrollHeight - input.clientHeight));
    syncScroll();
    syncHitInfo();
  };
  if (search) {
    search.addEventListener("input", () => {
      computeHits();
      refreshHl();
      if (hits.length > 0) jumpToHit(0);
      else syncHitInfo();
    });
    // Esc：先清搜索（不清弹窗焦点），再按一次才轮到 input 的 Esc 通道
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        jumpToHit(hitIndex + (event.shiftKey ? -1 : 1));
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        search.value = "";
        computeHits();
        refreshHl();
        syncHitInfo();
        input.focus();
      }
    });
  }

  /** 项目切换/初始化时把 body 的值换成当前条目。 */
  render = () => {
    input.value = entries[current].ddl;
    // 0.34.6 用户反馈「点击弹窗会自动滑到语句底部」：脚本赋值后 textarea 的
    // 选区默认落在文本末尾，聚焦（含脱管后重打焦点）就会滚到光标处=底部。
    // 显式把选区放回开头，聚焦不再引发滚动
    input.setSelectionRange(0, 0);
    computeHits();
    refreshHl();
    syncComment();
    syncHitInfo();
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
      // 0.38 用户反馈「点击后弹窗为什么要变化，直接用悬浮时的弹窗不行吗」：
      // 编辑器路径里 CM 把可用高度写在外层 dom、弹窗 height:100% 跟随——脱管后
      // 该约束失效，弹窗长回内容高度（体部 62vh 封顶），视觉上「点一下就变大挪位」。
      // 脱管时把当前高度一并钉死：点击前后弹窗尺寸位置完全一致
      dom.style.height = `${Math.round(rect.height)}px`;
      document.body.appendChild(dom);
      // 0.37.1 用户反馈「点击弹窗编辑后弹窗被截断（超出屏幕底）」：原 top 贴近
      // 屏幕底时出屏，按脱管后的真实尺寸夹回视口（尺寸钉死后通常已不动，兜底）
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

/** pos 之前的换行数（= 0 基行号；CRLF 也按一个换行算）。 */
function newlineCountBefore(text: string, pos: number): number {
  let count = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < pos; i = text.indexOf("\n", i + 1)) count += 1;
  return count;
}

/** 按位置穿插普通文本节点铺满整段代码（不拼 HTML 字符串，全 textContent）。
    先清空目标——着色层随每次输入全量重铺（单条语句数 KB，开销可忽略）。
    hits（0.38 弹窗内容搜索）：把这些范围垫上 .qn-sql-hit 高亮底——渲染按
    「token 边界 ∪ 命中边界」切格，同一格内 token 色 + 命中底可叠加（命中范围
    外层 span 套住内层 token span）。 */
function renderCodeHighlighted(
  target: HTMLElement,
  code: string,
  lang: TipLang,
  hits: Hit[] = [],
): void {
  const tokens = lang === "java" ? tokenizeJava(code) : tokenizeSql(code);
  target.textContent = "";
  // 切格：所有 token 边界与命中边界都是候选断点
  const cuts = new Set<number>([0, code.length]);
  for (const token of tokens) {
    cuts.add(token.from);
    cuts.add(token.from + token.text.length);
  }
  for (const hit of hits) {
    cuts.add(hit.from);
    cuts.add(hit.to);
  }
  const points = [...cuts].filter((at) => at >= 0 && at <= code.length).sort((a, b) => a - b);
  const tokenAt = (from: number, to: number) =>
    tokens.find((token) => token.from <= from && token.from + token.text.length >= to);
  const hitAt = (from: number) => hits.some((hit) => from >= hit.from && from < hit.to);
  let key: string | null = null;
  let span: HTMLElement | null = null;
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;
    const token = tokenAt(from, to);
    const cls = token ? CLS[token.cls] : "";
    const inHit = hitAt(from);
    const nextKey = `${cls}|${inHit}`;
    if (nextKey !== key || !span) {
      key = nextKey;
      span = document.createElement("span");
      if (cls) span.className = cls;
      if (inHit) span.className = `${span.className} qn-sql-hit`.trim();
      target.appendChild(span);
    }
    span.appendChild(document.createTextNode(code.slice(from, to)));
  }
}

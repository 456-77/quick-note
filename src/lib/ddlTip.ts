/**
 * DDL 悬浮弹窗的 DOM 装配（0.32）：hoverTooltip（编辑器正文）与表格单元格
 * 悬浮（document 层）共用同一个观感。着色的 token 计算在 lib/ddl.ts 的
 * `tokenizeSql`（纯函数，Node 可断言），这里只负责把 token 铺成 span。
 *
 * 0.34.2 用户反馈两轮：
 * - 「支持在这个视图中直接修改 DDL 语句」→ 传 onSave 时弹窗直接是可编辑的
 *   文本域（不再先点「编辑」），点保存经 App 的落盘通道（读 DDL 笔记 →
 *   同名表整段替换 → 写回 → 重载悬浮库）。
 * - 「当前点击编辑按钮后，弹窗就消失了」→ 直接可编辑设计下没有编辑钮了；
 *   单元格悬浮的 document 级 mousedown 隐藏逻辑也要放过弹窗内部的点击
 *   （见 ddlHover.ts）。
 *
 * 0.34.4 用户反馈「现在这个数据表的ddl弹窗现在很小，将弹窗改成第二张图片的
 * 样子，只是将编辑按钮改成保存」：0.34.2 起体部换成 textarea 后失去了着色
 * pre 的撑宽能力（textarea 固有宽度只有默认 20 列），整卡缩成 ~200px 小窗。
 * 改成 DataGrip 式宽面板——标题行 = 表名 + 保存钮（原「编辑」的右上位置），
 * 体部一大块可编辑文本域（长行横向滚动不折行）；无 onSave 时仍是着色只读体。
 */

import { parseDdlTables, tokenizeSql } from "./ddl.ts";

export interface DdlTipOptions {
  /** 保存整段编辑后的 DDL（含该表的 CREATE TABLE）。返回成功文案；抛错显示在弹窗里。 */
  onSave?: (table: string, ddl: string) => Promise<string>;
}

/** 悬浮弹窗 DOM：标题行（表名 + [消息 + 保存钮]）+ 可编辑文本域，否则着色只读体。 */
export function buildDdlTipDom(table: string, ddl: string, options?: DdlTipOptions): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "qn-ddl-tip";
  const onSave = options?.onSave;

  const head = document.createElement("div");
  head.className = "qn-ddl-tip-head";
  const title = document.createElement("span");
  title.className = "qn-ddl-tip-title";
  title.textContent = `Table: ${table}`;
  head.appendChild(title);

  if (!onSave) {
    const pre = document.createElement("pre");
    pre.className = "qn-ddl-tip-pre";
    renderSqlHighlighted(pre, ddl);
    dom.append(head, pre);
    return dom;
  }

  const message = document.createElement("span");
  message.className = "qn-ddl-tip-message";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "qn-ddl-tip-save";
  saveBtn.textContent = "保存";
  saveBtn.addEventListener("mousedown", (event) => event.stopPropagation());
  saveBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    void submit();
  });
  head.append(message, saveBtn);

  // 0.34.5 用户反馈「ddl语句要支持关键字高亮」：textarea 本身着不了色，用
  // 「着色层垫底 + textarea 透明字叠在上面」的双层结构——textarea 仍是唯一的
  // 编辑面（输入法/撤销/选区全原生），底下的 pre 跟着值重铺 token、跟着滚动
  const body = document.createElement("div");
  body.className = "qn-ddl-tip-body";

  const hl = document.createElement("pre");
  hl.className = "qn-ddl-tip-hl";
  renderSqlHighlighted(hl, ddl);

  const input = document.createElement("textarea");
  input.className = "qn-ddl-tip-input";
  input.value = ddl;
  input.spellcheck = false;
  // 长行不折行（DataGrip 式横向滚动）——着色层与 textarea 都按 pre 排版才能对齐
  input.wrap = "off";

  const refreshHl = () => {
    renderSqlHighlighted(hl, input.value);
    syncScroll();
  };
  const syncScroll = () => {
    hl.scrollTop = input.scrollTop;
    hl.scrollLeft = input.scrollLeft;
  };
  input.addEventListener("input", refreshHl);
  input.addEventListener("scroll", syncScroll);

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
    // 与收录弹窗同一套校验：改完的文本里必须还能认出这张表的 CREATE TABLE
    const statement = parseDdlTables(input.value.trim()).get(table.toLowerCase());
    if (!statement) {
      message.className = "qn-ddl-tip-message is-error";
      message.textContent = "没有识别到这张表的 CREATE TABLE 语句";
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      const ok = await onSave(table, statement);
      message.className = "qn-ddl-tip-message";
      message.textContent = ok;
      input.value = statement;
      refreshHl();
    } catch (e) {
      message.className = "qn-ddl-tip-message is-error";
      message.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
    }
  };

  body.append(hl, input);
  dom.append(head, body);
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

/** 按位置穿插普通文本节点铺满整段 SQL（不拼 HTML 字符串，全 textContent）。
    先清空目标——着色层随每次输入全量重铺（DDL 数 KB，开销可忽略）。 */
function renderSqlHighlighted(target: HTMLElement, sql: string): void {
  target.textContent = "";
  let cursor = 0;
  for (const token of tokenizeSql(sql)) {
    if (token.from > cursor) {
      target.appendChild(document.createTextNode(sql.slice(cursor, token.from)));
    }
    const span = document.createElement("span");
    span.className = CLS[token.cls];
    span.textContent = token.text;
    target.appendChild(span);
    cursor = token.from + token.text.length;
  }
  if (cursor < sql.length) {
    target.appendChild(document.createTextNode(sql.slice(cursor)));
  }
}

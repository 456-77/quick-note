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
 */

import { parseDdlTables, tokenizeSql } from "./ddl.ts";

export interface DdlTipOptions {
  /** 保存整段编辑后的 DDL（含该表的 CREATE TABLE）。返回成功文案；抛错显示在弹窗里。 */
  onSave?: (table: string, ddl: string) => Promise<string>;
}

/** 悬浮弹窗 DOM：标题行 +（有 onSave 时）可编辑文本域 + 动作行，否则着色只读体。 */
export function buildDdlTipDom(table: string, ddl: string, options?: DdlTipOptions): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "qn-ddl-tip";
  const onSave = options?.onSave;

  const head = document.createElement("div");
  head.className = "qn-ddl-tip-head";
  head.textContent = `Table: ${table}`;
  dom.appendChild(head);

  if (!onSave) {
    const pre = document.createElement("pre");
    pre.className = "qn-ddl-tip-pre";
    renderSqlHighlighted(pre, ddl);
    dom.appendChild(pre);
    return dom;
  }

  const input = document.createElement("textarea");
  input.className = "qn-ddl-tip-input";
  input.value = ddl;
  input.spellcheck = false;
  input.rows = Math.min(16, Math.max(4, ddl.split("\n").length));
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

  const actions = document.createElement("div");
  actions.className = "qn-ddl-tip-actions";
  actions.append(message, saveBtn);

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
    } catch (e) {
      message.className = "qn-ddl-tip-message is-error";
      message.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
    }
  };

  dom.append(input, actions);
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

/** 按位置穿插普通文本节点铺满整段 SQL（不拼 HTML 字符串，全 textContent）。 */
function renderSqlHighlighted(target: HTMLElement, sql: string): void {
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

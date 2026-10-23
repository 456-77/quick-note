/**
 * DDL 悬浮弹窗的 DOM 装配（0.32）：hoverTooltip（编辑器正文）与表格单元格
 * 悬浮（document 层）共用同一个观感。着色的 token 计算在 lib/ddl.ts 的
 * `tokenizeSql`（纯函数，Node 可断言），这里只负责把 token 铺成 span。
 */

import { tokenizeSql } from "./ddl.ts";

/** 悬浮弹窗 DOM（标题行 + 着色代码体）。 */
export function buildDdlTipDom(table: string, ddl: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "qn-ddl-tip";
  const head = document.createElement("div");
  head.className = "qn-ddl-tip-head";
  head.textContent = `Table: ${table}`;
  const pre = document.createElement("pre");
  pre.className = "qn-ddl-tip-pre";
  renderSqlHighlighted(pre, ddl);
  dom.append(head, pre);
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

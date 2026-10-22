/**
 * 表名悬浮预览（0.31 用户反馈）：光标悬停在已收录的表名上，浮动显示该表的
 * CREATE TABLE 语句（DataGrip 式）。表名库来自仓库内的 DDL 笔记，经
 * LivePreviewContext.ddlTables 就地更新（见 lib/ddl.ts 的收录格式）。
 *
 * 开关在设置里（ddlHover，默认开）；库没收录任何表时零开销（不进任何分支）。
 */

import { hoverTooltip } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { livePreviewContext } from "./paths.ts";
import { getSettings } from "./settings.ts";

/** 表名词法字符：字母数字下划线 $ # 与库名前缀的点。 */
function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_$#.]/.test(ch);
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
        create: () => {
          const dom = document.createElement("div");
          dom.className = "qn-ddl-tip";
          const head = document.createElement("div");
          head.className = "qn-ddl-tip-head";
          head.textContent = `Table: ${word}`;
          const pre = document.createElement("pre");
          pre.className = "qn-ddl-tip-pre";
          pre.textContent = ddl;
          dom.append(head, pre);
          return { dom };
        },
      };
    },
    // 默认 750ms 太迟钝；350ms 接近 Obsidian 的悬浮手感
    { hoverTime: 350 },
  );
}

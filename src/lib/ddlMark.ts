/**
 * 已收录 DDL 的表名着色（0.34.2 用户反馈「表名对应的表已经有 ddl 语句的话，
 * 将表名变色，提示已录入建表语句」）：Live Preview 里出现库里的表名（整词）
 * 时加 `.qn-ddl-known` 标记——既是「悬浮可得建表语句」的视觉索引，也提示这张
 * 表已录入 DDL 库。
 *
 * 实现口径：
 * - 与 ddlHover 同一个落点注册（editor.ts，Live Preview 扩展链），源码模式不装；
 * - 表名库来自 LivePreviewContext.ddlTables（App.loadDdlLibrary 维护），空库
 *   直接 Decoration.none，零开销；
 * - 可见区逐段扫描，单条正则交替（表名按长度降序排，先长后短防前缀截胡），
 *   词边界用表名字符集（字母数字 `_ $ # .`，与 ddlHover.isWordChar 同口径）；
 * - 悬浮设置关掉时一并关（ddlHover 同一个开关族：DDL 提示）；
 * - 库更新没有文档事务——loadDdlLibrary 后调 notifyDdlLibraryUpdated()，插件
 *   收到事件后空 dispatch 一次，强制重扫。
 */

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { Extension, Range } from "@codemirror/state";
import { livePreviewContext } from "./paths.ts";
import { getSettings } from "./settings.ts";

const MARK_CLASS = "qn-ddl-known";
/** 单次装饰的标记上限：极端刷屏兜底（一屏真有几百个表名也不该卡渲染）。 */
const MAX_MARKS = 800;
/** 参与交替正则的表名上限：防异常大库把正则撑爆（超过的部分不着色，悬浮仍可用）。 */
const MAX_NAMES = 400;

const DDL_UPDATED_EVENT = "qn-ddl-updated";

/** 库更新后调用：所有编辑器的标记插件重扫一遍。 */
export function notifyDdlLibraryUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DDL_UPDATED_EVENT));
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/** 表名库 → 整词交替正则（gi）。库空返回 null。 */
function buildWordRegex(tables: Map<string, string>): RegExp | null {
  const names = [...tables.keys()]
    .filter((name) => name.length >= 2 && name.length <= 64)
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_NAMES)
    .map((name) => name.replace(ESCAPE_RE, "\\$&"));
  if (names.length === 0) return null;
  // 表名字符集两侧封边（lookbehind Chromium 88+/Node 16.4+ 都支持）
  return new RegExp(`(?<![A-Za-z0-9_$#.])(?:${names.join("|")})(?![A-Za-z0-9_$#.])`, "gi");
}

export function ddlKnownMarks(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;

      constructor(view: EditorView) {
        this.rebuild(view);
        // 库更新事件 → 空 dispatch 触发一次 update 重扫（无文档变化）
        this.onUpdated = () => view.dispatch({});
        window.addEventListener(DDL_UPDATED_EVENT, this.onUpdated);
      }

      onUpdated: () => void;

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.rebuild(update.view);
      }

      rebuild(view: EditorView) {
        if (!getSettings().ddlHover) {
          this.decorations = Decoration.none;
          return;
        }
        const tables = view.state.facet(livePreviewContext).ddlTables;
        const re = tables && tables.size > 0 ? buildWordRegex(tables) : null;
        if (!re) {
          this.decorations = Decoration.none;
          return;
        }
        const mark = Decoration.mark({ class: MARK_CLASS });
        const ranges: Range<Decoration>[] = [];
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.sliceDoc(from, to);
          re.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = re.exec(text)) !== null) {
            ranges.push(mark.range(from + match.index, from + match.index + match[0].length));
            if (match.index === re.lastIndex) re.lastIndex += 1; // 空匹配保护
            if (ranges.length >= MAX_MARKS) break;
          }
          if (ranges.length >= MAX_MARKS) break;
        }
        this.decorations = ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
      }

      destroy() {
        window.removeEventListener(DDL_UPDATED_EVENT, this.onUpdated);
      }
    },
    { decorations: (value) => value.decorations },
  );
  return plugin;
}

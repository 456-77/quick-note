/**
 * 目录（大纲）面板：列出当前笔记的标题层级，点击跳转。
 *
 * 解析是纯函数（`outline.ts`），这里只负责从**文档源**取文本、随键入刷新、
 * 以及渲染缩进层级。0.31 起文档源由 App 注入（`getDoc`）：编辑器（原行为）或
 * 分屏查看窗格（只读渲染，跟随最后聚焦的窗格）——分屏模式下点击标题项会在
 * 编辑器里打开该笔记并跳到目标行。
 *
 * 解析按**显示文本**做——`sliceDoc` 用文件自己的分隔符拼串，再按同一个分隔符
 * 切开，行号才能和编辑器对上（CRLF/CR 文件也不例外）。
 */

import { useEffect, useMemo, useRef } from "react";
import { outlineInlineSpans, outlineOf, type OutlineEntry } from "../lib/outline";

/** 文档源：全文 + 换行符（行号口径与编辑器一致）。null = 没有可显示的文档。 */
export interface OutlineDoc {
  text: string;
  lineBreak: string;
}

interface Props {
  /** 取当前要列大纲的文档（ref 镜像，避免闭包过期）。 */
  getDoc: () => OutlineDoc | null;
  /** 文档改动计数：每次键入后重算大纲。 */
  revision: number;
  /** 当前文档的键（标签路径）；null 表示没有打开的笔记。 */
  activeKey: string | null;
  /** 跳转到指定行（0 基）。 */
  onJump: (line: number) => void;
  /** 光标所在行（0 基）：用于高亮"当前位置"所在的标题；-1 = 无光标（分屏查看）。 */
  cursorLine: number;
}

export default function OutlinePanel({ getDoc, revision, activeKey, onJump, cursorLine }: Props) {
  const entries = useMemo<OutlineEntry[]>(() => {
    const doc = getDoc();
    if (!doc || !activeKey) return [];
    return outlineOf(doc.text.split(doc.lineBreak));
    // revision 触发重算：键入、粘贴、外部改动都会递增它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getDoc, activeKey, revision]);

  // 当前标题 = 光标之前最近的那个标题（光标在两个标题之间时属于上面那个）
  const activeIndex = useMemo(() => {
    if (cursorLine < 0) return -1;
    let current = -1;
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index].line <= cursorLine) current = index;
      else break;
    }
    return current;
  }, [entries, cursorLine]);

  // 高亮项滚动到面板可见范围（长文档里当前标题跑出面板时跟着走）
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeIndex < 0) return;
    const list = listRef.current;
    const item = list?.querySelectorAll(".outline-item")[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!activeKey) {
    return <div className="outline"><div className="outline-empty">没有打开的笔记</div></div>;
  }
  if (entries.length === 0) {
    return (
      <div className="outline">
        <div className="outline-empty">这篇笔记没有标题。用 # 开头写一个，就会出现在这里。</div>
      </div>
    );
  }

  return (
    <div className="outline">
      <div className="outline-list" ref={listRef}>
        {entries.map((entry, index) => (
          <button
            type="button"
            key={`${entry.line}-${index}`}
            className={`outline-item outline-h${entry.level}${index === activeIndex ? " is-active" : ""}`}
            style={{ paddingLeft: 8 + (entry.level - 1) * 12 }}
            title={`跳到第 ${entry.line + 1} 行`}
            onClick={() => onJump(entry.line)}
          >
            <span className="outline-text">
              {/* 标题里的行内标记渲染出来（0.27）：**加粗** 等不再以原文示人 */}
              {outlineInlineSpans(entry.text || "（无标题文字）").map((span, i) =>
                span.code ? (
                  <code key={i} className="outline-inline-code">{span.text}</code>
                ) : (
                  <span
                    key={i}
                    className={[
                      span.bold ? "outline-inline-bold" : "",
                      span.italic ? "outline-inline-italic" : "",
                      span.strike ? "outline-inline-strike" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {span.text}
                  </span>
                ),
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

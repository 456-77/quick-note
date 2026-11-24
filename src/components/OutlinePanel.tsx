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

import { useEffect, useMemo, useRef, useState } from "react";
import { outlineInlineSpans, outlineOf, type OutlineEntry } from "../lib/outline";
import { isMarkdownPath } from "../lib/fileTypes";
import type { PdfToc } from "./FilePreview";

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
  /**
   * 拖动条目移动整个章节（0.39.31 用户反馈「支持拖动目录，来直接移动 md 文件
   * 内容」）：targetLine 是落点条目的标题行，place = 落在它之前/之后
   * （after 按列表顺序解释为下一个条目的行首；最后一个条目之后 = 文末）。
   */
  onMoveSection?: (fromLine: number, targetLine: number, place: "before" | "after") => void;
  /** 光标所在行（0 基）：用于高亮"当前位置"所在的标题；-1 = 无光标（分屏查看）。 */
  cursorLine: number;
  /** PDF 书签目录（0.39.17）：预览的 PDF 有书签时接管面板（点条目跳页），
   *  md 大纲让位；null/无书签 = 走 md 大纲/空态。 */
  pdfToc?: PdfToc | null;
}

export default function OutlinePanel({ getDoc, revision, activeKey, onJump, onMoveSection, cursorLine, pdfToc }: Props) {
  /** 拖动中的章节标题行（0 基）；null = 未在拖。 */
  const [dragLine, setDragLine] = useState<number | null>(null);
  /** 落点提示：目标条目行 + 前/后。 */
  const [dropHint, setDropHint] = useState<{ line: number; place: "before" | "after" } | null>(null);
  /** 刚结束一次拖动：抑制随后的 click 跳转（部分浏览器会补发 click）。 */
  const dragEndedAtRef = useRef(0);
  const entries = useMemo<OutlineEntry[]>(() => {
    const doc = getDoc();
    if (!doc || !activeKey) return [];
    // 0.39.28 用户反馈「对于非 md 文档就不需要进行渲染了」：`.sh` 的 `# 注释`
    // 是 shell 注释不是标题，大纲只对 markdown 计算（PDF 书签分支在上面不受影响）
    if (!isMarkdownPath(activeKey)) return [];
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

  if (!activeKey && !pdfToc) {
    return <div className="outline"><div className="outline-empty">没有打开的笔记</div></div>;
  }
  // PDF 书签模式（0.39.17）：点击条目滚到对应页；page=-1 的条目只展示不可点
  if (pdfToc) {
    if (pdfToc.entries.length === 0) {
      return (
        <div className="outline">
          <div className="outline-empty">这份 PDF 没有书签目录。</div>
        </div>
      );
    }
    return (
      <div className="outline">
        <div className="outline-list outline-pdf-list">
          {pdfToc.entries.map((entry, index) => (
            <button
              type="button"
              key={`${entry.page}-${index}`}
              className={`outline-item${entry.page < 0 ? " is-disabled" : ""}`}
              style={{ paddingLeft: 8 + entry.depth * 12 }}
              title={entry.page >= 0 ? `跳到第 ${entry.page + 1} 页` : "无法解析目标页"}
              onClick={() => {
                if (entry.page >= 0) pdfToc.jump(entry.page);
              }}
            >
              <span className="outline-text">{entry.title || "（无标题）"}</span>
              {entry.page >= 0 && <span className="outline-page">{entry.page + 1}</span>}
            </button>
          ))}
        </div>
      </div>
    );
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
            className={`outline-item outline-h${entry.level}${index === activeIndex ? " is-active" : ""}${
              dragLine === entry.line ? " is-drag-source" : ""
            }${
              dropHint?.line === entry.line
                ? dropHint.place === "before"
                  ? " is-drop-before"
                  : " is-drop-after"
                : ""
            }`}
            style={{ paddingLeft: 8 }}
            title={
              onMoveSection
                ? `第 ${entry.line + 1} 行 · 点击跳转，拖动可移动整节`
                : `跳到第 ${entry.line + 1} 行`
            }
            draggable={!!onMoveSection}
            onDragStart={
              onMoveSection
                ? (event) => {
                    setDragLine(entry.line);
                    event.dataTransfer.effectAllowed = "move";
                    // Firefox 需要 setData 才会真正开始拖动
                    event.dataTransfer.setData("text/plain", String(entry.line));
                  }
                : undefined
            }
            onDragEnd={
              onMoveSection
                ? () => {
                    dragEndedAtRef.current = Date.now();
                    setDragLine(null);
                    setDropHint(null);
                  }
                : undefined
            }
            onDragOver={
              onMoveSection
                ? (event) => {
                    if (dragLine === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    const place = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                    setDropHint((prev) =>
                      prev?.line === entry.line && prev.place === place
                        ? prev
                        : { line: entry.line, place },
                    );
                  }
                : undefined
            }
            onDragLeave={
              onMoveSection
                ? (event) => {
                    // 在条目内部的子元素之间移动不算离开，避免指示线闪烁
                    const next = event.relatedTarget as Node | null;
                    if (next && event.currentTarget.contains(next)) return;
                    setDropHint((prev) => (prev?.line === entry.line ? null : prev));
                  }
                : undefined
            }
            onDrop={
              onMoveSection
                ? (event) => {
                    event.preventDefault();
                    const from = dragLine;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const place = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                    dragEndedAtRef.current = Date.now();
                    setDragLine(null);
                    setDropHint(null);
                    if (from === null) return;
                    onMoveSection(from, entry.line, place);
                  }
                : undefined
            }
            onClick={() => {
              // 刚拖完的一次 click 不跳转（拖拽落点已产生文档改动）
              if (Date.now() - dragEndedAtRef.current < 300) return;
              onJump(entry.line);
            }}
          >
            {/* 0.39.31 用户反馈「添加不同颜色竖线突出层级关系」：逐级引导线 */}
            {Array.from({ length: entry.level - 1 }).map((_, i) => (
              <span key={i} className={`outline-guide qg${(i % 6) + 1}`} aria-hidden />
            ))}
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

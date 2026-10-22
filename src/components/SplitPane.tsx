/**
 * 分屏查看窗格（0.31 用户反馈：标签页支持分屏查看）：把一篇笔记以**只读渲染**
 * 视图钉在编辑区右侧，与正在编辑的笔记对照阅读。标签右键菜单「分屏查看」进入，
 * 窗格标题栏关闭。
 *
 * 为什么是只读渲染而不是第二个编辑器：用户的场景是「写 A 笔记时对照 B 笔记
 * （表清单/培训文档）」——查看即阅读，渲染视图信息密度最高，也天然规避双编辑器
 * 的保存/搜索/装饰联动复杂度。内容源由 App 注入：分屏文件是激活标签时传编辑器
 * 实时内容（跟键入防抖刷新），否则传它的存量状态或磁盘版本。
 *
 * 渲染管线与嵌入笔记/悬停预览同一条（markdown-it，链接不可导航），wiki 引用
 * 点击走 App 的统一 document 委托，上下文按**分屏文件**解析相对路径。
 */

import { useEffect, useMemo, useState } from "react";
import { renderMarkdownToHtml } from "../lib/embed";
import { EMPTY_CONTEXT, type LivePreviewContext } from "../lib/paths";
import { IconX } from "./icons";

export default function SplitPane({
  title,
  markdown,
  revision,
  notePath,
  context,
  onClose,
  onPaneFocus,
}: {
  /** 窗格标题（文件名）。 */
  title: string;
  /** 要渲染的 Markdown 全文。 */
  markdown: string;
  /** 内容代际：编辑中的分屏文件每击键 +1，这里据此防抖重渲染。 */
  revision: number;
  /** 分屏文件的仓库相对路径（资源上下文按它解析）。 */
  notePath: string;
  /** 资源上下文（App 的可变对象快照，notePath 已按分屏文件替换）。 */
  context: LivePreviewContext;
  onClose: () => void;
  /** 鼠标按下时上报（目录面板跟随「最后聚焦的窗格」）。 */
  onPaneFocus: () => void;
}) {
  const [html, setHtml] = useState("");

  // 资源上下文按分屏文件解析相对路径：浅拷贝换 notePath，不动 App 的可变原件
  const ctx = useMemo<LivePreviewContext>(
    () => (context ? { ...context, notePath } : EMPTY_CONTEXT),
    [context, notePath],
  );

  useEffect(() => {
    let alive = true;
    // 400ms 防抖：跟键入节奏刷新，不在每次击键后都跑一遍 markdown-it
    const timer = window.setTimeout(() => {
      if (!alive) return;
      void renderMarkdownToHtml(markdown, ctx)
        .then((rendered) => {
          if (alive) setHtml(rendered);
        })
        .catch(() => {
          if (alive) setHtml("");
        });
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [markdown, revision, ctx]);

  return (
    <section className="split-pane" aria-label={`分屏查看 ${title}`} onMouseDown={onPaneFocus}>
      <div className="split-pane-head">
        <span className="split-pane-title" title={title}>
          {title}
        </span>
        <span className="split-pane-badge">只读</span>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          title="关闭分屏 (Esc 也可)"
        >
          <IconX size={13} />
        </button>
      </div>
      {html ? (
        // markdown-it 管线 html:false 已转义原始 HTML；链接降级为 span 不可导航。
        // 挂 cm-lp-embed-body 复用嵌入笔记的整套正文样式（标题/表格/代码块）
        <div
          className="split-pane-body cm-lp-embed-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="split-pane-body split-pane-loading">正在渲染…</div>
      )}
    </section>
  );
}

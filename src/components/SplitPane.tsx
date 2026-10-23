/**
 * 分屏编辑窗格（0.31 引入只读渲染；0.32 按用户反馈改为**可编辑**）：把一篇笔记
 * 以第二个完整编辑器钉在编辑区右侧，与主编辑器并列——两边都能编辑、都有各自
 * 的文件内搜索（Ctrl+F）、都支持悬浮预览与表格就地编辑。
 *
 * 职责划分：本组件只做**宿主**——挂载时创建一个空 EditorView 交给 App（onReady），
 * 卸载时销毁并上报（onDestroy）；装什么内容（EditorState）、保存、大纲、外部
 * 改动对账全在 App 侧（与主编辑器同一套 stateStore 机制，见 App 的分屏区）。
 *
 * 硬性不变量（App 侧保证）：分屏文件 ≠ 当前激活标签——两个视图各持一份
 * EditorState，同一篇同时出现在两边会让"最后落盘者覆盖"悄悄丢内容。
 */

import { useLayoutEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { IconX } from "./icons";

export default function SplitPane({
  title,
  hostClass,
  onClose,
  onPaneFocus,
  onReady,
  onDestroy,
}: {
  /** 窗格标题（文件名）。 */
  title: string;
  /** 编辑区宿主的类名（is-live / is-source 随全局视图模式走）。 */
  hostClass: string;
  onClose: () => void;
  /** 鼠标按下时上报（目录面板跟随「最后聚焦的窗格」）。 */
  onPaneFocus: () => void;
  /** 视图创建后上报（App 由此装内容、接管保存与大纲）。 */
  onReady: (view: EditorView) => void;
  /** 视图销毁后上报（App 清引用）。 */
  onDestroy: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(onReady);
  const destroyRef = useRef(onDestroy);
  readyRef.current = onReady;
  destroyRef.current = onDestroy;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 先建空视图占位（同一帧内 App 的分屏 effect 会 setState 换上真实内容）。
    // 调试句柄与 __qnView 同一套约定（CDP 验收脚本用）。
    const view = new EditorView({ state: EditorState.create({}), parent: host });
    (window as unknown as Record<string, unknown>).__qnSplitView = view;
    readyRef.current(view);
    return () => {
      delete (window as unknown as Record<string, unknown>).__qnSplitView;
      destroyRef.current();
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="split-pane" aria-label={`分屏编辑 ${title}`} onMouseDown={onPaneFocus}>
      <div className="split-pane-head">
        <span className="split-pane-title" title={title}>
          {title}
        </span>
        <span className="split-pane-badge">分屏</span>
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
      <div className={`split-pane-body split-editor-host ${hostClass}`} ref={hostRef} />
    </section>
  );
}

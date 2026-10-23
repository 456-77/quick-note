/**
 * 分屏窗格宿主（0.32.2 Obsidian 式分栏）：右栏的编辑器容器。标签栏由 App
 * 渲染在右栏列里（与左栏同构）——本组件只负责 EditorView 的生命周期：挂载时
 * 建一个空视图交给 App（onReady），卸载时销毁并上报（onDestroy）。装什么
 * 内容（EditorState）、保存、大纲、外部改动对账全在 App 侧。
 */

import { useLayoutEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export default function SplitPane({
  hostClass,
  onPaneFocus,
  onReady,
  onDestroy,
}: {
  /** 编辑区宿主的类名（is-live / is-source 随全局视图模式走）。 */
  hostClass: string;
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
    // 先建空视图占位（同一帧内 App 的装载 effect 会 setState 换上真实内容）。
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
    <div
      className={`split-editor-host ${hostClass}`}
      ref={hostRef}
      onMouseDown={onPaneFocus}
    />
  );
}

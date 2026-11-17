/**
 * 快速笔记/收录/查词/JSON 弹窗的 拖拽移动 + 置顶固定（0.39.19 用户反馈
 * 「速记，ddl，单词，json转换弹窗添加支持拖动，同时添加一个固定按钮，可以
 * 显示在屏幕最上面，离开笔记软件也一直显示」）。
 *
 * - 拖拽：按住弹窗头部（标题行）拖动，绕过 React 直接写根元素 left/top，
 *   首次拖动把 `translateX(-50%)` 的居中定位换成普通 left/top。桌面限定——
 *   移动端弹窗是底部 sheet，不拖、也不出置顶钮。
 * - 置顶：主窗口已有「窗口置顶」能力（App 标题栏按钮，localStorage
 *   `quicknote.alwaysOnTop`）。弹窗里的 📌 按钮直接复用这套全局开关
 *   （事件 `qn-toggle-always-on-top` / `qn-always-on-top` 与 App 双向同步），
 *   窗口置顶后弹窗自然「离开笔记软件也一直显示」。关掉置顶在标题栏或
 *   再按一次 📌 都可以。
 *
 * 拖拽用 pointer capture：指针移出头部/窗口也能继续收 move，松手自动结束。
 */
import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { isMobile } from "../lib/platform.ts";

/** 弹窗头部（标题行）的拖拽手柄 props。rootRef 指向弹窗根元素。 */
export function useDialogDrag(rootRef: RefObject<HTMLElement | null>) {
  const dragRef = useRef<{
    px: number;
    py: number;
    left: number;
    top: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile() || event.button !== 0) return;
      // 头部里的按钮/输入控件照常工作，不充当拖拽把手
      const hit = event.target as HTMLElement;
      if (hit.closest("button, input, textarea, select, a, kbd")) return;
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      dragRef.current = {
        px: event.clientX,
        py: event.clientY,
        left: rect.left,
        top: rect.top,
      };
      // 头部拖动时别选中标题文本
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 老内核不支持 capture 就只能头内拖动，可接受
      }
    },
    [rootRef],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const root = rootRef.current;
      if (!drag || !root) return;
      const width = root.offsetWidth;
      // 至少留 60px 在屏幕内，别把弹窗拖丢
      const left = Math.min(
        window.innerWidth - 60,
        Math.max(60 - width, drag.left + event.clientX - drag.px),
      );
      const top = Math.min(window.innerHeight - 40, Math.max(0, drag.top + event.clientY - drag.py));
      root.style.left = `${Math.round(left)}px`;
      root.style.top = `${Math.round(top)}px`;
      root.style.transform = "none"; // 撤掉居中的 translateX(-50%)
    },
    [rootRef],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 没 capture 过就忽略
    }
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}

/**
 * 弹窗固定开关（0.39.19 用户二轮反馈「我要的只是弹窗固定，而不是整个软件
 * 界面都固定」）：**只管弹窗本身**——固定后点其他区域不关弹窗、背后的应用
 * 照常可操作（各弹窗据此不渲染 menu-backdrop）；**不动主窗口的置顶**。
 * 弹窗在主窗里，切到别的软件时会跟着应用走；要真正独立悬浮需单开置顶窗口，
 * 是另一轮的事。状态是各弹窗自己的（关窗即复位）。
 */
export function useDialogPinned(): [
  boolean,
  (value: boolean | ((prev: boolean) => boolean)) => void,
] {
  const [pinned, setPinned] = useState(false);
  return [pinned, setPinned];
}

/**
 * 弹窗头部的 📌 固定钮（桌面限定渲染）。受控组件：固定状态归弹窗所有。
 */
export function DialogPinButton({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  if (isMobile()) return null;
  return (
    <button
      type="button"
      className={`quick-capture-pin${pinned ? " is-on" : ""}`}
      title={pinned ? "取消固定（恢复点其他区域关闭）" : "固定弹窗（点其他区域不再关闭，可拖到一旁边干活边记）"}
      aria-pressed={pinned}
      onClick={onToggle}
    >
      📌
    </button>
  );
}

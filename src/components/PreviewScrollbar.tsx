/**
 * 预览浮层滚动条（0.39.17 用户反馈「滚轮不要占用空间，悬浮在空隙上」；
 * 0.39.18 反馈「预览文件放大后上下以及左右没有滑杆 / excel 上下和左右都没有
 * 滑杆了」——补横向 thumb，并修掉内容异步变高时 thumb 不刷新）：
 *
 * 原生 webkit 滚动条恒占布局位，把预览内容挤掉一条 9-15px 的空槽；这里隐藏
 * 原生条（styles.css 的 html:not(.qn-mobile) 段），自绘**横纵两条**悬浮 thumb
 * 贴容器右/下缘——不占布局位，悬停加深、可拖拽。
 *
 * 刷新策略三路兜底（内容高度变化的来源太杂：pdf 占位重排 / iframe 高度写入 /
 * 表格虚拟化 / docx 异步渲染）：
 * 1. scroll 事件（即时）；
 * 2. ResizeObserver 观察容器盒子；
 * 3. 200ms 轮询 scrollWidth/scrollHeight（异步内容变高变了但容器盒子不变时，
 *    前两路都收不到信号——旧实现只观察首个子元素，节点一换就失联）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  /** 滚动容器（预览 body / Excel 的 sheet-body）。 */
  targetRef: React.RefObject<HTMLElement | null>;
  /** 移动端滚动条已全局隐藏，不渲染自绘条。 */
  visible?: boolean;
}

type Thumb = { offset: number; size: number };

/** 与上次值差 <0.5px 就复用旧对象：200ms 轮询不至于每轮都触发 re-render。 */
function sameThumb(prev: Thumb | null, next: Thumb | null): boolean {
  if (prev === null || next === null) return prev === next;
  return Math.abs(prev.offset - next.offset) < 0.5 && Math.abs(prev.size - next.size) < 0.5;
}

export default function PreviewScrollbar({ targetRef, visible = true }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    axis: "x" | "y";
    start: number;
    startScroll: number;
    maxScroll: number;
    travel: number;
  } | null>(null);
  const [vert, setVert] = useState<Thumb | null>(null);
  const [horiz, setHoriz] = useState<Thumb | null>(null);

  const update = useCallback(() => {
    const el = targetRef.current;
    const root = rootRef.current;
    if (!el || !root) {
      setVert((prev) => (prev === null ? prev : null));
      setHoriz((prev) => (prev === null ? prev : null));
      return;
    }
    const viewW = el.clientWidth;
    const viewH = el.clientHeight;
    const contentW = el.scrollWidth;
    const contentH = el.scrollHeight;
    const trackW = root.clientWidth;
    const trackH = root.clientHeight;

    const nextVert: Thumb | null =
      contentH > viewH + 1 && trackH > 0
        ? {
            size: Math.max(28, (viewH / contentH) * trackH),
            offset: 0,
          }
        : null;
    if (nextVert) {
      nextVert.offset = (el.scrollTop / (contentH - viewH)) * (trackH - nextVert.size);
    }
    const nextHoriz: Thumb | null =
      contentW > viewW + 1 && trackW > 0
        ? {
            size: Math.max(28, (viewW / contentW) * trackW),
            offset: 0,
          }
        : null;
    if (nextHoriz) {
      nextHoriz.offset = (el.scrollLeft / (contentW - viewW)) * (trackW - nextHoriz.size);
    }
    setVert((prev) => (sameThumb(prev, nextVert) ? prev : nextVert));
    setHoriz((prev) => (sameThumb(prev, nextHoriz) ? prev : nextHoriz));
  }, [targetRef]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    update();
    const onScroll = () => update();
    el.addEventListener("scroll", onScroll, { passive: true });
    // 异步内容变高（pdf 渲染/iframe 高度写入/表格虚拟化）不会触发容器盒子变化，
    // 200ms 轮询是成本最低的兜底（同一帧内多次 set 都被 sameThumb 吞掉）
    const timer = window.setInterval(update, 200);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => update());
      ro.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearInterval(timer);
      ro?.disconnect();
    };
  }, [targetRef, update]);

  const beginDrag = (axis: "x" | "y", event: React.PointerEvent<HTMLDivElement>) => {
    const el = targetRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const maxScroll = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    const thumbSize = axis === "y" ? vert?.size ?? 0 : horiz?.size ?? 0;
    const track = axis === "y" ? root.clientHeight : root.clientWidth;
    dragRef.current = {
      axis,
      start: axis === "y" ? event.clientY : event.clientX,
      startScroll: axis === "y" ? el.scrollTop : el.scrollLeft,
      maxScroll,
      travel: track - thumbSize,
    };
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = targetRef.current;
    if (!drag || !el || drag.travel <= 0) return;
    const delta = (drag.axis === "y" ? event.clientY : event.clientX) - drag.start;
    const next = drag.startScroll + (delta / drag.travel) * drag.maxScroll;
    const clamped = Math.max(0, Math.min(drag.maxScroll, next));
    if (drag.axis === "y") el.scrollTop = clamped;
    else el.scrollLeft = clamped;
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  /** thumb 是 body 的兄弟节点（不在滚动容器内部），滚轮落在它上面不会滚 body
      ——手动转发一下（8px 的窄条，聊胜于无）。 */
  const forwardWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const el = targetRef.current;
    if (!el) return;
    el.scrollTop += event.deltaY;
    el.scrollLeft += event.deltaX;
  };

  if (!visible) return null;

  return (
    <div className="preview-scrollbar" ref={rootRef} aria-hidden>
      {vert && (
        <div
          className="preview-scrollbar-thumb is-v"
          style={{ top: vert.offset, height: vert.size }}
          onPointerDown={(event) => beginDrag("y", event)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={forwardWheel}
        />
      )}
      {horiz && (
        <div
          className="preview-scrollbar-thumb is-h"
          style={{ left: horiz.offset, width: horiz.size }}
          onPointerDown={(event) => beginDrag("x", event)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={forwardWheel}
        />
      )}
    </div>
  );
}

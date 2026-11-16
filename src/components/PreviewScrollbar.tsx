/**
 * 预览浮层滚动条（0.39.17 用户反馈「滚轮不要占用空间，悬浮在空隙上」）：
 * 原生 webkit 滚动条恒占布局位，把预览内容挤掉一条 9-15px 的空槽；这里隐藏
 * 原生条，自绘一条悬浮 thumb 贴容器右缘——不占布局位，悬停加深、可拖拽。
 *
 * 只做纵向（预览内容横向溢出极少见；真有横向溢出时内容仍可拖/滚，只是没有
 * 横向指示）。thumb 位置由 scroll/resize 事件驱动：scroll 走容器监听，内容
 * 高度变化（pdf 占位重排 / iframe 高度写入 / 表格行数变化）走 ResizeObserver
 * ——容器自身 + 首个子元素都观察（容器盒子不变但内容变高时靠后者兜底）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  /** 滚动容器（预览 body / Excel 的 sheet-body）。 */
  targetRef: React.RefObject<HTMLElement | null>;
  /** 移动端滚动条已全局隐藏，不渲染自绘条。 */
  visible?: boolean;
}

export default function PreviewScrollbar({ targetRef, visible = true }: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startY: number;
    startScroll: number;
    maxScroll: number;
    travel: number;
  } | null>(null);
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);

  const update = useCallback(() => {
    const el = targetRef.current;
    const track = trackRef.current;
    if (!el || !track) {
      setThumb(null);
      return;
    }
    const viewH = el.clientHeight;
    const contentH = el.scrollHeight;
    if (contentH <= viewH + 1) {
      setThumb(null);
      return;
    }
    const trackH = track.clientHeight;
    if (trackH <= 0) return;
    const height = Math.max(28, (viewH / contentH) * trackH);
    const top = (el.scrollTop / (contentH - viewH)) * (trackH - height);
    setThumb({ top, height });
  }, [targetRef]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    update();
    const onScroll = () => update();
    el.addEventListener("scroll", onScroll, { passive: true });
    let ro: ResizeObserver | undefined;
    let childRo: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => update());
      ro.observe(el);
      childRo = new ResizeObserver(() => update());
      // 内容尺寸变化大多体现在首个子元素的盒子上（pdf 页位重排 / iframe /
      // 表格容器）；容器自身盒子变化由上面的 ro 覆盖
      if (el.firstElementChild) childRo.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      childRo?.disconnect();
    };
  }, [targetRef, update]);

  const onThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = targetRef.current;
    if (!el || !thumb) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startY: event.clientY,
      startScroll: el.scrollTop,
      maxScroll: el.scrollHeight - el.clientHeight,
      travel: (thumb ? trackRef.current?.clientHeight ?? 0 : 0) - thumb.height,
    };
  };

  const onThumbPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = targetRef.current;
    if (!drag || !el || drag.travel <= 0) return;
    const next = drag.startScroll + ((event.clientY - drag.startY) / drag.travel) * drag.maxScroll;
    el.scrollTop = Math.max(0, Math.min(drag.maxScroll, next));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  if (!visible) return null;

  return (
    <div className="preview-scrollbar" ref={trackRef} aria-hidden>
      {thumb && (
        <div
          className="preview-scrollbar-thumb"
          style={{ top: thumb.top, height: thumb.height }}
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      )}
    </div>
  );
}

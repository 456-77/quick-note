/**
 * 图片灯箱：渲染态图片点「放大」后全屏查看。
 *
 * 独立于编辑器的纯 DOM 浮层（不参与 CM6 布局，不影响高度图）：
 * 滚轮缩放（以指针为中心）、拖拽平移、双击在「适应窗口 / 100%」间切换、
 * Esc / 点击背景 / 关闭钮退出。同一时刻只有一个实例，重复打开先关旧的。
 *
 * 0.34.6 两轮重做（用户反馈）：
 * - 「预览清晰度和原本的图片文件差了很多」：缩放从 transform:scale 改成 width
 *   布局尺寸——transform 是先把元素光栅成位图再做矩阵变换，放大就是拉糊位图；
 *   布局缩放让浏览器每次按目标尺寸从原图重新采样，任何倍率都锐利（mermaid
 *   灯箱 0.24 同坑同修，见 livePreview.ts「transform 放大只会把糊的位图拉大」）。
 * - 移动端：初始按宽度适应（此前按高度适应，超宽截图缩成一条线）、双指捏合
 *   缩放 + 单指拖动 + 双击适应/1:1（此前只有 +/- 按钮）；灯箱内滑动不再触发
 *   抽屉开合——touchmove 一律 preventDefault，App 内容区手势的浮层排除名单
 *   也加了 .qn-lightbox。
 */

import { isMobile } from "./platform.ts";

let open: { destroy: () => void } | null = null;

/** 关掉当前灯箱（若已打开）。 */
export function closeLightbox(): void {
  open?.destroy();
  open = null;
}

/** 打开灯箱查看图片。src 是可直接赋给 <img>.src 的地址。 */
export function openLightbox(src: string, alt: string): void {
  closeLightbox();

  const mobile = isMobile();
  const root = document.createElement("div");
  root.className = "qn-lightbox";

  const img = document.createElement("img");
  img.alt = alt;
  img.draggable = false;
  img.src = src;
  // load 前不给尺寸（避免原图尺寸闪一帧）；fit() 首次 apply 时显示
  img.style.visibility = "hidden";

  const hint = document.createElement("div");
  hint.className = "qn-lightbox-hint";
  hint.textContent = mobile
    ? "双指缩放 · 拖动平移 · 双击 100%/适应"
    : "滚轮缩放 · 拖动平移 · 双击 100%/适应 · Esc 关闭";

  const bar = document.createElement("div");
  bar.className = "qn-lightbox-bar";
  const mkBtn = (text: string, title: string, run: () => void) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qn-lightbox-btn";
    btn.title = title;
    btn.textContent = text;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      run();
    });
    bar.appendChild(btn);
    return btn;
  };

  root.append(img, bar, hint);

  // -------------------------------------------------- 缩放/平移状态
  // scale 表达为布局宽度（naturalWidth * scale px），transform 只留平移
  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    const base = img.naturalWidth || window.innerWidth;
    img.style.width = `${base * scale}px`;
    img.style.transform = `translate(${x}px, ${y}px)`;
    img.style.visibility = "visible";
  };

  const zoomAt = (factor: number, cx: number, cy: number) => {
    const next = Math.min(8, Math.max(0.05, scale * factor));
    if (next === scale) return;
    // 以 (cx, cy)（视口坐标）为锚缩放：图片上该点保持不动
    const dx = cx - window.innerWidth / 2 - x;
    const dy = cy - window.innerHeight / 2 - y;
    const ratio = next / scale;
    x += dx * (1 - ratio);
    y += dy * (1 - ratio);
    scale = next;
    apply();
  };

  // 整图塞进视口（宽高都取小）。桌面沿用；移动端改用按宽适应
  const fitAll = () => {
    scale = Math.min(1, window.innerWidth / (img.naturalWidth || 1), window.innerHeight / (img.naturalHeight || 1));
    x = 0;
    y = 0;
    apply();
  };
  // 按宽度适应：宽度铺满（上限 1:1），高度超出可上下/左右拖——超宽截图不再
  // 被压成一条线（0.34.6 用户反馈「默认显示的很小」）
  const fitWidth = () => {
    scale = Math.min(1, window.innerWidth / (img.naturalWidth || 1));
    x = 0;
    y = 0;
    apply();
  };
  const fit = () => (mobile ? fitWidth() : fitAll());

  const actual = () => {
    scale = 1;
    x = 0;
    y = 0;
    apply();
  };

  img.addEventListener("load", fit, { once: true });

  // -------------------------------------------------- 桌面交互（滚轮/拖动/双击）
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
  };

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    event.preventDefault();
  };
  const onMove = (event: MouseEvent) => {
    if (!dragging) return;
    x += event.clientX - lastX;
    y += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    apply();
  };
  const onUp = () => {
    dragging = false;
  };
  const onDbl = (event: MouseEvent) => {
    event.preventDefault();
    if (scale >= 0.999) fit();
    else actual();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") destroy();
  };
  const onBackdrop = (event: MouseEvent) => {
    if (event.target === root) destroy();
  };

  root.addEventListener("wheel", onWheel, { passive: false });
  img.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  img.addEventListener("dblclick", onDbl);
  window.addEventListener("keydown", onKey);
  root.addEventListener("mousedown", onBackdrop);

  // -------------------------------------------------- 移动端触摸（捏合/单指拖/双击）
  // touchmove 一律 preventDefault：拦掉页面滚动与浏览器手势，App 的抽屉横滑
  // 监听也就拿不到这次触摸；轻点（tap）不产生 move，在 touchend 里自己判定
  let lastTapTime = 0;
  let downX = 0;
  let downY = 0;
  let pinchDist = 0;
  let pinchScale = 1;
  const touchDist = (event: TouchEvent) => {
    const a = event.touches[0];
    const b = event.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  const onTouchStart = (event: TouchEvent) => {
    dragging = false;
    const t = event.touches[0];
    downX = t.clientX;
    downY = t.clientY;
    if (event.touches.length === 2) {
      pinchDist = touchDist(event);
      pinchScale = scale;
    } else if (event.touches.length === 1) {
      lastX = t.clientX;
      lastY = t.clientY;
    }
  };
  const onTouchMove = (event: TouchEvent) => {
    event.preventDefault();
    if (event.touches.length === 2) {
      const dist = touchDist(event);
      if (pinchDist > 0 && dist > 0) {
        const cx = (event.touches[0].clientX + event.touches[1].clientX) / 2;
        const cy = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        const target = Math.min(8, Math.max(0.05, pinchScale * (dist / pinchDist)));
        zoomAt(target / scale, cx, cy);
      }
      return;
    }
    if (event.touches.length === 1) {
      const t = event.touches[0];
      x += t.clientX - lastX;
      y += t.clientY - lastY;
      lastX = t.clientX;
      lastY = t.clientY;
      apply();
    }
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length > 0) return;
    pinchDist = 0;
    // 轻点判定（位移 <10px 才算 tap，拖动/捏合收尾不触发）；点背景关闭、
    // 双击（两次快速轻点在图片上）切换适应/1:1
    const t = event.changedTouches[0];
    const moved = Math.hypot(t.clientX - downX, t.clientY - downY) > 10;
    if (moved) return;
    const target = event.target;
    const now = Date.now();
    if (now - lastTapTime < 320 && target === img) {
      lastTapTime = 0;
      if (scale >= 0.999) fit();
      else actual();
      return;
    }
    lastTapTime = now;
    if (target === root) destroy();
  };

  if (mobile) {
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd);
  }

  mkBtn("＋", "放大", () => zoomAt(1.25, window.innerWidth / 2, window.innerHeight / 2));
  mkBtn("－", "缩小", () => zoomAt(1 / 1.25, window.innerWidth / 2, window.innerHeight / 2));
  mkBtn("1:1", "原始尺寸", actual);
  mkBtn("适应", mobile ? "适应宽度" : "适应窗口", fit);
  mkBtn("✕", "关闭 (Esc)", destroy);

  document.body.appendChild(root);

  function destroy() {
    root.removeEventListener("wheel", onWheel);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey);
    root.removeEventListener("mousedown", onBackdrop);
    if (mobile) {
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
    }
    root.remove();
    if (open && open.destroy === destroy) open = null;
  }

  open = { destroy };
}

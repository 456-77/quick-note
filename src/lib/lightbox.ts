/**
 * 图片灯箱：渲染态图片点「放大」后全屏查看。
 *
 * 独立于编辑器的纯 DOM 浮层（不参与 CM6 布局，不影响高度图）：
 * 滚轮缩放（以指针为中心）、拖拽平移、双击在「适应窗口 / 100%」间切换、
 * Esc / 点击背景 / 关闭钮退出。同一时刻只有一个实例，重复打开先关旧的。
 */

let open: { destroy: () => void } | null = null;

/** 关掉当前灯箱（若已打开）。 */
export function closeLightbox(): void {
  open?.destroy();
  open = null;
}

/** 打开灯箱查看图片。src 是可直接赋给 <img>.src 的地址。 */
export function openLightbox(src: string, alt: string): void {
  closeLightbox();

  const root = document.createElement("div");
  root.className = "qn-lightbox";

  const img = document.createElement("img");
  img.alt = alt;
  img.draggable = false;
  img.src = src;

  const hint = document.createElement("div");
  hint.className = "qn-lightbox-hint";
  hint.textContent = "滚轮缩放 · 拖动平移 · 双击 100%/适应 · Esc 关闭";

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
  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
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

  const fit = () => {
    scale = Math.min(1, window.innerWidth / (img.naturalWidth || 1), window.innerHeight / (img.naturalHeight || 1));
    x = 0;
    y = 0;
    apply();
  };

  const actual = () => {
    scale = 1;
    x = 0;
    y = 0;
    apply();
  };

  img.addEventListener("load", fit, { once: true });

  // -------------------------------------------------- 交互
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

  mkBtn("＋", "放大", () => zoomAt(1.25, window.innerWidth / 2, window.innerHeight / 2));
  mkBtn("－", "缩小", () => zoomAt(1 / 1.25, window.innerWidth / 2, window.innerHeight / 2));
  mkBtn("1:1", "原始尺寸", actual);
  mkBtn("适应", "适应窗口", fit);
  mkBtn("✕", "关闭 (Esc)", destroy);

  document.body.appendChild(root);

  function destroy() {
    root.removeEventListener("wheel", onWheel);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey);
    root.removeEventListener("mousedown", onBackdrop);
    root.remove();
    if (open && open.destroy === destroy) open = null;
  }

  open = { destroy };
}

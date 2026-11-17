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
import { screenshotOcr } from "./api.ts";
import {
  cropImageRegionBase64,
  SELECTION_MIN_DRAG,
  selectionToRegion,
  type PixelRegion,
} from "./imageOcr.ts";

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
    if (framing) return; // 框选态不缩放
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
  };

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onDown = (event: MouseEvent) => {
    if (framing) return; // 框选态不平移（按下是框选起点）
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
    if (event.key !== "Escape") return;
    if (framing) {
      // 框选态先退框选，再按一次才关灯箱
      exitFraming();
      return;
    }
    destroy();
  };
  const onBackdrop = (event: MouseEvent) => {
    if (framing) return; // 框选态点背景（含选框起点）不关闭
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
  // 单击切工具条的延迟器（等 320ms 区分双击；双击取消）
  let chromeTimer: number | null = null;
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
    if (event.touches.length === 1) {
      // 0.38.3 用户反馈「放大或缩小时一旦手指离开屏幕，图片位置会发生偏移」：
      // 双指收起一根转单指拖动——基准点必须重置到剩余手指，否则单指一动就从
      // 捏合前的旧坐标起跳（x/y 直接跳一截）。口径同 mermaid 灯箱
      const rest = event.touches[0];
      lastX = rest.clientX;
      lastY = rest.clientY;
      return;
    }
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
      // 双击：取消待生效的单击切 chrome（见下），执行适应/1:1
      if (chromeTimer !== null) {
        window.clearTimeout(chromeTimer);
        chromeTimer = null;
      }
      lastTapTime = 0;
      if (scale >= 0.999) fit();
      else actual();
      return;
    }
    lastTapTime = now;
    if (target === root) {
      destroy();
      return;
    }
    // 0.38.3 用户反馈「操作选项能不能点击图片时自动隐藏，再次点击恢复」：
    // 单击图片延迟 320ms 切工具条显隐（等待期来了第二击就是双击，取消）。
    // 只在图片上生效，点背景仍是关闭
    if (target === img) {
      chromeTimer = window.setTimeout(() => {
        chromeTimer = null;
        root.classList.toggle("is-chrome-off");
      }, 320);
    }
  };

  if (mobile) {
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd);
  }

  // -------------------------------------------------- OCR 框选识别（0.39.19）
  // 用户反馈「预览图片的时候，添加识别文本功能」+ 二轮澄清「不是全部识别而是
  // 识别框定的范围内的内容」：点「识别」进入框选态（十字光标），在图上拖一个
  // 框，松手只把框内像素送 OCR；拖动极小（<6px）视为轻点 → 整图识别。
  // screenshot_ocr 是桌面命令（WinRT），移动端不出按钮。
  let ocrBusy = false;
  let ocrPanel: HTMLDivElement | null = null;
  let ocrBtn: HTMLButtonElement | null = null;
  const closeOcrPanel = () => {
    ocrPanel?.remove();
    ocrPanel = null;
  };
  const showOcrPanel = (text: string) => {
    closeOcrPanel();
    const panel = document.createElement("div");
    panel.className = "qn-lightbox-ocr";
    const head = document.createElement("div");
    head.className = "qn-lightbox-ocr-head";
    const title = document.createElement("span");
    title.className = "qn-lightbox-ocr-title";
    title.textContent = "识别结果";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      void navigator.clipboard.writeText(text).then(() => {
        copy.textContent = "已复制";
        window.setTimeout(() => {
          copy.textContent = "复制";
        }, 1200);
      });
    });
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeOcrPanel();
    });
    head.append(title, copy, close);
    const area = document.createElement("textarea");
    area.className = "qn-lightbox-ocr-text";
    area.readOnly = true;
    area.value = text;
    // 面板内的按下不触发灯箱的拖动/关闭链路
    panel.addEventListener("mousedown", (event) => event.stopPropagation());
    panel.append(head, area);
    root.appendChild(panel);
    ocrPanel = panel;
  };

  const startOcr = async (region: PixelRegion | null) => {
    if (ocrBusy) return;
    ocrBusy = true;
    ocrBtn?.classList.add("is-busy");
    try {
      const base64 = await cropImageRegionBase64(src, region);
      const text = await screenshotOcr(base64);
      showOcrPanel(
        text.trim()
          ? text
          : "没有识别出文字（框内可能没有文本，或系统缺少 OCR 语言包）",
      );
    } catch (error) {
      showOcrPanel(`识别失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ocrBusy = false;
      ocrBtn?.classList.remove("is-busy");
    }
  };

  // 框选态：十字光标 + 提示文案；图上拖一个框，松手只识别框内
  let framing = false;
  let selFrom: { x: number; y: number } | null = null;
  let selEl: HTMLDivElement | null = null;
  const desktopHint = "滚轮缩放 · 拖动平移 · 双击 100%/适应 · Esc 关闭";
  const exitFraming = () => {
    framing = false;
    selFrom = null;
    selEl?.remove();
    selEl = null;
    root.classList.remove("is-framing");
    ocrBtn?.classList.remove("is-on");
    hint.textContent = desktopHint;
  };
  const toggleFraming = () => {
    if (framing) {
      exitFraming();
      return;
    }
    if (ocrBusy) return;
    closeOcrPanel();
    framing = true;
    root.classList.add("is-framing");
    ocrBtn?.classList.add("is-on");
    hint.textContent = "拖动框选要识别的区域（轻点=整图识别） · Esc 取消";
  };
  const onFrameDown = (event: MouseEvent) => {
    if (!framing || event.button !== 0) return;
    // 工具条/结果面板上的按下不是框选
    if ((event.target as HTMLElement).closest(".qn-lightbox-bar, .qn-lightbox-ocr")) return;
    event.preventDefault();
    event.stopPropagation();
    selFrom = { x: event.clientX, y: event.clientY };
    selEl = document.createElement("div");
    selEl.className = "qn-lightbox-frame";
    root.appendChild(selEl);
    const onMove = (ev: MouseEvent) => {
      if (!selFrom || !selEl) return;
      selEl.style.left = `${Math.min(selFrom.x, ev.clientX)}px`;
      selEl.style.top = `${Math.min(selFrom.y, ev.clientY)}px`;
      selEl.style.width = `${Math.abs(ev.clientX - selFrom.x)}px`;
      selEl.style.height = `${Math.abs(ev.clientY - selFrom.y)}px`;
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const from = selFrom;
      selFrom = null;
      selEl?.remove();
      selEl = null;
      if (!from) return;
      const drag = Math.hypot(ev.clientX - from.x, ev.clientY - from.y);
      // 轻点=整图；拖出框=只识别框内
      const region =
        drag < SELECTION_MIN_DRAG
          ? null
          : selectionToRegion(img, from.x, from.y, ev.clientX, ev.clientY);
      exitFraming();
      void startOcr(region);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  root.addEventListener("mousedown", onFrameDown);

  mkBtn("＋", "放大", () => zoomAt(1.25, window.innerWidth / 2, window.innerHeight / 2));
  mkBtn("－", "缩小", () => zoomAt(1 / 1.25, window.innerWidth / 2, window.innerHeight / 2));
  mkBtn("1:1", "原始尺寸", actual);
  mkBtn("适应", mobile ? "适应宽度" : "适应窗口", fit);
  if (!mobile) {
    ocrBtn = mkBtn("识别", "框选图中区域识别文字（轻点=整图）", toggleFraming);
  }
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
    if (chromeTimer !== null) {
      window.clearTimeout(chromeTimer);
      chromeTimer = null;
    }
    root.remove();
    if (open && open.destroy === destroy) open = null;
  }

  open = { destroy };
}

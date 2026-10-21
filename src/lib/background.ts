/**
 * 全局背景图片：把仓库内的一张图垫在界面最底层，营造氛围。
 *
 * 与插件的同一套可调参数（不透明度/模糊/亮度/对比度/位置/缩放/适配），归属是
 * **每仓库一份**（0.26 用户反馈：背景图是从当前仓库选的，换仓库不该还挂着
 * 上一个仓库的图）。仍存本机设置、不进仓库、不随同步走——背景是纯观感偏好。
 *
 * 与插件的一个刻意差异：不支持视频动态壁纸。技术选型里已经写明视频壁纸是
 * 内存杀手（常驻解码 + 一份全屏纹理），对"轻量"目标是反向优化，刻意不移植。
 *
 * 实现要点：背景层是 `#qn-bg-layer`（fixed、z-index 0、pointer-events:none），
 * 界面内容在其上（z-index ≥ 1）；启用时 `html` 挂 `qn-bg-on` 类，由 CSS 把
 * 顶栏/侧栏/编辑器卡片等表面色改成半透明，背景才透得出来。层自身不接收
 * 事件、也不盖住任何内容，所以不影响顶栏拖拽与点击。图层的可见度完全由
 * 用户的不透明度滑杆控制（0.26 回退了 0.25 短暂引入的主题色遮罩——它把图
 * 压到 ~12% 感知透明度，滑杆怎么调都"几乎看不见背景"）。
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import type { BgSettings } from "./settings.ts";

const LAYER_ID = "qn-bg-layer";
const ROOT_CLASS = "qn-bg-on";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const SHARPEN_SVG_ID = "qn-bg-sharpen-defs";
const SHARPEN_FILTER_ID = "qn-bg-sharpen";

/**
 * 注入/更新锐化滤镜（SVG feConvolveMatrix），返回 CSS filter 里的引用串。
 *
 * 背景层与设置页预览共用同一个滤镜：同一个 document 里一个 id 只能有一份，
 * 谁先用到就由谁创建，之后只改 kernelMatrix。强度 0 时不启用（不返回引用），
 * 免得给纯浏览场景白付一次全屏卷积。
 */
export function sharpenFilterRef(strength: number): string {
  if (typeof document === "undefined") return "";
  const amount = clamp(strength, 0, 100) / 100;
  if (amount <= 0) return "";

  let svg = document.getElementById(SHARPEN_SVG_ID) as SVGSVGElement | null;
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = SHARPEN_SVG_ID;
    // 定义型 SVG：不参与布局，也不能拦截事件
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.overflow = "hidden";
    svg.style.pointerEvents = "none";
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.id = SHARPEN_FILTER_ID;
    // 扩大滤镜区域：负权重的 3×3 卷积会在边缘取样，默认 -10%/120% 会把
    // 边缘一圈切掉（表现为背景图四周突然变透明）。
    filter.setAttribute("x", "-10%");
    filter.setAttribute("y", "-10%");
    filter.setAttribute("width", "120%");
    filter.setAttribute("height", "120%");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const kernel = document.createElementNS("http://www.w3.org/2000/svg", "feConvolveMatrix");
    kernel.setAttribute("order", "3");
    kernel.setAttribute("preserveAlpha", "true");
    kernel.setAttribute("edgeMode", "duplicate");
    filter.appendChild(kernel);
    svg.appendChild(filter);
    document.body.appendChild(svg);
  }

  // 标准 3×3 锐化核：中心 1+4a，四邻 -a。a 越大边缘越硬，过 0.5 会出现
  // 明显白边/光晕，所以滑杆 100% 也只到 0.5。
  const a = amount * 0.5;
  const center = 1 + 4 * a;
  const kernel = svg.querySelector("feConvolveMatrix");
  kernel?.setAttribute(
    "kernelMatrix",
    `0 ${-a} 0 ${-a} ${center} ${-a} 0 ${-a} 0`,
  );
  return `url(#${SHARPEN_FILTER_ID})`;
}

/** 背景层/预览共用的 filter 串（顺序：模糊 → 亮度 → 对比度 → 锐化）。 */
export function bgFilterCss(bg: BgSettings): string {
  const blur = clamp(bg.bgBlur, 0, 50);
  const sharpen = sharpenFilterRef(bg.bgSharpen ?? 0);
  return [
    blur > 0 ? `blur(${blur}px)` : "",
    `brightness(${clamp(bg.bgBrightness, 10, 200)}%)`,
    `contrast(${clamp(bg.bgContrast, 10, 200)}%)`,
    sharpen,
  ]
    .filter(Boolean)
    .join(" ");
}

/** 把一张背景参数快照铺到 DOM 上。参数改变、仓库切换后都要重新调用。 */
export function applyBackground(bg: BgSettings, vaultPath: string | null): void {
  if (typeof document === "undefined") return; // Node 测试环境没有 DOM
  const root = document.documentElement;
  const enabled = bg.bgEnabled && bg.bgImagePath.trim().length > 0 && !!vaultPath;

  let layer = document.getElementById(LAYER_ID);
  if (!enabled) {
    layer?.remove();
    root.classList.remove(ROOT_CLASS);
    return;
  }

  if (!layer) {
    layer = document.createElement("div");
    layer.id = LAYER_ID;
    document.body.appendChild(layer);
  }
  root.classList.add(ROOT_CLASS);

  // 仓库内相对路径 → 绝对路径 → asset URL。背景路径是仓库内路径（与插件一致），
  // 这里靠 vaultPath 现场拼出绝对路径；仓库没开就不显示（enabled 已挡住）。
  const relative = bg.bgImagePath.trim().replace(/\\/g, "/");
  const absolute = `${vaultPath!.replace(/[\\/]+$/, "")}/${relative}`;
  const blur = clamp(bg.bgBlur, 0, 50);
  const scale = clamp(bg.bgScale, 10, 400) / 100;
  layer.style.backgroundImage = `url("${convertFileSrc(absolute)}")`;
  layer.style.backgroundPosition = `${bg.bgPosX}% ${bg.bgPosY}%`;
  layer.style.backgroundSize = bg.bgFit === "contain" ? "contain" : "cover";
  layer.style.backgroundRepeat = "no-repeat";
  layer.style.opacity = String(clamp(bg.bgOpacity, 0, 1));
  // filter 只放合法的 filter 函数。0.26 及之前把 scale() 塞进了 filter——它不是
  // filter 函数，整条声明被浏览器判无效丢弃，模糊/亮度/对比度跟着全部失效
  // （0.27 用户反馈"调节不明显"的根因）。0.28 追加锐化：低分辨率背景图被
  // cover 放大后靠它找回边缘（用户 850×478 的图铺 1920 宽窗口）。
  layer.style.filter = bgFilterCss(bg);
  // 缩放走 transform，锚点跟随位置滑杆：放大后拖位置才有可感的平移。
  layer.style.transform = scale !== 1 ? `scale(${scale})` : "";
  layer.style.transformOrigin = `${bg.bgPosX}% ${bg.bgPosY}%`;
  // 模糊会把边缘糊成透明（fixed 层从视口外取不到像素）：把层往外扩一圈，
  // inset:0 + 负 margin 会把盒子撑出视口，糊边就落在视口外。
  layer.style.margin = blur > 0 ? `${-Math.ceil(blur * 2)}px` : "";
}


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
import { isMobile } from "./platform";
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

  // 标准 3×3 锐化核：中心 1+4a，四邻 -a。a 越大边缘越硬，0.5 以上开始出现
  // 可感知的白边/光晕——0.28 上限钉在 0.5，但用户把滑杆拉满仍然嫌"发虚"
  // （0.29 反馈），放到底 0.65：白边轻微可接受，换更硬的边缘。
  const a = amount * 0.65;
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

/**
 * 0.34.11 用户反馈「输入内容时背景图片会上移」：键盘弹出时原生把 WebView
 * 压矮（margin=ime.bottom），fixed 的背景层跟着重排，cover 重算——图整张跳位。
 * 把层高锁在「无键盘时的视口高」：键盘期间不跟随（多出的部分被键盘盖住）；
 * 键盘收起/旋转/桌面改窗时延迟 150ms 重锁（等 Kotlin 的 qn-ime-open 类先落地，
 * 避免把压矮中的高度锁进去）。
 */
function syncBgLayerHeight(): void {
  const layer = document.getElementById(LAYER_ID);
  if (!layer) return;
  layer.style.height = `${window.innerHeight}px`;
}

function scheduleBgLayerSync(): void {
  window.setTimeout(() => {
    if (!document.documentElement.classList.contains("qn-ime-open")) syncBgLayerHeight();
  }, 150);
}

let bgSyncWired = false;
function ensureBgLayerSync(): void {
  if (bgSyncWired || typeof window === "undefined") return;
  bgSyncWired = true;
  window.addEventListener("resize", scheduleBgLayerSync);
  window.visualViewport?.addEventListener("resize", scheduleBgLayerSync);
}

/** 把一张背景参数快照铺到 DOM 上。参数改变、仓库切换后都要重新调用。 */
export function applyBackground(bg: BgSettings, vaultPath: string | null): void {
  if (typeof document === "undefined") return; // Node 测试环境没有 DOM
  const root = document.documentElement;
  // 壁纸轮换（0.32）：轮换当前图（绝对路径，可来自仓库外的目录）优先于仓库内
  // 的 bgImagePath——轮换开着时背景由轮换说了算，关掉自动落回仓库内选的图。
  const rotating = bg.bgRotateEnabled && bg.bgImageAbsPath.trim().length > 0;
  const enabled =
    bg.bgEnabled && (rotating || bg.bgImagePath.trim().length > 0) && !!vaultPath;

  if (!enabled) {
    document.getElementById(LAYER_ID)?.remove();
    root.classList.remove(ROOT_CLASS);
    for (const name of VEIL_VARS) root.style.removeProperty(name);
    return;
  }

  let layer = document.getElementById(LAYER_ID);
  if (!layer) {
    layer = document.createElement("div");
    layer.id = LAYER_ID;
    document.body.appendChild(layer);
  }
  root.classList.add(ROOT_CLASS);
  ensureBgLayerSync();
  scheduleBgLayerSync();

  // 壁纸轮换的绝对路径直接用；否则仓库内相对路径 → 绝对路径 → asset URL。
  // 背景路径是仓库内路径（与插件一致），这里靠 vaultPath 现场拼出绝对路径；
  // 仓库没开就不显示（enabled 已挡住）。
  const absolute = rotating
    ? bg.bgImageAbsPath.trim()
    : `${vaultPath!.replace(/[\\/]+$/, "")}/${bg.bgImagePath.trim().replace(/\\/g, "/")}`;
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

  // 界面浓度（bgSurface）：表面半透明底的浓度。CSS 里的基础值（编辑器 80%、
  // 顶栏 82%、侧栏 66%、面板卡 76%）按滑杆等比缩放——80 就是 0.28 及以前的
  // 默认观感，调低背景透得更多，调到 100 表面全实。上限 100 防止溢出成
  // "比不透明还怪"的混合结果。
  // 0.33.0 停点1 用户反馈：移动端按桌面基准半透明，抽屉/面板下的空状态文字
  // 与背景图会透出来叠在列表上（模拟器截图实证）。手机屏窄、面板贴脸，
  // 可读性优先——移动端基准整体提到接近不透明，仅保留一丝氛围；滑杆仍在
  // 各自基准上等比缩放，需求 §十「不同壁纸下都必须保持可读性」。
  const k = clamp((bg.bgSurface ?? 80) / 80, 0, 1.25);
  const bases = isMobile()
    ? { panel: 97, side: 96, editor: 94, card: 95 }
    : { panel: 82, side: 66, editor: 80, card: 76 };
  const veil = (base: number) => `${Math.min(100, base * k)}%`;
  root.style.setProperty("--qn-veil-panel", veil(bases.panel));
  root.style.setProperty("--qn-veil-side", veil(bases.side));
  root.style.setProperty("--qn-veil-editor", veil(bases.editor));
  root.style.setProperty("--qn-veil-card", veil(bases.card));
}

/** 界面浓度写进 html 的 CSS 变量名（关闭背景时逐一移除）。 */
const VEIL_VARS = ["--qn-veil-panel", "--qn-veil-side", "--qn-veil-editor", "--qn-veil-card"];


/**
 * 全局背景图片：把仓库内的一张图垫在界面最底层，营造氛围。
 *
 * 与插件的同一套可调参数（不透明度/模糊/亮度/对比度/位置/缩放/适配），同样
 * **每设备独立**（存本机设置，不进仓库、不随同步走）——背景是纯观感偏好，
 * 同步它只会让每台机器都被迫接受同一张图。
 *
 * 与插件的一个刻意差异：不支持视频动态壁纸。技术选型里已经写明视频壁纸是
 * 内存杀手（常驻解码 + 一份全屏纹理），对"轻量"目标是反向优化，刻意不移植。
 *
 * 实现要点：背景层是 `#qn-bg-layer`（fixed、z-index 0、pointer-events:none），
 * 界面内容在其上（z-index ≥ 1）；启用时 `html` 挂 `qn-bg-on` 类，由 CSS 把
 * 顶栏/侧栏/编辑器卡片等表面色改成半透明，背景才透得出来。层自身不接收
 * 事件、也不盖住任何内容，所以不影响顶栏拖拽与点击。
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import type { Settings } from "./settings.ts";

const LAYER_ID = "qn-bg-layer";
const ROOT_CLASS = "qn-bg-on";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 把一张设置快照铺到 DOM 上。设置改变、仓库切换后都要重新调用。 */
export function applyBackground(settings: Settings, vaultPath: string | null): void {
  if (typeof document === "undefined") return; // Node 测试环境没有 DOM
  const root = document.documentElement;
  const enabled = settings.bgEnabled && settings.bgImagePath.trim().length > 0 && !!vaultPath;

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
  const relative = settings.bgImagePath.trim().replace(/\\/g, "/");
  const absolute = `${vaultPath!.replace(/[\\/]+$/, "")}/${relative}`;
  layer.style.backgroundImage = `url("${convertFileSrc(absolute)}")`;
  layer.style.backgroundPosition = `${settings.bgPosX}% ${settings.bgPosY}%`;
  layer.style.backgroundSize = settings.bgFit === "contain" ? "contain" : "cover";
  layer.style.backgroundRepeat = "no-repeat";
  layer.style.opacity = String(clamp(settings.bgOpacity, 0, 1));
  layer.style.filter = [
    `blur(${clamp(settings.bgBlur, 0, 50)}px)`,
    `brightness(${clamp(settings.bgBrightness, 10, 200)}%)`,
    `contrast(${clamp(settings.bgContrast, 10, 200)}%)`,
    `scale(${clamp(settings.bgScale, 10, 400) / 100})`,
  ].join(" ");
}


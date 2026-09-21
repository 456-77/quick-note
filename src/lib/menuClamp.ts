/**
 * 菜单渲染后按实际尺寸夹回视口内。
 *
 * 面板边缘（右侧日记面板的 ⋯、顶栏仓库下拉）触发的菜单 x/y 贴着屏幕边，
 * 直接用 clientX/clientY 会把大半个菜单送出屏幕外。渲染后量一次实际宽高，
 * 越界就往回收——ref 回调在 DOM 插入后立刻跑，用户看不到跳动。
 *
 * 用法：`<div className="context-menu" ref={menuRefClampedToViewport(x, y)} style={{ left: x, top: y }} />`
 */
export function menuRefClampedToViewport(x: number, y: number) {
  return (el: HTMLDivElement | null) => {
    if (!el) return;
    let left = x;
    let top = y;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) left = Math.max(8, window.innerWidth - rect.width - 8);
    if (rect.bottom > window.innerHeight - 8) top = Math.max(8, window.innerHeight - rect.height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
}

/**
 * pptx-preview 的最小类型声明。
 *
 * 包本身有 dist/index.d.ts 但 package.json 没有 types/exports 入口，
 * bundler 解析定位不到，这里按实际用到的 API 声明。
 */

declare module "pptx-preview" {
  export interface PptxPreviewOptions {
    /** 渲染区宽度（px），库内部用「width / 页宽」算缩放，必须给数值 */
    width?: number;
    height?: number;
    /** list = 顺序平铺全部幻灯片；slide = 单页 + 翻页按钮 */
    mode?: "list" | "slide";
  }

  export interface PPTXPreviewer {
    readonly slideCount: number;
    /** 库自己的渲染容器（清理内嵌图表实例时兜底扫描用） */
    readonly wrapper: HTMLElement;
    preview(file: ArrayBuffer): Promise<unknown>;
    destroy(): void;
  }

  export function init(dom: HTMLElement, options?: PptxPreviewOptions): PPTXPreviewer;
}

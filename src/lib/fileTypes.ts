/**
 * 文件类型分类：哪些能当笔记编辑（Markdown / 文本数据文件）、哪些走预览
 * （PDF / Word / Excel / PPT）、哪些只是列出来（其他二进制）。
 *
 * `.txt` 刻意**不在**可编辑清单里：纯文本没有结构，误开二进制/乱码文件的风险
 * 大于收益，且 GUI 契约依赖 `.txt` 保持"列出来但不可编辑"的现状。
 */

export type FileKind =
  | "markdown"
  | "text"
  | "pdf"
  | "docx"
  | "ppt"
  | "spreadsheet"
  | "image"
  | "html"
  | "other";

/** 可在编辑器里当作文本编辑的数据文件扩展名（小写、不含点）。 */
export const TEXT_EXTS = new Set([
  "json", "jsonc", "sql", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "xml", "css", "js", "mjs", "ts", "jsx", "tsx", "py", "java", "rs", "go",
  "sh", "bat", "ps1",
]);

/** 预览类扩展名：点击打开预览窗格而非编辑器（图片/HTML/文档/幻灯片）。 */
export const PREVIEW_EXTS = new Set([
  "pdf", "docx", "xlsx", "xlsm",
  "ppt", "pptx",
  "html", "htm",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico",
]);

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function fileKindOf(name: string): FileKind {
  const ext = extOf(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  // 旧版 .ppt 也归到预览：点开给出"另存为 .pptx"提示，好过无声无息打不开
  if (ext === "ppt" || ext === "pptx") return "ppt";
  if (ext === "xlsx" || ext === "xlsm") return "spreadsheet";
  if (ext === "html" || ext === "htm") return "html";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"].includes(ext)) {
    return "image";
  }
  if (TEXT_EXTS.has(ext)) return "text";
  return "other";
}

/** 文件是否可以在左侧树中点击打开（编辑或预览）。 */
export function isOpenable(name: string): boolean {
  return fileKindOf(name) !== "other";
}

/** 编辑器语法：Markdown 笔记走 GFM，数据文件走对应语言，其余纯文本。 */
export type EditorLanguage = "markdown" | "json" | "sql" | "yaml" | "plain";

export function editorLanguageOf(name: string): EditorLanguage {
  const ext = extOf(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json" || ext === "jsonc") return "json";
  if (ext === "sql") return "sql";
  if (ext === "yaml" || ext === "yml") return "yaml";
  return "plain";
}

/** 非 Markdown 文件只提供源码视图（实时预览的装饰对数据文件没有意义）。 */
export function isMarkdownPath(path: string): boolean {
  return editorLanguageOf(path) === "markdown";
}

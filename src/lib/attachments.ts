/**
 * 附件的命名与链接生成。
 *
 * 都是纯函数（不碰 DOM、不碰文件系统），所以可以直接在 Node 里断言——
 * 命名规则这种东西最容易在边界上出问题（无扩展名、重名、非法字符）。
 */

/** 由 MIME 推断扩展名：剪贴板里的截图经常没有可用的文件名。 */
const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/tiff": "tiff",
};

/** 取扩展名（不含点、小写）：优先用文件名，其次按 MIME 推断，都没有则给 bin。 */
export function extensionFor(name: string, mimeType: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  if (match) return match[1].toLowerCase();
  return MIME_EXTENSION[mimeType.trim().toLowerCase()] ?? "bin";
}

/** Obsidian 风格的时间戳：20260915143012。 */
export function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/**
 * 生成附件文件名。
 *
 * 图片一律用 `Pasted image <时间戳>.<扩展名>`——与 Obsidian 的命名一致：用户库里已经
 * 全是这种名字，新文件会和它们排在一起。其他文件（zip、pdf 等）保留原文件名。
 * `index` 用于同一批里的第 2、3 个，避免同一秒内重名。
 */
export function attachmentNameFor(
  file: { name: string; type: string },
  date: Date,
  index = 0,
): string {
  const extension = extensionFor(file.name, file.type);
  const suffix = index > 0 ? ` ${index}` : "";

  if (file.type.trim().toLowerCase().startsWith("image/")) {
    return `Pasted image ${timestamp(date)}${suffix}.${extension}`;
  }

  // 非图片保留原文件名，但要清掉路径分隔符与系统禁用字符
  const original = file.name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "");
  return original || `Pasted file ${timestamp(date)}${suffix}.${extension}`;
}

/**
 * 生成插入到笔记里的链接文本。
 *
 * - wiki：`![[图.png]]`——wiki 语法按**文件名**在全库解析，写文件名即可；
 * - markdown：`![图.png](/attachments/图.png)`——以 `/` 开头表示仓库根相对，
 *   这样笔记本身在子目录里时也不会指错（相对笔记目录反而容易写错）。
 */
export function linkTextFor(relativePath: string, format: "wiki" | "markdown"): string {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  if (format === "markdown") return `![${name}](/${relativePath})`;
  return `![[${name}]]`;
}

/**
 * 图片文件管理里的引用处理（纯函数，Node 里可断言）。
 *
 * 自 quick-daily-note 插件的 `isImageRef` / `removeImageLinksFromNote` 移植，
 * 语义一致：
 * - 只认两种引用：wiki 嵌入 `![[路径|说明]]` 与 Markdown 图片 `![说明](路径 "标题")`；
 * - 围栏代码块（``` / ~~~）里的内容**不处理**——那是示例文字，不是真引用；
 * - 引用被删空的行整行移除（原本就是空白的行保留）；
 * - 匹配规则：完整路径相等，或**按文件名**匹配（wiki 引用常常不带目录）。
 */

/** 判断一个链接目标是否指向指定图片（完整路径匹配或文件名匹配，忽略大小写）。 */
export function isImageRef(linkPath: string, filePath: string, fileName: string): boolean {
  let p = linkPath.trim();
  try {
    p = decodeURIComponent(p);
  } catch {
    // 解码失败按原文继续比较
  }
  p = p.replace(/\\/g, "/").toLowerCase();
  if (p === filePath.toLowerCase()) return true;
  // 无路径形式（![[xxx.png]]）：按文件名匹配
  return p.split("/").pop() === fileName.toLowerCase();
}

/**
 * 从一篇笔记里删掉指向该图片的所有引用，返回新内容；没有引用时返回 null
 * （调用方据它跳过写盘）。`inFence` 的翻转必须跨全文档统计，逐行处理时不能提前返回。
 */
export function removeImageReferences(content: string, filePath: string, fileName: string): string | null {
  const lines = content.split("\n");
  const newLines: string[] = [];
  let inFence = false;
  let changed = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      newLines.push(line);
      continue;
    }
    if (inFence) {
      newLines.push(line);
      continue;
    }

    let newLine = line;
    // wiki 嵌入：![[路径|尺寸或别名]]
    newLine = newLine.replace(/!\[\[[^\]]*\]\]/g, (m) => {
      const inner = m.slice(3, -2);
      const linkPath = inner.split("|")[0];
      return isImageRef(linkPath, filePath, fileName) ? "" : m;
    });
    // markdown 图片：![alt](路径 "title")
    newLine = newLine.replace(/!\[[^\]]*\]\([^)]*\)/g, (m) => {
      const url = m.match(/\(([^)]*)\)/)?.[1]?.trim() ?? "";
      const linkPath = url.split(/[?#\s]/)[0];
      return isImageRef(linkPath, filePath, fileName) ? "" : m;
    });

    if (newLine !== line) {
      changed = true;
      if (newLine.trim() === "") {
        // 引用被删空的行整行移除（原本就是空白的行保留）
        if (line.trim() !== "") continue;
      }
      newLine = newLine.replace(/[ \t]+$/, "");
    }
    newLines.push(newLine);
  }

  if (!changed) return null;
  return newLines.join("\n");
}

/** 按扩展名给图片文件一个正确的 MIME（Blob 构造用）。 */
export function blobTypeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/png";
}

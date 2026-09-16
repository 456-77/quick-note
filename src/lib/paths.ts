/** 路径与目标解析。
 *
 * 单独成模块有两个原因：
 *   1. 这些逻辑是**纯字符串运算**，可以在 Node 里直接断言（`convertFileSrc` 依赖
 *      `window`，不能在 Node 里调用，所以这里只产出绝对路径，不产出 asset URL）；
 *   2. 装饰层（livePreview）、内容嵌入（embed）、额外语法（markdownExtras）都要用，
 *      独立出来避免互相 import 形成循环依赖。
 */

import { Facet } from "@codemirror/state";

/** 资源解析上下文：仓库根目录 + 当前笔记的仓库相对路径 + 文件名索引。 */
export interface LivePreviewContext {
  vaultPath: string | null;
  notePath: string | null;
  /**
   * 「小写文件名 → 仓库相对路径」索引，用于解析 Obsidian 的 wiki 语法。
   *
   * `![[图片.png]]` 不是相对路径，而是**按文件名在全库查找**（同名时取路径最短的，
   * 近似 Obsidian 的"离当前笔记最近"）。索引在打开仓库时建立、文件变化时就地更新。
   */
  embedIndex: Map<string, string>;
  /**
   * 资源代际。索引或文件内容变化时递增，用于让 widget 的 `eq` 判定为"不等"，
   * 从而重建 DOM 并重新渲染（否则内容变了但 widget 相等，CM6 会沿用旧节点）。
   */
  generation: number;
}

export const EMPTY_CONTEXT: LivePreviewContext = {
  vaultPath: null,
  notePath: null,
  embedIndex: new Map(),
  generation: 0,
};

/** 远程或内联资源，直接用原地址。 */
export const REMOTE_SCHEME = /^(https?:|data:|blob:|asset:)/i;

/** 常见图片扩展名，用于判断 wiki 嵌入的是图片还是笔记。 */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i;

/** 解码 URL 编码；非法转义序列时按原文返回。 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 取笔记所在目录的路径段（`a/b.md` → `["a"]`）。 */
export function noteDirSegments(notePath: string | null): string[] {
  if (!notePath) return [];
  const slash = notePath.lastIndexOf("/");
  return slash < 0 ? [] : notePath.slice(0, slash).split("/");
}

/**
 * 逐段消解 `.` 与 `..`，并且**不允许越过仓库根**。
 * 结果始终是仓库内的相对路径，返回值不会是绝对路径。
 */
function normalizeInsideVault(base: string[], target: string): string {
  const parts: string[] = [];
  for (const segment of [...base, ...target.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // 已经到仓库根就不再上退，避免解析出库外路径
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/** 仓库相对路径 → 绝对路径（纯字符串）。 */
export function absoluteInVault(vaultPath: string, relative: string): string {
  const normalized = vaultPath.replace(/\\/g, "/");
  // 仓库路径必须**先拆成路径段**再归一化，否则会拼出 "H:/vault//pic.png" 这种结果
  const root = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  const joined = normalizeInsideVault(root, relative);
  // POSIX 绝对路径开头那个斜杠要在归一化后补回来
  return normalized.startsWith("/") ? `/${joined}` : joined;
}

/** 把目标相对于"笔记所在目录 / 仓库根"归一化成仓库内相对路径。 */
function relativeFromNote(ctx: LivePreviewContext, target: string): string {
  const clean = target.replace(/^\.\//, "");
  const fromRoot = clean.startsWith("/");
  const base = fromRoot ? [] : noteDirSegments(ctx.notePath);
  return normalizeInsideVault(base, clean.replace(/^\//, ""));
}

/**
 * 解析 Markdown 写法的资源地址（`![alt](path)`）。
 *
 * 规则：远程/内联原样返回；以 `/` 开头按仓库根解析，否则相对**笔记所在目录**。
 * 注意这里**不做文件名索引查找**——那是 wiki 语法的语义，两者不能混。
 */
export function resolveResource(
  ctx: LivePreviewContext,
  url: string,
): { remote: string | null; local: string | null } {
  if (REMOTE_SCHEME.test(url)) return { remote: url, local: null };
  if (!ctx.vaultPath) return { remote: null, local: null };
  const relative = relativeFromNote(ctx, safeDecode(url));
  return relative
    ? { remote: null, local: absoluteInVault(ctx.vaultPath, relative) }
    : { remote: null, local: null };
}

/**
 * 解析 Obsidian wiki 语法的目标，返回**仓库相对路径**（读取文件时需要这个形式）。
 *
 * 与 Markdown 语法的差别：纯文件名要走**全库索引**；含 `/` 的写法仍按路径解析。
 * 索引里找不到时退回相对笔记目录，不会失败。
 */
export function resolveWikiRelative(
  ctx: LivePreviewContext,
  target: string,
): string | null {
  if (REMOTE_SCHEME.test(target)) return null;
  const clean = safeDecode(target).replace(/^\.\//, "");

  if (!clean.includes("/")) {
    const indexed = ctx.embedIndex.get(clean.toLowerCase());
    if (indexed) return indexed;
  }

  const relative = relativeFromNote(ctx, clean);
  return relative || null;
}

/** 解析 wiki 目标为可加载的地址（远程地址或本地绝对路径）。 */
export function resolveWikiTarget(
  ctx: LivePreviewContext,
  target: string,
): { remote: string | null; local: string | null } {
  if (REMOTE_SCHEME.test(target)) return { remote: target, local: null };
  if (!ctx.vaultPath) return { remote: null, local: null };
  const relative = resolveWikiRelative(ctx, target);
  return relative
    ? { remote: null, local: absoluteInVault(ctx.vaultPath, relative) }
    : { remote: null, local: null };
}

/**
 * 由编辑器状态携带的资源上下文。
 *
 * 定义在本模块而不是 livePreview.ts：图片、内容嵌入、手写 HTML 三种 widget 都要读它，
 * 放在 livePreview 里会形成 livePreview ↔ markdownExtras 的循环依赖。
 */
export const livePreviewContext = Facet.define<LivePreviewContext, LivePreviewContext>({
  combine: (values) => values[0] ?? EMPTY_CONTEXT,
});

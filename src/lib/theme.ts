/**
 * 主题解析与应用。
 *
 * 「跟随系统」在 JS 里就解析成具体的 light/dark，再写到 `<html data-theme>`。
 * 这样深色色板在 CSS 里只写一份——若改用 `@media (prefers-color-scheme: dark)`
 * 再抄一遍，以后调色必然漏掉一边（这个项目已经在"同一逻辑写两遍"上踩过坑）。
 */

export type ThemeMode = "light" | "dark" | "system";

export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/** 把模式解析成实际生效的主题。 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

/** 应用到文档根节点，返回实际生效的主题。 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
  }
  return resolved;
}

/** 订阅系统主题变化。返回取消订阅函数；「跟随系统」模式下才有意义。 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

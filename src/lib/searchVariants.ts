/**
 * 字段名变体（0.23 用户反馈）：搜一个字段时，它可能以 camelCase（代码属性名）
 * 或 snake_case（表字段名）两种形态存在——`userName` 与 `user_name` 要能互相
 * 搜到。这里把一个词拆成两种字面变体，搜索时一并命中。
 *
 * 两个消费方：
 * - 命令面板/全局搜索（Rust `search_vault`）：用 {@link fieldVariants} 的字面
 *   变体做"或"匹配；Rust 侧有同逻辑的镜像实现（vault.rs 的 `field_variants`），
 *   两边注释互相指认，改这里必须同步改那边。
 * - 文件内搜索面板（searchPanel.ts）：用 {@link fieldPattern} 生成段间允许
 *   `_` 的正则，一次查询同时覆盖两种形态（含替换时的语义变化，所以做成开关）。
 *
 * 纯函数，Node 可直接断言。
 */

/** 生成一个词的字面变体集合（含原词）。`userName` → [userName, user_name]；`user_name` → [user_name, username]。 */
export function fieldVariants(term: string): string[] {
  const out = new Set<string>([term]);
  if (term.includes("_")) {
    // snake → 无分隔形态：user_name → username（小写化后与 userName 同形，
    // 子串匹配即可命中驼峰写法，不必真做大写还原）
    out.add(term.replace(/_/g, ""));
  } else if (/[a-z0-9][A-Z]/.test(term) || /[A-Z][a-z].*[A-Z]/.test(term)) {
    // 驼峰/帕斯卡 → snake：userName / UserName → user_name。必须在**原始大小写**
    // 上做（小写化后驼峰边界就丢了），调用方拿到的 query 是原文。
    out.add(camelToSnake(term));
  }
  return [...out];
}

/** 驼峰/帕斯卡 → snake_case：在"小写/数字 → 大写"的边界前插下划线再统一小写。 */
function camelToSnake(value: string): string {
  let out = "";
  const chars = [...value];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (
      /[A-Z]/.test(char) &&
      index > 0 &&
      /[a-z0-9]/.test(chars[index - 1] ?? "")
    ) {
      out += "_";
    }
    out += char.toLowerCase();
  }
  return out;
}

/**
 * 是否值得启用下划线联动：查询里带 `_` 或存在驼峰边界。纯小写单词没有两种
 * 形态，联动只会无谓地改变大小写语义（强制忽略大小写），保持普通搜索。
 */
export function hasFieldShape(query: string): boolean {
  return query.includes("_") || /[a-z0-9][A-Z]/.test(query);
}

/**
 * 下划线联动模式的正则源码：单下划线的连接处允许「隔一个 `_` 或直接连写」，其余
 * 部分按字面处理——`userName` 与 `user_name` 都生成 `user[_]?name`，两种形态
 * （以及无分隔的 username）一并命中；`__init__` 的双下划线保持字面，不退化。
 *
 * 段内正则元字符一律转义；整体配合大小写不敏感使用。查询没有字段形态（见
 * {@link hasFieldShape}）时返回 null，调用方回落普通搜索。
 */
export function fieldPattern(query: string): string | null {
  if (!query || !hasFieldShape(query)) return null;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** 驼峰边界切段（配合大小写不敏感，段内大小写无关紧要）。
   *  两种边界：小写/数字→大写（userName），以及连续大写后接「大写+小写」
   *  （HTTPResponse、USERName）。 */
  const splitCamel = (chunk: string): string[] => {
    const chars = [...chunk];
    for (let index = 1; index < chars.length; index += 1) {
      const previous = chars[index - 1] ?? "";
      const current = chars[index];
      const next = chars[index + 1] ?? "";
      const boundary =
        (/[a-z0-9]/.test(previous) && /[A-Z]/.test(current)) ||
        (/[A-Z]/.test(previous) && /[A-Z]/.test(current) && /[a-z]/.test(next));
      if (boundary) {
        return [
          ...splitCamel(chars.slice(0, index).join("")),
          ...splitCamel(chars.slice(index).join("")),
        ];
      }
    }
    return chunk ? [chunk] : [];
  };
  // 按「下划线连写段」切分：段与段之间的分隔是 1 个 `_`（弹性）还是 ≥2 个（字面）
  const chunks = query.split(/_+/);
  const runs = query.match(/_+/g) ?? [];
  if (chunks.every((chunk) => chunk === "")) return null;
  const parts: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    // 段内驼峰边界与单下划线同权：允许「隔一个 _ 或直接连写」。段统一小写——
    // 联动模式强制大小写不敏感（buildQuery），canonical 一点便于测试与阅读
    const segments = splitCamel(chunks[index]).map((segment) => segment.toLowerCase());
    for (let s = 0; s < segments.length; s += 1) {
      if (s > 0) parts.push("[_]?");
      parts.push(escape(segments[s]));
    }
    const run = runs[index];
    if (run === undefined) continue;
    parts.push(run.length === 1 ? "[_]?" : escape(run));
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * 文件名比较（文件树同组内排序用，0.39.8）。
 *
 * 用户反馈「v2 后缀的文件怎么排在没有后缀的上面」：`…-20261111-v2.xlsx` 与
 * `…-20261111.xlsx` 按字典序比到 `20261111` 后，一个是 '-'(0x2D)、一个是
 * '.'(0x2E)，'-' 更小 → 变体文件反而压过原文件。改成**先比主名（去掉最后一个
 * 扩展名）**：原文件的主名是变体主名的真前缀，ICU 排序里真前缀排在前 →
 * 原文件永远排在 -v2/-v3/(1)/副本 这类变体之前；主名相同时再比全名，
 * 决定同主名不同扩展名的次序（与旧的全名比较结果一致）。
 *
 * 两级比较都用 numeric: true 的 ICU Collator：数字段按数值比（2 < 10），
 * `-v2` 与 `-v10` 的次序也顺带正确。日期前缀日记的专门通道
 * （FileTree 的 compareByDatePrefix）在调用方，这里只管兜底比较。
 */

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });

/** 主名：最后一个 '.' 之后视为扩展名剥掉（开头的 dot 如 .gitignore 不算扩展名）。 */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 兜底文件名比较：主名优先（变体殿后），主名相同再比全名；全程数值感知。 */
export function compareFileNames(a: string, b: string): number {
  const primary = collator.compare(stemOf(a), stemOf(b));
  return primary !== 0 ? primary : collator.compare(a, b);
}

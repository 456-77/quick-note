/**
 * 代码块括号彩虹嵌套着色（0.39.19 用户反馈「对于代码块中的{}或者[],往往会
 * 存在多对，并且会有多重嵌套的形式，这样阅读体验就很差，改成嵌套时显示不同
 * 颜色，成对的颜色要相同」）。
 *
 * 纯函数：扫一遍代码文本，给每个括号字符（{} [] ()）算出嵌套层级 → 颜色档位
 * （6 色循环）。同一层级的开/闭括号档位相同，即「成对同色」；混合嵌套
 * （[ { } ]）按**深度**着色而不是按括号类型配对——深度相同的层永远是同一色，
 * 阅读时一眼能看出当前在第几层。
 *
 * 引号字符串里的括号不参与计数（`"{}"`、'[' 这类字面量不是结构），反斜杠
 * 转义跟着引号走。注释不识别（语言各异，误伤比漏配对更难看，先不做）。
 * 超长文本直接放弃着色（10 万字符以上的块扫描成本开始可见）。
 */

/** 单个括号的着色区间：相对代码起点的 [from, to)，level = 1..6（6 色循环）。 */
export interface RainbowMark {
  from: number;
  to: number;
  level: number;
}

/** 颜色档位数（CSS 类 qn-bracket-1..6 与这里的 6 对应，改要同步 styles.css）。 */
export const RAINBOW_LEVELS = 6;

/** 超过这个长度不再着色（扫描是每次装饰重建都要跑的 O(n)）。 */
const MAX_TEXT_LENGTH = 100_000;

const OPEN = new Set(["{", "[", "("]);
const CLOSE = new Set(["}", "]", ")"]);

/** 扫描代码文本，返回括号字符的着色区间（按出现顺序）。 */
export function bracketRainbowMarks(code: string): RainbowMark[] {
  if (!code || code.length > MAX_TEXT_LENGTH) return [];
  const marks: RainbowMark[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (quote !== null) {
      if (ch === "\\") {
        i += 1; // 转义字符连着下一个一起跳过
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (OPEN.has(ch)) {
      const level = (depth % RAINBOW_LEVELS) + 1;
      marks.push({ from: i, to: i + 1, level });
      depth += 1;
      continue;
    }
    if (CLOSE.has(ch)) {
      depth = Math.max(0, depth - 1);
      const level = (depth % RAINBOW_LEVELS) + 1;
      marks.push({ from: i, to: i + 1, level });
    }
  }
  return marks;
}

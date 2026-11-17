// 代码块括号彩虹嵌套着色的纯函数断言（0.39.19 用户反馈「改成嵌套时显示
// 不同颜色，成对的颜色要相同」）。
//
// 用法：node --experimental-strip-types --no-warnings scripts/verify-bracket-rainbow.mjs
import { bracketRainbowMarks, RAINBOW_LEVELS } from "../src/lib/bracketRainbow.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}  ${detail}`);
  }
};
/** 只取括号字符的档位序列（开/闭成对断言用）。 */
const levels = (code) => bracketRainbowMarks(code).map((mark) => mark.level);
const spans = (code) => bracketRainbowMarks(code);

// 1. 单层成对：开/闭同档
check(
  JSON.stringify(levels("{a}")) === JSON.stringify([1, 1]),
  "单层 {}：成对同档 1",
  JSON.stringify(levels("{a}")),
);
check(
  JSON.stringify(levels("[a]")) === JSON.stringify([1, 1]),
  "单层 []：成对同档 1",
  JSON.stringify(levels("[a]")),
);
check(
  JSON.stringify(levels("(a)")) === JSON.stringify([1, 1]),
  "单层 ()：成对同档 1",
  JSON.stringify(levels("(a)")),
);

// 2. 嵌套：深度递增，闭括号回落到自己的层级
check(
  JSON.stringify(levels("{ a [ b ( c ) b ] a }")) === JSON.stringify([1, 2, 3, 3, 2, 1]),
  "三层嵌套 1→2→3→3→2→1",
  JSON.stringify(levels("{ a [ b ( c ) b ] a }")),
);

// 3. 超过 6 层循环回 1
const deep = "[".repeat(RAINBOW_LEVELS + 1) + "]".repeat(RAINBOW_LEVELS + 1);
check(
  levels(deep)[RAINBOW_LEVELS] === 1,
  "第 7 层循环回档 1",
  JSON.stringify(levels(deep)),
);

// 4. 混合嵌套按深度着色（不按括号类型配对）：[{ }] 的 } 回到 1 档
check(
  JSON.stringify(levels("[ { } ]")) === JSON.stringify([1, 2, 2, 1]),
  "混合嵌套按深度：[ { } ] → 1 2 2 1",
  JSON.stringify(levels("[ { } ]")),
);

// 5. 字符串里的括号不参与计数
check(
  spans('a = "{}"; b = [1]').length === 2 && levels('a = "{}"; b = [1]').join() === "1,1",
  "字符串字面量里的 {} 不计数（只剩 [1] 一对）",
  JSON.stringify(spans('a = "{}"; b = [1]')),
);
// say("[hi]") 本身只有一对 ()，字符串里的 [] 不该额外产出
check(
  spans('say("[hi]")').length === 2 && levels('say("[hi]")').join() === "1,1",
  "字符串里的 [] 不计数",
  JSON.stringify(spans('say("[hi]")')),
);
// 转义的引号不结束字符串（"a\"[b]" 整个是字符串），只剩 (1) 一对
check(
  spans('x = "a\\"[b]"; y = (1)').length === 2 && levels('x = "a\\"[b]"; y = (1)').join() === "1,1",
  "转义引号后的括号正常计数",
  JSON.stringify(spans('x = "a\\"[b]"; y = (1)')),
);

// 6. 不平衡：多出的闭括号不产生负深度（档位不低于 1）
check(
  Math.min(...levels("} } {"), 1) >= 1,
  "多余闭括号不会算出 0/负档",
  JSON.stringify(levels("} } {")),
);

// 7. 空文本/超长文本：不产出
check(bracketRainbowMarks("").length === 0, "空文本无着色");
check(bracketRainbowMarks("x".repeat(100_001)).length === 0, "超长文本放弃着色");

console.log(failures === 0 ? "\n括号彩虹嵌套断言全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

// Markdown 成对符号自动闭合的纯逻辑验收（无需 DOM、无需 Tauri）。
//
// 判定核心在 src/lib/autoPairs.ts（纯函数）；本脚本逐条覆盖需求表的
// 补全规则、选区包裹、成长/跳过、代码语境禁用与货币/任务列表歧义。
// 事务层的执行与语法树上下文由 CDP 冒烟另行覆盖。
//
// 用法：node --experimental-strip-types --no-warnings scripts/verify-autopairs.mjs

import { markdownPairAction } from "../src/lib/autoPairs.ts";

let pass = 0;
let fail = 0;

/** 光标形上下文：before|after */
const c = (before, after, opts = {}) => ({
  before,
  after,
  hasSelection: false,
  inFence: false,
  inInlineCode: false,
  ...opts,
});
/** 选区形上下文：before[选中 selected]after */
const s = (before, selected, after, opts = {}) => ({
  ...c(before, after, opts),
  hasSelection: true,
  selected,
});

function check(name, input, ctx, expect) {
  const got = markdownPairAction(input, ctx);
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`FAIL ${name}\n  期望 ${JSON.stringify(expect)}\n  实得 ${JSON.stringify(got)}`);
  }
}
const none = { kind: "none" };

// ── 高优先级：空对插入 ──
check("斜体 *", "*", c("", ""), { kind: "insert", text: "**", cursorOffset: 1 });
check("斜体 _", "_", c("", ""), { kind: "insert", text: "__", cursorOffset: 1 });
check("加粗 **（成长）", "*", c("*", "*"), { kind: "grow", char: "*", leftLen: 1, rightLen: 1 });
check("加粗完成跳出", "*", c("**", "**"), { kind: "skip", by: 2 });
check("行内代码 `", "`", c("", ""), { kind: "insert", text: "``", cursorOffset: 1 });
check("行内代码成长", "`", c("`", "`"), { kind: "grow", char: "`", leftLen: 1, rightLen: 1 });
check(
  "代码块围栏（空行处）",
  "`",
  c("``", "``"),
  { kind: "edit", fromOffset: -2, toOffset: 2, text: "```\n\n```", cursorOffset: 3 },
);
check("行中双反引号不转围栏", "`", c("x ``", "`` y"), { kind: "skip", by: 2 });
check("围栏后跳出", "`", c("```", "```"), { kind: "skip", by: 3 });
check("删除线 ~~", "~", c("a ~", ""), { kind: "insert", text: "~~~", cursorOffset: 1 });
check("删除线已成对跳出", "~", c("~~", "~~"), { kind: "skip", by: 2 });
check("链接 [", "[", c("", ""), { kind: "insert", text: "[]", cursorOffset: 1 });
check("图片 ![", "[", c("!", ""), { kind: "insert", text: "[]()", cursorOffset: 1 });
check("行内公式 $（行首）", "$", c("", ""), { kind: "insert", text: "$$", cursorOffset: 1 });
check("行内公式 $（空格后）", "$", c("a ", ""), { kind: "insert", text: "$$", cursorOffset: 1 });
check("块级公式 $$（成长）", "$", c("$", "$"), { kind: "grow", char: "$", leftLen: 1, rightLen: 1 });

// ── 中优先级：非对称与两字符单位 ──
check("圆括号交给 closeBrackets", "(", c("", ""), none);
check("大括号交给 closeBrackets", "{", c("", ""), none);
check("双引号交给 closeBrackets", '"', c("", ""), none);
check("高亮 ==", "=", c("a =", ""), { kind: "insert", text: "===", cursorOffset: 1 });
check("注释 %%", "%", c("%%", ""), none);
check("注释 %%（恰一）", "%", c("a %", ""), { kind: "insert", text: "%%%", cursorOffset: 1 });
check("HTML 注释补全", "-", c("a <!-", ""), { kind: "insert", text: "--->", cursorOffset: 1 });
check("普通减号不触发", "-", c("a <", ""), none);
check("列表减号不触发", "-", c("- ", ""), none);

// ── 边界：代码语境禁用 ──
check("围栏内 * 不配对", "*", c("```py\nx", "", { inFence: true }), none);
check("围栏内 ( 不配对", "(", c("```py\nx", "", { inFence: true }), none);
check("围栏内 [ 不配对", "[", c("```py\nx", "", { inFence: true }), none);
check("HTML 块内不配对", "*", c("<div>", "", { inFence: true }), none);
check("行内代码内 ` 以外不配对", "*", c("a `x", "`", { inInlineCode: true }), none);
check("行内代码闭合跳过", "`", c("a `x", "`", { inInlineCode: true }), { kind: "skip", by: 1 });

// ── 边界：选区包裹 ──
check("选区斜体", "*", s("", "text", ""), { kind: "wrap", opener: "*", closer: "*" });
check("选区加粗（成长）", "*", s("*", "text", "*"), {
  kind: "grow",
  char: "*",
  leftLen: 1,
  rightLen: 1,
});
check("选区加粗跳出", "*", s("**", "text", "**"), { kind: "skip", by: 2 });
check("选区删除线", "~", s("", "text", ""), { kind: "wrap", opener: "~~", closer: "~~" });
check("选区删除线跳出", "~", s("~~", "text", "~~"), { kind: "skip", by: 2 });
check("选区高亮跳出", "=", s("==", "text", "=="), { kind: "skip", by: 2 });
check("选区行内代码", "`", s("", "text", ""), { kind: "wrap", opener: "`", closer: "`" });
check("选区圆括号交给 closeBrackets", "(", s("", "text", ""), none);
check("选区方括号交给 closeBrackets", "[", s("", "text", ""), none);

// ── 边界：跳过与货币/任务列表歧义 ──
check("斜体闭合跳过（*test|*）", "*", c("*test", "*"), { kind: "skip", by: 1 });
check("货币 $100 的 $ 不配对", "$", c("$100", ""), none);
check("词中 $ 不配对", "$", c("abc", ""), none);
check("任务列表 [ → [ ]", "[", c("- ", ""), { kind: "insert", text: "[ ]", cursorOffset: 3 });
check("星号列表 [ → [ ]", "[", c("* ", ""), { kind: "insert", text: "[ ]", cursorOffset: 3 });
check("嵌套任务列表 [ → [ ]", "[", c("  - ", ""), { kind: "insert", text: "[ ]", cursorOffset: 3 });
check("普通行 [ → 链接", "[", c("看这个 ", ""), { kind: "insert", text: "[]", cursorOffset: 1 });
check("图片 ] 跳到 url 括号", "]", c("![alt", "]()"), { kind: "skip", by: 2 });
check("普通 ] 不接管", "]", c("x", "()"), none);
check("连续 [ 成长为 wiki 链接", "[", c("[", "]"), {
  kind: "grow",
  char: "[",
  leftLen: 1,
  rightLen: 1,
  rightChar: "]",
});

// ── 其他：多字符输入（粘贴/IME）不处理 ──
check("多字符输入不处理", "py", c("```", ""), none);

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);

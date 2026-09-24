/**
 * Markdown 成对符号自动闭合的判定核心（纯函数，无 DOM / CodeMirror 依赖）。
 *
 * 覆盖三类行为，全部由 `markdownPairAction` 依据「输入字符 + 光标上下文」判定：
 *
 * 1. **空对插入**：`*` → `*|*`、`` ` `` → `` `|` ``、`[` → `[]`（任务列表语境 → `[ ]`）、
 *    `![` → `![]()`（光标先落 alt）等；
 * 2. **选区包裹**：选中 text 输入 `*` → `*text*`，再次输入成长为 `**text**`（选区保持，
 *    第三次跳出）——`_ `` ` `` $` 同理；两字符单位（`~~` `==` `%%`）一次包到位；
 * 3. **对称 run 的成长与跳出**：`*|*` 输入 `*` 成长为 `**|**`，`**|**` 再输入 `*` 跳出
 *    （光标移到闭合符之后），`` ``|`` `` 处输入第三个反引号展开为代码块围栏。
 *
 * 边界（由调用方传入上下文，本模块只做判定）：
 * - `inFence`（围栏代码块 / HTML 块）内一律不配对；
 * - `inInlineCode` 内只处理反引号自身的成长/跳出/围栏转换，其余输入不碰；
 * - `$` 仅在行首或空白后触发（货币 `$100` 的第二个 `$` 由跳过规则自然闭合）；
 * - `[` 在任务列表标记（`- ` / `* ` 行首）后补全为 `[ ]`。
 *
 * 判定只依赖文本，不查语法树——增量解析在快速输入时可能滞后，树查询放胶水层
 * 并用 ensureSyntaxTree 兜底。
 */

/** 判定所需的上下文。before/after 由胶水层截取光标前后各 ~120 字符。 */
export interface PairContext {
  /** 光标前文本（尾部保留光标前所有紧邻字符） */
  before: string;
  /** 光标后文本（头部保留光标后所有紧邻字符） */
  after: string;
  /** 是否有选区（from !== to） */
  hasSelection: boolean;
  /** 光标是否处于围栏代码块 / HTML 块内 */
  inFence: boolean;
  /** 光标是否处于行内代码内 */
  inInlineCode: boolean;
}

export type PairAction =
  | { kind: "none" }
  /** 在插入点插入 text，光标落在插入点 + cursorOffset（\n 由胶水层换成本文件换行符） */
  | { kind: "insert"; text: string; cursorOffset: number }
  /** 选区两侧包裹 opener/closer，重新选中文本（第二次输入同字符时成长为双层） */
  | { kind: "wrap"; opener: string; closer: string }
  /** 对称 run 两侧各补一个字符（选区形态：贴着 opener/closer 补；光标形态：光标处 + 闭合侧补）。
   *  rightChar 供非对称对使用（`[[` wiki 链接：左侧补 [、右侧补 ]）。 */
  | { kind: "grow"; char: string; leftLen: number; rightLen: number; rightChar?: string }
  /** 光标跳过右侧 by 个字符（不插入，选区形态下同时取消选区） */
  | { kind: "skip"; by: number }
  /** 区间替换：[插入点+fromOffset, 插入点+toOffset) 替换为 text，光标落在起点+cursorOffset */
  | { kind: "edit"; fromOffset: number; toOffset: number; text: string; cursorOffset: number };

/** 选区包裹映射：输入字符 → [前缀, 后缀]。两字符单位（~~ == %%）一次包到位。 */
const WRAP_MAP: Record<string, [string, string]> = {
  "*": ["*", "*"],
  _: ["_", "_"],
  "`": ["`", "`"],
  $: ["$", "$"],
  "~": ["~~", "~~"],
  "=": ["==", "=="],
  "%": ["%%", "%%"],
  "'": ["'", "'"],
  '"': ['"', '"'],
};

/** 对称 run 的成长上限：达到即改为跳过（`*|*`→成长，`**|**`→跳出）。 */
const MAX_RUN = 2;

/** 参与对称 run 成长/跳出的字符（引号也对称：'text'| 输入 ' 直接闭合；
 *  `( { 等真非对称对交给内置 closeBrackets；
 *  `[` 的任务列表/图片/wiki 链接在触发分支单独处理）。 */
const RUN_CHARS = new Set(["*", "_", "`", "$", "~", "=", "%", "'", '"']);

/** 字符串首/尾的连续同字符长度。 */
function runLen(s: string, ch: string, dir: 1 | -1): number {
  let n = 0;
  for (let i = dir === 1 ? 0 : s.length - 1; i >= 0 && i < s.length && s[i] === ch; i += dir) n += 1;
  return n;
}

/** 光标所在行除对称 run 外是否为空（``` 围栏转换只在空行处发生）。 */
function lineBlankAround(before: string, after: string, runLen: number): boolean {
  const lineBefore = before.slice(before.lastIndexOf("\n") + 1);
  const nl = after.indexOf("\n");
  const lineAfter = nl === -1 ? after : after.slice(0, nl);
  const ticks = "`".repeat(runLen);
  return lineBefore === ticks && lineAfter === ticks;
}

/**
 * 判定输入一个字符后应执行的配对动作。
 *
 * 规则按优先级：围栏/HTML 块内不配对 → 行内代码内只反刔回引号 → 选区包裹/成长 →
 * 对称 run 成长/跳出 → 右侧同名闭合的跳过 → 各符号的触发规则。
 */
export function markdownPairAction(input: string, ctx: PairContext): PairAction {
  if (input.length !== 1) return { kind: "none" };

  const { before, after } = ctx;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineBefore = before.slice(lineStart);
  const nl = after.indexOf("\n");
  const lineAfter = after.slice(0, nl === -1 ? after.length : nl);

  // 代码块围栏补全：行内代码成长出的 ``|`` 上输入第三个 `（或 `` 后直接输入第三个）
  // → 整行展开为成对围栏。必须先于 inFence 判定：四个反引号会被语法树误判为
  // 围栏开头（3+ 个 ` 即围栏），但整行纯反引号时用户意图是围栏补全。
  if (input === "`" && lineBefore === "``" && /^`*$/.test(lineAfter)) {
    return { kind: "edit", fromOffset: -lineBefore.length, toOffset: lineAfter.length, text: "```\n\n```", cursorOffset: 3 };
  }

  if (ctx.inFence) return { kind: "none" };

  // 行内代码内：只接管反引号（其余字符不配对，交给默认输入）
  if (ctx.inInlineCode) {
    if (input !== "`") return { kind: "none" };
    const left = runLen(before, "`", -1);
    const right = runLen(after, "`", 1);
    if (left >= 1 && left === right) {
      if (left === 1) return { kind: "grow", char: "`", leftLen: 1, rightLen: 1 };
      if (left === 2 && lineBlankAround(before, after, 2)) {
        return { kind: "edit", fromOffset: -2, toOffset: 2, text: "```\n\n```", cursorOffset: 3 };
      }
      return { kind: "skip", by: right };
    }
    if (right >= 1 && left === 0) return { kind: "skip", by: 1 }; // code|` 闭合行内代码
    return { kind: "none" };
  }

  // 选区：包裹 → 成长 → 跳出
  if (ctx.hasSelection) {
    const wrap = WRAP_MAP[input];
    if (!wrap) return { kind: "none" };
    const [opener, closer] = wrap;
    const leftRun = runLen(before, input, -1);
    const rightRun = runLen(after, input, 1);
    if (leftRun >= 1 && rightRun >= 1) {
      // 选区已带同字符包裹：未达上限则成长为双层，已达则跳出
      if (leftRun < MAX_RUN && rightRun < MAX_RUN) {
        return { kind: "grow", char: input, leftLen: leftRun, rightLen: rightRun };
      }
      return { kind: "skip", by: rightRun };
    }
    return { kind: "wrap", opener, closer };
  }

  const leftRun = runLen(before, input, -1);
  const rightRun = runLen(after, input, 1);

  // 对称 run（仅限 Markdown 语境的字符）：成长，达上限后跳出
  if (leftRun >= 1 && leftRun === rightRun && RUN_CHARS.has(input)) {
    if (input === "`") {
      if (leftRun === 1) return { kind: "grow", char: "`", leftLen: 1, rightLen: 1 };
      if (leftRun === 2 && lineBlankAround(before, after, 2)) {
        return { kind: "edit", fromOffset: -2, toOffset: 2, text: "```\n\n```", cursorOffset: 3 };
      }
      return { kind: "skip", by: rightRun };
    }
    if (leftRun < MAX_RUN) {
      return { kind: "grow", char: input, leftLen: leftRun, rightLen: rightRun };
    }
    return { kind: "skip", by: rightRun };
  }

  // 右侧已有同名闭合：跳过而非重复插入（*test|* 上输入 * 直接闭合斜体）
  if (leftRun === 0 && rightRun >= 1 && RUN_CHARS.has(input)) {
    return { kind: "skip", by: 1 };
  }

  switch (input) {
    case "*":
    case "_":
      return { kind: "insert", text: input + input, cursorOffset: 1 };
    case "`":
      return { kind: "insert", text: "``", cursorOffset: 1 };
    case "'":
    case '"': {
      // 撇号/英寸保护：字母或数字后输入引号是 it's、3" 这类原文字符，不配对
      // （此时落到 default 由内置 closeBrackets 决定，它同样不做字母前缀配对）。
      const prev = before.slice(-1);
      if (/[\p{L}\p{N}]/u.test(prev)) return { kind: "none" };
      return { kind: "insert", text: input + input, cursorOffset: 1 };
    }
    case "$": {
      // 货币保护：只在行首或空白后触发
      const prev = before.slice(-1);
      if (prev === "" || /\s/.test(prev)) return { kind: "insert", text: "$$", cursorOffset: 1 };
      return { kind: "none" };
    }
    case "~":
    case "=":
    case "%": {
      // 恰好一个同名符号在前 → 补全为两对（a ~~ → a ~~|~~）：输入字符凑满左侧
      // 单位，右侧补整单位
      const prev = before.slice(-1);
      const prev2 = before.slice(-2, -1);
      if (prev === input && prev2 !== input) {
        return { kind: "insert", text: input + input + input, cursorOffset: 1 };
      }
      return { kind: "none" };
    }
    case "-": {
      // <!-- 的最后一个 -：补全注释对，光标落在注释体内
      if (before.endsWith("<!-")) return { kind: "insert", text: "--->", cursorOffset: 1 };
      return { kind: "none" };
    }
    case "]":
      // 图片流：![alt|]() 上输入 ] 跳过 ]( 直达 url 括号内
      if (after.startsWith("](")) return { kind: "skip", by: 2 };
      return { kind: "none" };
    case "[": {
      // wiki 链接：[|] 上输入 [ 成长为 [[|]]
      if (before.endsWith("[") && after.startsWith("]")) {
        return { kind: "grow", char: "[", leftLen: 1, rightLen: 1, rightChar: "]" };
      }
      // 任务列表语境：行首是列表标记且光标紧跟其后的空格 → 补全复选框
      if (/^\s*[-*+]\s+$/.test(lineBefore)) return { kind: "insert", text: "[ ]", cursorOffset: 3 };
      if (before.endsWith("!")) return { kind: "insert", text: "[]()", cursorOffset: 1 };
      return { kind: "insert", text: "[]", cursorOffset: 1 };
    }
    default:
      return { kind: "none" };
  }
}

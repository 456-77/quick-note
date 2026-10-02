/**
 * ```log 围栏代码块的语法高亮。
 *
 * CM 的语言包（@codemirror/language-data）里没有 log，之前块内的时间戳/级别词
 * 着色靠 Live Preview 的装饰做，光标一进块（编辑态）装饰整体消失，源码模式下
 * 更是完全没有——日志块"看着是一坨单色"的原因。这里做成真正的语法语言挂进
 * markdown 的 codeLanguages：编辑态、源码模式下颜色都在。
 *
 * ## 架构：整行规划（planLine）+ 逐段消费
 *
 * token() 在行首对整行做一次结构分析，产出一串 {长度, token} 片段，之后逐段
 * 消费。比"逐字符碰匹配"强在能表达**行结构**，让样板信息整体退后、消息保持
 * 常规亮度——读日志时视线落在消息上：
 *
 * - Spring/Java 行 `时间戳 级别 PID --- [线程] logger : 消息`：时间戳淡化、
 *   级别词分级着色加粗、PID/`---`/线程/logger/冒号全部淡化，消息保持常亮；
 *   消息里的 `key=`（青）与值、引号字符串（绿）细分着色
 * - 终端会话行：`[user@host dir]$` 提示符强调色；命令里引号字符串绿、参数淡化
 * - grep -n 输出：行号前缀 `3512133:` 淡化（后续照常解析，栈帧行交给行级红条）
 * - 栈帧行（`at ...`/`Caused by:`，含行号前缀）：整行淡化
 * - 裸级别行：`ERROR ...`、`[WARN] ...`
 *
 * 级别配色走专属 CSS 变量（--syn-log-*，见 styles.css），与主题切换解耦。
 */

import { LanguageDescription, LanguageSupport, StreamLanguage, StringStream, type StreamParser } from "@codemirror/language";
import { Tag, tags as t } from "@lezer/highlight";

/** 时间戳，淡化处理。 */
export const logTimeTag = Tag.define("logTime");
/** 级别词，按严重度分四档着色。 */
export const logLevelErrorTag = Tag.define("logLevelError");
export const logLevelWarnTag = Tag.define("logLevelWarn");
export const logLevelInfoTag = Tag.define("logLevelInfo");
export const logLevelDebugTag = Tag.define("logLevelDebug");
/** 终端提示符（[user@host dir]$ / [root@host dir]#），强调色。 */
export const logPromptTag = Tag.define("logPrompt");
/** 线程/组件括号（[nio-8080-exec-4]），淡化处理。 */
export const logThreadTag = Tag.define("logThread");
/** 其他样板信息（PID、---、logger 名、冒号、行号前缀、栈帧、参数），淡化。 */
export const logDimTag = Tag.define("logDim");
/** 键名（key=value 的 key 部分），低饱和青。 */
export const logKeyTag = Tag.define("logKey");
/** 值/引号字符串，走标准字符串绿。 */
export const logStringTag = Tag.define("logString");

/** 完整时间戳：日期 + 时间（2026-09-22 14:28:01.176，时区后缀可选）。 */
const FULL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;

/** 只有时间（14:28:01.176）——短日志/控制台粘贴常见。 */
const TIME_ONLY = /^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/;

/** 终端提示符：[user@host dir]$ 或 #（root）。 */
const PROMPT = /^\[[^\]\n]{1,100}\][#$]/;

/** Spring 行的时间戳+级别开头（后续部件逐段条件匹配）。 */
const SPRING_HEAD =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+((?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL)\b)/;

/** Spring PID+分隔符：`507171 --- `（部分格式无 PID，可缺）。 */
const SPRING_PID = /^\s*(?:\d+\s+)?---\s+/;

/** Spring 线程括号（含两侧空格）。 */
const SPRING_THREAD = /^\s*\[[a-zA-Z0-9 ._:@/-]{2,48}\]\s*/;

/** Spring logger 名 + 冒号：`o.s.s.w.FilterChainProxy        : `。 */
const SPRING_LOGGER = /^[\w.$][\w.$]*\s*:(\s|$)/;

/** 栈帧/Caused by（可选 grep 行号前缀已在 planLine 里先处理）。 */
const STACK_FRAME = /^\s*(?:at\s+[\w$./]+\(|Caused by:|\.\.\.\s*\d+\s+more)/;

/** 行首级别词（裸或方括号形式）。 */
const LEADING_LEVEL =
  /^\s*(?:\[(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL)\]|(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL)\b)/;

/** 时间戳后紧跟的级别词。 */
const TS_LEVEL =
  /^\s+(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL)\b/;

type Seg = { len: number; token: string | null };

const push = (segs: Seg[], len: number, token: string | null): void => {
  if (len > 0) segs.push({ len, token });
};

function levelToken(word: string): string {
  switch (word) {
    case "ERROR":
    case "SEVERE":
    case "FATAL":
    case "CRITICAL":
      return "logLevelError";
    case "WARN":
    case "WARNING":
      return "logLevelWarn";
    case "INFO":
    case "NOTICE":
      return "logLevelInfo";
    default:
      return "logLevelDebug";
  }
}

/**
 * 消息/通用文本段细分：引号字符串（绿）、key=（青）+值（绿）、级别词（分色）。
 * 值的边界：到空白、`&` 或行尾为止（URL query、[xxx] 都能整段吃进来）。
 */
function planText(line: string, from: number, to: number, segs: Seg[]): void {
  const re =
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b[\w.]{1,60}\s*=\s*)|(\b(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL)\b)/g;
  re.lastIndex = from;
  let pos = from;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null && match.index < to) {
    push(segs, match.index - pos, null);
    if (match[1] !== undefined) {
      push(segs, match[0].length, "logString");
    } else if (match[2] !== undefined) {
      push(segs, match[0].length, "logKey");
      const rest = line.slice(re.lastIndex);
      const value = /^(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|[^\s&]+)/.exec(rest);
      if (value && value[0]) {
        push(segs, value[0].length, "logString");
        re.lastIndex += value[0].length;
      }
    } else {
      push(segs, match[0].length, levelToken(match[3]));
    }
    pos = re.lastIndex;
  }
  push(segs, to - pos, null);
}

/** 命令文本（提示符之后）：引号字符串绿、参数（-n/--line-number）淡化。 */
function planCommand(line: string, from: number, to: number, segs: Seg[]): void {
  const re =
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\s-{1,2}[a-zA-Z][\w-]*)|(\b(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL)\b)/g;
  re.lastIndex = from;
  let pos = from;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null && match.index < to) {
    push(segs, match.index - pos, null);
    if (match[1] !== undefined) {
      push(segs, match[0].length, "logString");
    } else if (match[2] !== undefined) {
      push(segs, match[0].length, "logDim");
    } else {
      push(segs, match[0].length, levelToken(match[3]));
    }
    pos = re.lastIndex;
  }
  push(segs, to - pos, null);
}

/** 整行规划：产出一串 {长度, token}，token() 逐段消费。 */
function planLine(line: string): Seg[] {
  const segs: Seg[] = [];
  let pos = 0;

  // grep -n 行号前缀：3512133: → 淡化（后续照常解析）
  const lineNo = /^\d{1,8}:(?=\s*\S)/.exec(line);
  if (lineNo) {
    push(segs, lineNo[0].length, "logDim");
    pos += lineNo[0].length;
  }

  const rest = line.slice(pos);

  // 栈帧/Caused by：整行余下淡化（error 语义由行级红条负责）
  if (STACK_FRAME.test(rest)) {
    push(segs, line.length - pos, "logDim");
    return segs;
  }

  // 终端提示符行：提示符强调色 + 命令细分
  const prompt = PROMPT.exec(rest);
  if (prompt) {
    push(segs, prompt[0].length, "logPrompt");
    planCommand(line, pos + prompt[0].length, line.length, segs);
    return segs;
  }

  // Spring 结构：ts LEVEL [pid ---] ([thread])? logger : message
  const head = SPRING_HEAD.exec(rest);
  if (head) {
    push(segs, head[1].length, "logTime");
    push(segs, head[0].length - head[1].length, levelToken(head[2]));
    let cur = pos + head[0].length;
    const remaining = line.slice(cur);
    const pid = SPRING_PID.exec(remaining);
    if (pid) {
      push(segs, pid[0].length, "logDim");
      cur += pid[0].length;
    }
    const thread = SPRING_THREAD.exec(line.slice(cur));
    if (thread) {
      push(segs, thread[0].length, "logThread");
      cur += thread[0].length;
    }
    const logger = SPRING_LOGGER.exec(line.slice(cur));
    if (logger) {
      push(segs, logger[0].length, "logDim");
      cur += logger[0].length;
    }
    planText(line, cur, line.length, segs);
    return segs;
  }

  // 行首时间戳（无 Spring 结构）：时间淡化 + 紧随级别词
  const ts = FULL_TIMESTAMP.exec(rest) ?? TIME_ONLY.exec(rest);
  if (ts) {
    push(segs, ts[0].length, "logTime");
    pos += ts[0].length;
    const lv = TS_LEVEL.exec(line.slice(pos));
    if (lv) {
      push(segs, lv[0].length, levelToken(lv[1]));
      pos += lv[0].length;
    }
    planText(line, pos, line.length, segs);
    return segs;
  }

  // 行首级别词（裸/方括号）
  const leading = LEADING_LEVEL.exec(rest);
  if (leading) {
    push(segs, leading[0].length, levelToken(leading[1] ?? leading[2] ?? ""));
    planText(line, pos + leading[0].length, line.length, segs);
    return segs;
  }

  // 其余：通用细分
  planText(line, pos, line.length, segs);
  return segs;
}

interface LogState {
  segs: Seg[];
}

const logStream = StreamLanguage.define({
  name: "log",
  startState: () => ({ segs: [] as Seg[] }),
  copy: (state: LogState) => ({ segs: state.segs }),
  token(stream: StringStream, state: LogState): string | null {
    if (stream.sol()) state.segs = planLine(stream.string);
    const seg = state.segs.shift();
    if (!seg) {
      stream.pos = stream.string.length;
      return null;
    }
    stream.pos += seg.len;
    return seg.token;
  },
  tokenTable: {
    logTime: logTimeTag,
    logLevelError: logLevelErrorTag,
    logLevelWarn: logLevelWarnTag,
    logLevelInfo: logLevelInfoTag,
    logLevelDebug: logLevelDebugTag,
    logPrompt: logPromptTag,
    logThread: logThreadTag,
    logDim: logDimTag,
    logKey: logKeyTag,
    logString: t.string,
  },
} as StreamParser<LogState>);

/** LanguageDescription：挂进 markdown({ codeLanguages }) 后 ```log 块即生效。 */
export const logLanguageDescription = LanguageDescription.of({
  name: "log",
  alias: ["logs", "log"],
  support: new LanguageSupport(logStream),
});

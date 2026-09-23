/**
 * 粘贴内容的纯变换（Node 里可断言）：换行符规范化、TSV/HTML 表格 → Markdown 表格。
 *
 * 两个动机：
 * - 编辑器的换行符是按文件锁定的（lineSeparator facet）。剪贴板里的文本几乎总是
 *   CRLF——直接插入会在行中间留下裸 `\r`，界面上渲染成红色 CR 角标（basicSetup 的
 *   特殊字符高亮），还会污染文件内容。粘贴时必须规范化成文档自己的分隔符。
 * - 从 Excel/网页/IDE 复制表格时，剪贴板里是 HTML `<table>` 或 TSV 文本。转成
 *   Markdown 管道表格再插入（对齐 Obsidian 的行为），用户不用手工重排。
 */

/** 把剪贴板文本的换行符统一成文档的分隔符（CRLF/LF/孤 CR 一律处理）。 */
export function normalizePastedText(text: string, separator: string): string {
  if (separator === "\r\n") return text.replace(/\r\n?|\n/g, "\r\n");
  if (separator === "\r") return text.replace(/\r\n?|\n/g, "\r");
  return text.replace(/\r\n?/g, "\n");
}

/** 单元格文本的转义与清理：竖线是管道表格的结构字符，必须转义。 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").trim();
}

/** 用 `| ` 包边拼一行；列数不足的行补空单元格。 */
function tableLines(rows: string[][]): string[] {
  const cols = Math.max(...rows.map((row) => row.length), 1);
  const padded = rows.map((row) =>
    Array.from({ length: cols }, (_, index) => escapeCell(row[index] ?? "")),
  );
  const separator = Array.from({ length: cols }, () => "---");
  return [padded[0], separator, ...padded.slice(1)].map((cells) => `| ${cells.join(" | ")} |`);
}

/**
 * TSV 文本 → Markdown 表格行。不是表格时返回 null：
 * - 至少 2 行（单行 tab 通常是路径、对齐文本，不该被当成表格）；
 * - 每行都含 tab、且首格非空（行首 tab 是缩进——Makefile 一类的代码，转表格是误伤）；
 * - 至少 2 列。
 */
export function tsvToMarkdownTable(text: string): string[] | null {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length < 2) return null;
  const rows = lines.map((line) => line.split("\t"));
  if (!rows.every((row) => row.length >= 2 && row[0].trim() !== "")) return null;
  return tableLines(rows);
}

/**
 * 剪贴板 HTML 里的 `<table>` → Markdown 表格行；没有表格返回 null。
 *
 * 单元格取 textContent（HTML 里的 `<br>`、加粗等标记全部拍平），换行压成空格——
 * 管道表格的单元格是单行的。colspan/rowspan 不支持（Obsidian 同样不支持）。
 * 依赖 DOMParser，只能在浏览器里调用；Node 测试只覆盖 TSV 一侧。
 */
export function htmlTableToMarkdown(html: string): string[] | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return null;
  const matrix = rows.map((row) =>
    Array.from(row.querySelectorAll("th,td")).map((cell) =>
      (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
    ),
  );
  if (!matrix.some((row) => row.length > 0)) return null;
  // 单行单列（1×1）没有表格语义——大量网页把整段文字套在 1×1 布局表格里，
  // 转成只有一格的 Markdown 管道表格纯属噪音。返回 null 回落到纯文本粘贴。
  const cellCount = matrix.reduce((sum, row) => sum + row.length, 0);
  if (cellCount <= 1) return null;
  return tableLines(matrix);
}

/**
 * 判断一段纯文本**本身就是** Markdown 表格（各行以竖线开头/结尾）——
 * 这种粘贴保持原样，绝不能再被 TSV 规则或代码围栏规则改写。
 */
export function looksLikeMarkdownTable(text: string): boolean {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  return lines.length >= 2 && lines.every((line) => /^\s*\|.*\|\s*$/.test(line));
}

// ---------------------------------------------------------------- 日志识别

/** 日志行首时间戳：ISO、常见 Java/Python/Nginx/Tomcat 等格式。 */
const LOG_TIMESTAMP =
  /(?:^|\s)(?:\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?|\[[\d\s:,-]+\]|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\d{2}-\w{3}-\d{4}|\d{4}\/\d{2}\/\d{2})/;

/** 日志级别（含方括号与全小写变体）。 */
const LOG_LEVEL = /(?:^|\[|\s)(?:TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|SEVERE|FATAL|CRITICAL)(?:\]|\s|:)/;

/** Java 栈帧 / Caused by / Python traceback 等"异常跟随行"。 */
const LOG_EXCEPTION = /^\s*(?:at\s+[\w$./]+\(|Caused by:|\.\.\.\s*\d+\s+more|Traceback\s|\w+(?:Exception|Error)\b)/;

/**
 * 判断多行文本是不是服务端/程序运行日志。判据（满足行数阈值才认）：
 * - 行首时间戳 + 级别关键词（最典型的 Logback/log4j/Nginx 行）；
 * - 或时间戳 + logger 名（com.foo.bar.Baz 这类点分类名）；
 * - 异常栈跟随行（at xxx(yyy:zz)、Caused by:）单独算弱信号。
 *
 * 优先级高于编程语言识别：带异常栈的日志按 Java 规则会误判成 java 代码，
 * 所以 smartPaste 先问这里。阈值取「强信号 ≥2 行」或「强 1 行 + 栈 ≥2 行」。
 */
export function looksLikeLog(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) return false;
  let strong = 0;
  let exceptions = 0;
  for (const line of lines) {
    if (LOG_EXCEPTION.test(line)) {
      exceptions += 1;
      continue;
    }
    const hasTs = LOG_TIMESTAMP.test(line);
    const hasLevel = LOG_LEVEL.test(line);
    const hasLogger = /\b(?:[a-z]\w*\.)+[A-Z]\w*\b/.test(line);
    if (hasTs && (hasLevel || hasLogger)) strong += 1;
  }
  return strong >= 2 || (strong >= 1 && exceptions >= 2);
}

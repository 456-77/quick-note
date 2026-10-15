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

// ---------------------------------------------------------------- 整篇 HTML → Markdown

/** 内联节点的行内文本：空白压成单空格（Markdown 渲染语义一致）。 */
function inlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * 行内内容 → Markdown 行内文本：粗体/斜体/删除线/行内代码/链接/图片/换行，
 * 其余标签递归拍平。空段返回空串。
 */
function inlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return inlineWhitespace(node.textContent ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const children = () => Array.from(el.childNodes).map(inlineToMarkdown).join("");
  switch (tag) {
    case "br":
      return "\n";
    case "strong":
    case "b": {
      const inner = children().trim();
      return inner ? `**${inner}**` : "";
    }
    case "em":
    case "i": {
      const inner = children().trim();
      return inner ? `*${inner}*` : "";
    }
    case "del":
    case "s":
    case "strike": {
      const inner = children().trim();
      return inner ? `~~${inner}~~` : "";
    }
    case "code": {
      const text = el.textContent ?? "";
      if (!text.trim()) return "";
      // 内容带反引号时换更长的围栏（CommonMark 规则）
      const ticks = text.includes("`") ? "``" : "`";
      return `${ticks}${text}${ticks}`;
    }
    case "a": {
      const href = el.getAttribute("href") ?? "";
      const text = children().trim() || href;
      // 只保留 http(s) 链接；javascript:/相对跳转一概退化成纯文字
      if (!/^https?:\/\//i.test(href)) return text;
      return `[${text}](${href})`;
    }
    case "img": {
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      if (!/^https?:\/\//i.test(src)) return alt;
      return `![${alt}](${src})`;
    }
    default:
      return children();
  }
}

/** 单元格 → 单行文本。竖线不在这里转义——tableLines 的 escapeCell 统一处理。 */
function cellToMarkdown(cell: Element): string {
  return inlineToMarkdown(cell).replace(/\s+/g, " ").trim();
}

/** 表格节点 → 管道表格行；1×1 布局表不当作表格（返回 null，调用方拍成段落）。 */
function tableNodeToMarkdown(table: Element): string[] | null {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return null;
  const matrix = rows.map((row) => Array.from(row.querySelectorAll("th,td")).map(cellToMarkdown));
  if (!matrix.some((row) => row.length > 0)) return null;
  const cellCount = matrix.reduce((sum, row) => sum + row.length, 0);
  if (cellCount <= 1) return null;
  return tableLines(matrix);
}

/** 列表（含嵌套）→ Markdown 行。`ordered` 决定 `-` 还是 `1.` 序号。 */
function listNodeToMarkdown(list: Element, ordered: boolean, depth: number): string[] {
  const out: string[] = [];
  const pad = "  ".repeat(depth);
  let index = 1;
  for (const item of Array.from(list.children)) {
    if (item.tagName.toLowerCase() !== "li") continue;
    const isTask = item.querySelector<HTMLInputElement>(":scope > input[type=checkbox]");
    const marker = ordered ? `${index}. ` : "- ";
    index += 1;
    // 条目内的块级子节点（嵌套列表、段落）逐块展开；纯内联内容拼在首行
    const inlineParts: string[] = [];
    const subBlocks: string[] = [];
    for (const child of Array.from(item.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) {
        inlineParts.push(inlineToMarkdown(child));
        continue;
      }
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") {
        subBlocks.push(...listNodeToMarkdown(el, tag === "ol", depth + 1));
      } else if (tag === "p") {
        inlineParts.push(inlineToMarkdown(el).trim());
      } else if (tag === "input" || tag === "br") {
        continue;
      } else {
        inlineParts.push(inlineToMarkdown(el));
      }
    }
    const body = inlineParts.join("").trim();
    const head = isTask
      ? `${pad}${marker}${isTask.checked ? "[x] " : "[ ] "}${body}`
      : `${pad}${marker}${body}`;
    out.push(head.replace(/\s+$/, ""));
    out.push(...subBlocks);
  }
  return out;
}

/** 围栏代码块：语言从 class 的 language-xxx / lang-xxx 提取，内容里的三反引号换四反引号围栏。 */
function preNodeToMarkdown(pre: Element): string {
  const code = pre.querySelector("code");
  const classList = (code ?? pre).getAttribute("class") ?? "";
  const lang = /(?:^|\s)(?:language|lang)-([\w+-]+)/i.exec(classList)?.[1] ?? "";
  const text = (code?.textContent ?? pre.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * 块级节点 → Markdown 块（数组，元素之间以空行连接）。返回 null 表示该节点
 * 不产生内容（样式脚本、空段落、1×1 布局表被拍平后无正文等）。
 */
function blockToMarkdown(node: Element): string[] | null {
  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = inlineToMarkdown(node).trim();
      return text ? [`${"#".repeat(Number(tag.slice(1)))} ${text}`] : null;
    }
    case "p": {
      const text = inlineToMarkdown(node).trim();
      return text ? [text] : null;
    }
    case "pre":
      return [preNodeToMarkdown(node)];
    case "ul":
      return listNodeToMarkdown(node, false, 0);
    case "ol":
      return listNodeToMarkdown(node, true, 0);
    case "blockquote": {
      const inner = Array.from(node.children)
        .map(blockToMarkdown)
        .filter((v): v is string[] => v !== null)
        .flat();
      const text = inner.length > 0 ? inner : [inlineToMarkdown(node).trim()].filter(Boolean);
      return text.map((line) => `> ${line}`);
    }
    case "table": {
      const lines = tableNodeToMarkdown(node);
      return lines && lines.length > 0 ? lines : null;
    }
    case "hr":
      return ["---"];
    case "br":
      return null;
    case "style":
    case "script":
    case "head":
    case "title":
    case "svg":
    case "button":
    case "input":
    case "select":
    case "form":
      return null;
    default: {
      // div/section/article 等容器：逐块递归；没有任何块级子节点时按段落拍平
      const blockChildren = Array.from(node.children).filter((child) =>
        BLOCK_TAGS.has(child.tagName.toLowerCase()),
      );
      if (blockChildren.length > 0) {
        return blockChildren
          .map(blockToMarkdown)
          .filter((v): v is string[] => v !== null)
          .flat();
      }
      const text = inlineToMarkdown(node).trim();
      return text ? [text] : null;
    }
  }
}

/** 视作"块"的标签：容器递归时会优先按块展开，而不是拍成段落。 */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "ul", "ol", "table",
  "blockquote", "div", "section", "article", "header", "footer", "main", "hr",
]);

/**
 * 整篇 HTML → Markdown（0.23 用户反馈）。
 *
 * 此前粘贴 AI 回答这类"标题 + 段落 + 多张表格"的内容时，只取第一张表替换整段，
 * 其余内容全部丢失。现在只要剪贴板 HTML 里**含有表格**就走完整的结构化转换：
 * 标题、列表、代码块、引用、每张表格各自转换后按原顺序拼接。纯表格（Excel、
 * 网页里的单表）同样得到正确结果；不含表格的 HTML 维持原有纯文本路径。
 *
 * 依赖 DOMParser，只能在浏览器里调用。
 */
export function htmlToMarkdown(html: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.querySelector("table")) return null;
  const blocks: string[] = [];
  for (const node of Array.from(doc.body.children)) {
    const piece = blockToMarkdown(node);
    if (piece && piece.some((line) => line.trim() !== "")) blocks.push(piece.join("\n"));
  }
  const joined = blocks.filter((block) => block.trim() !== "").join("\n\n").trim();
  return joined || null;
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
 * - 或 Maven/Gradle 构建输出的行首 `[INFO]` / `[ERROR]`；
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
    // Maven/Gradle：行首方括号级别，本身就是强信号
    if (/^\[(?:INFO|DEBUG|WARNING|ERROR|TRACE)\]/.test(line.trimStart())) {
      strong += 1;
      continue;
    }
    const hasTs = LOG_TIMESTAMP.test(line);
    const hasLevel = LOG_LEVEL.test(line);
    const hasLogger = /\b(?:[a-z]\w*\.)+[A-Z]\w*\b/.test(line);
    if (hasTs && (hasLevel || hasLogger)) strong += 1;
  }
  return strong >= 2 || (strong >= 1 && exceptions >= 2);
}

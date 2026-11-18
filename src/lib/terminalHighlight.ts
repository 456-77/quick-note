/**
 * shell / env 文件的轻量关键字高亮（0.39.22 用户反馈「优化 txt 和 sh、env
 * 文件的内容显示效果，要支持关键字高亮」）。
 *
 * 不引第三方语法包：逐行扫描 + 一个很小的引号/注释状态机就够覆盖 .sh / .env
 * 的高频结构（shebang / 注释 / 字符串 / 变量 / 关键字 / KEY=value）。
 * - 纯函数 `shellSpans` / `envSpans` 只产出 `{ from, to, kind }`，Node 里可直接断言；
 * - ViewPlugin 只装饰**可见区**（visibleRanges），大文件不会做全文扫描。
 *
 * 配色走既有 `--syn-*` 变量（与 fenced 代码块同一套色相），见 styles.css。
 */

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";

export type TerminalSpanKind = "comment" | "string" | "keyword" | "var" | "key" | "atom";

export interface TerminalSpan {
  from: number;
  to: number;
  kind: TerminalSpanKind;
}

export type TerminalLang = "shell" | "env";

const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until",
  "case", "esac", "function", "return", "export", "local", "readonly", "declare",
  "source", "unset", "shift", "exit", "break", "continue", "select", "time", "trap",
]);

const SHELL_ATOMS = new Set(["true", "false", "null"]);

/** `#` 注释起点：不在引号内、且前面是行首/空白（`${x###}` 之类不误伤）。 */
function commentStart(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return i;
  }
  return -1;
}

/** shell 行内着色区间（绝对下标，调用方传行首偏移）。 */
export function shellSpans(text: string, offset = 0): TerminalSpan[] {
  const spans: TerminalSpan[] = [];
  const out = (from: number, to: number, kind: TerminalSpanKind) => {
    if (to > from) spans.push({ from: offset + from, to: offset + to, kind });
  };
  const hash = commentStart(text);
  const body = hash >= 0 ? text.slice(0, hash) : text;
  if (hash >= 0) out(hash, text.length, "comment");

  // 字符串 + 变量（只扫注释之前的部分）
  let quote: '"' | "'" | null = null;
  let quoteStart = -1;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        out(quoteStart, i + 1, "string");
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoteStart = i;
      continue;
    }
    if (ch === "$") {
      // $VAR / ${VAR} / $(...) 只取名字部分，`$(` 交给后续 token 扫描
      const rest = body.slice(i + 1);
      const m = /^(\{?[A-Za-z_][A-Za-z0-9_]*\}?)/.exec(rest);
      if (m) {
        out(i, i + 1 + m[1].length, "var");
        i += m[1].length;
      }
      continue;
    }
  }
  if (quote && quoteStart >= 0) out(quoteStart, body.length, "string"); // 未闭合字符串

  // 关键字 / 原子（跳过字符串与变量区间）
  const taken = spans
    .filter((span) => span.kind !== "comment")
    .map((span) => [span.from - offset, span.to - offset] as const);
  const wordRe = /[A-Za-z_][A-Za-z0-9_-]*/g;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(body)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    const word = match[0];
    if (SHELL_KEYWORDS.has(word)) out(start, end, "keyword");
    else if (SHELL_ATOMS.has(word) && (end < body.length ? /[\s;|&)]/.test(body[end]) : true)) {
      out(start, end, "atom");
    }
  }
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  return spans;
}

/**
 * env 行内着色：整行注释 / `export KEY=value`（键名一色、值一色、行尾 `#` 注释）。
 */
export function envSpans(text: string, offset = 0): TerminalSpan[] {
  const spans: TerminalSpan[] = [];
  const out = (from: number, to: number, kind: TerminalSpanKind) => {
    if (to > from) spans.push({ from: offset + from, to: offset + to, kind });
  };
  const hash = commentStart(text);
  const body = hash >= 0 ? text.slice(0, hash) : text;
  if (hash >= 0) out(hash, text.length, "comment");
  if (body.trim() === "") return spans;

  const match = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/.exec(body);
  if (!match) return spans; // 非 KEY=VALUE 行（说明文字）：只用上面的注释色，不硬上色
  const [, lead, exportKw, key, eq, value] = match;
  if (exportKw) out(lead.length, lead.length + exportKw.trimEnd().length, "keyword");
  const keyStart = lead.length + (exportKw?.length ?? 0);
  out(keyStart, keyStart + key.length, "key");
  const valueStart = keyStart + key.length + eq.length;
  const valueEnd = valueStart + value.length;
  if (value.trim() !== "") {
    const quoted = /^(["']).*\1$/.test(value.trim());
    out(valueStart, valueEnd, quoted ? "string" : "atom");
  }
  return spans;
}

// ---------------------------------------------------------------- 视图接线

const DECOS: Record<TerminalSpanKind, Decoration> = {
  comment: Decoration.mark({ class: "qn-term-comment" }),
  string: Decoration.mark({ class: "qn-term-str" }),
  keyword: Decoration.mark({ class: "qn-term-kw" }),
  var: Decoration.mark({ class: "qn-term-var" }),
  key: Decoration.mark({ class: "qn-term-key" }),
  atom: Decoration.mark({ class: "qn-term-atom" }),
};

function buildDecorations(view: EditorView, lang: TerminalLang): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  const spans: TerminalSpan[] = [];
  for (const range of view.visibleRanges) {
    let lineNo = doc.lineAt(range.from).number;
    while (lineNo <= doc.lines) {
      const line = doc.line(lineNo);
      if (line.from > range.to) break;
      const lineSpans = lang === "shell" ? shellSpans(line.text, line.from) : envSpans(line.text, line.from);
      for (const span of lineSpans) spans.push(span);
      lineNo += 1;
    }
  }
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  let lastFrom = -1;
  let lastTo = -1;
  for (const span of spans) {
    // RangeSetBuilder 要求严格升序且不重叠：同一位置重复时跳过
    if (span.from < lastTo || (span.from === lastFrom && span.to <= lastTo)) continue;
    builder.add(span.from, span.to, DECOS[span.kind]);
    lastFrom = span.from;
    lastTo = span.to;
  }
  return builder.finish();
}

/** sh / env 语法高亮扩展（editorLanguageOf 选语言时挂进语言 Compartment）。 */
export function terminalHighlight(lang: TerminalLang) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, lang);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view, lang);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

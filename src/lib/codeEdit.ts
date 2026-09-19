/**
 * 行内代码 / 代码块的快捷切换（对齐 Obsidian 的「切换行内代码」「切换代码块」命令）。
 *
 * 两层结构：
 * - 纯函数（`inlineCodeToggleAt` / `codeBlockPadding`）只算"在哪删、在哪插"，
 *   不碰 DOM，可以在 Node 里断言；
 * - EditorView 入口（`toggleInlineCode` / `toggleCodeBlock`）负责取状态、派发变更。
 *
 * 键位绑定在 `hotkeys.ts` 的 COMMAND_KEYS（设置面板可改），由 `editor.ts` 的
 * keydown 分发调用。
 */

import { EditorSelection, type SelectionRange } from "@codemirror/state";
import { indentLess, indentMore } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { isInsideFence } from "./paste.ts";

// ---------------------------------------------------------------- 行内代码

/**
 * 计算行内代码切换在**一行文本内**的编辑动作。
 *
 * 入参：`lineText` 是本行文本，`fromCol`/`toCol` 是选区在本行内的列（空选区时相等）。
 * 返回：
 * - `{ remove: [起, 止] }`：成对反引号的区间（删掉即取消行内代码）；
 * - `{ wrap: [左插位, 右插位] }`：两侧各插一个反引号（包裹成行内代码）；
 * - `null`：此选区没法做行内代码切换（跨行、内容里已有反引号等），调用方跳过。
 *
 * 判定顺序（对齐 Obsidian 的手感）：
 * 1. 选区本身就裹着反引号 → 取消；
 * 2. 选区/光标落在一对反引号里 → 取消那一对；
 * 3. 其余 → 包裹。
 */
export function inlineCodeToggleAt(
  lineText: string,
  fromCol: number,
  toCol: number,
): { remove: [number, number] } | { wrap: [number, number] } | null {
  const selected = lineText.slice(fromCol, toCol);
  // 1) 选区自带反引号（`选中 \`code\`` 这种）：去掉两侧
  if (selected.length >= 2 && selected.startsWith("`") && selected.endsWith("`")) {
    const inner = selected.slice(1, -1);
    if (!inner.includes("`")) return { remove: [fromCol, toCol] };
    return null;
  }

  // 2) 找选区/光标所在的一对反引号：左取前面最近的 `，右取后面最近的 `，
  //    中间不能再有 `（否则就是跨了别的代码段，宁可不当它存在）。
  const leftAt = fromCol > 0 ? lineText.lastIndexOf("`", fromCol - 1) : -1;
  const rightAt = lineText.indexOf("`", toCol);
  if (leftAt >= 0 && rightAt > leftAt) {
    const inner = lineText.slice(leftAt + 1, rightAt);
    if (!inner.includes("`") && fromCol >= leftAt + 1 && toCol <= rightAt) {
      return { remove: [leftAt, rightAt + 1] };
    }
  }

  // 3) 包裹。内容里已有反引号的不再包（会拆出错误的代码段边界）。
  if (selected.includes("`")) return null;
  return { wrap: [fromCol, toCol] };
}

/** 把 {@link inlineCodeToggleAt} 的动作应用到整个编辑器（多选区从后往前，位置不漂移）。 */
export function toggleInlineCode(view: EditorView): boolean {
  const { state } = view;
  const changes: Array<{ from: number; to?: number; insert?: string }> = [];
  // 与原选区一一对应：能切换的换成新选区，切不了的（跨行等）原地保留
  const ranges: SelectionRange[] = [];

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.from);
    // 行内代码不跨行：跨行选区直接跳过（代码块走另一个命令）
    if (state.doc.lineAt(range.to).number !== line.number) {
      ranges.push(range);
      continue;
    }
    const action = inlineCodeToggleAt(
      line.text,
      range.from - line.from,
      range.to - line.from,
    );
    if (!action) {
      ranges.push(range);
      continue;
    }
    if ("remove" in action) {
      const [a, b] = action.remove;
      changes.push({ from: line.from + a, to: line.from + b, insert: "" });
      ranges.push(
        EditorSelection.range(line.from + a, Math.max(line.from + b - 2, line.from + a)),
      );
    } else {
      const [a, b] = action.wrap;
      changes.push({ from: line.from + a, insert: "`" });
      changes.push({ from: line.from + b, insert: "`" });
      ranges.push(EditorSelection.range(line.from + a + 1, line.from + b + 1));
    }
  }
  if (changes.length === 0) return false;

  view.dispatch({
    changes,
    selection: EditorSelection.create(ranges),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

// ---------------------------------------------------------------- 代码块

/**
 * 块级插入前后的补位换行（支持选区跨行）。
 *
 * 与 `paste.ts` 的 blockInsertPadding 同一套规则，但前后界各看各的：
 * 选区前的文字决定 prefix、选区后的文字决定 suffix，选区跨多少行无所谓。
 */
export function codeBlockPadding(
  lines: string[],
  fromLine: number,
  fromCol: number,
  toLine: number,
  toCol: number,
): { prefix: string; suffix: string } {
  const before = (lines[fromLine] ?? "").slice(0, fromCol).trim();
  const after = (lines[toLine] ?? "").slice(toCol).trim();
  const prev = fromLine > 0 ? (lines[fromLine - 1] ?? "").trim() : "";
  const next = (lines[toLine + 1] ?? "").trim();
  return {
    prefix: before ? "\n\n" : prev ? "\n" : "",
    suffix: after ? "\n\n" : next ? "\n" : "",
  };
}

/** 代码块切换的编辑器入口。光标已在围栏内时不动作（粘贴规则里也如此）。 */
export function toggleCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const fromLine = state.doc.lineAt(range.from);
  const toLine = state.doc.lineAt(range.to);
  const lines = state.doc.toString().split("\n");

  // 已在围栏代码块内：命令管"进代码块"，不管"出"——离开靠删围栏或光标操作
  if (isInsideFence(lines, fromLine.number - 1)) return false;

  const selected = state.sliceDoc(range.from, range.to);
  const { prefix, suffix } = codeBlockPadding(
    lines,
    fromLine.number - 1,
    range.from - fromLine.from,
    toLine.number - 1,
    range.to - toLine.from,
  );
  const text = `${prefix}\`\`\`\n${selected}\n\`\`\`${suffix}`;
  // 围栏开始（"```\n"）之后、正文之前的位置
  const bodyFrom = range.from + prefix.length + 4;

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: bodyFrom, head: bodyFrom + selected.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

// ---------------------------------------------------------------- 标题

/**
 * 计算某一行应用「设置标题 N」后的新行文本与光标列（对齐 Obsidian 的同名命令）。
 *
 * - 行已是 N 级标题 → 取消标题（去掉 `#` 前缀）；
 * - 行是其他级别的标题 → 直接换级别（保留正文）；
 * - 行不是标题 → 前缀 `# `.repeat(N)。
 *
 * 返回 `null` 表示没有可做的变换。光标列按新文本收尾，尽量停在原字符上。
 */
export function headingToggleAt(
  lineText: string,
  level: number,
  headCol: number,
): { text: string; headCol: number } | null {
  // 只认「缩进 + # 1..6 个 + 空白或行尾」——`#标签` 这种行内标签不算标题，
  // 免得给它换级别时把标签文字改坏
  const match = /^(\s*)(#{1,6})(\s|$)/.exec(lineText);
  const hashes = "#".repeat(level);

  if (!match) {
    const text = `${hashes} ${lineText}`;
    // 光标挪到前缀之后；原光标在行首时也一样，方便接着打标题
    return { text, headCol: Math.max(headCol + level + 1, level + 1) };
  }

  const indent = match[1];
  const oldHashes = match[2];
  const after = lineText.slice(indent.length + oldHashes.length);
  const prefixLen = indent.length + level;

  if (oldHashes.length === level) {
    // 取消标题：去掉 `#` 前缀与其后的空白
    const text = indent + after.replace(/^\s+/, "");
    const removed = lineText.length - text.length;
    return { text, headCol: Math.max(headCol - removed, indent.length) };
  }

  // 换级别：保留缩进与正文，只替换井号
  const text = indent + hashes + after;
  const delta = level - oldHashes.length;
  return {
    text,
    headCol: Math.min(Math.max(headCol + delta, prefixLen + 1), text.length),
  };
}

/** 标题切换的编辑器入口：作用于光标所在行；围栏代码块内不动作。 */
export function toggleHeading(view: EditorView, level: number): boolean {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  const lines = state.doc.toString().split("\n");
  if (isInsideFence(lines, line.number - 1)) return false;

  const result = headingToggleAt(line.text, level, range.head - line.from);
  if (!result) return false;

  view.dispatch({
    changes: { from: line.from, to: line.to, insert: result.text },
    selection: { anchor: line.from + Math.min(result.headCol, result.text.length) },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

// ---------------------------------------------------------------- Tab 缩进

/**
 * Tab（Obsidian 式）：光标处插入缩进单位；有选区时缩进所选行。
 *
 * 此前编辑器没有绑定裸 Tab，按键会按浏览器默认行为把焦点移出编辑器
 * （表现为"按 Tab 跳到别的控件"）。表格内的 Tab 仍由更早的键位处理。
 */
export function editorTab(view: EditorView): boolean {
  const ranges = view.state.selection.ranges;
  if (!ranges.every((range) => range.empty)) {
    return indentMore(view);
  }
  // 空选区：在每个光标处插入缩进单位（replaceSelection 原生支持多光标）
  view.dispatch(view.state.replaceSelection(view.state.facet(indentUnit)), {
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** Shift+Tab（Obsidian 式）：反缩进光标所在行 / 所选行。 */
export function editorShiftTab(view: EditorView): boolean {
  return indentLess(view);
}

/**
 * 表格编辑命令（EditorView 侧）。
 *
 * 纯结构变换在 `table.ts`（行数组进出），这里负责三件与编辑器相关的事：
 * 用语法树找到光标所在的表格块、按 `state.lineBreak` 拼接新块（CRLF 不被打回 LF）、
 * 以及把光标放进操作后的目标单元格。
 *
 * 键位只有 Tab / Shift-Tab：光标不在表格里时返回 false，交给默认行为（缩进），
 * 所以这个扩展可以放心全局挂载。
 */

import { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import {
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumn,
  insertRow,
  parseTableBlock,
  tableSpans,
  type TableBlock,
} from "./table.ts";

/** 光标所在的表格块：起始行/结束行（0 基，含）与行文本。 */
export interface TableRange {
  startLine: number;
  endLine: number;
  lines: string[];
}

/** 用语法树找包含 pos 的 Table 节点，返回它覆盖的行区间。 */
export function findTableRange(state: EditorState, pos: number): TableRange | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node && node.name !== "Table") node = node.parent;
  if (node === null || node.name !== "Table") return null;
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  const lines: string[] = [];
  for (let index = first.number; index <= last.number; index += 1) {
    lines.push(state.doc.line(index).text);
  }
  return { startLine: first.number - 1, endLine: last.number - 1, lines };
}

/** 光标是否在表格块内（工具栏的显示依据）。 */
export function isCursorInTable(state: EditorState): boolean {
  return findTableRange(state, state.selection.main.head) !== null;
}

/**
 * 对光标所在表格执行一个结构变换。
 *
 * 变换函数收到解析后的块，返回新块的行数组；随后光标按 (行, 列) 落位——
 * 行是**新块**里的行号（0 基），列是单元格序号（落在该单元格第一个字符之后）。
 */
function withTable(view: EditorView, transform: (block: TableBlock) => string[], caretLine: number, caretColumn: number): boolean {
  const state = view.state;
  const range = findTableRange(state, state.selection.main.head);
  if (!range) return false;
  const block = parseTableBlock(range.lines);
  if (!block) return false;

  const newLines = transform(block);
  const lineBreak = state.lineBreak;
  const insert = newLines.join(lineBreak);
  const firstLine = state.doc.line(range.startLine + 1);
  const lastLine = state.doc.line(range.endLine + 1);

  // 光标定位：新块第 caretLine 行的第 caretColumn 个单元格文本之后。
  // 用行内管道扫描，与 tableSpans 同一套口径，避免按字符累计在 CJK/对齐空白上算错。
  const targetLine = newLines[Math.min(caretLine, newLines.length - 1)] ?? "";
  const spans = tableSpans([targetLine]).rows[0].cells;
  const span = spans[Math.min(caretColumn, spans.length - 1)] ?? { start: 1, end: 1 };
  let caretInBlock = 0;
  for (let index = 0; index < Math.min(caretLine, newLines.length); index += 1) {
    caretInBlock += newLines[index].length + lineBreak.length;
  }
  const caretPos = firstLine.from + caretInBlock + Math.max(span.end - 1, span.start);

  view.dispatch({
    changes: { from: firstLine.from, to: lastLine.to, insert },
    selection: { anchor: Math.min(caretPos, view.state.doc.length) },
    scrollIntoView: true,
  });
  return true;
}

/** 下一单元格；最后一格则新建一行并进去（Obsidian 行为）。上一格不跨行回绕。 */
export function tableTab(view: EditorView): boolean {
  const state = view.state;
  const range = findTableRange(state, state.selection.main.head);
  if (!range) return false;

  const spans = tableSpans(range.lines);
  const head = state.selection.main.head;
  // 找到光标所在 (row, cell)
  let position: { line: number; cell: number } | null = null;
  for (let rowIndex = 0; rowIndex < spans.rows.length; rowIndex += 1) {
    const line = state.doc.line(range.startLine + rowIndex + 1);
    if (head < line.from || head > line.to) continue;
    const cells = spans.rows[rowIndex].cells;
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const cell = cells[cellIndex];
      if (head <= line.from + cell.end) {
        position = { line: rowIndex, cell: cellIndex };
        break;
      }
    }
    if (position) break;
  }
  if (!position) return false;

  const row = spans.rows[position.line];
  if (position.cell < row.cells.length - 1 || position.line < spans.rows.length - 1) {
    // 块内移动：下一格；行尾则下一行第一格
    if (position.cell < row.cells.length - 1) {
      return withSelection(view, range, position.line, position.cell + 1);
    }
    return withSelection(view, range, position.line + 1, 0);
  }
  // 最后一个单元格：新建数据行
  const block = parseTableBlock(range.lines);
  if (!block) return false;
  return withTable(
    view,
    (parsed) => insertRow(parsed, parsed.rows.length - 1, []),
    spans.rows.length, // 新块里新增的行（原有行数 + 1 - 1 = 行数）
    0,
  );
}

/** 上一单元格；行首则到上一行最后一格。不新建行。 */
export function tableShiftTab(view: EditorView): boolean {
  const state = view.state;
  const range = findTableRange(state, state.selection.main.head);
  if (!range) return false;
  const spans = tableSpans(range.lines);
  const head = state.selection.main.head;
  let position: { line: number; cell: number } | null = null;
  for (let rowIndex = 0; rowIndex < spans.rows.length; rowIndex += 1) {
    const line = state.doc.line(range.startLine + rowIndex + 1);
    if (head < line.from || head > line.to) continue;
    const cells = spans.rows[rowIndex].cells;
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const cell = cells[cellIndex];
      if (head <= line.from + cell.end) {
        position = { line: rowIndex, cell: cellIndex };
        break;
      }
    }
    if (position) break;
  }
  if (!position) return false;
  if (position.cell > 0) return withSelection(view, range, position.line, position.cell - 1);
  if (position.line > 0) {
    const above = spans.rows[position.line - 1];
    return withSelection(view, range, position.line - 1, Math.max(above.cells.length - 1, 0));
  }
  return true; // 已经是第一个单元格：吃掉按键，避免触发缩进
}

/** 把光标放回块内 (line, cell)（不改文档）。 */
function withSelection(view: EditorView, range: TableRange, lineIndex: number, cellIndex: number): boolean {
  const state = view.state;
  const spans = tableSpans(range.lines);
  const row = spans.rows[Math.min(lineIndex, spans.rows.length - 1)];
  const line = state.doc.line(range.startLine + Math.min(lineIndex, spans.rows.length - 1) + 1);
  const cell = row.cells[Math.min(cellIndex, row.cells.length - 1)] ?? { start: 1, end: 1 };
  view.dispatch({
    selection: { anchor: Math.min(line.from + Math.max(cell.end - 1, cell.start), line.to) },
  });
  return true;
}

/** 以下工具栏按钮。caretLine/caretColumn 的口径见 withTable。 */

export function insertRowBelow(view: EditorView): boolean {
  return locate(view, (_range, row) =>
    // row（0=表头 1=分隔行 2+=数据行）→ 数据行下标 = row-2；在其后插入。
    // 光标在表头/分隔行时钳到 -1 = 新行成为第一行数据（曾因 -2 让 splice(-1)
    // 把新行插到倒数第一行之前，位置全错）
    withTable(
      view,
      (block) => insertRow(block, Math.max(row - 2, -1), []),
      Math.max(row + 1, 2),
      0,
    ),
  );
}

export function insertRowAbove(view: EditorView): boolean {
  return locate(view, (_range, row) =>
    // 在数据行 i 之前插入 = afterRowIndex i-1；表头/分隔行/首行数据都钳到 -1
    withTable(
      view,
      (block) => insertRow(block, Math.max(row - 3, -1), []),
      Math.max(row, 2),
      0,
    ),
  );
}

export function insertColumnLeft(view: EditorView): boolean {
  return locate(view, (_range, row, column) =>
    withTable(view, (block) => insertColumn(block, column), row, column),
  );
}

export function insertColumnRight(view: EditorView): boolean {
  return locate(view, (_range, row, column) =>
    withTable(view, (block) => insertColumn(block, column + 1), row, column + 1),
  );
}

export function deleteRowAtCursor(view: EditorView): boolean {
  return locate(view, (_range, row) => {
    // 表头与分隔行不可删：删掉它们表格就散了。光标在这两行时此键为空操作
    if (row <= 1) return true;
    return withTable(
      view,
      (block) => deleteRow(block, row - 2),
      Math.max(row - 1, 2),
      0,
    );
  });
}

export function deleteColumnAtCursor(view: EditorView): boolean {
  return locate(view, (_range, row, column) =>
    withTable(view, (block) => deleteColumn(block, column), Math.max(row, 0), Math.max(column - 1, 0)),
  );
}

export function formatTableAtCursor(view: EditorView): boolean {
  return locate(view, () => withTable(view, formatTable, 0, 0));
}

/** 取光标在块内的 (行, 列) 后执行。 */
function locate(
  view: EditorView,
  run: (range: TableRange, row: number, column: number) => boolean,
): boolean {
  const state = view.state;
  const range = findTableRange(state, state.selection.main.head);
  if (!range) return false;
  const spans = tableSpans(range.lines);
  const head = state.selection.main.head;
  for (let rowIndex = 0; rowIndex < spans.rows.length; rowIndex += 1) {
    const line = state.doc.line(range.startLine + rowIndex + 1);
    if (head < line.from || head > line.to) continue;
    const cells = spans.rows[rowIndex].cells;
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      if (head <= line.from + cells[cellIndex].end) {
        return run(range, rowIndex, cellIndex);
      }
    }
    return run(range, rowIndex, Math.max(cells.length - 1, 0));
  }
  return false;
}

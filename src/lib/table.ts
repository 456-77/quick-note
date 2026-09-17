/**
 * GFM 表格的结构化编辑（Obsidian 式表格体验的核心逻辑）。
 *
 * ## 设计边界
 *
 * 这里只放**纯函数**：解析表格行、对齐管道、行列变换。它们拿 `string[]`（不带换行符
 * 的行文本）进、出新行数组——换行符拼接与文档定位由编辑器侧的命令函数完成
 * （用 `state.lineBreak`，CRLF 文件才不会被打回 LF）。
 *
 * 解析按“肉眼可见的管道”切分单元格，**不处理**转义 `\|` 与行内代码里的 `|`——
 * 基础 GFM 没有 SparseRead，Obsidian 的表格编辑器同样按可见管道切。这条边界写进
 * 注释比假装支持更好：真需要竖线的单元格，用户会在渲染视图里看到它被切开，自己规避。
 *
 * 宽度按**终端列宽**口径：CJK 等宽字符算 2 列。管道对齐若按 JS 字符串长度算，
 * 中文表格永远对不齐——这正是 Obsidian 表格观感的来源。
 */

/** 一个表格块的解析结果：表头、分隔行（含对齐）、数据行。全部为原始单元格文本。 */
export interface TableBlock {
  header: string[];
  /** 分隔行的原始单元格（如 `:---`），长度与 header 对齐。 */
  delimiter: string[];
  rows: string[][];
}

/** 把一行表格文本切成单元格（去掉首尾管道与两侧空白）。 */
export function splitRow(line: string): string[] {
  const trimmed = line.trim();
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").map((cell) => cell.trim());
}

/** 把单元格数组拼回一行（管道两侧留一个空格——Obsidian 的默认观感）。 */
export function joinRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** 判断一行文本是否是表格行（含表头、分隔行）。 */
export function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|", 1);
}

/**
 * 判断一行是否是分隔行（`| --- | :-: |`）。
 *
 * 连字符数按 cmark 规则：一个即可（`| - | - |` 是合法分隔行）。
 */
export function isDelimiterLine(line: string): boolean {
  if (!isTableRowLine(line)) return false;
  return splitRow(line).every((cell) => /^:?-+:?$/.test(cell));
}

/** 从表格行数组解析出块；不合法（没有分隔行）返回 null。 */
export function parseTableBlock(lines: string[]): TableBlock | null {
  if (lines.length < 2) return null;
  if (!isDelimiterLine(lines[1])) return null;
  const header = splitRow(lines[0]);
  const delimiter = splitRow(lines[1]);
  const rows = lines.slice(2).map(splitRow);
  return { header, delimiter, rows };
}

/**
 * 把所有行规范到同一列数（Obsidian 的行为：缺的补空单元格，不丢内容）。
 * 返回统一后的块。
 */
export function normalizeColumns(block: TableBlock): TableBlock {
  const width = Math.max(
    block.header.length,
    block.delimiter.length,
    ...block.rows.map((row) => row.length),
    1,
  );
  const pad = (cells: string[]) => {
    const out = cells.slice();
    while (out.length < width) out.push("");
    return out;
  };
  return {
    header: pad(block.header),
    delimiter: pad(block.delimiter),
    rows: block.rows.map(pad),
  };
}

/**
 * 单个字符的显示宽度：CJK/全角算 2，其余算 1。
 *
 * 覆盖常用区间（谚文、CJK 统一表意、假名、全角形式、CJK 标点等），不追求
 * Unicode EastAsianWidth 全表——对齐是观感问题，漏一个罕见区间只是差一格。
 */
export function charWidth(codePoint: number): 1 | 2 {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK 部首/符号
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // 假名/注音/CJK 符号
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 统一表意
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // 彝文
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // 音节文字（谚文）
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK 兼容形式
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角形式
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) // CJK 扩展 B+
  ) {
    return 2;
  }
  return 1;
}

/** 字符串的显示宽度。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

/** 按显示宽度补空白到指定宽度；align 决定空白放哪边。 */
function padCell(text: string, width: number, align: "left" | "center" | "right"): string {
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + text + " ".repeat(gap - left);
  }
  return text + " ".repeat(gap);
}

/** 从分隔行单元格读对齐（`:-:` 居中、`-:` 右对齐、其余左对齐）。 */
export function alignOf(delimiterCell: string): "left" | "center" | "right" {
  const cell = delimiterCell.trim();
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/**
 * 管道对齐：每列取最大显示宽度，所有单元格补空白，分隔行补足 `-`。
 *
 * 这是 Obsidian 表格编辑器的标志性观感——源码里的管道竖成一条直线。
 * 只改空白与 `-` 的数量，不动任何单元格内容。
 */
export function formatTable(block: TableBlock): string[] {
  const normalized = normalizeColumns(block);
  const columnCount = normalized.header.length;
  const aligns = normalized.delimiter.map(alignOf);

  const widths: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    const cells = [
      normalized.header[column],
      ...normalized.rows.map((row) => row[column]),
    ];
    widths.push(
      Math.max(3, ...cells.map((cell) => displayWidth(cell))),
    );
  }

  const dashRow = widths.map((width, column) => {
    const align = aligns[column] ?? "left";
    if (align === "center") {
      const inner = Math.max(width - 2, 1);
      return ":" + "-".repeat(inner) + ":";
    }
    // 右对齐的标记是**尾随**冒号（`---:`）。曾写成前导冒号（`:---`），而 alignOf
    // 把前导冒号读成 left——右对齐的列在任何一次对齐/编辑后都会被静默降级成左对齐
    if (align === "right") return "-".repeat(Math.max(width - 1, 3)) + ":";
    return "-".repeat(width);
  });

  const lineOf = (cells: string[], isDelimiter = false) => {
    const padded = cells.map((cell, column) =>
      isDelimiter ? cell : padCell(cell, widths[column], aligns[column] ?? "left"),
    );
    return `| ${padded.join(" | ")} |`;
  };

  return [
    lineOf(normalized.header),
    lineOf(dashRow, true),
    ...normalized.rows.map((row) => lineOf(row)),
  ];
}

/**
 * 在指定数据行之后插入一行。
 *
 * `afterRowIndex` 是"插在哪个数据行之后"：-1 = 插到最前（表头与分隔行之间），
 * rows.length - 1 = 追加到末尾。列数与表格对齐，缺的补空单元格。
 */
export function insertRow(block: TableBlock, afterRowIndex: number, template: string[]): string[] {
  const normalized = normalizeColumns(block);
  const columnCount = normalized.header.length;
  const newRow = Array.from({ length: columnCount }, (_, index) => template[index] ?? "");
  const rows = normalized.rows.slice();
  // afterRowIndex 以数据行为基准：-1 表示插在最前（表头之后），rows.length 表示追加
  rows.splice(afterRowIndex + 1, 0, newRow);
  return formatTable({ ...normalized, rows });
}

/** 删除数据行（0 基；越界返回原样）。 */
export function deleteRow(block: TableBlock, rowIndex: number): string[] {
  const normalized = normalizeColumns(block);
  if (rowIndex < 0 || rowIndex >= normalized.rows.length || normalized.rows.length === 1) {
    return formatTable(normalized);
  }
  const rows = normalized.rows.slice();
  rows.splice(rowIndex, 1);
  return formatTable({ ...normalized, rows });
}

/**
 * 在指定列侧插入一列。
 *
 * 分隔行的对齐标记**不继承**——新列默认左对齐（空 `---`）。继承隔壁列的对齐
 * 看似贴心，实际上"我加了列但内容全变居中"更让人困惑。
 */
export function insertColumn(block: TableBlock, beforeColumnIndex: number): string[] {
  const normalized = normalizeColumns(block);
  const at = Math.min(Math.max(beforeColumnIndex, 0), normalized.header.length);
  const insert = (cells: string[]) => {
    const out = cells.slice();
    out.splice(at, 0, "");
    return out;
  };
  return formatTable({
    header: insert(normalized.header),
    delimiter: insert(normalized.delimiter),
    rows: normalized.rows.map(insert),
  });
}

/** 删除一列（只剩一列时不动）。 */
export function deleteColumn(block: TableBlock, columnIndex: number): string[] {
  const normalized = normalizeColumns(block);
  if (normalized.header.length <= 1) return formatTable(normalized);
  const at = Math.min(Math.max(columnIndex, 0), normalized.header.length - 1);
  const remove = (cells: string[]) => {
    const out = cells.slice();
    out.splice(at, 1);
    return out;
  };
  return formatTable({
    header: remove(normalized.header),
    delimiter: remove(normalized.delimiter),
    rows: normalized.rows.map(remove),
  });
}

// ---------------------------------------------------------------- 光标与单元格

/** 相对表格块起始行的单元格定位（用于导航）。 */
export interface CellSpan {
  rowIndex: number; // 0 = 表头
  columnIndex: number;
  /** 在该行文本内的 [start, end)（按去掉行尾空白后的文本计）。 */
  start: number;
  end: number;
}

/**
 * 计算表格块内所有单元格在**行内**的区间。
 *
 * 行文本取的是不含换行符的原文（含 `\r` 的场景由调用方处理），首尾管道保留，
 * 单元格文本带有一个前导空格（`| a | b |` 里 a 的区间是 [3,4]）。
 */
export function cellSpansInLine(line: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let index = line.indexOf("|");
  while (index >= 0) {
    const next = line.indexOf("|", index + 1);
    if (next < 0) break;
    // 空区间（`||`）也占一格，光标落在两根管道之间
    spans.push({ start: index + 1, end: next });
    index = next;
  }
  return spans;
}

/** 表格块的完整结构：行区间（块内）与每行的单元格区间。 */
export interface TableSpans {
  /** 每行的行内单元格区间；0 = 表头，1 = 分隔行，2+ = 数据行。 */
  rows: { start: number; end: number; cells: { start: number; end: number }[] }[];
}

export function tableSpans(lines: string[]): TableSpans {
  return {
    rows: lines.map((line) => {
      const text = line.replace(/\r$/, "");
      const body = text.trimEnd();
      return {
        start: 0,
        end: body.length,
        cells: cellSpansInLine(body),
      };
    }),
  };
}

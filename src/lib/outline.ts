/**
 * 大纲（目录）提取。
 *
 * 纯文本扫描而不是语法树：目录要在每次键入后重算，正则扫一遍全文的成本远低于
 * 构建增量语法树的查询链，而且这里只需要行级信息。围栏代码块里的 `# 注释` 不是
 * 标题——这是这类扫描最常见的假阳性，必须跳过。
 *
 * Setext 标题（下一行是 `===` 或 `---`）也要认出来：M1 的渲染层支持它，
 * 大纲与渲染看到的标题不一致会让人困惑。
 */

export interface OutlineEntry {
  /** 标题级别：1-6（ATX）或 1/2（setext）。 */
  level: number;
  /** 标题文字（去掉 # 与空格）。 */
  text: string;
  /** 所在行号（0 基）。 */
  line: number;
}

/** 提取一篇笔记的大纲。文本按行传入（保留行内的 `\r`，由这里 trim 掉）。 */
export function outlineOf(lines: string[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    const trimmed = line.trim();

    // 围栏状态机：``` 与 ~~~ 各自闭合（与 markdown 一致），行内还有别的字符也算开栏
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;

    // ATX：#{1,6} 后必须有空格或行尾
    const atx = /^(#{1,6})(\s+(.*))?$/.exec(trimmed);
    if (atx) {
      entries.push({
        level: atx[1].length,
        text: (atx[3] ?? "").trim(),
        line: index,
      });
      continue;
    }

    // Setext：本行非空、无 #，下一行全是 = 或 -（至少两个，避免把列表/分隔线误判）
    if (trimmed.length > 0 && !trimmed.startsWith("#") && index + 1 < lines.length) {
      const next = lines[index + 1].replace(/\r$/, "").trim();
      if (/^={2,}$/.test(next)) {
        entries.push({ level: 1, text: trimmed, line: index });
        continue;
      }
      if (/^-{2,}$/.test(next) && !/^\s*([-*+]|\d+\.)\s/.test(trimmed)) {
        // `---` 是分隔线还是 setext 下划线，取决于上一行有没有文字——有文字就是标题
        entries.push({ level: 2, text: trimmed, line: index });
        continue;
      }
    }
  }

  return entries;
}

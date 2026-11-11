/**
 * Excel 预览的表头行识别（0.39.7 用户反馈「筛选只能根据第一行内容筛，正常
 * 应该根据紧挨数据的那一行」——WPS 里常见「合并大标题行 + 真正字段名行」的
 * 两行头结构，0.39.5 起大标题行被当成表头，筛选的列头/值列表全错位）。
 *
 * 纯函数、无 IO，可在 Node 里断言（verify-xlsx-merges.mjs）。
 */

/** 统计一行里的非空单元格数（容忍数字等非字符串值——测试数据直接写原始值）。 */
function filledCount(row: string[]): number {
  let count = 0;
  for (const value of row) {
    if (String(value ?? "").trim() !== "") count += 1;
  }
  return count;
}

/**
 * 从解析结果的前几行里挑出真正的表头行（0 基行号）。
 *
 * **刻意保守**：只有第 1 行明显是「稀疏横幅」（非空格数不到前 4 行里最满一行
 * 的一半）时才把表头行下移到最满的那行；否则恒返回 0——普通表（第 1 行就是
 * 满的表头）行为完全不变，表头稀疏而数据更满的表也不会误判。
 */
export function detectHeaderRow(rows: string[][]): number {
  const limit = Math.min(3, rows.length - 1);
  if (limit <= 0) return 0;
  let max = -1;
  let maxAt = 0;
  for (let i = 0; i <= limit; i += 1) {
    const count = filledCount(rows[i] ?? []);
    if (count > max) {
      max = count;
      maxAt = i;
    }
  }
  const first = filledCount(rows[0] ?? []);
  if (first * 2 < max) return maxAt;
  return 0;
}

/**
 * 换行符风格 ↔ 实际分隔符。
 *
 * 单独成模块且不引入任何依赖，目的是让测试脚本能直接引用同一份映射
 * （Node 的类型剥离可以直接 import 本文件）。若测试里再抄一份映射，
 * 两边判定不一致时会双双"通过"，掩盖真实缺陷——这个坑已经踩过一次。
 */

/** Rust 侧 detect_line_ending 的取值 → CodeMirror lineSeparator。 */
export const LINE_SEPARATOR: Record<string, string> = {
  crlf: "\r\n",
  lf: "\n",
  cr: "\r",
  // 文件内没有任何换行符，取 \n 无影响。
  none: "\n",
};

const LINE_ENDING_LABEL: Record<string, string> = {
  crlf: "CRLF",
  lf: "LF",
  cr: "CR",
  none: "无换行",
};

/** 未知取值一律退回 `\n`（保守：只影响显示，不影响已有字节）。 */
export function separatorFor(lineEnding: string): string {
  return LINE_SEPARATOR[lineEnding] ?? "\n";
}

export function lineEndingLabel(lineEnding: string): string {
  return LINE_ENDING_LABEL[lineEnding] ?? lineEnding;
}

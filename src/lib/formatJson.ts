/**
 * JSON 格式化（0.34.6 用户反馈「创建一个脚本用来格式化 json」——排查接口数据时
 * 常在笔记里贴一整段压缩 JSON，命令面板「格式化选中的 JSON」一键展开）。
 *
 * 纯函数：parse 失败把原错误信息带回去（输入行显示），成功返回 2 空格缩进的
 * 展开文本。不强行修复（尾逗号/单引号等非标准 JSON 交还给用户手改）。
 */
export function formatJsonText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const value = JSON.parse(raw) as unknown;
    return { ok: true, text: JSON.stringify(value, null, 2) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

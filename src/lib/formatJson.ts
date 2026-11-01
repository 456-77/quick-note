/**
 * JSON 格式化与文本转换（0.34.6「格式化选中的 JSON」+ 0.34.13 用户反馈
 * 「添加快捷键唤起一个文本格式转换面板，可以自动将 json 数据进行格式化；
 * 若原 json 数据被转换成了字符串，能够转换回来」）。
 *
 * 纯函数、不碰 DOM，Node 里直接断言（verify-format-json.mjs）：
 * - formatJsonText：就地展开（命令面板那条旧命令），parse 失败把原错误信息带回；
 * - beautify/minify：字符串化的 JSON（可多层）**自动解包**到最深一层再展开；
 * - toJsonString / fromJsonString：任意文本 ↔ JSON 字符串字面量双向转换。
 *
 * 不强行修复（尾逗号/单引号等非标准 JSON 交还给用户手改）。
 */

export function formatJsonText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const value = JSON.parse(raw) as unknown;
    return { ok: true, text: JSON.stringify(value, null, 2) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 解析失败的中文错误（带位置提示；JSON.parse 原生消息在 Chromium 里较友好，直接拼接）。 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 解包所有字符串化层：输入解析后是 string 就继续解析，直到不是字符串或
 * 上一层解析失败。返回最深一层与解开的层数（0 = 输入本来就不是字符串化 JSON）。
 */
export function unwrapJsonString(text: string, maxLayers = 8): { value: string; layers: number } {
  let current = text;
  let layers = 0;
  for (;;) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return { value: current, layers };
    }
    if (typeof parsed !== "string" || layers >= maxLayers) return { value: current, layers };
    current = parsed;
    layers += 1;
  }
}

/** 格式化（2 空格缩进）。输入是字符串化的 JSON（可多层）时自动解包到最深一层。 */
export function beautifyJson(text: string): string {
  const { value } = unwrapJsonString(text);
  return `${JSON.stringify(parseJson(value), null, 2)}\n`;
}

/** 压缩成单行。字符串化输入同样先解包。 */
export function minifyJson(text: string): string {
  const { value } = unwrapJsonString(text);
  return JSON.stringify(parseJson(value));
}

/** 把任意文本转成一个 JSON 字符串字面量（转义引号/换行；中文不转义）。 */
export function toJsonString(text: string): string {
  return JSON.stringify(text);
}

/**
 * 把 JSON 字符串字面量还原成文本。输入必须是 `"..."` 形式（解析结果是
 * string 才算）；多层字符串化一次全解开。不是字符串字面量时抛中文错误。
 */
export function fromJsonString(text: string): string {
  const { value, layers } = unwrapJsonString(text);
  if (layers === 0) {
    // 要么不是 JSON、要么是别的 JSON 值（对象/数字）——都不是「字符串还原」
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("不是 JSON 字符串字面量（应以引号包裹，如 \"…\"）");
    }
    if (typeof parsed !== "string") {
      throw new Error("内容不是字符串（是对象/数组/数字等），直接用「格式化」即可");
    }
  }
  return value;
}

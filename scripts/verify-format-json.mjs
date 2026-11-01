// 0.34.6「格式化选中的 JSON」（用户反馈「创建一个脚本用来格式化 json」）纯函数断言
import { formatJsonText } from "../src/lib/formatJson.ts";

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
};

// 常规展开：2 空格缩进
const ok = formatJsonText('{"a":1,"b":[2,3]}');
assert(ok.ok && ok.text === '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}', "2 空格缩进展开");

// 数组根也能展开
const arr = formatJsonText("[1,2]");
assert(arr.ok && arr.text === "[\n  1,\n  2\n]", "数组根");

// 标量根合法
const num = formatJsonText("42");
assert(num.ok && num.text === "42", "标量根");

// 非法 JSON：带回原始错误信息
const bad = formatJsonText('{"a":1,}');
assert(!bad.ok && bad.error.length > 0, "非法 JSON 报错");

// 中文不被转义成 \uXXXX
const zh = formatJsonText('{"名称":"智能审核"}');
assert(zh.ok && zh.text.includes("名称") && zh.text.includes("智能审核"), "中文原样保留");

// 非标准 JSON（尾逗号/单引号）不强行修复
const loose = formatJsonText("{a:1}");
assert(!loose.ok, "非标准 JSON 不强行修复");

// ---- 0.34.13 转换面板（beautify/minify 自动解包、文本 ↔ JSON 字符串互转）----
import { beautifyJson, minifyJson, toJsonString, fromJsonString, unwrapJsonString } from "../src/lib/formatJson.ts";

assert(beautifyJson('{"a":1,"b":[2,3]}') === '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n', "beautify 2 空格缩进");
assert(minifyJson('{ "a": 1 }') === '{"a":1}', "minify 单行");
assert(toJsonString('a"b\nc') === '"a\\"b\\nc"', "toJsonString 转义引号与换行");
assert(toJsonString("中文") === '"中文"', "toJsonString 中文不转义");
assert(fromJsonString('"{\\"a\\":1}"') === '{"a":1}', "fromJsonString 单层还原");
const deep = JSON.stringify(JSON.stringify(JSON.stringify({ a: { b: 2 } })));
assert(fromJsonString(deep) === JSON.stringify({ a: { b: 2 } }), "fromJsonString 多层一次解开");
assert(beautifyJson(JSON.stringify(JSON.stringify({ a: 1 }))) === '{\n  "a": 1\n}\n', "beautify 自动解包字符串化 JSON");
assert(unwrapJsonString('{"a":1}').layers === 0, "非字符串化层数 0");
assert(!fromJsonStringSafe('{"a":1}'), "对象输入报错");
assert(!fromJsonStringSafe("垃圾"), "垃圾输入报错");
assert(!beautifySafe("{a:1}"), "非法 JSON 报错");
assert(!beautifySafe('"{\\"a\\":1} {\\"b\\":2}"'), "拼接串解一层后不是合法 JSON 报错");

function fromJsonStringSafe(text) {
  try { fromJsonString(text); return true; } catch { return false; }
}
function beautifySafe(text) {
  try { beautifyJson(text); return true; } catch { return false; }
}

if (failed > 0) {
  console.error(`verify-format-json ✗（${failed} 处断言失败）`);
  process.exit(1);
}
console.log("verify-format-json ✓");

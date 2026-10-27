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

if (failed > 0) {
  console.error(`verify-format-json ✗（${failed} 处断言失败）`);
  process.exit(1);
}
console.log("verify-format-json ✓");

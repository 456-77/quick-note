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

// ---- 0.39.31 多一层转义自动修复（用户反馈：从日志复制的 JSON 带 \" 无法格式化）----
import { parseJsonLoose } from "../src/lib/formatJson.ts";
const escapedObj = '{\\"a\\":1,\\"b\\":\\"x\\"}';
const repaired = parseJsonLoose(escapedObj);
assert(repaired.repaired === true && repaired.value.b === "x", "单层转义 JSON 自动解转义后解析");
assert(beautifyJson(escapedObj) === '{\n  "a": 1,\n  "b": "x"\n}\n', "beautify 吃掉一层转义");
// 双层转义：JSON → 字符串（内层仍是转义 JSON）→ 字符串
const twice = JSON.stringify(JSON.stringify({ a: 1 })).replace(/^"|"$/g, "");
const twiceParsed = parseJsonLoose(twice);
assert(twiceParsed.repaired === true && twiceParsed.value.a === 1, "双层转义逐层修复");
// 合法 JSON 带正常转义时不误判（含 \n、\\ 字符串内容）
const legit = '{"p":"C:\\\\tmp","n":"a\\nb"}';
const legitParsed = parseJsonLoose(legit);
assert(legitParsed.repaired === false && legitParsed.value.p === "C:\\tmp", "合法 JSON 不被改写");

// ---- 0.39.33/0.39.35 Base64 自动识别解码 + 转码 ----
import { decodeBase64Auto, decodeBase64Text, encodeBase64, findBase64InText } from "../src/lib/formatJson.ts";

const b64Url =
  "https://cwgx-ai-gtw-uat.ehailiang.com/hitf/v2p/rest/invoke/SFpFUk86SEZTSURTOmhmaW5zLWlkcy5jaGVjay1yZXN1bHQuY3V4TGlzdA==?docNumber=AR202611250121&sourceSystem=HFINS&docCategory=ACR_INVOICE&lang=th_TH&logicFlag=Y";
const urlHits = findBase64InText(b64Url);
assert(
  urlHits.length === 1 &&
    urlHits[0].decoded === "HZERO:HFSIDS:hfins-ids.check-result.cuxList",
  "URL 路径里的 base64 自动识别并解码",
);
assert(urlHits[0].raw === "SFpFUk86SEZTSURTOmhmaW5zLWlkcy5jaGVjay1yZXN1bHQuY3V4TGlzdA==", "raw 保留原文片段");
assert(decodeBase64Auto("aGVsbG8gd29ybGQ=") === "hello world", "整段 base64 解码");
assert(
  decodeBase64Auto("5L2g5aW977yM5LiW55WM77yB") === "你好，世界！",
  "base64 → UTF-8 中文",
);
assert(decodeBase64Auto("aGVsbG8K") === "hello\n", "保留 base64 内容里的换行");
// URL-safe 变体：😀 的 base64 是 8J+YgA==（含 +），URL-safe 写作 8J-YgA==
assert(decodeBase64Auto("8J-YgA==") === "😀", "URL-safe -_ 也能解");
// 多行粘贴的整段 base64（日志里常见的换行）
assert(decodeBase64Auto("aGVsbG8g\nd29ybGQ=") === "hello world", "多行整段 base64（空白忽略）");
// 误报防线：普通文本/代码/纯字母数字 ID 不解
assert(findBase64InText("这是一段普通的中文文本，没有 base64。").length === 0, "普通中文不误报");
assert(findBase64InText("const answer: number = 42;").length === 0, "普通代码不误报");
assert(findBase64InText("AR202611250121").length === 0, "短字母数字 ID 不误报");
assert(findBase64InText("https://example.com/api/v1/users?page=2").length === 0, "普通 URL 不误报");
assertThrows(() => decodeBase64Auto("没有 base64 的内容"), "识别不到时抛错");

// 转码（0.39.35 快捷键弹窗）：UTF-8 编码 + 与解码往返
assert(encodeBase64("hello world") === "aGVsbG8gd29ybGQ=", "编码：ASCII");
assert(encodeBase64("你好，世界！") === "5L2g5aW977yM5LiW55WM77yB", "编码：中文按 UTF-8");
assert(decodeBase64Auto(encodeBase64("中文😀 mixed\nline")) === "中文😀 mixed\nline", "编码 → 解码往返");
assert(encodeBase64("") === "", "空文本编码为空串");
assert(decodeBase64Text("YQ==") === "a", "显式解码：短 padding 也解");
assert(decodeBase64Text(b64Url) === "HZERO:HFSIDS:hfins-ids.check-result.cuxList", "显式解码：URL 片段");
assertThrows(() => decodeBase64Text("普通中文文本"), "显式解码普通文本抛错");

function assertThrows(fn, msg) {
  try {
    fn();
    assert(false, msg);
  } catch {
    assert(true, msg);
  }
}

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

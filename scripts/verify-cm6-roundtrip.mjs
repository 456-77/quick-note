// 编辑器层（CodeMirror 6）字节精确往返验证。
//
// 分工：
//   · Rust 集成测试保证「磁盘 ↔ 字符串」无损，并且是换行符风格的唯一判定来源；
//   · 本脚本保证「字符串 ↔ 编辑器状态」无损，覆盖完整链路，无需启动 GUI。
//
// 地面真值来自 `cargo run --example dump-detect`，脚本自身不复刻探测逻辑——
// 复刻过的版本曾把 CRLF 误判为 LF，却因为 LF 分隔符下 "\r" 会作为普通字符
// 留在行内而"通过"，属于假阳性。
//
// 用法：node --experimental-strip-types scripts/verify-cm6-roundtrip.mjs <vault> <detect.json>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorState } from "@codemirror/state";
import { separatorFor } from "../src/lib/lineEndings.ts";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const vault = process.argv[2] ?? "test-vault";
const detectPath = process.argv[3] ?? "test-vault.detect.json";

const detections = JSON.parse(readFileSync(detectPath, "utf8"));
let failures = 0;

for (const info of detections) {
  const { path, lineEnding, mixedLineEndings, hasBom } = info;
  const raw = readFileSync(join(vault, path));
  const content = (hasBom ? raw.subarray(BOM.length) : raw).toString("utf8");
  const separator = separatorFor(lineEnding);

  const state = EditorState.create({
    doc: content,
    extensions: [EditorState.lineSeparator.of(separator)],
  });

  const problems = [];

  // 1) 序列化必须字节一致。注意必须用 sliceDoc()：
  //    doc.toString() 固定用 "\n" 拼接，会把 CRLF 文件改写成 LF。
  if (state.sliceDoc() !== content) {
    problems.push("sliceDoc() 往返不一致");
  }

  // 2) 确认 facet 真的生效了，而不是碰巧通过。
  if (state.lineBreak !== separator) {
    problems.push(`lineBreak=${JSON.stringify(state.lineBreak)}，期望 ${JSON.stringify(separator)}`);
  }

  // 3) 行切分必须正确：CRLF 文件若按 "\n" 切，行尾会残留 "\r"，
  //    数据虽然没坏，但编辑器里会显示异常。
  if (lineEnding === "crlf") {
    const stray = [];
    for (let i = 1; i <= state.doc.lines; i += 1) {
      const line = state.doc.line(i);
      if (line.text.endsWith("\r")) stray.push(line.number);
    }
    if (stray.length > 0) {
      problems.push(`CRLF 文件切分错误，第 ${stray.slice(0, 5).join(",")} 行残留 \\r`);
    }
  }

  const tags = [lineEnding, mixedLineEndings ? "mixed" : "", hasBom ? "BOM" : ""]
    .filter(Boolean)
    .join(" ");

  if (problems.length > 0) {
    failures += 1;
    console.log(`✗ ${path}  (${tags})`);
    problems.forEach((p) => console.log(`    ${p}`));
  } else {
    // toString() 的差异是已知陷阱，仅作提示，不算失败。
    const trap = state.doc.toString() === content ? "" : "  [陷阱] doc.toString() 会改写此文件";
    console.log(`✓ ${path}  (${tags})${trap}`);
  }
}

console.log(`\n检查 ${detections.length} 个文件，失败 ${failures} 个`);
process.exit(failures === 0 ? 0 : 1);

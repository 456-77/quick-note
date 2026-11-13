// 生成 src-tauri/tests/fixtures/big-sample.xlsx（表格解析基准用大文件，
// 不进仓库；0.39.9）。用法：node scripts/make-xlsx-fixture.mjs
// 之后跑：cd src-tauri && cargo test bench_big -- --nocapture

import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const wb = XLSX.utils.book_new();
const rows = [
  ["新单号", "单据类型", "当前状态", "处理说明", "旧系统单据", "新系统单据", "渠道", "备注"],
];
for (let i = 0; i < 5500; i += 1) {
  rows.push([
    `B323F5261118${4100 + i}`,
    "通用费用报销单",
    i % 7 ? "FAILED" : "新建",
    `存行被拒: {"failed":true,"code":"hfins.error.xxx","message":"很长的错误信息内容在这里面呢很长的错误信息内容在这里面呢${i}"}`,
    `B2888260900${400 + i}`,
    `B28882611032${200 + i}`,
    `渠道${i % 3}`,
    `备注内容${i}`,
  ]);
}
const ws = XLSX.utils.aoa_to_sheet(rows);
ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
XLSX.utils.book_append_sheet(wb, ws, "完全匹配");

const out = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/tests/fixtures/big-sample.xlsx");
writeFileSync(out, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
console.log("written:", out);

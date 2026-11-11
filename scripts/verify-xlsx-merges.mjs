// Excel 合并单元格裁剪的纯函数断言（0.39.5 用户反馈「表头合并了多个单元格，
// 预览只占一个单元格」）。
//
// 用法：node --experimental-strip-types scripts/verify-xlsx-merges.mjs

import { clampMerges } from "../src/lib/xlsxMerges.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

// 解析窗口：行 0..4999、列 0..79（0 基，含端点）
const S = 0, ER = 4999, SC = 0, EC = 79;

// 普通跨列表头：F1:M1 → (0,5,1,8)
check(
  JSON.stringify(clampMerges([{ s: { r: 0, c: 5 }, e: { r: 0, c: 12 } }], S, ER, SC, EC)) ===
    JSON.stringify([{ r: 0, c: 5, rs: 1, cs: 8 }]),
  "跨列表头 F1:M1 → colSpan 8",
);

// 纵向合并：A2:A5 → (1,0,4,1)
check(
  JSON.stringify(clampMerges([{ s: { r: 1, c: 0 }, e: { r: 4, c: 0 } }], S, ER, SC, EC)) ===
    JSON.stringify([{ r: 1, c: 0, rs: 4, cs: 1 }]),
  "纵向合并 A2:A5 → rowSpan 4",
);

// 窗口外丢弃
check(
  clampMerges([{ s: { r: 6000, c: 0 }, e: { r: 6010, c: 3 } }], S, ER, SC, EC).length === 0,
  "完全在行截断线之后的合并丢弃",
);
check(
  clampMerges([{ s: { r: 0, c: 90 }, e: { r: 1, c: 95 } }], S, ER, SC, EC).length === 0,
  "完全在列截断线之后的合并丢弃",
);

// 跨截断线收进窗口
check(
  JSON.stringify(clampMerges([{ s: { r: 4990, c: 78 }, e: { r: 6000, c: 90 } }], S, ER, SC, EC)) ===
    JSON.stringify([{ r: 4990, c: 78, rs: 10, cs: 2 }]),
  "跨行/列截断线的合并收进窗口",
);

// 单格区间（rs=cs=1）没有渲染意义
check(
  clampMerges([{ s: { r: 2, c: 3 }, e: { r: 2, c: 3 } }], S, ER, SC, EC).length === 0,
  "单格合并丢弃",
);

// 起点/终点顺序不假设（SheetJS 语义 s<=e，但防御性容忍反写）
check(
  clampMerges([{ s: { r: 5, c: 9 }, e: { r: 4, c: 8 } }], S, ER, SC, EC).length === 0,
  "反写区间不炸、无交集时丢弃",
);

// undefined / 空数组
check(clampMerges(undefined, S, ER, SC, EC).length === 0, "undefined 输入返回空");
check(clampMerges([], S, ER, SC, EC).length === 0, "空数组返回空");

// limit 截断
const many = Array.from({ length: 50 }, (_, i) => ({
  s: { r: i * 2, c: 0 },
  e: { r: i * 2 + 1, c: 1 },
}));
check(clampMerges(many, S, ER, SC, EC).length === 50, "普通数量全保留");
check(clampMerges(many, S, ER, SC, EC, 10).length === 10, "超出 limit 截断");

// 窗口起点非 0（截断后的窗口从中间开始——口径与解析循环一致：相对坐标）
check(
  JSON.stringify(clampMerges([{ s: { r: 10, c: 3 }, e: { r: 12, c: 5 } }], 10, 4999, 3, 79)) ===
    JSON.stringify([{ r: 0, c: 0, rs: 3, cs: 3 }]),
  "窗口起点非 0：坐标转为相对",
);

console.log(failures === 0 ? "\n合并单元格裁剪验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

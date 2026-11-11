// Excel 合并单元格裁剪的纯函数断言（0.39.5 用户反馈「表头合并了多个单元格，
// 预览只占一个单元格」）。
//
// 用法：node --experimental-strip-types scripts/verify-xlsx-merges.mjs

import { clampMerges } from "../src/lib/xlsxMerges.ts";
import { detectHeaderRow } from "../src/lib/xlsxHeader.ts";

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

// ---------------------------------------------------------------- 表头行识别
// 0.39.7 用户反馈「筛选只能根据第一行内容筛，应该根据紧挨数据的那一行」——
// 「合并大标题行 + 字段名行」两行头结构。保守启发式：仅当第 1 行非空格数
// 不到前 4 行最满行的一半时才下移，普通表行为不变。
console.log("\n表头行识别（detectHeaderRow）\n");
const banner = ["完全匹配（共计245张）", "", "", "", "", "", "部分匹配（157 张单 / 205 个节点）", "", ""];
const fields = ["单据类型", "单据类型名称", "旧系统单据编号", "新系统单据编号", "", "单据类型", "单据类型名称", "旧单号", "新单号"];
const dataRow = ["REQ002", "业务招待事前申请", "S2186260800107", "S2186261100450", "", "REQ002", "业务招待事前申请", "S1100260800064", "S1100261103373"];

check(detectHeaderRow([banner, fields, dataRow]) === 1, "合并大标题行 + 字段名行 → 表头行=1（用户实测文件）");
check(
  detectHeaderRow([["报表标题", "", "", ""], ["A", "B", "C", "D"], [1, 2, 3, 4], [5, 6, 7, 8]]) === 1,
  "整行合并横幅 + 表头 → 表头行=1",
);
check(
  detectHeaderRow([["标题一", "", "", ""], ["标题二", "", "", ""], ["A", "B", "C", "D"], [1, 2, 3, 4]]) === 2,
  "两行横幅 → 表头行=2",
);
check(
  detectHeaderRow([["A", "B", "C", "D"], [1, 2, 3, 4], [5, 6, 7, 8]]) === 0,
  "普通表（第 1 行即满表头）→ 保持 0（平局不抢）",
);
check(
  detectHeaderRow([["A", "B"], [1, 2, 3, 4], [5, 6, 7, 8]]) === 0,
  "表头稀疏但未过半 → 不误判（数据行不抢当表头）",
);
check(
  detectHeaderRow([["标题"], [], ["A", "B", "C"], [1, 2, 3]]) === 2,
  "横幅与表头之间隔空行 → 跳到字段名行",
);
check(detectHeaderRow([["唯一一行"]]) === 0, "单行表 → 0");
check(detectHeaderRow([]) === 0, "空表 → 0");


console.log(failures === 0 ? "\n合并单元格裁剪验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
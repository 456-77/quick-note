// 文件名排序纯函数断言（0.39.8 用户反馈「v2 后缀的文件怎么排在没有后缀的上面」：
// 字典序里 '-'(0x2D) < '.'(0x2E)，变体文件压过原文件）。
import assert from "node:assert/strict";
import { compareFileNames, stemOf } from "../src/lib/fileNameSort.ts";

// 用户实测文件形状：-v2 变体排在原文件**之后**（旧规则里排在前面）
assert.ok(
  compareFileNames(
    "RPT027-通用费用报销-导入结果-20261111.xlsx",
    "RPT027-通用费用报销-导入结果-20261111-v2.xlsx",
  ) < 0,
  "原文件应排在 -v2 变体之前",
);

// 多级版本数值感知：v2 < v10（旧字典序里 v10 < v2）
assert.ok(compareFileNames("报告-v2.xlsx", "报告-v10.xlsx") < 0, "v2 应排在 v10 之前");

// 括号副本、普通数字段同样数值感知：2 < 10
assert.ok(compareFileNames("报告 (1).xlsx", "报告.xlsx") > 0, "副本应排在原文件之后");
assert.ok(compareFileNames("结果2.md", "结果10.md") < 0, "数字段应按数值比");

// 主名相同时按全名比：扩展名次序与旧规则一致（md < xlsx），同名稳定为 0
assert.ok(compareFileNames("abc.md", "abc.xlsx") < 0);
assert.ok(compareFileNames("abc.xlsx", "abc.md") > 0);
assert.equal(compareFileNames("同名.md", "同名.md"), 0);

// 日期前缀日记的同年月日兜底走同一比较：笔记在前，-v2 在后
assert.ok(compareFileNames("2026-11-12 笔记.md", "2026-11-12 笔记-v2.md") < 0);

// stemOf 边界：无扩展名 / 开头 dot（.gitignore 不是扩展名）/ 多段扩展名
assert.equal(stemOf("README"), "README");
assert.equal(stemOf(".gitignore"), ".gitignore");
assert.equal(stemOf("数据.final.md"), "数据.final");

console.log("文件名排序断言全部通过 ✓");

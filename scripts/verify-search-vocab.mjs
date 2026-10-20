// 0.23 新功能的纯逻辑：字段名变体（全局/文件内搜索的下划线↔驼峰联动）与
// 单词本（解析/新增/掌握/删除的内容变换）。
//
// 字段变体是搜索正确性的关键路径：搜 userName 必须能命中 user_name，反之亦然；
// 漏一个方向用户就会得出"搜不到"的结论。单词本是纯内容变换，解析错一行就是
// 丢一条记录。HTML→Markdown 转换依赖 DOMParser，由 GUI 批测覆盖（gui-023）。
//
// 用法：node --experimental-strip-types scripts/verify-search-vocab.mjs

import { fieldPattern, fieldVariants, hasFieldShape } from "../src/lib/searchVariants.ts";
import {
  VOCAB_FILENAME,
  addVocabEntry,
  initialVocabulary,
  parseVocabulary,
  removeVocabEntry,
  setVocabLearned,
  updateVocabEntry,
} from "../src/lib/vocabulary.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------- 字段变体

check(
  JSON.stringify(fieldVariants("userName")) === JSON.stringify(["userName", "user_name"]),
  "驼峰 → 补 snake 变体",
  JSON.stringify(fieldVariants("userName")),
);
check(
  JSON.stringify(fieldVariants("UserName")) === JSON.stringify(["UserName", "user_name"]),
  "帕斯卡 → 补 snake 变体",
  JSON.stringify(fieldVariants("UserName")),
);
check(
  JSON.stringify(fieldVariants("user_name")) === JSON.stringify(["user_name", "username"]),
  "snake → 补无分隔变体",
  JSON.stringify(fieldVariants("user_name")),
);
check(
  fieldVariants("USER_NAME").includes("USERNAME"),
  "全大写 snake → 补全大写无分隔",
  JSON.stringify(fieldVariants("USER_NAME")),
);
check(
  JSON.stringify(fieldVariants("username")) === JSON.stringify(["username"]),
  "纯小写没有第二种形态",
);
check(
  fieldVariants("order_item_2").includes("orderitem2"),
  "含数字的 snake 也能去分隔",
  JSON.stringify(fieldVariants("order_item_2")),
);

// 下划线联动正则
check(fieldPattern("userName") === "user[_]?name", "驼峰查询 → 段间 [_]?", fieldPattern("userName") ?? "null");
check(fieldPattern("user_name") === "user[_]?name", "snake 查询 → 段间 [_]?", fieldPattern("user_name") ?? "null");
check(fieldPattern("__init__") === "__init__", "连续下划线保持字面", fieldPattern("__init__") ?? "null");
check(fieldPattern("hello") === null, "无字段形态回落 null", fieldPattern("hello") ?? "null");
check(fieldPattern("") === null, "空查询回落 null");
// 正则元字符转义
check(fieldPattern("a.b_c") === "a\\.b[_]?c", "段内元字符转义", fieldPattern("a.b_c") ?? "null");
check(hasFieldShape("userName"), "驼峰判定为字段形态");
check(hasFieldShape("user_name"), "snake 判定为字段形态");
check(!hasFieldShape("username"), "纯小写不是字段形态");

// ---------------------------------------------------------------- 单词本

// 初始内容与解析
const fresh = initialVocabulary();
let parsed = parseVocabulary(fresh);
check(parsed.length === 0, "初始内容解析为空表", JSON.stringify(parsed));
check(fresh.includes("## 待学习") && fresh.includes("## 已掌握"), "初始内容含两节");

// 新增
let doc = addVocabEntry(fresh, "resilient", "2026-10-15 · 测试笔记").content;
parsed = parseVocabulary(doc);
check(parsed.length === 1 && parsed[0].word === "resilient", "新增进待学习", JSON.stringify(parsed));
check(parsed[0].learned === false, "新增条目默认未掌握");
check(parsed[0].meta.includes("2026-10-15"), "元信息带日期");
check(addVocabEntry(doc, "resilient", "x").added === false, "重复词不重录");
check(addVocabEntry(doc, "Resilient", "x").added === false, "大小写不敏感去重");
doc = addVocabEntry(doc, "PR", "").content;
check(parseVocabulary(doc).some((entry) => entry.word === "PR" && entry.meta === ""), "无元信息的词也能加");

// 掌握 / 撤销
let moved = setVocabLearned(doc, "resilient", true).content;
parsed = parseVocabulary(moved);
check(
  parsed.find((entry) => entry.word === "resilient")?.learned === true,
  "移入已掌握",
  moved,
);
check(parseVocabulary(moved).filter((entry) => !entry.learned).length === 1, "待学习只剩另一个词");
const undo = setVocabLearned(moved, "resilient", false).content;
check(parseVocabulary(undo).find((entry) => entry.word === "resilient")?.learned === false, "移回待学习");
check(setVocabLearned(moved, "resilient", true).changed === false, "状态没变不产生写入");
check(setVocabLearned(moved, "ghost", true).changed === false, "词不存在不产生写入");

// 删除
let removed = removeVocabEntry(undo, "PR").content;
check(parseVocabulary(removed).length === 1, "删除待学习条目", removed);
removed = removeVocabEntry(moved, "resilient").content;
check(parseVocabulary(removed).length === 1, "删除已掌握条目", removed);
const emptied = removeVocabEntry(removed, "PR").content;
check(parseVocabulary(emptied).length === 0, "删空后解析为空", emptied);
check(removeVocabEntry(removed, "ghost").changed === false, "删除不存在的词无变化");

// 手编文件的宽容解析：小节外的条目归待学习、空行/标题行跳过
const handWritten = [
  "# 单词本",
  "",
  "- orphan — 无小节的词",
  "",
  "## 已掌握",
  "",
  "- done — 早就会了",
  "",
  "## 待学习",
  "",
  "- pending",
].join("\n");
parsed = parseVocabulary(handWritten);
check(parsed.find((entry) => entry.word === "orphan")?.learned === false, "小节外条目归待学习");
check(parsed.find((entry) => entry.word === "done")?.learned === true, "已掌握节解析");
check(parsed.find((entry) => entry.word === "pending")?.learned === false, "待学习节解析");
check(parsed.length === 3, "解析条目数", JSON.stringify(parsed));

// 重复词后写者胜
const dup = "# 单词本\n\n## 待学习\n\n- Word — 旧\n- word — 新\n";
parsed = parseVocabulary(dup);
check(parsed.length === 1 && parsed[0].meta === "新", "同词重录后写者胜", JSON.stringify(parsed));

// CRLF 内容按行正常处理
const crlf = initialVocabulary().replace(/\n/g, "\r\n");
const crlfAdded = addVocabEntry(crlf, "alpha", "m").content;
check(parseVocabulary(crlfAdded).some((entry) => entry.word === "alpha"), "CRLF 文件也能新增");

// v2 行格式：`- word | 释义 | 备注 — meta`（0.24 快速查词）
const v2 = addVocabEntry(fresh, "hscs_hsdt", "2026-10-16 · 数据库表清单", "数据传输任务接口表", "测试库").content;
parsed = parseVocabulary(v2);
check(
  parsed[0].word === "hscs_hsdt" && parsed[0].meaning === "数据传输任务接口表" && parsed[0].note === "测试库",
  "v2 行解析出释义与备注",
  JSON.stringify(parsed[0]),
);
check(v2.includes("- hscs_hsdt | 数据传输任务接口表 | 测试库 — 2026-10-16 · 数据库表清单"), "v2 行序列化格式", v2);
const v2NoNote = parseVocabulary(addVocabEntry(fresh, "alpha", "m", "只带释义").content);
check(v2NoNote[0].meaning === "只带释义" && v2NoNote[0].note === "", "只带释义时备注截断", v2NoNote[0] ? "- alpha | 只带释义 — m" : "");
check(
  !addVocabEntry(fresh, "alpha", "m").content.includes("|"),
  "空释义备注不产生竖线（与 v1 行一致）",
);
const v1Mixed = "# 单词本\n\n## 待学习\n\n- legacy — 2026-10-01 · 旧\n- hello\n";
parsed = parseVocabulary(v1Mixed);
check(parsed[0].meaning === "" && parsed[0].note === "" && parsed[0].meta === "2026-10-01 · 旧", "v1 裸行兼容", JSON.stringify(parsed));
check(parsed[1].meaning === "" && parsed[1].note === "", "v1 无 meta 行兼容");

// v2 编辑：更新释义/备注（原行就地重写，meta 保留）
const edited = updateVocabEntry(v2, "HSCS_HSDT", { meaning: "数据传输任务接口表（更新）", note: "" }).content;
parsed = parseVocabulary(edited);
check(
  parsed[0].meaning === "数据传输任务接口表（更新）" && parsed[0].note === "",
  "编辑后释义备注生效（大小写不敏感定位）",
  edited,
);
check(parsed[0].meta === "2026-10-16 · 数据库表清单", "编辑保留 meta", JSON.stringify(parsed[0]));
check(updateVocabEntry(v2, "hscs_hsdt", { meaning: "数据传输任务接口表", note: "测试库" }).changed === false, "内容没变不产生写入");
check(updateVocabEntry(fresh, "ghost", { meaning: "x" }).changed === false, "编辑不存在的词无变化");
const editedLearned = updateVocabEntry(v2, "hscs_hsdt", { note: "新备注" }).content;
check(parseVocabulary(editedLearned)[0].note === "新备注" && parseVocabulary(editedLearned)[0].meaning === "数据传输任务接口表", "只改备注时释义保留");

// v2 条目在状态切换/删除时保留释义备注
const movedV2 = setVocabLearned(v2, "hscs_hsdt", true).content;
const movedParsed = parseVocabulary(movedV2);
check(
  movedParsed[0].learned === true && movedParsed[0].meaning === "数据传输任务接口表" && movedParsed[0].note === "测试库",
  "移入已掌握时释义备注跟着走",
  movedV2,
);
const removedV2 = removeVocabEntry(movedV2, "hscs_hsdt").content;
check(parseVocabulary(removedV2).length === 0, "v2 条目可删除");

// v3 行格式（0.25 释义自动获取）：`- word | 释义 | 备注 | 音标 — meta`，
// v2/v1 行完全兼容（缺省字段按需截断）
const v3 = addVocabEntry(fresh, "scenario", "2026-10-17 · 手动添加", "n. 设想，方案", "", "/sɪˈnɑːriəʊ/").content;
parsed = parseVocabulary(v3);
check(
  parsed[0].meaning === "n. 设想，方案" && parsed[0].note === "" && parsed[0].phonetic === "/sɪˈnɑːriəʊ/",
  "v3 行解析出释义与音标（备注为空截断）",
  JSON.stringify(parsed[0]),
);
check(
  v3.includes("- scenario | n. 设想，方案 |  | /sɪˈnɑːriəʊ/ — 2026-10-17 · 手动添加"),
  "v3 行序列化格式（空备注中置空段）",
  v3,
);
const v3Full = parseVocabulary(
  addVocabEntry(fresh, "alpha", "m", "释义", "备注", "/ˈælfə/").content,
);
check(v3Full[0].phonetic === "/ˈælfə/", "v3 四字段齐全解析", JSON.stringify(v3Full[0]));
const v2Still = parseVocabulary(v2);
check(v2Still[0].phonetic === "", "v2 行解析音标为空串（向后兼容）", JSON.stringify(v2Still[0]));
const v3Edited = updateVocabEntry(v3, "scenario", { phonetic: "/səˈnɑːrioʊ/" }).content;
check(
  parseVocabulary(v3Edited)[0].phonetic === "/səˈnɑːrioʊ/" && parseVocabulary(v3Edited)[0].meaning === "n. 设想，方案",
  "编辑音标保留释义",
  v3Edited,
);
const v3Moved = setVocabLearned(v3, "scenario", true).content;
check(
  parseVocabulary(v3Moved).find((entry) => entry.word === "scenario")?.phonetic === "/sɪˈnɑːriəʊ/",
  "状态切换时音标跟着走",
  v3Moved,
);

// 文件名约定
check(VOCAB_FILENAME === "单词本.md", "单词本落在仓库根的 单词本.md");

// 0.27：备注留空但带音标的行要能往返（此前按 " | " 整串拆，音标被并进备注）
{
  const roundTripLine = addVocabEntry(
    "# 单词本\n\n## 待学习\n",
    "banana",
    "2026-10-15 · 批测",
    "香蕉",
    "",
    "/bəˈnɑːnə/",
  ).content;
  const parsed = parseVocabulary(roundTripLine).find((entry) => entry.word === "banana");
  check(
    !!parsed && parsed.meaning === "香蕉" && parsed.note === "" && parsed.phonetic === "/bəˈnɑːnə/",
    "备注留空 + 音标：写入的行解析回同样的字段（往返不丢音标）",
    JSON.stringify(parsed),
  );
  // 手写紧凑格式（无空格竖线）同样解析
  const compact = parseVocabulary("# 单词本\n\n## 待学习\n\n- kiwi|猕猴桃|备注|/ˈkiːwi/ — 2026-10-19 · 手写\n");
  const kiwi = compact.find((entry) => entry.word === "kiwi");
  check(
    !!kiwi && kiwi.meaning === "猕猴桃" && kiwi.note === "备注" && kiwi.phonetic === "/ˈkiːwi/",
    "无空格竖线的手写行同样解析",
    JSON.stringify(kiwi),
  );
}

// ---------------------------------------------------------------- 汇总

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过 ✓");

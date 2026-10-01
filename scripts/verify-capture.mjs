// 速记行格式的纯逻辑（无需 DOM、无需 Tauri）。
//
// 覆盖：行组装（来源/标签/归档标记）、解析（新格式 + 旧格式 + 手写行回退）、
// 行级归档/加标签编辑（保留 CRLF）、归档行落到目标笔记的形状、换行符探测。
// 速记是一行一条的格式，解析错一行就是丢一条速记——这里的每个分支都要钉死。
//
// 用法：node --experimental-strip-types scripts/verify-capture.mjs

import {
  ARCHIVE_MARK,
  archivedLineForTarget,
  buildCaptureLine,
  detectEol,
  lineAddTagEdit,
  lineArchiveEdit,
  parseCaptureEntries,
} from "../src/lib/capture.ts";
import { parseCaptureEntries as reparsed } from "../src/lib/capture.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------- 组装

check(
  buildCaptureLine({ timestamp: "2026-09-30 14:32", text: "明天要跟进" }) ===
    "- 2026-09-30 14:32 明天要跟进",
  "最小行：时间戳 + 正文",
);
check(
  buildCaptureLine({ timestamp: "2026-09-30 14:32", source: "运维库", text: "内容" }) ===
    "- 2026-09-30 14:32 [运维库] 内容",
  "来源用方括号跟在时间戳后",
);
check(
  buildCaptureLine({ timestamp: "2026-09-30 14:32", tags: ["想法", "项目A"], text: "内容" }) ===
    "- 2026-09-30 14:32 #想法 #项目A 内容",
  "标签跟在时间戳后、正文前",
);
check(
  buildCaptureLine({
    timestamp: "2026-09-30 14:32",
    source: "运维库",
    tags: ["想法"],
    text: "内容",
    archived: true,
  }) === "- 2026-09-30 14:32 [运维库] #想法 内容 ^archived",
  "归档标记在行尾",
);

// ---------------------------------------------------------------- 解析

const file = "Inbox.md";
const full = parseCaptureEntries(
  file,
  [
    "- 2026-09-30 14:32 [运维库/部署.md] #想法 #项目A 明天要跟进 xxx",
    "- 2026-09-29 09:00 旧格式速记（没有来源和标签）",
    "- 2026-09-28 08:30 [test-vault] #待办 记一下 ^archived",
    "普通正文不是速记",
    "- 手写行没有时间戳",
  ].join("\n"),
);
check(full.length === 4, "4 个列表行都算条目，普通正文不算（手写行回退）", String(full.length));
const [e1, e2, e3, e4] = full;
check(e1.timestamp === "2026-09-30 14:32" && e1.source === "运维库/部署.md", "新格式：时间戳+来源");
check(
  e1.tags.join(",") === "想法,项目A" && e1.text === "明天要跟进 xxx" && !e1.archived,
  "新格式：标签+正文+未归档",
  JSON.stringify(e1),
);
check(e2.source === null && e2.tags.length === 0 && e2.text.includes("旧格式"), "旧格式回退不丢内容");
check(e3.archived && e3.tags.includes("待办"), "归档标记与标签同存");
check(e4.timestamp === null && e4.text === "手写行没有时间戳", "无时间戳行归入未标注");
check(full.every((entry) => entry.file === file), "条目带所在文件");

// 正文里的行内标签也聚合（去重）
const inline = parseCaptureEntries(file, "- 2026-09-30 10:00 想法 #想法 #项目A 记录");
check(
  inline[0].tags.join(",") === "想法,项目A",
  "前导标签 + 行内标签去重合并",
  JSON.stringify(inline[0].tags),
);

// ---------------------------------------------------------------- 行级编辑

const crlfLine = "- 2026-09-30 14:32 内容\r";
check(lineArchiveEdit(crlfLine, true) === `${crlfLine.slice(0, -1)} ${ARCHIVE_MARK}\r`, "归档保留行尾 CRLF");
check(lineArchiveEdit(crlfLine, false) === null, "未归档行撤归档 = 无变化（null）");
const marked = "- 2026-09-30 14:32 内容 ^archived\r";
check(lineArchiveEdit(marked, false) === "- 2026-09-30 14:32 内容\r", "撤销归档剥掉标记");
check(lineArchiveEdit(marked, true) === null, "已归档行再归档 = 无变化");

check(
  lineAddTagEdit("- 2026-09-30 14:32 内容", "想法") === "- 2026-09-30 14:32 内容 #想法",
  "加标签追加到行尾",
);
check(lineAddTagEdit("- 2026-09-30 14:32 内容 #想法", "想法") === null, "已有同名标签 = 无变化");
check(
  lineAddTagEdit("- 2026-09-30 14:32 内容 ^archived", "想法") ===
    "- 2026-09-30 14:32 内容 #想法 ^archived",
  "加标签插在归档标记之前",
);
check(
  lineAddTagEdit("- 2026-09-30 14:32 内容\r", "想法") === "- 2026-09-30 14:32 内容 #想法\r",
  "加标签保留 CRLF",
);

// ---------------------------------------------------------------- 目标行与 EOL

const entry = parseCaptureEntries(file, "- 2026-09-30 14:32 [运维库] #想法 内容 ^archived\n")[0];
check(
  archivedLineForTarget(entry) === "- 2026-09-30 14:32 [运维库] #想法 内容",
  "落进目标笔记的行剥掉归档标记",
);
check(detectEol("a\r\nb") === "\r\n" && detectEol("a\nb") === "\n", "换行符探测");

// ---------------------------------------------------------------- 往返

const built = buildCaptureLine({
  timestamp: "2026-09-30 15:00",
  source: "仓库A/笔记.md",
  tags: ["x"],
  text: "往返",
});
const round = reparsed(file, `${built}\n`)[0];
check(
  round.timestamp === "2026-09-30 15:00" &&
    round.source === "仓库A/笔记.md" &&
    round.tags.join(",") === "x" &&
    round.text === "往返" &&
    !round.archived,
  "组装 → 解析往返一致",
  JSON.stringify(round),
);

console.log(failures === 0 ? "\n速记行格式验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

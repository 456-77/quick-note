// 速记行格式的纯逻辑（无需 DOM、无需 Tauri）。
//
// 覆盖：行组装（来源/标签/归档标记）、解析（新格式 + 旧格式 + 手写行回退）、
// 行级归档/加标签编辑（保留 CRLF）、归档行落到目标笔记的形状、换行符探测。
// 速记是一行一条的格式，解析错一行就是丢一条速记——这里的每个分支都要钉死。
//
// 用法：node --experimental-strip-types scripts/verify-capture.mjs

import {
  ARCHIVE_MARK,
  archivedLinesForTarget,
  buildCaptureLines,
  detectEol,
  lineAddTagEdit,
  lineArchiveEdit,
  lineTextEditLines,
  lineTextEditText,
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
  buildCaptureLines({ timestamp: "2026-09-30 14:32", text: "明天要跟进" }).join("\n") ===
    "- 2026-09-30 14:32 明天要跟进",
  "最小行：时间戳 + 正文",
);
check(
  buildCaptureLines({ timestamp: "2026-09-30 14:32", source: "运维库", text: "内容" }).join("\n") ===
    "- 2026-09-30 14:32 [运维库] 内容",
  "来源用方括号跟在时间戳后",
);
check(
  buildCaptureLines({ timestamp: "2026-09-30 14:32", tags: ["想法", "项目A"], text: "内容" }).join(
    "\n",
  ) === "- 2026-09-30 14:32 #想法 #项目A 内容",
  "标签跟在时间戳后、正文前",
);
check(
  buildCaptureLines({
    timestamp: "2026-09-30 14:32",
    source: "运维库",
    tags: ["想法"],
    text: "内容",
    archived: true,
  }).join("\n") === "- 2026-09-30 14:32 [运维库] #想法 内容 ^archived",
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

// 正文替换：保留前缀与归档标记
check(
  lineTextEditText("- 2026-09-30 14:32 [仓库] #想法 旧正文 ^archived", "旧正文", "新正文") ===
    "- 2026-09-30 14:32 [仓库] #想法 新正文 ^archived",
  "改正文保留时间戳/来源/标签/归档标记",
);
check(
  lineTextEditText("- 2026-09-30 14:32 内容\r", "内容", "新内容") === "- 2026-09-30 14:32 新内容\r",
  "改正文保留 CRLF",
);
check(lineTextEditText("- 2026-09-30 14:32 内容", "不存在", "x") === null, "找不到正文返回 null");
check(lineTextEditText("- 2026-09-30 14:32 内容", "内容", "内容") === null, "相同正文返回 null");
check(
  lineTextEditText("- 2026-09-30 14:32 #想法 想法", "想法", "新") === "- 2026-09-30 14:32 #想法 新",
  "标签撞名时替换最后一次出现（正文在行尾）",
);

// ---------------------------------------------------------------- 目标行与 EOL

const entry = parseCaptureEntries(file, "- 2026-09-30 14:32 [运维库] #想法 内容 ^archived\n")[0];
check(
  archivedLinesForTarget(entry).join("\n") === "- 2026-09-30 14:32 [运维库] #想法 内容",
  "落进目标笔记的行剥掉归档标记",
);
check(detectEol("a\r\nb") === "\r\n" && detectEol("a\nb") === "\n", "换行符探测");

// ---------------------------------------------------------------- 多行正文

const multiline = parseCaptureEntries(
  file,
  [
    "- 2026-10-02 09:00 [仓库] #想法 第一行",
    "  第二行缩进续行",
    "",
    "  空行后的第三行（松散续行）",
    "- 2026-10-02 09:01 下一条",
  ].join("\n"),
);
check(multiline.length === 2, "多行条目与下一条互不吞并", String(multiline.length));
check(
  multiline[0].text === "第一行\n第二行缩进续行\n\n空行后的第三行（松散续行）" && multiline[0].span === 4,
  "缩进续行并入正文（span 记录占用行数）",
  JSON.stringify(multiline[0]),
);
check(multiline[1].text === "下一条" && multiline[1].span === 1, "后续条目正常解析");

// 空行后跟非缩进行：续行停止且空行不被吞掉
const lazy = parseCaptureEntries(file, "- 2026-10-02 09:00 第一行\n\n普通正文");
check(lazy.length === 1 && lazy[0].text === "第一行" && lazy[0].span === 1, "空行+非缩进 = 续行结束");

// 多行编辑：头行锚点替换 + 旧续行整段换新
const edited = lineTextEditLines(
  "- 2026-10-02 09:00 [仓库] #想法 第一行",
  3,
  "第一行\n第二行",
  "改头行\n新续行A\n新续行B",
);
check(
  edited !== null &&
    edited.join("\n") === "- 2026-10-02 09:00 [仓库] #想法 改头行\n  新续行A\n  新续行B",
  "多行编辑替换头行与续行（保留前缀，续行缩进）",
  JSON.stringify(edited),
);
const editedRound = reparsed(file, edited.join("\n"))[0];
check(
  editedRound.text === "改头行\n新续行A\n新续行B" && editedRound.span === 3,
  "多行编辑 → 解析往返一致",
  JSON.stringify(editedRound),
);
const reSingle = lineTextEditLines("- 2026-10-02 09:00 内容", 1, "内容", "改一行");
check(reSingle?.join("\n") === "- 2026-10-02 09:00 改一行", "单行编辑退化为整行替换");
const reEmpty = lineTextEditLines("- 2026-10-02 09:00 #标签 ^archived", 1, "", "补上正文");
check(
  reEmpty?.join("\n") === "- 2026-10-02 09:00 #标签 补上正文 ^archived",
  "空正文条目：正文插到归档标记之前",
  JSON.stringify(reEmpty),
);
check(lineTextEditLines("- 2026-10-02 09:00 内容", 1, "内容", "内容") === null, "相同正文 = 无变化");
check(lineTextEditLines("- 2026-10-02 09:00 内容", 1, "不存在", "x") === null, "锚不到 = 不动");

// 多行条目归档到目标笔记：续行跟着走
const multiEntry = parseCaptureEntries(
  file,
  "- 2026-10-02 09:00 [仓库] #想法 第一行 ^archived\n  第二行\n",
)[0];
check(
  archivedLinesForTarget(multiEntry).join("\n") === "- 2026-10-02 09:00 [仓库] #想法 第一行\n  第二行",
  "多行归档：续行随正文进目标笔记",
  JSON.stringify(archivedLinesForTarget(multiEntry)),
);

// ---------------------------------------------------------------- 往返

const built = buildCaptureLines({
  timestamp: "2026-09-30 15:00",
  source: "仓库A/笔记.md",
  tags: ["x"],
  text: "往返",
}).join("\n");
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

// 多行组装 → 解析往返（含空行段落）
const builtMulti = buildCaptureLines({
  timestamp: "2026-09-30 15:01",
  text: "一段\n\n二段\n三段",
}).join("\n");
const roundMulti = reparsed(file, `${builtMulti}\n`)[0];
check(
  roundMulti.text === "一段\n\n二段\n三段" && roundMulti.span === 4,
  "多行组装 → 解析往返一致",
  JSON.stringify({ text: roundMulti.text, span: roundMulti.span }),
);

console.log(failures === 0 ? "\n速记行格式验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

// 0.31 新增的纯逻辑：DDL 收录（解析/合并/语句边界）、阅读位置（LRU 持久化）、
// 表格单元格高亮切分。逐条钉住边界：
//   - COMMENT 'xx;yy' 里的分号不能截断语句
//   - -- 行注释里的分号同理
//   - 同名表收录替换旧段、新表追加、用户说明文字保留
//   - 阅读位置顶部不记、LRU 淘汰、按仓库隔离
//
// 用法：node --experimental-strip-types scripts/verify-ddl-progress.mjs

import {
  endOfStatement,
  extractTableNames,
  mergeDdlIntoNote,
  parseDdlTables,
} from "../src/lib/ddl.ts";
import { splitHighlight } from "../src/lib/inlineSyntax.ts";
import {
  deleteProgress,
  loadProgress,
  saveProgress,
} from "../src/lib/readProgress.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------- 语句边界

check(endOfStatement("create table a (x int); select 1") === 22, "分号在字段表后", String(endOfStatement("create table a (x int); select 1")));
check(endOfStatement("comment '含;分号' ; tail") === 15, "字符串里的分号被跳过", String(endOfStatement("comment '含;分号' ; tail")));
check(endOfStatement("a -- 注释;分号\n; b") === 11, "行注释里的分号被跳过", String(endOfStatement("a -- 注释;分号\n; b")));
check(endOfStatement("没有分号") === -1, "无分号返回 -1");

// ---------------------------------------------------------------- 解析

const noteText = [
  "# 数据库表 DDL",
  "",
  "```sql",
  "CREATE TABLE IF NOT EXISTS `ids_check_scenario` (",
  "  id bigint NOT NULL COMMENT '场景ID;主键',",
  "  name varchar(64)",
  ") COMMENT='检查场景';",
  "create table ids_check_plan (id bigint);",
  "```",
  "",
  "正文里散一句 create table ids_task (task_id bigint); 也算。",
].join("\n");

const tables = parseDdlTables(noteText);
check(tables.size === 3, "围栏内两条 + 正文一条都收录", [...tables.keys()].join(","));
check(
  tables.get("ids_check_scenario")?.includes("COMMENT='检查场景';"),
  "含字符串分号的语句完整收录到分号",
);
check(
  tables.get("ids_check_scenario")?.startsWith("CREATE TABLE IF NOT EXISTS"),
  "语句从 CREATE 开始",
);
check(
  !tables.get("ids_check_plan")?.includes("ids_task"),
  "第二条语句不含下一条的内容",
);
check(extractTableNames(noteText).join(",") === "ids_check_scenario,ids_check_plan,ids_task", "表名按出现顺序去重");
check(parseDdlTables("create table db.tbl_x (a int);").has("db.tbl_x"), "裸库名前缀整体收录");
check(parseDdlTables("create table `tbl_y` (a int);").has("tbl_y"), "反引号包裹的单名剥掉包裹符");

// ---------------------------------------------------------------- 合并

const DDL_A = "CREATE TABLE a (id bigint);";
const DDL_B = "CREATE TABLE b (id bigint);";
const intro = "# 我的 DDL 库\n\n说明文字不许动。\n";

let merged = mergeDdlIntoNote(intro, DDL_A + "\n" + DDL_B);
check(merged.includes("说明文字不许动。"), "合并保留用户说明文字");
check(merged.includes("```sql\nCREATE TABLE a") && merged.includes("CREATE TABLE b"), "新表追加进围栏块");

merged = mergeDdlIntoNote(merged, "CREATE TABLE a (id bigint, name varchar(10));");
check(!merged.includes("CREATE TABLE a (id bigint);"), "同名表旧段被整段替换");
check(merged.includes("CREATE TABLE a (id bigint, name varchar(10));"), "新段就位");
check((merged.match(/CREATE TABLE a/g) ?? []).length === 1, "替换后不残留重复段");
check(mergeDdlIntoNote(intro, "没有建表语句") === intro, "无可识别内容返回原文");

// 语句里的 $& 不被当替换占位符
const dollar = mergeDdlIntoNote("", "CREATE TABLE t_money (amount varchar(8) COMMENT '$100;$&');\n\nCREATE TABLE t_money (amount varchar(9) COMMENT '$200;$&');");
check(dollar.includes("$&") && !dollar.includes("$100;$&'),$200"), "$& 字面保留", dollar);

// ---------------------------------------------------------------- 阅读位置

class MemStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, value);
  }
  removeItem(key) {
    this.map.delete(key);
  }
}
const storage = new MemStorage();
const VAULT_A = "H:/vault-a";
const VAULT_B = "H:/vault-b";

check(loadProgress(storage, VAULT_A, "a.md") === null, "无记录返回 null");
saveProgress(storage, VAULT_A, "a.md", 1200);
check(loadProgress(storage, VAULT_A, "a.md") === 1200, "记录后可读回");
check(loadProgress(storage, VAULT_B, "a.md") === null, "按仓库隔离");
saveProgress(storage, VAULT_A, "a.md", 2);
check(loadProgress(storage, VAULT_A, "a.md") === null, "顶部附近不记（清掉旧值）");
saveProgress(storage, VAULT_A, "a.md", 500);
saveProgress(storage, VAULT_A, "a.md", 900);
const db = JSON.parse(storage.getItem("quicknote.readprogress.v1"));
check(db[VAULT_A]["a.md"] === 900, "重复写入覆盖同一条");
// LRU：灌满上限后最旧的被淘汰
for (let i = 0; i < 420; i += 1) saveProgress(storage, VAULT_A, `note-${i}.md`, 100 + i);
const dbFull = JSON.parse(storage.getItem("quicknote.readprogress.v1"));
const count = Object.values(dbFull).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0);
check(count <= 400, `条目数不超上限（实际 ${count}）`);
check(dbFull[VAULT_A]["note-0.md"] === undefined, "最旧的先淘汰");
check(dbFull[VAULT_A]["note-419.md"] === 519, "最新的保留");
deleteProgress(storage, VAULT_A, "note-419.md");
check(loadProgress(storage, VAULT_A, "note-419.md") === null, "删除生效");

// ---------------------------------------------------------------- 高亮切分

const parts = splitHighlight("前 ==重要== 中 ==两个词== 后");
check(parts.length === 5, "切出五段", JSON.stringify(parts));
check(parts[1].text === "重要" && parts[1].hit === true, "命中段内容与标记");
check(parts[0].text === "前 " && parts[0].hit === false, "普通段");
check(splitHighlight("100 == 200")[0].hit === false && splitHighlight("100 == 200").length === 1, "比较运算不误判");
check(splitHighlight("== 顶格空格不是高亮==").length === 1, "首字符为空不命中");
// 与正文 findHighlights 同一口径：内容里含 = 不算高亮（防 a == b == c 误判）
check(splitHighlight("==a=b==").length === 1 && !splitHighlight("==a=b==")[0].hit, "内容含 = 不命中（与正文口径一致）");
check(splitHighlight("").length === 1 && splitHighlight("")[0].text === "", "空文本单段");

console.log(failures === 0 ? "\nDDL/阅读位置/高亮切分全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

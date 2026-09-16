// 云同步的纯逻辑（无需 DOM、无需 Tauri、不连真后端）。
//
// 覆盖重点是那些"写错了不会报错、只会静默损坏数据"的地方：
//   · 冲突决策的每个分支（判断错了就是丢改动或覆盖别人）
//   · 同步状态的深拷贝与坏值兜底（插件为此踩过一次全库误删的事故）
//   · 待办快照与条目级合并（快照每轮抖动 = 每轮都推 = 压掉别的设备）
//   · 哈希口径（BOM 不进哈希、换行符进哈希）
//   · 范围判定与 URL 归一化（错一个后缀就是整批 400）
//
// 这些断言与 Rust 侧 `tests/sync.rs` 是**两侧各测一遍**的关系：同一套规则在两个语言里
// 各有一份实现（扫描在 Rust、应用在 TS），只测一边等于放弃另一边。
//
// 用法：node --experimental-strip-types --no-warnings scripts/verify-sync.mjs

import { createHash } from "node:crypto";
import {
  ATTACHMENT_DOWNLOAD_BYTES_PER_CYCLE,
  ATTACHMENT_DOWNLOAD_PER_CYCLE,
  DEFAULT_SYNC_STATE,
  MAX_ATTACHMENT_BYTES,
  MAX_BATCH,
  MAX_CONTENT_CHARS,
  PULL_LIMIT,
  DownloadBudget,
  adaptStateToVault,
  attachmentStamp,
  baseUrl,
  conflictLabel,
  decideRecord,
  defaultVaultName,
  headerValue,
  inScope,
  isAttachmentPath,
  mergeTodoSnapshot,
  normalizeSyncState,
} from "../src/lib/sync.ts";
import {
  SNAPSHOT_VERSION,
  TOMBSTONE_TTL_MS,
  TODO_SYNC_PATH,
  buildSnapshot,
  liveItems,
  mergeTodos,
  parseSnapshot,
} from "../src/lib/todos.ts";
import { sha256Hex, sha256HexBytes } from "../src/lib/hash.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

// 哈希在 Node 里的独立真值：与 WebCrypto 的那条路径互相对照，
// 而不是把实现抄一遍（同一份实现抄两遍，写错了会一起错）。
const nodeHash = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// ---------------------------------------------------------------- 同步状态

console.log("同步状态（本机文件，内含凭据，绝不进仓库）\n");

{
  check(
    normalizeSyncState(undefined).hashes !== DEFAULT_SYNC_STATE.hashes,
    "默认状态表的 hashes 是新对象（浅拷贝会让多台设备共用同一张表）",
  );

  const a = normalizeSyncState({ hashes: { "a.md": "x" } });
  const b = normalizeSyncState(undefined);
  a.hashes["b.md"] = "y";
  check(b.hashes["b.md"] === undefined, "两台设备的状态互不影响");
  check(
    normalizeSyncState(null).hashes !== null && typeof normalizeSyncState(null).hashes === "object",
    "空状态也有 hashes 对象",
  );

  check(normalizeSyncState({ scope: "vault" }).scope === "vault", "scope=vault 保留");
  check(normalizeSyncState({ scope: "nonsense" }).scope === "folder", "非法 scope 退回 folder");
  check(normalizeSyncState({ cursor: 12 }).cursor === 12, "游标保留");
  check(normalizeSyncState({ cursor: -5 }).cursor === 0, "负游标归零");
  check(normalizeSyncState({ cursor: "9" }).cursor === 0, "字符串游标归零（不信坏数据）");
  check(normalizeSyncState({ lastSyncAt: 123 }).lastSyncAt === 123, "上次同步时间保留");
  check(normalizeSyncState({}).enabled === false, "默认不自动开启同步");
  check(normalizeSyncState({}).refreshToken === "", "默认没有 refreshToken");

  // 换仓库：游标与哈希必须归零。带着别的仓库的哈希去比对，同名文件会被误判成
  // 「本地改过」（多推一遍）或「云端已删」（误删本地文件）。
  const sameVault = adaptStateToVault(
    { ...DEFAULT_SYNC_STATE, vault: "D:/notes", cursor: 7, hashes: { "a.md": "h" }, lastSyncAt: 5 },
    "D:/notes",
  );
  check(sameVault.cursor === 7 && sameVault.hashes["a.md"] === "h", "同一个仓库：游标与哈希照旧");

  const otherVault = adaptStateToVault(
    {
      ...DEFAULT_SYNC_STATE,
      vault: "D:/notes",
      cursor: 7,
      hashes: { "a.md": "h" },
      lastSyncAt: 5,
      serverUrl: "http://x",
      username: "u",
      enabled: true,
      refreshToken: "r",
    },
    "D:/other",
  );
  check(otherVault.cursor === 0, "换仓库后游标归零");
  check(Object.keys(otherVault.hashes).length === 0, "换仓库后哈希清空");
  check(otherVault.lastSyncAt === 0, "换仓库后「上次同步时间」归零");
  check(otherVault.vault === "D:/other", "记下新仓库");
  check(
    otherVault.serverUrl === "http://x" &&
      otherVault.username === "u" &&
      otherVault.enabled === true &&
      otherVault.refreshToken === "r",
    "换仓库不影响账号配置与 refreshToken（它们是设备/账号级的）",
  );
  check(
    adaptStateToVault({ ...DEFAULT_SYNC_STATE, vault: "" }, "D:/notes").vault === "D:/notes",
    "首次使用（状态里没有仓库）也记下当前仓库",
  );
}

// ---------------------------------------------------------------- 范围判定

console.log("\n推送范围（与插件 inScope 对齐）\n");

{
  const cases = [
    ["日记/2026-09-15 测试.md", "folder", "日记", true],
    ["日记/子目录/嵌套.md", "folder", "日记", true],
    ["日记本/2026-09-15.md", "folder", "日记", false],
    ["笔记/别的.md", "folder", "日记", false],
    ["日记/附件.txt", "folder", "日记", false],
    // 服务端扩展名白名单区分大小写：`.MD` 推上去会让整批 400，所以不推
    ["日记/大写.MD", "folder", "日记", false],
    ["日记/.隐藏.md", "folder", "日记", false],
    ["日记/子/.隐藏/也.md", "folder", "日记", false],
    // folder 为空 = 仓库根目录，整个库都在范围里（与插件的 `folder === ""` 一致）
    ["任意/路径.md", "folder", "", true],
    ["任意/路径.md", "vault", "日记", true],
    ["quick-daily-note.json", "vault", "", false],
    ["daily-sync-todos.json", "vault", "", false],
  ];
  for (const [path, scope, folder, expected] of cases) {
    check(
      inScope(path, scope, folder) === expected,
      `inScope(${path}, ${scope}, "${folder}") === ${expected}`,
    );
  }

  // 尾部分隔符与反斜杠（Windows 上用户填的是 `日记\`）
  check(inScope("日记/a.md", "folder", "日记/") === true, "folder 尾部的 / 被忽略");
  check(inScope("日记/a.md", "folder", "日记\\") === true, "folder 里的反斜杠被归一成正斜杠");
  check(inScope("日记/a.md", "folder", " 日记 ") === true, "folder 两端的空白被忽略");
}

console.log("\n服务端地址与仓库名\n");

{
  check(baseUrl("192.0.2.10:8080") === "http://192.0.2.10:8080", "没写协议时补 http");
  check(baseUrl("http://a.com/") === "http://a.com", "去掉尾部斜杠");
  check(baseUrl("https://a.com///") === "https://a.com", "多个尾部斜杠也去掉");
  check(baseUrl("  http://a.com  ") === "http://a.com", "两端空白去掉");
  check(baseUrl("HTTP://A.com") === "HTTP://A.com", "已有协议时原样保留（含大小写）");

  check(defaultVaultName("D:\\笔记\\quick daily note") === "quick daily note", "Windows 路径取末段");
  check(defaultVaultName("/home/me/notes/") === "notes", "末尾分隔符不影响");
  check(defaultVaultName("notes") === "notes", "没有分隔符时就是它本身");
  check(defaultVaultName("") === "", "空路径得到空串（由调用方兜底显示）");

  const headers = [
    { name: "Content-Type", value: "application/json" },
    { name: "X-Attachment-Path", value: "image/a.png" },
  ];
  check(headerValue(headers, "x-attachment-path") === "image/a.png", "响应头按小写比对取值");
  check(headerValue(headers, "content-type") === "application/json", "大小写不同的键也能取到");
  check(headerValue(headers, "missing") === undefined, "取不到时返回 undefined");
}

// ---------------------------------------------------------------- 冲突决策

console.log("\n冲突决策（判断错了就是丢改动或覆盖别人）\n");

{
  const H = (tag) => `hash-${tag}`;

  // —— 远端不是墓碑 ——
  check(
    decideRecord({
      remoteDeleted: false,
      remoteHash: H("same"),
      knownHash: H("same"),
      local: { exists: true, hash: H("same") },
    }) === "noop-identical",
    "本地与远端一致 → 什么都不做",
  );
  check(
    decideRecord({
      remoteDeleted: false,
      remoteHash: H("remote"),
      knownHash: H("old"),
      local: { exists: true, hash: H("old") },
    }) === "adopt-remote",
    "本地没动过、云端改过 → 采纳云端",
  );
  check(
    decideRecord({
      remoteDeleted: false,
      remoteHash: H("remote"),
      knownHash: H("old"),
      local: { exists: true, hash: H("local") },
    }) === "keep-local",
    "双边都改过 → 本地胜（保留本地并回推）",
  );
  check(
    decideRecord({
      remoteDeleted: false,
      remoteHash: H("remote"),
      knownHash: undefined,
      local: { exists: true, hash: H("local") },
    }) === "keep-local",
    "本设备不认识它、而本地已有文件 → 本地胜（不覆盖来路不明的本地内容）",
  );

  // 与插件的刻意差别：这里若按插件"当成没动过"处理，一次「重置同步状态」
  // 就会让云端内容成片覆盖本地（把读取失败放大成全库回滚）
  check(
    decideRecord({
      remoteDeleted: false,
      remoteHash: H("cloud"),
      knownHash: undefined,
      local: { exists: true, hash: H("mine") },
    }) !== "adopt-remote",
    "「重置同步状态」后不会用云端覆盖本地（这是与插件唯一的策略差别）",
  );
  check(
    decideRecord({
      remoteDeleted: false,
      remoteHash: H("remote"),
      knownHash: undefined,
      local: { exists: false, hash: null },
    }) === "create-local",
    "云端新增、本地没有 → 在本地重建",
  );
  check(
    decideRecord({
      remoteDeleted: false,
      remoteHash: H("remote"),
      knownHash: H("remote"),
      local: { exists: false, hash: null },
    }) === "push-delete",
    "本地文件已不在、而上一次同步的正是这份 → 补一个墓碑（本地删除没推上去）",
  );

  // —— 远端是墓碑 ——
  check(
    decideRecord({
      remoteDeleted: true,
      remoteHash: null,
      knownHash: undefined,
      local: { exists: false, hash: null },
    }) === "noop-identical",
    "云端已删、本地也没有 → 什么都不做",
  );
  check(
    decideRecord({
      remoteDeleted: true,
      remoteHash: null,
      knownHash: H("old"),
      local: { exists: true, hash: H("old") },
    }) === "delete-local",
    "云端已删、本地没动过 → 跟随删除",
  );
  check(
    decideRecord({
      remoteDeleted: true,
      remoteHash: null,
      knownHash: undefined,
      local: { exists: true, hash: H("local") },
    }) === "delete-local",
    "云端已删、本设备没见过这个文件 → 跟随删除（不留下幽灵文件）",
  );
  check(
    decideRecord({
      remoteDeleted: true,
      remoteHash: null,
      knownHash: H("old"),
      local: { exists: true, hash: H("mine") },
    }) === "resurrect-local",
    "云端已删、本地有未同步修改 → 本地胜，复活并回推",
  );

  check(
    conflictLabel("keep-local", "日记/a.md")?.includes("重新上传") === true,
    "冲突提示说明了「已重新上传」",
  );
  check(conflictLabel("noop-identical", "日记/a.md") === null, "无冲突时不给提示文案");
}

// ---------------------------------------------------------------- 哈希口径

console.log("\n哈希口径（M3 的阻断项）\n");

{
  const text = "# 标题\n正文\n";
  check((await sha256Hex(text)) === nodeHash(text), "sha256Hex 与 Node 的 createHash 结果一致");
  check(
    (await sha256Hex("# 标题\r\n正文\r\n")) !== (await sha256Hex(text)),
    "换行符参与哈希：CRLF 与 LF 是不同内容（两侧都不规范化）",
  );
  check((await sha256Hex("a\n")) !== (await sha256Hex("a")), "尾随换行参与哈希");
  check(
    (await sha256HexBytes(new Uint8Array([0x00, 0xff]))) ===
      createHash("sha256").update(Buffer.from([0x00, 0xff])).digest("hex"),
    "二进制哈希（附件用）与 Node 一致",
  );
  check(
    (await sha256Hex("")) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "空内容的哈希是已知值",
  );
}

// ---------------------------------------------------------------- 待办快照

console.log("\n待办快照（内容必须稳定，抖动一次就多推一轮）\n");

{
  const now = 1_800_000_000_000;
  const todos = {
    "2026-09-15": [
      { id: "b", text: "第二条", done: true, updatedAt: now - 1000 },
      { id: "a", text: "第一条", done: false, updatedAt: now - 2000 },
    ],
    "2026-09-16": [],
  };

  const text = buildSnapshot(todos, now - 5000, now);
  const parsed = JSON.parse(text);
  check(parsed.version === SNAPSHOT_VERSION, "快照带版本号");
  check(parsed.updatedAt === new Date(now - 5000).toISOString(), "updatedAt 用传入的待办修改时间");
  check(parsed.updatedAt !== new Date(now).toISOString(), "而不是当前时间（否则哈希每轮都变）");
  check(
    parsed.todos["2026-09-15"].map((item) => item.id).join(",") === "a,b",
    "同一天内按 updatedAt 升序（新建的排后面，两侧顺序一致）",
  );
  check(parsed.todos["2026-09-16"] === undefined, "只含空数组的日期整条丢掉");
  check(!text.endsWith("\n"), "没有尾随换行（与插件逐字节一致）");
  check(text === JSON.stringify(parsed, null, 2), "缩进是 2 空格，与插件一致");

  // 同一份数据两次生成必须逐字节相同
  check(buildSnapshot(todos, now - 5000, now) === text, "同一份数据两次生成内容完全一致");

  // 墓碑：保留期内带着，过期后清掉
  const withTombstone = {
    "2026-09-15": [
      { id: "gone", text: "删了的", done: false, updatedAt: now - 1000, deleted: true },
      { id: "live", text: "还在的", done: false, updatedAt: now - 2000 },
    ],
  };
  const kept = JSON.parse(buildSnapshot(withTombstone, now, now));
  check(kept.todos["2026-09-15"].length === 2, "保留期内的墓碑进快照（别的设备要看到这次删除）");
  const expired = JSON.parse(buildSnapshot(withTombstone, now, now + TOMBSTONE_TTL_MS + 1));
  check(expired.todos["2026-09-15"].length === 1, "过期墓碑从快照里清掉（避免无限膨胀）");
  const onlyTombstone = {
    "2026-09-15": [{ id: "gone", text: "x", done: false, updatedAt: now, deleted: true }],
  };
  check(
    buildSnapshot(onlyTombstone, now, now + TOMBSTONE_TTL_MS + 1).includes("2026-09-15") === false,
    "只含墓碑的日期整条丢掉",
  );

  // 解析
  check(parseSnapshot(text)?.version === SNAPSHOT_VERSION, "能解析自己生成的快照");
  check(parseSnapshot("{ 不是 JSON") === null, "坏 JSON 返回 null（调用方据此只推不拉）");
  check(
    parseSnapshot(JSON.stringify({ version: 1, todos: {} })) === null,
    "版本不匹配返回 null（旧格式无法按条目对齐，只推不拉）",
  );
  check(
    parseSnapshot(JSON.stringify({ version: SNAPSHOT_VERSION })) === null,
    "缺 todos 字段返回 null",
  );
}

console.log("\n待办条目级合并（一边加、一边勾，不能互相冲掉）\n");

{
  const t = 1000;
  const local = {
    "2026-09-15": [
      { id: "a", text: "本地改过的", done: true, updatedAt: t + 10 },
      { id: "only-local", text: "本地新增", done: false, updatedAt: t },
    ],
  };
  const remote = {
    "2026-09-15": [
      { id: "a", text: "云端改过的", done: false, updatedAt: t },
      { id: "only-remote", text: "云端新增", done: false, updatedAt: t },
    ],
    "2026-09-16": [{ id: "other-day", text: "云端别的日期", done: false, updatedAt: t }],
  };

  const { todos, changed } = mergeTodos(local, remote);
  const flat = Object.entries(todos).flatMap(([date, items]) =>
    items.map((item) => `${date}/${item.id}`),
  );
  check(changed === true, "合并结果与本地不同 → changed（需要回推）");
  check(flat.includes("2026-09-15/a"), "同一条保留（不会变成两条）");
  check(
    todos["2026-09-15"].find((item) => item.id === "a").text === "本地改过的",
    "同一条双方都改 → updatedAt 更大的赢",
  );
  check(flat.includes("2026-09-15/only-local"), "只有本地有的条目保留");
  check(flat.includes("2026-09-15/only-remote"), "只有云端有的条目保留");
  check(flat.includes("2026-09-16/other-day"), "云端别的日期也并进来");
  check(
    todos["2026-09-15"].map((item) => item.id).join(",") === "only-local,only-remote,a",
    "同一天内按 updatedAt 升序（updatedAt 相同的保持插入顺序，两侧都稳定）",
  );

  // 合并结果与本地一致时不该回推（否则每次拉取都会推一轮）
  const same = mergeTodos(local, { "2026-09-15": [{ id: "a", text: "本地改过的", done: true, updatedAt: t + 10 }] });
  check(same.changed === false, "云端只是本地的一个子集 → 不回推");

  // 墓碑赢：云端删了、本地没改过
  const deleted = mergeTodos(
    { "2026-09-15": [{ id: "a", text: "x", done: false, updatedAt: t }] },
    { "2026-09-15": [{ id: "a", text: "x", done: false, updatedAt: t + 5, deleted: true }] },
  );
  check((deleted.todos["2026-09-15"] ?? []).length === 0, "云端墓碑更新 → 本地条目消失（删除生效）");
  check(deleted.changed === true, "删除算改动 → 回推让其他设备也清掉");

  // 墓碑不赢：本地改得更晚
  const kept = mergeTodos(
    { "2026-09-15": [{ id: "a", text: "本地后改的", done: false, updatedAt: t + 9 }] },
    { "2026-09-15": [{ id: "a", text: "x", done: false, updatedAt: t + 5, deleted: true }] },
  );
  check(
    kept.todos["2026-09-15"]?.[0]?.text === "本地后改的",
    "本地改动比云端墓碑更晚 → 条目留下（后改的赢）",
  );

  // 日期归属跟着赢家走
  const moved = mergeTodos(
    { "2026-09-15": [{ id: "a", text: "x", done: false, updatedAt: t }] },
    { "2026-09-16": [{ id: "a", text: "x", done: false, updatedAt: t + 5 }] },
  );
  check(moved.todos["2026-09-16"]?.length === 1 && !moved.todos["2026-09-15"], "日期归属跟着更新的那一侧");

  // 重复 id：保留更新的那条（同一个 id 不该出现在两个日期里，但坏数据要能扛住）
  const dup = mergeTodos(
    {
      "2026-09-15": [{ id: "a", text: "旧的", done: false, updatedAt: t }],
      "2026-09-16": [{ id: "a", text: "新的", done: false, updatedAt: t + 5 }],
    },
    {},
  );
  check(dup.todos["2026-09-16"]?.[0]?.text === "新的", "重复 id 取 updatedAt 更新的那条");

  // 空输入
  const empty = mergeTodos({}, {});
  check(empty.changed === false && Object.keys(empty.todos).length === 0, "两边都空 → 无改动");

  // liveItems 仍然滤掉墓碑（渲染路径）
  check(
    liveItems([{ id: "x", text: "x", done: false, updatedAt: 1, deleted: true }]).length === 0,
    "墓碑不进渲染",
  );
}

console.log("\n虚拟文件的合并入口（mergeTodoSnapshot）\n");

{
  const local = { "2026-09-15": [{ id: "a", text: "本地", done: false, updatedAt: 100 }] };
  const remoteText = buildSnapshot(
    { "2026-09-15": [{ id: "a", text: "本地", done: false, updatedAt: 100 }] },
    100,
    100,
  );
  const result = mergeTodoSnapshot(remoteText, local);
  check(result !== null && result.changed === false, "内容一致 → 不改动（不产生无谓的推送）");

  const newer = buildSnapshot(
    { "2026-09-15": [{ id: "b", text: "云端新增", done: false, updatedAt: 200 }] },
    200,
    200,
  );
  const merged = mergeTodoSnapshot(newer, local);
  check(merged?.todos["2026-09-15"]?.length === 2, "云端新增条目并进本地");

  check(mergeTodoSnapshot("{坏数据", local) === null, "坏快照返回 null（只推不拉，不覆盖本地）");
  check(
    mergeTodoSnapshot(JSON.stringify({ version: 1, todos: {} }), local) === null,
    "旧版本快照返回 null",
  );
  check(TODO_SYNC_PATH === "daily-sync-todos.json", "待办在云端的记录路径与插件一致");
}

console.log("\n协议常量（与插件、服务端一致）\n");

{
  check(MAX_BATCH === 200, "单批 ≤200 条（服务端限制）");
  check(MAX_CONTENT_CHARS === 1_048_576, "单条 ≤1MB");
  check(PULL_LIMIT === 500, "拉取分页 500（服务端上限）");
  check(TODO_SYNC_PATH.endsWith(".json"), "待办记录以 .json 结尾（服务端扩展名白名单）");
}

console.log("\n附件同步（纯逻辑部分）\n");

{
  // 白名单与路径分类（与后端 AttachmentService 一致）
  check(isAttachmentPath("attachments/图.png"), "png 算附件");
  check(isAttachmentPath("a/b/c.pdf"), "pdf 算附件");
  check(isAttachmentPath("图.JPEG"), "扩展名大小写不敏感");
  check(!isAttachmentPath("日记/a.md"), "正文不算附件");
  check(!isAttachmentPath("quick-daily-note.json"), "库内配置不算附件");
  check(!isAttachmentPath(".trash/图.png"), "点开头目录里的不同步");
  check(!isAttachmentPath("a/.hidden/图.png"), "路径中任何一段点开头都不同步");
  check(!isAttachmentPath("图.svg"), "svg 刻意不支持（能内联脚本）");
  check(!isAttachmentPath("a.txt"), "白名单之外不同步");
  check(!isAttachmentPath("没有扩展名"), "没有扩展名不同步");

  // 旁路缓存键
  check(attachmentStamp(123, 456) === "123:456", "stamp 是 mtime:size");
  check(attachmentStamp(123, 456) !== attachmentStamp(124, 456), "mtime 变了 stamp 就变");

  // 状态里的附件哈希表也要深拷贝、换仓库也要清空
  const a = normalizeSyncState({ attachmentHashes: { "a.png": "h" } });
  a.attachmentHashes["b.png"] = "h2";
  check(
    normalizeSyncState(undefined).attachmentHashes["b.png"] === undefined,
    "attachmentHashes 深拷贝（不与默认状态共享）",
  );
  const moved = adaptStateToVault(
    {
      ...DEFAULT_SYNC_STATE,
      vault: "D:/a",
      attachmentHashes: { "a.png": "h" },
      attachmentStamps: { "a.png": "1:2" },
    },
    "D:/b",
  );
  check(
    Object.keys(moved.attachmentHashes).length === 0 && Object.keys(moved.attachmentStamps).length === 0,
    "换仓库后附件哈希与 stamp 一并清空",
  );

  // 每轮下载预算
  const budget = new DownloadBudget(3, 100);
  budget.reset();
  check(!budget.exhausted(), "新预算没用完");
  budget.record(40);
  budget.record(40);
  check(!budget.exhausted(), "80/100 字节还能下");
  budget.record(40);
  check(budget.exhausted(), "累计 120 字节，超过上限");
  check(budget.deferred === 1, "被推迟记一笔（下轮继续）");
  budget.reset();
  check(!budget.exhausted() && budget.deferred === 0, "重置后额度恢复");
  const countBudget = new DownloadBudget(1, Number.MAX_SAFE_INTEGER);
  countBudget.record(1);
  check(countBudget.exhausted(), "条数上限同样生效");

  check(MAX_ATTACHMENT_BYTES === 10 * 1024 * 1024, "附件上限 10MB（与服务端一致）");
  check(
    ATTACHMENT_DOWNLOAD_PER_CYCLE === 20 && ATTACHMENT_DOWNLOAD_BYTES_PER_CYCLE === 50 * 1024 * 1024,
    "每轮下载额度与插件一致（20 个 / 50MB）",
  );
}

console.log(failures === 0 ? "\n云同步逻辑验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

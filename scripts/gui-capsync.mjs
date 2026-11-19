// GUI 批测：速记写入后收件仓库自动同步（0.39.19 用户反馈「每次添加速记后想要
// 进行同步，必须要打开速记仓库，很麻烦」；0.39.20 加固——enabledForVault 以
// per-vault 状态文件为权威、失败如实上抛）。桩后端做端到端验证：主仓库（另一
// 窗口语境）里加一条速记 → 收件仓库应在 ~10s 内被临时引擎推上桩。
//
// 0.39.26 新增两阶段：
//   · 阶段 3 根因回归——quickCaptureVault 用反斜杠路径 + per-vault vaultName 空
//     （0.39.22 清洗后的真实形状），临时轮必须推到 basename 仓，不允许把整条
//     路径当仓库名发给桩（「D:\study\inbox」假仓库事故）。
//   · 阶段 4 自愈回归——桩端仓库「重建」（版本倒退到 5）：客户端游标高于服务端
//     版本时必须重置游标/哈希全量对账；墓碑不得误删本地文件（复活推回）；下一
//     轮触发时哈希已清 → 全量重推。
//
// 镜像用户真实状态形状（排查期实锤环境差异路径用）：
//   · 收件仓库：15 个 md + 8 张图，per-vault 状态 cursor=401、哈希/戳全匹配
//   · 桩后端：预置 records v1..401（内容=盘上文件），vaultVersion=401
//   · 主仓库：同步也开着，双引擎并存
//   · 速记正文带一个**本地不存在的附件引用**（镜像用户库里缺失的贴图）
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { vaultStateKey } from "../src/lib/sync.ts";

const port = process.argv[2] ?? "9475";
const stubPort = Number(process.argv[3] ?? 9476);
const BASE = `http://127.0.0.1:${stubPort}`;
const root = process.cwd();
const exe = join(root, "src-tauri", "target", "release", "quick-note.exe");
if (!existsSync(exe)) {
  console.error(`找不到 ${exe}——先构建 gui-test 变体`);
  process.exit(2);
}

const USERNAME = "guitest";
const PASSWORD = "GuiTest-2026";

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 Rust sync_hash 同口径：剥 BOM 的 UTF-8 正文 sha256。 */
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const syncHashOf = (raw) => {
  const stripped = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  return sha256Hex(stripped);
};
/** attachmentStamp 口径：mtime(ms)+size（见 sync.ts attachmentStamp）。 */
const stampOf = (p) => {
  const st = statSync(p);
  return `${st.mtimeMs}:${st.size}`;
};

// ---------------------------------------------------------------- 桩后端
const requests = [];
const tokens = new Set();
const refreshTokens = new Set(["refresh-seed"]);
let tokenSeq = 0;
const vaults = new Map();
const vaultOf = (name) => {
  if (!vaults.has(name)) vaults.set(name, { version: 0, records: new Map(), attachments: new Map() });
  return vaults.get(name);
};
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const bodyBuffer = Buffer.concat(chunks);
    const body = bodyBuffer.toString("utf8");
    const url = new URL(req.url, BASE);
    requests.push({ method: req.method, path: url.pathname, vault: url.searchParams.get("vault"), body, at: Date.now() });
    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/v1/auth/login") {
      const parsed = JSON.parse(body || "{}");
      if (parsed.password !== PASSWORD || parsed.username !== USERNAME) {
        send(401, { code: 401, message: "账号或密码错误" });
        return;
      }
      tokenSeq += 1;
      tokens.add(`access-${tokenSeq}`);
      refreshTokens.add(`refresh-${tokenSeq}`);
      send(200, { code: 0, data: { accessToken: `access-${tokenSeq}`, refreshToken: `refresh-${tokenSeq}`, expiresIn: 7200 } });
      return;
    }
    if (url.pathname === "/api/v1/auth/refresh") {
      const parsed = JSON.parse(body || "{}");
      if (!refreshTokens.has(parsed.refreshToken)) {
        send(401, { code: 401, message: "refreshToken 已失效" });
        return;
      }
      refreshTokens.delete(parsed.refreshToken);
      tokenSeq += 1;
      tokens.add(`access-${tokenSeq}`);
      refreshTokens.add(`refresh-${tokenSeq}`);
      send(200, { code: 0, data: { accessToken: `access-${tokenSeq}`, refreshToken: `refresh-${tokenSeq}`, expiresIn: 7200 } });
      return;
    }
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!tokens.has(bearer)) {
      send(401, { code: 401, message: "未登录或令牌失效" });
      return;
    }
    if (url.pathname === "/api/v1/sync" && req.method === "POST") {
      const vaultState = vaultOf(url.searchParams.get("vault") ?? "");
      const parsed = JSON.parse(body || "{}");
      const results = [];
      for (const item of parsed.items ?? []) {
        vaultState.version += 1;
        vaultState.records.set(item.path, {
          path: item.path,
          content: item.deleted ? null : item.content,
          deleted: !!item.deleted,
          version: vaultState.version,
        });
        results.push({ path: item.path, status: item.deleted ? "deleted" : "updated", version: vaultState.version });
      }
      send(200, { code: 0, data: { vaultVersion: vaultState.version, changed: results.length > 0, results } });
      return;
    }
    if (url.pathname === "/api/v1/sync" && req.method === "GET") {
      const vaultState = vaultOf(url.searchParams.get("vault") ?? "");
      const since = Number(url.searchParams.get("since") ?? 0);
      const all = [...vaultState.records.values()].sort((a, b) => a.version - b.version);
      const fresh = all.filter((item) => item.version > since);
      send(200, {
        code: 0,
        data: { vaultVersion: vaultState.version, hasMore: false, records: fresh, attachments: [] },
      });
      return;
    }
    if (url.pathname === "/api/v1/sync/attachments") {
      const vaultState = vaultOf(url.searchParams.get("vault") ?? "");
      const sha256 = sha256Hex(bodyBuffer);
      if (req.method === "POST") {
        const path = url.searchParams.get("path");
        vaultState.version += 1;
        vaultState.attachments.set(path, { path, sha256, size: bodyBuffer.length, deleted: false, version: vaultState.version });
        send(200, { code: 0, data: { path, status: "updated", version: vaultState.version } });
        return;
      }
      if (req.method === "DELETE") {
        vaultState.version += 1;
        send(200, { code: 0, data: { path: url.searchParams.get("path"), status: "deleted", version: vaultState.version } });
        return;
      }
      if (req.method === "GET") {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ code: 404, message: "附件不存在" }));
        return;
      }
    }
    send(404, { code: 404, message: "not found" });
  });
});
await new Promise((resolve) => server.listen(stubPort, "127.0.0.1", resolve));

// ---------------------------------------------------------------- 镜像真实收件仓库
const work = join(tmpdir(), `qn-capsync2-${Date.now()}`);
mkdirSync(work, { recursive: true });
const mainVault = join(work, "主仓库").replace(/\\/g, "/");
const inboxVault = join(work, "收件仓库").replace(/\\/g, "/");
mkdirSync(mainVault, { recursive: true });
mkdirSync(join(inboxVault, "attachments"), { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });
writeFileSync(join(mainVault, "首页.md"), "# 首页\n\n主仓库正文。\n", "utf8");

// 收件仓库 md：14 个历史日期文件 + Inbox.md（内容随意，哈希按盘上字节算进状态）
const hashes = {};
for (let d = 1; d <= 14; d += 1) {
  const name = `2026-11-${String(d).padStart(2, "0")}.md`;
  const content = `# 2026-11-${String(d).padStart(2, "0")}\n\n- 2026-11-${String(d).padStart(2, "0")} 10:00 [测试] 历史速记 ${d}\n`;
  writeFileSync(join(inboxVault, name), content, "utf8");
  hashes[name] = syncHashOf(Buffer.from(content, "utf8"));
}
writeFileSync(join(inboxVault, "Inbox.md"), "# Inbox\n\n- 旧条目甲\n- 旧条目乙\n", "utf8");
hashes["Inbox.md"] = syncHashOf(Buffer.from("# Inbox\n\n- 旧条目甲\n- 旧条目乙\n", "utf8"));

// 附件：从用户真实仓库拷 8 张图（镜像大小分布），哈希进状态
const realAtt = "H:\\develop\\shuiyi_code\\inbox\\attachments";
const realImages = readdirSync(realAtt).filter((n) => n.endsWith(".png")).slice(0, 8);
const attachmentHashes = {};
const attachmentStamps = {};
for (const img of realImages) {
  const from = join(realAtt, img);
  const to = join(inboxVault, "attachments", img);
  copyFileSync(from, to);
  attachmentHashes[`attachments/${img}`] = sha256Hex(readFileSync(to));
  attachmentStamps[`attachments/${img}`] = stampOf(to);
}

// 桩预置：records v1..401 = 盘上文件内容（拉取=无新东西），vaultVersion=401
const inboxCloud = vaultOf("收件仓库");
for (const [p, content] of Object.entries(hashes)) {
  inboxCloud.version += 1;
  inboxCloud.records.set(p, { path: p, content: readFileSync(join(inboxVault, p), "utf8"), deleted: false, version: inboxCloud.version });
}
// 版本号补齐到 401（模拟历史：中间版本是附件等）
while (inboxCloud.version < 400) {
  inboxCloud.version += 1;
  inboxCloud.records.set(`filler-${inboxCloud.version}.md`, { path: `filler-${inboxCloud.version}.md`, content: "x", deleted: true, version: inboxCloud.version });
}
inboxCloud.version = 401;
const mainCloud = vaultOf("主仓库");
mainCloud.version = 12;

// ---------------------------------------------------------------- 同步状态预写（真实形状）
const configDir = join(process.env.APPDATA ?? "", "com.quicknote.gui-test");
mkdirSync(configDir, { recursive: true });
const inboxKey = vaultStateKey(inboxVault);
const mainKey = vaultStateKey(mainVault);
const account = { serverUrl: BASE, username: USERNAME, password: PASSWORD };
const perVaultPath = join(configDir, `sync-state-${inboxKey}.json`);
const perVaultMainPath = join(configDir, `sync-state-${mainKey}.json`);
const sharedPath = join(configDir, "sync-state.json");
const sharedBackup = existsSync(sharedPath) ? readFileSync(sharedPath, "utf8") : null;
writeFileSync(
  perVaultPath,
  JSON.stringify({
    ...account,
    vault: inboxVault,
    vaultName: "",
    enabled: true,
    scope: "vault",
    cursor: 401,
    hashes,
    attachmentHashes,
    attachmentStamps,
    refreshToken: "refresh-seed",
    pendingConflicts: [],
    lastSyncAt: Date.now() - 3600_000,
  }),
  "utf8",
);
writeFileSync(
  perVaultMainPath,
  JSON.stringify({
    ...account,
    vault: mainVault,
    vaultName: "",
    enabled: true,
    scope: "vault",
    cursor: 12,
    hashes: { "首页.md": syncHashOf(Buffer.from("# 首页\n\n主仓库正文。\n", "utf8")) },
    refreshToken: "refresh-seed",
    pendingConflicts: [],
  }),
  "utf8",
);
writeFileSync(
  sharedPath,
  JSON.stringify({ ...account, enabledByVault: { [inboxKey]: true, [mainKey]: true }, refreshToken: "refresh-seed" }),
  "utf8",
);

// ---------------------------------------------------------------- CDP
let nextId = 1;
const cdp = (ws, method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (ws, expression) => {
  const r = await Promise.race([
    cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate 超时（10s）")), 10000)),
  ]);
  if (r.exceptionDetails) {
    throw new Error(`页面内异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
  }
  return r.result.value;
};
const waitFor = async (ws, expression, timeoutMs, pollMs = 300) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};
const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}`;

const spawnApp = () =>
  spawn(exe, [mainVault], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: udf,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
    detached: false,
  });

const connectApp = async () => {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      ready = list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    } catch {}
  }
  if (!ready) throw new Error("应用页面没有就绪");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener("open", resolve, { once: true });
    sock.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(sock, "Page.bringToFront");
  await waitFor(sock, `document.readyState === "complete"`, 15000);
  return sock;
};

/** 加一条速记并断言收件仓库被临时引擎推上桩。 */
const captureAndAssert = async (sock, marker, label) => {
  await evaluate(
    sock,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, altKey: true, bubbles: true }))`,
  );
  const dialogShown = await waitFor(sock, `!!document.querySelector('.quick-capture textarea')`, 8000);
  check(dialogShown, `${label}：快捷键唤起快速笔记弹窗`);
  if (!dialogShown) throw new Error(`${label}：速记弹窗没有打开`);
  // 正文带一个本地不存在的附件引用（镜像用户库里缺失贴图的速记）
  await evaluate(
    sock,
    `(() => { const el = document.querySelector('.quick-capture textarea'); (${nativeSet})(el, '自动同步验证 ${marker} 缺图 ![[Pasted image 20991231000000.png]]'); return true; })()`,
  );
  await evaluate(
    sock,
    `document.querySelector('.quick-capture-tags input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`,
  );
  await sleep(1500);

  const stamp = new Date();
  const dateName = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`;
  const inboxFile = join(inboxVault, `${dateName}.md`);
  const inboxContent = existsSync(inboxFile) ? readFileSync(inboxFile, "utf8") : "";
  check(inboxContent.includes(marker), `${label}：速记写入收件仓库文件`, JSON.stringify(inboxContent.slice(0, 120)));

  let pushed = null;
  const t0 = Date.now();
  let lastCount = -1;
  for (let i = 0; i < 90 && !pushed; i += 1) {
    await sleep(500);
    if (requests.length !== lastCount) {
      lastCount = requests.length;
      if (process.env.CAPSYNC_TRACE) console.log(`  [t+${((Date.now() - t0) / 1000).toFixed(1)}s] 桩请求 ${requests.length} 条，最新：${requests.at(-1)?.method} ${requests.at(-1)?.path}?vault=${requests.at(-1)?.vault}`);
    }
    for (const req of requests) {
      if (req.method === "POST" && req.path === "/api/v1/sync" && req.vault === "收件仓库" && req.body.includes(marker)) {
        pushed = req;
        break;
      }
    }
  }
  check(!!pushed, `${label}：收件仓库自动推送（≤45s）`, `等待 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!pushed) {
    console.log("\n-- 桩收到的请求（后 25 条）--");
    for (const req of requests.slice(-25)) console.log(`${req.method} ${req.path}?vault=${req.vault}  body[:100]=${req.body.slice(0, 100)}`);
    const statusText = await evaluate(sock, `document.querySelector('.statusbar')?.textContent ?? "(none)"`).catch(() => "?");
    console.log("statusbar:", statusText);
    // 诊断：临时轮跑完后的 per-vault 状态——cursor/哈希/冲突扣住谁是「无脏可推」的关键
    try {
      const stateNow = JSON.parse(readFileSync(perVaultPath, "utf8"));
      const hs = stateNow.hashes ?? {};
      const dateBase = inboxFile.split(/[\\/]/).pop() ?? "";
      console.log(`-- per-vault 状态：cursor=${stateNow.cursor} enabled=${stateNow.enabled} conflicts=${JSON.stringify((stateNow.pendingConflicts ?? []).map((c) => c.path))}`);
      console.log(`-- hashes[${dateBase}] = ${(hs[dateBase] ?? "(缺)").slice(0, 12)}`);
      const disk = readFileSync(inboxFile, "utf8");
      const { createHash } = await import("node:crypto");
      console.log(`-- 盘上内容哈希   = ${createHash("sha256").update(Buffer.from(disk, "utf8")).digest("hex").slice(0, 12)}（sync 口径=剥 BOM，此处无 BOM 同值）`);
      const cloud = vaultOf("收件仓库");
      console.log(`-- 桩端 vaultVersion=${cloud.version}，该文件记录版本=${cloud.records.get(dateBase)?.version ?? "(无)"}`);
    } catch (diagErr) {
      console.log("-- 诊断读取失败：", diagErr.message);
    }
  }
};

const killApp = async () => {
  try { ws?.close(); } catch {}
  ws = null;
  child?.kill();
  await sleep(800);
  try { child?.kill("SIGKILL"); } catch {}
};

let child = null;
let ws = null;
try {
  // —— 阶段 1：记忆表 true + per-vault 文件 true → 常规推送
  child = spawnApp();
  ws = await connectApp();
  await evaluate(ws, `(() => {
    localStorage.clear();
    localStorage.setItem('quicknote.settings', JSON.stringify({}));
    localStorage.setItem('quicknote.vault', ${JSON.stringify(mainVault)});
    const raw = JSON.parse(localStorage.getItem('quicknote.settings'));
    raw.quickCaptureVault = ${JSON.stringify(inboxVault)};
    raw.quickCaptureFile = '{{date}}';
    localStorage.setItem('quicknote.settings', JSON.stringify(raw));
    return true;
  })()`);
  await cdp(ws, "Page.reload").catch(() => undefined);
  const booted = await waitFor(ws, `!!document.querySelector('.tree-file')`, 30000);
  check(booted, "应用启动（文件树可见）");
  if (!booted) throw new Error("应用没有启动完成");
  await sleep(6000); // 让主仓库引擎先跑完 startup 轮（镜像真实环境：当前仓库同步开着）
  await captureAndAssert(ws, "CAPSYNC2-7", "基线");

  // —— 阶段 2：中毒场景（0.39.20 根因回归）。shared 记忆表把收件仓库显式记成
  // false（历史上某窗口快照写入的旧值），per-vault 状态文件里 enabled 仍是 true。
  // 修复前 enabledForVault 对显式 false 直接短路返回、静默跳过整轮（用户实锤
  // 「速记后收件仓库从不自动同步」）；修复后必须回落文件、照常推送。
  await killApp();
  writeFileSync(
    sharedPath,
    JSON.stringify({ ...account, enabledByVault: { [inboxKey]: false, [mainKey]: true }, refreshToken: "refresh-seed" }),
    "utf8",
  );
  child = spawnApp();
  ws = await connectApp();
  const booted2 = await waitFor(ws, `!!document.querySelector('.tree-file')`, 30000);
  check(booted2, "阶段 2 应用重启（localStorage 设置沿用）");
  if (!booted2) throw new Error("阶段 2 应用没有启动完成");
  await sleep(6000);
  await captureAndAssert(ws, "CAPSYNC-POISON", "中毒场景");

  // —— 阶段 3：0.39.26 根因回归（2026-11-19「D:\study\inbox」假仓库事故）。
  // 收件仓库路径改用 **反斜杠**（Windows 原生形态）写进 quickCaptureVault，且
  // per-vault 状态文件 vaultName 为空（0.39.22 清洗后的真实形状）。旧代码的
  // fallback `split(/[\/]/)` 切不开反斜杠 → 整条路径被当仓库名发给桩，桩端
  // vaultOf 会静默建出一个路径名假仓库；修复后必须推到 basename 仓「收件仓库」，
  // 且全程不出现任何带反斜杠的 vault 名。
  await killApp();
  const inboxVaultBackslash = inboxVault.replace(/\//g, "\\");
  child = spawnApp();
  ws = await connectApp();
  await evaluate(ws, `(() => {
    const raw = JSON.parse(localStorage.getItem('quicknote.settings') || '{}');
    raw.quickCaptureVault = ${JSON.stringify(inboxVaultBackslash)};
    localStorage.setItem('quicknote.settings', JSON.stringify(raw));
    return true;
  })()`);
  await cdp(ws, "Page.reload").catch(() => undefined);
  const booted3 = await waitFor(ws, `!!document.querySelector('.tree-file')`, 30000);
  check(booted3, "阶段 3 应用重启（收件仓库路径=反斜杠）");
  if (!booted3) throw new Error("阶段 3 应用没有启动完成");
  await sleep(6000);
  const badVaultHits = () => requests.filter((r) => r.vault && r.vault.includes("\\")).length;
  await captureAndAssert(ws, "CAPSYNC-BS", "反斜杠路径");
  check(badVaultHits() === 0, "反斜杠路径：全程没有把整条路径当仓库名发给桩", `${badVaultHits()} 条污染请求`);
  check(
    !vaults.has(inboxVaultBackslash),
    "反斜杠路径：桩端没有出现路径名假仓库",
  );

  // —— 阶段 4：0.39.26 自愈回归（云端历史被重建/删除重置）。把桩端收件仓库
  // 整个「重建」：版本倒退到 5、记录清到只剩一篇本地没有的新笔记 + 一条针对
  // 本地已有文件的墓碑。客户端游标（>400）高于桩端版本 → 下一轮必须：
  // ① 检测版本倒退、重置游标与哈希；② 全量拉取（新笔记落地本地）；
  // ③ 墓碑守卫：本地已有的文件不跟随删除、复活推回；④ 下一轮触发时全量重推
  // （哈希已清，历史文件重新上桩）。
  await killApp();
  inboxCloud.version = 0;
  inboxCloud.records.clear();
  inboxCloud.attachments.clear();
  const rebuilt = "# 重建后的新笔记\n\n云端重建后才有的内容。\n";
  inboxCloud.version += 1;
  inboxCloud.records.set("重建笔记.md", { path: "重建笔记.md", content: rebuilt, deleted: false, version: inboxCloud.version });
  const tombTarget = "2026-11-14.md";
  inboxCloud.version += 1;
  inboxCloud.records.set(tombTarget, { path: tombTarget, content: null, deleted: true, version: inboxCloud.version });
  // 重建笔记.md 本地刻意没有 → 自愈全量拉取应走 create-local 把它下载落地
  child = spawnApp();
  ws = await connectApp();
  const booted4 = await waitFor(ws, `!!document.querySelector('.tree-file')`, 30000);
  check(booted4, "阶段 4 应用重启（桩端已重建）");
  if (!booted4) throw new Error("阶段 4 应用没有启动完成");
  await sleep(6000);
  await captureAndAssert(ws, "CAPSYNC-HEAL", "自愈场景");
  check(existsSync(join(inboxVault, "重建笔记.md")), "自愈：全量拉取把云端新笔记落到了本地");
  check(existsSync(join(inboxVault, tombTarget)), "自愈墓碑守卫：本地已有文件没有被云端墓碑删掉");
  const resurrected = requests.some(
    (r) => r.method === "POST" && r.path === "/api/v1/sync" && r.vault === "收件仓库" && r.body.includes("历史速记 14"),
  );
  check(resurrected, "自愈墓碑守卫：被墓碑针对的本地文件复活推回桩端");
  await sleep(2500); // 状态落盘有 300ms 防抖，等轮次收尾
  const healed = JSON.parse(readFileSync(perVaultPath, "utf8"));
  check(healed.cursor <= inboxCloud.version + 10, "自愈：游标已从 >400 重置到桩端版本附近", `cursor=${healed.cursor}`);
  check(Object.keys(healed.hashes ?? {}).length > 0, "自愈：哈希表已重建");
  // 第二条速记触发下一轮临时引擎：此时哈希已被自愈清空，扫描应把全部历史文件重新入队推送。
  // 注意请求体是 JSON 文本，换行是字面量 `\n`（反斜杠+n），不是真实换行符——
  // 用「历史速记 1\」结尾形态匹配 2026-11-01.md（其他文件是 1X 结尾，不会误匹配）。
  await captureAndAssert(ws, "CAPSYNC-HEAL2", "自愈后重推");
  const repushed = requests.filter(
    (r) => r.method === "POST" && r.path === "/api/v1/sync" && r.vault === "收件仓库" && r.body.includes("历史速记 1\\n"),
  ).length;
  check(repushed > 0, "自愈后：哈希清空触发全量重推（历史文件重新上桩）");
  const attRepushed = requests.filter(
    (r) => r.method === "POST" && r.path === "/api/v1/sync/attachments" && r.vault === "收件仓库",
  ).length;
  check(attRepushed >= 8, "自愈后：附件哈希同样被清空重传（8 张图重新上桩）", `附件 POST ${attRepushed} 条`);
} catch (e) {
  failures += 1;
  console.log(`✗ 脚本异常：${e.message}`);
} finally {
  await killApp();
  server.close();
  rmSync(work, { recursive: true, force: true });
  rmSync(perVaultPath, { force: true });
  rmSync(perVaultMainPath, { force: true });
  if (sharedBackup === null) rmSync(sharedPath, { force: true });
  else writeFileSync(sharedPath, sharedBackup, "utf8");
}

console.log(failures === 0 ? "\n速记自动同步批测全部通过 ✓" : `\n批测失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);

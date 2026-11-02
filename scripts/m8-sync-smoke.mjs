// M8 全类型同步 × 真实后端联调冒烟（本地 daily-sync + 本地 MySQL dev 库）。
//
// 隔离纪律（用户 2026-11-03 要求）：
// - 客户端是 gui-test identifier（独立 %APPDATA%，不碰真实仓库/真实同步状态）；
// - 仓库是 H:/tmp/qn-m8-vault 一次性 fixture；云端仓库名 qn-m8-test（生产库无此名）；
// - 后端连本地 MySQL daily_sync_dev（空库），附件目录 H:/tmp/dsync-dev-attachments。
//
// 覆盖：目录扫全量上云（孤儿/非白名单）、范围外不上云、按名补下（X-Attachment-Path
// 落位）、删除传播（墓碑 deleted=1）。
//
// 前置：后端已跑在 127.0.0.1:8080（DB_HOST=127.0.0.1 DB_PORT=3309 …）；
//       gui-test exe 已构建（npm run tauri build -- --no-bundle --config …gui-test）。
// 用法：node --experimental-strip-types --no-warnings scripts/m8-sync-smoke.mjs

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeSyncState, vaultStateKey } from "../src/lib/sync.ts";
import { TODO_SYNC_PATH } from "../src/lib/todos.ts";

const EXE = "src-tauri/target/release/quick-note.exe";
const CDP_PORT = "9222";
const SERVER = "http://127.0.0.1:18080";
const VAULT_DIR = "H:/tmp/qn-m8-vault";
const VAULT_NAME = "qn-m8-vault"; // 与文件夹同名（首次加载的 vaultName 迁移会回落到文件夹名，预写同名免漂移）
const USER = "m8tester";
const PASS = "m8-test-123456";
const MYSQL = "H:/develop/MySQL/MySQL Server 8.0/bin/mysql";
const MYSQL_ARGS = ["-h127.0.0.1", "-P3309", "-uroot", "-p123456", "--default-character-set=utf8mb4", "-N", "-B", "daily_sync_dev", "-e"];

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sql = (query) =>
  execFileSync(MYSQL, [...MYSQL_ARGS.slice(0, -1), "-e", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

let __cdpId = 1;
async function cdp(method, params = {}, sessionId) {
  const ws = globalThis.__cdpWs;
  const id = __cdpId++; // CDP 协议要求整数 id：字符串 id 会被 Chromium 静默丢弃
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 10000);
    const onMsg = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evaluate(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
}
/** reload 会断掉 CDP target：重新拉 target 列表、重开 ws、带回前台。 */
async function reconnect() {
  try { globalThis.__cdpWs?.close(); } catch {}
  await sleep(1200);
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const next = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  if (!next) throw new Error("reload 后找不到页面 target");
  globalThis.__cdpWs = new WebSocket(next.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    globalThis.__cdpWs.addEventListener("open", r, { once: true });
    globalThis.__cdpWs.addEventListener("error", () => j(new Error("ws 重连失败")), { once: true });
  });
  await cdp("Page.bringToFront");
}
async function waitFor(expr, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await evaluate(expr)) return true;
    } catch {}
    if (Date.now() > end) {
      console.log(`✗ 超时等待：${label}`);
      failures += 1;
      return false;
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------- fixture
rmSync(VAULT_DIR, { recursive: true, force: true });
mkdirSync(join(VAULT_DIR, "日记"), { recursive: true });
mkdirSync(join(VAULT_DIR, "attachments"), { recursive: true });
writeFileSync(join(VAULT_DIR, "日记", "2026-11-03 测试.md"), "# 测试\n\n![[referenced.png]]\n![[云端补.png]]\n\n正文内容。\n");
writeFileSync(join(VAULT_DIR, "日记", "orphan.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
writeFileSync(join(VAULT_DIR, "日记", "清单.txt"), "M8 目录扫全量上云：txt 也该出现在云端\n");
writeFileSync(join(VAULT_DIR, "attachments", "referenced.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));

// 预写同步状态（应用启动时读，等价于用户在设置里配好+开启）。
// **必须先清场**：gui-test 目录是批测共享场，残留的共享 sync-state.json（旧 stub
// 的 serverUrl/账号）会在加载合并时**优先于 per-vault 预写**——0.27 拆分语义，
// 共享字段有值就覆盖。首跑就栽在这里：引擎一直连没人听的 9299 报 10061。
const appData = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "com.quicknote.gui-test");
mkdirSync(appData, { recursive: true });
for (const file of readdirSync(appData)) {
  if (file.startsWith("sync-state")) rmSync(join(appData, file), { force: true });
}
const stateKey = vaultStateKey(VAULT_DIR);
const state = normalizeSyncState({
  vault: VAULT_DIR,
  serverUrl: SERVER,
  username: USER,
  password: PASS,
  enabled: true,
  scope: "folder",
  vaultName: VAULT_NAME,
});
// per-vault（游标/哈希/本仓库开关）+ 共享（账号级：服务器地址、账号密码、refreshToken）
// 两份都写成本轮联调的值，杜绝任何残留串台。
writeFileSync(join(appData, `sync-state-${stateKey}.json`), JSON.stringify(state, null, 2));
writeFileSync(join(appData, "sync-state.json"), JSON.stringify(state, null, 2));
console.log(`预写状态：${join(appData, `sync-state-${stateKey}.json`)} + 共享`);

// 账号已在启动后端时注册过（register 幂等失败可忽略）
await fetch(`${SERVER}/api/v1/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASS }),
}).catch(() => {});
console.log("[step] 注册/登录");
const login = await (await fetch(`${SERVER}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASS }),
})).json();
if (login.code !== 0) {
  console.log(`✗ 后端登录失败：${login.message}`);
  process.exit(1);
}
const token = login.data.accessToken;
const uid = sql(`SELECT id FROM users WHERE username='${USER}'`);
// vault 行由客户端首次同步时 findOrCreateVault 创建，查询要延迟到首轮之后
let vaultId = "";
const attPaths = () => {
  if (!vaultId) {
    vaultId = sql(
      `SELECT id FROM vaults WHERE name='${VAULT_NAME}' AND user_id=${uid}`,
    );
    if (!vaultId) return [];
  }
  // Windows mysql CLI 行尾是 \r\n：剥掉 \r，否则数组 includes 全等匹配全挂
  return sql(`SELECT path FROM attachments WHERE vault_id=${vaultId} ORDER BY path`)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean);
};
const attDeleted = (path) =>
  vaultId ? sql(`SELECT deleted FROM attachments WHERE vault_id=${vaultId} AND path='${path}'`) : "";

// ---------------------------------------------------------------- 起应用
// WebView2 的 CDP 端口走环境变量（--remote-debugging-port 命令行参数不生效），
// 且要配独立 USER_DATA_FOLDER——与 verify-gui 批测同一套约定。
// 先清场：残留的测试实例（及其 WebView2 子进程）会占着 CDP 端口。
console.log("[step] 清场");
try { execFileSync("taskkill", ["/F", "/IM", "quick-note.exe"], { stdio: "ignore" }); } catch {}
await sleep(1500);
const udf = join(process.env.TEMP ?? "H:/tmp", "qn-m8-smoke-udf");
rmSync(udf, { recursive: true, force: true });
mkdirSync(udf, { recursive: true });
console.log("[step] spawn exe");
const exe = spawn(EXE, [], {
  cwd: process.cwd(),
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: udf,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});
try {
  // 等 CDP target 出现
  console.log("[step] 等 CDP target");
  let page = null;
  for (let i = 0; i < 40 && !page; i += 1) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    } catch {}
  }
  if (!page) throw new Error("CDP target 没出现（应用没起来？）");
  console.log("[step] ws open");
  globalThis.__cdpWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    globalThis.__cdpWs.addEventListener("open", r, { once: true });
    globalThis.__cdpWs.addEventListener("error", () => j(new Error("ws 连不上")), { once: true });
  });
  console.log("[step] bringToFront");
  await cdp("Page.bringToFront");
  console.log("[step] localStorage 写仓库");

  // 指向 fixture 仓库并 reload（localStorage 直写设置必须 reload）
  await evaluate(`localStorage.setItem('quicknote.vault', ${JSON.stringify(VAULT_DIR)}); 'ok'`);
  await evaluate(`location.reload(); 'reloading'`);
  console.log("[step] reconnect");
  await reconnect();
  console.log("[step] 等文件树");
  await waitFor(`document.querySelectorAll('.tree-item,.tree-dir').length > 0`, 15000, "文件树加载");

  // 状态栏同步应已启用（预写状态生效）——点击即手动同步一轮
  const syncOn = await waitFor(
    `document.querySelector('.statusbar .sync-status')?.className.includes('is-') ?? false`,
    8000,
    "状态栏同步按钮",
  );
  check(syncOn, "预写配置生效：状态栏同步按钮就位");
  await evaluate(`document.querySelector('.statusbar .sync-status')?.click(); 'sync clicked'`);

  // A. 目录扫全量上云：孤儿 png 与 txt 都应出现在服务端（attachments 表）
  let uploaded = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    uploaded = attPaths();
    if (uploaded.includes("日记/orphan.png") && uploaded.includes("日记/清单.txt")) break;
  }
  check(uploaded?.includes("日记/orphan.png"), "孤儿附件上云（按目录扫，无需引用）", uploaded?.join(" | "));
  check(uploaded?.includes("日记/清单.txt"), "非白名单类型上云（txt 走字节通道）");
  check(uploaded?.includes("attachments/referenced.png"), "全库范围（日记目录默认空）：范围外目录的附件也上云");
  check(!uploaded?.includes(TODO_SYNC_PATH), "todo 快照不进附件通道");

  // B. 按名补下：云端注入 attachments/云端补.png → 引擎按名取回并落到 X-Attachment-Path
  const cloudBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc, 0xdd]);
  const up = await fetch(`${SERVER}/api/v1/sync/attachments?vault=${encodeURIComponent(VAULT_NAME)}&path=${encodeURIComponent("attachments/云端补.png")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: cloudBytes,
  });
  const upJson = await up.json();
  check(upJson.code === 0, "服务端注入「云端补.png」（另一设备的上传语义）", JSON.stringify(upJson).slice(0, 120));
  await evaluate(`document.querySelector('.statusbar .sync-status')?.click(); 'sync clicked'`);
  let landed = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    landed = existsSync(join(VAULT_DIR, "attachments", "云端补.png"));
    if (landed) break;
  }
  check(landed, "本地缺的被引用文件按名补下并落位");

  // C. 删除传播（本轮真实链路）：删掉本轮刚上传的 orphan.png → 下一轮服务端墓碑。
  // （清单.txt 上一轮已推过墓碑，且本轮拉取会把云端已删应用回本地——那正是
  // 「删除传播」的拉取侧，单独按稳态断言。）
  rmSync(join(VAULT_DIR, "日记", "orphan.png"), { force: true });
  await sleep(500);
  await evaluate(`document.querySelector('.statusbar .sync-status')?.click(); 'sync clicked'`);
  let tombstoned = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    if (attDeleted("日记/orphan.png") === "1") {
      tombstoned = true;
      break;
    }
  }
  check(tombstoned, "本地删除 → 服务端墓碑（deleted=1，其他设备跟着删）");
  check(
    !existsSync(join(VAULT_DIR, "日记", "清单.txt")) && attDeleted("日记/清单.txt") === "1",
    "拉取侧墓碑应用：云端已删的文件不复活在本地（稳态）",
  );

  // 状态栏无错误（is-error 连同它的文案一起打出来，便于定位）
  const errText = await evaluate(`(() => { const el = document.querySelector('.statusbar .sync-status'); return (el?.className ?? '') + ' | ' + (el?.textContent ?? ''); })()`);
  check(!errText.includes("is-error"), "整轮同步后状态栏无错误", errText);

  console.log(`\n服务端附件清单（${VAULT_NAME}）：\n  ${attPaths().join("\n  ")}`);
} finally {
  try { exe.kill(); } catch {}
  await sleep(800);
  try { execFileSync("taskkill", ["/F", "/IM", "quick-note.exe"], { stdio: "ignore" }); } catch {}
}
console.log(`\n${failures === 0 ? "M8 联调冒烟全部通过 ✓" : `${failures} 项失败 ✗`}`);
process.exit(failures === 0 ? 0 : 1);

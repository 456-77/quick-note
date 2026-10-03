// A1 后半：Android 云同步端到端冒烟——对桩后端完成 配置 → 首推 → 云端回流拉取。
//
// 与桌面 gui-sync.mjs 的差别：
//   - 桩后端跑在宿主机 127.0.0.1，应用（模拟器）用 http://10.0.2.2:<port> 访问宿主
//     loopback（Android 模拟器固定映射），TLS 走 http——rustls/WebPki 的 https 验证
//     归真机场景（对 daily-sync 正式服务器），这里验证的是通道与接线；
//   - 仓库在共享存储（基础目录模型），文件操作直接 adb shell，不再 run-as；
//   - 同步状态文件在 Android app 配置目录，路径经 app_data_paths 命令查询后 run-as 删。
//
// 前置：模拟器运行中、应用已启动且已打开「我的笔记」仓库、adb forward 9222 已建。
// 用法：node scripts/gui-android-sync.mjs [stubPort]

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const stubPort = Number(process.argv[2] ?? 9299);
const BASE = `http://127.0.0.1:${stubPort}`;
const APP_BASE = `http://10.0.2.2:${stubPort}`;
const ENDPOINT = "http://127.0.0.1:9222/json/list";
const VAULT_DIR = "/storage/emulated/0/Documents/QuickNote/我的笔记";
const VAULT_NAME = "我的笔记";
const USERNAME = "guitest";
const PASSWORD = "GuiTest-2026";

let nextId = 1;
function cdp(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(ws, expression) {
  const result = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面内异常: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`);
  }
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function adb(cmd) {
  try {
    return execFileSync("adb", ["shell", cmd], { encoding: "utf8" }).replace(/\r/g, "");
  } catch (err) {
    // 远程命令非零退出（如 cat 不存在的文件）在轮询里是常态，返回已有输出
    return String(err.stdout ?? "");
  }
}
function shellWrite(path, bytes) {
  // 共享存储二进制安全写入：base64 解码进文件
  execFileSync("adb", ["shell", `sh -c "echo '${bytes.toString("base64")}' | base64 -d > '${path}'"`], { encoding: "utf8" });
}
let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};
async function waitFor(label, fn, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) {
      console.log(`… ${label}（${Date.now() - start}ms）`);
      return value;
    }
    await sleep(400);
  }
  return null;
}

// ---------------------------------------------------------------- 桩后端（裁剪自 gui-sync.mjs，端点形状一致）

function createStubBackend() {
  const vaults = new Map();
  const requests = [];
  const tokens = new Set(["access-1"]);
  const refreshTokens = new Set(["refresh-1"]);
  let tokenSeq = 1;
  const state = { rejectLogin: false };

  const vaultOf = (name) => {
    if (!vaults.has(name)) vaults.set(name, { version: 0, records: new Map(), attachments: [] });
    return vaults.get(name);
  };
  const injectRecord = (name, path, content) => {
    const v = vaultOf(name);
    v.version += 1;
    v.records.set(path, { path, content, deleted: false, version: v.version });
    return v.version;
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyBuffer = Buffer.concat(chunks);
      const body = bodyBuffer.toString("utf8");
      const url = new URL(req.url, BASE);
      requests.push({
        method: req.method,
        path: url.pathname,
        vault: url.searchParams.get("vault"),
        since: url.searchParams.get("since"),
        authorization: req.headers.authorization ?? "",
        body,
      });
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === "/api/v1/auth/login") {
        const parsed = JSON.parse(body || "{}");
        if (state.rejectLogin || parsed.password !== PASSWORD || parsed.username !== USERNAME) {
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
        const v = vaultOf(url.searchParams.get("vault") ?? "");
        const parsed = JSON.parse(body || "{}");
        const results = [];
        let changed = false;
        for (const item of parsed.items ?? []) {
          const existing = v.records.get(item.path);
          const identical = existing && !existing.deleted && existing.content === item.content;
          if (!identical) {
            v.version += 1;
            v.records.set(item.path, { path: item.path, content: item.content, deleted: false, version: v.version });
            changed = true;
          }
          results.push({ path: item.path, version: identical ? existing.version : v.version });
        }
        send(200, { code: 0, data: { version: v.version, results } });
        return;
      }
      if (url.pathname === "/api/v1/sync" && req.method === "GET") {
        const v = vaultOf(url.searchParams.get("vault") ?? "");
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const all = [...v.records.values()].sort((a, b) => a.version - b.version);
        const fresh = all.filter((item) => item.version > since);
        const page = fresh.slice(0, limit);
        send(200, {
          code: 0,
          data: {
            vaultVersion: v.version,
            hasMore: fresh.length > page.length,
            records: page.map(({ path, content, deleted, version }) => ({ path, content, deleted, version })),
            attachments: [],
          },
        });
        return;
      }
      send(404, { code: 404, message: `stub 未实现: ${req.method} ${url.pathname}` });
    });
  });

  return {
    start: () => new Promise((resolve) => server.listen(stubPort, "127.0.0.1", resolve)),
    stop: () => new Promise((resolve) => server.close(resolve)),
    requests,
    injectRecord,
    state,
    dump: () => {
      for (const [name, v] of vaults) {
        console.log(`  [stub] vault="${name}" version=${v.version} records=${v.records.size}: ${[...v.records.keys()].join(", ")}`);
      }
      if (vaults.size === 0) console.log("  [stub] 没有任何 vault 记录");
    },
  };
}

// ---------------------------------------------------------------- 准备

const backend = createStubBackend();
await backend.start();
console.log(`桩后端已启动：${BASE}（应用侧 ${APP_BASE}）\n`);

// 预置仓库内容：库内配置（folder=日记）+ CRLF/LF 各一篇
adb(`mkdir -p '${VAULT_DIR}/日记'`);
adb(`mkdir -p '${VAULT_DIR}/.obsidian'`);
shellWrite(`${VAULT_DIR}/quick-daily-note.json`, Buffer.from(JSON.stringify({ folder: "日记", template: "" }, null, 2)));
shellWrite(`${VAULT_DIR}/日记/同步 CRLF.md`, Buffer.from("# 首行\r\n第二行\r\n"));
shellWrite(`${VAULT_DIR}/日记/普通 LF.md`, Buffer.from("# 普通笔记\n正文行\n"));

async function connect() {
  const list = await (await fetch(ENDPOINT)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有页面目标");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  return ws;
}
const ws = await connect();

// 确认在目标仓库里；不在就导航过去（列表页路径）
const vaultNow = await evaluate(ws, `localStorage.getItem('quicknote.vault')`);
if (vaultNow !== VAULT_DIR) {
  console.log(`… 当前仓库是 ${vaultNow}，切换到 ${VAULT_DIR}`);
  await evaluate(ws, `localStorage.setItem('quicknote.vault', ${JSON.stringify(VAULT_DIR)})`);
}

// 删同步状态（Android 配置目录）→ reload：从"从未同步"开始。
// 路径不猜：run-as find 定位 sync-state.json（app_data_paths 的 CDP 序列化
// 在移动端会报 Object reference chain is too long，绕开）
const stateFind = adb(`run-as com.quicknote.app find . -name sync-state.json 2>/dev/null`);
const statePath = stateFind.split("\n").map((s) => s.trim().replace(/^\.\//, "")).filter(Boolean)[0];
if (!statePath) {
  console.log("… 无既有同步状态文件（首次）");
} else {
  adb(`run-as com.quicknote.app rm -f '${statePath}'`);
}
await cdp(ws, "Page.enable");
await cdp(ws, "Page.reload");
await sleep(4000);
await waitFor("应用重载完成", async () => !!(await evaluate(ws, `!!document.querySelector('.brand')`)));

// ---------------------------------------------------------------- 配置同步

async function openSettings() {
  const exists = await evaluate(ws, `!!document.querySelector('.settings-panel')`);
  if (!exists) {
    await evaluate(ws, `document.querySelector('.topbar .icon-btn[title^="设置"]')?.click(), true`);
    await sleep(300);
  }
  await evaluate(ws, `[...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent.includes("云同步"))?.click(), true`);
  await sleep(200);
}
async function setSetting(label, value) {
  return evaluate(ws, `(() => {
     const el = [...document.querySelectorAll('.settings-row')].find(r => r.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input,select');
     if (!el) return "no-row";
     const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
     Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
     el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
     return "ok";
   })()`);
}
async function setSettingCheckbox(label, checked) {
  return evaluate(ws, `(() => {
     const el = [...document.querySelectorAll('.settings-row')].find(r => r.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input');
     if (!el) return "no-row";
     if (el.checked !== ${checked}) el.click();
     return el.checked === ${checked} ? "ok" : "mismatch";
   })()`);
}

console.log("配置同步（服务端指向宿主 loopback）\n");
await openSettings();
check((await setSetting("服务端地址", APP_BASE)) === "ok", "填服务端地址");
check((await setSetting("账号", USERNAME)) === "ok", "填账号");
check((await setSetting("密码", PASSWORD)) === "ok", "填密码");
check((await setSetting("推送范围", "vault")) === "ok", "推送范围 = 整库");
check((await setSettingCheckbox("启用自动同步", true)) === "ok", "开启自动同步");
await sleep(400);

const ready = await waitFor(
  "同步进入就绪并完成首轮",
  async () => (await evaluate(ws, `document.querySelector('.sync-status')?.textContent ?? ""`)).includes("就绪"),
);
check(!!ready, "状态栏进入就绪状态", await evaluate(ws, `document.querySelector('.sync-status')?.textContent ?? ""`));

// 开关只切状态不触发请求（与桌面一致），点状态栏立即同步
await evaluate(ws, `document.querySelector('.sync-status')?.click(), true`);

// 诊断打印见下方失败分支（无需空定时器）
const pushed = await waitFor("桩后端收到首推", async () =>
  backend.requests.find((r) => r.path === "/api/v1/sync" && r.method === "POST" && r.body.includes("同步 CRLF")),
);
if (!pushed) {
  const status = await evaluate(ws, `document.querySelector('.sync-status')?.textContent ?? ""`);
  const summary = backend.requests.map((r) => `${r.method} ${r.path} vault=${r.vault}`).join("; ") || "(无请求)";
  console.log(`  诊断：状态栏="${status}"；stub 收到 ${backend.requests.length} 个请求 → ${summary}`);
  for (const r of backend.requests.filter((x) => x.method === "POST" && x.path === "/api/v1/sync")) {
    console.log(`  POST body: ${r.body.slice(0, 400)}`);
  }
}
check(!!pushed, "推送请求到达桩后端（vault=我的笔记）");
if (pushed) {
  const items = JSON.parse(pushed.body).items ?? [];
  const crlf = items.find((i) => i.path === "日记/同步 CRLF.md");
  check(!!crlf && crlf.content === "# 首行\r\n第二行\r\n", "CRLF 字节原样上云", JSON.stringify(crlf?.content));
  check(items.some((i) => i.path === "日记/普通 LF.md"), "LF 笔记上云");
  // reload 后复用状态文件里的持久化令牌是正确行为——有 login 才是新设备；
  // 令牌断言放在全部同步完成后（见文件末尾）
}

// 状态文件落在配置目录（不进仓库）
check(
  adb(`ls '${VAULT_DIR}/sync-state.json' 2>/dev/null || true`).trim() === "",
  "同步状态没有写进共享存储仓库",
);
check(
  adb(`run-as com.quicknote.app find . -name sync-state.json 2>/dev/null`).trim() !== "",
  "同步状态在应用私有配置目录",
);

// ---------------------------------------------------------------- 云端回流

console.log("\n云端注入新笔记，触发拉取\n");
const cloudVersion = backend.injectRecord(VAULT_NAME, "日记/云端来的.md", "# 云端注入\n\n来自桩后端。\n");
console.log(`  注入版本 ${cloudVersion}`);

// 点状态栏立即同步
await evaluate(ws, `document.querySelector('.sync-status')?.click(), true`);
const pulled = await waitFor("云端笔记落到本地", async () => {
  const out = adb(`cat '${VAULT_DIR}/日记/云端来的.md' 2>/dev/null`);
  return out.includes("云端注入") ? out : null;
});
check(!!pulled, "云端注入的笔记已拉取落盘", pulled ?? "未出现");
if (pulled) check(pulled.includes("来自桩后端"), "拉取内容完整");

// 收尾断言：整轮所有同步请求都带着持久化令牌（reload 后未重新 login 也工作）
const authed = backend.requests.filter((r) => r.path === "/api/v1/sync" && r.authorization.startsWith("Bearer access-"));
if (authed.length < 2) {
  console.log("  诊断：", backend.requests.map((r) => `${r.method} ${r.path} vault=${r.vault} auth="${r.authorization.slice(0, 20)}"`).join("\n         "));
  backend.dump();
}
check(authed.length >= 2, "同步请求携带持久化令牌且被接受", `${authed.length} 个`);

console.log(failures === 0 ? "\nSYNC_OK" : `\n${failures} 项失败`);
ws.close();
await backend.stop();
process.exit(failures === 0 ? 0 : 1);

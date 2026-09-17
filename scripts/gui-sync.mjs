// GUI 验证：云同步的完整往返——通过设置面板配置、点「立即同步」，对着一个**桩后端**跑。
//
// 为什么必须有这一层：同步的正确性有一半在"读盘 → 哈希 → 发请求 → 写回"这条链路的接线
// 上——Rust 命令的参数、响应头的传回、状态文件有没有落在仓库外、待办快照有没有接上。
// 纯逻辑测试（verify-sync.mjs）能断言决策的每个分支，但断言不了"点下去真的发出去了"。
//
// 桩后端而不是真后端：验收要在没有网络、没有 Docker 的机器上跑得完。而且这里要验证的
// 恰恰是"字节怎么进怎么出"与"状态码不被吞掉"，桩比真服务器更容易构造这些边界。
//
// 前置：应用以 --remote-debugging-port 启动（verify-gui.sh 负责），仓库由 make-test-vault.sh 生成。
// 用法：node scripts/gui-sync.mjs <vaultDir> [port] [stubPort]

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";
const stubPort = Number(process.argv[4] ?? 9299);
const BASE = `http://127.0.0.1:${stubPort}`;

/**
 * 云端仓库名。
 *
 * 应用在不填「云端仓库名」时取仓库**文件夹名**（与 Obsidian 的 `app.vault.getName()`
 * 对齐）。断言里要用同一个值，所以这里也按文件夹名推——但**不写死**成 test-vault，
 * 避免"测试通过、实际仓库名却算错了"。
 */
const VAULT_NAME = vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? vault;

/** 应用的同步状态文件（本机配置目录，**不在仓库里**）。 */
const STATE_FILE = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "com.quicknote.gui-test",
  "sync-state.json",
);

/** 库内配置：同步范围 scope=folder 时推的是它的 folder。 */
const CONFIG = join(vault, "quick-daily-note.json");
/**
 * 配置文件的备份。
 *
 * 这个脚本会**通过界面**加一条待办，而待办存在库内配置里——所以它会被改写。
 * 基线把非隐藏的 `.json` 也算在内（M2 之后就是这样），不还原就会让基线比对失败。
 * 与 gui-daily 同一个做法。
 */
const configBackup = readFileSync(CONFIG, "utf8");
const FOLDER = JSON.parse(configBackup).folder ?? "";

const USERNAME = "guitest";
const PASSWORD = "GuiTest-2026";

/** 测试创建的文件，结束时清掉（基线比对会盯着仓库字节）。 */
const created = [];
const track = (path) => {
  created.push(path);
  return path;
};

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 桩后端

/** 一个够用的 daily-sync：登录/续期、批量推送（幂等）、按版本号增量拉取。 */
function createStubBackend() {
  const vaults = new Map();
  const requests = [];
  const tokens = new Set(["access-1"]);
  const refreshTokens = new Set(["refresh-1"]);
  let tokenSeq = 1;

  /** 密码错误时用来验证"凭证问题走的是提示而不是无脑重试"。 */
  const state = { rejectLogin: false };

  const vaultOf = (name) => {
    if (!vaults.has(name)) vaults.set(name, { version: 0, records: new Map(), attachments: [] });
    return vaults.get(name);
  };

  /** 直接往云端放一条记录（模拟"别的设备推上来的"）。 */
  const injectRecord = (name, path, content) => {
    const vaultState = vaultOf(name);
    vaultState.version += 1;
    vaultState.records.set(path, {
      path,
      content,
      deleted: false,
      version: vaultState.version,
    });
    return vaultState.version;
  };

  /** 让所有 refreshToken 失效（模拟 30 天到期/被轮换作废）。 */
  const expireRefreshTokens = () => refreshTokens.clear();

  const injectTombstone = (name, path) => {
    const vaultState = vaultOf(name);
    vaultState.version += 1;
    vaultState.records.set(path, { path, content: null, deleted: true, version: vaultState.version });
    return vaultState.version;
  };

  /** 放一条附件元数据（模拟"别的设备推上来的图"），字节进 blobs。 */
  const injectAttachment = (name, path, bytes, version) => {
    const vaultState = vaultOf(name);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    vaultState.version = Math.max(vaultState.version, version);
    // 同路径重复注入（覆盖）要先清掉旧的元数据
    vaultState.attachments = vaultState.attachments.filter((a) => a.path !== path);
    vaultState.attachments.push({ path, name: path.split("/").pop(), sha256, size: bytes.length, deleted: false, version });
    blobs.set(path, bytes);
    return version;
  };

  /** 附件字节（内容寻址地存在内存里，模拟服务端的 blob 存储）。 */
  const blobs = new Map();

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyBuffer = Buffer.concat(chunks);
      // 文本按 utf8 记录方便断言 JSON；附件是二进制，必须保留原始字节——
      // 字节流转成字符串再转回来，非 ASCII 字节早就坏了（第一次实测就是这样"不一致"的）
      const body = bodyBuffer.toString("utf8");
      const url = new URL(req.url, BASE);
      const record = {
        method: req.method,
        path: url.pathname,
        rawUrl: req.url,
        vault: url.searchParams.get("vault"),
        since: url.searchParams.get("since"),
        authorization: req.headers.authorization ?? "",
        body,
        bodyBytes: bodyBuffer,
      };
      requests.push(record);

      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(text);
      };

      if (url.pathname === "/api/v1/auth/login") {
        const parsed = JSON.parse(body || "{}");
        if (state.rejectLogin || parsed.password !== PASSWORD || parsed.username !== USERNAME) {
          send(401, { code: 401, message: "账号或密码错误" });
          return;
        }
        tokenSeq += 1;
        const accessToken = `access-${tokenSeq}`;
        const refreshToken = `refresh-${tokenSeq}`;
        tokens.add(accessToken);
        refreshTokens.add(refreshToken);
        send(200, { code: 0, data: { accessToken, refreshToken, expiresIn: 7200 } });
        return;
      }

      if (url.pathname === "/api/v1/auth/refresh") {
        const parsed = JSON.parse(body || "{}");
        if (!refreshTokens.has(parsed.refreshToken)) {
          send(401, { code: 401, message: "refreshToken 已失效" });
          return;
        }
        // 一次性轮换：旧 refresh 立即作废
        refreshTokens.delete(parsed.refreshToken);
        tokenSeq += 1;
        const accessToken = `access-${tokenSeq}`;
        const refreshToken = `refresh-${tokenSeq}`;
        tokens.add(accessToken);
        refreshTokens.add(refreshToken);
        send(200, { code: 0, data: { accessToken, refreshToken, expiresIn: 7200 } });
        return;
      }

      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!tokens.has(bearer)) {
        send(401, { code: 401, message: "未登录或令牌失效" });
        return;
      }

      if (url.pathname === "/api/v1/sync" && req.method === "POST") {
        const name = url.searchParams.get("vault") ?? "";
        const vaultState = vaultOf(name);
        const parsed = JSON.parse(body || "{}");
        const results = [];
        let changed = false;
        for (const item of parsed.items ?? []) {
          const existing = vaultState.records.get(item.path);
          if (item.deleted) {
            if (existing && existing.deleted) {
              results.push({ path: item.path, status: "unchanged", version: existing.version });
              continue;
            }
            vaultState.version += 1;
            vaultState.records.set(item.path, {
              path: item.path,
              content: null,
              deleted: true,
              version: vaultState.version,
            });
            results.push({ path: item.path, status: "deleted", version: vaultState.version });
            changed = true;
            continue;
          }
          if (existing && !existing.deleted && existing.content === item.content) {
            // 幂等：内容没变就不推进版本号
            results.push({ path: item.path, status: "unchanged", version: existing.version });
            continue;
          }
          vaultState.version += 1;
          vaultState.records.set(item.path, {
            path: item.path,
            content: item.content,
            deleted: false,
            version: vaultState.version,
          });
          results.push({ path: item.path, status: "updated", version: vaultState.version });
          changed = true;
        }
        send(200, {
          code: 0,
          data: { vaultVersion: vaultState.version, changed, results },
        });
        return;
      }

      if (url.pathname === "/api/v1/sync" && req.method === "GET") {
        const name = url.searchParams.get("vault") ?? "";
        const vaultState = vaultOf(name);
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const all = [
          ...[...vaultState.records.values()].map((item) => ({ ...item, kind: "record" })),
          ...vaultState.attachments.map((item) => ({ ...item, kind: "attachment" })),
        ].sort((a, b) => a.version - b.version);
        const fresh = all.filter((item) => item.version > since);
        const page = fresh.slice(0, limit);
        send(200, {
          code: 0,
          data: {
            vaultVersion: vaultState.version,
            hasMore: fresh.length > page.length,
            records: page
              .filter((item) => item.kind === "record")
              .map(({ path, content, deleted, version }) => ({ path, content, deleted, version })),
            attachments: page
              .filter((item) => item.kind === "attachment")
              .map(({ path, name: fileName, sha256, size, deleted, version }) => ({
                path,
                name: fileName,
                sha256,
                size,
                deleted,
                version,
              })),
          },
        });
        return;
      }

      // ---- 附件接口：原始字节上传 / 下载 / 墓碑删除 ----
      if (url.pathname === "/api/v1/sync/attachments") {
        const vaultState = vaultOf(url.searchParams.get("vault") ?? "");
        const path = url.searchParams.get("path");
        const name = url.searchParams.get("name");
        const from = url.searchParams.get("from");

        if (req.method === "POST") {
          if (!path) {
            send(400, { code: 400, message: "缺少 path" });
            return;
          }
          const bytes = bodyBuffer;
          if (bytes.length === 0) {
            send(400, { code: 400, message: "空内容" });
            return;
          }
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const existing = vaultState.attachments.find((a) => a.path === path && !a.deleted);
          if (existing && existing.sha256 === sha256) {
            // 幂等：同路径同内容不推进版本号
            send(200, { code: 0, data: { path, status: "unchanged", version: existing.version } });
            return;
          }
          vaultState.version += 1;
          vaultState.attachments = vaultState.attachments.filter((a) => a.path !== path);
          vaultState.attachments.push({
            path,
            name: path.split("/").pop(),
            sha256,
            size: bytes.length,
            deleted: false,
            version: vaultState.version,
          });
          blobs.set(path, bytes);
          send(200, { code: 0, data: { path, status: "updated", version: vaultState.version } });
          return;
        }

        if (req.method === "DELETE") {
          if (!path) {
            send(400, { code: 400, message: "缺少 path" });
            return;
          }
          const existing = vaultState.attachments.find((a) => a.path === path && !a.deleted);
          if (!existing) {
            send(200, { code: 0, data: { path, status: "unchanged" } });
            return;
          }
          vaultState.version += 1;
          vaultState.attachments = vaultState.attachments.filter((a) => a.path !== path);
          vaultState.attachments.push({
            path,
            name: path.split("/").pop(),
            sha256: existing.sha256,
            size: existing.size,
            deleted: true,
            version: vaultState.version,
          });
          send(200, { code: 0, data: { path, status: "deleted", version: vaultState.version } });
          return;
        }

        if (req.method === "GET") {
          let found = null;
          let resolvedPath = null;
          if (path) {
            found = vaultState.attachments.find((a) => a.path === path && !a.deleted);
            resolvedPath = found?.path ?? null;
          } else if (name) {
            // 与服务端同一套解析：同目录优先 → 最短路径 → 字典序
            const alive = vaultState.attachments.filter(
              (a) => !a.deleted && a.name === decodeURIComponent(name),
            );
            if (from) {
              const slash = from.lastIndexOf("/");
              if (slash >= 0) {
                const candidate = `${from.slice(0, slash + 1)}${decodeURIComponent(name)}`;
                found = alive.find((a) => a.path === candidate) ?? null;
              }
            }
            if (!found) {
              found =
                [...alive].sort(
                  (a, b) =>
                    [...a.path].length - [...b.path].length || (a.path < b.path ? -1 : 1),
                )[0] ?? null;
            }
            resolvedPath = found?.path ?? null;
          }
          if (!found) {
            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ code: 404, message: "附件不存在" }));
            return;
          }
          const bytes = blobs.get(found.path) ?? Buffer.alloc(0);
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            // 与真后端一致：路径百分号编码（响应头只认 ISO-8859-1）
            "X-Attachment-Path": encodeURIComponent(resolvedPath),
            ETag: `"${found.sha256}"`,
          });
          res.end(bytes);
          return;
        }
      }

      send(404, { code: 404, message: "not found" });
    });
  });

  return {
    server,
    requests,
    vaults,
    state,
    vaultOf,
    injectRecord,
    injectTombstone,
    injectAttachment,
    expireRefreshTokens,
    /** 某条路径最近一次被推送的内容。 */
    lastPushed(name, path) {
      const pushes = requests.filter(
        (item) => item.method === "POST" && item.path === "/api/v1/sync" && item.vault === name,
      );
      for (let index = pushes.length - 1; index >= 0; index -= 1) {
        const parsed = JSON.parse(pushes[index].body || "{}");
        const found = (parsed.items ?? []).find((entry) => entry.path === path);
        if (found) return found;
      }
      return null;
    },
    pushedPaths(name) {
      const out = new Set();
      for (const request of requests) {
        if (request.method !== "POST" || request.path !== "/api/v1/sync") continue;
        if (request.vault !== name) continue;
        for (const item of JSON.parse(request.body || "{}").items ?? []) out.add(item.path);
      }
      return out;
    },
    /** 附件上传的原始字节（按查询串里的 path 找最后一次）。 */
    uploadedAttachment(name, path) {
      const wanted = `path=${encodeURIComponent(path)}`;
      const uploads = requests.filter(
        (r) =>
          r.method === "POST" &&
          r.path === "/api/v1/sync/attachments" &&
          r.vault === name &&
          r.rawUrl.includes(wanted),
      );
      const last = uploads[uploads.length - 1];
      return last ? last.bodyBytes : null;
    },
    /** 附件是否被墓碑删除过。 */
    attachmentDeleted(name, path) {
      const wanted = `path=${encodeURIComponent(path)}`;
      return requests.some(
        (r) =>
          r.method === "DELETE" &&
          r.path === "/api/v1/sync/attachments" &&
          r.vault === name &&
          r.rawUrl.includes(wanted),
      );
    },
    start() {
      return new Promise((resolve) => server.listen(stubPort, "127.0.0.1", resolve));
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------- CDP 工具

let nextId = 1;
const cdp = (ws, method, params) =>
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
  const result = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`页面内异常: ${result.exceptionDetails.text}`);
  return result.result.value;
};

async function waitFor(label, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) {
      check(false, label, "等待超时");
      return false;
    }
    await sleep(150);
  }
}

/** 输入框的值要用原生 setter 写，直接改 .value 不会触发 React 的 onChange。 */
async function typeInto(ws, selector, text) {
  const ok = await evaluate(
    ws,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return false;
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(text)});
       el.dispatchEvent(new Event("input", { bubbles: true }));
       return true;
     })()`,
  );
  if (!ok) throw new Error(`找不到输入框：${selector}`);
}

/** 按设置行的标签找控件（面板里的行顺序会变，按标签定位更稳）。 */
const rowSelector = (label) =>
  `[...document.querySelectorAll('.settings-row')].find(r => r.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input,select')`;

/**
 * 设置一个设置项的值。
 *
 * **查找、赋值、派发事件都在同一个 evaluate 里完成**，不要"先打标记再按标记取"——
 * 那样标记会留在 DOM 上，下一次 `querySelector('[data-test-target]')` 命中的是**最旧的**
 * 那个元素，于是所有值都灌进了第一个输入框（表现为"服务端地址里是密码、账号是空的"，
 * 查起来像同步配置根本没生效）。
 *
 * 用原生 setter 写值：直接改 `.value` 不会触发 React 的 onChange。
 */
async function setSetting(ws, label, value) {
  const result = await evaluate(
    ws,
    `(() => {
       const el = ${rowSelector(label)};
       if (!el) return "no-row";
       const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
       Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
       return "ok";
     })()`,
  );
  if (result !== "ok") throw new Error(`设置项不存在：${label}`);
}

async function setSettingCheckbox(ws, label, checked) {
  const result = await evaluate(
    ws,
    `(() => {
       const el = ${rowSelector(label)};
       if (!el) return "no-row";
       if (el.checked !== ${checked}) el.click();
       return el.checked === ${checked} ? "ok" : "mismatch";
     })()`,
  );
  if (result !== "ok") throw new Error(`开关没设成 ${checked}：${label}（${result}）`);
}

const clickByText = (ws, selector, text) =>
  evaluate(
    ws,
    `(() => {
       const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
         .find(b => b.textContent.trim() === ${JSON.stringify(text)});
       if (!el) return false;
       el.click();
       return true;
     })()`,
  );

const clickSyncStatus = (ws) => evaluate(ws, `document.querySelector('.sync-status').click(), true`);

const syncStatusText = (ws) => evaluate(ws, `document.querySelector('.sync-status')?.textContent ?? ''`);

const bannerText = (ws) =>
  evaluate(ws, `[...document.querySelectorAll('.banner')].map(b => b.textContent).join(' | ')`);

/** 打开设置面板（已经是打开状态就不动，免得又把它关掉）。 */
async function openSettings(ws) {
  const exists = await evaluate(ws, `!!document.querySelector('.settings-panel')`);
  if (!exists) {
    await evaluate(
      ws,
      `document.querySelector('.topbar .icon-btn[title="设置"]')?.click(), true`,
    );
    await sleep(250);
  }
  return evaluate(ws, `!!document.querySelector('.settings-panel')`);
}

/**
 * 在应用里改一个设置项。
 *
 * 改动会触发"配置变更 → 重建引擎"，是刻意的：范围与仓库名都影响行为。
 */
async function configure(ws, patch) {
  await openSettings(ws);
  if (patch.serverUrl !== undefined) await setSetting(ws, "服务端地址", patch.serverUrl);
  if (patch.username !== undefined) await setSetting(ws, "账号", patch.username);
  if (patch.password !== undefined) await setSetting(ws, "密码", patch.password);
  if (patch.scope !== undefined) await setSetting(ws, "推送范围", patch.scope);
  if (patch.enabled !== undefined) await setSettingCheckbox(ws, "启用自动同步", patch.enabled);
  await sleep(300);
}

const readStateFile = () => JSON.parse(readFileSync(STATE_FILE, "utf8"));
/** 某附件路径被上传了几次（幂等断言用）。 */
const countUploadsOf = (path) => {
  const wanted = `path=${encodeURIComponent(path)}`;
  return backend.requests.filter(
    (r) =>
      r.method === "POST" &&
      r.path === "/api/v1/sync/attachments" &&
      r.vault === VAULT_NAME &&
      r.rawUrl.includes(wanted),
  ).length;
};
const fileText = (rel) => readFileSync(join(vault, rel), "utf8");
const writeVaultFile = (rel, text) => {
  const full = join(vault, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  return full;
};
const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// ---------------------------------------------------------------- 主流程

const backend = createStubBackend();
await backend.start();
console.log(`桩后端已启动：${BASE}\n`);

/** 状态文件必须不在仓库里——它含服务端密码与令牌。 */
if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("没有找到 page 目标");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
});

// 删掉状态文件后重载页面：应用只在启动时读一次状态，重载是让它以"从未同步"开始。
// （不这么做的话，上一轮遗留的游标与哈希会让"首次同步应当推送全部"的断言莫名其妙地失败。）
await cdp(ws, "Page.enable", {});
await cdp(ws, "Page.reload", { ignoreCache: true });
await sleep(1500);
await waitFor("应用重新加载完成", async () => (await evaluate(ws, `!!document.querySelector('.brand')`)) === true);

try {
  // ---------------------------------------------------------------- 首次同步
  console.log("首次同步：把范围内的笔记推上去\n");

  const crlfPath = track(`日记/同步 CRLF.md`);
  writeVaultFile(crlfPath, "# 首行\r\n第二行\r\n");
  const bomPath = track(`日记/同步 BOM.md`);
  writeFileSync(join(vault, bomPath), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("# 带 BOM\n正文\n", "utf8"),
  ]));
  const outOfScope = track(`笔记/范围外.md`);
  writeVaultFile(outOfScope, "# 不在日记目录里\n");

  await configure(ws, {
    serverUrl: BASE,
    username: USERNAME,
    password: PASSWORD,
    scope: "folder",
    enabled: true,
  });
  // 这一步很要紧：它证明「填进设置面板的值真的进了同步状态」。
  // 曾经踩过——改配置会顺手重读一次状态文件，而那时落盘还在防抖窗口里，
  // 于是刚填的地址与账号被读回成空，界面上表现为"开关点了没反应"。
  const configuredOk = await waitFor(
    "配置生效（状态栏从「未启用」变成「已就绪」）",
    async () => (await syncStatusText(ws)).includes("就绪"),
  );
  check(configuredOk, "填完设置后同步进入就绪状态", await syncStatusText(ws));
  if (!configuredOk) {
    // 失败时把现场打出来：这是最容易"看起来像界面没接上"的一环
    console.log(
      "  现场：",
      JSON.stringify(
        await evaluate(
          ws,
          `({
             panel: !!document.querySelector('.settings-panel'),
             rows: [...document.querySelectorAll('.settings-row')]
               .filter(r => ['服务端地址','账号','密码','启用自动同步'].includes(r.querySelector('span')?.textContent))
               .map(r => { const f = r.querySelector('input'); return r.querySelector('span').textContent + '=' + (f.type === 'checkbox' ? f.checked : f.value); }),
             status: document.querySelector('.sync-status')?.textContent,
           })`,
        ),
      ),
    );
    console.log("  状态文件：", existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf8") : "(不存在)");
  }

  // 状态是防抖 300ms 后落盘的，所以这里要等，不能立刻断言文件在
  check(
    await waitFor("同步状态落到应用配置目录", async () => existsSync(STATE_FILE)),
    "同步状态写在应用配置目录",
  );
  check(
    !existsSync(join(vault, "sync-state.json")) &&
      !existsSync(join(vault, ".obsidian", "sync-state.json")),
    "同步状态**不**写进仓库（里面有服务端密码与令牌）",
  );

  await clickSyncStatus(ws);
  await waitFor("首次同步把笔记推上去", async () => backend.pushedPaths(VAULT_NAME).size >= 2);

  const pushedCrlf = backend.lastPushed(VAULT_NAME, crlfPath);
  check(pushedCrlf !== null, "CRLF 笔记被推送");
  check(
    pushedCrlf?.content === "# 首行\r\n第二行\r\n",
    "推送的内容里换行符仍是 CRLF（没有被规范化）",
    JSON.stringify(pushedCrlf?.content),
  );

  const pushedBom = backend.lastPushed(VAULT_NAME, bomPath);
  check(pushedBom !== null, "带 BOM 的笔记被推送");
  check(
    pushedBom?.content === "# 带 BOM\n正文\n",
    "推送的内容**已剥掉 BOM**（与 Obsidian 的 vault.read 一致）",
    JSON.stringify(pushedBom?.content),
  );
  check(
    readFileSync(join(vault, bomPath)).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    "但磁盘上的 BOM 原样保留（同步不改变文件字节）",
  );
  check(
    !backend.pushedPaths(VAULT_NAME).has(outOfScope),
    "日记目录之外的文件没有被推送（scope=folder）",
  );

  // 哈希口径必须与"推送出去的内容"一致——否则双方会永远互相判成已改动。
  // 状态是同步周期结束时才落盘的（300ms 防抖），所以要等它写出来。
  await waitFor(
    "同步状态落盘（含各文件哈希）",
    async () => {
      if (!existsSync(STATE_FILE)) return false;
      try {
        return readStateFile().hashes[crlfPath] === sha256("# 首行\r\n第二行\r\n");
      } catch {
        return false;
      }
    },
    10000,
  );
  const stateAfterFirst = readStateFile();
  check(
    stateAfterFirst.hashes[crlfPath] === sha256("# 首行\r\n第二行\r\n"),
    "状态里记的哈希 = 云端内容的 SHA-256（同口径）",
    JSON.stringify(stateAfterFirst.hashes[crlfPath]),
  );
  check(
    stateAfterFirst.hashes[bomPath] === sha256("# 带 BOM\n正文\n"),
    "带 BOM 的文件记的是剥掉 BOM 之后的哈希",
    JSON.stringify(stateAfterFirst.hashes[bomPath]),
  );
  await waitFor("状态栏显示同步时间", async () => /\d{2}:\d{2}/.test(await syncStatusText(ws)));

  // ---------------------------------------------------------------- 拉取
  console.log("\n拉取：云端新增/修改/删除落到本地\n");

  const remotePath = "日记/来自云端.md";
  const remoteFull = track(remotePath);
  backend.injectRecord(VAULT_NAME, remotePath, "# 云端写的\n来自另一台设备\n");
  await clickSyncStatus(ws);
  await waitFor("云端的笔记出现在本地", async () => existsSync(join(vault, remotePath)));
  check(
    fileText(remotePath) === "# 云端写的\n来自另一台设备\n",
    "云端内容逐字节写到本地",
    JSON.stringify(fileText(remotePath)),
  );
  // 文件树常驻左栏（0.3 起左右分栏），不依赖任何页签状态。
  check(
    await waitFor(
      "文件树里能看到它",
      async () => (await evaluate(ws, `document.body.innerText.includes('来自云端')`)) === true,
    ),
    "新文件出现在文件树里",
  );

  // 远端改内容 → 本地跟随（本地没动过）
  backend.injectRecord(VAULT_NAME, remotePath, "# 云端改过\n");
  await clickSyncStatus(ws);
  await waitFor("远端修改被采纳", async () => fileText(remotePath) === "# 云端改过\n");
  check(fileText(remotePath) === "# 云端改过\n", "本地没动过时采纳云端内容");

  // 远端删除 → 本地进回收目录
  backend.injectTombstone(VAULT_NAME, remotePath);
  await clickSyncStatus(ws);
  await waitFor("云端墓碑让本地文件被移走", async () => !existsSync(join(vault, remotePath)));
  check(!existsSync(join(vault, remotePath)), "云端删除后本地文件被移入回收目录");
  check(
    existsSync(join(vault, ".trash")),
    "删除走的是回收目录（不是直接抹掉）",
  );

  // ---------------------------------------------------------------- 本地修改
  console.log("\n本地修改：防抖后自动推送（不点按钮）\n");

  const localPath = track("日记/同步 CRLF.md");
  writeVaultFile(localPath, "# 首行\r\n第二行\r\n本地加了一行\r\n");
  await waitFor(
    "本地改动在防抖后被推送",
    async () => backend.lastPushed(VAULT_NAME, localPath)?.content === "# 首行\r\n第二行\r\n本地加了一行\r\n",
    8000,
  );
  check(
    backend.lastPushed(VAULT_NAME, localPath)?.content === "# 首行\r\n第二行\r\n本地加了一行\r\n",
    "本地改动自动推送到云端（3 秒防抖，无需手动）",
  );

  // ---------------------------------------------------------------- 冲突
  console.log("\n冲突：本地与云端都改过\n");

  writeVaultFile(localPath, "# 本地版本\r\n");
  backend.injectRecord(VAULT_NAME, localPath, "# 云端版本\r\n");
  await clickSyncStatus(ws);
  await waitFor(
    "冲突横幅出现",
    async () => (await bannerText(ws)).includes("本地与云端都改"),
    10000,
  );
  check(
    (await bannerText(ws)).includes("本地与云端都改"),
    "双边都改过时给出冲突提示",
    await bannerText(ws),
  );
  check(fileText(localPath) === "# 本地版本\r\n", "本地版本被保留（没被云端覆盖）");
  await waitFor(
    "冲突后本地版本被重新推上去",
    async () => backend.lastPushed(VAULT_NAME, localPath)?.content === "# 本地版本\r\n",
    10000,
  );
  check(
    backend.lastPushed(VAULT_NAME, localPath)?.content === "# 本地版本\r\n",
    "冲突后本地版本重新上传（对方会拿到它）",
  );
  // 收掉冲突横幅：它是告知性的（本地版本已经推上去了）。留着会干扰后面
  // "密码错了要报什么"这类基于横幅文本的断言。
  await clickByText(ws, ".banner button", "知道了");
  await waitFor("冲突横幅可以关掉", async () => !(await bannerText(ws)).includes("本地与云端都改"));
  check(!(await bannerText(ws)).includes("本地与云端都改"), "冲突横幅点「知道了」后消失");

  // ---------------------------------------------------------------- 待办
  console.log("\n待办：走虚拟文件（不落盘）双向同步\n");

  await evaluate(
    ws,
    `(() => {
       const tab = [...document.querySelectorAll('.sidebar-tab')].find(b => b.textContent.trim() === '日历');
       tab.click();
       return true;
     })()`,
  );
  await sleep(400);

  const todoInputSelector = ".cal-todo-add input";
  const hasTodoInput = await evaluate(ws, `!!document.querySelector(${JSON.stringify(todoInputSelector)})`);
  check(hasTodoInput, "日历面板里有待办输入框");

  if (hasTodoInput) {
    await typeInto(ws, todoInputSelector, "同步测试待办");
    await evaluate(
      ws,
      `(() => {
         const el = document.querySelector(${JSON.stringify(todoInputSelector)});
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
         return true;
       })()`,
    );
    // 等"含这条待办"的那一次推送——首次同步时快照就已经推过一次了，
    // 只等"推过"会立刻满足，拿到的是加待办之前的那份。
    await waitFor(
      "含新待办的快照被推送",
      async () => (backend.lastPushed(VAULT_NAME, "daily-sync-todos.json")?.content ?? "").includes("同步测试待办"),
      10000,
    );
    const snapshot = backend.lastPushed(VAULT_NAME, "daily-sync-todos.json");
    check(snapshot !== null, "待办变化后推送 daily-sync-todos.json（不落盘）");
    const snapshotText = snapshot?.content ?? "";
    check(snapshotText.includes("同步测试待办"), "快照里含刚加的待办");
    check(JSON.parse(snapshotText || "{}").version === 2, "快照版本是 2（与插件/网页端同一份格式）");
    check(
      !existsSync(join(vault, "daily-sync-todos.json")),
      "待办数据**没有**在仓库里落盘（虚拟文件）",
    );

    // 云端回流：另一台设备加了一条 → 合并进本地。
    //
    // 加到**界面上选中的那一天**（从 DOM 的 data-date 读，不自己算日期）——
    // 面板只渲染选中日的待办，加到别的日期桶里等于"合并成功了但看不见"。
    const selectedDate = await evaluate(
      ws,
      `document.querySelector('.cal-day.is-selected')?.getAttribute('data-date') ?? null`,
    );
    check(!!selectedDate, `读到了当前选中的日期（${selectedDate}）`);
    const merged = JSON.parse(snapshotText);
    merged.todos[selectedDate] = [
      ...(merged.todos[selectedDate] ?? []),
      { id: "from-cloud-todo", text: "云端加的待办", done: false, updatedAt: Date.now() + 1000 },
    ];
    backend.injectRecord(VAULT_NAME, "daily-sync-todos.json", JSON.stringify(merged, null, 2));
    await clickSyncStatus(ws);
    check(
      await waitFor("云端待办合并到本地界面", async () =>
        (await evaluate(ws, `document.body.innerText.includes('云端加的待办')`)) === true,
      ),
      "云端新增的待办出现在本地列表里（条目级合并）",
    );
    check(
      (await evaluate(ws, `document.body.innerText.includes('同步测试待办')`)) === true,
      "本地原有的待办没有被云端快照冲掉",
    );
    // 合并结果要写回库内配置（待办的真身在那儿），否则重启就丢了
    await waitFor("合并结果写回库内配置", async () =>
      readFileSync(CONFIG, "utf8").includes("云端加的待办"),
    );
    check(
      readFileSync(CONFIG, "utf8").includes("云端加的待办"),
      "合并结果写回库内 quick-daily-note.json（待办的真身在配置文件里）",
    );
  }

  // ---------------------------------------------------------------- 附件
  console.log("\n附件：按引用上传、按名补下、墓碑删除\n");

  // 粘贴路径：文件监听把附件路径送进引擎后，防抖 3 秒内就应上传——
  // 不需要点同步按钮。曾经只排 .md 文件，贴图要等下一轮全量扫描才上云，
  // 网页端在那几分钟里看到的是裂图。
  const pasteNote = track("日记/贴图日记.md");
  const pasteImg = track("attachments/贴图.png");
  const pasteImgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0a]);
  writeVaultFile(pasteNote, "# 贴图\n\n![[贴图.png]]\n");
  writeFileSync(join(vault, pasteImg), pasteImgBytes);
  check(
    await waitFor(
      "粘贴触发自动上传（不点同步）",
      async () =>
        Buffer.compare(
          backend.uploadedAttachment(VAULT_NAME, pasteImg) ?? Buffer.alloc(0),
          pasteImgBytes,
        ) === 0,
      15000,
    ),
    "粘贴图片后 3 秒防抖内自动上传（无需手动同步）",
  );

  // 一篇日记引用两张图：一张本地有（该被上传），一张本地没有（该从云端补下）
  const attNote = track("日记/带图日记.md");
  writeVaultFile(attNote, "# 带图\n\n![[本地的图.png]]\n\n![[云端的图.png]]\n");
  const localImg = track("attachments/本地的图.png");
  const localImgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  writeFileSync(join(vault, localImg), localImgBytes);
  track("attachments/云端的图.png"); // 它应该被同步引擎拉回来，而不是测试自己创建

  // 云端放好"云端的图"（模拟另一台设备传的）
  const cloudImgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
  const beforeCursor0 = readStateFile().cursor;
  const cloudVersion = beforeCursor0 + 1;
  backend.injectAttachment(VAULT_NAME, "attachments/云端的图.png", cloudImgBytes, cloudVersion);

  await clickSyncStatus(ws);
  await waitFor(
    "本地有、被引用的图被上传",
    async () => backend.uploadedAttachment(VAULT_NAME, localImg) !== null,
    15000,
  );
  check(
    Buffer.compare(backend.uploadedAttachment(VAULT_NAME, localImg) ?? Buffer.alloc(0), localImgBytes) === 0,
    "被引用的图原样上传（逐字节一致）",
  );
  check(
    await waitFor(
      "本地缺的图从云端补下",
      async () => existsSync(join(vault, "attachments/云端的图.png")),
      15000,
    ),
    "引用着但本地没有的图从云端拉回来了",
  );
  check(
    Buffer.compare(readFileSync(join(vault, "attachments/云端的图.png")), cloudImgBytes) === 0,
    "补下来的图逐字节一致",
  );
  // 孤儿附件（没被任何笔记引用）不上传
  const orphan = track("attachments/孤儿.png");
  writeFileSync(join(vault, orphan), Buffer.from("orphan"));
  await clickSyncStatus(ws);
  await sleep(2500);
  check(
    backend.uploadedAttachment(VAULT_NAME, orphan) === null,
    "没被引用的附件不上传（不镜像无用的二进制）",
  );
  // 已上传过的图不再重复上传（幂等：第二轮没有新的上传请求）
  const uploadsBefore = countUploadsOf(localImg);
  await clickSyncStatus(ws);
  await sleep(2500);
  check(
    countUploadsOf(localImg) === uploadsBefore,
    "没有变化的附件不重复上传（第二轮零请求）",
  );

  // 按名补下的**真正场景**：云端有图，但它的版本号已被游标越过（老设备拉过一轮），
  // 拉取流的增量里永远不会再出现它——只能靠"本地日记的引用"按名去要。
  // 之前在这里断言"发生过 name= 请求"是竞态：云端的图既可能由拉取元数据下发、
  // 也可能由按名补下取得，谁先到都合法；只有"游标外"这个场景才能确定性地测到它。
  const skipImg = track("attachments/游标外.png");
  const skipBytes = Buffer.from("below-cursor-image");
  backend.injectAttachment(
    VAULT_NAME,
    "attachments/游标外.png",
    skipBytes,
    Math.max(beforeCursor0 - 1, 1), // 故意压到当前游标之下
  );
  const skipNote = track("日记/引用游标外.md");
  writeVaultFile(skipNote, "# 引用\n\n![[游标外.png]]\n");
  await clickSyncStatus(ws);
  check(
    await waitFor(
      "游标外的图按名补下",
      async () =>
        Buffer.compare(
          existsSync(join(vault, skipImg)) ? readFileSync(join(vault, skipImg)) : Buffer.alloc(0),
          skipBytes,
        ) === 0,
      15000,
    ),
    "版本号已被游标越过的附件仍能按名从云端取回",
  );

  // ---------------------------------------------------------------- 游标
  console.log("\n游标：附件的版本号也要吃掉（否则同一页永远拉不完）\n");

  const beforeCursor = readStateFile().cursor;
  const attachmentVersion = beforeCursor + 5;
  backend.injectAttachment(
    VAULT_NAME,
    "attachments/游标推进.png",
    Buffer.from(`cursor-${attachmentVersion}`),
    attachmentVersion,
  );
  await clickSyncStatus(ws);
  await waitFor("游标越过附件版本号", async () => readStateFile().cursor >= attachmentVersion, 10000);
  check(
    readStateFile().cursor >= attachmentVersion,
    "只有附件变化的版本号也会推进游标",
  );

  // ---------------------------------------------------------------- 凭证
  console.log("\n凭证：refresh 也失效 + 密码错，要明说是凭证问题\n");

  // 两步都要做才测得到真正的凭证错误：refreshToken 有效时（30 天滚动续期）
  // 客户端会**正常续期**，根本不会拿密码去登录——那是设计如此，不是漏洞。
  backend.expireRefreshTokens();
  backend.state.rejectLogin = true;
  await configure(ws, { password: "错误的密码" });
  await clickSyncStatus(ws);
  await waitFor(
    "密码错误给出提示",
    async () => (await bannerText(ws)).includes("账号或密码错误"),
    15000,
  );
  check(
    (await bannerText(ws)).includes("账号或密码错误"),
    "refresh 失效且密码错时明确提示凭证问题（不谎报成网络故障）",
    await bannerText(ws),
  );

  backend.state.rejectLogin = false;
  await configure(ws, { password: PASSWORD });
  await clickSyncStatus(ws);
  await waitFor(
    "改回正确密码后恢复同步",
    async () => (await syncStatusText(ws)).includes("已同步"),
    15000,
  );
  check(
    (await syncStatusText(ws)).includes("已同步"),
    "改回正确密码后恢复正常同步",
    await syncStatusText(ws),
  );
} finally {
  // 库内配置被改过（加了一条待办）→ 原样还原
  try {
    writeFileSync(CONFIG, configBackup);
  } catch {
    /* 清理失败不影响结论，基线比对会报出来 */
  }
  // 清掉测试创建的文件：基线比对会盯着仓库字节。
  for (const path of created) {
    const full = path.startsWith(vault) ? path : join(vault, path);
    try {
      if (existsSync(full)) unlinkSync(full);
    } catch {
      /* 清理失败不影响结论，基线比对会报出来 */
    }
  }
  // 被墓碑删掉的笔记会进回收目录，一并清掉（只清这一轮产生的，不动别处）
  for (const name of ["来自云端.md", "来自云端 1.md", "来自云端 2.md"]) {
    const full = join(vault, ".trash", name);
    try {
      if (existsSync(full)) unlinkSync(full);
    } catch {
      /* 同上 */
    }
  }
  try {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  } catch {
    /* 同上 */
  }
  ws.close();
  await backend.stop();
}

console.log(failures === 0 ? "\n云同步界面验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

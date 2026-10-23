// 0.32.2 第二批验收：分栏分界线拖动 + 服务器仓库选择（菜单渲染/已落地识别）。
// 前置：gui-test 变体 exe 已构建。自起实例（独立 UDF + 独立 CDP 端口 + 临时仓库
// + 桩同步后端），结束时自清理。
//
// 覆盖：
// - 分栏分界线：拖动改变右栏占比（内联 flexBasis）并落盘 localStorage
// - 仓库下拉的「服务器仓库」组：配置账号后列出云端仓库（桩后端 /api/v1/vaults）
// - 已落地过滤：与当前仓库同名的云端仓库不列出（0.32.2 第二轮反馈）
// - 快捷键系统占用检测：invoke 三态（本程序注册的=own；冷门组合=free）
// - 未配置账号：菜单显示「配置云同步后…」引导
//
// 落地流程的目录选择是系统对话框（pickDirectory），自动化点不了——
// ensure_directory 的建目录/非空拦截由 Rust 单测覆盖，端到端落地留用户手工测试。

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const port = process.argv[2] ?? "9474";
const stubPort = process.argv[3] ?? "9484";
const root = process.cwd();
const exe = join(root, "src-tauri", "target", "release", "quick-note.exe");
if (!existsSync(exe)) {
  console.error(`找不到 ${exe}——先跑 verify-gui.sh 的构建步骤（gui-test 变体）`);
  process.exit(2);
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

const waitFor = async (ws, expression, timeoutMs, pollMs = 400) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};

const mouse = (ws, type, x, y, extra = {}) =>
  cdp(ws, "Input.dispatchMouseEvent", { type, x, y, button: type === "mousePressed" || type === "mouseReleased" ? "left" : "none", ...extra });

// ------------------------------------------------ 桩同步后端（login + vaults + sync）

const CLOUD_VAULTS = [
  { name: "云仓A", version: 3 },
  { name: "云仓B", version: 1 },
];

const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, json) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(json));
    };
    if (url.pathname === "/api/v1/auth/login") {
      send(200, { code: 0, data: { accessToken: "stub", refreshToken: "stub-r", expiresIn: 7200 } });
      return;
    }
    if (url.pathname === "/api/v1/vaults") {
      send(200, { code: 0, data: CLOUD_VAULTS });
      return;
    }
    if (url.pathname === "/api/v1/sync" && req.method === "GET") {
      send(200, { code: 0, data: { vaultVersion: 0, hasMore: false, records: [], attachments: [] } });
      return;
    }
    if (url.pathname === "/api/v1/sync" && req.method === "POST") {
      send(200, { code: 0, data: { accepted: 0, version: 0 } });
      return;
    }
    send(404, { code: 404, message: "not found" });
  });
});

// ------------------------------------------------ 自备数据

const work = join(tmpdir(), `qn-034-${Date.now()}`);
mkdirSync(work, { recursive: true });
// 启动仓库目录名 = 云端同名（已落地识别的用例）
const vault = join(work, "云仓A").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, "本地笔记.md"), ["# 本地笔记", "", "内容。"].join("\n"), "utf8");
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

// 同步账号（桩地址）：写到应用配置目录的 sync-state.json
const appConfig = join(process.env.APPDATA ?? "", "com.quicknote.gui-test");
mkdirSync(appConfig, { recursive: true });
const syncStateFile = join(appConfig, "sync-state.json");
const hadSyncState = existsSync(syncStateFile);
writeFileSync(
  syncStateFile,
  JSON.stringify(
    {
      vault: "",
      serverUrl: `http://127.0.0.1:${stubPort}`,
      username: "stub-user",
      password: "stub-pass",
      enabled: false,
      scope: "vault",
      vaultName: "",
      cursor: 0,
      hashes: {},
      attachmentHashes: {},
      attachmentStamps: {},
      lastSyncAt: 0,
      refreshToken: "",
      pendingConflicts: [],
      enabledByVault: {},
    },
    null,
    2,
  ),
  "utf8",
);

const spawnInstance = () =>
  spawn(exe, [vault], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: udf,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
    detached: false,
  });

const connectPage = async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  if (!page) throw new Error("没有找到 page 目标");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  return ws;
};

let child = null;
let ws = null;

const openVaultMenu = async () => {
  await evaluate(ws, `(() => { const pill = document.querySelector('.vault-pill'); if (!pill) return false; pill.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); pill.click(); return true; })()`);
};

try {
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });
  await new Promise((resolve) => stub.listen(stubPort, "127.0.0.1", resolve));

  const booted = await (async () => {
    child = spawnInstance();
    for (let i = 0; i < 60; i += 1) {
      await sleep(1000);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        if (list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"))) return true;
      } catch {}
    }
    return false;
  })();
  if (!booted) throw new Error("应用没有就绪");
  ws = await connectPage();
  const treeOk = await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 30000);
  if (!treeOk) throw new Error("文件树没有就绪");
  await sleep(1500); // 等 useSync 读盘加载配置

  // ============================================== 1. 服务器仓库组（已配置账号）
  {
    await openVaultMenu();
    const menuUp = await waitFor(ws, `!!document.querySelector('.vault-menu')`, 5000);
    check(menuUp, "仓库下拉菜单打开");
    const listed = await waitFor(ws, `(() => {
      const names = [...document.querySelectorAll('.vault-menu .vault-menu-name')].map((el) => el.textContent);
      return names.includes('云仓B') ? names.join('|') : false;
    })()`, 8000);
    check(!!listed, "「服务器仓库」组列出云端仓库（桩 /api/v1/vaults）", String(listed));
    // 0.32.2 第二轮反馈：本地已有的仓库**直接过滤**（不再显示徽标条目）——
    // 当前仓库目录名「云仓A」与云端同名 → 不出现在服务器仓库组；云仓B 出现
    const filtered = await waitFor(ws, `(() => {
      const names = [...document.querySelectorAll('.vault-menu .vault-menu-name')].map((el) => el.textContent);
      return !names.includes('云仓A') && names.includes('云仓B') ? names.join('|') : false;
    })()`, 8000);
    check(!!filtered, "本地已有的云端仓库被过滤（云仓A 不列出），只显示可落地的（云仓B）", String(filtered));
    // 等待本机同步状态扫描完成后复查一遍（vaultName 层的识别也要参与过滤）
    await sleep(1200);
  }

  // ============================================== 2. 未配置账号的引导
  {
    // 抹掉账号（直接改状态文件 + reload 太重；用 UI 状态内 config 判定分支验证：
    // 把 serverUrl 写空需要走设置面板——这里改为断言「配置云同步后…」条目在
    // 未配置时的渲染，通过清空 sync-state.json 后重启实现）
    await evaluate(ws, `window.close ? true : true`).catch(() => false);
    try { ws.close(); } catch {}
    child.kill();
    await sleep(1500);
    writeFileSync(
      syncStateFile,
      JSON.stringify(
        {
          vault: "", serverUrl: "", username: "", password: "",
          enabled: false, scope: "vault", vaultName: "", cursor: 0,
          hashes: {}, attachmentHashes: {}, attachmentStamps: {},
          lastSyncAt: 0, refreshToken: "", pendingConflicts: [], enabledByVault: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const second = await (async () => {
      child = spawnInstance();
      for (let i = 0; i < 60; i += 1) {
        await sleep(1000);
        try {
          const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
          if (list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"))) return true;
        } catch {}
      }
      return false;
    })();
    if (!second) throw new Error("第二次启动没有就绪");
    ws = await connectPage();
    await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 30000);
    await sleep(1500);
    await openVaultMenu();
    const guide = await waitFor(ws, `[...document.querySelectorAll('.vault-menu .vault-menu-name')].some((el) => (el.textContent ?? '').includes('配置云同步后'))`, 5000);
    check(guide, "未配置账号时显示「配置云同步后可从服务器选择仓库…」引导");
  }

  // ============================================== 2.5 快捷键系统占用检测（命令层）
  {
    // 本程序注册的截图键（默认 Ctrl+Alt+G）：register 报 already → own；
    // own 名单里传它也标 own；冷门组合几乎不可能被占 → free
    const result = await evaluate(ws, `window.__TAURI_INTERNALS__.invoke('check_hotkey_conflicts', { combos: ['Ctrl+Alt+G', 'Ctrl+Alt+Shift+F12'], own: ['Ctrl+Alt+G'] })`);
    const map = Object.fromEntries((result ?? []).map((item) => [item.combo, item.status]));
    check(map["Ctrl+Alt+G"] === "own", "本程序注册的组合标 own（不算冲突）", JSON.stringify(map));
    check(map["Ctrl+Alt+Shift+F12"] === "free", "冷门组合探测为 free（注册成功即还原）", JSON.stringify(map));
  }

  // ============================================== 2.6 快捷键面板的占用检测 UI
  {
    // 打开设置 → 快捷键分区：面板挂载即自动检测；按钮在检测完成后回到可点状态
    await evaluate(ws, `(() => { const isOpen = document.querySelector('.settings-panel') !== null; if (!isOpen) document.querySelector('.topbar .icon-btn[title^="设置"]')?.click(); return true; })()`);
    await sleep(600);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((x) => x.textContent.includes('快捷键')); b?.click(); return !!b; })()`);
    const detectBtn = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.hotkey-head-actions .hotkey-action')].find((x) => (x.textContent ?? '').includes('检测系统占用')); return b ? { disabled: b.disabled, text: b.textContent } : null; })()`, 8000);
    check(!!detectBtn, "快捷键面板有「检测系统占用」按钮", JSON.stringify(detectBtn));
    const done = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.hotkey-head-actions .hotkey-action')].find((x) => (x.textContent ?? '').includes('检测系统占用')); return b && !b.disabled ? true : false; })()`, 15000);
    check(done, "面板打开自动检测完成（按钮从检测中恢复可点）");
    // 再手动点一次：重跑不报错
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.hotkey-head-actions .hotkey-action')].find((x) => (x.textContent ?? '').includes('检测系统占用')); b?.click(); return !!b; })()`);
    const redone = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.hotkey-head-actions .hotkey-action')].find((x) => (x.textContent ?? '').includes('检测系统占用')); return b && !b.disabled ? true : false; })()`, 15000);
    check(redone, "手动重跑检测正常");
    // 关设置
    await evaluate(ws, `(() => { document.querySelector('.settings-panel [title*="关闭"], .settings-close')?.click(); const any = [...document.querySelectorAll('button')].find((b) => (b.title ?? '').includes('关闭设置')); any?.click(); return true; })()`);
    await sleep(400);
  }

  // ============================================== 3. 分栏分界线拖动
  {
    // newTab 开两篇，把一篇移到右栏，然后拖分界线
    await evaluate(ws, `(() => { const k='quicknote.settings'; const s=JSON.parse(localStorage.getItem(k) ?? '{}'); s.openNoteMode='newTab'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
    await evaluate(ws, `location.reload()`);
    await sleep(2500);
    try { ws.close(); } catch {}
    {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("ws 重连失败")), { once: true });
      });
      await cdp(ws, "Page.bringToFront");
      await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 20000);
    }
    // 第二篇笔记
    writeFileSync(join(vault, "拖动用.md"), ["# 拖动用", "", "内容。"].join("\n"), "utf8");
    await sleep(600);
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('本地笔记')); t?.click(); return !!t; })()`);
    await waitFor(ws, `(window.__qnView?.state.doc.toString() ?? '').includes('本地笔记')`, 8000);
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('拖动用')); t?.click(); return !!t; })()`);
    await waitFor(ws, `(window.__qnView?.state.doc.toString() ?? '').includes('拖动用')`, 8000);
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tabbar:not(.is-split) [role="tab"]')].find((el) => el.textContent.includes('本地笔记')); t?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 120 })); return !!t; })()`);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.context-menu button')].find((el) => (el.textContent ?? '').includes('分屏到右侧')); b?.click(); return !!b; })()`);
    const splitUp = await waitFor(ws, `!!document.querySelector('.pane-divider') && !!document.querySelector('.editor-pane-col.is-split')`, 8000);
    check(splitUp, "分栏出现（分界线就位）");
    const before = await evaluate(ws, `(() => { const el = document.querySelector('.editor-pane-col.is-split'); const d = document.querySelector('.pane-divider'); return { basis: el.style.flexBasis, dx: Math.round(d.getBoundingClientRect().left + d.getBoundingClientRect().width / 2), dy: Math.round(d.getBoundingClientRect().top + d.getBoundingClientRect().height / 2) }; })()`);
    // CDP 拖动：mousePressed → 数次 mouseMoved（Chromium 会合成 pointer 事件）→ mouseReleased
    await mouse(ws, "mousePressed", before.dx, before.dy, { clickCount: 1 });
    for (let i = 1; i <= 12; i += 1) {
      await mouse(ws, "mouseMoved", before.dx + i * 12, before.dy);
      await sleep(30);
    }
    await mouse(ws, "mouseReleased", before.dx + 144, before.dy, { clickCount: 1 });
    await sleep(500);
    const after = await evaluate(ws, `(() => ({ basis: document.querySelector('.editor-pane-col.is-split').style.flexBasis, saved: localStorage.getItem('quicknote.splitRatio') }))()`);
    check(after.basis !== before.basis && after.basis.length > 0, `拖动分界线改变右栏占比（${before.basis || "42%默认"} → ${after.basis}）`, JSON.stringify(after));
    check(!!after.saved, "拖动结束占比落盘 localStorage（下次启动记住）", JSON.stringify(after));
    // 还原设置
    await evaluate(ws, `(() => { const k='quicknote.settings'; const s=JSON.parse(localStorage.getItem(k) ?? '{}'); s.openNoteMode='replace'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  }
} catch (error) {
  failures += 1;
  console.error(`批测异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    ws?.close();
  } catch {}
  child?.kill();
  stub.close();
  await sleep(800);
  try {
    if (!hadSyncState) rmSync(syncStateFile, { force: true });
  } catch {}
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

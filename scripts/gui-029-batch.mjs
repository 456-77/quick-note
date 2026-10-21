// 0.29 批次验收：本轮 7 项反馈的桌面端关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 + 临时
// 仓库），结束时自清理。
//
// 覆盖：
// - 标签详情头部：📌/✎ 常驻按钮收进单个右对齐 ⋯ 菜单（0.29 反馈「进入标签
//   为什么还有置顶和重命名图标」）
// - 背景图「界面浓度」：html 上写入 --qn-veil-* 变量、滑杆实时改值
//   （0.29 反馈「不透明度拉满背景还是淡」——表面底色此前写死在 CSS 里）
// - 背景图片下拉不截断：菜单宽度算死、右缘对齐触发器、整体在视口内
//   （0.29 反馈「背景图片下拉框选择出现了截断」）
// - 全局搜索跨仓库：最近仓库参与内容检索、当前仓库结果排最前、点其他仓库的
//   命中先切仓库再打开（0.29 反馈「全局搜索支持搜索账户下的所有仓库」）
// - 单词本云同步：本机词推上专用云端仓 quick-note-vocab、云端词拉下来合并
//   （0.29 反馈「daily sync 添加支持同步单词本」；桩后端不需要真服务器）

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const port = process.argv[2] ?? "9399";
const stubPort = Number(process.argv[3] ?? 9499);
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

const waitFor = async (ws, expression, timeoutMs, pollMs = 500) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};

const key = (ws, combo, code, keyCode) =>
  cdp(ws, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: combo.mod,
    key: combo.key,
    code,
    windowsVirtualKeyCode: keyCode,
  }).then(() =>
    cdp(ws, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: combo.mod,
      key: combo.key,
      code,
      windowsVirtualKeyCode: keyCode,
    }),
  );
// Chromium CDP modifiers 位：Alt=1 Ctrl=2 Meta=4 Shift=8
const CTRL = 2;

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}`;

// ------------------------------------------------ 自备数据：两个临时仓库

const work = join(tmpdir(), `qn-029-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vaultA = join(work, "主库A").replace(/\\/g, "/");
const vaultB = join(work, "跨库B").replace(/\\/g, "/");
mkdirSync(vaultA, { recursive: true });
mkdirSync(vaultB, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

const nameOf = (dir) => dir.replace(/\/+$/, "").split("/").pop();

// 主库：带标签的笔记（标签行固定第 3 行）+ 背景图 + 搜索令牌
writeFileSync(
  join(vaultA, "qn29标签源.md"),
  ["# 标签源", "", "#qn29tag", "", "正文。"].join("\n"),
  "utf8",
);
writeFileSync(
  join(vaultA, "qn29主笔记.md"),
  ["# 主库笔记", "", "这里是 qn29令牌 所在的正文。"].join("\n"),
  "utf8",
);
writeFileSync(
  join(vaultA, "qn29bg.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
// 跨库：只有内容命中（没有同名文件），令牌与主库相同 → 验证当前库排前
writeFileSync(
  join(vaultB, "qn29跨库笔记.md"),
  ["# 跨库笔记", "", "跨库 B 里也有 qn29令牌 的正文。"].join("\n"),
  "utf8",
);

/** 本机配置目录（gui-test 变体独立）。 */
const appConfig = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "com.quicknote.gui-test",
);
const vocabFile = join(appConfig, "vocabulary.md");
const vocabStateFile = join(appConfig, "sync-state-vocab.json");
// 种子本机词库：vocab 同步的「本机 → 云端」方向要有内容可推
mkdirSync(appConfig, { recursive: true });
writeFileSync(
  vocabFile,
  ["# 单词本", "", "## 待学习", "", "- 本地词qn29 — 2026-10-21 · 批测", "", "## 已掌握", "", ""].join("\n"),
  "utf8",
);

// ------------------------------------------------ 桩后端（够 vocab 同步用）

function createStubBackend() {
  const vaults = new Map();
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyRaw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://127.0.0.1");
      const vault = url.searchParams.get("vault") ?? "";
      const record = {
        method: req.method,
        path: url.pathname,
        vault,
        body: bodyRaw,
      };
      requests.push(record);
      const send = (status, json) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(json));
      };

      if (url.pathname === "/api/v1/auth/login") {
        send(200, { code: 0, data: { accessToken: "stub-access", refreshToken: "stub-refresh", expiresIn: 7200 } });
        return;
      }
      if (url.pathname === "/api/v1/auth/refresh") {
        send(200, { code: 0, data: { accessToken: "stub-access-2", refreshToken: "stub-refresh-2", expiresIn: 7200 } });
        return;
      }
      if (url.pathname === "/api/v1/sync" && req.method === "POST") {
        const state = vaults.get(vault) ?? { version: 0, records: new Map() };
        const parsed = JSON.parse(bodyRaw || "{}");
        for (const item of parsed.items ?? []) {
          if (item.deleted) state.records.delete(item.path);
          else state.records.set(item.path, { path: item.path, content: item.content ?? "", deleted: false });
          state.version += 1;
        }
        vaults.set(vault, state);
        send(200, { code: 0, data: { accepted: (parsed.items ?? []).length, version: state.version } });
        return;
      }
      if (url.pathname === "/api/v1/sync" && req.method === "GET") {
        const state = vaults.get(vault) ?? { version: 0, records: new Map() };
        vaults.set(vault, state);
        const since = Number(url.searchParams.get("since") ?? 0);
        const records = [...state.records.values()].map((item, index) => ({
          ...item,
          version: since + index + 1,
        }));
        send(200, {
          code: 0,
          data: { vaultVersion: state.version, hasMore: false, records, attachments: [] },
        });
        return;
      }
      send(404, { code: 404, message: "not found" });
    });
  });
  return {
    server,
    requests,
    vaults,
    /** 手动往云端仓里塞一条记录（模拟另一台设备推的内容）。 */
    injectRecord(vaultName, record) {
      const state = vaults.get(vaultName) ?? { version: 0, records: new Map() };
      state.records.set(record.path, { path: record.path, content: record.content, deleted: false });
      state.version = Math.max(state.version + 1, record.version ?? 1);
      vaults.set(vaultName, state);
    },
    lastPushed(vaultName, path) {
      const pushes = requests.filter(
        (item) => item.method === "POST" && item.path === "/api/v1/sync" && item.vault === vaultName,
      );
      for (let index = pushes.length - 1; index >= 0; index -= 1) {
        const parsed = JSON.parse(pushes[index].body || "{}");
        const found = (parsed.items ?? []).find((entry) => entry.path === path);
        if (found) return found;
      }
      return null;
    },
    start() {
      return new Promise((resolve) => server.listen(stubPort, "127.0.0.1", resolve));
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const BASE = `http://127.0.0.1:${stubPort}`;

const spawnInstance = () =>
  spawn(exe, [vaultA], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: udf,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
    detached: false,
  });

const connectPage = async (matchIndex = 0) => {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const pages = targets.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  const page = pages[matchIndex];
  if (!page) throw new Error(`没有找到 page 目标（${pages.length} 个）`);
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
const backend = createStubBackend();

try {
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });
  // 清掉上一轮批测的同步状态与词库同步状态（本机词库种子在上面已重写）
  try {
    if (existsSync(appConfig)) {
      for (const name of readdirSync(appConfig)) {
        if (name.startsWith("sync-state")) rmSync(join(appConfig, name), { force: true });
      }
    }
  } catch {}
  rmSync(join(appConfig, "open-vaults.json"), { force: true });
  await backend.start();

  child = spawnInstance();
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      ready = list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    } catch {}
  }
  if (!ready) throw new Error("应用页面没有就绪");
  ws = await connectPage();
  await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 30000);

  // ============================================== 1. 标签详情头部：📌/✎ 收进 ⋯
  {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn29标签源')); t?.click(); return !!t; })()`);
    await waitFor(ws, `document.querySelectorAll('.cm-line').length > 0`, 10000);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.left-view-tab')].find((el) => el.textContent.includes('标签')); b?.click(); return !!b; })()`);
    await waitFor(ws, `document.querySelectorAll('.tag-dash-row').length > 0`, 15000);
    const entered = await evaluate(ws, `(() => { const row = [...document.querySelectorAll('.tag-dash-row')].find((el) => el.textContent.includes('qn29tag')); row?.click(); return !!row; })()`);
    const headReady = entered && await waitFor(ws, `!!document.querySelector('.tag-dash-head')`, 5000);
    const head = await evaluate(ws, `(() => {
      const head = document.querySelector('.tag-dash-head');
      if (!head) return null;
      const acts = [...head.querySelectorAll('button')];
      return { text: head.textContent, actCount: acts.length, actTexts: acts.map((b) => b.textContent.trim()) };
    })()`);
    check(headReady && head && head.actCount === 1, "详情头部只剩一个操作按钮（不再常驻 📌/✎）", JSON.stringify(head));
    check(head && head.actTexts[0] === "⋯", "头部操作按钮是右对齐的 ⋯", JSON.stringify(head?.actTexts));
    check(head && !head.text.includes("📌") && !head.text.includes("✎"), "头部不再有 📌/✎ 图标", JSON.stringify(head));
    if (head && head.actCount === 1) {
      await evaluate(ws, `document.querySelector('.tag-dash-head button')?.click(), true`);
      const menu = await waitFor(ws, `document.querySelector('.tag-dash-menu')?.textContent ?? false`, 3000);
      check(!!menu && menu.includes("置顶") && menu.includes("重命名"), "头部 ⋯ 菜单含置顶/重命名", String(menu));
      await evaluate(ws, `(() => { document.querySelector('.menu-backdrop')?.click(); return true; })()`);
    }
  }

  // ============================================== 2. 背景：界面浓度变量
  {
    await key(ws, { mod: CTRL, key: "," }, "Comma", 188);
    await waitFor(ws, `!!document.querySelector('[data-sec="appearance"]')`, 8000);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('外观')); b?.click(); return !!b; })()`);
    await sleep(300);
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === '启用背景图片');
      const cb = row?.querySelector('input[type=checkbox]');
      if (cb && !cb.checked) cb.click();
      return !!cb;
    })()`);
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === '背景图片');
      const sel = row?.querySelector('select');
      if (!sel) return 'no-select';
      const opt = [...sel.options].find((o) => o.value.includes('qn29bg.png'));
      if (!opt) return 'no-option';
      const set = ${nativeSet}; set(sel, opt.value);
      return 'ok';
    })()`);
    await waitFor(ws, `!!document.getElementById('qn-bg-layer')`, 5000);
    // html.qn-bg-on 挂上后，界面浓度变量应以默认 80% 写入（80 = 0.28 默认观感）
    const veilDefault = await evaluate(ws, `(() => {
      const root = document.documentElement;
      return {
        on: root.classList.contains('qn-bg-on'),
        editor: root.style.getPropertyValue('--qn-veil-editor'),
        side: root.style.getPropertyValue('--qn-veil-side'),
        panel: root.style.getPropertyValue('--qn-veil-panel'),
      };
    })()`);
    check(
      veilDefault.on && veilDefault.editor === "80%" && veilDefault.side === "66%" && veilDefault.panel === "82%",
      "启用背景后写入界面浓度变量（默认 80/66/82 同旧观感）",
      JSON.stringify(veilDefault),
    );
    const surfaceRow = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === '界面浓度');
      const input = row?.querySelector('input[type=range]');
      if (!input) return 'no-row';
      const set = ${nativeSet}; set(input, "40");
      return 'ok';
    })()`);
    check(surfaceRow === "ok", "设置里出现「界面浓度」滑杆并可调");
    await sleep(400);
    const veilLow = await evaluate(ws, `(() => {
      const root = document.documentElement;
      return { editor: root.style.getPropertyValue('--qn-veil-editor'), layerOpacity: document.getElementById('qn-bg-layer')?.style.opacity };
    })()`);
    check(
      veilLow.editor === "40%",
      "界面浓度调低后表面变量实时跟随（背景透出来）",
      JSON.stringify(veilLow),
    );
    check(
      veilLow.layerOpacity === "0.35",
      "图层不透明度不受界面浓度影响（两者是独立的旋钮，默认仍 0.35）",
      String(veilLow.layerOpacity),
    );
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('通用')); b?.click(); return !!b; })()`);
  }

  // ============================================== 3. 背景图片下拉不截断
  {
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('外观')); b?.click(); return !!b; })()`);
    await sleep(300);
    const opened = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === '背景图片');
      row?.querySelector('.settings-select-trigger')?.click();
      return !!row;
    })()`);
    const menuReady = await waitFor(ws, `!!document.querySelector('.settings-select-menu')`, 3000);
    // 等入场动画（rise-in 0.12s）播完再量，避免动画中途的变换污染矩形
    await sleep(300);
    const box = await evaluate(ws, `(() => {
      const m = document.querySelector('.settings-select-menu');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      const trigger = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')]
        .find((row) => row.querySelector('span')?.textContent === '背景图片')
        ?.querySelector('.settings-select-trigger');
      const tr = trigger?.getBoundingClientRect();
      return {
        left: r.left, right: r.right, width: r.width,
        inner: window.innerWidth,
        triggerRight: tr ? tr.right : null,
        clipped: r.right > window.innerWidth - 1 || r.left < 0,
        firstOption: m.querySelector('[role=option]')?.textContent ?? "",
        title: m.querySelector('[role=option]')?.getAttribute('title') ?? "",
      };
    })()`);
    check(opened && menuReady && box, "背景图片下拉打开", JSON.stringify(box));
    check(box && !box.clipped, "下拉菜单整体在视口内（不再被窗口右缘裁掉）", JSON.stringify(box));
    check(
      box && box.triggerRight !== null && Math.abs(box.right - box.triggerRight) <= 2,
      "下拉菜单右缘与触发器右缘对齐",
      `menu.right=${box?.right} trigger.right=${box?.triggerRight}`,
    );
    // 关掉菜单（再点一次触发器收起），并还原背景开关（别让背景层影响后续断言）
    await evaluate(ws, `(() => { document.querySelector('.settings-select-trigger')?.click(); return true; })()`);
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === '启用背景图片');
      const cb = row?.querySelector('input[type=checkbox]');
      if (cb?.checked) cb.click();
      return true;
    })()`);
    await sleep(300);
    await evaluate(ws, `(() => { document.querySelector('.topbar .icon-btn[title^="设置"]')?.click(); return true; })()`);
    await sleep(300);
  }

  // ============================================== 4. 全局搜索跨仓库
  {
    // 种最近仓库 + 重载：paletteVaults = [当前库, ...recents]
    await evaluate(ws, `localStorage.setItem('quicknote.vaultRecents', JSON.stringify([${JSON.stringify(vaultB)}])), true`);
    await cdp(ws, "Page.enable", {});
    await cdp(ws, "Page.reload", { ignoreCache: true });
    await sleep(1500);
    await waitFor(ws, `!!document.querySelector('.brand')`, 20000);
    await waitFor(ws, `document.querySelectorAll('.tree-item').length > 0`, 30000);
    await key(ws, { mod: CTRL, key: "k" }, "KeyK", 75);
    await waitFor(ws, `!!document.querySelector('.palette-input')`, 5000);
    await evaluate(ws, `(() => {
      const input = document.querySelector('.palette-input');
      const set = ${nativeSet}; set(input, "qn29令牌");
      return true;
    })()`);
    const listed = await waitFor(ws, `(() => {
      const items = [...document.querySelectorAll('.palette-item')];
      return items.some((el) => el.textContent.includes('qn29主笔记')) && items.some((el) => el.textContent.includes('qn29跨库笔记'));
    })()`, 10000);
    const hitInfo = await evaluate(ws, `(() => {
      const items = [...document.querySelectorAll('.palette-item')];
      const main = items.findIndex((el) => el.textContent.includes('qn29主笔记'));
      const cross = items.findIndex((el) => el.textContent.includes('qn29跨库笔记'));
      const crossItem = cross >= 0 ? items[cross] : null;
      return { main, cross, crossMeta: crossItem?.querySelector('.palette-item-meta')?.textContent ?? '', crossIcon: crossItem?.querySelector('.palette-item-icon')?.textContent ?? '' };
    })()`);
    check(listed && hitInfo.main >= 0 && hitInfo.cross >= 0, "全局搜索命中两个仓库的同令牌笔记", JSON.stringify(hitInfo));
    check(hitInfo.main < hitInfo.cross, "当前仓库的结果排在其他仓库前面", JSON.stringify(hitInfo));
    check(!!hitInfo.crossMeta, "其他仓库的命中标注仓库名", hitInfo.crossMeta);
    // 点跨库命中：应先切仓库再打开（顶栏仓库胶囊落进 vaultB、正文渲染出来）
    await evaluate(ws, `(() => {
      const items = [...document.querySelectorAll('.palette-item')];
      items.find((el) => el.textContent.includes('qn29跨库笔记'))?.click();
      return true;
    })()`);
    const openedInB = await waitFor(ws, `(() => {
      const pill = document.querySelector('.vault-pill');
      const lines = document.querySelectorAll('.cm-line').length;
      return pill && pill.textContent.includes('${nameOf(vaultB)}') && lines > 0;
    })()`, 15000, 400);
    check(openedInB, "点其他仓库的命中：切仓库并打开那篇笔记", await evaluate(ws, `JSON.stringify({ pill: document.querySelector('.vault-pill')?.textContent ?? '', cell: document.querySelector('.statusbar .status-cell')?.textContent ?? '' })`));
  }

  // ============================================== 5. 单词本云同步（桩后端）
  {
    // 重载后 vocab 文件仍是种子（上面写的），同步状态文件已清
    const panelOpen = await evaluate(ws, `!!document.querySelector('.settings-panel')`);
    if (!panelOpen) {
      await evaluate(ws, `(() => { document.querySelector('.topbar .icon-btn[title^="设置"]')?.click(); return true; })()`);
      await sleep(400);
    }
    await waitFor(ws, `!!document.querySelector('.settings-panel')`, 5000);
    const setSetting = async (label, value) => {
      await evaluate(ws, `(() => {
        const el = [...document.querySelectorAll('.settings-row')].find(r => r.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input');
        if (!el) return "no-row";
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return "ok";
      })()`);
    };
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('同步')); b?.click(); return !!b; })()`);
    await sleep(300);
    await setSetting("服务端地址", BASE);
    await setSetting("账号", "guitest");
    await setSetting("密码", "GuiTest-2026");
    await evaluate(ws, `(() => {
      const el = [...document.querySelectorAll('.settings-row')].find(r => r.querySelector('span')?.textContent === '启用自动同步')?.querySelector('input[type=checkbox]');
      if (el && !el.checked) el.click();
      return true;
    })()`);
    const readyOk = await waitFor(ws, `document.querySelector('.sync-status')?.textContent.includes('就绪')`, 15000);
    check(readyOk, "同步配置生效（状态栏就绪）", await evaluate(ws, `document.querySelector('.sync-status')?.textContent ?? ''`));
    // 引擎启动是异步的（读共享配置文件），留一拍再点立即同步
    await sleep(2500);
    await evaluate(ws, `document.querySelector('.sync-status')?.click(), true`);
    // 本机词应被推上专用云端仓（轮询桩后端的请求记录）
    let pushed = null;
    for (let i = 0; i < 60 && !pushed; i += 1) {
      await sleep(500);
      const found = backend.lastPushed("quick-note-vocab", "vocabulary.md");
      if (found && (found.content ?? "").includes("本地词qn29")) pushed = found;
    }
    check(!!pushed, "本机单词本推上云端专用仓（quick-note-vocab）", JSON.stringify(pushed ?? null).slice(0, 200));
    // 云端塞一个新词 → 立即同步拉回来合并
    backend.injectRecord("quick-note-vocab", {
      path: "vocabulary.md",
      content: ["# 单词本", "", "## 待学习", "", "- 云端词qn29 — 2026-10-21 · 云端", "", "## 已掌握", "", ""].join("\n"),
      version: 99,
    });
    await evaluate(ws, `document.querySelector('.sync-status')?.click(), true`);
    let merged = false;
    for (let i = 0; i < 60 && !merged; i += 1) {
      await sleep(500);
      try {
        merged = readFileSync(vocabFile, "utf8").includes("云端词qn29");
      } catch {}
    }
    check(merged, "云端词拉下来并合并进本机词库", existsSync(vocabFile) ? readFileSync(vocabFile, "utf8").slice(0, 200) : "(无文件)");
    const bothWords = existsSync(vocabFile)
      ? readFileSync(vocabFile, "utf8").includes("本地词qn29") && readFileSync(vocabFile, "utf8").includes("云端词qn29")
      : false;
    check(bothWords, "合并是 union：本机词与云端词都在", existsSync(vocabFile) ? readFileSync(vocabFile, "utf8") : "");
    check(existsSync(vocabStateFile), "单词本同步状态独立落盘（sync-state-vocab.json）");
    // 合并结果应回推（下一轮 flush），云端最终包含两边的词
    let pushedBack = null;
    for (let i = 0; i < 40 && !pushedBack; i += 1) {
      await sleep(500);
      const found = backend.lastPushed("quick-note-vocab", "vocabulary.md");
      if (found && (found.content ?? "").includes("云端词qn29") && (found.content ?? "").includes("本地词qn29")) {
        pushedBack = found;
      }
    }
    check(!!pushedBack, "合并结果回推云端（双向同步闭环）");
    await evaluate(ws, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
  }
} catch (error) {
  failures += 1;
  console.error(`批测异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    backend.stop();
  } catch {}
  try {
    ws?.close();
  } catch {}
  child?.kill();
  await sleep(800);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n0.29 批测全部通过 ✓");

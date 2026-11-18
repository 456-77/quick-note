// 0.39.23 批测：①背景图烘焙成 canvas（设置页卡顿修复：层上不再挂 filter）
// ②设置新增 AI 子菜单（三行配置）③最近文件跨仓库条目带仓库徽标（选项开启时）。
// 自起 gui-test 实例（独立 UDF + 临时仓库），结束自清理。
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9489";
const root = process.cwd();
const exe = join(root, "src-tauri", "target", "release", "quick-note.exe");
if (!existsSync(exe)) {
  console.error("找不到 exe");
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
  const r = await cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`页面内异常: ${r.exceptionDetails.text}`);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (ws, expression, timeoutMs, pollMs = 300) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};
const nativeClick = (ws, selector) =>
  evaluate(ws, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!el; })()`);

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
};

const work = join(tmpdir(), `qn-03923-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "仓库").replace(/\\/g, "/");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });
writeFileSync(join(vault, "笔记.md"), "# 笔记\n\n正文。\n", "utf8");
// 生成一张 640x360 的背景图（渐变近似：纯色 PNG，够烘焙链路用）
const bgPng = join(vault, "壁纸.png");
const bgPngUrlPath = bgPng.split("\\").join("/");
execSync(
  `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; ` +
    `$b=New-Object Drawing.Bitmap 640,360; $g=[Drawing.Graphics]::FromImage($b); ` +
    `$g.Clear([Drawing.Color]::FromArgb(40,90,150)); $b.Save('${bgPng.replace(/\\/g, "/")}',[Drawing.Imaging.ImageFormat]::Png)"`,
  { stdio: "pipe" },
);

const child = spawn(exe, [vault], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: udf, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: "ignore",
  detached: false,
});

let ws = null;
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      ready = list.some((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    } catch {}
  }
  if (!ready) throw new Error("页面没就绪");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WS 失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  await waitFor(ws, `document.readyState === "complete"`, 15000);
  // 收集页面异常/console.error（背景烘焙链路的诊断）
  const pageErrors = [];
  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(`EXC: ${msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? "?"}`);
      } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params?.type === "error" || msg.params?.type === "warning")) {
        pageErrors.push(`${msg.params.type}: ${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 300));
      }
    } catch {}
  });
  await cdp(ws, "Runtime.enable").catch(() => undefined);

  // 种子设置：背景图开 + 模糊/锐化（烘焙链路全部参数都走到）
  await evaluate(ws, `(() => {
    localStorage.clear();
    const settings = {
      bgEnabled: true,
      bgImagePath: "壁纸.png",
      bgOpacity: 0.8,
      bgBlur: 12,
      bgSharpness: 40,
      bgSharpen: 40,
      bgBrightness: 100,
      bgContrast: 100,
      bgScale: 100,
      bgPosX: 50,
      bgPosY: 50,
      bgFit: "cover",
      bgSurface: 80,
      recentsShowOtherVaults: true,
    };
    localStorage.setItem('quicknote.settings', JSON.stringify(settings));
    localStorage.setItem('quicknote.vault', ${JSON.stringify(vault)});
    localStorage.setItem('quicknote.recents', JSON.stringify([
      { vault: ${JSON.stringify(vault)}, path: "笔记.md" },
      { vault: "D:/another-vault", path: "别仓库笔记.md" },
    ]));
    return true;
  })()`);
  await cdp(ws, "Page.reload").catch(() => undefined);
  const booted = await waitFor(ws, `!!document.querySelector('.tree-file')`, 30000);
  check(booted, "应用启动");
  if (!booted) throw new Error("应用没启动");

  // ① 背景烘焙：层次挂 canvas、filter 为空
  const bgOk = await waitFor(
    ws,
    `(() => { const layer = document.getElementById('qn-bg-layer'); const canvas = layer?.querySelector('canvas'); return !!canvas && canvas.width > 100; })()`,
    15000,
  );
  check(bgOk, "背景层烘焙成 canvas（0.39.23）");
  const bgDiag = await evaluate(
    ws,
    `(() => { const layer = document.getElementById('qn-bg-layer'); if (!layer) return null; return { filter: getComputedStyle(layer).filter, transform: getComputedStyle(layer).transform, child: layer.firstElementChild?.tagName ?? '', css: layer.getAttribute('style') ?? '' }; })()`,
  );
  if (!bgOk) {
    // 诊断：直接拿资产 URL 试加载，区分「图加载失败」还是「烘焙代码没跑」
    const probe = await evaluate(
      ws,
      `(async () => {
        try {
          const url = window.__TAURI_INTERNALS__?.convertFileSrc(${JSON.stringify(bgPngUrlPath)});
          if (!url) return { url: "(no internals)" };
          const ok = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = url;
            setTimeout(() => resolve("timeout"), 8000);
          });
          return { url: url.slice(0, 120), loaded: ok };
        } catch (e) { return { error: String(e) }; }
      })()`,
    );
    console.log("  [bg probe]", JSON.stringify(probe), "| diag:", JSON.stringify(bgDiag));
    console.log("  [page errors]", pageErrors.slice(0, 8).join(" || ") || "(none)");
  }
  check(
    bgDiag && (bgDiag.filter === "none" || bgDiag.filter === "") && bgDiag.child === "CANVAS",
    "背景层不再挂 CSS filter（重绘开销与交互解耦）",
    JSON.stringify(bgDiag),
  );

  // ② 设置 → AI 子菜单
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true }))`);
  const settingsUp = await waitFor(ws, `!!document.querySelector('.settings-panel')`, 6000);
  check(settingsUp, "打开设置面板");
  const aiNav = await evaluate(ws, `[...document.querySelectorAll('.settings-nav-item')].some((b) => b.textContent.trim() === 'AI')`);
  check(aiNav, "设置导航出现 AI 子菜单（0.39.23）");
  if (aiNav) {
    await evaluate(ws, `(() => { [...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent.trim() === 'AI')?.click(); return true; })()`);
    await sleep(400);
    const aiRows = await evaluate(ws, `({
      visible: [...document.querySelectorAll('.settings-sec[data-sec="ai"]')].some((el) => el.offsetParent !== null),
      labels: [...document.querySelectorAll('.settings-sec[data-sec="ai"] .settings-row > span:first-child')].map((el) => el.textContent),
    })`);
    check(
      aiRows.visible && ["Base URL", "API Key", "模型"].every((t) => aiRows.labels.some((l) => l.includes(t))),
      "AI 设置可见（Base URL / API Key / 模型）",
      JSON.stringify(aiRows),
    );
  }
  // 关设置
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);

  // ③ 最近文件：跨仓库条目带仓库徽标
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, bubbles: true }))`);
  const recentUp = await waitFor(ws, `!!document.querySelector('.recent-dialog')`, 6000);
  check(recentUp, "打开最近文件弹窗");
  const recentInfo = await waitFor(
    ws,
    `(() => { const badge = document.querySelector('.recent-vault'); if (!badge) return false; return { badge: badge.textContent, names: [...document.querySelectorAll('.recent-name')].map((el) => el.textContent) }; })()`,
    5000,
  );
  check(
    !!recentInfo && recentInfo.badge === "another-vault" && recentInfo.names.includes("别仓库笔记.md"),
    "跨仓库条目带仓库徽标（选项开启时）",
    JSON.stringify(recentInfo ?? null),
  );
  // 点跨仓库条目：应切仓库（这里只断言弹窗关闭，不真的等它切完）
  await evaluate(ws, `(() => { const btn = [...document.querySelectorAll('.recent-item')].find((el) => el.querySelector('.recent-vault')); btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  const dialogClosed = await waitFor(ws, `!document.querySelector('.recent-dialog')`, 4000);
  check(dialogClosed, "点击跨仓库条目后弹窗关闭并触发切仓库");
} catch (e) {
  failures += 1;
  console.log(`✗ 异常：${e.message}`);
} finally {
  try { ws?.close(); } catch {}
  child.kill();
  await sleep(600);
  try { child.kill("SIGKILL"); } catch {}
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n0.39.23 冒烟全部通过 ✓" : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);

// 0.24 批次验收：本轮 7 项反馈的关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 + 临时
// 仓库）与桩后端，不依赖 verify-gui 的实例，结束时自清理。
//
// 覆盖：文件内搜索定位表格内容保持渲染态+widget 内红色命中+行内 code 命中不被遮 /
// mermaid 导出 SVG 原生文本+背景矩形（无 foreignObject）+PNG 与 SVG 同比例 3x /
// 单词面板 v2（搜索优先/筛选/详情弹层/快速添加 Toast/无结果收录/快捷键收词自动刷新）/
// 截图抓屏物理分辨率（SetProcessDPIAware）+ 冻结期窗口全屏 /
// 热键仲裁：登记表损坏时第二实例静默让位不弹错 /
// 归档自动同步：当前仓库触发完整轮（含拉取）、跨仓库按仓库记忆自动跑临时轮、冲突提醒。

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { vaultStateKey } from "../src/lib/sync.ts";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const port = process.argv[2] ?? "9344";
const stubPort = Number(process.argv[3] ?? 9355);
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
  const r = await cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`页面内异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
  }
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 命中高亮是否为红色（0.26 起颜色可配置、CSS 用 color-mix 派生，计算值
// 可能是旧 rgba() 或 color(srgb …) 格式——按"红通道显著占优"判，格式无关）
const isRedish = (value) => {
  const s = String(value ?? "");
  if (s.includes("255, 82, 82") || s.includes("229, 57, 53")) return true;
  const m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (m) return Number(m[1]) > 0.5 && Number(m[1]) > Number(m[2]) * 1.8 && Number(m[1]) > Number(m[3]) * 1.8;
  const n = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (n) return Number(n[1]) > 150 && Number(n[1]) > Number(n[2]) * 1.8 && Number(n[1]) > Number(n[3]) * 1.8;
  return false;
};

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}`;

/** 轮询直到 evaluate 断言为真或超时；返回最后的真值。 */
const waitFor = async (ws, expression, timeoutMs, pollMs = 500) => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    const hit = await evaluate(ws, expression).catch(() => false);
    if (hit) return hit;
    await sleep(pollMs);
  }
  return false;
};

const mouseClick = async (ws, x, y) => {
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const rectCenter = (ws, selectorExpr) =>
  evaluate(ws, `(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

// ------------------------------------------------ 自备数据：临时仓库（A 收件+编辑，B 跨仓库归档目标）

const work = join(tmpdir(), `qn-024-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vaultA = join(work, "vaulta");
const vaultB = join(work, "vaultb");
mkdirSync(vaultA, { recursive: true });
mkdirSync(vaultB, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

writeFileSync(
  join(vaultA, "qn24表格.md"),
  [
    "# 表格与搜索",
    "",
    ...Array.from({ length: 40 }, (_, i) => `垫高行 ${i + 1}。`),
    "",
    "| 库 | 归属服务 | 表前缀 |",
    "|---|---|---|",
    "| hfsids | hfins-ai-ids | ids_ |",
    "| `hscs_hsdt` | hfins-ai-data-transfer | hsdt_ |",
    "",
    "行内代码命中：`QN24CODE` 在正文里。",
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(
  join(vaultA, "qn24图.md"),
  [
    "# 流程图",
    "",
    "```mermaid",
    "flowchart TD",
    '  subgraph EXT["业务系统"]',
    '    BIZ["HFINS / HFINS-FM<br/>(报账等单据系统)"]',
    "  end",
    '  subgraph DT["数据传输"]',
    '    ITF["hsdt_hocr_task_itf<br/>status=N"]',
    '    J1["GeneratorTaskJob →<br/>生成任务"]',
    "  end",
    '  BIZ -->|"①写识别接口表"| ITF',
    "  ITF -->|②| J1",
    "```",
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(join(vaultA, "qn24归档A.md"), "# 归档目标A\n\n已有内容。\n", "utf8");
writeFileSync(join(vaultB, "qn24归档B.md"), "# 归档目标B\n\nB0 行。\n", "utf8");
writeFileSync(
  join(vaultA, "Inbox.md"),
  [
    "# Inbox",
    "",
    "- 24Q1 第一条速记 2026-10-16 10:00",
    "- 24Q2 第二条速记 2026-10-16 10:05",
    "- 24Q3 第三条速记 2026-10-16 10:10",
    "",
  ].join("\n"),
  "utf8",
);

// ------------------------------------------------ 桩后端（登录 + 批量推拉，与 gui-sync 同款的最小子集）

const USERNAME = "guitest";
const PASSWORD = "GuiTest-2026";
const BASE = `http://127.0.0.1:${stubPort}`;

function createStubBackend() {
  const vaults = new Map();
  const requests = [];
  const tokens = new Set(["access-1"]);
  let tokenSeq = 1;
  const vaultOf = (name) => {
    if (!vaults.has(name)) vaults.set(name, { version: 0, records: new Map() });
    return vaults.get(name);
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, BASE);
      requests.push({
        method: req.method,
        path: url.pathname,
        vault: url.searchParams.get("vault"),
        body,
      });
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
        send(200, { code: 0, data: { accessToken: `access-${tokenSeq}`, refreshToken: `refresh-${tokenSeq}`, expiresIn: 7200 } });
        return;
      }
      if (url.pathname === "/api/v1/auth/refresh") {
        tokenSeq += 1;
        tokens.add(`access-${tokenSeq}`);
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
          results.push({ path: item.path, status: "updated", version: vaultState.version });
        }
        send(200, { code: 0, data: { vaultVersion: vaultState.version, changed: true, results } });
        return;
      }
      if (url.pathname === "/api/v1/sync" && req.method === "GET") {
        const vaultState = vaultOf(url.searchParams.get("vault") ?? "");
        const since = Number(url.searchParams.get("since") ?? 0);
        const all = [...vaultState.records.values()].sort((a, b) => a.version - b.version);
        send(200, {
          code: 0,
          data: {
            vaultVersion: vaultState.version,
            hasMore: false,
            records: all.filter((item) => item.version > since),
            attachments: [],
          },
        });
        return;
      }
      send(404, { code: 404, message: "not found" });
    });
  });
  return {
    requests,
    vaultOf,
    /** 直接往云端放一条记录（模拟另一台设备改了它）。 */
    injectRecord(name, path, content) {
      const vaultState = vaultOf(name);
      vaultState.version += 1;
      vaultState.records.set(path, { path, content, deleted: false, version: vaultState.version });
      return vaultState.version;
    },
    recordOf(name, path) {
      return vaults.get(name)?.records.get(path) ?? null;
    },
    start() {
      return new Promise((resolve) => server.listen(stubPort, "127.0.0.1", resolve));
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ------------------------------------------------ 起实例 + 连 CDP

const spawnInstance = (vaultDir) =>
  spawn(exe, [vaultDir.replace(/\\/g, "/")], {
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

/** 本机配置目录（gui-test 变体独立）。 */
const appConfig = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "com.quicknote.gui-test",
);
const normalizeKey = (value) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();

const child = spawnInstance(vaultA);
let ws = null;
let backend = null;
try {
  let portReady = false;
  for (let i = 0; i < 45 && !portReady; i += 1) {
    await sleep(1000);
    portReady = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
  }
  if (!portReady) throw new Error("调试端口未就绪");
  let booted = false;
  for (let i = 0; i < 60 && !booted; i += 1) {
    ws = await connectPage(0).catch(() => null);
    if (!ws) continue;
    booted = await evaluate(
      ws,
      `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0; } catch { return false; } })()`,
    ).catch(() => false);
    if (!booted) {
      ws.close();
      ws = null;
    }
  }
  check(booted, "应用就绪（临时仓库已打开）");
  if (!booted) throw new Error("应用没起来");

  // 种子：收件仓库、最近仓库（跨仓库归档的下拉候选）、收件文件
  await evaluate(ws, `(() => {
    const raw = JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}');
    raw.quickCaptureVault = ${JSON.stringify(vaultA)};
    raw.quickCaptureFile = 'Inbox.md';
    localStorage.setItem('quicknote.settings', JSON.stringify(raw));
    localStorage.setItem('quicknote.vaultRecents', JSON.stringify([${JSON.stringify(vaultA.replace(/\\/g, "/"))}, ${JSON.stringify(vaultB.replace(/\\/g, "/"))}]));
    return true;
  })()`);
  await cdp(ws, "Page.reload").catch(() => undefined);
  const rebooted = await waitFor(
    ws,
    `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0 && !!window.__qnView; } catch { return false; } })()`,
    30000,
  );
  check(rebooted, "种子设置后重载完成");
  if (!rebooted) throw new Error("重载失败");
  // 文件行（.tree-file）就绪再点第一条笔记：重载后目录扫描是异步的，
  // 只有目录行时点笔记会静默落空（首轮 openNoteByLabel 因此失败的实测）
  const treeReady = await waitFor(ws, `document.querySelectorAll('.tree-file').length > 0`, 20000);
  check(treeReady, "文件树行就绪");
  if (!treeReady) throw new Error("文件树没就绪");

  const docString = () => evaluate(ws, `window.__qnView.state.doc.toString()`);
  const openNoteByLabel = async (label) => {
    await evaluate(
      ws,
      `(() => { const row = Array.from(document.querySelectorAll('.tree-file')).find((el) => el.textContent.includes('${label}')); if (!row) return false; row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})); return true; })()`,
    );
    // 笔记正文不一定含文件名：内容里含文件名或行数>3 都算打开
    for (let i = 0; i < 20; i += 1) {
      await sleep(400);
      const done = await evaluate(
        ws,
        `(() => { try { return window.__qnView.state.doc.toString().includes('${label.replace(/'/g, "")}') || window.__qnView.state.doc.lines > 3; } catch { return false; } })()`,
      ).catch(() => false);
      if (done) return true;
    }
    return false;
  };

  // ---------------------------------------------- 1. 文件内搜索 × 表格（0.24 反馈①）
  check(await openNoteByLabel("qn24表格.md"), "打开 qn24表格.md");
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    view.dispatch({ selection: { anchor: 0 } });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    view.focus();
    return true;
  })()`);
  await sleep(400);
  const panelOn = await evaluate(ws, `!!document.querySelector('.qn-search')`);
  check(panelOn, "Ctrl+F 打开文件内搜索面板");
  if (panelOn) {
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.qn-search-input'), 'hscs_hsdt'); return true; })()`);
    await sleep(400);
    await evaluate(ws, `(() => { document.querySelector('.qn-search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    await sleep(800);
    const tableVisible = await evaluate(ws, `(() => {
      const el = document.querySelector('.cm-lp-table');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.__qnView.scrollDOM.getBoundingClientRect();
      return r.top < s.bottom && r.bottom > s.top;
    })()`);
    check(tableVisible, "Enter 定位到表格内命中：表格保持渲染态（不显示源码）");
    const hitInTable = await evaluate(ws, `(() => {
      const mark = document.querySelector('.cm-lp-table mark.qn-search-hit');
      if (!mark) return null;
      return { text: mark.textContent, bg: getComputedStyle(mark).backgroundColor };
    })()`);
    check(
      !!hitInTable && hitInTable.text === "hscs_hsdt" && isRedish(hitInTable.bg),
      "渲染态表格内的命中带红色高亮",
      JSON.stringify(hitInTable),
    );
    const count = await evaluate(ws, `document.querySelector('.qn-search-count')?.textContent ?? ''`);
    check(/1\s*\/\s*1/.test(count.trim()), "命中计数正常（1/1）", count);
    // 再按一次 Enter（环绕到同一处）也不把表格翻成源码
    await evaluate(ws, `(() => { document.querySelector('.qn-search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    await sleep(600);
    const stillRendered = await evaluate(ws, `!!document.querySelector('.cm-lp-table')`);
    check(stillRendered, "继续导航后表格仍是渲染态");
    await evaluate(ws, `(() => { document.querySelector('.qn-search [data-act="close"]')?.click(); return true; })()`);
    await sleep(300);
  }

  // 行内 code 上的命中：红色不被芯片底色遮住（0.24 反馈①后半）
  await evaluate(ws, `(() => {
    const view = window.__qnView;
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    view.focus();
    return true;
  })()`);
  await sleep(400);
  if (await evaluate(ws, `!!document.querySelector('.qn-search')`)) {
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.qn-search-input'), 'QN24CODE'); return true; })()`);
    await sleep(500);
    const codeHit = await evaluate(ws, `(() => {
      const outer = document.querySelector('.cm-searchMatch');
      const inner = outer?.querySelector('.cm-lp-code') ?? null;
      return {
        hasOuter: !!outer,
        outerBg: outer ? getComputedStyle(outer).backgroundColor : null,
        innerBg: inner ? getComputedStyle(inner).backgroundColor : null,
      };
    })()`);
    check(
      codeHit.hasOuter && isRedish(codeHit.outerBg),
      "行内 code 的命中外层有红色高亮",
      JSON.stringify(codeHit),
    );
    check(
      codeHit.innerBg === "rgba(0, 0, 0, 0)" || codeHit.innerBg === "transparent",
      "行内 code 芯片底色在命中区间内放透明（不再遮挡红色）",
      JSON.stringify(codeHit),
    );
    await evaluate(ws, `(() => { document.querySelector('.qn-search [data-act="close"]')?.click(); return true; })()`);
    await sleep(300);
  }

  // ---------------------------------------------- 2. mermaid 导出（0.24 反馈②）
  check(await openNoteByLabel("qn24图.md"), "打开 qn24图.md");
  await waitFor(ws, `(() => { const svg = document.querySelector('.cm-lp-mermaid svg'); return !!svg && !!svg.viewBox?.baseVal?.width; })()`, 20000);
  await evaluate(ws, `(() => { const v = window.__qnView; v.dispatch({ selection: { anchor: 0 } }); v.focus(); return true; })()`);
  await sleep(600);
  const dl = await rectCenter(ws, `document.querySelector('.cm-lp-mermaid .qn-mermaid-toolbar button[title="导出 SVG / PNG"]')`);
  check(!!dl, "mermaid 工具栏出现");
  const exportDir = join(vaultA, "导出");
  let svgFile = null;
  if (dl) {
    await mouseClick(ws, dl.x, dl.y);
    await sleep(400);
    const svgItem = await rectCenter(ws, `Array.from(document.querySelectorAll('.qn-mermaid-menu-item')).find((el) => el.textContent === 'SVG')`);
    if (svgItem) {
      await mouseClick(ws, svgItem.x, svgItem.y);
      for (let i = 0; i < 12 && !svgFile; i += 1) {
        await sleep(800);
        if (existsSync(exportDir)) {
          const files = readdirSync(exportDir).filter((f) => f.endsWith(".svg"));
          if (files.length > 0) svgFile = join(exportDir, files[0]);
        }
      }
      check(!!svgFile, "导出 SVG 落到导出目录", svgFile ?? "无文件");
      if (svgFile) {
        const svgText = readFileSync(svgFile, "utf8");
        check(!svgText.includes("<foreignObject"), "导出 SVG 不含 foreignObject（标签是原生文本）");
        check(/<text[\s>]/.test(svgText) || /<tspan[\s>]/.test(svgText), "导出 SVG 里有 <text>/<tspan> 文字", svgText.slice(0, 200));
        check(/<rect x="0" y="0"[^>]*fill="/.test(svgText), "导出 SVG 垫了主题底色矩形");
        // PNG：与 SVG 同一渲染源，尺寸应是同一 viewBox 的 3x
        await mouseClick(ws, dl.x, dl.y);
        await sleep(400);
        const pngItem = await rectCenter(ws, `Array.from(document.querySelectorAll('.qn-mermaid-menu-item')).find((el) => el.textContent === 'PNG')`);
        if (pngItem) {
          await mouseClick(ws, pngItem.x, pngItem.y);
          let pngFile = null;
          for (let i = 0; i < 12 && !pngFile; i += 1) {
            await sleep(800);
            if (existsSync(exportDir)) {
              const files = readdirSync(exportDir).filter((f) => f.endsWith(".png"));
              if (files.length > 0) pngFile = join(exportDir, files[0]);
            }
          }
          check(!!pngFile, "导出 PNG 落到导出目录", pngFile ?? "无文件");
          if (pngFile && svgFile) {
            const buf = readFileSync(pngFile);
            const width = buf.readUInt32BE(16);
            const height = buf.readUInt32BE(20);
            const vb = /viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/.exec(readFileSync(svgFile, "utf8"));
            const svgW = vb ? Number(vb[3]) : null;
            const svgH = vb ? Number(vb[4]) : null;
            check(
              svgW > 0 && Math.abs(width / svgW - 3) < 0.05 && Math.abs(height / svgH - 3) < 0.05,
              `PNG 与 SVG 同比例 3x 光栅化（${width}x${height} vs ${svgW}x${svgH}）`,
            );
          }
        } else {
          check(false, "导出菜单没有 PNG 项");
        }
      }
    } else {
      check(false, "导出菜单没有 SVG 项");
    }
  }

  // ---------------------------------------------- 3. 单词面板 v2（0.24 反馈③④；0.25 面板重排后适配）
  // 添加区流程：展开 → 输入 → 回车在线查询 → 生造词走「手动填写释义」兜底保存。
  const saveViaAdd = `(() => {
    const lookup = document.querySelector('.vocab-lookup');
    if (!lookup) return false;
    const save = [...lookup.querySelectorAll('button')].find((x) => x.textContent === '保存');
    if (save) { save.click(); return true; }
    const manual = [...lookup.querySelectorAll('button')].find((x) => x.textContent === '手动填写释义');
    if (manual) { manual.click(); return false; }
    return false;
  })()`;
  const tabPos = await rectCenter(ws, `Array.from(document.querySelectorAll('.sidebar-tab')).find((el) => el.textContent.includes('单词'))`);
  check(!!tabPos, "右侧面板出现「单词」页签");
  if (tabPos) {
    await mouseClick(ws, tabPos.x, tabPos.y);
    await sleep(700);
    check(
      (await evaluate(ws, `document.querySelector('.vocab-search-input')?.placeholder ?? ''`)) === "搜索单词、释义...",
      "搜索框置顶（placeholder=搜索单词、释义...）",
    );
    const filters = await evaluate(ws, `[...document.querySelectorAll('.vocab-filter')].map((b) => b.textContent)`);
    check(
      filters.length === 3 && filters[0].includes("全部") && filters[1].includes("待学习") && filters[2].includes("已掌握"),
      "快捷筛选：全部/待学习/已掌握（最近添加已移进排序）",
      JSON.stringify(filters),
    );
    // 添加区默认收起；展开 → 查询（生造词必失败）→ 手动兜底 → 保存 → Toast
    check(!!(await evaluate(ws, `!!document.querySelector('.vocab-add-toggle')`)), "添加区默认收起（＋ 添加新单词）");
    await evaluate(ws, `(() => { document.querySelector('.vocab-add-toggle')?.click(); return true; })()`);
    await sleep(300);
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.vocab-add-input'), 'qn24word1'); document.querySelector('.vocab-add-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    await waitFor(ws, saveViaAdd, 20000, 600);
    await sleep(900);
    const toast1 = await evaluate(ws, `document.querySelector('.vocab-toast')?.textContent ?? ''`);
    check(String(toast1).includes("已添加到待学习"), "添加成功 Toast", String(toast1));
    const vocabFile = join(vaultA, "单词本.md");
    let vocab = existsSync(vocabFile) ? readFileSync(vocabFile, "utf8") : "";
    check(vocab.includes("- qn24word1"), "快速添加落盘 单词本.md", vocab);
    // 重复添加 → 提示已存在 + 查看入口（先等第一条 Toast 消失，避免轮询命中残留）
    await waitFor(ws, `!document.querySelector('.vocab-toast')`, 5000);
    await evaluate(ws, `(() => { const t = document.querySelector('.vocab-add-toggle'); if (t) { t.click(); return true; } return !!document.querySelector('.vocab-add-input'); })()`);
    await sleep(300);
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.vocab-add-input'), 'qn24word1'); document.querySelector('.vocab-add-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    await waitFor(ws, saveViaAdd, 20000, 600);
    await sleep(900);
    const toast2 = await waitFor(ws, `(document.querySelector('.vocab-toast')?.textContent ?? '').includes('已经添加过了')`, 6000);
    check(!!toast2, "重复词 Toast 提示", String(await evaluate(ws, `document.querySelector('.vocab-toast')?.textContent ?? ''`)));
    const viewBtn = await waitFor(ws, `(() => { const b = [...document.querySelectorAll('.vocab-toast button')].find((x) => x.textContent === '查看'); if (!b) return false; b.click(); return true; })()`, 4000);
    check(viewBtn, "Toast 的「查看」打开详情");
    await waitFor(ws, `!!document.querySelector('.vocab-detail')`, 4000);
    check(await evaluate(ws, `document.querySelector('.vocab-detail-word')?.textContent === 'qn24word1'`), "详情弹层显示单词");
    // 详情里编辑释义/备注（0.25 起编辑表单是 音标/释义/备注 三个字段）
    await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-detail-act')].find((b) => b.textContent === '编辑')?.click(); return true; })()`);
    await sleep(300);
    await evaluate(ws, `(() => { const el = document.querySelector('.vocab-detail-edit label:nth-child(2) input'); (${nativeSet})(el, '数据传输任务接口表'); return true; })()`);
    await sleep(200);
    await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-detail-edit-actions .btn')].find((b) => b.textContent === '保存')?.click(); return true; })()`);
    await sleep(900);
    vocab = readFileSync(vocabFile, "utf8");
    check(vocab.includes("qn24word1 | 数据传输任务接口表"), "编辑释义写回（v2 行格式）", vocab.split("\n").filter((l) => l.includes("qn24word1")).join(" ; "));
    // 详情里标记已掌握（0.25 起按钮文案是「已掌握」）
    await evaluate(ws, `(() => { [...document.querySelectorAll('.vocab-detail-act')].find((b) => b.textContent === '已掌握')?.click(); return true; })()`);
    await sleep(900);
    vocab = readFileSync(vocabFile, "utf8");
    const doneIdx = vocab.indexOf("## 已掌握");
    const wordIdx = vocab.indexOf("- qn24word1");
    check(wordIdx >= 0 && doneIdx >= 0 && wordIdx > doneIdx, "标记为已掌握移入对应节", vocab);
    await evaluate(ws, `(() => { document.querySelector('.vocab-detail-close')?.click(); return true; })()`);
    await sleep(400);

    // 中文释义搜索 + 匹配计数（0.25 起计数行文案是「搜索结果 · N」）
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.vocab-search-input'), '接口表'); return true; })()`);
    await sleep(500);
    const cnHits = await evaluate(ws, `document.querySelectorAll('.vocab-item').length`);
    const countLine = await evaluate(ws, `document.querySelector('.vocab-count-line')?.textContent ?? ''`);
    check(cnHits === 1 && countLine.includes("搜索结果 · 1"), "中文释义可搜索且显示匹配数", `${cnHits} ${countLine}`);
    await evaluate(ws, `(() => { document.querySelector('.vocab-search-clear')?.click(); return true; })()`);
    await sleep(400);

    // 快捷键收词后列表自动刷新（0.24 反馈③）——面板保持打开、不切页签
    check(await openNoteByLabel("qn24表格.md"), "切到编辑器（面板仍开着）");
    await evaluate(ws, `(() => {
      const view = window.__qnView;
      const doc = view.state.doc.toString();
      const at = doc.indexOf('hfsids');
      view.dispatch({ selection: { anchor: at, head: at + 'hfsids'.length } });
      view.focus();
      return at >= 0;
    })()`);
    const beforeCount = await evaluate(ws, `document.querySelectorAll('.vocab-item').length`);
    await evaluate(ws, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`);
    const refreshed = await waitFor(
      ws,
      `(() => { const items = [...document.querySelectorAll('.vocab-item .vocab-item-word')]; return items.some((el) => el.textContent === 'hfsids'); })()`,
      8000,
    );
    check(refreshed, "Ctrl+Alt+V 收词后右侧单词面板自动出现新词（无需切页签）");
    const afterCount = await evaluate(ws, `document.querySelectorAll('.vocab-item').length`);
    check(afterCount === beforeCount + 1, "面板列表计数 +1", `${beforeCount} -> ${afterCount}`);

    // 无结果空态 + 收录（0.25：收录会展开添加区并走在线查询，生造词手动兜底）
    await evaluate(ws, `(() => { (${nativeSet})(document.querySelector('.vocab-search-input'), 'zzz不存在词'); return true; })()`);
    await sleep(500);
    const emptyShown = await evaluate(ws, `(() => { const el = document.querySelector('.vocab-empty-search'); return el && el.textContent.includes('没有找到相关单词'); })()`);
    check(emptyShown, "搜索无结果出现居中空态");
    await evaluate(ws, `(() => { const b = document.querySelector('.vocab-empty-search .vocab-btn'); b?.click(); return !!b; })()`);
    await waitFor(ws, saveViaAdd, 20000, 600);
    await sleep(900);
    vocab = readFileSync(vocabFile, "utf8");
    check(vocab.includes("- zzz不存在词"), "空态的「收录」走添加区落盘", vocab);
    const queryCleared = await evaluate(ws, `document.querySelector('.vocab-search-input')?.value === ''`);
    check(queryCleared, "收录保存后清除搜索词（列表直接可见新词）");
    await sleep(400);
    // 字母分组与定位栏
    const hasAlpha = await evaluate(ws, `(() => { const a = document.querySelector('.vocab-alpha'); return a && a.querySelectorAll('button').length > 1; })()`);
    check(hasAlpha, "字母快速定位栏出现（多于一个分组）");
    // 字母分组头：字母 + 计数 + 分隔线（不再是色块）
    const groupHead = await evaluate(ws, `(() => { const g = document.querySelector('.vocab-group-letter'); return g ? g.textContent : ''; })()`);
    check(/·\s*\d+ 个单词/.test(String(groupHead)), "字母分组头为「字母 · N 个单词」", String(groupHead));
  }

  // ---------------------------------------------- 4. 截图：物理分辨率 + 全屏冻结（0.24 反馈⑤）
  // 期望值：与 Rust 同款的 PS 脚本（SetProcessDPIAware 后读 VirtualScreen）现场实测
  let expectW = 0;
  let expectH = 0;
  try {
    const psScript = [
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public sealed class QnDpiT{[DllImport(\"user32.dll\")]public static extern bool SetProcessDPIAware();}'",
      "[QnDpiT]::SetProcessDPIAware()|Out-Null",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen",
      'Write-Output ("{0}x{1}" -f $b.Width,$b.Height)',
    ].join("; ");
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], { encoding: "utf8" });
    const [w, h] = out.trim().split("x").map(Number);
    expectW = w;
    expectH = h;
  } catch {
    // 拿不到期望值就跳过分辨率断言（CI 无桌面会话时的兜底）
  }
  if (expectW > 0) {
    const shot = await evaluate(
      ws,
      `window.__TAURI_INTERNALS__.invoke('screenshot_capture').then((s) => ({ w: s.width, h: s.height }))`,
    );
    check(
      shot.w === expectW && shot.h === expectH,
      `抓屏为物理分辨率（${shot.w}x${shot.h} == ${expectW}x${expectH}，DPI 虚拟化修复生效）`,
    );
  } else {
    console.log("· 跳过抓屏分辨率断言（未能现场取到物理分辨率）");
  }
  // 冻结期窗口切系统全屏（覆盖任务栏），关闭后还原
  await evaluate(ws, `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'screenshot-hotkey' })`);
  const overlayUp = await waitFor(ws, `!!document.querySelector('.shot-overlay')`, 15000);
  check(overlayUp, "合成 screenshot-hotkey 打开冻结浮层");
  if (overlayUp) {
    const full = await waitFor(
      ws,
      `(() => { const sh = window.screen.height; return window.outerHeight >= sh - 2 ? window.outerHeight : false; })()`,
      8000,
    );
    check(!!full, `冻结期窗口进入系统全屏（outerHeight=${await evaluate(ws, "window.outerHeight")} / screen.height=${await evaluate(ws, "window.screen.height")}）`);
    await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    const overlayGone = await waitFor(ws, `!document.querySelector('.shot-overlay')`, 6000);
    check(overlayGone, "Esc 关闭冻结浮层");
    const restored = await waitFor(
      ws,
      `(() => { return window.outerHeight < window.screen.height - 10; })()`,
      8000,
    );
    check(restored, "关闭后窗口退出全屏（任务栏恢复）");
  }

  // ---------------------------------------------- 5. 归档自动同步（0.24 反馈⑦）
  backend = createStubBackend();
  await backend.start();
  // 通过设置面板为当前仓库启用同步（整库范围）
  await evaluate(ws, `(() => { document.querySelector('.topbar .icon-btn[title^="设置"]')?.click(); return true; })()`);
  await sleep(400);
  const rowSelector = (label) =>
    `[...document.querySelectorAll('.settings-row')].find(r => r.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input,select')`;
  const setSetting = async (label, value) => {
    await evaluate(ws, `(() => {
      const el = ${rowSelector(label)};
      if (!el) return "no-row";
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      return "ok";
    })()`);
  };
  await setSetting("服务端地址", BASE);
  await setSetting("账号", USERNAME);
  await setSetting("密码", PASSWORD);
  await setSetting("推送范围", "vault");
  await evaluate(ws, `(() => { const el = ${rowSelector("启用自动同步")}; if (el && !el.checked) el.click(); return true; })()`);
  await sleep(600);
  const syncReady = await waitFor(ws, `(document.querySelector('.sync-status')?.textContent ?? '').includes('就绪')`, 10000);
  check(syncReady, "同步配置生效（状态栏就绪）");
  await evaluate(ws, `(() => { document.querySelector('.topbar .icon-btn[title^="设置"]')?.click(); return true; })()`);
  await sleep(400);
  // 打开 Inbox 视图
  await evaluate(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, altKey: true, bubbles: true }))`);
  await sleep(1500);
  const inboxOpen = await evaluate(ws, `!!document.querySelector('.cm-root')`);
  check(inboxOpen, "Ctrl+Alt+M 打开速记管理");
  if (inboxOpen) {
    const pickTarget = async (noteLabel) => {
      await evaluate(ws, `document.querySelector('.cm-batch-target')?.click()`);
      await sleep(500);
      if (!(await evaluate(ws, `!!document.querySelector('.cm-target-pop')`))) return false;
      await evaluate(ws, `(() => {
        const chip = [...document.querySelectorAll('.cm-target-vault')].find((b) => ${JSON.stringify(noteLabel.includes("B"))} ? b.textContent.includes('vaultb') : b.textContent.includes('vaulta'));
        chip?.click();
        return true;
      })()`);
      await sleep(700);
      await evaluate(ws, `(() => { const el = document.querySelector('.cm-target-search'); (${nativeSet})(el, ${JSON.stringify(noteLabel)}); return true; })()`);
      await sleep(400);
      await evaluate(ws, `document.querySelector('.cm-target-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await sleep(600);
      const label = await evaluate(ws, `document.querySelector('.cm-batch-target')?.textContent ?? ''`);
      return label.includes(noteLabel);
    };
    const checkFirstRow = async () => {
      await evaluate(ws, `document.querySelectorAll('.cm-check')[0].click()`);
      await sleep(400);
      return evaluate(ws, `!!document.querySelector('.cm-toolbar.is-batch')`);
    };
    const clickArchive = async () => {
      await evaluate(ws, `[...document.querySelectorAll('.cm-toolbar.is-batch .cm-btn')].find((b) => b.textContent === '归档')?.click()`);
      await sleep(1200);
    };

    // —— 当前仓库：归档 → 完整轮（有拉取请求；纯 watcher 只推不拉）
    backend.requests.length = 0;
    check(await checkFirstRow(), "勾选第一条速记进入批量模式");
    check(await pickTarget("qn24归档A"), "选择当前仓库目标笔记");
    await clickArchive();
    let sawPull = false;
    let sawPush = false;
    for (let i = 0; i < 24 && !(sawPull && sawPush); i += 1) {
      await sleep(500);
      sawPull = backend.requests.some((r) => r.method === "GET" && r.path === "/api/v1/sync" && r.vault === "vaulta");
      sawPush = backend.requests.some((r) => r.method === "POST" && r.path === "/api/v1/sync" && r.vault === "vaulta" && r.body.includes("qn24归档A.md"));
    }
    check(sawPull, "归档后自动触发完整同步轮（出现拉取请求）");
    check(sawPush, "归档目标笔记被推送上云", JSON.stringify(backend.requests.map((r) => `${r.method} ${r.vault}`).slice(-6)));

    // —— 跨仓库：per-vault 状态文件预置（enabledByVault 记忆=true）→ 归档自动跑临时轮
    const perVaultState = {
      vault: "",
      serverUrl: BASE,
      username: USERNAME,
      password: PASSWORD,
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
      enabledByVault: { [normalizeKey(vaultB)]: true },
    };
    mkdirSync(appConfig, { recursive: true });
    writeFileSync(join(appConfig, `sync-state-${vaultStateKey(vaultB)}.json`), JSON.stringify(perVaultState, null, 2), "utf8");
    // Inbox 里再补一条（直接落盘；面板重扫会读到）
    writeFileSync(
      join(vaultA, "Inbox.md"),
      [
        "# Inbox",
        "",
        "- 24Q1 第一条速记 2026-10-16 10:00 ^archived",
        "- 24Q2 第二条速记 2026-10-16 10:05 ^archived",
        "- 24Q3 第三条速记 2026-10-16 10:10 ^archived",
        "- 24Q4 跨仓库速记 2026-10-16 10:15",
        "",
      ].join("\n"),
      "utf8",
    );
    await evaluate(ws, `(() => { const b = document.querySelector('.cm-tool-btn[title*="刷新"], .cm-head button'); return !!b; })()`);
    await waitFor(ws, `[...document.querySelectorAll('.cm-row-text')].some((el) => el.textContent.includes('跨仓库速记'))`, 8000);
    backend.requests.length = 0;
    check(await checkFirstRow(), "勾选跨仓库速记");
    check(await pickTarget("qn24归档B"), "选择 vaultB 的目标笔记");
    await clickArchive();
    let sawCrossPush = false;
    for (let i = 0; i < 30 && !sawCrossPush; i += 1) {
      await sleep(500);
      sawCrossPush = backend.requests.some((r) => r.method === "POST" && r.path === "/api/v1/sync" && r.vault === "vaultb" && r.body.includes("qn24归档B.md"));
    }
    check(sawCrossPush, "跨仓库归档自动同步目标仓库（0.23 要等打开才同步）");

    // —— 跨仓库冲突：云端与本地都改过 → 提醒打开仓库手动处理
    backend.injectRecord("vaultb", "qn24归档B.md", "# 归档目标B\n\n云端改的行。\n");
    writeFileSync(join(vaultB, "qn24归档B.md"), "# 归档目标B\n\nB0 行。\n本地改的行。\n", "utf8");
    writeFileSync(
      join(vaultA, "Inbox.md"),
      [
        "# Inbox",
        "",
        "- 24Q1 第一条速记 2026-10-16 10:00 ^archived",
        "- 24Q2 第二条速记 2026-10-16 10:05 ^archived",
        "- 24Q3 第三条速记 2026-10-16 10:10 ^archived",
        "- 24Q4 跨仓库速记 2026-10-16 10:15 ^archived",
        "- 24Q5 冲突轮速记 2026-10-16 10:20",
        "",
      ].join("\n"),
      "utf8",
    );
    await waitFor(ws, `[...document.querySelectorAll('.cm-row-text')].some((el) => el.textContent.includes('冲突轮速记'))`, 8000);
    backend.requests.length = 0;
    check(await checkFirstRow(), "勾选冲突轮速记");
    check(await pickTarget("qn24归档B"), "再次选择 vaultB 目标笔记");
    await clickArchive();
    const conflictReminded = await waitFor(
      ws,
      `document.body.textContent.includes('请打开该仓库手动处理')`,
      20000,
    );
    if (!conflictReminded) {
      // 诊断现场：归档是否成功、横幅/状态栏内容、per-vault 状态文件、vaultb 请求
      const diag = await evaluate(ws, `(() => {
        const toasts = [...document.querySelectorAll('.cm-toast, .vocab-toast')].map((el) => el.textContent);
        return JSON.stringify({
          toasts,
          status: [...document.querySelectorAll('.status-cell')].map((el) => el.textContent).join('|'),
        });
      })()`);
      const stateFile = join(appConfig, `sync-state-${vaultStateKey(vaultB)}.json`);
      const stateInfo = existsSync(stateFile)
        ? (() => {
            try {
              const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
              return JSON.stringify({ enabled: parsed.enabled, byVault: parsed.enabledByVault, hashes: Object.keys(parsed.hashes ?? {}), cursor: parsed.cursor });
            } catch (e) {
              return `parse-error ${e}`;
            }
          })()
        : "missing";
      console.log(
        `  诊断：${diag}\n  per-vault 状态：${stateInfo}\n  全部请求：${JSON.stringify(backend.requests.map((r) => `${r.method} ${r.path}?vault=${r.vault} ${r.body.slice(0, 100)}`))}\n  横幅：${await evaluate(ws, `[...document.querySelectorAll('.banner')].map((el) => el.textContent).join(' | ')`)}`,
      );
    }
    check(conflictReminded, "归档同步冲突提醒用户打开仓库处理");
    const remoteUntouched = backend.recordOf("vaultb", "qn24归档B.md")?.content?.includes("云端改的行");
    check(remoteUntouched, "冲突文件不被自动覆盖（扣住待裁决）");
  }

  // ---------------------------------------------- 6. 热键仲裁：登记表损坏仍让位（0.24 反馈⑥）
  mkdirSync(appConfig, { recursive: true });
  writeFileSync(join(appConfig, "open-vaults.json"), "corrupted{{{not-json", "utf8");
  const child2 = spawnInstance(vaultB);
  let ws2 = null;
  try {
    let page2 = null;
    for (let i = 0; i < 30 && !page2; i += 1) {
      await sleep(1000);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        const pages = list.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
        if (pages.length >= 2) page2 = pages[1];
      } catch {}
    }
    if (!page2) {
      check(false, "登记表损坏场景：未发现第二个页面目标");
    } else {
      ws2 = new WebSocket(page2.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws2.addEventListener("open", resolve, { once: true });
        ws2.addEventListener("error", () => reject(new Error("ws2 连接失败")), { once: true });
      });
      let b2 = false;
      for (let i = 0; i < 30 && !b2; i += 1) {
        await sleep(800);
        b2 = await cdp(ws2, "Runtime.evaluate", {
          expression: `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0; } catch { return false; } })()`,
          returnByValue: true,
        }).then((r) => r.result.value).catch(() => false);
      }
      check(b2, "登记表损坏场景：第二实例启动");
      // 启动稍等片刻，让热键注册路径跑完
      await sleep(3000);
      const b2text = await cdp(ws2, "Runtime.evaluate", {
        expression: `document.body.textContent.slice(0, 6000)`,
        returnByValue: true,
      }).then((r) => r.result.value).catch(() => "");
      check(!b2text.includes("注册截图快捷键失败"), "登记表读不出来时静默让位（不再弹「被其他程序占用」）");
    }
  } finally {
    try {
      process.kill(child2.pid);
    } catch {}
    try {
      ws2?.close();
    } catch {}
  }
  await sleep(800);
} catch (error) {
  failures += 1;
  console.error(`✗ 批测中断：${error?.message ?? error}`);
} finally {
  try {
    backend?.stop();
  } catch {}
  try {
    ws?.close();
  } catch {}
  try {
    process.kill(child.pid);
  } catch {}
  await sleep(800);
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n0.24 批次验收全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

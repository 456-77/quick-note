/**
 * 内存压测（0.34.3 内存轮）：私有工作集轨迹测量。
 *
 *   node --experimental-strip-types scripts/mem-stress.mjs <exe路径> [CDP端口]
 *
 * 流程：临时仓库（30 张 mermaid 图 + 5 表 xlsx + 大文本）→ 起 release exe →
 *   A 空闲 25s 测基线 → B 开 mermaid 笔记 → C 开/关 xlsx 预览 ×5（每轮测）→
 *   D 关预览回编辑器再测。判定：开合循环后不单调上涨（M5 验收口径）。
 *
 * 测量口径：scripts/measure-rss.ps1 的 PrivateWS 合计（ASCII 正则解析，
 * 中文管道转码会花——见 memory/webview2-cdp-launch）。
 */

import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const exe = process.argv[2] ?? "";
const port = process.argv[3] ?? "9377";
if (!exe) {
  console.error("用法: node --experimental-strip-types scripts/mem-stress.mjs <exe路径> [端口]");
  process.exit(2);
}

const work = join(tmpdir(), `qn-mem-${Date.now()}`);
const vault = join(work, "vault");
const udf = join(work, "udf");
mkdirSync(vault, { recursive: true });
mkdirSync(udf, { recursive: true });

// ---- 自备数据 ------------------------------------------------------------
const diagrams = Array.from({ length: 30 }, (_, i) =>
  ["```mermaid", "flowchart TD", `  A${i}[开始 ${i}] --> B${i}{判断}`, `  B${i} -->|是| C${i}[处理 ${i}]`, `  B${i} -->|否| D${i}[结束 ${i}]`, "```", ""].join("\n"),
).join("\n");
writeFileSync(join(vault, "mem-mermaid大笔记.md"), `# mermaid 压测\n\n${diagrams}`, "utf8");

const bigRows = Array.from({ length: 300 }, (_, r) => `| 行${r} | 值${r}-甲 | 值${r}-乙 | ${r * 2} |`).join("\n");
writeFileSync(join(vault, "mem-大文本.md"), `# 大文本\n\n${"| 列一 | 列二 | 列三 | 列四 |\n| --- | --- | --- | --- |\n"}${bigRows}\n\n${"长段落。".repeat(4000)}`, "utf8");

// xlsx 用项目自带的 SheetJS 生成：临时 .cjs 脚本放项目里跑（依赖从项目 node_modules 解析）
const xlsxPath = join(vault, "mem-表格.xlsx");
const genCjs = join(process.cwd(), "scripts", "_mem-gen-xlsx.cjs");
writeFileSync(
  genCjs,
  [
    "const XLSX = require('xlsx');",
    "const out = process.argv[2];",
    "const wb = XLSX.utils.book_new();",
    "for (let s = 0; s < 5; s++) {",
    "  const rows = [['编号','名称','数值','备注']];",
    "  for (let r = 1; r <= 200; r++) rows.push(['r'+r, '项目'+r+'-'+s, r*s, '说明文字'.repeat(3)]);",
    "  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '表'+s);",
    "}",
    "XLSX.writeFile(wb, out);",
  ].join("\n"),
  "utf8",
);
execSync(`node "${genCjs}" "${xlsxPath}"`, { cwd: process.cwd(), stdio: "ignore" });
try {
  const size = (await import("node:fs")).statSync(xlsxPath).size;
  console.log(`测试数据就绪：xlsx ${size} 字节`);
} catch {
  console.error("xlsx 生成失败");
  process.exit(2);
}

// ---- CDP 助手 -------------------------------------------------------------
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const measure = (pid) => {
  const out = execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-rss.ps1 -ProcessId ${pid}`,
    { encoding: "utf8" },
  );
  const m = out.match(/PrivateWS\):\s*([\d.]+) MB/);
  return m ? Number(m[1]) : -1;
};

// ---- 主流程 ---------------------------------------------------------------
const child = spawn(exe, [vault.replace(/\\/g, "/")], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: udf,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: "ignore",
});

const stop = (code) => {
  try {
    child.kill();
  } catch {}
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
  process.exit(code);
};

try {
  let ws = null;
  for (let i = 0; i < 45 && !ws; i += 1) {
    await sleep(1000);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
      if (!page) continue;
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("ws")), { once: true });
      });
    } catch {
      ws = null;
    }
  }
  if (!ws) throw new Error("CDP 未就绪");
  await cdp(ws, "Page.bringToFront");
  await waitFor(ws, `document.querySelectorAll('.tree-item').length >= 3`, 30000);

  const pid = child.pid;
  const row = (label, value) => console.log(`${label.padEnd(28, " ")} ${value} MB`);

  await sleep(25000);
  row("A 空闲 25s", measure(pid));

  await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('mem-mermaid大笔记')); t?.click(); return !!t; })()`);
  await waitFor(ws, `document.querySelectorAll('.qn-mermaid-box svg, [class*="mermaid"]').length >= 5`, 30000).catch(() => {});
  await sleep(3000);
  row("B mermaid 笔记（30 图）", measure(pid));

  for (let cycle = 1; cycle <= 5; cycle += 1) {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('mem-表格.xlsx')); t?.click(); return !!t; })()`);
    await sleep(2500);
    await evaluate(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
    await sleep(800);
    row(`C${cycle} xlsx 开→关`, measure(pid));
  }

  await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('mem-大文本')); t?.click(); return !!t; })()`);
  await sleep(2000);
  row("D 大文本", measure(pid));
  await sleep(5000);
  row("D2 静置 5s", measure(pid));

  console.log("\n判定：C1..C5 与 B/D 不应单调上涨（M5 口径）。");
  stop(0);
} catch (e) {
  console.error("压测失败：", e);
  stop(1);
}

async function waitFor(ws, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(ws, expression)) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

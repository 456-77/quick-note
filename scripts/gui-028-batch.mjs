// 0.28 批次验收：本轮反馈的桌面端关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 + 临时
// 仓库），结束时自清理。
//
// 覆盖：
// - 标签索引跳过围栏代码块/行内代码；标签行只有「⋯」菜单（无多余 ›）、置顶可用
// - 背景预览可见（棋盘格不再盖住图片）+ 清晰度/锐化滤镜 + 图层 filter 含锐化
// - 设置下拉框改为自绘现代菜单（原生 select 仍保留，GUI 脚本可操作）
// - 同步按钮旁显示状态，同步中按钮禁用、完成后恢复
// - 最近文件弹窗「已编辑」按 mtime 排序（没打开过的文件也在）
// - 日历日格：有/无日记圆点时数字位置与格高一致
// - PDF 预览：Ctrl+滚轮缩放、放大到上限按钮禁用、手动放大真正变宽（不再被 max-width 卡住）
// - 单词本改为账户级：读应用配置目录全局文件、旧仓库文件只迁移一次
// - 应用图标（favicon/关于页）已是方案 D

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { utimesSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9388";
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

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}`;

const waitFor = async (ws, expression, timeoutMs, pollMs = 300) => {
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
const CTRL = 2;
const CTRL_SHIFT = 2 | 8;

// ------------------------------------------------ 自备数据：临时仓库

const work = join(tmpdir(), `qn-028-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vault = join(work, "vault");
mkdirSync(vault, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

/** 最小可解析的 PDF（一页 Helvetica 文本），用来测预览缩放。 */
function makePdf() {
  const stream = "BT /F1 24 Tf 72 720 Td (Hello Quick Note PDF) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets[index] = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// 标签源：正文标签 + 代码块/行内代码里的同名样式（不应进索引）
writeFileSync(
  join(vault, "qn28标签源.md"),
  [
    "# 0.28 标签源",
    "",
    "#真标签 #置顶q28",
    "",
    "正文里的 `#行内代码` 不算标签。",
    "",
    "```text",
    "#代码标签",
    "```",
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(join(vault, "qn28笔记.md"), `# 0.28 批测\n\n打开这一篇。\n`, "utf8");
writeFileSync(join(vault, "乙.md"), `# 乙\n\n从没打开过，但文件更新时间更早。\n`, "utf8");
writeFileSync(join(vault, `${todayStr}.md`), `# 今天\n\n日记正文。\n`, "utf8");
writeFileSync(join(vault, "sample.pdf"), makePdf());
writeFileSync(
  join(vault, "单词本.md"),
  ["# 单词本", "", "## 待学习", "", "- alpha | 阿尔法 | | — 2026-10-01 · 种子", "", "## 已掌握", ""].join("\n"),
  "utf8",
);
// 1x1 PNG（背景图选择用）
writeFileSync(
  join(vault, "背景图.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

// mtime：乙 最旧，标签源更早于笔记（「已编辑」排序断言用）
const old = new Date("2020-01-02T03:04:05Z");
const mid = new Date("2024-05-06T07:08:09Z");
utimesSync(join(vault, "乙.md"), old, old);
utimesSync(join(vault, "qn28标签源.md"), mid, mid);

const spawnInstance = () =>
  spawn(exe, [vault.replace(/\\/g, "/")], {
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
  const pages = targets.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  const page = pages[0];
  if (!page) throw new Error(`没有找到 page 目标（${pages.length} 个）`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  await cdp(ws, "Page.bringToFront");
  return ws;
};

const appConfig = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "com.quicknote.gui-test",
);
const globalVocab = join(appConfig, "vocabulary.md");
const migratedFile = join(appConfig, "vocabulary-migrated.json");

let child = null;
let ws = null;
let stub = null;

try {
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });
  rmSync(join(appConfig, "open-vaults.json"), { force: true });
  // 单词本迁移是"每个仓库一次"：清掉全局文件与标记，才能验证种子库被合并
  rmSync(globalVocab, { force: true });
  rmSync(migratedFile, { force: true });

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

  // ============================================== 1. 标签：代码跳过 + ⋯ 菜单
  {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn28标签源')); t?.click(); return !!t; })()`);
    await waitFor(ws, `document.querySelectorAll('.cm-line').length > 0`, 10000);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.left-view-tab')].find((el) => el.textContent.includes('标签')); b?.click(); return !!b; })()`);
    await waitFor(ws, `document.querySelectorAll('.tag-dash-row').length > 0`, 15000);
    const labels = await evaluate(ws, `[...document.querySelectorAll('.tag-dash-row .tree-label')].map((el) => el.textContent).join('|')`);
    check(labels.includes("真标签") && labels.includes("置顶q28"), "正文标签进入索引", labels);
    check(!labels.includes("代码标签") && !labels.includes("行内代码"), "代码块/行内代码里的 # 不进标签索引", labels);
    const rowShape = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('.tag-dash-row')].find((el) => el.textContent.includes('真标签'));
      if (!row) return null;
      return { svgs: row.querySelectorAll('svg').length, more: !!row.querySelector('.tag-dash-more'), tail: row.textContent.trim() };
    })()`);
    check(rowShape && rowShape.more, "标签行尾是「⋯」菜单按钮", JSON.stringify(rowShape));
    check(rowShape && rowShape.svgs === 1, "标签行不再有多余的 › 图标（只剩标签图标）", JSON.stringify(rowShape));
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('.tag-dash-row')].find((el) => el.textContent.includes('真标签'));
      row?.querySelector('.tag-dash-more')?.click();
      return !!row;
    })()`);
    const menu = await waitFor(ws, `document.querySelector('.tag-dash-menu')?.textContent ?? false`, 3000);
    check(!!menu && menu.includes("置顶") && menu.includes("重命名"), "⋯ 菜单含置顶/重命名", String(menu));
    await evaluate(ws, `(() => { [...document.querySelectorAll('.tag-dash-menu button')].find((b) => b.textContent.includes('置顶'))?.click(); return true; })()`);
    await sleep(500);
    const pinned = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('.tag-dash-row')].find((el) => el.textContent.includes('真标签'));
      return row?.classList.contains('is-pinned') ?? false;
    })()`);
    check(pinned, "菜单置顶生效（行 is-pinned）");
  }

  // ============================================== 2. 背景预览 + 锐化
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
      const opt = [...sel.options].find((o) => o.value.includes('背景图.png'));
      if (!opt) return 'no-option';
      const set = ${nativeSet}; set(sel, opt.value);
      return 'ok';
    })()`);
    const previewReady = await waitFor(ws, `!!document.querySelector('.bg-preview-img')`, 5000);
    const preview = await evaluate(ws, `(() => {
      const box = document.querySelector('.bg-preview');
      const img = document.querySelector('.bg-preview-img');
      if (!box || !img) return null;
      const before = getComputedStyle(box, '::before');
      const imgStyle = getComputedStyle(img);
      return {
        bg: imgStyle.backgroundImage,
        filter: imgStyle.filter,
        checker: before.content,
        hint: !!document.querySelector('.bg-preview-hint'),
      };
    })()`);
    check(previewReady && preview && preview.bg.includes("url("), "背景预览显示图片（不再是空棋盘格）", JSON.stringify(preview?.bg?.slice(0, 80)));
    check(preview && preview.checker === "none", "棋盘格不再用负 z-index 伪元素盖图", String(preview?.checker));
    check(preview && preview.filter.includes("url(") && preview.filter.includes("#qn-bg-sharpen"), "预览 filter 含锐化滤镜", String(preview?.filter));
    check(preview && preview.hint, "预览角标仍在");
    const sharpRow = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === '清晰度');
      return row ? !!row.querySelector('input[type=range]') : false;
    })()`);
    check(sharpRow, "设置里出现「清晰度」滑杆");
    await sleep(600);
    const layer = await evaluate(ws, `(() => { const el = document.getElementById('qn-bg-layer'); return el ? el.style.filter : null; })()`);
    check(layer && layer.includes("#qn-bg-sharpen"), "背景图层 filter 含锐化（低分辨率放大后不发虚）", String(layer));
  }

  // ============================================== 3. 设置下拉（自绘菜单）
  {
    const selects = await evaluate(ws, `document.querySelectorAll('[data-sec="appearance"] select, [data-sec="general"] select, [data-sec="sync"] select').length`);
    check(selects >= 7, `设置里保留原生 select（GUI/读屏可操作，${selects} 个）`);
    const opened = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === 'Markdown 渲染风格');
      const trigger = row?.querySelector('.settings-select-trigger');
      trigger?.click();
      return trigger ? trigger.getBoundingClientRect().height : 0;
    })()`);
    const menuReady = await waitFor(ws, `!!document.querySelector('.settings-select-menu')`, 3000);
    const menuStyle = await evaluate(ws, `(() => {
      const m = document.querySelector('.settings-select-menu');
      if (!m) return null;
      const st = getComputedStyle(m);
      return { radius: st.borderRadius, shadow: st.boxShadow, role: m.getAttribute('role'), options: m.querySelectorAll('[role=option]').length };
    })()`);
    check(!!opened && opened >= 30, "下拉触发器高度 32px（与输入框同规格）", String(opened));
    check(menuReady && menuStyle && menuStyle.radius !== "0px" && menuStyle.role === "listbox", "下拉菜单是自绘圆角列表（不再是系统白框）", JSON.stringify(menuStyle));
    await evaluate(ws, `(() => { [...document.querySelectorAll('.settings-select-option')].find((b) => b.textContent.includes('Blue Topaz'))?.click(); return true; })()`);
    await sleep(500);
    const label = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === 'Markdown 渲染风格');
      return row?.querySelector('.settings-select-label')?.textContent ?? '';
    })()`);
    check(label.includes("Blue Topaz"), "选中后触发器文案更新", label);
    // 切回默认
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="appearance"] .settings-row')].find((r) => r.querySelector('span')?.textContent === 'Markdown 渲染风格');
      row?.querySelector('.settings-select-trigger')?.click();
      return true;
    })()`);
    await waitFor(ws, `!!document.querySelector('.settings-select-menu')`, 3000);
    await evaluate(ws, `(() => { [...document.querySelectorAll('.settings-select-option')].find((b) => b.textContent.trim().startsWith('默认'))?.click(); return true; })()`);
  }

  // ============================================== 4. 同步按钮状态 + 禁点
  {
    let pending = null;
    stub = createServer((req, res) => {
      if (req.url?.includes("/auth/login")) {
        pending = { res };
        // 拖 2 秒再回 500：给"同步中…"留出稳定的断言窗口
        setTimeout(() => {
          if (pending?.res === res && !res.writableEnded) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end('{"message":"stub"}');
          }
        }, 2000);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const stubPort = stub.address().port;
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('同步')); b?.click(); return !!b; })()`);
    await sleep(300);
    const setRow = async (label, value) =>
      evaluate(ws, `(() => {
        const row = [...document.querySelectorAll('[data-sec="sync"] .settings-row')].find((r) => r.querySelector('span')?.textContent === ${JSON.stringify(label)});
        const el = row?.querySelector('input');
        if (!el) return 'no-row';
        const set = ${nativeSet}; set(el, ${JSON.stringify(value)});
        return 'ok';
      })()`);
    await setRow("服务端地址", `http://127.0.0.1:${stubPort}`);
    await setRow("账号", "qf");
    await setRow("密码", "pw");
    await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll('[data-sec="sync"] .settings-row')].find((r) => r.querySelector('span')?.textContent === '启用自动同步');
      const cb = row?.querySelector('input[type=checkbox]');
      if (cb && !cb.checked) cb.click();
      return !!cb;
    })()`);
    await sleep(400);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('[data-sec="sync"] button')].find((el) => el.textContent.trim() === '立即同步'); b?.click(); return !!b; })()`);
    await sleep(300);
    const busy = await evaluate(ws, `(() => {
      const b = [...document.querySelectorAll('[data-sec="sync"] button')].find((el) => el.textContent.includes('同步中'));
      const status = document.querySelector('[data-sec="sync"] .settings-sync-status');
      return { disabled: b ? b.disabled : null, text: b?.textContent ?? '', status: status?.textContent ?? '',  kind: status?.dataset.syncStatus ?? '' };
    })()`);
    check(busy.disabled === true && busy.text.includes("同步中"), "同步中：按钮禁用且文案切换", JSON.stringify(busy));
    check(busy.status.includes("同步中") && busy.kind === "syncing", "按钮旁显示「同步中…」状态", JSON.stringify(busy));
    await sleep(3500);
    const after = await evaluate(ws, `(() => {
      const b = [...document.querySelectorAll('[data-sec="sync"] button')].find((el) => el.textContent.trim() === '立即同步');
      const status = document.querySelector('[data-sec="sync"] .settings-sync-status');
      return { disabled: b ? b.disabled : null, kind: status?.dataset.syncStatus ?? '', text: status?.textContent ?? '' };
    })()`);
    check(after.disabled === false && after.kind === "error", "同步失败后按钮恢复可点、状态显示失败原因", JSON.stringify(after));
    stub.close();
    stub = null;
    // 关设置
    await evaluate(ws, `document.querySelector('.settings-nav-head .icon-btn')?.click()`);
    await sleep(400);
  }

  // ============================================== 5. 最近文件「已编辑」
  {
    await key(ws, { mod: CTRL_SHIFT, key: "E" }, "KeyE", 69);
    const open = await waitFor(ws, `!!document.querySelector('.recent-dialog')`, 5000);
    check(!!open, "Ctrl+Shift+E 打开最近文件弹窗");
    const modes = await evaluate(ws, `[...document.querySelectorAll('.recent-mode')].map((b) => b.textContent.trim()).join('|')`);
    check(modes.includes("最近打开") && modes.includes("已编辑"), "弹窗有「最近打开 / 已编辑」两档", modes);
    await evaluate(ws, `(() => { [...document.querySelectorAll('.recent-mode')].find((b) => b.textContent.includes('已编辑'))?.click(); return true; })()`);
    await sleep(400);
    const names = await evaluate(ws, `[...document.querySelectorAll('.recent-item .recent-name')].map((el) => el.textContent)`);
    check(names.includes("乙.md"), "「已编辑」包含从未打开过、但改过的文件", JSON.stringify(names));
    check(
      names.indexOf("qn28标签源.md") >= 0 && names.indexOf("qn28标签源.md") < names.indexOf("乙.md"),
      "「已编辑」按修改时间倒序（新的在前）",
      JSON.stringify(names),
    );
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
  }

  // ============================================== 6. 日历日格等高
  {
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.sidebar-tab')].find((el) => el.textContent.includes('日历')); b?.click(); return !!b; })()`);
    const grid = await waitFor(ws, `document.querySelectorAll('.cal-day').length > 20`, 10000);
    const cells = await evaluate(ws, `(() => {
      const out = [];
      for (const cell of document.querySelectorAll('.cal-day')) {
        const num = cell.querySelector('.cal-day-num');
        const cr = cell.getBoundingClientRect();
        const nr = num.getBoundingClientRect();
        out.push({ h: Math.round(cr.height * 10) / 10, offset: Math.round((nr.top + nr.height / 2 - cr.top) * 10) / 10, dot: !!cell.querySelector('.cal-dot') });
      }
      return out;
    })()`);
    const heights = new Set(cells.map((c) => c.h));
    const offsets = new Set(cells.map((c) => c.offset));
    check(grid && heights.size === 1 && cells[0].h === 34, "所有日格同高（34px）", [...heights].join(","));
    check(offsets.size === 1, "有/无日记圆点时数字垂直位置一致", [...offsets].join(","));
    check(cells.some((c) => c.dot), "今天有日记 → 有圆点样本");
  }

  // ============================================== 7. PDF 预览缩放
  {
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.left-view-tab')].find((el) => el.textContent.includes('知识库')); b?.click(); return !!b; })()`);
    await sleep(300);
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('sample.pdf')); t?.click(); return !!t; })()`);
    const preview = await waitFor(ws, `!!document.querySelector('.file-preview-pdf-page canvas')`, 20000);
    check(!!preview, "PDF 预览渲染出画布");
    const readZoom = () => evaluate(ws, `(() => {
      const v = document.querySelector('.file-preview-zoom-value')?.textContent ?? '';
      const wide = document.querySelector('.file-preview-pdf-page')?.getBoundingClientRect().width ?? 0;
      const plus = document.querySelector('.file-preview-zoom-in');
      return { pct: parseInt(v, 10) || 0, width: Math.round(wide), plusDisabled: plus ? plus.disabled : null };
    })()`);
    const before = await readZoom();
    await evaluate(ws, `(() => { document.querySelector('.file-preview-zoom-in')?.click(); return true; })()`);
    await sleep(500);
    const afterClick = await readZoom();
    check(afterClick.pct > before.pct && afterClick.width > before.width, "点击放大：比例和页面宽度同时变大", `${JSON.stringify(before)} → ${JSON.stringify(afterClick)}`);
    // Ctrl+滚轮
    const rect = await evaluate(ws, `(() => { const el = document.querySelector('.file-preview-pdf'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x, y: rect.y, deltaX: 0, deltaY: -120, modifiers: CTRL });
    await sleep(600);
    const afterWheel = await readZoom();
    check(afterWheel.pct > afterClick.pct, "Ctrl+滚轮向上放大 PDF", `${afterClick.pct}% → ${afterWheel.pct}%`);
    // 一直点到上限
    for (let i = 0; i < 45; i += 1) {
      const state = await readZoom();
      if (state.plusDisabled) break;
      await evaluate(ws, `(() => { document.querySelector('.file-preview-zoom-in')?.click(); return true; })()`);
      await sleep(80);
    }
    const maxed = await readZoom();
    check(maxed.pct === 300 && maxed.plusDisabled === true, "放大到上限 300% 后按钮禁用、比例不再涨", JSON.stringify(maxed));
    await evaluate(ws, `(() => { document.querySelector('.file-preview-zoom-in')?.click(); return true; })()`);
    await sleep(300);
    const stillMax = await readZoom();
    check(stillMax.pct === 300, "上限后再点不变（不会出现比例虚涨）", JSON.stringify(stillMax));
    await key(ws, { mod: 0, key: "Escape" }, "Escape", 27);
    await sleep(300);
  }

  // ============================================== 8. 单词本账户级
  {
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.sidebar-tab')].find((el) => el.textContent.includes('单词')); b?.click(); return !!b; })()`);
    const loaded = await waitFor(ws, `[...document.querySelectorAll('.vocab-panel *')].some((el) => el.textContent === 'alpha')`, 15000);
    check(!!loaded, "旧仓库单词本已迁移进面板");
    const globalText = existsSync(globalVocab) ? readFileSync(globalVocab, "utf8") : "";
    check(globalText.includes("alpha"), "全局单词本文件已生成（应用配置目录 vocabulary.md）", globalVocab);
    // 直接改全局文件 → 刷新可见；改仓库旧文件 → 刷新不可见（迁移只做一次）
    writeFileSync(
      globalVocab,
      `${globalText.trimEnd()}\n- beta | 贝塔 | | — 2026-10-21 · 全局\n`,
      "utf8",
    );
    await evaluate(ws, `document.querySelector('.vocab-refresh')?.click()`);
    const betaSeen = await waitFor(ws, `[...document.querySelectorAll('.vocab-panel *')].some((el) => el.textContent === 'beta')`, 8000);
    check(!!betaSeen, "改全局文件后刷新可见（所有仓库共用同一份）");
    writeFileSync(
      join(vault, "单词本.md"),
      `${readFileSync(join(vault, "单词本.md"), "utf8").trimEnd()}\n- gamma | 伽马 | | — 2026-10-21 · 仓库旧文件\n`,
      "utf8",
    );
    await evaluate(ws, `document.querySelector('.vocab-refresh')?.click()`);
    await sleep(1500);
    const gammaSeen = await evaluate(ws, `[...document.querySelectorAll('.vocab-panel *')].some((el) => el.textContent === 'gamma')`);
    check(!gammaSeen, "已迁移仓库的旧 单词本.md 不再参与读写（不会复活旧词）");
  }

  // ============================================== 9. 图标方案 D
  {
    // 0.29 起图标换成用户提供的渲染版：favicon/关于页走 qn-icon.png（PNG 全套
    // 由 tauri icon 从 scripts/icon-source.png 生成）。0.28 的 svg 断言随之更新。
    const pngHead = await evaluate(ws, `fetch('/qn-icon.png').then((r) => r.arrayBuffer()).then((b) => {
      const head = new Uint8Array(b.slice(0, 4));
      return String.fromCharCode(head[0], head[1], head[2], head[3]);
    })`);
    check(pngHead === "PNG", "favicon/关于页图标是 PNG（0.29 渲染版方案 D）", JSON.stringify(pngHead));
    const html = await evaluate(ws, `fetch('/').then((r) => r.text())`);
    check(html.includes("/qn-icon.png") && !html.includes("qn-icon.svg"), "index.html 的 favicon 指向 qn-icon.png");
  }

  console.log(failures === 0 ? "\n0.28 批测全部通过 ✓" : `\n共 ${failures} 项失败 ✗`);
} catch (err) {
  failures += 1;
  console.error(`脚本级失败：${err instanceof Error ? err.message : String(err)}`);
} finally {
  try {
    stub?.close();
  } catch {}
  try {
    ws?.close();
  } catch {}
  try {
    child?.kill();
  } catch {}
  await sleep(2500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

process.exit(failures === 0 ? 0 : 1);

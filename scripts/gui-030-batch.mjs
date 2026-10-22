// 0.30 批次验收：本轮 4 项反馈的桌面端关键路径断言（发版前脚本）。
// 前置：gui-test 变体 exe 已构建（target/release/quick-note.exe，identifier=
// com.quicknote.gui-test）。脚本自己拉起实例（独立 UDF + 独立 CDP 端口 + 临时
// 仓库），结束时自清理。
//
// 覆盖：
// - 全局搜索两组独立展示：标题命中的文件在「内容」组也列出（0.30 反馈
//   「在内容类别下也显示文件」——此前为跨组去重被压掉）
// - 代码块上下对称：收尾围栏行是一行代码的等高空行（0.30 反馈「底部少一行，
//   上下不对称」）
// - 添加单词自动在线释义：Ctrl+Alt+U 弹窗落盘后后台查询回填释义+音标
//   （0.30 反馈「添加单词时自动搜索在线释义」；真网络，有道免 key 通道）
// - 新图标全链路：favicon 字节与 128x128@2x 一致、关于页 logo 正常渲染
//   （0.30 反馈「更新软件图标，背景透明」）

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9420";
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
const CTRL_ALT = 3;

const nativeSet = `(el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}`;

/** 与页面内一致的 31 进制字节折叠哈希（int32 溢出口径一致）。 */
const foldHash = (buf) => {
  let h = 0;
  for (const byte of buf) h = (Math.imul(h, 31) + byte) | 0;
  return h;
};

// ------------------------------------------------ 自备数据：临时仓库

const work = join(tmpdir(), `qn-030-${Date.now()}`);
mkdirSync(work, { recursive: true });
const vaultA = join(work, "主库A").replace(/\\/g, "/");
mkdirSync(vaultA, { recursive: true });
const udf = join(work, "udf");
mkdirSync(udf, { recursive: true });

// 标题+内容都命中（0.30 反馈的主角：它必须在两组都出现）
writeFileSync(
  join(vaultA, "qn30表格清单.md"),
  ["# qn30表格清单", "", "这里正文也含 qn30表 令牌，用于内容组命中。"].join("\n"),
  "utf8",
);
// 只有内容命中（对照组：只该出现在内容组）
writeFileSync(
  join(vaultA, "qn30纯内容.md"),
  ["# 完全无关的标题", "", "只有正文里出现 qn30表 这个词。"].join("\n"),
  "utf8",
);
// 代码块（围栏行等高断言用）
writeFileSync(
  join(vaultA, "qn30代码块.md"),
  ["# qn30代码块", "", "```bash", "echo hello qn30", "echo second line", "```", "", "正文收尾。"].join("\n"),
  "utf8",
);

/** 本机配置目录（gui-test 变体独立）。 */
const appConfig = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"),
  "com.quicknote.gui-test",
);
const vocabFile = join(appConfig, "vocabulary.md");
// 种一份不含 scenario 的干净词库：加词后的自动回填断言才有基线
mkdirSync(appConfig, { recursive: true });
writeFileSync(vocabFile, ["# 单词本", "", "## 待学习", "", "## 已掌握", "", ""].join("\n"), "utf8");

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

try {
  rmSync(udf, { recursive: true, force: true });
  mkdirSync(udf, { recursive: true });

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

  // ============================================== 1. 代码块上下对称
  {
    await evaluate(ws, `(() => { const t = [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.includes('qn30代码块')); t?.click(); return !!t; })()`);
    await waitFor(ws, `[...document.querySelectorAll('.cm-line')].some((el) => (el.innerText ?? '').includes('echo hello'))`, 10000);
    await sleep(400); // 等装饰build一遍
    const heights = await evaluate(ws, `(() => {
      const fence = document.querySelector('.cm-line.cm-lp-fence');
      const code = [...document.querySelectorAll('.cm-line')].find((el) => el.className.includes('cm-lp-codeblock') && (el.innerText ?? '').includes('echo hello'));
      return { fence: fence?.getBoundingClientRect().height ?? null, code: code?.getBoundingClientRect().height ?? null };
    })()`);
    check(
      heights.fence !== null && heights.code !== null && Math.abs(heights.fence - heights.code) < 2,
      "代码块收尾围栏行与代码行等高（底部不再贴边）",
      JSON.stringify(heights),
    );
  }

  // ============================================== 2. 全局搜索：标题命中的文件两组都显示
  {
    await key(ws, { mod: CTRL, key: "k" }, "KeyK", 75);
    await waitFor(ws, `!!document.querySelector('.palette-input')`, 5000);
    await evaluate(ws, `(() => {
      const input = document.querySelector('.palette-input');
      const set = ${nativeSet}; set(input, "qn30表");
      return true;
    })()`);
    const ready = await waitFor(ws, `(() => {
      const groups = [...document.querySelectorAll('.palette-group')].map((g) => ({
        name: g.querySelector('.palette-group-name')?.textContent ?? '',
        titles: [...g.querySelectorAll('.palette-item-title')].map((t) => t.textContent ?? ''),
      }));
      const content = groups.find((g) => g.name === '内容');
      return !!content && content.titles.some((t) => t.includes('qn30表格清单')) && content.titles.some((t) => t.includes('qn30纯内容'));
    })()`, 12000);
    const groups = await evaluate(ws, `(() => {
      return [...document.querySelectorAll('.palette-group')].map((g) => ({
        name: g.querySelector('.palette-group-name')?.textContent ?? '',
        titles: [...g.querySelectorAll('.palette-item-title')].map((t) => t.textContent ?? ''),
      }));
    })()`);
    const notes = groups.find((g) => g.name === "笔记");
    const content = groups.find((g) => g.name === "内容");
    check(!!ready, "搜索出结果（两组齐备）", JSON.stringify(groups));
    check(!!notes?.titles.some((t) => t.includes("qn30表格清单")), "笔记组列出标题命中的文件", JSON.stringify(notes));
    check(
      !!content?.titles.some((t) => t.includes("qn30表格清单")),
      "内容组也列出该文件（0.30 此前被跨组去重压掉）",
      JSON.stringify(content),
    );
    check(
      !!content?.titles.some((t) => t.includes("qn30纯内容")),
      "内容组正常列出纯内容命中",
      JSON.stringify(content),
    );
    check(!notes?.titles.some((t) => t.includes("qn30纯内容")), "笔记组不列纯内容命中的文件", JSON.stringify(notes));
    await evaluate(ws, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
    await sleep(300);
  }

  // ============================================== 3. 添加单词自动在线释义（真网络）
  {
    await key(ws, { mod: CTRL_ALT, key: "u" }, "KeyU", 85);
    const dialogUp = await waitFor(ws, `!!document.querySelector('.add-word-input')`, 5000);
    check(dialogUp, "Ctrl+Alt+U 弹出添加单词弹窗");
    await evaluate(ws, `(() => {
      const input = document.querySelector('.add-word-input');
      const set = ${nativeSet}; set(input, "Scenario");
      return true;
    })()`);
    await key(ws, { mod: 0, key: "Enter" }, "Enter", 13);
    const queued = await waitFor(ws, `document.querySelector('.add-word-message')?.textContent.includes('正在查询') ?? false`, 5000);
    check(queued, "落盘立即返回（提示正在查询在线释义，不阻塞录入）", await evaluate(ws, `document.querySelector('.add-word-message')?.textContent ?? ''`));
    // 后台查询回填：轮询账户级单词本文件，scenario 行出现非空释义与音标
    let filled = null;
    for (let i = 0; i < 50 && !filled; i += 1) {
      await sleep(500);
      try {
        const text = readFileSync(vocabFile, "utf8");
        const line = text.split(/\r?\n/).find((row) => row.trim().startsWith("- scenario |"));
        if (!line) continue;
        const parts = line.split("|");
        const meaning = (parts[1] ?? "").trim();
        const phonetic = (parts[3] ?? "").split("—")[0].trim();
        if (meaning.length > 2 && phonetic.startsWith("/")) filled = { line, meaning, phonetic };
      } catch {}
    }
    check(!!filled, "词自动补全在线释义与音标（有道免 key 通道）", filled ? filled.line : readFileSync(vocabFile, "utf8"));
    const cleared = await evaluate(ws, `document.querySelector('.add-word-input')?.value ?? '(gone)'`);
    check(cleared === "", "回车后输入框清空（连续录入保留）", cleared);
    // 落盘的词统一小写（0.26 规范延续）
    const lowercased = existsSync(vocabFile) ? !readFileSync(vocabFile, "utf8").includes("Scenario") : false;
    check(lowercased, "词统一转小写落盘");
    await evaluate(ws, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
    await sleep(300);
  }

  // ============================================== 4. 新图标全链路
  {
    const source = readFileSync(join(root, "src-tauri", "icons", "128x128@2x.png"));
    const favicon = readFileSync(join(root, "public", "qn-icon.png"));
    const served = await evaluate(ws, `(async () => await fetch('/qn-icon.png').then((r) => r.arrayBuffer()).then((b) => {
      const u = new Uint8Array(b);
      let h = 0;
      for (const x of u) h = (Math.imul(h, 31) + x) | 0;
      return { len: u.length, h };
    }))()`);
    check(
      served.len === source.length && served.h === foldHash(source),
      "favicon 与生成的 256px 图标字节一致（透明背景新图）",
      JSON.stringify({ served: served.len, local: source.length }),
    );
    check(foldHash(favicon) === foldHash(source), "public/qn-icon.png 与 128x128@2x 同步");
    // 关于页 logo 渲染（宽 256 = 128x128@2x）
    await evaluate(ws, `(() => { document.querySelector('.topbar .icon-btn[title^="设置"]')?.click(); return true; })()`);
    await waitFor(ws, `!!document.querySelector('.settings-panel')`, 5000);
    await evaluate(ws, `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.textContent.includes('关于')); b?.click(); return !!b; })()`);
    const logo = await waitFor(ws, `(document.querySelector('.about-logo')?.naturalWidth ?? 0) > 0`, 5000);
    const width = await evaluate(ws, `document.querySelector('.about-logo')?.naturalWidth ?? 0`);
    check(logo && width === 256, "关于页 logo 正常加载（256px 新图）", String(width));
    await evaluate(ws, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
  }
} catch (error) {
  failures += 1;
  console.error(`批测异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    ws?.close();
  } catch {}
  child?.kill();
  await sleep(800);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

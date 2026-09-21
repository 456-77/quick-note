// 复现「新建笔记复用已有内容 / 重命名后内容消失」。
// 用法：node scripts/repro-create-rename.mjs
// 前置：vite 已在 1420；调试 exe 由本脚本自己拉起（独立 profile + CDP 9333 + 临时仓库）。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "H:/develop/project/quick-note";
const EXE = join(ROOT, "src-tauri/target/debug/quick-note.exe");
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

let nextId = 1;
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
    ws.addEventListener("open", () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const mid = nextId++;
        pending.set(mid, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
      close: () => ws.close(),
    }));
    ws.addEventListener("error", () => reject(new Error("ws 连接失败")));
  });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
    throw new Error("PAGE ERR: " + text);
  }
  return r.result?.value;
}

const nativeSet = (selector, value) => {
  const el = document.querySelector(selector);
  if (!el) return "NO_EL";
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  return "OK:" + el.value;
};

async function main() {
  // 端口被占（上一次的实例还活着）会让本脚本连到旧实例、状态全错——宁可失败
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
    throw new Error(`端口 ${PORT} 已被占用：先杀掉遗留的调试实例再跑`);
  } catch (e) {
    if (!String(e?.cause?.code || "").includes("ECONNREFUSED") && String(e.message).includes("占用")) throw e;
  }

  const work = mkdtempSync(join(tmpdir(), "qn-repro-"));
  const vault = join(work, "vault");
  const profile = join(work, "profile");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "已有笔记.md"), "这是已有笔记的内容");

  const exe = spawn(EXE, [vault], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + PORT,
      // 隔离应用配置目录（%APPDATA%/com.quicknote.app）：那里有**共享的**
      // sync-state.json，带着真实同步服务器地址——不隔离的话测试实例会连上
      // 真实服务做全量双向同步（本仓库 0.8.0 轮实测踩过：测试垃圾文件被推上云端）。
      APPDATA: join(work, "appdata"),
      LOCALAPPDATA: join(work, "localappdata"),
    },
  });
  console.log("exe pid:", exe.pid, "vault:", vault);

  // 等 CDP 端口就绪
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await getTargets();
      target = list.find((t) => t.type === "page" && t.url.includes("1420"));
      if (!target && list.length) target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
  }
  if (!target) throw new Error("CDP target 未出现");
  console.log("target:", target.url);

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Page.bringToFront");

  // 在页面任何脚本运行前给 window.__TAURI_INTERNALS__ 装 setter：Tauri 的 init 脚本
  // 每次 load 都会**重新赋值**这个对象（直接替换会被它覆盖回去），setter 能在它赋值
  // 后立刻包一层。拦截所有 sync_* 命令——共享的 sync-state.json 带着真实服务器地址，
  // 不拦住测试实例会连真实服务做全量双向同步（0.8.0 轮实测踩过：测试垃圾上云）。
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__qnInjectRan = (window.__qnInjectRan || 0) + 1;
      try {
        let real = undefined;
        const wrap = (internals) => {
        const orig = internals.invoke;
        if (typeof orig !== "function") return internals;
        const patched = Object.create(internals);
        patched.invoke = (cmd, args, opts) => {
          if (typeof cmd === "string" && cmd.startsWith("sync_")) {
            return Promise.resolve(null);
          }
          return orig.call(internals, cmd, args, opts);
        };
        Object.defineProperty(patched, "__qnSyncBlocked", { value: true });
        return patched;
      };
      let defined = true;
      try {
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          configurable: true,
          get() { return real; },
          set(v) { real = wrap(v); },
        });
      } catch (e) { defined = false; window.__qnDefineErr = String(e); }
      window.__qnDefineOk = defined;
    })()`,
  });

  // 种仓库路径并刷新（全新 profile 首次启动未选仓库）
  await sleep(1500);
  const seeded = await evaluate(cdp, `(() => {
    try {
      localStorage.setItem("quicknote.vault", ${JSON.stringify(vault)});
      return "SEEDED";
    } catch (e) { return "ERR:" + e.message; }
  })()`);
  console.log("seed:", seeded);
  if (seeded.startsWith("SEEDED")) {
    await cdp.send("Page.reload");
    await sleep(2500);
  }

  // 等应用就绪：树里有内容 && __qnView 存在
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(cdp, `(() => {
      try {
        return JSON.stringify({
          tree: document.querySelectorAll(".tree-item").length,
          view: !!window.__qnView,
        });
      } catch (e) { return JSON.stringify({ err: e.message }); }
    })()`);
    const st = JSON.parse(ready);
    if (st.tree > 0 && st.view) { console.log("ready:", ready); break; }
    await sleep(500);
  }

  // 键盘事件捕获计数：验证页面实际收到几个 Enter keydown
  const setProbe = await evaluate(cdp, `(() => {
    window.__enterCount = 0;
    window.__enterLog = [];
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        window.__enterCount++;
        window.__enterLog.push(document.activeElement?.placeholder || document.activeElement?.className || "?");
      }
    }, true);
    return JSON.stringify({
      syncBlocked: !!window.__TAURI_INTERNALS__?.__qnSyncBlocked,
      injectRan: window.__qnInjectRan || 0,
      defineOk: window.__qnDefineOk === true,
      defineErr: window.__qnDefineErr || null,
    });
  })()`);
  console.log("inject probe:", setProbe);
  const enterStats = () => evaluate(cdp, `JSON.stringify({ n: window.__enterCount, targets: window.__enterLog })`);

  // 宿主侧目录监视：文件事件的绝对时间线
  const t0 = Date.now();
  const { watch } = await import("node:fs");
  const watcher = watch(vault, (kind, filename) => {
    if (filename && !String(filename).startsWith(".")) {
      console.log(`[fs +${Date.now() - t0}ms] ${kind}: ${filename}`);
    }
  });

  const viewDoc = () => evaluate(cdp, `window.__qnView.state.sliceDoc()`);
  const report = {};

  const dumpState = async (label) => {
    const files = await evaluate(cdp, `(() => {
      try {
        return JSON.stringify({
          status: document.querySelector(".statusbar")?.textContent || "",
          error: document.querySelector(".banner-error")?.textContent || "",
          tabs: [...document.querySelectorAll(".tab .tab-title")].map(e => e.textContent),
          active: document.querySelector(".tab.is-active .tab-title")?.textContent || null,
          createRow: document.querySelector(".create-row input")?.placeholder || null,
          err: null,
        });
      } catch (e) { return JSON.stringify({ err: e.message }); }
    })()`);
    console.log(`[${label}] ui:`, files);
    return JSON.parse(files);
  };
  const listVault = async (label) => {
    const names = await evaluate(cdp, `(() => {
      try {
        return JSON.stringify([...document.querySelectorAll(".tree-file .tree-label")].map(e => e.textContent));
      } catch (e) { return JSON.stringify({ err: e.message }); }
    })()`);
    console.log(`[${label}] tree:`, names);
  };

  // ---------- STEP 1: 左侧「新建笔记」建「草稿」 ----------
  await evaluate(cdp, `(() => {
    const btn = [...document.querySelectorAll("button")].find(b => (b.title || "").includes("新建笔记"));
    if (!btn) return "NO_BTN";
    btn.click();
    return "CLICKED";
  })()`);
  await sleep(600);
  const setInput = await evaluate(cdp, `(${nativeSet})(".create-row input", "草稿")`);
  console.log("setInput:", setInput);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(200);
  await listVault("create+200ms");
  await dumpState("create+200ms");
  await sleep(1000);
  await listVault("create+1200ms");
  await dumpState("create+1200ms");
  report.step1_created = {
    fileExists: existsSync(join(vault, "草稿.md")),
    viewDoc: await viewDoc(),
  };
  console.log("step1:", JSON.stringify(report.step1_created));

  // ---------- STEP 2: 输入内容并等自动保存 ----------
  await evaluate(cdp, `window.__qnView.dispatch({ changes: { from: 0, insert: "第一版内容ABC" } })`);
  await sleep(1800);
  const disk1 = existsSync(join(vault, "草稿.md")) ? readFileSync(join(vault, "草稿.md"), "utf8") : "(missing)";
  report.step2_typed = { viewDoc: await viewDoc(), disk: disk1 };
  console.log("step2:", JSON.stringify(report.step2_typed));

  // ---------- STEP 3: 重命名 草稿.md -> 正式.md ----------
  const menuOpened = await evaluate(cdp, `(() => {
    const row = [...document.querySelectorAll(".tree-file")].find(el => el.querySelector(".tree-label")?.textContent === "草稿.md");
    if (!row) return "NO_ROW";
    row.querySelector(".tree-more")?.click();
    return "MENU";
  })()`);
  await sleep(500);
  const renameClicked = await evaluate(cdp, `(() => {
    const btn = [...document.querySelectorAll(".context-menu button")].find(b => b.textContent.trim() === "重命名");
    if (!btn) return "NO_RENAME_BTN";
    btn.click();
    return "RENAMING";
  })()`);
  await sleep(600);
  const renameInput = await evaluate(cdp, `(${nativeSet})(".create-row input", "正式.md")`);
  console.log("rename:", menuOpened, renameClicked, renameInput);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(150);
  console.log("enter after rename:", await enterStats());
  // 文件事件时序采样：抓出 正式.md 出现 / 草稿.md 复活 / 草稿 1.md 新建的先后
  for (let i = 0; i < 12; i++) {
    const names = await evaluate(cdp, `(() => {
      try {
        return JSON.stringify([...document.querySelectorAll(".tree-file .tree-label")].map(e => e.textContent));
      } catch (e) { return "[]"; }
    })()`);
    console.log(`[t+${(i * 150)}ms] tree:`, names);
    await sleep(150);
  }
  const disk2 = existsSync(join(vault, "正式.md")) ? readFileSync(join(vault, "正式.md"), "utf8") : "(missing)";
  const diskOld = existsSync(join(vault, "草稿.md")) ? readFileSync(join(vault, "草稿.md"), "utf8") : "(missing)";
  report.step3_renamed = {
    oldGone: !existsSync(join(vault, "草稿.md")),
    oldDisk: diskOld,
    viewDoc: await viewDoc(),
    disk: disk2,
  };
  console.log("step3:", JSON.stringify(report.step3_renamed));
  await dumpState("after-rename");
  await listVault("after-rename");

  // ---------- STEP 4: 再用旧名「草稿」新建 ----------
  await evaluate(cdp, `(() => {
    const btn = [...document.querySelectorAll("button")].find(b => (b.title || "").includes("新建笔记"));
    btn?.click();
  })()`);
  await sleep(600);
  await evaluate(cdp, `(${nativeSet})(".create-row input", "草稿")`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(1200);
  const disk3 = existsSync(join(vault, "草稿.md")) ? readFileSync(join(vault, "草稿.md"), "utf8") : "(missing)";
  report.step4_recreate = { viewDoc: await viewDoc(), disk: disk3 };
  console.log("step4:", JSON.stringify(report.step4_recreate));
  await dumpState("after-recreate");
  await listVault("after-recreate");

  writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2));
  console.log("REPORT:", JSON.stringify(report, null, 2));
  console.log("workdir:", work);
  cdp.close();
  try {
    process.kill(exe.pid);
    console.log("repro instance killed");
  } catch {}
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});

// GUI 验证：仓库打开方式——点击「最近仓库」里的仓库也要弹出「当前窗口 / 新窗口」
// 选择弹窗（vaultOpenMode = ask，默认），选「当前窗口」后整个应用切到目标仓库。
//
// 仓库下拉菜单只列「不是当前仓库」的最近仓库，所以流程是：种子一个第二仓库 →
// 点仓库胶囊 → 点第二仓库 → 断言弹窗出现 → 选当前窗口 → 断言已切过去 →
// 用同一弹窗切回原仓库（套件后续步骤还在这份应用实例上跑，不能把仓库留在第二仓库）。
//
// 前置：应用已启动（verify-gui.sh 的流程），仓库由 make-test-vault.sh 生成。
// 用法：node scripts/gui-openmode.mjs <vaultDir> [port]

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

const vault = process.argv[2] ?? "test-vault";
const port = process.argv[3] ?? "9222";

/** 第二仓库（临时目录，测完删掉）：放一篇笔记，切过去后断言文件树里是它。 */
const secondVault = join(tmpdir(), `qn-openmode-vault-${Date.now()}`);
mkdirSync(secondVault, { recursive: true });
writeFileSync(join(secondVault, "第二仓库的笔记.md"), "# 第二仓库\n", "utf8");

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
  const r = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(`页面内异常: ${r.exceptionDetails.text}`);
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

/** 点击仓库胶囊（真实点击），打开最近仓库下拉。 */
async function openVaultMenu(ws) {
  const ok = await evaluate(ws, `(() => {
    const pill = document.querySelector('.vault-pill');
    if (!pill) return false;
    pill.click();
    return true;
  })()`);
  await sleep(400);
  return ok;
}

/** 在下拉里点击指定名称的仓库。 */
async function clickVaultInMenu(ws, name) {
  const ok = await evaluate(ws, `(() => {
    const item = [...document.querySelectorAll('.vault-menu button')].find(b => b.textContent.includes(${JSON.stringify(name)}));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  await sleep(400);
  return ok;
}

/** 在选择弹窗里点「当前窗口打开」或「在新窗口打开」。 */
async function chooseVaultOpen(ws, way) {
  const label = way === "current" ? "当前窗口打开" : "在新窗口打开";
  const ok = await evaluate(ws, `(() => {
    const btn = [...document.querySelectorAll('.vault-choice-actions .btn')].find(b => b.textContent.includes(${JSON.stringify(label)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1200);
  return ok;
}

// ---------------------------------------------------------------- 连接

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
await cdp(ws, "Page.bringToFront");
await sleep(600);

try {
  console.log("最近仓库的打开方式弹窗\n");

  // 种子最近仓库列表（应用启动时读取），只放第二仓库；重载后生效。
  await evaluate(
    ws,
    `localStorage.setItem('quicknote.vaultRecents', JSON.stringify([${JSON.stringify(secondVault)}])); true`,
  );
  await cdp(ws, "Page.reload").catch(() => undefined);
  let booted = false;
  for (let i = 0; i < 30 && !booted; i += 1) {
    await sleep(500);
    booted = await evaluate(
      ws,
      `(() => { try { return !!document.querySelector('.vault-pill') && document.querySelectorAll('.tree-item').length > 0; } catch { return false; } })()`,
    ).catch(() => false);
  }
  check(booted, "已种子最近仓库列表并重载（应用就绪）");

  check(await openVaultMenu(ws), "点击仓库胶囊打开下拉");
  check(
    await evaluate(ws, `!!document.querySelector('.vault-menu')`),
    "下拉菜单出现",
  );
  check(
    await clickVaultInMenu(ws, "qn-openmode-vault"),
    "点击最近仓库「第二仓库」",
  );
  check(
    await evaluate(ws, `(() => {
      const dialog = document.querySelector('.vault-choice');
      if (!dialog) return false;
      return dialog.textContent.includes('当前窗口打开') && dialog.textContent.includes('在新窗口打开');
    })()`),
    "点击最近仓库也弹出打开方式选择弹窗（此前直接切仓库）",
  );

  check(await chooseVaultOpen(ws, "current"), "选择「当前窗口打开」");
  const pillText = await evaluate(ws, `document.querySelector('.vault-pill')?.textContent ?? ''`);
  check(pillText.includes("qn-openmode-vault"), "仓库已切到第二仓库（胶囊显示新名字）", pillText);
  check(
    await evaluate(ws, `[...document.querySelectorAll('.tree-label')].some(e => e.textContent.includes('第二仓库的笔记'))`),
    "文件树显示第二仓库的笔记",
  );
  check(
    (await evaluate(ws, `JSON.parse(localStorage.getItem('quicknote.settings') ?? '{}').vaultOpenMode ?? 'ask'`)) === "ask",
    "未勾「记住选择」时打开方式保持 ask（下次仍询问）",
  );

  // 切回原仓库：同样的弹窗流程（套件后续步骤还在同一实例上跑）。
  check(await openVaultMenu(ws), "再次打开仓库下拉");
  check(await clickVaultInMenu(ws, basename(vault)), "点击最近仓库里的原仓库");
  check(await evaluate(ws, `!!document.querySelector('.vault-choice')`), "弹窗再次出现");
  check(await chooseVaultOpen(ws, "current"), "选择「当前窗口打开」切回");
  const pillBack = await evaluate(ws, `document.querySelector('.vault-pill')?.textContent ?? ''`);
  check(pillBack.includes(basename(vault)), "已切回原仓库", pillBack);
  check(
    await evaluate(ws, `[...document.querySelectorAll('.tree-label')].some(e => e.textContent.includes('features'))`),
    "文件树恢复显示原仓库内容",
  );
} finally {
  ws.close();
  // 第二仓库整个删掉；应用侧现在停在原仓库，不残留状态。
  if (existsSync(secondVault)) rmSync(secondVault, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n仓库打开方式验证通过 ✓" : `\n失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env bash
# GUI 端到端验收：启动真实应用，用 CDP 读取渲染后的 DOM 并模拟真实输入。
#
#   ./scripts/verify-gui.sh
#
# 覆盖内容：
#   1. 应用渲染、仓库载入、文件树内容（Rust 命令 → IPC → React）
#   2. 打开 CRLF 笔记、编辑器渲染、状态栏换行符/BOM 显示
#   3. 真实鼠标点击 + 键盘输入 → 自动保存 → 磁盘字节仍全为 CRLF
#   4. 全程结束后文件字节与基线一致（测试会自动还原被改动的文件）
#
# 前置：先构建二进制（npm run tauri build -- --no-bundle）。
# 用 CDP 而不是截图：本机屏幕捕获不可用，且 DOM 断言比看图更精确。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VAULT="$ROOT/test-vault"
EXE="$ROOT/src-tauri/target/release/quick-note.exe"
PORT=9222
FIXTURE="日记/2026-W37 周记.md"

echo "=== 1/13 构建 GUI 测试专用二进制 ==="
# 用独立 identifier 构建，让 WebView2 使用独立的数据目录。两个好处：
#   · 测试不再读写你日常使用的应用配置（localStorage 里存着上次打开的仓库）
#   · 即使本机有残留/卡死实例锁住了正式数据目录，测试照样能跑
#
# 注意：这会把 target/release/quick-note.exe 覆盖成测试变体。
# 需要正式二进制时重新跑 `npm run tauri build -- --no-bundle`。
npm run tauri build -- --no-bundle --config '{"identifier":"com.quicknote.gui-test"}' > /dev/null
echo "已构建测试变体（identifier=com.quicknote.gui-test）"

echo
echo "=== 2/13 准备测试仓库 ==="
bash scripts/make-test-vault.sh "$VAULT" > /dev/null
bash scripts/verify-roundtrip.sh snapshot "$VAULT" > /dev/null

BACKUP_DIR="$(mktemp -d)"
cp "$VAULT/$FIXTURE" "$BACKUP_DIR/w37.md"
cp "$VAULT/features.md" "$BACKUP_DIR/features.md"
cp "$VAULT/日记/2026-09-14.md" "$BACKUP_DIR/daily.md"

# 让 WebView2 优雅退出，再兜底强杀。
# 直接 taskkill 会打断 WebView2 的收尾流程，进程可能卡在"终止中"状态——此后连
# taskkill /F 都会返回"拒绝访问"，只能重启或管理员结束。已经踩过多次。
close_app() {
  node -e "
    fetch('http://127.0.0.1:$PORT/json/version')
      .then((r) => r.json())
      .then((v) => {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          setTimeout(() => process.exit(0), 600);
        });
        setTimeout(() => process.exit(0), 2500);
      })
      .catch(() => process.exit(0));
  " > /dev/null 2>&1 || true

  # 等它自己退完再兜底强杀：正在退出的进程是无法再被强杀的（Windows 会拒绝访问），
  # 所以要给它时间，最多等 10 秒。
  for _ in $(seq 1 10); do
    if ! tasklist //FI "IMAGENAME eq quick-note.exe" 2>/dev/null | grep -q "quick-note.exe"; then
      return 0
    fi
    sleep 1
  done

  taskkill //F //IM quick-note.exe > /dev/null 2>&1 || true
  sleep 1
}

# 还原被测试改动的 fixture。
restore_fixtures() {
  cp "$BACKUP_DIR/w37.md" "$VAULT/$FIXTURE" 2>/dev/null || true
  cp "$BACKUP_DIR/features.md" "$VAULT/features.md" 2>/dev/null || true
  cp "$BACKUP_DIR/daily.md" "$VAULT/日记/2026-09-14.md" 2>/dev/null || true
  rm -f "$VAULT/外部新建.md"
}

cleanup() {
  close_app
  restore_fixtures
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

echo
echo "=== 3/13 启动应用（注入调试端口） ==="
# 用干净的 WebView 配置：localStorage 里存着上次的设置与仓库，残留会让断言不稳定。
rm -rf "$HOME/AppData/Local/com.quicknote.gui-test" 2>/dev/null || true
# 同步状态也要清掉。它是每台设备一份的（游标 + 各文件哈希），上一轮跑完留下的哈希
# 会让"首次同步应当把全部笔记推上去"这类断言莫名其妙地失败。
# 注意它**不在仓库里**——里面有服务端密码与令牌。
rm -f "$APPDATA/com.quicknote.gui-test/sync-state.json" 2>/dev/null || true
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$PORT" \
  "$EXE" "$VAULT" > /dev/null 2>&1 &

for i in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/json/list" > /dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -s "http://127.0.0.1:$PORT/json/list" > /dev/null 2>&1; then
  echo "调试端口未就绪，应用可能启动失败" >&2
  exit 1
fi

# 端口就绪只说明浏览器进程起来了，页面可能还是 about:blank。必须等真正的页面出现
# 再往下走，否则测试会连到 about:blank 上，得到一片「应用没渲染」的**假失败**
# （#root 长度 0、文件树 0 条），看起来像应用坏了，其实是测试连错了目标。
for i in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/json/list" | grep -q "tauri.localhost"; then break; fi
  sleep 1
done
if ! curl -s "http://127.0.0.1:$PORT/json/list" | grep -q "tauri.localhost"; then
  echo "应用页面没有加载（仍是 about:blank），放弃" >&2
  exit 1
fi
echo "应用已就绪（端口 $PORT）"

echo
echo "=== 4/13 GUI 冒烟测试 ==="
node scripts/gui-smoke.mjs "$PORT"

echo
echo "=== 5/13 编辑保存路径（真实输入） ==="
node scripts/gui-edit-save.mjs "$VAULT" "$PORT"

echo
echo "=== 6/13 Live Preview / 表格 / Mermaid / 图片 ==="
node scripts/gui-livepreview.mjs "$VAULT" "$PORT"

echo
echo "=== 7/13 文件监听与外部改动 ==="
node scripts/gui-external-change.mjs "$VAULT" "$PORT"

echo
echo "=== 8/13 粘贴附件 ==="
bash scripts/make-test-vault.sh "$VAULT" > /dev/null
node scripts/gui-paste.mjs "$VAULT" "$PORT"

echo
echo "=== 9/13 文件管理：新建 / 重命名 / 删除 ==="
node scripts/gui-file-manage.mjs "$VAULT" "$PORT"

echo
echo "=== 10/13 额外语法渲染与主题 ==="
bash scripts/make-test-vault.sh "$VAULT" > /dev/null
node scripts/gui-rendering.mjs "$VAULT" "$PORT"

echo
echo "=== 11/13 日记与日历（含库内配置写回） ==="
# 不重建仓库：上一步刚重建过，配置是干净的。gui-daily 自己备份/还原 quick-daily-note.json
# 并清掉它创建的两篇日记。
node scripts/gui-daily.mjs "$VAULT" "$PORT"

echo
echo "=== 12/13 多标签页与目录 ==="
node scripts/gui-tabs.mjs "$VAULT" "$PORT"

echo
echo "=== 13/13 云同步（对着桩后端跑完整往返） ==="
# 用桩后端而不是真后端：验收要在没有网络与 Docker 的机器上跑得完；而这里要验证的
# 恰恰是"字节怎么进怎么出"与"状态码不被吞掉"，桩比真服务器更容易构造这些边界。
# 脚本自己起后端、自己清理创建的文件（含被墓碑删进 .trash 的那些）。
node scripts/gui-sync.mjs "$VAULT" "$PORT"

echo
echo "关闭应用（必须先关：应用还开着的话，排队中的自动保存会把内容又写回文件）…"
close_app

echo
echo "还原 fixture 并比对基线…"
restore_fixtures
bash scripts/verify-roundtrip.sh check "$VAULT"

echo
echo "GUI 验收全部通过 ✓"

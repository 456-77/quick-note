#!/usr/bin/env bash
# 逻辑层验收：一条命令跑完「字节精确往返」与「渲染层」的全部检查。
#
#   ./scripts/verify-all.sh
#
# 流程：
#   1. 类型检查（能抓到 Node 类型擦除测试抓不到的类型错误）
#   2. 重建测试仓库并记录内容哈希基线
#   3. Rust 集成测试：往返无损 + 新建/重命名/删除
#   4. 从 Rust 导出换行符探测结果，作为编辑器层测试的地面真值
#   5. 编辑器层测试：字符串 ↔ CodeMirror 状态 无损
#   6. Live Preview 装饰层测试：语法标记隐藏、样式、小部件、表格、嵌入
#   7. 额外行内语法扫描测试：公式 / 高亮 / 注释 / 手写 HTML 的边界
#   8. 附件命名与链接测试
#   9. 日记与日历的纯逻辑：ISO 周号、命名、模板、统计、待办顺延、库内配置写回
#  10. 云同步的纯逻辑：冲突决策、状态兜底、快照与条目级合并、哈希口径、范围判定
#  11. 表格结构编辑与大纲：管道对齐（CJK 宽度）、行列增删、标题提取
#  12. M4 增强功能：语言识别、周回顾格式、提醒判定、天气文案、引用清理、共享配置写回
#  13. 比对基线：确认以上过程没有改动任何文件
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VAULT="$ROOT/test-vault"
DETECT="$ROOT/test-vault.detect.json"

echo "=== 1/13 类型检查 ==="
npx tsc --noEmit

echo
echo "=== 2/13 重建测试仓库并记录基线 ==="
bash scripts/make-test-vault.sh "$VAULT" > /dev/null
bash scripts/verify-roundtrip.sh snapshot "$VAULT" > /dev/null
echo "基线已记录（$(($(wc -l < "$VAULT.baseline.txt"))) 个文件）"

echo
echo "=== 3/13 Rust 集成测试（往返 + 新建/重命名/删除 + 同步扫描与 HTTP 通道） ==="
(cd src-tauri && cargo test --quiet --test roundtrip --test create --test sync)

echo
echo "=== 4/13 导出 Rust 的换行符探测结果 ==="
(cd src-tauri && cargo run --quiet --example dump-detect -- "$VAULT") > "$DETECT"
echo "已导出 $DETECT"

echo
echo "=== 5/13 编辑器层测试：字符串 ↔ CodeMirror 状态 ==="
node --experimental-strip-types --no-warnings scripts/verify-cm6-roundtrip.mjs "$VAULT" "$DETECT"

echo
echo "=== 6/13 Live Preview 装饰层测试 ==="
node --experimental-strip-types --no-warnings scripts/verify-livepreview.mjs "$VAULT/features.md"

echo
echo "=== 7/13 额外行内语法扫描测试 ==="
node --experimental-strip-types --no-warnings scripts/verify-inline-syntax.mjs

echo
echo "=== 8/13 附件命名与链接测试 ==="
node --experimental-strip-types --no-warnings scripts/verify-attachments.mjs

echo
echo "=== 9/13 日记与日历的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-daily.mjs

echo
echo "=== 10/13 云同步的纯逻辑（冲突决策、快照合并、哈希口径） ==="
node --experimental-strip-types --no-warnings scripts/verify-sync.mjs

echo
echo "=== 11/13 表格结构编辑与大纲的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-tables.mjs

echo
echo "=== 12/13 M4 增强功能的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-m4.mjs

echo
echo "=== 13/13 比对基线：确认文件未被改动 ==="
bash scripts/verify-roundtrip.sh check "$VAULT"

echo
echo "全部通过 ✓"

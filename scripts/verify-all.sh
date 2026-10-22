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
#  13. 行内代码 / 代码块切换的纯逻辑：包裹与取消判定、块级补位
#  14. Markdown 成对符号自动闭合的纯逻辑：补全规则、选区包裹、成长/跳出、代码语境禁用
#  15. 列表切换 / 日记改名日期 / 待办日期前缀的纯逻辑
#  16. 速记行格式：组装 / 解析（新格式 + 旧格式回退）/ 行级归档与加标签
#  18. DDL 收录 / 阅读位置持久化 / 表格单元格高亮切分（0.31）
#  19. 比对基线：确认以上过程没有改动任何文件
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VAULT="$ROOT/test-vault"
DETECT="$ROOT/test-vault.detect.json"

echo "=== 1/18 类型检查 ==="
npx tsc --noEmit

echo
echo "=== 2/18 重建测试仓库并记录基线 ==="
bash scripts/make-test-vault.sh "$VAULT" > /dev/null
bash scripts/verify-roundtrip.sh snapshot "$VAULT" > /dev/null
echo "基线已记录（$(($(wc -l < "$VAULT.baseline.txt"))) 个文件）"

echo
echo "=== 3/18 Rust 测试（单元：文件 URL 编码 + 真实 PDF 导出；集成：往返/新建/重命名/删除/同步扫描） ==="
(cd src-tauri && cargo test --quiet --lib --test roundtrip --test create --test sync)

echo
echo "=== 4/18 导出 Rust 的换行符探测结果 ==="
(cd src-tauri && cargo run --quiet --example dump-detect -- "$VAULT") > "$DETECT"
echo "已导出 $DETECT"

echo
echo "=== 5/18 编辑器层测试：字符串 ↔ CodeMirror 状态 ==="
node --experimental-strip-types --no-warnings scripts/verify-cm6-roundtrip.mjs "$VAULT" "$DETECT"

echo
echo "=== 6/18 Live Preview 装饰层测试 ==="
node --experimental-strip-types --no-warnings scripts/verify-livepreview.mjs "$VAULT/features.md"

echo
echo "=== 7/18 额外行内语法扫描测试 ==="
node --experimental-strip-types --no-warnings scripts/verify-inline-syntax.mjs

echo
echo "=== 8/18 附件命名与链接测试 ==="
node --experimental-strip-types --no-warnings scripts/verify-attachments.mjs

echo
echo "=== 9/18 日记与日历的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-daily.mjs

echo
echo "=== 10/18 云同步的纯逻辑（冲突决策、快照合并、哈希口径） ==="
node --experimental-strip-types --no-warnings scripts/verify-sync.mjs

echo
echo "=== 11/18 表格结构编辑与大纲的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-tables.mjs

echo
echo "=== 12/18 M4 增强功能的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-m4.mjs

echo
echo "=== 13/18 行内代码 / 代码块切换的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-code-edit.mjs

echo
echo "=== 14/18 Markdown 成对符号自动闭合的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-autopairs.mjs

echo
echo "=== 15/18 列表切换 / 日记改名日期 / 待办日期前缀的纯逻辑 ==="
node --experimental-strip-types --no-warnings scripts/verify-lists-daily.mjs

echo
echo "=== 16/18 速记行格式：组装/解析/行级编辑（纯逻辑） ==="
node --experimental-strip-types --no-warnings scripts/verify-capture.mjs

echo
echo "=== 17/18 搜索变体与单词本（字段联动/单词本纯变换） ==="
node --experimental-strip-types --no-warnings scripts/verify-search-vocab.mjs

echo
echo "=== 18/19 DDL 收录 / 阅读位置 / 高亮切分（0.31 新增纯逻辑） ==="
node --experimental-strip-types --no-warnings scripts/verify-ddl-progress.mjs

echo
echo "=== 19/19 比对基线：确认文件未被改动 ==="
bash scripts/verify-roundtrip.sh check "$VAULT"

echo
echo "全部通过 ✓"

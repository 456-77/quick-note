#!/usr/bin/env bash
# 记录或校验仓库内所有 .md 文件的内容哈希。
#
#   ./scripts/verify-roundtrip.sh snapshot <vault>   记录基线
#   ./scripts/verify-roundtrip.sh check    <vault>   与基线比对
#
# 用法：在应用里打开 <vault>、逐个点开笔记但什么都不改，然后跑 check。
# 若换行符/BOM/空白被隐式改写，哈希会变化并在此暴露。
set -euo pipefail

MODE="${1:?用法: $0 snapshot|check <vault>}"
VAULT="${2:?缺少仓库路径}"
SNAPSHOT="${VAULT}.baseline.txt"

# 只统计应用会读写的文本文件：`.md` 与库内配置文件（quick-daily-note.json），
# 且不含点开头的路径段（.obsidian/app.json 这类要排除）。
#
# 配置文件必须纳入：它与 Obsidian 插件共用，被写坏（丢掉插件键）比某篇笔记被改写
# 严重得多，而它恰恰不在"只有 .md"的老口径里。
list_files() {
  find "$VAULT" -type f \( -name '*.md' -o -name '*.json' \) \
    | sed "s|^$VAULT/||" \
    | grep -v -E '(^|/)\.' \
    | sort
}

hash_all() {
  while IFS= read -r rel; do
    printf '%s  %s\n' "$(sha256sum "$VAULT/$rel" | cut -d' ' -f1)" "$rel"
  done < <(list_files)
}

case "$MODE" in
  snapshot)
    hash_all > "$SNAPSHOT"
    echo "基线已记录到 $SNAPSHOT（$(wc -l < "$SNAPSHOT") 个文件）"
    cat "$SNAPSHOT"
    ;;
  check)
    [ -f "$SNAPSHOT" ] || { echo "找不到基线 $SNAPSHOT，请先运行 snapshot"; exit 1; }
    hash_all > "${SNAPSHOT}.now"
    if diff -u "$SNAPSHOT" "${SNAPSHOT}.now"; then
      echo "往返校验通过：$(wc -l < "$SNAPSHOT") 个文件字节完全一致 ✓"
      rm -f "${SNAPSHOT}.now"
    else
      echo "往返校验失败：上面列出被改写的文件 ✗" >&2
      exit 1
    fi
    ;;
  *)
    echo "未知模式: $MODE" >&2
    exit 1
    ;;
esac

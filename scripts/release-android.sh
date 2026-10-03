#!/usr/bin/env bash
# Android 版构建（发版用）：签名的 release APK（aarch64），命名后输出到项目根。
#
# 用法：scripts/release-android.sh [版本号]
#   版本号缺省从 package.json 读。产物：QuickNote_<ver>_android_arm64.apk
#
# 前置：H:/develop/keystore/quick-note-release.keystore + gen/android/app/keystore.properties
# （见 docs/A3-实现说明.md §六）；keystore 丢失则无法再更新已发布的应用，务必备份。
#
# 发版集成：桌面流程（版本号四处 → tag → npm run tauri build → gh release create）
# 之后追加：本脚本 → `gh release upload vX.Y.Z <产物> --clobber`。

set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/android-env.sh

VERSION="${1:-$(node -p "require('./package.json').version")}"
echo "==> 构建 Android release（v$VERSION，aarch64）"

npx tauri android build --target aarch64

SRC="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
DEST="QuickNote_${VERSION}_android_arm64.apk"
cp "$SRC" "$DEST"
echo "==> 产物：$(pwd)/$DEST ($(du -h "$DEST" | cut -f1))"

# 签名校验（证书指纹应与 H:/develop/keystore 首次产出时一致）
"$ANDROID_HOME/build-tools/34.0.0/apksigner.bat" verify --print-certs "$DEST" | head -2

echo "==> 上传到已有 Release：gh release upload v$VERSION $DEST --clobber"
echo "    （新建 Release：gh release create v$VERSION --title ... $DEST）"

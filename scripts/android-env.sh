#!/usr/bin/env bash
# Android 构建环境（A0 引入）。用法：source scripts/android-env.sh
#
# 本机特有的三个关键点：
# 1. Windows 用户名「一切随缘」是非 ASCII：
#    - NDK 的 lld 打不开 %USERPROFILE%\.rustup 下工具链的 rlib（GBK/UTF-8 编码问题）。
#      A0 已把 rustup home **mv** 到 C:\rust\rustup（同盘改名，瞬时），
#      旧位置留同名 junction 兼容，且已 setx RUSTUP_HOME 永久生效。
#    - Kotlin 守护进程对「不同盘符」的路径做 relativize 会抛 different roots，
#      且会把非 ASCII 用户名转义成 \uXXXX 找不到文件。CARGO_HOME 因此固定用
#      H:\cargo-mirror（junction → 真实 .cargo）：与项目同盘、全 ASCII，
#      Kotlin 的 Path.relativize 是纯字符串操作、不解析 junction，两个问题同时规避。
#      ⚠ CARGO_HOME 已 setx 永久化——桌面与 Android 构建必须共用同一路径，
#      否则每次切换都会触发全量重编（指纹里含源码路径）。
# 2. JDK 用独立的 jdk-21（JDK 23 与部分 Gradle/AGP 组合有兼容风险，21 是 AGP 的 LTS）。
# 3. 新开的终端自动带 setx 的值；本脚本为任何环境兜底。

export ANDROID_HOME="H:\\develop\\android-sdk"
export NDK_HOME="H:\\develop\\android-sdk\\ndk\\27.0.12077973"
export JAVA_HOME="H:\\develop\\jdk-21.0.12.1+1"
export RUSTUP_HOME="C:\\rust\\rustup"
export CARGO_HOME="H:\\cargo-mirror"
# AVD 固定放 ASCII 路径；并清掉历史残留的 ANDROID_SDK_HOME（曾指向已删除的
# H:\develop\Android\AVD，会让模拟器反复报 feature-flags.lock 创建失败）
export ANDROID_AVD_HOME="H:\\android-avd"
unset ANDROID_SDK_HOME


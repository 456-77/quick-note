/**
 * 检查更新（GitHub Releases）。
 *
 * ## 为什么是"检查 + 打开发布页"，而不是应用内自动更新
 *
 * Tauri 的自动更新插件要求签名密钥与一个固定 URL 的更新清单（latest.json），
 * 还要把安装包与签名一起发布——对目前"手动构建 + GitHub Release"的分发方式是
 * 一套多余的发布流水线。而检查更新只需要读 releases/latest 这一个公开接口，
 * 发现有新版本就带用户去下载页，覆盖了真实需求（知道有新版、能拿到安装包）。
 *
 * ## 请求走 Rust 的 HTTP 通道
 *
 * 与同步同一理由：渲染进程的 fetch 受同源策略约束，而且这样错误口径一致
 * （"无法连接同步服务器"同款消息风格）。
 *
 * 匿名访问 GitHub API 每小时 60 次，"手动点检查"完全够用；刻意不做启动自动检查，
 * 免得多一次没人要求的网络请求。
 */

import { httpRequest } from "./api.ts";

export interface UpdateInfo {
  /** 最新版本号（去掉 tag 的 v 前缀）。 */
  latest: string;
  /** 发布页链接。 */
  url: string;
  /** 是否比当前版本新。 */
  newer: boolean;
}

/** 比较两个点分版本号；解析不出的段按 0 处理，相等返回 false。 */
export function isNewer(current: string, latest: string): boolean {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((part) => {
        const number = Number.parseInt(part, 10);
        return Number.isFinite(number) ? number : 0;
      });
  const a = parse(current);
  const b = parse(latest);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (right !== left) return right > left;
  }
  return false;
}

/** 查询 GitHub 上最新发布版本，与当前版本比较。 */
export async function checkForUpdate(current: string): Promise<UpdateInfo> {
  const response = await httpRequest({
    method: "GET",
    url: "https://api.github.com/repos/456-77/quick-note/releases/latest",
    headers: [{ name: "Accept", value: "application/vnd.github+json" }],
  });
  if (response.status !== 200) {
    throw new Error(`GitHub 返回 HTTP ${response.status}`);
  }
  let data: { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
  try {
    data = JSON.parse(responseBodyText(response));
  } catch {
    throw new Error("响应不是合法的 JSON");
  }
  if (!data.tag_name || !data.html_url) {
    // 仓库一个 release 都没有时 API 返回 404，走不到这里；到这说明响应形状变了
    throw new Error("响应缺少版本信息");
  }
  const latest = data.tag_name.replace(/^v/i, "");
  return {
    latest,
    url: data.html_url,
    newer: isNewer(current, latest),
  };
}

/** 把 base64 响应体解成文本（HTTP 命令统一用 base64 搬字节）。 */
function responseBodyText(response: { bodyBase64: string }): string {
  const binary = atob(response.bodyBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------- 应用内更新
//
// Tauri updater 插件路径：端点（tauri.conf.json）指向 GitHub Release 上的
// latest.json，检查/下载/安装/重启全部在应用内完成。GitHub API 检查保留作
// 回退——latest.json 还没发布（首个带更新清单的版本之前）或离线时仍能提示。

import { check as pluginCheck, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

/**
 * 用 updater 插件检查更新。
 *
 * 返回 `null` 表示"没有可用更新**或**插件检查没走通"（端点 404、离线）——
 * 调用方应回退到 {@link checkForUpdate} 的 GitHub API 比较，两种检查不会都失败。
 */
export async function checkViaPlugin(): Promise<Update | null> {
  try {
    return await pluginCheck();
  } catch {
    return null;
  }
}

/**
 * 下载并安装更新，安装完重启应用（不返回——进程已经被替换）。
 *
 * onProgress 收到 0-100 的下载百分比；`Finished` 后进度到 100，剩下的安装
 * 由 NSIS 安装器静默完成。
 */
export async function installAndRelaunch(update: Update, onProgress: (pct: number) => void): Promise<void> {
  let downloaded = 0;
  let contentLength = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength ?? 0;
      onProgress(0);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress(contentLength > 0 ? Math.min(99, Math.round((downloaded / contentLength) * 100)) : 50);
    } else if (event.event === "Finished") {
      onProgress(100);
    }
  });
  await relaunch();
}

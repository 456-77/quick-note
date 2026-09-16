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

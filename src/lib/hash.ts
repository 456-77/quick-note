/**
 * SHA-256（十六进制小写），同步协议的哈希工具。
 *
 * 三处必须给出同一个值，所以口径只在这里定义一次：
 *
 * 1. Rust 的 `vault::sync_hash`（扫描与读取时算）；
 * 2. 这里（前端算待办快照等**不落盘**的内容）；
 * 3. Obsidian 插件的 `sha256Hex`。
 *
 * 三者的共同点是"对 UTF-8 字节求 SHA-256"。真正的坑不在这里，而在**拿什么字节**：
 * 文件的同步哈希用的是**已剥 BOM 的正文**，不是磁盘上的原始字节——见
 * `docs/M3-实现说明.md`。这个模块只管把给定字符串正确哈希。
 */

/** SHA-256 十六进制小写。 */
export async function sha256Hex(content: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(content));
}

/** 二进制内容的 SHA-256（附件用）。 */
export async function sha256HexBytes(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

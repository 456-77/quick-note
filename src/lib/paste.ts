/**
 * 粘贴附件：把剪贴板里的图片/文件写进仓库的附件目录，并在光标处插入链接。
 *
 * 只在剪贴板里真的有文件时才接管粘贴；纯文本粘贴保持编辑器默认行为——这点很重要，
 * 否则会破坏最日常的操作。
 */

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { attachmentNameFor, linkTextFor } from "./attachments.ts";
import { writeAttachment } from "./api.ts";
import { livePreviewContext } from "./paths.ts";

export interface AttachmentOptions {
  /** 是否启用。用函数读实时设置，避免把旧值固化进扩展。 */
  enabled: () => boolean;
  /** 附件目录（仓库内相对路径，空串为仓库根）。 */
  folder: () => string;
  /** 插入链接的写法。 */
  linkFormat: () => "wiki" | "markdown";
  /** 给用户的反馈。省略 kind 视为普通提示。 */
  notice: (message: string, kind?: "info" | "error") => void;
}

/** 单个附件上限，与 Rust 侧保持一致。 */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * 从剪贴板事件里取出需要落盘的文件。
 *
 * 两种来源：`files`（从资源管理器复制的文件）与 `items`（截图等以位图形式存在的项）。
 * 有 files 时不再看 items，避免同一份内容被处理两次。
 */
export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromFiles = Array.from(data.files ?? []);
  if (fromFiles.length > 0) return fromFiles;

  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}

/** Uint8Array → base64（分块处理，避免超长参数导致栈溢出）。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function attachmentPaste(options: AttachmentOptions): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      if (!options.enabled()) return false;
      const files = clipboardFiles(event.clipboardData);
      if (files.length === 0) return false; // 纯文本粘贴交给编辑器
      event.preventDefault();
      void saveAndLink(view, files, options);
      return true;
    },
  });
}

async function saveAndLink(
  view: EditorView,
  files: File[],
  options: AttachmentOptions,
): Promise<void> {
  const vaultPath = view.state.facet(livePreviewContext).vaultPath;
  if (!vaultPath) {
    options.notice("尚未打开仓库，无法保存附件", "error");
    return;
  }

  const links: string[] = [];
  const failures: string[] = [];
  let index = 0;

  for (const file of files) {
    try {
      if (file.size > MAX_BYTES) {
        throw new Error(`超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB`);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = attachmentNameFor(file, new Date(), index);
      const relative = await writeAttachment(
        vaultPath,
        options.folder(),
        name,
        toBase64(bytes),
      );
      links.push(linkTextFor(relative, options.linkFormat()));
      index += 1;
    } catch (e) {
      failures.push(`${file.name || file.type}：${String(e)}`);
    }
  }

  if (links.length > 0) {
    // 用当前状态插入：写入是异步的，期间用户可能已经移动了光标
    view.dispatch(view.state.replaceSelection(links.join(" ")));
  }

  if (failures.length > 0) {
    options.notice(`附件保存失败：${failures.join("；")}`, "error");
  } else if (links.length > 0) {
    options.notice(`已保存 ${links.length} 个附件到 ${options.folder() || "仓库根目录"}`);
  }
}

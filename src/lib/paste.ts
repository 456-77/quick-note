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
import { detectLanguage } from "./languageDetect.ts";
import {
  htmlTableToMarkdown,
  looksLikeLog,
  looksLikeMarkdownTable,
  normalizePastedText,
} from "./pasteTransforms.ts";

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

// ---------------------------------------------------------------- 粘贴代码识别

/** 粘贴处理的行为配置（与 AttachmentOptions 同一套「读实时设置」约定）。 */
export interface CodePasteOptions {
  /** 是否启用「代码自动包围栏」。规范化与表格转换不受它控制，始终开启。 */
  enabled: () => boolean;
  /** 识别/转换成功后的提示。 */
  notice?: (message: string) => void;
}

/** 光标是否在未闭合的围栏代码块内（与插件同一套逐行计数规则）。 */
export function isInsideFence(docLines: string[], cursorLine: number): boolean {
  let inBlock = false;
  for (let i = 0; i <= cursorLine && i < docLines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(docLines[i])) inBlock = !inBlock;
  }
  return inBlock;
}

/**
 * 计算插入块级内容前后的补位换行：代码块必须独立成段，贴在文字中间会破坏
 * 前后段落。规则自插件移植（行中间/行尾/行首/空行四种情形各不同）。
 */
export function blockInsertPadding(
  lines: string[],
  lineIndex: number,
  posInLine: number,
): { prefix: string; suffix: string } {
  const line = lines[lineIndex] ?? "";
  const beforeText = line.slice(0, posInLine);
  const afterText = line.slice(posInLine);
  const prevLine = lineIndex > 0 ? lines[lineIndex - 1] : "";
  const nextLine = lines[lineIndex + 1] ?? "";
  if (beforeText.trim() && afterText.trim()) {
    // 行中间：断开本行前后并各空一行（插入点两侧没有现成换行符）
    return { prefix: "\n\n", suffix: "\n\n" };
  }
  if (beforeText.trim()) {
    // 行尾：本行换行符在插入点之后，suffix 只补一个换行
    return { prefix: "\n\n", suffix: nextLine.trim() ? "\n" : "" };
  }
  if (afterText.trim()) {
    // 行首：本行换行符在插入点之前（上一行的换行），prefix 只补一个换行
    return { prefix: prevLine.trim() ? "\n" : "", suffix: "\n\n" };
  }
  // 空行：块占用本行，前后各由相邻换行符 + 一个补位换行构成空行
  return { prefix: prevLine.trim() ? "\n" : "", suffix: nextLine.trim() ? "\n" : "" };
}

/** 把纯文本代码包成带语言围栏的块（换行符规范化为 \n，代码块内部如此是安全的）。 */
export function fencedBlock(code: string, lang: string): string {
  const clean = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return `\`\`\`${lang}\n${clean}\n\`\`\``;
}

/**
 * 智能文本粘贴（替代早期的 codePaste）：
 *
 * 1. **换行符规范化（始终开启）**：剪贴板文本几乎总是 CRLF，而文档的分隔符是按文件
 *    锁定的——直接插入会留下裸 `\r`，界面上渲染成红色 CR 角标，还污染文件内容。
 * 2. **表格转换（始终开启）**：剪贴板带 HTML `<table>`（Excel/WPS/网页复制时都会带）
 *    才转成 Markdown 管道表格插入——**真表格才转表格**。纯文本（含 TSV）一律原样粘贴：
 *    代码缩进、对齐文本里的 tab 以前会被 TSV 规则误判成表格，整段被拆得七零八落。
 *    本身就是 Markdown 表格的文本保持原样。
 * 3. **代码围栏（受开关控制）**：纯文本代码识别语言后包成围栏块。
 *
 * 接线顺序在 `attachmentPaste` 之后：剪贴板里有文件时轮不到它。
 */
export function smartPaste(options: CodePasteOptions): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const data = event.clipboardData;
      if (!data || data.files.length > 0) return false; // 文件粘贴归附件处理
      const raw = data.getData("text/plain") ?? "";
      const html = data.getData("text/html") ?? "";
      if (!raw.trim() && !html.trim()) return false;

      const separator = view.state.lineBreak;

      // 1) HTML 表格：只有剪贴板里真的有 `<table>`（Excel/WPS/网页复制）才转，
      //    纯文本（含 TSV）不猜——tab 缩进的代码、对齐文本不是表格
      const tableLines = htmlTableToMarkdown(html);
      if (tableLines) {
        event.preventDefault();
        insertBlock(view, tableLines.join(separator));
        options.notice?.("已把剪贴板中的表格转成 Markdown 表格");
        return true;
      }

      // 代码围栏：整块复制了已带围栏的代码、或光标已在代码块内时都不干预
      const fenceCandidate = raw;
      if (
        options.enabled() &&
        raw.trim() &&
        !/^\s*(```|~~~)/.test(raw) &&
        !looksLikeMarkdownTable(raw)
      ) {
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        const lines = view.state.doc.toString().split("\n");
        if (!isInsideFence(lines, line.number - 1)) {
          // 日志优先于编程语言识别：带异常栈的运行日志按特征打分会误判成
          // java/python 代码，而用户要的是可读的 log 块（级别配色，见 livePreview）。
          const isLog = fenceCandidate.includes("\n") && looksLikeLog(fenceCandidate);
          const lang = isLog ? "log" : detectLanguage(fenceCandidate, fenceCandidate.includes("\n"));
          if (lang) {
            event.preventDefault();
            const { prefix, suffix } = blockInsertPadding(lines, line.number - 1, pos - line.from);
            view.dispatch(
              view.state.replaceSelection(`${prefix}${fencedBlock(fenceCandidate, lang)}${suffix}`),
            );
            view.focus();
            options.notice?.(isLog ? "已识别为日志，按 log 块插入" : `已识别为 ${lang} 代码块`);
            return true;
          }
        }
      }

      // 3) 普通文本：换行符规范化后交给编辑器默认行为
      const normalized = normalizePastedText(raw, separator);
      if (normalized !== raw) {
        event.preventDefault();
        view.dispatch(view.state.replaceSelection(normalized));
        return true;
      }
      return false;
    },
  });
}

/** 插入块级内容（表格）：前后补空行让它独立成段，与代码块同一套补位规则。 */
function insertBlock(view: EditorView, text: string): void {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const lines = view.state.doc.toString().split("\n");
  const { prefix, suffix } = blockInsertPadding(lines, line.number - 1, pos - line.from);
  view.dispatch(view.state.replaceSelection(`${prefix}${text}${suffix}`));
  view.focus();
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

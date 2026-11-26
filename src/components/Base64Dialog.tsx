/**
 * Base64 转码面板（0.39.35 用户需求「同样的，创建一个快捷键触发弹窗，专门用来
 * 处理转码和解码」）。
 *
 * 打开时预填编辑器选区；识别方向：
 *  - 输入里识别到 base64（整段 / URL 路径 / 日志片段）→ 打开即解码；
 *  - 普通文本 → 点「编码」转成 UTF-8 的 Base64（中文/emoji 都正确）。
 * 结果可复制或写回笔记（替换原选区 / 插入光标处），与 JSON 转换面板同一套交互。
 */

import { useEffect, useRef, useState } from "react";
import { decodeBase64Text, encodeBase64 } from "../lib/formatJson";
import { DialogPinButton, useDialogDrag, useDialogPinned } from "./DialogDragPin";

export default function Base64Dialog({
  initialText,
  onApply,
  onClose,
}: {
  /** 打开时的预填文本（编辑器选区；可为空）。 */
  initialText: string;
  /** 写回笔记：替换原选区 / 插入光标处（App 侧实现）。 */
  onApply: (text: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(initialText);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const outputRef = useRef<HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogDrag = useDialogDrag(dialogRef);
  const [pinned, setPinned] = useDialogPinned();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // 打开即识别：选区里带 base64（典型是从抓包/日志里选中一段 URL）就直接解码
    const text = initialText.trim();
    if (!text) return;
    try {
      setOutput(decodeBase64Text(text));
    } catch {
      // 不是 base64（普通文本）：保持空输出，等用户点「编码」
    }
  }, [initialText]);

  const run = (label: string, fn: (text: string) => string) => {
    try {
      const result = fn(input);
      setOutput(result);
      setError(null);
      requestAnimationFrame(() => outputRef.current?.focus());
    } catch (e) {
      setError(`${label}：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const apply = () => {
    if (!output.trim()) return;
    onApply(output);
  };

  return (
    <>
      {!pinned && <div className="menu-backdrop" onClick={onClose} />}
      <div ref={dialogRef} className="jsonfmt" role="dialog" aria-label="Base64 转码">
        <div className="jsonfmt-head" {...dialogDrag}>
          <span className="jsonfmt-title">Base64 转码</span>
          <span className="spacer" />
          <DialogPinButton pinned={pinned} onToggle={() => setPinned((value) => !value)} />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>

        <textarea
          ref={inputRef}
          className="jsonfmt-io"
          rows={8}
          spellCheck={false}
          value={input}
          placeholder="粘贴 Base64 或普通文本…（带 base64 的 URL/日志选中后打开会自动解码）"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              run("转码", encodeBase64);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />

        <div className="jsonfmt-actions">
          <button
            type="button"
            onClick={() => run("解码", decodeBase64Text)}
            title="自动识别输入里的 base64（整段 / URL 路径 / 日志片段）并解码成文本"
          >
            解码
          </button>
          <button
            type="button"
            onClick={() => run("编码", encodeBase64)}
            title="把输入文本按 UTF-8 编成 Base64（Ctrl+Enter）"
          >
            编码
          </button>
          <button
            type="button"
            title="把上面的结果搬到输入框，接着做下一步转换（例如 编码 → 解码 验证往返）"
            onClick={() => {
              if (!output.trim()) return;
              setInput(output);
              setOutput("");
              setError(null);
              inputRef.current?.focus();
            }}
          >
            结果↑输入
          </button>
          <span className="spacer" />
          <button
            type="button"
            disabled={!output.trim()}
            title={output.trim() ? "把结果写回笔记（替换原选区 / 插入光标处）" : "先转码或解码，再写回"}
            onClick={apply}
          >
            写回笔记
          </button>
          <button
            type="button"
            disabled={!output.trim()}
            title="复制结果"
            onClick={() => void navigator.clipboard.writeText(output)}
          >
            复制结果
          </button>
        </div>

        {error && <div className="jsonfmt-error">{error}</div>}

        <textarea
          ref={outputRef}
          className="jsonfmt-io"
          rows={8}
          spellCheck={false}
          readOnly
          value={output}
          placeholder="转码 / 解码结果显示在这里…"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="jsonfmt-help">
          <span>选中带 base64 的内容打开会自动解码；普通文本点「编码」转成 Base64</span>
        </div>
      </div>
    </>
  );
}

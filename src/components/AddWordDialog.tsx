/**
 * 手动添加单词弹窗（0.26 用户反馈"添加一个快捷键用弹出一个窗口手动输入单词，
 * 类似于快速笔记"）：正在看别处的内容时想起一个词，按快捷键（默认 Ctrl+Alt+U，
 * 设置 → 快捷键 里可改）唤起这里，输入单词 Enter 落进账户级单词本（所有仓库共用）。
 *
 * 与右侧「单词」面板的添加区的分工：面板里有在线查释义的完整预览流程；这个弹窗
 * 走**快速通道**——只记词立刻返回（可连续录入），0.30 起落盘后在后台自动在线
 * 查询释义并回填（App 的 autoFillVocabMeaning），结果经状态栏提示，不挡录入。
 * 词统一转小写后落盘。
 *
 * 交互：Enter = 添加（可连续添加，输入框清空接着输），Esc / 点遮罩 = 关闭。
 */

import { useEffect, useRef, useState } from "react";

export default function AddWordDialog({
  initialWord = "",
  onSubmit,
  onClose,
}: {
  /** 打开时预填的词（快捷键唤起时带上的当前选词，可为空）。 */
  initialWord?: string;
  /** 落盘由父组件做。返回添加结果文案（含"已有"的情形），弹窗保持打开继续录。 */
  onSubmit: (word: string) => Promise<string>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initialWord);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const word = draft.trim().toLowerCase();
    if (!word || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await onSubmit(word);
      setMessage({ text, kind: "ok" });
      setDraft("");
      inputRef.current?.focus();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="quick-capture add-word-dialog" role="dialog" aria-label="添加单词">
        <div className="quick-capture-head">
          <span className="quick-capture-title">添加单词</span>
          <span className="spacer" />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>
        <input
          ref={inputRef}
          type="text"
          className="add-word-input"
          placeholder="输入单词，例如 scenario"
          value={draft}
          spellCheck={false}
          enterKeyHint="done"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="quick-capture-help">
          <span>
            <kbd>Enter</kbd> 添加 · 词会统一转小写
          </span>
          <span className="spacer" />
          <span>释义会自动在线查询并回填</span>
        </div>
        <div className="quick-capture-foot">
          {message && (
            <span className={`add-word-message is-${message.kind}`}>{message.text}</span>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-primary quick-capture-save"
            disabled={!draft.trim() || busy}
            onClick={() => void submit()}
          >
            {busy ? "添加中…" : "加入单词本"}
          </button>
        </div>
      </div>
    </>
  );
}

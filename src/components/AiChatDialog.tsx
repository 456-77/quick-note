/**
 * AI 对话面板（0.39.28 用户需求「添加 ai 对话功能」，14:06 [运维/2026-11-19 草稿]）。
 *
 * 多轮聊天：历史整包发给 设置 → AI 里配的供应商（与 AI 识图同一套三件套 +
 * 附加请求头，走 Rust http_request/rustls）。可选把当前笔记全文（或选区）作为
 * 上下文一起问；回复可插入笔记光标处或复制。会话只在面板内存里（关掉即散，
 * 不落盘——聊天记录是临时工作上下文，不是笔记）。
 */

import { useEffect, useRef, useState } from "react";
import { aiChat, aiConfigured, type AiChatMessage } from "../lib/aiVision";
import { DialogPinButton, useDialogDrag, useDialogPinned } from "./DialogDragPin";

export default function AiChatDialog({
  noteContext,
  onInsert,
  onClose,
}: {
  /** 当前笔记上下文（笔记名 + 全文/选区）；null=没有打开的笔记。 */
  noteContext: { name: string; text: string } | null;
  /** 把文本插入笔记光标处（App 侧实现，与 JSON 面板的写回同一通道）。 */
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  /** 会话历史（system 提示不进这个列表，发送时按需拼装）。 */
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 是否把当前笔记作为上下文一起问（每次发送时生效）。 */
  const [withNote, setWithNote] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 头部拖拽移动 + 固定常驻（与 JSON 面板同一套）
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogDrag = useDialogDrag(dialogRef);
  const [pinned, setPinned] = useDialogPinned();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // 新回复/流式占位出现后滚到对话底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!aiConfigured()) {
      setError("先在 设置 → AI 配置模型供应商（Base URL / API Key / 模型名）");
      return;
    }
    setError(null);
    setInput("");
    const history = [...messages, { role: "user" as const, content: text }];
    const payload: AiChatMessage[] = [];
    if (withNote && noteContext && noteContext.text.trim()) {
      payload.push({
        role: "system",
        content: `用户正在编辑笔记《${noteContext.name}》，以下是全文，回答时可以参考它：\n\n${noteContext.text}`,
      });
    }
    payload.push(...history);
    setMessages([...history, { role: "assistant", content: "" }]);
    setBusy(true);
    try {
      const reply = await aiChat(payload);
      setMessages([...history, { role: "assistant", content: reply }]);
    } catch (e) {
      // 失败的轮次不进历史：把刚排上的空回复撤掉，输入还回输入框让用户重试
      setMessages(history);
      setInput(text);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const lastReply = [...messages].reverse().find((m) => m.role === "assistant" && m.content !== "");

  return (
    <>
      {!pinned && <div className="menu-backdrop" onClick={onClose} />}
      <div ref={dialogRef} className="ai-chat" role="dialog" aria-label="AI 对话">
        <div className="ai-chat-head" {...dialogDrag}>
          <span className="ai-chat-title">AI 对话</span>
          <span className="spacer" />
          <DialogPinButton pinned={pinned} onToggle={() => setPinned((value) => !value)} />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>

        <div className="ai-chat-log" ref={listRef}>
          {messages.length === 0 && (
            <div className="ai-chat-empty">
              和配置好的模型多轮对话（设置 → AI）。
              {noteContext ? " 可勾选「带上当前笔记」让模型参考全文。" : ""}
            </div>
          )}
          {messages.map((message, index) => (
            <div key={index} className={`ai-chat-msg is-${message.role}`}>
              <div className="ai-chat-msg-role">{message.role === "user" ? "我" : "AI"}</div>
              <div className="ai-chat-msg-text">
                {message.content === "" && busy && index === messages.length - 1
                  ? "思考中…"
                  : message.content}
              </div>
            </div>
          ))}
        </div>

        {error && <div className="ai-chat-error">{error}</div>}

        <div className="ai-chat-inputrow">
          <label className="ai-chat-withnote" title={noteContext ? "发送时附带当前笔记全文作为上下文" : "当前没有打开的笔记"}>
            <input
              type="checkbox"
              checked={withNote && !!noteContext}
              disabled={!noteContext}
              onChange={(event) => setWithNote(event.target.checked)}
            />
            带上当前笔记
          </label>
          <textarea
            ref={inputRef}
            className="ai-chat-input"
            rows={2}
            spellCheck={false}
            value={input}
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="ai-chat-actions">
          <button type="button" disabled={busy || !input.trim()} onClick={() => void send()}>
            {busy ? "思考中…" : "发送"}
          </button>
          <button
            type="button"
            disabled={messages.length === 0 || busy}
            title="清空会话重新开始"
            onClick={() => {
              setMessages([]);
              setError(null);
            }}
          >
            清空会话
          </button>
          <span className="spacer" />
          <button
            type="button"
            disabled={!lastReply}
            title={lastReply ? "把最近一条 AI 回复插入笔记光标处" : "还没有 AI 回复"}
            onClick={() => {
              if (lastReply) onInsert(lastReply.content);
            }}
          >
            插入笔记
          </button>
          <button
            type="button"
            disabled={!lastReply}
            onClick={() => {
              if (lastReply) void navigator.clipboard.writeText(lastReply.content);
            }}
          >
            复制回复
          </button>
        </div>
      </div>
    </>
  );
}

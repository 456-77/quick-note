/**
 * 手动添加单词弹窗（0.26 用户反馈"添加一个快捷键用弹出一个窗口手动输入单词，
 * 类似于快速笔记"）：正在看别处的内容时想起一个词，按快捷键（默认 Ctrl+Alt+U，
 * 设置 → 快捷键 里可改）唤起这里，输入单词 Enter 落进账户级单词本（所有仓库共用）。
 *
 * 与右侧「单词」面板的添加区的分工：面板里有在线查释义的完整预览流程；这个弹窗
 * 走**快速通道**——0.32 起（用户反馈"有时候只想查词义、不想收词"）输入停顿
 * 500ms 就**自动查询在线释义**直接显示在弹窗里，查词与收词解耦：看完释义关掉
 * 弹窗即走，什么都不落盘；要收词才 Enter / 点「加入单词本」。收词后 0.30 的
 * 后台回填机制照旧（词统一转小写后落盘）。
 *
 * 交互：Enter = 添加（可连续添加，输入框清空接着输），Esc / 点遮罩 = 关闭。
 */

import { useEffect, useRef, useState } from "react";
import { vocabLookup } from "../lib/api";

/** 输入停顿多久后自动查释义。 */
const LOOKUP_DEBOUNCE = 500;

interface LookupResult {
  word: string;
  meaning: string;
  phonetic: string;
}

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
  const [lookup, setLookup] = useState<LookupResult | "loading" | "failed" | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 只用于让过期的自动查询结果作废。 */
  const lookupSeq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 输入停顿后自动查在线释义（0.32）：查词不落盘，收词才落盘
  useEffect(() => {
    const word = draft.trim().toLowerCase();
    if (!word) {
      lookupSeq.current += 1;
      setLookup(null);
      return;
    }
    setLookup("loading");
    const seq = (lookupSeq.current += 1);
    const timer = window.setTimeout(() => {
      vocabLookup(word)
        .then((result) => {
          if (seq !== lookupSeq.current) return;
          if (result.meaning || result.phonetic) {
            setLookup({ word, meaning: result.meaning, phonetic: result.phonetic });
          } else {
            setLookup("failed");
          }
        })
        .catch(() => {
          if (seq === lookupSeq.current) setLookup("failed");
        });
    }, LOOKUP_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [draft]);

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
          <span className="quick-capture-title">查词 / 添加单词</span>
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
        {/* 自动查询的释义区（0.32）：只读展示，不落盘。 */}
        <div className="add-word-lookup" data-keywords="单词 释义">
          {lookup === null && (
            <span className="add-word-lookup-hint">输入后自动查询释义，看完即走；Enter 才收入单词本</span>
          )}
          {lookup === "loading" && <span className="add-word-lookup-hint">正在查询释义…</span>}
          {lookup === "failed" && (
            <span className="add-word-lookup-hint">没有查到释义（词形不对或网络问题），收入后可在单词面板里手动再查</span>
          )}
          {lookup && typeof lookup === "object" && (
            <div className="add-word-lookup-body">
              {lookup.phonetic && <span className="add-word-lookup-phonetic">{lookup.phonetic}</span>}
              <span className="add-word-lookup-meaning">{lookup.meaning}</span>
            </div>
          )}
        </div>
        <div className="quick-capture-help">
          <span>
            <kbd>Enter</kbd> 添加 · 词会统一转小写
          </span>
          <span className="spacer" />
          <span>释义自动在线查询并回填</span>
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

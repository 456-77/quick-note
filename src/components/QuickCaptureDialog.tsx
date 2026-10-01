/**
 * 快速笔记捕获弹窗：一条速记追加进「收件仓库」（不切换当前仓库、不新开标签）。
 *
 * 场景：正在别的仓库里干活，突然想记一条电脑操作技巧——按快捷键（默认
 * Ctrl+Alt-N，可在设置 → 快捷键 里改）唤起这里，Enter 写入收件箱继续干活。
 *
 * Enter = 记下来，Shift+Enter = 换行（提交时折叠成 " / "，速记一行一条），
 * Esc / 点遮罩 = 取消。可顺手打标签（空格分隔，速记管理里聚合筛选）。
 * 提交由父组件做 IO，返回是否成功：失败（仓库没配、写盘出错）弹窗保持展开便于重试。
 */

import { useEffect, useRef, useState } from "react";
import { normalizeTagName } from "../lib/tags";
import { IconX } from "./icons";

export default function QuickCaptureDialog({
  /** 落点提示，如「Inbox.md · 00-Inbox」；空串表示还没配置收件仓库。 */
  target,
  /** 标签联想词表（当前仓库 + 收件仓库出现过的标签，App 侧合并）。 */
  tagSuggestions,
  onSubmit,
  onClose,
  onOpenSettings,
}: {
  target: string;
  tagSuggestions: string[];
  /** text 已折成一行（换行变 " / "），tags 已规范去重。返回是否成功（成功关窗）。 */
  onSubmit: (text: string, tags: string[]) => Promise<boolean>;
  onClose: () => void;
  /** 未配置收件仓库时提示里给一个直达设置的入口。 */
  onOpenSettings: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (busy) return;
    // 速记一行一条：多行输入折成一行（用 " / " 分隔），不拆散行格式
    const text = draft
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" / ");
    if (!text) return;
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const piece of tagDraft.split(/[\s,，、]+/)) {
      const name = normalizeTagName(piece);
      if (name && !seen.has(name)) {
        seen.add(name);
        tags.push(name);
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (await onSubmit(text, tags)) {
        onClose();
        return;
      }
    } catch (e) {
      setError(String(e));
      return;
    } finally {
      setBusy(false);
    }
    // onSubmit 返回 false：父组件已给出原因（未配置等），这里不重复弹错
  };

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="quick-capture" role="dialog" aria-label="快速笔记">
        <div className="quick-capture-head">
          <span className="quick-capture-title">快速笔记</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" title="取消 (Esc)" onClick={onClose}>
            <IconX size={13} />
          </button>
        </div>
        <textarea
          ref={inputRef}
          rows={3}
          value={draft}
          placeholder="记点什么…（Enter 记下来，Shift+Enter 换行）"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <input
          type="text"
          className="quick-capture-tags"
          list="quick-capture-tag-options"
          value={tagDraft}
          placeholder="标签，空格分隔（可选，如：想法 项目A）"
          title="标签写进速记行，速记管理里聚合筛选"
          onChange={(event) => setTagDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <datalist id="quick-capture-tag-options">
          {tagSuggestions.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        <div className="quick-capture-foot">
          {target ? (
            <span className="quick-capture-target" title={target}>
              记到 {target}
            </span>
          ) : (
            <button type="button" className="quick-capture-setup" onClick={onOpenSettings}>
              还没选择收件仓库，去设置 → 通用 里配置
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!draft.trim() || busy}
            onClick={() => void submit()}
          >
            {busy ? "记下中…" : "记下来"}
          </button>
        </div>
        {error && <div className="quick-capture-error">{error}</div>}
      </div>
    </>
  );
}

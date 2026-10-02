/**
 * 快速笔记捕获弹窗：一条速记追加进「收件仓库」（不切换当前仓库、不新开标签）。
 *
 * 场景：正在别的仓库里干活，突然想记一条电脑操作技巧——按快捷键（默认
 * Ctrl+Alt-N，可在设置 → 快捷键 里改）唤起这里，Enter 写入收件箱继续干活。
 *
 * 交互：Enter = 记下来，Shift+Enter = 换行（提交时折叠成 " / "，速记一行一条），
 * Ctrl/Cmd+Enter 任意焦点都可提交，Esc / 点遮罩 = 关闭。标签是 chip 输入组件——
 * 输入后 Enter 生成标签、Backspace 删最后一个，速记管理里聚合筛选。
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
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const tagRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /** 把输入框里的文字落成一个标签 chip。 */
  const commitTag = (): boolean => {
    const name = normalizeTagName(tagDraft);
    if (!name) {
      setTagDraft("");
      return false;
    }
    setTags((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setTagDraft("");
    return true;
  };

  const submit = async () => {
    if (busy) return;
    // 速记一行一条：多行输入折成一行（用 " / " 分隔），不拆散行格式
    const text = draft
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" / ");
    if (!text) return;
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

  /** 标签输入框里的 Enter：有内容 = 生成标签；已空 = 直接提交整条速记。 */
  const tagInputEnter = () => {
    if (tagDraft.trim()) {
      commitTag();
      return;
    }
    void submit();
  };

  // 保存位置展示：文件里的 {{date}} 就地展开（与 App 侧写入口径一致）
  const [fileHint, vaultHint] = target ? target.split(" · ") : ["", ""];
  const displayFile = (fileHint || "").replace(
    /\{\{date\}\}/g,
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(
      new Date().getDate(),
    ).padStart(2, "0")}`,
  );

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="quick-capture" role="dialog" aria-label="快速笔记">
        <div className="quick-capture-head">
          <span className="quick-capture-title">快速笔记</span>
          <span className="spacer" />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>

        <textarea
          ref={inputRef}
          rows={5}
          value={draft}
          placeholder="记录想法..."
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
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
            <kbd>Enter</kbd> 保存 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
          </span>
          <span className="spacer" />
          <span>
            <kbd>{navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"}</kbd>+
            <kbd>Enter</kbd> 保存
          </span>
        </div>

        <div className="quick-capture-tags">
          {tags.map((tag) => (
            <span key={tag} className="quick-capture-tag">
              #{tag}
              <button
                type="button"
                className="quick-capture-tag-x"
                title={`移除 #${tag}`}
                onClick={() => setTags((prev) => prev.filter((item) => item !== tag))}
              >
                <IconX size={9} />
              </button>
            </span>
          ))}
          <input
            ref={tagRef}
            type="text"
            className="quick-capture-tags-input"
            list="quick-capture-tag-options"
            value={tagDraft}
            placeholder={tags.length > 0 ? "加标签…" : "标签（Enter 生成，可留空）"}
            title="标签写进速记行，速记管理里聚合筛选"
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                tagInputEnter();
              }
              if (event.key === "Backspace" && !tagDraft && tags.length > 0) {
                event.preventDefault();
                setTags((prev) => prev.slice(0, -1));
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
        </div>

        <div className="quick-capture-foot">
          {target ? (
            <span className="quick-capture-target" title={target}>
              <span className="quick-capture-target-file">{displayFile}</span>
              {vaultHint && <span className="quick-capture-target-vault">· {vaultHint}</span>}
            </span>
          ) : (
            <button type="button" className="quick-capture-setup" onClick={onOpenSettings}>
              还没选择收件仓库，去设置 → 通用 里配置
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-primary quick-capture-save"
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

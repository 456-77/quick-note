/**
 * 标签管理浮层：由标题栏的标签按钮唤出（不再常驻编辑区底部占空间）。
 *
 * 当前笔记的标签以芯片展示（点 × 移除）；输入框支持一次贴多个标签——
 * 用逗号（中英）、顿号或空格分隔批量添加，Enter 提交。补全词表来自
 * 本仓库累积（App 侧 localStorage 按仓库分桶）。
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface TagPopoverProps {
  /** 当前笔记的标签（按正文出现顺序）。 */
  tags: string[];
  /** 补全词表（全仓库已知标签）。 */
  vocabulary: string[];
  /** 逐个添加（批量由本组件拆分后多次回调）。 */
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  onClose: () => void;
}

/** 把输入拆成标签名：逗号/顿号/空白分隔，去掉 # 前缀与空白。 */
export function splitTagInput(input: string): string[] {
  return input
    .split(/[,，、\s]+/)
    .map((part) => part.trim().replace(/^#+/, "").trim())
    .filter(Boolean);
}

export default function TagPopover({ tags, vocabulary, onAdd, onRemove, onClose }: TagPopoverProps) {
  const [draft, setDraft] = useState("");
  /** ▼ 展开全量词表（不输入也看得到）；输入时按包含过滤。 */
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc 关闭挂在 window 上：焦点在任何位置（含点过别的面板后）都能关
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const suggestions = useMemo(
    () => vocabulary.filter((tag) => !tags.includes(tag)).slice(0, 200),
    [vocabulary, tags],
  );

  // 0.33.1 用户反馈「下拉选项透图」：原先用原生 <datalist>，安卓 WebView 把它
  // 渲染成不可控的半透明列表（样式无法覆盖、点几次 ▼ 都透）。改自绘建议面板：
  // 实底、紧凑行、限高滚动；输入时按包含过滤，▼ 展开全量，点击直接上标签
  const filtered = useMemo(() => {
    const q = draft.trim().toLowerCase();
    const base = q ? suggestions.filter((tag) => tag.toLowerCase().includes(q)) : suggestions;
    return base.slice(0, 30);
  }, [suggestions, draft]);
  const panelOpen = showAll || draft.trim() !== "";

  const submit = () => {
    const names = splitTagInput(draft);
    for (const name of names) onAdd(name);
    // 还贴得动的输入就别让用户再点一次：批量贴标签是常态
    setDraft("");
    inputRef.current?.focus();
  };

  return (
    <>
      {/* 点浮层外面关闭；放浮层自身之下、页面其余内容之上 */}
      <div className="menu-backdrop" onClick={onClose} />
      <div className="tag-popover" role="dialog" aria-label="笔记标签">
        <div className="tag-popover-head">笔记标签</div>
        {tags.length > 0 && (
          <div className="tag-popover-chips">
            {tags.map((tag) => (
              <span className="tagbar-chip" key={tag} title={`移除标签 #${tag}`}>
                <span className="tagbar-chip-name">#{tag}</span>
                <button
                  type="button"
                  className="tagbar-chip-x"
                  aria-label={`移除 ${tag}`}
                  onClick={() => onRemove(tag)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {tags.length === 0 && <div className="tag-popover-empty">还没有标签</div>}
        <div className="tag-popover-inputrow">
          <input
            ref={inputRef}
            className="tagbar-input tag-popover-input"
            type="text"
            value={draft}
            placeholder="可一次贴多个：工作, 记录 或 学习/前端"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <button
            type="button"
            className={`tag-popover-caret${panelOpen && filtered.length > 0 ? " is-open" : ""}`}
            aria-label="展开标签词表"
            title="展开标签词表"
            onClick={() => setShowAll((value) => !value)}
          >
            ▼
          </button>
        </div>
        {panelOpen && filtered.length > 0 && (
          <div className="tag-popover-suggest" role="listbox" aria-label="标签词表">
            {filtered.map((tag) => (
              <button
                key={tag}
                type="button"
                role="option"
                aria-label={`添加标签 #${tag}`}
                onClick={() => {
                  onAdd(tag);
                  setDraft("");
                  inputRef.current?.focus();
                }}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
        <div className="tag-popover-hint">Enter 添加 · 逗号或空格分隔可批量 · Esc 关闭</div>
      </div>
    </>
  );
}

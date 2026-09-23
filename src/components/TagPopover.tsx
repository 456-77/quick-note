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
        <input
          ref={inputRef}
          className="tagbar-input tag-popover-input"
          type="text"
          list="qn-tag-vocabulary"
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
        <datalist id="qn-tag-vocabulary">
          {suggestions.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        <div className="tag-popover-hint">Enter 添加 · 逗号或空格分隔可批量 · Esc 关闭</div>
      </div>
    </>
  );
}

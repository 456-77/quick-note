/**
 * 选区标题归一的级别选择弹窗。
 *
 * 0.20 用户反馈：不要每个等级一个快捷键，触发后弹窗让用户选设置几级标题。
 * 选中级别后由 App 侧对当前编辑器执行 {@link codeEdit.clampHeadings}；
 * 弹窗本身不碰编辑器。
 */

import { useEffect } from "react";
import { IconX } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (level: number) => void;
}

export default function HeadingLevelDialog({ open, onClose, onPick }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card clamp-heading-card"
        role="dialog"
        aria-label="选择标题级别"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span>选区标题归一：设置几级标题？</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>
        <div className="clamp-heading-grid">
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <button
              key={level}
              type="button"
              className="clamp-heading-btn"
              title={`选区内最高级标题设为 H${level}，其余小标题保持层级相对平移`}
              onClick={() => {
                onClose();
                onPick(level);
              }}
            >
              <span className={`clamp-heading-tag clamp-heading-tag-${level}`}>
                {"#".repeat(level)} H{level}
              </span>
              {level === 1 && <span className="clamp-heading-badge">最高级</span>}
            </button>
          ))}
        </div>
        <div className="clamp-heading-note">空选区时作用于全文；只调整标题行，正文不动。</div>
      </div>
    </div>
  );
}

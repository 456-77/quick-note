/**
 * 选周弹窗：为最近 12 周（含本周）的任意一周生成回顾。
 *
 * 与插件的 WeekReviewModal 同一口径（12 周、本周在前）；这里是普通列表
 * 而不是模糊搜索——12 项的规模用不着搜索框，点击即生成。
 */

import { useMemo } from "react";
import moment from "moment";
import { recentWeeks } from "../lib/weeklyReview";
import { IconX } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  /** mondayISO：选中那一周的周一（YYYY-MM-DD）。 */
  onPick: (mondayISO: string) => void;
}

export default function WeekReviewDialog({ open, onClose, onPick }: Props) {
  // anchor 固定为「今天」：弹窗每次打开时重算 12 周窗口
  const weeks = useMemo(() => (open ? recentWeeks(moment()) : []), [open]);
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card week-review-card"
        role="dialog"
        aria-label="选择要生成回顾的周"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span>选择要生成回顾的周</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>
        <div className="week-review-list">
          {weeks.map((week, index) => (
            <button
              key={week.weekKey}
              type="button"
              className="week-review-item"
              onClick={() => {
                onClose();
                onPick(week.monday.format("YYYY-MM-DD"));
              }}
            >
              <span className="week-review-label">{week.label}</span>
              {index === 0 && <span className="week-review-badge">本周</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

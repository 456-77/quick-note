/**
 * 快速添加待办弹窗（0.27 用户反馈：给「添加待办」一个快捷键唤起的弹窗）。
 *
 * 一个输入框 + 一排日期 chip：正文支持日历面板同款**日期前缀语法**
 * （明天/后天/大后天、2026-10-21、10-21，见 daily.ts 的 parseTodoDateInput）；
 * 也可以先点 chip 选定日期再写正文（前缀语法优先）。Enter 记下并关闭，
 * Esc / 点遮罩关闭。提交由父组件走 useDaily.addTodo（落 quick-daily-note.json
 * 并通知同步引擎），这里不做 IO。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import moment from "moment";
import { parseTodoDateInput } from "../lib/daily";

export default function QuickTodoDialog({
  dateFormat,
  today,
  onSubmit,
  onClose,
}: {
  /** 待办存储键的日期格式（与仓库配置一致）。 */
  dateFormat: string;
  today: string;
  /** 日期（该格式）与正文都已校验非空；调用方负责落库与反馈。 */
  onSubmit: (date: string, text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  /** 选中的日期 chip（该 chip 的完整日期串）；空串 = 无选中，靠前缀语法或今天。 */
  const [picked, setPicked] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const base = useMemo(
    () => (moment(today, dateFormat, true).isValid() ? moment(today, dateFormat) : moment()),
    [today, dateFormat],
  );
  const chips = useMemo(
    () =>
      ["今天", "明天", "后天"].map((label, days) => ({
        label,
        date: base.clone().add(days, "day").format(dateFormat),
      })),
    [base, dateFormat],
  );

  const submit = () => {
    // 前缀语法优先（与日历面板同一套解析）；没有前缀时用选中的 chip，否则今天
    const trimmed = draft.trim();
    if (!trimmed) return;
    const scheduled = parseTodoDateInput(trimmed, dateFormat, base.format(dateFormat));
    if (scheduled) onSubmit(scheduled.date, scheduled.text);
    else onSubmit(picked || base.format(dateFormat), trimmed);
    onClose();
  };

  return (
    <div
      className="recent-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="recent-dialog quick-todo" role="dialog" aria-label="快速添加待办">
        <div className="recent-head">
          <span className="recent-title">快速添加待办</span>
          <span className="recent-count">{picked || base.format(dateFormat)}</span>
          <button type="button" className="recent-close" title="关闭（Esc）" onClick={onClose}>
            ×
          </button>
        </div>
        <input
          ref={inputRef}
          type="text"
          className="recent-search"
          placeholder="待办内容…（可用「明天 / 2026-10-21」开头记到那天）"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="recent-chips" role="tablist" aria-label="记到哪一天">
          {chips.map((chip) => (
            <button
              key={chip.date}
              type="button"
              role="tab"
              aria-selected={picked === chip.date || (picked === "" && chip.label === "今天")}
              className={`recent-chip${picked === chip.date || (picked === "" && chip.label === "今天") ? " is-on" : ""}`}
              onClick={() => setPicked(chip.date)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="recent-hint">Enter 记下 · Esc 关闭 · 开头写「明天/后天/日期」可记到指定日</div>
      </div>
    </div>
  );
}

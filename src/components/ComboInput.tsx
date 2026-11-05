/**
 * 下拉补全输入框（0.38 用户反馈「下拉框风格要对齐软件」）：
 * 收录弹窗的项目框与快速笔记的标签框原来都挂原生 datalist——那是浏览器控件，
 * 深色主题里弹出泛白的系统列表（用户截图实锤），风格与应用脱节。这里换成
 * 自定义候选列表：输入过滤 + ↑/↓ 高亮 + Enter 选中，视觉走应用自己的
 * surface/border 变量。
 *
 * 受控语义与原 input 完全一致（value/onChange 原样转发），额外约定：
 * - 候选开着且高亮在某项上时，Enter 选中该项（onPick），keydown 不再下传——
 *   否则快速笔记会先把原文 commit 成标签再选中，一次 Enter 出两个结果；
 * - Esc 先收候选（不下传），再按一次才走调用方的 Esc 通道（关弹窗）；
 * - 其余按键原样转发调用方的 onKeyDown（Backspace 删 chip、Ctrl+Enter 提交等
 *   都不受影响）。
 * 点击候选用 onMouseDown + preventDefault（不抢焦点），输入框保持焦点可连续选。
 */

import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

const MAX_SUGGESTIONS = 50;

export default function ComboInput({
  value,
  onChange,
  onPick,
  suggestions,
  placeholder,
  title,
  ariaLabel,
  autoFocus = false,
  onKeyDown,
  /** 原样透传的粘贴通道（快速笔记标签框：往标签框粘的截图归入正文图片）。 */
  onPaste,
  inputRef,
}: {
  value: string;
  onChange: (next: string) => void;
  /** 选中某条候选（点击或 Enter）。绝大多数场景里选中 = 采纳候选文本。 */
  onPick?: (picked: string) => void;
  /** 候选词表（按当前输入过滤：前缀命中优先，其后包含命中）。 */
  suggestions: string[];
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** 候选没收走按键时原样转发（调用方保留 Enter 提交/Esc 关窗等语义）。 */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onPaste?: (event: ReactClipboardEvent<HTMLInputElement>) => void;
  /** 调用方需要拿到 input 元素时（初始 focus 等）。 */
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase();
    const starts: string[] = [];
    const includes: string[] = [];
    for (const item of suggestions) {
      if (item === value) continue;
      const lower = item.toLowerCase();
      if (query && lower.startsWith(query)) starts.push(item);
      else if (query && lower.includes(query)) includes.push(item);
      else if (!query) starts.push(item);
    }
    return [...starts, ...includes].slice(0, MAX_SUGGESTIONS);
  }, [suggestions, value]);

  // 输入变化后高亮回到第一项（开合状态由 focus/外点/按键管理，不在这里动）
  useEffect(() => {
    setHighlight(0);
  }, [value]);

  const pick = (item: string) => {
    setOpen(false);
    onChange(item);
    onPick?.(item);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (open && filtered.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((prev) => (prev + 1) % filtered.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((prev) => (prev - 1 + filtered.length) % filtered.length);
        return;
      }
      if (event.key === "Enter") {
        // 只在「补全意图」时接管 Enter：输入了内容且高亮候选以它为前缀（打「整」
        // 选中「待整理」）。输入框里已经是完整词（打全「整理」）时透传给调用方
        // 按原文提交——快速笔记的标签框要落的是用户打的词，不是最像的候选
        // （0.38 门禁踩中：输入「整理」+Enter 曾被候选「待整理」截胡）。输入为空
        // 也不接管（快速笔记空标签框 Enter = 提交速记的既有语义）
        const query = value.trim().toLowerCase();
        const candidate = filtered[Math.min(highlight, filtered.length - 1)];
        if (query !== "" && candidate.toLowerCase().startsWith(query)) {
          event.preventDefault();
          event.stopPropagation();
          pick(candidate);
          return;
        }
        onKeyDown?.(event);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
    }
    onKeyDown?.(event);
  };

  // 点到组件外收起候选（不抢焦点：弹窗里还有别的输入框）
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    return () => document.removeEventListener("mousedown", onDocMouseDown, true);
  }, [open]);

  return (
    <span className="combo" ref={wrapRef}>
      <input
        ref={inputRef ?? undefined}
        type="text"
        className="combo-input"
        value={value}
        placeholder={placeholder}
        title={title}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open && filtered.length > 0}
        aria-controls="combo-list"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(event) => {
          onChange(event.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          if (filtered.length > 0) setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
      />
      {open && filtered.length > 0 && (
        <div className="combo-list" role="listbox" aria-label={ariaLabel}>
          {filtered.map((item, index) => (
            <button
              key={item}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className={`combo-option${index === highlight ? " is-on" : ""}`}
              title={item}
              // onMouseDown 而不是 onClick：先于 input 的 blur 执行且不抢焦点
              onMouseDown={(event) => {
                event.preventDefault();
                pick(item);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

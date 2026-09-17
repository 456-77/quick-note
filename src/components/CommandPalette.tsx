/**
 * 全局命令面板（Ctrl+K）：搜索笔记、全文检索内容、触发快捷操作。
 *
 * 三类结果合一列表，方向键上下、回车执行：
 *   1. 快捷操作 —— 新建/保存/切换模式等，来自调用方注入（App 持有这些回调）；
 *   2. 笔记 —— 按文件名即时过滤（entries 已在内存里，零开销）；
 *   3. 内容 —— Rust 侧 `search_vault` 全文扫描，防抖 250ms，取每个文件的首个命中行，
 *      回车直接打开并跳到那一行。
 *
 * 面板是纯展示组件：开关由 App 控制，这样顶栏的搜索框、快捷键、Esc 都能收拢在一处。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { searchVault, type EntryMeta, type SearchHit } from "../lib/api";

export interface PaletteAction {
  id: string;
  title: string;
  /** 快捷键提示（右侧灰字）。 */
  hint?: string;
  icon: string;
  run: () => void;
}

interface Item {
  key: string;
  group: string;
  icon: string;
  title: string;
  /** 命中行摘要（内容搜索结果）。 */
  detail?: string;
  /** 右侧弱化信息（修改时间等）。 */
  meta?: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  entries: EntryMeta[];
  vault: string | null;
  onOpenNote: (path: string, line?: number) => void;
  actions: PaletteAction[];
}

const SEARCH_DEBOUNCE = 250;
const NAME_LIMIT = 8;
const CONTENT_LIMIT = 14;

/** 大小写不敏感地判断文件名是否命中全部关键词。 */
function nameHits(name: string, terms: string[]): boolean {
  const lowered = name.toLowerCase();
  return terms.every((term) => lowered.includes(term));
}

function formatTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把命中关键词的部分包上 <mark>。只处理第一个命中的词，足够指路。 */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const lower = text.toLowerCase();
  let start = -1;
  let length = 0;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (start < 0 || at < start)) {
      start = at;
      length = term.length;
    }
  }
  if (start < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, start + length)}</mark>
      {text.slice(start + length)}
    </>
  );
}

export default function CommandPalette({ open, onClose, entries, vault, onOpenNote, actions }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [contentHits, setContentHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 只用于让过期的异步搜索结果作废。 */
  const searchSeq = useRef(0);

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);

  // 打开时重置并聚焦；关闭时清掉残留的搜索结果
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setContentHits([]);
      setSearching(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 全文搜索防抖；名称过滤是同步的，不在这里
  useEffect(() => {
    if (!open || !vault || terms.length === 0) {
      setContentHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      const seq = (searchSeq.current += 1);
      searchVault(vault, terms.join(" "), 50)
        .then((hits) => {
          if (searchSeq.current === seq) setContentHits(hits);
        })
        .catch(() => {
          if (searchSeq.current === seq) setContentHits([]);
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, SEARCH_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [open, vault, terms]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const out: Item[] = [];

    const actionPool = terms.length
      ? actions.filter((action) => action.title.toLowerCase().includes(query.trim().toLowerCase()))
      : actions;
    for (const action of actionPool) {
      out.push({
        key: `action-${action.id}`,
        group: "快捷操作",
        icon: action.icon,
        title: action.title,
        hint: action.hint,
        run: action.run,
      });
    }

    if (terms.length > 0) {
      const notes = entries
        .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md"))
        .filter((entry) => nameHits(entry.name, terms))
        .sort((a, b) => b.modified - a.modified)
        .slice(0, NAME_LIMIT);
      for (const note of notes) {
        out.push({
          key: `note-${note.path}`,
          group: "笔记",
          icon: "📄",
          title: note.name,
          detail: note.path,
          meta: formatTime(note.modified),
          run: () => onOpenNote(note.path),
        });
      }

      const seen = new Set(notes.map((note) => note.path));
      for (const hit of contentHits.slice(0, CONTENT_LIMIT)) {
        // 内容命中里已经是名称命中的文件不再重复列
        if (seen.has(hit.path)) continue;
        seen.add(hit.path);
        out.push({
          key: `hit-${hit.path}-${hit.line}`,
          group: "内容",
          icon: "🔎",
          title: hit.path.slice(hit.path.lastIndexOf("/") + 1),
          detail: hit.text.trim(),
          run: () => onOpenNote(hit.path, hit.line),
        });
      }
    }

    return out;
  }, [open, actions, actions.length, entries, terms, query, contentHits, onOpenNote]);

  // 结果变化时把选中项拉回范围
  useEffect(() => {
    setActive((value) => Math.min(value, Math.max(items.length - 1, 0)));
  }, [items.length]);

  // 键盘选中项滚进可视范围
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector(".palette-item.is-active");
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const pick = (index: number) => {
    const item = items[index];
    if (!item) return;
    onClose();
    item.run();
  };

  const groups: { name: string; items: Item[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  // 组结构 -> 扁平下标（方向键/回车用的就是全局下标）
  let renderIndex = -1;

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input-row">
          <span className="palette-icon">🔎</span>
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="搜索笔记、全文内容，或输入命令…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, items.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                pick(active);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <kbd className="palette-kbd">Esc</kbd>
        </div>

        <div className="palette-list" ref={listRef}>
          {items.length === 0 && (
            <div className="palette-empty">
              {searching ? "正在搜索…" : terms.length === 0 ? "输入以搜索，↑↓ 选择，回车打开" : "没有匹配的结果"}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.name} className="palette-group">
              <div className="palette-group-name">{group.name}</div>
              {group.items.map((item) => {
                renderIndex += 1;
                const index = renderIndex;
                return (
                  <button
                    type="button"
                    key={item.key}
                    className={`palette-item${index === active ? " is-active" : ""}`}
                    onMouseMove={() => setActive(index)}
                    onClick={() => pick(index)}
                  >
                    <span className="palette-item-icon">{item.icon}</span>
                    <span className="palette-item-body">
                      <span className="palette-item-title">
                        <Highlight text={item.title} terms={terms} />
                      </span>
                      {item.detail && (
                        <span className="palette-item-detail">
                          <Highlight text={item.detail} terms={terms} />
                        </span>
                      )}
                    </span>
                    {item.meta && <span className="palette-item-meta">{item.meta}</span>}
                    {item.hint && <kbd className="palette-kbd">{item.hint}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}

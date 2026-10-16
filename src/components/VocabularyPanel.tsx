/**
 * 单词本面板（右侧「单词」页签）。
 *
 * 数据源是仓库根的 `单词本.md`（格式见 vocabulary.ts 的文件头说明）：面板只做
 * 读取 → 解析 → 行级变换 → 写回，文件本身保持用户可手编的普通 Markdown。
 *
 * 0.24 按用户提示词重做（"轻量的个人单词记忆工具，快速记录 + 快速查词"）：
 *  - 搜索优先：顶部醒目搜索框（英文/中文释义实时过滤、回车记入最近搜索、
 *    清除按钮、匹配计数、无结果空态 + 一键收录）；
 *  - 快捷筛选：全部 / 待学习 / 已掌握 / 最近添加，默认全部；
 *  - 列表卡片：单词为主、释义次级、轻量状态标识，按字母分组 + 字母栏快速定位；
 *  - 点击单词弹轻量详情（发音 / 释义 / 备注 / 状态 / 添加时间 / 标记 / 编辑 /
 *    删除），没有内容的模块自动隐藏；移动端走底部弹层样式；
 *  - 快速添加：输入 → 添加 → 轻量 Toast（重复词给「查看」入口），不跳转。
 * 刷新时机：仓库切换 / 文件树 revision / 收词或外部改动触发的 version 变化。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readNoteOptional, writeNote } from "../lib/api";
import { isMobile } from "../lib/platform";
import {
  VOCAB_FILENAME,
  addVocabEntry,
  parseVocabulary,
  removeVocabEntry,
  setVocabLearned,
  updateVocabEntry,
  type VocabEntry,
} from "../lib/vocabulary";

interface Props {
  vault: string | null;
  /** 文件树代际：仓库文件变动（含单词本被手改）时重读。 */
  revision: number;
  /** 单词本代际：收词落盘 / 外部改动单词本时 bump（快捷键收词不经过编辑器）。 */
  version: number;
  onOpen: (path: string) => void;
  notice: (message: string, kind?: "info" | "error") => void;
}

type Filter = "all" | "todo" | "done" | "recent";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "todo", label: "待学习" },
  { key: "done", label: "已掌握" },
  { key: "recent", label: "最近添加" },
];

const RECENT_KEY = "quicknote.vocabRecentSearches";
const RECENT_LIMIT = 8;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** 词条按查询过滤：空格分段的每一段都要在 词/释义/备注 里出现（大小写不敏感）。 */
function matchEntry(entry: VocabEntry, tokens: string[]): boolean {
  const hay = `${entry.word}\n${entry.meaning}\n${entry.note}`.toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

/** meta 开头的 YYYY-MM-DD（「最近添加」排序用；没有日期的排最后）。 */
function addedAt(entry: VocabEntry): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(entry.meta);
  return match ? match[1] : "0000-00-00";
}

/** 分组键：拉丁字母按首字母归组，其余（中文等）归「#」。 */
function groupKey(word: string): string {
  const ch = word.charAt(0).toUpperCase();
  return ch >= "A" && ch <= "Z" ? ch : "#";
}

/** 当天本地日期（YYYY-MM-DD），快速添加的 meta 用。 */
function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 面板内的轻量 Toast（添加/状态切换反馈，带可选动作）。 */
interface PanelToast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

export default function VocabularyPanel({ vault, revision, version, onOpen, notice }: Props) {
  const [entries, setEntries] = useState<VocabEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailWord, setDetailWord] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [toast, setToast] = useState<PanelToast | null>(null);
  const toastTimer = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 桌面端进入面板即聚焦搜索框（移动端不自动弹键盘，点击再聚焦）
  useEffect(() => {
    if (!isMobile()) searchInputRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    if (!vault) {
      setEntries([]);
      return;
    }
    try {
      const note = await readNoteOptional(vault, VOCAB_FILENAME);
      setEntries(note ? parseVocabulary(note.content) : []);
    } catch {
      setEntries([]);
    }
  }, [vault]);

  useEffect(() => {
    void reload();
  }, [reload, revision, version]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  /** 行级变换的公共骨架：读 → 变换 → 写回 → 刷新列表。 */
  const mutate = useCallback(
    async (transform: (content: string) => string): Promise<boolean> => {
      if (!vault || busy) return false;
      setBusy(true);
      try {
        const note = await readNoteOptional(vault, VOCAB_FILENAME);
        const content = note?.content ?? "";
        const next = transform(content);
        if (next === content) return false;
        await writeNote(vault, VOCAB_FILENAME, next, false);
        return true;
      } catch (e) {
        notice(`单词本操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
        return false;
      } finally {
        setBusy(false);
        void reload();
      }
    },
    [vault, busy, notice, reload],
  );

  const showToast = useCallback((message: string, action?: PanelToast["action"]) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message, action });
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  /** 快速添加（不跳转）：成功 Toast；重复词给「查看」入口。 */
  const addWord = useCallback(
    async (raw: string) => {
      const word = raw.trim();
      if (!word || !vault || busy) return;
      setDraft((prev) => (prev.trim() === word ? "" : prev));
      setBusy(true);
      try {
        const note = await readNoteOptional(vault, VOCAB_FILENAME);
        const content = note?.content ?? "";
        const result = addVocabEntry(content, word, `${today()} · 手动添加`);
        if (!result.added) {
          showToast("这个单词已经添加过了", { label: "查看", run: () => setDetailWord(word) });
          return;
        }
        await writeNote(vault, VOCAB_FILENAME, result.content, false);
        showToast("已添加到待学习");
      } catch (e) {
        notice(`单词本操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        setBusy(false);
        void reload();
      }
    },
    [vault, busy, notice, reload, showToast],
  );

  /** 回车提交搜索：记入最近搜索（去重、限量）。 */
  const commitSearch = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setRecent((prev) => {
      const next = [
        trimmed,
        ...prev.filter((item) => item.toLowerCase() !== trimmed.toLowerCase()),
      ].slice(0, RECENT_LIMIT);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // 存不上只影响下次的最近搜索
      }
      return next;
    });
  }, [query]);

  const tokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );
  const searching = tokens.length > 0;

  const visible = useMemo(() => {
    let list = entries;
    if (searching) list = list.filter((entry) => matchEntry(entry, tokens));
    if (filter === "todo") list = list.filter((entry) => !entry.learned);
    else if (filter === "done") list = list.filter((entry) => entry.learned);
    else if (filter === "recent") {
      list = [...list].sort(
        (a, b) => addedAt(b).localeCompare(addedAt(a)) || b.line - a.line,
      );
    }
    if (filter !== "recent") {
      const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });
      list = [...list].sort((a, b) => collator.compare(a.word, b.word));
    }
    return list;
  }, [entries, searching, tokens, filter]);

  /** 字母分组（「最近添加」是纯时间序，不分组）。 */
  const groups = useMemo(() => {
    if (filter === "recent") return [{ key: "", items: visible }];
    const map = new Map<string, VocabEntry[]>();
    for (const entry of visible) {
      const key = groupKey(entry.word);
      const bucket = map.get(key);
      if (bucket) bucket.push(entry);
      else map.set(key, [entry]);
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] === "#" ? 1 : 0) - (b[0] === "#" ? 1 : 0) || a[0].localeCompare(b[0]))
      .map(([key, items]) => ({ key, items }));
  }, [visible, filter]);

  const detail = useMemo(
    () => (detailWord ? entries.find((entry) => entry.word.toLowerCase() === detailWord.toLowerCase()) ?? null : null),
    [detailWord, entries],
  );

  // 详情开着时 Esc 只关详情（捕获阶段拦下，不透传给其他 Esc 链）
  useEffect(() => {
    if (!detailWord) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setDetailWord(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [detailWord]);

  const scrollToGroup = useCallback((key: string) => {
    const target = listRef.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(key)}"]`);
    target?.scrollIntoView({ block: "start" });
  }, []);

  const toggleLearned = useCallback(
    async (entry: VocabEntry, learned: boolean) => {
      const ok = await mutate((content) => setVocabLearned(content, entry.word, learned).content);
      if (ok) showToast(learned ? `已标记「${entry.word}」为已掌握` : `「${entry.word}」移回待学习`);
    },
    [mutate, showToast],
  );

  const removeWord = useCallback(
    async (entry: VocabEntry) => {
      const ok = await mutate((content) => removeVocabEntry(content, entry.word).content);
      if (ok) {
        setDetailWord((prev) => (prev?.toLowerCase() === entry.word.toLowerCase() ? null : prev));
        showToast(`已删除「${entry.word}」`);
      }
    },
    [mutate, showToast],
  );

  if (!vault) {
    return <div className="vocab-panel vocab-empty">打开仓库后可使用单词本。</div>;
  }

  const searchEmpty = searching && visible.length === 0;

  return (
    <div className="vocab-panel">
      {/* 搜索优先：顶部主搜索框（英文单词与中文释义都能搜，实时过滤） */}
      <div className="vocab-search">
        <span className="vocab-search-icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="21" y1="21" x2="16.5" y2="16.5"></line>
          </svg>
        </span>
        <input
          ref={searchInputRef}
          type="text"
          className="vocab-search-input"
          placeholder="搜索单词..."
          value={query}
          spellCheck={false}
          enterKeyHint="search"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitSearch();
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="vocab-search-clear"
            title="清除搜索"
            onClick={() => setQuery("")}
          >
            ×
          </button>
        )}
        <button
          type="button"
          className="btn btn-mini"
          title="重新读取单词本.md"
          onClick={() => void reload()}
        >
          ⟳
        </button>
        <button
          type="button"
          className="btn btn-mini"
          title="在编辑器中打开单词本.md"
          onClick={() => onOpen(VOCAB_FILENAME)}
        >
          打开
        </button>
      </div>

      {/* 快速添加：视觉层级低于搜索框，添加后停留原地 + Toast */}
      <div className="vocab-quickadd">
        <input
          type="text"
          className="vocab-quickadd-input"
          placeholder="输入单词，回车加入待学习…"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void addWord(draft);
            }
          }}
        />
        <button
          type="button"
          className="vocab-quickadd-btn"
          disabled={busy || !draft.trim()}
          onClick={() => void addWord(draft)}
        >
          添加
        </button>
      </div>

      {/* 最近搜索（空查询时显示，方便重复查词） */}
      {!searching && recent.length > 0 && (
        <div className="vocab-recent">
          {recent.map((item) => (
            <button
              key={item}
              type="button"
              className="vocab-recent-chip"
              onClick={() => setQuery(item)}
            >
              {item}
            </button>
          ))}
          <button
            type="button"
            className="vocab-recent-clear"
            title="清空最近搜索"
            onClick={() => {
              setRecent([]);
              try {
                localStorage.removeItem(RECENT_KEY);
              } catch {
                // 尽力而为
              }
            }}
          >
            清除
          </button>
        </div>
      )}

      {/* 快捷筛选 */}
      <div className="vocab-filters" role="tablist" aria-label="单词筛选">
        {FILTERS.map((item) => {
          const count =
            item.key === "all"
              ? entries.length
              : item.key === "todo"
                ? entries.filter((entry) => !entry.learned).length
                : item.key === "done"
                  ? entries.filter((entry) => entry.learned).length
                  : null;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={filter === item.key}
              className={`vocab-filter${filter === item.key ? " is-on" : ""}`}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
              {count !== null && <span className="vocab-filter-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {searching && (
        <div className="vocab-count-line">
          {visible.length > 0 ? `找到 ${visible.length} 个单词` : "没有找到相关单词"}
        </div>
      )}

      {/* 无结果空态：居中提示 + 一键收录当前搜索词 */}
      {searchEmpty ? (
        <div className="vocab-empty-search">
          <p>没有找到相关单词</p>
          <button type="button" className="vocab-empty-add" onClick={() => void addWord(query)}>
            添加「{query.trim()}」这个单词
          </button>
        </div>
      ) : visible.length === 0 ? (
        <p className="vocab-hint">
          还没有单词。在笔记里选中一个词按 <kbd>Ctrl+Alt+V</kbd>，或上面手动添加——
          单词记在仓库根的「{VOCAB_FILENAME}」里，随时可手改。
        </p>
      ) : (
        <div className="vocab-list" ref={listRef}>
          {groups.map((group) => (
            <div key={group.key || "recent"} className="vocab-group" data-group={group.key}>
              {group.key && <div className="vocab-group-letter">{group.key}</div>}
              {group.items.map((entry) => (
                <div
                  key={`${entry.line}-${entry.word}`}
                  className={`vocab-item${entry.learned ? " is-learned" : ""}`}
                  onClick={() => setDetailWord(entry.word)}
                >
                  <div className="vocab-item-main">
                    <span className="vocab-item-word">{entry.word}</span>
                    {entry.meaning && <span className="vocab-item-meaning">{entry.meaning}</span>}
                  </div>
                  <span className={`vocab-status${entry.learned ? " is-learned" : ""}`}>
                    {entry.learned ? "已掌握" : "待学习"}
                  </span>
                  <button
                    type="button"
                    className="vocab-item-toggle"
                    title={entry.learned ? "移回待学习" : "标记为已掌握"}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleLearned(entry, !entry.learned);
                    }}
                  >
                    {entry.learned ? "↩" : "✓"}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* 字母快速定位栏（列出实际存在的分组） */}
      {filter !== "recent" && groups.length > 1 && (
        <div className="vocab-alpha" aria-label="按字母定位">
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              onClick={() => scrollToGroup(group.key)}
            >
              {group.key}
            </button>
          ))}
        </div>
      )}

      {toast && (
        <div className="vocab-toast" key={toast.id} role="status">
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                setToast(null);
                toast.action?.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}

      {detail && (
        <VocabDetail
          entry={detail}
          busy={busy}
          onClose={() => setDetailWord(null)}
          onToggle={(learned) => void toggleLearned(detail, learned)}
          onRemove={() => void removeWord(detail)}
          onSave={(meaning, note) =>
            void mutate((content) => updateVocabEntry(content, detail.word, { meaning, note }).content)
          }
        />
      )}
    </div>
  );
}

/** 单词详情：桌面居中圆角弹层，移动端（coarse pointer）底部弹层。空模块自动隐藏。 */
function VocabDetail({
  entry,
  busy,
  onClose,
  onToggle,
  onRemove,
  onSave,
}: {
  entry: VocabEntry;
  busy: boolean;
  onClose: () => void;
  onToggle: (learned: boolean) => void;
  onRemove: () => void;
  onSave: (meaning: string, note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [meaning, setMeaning] = useState(entry.meaning);
  const [note, setNote] = useState(entry.note);

  // 换词（含条目被更新后的重挂载）时重置编辑态
  useEffect(() => {
    setEditing(false);
    setMeaning(entry.meaning);
    setNote(entry.note);
  }, [entry.word, entry.meaning, entry.note]);

  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  const speak = () => {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(entry.word);
      utterance.lang = "en-US";
      window.speechSynthesis.speak(utterance);
    } catch {
      // 没有可用的语音引擎就算了
    }
  };

  return (
    <div className="vocab-detail-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="vocab-detail" role="dialog" aria-label={`单词详情：${entry.word}`}>
        <div className="vocab-detail-head">
          <span className="vocab-detail-word">{entry.word}</span>
          {canSpeak && (
            <button type="button" className="vocab-detail-speak" title="朗读发音" onClick={speak}>
              🔊
            </button>
          )}
          <span className={`vocab-status${entry.learned ? " is-learned" : ""}`}>
            {entry.learned ? "已掌握" : "待学习"}
          </span>
          <button type="button" className="vocab-detail-close" title="关闭（Esc）" onClick={onClose}>
            ×
          </button>
        </div>

        {entry.meta && <div className="vocab-detail-meta">{entry.meta}</div>}

        {editing ? (
          <div className="vocab-detail-edit">
            <label>
              释义
              <input
                type="text"
                value={meaning}
                spellCheck={false}
                onChange={(event) => setMeaning(event.target.value)}
              />
            </label>
            <label>
              备注
              <input
                type="text"
                value={note}
                spellCheck={false}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <div className="vocab-detail-edit-actions">
              <button type="button" className="btn btn-mini" onClick={() => setEditing(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-mini vocab-detail-primary"
                disabled={busy}
                onClick={() => {
                  onSave(meaning, note);
                  setEditing(false);
                }}
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <>
            {entry.meaning && <div className="vocab-detail-meaning">{entry.meaning}</div>}
            {entry.note && <div className="vocab-detail-note">{entry.note}</div>}
            {!entry.meaning && !entry.note && (
              <div className="vocab-detail-none">还没有释义或备注</div>
            )}
          </>
        )}

        <div className="vocab-detail-actions">
          <button
            type="button"
            className="vocab-detail-act vocab-detail-primary"
            disabled={busy}
            onClick={() => onToggle(!entry.learned)}
          >
            {entry.learned ? "标记为待学习" : "标记为已掌握"}
          </button>
          {!editing && (
            <button type="button" className="vocab-detail-act" onClick={() => setEditing(true)}>
              编辑
            </button>
          )}
          <button
            type="button"
            className="vocab-detail-act vocab-detail-danger"
            disabled={busy}
            onClick={onRemove}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

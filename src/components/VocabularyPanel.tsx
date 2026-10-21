/**
 * 单词本面板（右侧「单词」页签）。
 *
 * 数据源是**账户级**单词本（应用配置目录的 vocabulary.md，0.28 起所有仓库
 * 共用一份；格式见 vocabulary.ts）：面板只做读取 → 解析 → 行级变换 → 写回，
 * 文件本身保持用户可手编的普通 Markdown。旧仓库里的 单词本.md 由
 * vocabStore.ts 一次性合并，不再参与读写。
 *
 * 0.24 按用户提示词重做（"轻量的个人单词记忆工具，快速记录 + 快速查词"）：
 *  - 搜索优先：顶部醒目搜索框（英文单词与中文释义实时过滤、回车记入最近搜索、
 *    清除按钮、匹配计数、无结果空态 + 一键收录）；
 *  - 列表卡片：单词为主、释义次级、轻量状态标识，按字母分组 + 字母栏快速定位；
 *  - 点击单词弹轻量详情，没有内容的模块自动隐藏；移动端走底部弹层样式；
 * 0.25 按"个人词汇速查库"规范再打磨（用户 31 节提示词）：
 *  - 添加区默认收起（＋ 添加新单词），展开后回车**自动在线查询释义**（有道词典
 *    免费接口，vocab.rs），成功给"音标 + 释义"预览卡（取消/保存），失败给
 *    「手动填写释义」——不阻止保存；
 *  - 「最近添加」从筛选 Tab 移进排序下拉（最近添加 / 字母 A-Z / 字母 Z-A）；
 *    「打开单词本.md」挪进「···」菜单，搜索行只留搜索框 + 圆形刷新钮；
 *  - 字母分组头从黑块改为"字母 · N 个单词"+ 细分割线；搜索结果扁平展示；
 *  - 空态、触控目标（≥44dp）、Android 返回键消费链（详情→添加→搜索→抽屉）。
 * 刷新时机：仓库切换 / 文件树 revision / 收词或外部改动触发的 version 变化。
 */

import { MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appTextPath, vocabLookup, type VocabLookup } from "../lib/api";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { isMobile } from "../lib/platform";
import {
  addVocabEntry,
  parseVocabulary,
  removeVocabEntry,
  setVocabLearned,
  updateVocabEntry,
  type VocabEntry,
} from "../lib/vocabulary";
import { VOCAB_GLOBAL_FILE, loadVocabularyContent, saveVocabularyContent } from "../lib/vocabStore";

interface Props {
  vault: string | null;
  /** 文件树代际：仓库文件变动（含单词本被手改）时重读。 */
  revision: number;
  /** 单词本代际：收词落盘 / 外部改动单词本时 bump（快捷键收词不经过编辑器）。 */
  version: number;
  notice: (message: string, kind?: "info" | "error") => void;
  /** Android 返回键消费链（App 的 backConsumeRef 在抽屉收起前先问这里）。 */
  backConsumerRef?: MutableRefObject<(() => boolean) | null>;
}

type Filter = "all" | "todo" | "done";
type Sort = "az" | "za" | "recent";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "todo", label: "待学习" },
  { key: "done", label: "已掌握" },
];

const SORTS: Array<{ key: Sort; label: string }> = [
  { key: "recent", label: "最近添加" },
  { key: "az", label: "字母 A-Z" },
  { key: "za", label: "字母 Z-A" },
];

const RECENT_KEY = "quicknote.vocabRecentSearches";
const SORT_KEY = "quicknote.vocabSort";
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

function loadSort(): Sort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    return SORTS.some((item) => item.key === raw) ? (raw as Sort) : "az";
  } catch {
    return "az";
  }
}

/** 词条按查询过滤：空格分段的每一段都要在 词/释义/备注/音标 里出现（大小写不敏感）。 */
function matchEntry(entry: VocabEntry, tokens: string[]): boolean {
  const hay = `${entry.word}\n${entry.meaning}\n${entry.note}\n${entry.phonetic}`.toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

/** meta 开头的 YYYY-MM-DD（「最近添加」排序用；没有日期的排最后）。 */
function addedAt(entry: VocabEntry): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(entry.meta);
  return match ? match[1] : "0000-00-00";
}

/**
 * 系统语音合成可用才显示发音按钮（规范：没有发音资源时不显示无效按钮）。
 * WebView2 自带 en-US 语音；Android WebView 也支持 speechSynthesis。
 */
const SPEECH_OK = typeof window !== "undefined" && "speechSynthesis" in window;

/** 朗读一个单词（列表行、详情、复习卡共用）。失败静默——按钮只在能力存在时渲染。 */
function speakWord(word: string) {
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
  } catch {
    // 语音引擎瞬时不可用就算了
  }
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

/** 添加区的在线查询状态机：折叠 → 输入 → 回车查询（loading）→ 预览/失败。 */
interface LookupState {
  status: "idle" | "loading" | "done" | "failed";
  result: VocabLookup | null;
  /** 查询失败后展开的手动释义输入（不阻止保存）。 */
  manualMeaning: string;
  manualOpen: boolean;
}

/** 快速复习的进行态（0.27 规范 §八：先英文 → 主动看释义 → 认识/不认识 → 进度）。 */
interface ReviewState {
  queue: VocabEntry[];
  index: number;
  revealed: boolean;
  knownCount: number;
}

const LOOKUP_IDLE: LookupState = { status: "idle", result: null, manualMeaning: "", manualOpen: false };

export default function VocabularyPanel({ vault, revision, version, notice, backConsumerRef }: Props) {
  const [entries, setEntries] = useState<VocabEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>(loadSort);
  const [sortOpen, setSortOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [lookup, setLookup] = useState<LookupState>(LOOKUP_IDLE);
  const [busy, setBusy] = useState(false);
  const [detailWord, setDetailWord] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [toast, setToast] = useState<PanelToast | null>(null);
  /** 快速复习：null=没在复习；index 到队尾即完成态（显示战绩与再来一轮）。 */
  const [review, setReview] = useState<ReviewState | null>(null);
  const toastTimer = useRef<number | null>(null);
  const lookupSeq = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * 面板内下拉菜单（排序 / 「···」）渲染后夹回面板可视区。
   * `.vocab-panel` 是 overflow:hidden 的裁剪容器，菜单按 right:0 锚在按钮上、
   * 向左展开，按钮贴近面板右缘时菜单左端会伸出面板被裁掉一条（0.26 用户反馈
   * 的两个"弹窗被切割"截图）。这里量一次实际几何，越界就改写成 left 定位并
   * 挪回界内；上下同理（面板矮时菜单底部也可能被裁）。
   */
  const menuClampRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const panel = panelRef.current;
    if (!panel) return;
    // 先复位再量：同一份 DOM 可能被 React 复用，残留上次的改写会量出假位置
    el.style.right = "0px";
    el.style.left = "";
    el.style.top = "";
    const panelRect = panel.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const margin = 4;
    let dx = 0;
    if (rect.left < panelRect.left + margin) dx = panelRect.left + margin - rect.left;
    if (rect.right + dx > panelRect.right - margin) dx = panelRect.right - margin - rect.right;
    let dy = 0;
    if (rect.bottom > panelRect.bottom - margin) dy = panelRect.bottom - margin - rect.bottom;
    if (dx !== 0) {
      el.style.right = "auto";
      el.style.left = `${el.offsetLeft + dx}px`;
    }
    if (dy !== 0) el.style.top = `${el.offsetTop + dy}px`;
  }, []);

  // 桌面端进入面板即聚焦搜索框（移动端不自动弹键盘，点击再聚焦）
  useEffect(() => {
    if (!isMobile()) searchInputRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    try {
      // 0.28：账户级单词本，所有仓库共用；vault 只用于首次迁移旧文件
      const content = await loadVocabularyContent(vault);
      setEntries(parseVocabulary(content));
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

  // Android 返回键：复习 → 详情 → 添加区（含查询预览）→ 搜索态，都被消费后才轮到抽屉
  useEffect(() => {
    if (!backConsumerRef) return;
    backConsumerRef.current = () => {
      if (review) {
        setReview(null);
        return true;
      }
      if (detailWord) {
        setDetailWord(null);
        return true;
      }
      if (addOpen) {
        setAddOpen(false);
        setDraft("");
        setLookup(LOOKUP_IDLE);
        return true;
      }
      if (query) {
        setQuery("");
        return true;
      }
      return false;
    };
    return () => {
      backConsumerRef.current = null;
    };
  }, [backConsumerRef, review, detailWord, addOpen, query]);

  /** 行级变换的公共骨架：读 → 变换 → 写回 → 刷新列表。 */
  const mutate = useCallback(
    async (transform: (content: string) => string): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      try {
        const content = await loadVocabularyContent(vault);
        const next = transform(content);
        if (next === content) return false;
        await saveVocabularyContent(next);
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

  const tokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );
  const searching = tokens.length > 0;

  /** 落盘一个新词（释义/音标来自在线查询或手动填写）。 */
  const saveWord = useCallback(
    async (word: string, meaning: string, phonetic: string) => {
      setBusy(true);
      try {
        const content = await loadVocabularyContent(vault);
        const result = addVocabEntry(content, word, `${today()} · 手动添加`, meaning, "", phonetic);
        if (!result.added) {
          showToast("这个单词已经添加过了", { label: "查看", run: () => setDetailWord(word) });
          return;
        }
        await saveVocabularyContent(result.content);
        showToast("已添加到待学习");
      } catch (e) {
        notice(`单词本操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        setBusy(false);
        void reload();
      }
    },
    [vault, notice, reload, showToast],
  );

  /** 在线查询释义（免费词典接口）：成功进预览，失败给「手动填写释义」。 */
  const runLookup = useCallback(
    async (raw: string) => {
      const word = raw.trim();
      if (!word) return;
      const seq = ++lookupSeq.current;
      setLookup({ status: "loading", result: null, manualMeaning: "", manualOpen: false });
      try {
        const result = await vocabLookup(word);
        if (lookupSeq.current !== seq) return; // 连续查询：只认最后一次
        setLookup({ status: "done", result, manualMeaning: "", manualOpen: false });
      } catch {
        if (lookupSeq.current !== seq) return;
        setLookup({
          status: "failed",
          result: null,
          manualMeaning: "",
          manualOpen: false,
        });
        // 失败原因（网络/未收录）在预览卡里用统一文案，不打断添加
      }
    },
    [],
  );

  /** 添加区回车：先在线查询，不让用户手写翻译。词统一转小写（0.26 用户反馈）。 */
  const submitDraft = useCallback(() => {
    if (!draft.trim() || lookup.status === "loading") return;
    void runLookup(draft.trim().toLowerCase());
  }, [draft, lookup.status, runLookup]);

  const closeAdd = useCallback(() => {
    setAddOpen(false);
    setDraft("");
    setLookup(LOOKUP_IDLE);
  }, []);

  const confirmSave = useCallback(() => {
    // 落盘同样用小写（0.26 用户反馈"统一成小写"）：查询与保存同源，不会出现
    // 预览的是 Scenario、存的是 scenario 的错位
    const word = draft.trim().toLowerCase();
    if (!word) return;
    const meaning = lookup.result?.meaning ?? lookup.manualMeaning.trim();
    const phonetic = lookup.result?.phonetic ?? "";
    void saveWord(word, meaning, phonetic);
    closeAdd();
    // 从「搜索无结果 → 收录」进来的保存：清掉搜索词，让新词直接出现在列表里
    if (searching && query.trim().toLowerCase() === word.toLowerCase()) setQuery("");
  }, [draft, lookup, saveWord, closeAdd, searching, query]);

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

  const visible = useMemo(() => {
    let list = entries;
    if (searching) list = list.filter((entry) => matchEntry(entry, tokens));
    if (filter === "todo") list = list.filter((entry) => !entry.learned);
    else if (filter === "done") list = list.filter((entry) => entry.learned);
    if (sort === "recent") {
      return [...list].sort(
        (a, b) => addedAt(b).localeCompare(addedAt(a)) || b.line - a.line,
      );
    }
    const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });
    return [...list].sort((a, b) =>
      sort === "za" ? collator.compare(b.word, a.word) : collator.compare(a.word, b.word),
    );
  }, [entries, searching, tokens, filter, sort]);

  /** 字母分组（「最近添加」排序与搜索结果是纯列表，不分组）。 */
  const grouped = !searching && sort !== "recent";
  const groups = useMemo(() => {
    if (!grouped) return [{ key: "", items: visible }];
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
  }, [visible, grouped]);

  const detail = useMemo(
    () => (detailWord ? entries.find((entry) => entry.word.toLowerCase() === detailWord.toLowerCase()) ?? null : null),
    [detailWord, entries],
  );

  // 详情/复习开着时 Esc 只关最上层（捕获阶段拦下，不透传给其他 Esc 链）
  useEffect(() => {
    if (!detailWord && !review) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (review) setReview(null);
      else setDetailWord(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [detailWord, review]);

  // 「···」/排序下拉：点外面就收起（面板内轻量菜单，不值得引 popper）
  useEffect(() => {
    if (!sortOpen && !moreOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".vocab-menu-wrap")) {
        setSortOpen(false);
        setMoreOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [sortOpen, moreOpen]);

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

  /** 详情里的「查询在线释义」：收词快捷键进来的词往往只有词本身。 */
  const fillDetailMeaning = useCallback(
    async (entry: VocabEntry) => {
      try {
        const result = await vocabLookup(entry.word);
        const ok = await mutate((content) =>
          updateVocabEntry(content, entry.word, {
            meaning: result.meaning || entry.meaning,
            phonetic: result.phonetic || entry.phonetic,
          }).content,
        );
        if (ok) showToast(`已填入「${entry.word}」的在线释义`);
      } catch (e) {
        notice(e instanceof Error ? e.message : String(e), "info");
      }
    },
    [mutate, notice, showToast],
  );

  const todoCount = useMemo(() => entries.filter((entry) => !entry.learned).length, [entries]);

  /**
   * 开始快速复习（0.27 规范 §八的轻量版）：从「待学习」里取队列，先只显示英文，
   * 用户主动翻开释义后再自评。顺序取「最近添加优先」——新词最需要过一遍；
   * 不引入间隔重复算法，不改数据结构，只复用 setVocabLearned。
   */
  const startReview = useCallback(() => {
    const queue = [...entries]
      .filter((entry) => !entry.learned)
      .sort((a, b) => addedAt(b).localeCompare(addedAt(a)) || b.line - a.line);
    if (queue.length === 0) {
      showToast("没有待学习的单词");
      return;
    }
    setReview({ queue, index: 0, revealed: false, knownCount: 0 });
  }, [entries, showToast]);

  /** 复习作答：认识 → 落为已掌握；不认识 → 留在待学习。推进队列，到尾进完成态。 */
  const reviewAnswer = useCallback(
    (known: boolean) => {
      if (!review || review.index >= review.queue.length) return;
      const entry = review.queue[review.index];
      if (known) void mutate((content) => setVocabLearned(content, entry.word, true).content);
      setReview({
        ...review,
        index: review.index + 1,
        revealed: false,
        knownCount: review.knownCount + (known ? 1 : 0),
      });
    },
    [review, mutate],
  );

  if (!vault) {
    return <div className="vocab-panel vocab-empty">打开仓库后可使用单词本。</div>;
  }

  const searchEmpty = searching && visible.length === 0;

  return (
    <div className="vocab-panel" ref={panelRef}>
      {/* 标题与总数（规范 §三.1），右侧是快速复习入口（§三.6：待学习有词才可点） */}
      <div className="vocab-head">
        <span className="vocab-head-title">单词本</span>
        <span className="vocab-head-count">{entries.length} 个单词</span>
        <button
          type="button"
          className="vocab-review-btn"
          disabled={todoCount === 0}
          title={todoCount === 0 ? "没有待学习的单词" : `复习 ${todoCount} 个待学习单词`}
          onClick={startReview}
        >
          开始复习{todoCount > 0 ? `（${todoCount}）` : ""}
        </button>
      </div>

      {/* 搜索优先：顶部主搜索框（英文单词/中文释义/音标都能搜，实时过滤）。
          「打开单词本.md」不在这里——它不是查词动作，挪进「···」菜单。 */}
      <div className="vocab-search-row">
        <div className="vocab-search">
          <span className="vocab-search-icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7"></circle>
              <line x1="21" y1="21" x2="16.5" y2="16.5"></line>
            </svg>
          </span>
          <input
            ref={searchInputRef}
            type="text"
            className="vocab-search-input"
            placeholder="搜索单词、释义..."
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
        </div>
        <button
          type="button"
          className="vocab-refresh"
          title="重新读取单词本"
          aria-label="重新读取单词本"
          onClick={() => void reload()}
        >
          ⟳
        </button>
      </div>

      {/* 添加区默认收起：一个小按钮，不跟搜索框抢视觉。展开后回车自动查询释义。 */}
      {!addOpen ? (
        <button type="button" className="vocab-add-toggle" onClick={() => setAddOpen(true)}>
          ＋ 添加新单词
        </button>
      ) : (
        <div className="vocab-add">
          <div className="vocab-add-row">
            <input
              ref={addInputRef}
              type="text"
              className="vocab-add-input"
              placeholder="输入单词，例如 scenario"
              value={draft}
              spellCheck={false}
              enterKeyHint="done"
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitDraft();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closeAdd();
                }
              }}
            />
            <button
              type="button"
              className="vocab-add-btn"
              disabled={busy || !draft.trim() || lookup.status === "loading"}
              onClick={submitDraft}
            >
              查询
            </button>
          </div>

          {lookup.status === "loading" && (
            <div className="vocab-lookup vocab-lookup-loading">正在查询在线释义…</div>
          )}

          {lookup.status === "done" && lookup.result && (
            <div className="vocab-lookup">
              <div className="vocab-lookup-word">
                {lookup.result.word}
                {lookup.result.phonetic && (
                  <span className="vocab-lookup-phonetic">{lookup.result.phonetic}</span>
                )}
              </div>
              {lookup.result.meaning ? (
                <div className="vocab-lookup-meaning">{lookup.result.meaning}</div>
              ) : (
                <div className="vocab-lookup-none">词典里没有收录释义</div>
              )}
              <div className="vocab-lookup-actions">
                <button type="button" className="vocab-btn" onClick={closeAdd}>
                  取消
                </button>
                <button type="button" className="vocab-btn vocab-btn-primary" disabled={busy} onClick={confirmSave}>
                  保存
                </button>
              </div>
            </div>
          )}

          {lookup.status === "failed" && (
            <div className="vocab-lookup">
              <div className="vocab-lookup-none">未找到在线释义</div>
              {lookup.manualOpen ? (
                <input
                  type="text"
                  className="vocab-add-input"
                  placeholder="手动填写释义（可留空，之后再补）"
                  value={lookup.manualMeaning}
                  spellCheck={false}
                  autoFocus
                  onChange={(event) => setLookup((prev) => ({ ...prev, manualMeaning: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      confirmSave();
                    }
                  }}
                />
              ) : (
                <div className="vocab-lookup-actions">
                  <button
                    type="button"
                    className="vocab-btn"
                    onClick={() => setLookup((prev) => ({ ...prev, manualOpen: true }))}
                  >
                    手动填写释义
                  </button>
                </div>
              )}
              {lookup.manualOpen && (
                <div className="vocab-lookup-actions">
                  <button type="button" className="vocab-btn" onClick={closeAdd}>
                    取消
                  </button>
                  <button type="button" className="vocab-btn vocab-btn-primary" disabled={busy} onClick={confirmSave}>
                    保存
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

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

      {/* 快捷筛选（状态）+ 排序 + 「···」：最近添加不是状态，是排序方式 */}
      <div className="vocab-toolbar">
        <div className="vocab-filters" role="tablist" aria-label="单词筛选">
          {FILTERS.map((item) => {
            const count =
              item.key === "all"
                ? entries.length
                : item.key === "todo"
                  ? entries.filter((entry) => !entry.learned).length
                  : entries.filter((entry) => entry.learned).length;
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
                <span className="vocab-filter-count">{count}</span>
              </button>
            );
          })}
        </div>
        <span className="vocab-toolbar-spacer" />
        <div className="vocab-menu-wrap">
          <button
            type="button"
            className="vocab-toolbar-btn"
            aria-haspopup="listbox"
            aria-expanded={sortOpen}
            onClick={() => {
              setSortOpen((prev) => !prev);
              setMoreOpen(false);
            }}
          >
            {SORTS.find((item) => item.key === sort)?.label} ▾
          </button>
          {sortOpen && (
            <div className="vocab-menu" role="listbox" aria-label="排序方式" ref={menuClampRef}>
              {SORTS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={sort === item.key}
                  className={`vocab-menu-item${sort === item.key ? " is-on" : ""}`}
                  onClick={() => {
                    setSort(item.key);
                    setSortOpen(false);
                    try {
                      localStorage.setItem(SORT_KEY, item.key);
                    } catch {
                      // 存不上就下次回到默认
                    }
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="vocab-menu-wrap">
          <button
            type="button"
            className="vocab-toolbar-btn vocab-more-btn"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="更多操作"
            onClick={() => {
              setMoreOpen((prev) => !prev);
              setSortOpen(false);
            }}
          >
            ···
          </button>
          {moreOpen && (
            <div className="vocab-menu vocab-menu-right" role="menu" ref={menuClampRef}>
              {!isMobile() && (
                <button
                  type="button"
                  className="vocab-menu-item"
                  role="menuitem"
                  onClick={async () => {
                    setMoreOpen(false);
                    try {
                      // 单词本已不在仓库里（账户级文件），给「在文件夹中显示」而不是打开笔记
                      const path = await appTextPath(VOCAB_GLOBAL_FILE);
                      await revealItemInDir(path);
                    } catch (e) {
                      notice(`打开单词本位置失败：${e instanceof Error ? e.message : String(e)}`, "error");
                    }
                  }}
                  title="单词本存在本机应用数据目录，所有仓库共用"
                >
                  在文件夹中显示单词本
                </button>
              )}
              <button
                type="button"
                className="vocab-menu-item"
                role="menuitem"
                disabled={recent.length === 0}
                onClick={() => {
                  setMoreOpen(false);
                  setRecent([]);
                  try {
                    localStorage.removeItem(RECENT_KEY);
                  } catch {
                    // 尽力而为
                  }
                }}
              >
                清除最近搜索
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 搜索结果头（规范：搜索结果 · N） */}
      {searching && (
        <div className="vocab-count-line">
          {visible.length > 0 ? `搜索结果 · ${visible.length}` : "没有找到相关单词"}
        </div>
      )}

      {/* 无结果空态：先给排查建议，再给一键收录 */}
      {searchEmpty ? (
        <div className="vocab-empty-search">
          <span className="vocab-empty-icon" aria-hidden>🔍</span>
          <p>没有找到相关单词</p>
          <div className="vocab-empty-tips">
            可以尝试：检查拼写 · 搜索中文释义 · 只输入部分单词
          </div>
          <button
            type="button"
            className="vocab-btn"
            onClick={() => {
              // 收录 = 展开添加区并带入搜索词，直接走在线查询预览
              setAddOpen(true);
              setDraft(query.trim());
              void runLookup(query);
            }}
          >
            收录「{query.trim()}」并查询释义
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="vocab-empty-list">
          <span className="vocab-empty-icon" aria-hidden>✦</span>
          <p>还没有记录单词</p>
          <div className="vocab-empty-tips">
            在笔记里选中一个词按 <kbd>Ctrl+Alt+V</kbd>，或输入一个单词开始记录。
            单词本按账户共用一份（所有仓库共享，存本机），随时可手改。
          </div>
          <button
            type="button"
            className="vocab-btn vocab-btn-primary"
            onClick={() => setAddOpen(true)}
          >
            ＋ 添加单词
          </button>
        </div>
      ) : (
        <div className="vocab-list" ref={listRef}>
          {groups.map((group) => (
            <div key={group.key || "flat"} className="vocab-group" data-group={group.key}>
              {group.key && (
                <div className="vocab-group-letter">
                  <span>{group.key}</span>
                  <span className="vocab-group-count">· {group.items.length} 个单词</span>
                </div>
              )}
              {group.items.map((entry) => (
                <div
                  key={`${entry.line}-${entry.word}`}
                  className={`vocab-item${entry.learned ? " is-learned" : ""}`}
                  onClick={() => setDetailWord(entry.word)}
                >
                  {/* 第一行：英文单词（视觉主体）+ 学习状态标签（点击即切换，规范 §七） */}
                  <div className="vocab-item-line1">
                    <span className="vocab-item-word">{entry.word}</span>
                    <button
                      type="button"
                      className={`vocab-status vocab-status-btn${entry.learned ? " is-learned" : ""}`}
                      title={entry.learned ? "移回待学习" : "标记为已掌握"}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleLearned(entry, !entry.learned);
                      }}
                    >
                      <span className="vocab-status-dot" aria-hidden>{entry.learned ? "✓" : "●"}</span>
                      {entry.learned ? "已掌握" : "待学习"}
                    </button>
                  </div>
                  {/* 第二行：音标 + 发音按钮（系统没有语音合成就整行不渲染，规范 §四） */}
                  {(entry.phonetic || SPEECH_OK) && (
                    <div className="vocab-item-line2">
                      {entry.phonetic && <span className="vocab-item-phonetic">{entry.phonetic}</span>}
                      {SPEECH_OK && (
                        <button
                          type="button"
                          className="vocab-item-speak"
                          title={`朗读 ${entry.word}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            speakWord(entry.word);
                          }}
                        >
                          🔊
                        </button>
                      )}
                    </div>
                  )}
                  {/* 第三行：简短释义；没有就省略整行（条目高度允许不一致，规范 §四） */}
                  {entry.meaning && <div className="vocab-item-meaning">{entry.meaning}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* 字母快速定位栏（列出实际存在的分组；搜索态没有分组） */}
      {grouped && groups.length > 1 && (
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

      {review && (
        <VocabReview
          review={review}
          onReveal={() => setReview((prev) => (prev ? { ...prev, revealed: true } : prev))}
          onAnswer={reviewAnswer}
          onClose={() => setReview(null)}
          onRestart={startReview}
        />
      )}

      {detail && (
        <VocabDetail
          entry={detail}
          busy={busy}
          onClose={() => setDetailWord(null)}
          onToggle={(learned) => void toggleLearned(detail, learned)}
          onRemove={() => void removeWord(detail)}
          onSave={(meaning, note, phonetic) =>
            void mutate((content) =>
              updateVocabEntry(content, detail.word, { meaning, note, phonetic }).content,
            )
          }
          onLookup={() => void fillDetailMeaning(detail)}
        />
      )}
    </div>
  );
}

/**
 * 快速复习卡（0.27 规范 §八的轻量流程）：先英文 → 「显示释义」→ 认识/不认识。
 * 认识 = 落为已掌握；不认识 = 留在待学习。完成后给战绩与「再复习一轮」
 * （用当前仍待学习的词重建队列）。样式复用详情弹层（桌面居中/移动端底部）。
 */
function VocabReview({
  review,
  onReveal,
  onAnswer,
  onClose,
  onRestart,
}: {
  review: ReviewState;
  onReveal: () => void;
  onAnswer: (known: boolean) => void;
  onClose: () => void;
  onRestart: () => void;
}) {
  const done = review.index >= review.queue.length;
  const entry = done ? null : review.queue[review.index];
  return (
    <div
      className="vocab-detail-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="vocab-detail vocab-review" role="dialog" aria-label="快速复习">
        {done || !entry ? (
          <div className="vocab-review-done">
            <span className="vocab-empty-icon" aria-hidden>✦</span>
            <p className="vocab-review-done-title">复习完成</p>
            <p className="vocab-review-done-stats">
              认识 {review.knownCount} · 不认识 {review.queue.length - review.knownCount} · 共 {review.queue.length}
            </p>
            <div className="vocab-detail-actions">
              <button type="button" className="vocab-detail-act" onClick={onRestart}>
                再复习一轮
              </button>
              <button type="button" className="vocab-detail-act vocab-detail-primary" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="vocab-review-progress">
              <span className="vocab-review-count">
                {review.index + 1} / {review.queue.length}
              </span>
              <div className="vocab-review-bar" aria-hidden>
                <div
                  className="vocab-review-bar-fill"
                  style={{ width: `${Math.round((review.index / review.queue.length) * 100)}%` }}
                />
              </div>
              <button type="button" className="vocab-detail-close" title="结束复习（Esc）" onClick={onClose}>
                ×
              </button>
            </div>
            <div className="vocab-review-word">
              {entry.word}
              {SPEECH_OK && (
                <button
                  type="button"
                  className="vocab-detail-speak"
                  title={`朗读 ${entry.word}`}
                  onClick={() => speakWord(entry.word)}
                >
                  🔊
                </button>
              )}
            </div>
            {review.revealed ? (
              <div className="vocab-review-answer">
                {entry.phonetic && <div className="vocab-detail-phonetic">{entry.phonetic}</div>}
                {entry.meaning ? (
                  <div className="vocab-review-meaning">{entry.meaning}</div>
                ) : (
                  <div className="vocab-detail-none">这条还没有释义（可在详情里补在线释义）</div>
                )}
                {entry.note && <div className="vocab-detail-note">{entry.note}</div>}
              </div>
            ) : (
              <button type="button" className="vocab-btn vocab-review-reveal" onClick={onReveal}>
                显示释义
              </button>
            )}
            <div className="vocab-detail-actions">
              <button type="button" className="vocab-detail-act vocab-review-no" onClick={() => onAnswer(false)}>
                不认识
              </button>
              <button type="button" className="vocab-detail-act vocab-detail-primary" onClick={() => onAnswer(true)}>
                认识
              </button>
            </div>
          </>
        )}
      </div>
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
  onLookup,
}: {
  entry: VocabEntry;
  busy: boolean;
  onClose: () => void;
  onToggle: (learned: boolean) => void;
  onRemove: () => void;
  onSave: (meaning: string, note: string, phonetic: string) => void;
  onLookup: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [meaning, setMeaning] = useState(entry.meaning);
  const [note, setNote] = useState(entry.note);
  const [phonetic, setPhonetic] = useState(entry.phonetic);

  // 换词（含条目被更新后的重挂载）时重置编辑态
  useEffect(() => {
    setEditing(false);
    setMeaning(entry.meaning);
    setNote(entry.note);
    setPhonetic(entry.phonetic);
  }, [entry.word, entry.meaning, entry.note, entry.phonetic]);

  const canSpeak = SPEECH_OK;
  const speak = () => speakWord(entry.word);

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
            <span className="vocab-status-dot" aria-hidden>{entry.learned ? "✓" : "●"}</span>
            {entry.learned ? "已掌握" : "待学习"}
          </span>
          <button type="button" className="vocab-detail-close" title="关闭（Esc）" onClick={onClose}>
            ×
          </button>
        </div>

        {(entry.phonetic || entry.meaning) && (
          <div className="vocab-detail-phonetic">{entry.phonetic}</div>
        )}
        {entry.meta && <div className="vocab-detail-meta">{entry.meta}</div>}

        {editing ? (
          <div className="vocab-detail-edit">
            <label>
              音标
              <input
                type="text"
                value={phonetic}
                placeholder="/sɪˈnɑːriəʊ/"
                spellCheck={false}
                onChange={(event) => setPhonetic(event.target.value)}
              />
            </label>
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
                  onSave(meaning, note, phonetic);
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
            {!entry.meaning && !entry.note && !entry.phonetic && (
              <div className="vocab-detail-none">
                还没有释义或备注
                <button type="button" className="vocab-btn" disabled={busy} onClick={onLookup}>
                  查询在线释义
                </button>
              </div>
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
            {entry.learned ? "重新学习" : "已掌握"}
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

/**
 * 全局命令面板（Ctrl+K）：搜索笔记、全文检索内容、触发快捷操作。
 *
 * 三类结果合一列表，方向键上下、回车执行：
 *   1. 快捷操作 —— 新建/保存/切换模式等，来自调用方注入（App 持有这些回调）；
 *   2. 笔记 —— 按文件名即时过滤（entries 已在内存里，零开销）；
 *   3. 内容 —— Rust 侧 `search_vault` 全文扫描，防抖 250ms，取每个文件的首个命中行，
 *      回车直接打开并跳到那一行。
 *
 * 0.29 起内容检索覆盖**账户下的所有已知仓库**（当前仓库 + 最近仓库，0.24 反馈
 * 「全局搜索，支持搜索账户下的所有仓库」）：当前仓库的结果排最前，其他仓库的
 * 命中右侧标注仓库名；回车打开别的仓库的命中会先切仓库再开笔记。其他仓库的
 * 条目列表（笔记名匹配用）在面板打开时拉一次，不跟着每次击键重复扫盘。
 *
 * 「笔记」（标题命中）与「内容」（全文命中）两组**独立展示、互不去重**——
 * 0.30 用户反馈：标题命中的文件此前在「内容」组被压掉，少了命中行摘要与
 * 悬停预览，找文件反而要来回换着看两组。
 *
 * 面板是纯展示组件：开关由 App 控制，这样顶栏的搜索框、快捷键、Esc 都能收拢在一处。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { listEntries, readNoteOptional, searchVault, type EntryMeta, type SearchFileHit } from "../lib/api";
import { fieldVariants } from "../lib/searchVariants";

export interface PaletteAction {
  id: string;
  title: string;
  /** 参与搜索匹配的附加词（说明文字、命令 id 等）；标题始终参与匹配。 */
  keywords?: string[];
  /** 标题下方的弱化说明（命令 desc 等）。 */
  detail?: string;
  /** 快捷键提示（右侧灰字）。 */
  hint?: string;
  icon: string;
  run: () => void;
}

interface Item {
  key: string;
  group: string;
  /** 组名右侧的计数徽标（「内容 · 显示 60 / 共 120 条」），只挂在组内第一条上。 */
  groupBadge?: string;
  icon: string;
  title: string;
  /** 命中行摘要（内容搜索结果）。 */
  detail?: string;
  /** 右侧弱化信息（修改时间等）。 */
  meta?: string;
  hint?: string;
  run: () => void;
  /** 内容命中的原始数据（悬停预览用）；其他组为空。 */
  hit?: PaletteHit;
}

/** 内容命中（按文件聚合，带来源仓库）：悬停预览与跨仓库打开都需要它。 */
export interface PaletteHit extends SearchFileHit {
  /** 命中来自哪个仓库（绝对路径）；当前仓库命中与 vault prop 相同。 */
  vault: string;
}

/** 悬停预览卡展示的上下文（命中行 ±4 行）。 */
interface HoverPreview {
  path: string;
  line: number;
  lines: { no: number; text: string }[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  entries: EntryMeta[];
  vault: string | null;
  /** 账户下参与搜索的全部仓库（当前仓库第一；0.29 多仓库检索）。 */
  vaults: string[];
  /** term 一起带回：打开笔记后用它高亮关键词（0.21 用户反馈）。 */
  onOpenNote: (path: string, line?: number, term?: string) => void;
  /** 打开**其他仓库**的命中：先切仓库再开笔记（0.29 多仓库检索）。 */
  onOpenNoteInVault: (vault: string, path: string, line?: number, term?: string) => void;
  actions: PaletteAction[];
  /** 「内容」结果悬停预览（设置 → 通用 → 搜索，0.21 用户反馈）。 */
  hoverPreview: boolean;
  /** 打开面板时带入的初始搜索词（编辑器选中文本，0.34.2 用户反馈）。 */
  seed?: string;
  /** 「内容」组一次展示的文件数（设置项，0.34.3；滚到底自动追加下一页）。 */
  contentLimit: number;
}

const SEARCH_DEBOUNCE = 250;
const NAME_LIMIT = 8;
/**
 * 「内容」组的展示上限走设置项 `paletteContentLimit`（0.34.3 用户需求：默认
 * 60、可调 20–300，滚到底部自动追加下一页；键盘走到页尾也预扩一页）。0.32
 * 起在组名上标「显示 x / 共 y 个文件」，截断与否一眼可见。
 */
/** 内容检索的分仓限额（按文件计）：当前仓库多给，其他仓库每仓少给，防大库拖慢一轮搜索。 */
const CONTENT_LIMIT_CURRENT = 150;
const CONTENT_LIMIT_OTHER = 50;
/** 其他仓库笔记名命中合计上限。 */
const NAME_LIMIT_OTHER = 8;
/** 参与搜索的仓库总数上限（最近仓库列表本身 ≤8，加上当前仓库天然封顶）。 */
const MAX_SEARCH_VAULTS = 9;
/** 上一次搜索词的落盘键（0.23 用户反馈：每次打开都要重新输入太麻烦）。 */
const LAST_QUERY_KEY = "quicknote.palette.query";

function loadLastQuery(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(LAST_QUERY_KEY) ?? "";
  } catch {
    return "";
  }
}

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

export default function CommandPalette({
  open,
  onClose,
  entries,
  vault,
  vaults,
  onOpenNote,
  onOpenNoteInVault,
  actions,
  hoverPreview,
  seed,
  contentLimit,
}: Props) {
  // 保留上一次的搜索词（会话内不重置，跨重启落盘 localStorage）。打开时全选
  // 文本：直接输入即替换，想接着改也可以光标挪过去。
  const [query, setQuery] = useState(loadLastQuery);
  const [active, setActive] = useState(0);
  const limit = Math.max(10, contentLimit);
  /** 已展示的文件行数：滚到底部/键盘走到页尾各追加一页（0.34.3）。 */
  const [shownCount, setShownCount] = useState(limit);
  const [contentHits, setContentHits] = useState<PaletteHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<HoverPreview | null>(null);
  /** 其他仓库的条目（笔记名匹配用）：面板打开时拉一次，不跟击键走。 */
  const [otherEntries, setOtherEntries] = useState<Record<string, EntryMeta[]>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 只用于让过期的异步搜索结果作废。 */
  const searchSeq = useRef(0);
  /** 悬停预览的防抖计时与过期序号（同一机制）。 */
  const previewTimer = useRef<number | null>(null);
  const previewSeq = useRef(0);
  /** 鼠标离开结果列表后预览卡的宽限期：正在移向预览卡的路上不立即撤掉。 */
  const leaveTimer = useRef<number | null>(null);

  /** 当前仓库之外的搜索范围（顺序 = vaults 顺序，即最近仓库的新旧序）。 */
  const otherVaults = useMemo(
    () => vaults.filter((item) => item !== vault).slice(0, MAX_SEARCH_VAULTS - 1),
    [vaults, vault],
  );

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  /** 原始大小写的首个词：跳转预填搜索面板时用它高亮——面板按原文预填，
   *  传小写化后的 terms[0] 会把面板输入框也变成小写（0.22 批测发现）。 */
  const rawFirstTerm = useMemo(() => query.trim().split(/\s+/).filter(Boolean)[0] ?? "", [query]);
  /** 高亮词表：搜索词之外补上字段变体（user_name ↔ userName），命中行里哪种
   *  形态都能亮出来（0.23 用户反馈）。 */
  const highlightTerms = useMemo(() => {
    const rawWords = query.trim().split(/\s+/).filter(Boolean);
    const set = new Set<string>([...terms, ...rawWords.flatMap((word) => fieldVariants(word).map((v) => v.toLowerCase()))]);
    return [...set];
  }, [query, terms]);

  // 上限设置变化或新一轮结果到达：分页位置归零
  useEffect(() => {
    setShownCount(limit);
  }, [limit, contentHits]);

  // 打开时聚焦；关闭时清掉残留的悬停预览。搜索词按上面的策略保留。
  // 0.34.2 用户反馈「选中内容后再打开全局搜索自动搜索选中内容」：编辑器里有
  // 选中文本时把第一个非空行（≤80 字）带进搜索框。setQuery 在 RAF 聚焦前提交，
  // 聚焦后的 select() 选中的就是种子词——直接打字即替换。
  useEffect(() => {
    if (open) {
      if (seed) setQuery(seed);
      setActive(0);
      setSearching(false);
      setPreview(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        if (input.value) input.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      try {
        if (query) localStorage.setItem(LAST_QUERY_KEY, query);
        else localStorage.removeItem(LAST_QUERY_KEY);
      } catch {
        // 存不进去只影响下次启动
      }
    }
  }, [query]);

  // 关闭/查询变化时撤销悬停预览
  useEffect(() => {
    setPreview(null);
  }, [terms, open, hoverPreview]);

  // 其他仓库的条目列表：面板打开时拉一次（笔记名匹配用）。拉不到的仓库按空处理，
  // 不拖垮搜索。
  useEffect(() => {
    if (!open || otherVaults.length === 0) {
      setOtherEntries({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      otherVaults.map(async (item) => [item, await listEntries(item).catch(() => [] as EntryMeta[])] as const),
    ).then((pairs) => {
      if (cancelled) return;
      setOtherEntries(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [open, otherVaults]);

  // 全文搜索防抖（当前仓库 + 其他仓库并发）；名称过滤是同步的，不在这里
  useEffect(() => {
    if (!open || !vault || terms.length === 0) {
      setContentHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      const seq = (searchSeq.current += 1);
      // 传**原始大小写**的查询：Rust 侧自己小写化，但字段变体（userName ↔
      // user_name）要在原始大小写上找驼峰边界，提前小写化就丢了
      const current = searchVault(vault, query.trim(), CONTENT_LIMIT_CURRENT)
        .then((hits) => hits.map((hit) => ({ ...hit, vault })));
      const others = Promise.all(
        otherVaults.map(async (item) => {
          const hits = await searchVault(item, query.trim(), CONTENT_LIMIT_OTHER).catch(() => []);
          return hits.map((hit) => ({ ...hit, vault: item }));
        }),
      );
      Promise.all([current, others])
        .then(([currentHits, otherHits]) => {
          if (searchSeq.current !== seq) return;
          // 当前仓库的结果排最前（0.29 用户反馈），其余按最近仓库的新旧序接在后面
          setContentHits([...currentHits, ...otherHits.flat()]);
        })
        .catch(() => {
          if (searchSeq.current === seq) setContentHits([]);
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, SEARCH_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [open, vault, otherVaults, terms, query]);

  // 展示顺序：其他仓库有命中时，当前仓库首页最多占一半（0.34.2 用户反馈
  // 「搜其他库只搜到文件名」——常见字命中会把其他仓库挤出一整页），其余的
  // 当前仓库命中排到后续分页；其他仓库没有命中时不压缩当前仓库。
  const displayOrder = useMemo(() => {
    if (!vault) return contentHits;
    const currentRows = contentHits.filter((hit) => hit.vault === vault);
    const otherRows = contentHits.filter((hit) => hit.vault !== vault);
    if (otherRows.length === 0) return contentHits;
    const cap = Math.floor(limit / 2);
    return [...currentRows.slice(0, cap), ...otherRows, ...currentRows.slice(cap)];
  }, [contentHits, vault, limit]);

  // 滚到底部自动追加下一页（0.34.3 用户需求）
  const onListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
      setShownCount((value) => Math.min(value + limit, displayOrder.length));
    }
  };

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const out: Item[] = [];

    const actionPool = terms.length
      ? actions.filter((action) => {
          const q = query.trim().toLowerCase();
          if (action.title.toLowerCase().includes(q)) return true;
          return (action.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(q));
        })
      : actions;
    for (const action of actionPool) {
      out.push({
        key: `action-${action.id}`,
        group: "快捷操作",
        icon: action.icon,
        title: action.title,
        detail: action.detail,
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

      // 其他仓库的笔记名命中（0.29 多仓库检索）：排在当前仓库之后，
      // meta 直接标注仓库名，回车先切仓库再打开
      const otherNotes: Item[] = [];
      for (const item of otherVaults) {
        const vaultBase = item.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || item;
        for (const note of otherEntries[item] ?? []) {
          if (note.isDir || !note.name.toLowerCase().endsWith(".md")) continue;
          if (!nameHits(note.name, terms)) continue;
          otherNotes.push({
            key: `note-v-${item}-${note.path}`,
            group: "笔记",
            icon: "📄",
            title: note.name,
            detail: note.path,
            meta: vaultBase,
            run: () => onOpenNoteInVault(item, note.path),
          });
        }
      }
      for (const item of otherNotes
        .sort((a, b) => a.key.localeCompare(b.key))
        .slice(0, NAME_LIMIT_OTHER)) {
        out.push(item);
      }

      // 0.30 用户反馈：标题命中的文件在「内容」组也要列出（此前为去重被压掉，
      // 结果只有标题行能看，少了命中行摘要与悬停预览）。两组各自独立展示。
      // 0.34.2 用户反馈：同一文件只出现一次（此前逐条命中刷屏），完整命中数
      // 放 meta，点击打开笔记并预填文件内搜索——所有命中在笔记里高亮可跳。
      // 展示顺序见 displayOrder（其他仓库有命中时当前仓库首页占一半）。
      const shown = displayOrder.slice(0, shownCount);
      const truncated = displayOrder.length > shown.length;
      const totalHits = contentHits.reduce((sum, hit) => sum + hit.count, 0);
      const totalHitsLabel = totalHits > 999 ? "999+" : String(totalHits);
      shown.forEach((hit) => {
        const otherVault = hit.vault !== vault;
        const vaultBase = hit.vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || hit.vault;
        const first = hit.samples[0];
        out.push({
          key: `hit-${hit.vault}-${hit.path}`,
          group: "内容",
          groupBadge: truncated
            ? `显示 ${shown.length} / 共 ${contentHits.length}+ 个文件 · ${totalHitsLabel} 处`
            : `${contentHits.length} 个文件 · ${totalHitsLabel} 处`,
          icon: otherVault ? "🗂️" : "🔎",
          title: hit.path.slice(hit.path.lastIndexOf("/") + 1),
          detail: first?.text.trim() ?? "",
          meta: `${otherVault ? `${vaultBase} · ` : ""}${hit.count} 处`,
          // 带回首个关键词：打开后预填搜索面板高亮全文命中（0.21 用户反馈）
          run: otherVault
            ? () => onOpenNoteInVault(hit.vault, hit.path, first?.line, rawFirstTerm)
            : () => onOpenNote(hit.path, first?.line, rawFirstTerm),
          hit,
        });
      });
    }

    return out;
  }, [
    open,
    actions,
    actions.length,
    entries,
    terms,
    query,
    rawFirstTerm,
    contentHits,
    displayOrder,
    shownCount,
    otherVaults,
    otherEntries,
    vault,
    onOpenNote,
    onOpenNoteInVault,
  ]);

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

  /** 悬停「内容」结果 300ms 后加载上下文预览；移开/悬到别组立即撤销。 */
  const hoverContentHit = (hit: PaletteHit | null) => {
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    cancelLeaveGrace();
    previewSeq.current += 1;
    if (!hit || !hoverPreview || !vault) {
      setPreview(null);
      return;
    }
    const seq = previewSeq.current;
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      // 0.29 多仓库检索：按命中自己的仓库读（其他仓库的命中也能预览）
      readNoteOptional(hit.vault ?? vault ?? "", hit.path)
        .then((note) => {
          if (seq !== previewSeq.current) return;
          if (!note) {
            setPreview(null);
            return;
          }
          const all = note.content.split(/\r?\n/);
          // 预览以第一条命中样本为中心（0.34.2 起命中按文件聚合）
          const center = Math.min(Math.max(hit.samples[0]?.line ?? 0, 0), all.length - 1);
          const from = Math.max(0, center - 4);
          const to = Math.min(all.length - 1, center + 4);
          const lines: { no: number; text: string }[] = [];
          for (let index = from; index <= to; index += 1) {
            lines.push({ no: index + 1, text: all[index] ?? "" });
          }
          setPreview({ path: hit.path, line: center, lines });
        })
        .catch(() => {
          if (seq === previewSeq.current) setPreview(null);
        });
    }, 300);
  };

  /** 结果列表与预览卡之间有缝隙：离开列表先给一段宽限期，移进预览卡就取消
   *  撤销（0.23 用户反馈：鼠标一往预览卡上移预览就消失）。超时仍未进入才撤。 */
  const cancelLeaveGrace = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };
  const scheduleLeaveGrace = () => {
    cancelLeaveGrace();
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      hoverContentHit(null);
    }, 350);
  };

  useEffect(
    () => () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    },
    [],
  );

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
                // 键盘走到分页尾部前三行时先扩一页（与滚动追加同口径）
                if (active + 3 >= shownCount && shownCount < displayOrder.length) {
                  setShownCount((value) => Math.min(value + limit, displayOrder.length));
                }
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

        <div className="palette-list" ref={listRef} onMouseLeave={scheduleLeaveGrace} onScroll={onListScroll}>
          {items.length === 0 && (
            <div className="palette-empty">
              {searching ? "正在搜索…" : terms.length === 0 ? "输入以搜索，↑↓ 选择，回车打开" : "没有匹配的结果"}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.name} className="palette-group">
              <div className="palette-group-name">
                {group.name}
                {group.items[0]?.groupBadge && (
                  <span className="palette-group-count">{group.items[0].groupBadge}</span>
                )}
              </div>
              {group.items.map((item) => {
                renderIndex += 1;
                const index = renderIndex;
                return (
                  <button
                    type="button"
                    key={item.key}
                    className={`palette-item${index === active ? " is-active" : ""}`}
                    onMouseMove={() => setActive(index)}
                    onMouseEnter={() => hoverContentHit(item.hit ?? null)}
                    onClick={() => pick(index)}
                  >
                    <span className="palette-item-icon">{item.icon}</span>
                    <span className="palette-item-body">
                      <span className="palette-item-title">
                        <Highlight text={item.title} terms={highlightTerms} />
                      </span>
                      {item.detail && (
                        <span className="palette-item-detail">
                          <Highlight text={item.detail} terms={highlightTerms} />
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

      {/* 「内容」结果悬停预览（设置可关）：命中行 ±4 行的上下文，关键词高亮。
          鼠标移进卡片本身不撤销（宽限期机制），移出卡片才收起。 */}
      {preview && (
        <div
          className="palette-preview"
          onMouseDown={(event) => event.stopPropagation()}
          onMouseEnter={cancelLeaveGrace}
          onMouseLeave={() => hoverContentHit(null)}
        >
          <div className="palette-preview-title">
            <span className="palette-preview-name">
              {preview.path.slice(preview.path.lastIndexOf("/") + 1)}
            </span>
            <span className="palette-preview-path">{preview.path}</span>
          </div>
          <div className="palette-preview-lines">
            {preview.lines.map((line) => (
              <div key={line.no} className={`palette-preview-line${line.no - 1 === preview.line ? " is-hit" : ""}`}>
                <span className="palette-preview-no">{line.no}</span>
                <span className="palette-preview-text">
                  <Highlight text={line.text} terms={highlightTerms} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

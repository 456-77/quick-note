/**
 * Inbox（速记管理）：占据编辑区的「快速整理中心」。
 *
 * 打开方式：命令面板「速记管理」或 Ctrl+Alt+M；Esc 逐层退出（弹层 → 抽屉 →
 * 编辑态 → 视图本身，Esc 由本组件在捕获阶段拦，逐层消费后放行给全局）。
 *
 * 视觉口径（与 Obsidian/Linear 一路的桌面应用对齐）：少边框、低阴影、行级
 * hover 才出操作、选中态用主题色；筛选收进 [标签] [日期] [排序] [筛选] 四个
 * 轻量 Popover，不把条件摊满页面。批量操作默认隐藏，勾选后才浮出工具条。
 *
 * 业务核心（扫描 / 行级重写 / 归档标记 / 目标笔记追加）与旧版一致：
 * - 归档 = 源行尾打 `^archived`（不删除，可撤销）+ 条目按时间正序追加到目标笔记；
 * - 删除 = 从收件文件里移除该行（速记行没有墓碑协议，删除即删除）；
 * - 全部 IO 走 listEntries/readNoteOptional/writeNote，收件仓库独立于当前仓库。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listEntries, pickDirectory, readNoteOptional, writeNote } from "../lib/api";
import {
  archivedLineForTarget,
  detectEol,
  lineAddTagEdit,
  lineArchiveEdit,
  lineTextEditText,
  parseCaptureEntries,
  type CaptureEntry,
} from "../lib/capture";
import { normalizeTagName } from "../lib/tags";
import { IconCalendar, IconFolder, IconListTree, IconRefresh, IconTag, IconX } from "./icons";

/** 「无标签」筛选项的内部键（不是真标签名）。 */
const NO_TAG = "__none__";

export interface VaultOption {
  value: string;
  label: string;
}

type Scope = "active" | "archived" | "all";
type SortKey = "newest" | "oldest" | "modified" | "tagCount";
type Popover = "filter" | "tags" | "date" | "sort" | "more" | "target" | null;

const SORT_LABELS: Record<SortKey, string> = {
  newest: "最新优先",
  oldest: "最早优先",
  modified: "最近修改",
  tagCount: "标签数量",
};

/** 本地日期串（YYYY-MM-DD，按本地时区；toISOString 是 UTC，不能用）。 */
function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** Mac 检测（快捷键提示的 ⌘/Ctrl 显示）。 */
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** 时间戳 → 人话：今天显示 HH:mm，昨天「昨天 HH:mm」，更早 MM-DD HH:mm。 */
function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = localDate(d);
  if (day === localDate(new Date())) return hhmm;
  if (day === localDate(new Date(Date.now() - 86400000))) return `昨天 ${hhmm}`;
  return `${day.slice(5)} ${hhmm}`;
}

export default function CaptureManager({
  inboxVault,
  onInboxVaultChange,
  vaultOptions,
  currentVault,
  onClose,
  notice,
  onNewCapture,
  onStats,
}: {
  /** 收件仓库绝对路径（settings.quickCaptureVault）；空串 = 未配置。 */
  inboxVault: string;
  onInboxVaultChange: (vault: string) => void;
  /** 仓库下拉候选（最近 + 当前 + 已配置的收件仓库，App 侧已去重）。 */
  vaultOptions: VaultOption[];
  currentVault: string | null;
  onClose: () => void;
  notice: (message: string, kind?: "info" | "error") => void;
  /** 空状态的「新建速记」：唤起快速笔记弹窗（视图保持打开）。 */
  onNewCapture: () => void;
  /** 统计上报：右侧「今日整理」面板渲染用（App 侧持 state）。 */
  onStats?: (stats: { pending: number; todayNew: number; recentTags: string[] }) => void;
}) {
  // ---------------------------------------------------------------- 扫描

  const [scan, setScan] = useState<{
    loading: boolean;
    entries: CaptureEntry[];
    files: number;
    error: string | null;
  }>({ loading: false, entries: [], files: 0, error: null });
  const [scanToken, setScanToken] = useState(0);

  useEffect(() => {
    if (!inboxVault) {
      setScan({ loading: false, entries: [], files: 0, error: null });
      return;
    }
    let cancelled = false;
    setScan((prev) => ({ ...prev, loading: true, error: null }));
    void (async () => {
      try {
        const all = await listEntries(inboxVault);
        if (cancelled) return;
        const files = all
          .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md"))
          .map((entry) => entry.path)
          .sort((a, b) => a.localeCompare(b, "zh"));
        const entries: CaptureEntry[] = [];
        let cursor = 0;
        const worker = async () => {
          // 小并发逐篇读：一次性把几百个 IPC 全打出去反而更慢
          while (!cancelled) {
            const index = cursor;
            cursor += 1;
            if (index >= files.length) break;
            try {
              const note = await readNoteOptional(inboxVault, files[index]);
              if (note) {
                // 文件 mtime 挂到每条速记上（「最近修改」排序用；同文件各条相同）
                entries.push(
                  ...parseCaptureEntries(files[index], note.content).map((entry) => ({
                    ...entry,
                    modified: note.modified,
                  })),
                );
              }
            } catch {
              // 单篇读失败不影响整体：它只是不进列表
            }
          }
        };
        await Promise.all(Array.from({ length: 8 }, () => worker()));
        if (cancelled) return;
        entries.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
        setScan({ loading: false, entries, files: files.length, error: null });
      } catch (e) {
        if (!cancelled) setScan({ loading: false, entries: [], files: 0, error: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inboxVault, scanToken]);

  // ------------------------------------------------------------- 筛选状态

  const [scope, setScope] = useState<Scope>("active");
  const [query, setQuery] = useState("");
  const [tagSel, setTagSel] = useState<Set<string>>(new Set());
  const [sourceSel, setSourceSel] = useState<Set<string>>(new Set());
  const [dateRange, setDateRange] = useState<"any" | "today" | "yesterday" | "7d" | "30d" | "custom">("any");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [popover, setPopover] = useState<Popover>(null);
  const [tagSearch, setTagSearch] = useState("");

  /** 标签聚合（全量条目，不受筛选影响）：#tag → 条数；外加「无标签」。 */
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let untagged = 0;
    for (const entry of scan.entries) {
      if (entry.tags.length === 0) untagged += 1;
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const tags = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
    return { tags, untagged };
  }, [scan.entries]);

  /** 来源聚合（速记时的仓库/笔记），「筛选」Popover 用。 */
  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of scan.entries) {
      if (!entry.source) continue;
      counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
  }, [scan.entries]);

  // ------------------------------------------------------------- 派生筛选

  const today = localDate(new Date());
  const yesterday = localDate(new Date(Date.now() - 86400000));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return scan.entries.filter((entry) => {
      if (scope === "active" && entry.archived) return false;
      if (scope === "archived" && !entry.archived) return false;
      if (q && !entry.text.toLowerCase().includes(q) && !entry.tags.some((tag) => tag.toLowerCase().includes(q))) {
        return false;
      }
      if (tagSel.size > 0) {
        const hit = [...tagSel].some((tag) =>
          tag === NO_TAG ? entry.tags.length === 0 : entry.tags.includes(tag),
        );
        if (!hit) return false;
      }
      if (sourceSel.size > 0 && !(entry.source && sourceSel.has(entry.source))) return false;
      if (dateRange !== "any") {
        const day = entry.timestamp?.slice(0, 10) ?? "";
        if (!day) return false;
        if (dateRange === "today" && day !== today) return false;
        if (dateRange === "yesterday" && day !== yesterday) return false;
        if (dateRange === "7d" || dateRange === "30d") {
          const days = dateRange === "7d" ? 7 : 30;
          if (new Date(`${day}T00:00:00`).getTime() < now - days * 86400000) return false;
        }
        if (dateRange === "custom") {
          if (customFrom && day < customFrom) return false;
          if (customTo && day > customTo) return false;
        }
      }
      return true;
    });
  }, [scan.entries, scope, query, tagSel, sourceSel, dateRange, customFrom, customTo, today, yesterday]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    if (sort === "newest") list.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    if (sort === "oldest") list.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
    if (sort === "modified") list.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
    if (sort === "tagCount") {
      list.sort((a, b) => b.tags.length - a.tags.length || (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    }
    return list;
  }, [filtered, sort]);

  /** 日期分组：今天 / 昨天 / 更早（条目保持当前排序）。 */
  const groups = useMemo(() => {
    const order: { key: string; label: string; entries: CaptureEntry[] }[] = [
      { key: "today", label: "今天", entries: [] },
      { key: "yesterday", label: "昨天", entries: [] },
      { key: "earlier", label: "更早", entries: [] },
    ];
    const map = new Map(order.map((group) => [group.key, group]));
    for (const entry of sorted) {
      const day = entry.timestamp?.slice(0, 10) ?? "";
      const bucket = day === today ? "today" : day === yesterday ? "yesterday" : "earlier";
      map.get(bucket)!.entries.push(entry);
    }
    return order.filter((group) => group.entries.length > 0);
  }, [sorted, today, yesterday]);

  // ------------------------------------------------------------- 统计

  const stats = useMemo(() => {
    let active = 0;
    let archived = 0;
    let todayNew = 0;
    let todayArchived = 0;
    for (const entry of scan.entries) {
      if (entry.archived) archived += 1;
      else active += 1;
      if (entry.timestamp?.slice(0, 10) === today) {
        todayNew += 1;
        if (entry.archived) todayArchived += 1;
      }
    }
    return { active, archived, all: scan.entries.length, todayNew, todayArchived };
  }, [scan.entries, today]);

  // 上报给右侧「今日整理」面板（App 持 state 渲染；数值或标签变化才触发）
  useEffect(() => {
    onStats?.({
      pending: stats.active,
      todayNew: stats.todayNew,
      recentTags: tagCounts.tags.slice(0, 8).map((tag) => tag.name),
    });
  }, [onStats, stats.active, stats.todayNew, tagCounts.tags]);

  // ------------------------------------------------------------- 选择

  const [sel, setSel] = useState<Set<string>>(new Set());
  const lastCheckedRef = useRef<string | null>(null);
  const keyOf = (entry: CaptureEntry) => `${entry.file}::${entry.line}`;

  const toggleSelect = (entry: CaptureEntry, range: boolean) => {
    const key = keyOf(entry);
    setSel((prev) => {
      const next = new Set(prev);
      const anchor = lastCheckedRef.current;
      if (range && anchor && anchor !== key) {
        const keys = sorted.map(keyOf);
        const from = keys.indexOf(anchor);
        const to = keys.indexOf(key);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          for (let i = lo; i <= hi; i += 1) next.add(keys[i]);
          return next;
        }
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    lastCheckedRef.current = key;
  };

  const clearSel = useCallback(() => {
    setSel(new Set());
    lastCheckedRef.current = null;
  }, []);

  // ------------------------------------------------------------- 目标笔记

  const [targetVault, setTargetVault] = useState(currentVault ?? "");
  const [, setTargetNotes] = useState<string[]>([]);
  const [targetNote, setTargetNote] = useState("");
  const [busy, setBusy] = useState(false);

  // currentVault 是异步加载的（启动参数 → IPC → setState）：视图可能在它到位前
  // 挂载，此时 targetVault 还是空串、目标笔记列表加载不出来。用户没手动选过
  // （state 为空）就跟上 prop，选过则不动。
  useEffect(() => {
    setTargetVault((prev) => prev || currentVault || "");
  }, [currentVault]);

  useEffect(() => {
    if (!targetVault) {
      setTargetNotes([]);
      setTargetNote("");
      return;
    }
    let cancelled = false;
    listEntries(targetVault)
      .then((all) => {
        if (cancelled) return;
        const notes = all
          .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md"))
          .map((entry) => entry.path)
          .sort((a, b) => a.localeCompare(b, "zh"));
        setTargetNotes(notes);
        setTargetNote((prev) => (notes.includes(prev) ? prev : ""));
      })
      .catch(() => {
        if (!cancelled) {
          setTargetNotes([]);
          setTargetNote("");
        }
      });
    return () => {
      cancelled = true;
    };
    // 重扫后目标笔记列表也刷新一次（收件仓库文件可能刚被本视图改过）
  }, [targetVault, scanToken]);

  // ------------------------------------------------------------- 落盘核心

  /**
   * 按行重写一批收件文件：plan = 文件 → (行号 → 行变换)。
   * 每个文件读一次、改完一次写回；换行风格按文件现状拼接。
   * 返回实际改动的文件数。
   */
  const rewriteLines = useCallback(
    async (vault: string, plan: Map<string, Map<number, (line: string) => string | null>>) => {
      let changed = 0;
      for (const [file, lineOps] of plan) {
        const note = await readNoteOptional(vault, file);
        if (!note) continue;
        const eol = detectEol(note.content);
        const lines = note.content.split(/\r?\n/);
        let touched = false;
        for (const [index, op] of lineOps) {
          if (index >= lines.length) continue;
          const next = op(lines[index]);
          if (next === null || next === lines[index]) continue;
          lines[index] = next;
          touched = true;
        }
        if (!touched) continue;
        await writeNote(vault, file, lines.join(eol), note.hasBom);
        changed += 1;
      }
      return changed;
    },
    [],
  );

  /** 从收件文件里移除若干行（删除速记）。按文件分组，行号倒序 splice。 */
  const removeLines = useCallback(
    async (vault: string, entries: CaptureEntry[]) => {
      const byFile = new Map<string, number[]>();
      for (const entry of entries) {
        const bucket = byFile.get(entry.file);
        if (bucket) bucket.push(entry.line);
        else byFile.set(entry.file, [entry.line]);
      }
      let changed = 0;
      for (const [file, lineIdxs] of byFile) {
        const note = await readNoteOptional(vault, file);
        if (!note) continue;
        const eol = detectEol(note.content);
        const lines = note.content.split(/\r?\n/);
        for (const index of [...lineIdxs].sort((a, b) => b - a)) {
          if (index < lines.length) lines.splice(index, 1);
        }
        await writeNote(vault, file, lines.join(eol), note.hasBom);
        changed += 1;
      }
      return changed;
    },
    [],
  );

  // ------------------------------------------------------------- 动效状态

  /** 正在淡出的行（归档/删除后先播 220ms 动画再重扫）。 */
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((text: string, undo?: () => void) => {
    setToast({ text, undo });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  const leaveAndRescan = useCallback(
    (keys: string[]) => {
      setLeaving((prev) => new Set([...prev, ...keys]));
      window.setTimeout(() => {
        setLeaving((prev) => {
          const next = new Set(prev);
          for (const key of keys) next.delete(key);
          return next;
        });
        setScanToken((value) => value + 1);
      }, 240);
    },
    [],
  );

  // ------------------------------------------------------------- 动作

  /** 归档一批：源行打 ^archived + 按时间正序追加到目标笔记。返回是否成功。 */
  const archiveEntries = useCallback(
    async (entries: CaptureEntry[]): Promise<boolean> => {
      if (!inboxVault) return false;
      const chosen = entries.filter((entry) => !entry.archived);
      if (chosen.length === 0) return false;
      if (!targetVault || !targetNote) {
        notice("先选择归档目标笔记（批量栏或详情抽屉里可选）", "error");
        return false;
      }
      setBusy(true);
      try {
        const plan = new Map<string, Map<number, (line: string) => string | null>>();
        for (const entry of chosen) {
          let bucket = plan.get(entry.file);
          if (!bucket) {
            bucket = new Map();
            plan.set(entry.file, bucket);
          }
          bucket.set(entry.line, (line) => lineArchiveEdit(line, true));
        }
        await rewriteLines(inboxVault, plan);

        const ordered = [...chosen].sort((a, b) =>
          (a.timestamp ?? "").localeCompare(b.timestamp ?? ""),
        );
        const target = await readNoteOptional(targetVault, targetNote);
        const eol = target ? detectEol(target.content) : "\n";
        const block = ordered.map((entry) => archivedLineForTarget(entry)).join(eol);
        const title = targetNote.replace(/^.*\//, "").replace(/\.md$/i, "");
        const nextContent = target
          ? `${target.content}${target.content.endsWith("\n") ? "" : eol}${eol}${block}${eol}`
          : `# ${title}${eol}${eol}${block}${eol}`;
        await writeNote(targetVault, targetNote, nextContent, target?.hasBom ?? false);
        // 记录最近整理时间（顶栏「最近整理」；本机偏好不进仓库）
        const archivedAt = Date.now();
        try {
          localStorage.setItem("quicknote.inbox.lastArchiveAt", String(archivedAt));
        } catch {
          // 存不上只影响这一处显示
        }
        setLastArchiveAt(archivedAt);
        const keys = chosen.map(keyOf);
        clearSel();
        leaveAndRescan(keys);
        showToast(
          `已归档 ${chosen.length} 条到「${targetNote.replace(/^.*\//, "")}」`,
          // 撤销走 unarchiveEntries，它按 entry.archived 过滤——这里捕获的还是
          // 归档前的对象（archived:false），必须带上归档后的状态，否则撤销为空操作
          () => void unarchiveEntries(chosen.map((entry) => ({ ...entry, archived: true }))),
        );
        return true;
      } catch (e) {
        notice(`归档失败：${e}`, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    // unarchiveEntries 在下方声明（互相引用，用 ref 兜住时序）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inboxVault, targetVault, targetNote, rewriteLines, notice, clearSel, leaveAndRescan, showToast],
  );

  /** 撤销归档一批：剥掉源行的 ^archived 标记。 */
  const unarchiveEntries = useCallback(
    async (entries: CaptureEntry[]): Promise<boolean> => {
      if (!inboxVault) return false;
      const chosen = entries.filter((entry) => entry.archived);
      if (chosen.length === 0) return false;
      setBusy(true);
      try {
        const plan = new Map<string, Map<number, (line: string) => string | null>>();
        for (const entry of chosen) {
          let bucket = plan.get(entry.file);
          if (!bucket) {
            bucket = new Map();
            plan.set(entry.file, bucket);
          }
          bucket.set(entry.line, (line) => lineArchiveEdit(line, false));
        }
        const files = await rewriteLines(inboxVault, plan);
        if (files > 0) {
          clearSel();
          setScanToken((value) => value + 1);
          showToast(`已撤销归档 ${chosen.length} 条`);
        }
        return files > 0;
      } catch (e) {
        notice(`撤销归档失败：${e}`, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [inboxVault, rewriteLines, notice, clearSel, showToast],
  );

  /** 给一批条目加标签。 */
  const addTagToEntries = useCallback(
    async (entries: CaptureEntry[], rawTag: string): Promise<boolean> => {
      const tag = normalizeTagName(rawTag);
      if (!tag) {
        notice("标签名不合法（不能含空格）", "error");
        return false;
      }
      if (!inboxVault || entries.length === 0) return false;
      setBusy(true);
      try {
        const plan = new Map<string, Map<number, (line: string) => string | null>>();
        for (const entry of entries) {
          let bucket = plan.get(entry.file);
          if (!bucket) {
            bucket = new Map();
            plan.set(entry.file, bucket);
          }
          bucket.set(entry.line, (line) => lineAddTagEdit(line, tag));
        }
        const files = await rewriteLines(inboxVault, plan);
        if (files > 0) {
          clearSel();
          setScanToken((value) => value + 1);
          showToast(`已给 ${entries.length} 条加上 #${tag}`);
        } else {
          notice("选中的条目都已带这个标签");
        }
        return files > 0;
      } catch (e) {
        notice(`加标签失败：${e}`, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [inboxVault, rewriteLines, notice, clearSel, showToast],
  );

  /** 删除一批速记行（收件行没有墓碑协议，删除即删除）。 */
  const deleteEntries = useCallback(
    async (entries: CaptureEntry[]): Promise<boolean> => {
      if (!inboxVault || entries.length === 0) return false;
      setBusy(true);
      try {
        const files = await removeLines(inboxVault, entries);
        if (files > 0) {
          const keys = entries.map(keyOf);
          clearSel();
          leaveAndRescan(keys);
          showToast(`已删除 ${entries.length} 条速记`);
        }
        return files > 0;
      } catch (e) {
        notice(`删除失败：${e}`, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [inboxVault, removeLines, notice, clearSel, leaveAndRescan, showToast],
  );

  /** 保存行内编辑（只改正文，时间戳/来源/标签/标记原样保留）。 */
  const saveEdit = useCallback(
    async (entry: CaptureEntry, nextText: string): Promise<boolean> => {
      const text = nextText.trim();
      if (!inboxVault || !text || text === entry.text) return false;
      setBusy(true);
      try {
        const plan = new Map<string, Map<number, (line: string) => string | null>>([
          [entry.file, new Map([[entry.line, (line) => lineTextEditText(line, entry.text, text)]])],
        ]);
        const files = await rewriteLines(inboxVault, plan);
        if (files > 0) setScanToken((value) => value + 1);
        return files > 0;
      } catch (e) {
        notice(`保存失败：${e}`, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [inboxVault, rewriteLines, notice],
  );

  // ------------------------------------------------------------- 抽屉与编辑

  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  /** 打开着 ⋯ 操作菜单的行（row key）。 */
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  /** 「移动到」目标选择器（popover === "target"）的内部状态。 */
  const [pickVault, setPickVault] = useState("");
  const [pickQuery, setPickQuery] = useState("");
  const [pickIdx, setPickIdx] = useState(0);
  const [pickNotes, setPickNotes] = useState<string[]>([]);
  /** 最近一次归档时间（本机记录；顶栏「最近整理」用）。 */
  const [lastArchiveAt, setLastArchiveAt] = useState<number | null>(() => {
    try {
      const raw = Number(localStorage.getItem("quicknote.inbox.lastArchiveAt") ?? 0);
      return raw > 0 ? raw : null;
    } catch {
      return null;
    }
  });

  // 「移动到」选择器打开时按 pickVault 加载笔记列表
  useEffect(() => {
    if (popover !== "target") return;
    if (!pickVault) {
      setPickNotes([]);
      return;
    }
    let cancelled = false;
    listEntries(pickVault)
      .then((all) => {
        if (cancelled) return;
        setPickNotes(
          all
            .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md"))
            .map((entry) => entry.path)
            .sort((a, b) => a.localeCompare(b, "zh")),
        );
      })
      .catch(() => {
        if (!cancelled) setPickNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [popover, pickVault]);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  const [newTag, setNewTag] = useState("");

  const drawerEntry = useMemo(
    () => (drawerKey ? scan.entries.find((entry) => keyOf(entry) === drawerKey) ?? null : null),
    [drawerKey, scan.entries],
  );

  // ------------------------------------------------------------- Esc 逐层退出

  /** 勾选中的条目（按当前排序；批量栏与 A 键归档共用）。 */
  const selectedEntries = useMemo(
    () => sorted.filter((entry) => sel.has(keyOf(entry))),
    [sorted, sel],
  );

  useEffect(() => {
    // 捕获阶段拦 Esc：先吃掉本视图内的浮层（弹层 → 行菜单 → 抽屉 → 行内编辑 →
    // 取消选择），都没有时放行给全局兜底（关整个视图）。用 stopImmediatePropagation：
    // 全局兜底与本处理器都挂在 window 上，普通 stopPropagation 拦不住
    // 同节点的后续监听（target 就在 window 时两者必同节点）。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (popover || rowMenu) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPopover(null);
        setRowMenu(null);
        return;
      }
      if (drawerKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setDrawerKey(null);
        return;
      }
      if (editKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setEditKey(null);
        return;
      }
      if (sel.size > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearSel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [popover, rowMenu, drawerKey, editKey, sel, clearSel]);

  // 快捷操作：Ctrl/Cmd+Enter 新建速记，A 归档选中（输入焦点在表单里时不抢）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inForm =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        // 行内/抽屉编辑里 Ctrl+Enter 是保存，不让给「新建速记」
        if (target?.closest(".cm-row-edit, .cm-drawer-edit")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        onNewCapture();
        return;
      }
      if (event.key !== "a" && event.key !== "A") return;
      if (event.ctrlKey || event.metaKey || event.altKey || inForm) return;
      if (sel.size === 0 || busy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void archiveEntries(selectedEntries);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sel, busy, selectedEntries, archiveEntries, onNewCapture]);

  // ------------------------------------------------------------- 小组件

  /** 打开「移动到」目标选择器（重置内部状态）。 */
  const openTargetPicker = () => {
    setPickVault(targetVault || currentVault || vaultOptions[0]?.value || "");
    setPickQuery("");
    setPickIdx(0);
    setPopover("target");
  };

  /** 确认归档目标（仓库用选择器内的 pickVault）。 */
  const pickTarget = (note: string) => {
    setTargetVault(pickVault);
    setTargetNote(note);
    setPopover(null);
  };

  /**
   * Command Palette 风格的归档目标选择器（popover === "target" 时渲染）：
   * 仓库 chips + 搜索框 + 笔记列表（文件夹层级以 dim 路径前缀呈现），
   * ↑↓ 移动高亮、Enter 确认、Esc 关闭——替代原生 select。
   */
  const targetPicker = (anchorClass: string) => {
    const q = pickQuery.trim().toLowerCase();
    const list = q ? pickNotes.filter((path) => path.toLowerCase().includes(q)) : pickNotes;
    const clamped = Math.min(pickIdx, Math.max(0, list.length - 1));
    return (
      <div className={`cm-pop cm-target-pop ${anchorClass}`}>
        <div className="cm-target-vaults">
          {vaultOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`cm-target-vault${option.value === pickVault ? " is-on" : ""}`}
              title={option.value}
              onClick={() => {
                setPickVault(option.value);
                setPickQuery("");
                setPickIdx(0);
              }}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className="cm-target-vault"
            title="选择其他目录"
            onClick={() => {
              void pickDirectory("选择归档目标仓库").then((picked) => {
                if (picked) {
                  setPickVault(picked);
                  setPickQuery("");
                  setPickIdx(0);
                }
              });
            }}
          >
            其他…
          </button>
        </div>
        <input
          autoFocus
          type="text"
          className="cm-target-search"
          value={pickQuery}
          placeholder="搜索笔记…（↑↓ 选择 · Enter 确认）"
          onChange={(event) => {
            setPickQuery(event.target.value);
            setPickIdx(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setPickIdx(Math.min(clamped + 1, list.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setPickIdx(Math.max(clamped - 1, 0));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const path = list[clamped];
              if (path) pickTarget(path);
            }
          }}
        />
        <div className="cm-target-list">
          {list.map((path, index) => {
            const slash = path.lastIndexOf("/");
            return (
              <button
                key={path}
                type="button"
                className={`cm-target-item${index === clamped ? " is-on" : ""}`}
                title={path}
                onMouseEnter={() => setPickIdx(index)}
                onClick={() => pickTarget(path)}
              >
                {slash >= 0 && (
                  <span className="cm-target-item-dir">{path.slice(0, slash + 1)}</span>
                )}
                <span className="cm-target-item-name">{path.slice(slash + 1)}</span>
              </button>
            );
          })}
          {list.length === 0 && <div className="cm-pop-empty">没有匹配的笔记</div>}
        </div>
        <div className="cm-target-foot">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
      </div>
    );
  };

  // ------------------------------------------------------------- 渲染

  const activeFilterChips: { label: string; clear: () => void }[] = [];
  if (query.trim()) activeFilterChips.push({ label: `“${query.trim()}”`, clear: () => setQuery("") });
  for (const tag of tagSel) {
    activeFilterChips.push({
      label: tag === NO_TAG ? "无标签" : `#${tag}`,
      clear: () =>
        setTagSel((prev) => {
          const next = new Set(prev);
          next.delete(tag);
          return next;
        }),
    });
  }
  for (const source of sourceSel) {
    activeFilterChips.push({
      label: `来源 ${source}`,
      clear: () =>
        setSourceSel((prev) => {
          const next = new Set(prev);
          next.delete(source);
          return next;
        }),
    });
  }
  if (dateRange !== "any") {
    activeFilterChips.push({
      label: dateRange === "custom" ? `${customFrom || "…"} ~ ${customTo || "…"}` : { today: "今天", yesterday: "昨天", "7d": "最近 7 天", "30d": "最近 30 天" }[dateRange] ?? dateRange,
      clear: () => setDateRange("any"),
    });
  }
  if (sort !== "newest") {
    activeFilterChips.push({ label: SORT_LABELS[sort], clear: () => setSort("newest") });
  }

  const scopeTabs: { value: Scope; label: string; count: number }[] = [
    { value: "active", label: "未归档", count: stats.active },
    { value: "archived", label: "已归档", count: stats.archived },
    { value: "all", label: "全部", count: stats.all },
  ];

  if (!inboxVault) {
    return (
      <div className="cm-root">
        <div className="cm-head">
          <div className="cm-head-titles">
            <h2 className="cm-title">Inbox</h2>
            <p className="cm-subtitle">快速整理刚刚记录的内容</p>
          </div>
          <span className="cm-spacer" />
          <button type="button" className="cm-icon-btn" title="返回笔记 (Esc)" onClick={onClose}>
            <IconX size={15} />
          </button>
        </div>
        <div className="cm-empty">
          <div className="cm-empty-icon">📥</div>
          <p className="cm-empty-title">还没有配置收件仓库</p>
          <p className="cm-empty-hint">
            在 设置 → 通用 → 快速笔记 里选择一个仓库作为收件仓库，
            之后 Ctrl+Alt+N 的速记都会落到这里。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="cm-root">
      {/* ------------------------------------------------------------ 顶栏 */}
      <div className="cm-head">
        <div className="cm-head-titles">
          <h2 className="cm-title">Inbox</h2>
          <p className="cm-subtitle">快速整理刚刚记录的内容</p>
        </div>
        <span className="cm-spacer" />
        <span
          className="cm-head-stats"
          title={`今日新增 ${stats.todayNew} · 今日已整理 ${stats.todayArchived}${lastArchiveAt ? ` · 最近整理 ${fmtWhen(lastArchiveAt)}` : ""}`}
        >
          未归档 {stats.active} · 今日新增 {stats.todayNew} · 今日已整理 {stats.todayArchived}
          {lastArchiveAt ? ` · 最近整理 ${fmtWhen(lastArchiveAt)}` : ""}
        </span>
        <input
          type="text"
          className="cm-search"
          value={query}
          placeholder="搜索速记…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        <button
          type="button"
          className="cm-icon-btn"
          title="重新扫描收件仓库"
          onClick={() => setScanToken((value) => value + 1)}
        >
          <IconRefresh size={14} />
        </button>
        <div className="cm-tool">
          <button
            type="button"
            className={`cm-icon-btn${popover === "more" ? " is-on" : ""}`}
            title="更多操作"
            onClick={() => setPopover(popover === "more" ? null : "more")}
          >
            ⋯
          </button>
          {popover === "more" && (
            <div className="cm-pop cm-pop-right">
              <button type="button" className="cm-pop-item" onClick={() => {
                setSel(new Set(sorted.map(keyOf)));
                setPopover(null);
              }}>
                全选当前视图（{sorted.length}）
              </button>
              <button type="button" className="cm-pop-item" disabled={sel.size === 0} onClick={() => {
                clearSel();
                setPopover(null);
              }}>
                取消全选
              </button>
              <div className="cm-pop-sep" />
              <button type="button" className="cm-pop-item" onClick={() => {
                setScanToken((value) => value + 1);
                setPopover(null);
              }}>
                重新扫描
              </button>
              <button
                type="button"
                className="cm-pop-item"
                onClick={() => {
                  setPopover(null);
                  void pickDirectory("选择速记收件仓库").then((picked) => {
                    if (picked) onInboxVaultChange(picked);
                  });
                }}
              >
                更换收件仓库…
              </button>
            </div>
          )}
        </div>
        <button type="button" className="cm-icon-btn" title="返回笔记 (Esc)" onClick={onClose}>
          <IconX size={15} />
        </button>
      </div>

      {/* -------------------------------------------------------- 分段切换 */}
      <div className="cm-seg" role="tablist" aria-label="归档状态">
        {scopeTabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={scope === tab.value}
            className={`cm-seg-btn${scope === tab.value ? " is-on" : ""}`}
            onClick={() => setScope(tab.value)}
          >
            {tab.label}
            <span className="cm-seg-count">{tab.count}</span>
          </button>
        ))}
      </div>

      {/* --------- 工具栏：普通态=筛选入口；勾选后=批量模式（原位切换，不遮列表） --------- */}
      <div className={`cm-toolbar${sel.size > 0 ? " is-batch" : ""}`}>
        {sel.size > 0 ? (
          <>
            <span className="cm-batch-count">已选择 {sel.size} 条</span>
            <span className="cm-batch-sep" />
            <div className="cm-tool">
              <button
                type="button"
                className="cm-btn cm-batch-target"
                disabled={busy}
                title={targetNote ? `归档目标：${targetNote}` : "选择归档目标笔记"}
                onClick={() => (popover === "target" ? setPopover(null) : openTargetPicker())}
              >
                <IconFolder size={12} />
                {targetNote
                  ? `移动到 ${targetNote.slice(targetNote.lastIndexOf("/") + 1)}`
                  : "移动到…"}
              </button>
              {popover === "target" && targetPicker("")}
            </div>
            {batchTagOpen ? (
              <input
                autoFocus
                type="text"
                className="cm-batch-tag-input"
                value={newTag}
                placeholder="标签名（不含 #）"
                onChange={(event) => setNewTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addTagToEntries(selectedEntries, newTag).then((done) => {
                      if (done) setBatchTagOpen(false);
                    });
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setBatchTagOpen(false);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="cm-btn"
                disabled={busy}
                onClick={() => {
                  setNewTag("");
                  setBatchTagOpen(true);
                }}
              >
                添加标签
              </button>
            )}
            <button
              type="button"
              className="cm-btn cm-btn-primary"
              disabled={busy || !targetVault || !targetNote}
              title={targetNote ? `归档到 ${targetNote}` : "先选择目标笔记"}
              onClick={() => void archiveEntries(selectedEntries)}
            >
              归档
            </button>
            <button
              type="button"
              className="cm-btn cm-btn-danger"
              disabled={busy}
              onClick={() => void deleteEntries(selectedEntries)}
            >
              删除
            </button>
            <button type="button" className="cm-btn cm-btn-ghost" onClick={clearSel}>
              取消
            </button>
          </>
        ) : (
        <>
        <div className="cm-tool">
          <button
            type="button"
            className={`cm-tool-btn${sourceSel.size > 0 ? " is-on" : ""}`}
            onClick={() => setPopover(popover === "filter" ? null : "filter")}
          >
            筛选
          </button>
          {popover === "filter" && (
            <div className="cm-pop">
              <div className="cm-pop-title">按来源筛选</div>
              {sourceCounts.length === 0 && <div className="cm-pop-empty">速记还没有来源记录</div>}
              {sourceCounts.map((source) => (
                <label key={source.name} className="cm-pop-row">
                  <input
                    type="checkbox"
                    checked={sourceSel.has(source.name)}
                    onChange={() =>
                      setSourceSel((prev) => {
                        const next = new Set(prev);
                        if (next.has(source.name)) next.delete(source.name);
                        else next.add(source.name);
                        return next;
                      })
                    }
                  />
                  <span className="cm-pop-row-name" title={source.name}>
                    {source.name}
                  </span>
                  <span className="cm-spacer" />
                  <span className="cm-pop-row-count">{source.count}</span>
                </label>
              ))}
              {activeFilterChips.length > 0 && (
                <button
                  type="button"
                  className="cm-pop-clear"
                  onClick={() => {
                    setQuery("");
                    setTagSel(new Set());
                    setSourceSel(new Set());
                    setDateRange("any");
                    setSort("newest");
                  }}
                >
                  清除全部筛选
                </button>
              )}
            </div>
          )}
        </div>
        <div className="cm-tool">
          <button
            type="button"
            className={`cm-tool-btn${tagSel.size > 0 ? " is-on" : ""}`}
            onClick={() => {
              setTagSearch("");
              setPopover(popover === "tags" ? null : "tags");
            }}
          >
            <IconTag size={12} />
            标签
          </button>
          {popover === "tags" && (
            <div className="cm-pop">
              <input
                type="text"
                className="cm-pop-search"
                value={tagSearch}
                placeholder="搜索标签…"
                onChange={(event) => setTagSearch(event.target.value)}
              />
              <div className="cm-pop-list">
                {tagCounts.tags
                  .filter((tag) => !tagSearch.trim() || tag.name.toLowerCase().includes(tagSearch.trim().toLowerCase()))
                  .map((tag) => (
                    <label key={tag.name} className="cm-pop-row">
                      <input
                        type="checkbox"
                        checked={tagSel.has(tag.name)}
                        onChange={() =>
                          setTagSel((prev) => {
                            const next = new Set(prev);
                            if (next.has(tag.name)) next.delete(tag.name);
                            else next.add(tag.name);
                            return next;
                          })
                        }
                      />
                      <span className="cm-pop-row-name">#{tag.name}</span>
                      <span className="cm-spacer" />
                      <span className="cm-pop-row-count">{tag.count}</span>
                    </label>
                  ))}
                {tagCounts.untagged > 0 && (
                  <label className="cm-pop-row">
                    <input
                      type="checkbox"
                      checked={tagSel.has(NO_TAG)}
                      onChange={() =>
                        setTagSel((prev) => {
                          const next = new Set(prev);
                          if (next.has(NO_TAG)) next.delete(NO_TAG);
                          else next.add(NO_TAG);
                          return next;
                        })
                      }
                    />
                    <span className="cm-pop-row-name">无标签</span>
                    <span className="cm-spacer" />
                    <span className="cm-pop-row-count">{tagCounts.untagged}</span>
                  </label>
                )}
                {tagCounts.tags.length === 0 && tagCounts.untagged === 0 && (
                  <div className="cm-pop-empty">还没有带标签的速记</div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="cm-tool">
          <button
            type="button"
            className={`cm-tool-btn${dateRange !== "any" ? " is-on" : ""}`}
            onClick={() => setPopover(popover === "date" ? null : "date")}
          >
            <IconCalendar size={12} />
            日期
          </button>
          {popover === "date" && (
            <div className="cm-pop">
              {([
                ["any", "全部日期"],
                ["today", "今天"],
                ["yesterday", "昨天"],
                ["7d", "最近 7 天"],
                ["30d", "最近 30 天"],
                ["custom", "自定义"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`cm-pop-item${dateRange === value ? " is-on" : ""}`}
                  onClick={() => setDateRange(value)}
                >
                  {label}
                </button>
              ))}
              {dateRange === "custom" && (
                <div className="cm-pop-custom">
                  <input
                    type="date"
                    className="cm-pop-date"
                    value={customFrom}
                    onChange={(event) => setCustomFrom(event.target.value)}
                  />
                  <span className="cm-pop-date-sep">~</span>
                  <input
                    type="date"
                    className="cm-pop-date"
                    value={customTo}
                    onChange={(event) => setCustomTo(event.target.value)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <div className="cm-tool">
          <button
            type="button"
            className={`cm-tool-btn${sort !== "newest" ? " is-on" : ""}`}
            onClick={() => setPopover(popover === "sort" ? null : "sort")}
          >
            <IconListTree size={12} />
            排序
          </button>
          {popover === "sort" && (
            <div className="cm-pop">
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`cm-pop-item${sort === key ? " is-on" : ""}`}
                  onClick={() => setSort(key)}
                >
                  {SORT_LABELS[key]}
                </button>
              ))}
            </div>
          )}
        </div>
        {activeFilterChips.map((chip) => (
          <button key={chip.label} type="button" className="cm-chip" title="移除这个筛选" onClick={chip.clear}>
            {chip.label}
            <IconX size={10} />
          </button>
        ))}
        <span className="cm-spacer" />
        {scan.loading && <span className="cm-scan-meta">扫描中…</span>}
        {!scan.loading && !scan.error && (
          <span className="cm-scan-meta">
            {sorted.length} / {scan.entries.length} 条
          </span>
        )}
        </>
        )}
      </div>
      {(popover || rowMenu) && (
        <div
          className="cm-pop-backdrop"
          onClick={() => {
            setPopover(null);
            setRowMenu(null);
          }}
        />
      )}

      {/* -------------------------------------------------------- 列表 */}
      <div className="cm-list">
        {scan.error && <div className="cm-list-error">{scan.error}</div>}
        {scan.loading && <div className="cm-list-note">正在扫描收件仓库…</div>}
        {!scan.loading && !scan.error && groups.length === 0 && (
          <div className="cm-empty">
            {scope === "active" && scan.entries.length > 0 ? (
              <>
                <div className="cm-empty-icon">✓</div>
                <p className="cm-empty-title">Inbox 已清空</p>
                <p className="cm-empty-hint">所有速记都已经整理完成。</p>
                <button type="button" className="cm-btn cm-btn-primary" onClick={onNewCapture}>
                  新建速记
                </button>
              </>
            ) : (
              <>
                <div className="cm-empty-icon">📥</div>
                <p className="cm-empty-title">{scope === "archived" ? "还没有已归档的速记" : "还没有速记"}</p>
                <p className="cm-empty-hint">用 Ctrl+Alt+N 或命令面板的「快速笔记」随手记，记录会出现在这里。</p>
                <button type="button" className="cm-btn cm-btn-primary" onClick={onNewCapture}>
                  新建速记
                </button>
              </>
            )}
          </div>
        )}
        {groups.map((group) => (
          <div key={group.key} className="cm-group">
            <div className="cm-group-head">{group.label}</div>
            {group.entries.map((entry) => {
              const key = keyOf(entry);
              const editing = editKey === key;
              return (
                <div
                  key={key}
                  className={`cm-row${entry.archived ? " is-archived" : ""}${sel.has(key) ? " is-sel" : ""}${
                    leaving.has(key) ? " is-leaving" : ""
                  }`}
                  onClick={() => {
                    if (!editing) setDrawerKey(key);
                  }}
                >
                  <input
                    type="checkbox"
                    className="cm-check"
                    checked={sel.has(key)}
                    // 普通勾选走 onChange（受控更新）；onClick 只在 Shift+点选时
                    // 接手做范围多选，preventDefault 挡掉浏览器自己的切换。
                    // stopPropagation 挡掉冒泡到行上的 onClick——否则勾一下顺手
                    // 把详情抽屉打开了，抽屉遮罩（z-40）还会盖住批量栏（z-20）。
                    onChange={() => toggleSelect(entry, false)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (event.shiftKey && lastCheckedRef.current) {
                        event.preventDefault();
                        toggleSelect(entry, true);
                      }
                    }}
                    title="勾选（Shift+点选范围多选）"
                  />
                  <div className="cm-row-main">
                    {editing ? (
                      <textarea
                        autoFocus
                        className="cm-row-edit"
                        rows={2}
                        value={editDraft}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void saveEdit(entry, editDraft).then((saved) => {
                              if (saved) setEditKey(null);
                            });
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            setEditKey(null);
                          }
                        }}
                      />
                    ) : (
                      <div className="cm-row-text">{entry.text}</div>
                    )}
                    <div className="cm-row-meta">
                      <span className="cm-row-time">
                        {entry.timestamp
                          ? group.key === "earlier"
                            ? entry.timestamp.slice(0, 16)
                            : entry.timestamp.slice(11)
                          : "--:--"}
                      </span>
                      <span className="cm-meta-dot">·</span>
                      <span className={`cm-row-state${entry.archived ? " is-archived" : ""}`}>
                        {entry.archived ? "已归档" : "未归档"}
                      </span>
                      {entry.tags.length > 0 && <span className="cm-meta-dot">·</span>}
                      {entry.tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className="cm-tag"
                          title={`筛选 #${tag}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setTagSel((prev) => new Set(prev).add(tag));
                          }}
                        >
                          #{tag}
                        </button>
                      ))}
                      {entry.source && (
                        <span className="cm-row-src" title={entry.source}>
                          {entry.source}
                        </span>
                      )}
                    </div>
                  </div>
                  {!editing && (
                    <div className="cm-tool cm-row-tool" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="cm-row-quick"
                        title="编辑"
                        onClick={() => {
                          setEditDraft(entry.text);
                          setEditKey(key);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="cm-row-quick"
                        title="添加标签"
                        disabled={busy}
                        onClick={() => {
                          const tag = window.prompt("标签名（不含 #）");
                          if (tag) void addTagToEntries([entry], tag);
                        }}
                      >
                        标签
                      </button>
                      {entry.archived ? (
                        <button
                          type="button"
                          className="cm-row-quick"
                          title="撤销归档（去掉 ^archived 标记）"
                          disabled={busy}
                          onClick={() => void unarchiveEntries([entry])}
                        >
                          撤销
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cm-row-quick"
                          title={targetNote ? `归档到 ${targetNote}` : "先在批量栏选归档目标"}
                          disabled={busy || !targetVault || !targetNote}
                          onClick={() => void archiveEntries([entry])}
                        >
                          归档
                        </button>
                      )}
                      <button
                        type="button"
                        className={`cm-icon-btn cm-row-more${rowMenu === key ? " is-on" : ""}`}
                        title="更多操作"
                        onClick={() => setRowMenu(rowMenu === key ? null : key)}
                      >
                        ⋯
                      </button>
                      {rowMenu === key && (
                        <div className="cm-pop cm-pop-right">
                          <button
                            type="button"
                            className="cm-pop-item"
                            onClick={() => {
                              void navigator.clipboard.writeText(entry.text).then(
                                () => notice("已复制速记文本"),
                                () => notice("复制失败：剪贴板不可用", "error"),
                              );
                              setRowMenu(null);
                            }}
                          >
                            复制文本
                          </button>
                          <div className="cm-pop-sep" />
                          <button
                            type="button"
                            className="cm-pop-item cm-pop-danger"
                            disabled={busy}
                            onClick={() => {
                              setRowMenu(null);
                              void deleteEntries([entry]);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* -------------------------------------------------------- 快捷操作提示 */}
      <div className="cm-hints">
        <span>
          <kbd>{IS_MAC ? "⌘" : "Ctrl"}</kbd> <kbd>Enter</kbd> 新建
        </span>
        <span>
          <kbd>A</kbd> 归档
        </span>
        <span>
          <kbd>Esc</kbd> 返回
        </span>
      </div>

      {/* -------------------------------------------------------- 详情抽屉 */}
      {drawerEntry && (
        <>
          <div className="cm-drawer-backdrop" onClick={() => setDrawerKey(null)} />
          <aside className="cm-drawer">
            <div className="cm-drawer-head">
              <span className="cm-drawer-title">速记详情</span>
              <span className="cm-spacer" />
              <button type="button" className="cm-icon-btn" title="关闭 (Esc)" onClick={() => setDrawerKey(null)}>
                <IconX size={14} />
              </button>
            </div>
            <div className="cm-drawer-body">
              <div className="cm-field">
                <div className="cm-field-label">时间</div>
                <div className="cm-field-value">{drawerEntry.timestamp ?? "未标注时间"}</div>
              </div>
              <div className="cm-field">
                <div className="cm-field-label">内容</div>
                {editKey === keyOf(drawerEntry) ? (
                  <textarea
                    autoFocus
                    className="cm-drawer-edit"
                    rows={4}
                    value={editDraft}
                    onChange={(event) => setEditDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        void saveEdit(drawerEntry, editDraft).then((saved) => {
                          if (saved) setEditKey(null);
                        });
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditKey(null);
                      }
                    }}
                  />
                ) : (
                  <div className="cm-field-value cm-drawer-text">{drawerEntry.text}</div>
                )}
              </div>
              <div className="cm-field">
                <div className="cm-field-label">标签</div>
                <div className="cm-drawer-tags">
                  {drawerEntry.tags.map((tag) => (
                    <span key={tag} className="cm-tag">
                      #{tag}
                    </span>
                  ))}
                  {drawerEntry.tags.length === 0 && <span className="cm-field-dim">无标签</span>}
                </div>
              </div>
              <div className="cm-field">
                <div className="cm-field-label">来源</div>
                <div className="cm-field-value cm-field-dim">{drawerEntry.source ?? "未记录来源"}</div>
              </div>
              <div className="cm-field">
                <div className="cm-field-label">归档目标</div>
                <div className="cm-drawer-target">
                  <div className="cm-tool">
                    <button
                      type="button"
                      className="cm-btn cm-batch-target"
                      title={targetNote ? `归档目标：${targetNote}` : "选择归档目标笔记"}
                      onClick={() => (popover === "target" ? setPopover(null) : openTargetPicker())}
                    >
                      <IconFolder size={12} />
                      {targetNote
                        ? `移动到 ${targetNote.slice(targetNote.lastIndexOf("/") + 1)}`
                        : "移动到…"}
                    </button>
                    {popover === "target" && targetPicker("cm-pop-right")}
                  </div>
                </div>
              </div>
            </div>
            <div className="cm-drawer-foot">
              <button
                type="button"
                className="cm-btn cm-btn-danger"
                disabled={busy}
                onClick={() => {
                  const entry = drawerEntry;
                  setDrawerKey(null);
                  void deleteEntries([entry]);
                }}
              >
                删除
              </button>
              <span className="cm-spacer" />
              {drawerEntry.archived ? (
                <button
                  type="button"
                  className="cm-btn"
                  disabled={busy}
                  onClick={() => {
                    const entry = drawerEntry;
                    setDrawerKey(null);
                    void unarchiveEntries([entry]);
                  }}
                >
                  撤销归档
                </button>
              ) : (
                <button
                  type="button"
                  className="cm-btn cm-btn-primary"
                  disabled={busy || !targetVault || !targetNote}
                  onClick={() => {
                    const entry = drawerEntry;
                    setDrawerKey(null);
                    void archiveEntries([entry]);
                  }}
                >
                  归档
                </button>
              )}
            </div>
          </aside>
        </>
      )}

      {/* -------------------------------------------------------- Toast */}
      {toast && (
        <div className="cm-toast">
          <span>{toast.text}</span>
          {toast.undo && (
            <button type="button" className="cm-toast-undo" onClick={() => {
              toast.undo?.();
              setToast(null);
            }}>
              撤销
            </button>
          )}
        </div>
      )}
    </div>
  );
}

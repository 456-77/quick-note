/**
 * 语句库管理（0.39 用户反馈「语句库完全放弃现有页面设计，从零开始复用速记管理
 * 面板」）：整页结构完全照搬 CaptureManager（Inbox）——cm-root 页头（标题/
 * 副标题/统计/搜索/刷新/⋯/关闭）、cm-seg 分段（数据表 / Java 实体）、
 * cm-toolbar（筛选/标签/日期/排序 + active chips + 计数，勾选后原位切批量栏）、
 * cm-list 行（勾选框 + 名字/预览 + 时间/分组/标签/COMMENT meta + 行尾
 * 「定位/标签/⋯」）、cm-empty 空态、cm-hints 快捷提示、cm-drawer 详情抽屉
 * （备注 + 标签 chips + SQL/Java 关键字高亮语句）。
 *
 * 二轮反馈落点：
 * - 「点击行上的标签按钮显示交互逻辑对齐速记」：行上 标签 按钮 = Inbox 同款
 *   行内输入框（Enter 添加并关闭 · Esc 取消 · 失焦也添加），不再是开抽屉；
 * - 「对齐速记的筛选按钮」：工具栏 筛选/标签/日期/排序 四件套同 Inbox；
 * - 「目前 ddl 添加时没有设置时间，类似地给 ddl 也添加时间」：收录时在语句
 *   上方写 `-- @time: YYYY-MM-DD HH:mm`（App 侧 nowStamp），行上显示时间、
 *   日期筛选与「最新收录」排序、按 今天/昨天/更早 分组都吃这个字段；
 * - 「在 ddl 行上显示 comment，点击行进入详情要支持关键字高亮」：行 meta 里
 *   展示表级 COMMENT（lib/ddl.ts 的 tableCommentOf），抽屉语句块用
 *   tokenizeSql/tokenizeJava 上色（与 DDL 悬浮卡同一组 qn-sql-* 类）。
 *
 * 标签语义：一条语句可挂多个标签，落盘是语句上方的 `@tags` 行（没有时回落
 * `## 项目` 段落名）；批量「添加标签」与现有标签取并集，绝不误删。
 * 增删改的落盘都在 App 侧（读盘-改-写盘-重载一条线），组件只管展示与触发。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ddlEntryName,
  entryTimeOf,
  tableCommentOf,
  tokenizeSql,
  type DdlLibrary,
} from "../lib/ddl";
import type { ClassLibrary } from "../lib/javaEntity";
import { tokenizeJava } from "../lib/javaEntity";
import { normalizeTagName } from "../lib/tags";
import { IconCalendar, IconFilter, IconListTree, IconRefresh, IconTag, IconX } from "./icons";

export type LibraryKind = "ddl" | "java";

interface LibraryRow {
  /** 库 Map 的键（表名小写 / 类名原名），定位/删除用它。 */
  key: string;
  /** 显示名（表名从语句里反查原大小写；类名即键）。 */
  name: string;
  /** 生效标签（显式 @tags 行；没有该行时=段落名）。 */
  tags: string[];
  /** 语句所在段落（落盘定位/删除/标签的定位键，不直接展示成「项目」）。 */
  project: string;
  /** 收录时间（@time 行；老语句没有=undefined）。 */
  time?: string;
  /** 表级 COMMENT（仅 DDL；行 meta 与抽屉备注展示）。 */
  comment: string | null;
  ddl: string;
  kind: LibraryKind;
}

/** 行身份：库 + 键 + 所在段落（同名语句可在不同段落各存一份）。 */
function rowIdOf(row: LibraryRow): string {
  return `${row.kind}\u0000${row.key}\u0000${row.project}`;
}

/** 「无标签」筛选的哨兵值。 */
const NO_TAG = "\u0000none";

/** 语句的第一行（行预览用）：剥掉空行与围栏残留。 */
function firstLine(ddl: string): string {
  const line = ddl.split("\n").find((part) => part.trim() !== "") ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

type SortKey = "newest" | "oldest" | "nameAsc" | "nameDesc";
type DateRange = "any" | "today" | "yesterday" | "7d" | "30d";

const SORT_LABELS: Record<SortKey, string> = {
  newest: "最新收录",
  oldest: "最早收录",
  nameAsc: "名称 A→Z",
  nameDesc: "名称 Z→A",
};

const DATE_LABELS: Record<Exclude<DateRange, "any">, string> = {
  today: "今天",
  yesterday: "昨天",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
};

/** 本地日期串（YYYY-MM-DD；toISOString 是 UTC，不能用）。 */
function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** 行上的时间：今天显示 HH:mm，更早 MM-DD HH:mm（同 Inbox 口径）。 */
function fmtRowTime(time: string | undefined, today: string): string {
  const ts = entryTimeOf(time);
  if (!ts) return "";
  const date = new Date(ts);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const day = localDate(date);
  return day === today ? hhmm : `${day.slice(5)} ${hhmm}`;
}

/**
 * 抽屉里的语句块：tokenizeSql/tokenizeJava 上色（与 DDL 悬浮卡同一组
 * qn-sql-* 类）；token 之间的空隙按原文穿插普通文本，`pre` 保留换行与缩进。
 */
function HighlightedCode({ code, lang }: { code: string; lang: "sql" | "java" }) {
  const nodes = useMemo(() => {
    const tokens = lang === "java" ? tokenizeJava(code) : tokenizeSql(code);
    const out: ReactNode[] = [];
    let cursor = 0;
    tokens.forEach((token, index) => {
      if (token.from > cursor) out.push(code.slice(cursor, token.from));
      out.push(
        <span key={index} className={`qn-sql-${token.cls}`}>
          {token.text}
        </span>,
      );
      cursor = token.from + token.text.length;
    });
    if (cursor < code.length) out.push(code.slice(cursor));
    return out;
  }, [code, lang]);
  return <pre className="lib-drawer-code">{nodes}</pre>;
}

type Toast = { text: string; kind: "ok" | "error" } | null;

export default function LibraryManagerDialog({
  onClose,
  tables,
  classes,
  ddlPath,
  javaPath,
  onJump,
  onDelete,
  onSetTags,
  onBatchDelete,
  onOpenNote,
  onRefresh,
}: {
  onClose: () => void;
  /** 表名（小写键）→ 语句；Java 实体同名用 classes。 */
  tables: DdlLibrary;
  classes: ClassLibrary;
  ddlPath: string;
  /** 实体库笔记路径；空串 = 实体库关闭（隐藏分段）。 */
  javaPath: string;
  onJump: (kind: LibraryKind, name: string, project: string) => void;
  /** 落盘由父组件做；抛错显示在面板里。project = 语句所在段落（定位键）。 */
  onDelete: (kind: LibraryKind, name: string, project: string) => Promise<string>;
  /**
   * 设置/添加标签：items 是（名, 所在段落）对；mode="set" 整组覆盖，
   * "add" 与现有标签取并集。一次读盘批量改一次写盘。
   */
  onSetTags: (
    kind: LibraryKind,
    items: { name: string; project: string }[],
    tags: string[],
    mode: "set" | "add",
  ) => Promise<string>;
  /** 批量删除。 */
  onBatchDelete: (kind: LibraryKind, items: { name: string; project: string }[]) => Promise<string>;
  onOpenNote: (kind: LibraryKind) => void;
  /** 重新读取仓库里的库笔记（页头刷新钮）。 */
  onRefresh?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [libFilter, setLibFilter] = useState<LibraryKind>("ddl");
  const [tagSel, setTagSel] = useState<Set<string>>(new Set());
  /** 分组筛选（多选，OR 语义；空集=全部分组）。 */
  const [groupSel, setGroupSel] = useState<Set<string>>(new Set());
  const [dateRange, setDateRange] = useState<DateRange>("any");
  const [sort, setSort] = useState<SortKey>("newest");
  const [tagSearch, setTagSearch] = useState("");
  const [popover, setPopover] = useState<"group" | "tags" | "date" | "sort" | "more" | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  /** 行上「标签」按钮的行内输入框（Inbox 同款；一次只有一行在加）。 */
  const [tagEditKey, setTagEditKey] = useState<string | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const [drawerTagDraft, setDrawerTagDraft] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagDraft, setBulkTagDraft] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState(false);
  /** 两步确认删除（行菜单 / 抽屉共用）。 */
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const lastCheckedRef = useRef<string | null>(null);

  const today = localDate(new Date());
  const yesterday = localDate(new Date(Date.now() - 86400000));

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Esc 的消费顺序：详情抽屉 → 菜单/弹层 → 交给 App 关整页（App 派发
  // qn-library-esc 并检查 preventDefault，见 App 的全局 Esc）
  useEffect(() => {
    const onEsc = (event: Event) => {
      if (drawerKey) {
        event.preventDefault();
        setDrawerKey(null);
        return;
      }
      if (popover || rowMenu) {
        event.preventDefault();
        setPopover(null);
        setRowMenu(null);
      }
    };
    window.addEventListener("qn-library-esc", onEsc);
    return () => window.removeEventListener("qn-library-esc", onEsc);
  }, [drawerKey, popover, rowMenu]);

  const includeJava = javaPath.trim() !== "";
  // 实体库关闭（javaPath 空）时锁在数据表分段
  const activeLib: LibraryKind = includeJava ? libFilter : "ddl";

  const rows: LibraryRow[] = useMemo(() => {
    const out: LibraryRow[] = [];
    for (const [key, entries] of tables) {
      for (const entry of entries) {
        out.push({
          key,
          name: ddlEntryName(entry.ddl) || key,
          tags: entry.tags,
          project: entry.project,
          time: entry.time,
          comment: tableCommentOf(entry.ddl),
          ddl: entry.ddl,
          kind: "ddl",
        });
      }
    }
    if (includeJava) {
      for (const [key, entries] of classes) {
        for (const entry of entries) {
          out.push({
            key,
            name: key,
            tags: entry.tags,
            project: entry.project,
            time: entry.time,
            comment: null,
            ddl: entry.ddl,
            kind: "java",
          });
        }
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, "en") || a.kind.localeCompare(b.kind));
    return out;
  }, [tables, classes, includeJava]);

  const scoped = useMemo(() => rows.filter((row) => row.kind === activeLib), [rows, activeLib]);

  /** 标签聚合（筛选弹层用；多标签行在每个标签下各计一次）。 */
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let untagged = 0;
    for (const row of scoped) {
      if (row.tags.length === 0) untagged += 1;
      for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const tags = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
    return { tags, untagged };
  }, [scoped]);

  /** 分组聚合（段落名；「筛选」弹层用）。 */
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of scoped) counts.set(row.project, (counts.get(row.project) ?? 0) + 1);
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) =>
        a.name === "" ? -1 : b.name === "" ? 1 : a.name.localeCompare(b.name, "zh"),
      );
  }, [scoped]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return scoped.filter((row) => {
      if (groupSel.size > 0 && !groupSel.has(row.project)) return false;
      if (tagSel.size > 0) {
        const hit = [...tagSel].some((tag) =>
          tag === NO_TAG ? row.tags.length === 0 : row.tags.includes(tag),
        );
        if (!hit) return false;
      }
      if (dateRange !== "any") {
        const ts = entryTimeOf(row.time);
        if (!ts) return false;
        const day = localDate(new Date(ts));
        if (dateRange === "today" && day !== today) return false;
        if (dateRange === "yesterday" && day !== yesterday) return false;
        if (dateRange === "7d" && ts < now - 7 * 86400000) return false;
        if (dateRange === "30d" && ts < now - 30 * 86400000) return false;
      }
      if (!q) return true;
      const hay = `${row.name}\n${row.tags.join(" ")}\n${row.project}\n${row.comment ?? ""}\n${firstLine(row.ddl)}`;
      return hay.toLowerCase().includes(q);
    });
  }, [scoped, query, tagSel, groupSel, dateRange, today, yesterday]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    if (sort === "nameAsc") {
      list.sort((a, b) => a.name.localeCompare(b.name, "en") || a.kind.localeCompare(b.kind));
    } else if (sort === "nameDesc") {
      list.sort((a, b) => b.name.localeCompare(a.name, "en") || a.kind.localeCompare(b.kind));
    } else if (sort === "oldest") {
      list.sort((a, b) => entryTimeOf(a.time) - entryTimeOf(b.time));
    } else {
      list.sort((a, b) => entryTimeOf(b.time) - entryTimeOf(a.time));
    }
    return list;
  }, [filtered, sort]);

  /** 日期分组：今天 / 昨天 / 更早（按收录时间；名称排序时不分组）。 */
  const groups = useMemo(() => {
    if (sort === "nameAsc" || sort === "nameDesc") {
      return [{ key: "all", label: "", rows: sorted }];
    }
    const order: { key: string; label: string; rows: LibraryRow[] }[] = [
      { key: "today", label: "今天", rows: [] },
      { key: "yesterday", label: "昨天", rows: [] },
      { key: "earlier", label: "更早", rows: [] },
    ];
    const map = new Map(order.map((group) => [group.key, group]));
    for (const row of sorted) {
      const ts = entryTimeOf(row.time);
      const day = ts ? localDate(new Date(ts)) : "";
      const bucket = day === today ? "today" : day === yesterday ? "yesterday" : "earlier";
      map.get(bucket)!.rows.push(row);
    }
    return order.filter((group) => group.rows.length > 0);
  }, [sorted, today, yesterday, sort]);

  /** 渲染顺序（Shift 范围多选 / 全选的基准）。 */
  const visibleRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

  const drawerRow = drawerKey
    ? rows.find((row) => rowIdOf(row) === drawerKey) ?? null
    : null;
  // 语句被删掉后抽屉自动收起
  useEffect(() => {
    if (drawerKey && !drawerRow) setDrawerKey(null);
  }, [drawerKey, drawerRow]);
  // 换一条语句时清空抽屉里的标签草稿
  useEffect(() => {
    setDrawerTagDraft("");
  }, [drawerKey]);

  const rowById = (id: string | null) => (id ? rows.find((row) => rowIdOf(row) === id) ?? null : null);

  const clearSel = () => {
    setSel(new Set());
    setBulkTagOpen(false);
    setBulkConfirm(false);
    setBulkTagDraft("");
  };
  const resetFilters = () => {
    setTagSel(new Set());
    setGroupSel(new Set());
    setDateRange("any");
    setConfirmKey(null);
    clearSel();
  };
  const switchLib = (kind: LibraryKind) => {
    setLibFilter(kind);
    setQuery("");
    resetFilters();
    setPopover(null);
    setRowMenu(null);
    setDrawerKey(null);
  };

  const toggleTagFilter = (tag: string) => {
    setTagSel((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
    setConfirmKey(null);
    clearSel();
  };

  const toggleGroupFilter = (name: string) => {
    setGroupSel((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setConfirmKey(null);
    clearSel();
  };

  const toggleSel = (id: string, range = false, from?: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (range) {
        const ordered = visibleRows.map((row) => rowIdOf(row));
        const a = ordered.indexOf(from ?? id);
        const b = ordered.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) next.add(ordered[i]);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastCheckedRef.current = id;
  };

  /** 批量添加标签（与现有标签取并集；Inbox 批量「添加标签」同口径）。 */
  const addBulkTag = async () => {
    const tag = normalizeTagName(bulkTagDraft);
    if (!tag) {
      setToast({ text: "标签名不合法（不能含空格）", kind: "error" });
      return;
    }
    if (sel.size === 0) return;
    setBusy(true);
    try {
      const text = await onSetTags(
        activeLib,
        [...sel]
          .map((id) => rowById(id))
          .filter((row): row is LibraryRow => row !== null)
          .map((row) => ({ name: row.name, project: row.project })),
        [tag],
        "add",
      );
      setToast({ text, kind: "ok" });
      clearSel();
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  /** 行上「标签」输入框的提交（Inbox 同款：追加一个标签）。 */
  const addRowTag = async (row: LibraryRow, rawName: string) => {
    const tag = normalizeTagName(rawName);
    if (!tag) {
      setToast({ text: "标签名不合法（不能含空格）", kind: "error" });
      return;
    }
    if (row.tags.some((entry) => entry.toLowerCase() === tag.toLowerCase())) {
      setToast({ text: `「${row.name}」已带有 #${tag}`, kind: "ok" });
      return;
    }
    setBusy(true);
    try {
      const text = await onSetTags(
        row.kind,
        [{ name: row.name, project: row.project }],
        [...row.tags, tag],
        "set",
      );
      setToast({ text, kind: "ok" });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  /** 抽屉里加/删标签（整组覆盖）。 */
  const setDrawerTags = async (tags: string[], okText: string) => {
    if (!drawerRow) return;
    setBusy(true);
    try {
      const text = await onSetTags(
        drawerRow.kind,
        [{ name: drawerRow.name, project: drawerRow.project }],
        tags,
        "set",
      );
      setToast({ text: text || okText, kind: "ok" });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const addDrawerTag = async () => {
    const tag = normalizeTagName(drawerTagDraft);
    if (!tag || !drawerRow) return;
    if (drawerRow.tags.some((entry) => entry.toLowerCase() === tag.toLowerCase())) {
      setDrawerTagDraft("");
      return;
    }
    await setDrawerTags([...drawerRow.tags, tag], `已给「${drawerRow.name}」加上 #${tag}`);
    setDrawerTagDraft("");
  };

  const removeDrawerTag = async (tag: string) => {
    if (!drawerRow) return;
    await setDrawerTags(
      drawerRow.tags.filter((entry) => entry !== tag),
      `已移除标签 #${tag}`,
    );
  };

  const copyStatement = async (row: LibraryRow) => {
    try {
      await navigator.clipboard.writeText(row.ddl);
      setToast({ text: `已复制「${row.name}」的${row.kind === "ddl" ? "建表语句" : "源码"}`, kind: "ok" });
    } catch {
      setToast({ text: "复制失败：剪贴板不可用", kind: "error" });
    }
  };

  const runDelete = async (row: LibraryRow) => {
    const id = rowIdOf(row);
    if (confirmKey !== id) {
      setConfirmKey(id);
      return;
    }
    setBusy(true);
    try {
      const text = await onDelete(row.kind, row.name, row.project);
      setToast({ text, kind: "ok" });
      if (drawerKey === id) setDrawerKey(null);
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
      setConfirmKey(null);
      setRowMenu(null);
    }
  };

  const runBulkDelete = async () => {
    if (sel.size === 0) return;
    if (!bulkConfirm) {
      setBulkConfirm(true);
      return;
    }
    setBusy(true);
    try {
      const text = await onBatchDelete(
        activeLib,
        [...sel]
          .map((id) => rowById(id))
          .filter((row): row is LibraryRow => row !== null)
          .map((row) => ({ name: row.name, project: row.project })),
      );
      setToast({ text, kind: "ok" });
      clearSel();
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
      setBulkConfirm(false);
    }
  };

  const selectAllVisible = () => {
    setSel(new Set(visibleRows.map((row) => rowIdOf(row))));
    setPopover(null);
  };

  const activeChips: { label: string; clear: () => void }[] = [];
  for (const name of groupSel) {
    activeChips.push({
      label: `分组：${name || "未分组"}`,
      clear: () => {
        setGroupSel((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
        setConfirmKey(null);
        clearSel();
      },
    });
  }
  for (const tag of tagSel) {
    activeChips.push({
      label: tag === NO_TAG ? "无标签" : `#${tag}`,
      clear: () => {
        setTagSel((prev) => {
          const next = new Set(prev);
          next.delete(tag);
          return next;
        });
        setConfirmKey(null);
        clearSel();
      },
    });
  }
  if (dateRange !== "any") {
    activeChips.push({
      label: DATE_LABELS[dateRange],
      clear: () => {
        setDateRange("any");
        setConfirmKey(null);
        clearSel();
      },
    });
  }
  if (sort !== "newest") {
    activeChips.push({
      label: SORT_LABELS[sort],
      clear: () => {
        setSort("newest");
        setConfirmKey(null);
        clearSel();
      },
    });
  }

  const tagList = tagCounts.tags.filter(
    (tag) => !tagSearch.trim() || tag.name.toLowerCase().includes(tagSearch.trim().toLowerCase()),
  );

  return (
    <div className="cm-root lib-page">
      {/* ------------------------------------------------------------ 页头 */}
      <div className="cm-head">
        <div className="cm-head-titles">
          <h2 className="cm-title">语句库</h2>
          <p className="cm-subtitle">查看、定位与整理已收录的数据表 / 实体类</p>
        </div>
        <span className="cm-spacer" />
        <span className="cm-head-stats" title="已收录的数据表与实体类数量">
          <b>{tables.size}</b> 数据表
          {includeJava && (
            <>
              <i>·</i>
              <b>{classes.size}</b> 实体类
            </>
          )}
        </span>
        <input
          type="text"
          className="cm-search"
          value={query}
          placeholder="搜索表名 / 类名 / 标签…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (query) setQuery("");
              else onClose();
            }
          }}
        />
        {onRefresh && (
          <button type="button" className="cm-icon-btn" title="重新读取库笔记" onClick={onRefresh}>
            <IconRefresh size={14} />
          </button>
        )}
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
              <button type="button" className="cm-pop-item" onClick={selectAllVisible}>
                全选当前视图（{visibleRows.length}）
              </button>
              <button
                type="button"
                className="cm-pop-item"
                disabled={sel.size === 0}
                onClick={() => {
                  clearSel();
                  setPopover(null);
                }}
              >
                取消全选
              </button>
              <div className="cm-pop-sep" />
              <button
                type="button"
                className="cm-pop-item"
                onClick={() => {
                  setPopover(null);
                  onOpenNote("ddl");
                }}
              >
                打开 {ddlPath}
              </button>
              {includeJava && (
                <button
                  type="button"
                  className="cm-pop-item"
                  onClick={() => {
                    setPopover(null);
                    onOpenNote("java");
                  }}
                >
                  打开 {javaPath}
                </button>
              )}
            </div>
          )}
        </div>
        <button type="button" className="cm-icon-btn" title="返回笔记 (Esc)" onClick={onClose}>
          <IconX size={15} />
        </button>
      </div>

      {/* -------------------------------------------------------- 分段切换 */}
      <div className="cm-seg" role="tablist" aria-label="语句库类型">
        <button
          type="button"
          role="tab"
          aria-selected={activeLib === "ddl"}
          className={`cm-seg-btn${activeLib === "ddl" ? " is-on" : ""}`}
          onClick={() => switchLib("ddl")}
        >
          数据表
          <span className="cm-seg-count">{tables.size}</span>
        </button>
        {includeJava && (
          <button
            type="button"
            role="tab"
            aria-selected={activeLib === "java"}
            className={`cm-seg-btn${activeLib === "java" ? " is-on" : ""}`}
            onClick={() => switchLib("java")}
          >
            Java 实体
            <span className="cm-seg-count">{classes.size}</span>
          </button>
        )}
      </div>

      {/* --------- 工具栏：普通态=筛选入口；勾选后=批量模式（原位切换） --------- */}
      <div className={`cm-toolbar${sel.size > 0 ? " is-batch" : ""}`}>
        {sel.size > 0 ? (
          <>
            <span className="cm-batch-count">已选择 {sel.size} 条</span>
            <span className="cm-batch-sep" />
            {bulkTagOpen ? (
              <input
                autoFocus
                type="text"
                className="cm-batch-tag-input"
                value={bulkTagDraft}
                placeholder="标签名（不含 #，Enter 添加）"
                onChange={(event) => setBulkTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addBulkTag();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setBulkTagOpen(false);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="cm-btn"
                disabled={busy}
                title="给选中的语句添加一个标签（与现有标签取并集）"
                onClick={() => {
                  setBulkTagDraft("");
                  setBulkTagOpen(true);
                  setBulkConfirm(false);
                }}
              >
                添加标签
              </button>
            )}
            <button
              type="button"
              className={`cm-btn${bulkConfirm ? " cm-btn-danger" : ""}`}
              disabled={busy}
              title={bulkConfirm ? "再点一次确认删除（不可恢复）" : "从库笔记里删除选中的语句"}
              onClick={() => void runBulkDelete()}
            >
              {bulkConfirm ? `确认删除 ${sel.size} 条？` : "删除"}
            </button>
            <button type="button" className="cm-btn cm-btn-ghost" onClick={clearSel}>
              取消
            </button>
            <span className="cm-spacer" />
            <span className="cm-scan-meta">{visibleRows.length} 条可见</span>
          </>
        ) : (
          <>
            {/* 「筛选」= 按分组（库笔记 ## 段落），Inbox 的来源筛选同款 */}
            <div className="cm-tool">
              <button
                type="button"
                className={`cm-tool-btn${groupSel.size > 0 ? " is-on" : ""}`}
                onClick={() => setPopover(popover === "group" ? null : "group")}
              >
                <IconFilter size={12} /> 筛选
              </button>
              {popover === "group" && (
                <div className="cm-pop">
                  <div className="cm-pop-title">按分组筛选</div>
                  <div className="cm-pop-list">
                    {groupCounts.map((group) => (
                      <label key={group.name || "\u0000"} className="cm-pop-row">
                        <input
                          type="checkbox"
                          checked={groupSel.has(group.name)}
                          onChange={() => toggleGroupFilter(group.name)}
                        />
                        <span className="cm-pop-row-name">{group.name || "未分组"}</span>
                        <span className="cm-spacer" />
                        <span className="cm-pop-row-count">{group.count}</span>
                      </label>
                    ))}
                    {groupCounts.length === 0 && <div className="cm-pop-empty">还没有分组</div>}
                  </div>
                  {groupSel.size > 0 && (
                    <button
                      type="button"
                      className="cm-pop-clear"
                      onClick={() => setGroupSel(new Set())}
                    >
                      清除分组筛选
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
                <IconTag size={12} /> 标签
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
                    {tagList.map((tag) => (
                      <label key={tag.name} className="cm-pop-row">
                        <input
                          type="checkbox"
                          checked={tagSel.has(tag.name)}
                          onChange={() => toggleTagFilter(tag.name)}
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
                          onChange={() => toggleTagFilter(NO_TAG)}
                        />
                        <span className="cm-pop-row-name">无标签</span>
                        <span className="cm-spacer" />
                        <span className="cm-pop-row-count">{tagCounts.untagged}</span>
                      </label>
                    )}
                    {tagCounts.tags.length === 0 && tagCounts.untagged === 0 && (
                      <div className="cm-pop-empty">这个库里还没有语句</div>
                    )}
                    {tagCounts.tags.length > 0 && tagList.length === 0 && (
                      <div className="cm-pop-empty">没有匹配的标签</div>
                    )}
                  </div>
                  {tagSel.size > 0 && (
                    <button
                      type="button"
                      className="cm-pop-clear"
                      onClick={() => setTagSel(new Set())}
                    >
                      清除标签筛选
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="cm-tool">
              <button
                type="button"
                className={`cm-tool-btn${dateRange !== "any" ? " is-on" : ""}`}
                onClick={() => setPopover(popover === "date" ? null : "date")}
              >
                <IconCalendar size={12} /> 日期
              </button>
              {popover === "date" && (
                <div className="cm-pop">
                  {(["any", "today", "yesterday", "7d", "30d"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`cm-pop-item${dateRange === value ? " is-on" : ""}`}
                      onClick={() => {
                        setDateRange(value);
                        setPopover(null);
                      }}
                    >
                      {value === "any" ? "全部日期" : DATE_LABELS[value]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="cm-tool">
              <button
                type="button"
                className={`cm-tool-btn${sort !== "newest" ? " is-on" : ""}`}
                onClick={() => setPopover(popover === "sort" ? null : "sort")}
              >
                <IconListTree size={12} /> 排序
              </button>
              {popover === "sort" && (
                <div className="cm-pop">
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={`cm-pop-item${sort === key ? " is-on" : ""}`}
                      onClick={() => {
                        setSort(key);
                        setPopover(null);
                      }}
                    >
                      {SORT_LABELS[key]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {activeChips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                className="cm-chip"
                title="移除这个筛选"
                onClick={chip.clear}
              >
                {chip.label}
                <IconX size={10} />
              </button>
            ))}
            <span className="cm-spacer" />
            <span className="cm-scan-meta">
              {filtered.length} / {scoped.length} 条
            </span>
          </>
        )}
      </div>
      {(popover || rowMenu) && (
        <div
          className="cm-pop-backdrop"
          onClick={() => {
            setPopover(null);
            setRowMenu(null);
            setConfirmKey(null);
          }}
        />
      )}

      {/* -------------------------------------------------------- 列表 */}
      <div className="cm-list">
        {scoped.length === 0 ? (
          <div className="cm-empty">
            <div className="cm-empty-icon">▤</div>
            <p className="cm-empty-title">
              {activeLib === "ddl" ? "库里还没有建表语句" : "库里还没有实体类"}
            </p>
            <p className="cm-empty-hint">
              用「收录语句」弹窗（默认 Ctrl+Alt+J）粘贴 CREATE TABLE 或 Java
              类源码即可收录，收录后可在笔记里悬浮查看。
            </p>
            <button type="button" className="cm-btn cm-btn-primary" onClick={() => onOpenNote(activeLib)}>
              打开库笔记
            </button>
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="cm-empty">
            <div className="cm-empty-icon">🔎</div>
            <p className="cm-empty-title">没有匹配的语句</p>
            <p className="cm-empty-hint">换个关键词，或清除筛选条件。</p>
            <button type="button" className="cm-btn" onClick={() => { setQuery(""); resetFilters(); }}>
              清除筛选
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key} className="cm-group">
              {group.label && <div className="cm-group-head">{group.label}</div>}
              {group.rows.map((row) => {
                const id = rowIdOf(row);
                const menuOpen = rowMenu === id;
                const tagEditing = tagEditKey === id;
                return (
                  <div
                    key={id}
                    className={`cm-row${sel.has(id) ? " is-sel" : ""}`}
                    onClick={() => {
                      if (!menuOpen && !tagEditing) setDrawerKey(id);
                    }}
                  >
                    <input
                      type="checkbox"
                      className="cm-check"
                      checked={sel.has(id)}
                      onChange={() => toggleSel(id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (event.shiftKey && lastCheckedRef.current) {
                          event.preventDefault();
                          toggleSel(id, true, lastCheckedRef.current);
                        }
                      }}
                      title="勾选（Shift+点选范围多选）"
                    />
                    <div className="cm-row-main">
                      <div className="cm-row-text lib-row-name" title={row.name}>
                        {row.name}
                      </div>
                      <div className="lib-row-preview" title={row.ddl.slice(0, 300)}>
                        {firstLine(row.ddl)}
                      </div>
                      <div className="cm-row-meta">
                        {row.time && (
                          <>
                            <span className="cm-row-time">{fmtRowTime(row.time, today)}</span>
                            <span className="cm-meta-dot">·</span>
                          </>
                        )}
                        <span className="cm-row-state">
                          {row.project ? `分组 · ${row.project}` : "未分组"}
                        </span>
                        {row.tags.length > 0 && <span className="cm-meta-dot">·</span>}
                        {row.tags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className="cm-tag"
                            title={`筛选 #${tag}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleTagFilter(tag);
                            }}
                          >
                            #{tag}
                          </button>
                        ))}
                        {row.comment && (
                          <>
                            <span className="cm-meta-dot">·</span>
                            <span className="cm-row-src" title={row.comment}>
                              {row.comment}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="cm-tool cm-row-tool" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="cm-row-quick"
                        title="打开库笔记并跳到这一条"
                        disabled={busy}
                        onClick={() => onJump(row.kind, row.name, row.project)}
                      >
                        定位
                      </button>
                      {/* 0.39 二轮「点击行上的标签按钮显示交互逻辑对齐速记」：
                          行内输入框（Enter 添加并关闭 · Esc 取消 · 失焦也添加） */}
                      {tagEditing ? (
                        <input
                          autoFocus
                          ref={tagInputRef}
                          type="text"
                          className="cm-row-tag-input"
                          placeholder="标签名（Enter 加）"
                          title="Enter 添加并关闭 · Esc 取消"
                          disabled={busy}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              const name = normalizeTagName(tagInputRef.current?.value ?? "");
                              if (name) void addRowTag(row, name);
                              setTagEditKey(null);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              setTagEditKey(null);
                            }
                          }}
                          onBlur={() => {
                            const name = normalizeTagName(tagInputRef.current?.value ?? "");
                            if (name) void addRowTag(row, name);
                            setTagEditKey(null);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="cm-row-quick"
                          title="添加标签"
                          disabled={busy}
                          onClick={() => setTagEditKey(id)}
                        >
                          标签
                        </button>
                      )}
                      <button
                        type="button"
                        className={`cm-icon-btn cm-row-more${menuOpen ? " is-on" : ""}`}
                        title="更多操作"
                        onClick={() => {
                          setRowMenu(menuOpen ? null : id);
                          setConfirmKey(null);
                        }}
                      >
                        ⋯
                      </button>
                      {menuOpen && (
                        <div className="cm-pop cm-pop-right">
                          <button
                            type="button"
                            className="cm-pop-item"
                            onClick={() => {
                              setRowMenu(null);
                              setDrawerKey(id);
                            }}
                          >
                            详情 / 标签
                          </button>
                          <button
                            type="button"
                            className="cm-pop-item"
                            onClick={() => {
                              setRowMenu(null);
                              setTagEditKey(id);
                            }}
                          >
                            添加标签
                          </button>
                          <button
                            type="button"
                            className="cm-pop-item"
                            onClick={() => {
                              setRowMenu(null);
                              onJump(row.kind, row.name, row.project);
                            }}
                          >
                            定位
                          </button>
                          <button
                            type="button"
                            className="cm-pop-item"
                            onClick={() => {
                              setRowMenu(null);
                              void copyStatement(row);
                            }}
                          >
                            复制{row.kind === "ddl" ? "语句" : "源码"}
                          </button>
                          <div className="cm-pop-sep" />
                          <button
                            type="button"
                            className="cm-pop-item cm-pop-danger"
                            disabled={busy}
                            onClick={() => void runDelete(row)}
                          >
                            {confirmKey === id ? "确认删除？" : "删除"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* -------------------------------------------------------- 快捷提示 */}
      <div className="cm-hints">
        <span>
          <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>J</kbd> 收录
        </span>
        <span>
          <kbd>Esc</kbd> 返回
        </span>
      </div>

      {toast && <div className={`cm-toast${toast.kind === "error" ? " is-error" : ""}`}>{toast.text}</div>}

      {/* -------------------------------------------------------- 详情抽屉 */}
      {drawerRow && (
        <>
          <div className="cm-drawer-backdrop" onClick={() => setDrawerKey(null)} />
          <aside className="cm-drawer">
            <div className="cm-drawer-head">
              <span className="cm-drawer-title">
                {drawerRow.kind === "ddl" ? "数据表" : "实体类"}：{drawerRow.name}
              </span>
              <span className="cm-spacer" />
              <button
                type="button"
                className="cm-icon-btn"
                title="关闭 (Esc)"
                onClick={() => setDrawerKey(null)}
              >
                <IconX size={14} />
              </button>
            </div>
            <div className="cm-drawer-body">
              <div className="cm-field">
                <div className="cm-field-label">库</div>
                <div className="cm-field-value cm-field-dim">
                  {drawerRow.kind === "ddl" ? ddlPath : javaPath}
                </div>
              </div>
              <div className="cm-field">
                <div className="cm-field-label">分组</div>
                <div className="cm-field-value">{drawerRow.project || "未分组"}</div>
              </div>
              {drawerRow.time && (
                <div className="cm-field">
                  <div className="cm-field-label">收录时间</div>
                  <div className="cm-field-value cm-field-dim">{drawerRow.time}</div>
                </div>
              )}
              {drawerRow.comment && (
                <div className="cm-field">
                  <div className="cm-field-label">备注</div>
                  <div className="cm-field-value">{drawerRow.comment}</div>
                </div>
              )}
              <div className="cm-field">
                <div className="cm-field-label">标签（一条语句可挂多个）</div>
                <div className="cm-drawer-tags">
                  {drawerRow.tags.length === 0 && <span className="cm-field-dim">无标签</span>}
                  {drawerRow.tags.map((tag) => (
                    <span key={tag} className="cm-tag">
                      #{tag}
                      <button
                        type="button"
                        className="cm-tag-x"
                        title={`移除标签 #${tag}`}
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeDrawerTag(tag);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    className="cm-drawer-tag-input"
                    value={drawerTagDraft}
                    placeholder="＋ 标签"
                    title="Enter 添加标签 · Esc 清空"
                    disabled={busy}
                    onChange={(event) => setDrawerTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void addDrawerTag();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setDrawerTagDraft("");
                      }
                    }}
                  />
                </div>
              </div>
              <div className="cm-field">
                <div className="cm-field-label">语句（关键字高亮）</div>
                <HighlightedCode
                  code={drawerRow.ddl}
                  lang={drawerRow.kind === "ddl" ? "sql" : "java"}
                />
              </div>
            </div>
            <div className="cm-drawer-foot">
              <button
                type="button"
                className="cm-btn"
                onClick={() => onJump(drawerRow.kind, drawerRow.name, drawerRow.project)}
              >
                定位
              </button>
              <button type="button" className="cm-btn" onClick={() => void copyStatement(drawerRow)}>
                复制
              </button>
              <span className="cm-spacer" />
              <button
                type="button"
                className={`cm-btn${confirmKey === rowIdOf(drawerRow) ? " cm-btn-danger" : ""}`}
                disabled={busy}
                title={confirmKey === rowIdOf(drawerRow) ? "再点一次确认删除" : "从库笔记里删除这一条"}
                onClick={() => void runDelete(drawerRow)}
              >
                {confirmKey === rowIdOf(drawerRow) ? "确认删除？" : "删除"}
              </button>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

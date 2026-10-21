/**
 * 最近文件弹窗（0.27 用户反馈：类 IDEA 的 Ctrl+E）。
 *
 * 唤起后列出「最近打开」的文件：顶部搜索实时过滤（文件名/路径子串，大小写
 * 不敏感），下面一排目录筛选 chip（按一级目录聚合），↑↓ 选择、Enter 打开、
 * Esc 关闭。数据来自 App 的 recents（打开顺序即新鲜度），这里不另做 IO。
 *
 * 0.28 用户反馈「添加已编辑的筛选」：加一档「已编辑」，按文件 mtime 倒序
 * 列出最近改过的笔记（与「最近打开」正交——只读过没改的不会出现在这里）。
 * 数据来自 App 的文件索引 entries（每条带 modified），不另扫盘。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { EntryMeta } from "../lib/api";

/** 列表里最多展示多少条（recents 上限之外再截一层，弹窗不是文件管理器）。 */
const LIST_LIMIT = 30;
/** 「已编辑」来源最多取多少条（按 mtime 排序后截断）。 */
const EDITED_LIMIT = 80;
type Mode = "opened" | "edited";
/** 目录筛选 chip 的上限：一级目录太多时只留笔记数最多的几个。 */
const DIR_CHIP_LIMIT = 6;

export default function RecentFilesDialog({
  recents,
  entries,
  activePath,
  onOpen,
  onClose,
}: {
  recents: string[];
  /** 文件索引（「已编辑」用 mtime 排序；不含目录）。 */
  entries: EntryMeta[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("opened");
  const [dir, setDir] = useState<string>("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");

  /** 最近编辑的笔记：按 mtime 倒序（不随「最近打开」顺序变化）。 */
  const edited = useMemo(
    () =>
      entries
        .filter((entry) => !entry.isDir)
        .sort((a, b) => b.modified - a.modified)
        .slice(0, EDITED_LIMIT)
        .map((entry) => entry.path),
    [entries],
  );
  const source = mode === "edited" ? edited : recents;

  /** 目录 chip 候选：当前来源里按条数聚合的一级目录（搜索词也参与）。 */
  const dirChips = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const counts = new Map<string, number>();
    for (const path of source) {
      if (tokens.length > 0 && !tokens.every((t) => path.toLowerCase().includes(t))) continue;
      const d = dirOf(path);
      if (!d) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
      .slice(0, DIR_CHIP_LIMIT)
      .map(([name]) => name);
  }, [source, query]);

  const items = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = source;
    if (dir) list = list.filter((path) => dirOf(path) === dir);
    if (tokens.length > 0) list = list.filter((path) => tokens.every((t) => path.toLowerCase().includes(t)));
    return list.slice(0, LIST_LIMIT);
  }, [source, query, dir]);

  // 来源/过滤条件变了：目录筛选与选中项都回到第一项
  useEffect(() => {
    setCursor(0);
  }, [query, dir, mode]);
  useEffect(() => {
    setDir("");
  }, [mode]);

  // 选中项滚进可视区（键盘导航到列表下部时跟着走）
  useEffect(() => {
    const el = listRef.current?.querySelectorAll(".recent-item")[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const openAt = (index: number) => {
    const path = items[index];
    if (!path) return;
    onOpen(path);
    onClose();
  };

  return (
    <div
      className="recent-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="recent-dialog" role="dialog" aria-label="最近文件">
        <div className="recent-head">
          <span className="recent-title">最近文件</span>
          <span className="recent-count">{items.length} 项</span>
          <button type="button" className="recent-close" title="关闭（Esc）" onClick={onClose}>
            ×
          </button>
        </div>
        <input
          ref={searchRef}
          type="text"
          className="recent-search"
          placeholder="搜索文件名或路径…"
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((c) => Math.min(items.length - 1, c + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              openAt(cursor);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="recent-modes" role="tablist" aria-label="最近文件来源">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "opened"}
            className={`recent-mode${mode === "opened" ? " is-on" : ""}`}
            onClick={() => setMode("opened")}
            title="按打开顺序"
          >
            最近打开
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "edited"}
            className={`recent-mode${mode === "edited" ? " is-on" : ""}`}
            onClick={() => setMode("edited")}
            title="按最后修改时间排序（只包含被编辑过的文件）"
          >
            已编辑
          </button>
        </div>
        {dirChips.length > 0 && (
          <div className="recent-chips" role="tablist" aria-label="按目录筛选">
            <button
              type="button"
              role="tab"
              aria-selected={dir === ""}
              className={`recent-chip${dir === "" ? " is-on" : ""}`}
              onClick={() => setDir("")}
            >
              全部
            </button>
            {dirChips.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={dir === name}
                className={`recent-chip${dir === name ? " is-on" : ""}`}
                onClick={() => setDir(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        <div className="recent-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="recent-empty">
              {mode === "edited" ? "还没有编辑过的文件" : "没有匹配的最近文件"}
            </div>
          ) : (
            items.map((path, index) => {
              const slash = path.lastIndexOf("/");
              const name = slash >= 0 ? path.slice(slash + 1) : path;
              const folder = slash >= 0 ? path.slice(0, slash) : "";
              return (
                <button
                  key={path}
                  type="button"
                  className={`recent-item${index === cursor ? " is-active" : ""}${
                    path === activePath ? " is-open" : ""
                  }`}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => openAt(index)}
                  title={path}
                >
                  <span className="recent-name">{name}</span>
                  <span className="recent-dir">{folder}</span>
                </button>
              );
            })
          )}
        </div>
        <div className="recent-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  );
}

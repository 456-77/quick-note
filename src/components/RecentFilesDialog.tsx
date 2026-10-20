/**
 * 最近文件弹窗（0.27 用户反馈：类 IDEA 的 Ctrl+E）。
 *
 * 唤起后列出「最近打开」的文件：顶部搜索实时过滤（文件名/路径子串，大小写
 * 不敏感），下面一排目录筛选 chip（按一级目录聚合），↑↓ 选择、Enter 打开、
 * Esc 关闭。数据来自 App 的 recents（打开顺序即新鲜度），这里不另做 IO。
 *
 * 刻意不做时间筛选：recents 只存顺序没有时间戳，伪造「今天/本周」是假数据；
 * 顺序本身已经表达了「最近」。
 */

import { useEffect, useMemo, useRef, useState } from "react";

/** 列表里最多展示多少条（recents 上限之外再截一层，弹窗不是文件管理器）。 */
const LIST_LIMIT = 30;
/** 目录筛选 chip 的上限：一级目录太多时只留笔记数最多的几个。 */
const DIR_CHIP_LIMIT = 6;

export default function RecentFilesDialog({
  recents,
  activePath,
  onOpen,
  onClose,
}: {
  recents: string[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [dir, setDir] = useState<string>("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");

  /** 目录 chip 候选：全量 recents 里按条数聚合的一级目录（搜索词也参与）。 */
  const dirChips = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const counts = new Map<string, number>();
    for (const path of recents) {
      if (tokens.length > 0 && !tokens.every((t) => path.toLowerCase().includes(t))) continue;
      const d = dirOf(path);
      if (!d) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
      .slice(0, DIR_CHIP_LIMIT)
      .map(([name]) => name);
  }, [recents, query]);

  const items = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = recents;
    if (dir) list = list.filter((path) => dirOf(path) === dir);
    if (tokens.length > 0) list = list.filter((path) => tokens.every((t) => path.toLowerCase().includes(t)));
    return list.slice(0, LIST_LIMIT);
  }, [recents, query, dir]);

  // 过滤条件变了，选中项回到第一条
  useEffect(() => {
    setCursor(0);
  }, [query, dir]);

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
            <div className="recent-empty">没有匹配的最近文件</div>
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

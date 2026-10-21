/**
 * 标签仪表盘（知识库左侧栏的第四个视图）。
 *
 * 两级结构：先列**全仓库的标签**（按笔记数排序，「待整理」这类自动标签置顶），
 * 点进去看带这个标签的笔记。整理流程就是进来点「待整理」→ 逐条打开处理，
 * 处理完的在行上直接 × 掉标签（没有这个仪表盘时，散落的标签基本没人回头整理）。
 *
 * 标签索引由 App 扫描全仓库生成（这里是纯展示）；行上的 × 走 App 的统一
 * 移除路径——激活中的笔记在编辑器里改（保住撤销历史），没打开的直接改盘。
 *
 * 0.27：行内加了「重命名」（✎，就地输入新名，App 对所有带该标签的笔记做
 * `#旧 → #新` 多区间替换）与「置顶」（📌，置顶的标签排在自动标签之后、
 * 其余之前，按仓库记忆）。次要操作悬停才出现，不与标签名抢点击面积。
 */

import { useEffect, useRef, useState } from "react";
import { menuRefClampedToViewport } from "../lib/menuClamp";
import { normalizeTagName } from "../lib/tags";
import { IconTag, IconX } from "./icons";

export interface TagIndexEntry {
  name: string;
  notes: string[];
}

export default function TagDashboard({
  loading,
  tags,
  /** path → 这篇笔记的标签（笔记行的标签 chips 用）。 */
  noteTags,
  activeTag,
  /** 置顶的标签名（App 按仓库分桶记忆）。 */
  pinnedTags,
  onTogglePin,
  /** 重命名：对所有带该标签的笔记做替换；名字合法性在这里校验。 */
  onRename,
  onPickTag,
  onBack,
  activePath,
  onOpen,
  onRemoveTag,
}: {
  loading: boolean;
  tags: TagIndexEntry[];
  noteTags: Record<string, string[]>;
  activeTag: string | null;
  pinnedTags: string[];
  onTogglePin: (tag: string) => void;
  onRename: (from: string, to: string) => void;
  onPickTag: (tag: string) => void;
  onBack: () => void;
  activePath: string | null;
  onOpen: (path: string) => void;
  onRemoveTag: (path: string, tag: string) => void;
}) {
  /** 正在重命名的标签（null = 没有）；输入框的草稿跟着它。 */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** 行尾 ⋯ 菜单：当前标签 + 锚点（视口坐标）。 */
  const [rowMenu, setRowMenu] = useState<{ tag: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (renaming !== null) renameInputRef.current?.focus({ preventScroll: true });
  }, [renaming]);

  const startRename = (tag: string) => {
    setRenaming(tag);
    setDraft(tag);
  };

  const commitRename = () => {
    if (renaming === null) return;
    const next = normalizeTagName(draft);
    if (!next || next === renaming) {
      setRenaming(null);
      return;
    }
    if (tags.some((tag) => tag.name === next)) {
      // 重命名成已有标签 = 合并，语义上说得通，但要用户知情
      const ok = window.confirm(`标签「#${next}」已存在，重命名会把两个标签合并，继续吗？`);
      if (!ok) return;
    }
    const from = renaming;
    setRenaming(null);
    onRename(from, next);
  };

  if (tags.length === 0 && !loading) {
    return <div className="tree-empty">仓库里还没有标签。给笔记加 `#标签` 后会汇集在这里。</div>;
  }

  if (activeTag !== null) {
    const entry = tags.find((tag) => tag.name === activeTag);
    return (
      <div className="tag-dash">
        <button type="button" className="tag-dash-back" onClick={onBack}>
          ← 全部标签
        </button>
        <div className="tag-dash-head">
          <IconTag size={13} />
          <span className="tag-dash-name">{activeTag}</span>
          <span className="tag-dash-count">{entry?.notes.length ?? 0} 篇</span>
          <span className="spacer" />
          <button
            type="button"
            className={`tag-dash-act${pinnedTags.includes(activeTag) ? " is-on" : ""}`}
            title={pinnedTags.includes(activeTag) ? "取消置顶" : "置顶这个标签"}
            onClick={() => onTogglePin(activeTag)}
          >
            📌
          </button>
          <button
            type="button"
            className="tag-dash-act"
            title="重命名标签（对所有笔记生效）"
            onClick={() => startRename(activeTag)}
          >
            ✎
          </button>
        </div>
        {renaming === activeTag && (
          <div className="tag-dash-rename">
            <input
              ref={renameInputRef}
              type="text"
              value={draft}
              spellCheck={false}
              placeholder="新标签名"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setRenaming(null);
                }
              }}
            />
            <span className="tag-dash-rename-hint">回车确认 · Esc 取消</span>
          </div>
        )}
        {(entry?.notes ?? []).map((path) => (
          <div
            key={path}
            role="button"
            tabIndex={0}
            className={`tree-item tree-file${path === activePath ? " is-active" : ""}`}
            onClick={() => onOpen(path)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onOpen(path);
            }}
            title={`${path}（点击打开）`}
          >
            <IconTag size={13} className="tree-icon" />
            <span className="tree-label">{path.slice(path.lastIndexOf("/") + 1)}</span>
            <span className="tag-dash-chips">
              {(noteTags[path] ?? []).map((tag) => (
                <span key={tag} className="tag-dash-chip" title={`标签 ${tag}`}>
                  {tag}
                  <button
                    type="button"
                    className="tag-dash-chip-x"
                    title="移除这个标签"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveTag(path, tag);
                    }}
                  >
                    <IconX size={9} />
                  </button>
                </span>
              ))}
            </span>
          </div>
        ))}
        {(entry?.notes.length ?? 0) === 0 && !loading && (
          <div className="tree-empty">这个标签下暂时没有笔记。</div>
        )}
      </div>
    );
  }

  return (
    <div className="tag-dash">
      {loading && <div className="tree-empty">正在扫描仓库标签…</div>}
      {tags.map((tag) => {
        const isPinned = pinnedTags.includes(tag.name);
        return (
          <div
            key={tag.name}
            className={`tree-item tag-dash-row${isPinned ? " is-pinned" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => onPickTag(tag.name)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onPickTag(tag.name);
            }}
            title={`${tag.name}：${tag.notes.length} 篇笔记`}
          >
            <IconTag size={13} className="tree-icon" />
            {renaming === tag.name ? (
              <input
                ref={renameInputRef}
                type="text"
                className="tag-dash-rename-input"
                value={draft}
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setRenaming(null);
                  }
                }}
              />
            ) : (
              <span className="tree-label">{tag.name}</span>
            )}
            {renaming !== tag.name && (
              <>
                <span className="tag-dash-count">{tag.notes.length}</span>
                {/* 行功能收进 ⋯（与知识库文件行同一套交互）：行面上只留名字、
                    篇数和一个次要按钮，不再挤 ✎/📌/› 三个图标（0.28 反馈
                    「右侧 > 多余、看起来很乱」）。按钮平时不占位，悬停显形。 */}
                <button
                  type="button"
                  className={`tag-dash-more${rowMenu?.tag === tag.name ? " is-open" : ""}`}
                  aria-label={`${tag.name} 的操作`}
                  aria-haspopup="menu"
                  aria-expanded={rowMenu?.tag === tag.name}
                  title="标签操作：置顶 / 重命名"
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setRowMenu({ tag: tag.name, x: rect.right, y: rect.bottom });
                  }}
                >
                  ⋯
                </button>
              </>
            )}
          </div>
        );
      })}

      {rowMenu && (
        <>
          <div
            className="menu-backdrop"
            onClick={() => setRowMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setRowMenu(null);
            }}
          />
          <div
            className="context-menu tag-dash-menu"
            role="menu"
            ref={menuRefClampedToViewport(rowMenu.x, rowMenu.y)}
            style={{ left: rowMenu.x, top: rowMenu.y }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onTogglePin(rowMenu.tag);
                setRowMenu(null);
              }}
            >
              {pinnedTags.includes(rowMenu.tag) ? "取消置顶" : "置顶"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const tag = rowMenu.tag;
                setRowMenu(null);
                startRename(tag);
              }}
            >
              重命名…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

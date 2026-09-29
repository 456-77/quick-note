/**
 * 标签仪表盘（知识库左侧栏的第四个视图）。
 *
 * 两级结构：先列**全仓库的标签**（按笔记数排序，「待整理」这类自动标签置顶），
 * 点进去看带这个标签的笔记。整理流程就是进来点「待整理」→ 逐条打开处理，
 * 处理完的在行上直接 × 掉标签（没有这个仪表盘时，散落的标签基本没人回头整理）。
 *
 * 标签索引由 App 扫描全仓库生成（这里是纯展示）；行上的 × 走 App 的统一
 * 移除路径——激活中的笔记在编辑器里改（保住撤销历史），没打开的直接改盘。
 */

import { IconChevronRight, IconTag, IconX } from "./icons";

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
  onPickTag: (tag: string) => void;
  onBack: () => void;
  activePath: string | null;
  onOpen: (path: string) => void;
  onRemoveTag: (path: string, tag: string) => void;
}) {
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
        </div>
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
      {tags.map((tag) => (
        <button
          key={tag.name}
          type="button"
          className="tree-item tag-dash-row"
          onClick={() => onPickTag(tag.name)}
          title={`${tag.name}：${tag.notes.length} 篇笔记`}
        >
          <IconTag size={13} className="tree-icon" />
          <span className="tree-label">{tag.name}</span>
          <span className="spacer" />
          <span className="tag-dash-count">{tag.notes.length}</span>
          <IconChevronRight size={12} />
        </button>
      ))}
    </div>
  );
}

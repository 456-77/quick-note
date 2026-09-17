import { useMemo, useState } from "react";
import type { EntryMeta } from "../lib/api";
import {
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconFile,
  IconFileText,
  IconFolder,
  IconStar,
} from "./icons";

type NodeKind = "dir" | "note" | "file";

export type LeftView = "files" | "favorites" | "recents";

interface TreeNode {
  name: string;
  path: string;
  kind: NodeKind;
  size: number;
  modified: number;
  /** 子树里是否含有笔记。用于决定目录默认展开还是收起。 */
  hasNotes: boolean;
  children: TreeNode[];
}

const isNoteName = (name: string) => name.toLowerCase().endsWith(".md");

/**
 * 把扁平条目拼成目录树。
 *
 * 目录条目（含空目录）由 `list_entries` 直接给出，所以**空文件夹也会出现在树里**。
 * 之前这里是从 md 文件路径反推目录的，空目录不产生任何节点——"新建了文件夹但左侧看不到"
 * 就是这个原因。
 */
function buildTree(entries: EntryMeta[]): TreeNode[] {
  const root: TreeNode[] = [];

  const ensureDir = (segments: string[]): TreeNode[] => {
    let level = root;
    let acc = "";
    for (const segment of segments) {
      acc = acc ? `${acc}/${segment}` : segment;
      let node = level.find((candidate) => candidate.kind === "dir" && candidate.name === segment);
      if (!node) {
        node = {
          name: segment,
          path: acc,
          kind: "dir",
          size: 0,
          modified: 0,
          hasNotes: false,
          children: [],
        };
        level.push(node);
      }
      level = node.children;
    }
    return level;
  };

  // 先建目录：保证空目录也有节点
  for (const entry of entries) {
    if (entry.isDir) ensureDir(entry.path.split("/"));
  }

  // 再放文件
  for (const entry of entries) {
    if (entry.isDir) continue;
    const segments = entry.path.split("/");
    const name = segments.pop();
    if (!name) continue;
    const level = ensureDir(segments);
    level.push({
      name,
      path: entry.path,
      kind: isNoteName(name) ? "note" : "file",
      size: entry.size,
      modified: entry.modified,
      hasNotes: isNoteName(name),
      children: [],
    });
  }

  // 标记「子树里有没有笔记」
  const mark = (nodes: TreeNode[]): boolean => {
    let any = false;
    for (const node of nodes) {
      const childHasNotes = mark(node.children);
      node.hasNotes = node.hasNotes || childHasNotes;
      any = any || node.hasNotes;
    }
    return any;
  };
  mark(root);

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const aDir = a.kind === "dir";
      const bDir = b.kind === "dir";
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh");
    });
    nodes.forEach((node) => sort(node.children));
  };
  sort(root);

  return root;
}

/** 过滤模式：拍平成命中的文件列表（目录层级在搜索场景里只是噪音）。 */
function flattenMatches(nodes: TreeNode[], terms: string[], out: TreeNode[]): void {
  for (const node of nodes) {
    const lowered = node.name.toLowerCase();
    if (node.kind !== "dir" && terms.every((term) => lowered.includes(term))) out.push(node);
    if (node.children.length > 0) flattenMatches(node.children, terms, out);
  }
}

function collectNotes(nodes: TreeNode[], out: TreeNode[]): void {
  for (const node of nodes) {
    if (node.kind === "note") out.push(node);
    if (node.children.length > 0) collectNotes(node.children, out);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 笔记行的通用渲染。行是 div[role=button]：行尾要挂 ⋯ 按钮，button 里不能嵌 button。 */
function NoteRow({
  node,
  indent,
  active,
  favorite,
  onOpen,
  onContext,
  leading,
}: {
  node: Pick<TreeNode, "path" | "name" | "size" | "modified">;
  indent?: number;
  active: boolean;
  favorite: boolean;
  onOpen: (path: string) => void;
  onContext: (path: string, isDir: boolean, x: number, y: number) => void;
  /** 替代默认文档图标的图标（收藏视图用星标）。 */
  leading?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`tree-item tree-file${active ? " is-active" : ""}`}
      style={indent ? { paddingLeft: `${indent}px` } : undefined}
      onClick={() => onOpen(node.path)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(node.path);
      }}
      title={node.path}
      onContextMenu={(event) => {
        event.preventDefault();
        onContext(node.path, false, event.clientX, event.clientY);
      }}
    >
      {leading ?? <IconFileText size={14} className="tree-icon" />}
      <span className="tree-label">{node.name}</span>
      <span className="tree-size">{formatTime(node.modified) || formatSize(node.size)}</span>
      <button
        type="button"
        className="tree-more"
        aria-label="更多操作"
        title="收藏 / 重命名 / 删除"
        onClick={(event) => {
          event.stopPropagation();
          onContext(node.path, false, event.clientX, event.clientY);
        }}
      >
        ⋯
      </button>
      {favorite && <IconStar size={12} className="tree-fav-mark" />}
    </div>
  );
}

function Node({
  node,
  depth,
  activePath,
  favorites,
  onOpen,
  onContext,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  favorites: string[];
  onOpen: (path: string) => void;
  onContext: (path: string, isDir: boolean, x: number, y: number) => void;
}) {
  // 默认只展开"子树里有笔记"的目录：只放附件的目录（例如装满图片的 image/）
  // 若默认展开，会把侧栏刷满与笔记无关的条目。
  const [expanded, setExpanded] = useState(node.hasNotes);
  const contextProps = {
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      onContext(node.path, node.kind === "dir", event.clientX, event.clientY);
    },
  };

  if (node.kind === "dir") {
    return (
      <div className="tree-folder">
        <button
          type="button"
          className={`tree-item tree-dir${expanded ? " is-open" : ""}`}
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          onClick={() => setExpanded((value) => !value)}
          title={node.path}
          {...contextProps}
        >
          <span className="tree-caret">
            {expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </span>
          <IconFolder size={15} className="tree-icon" />
          <span className="tree-label">{node.name}</span>
        </button>
        {expanded && (
          <div className="tree-children">
            {node.children.map((child) => (
              <Node
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                favorites={favorites}
                onOpen={onOpen}
                onContext={onContext}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (node.kind === "file") {
    // 非 Markdown 文件列出来但不给打开动作：编辑器只能编辑笔记，
    // 列出来是为了让文件树忠实反映仓库结构。
    return (
      <div
        className="tree-item tree-other"
        style={{ paddingLeft: `${28 + depth * 14}px` }}
        title={`${node.path}（非 Markdown，不可编辑）`}
        {...contextProps}
      >
        <IconFile size={14} className="tree-icon" />
        <span className="tree-label">{node.name}</span>
        <span className="tree-size">{formatSize(node.size)}</span>
      </div>
    );
  }

  return (
    <NoteRow
      node={node}
      indent={28 + depth * 14}
      active={node.path === activePath}
      favorite={favorites.includes(node.path)}
      onOpen={onOpen}
      onContext={onContext}
    />
  );
}

export default function FileTree({
  entries,
  activePath,
  filter,
  view,
  favorites,
  recents,
  onOpen,
  onContext,
}: {
  entries: EntryMeta[];
  activePath: string | null;
  /** 知识库视图下的名称过滤（空串 = 显示完整目录树）。 */
  filter: string;
  view: LeftView;
  favorites: string[];
  recents: string[];
  onOpen: (path: string) => void;
  onContext: (path: string, isDir: boolean, x: number, y: number) => void;
}) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const terms = useMemo(
    () => filter.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [filter],
  );
  const matches = useMemo(() => {
    if (terms.length === 0) return null;
    const out: TreeNode[] = [];
    flattenMatches(tree, terms, out);
    return out.slice(0, 200);
  }, [tree, terms]);

  /** 收藏 / 最近视图的扁平笔记列表。 */
  const flatNotes = useMemo(() => {
    if (view === "files") return null;
    const all: TreeNode[] = [];
    collectNotes(tree, all);
    if (view === "favorites") {
      return all
        .filter((node) => favoriteSet.has(node.path))
        .sort((a, b) => a.name.localeCompare(b.name, "zh"));
    }
    // 最近：按打开顺序（recents 里已按新到旧），只显示还存在的
    const byPath = new Map(all.map((node) => [node.path, node]));
    return recents
      .map((path) => byPath.get(path))
      .filter((node): node is TreeNode => Boolean(node));
  }, [view, tree, favoriteSet, recents]);

  if (entries.length === 0) {
    return <div className="tree-empty">仓库内暂无内容</div>;
  }

  if (view === "favorites") {
    return (
      <div className="tree is-filtered">
        {(!flatNotes || flatNotes.length === 0) && (
          <div className="tree-empty">
            还没有收藏。在笔记上右键或悬停行尾的 ⋯ 即可收藏。
          </div>
        )}
        {flatNotes?.map((node) => (
          <NoteRow
            key={node.path}
            node={node}
            active={node.path === activePath}
            favorite
            onOpen={onOpen}
            onContext={onContext}
            leading={<IconStar size={14} className="tree-icon tree-icon-fav" />}
          />
        ))}
      </div>
    );
  }

  if (view === "recents") {
    return (
      <div className="tree is-filtered">
        {(!flatNotes || flatNotes.length === 0) && (
          <div className="tree-empty">最近打开的笔记会出现在这里。</div>
        )}
        {flatNotes?.map((node) => (
          <NoteRow
            key={node.path}
            node={node}
            active={node.path === activePath}
            favorite={favoriteSet.has(node.path)}
            onOpen={onOpen}
            onContext={onContext}
            leading={<IconClock size={14} className="tree-icon" />}
          />
        ))}
      </div>
    );
  }

  if (matches) {
    if (matches.length === 0) {
      return <div className="tree-empty">没有匹配「{filter.trim()}」的笔记</div>;
    }
    return (
      <div className="tree is-filtered">
        <div className="tree-filter-meta">{matches.length} 个结果</div>
        {matches.map((node) => (
          <NoteRow
            key={node.path}
            node={node}
            active={node.path === activePath}
            favorite={favoriteSet.has(node.path)}
            onOpen={onOpen}
            onContext={onContext}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="tree">
      {tree.map((node) => (
        <Node
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          favorites={favorites}
          onOpen={onOpen}
          onContext={onContext}
        />
      ))}
    </div>
  );
}

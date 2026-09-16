import { useMemo, useState } from "react";
import type { EntryMeta } from "../lib/api";

type NodeKind = "dir" | "note" | "file";

interface TreeNode {
  name: string;
  path: string;
  kind: NodeKind;
  size: number;
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
        node = { name: segment, path: acc, kind: "dir", size: 0, hasNotes: false, children: [] };
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Node({
  node,
  depth,
  activePath,
  onOpen,
  onContext,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onOpen: (path: string) => void;
  onContext: (path: string, isDir: boolean, x: number, y: number) => void;
}) {
  // 默认只展开"子树里有笔记"的目录：只放附件的目录（例如装满图片的 image/）
  // 若默认展开，会把侧栏刷满与笔记无关的条目。
  const [expanded, setExpanded] = useState(node.hasNotes);
  const indent = { paddingLeft: `${8 + depth * 12}px` };
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
          className="tree-item tree-dir"
          style={indent}
          onClick={() => setExpanded((value) => !value)}
          title={node.path}
          {...contextProps}
        >
          <span className="tree-caret">{expanded ? "▾" : "▸"}</span>
          <span className="tree-label">{node.name}</span>
        </button>
        {expanded &&
          node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
              onContext={onContext}
            />
          ))}
      </div>
    );
  }

  if (node.kind === "file") {
    // 非 Markdown 文件列出来但不给打开动作：编辑器只能编辑笔记，
    // 列出来是为了让文件树忠实反映仓库结构。
    return (
      <div
        className="tree-item tree-other"
        style={indent}
        title={`${node.path}（非 Markdown，不可编辑）`}
        {...contextProps}
      >
        <span className="tree-label">{node.name}</span>
        <span className="tree-size">{formatSize(node.size)}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`tree-item tree-file${node.path === activePath ? " is-active" : ""}`}
      style={indent}
      onClick={() => onOpen(node.path)}
      title={node.path}
      {...contextProps}
    >
      <span className="tree-label">{node.name}</span>
      <span className="tree-size">{formatSize(node.size)}</span>
    </button>
  );
}

export default function FileTree({
  entries,
  activePath,
  onOpen,
  onContext,
}: {
  entries: EntryMeta[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onContext: (path: string, isDir: boolean, x: number, y: number) => void;
}) {
  const tree = useMemo(() => buildTree(entries), [entries]);

  if (entries.length === 0) {
    return <div className="tree-empty">仓库内暂无内容</div>;
  }

  return (
    <div className="tree">
      {tree.map((node) => (
        <Node
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onOpen={onOpen}
          onContext={onContext}
        />
      ))}
    </div>
  );
}

/**
 * 语句库管理面板（0.35.1 用户反馈「对于ddl语句和实体，添加一个面板进行管理，
 * 这两个可以复用同一个页面……管理面板也复用同一个快捷键和弹窗」）。
 *
 * 与收录弹窗同一套双库复用思路：一个快捷键（默认 Ctrl+Alt+K，可改绑）唤起，
 * 面板内「数据表 / Java 实体」两个页签。列表按 `## 项目名` 段落分组（与库笔记
 * 的段落协议一致），支持搜索过滤；每条语句可以：
 * - 定位：跳进库笔记对应行（App 侧先按收录同口径在段落里找最后一次出现）；
 * - 复制：语句/类源码进剪贴板；
 * - 删除：两步确认后从库笔记里整段移除（App 侧落盘并重载悬浮库）。
 *
 * 增删改的落盘都在 App 侧（读盘-改-写盘-重载一条线），组件只管展示与触发。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ddlEntryName, type DdlLibrary } from "../lib/ddl";
import type { ClassLibrary } from "../lib/javaEntity";

export type LibraryKind = "ddl" | "java";

interface LibraryRow {
  /** 库 Map 的键（表名小写 / 类名原名），删除定位用它。 */
  key: string;
  /** 显示名（表名从语句里反查原大小写；类名即键）。 */
  name: string;
  project: string;
  ddl: string;
  /** 归属库（0.35.3 三轮反馈：页签去掉，单列表混排，行上挂徽标区分）。 */
  kind: LibraryKind;
}

/** 语句的第一行（预览用）：剥掉空行与围栏残留。 */
function firstLine(ddl: string): string {
  const line = ddl.split("\n").find((part) => part.trim() !== "") ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

export default function LibraryManagerDialog({
  onClose,
  tables,
  classes,
  projects,
  ddlPath,
  javaPath,
  onJump,
  onDelete,
  onMove,
  onBatchMove,
  onBatchDelete,
  onOpenNote,
  variant = "dialog",
}: {
  onClose: () => void;
  /** 表名（小写键）→ 各项目语句；Java 实体同名页签用 classes。 */
  tables: DdlLibrary;
  classes: ClassLibrary;
  /** 库笔记里出现过的项目名（未分组 "" 排在首位），分组按这个顺序。 */
  projects: string[];
  ddlPath: string;
  /** 实体库笔记路径；空串 = 实体库关闭（隐藏页签）。 */
  javaPath: string;
  onJump: (kind: LibraryKind, name: string, project: string) => void;
  /** 落盘由父组件做；抛错显示在面板里。 */
  onDelete: (kind: LibraryKind, name: string, project: string) => Promise<string>;
  /** 移动到别的项目段落（0.38 用户反馈「添加设置所属项目」）；抛错显示在面板里。 */
  onMove: (kind: LibraryKind, name: string, fromProject: string, toProject: string) => Promise<string>;
  /** 批量移动（0.38 对齐 Inbox 勾选批量栏：一次读盘批量改一次写盘）。 */
  onBatchMove: (
    kind: LibraryKind,
    items: { name: string; project: string }[],
    toProject: string,
  ) => Promise<string>;
  /** 批量删除（两步确认由面板管）。 */
  onBatchDelete: (kind: LibraryKind, items: { name: string; project: string }[]) => Promise<string>;
  onOpenNote: (kind: LibraryKind) => void;
  /** dialog=浮层（默认）；page=内容区标签页形态（0.35.3 用户反馈「不应该使用弹窗，
   * 新建一个标签页」——标签栏常驻，面板铺满编辑区）。 */
  variant?: "dialog" | "page";
}) {
  // 0.35.3 五轮反馈澄清：**不是合并两库**——是去掉页签外壳，换成速记管理（Inbox）
  // 那种筛选 chips 行：「数据表 / Java 实体」两枚大 chip 切换显示哪个库（默认数据表）。
  const [query, setQuery] = useState("");
  const [libFilter, setLibFilter] = useState<LibraryKind>("ddl");
  // 0.38 用户反馈「类似于 inbox，添加一些筛选功能」：按项目筛选（"" = 全部）
  const [projectFilter, setProjectFilter] = useState("");
  const [busy, setBusy] = useState(false);
  // 两步确认：记录待删行的 key（键+项目），再点一次才真删；点别处/删完重置
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  // 0.38 用户反馈「默认显示几个按钮，其他的隐藏起来可以手动展开」：行尾只留
  // 「定位 + ⋯」，⋯ 展开第二行放 复制 / 移动项目 / 删除（一次只展开一行）
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // 展开行里的「新项目名」草稿（按行 key 分桶，0.38 实测单项目库也需要移动通道）
  const [moveDrafts, setMoveDrafts] = useState<Record<string, string>>({});
  /** Shift 范围多选的起点（Inbox lastCheckedRef 同款）。 */
  const lastCheckedKeyRef = useRef<string | null>(null);
  // 0.38 用户反馈「语句库管理面板功能向速记管理面板对齐」：勾选多选 + 批量栏
  // （移动到项目 / 批量删除 / 取消），工具行原位切换（Inbox cm-toolbar 同款）。
  // 勾选跨项目分组都有效（rowKey = 键+项目）；切库筛选时清空（跨库勾选易错删）
  const [sel, setSel] = useState<Set<string>>(new Set());
  const isBatch = sel.size > 0;
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMoveDraft, setBulkMoveDraft] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const includeJava = javaPath.trim() !== "";
  // 实体库关闭（javaPath 空）时锁在数据表页
  const activeLib: LibraryKind = includeJava ? libFilter : "ddl";
  const rows: LibraryRow[] = useMemo(() => {
    const out: LibraryRow[] = [];
    for (const [key, entries] of tables) {
      for (const entry of entries) {
        out.push({ key, name: ddlEntryName(entry.ddl) || key, project: entry.project, ddl: entry.ddl, kind: "ddl" });
      }
    }
    if (includeJava) {
      for (const [key, entries] of classes) {
        for (const entry of entries) {
          out.push({ key, name: key, project: entry.project, ddl: entry.ddl, kind: "java" });
        }
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, "en") || a.kind.localeCompare(b.kind));
    return out;
  }, [tables, classes, includeJava]);

  // 分组按库笔记里段落的出场顺序（projects），面板里新出现的项目排最后；
  // 0.38 项目筛选 chips 生效时只看选中的那个项目
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scoped = rows.filter(
      (row) =>
        row.kind === activeLib && (projectFilter === "" || row.project === projectFilter),
    );
    const filtered = q
      ? scoped.filter((row) => row.name.toLowerCase().includes(q) || row.project.toLowerCase().includes(q))
      : scoped;
    const order = [...projects.filter((name) => name !== "" || filtered.some((row) => row.project === ""))];
    for (const row of filtered) if (!order.includes(row.project)) order.push(row.project);
    return order
      .map((project) => ({ project, rows: filtered.filter((row) => row.project === project) }))
      .filter((group) => group.rows.length > 0);
  }, [rows, projects, query, activeLib, projectFilter]);

  // 项目筛选 chips 的词表：当前库实际出现过的项目（按 projects 顺序 + 兜底追加）
  const filterProjects = useMemo(() => {
    const scoped = rows.filter((row) => row.kind === activeLib);
    const order = [...projects.filter((name) => name !== "" || scoped.some((row) => row.project === ""))];
    for (const row of scoped) if (!order.includes(row.project)) order.push(row.project);
    return order;
  }, [rows, projects, activeLib]);

  // 空态按**当前筛选的库**判（数据表有内容不代表实体库不空）
  const total = rows.filter((row) => row.kind === activeLib).length;
  const shown = groups.reduce((sum, group) => sum + group.rows.length, 0);

  const runDelete = async (row: LibraryRow) => {
    const rowKey = `${row.key}\u0000${row.project}`;
    if (confirmKey !== rowKey) {
      setConfirmKey(rowKey);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const text = await onDelete(row.kind, row.name, row.project);
      setMessage({ text, kind: "ok" });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
      setConfirmKey(null);
    }
  };

  /** 移动到别的项目段落（0.38 用户反馈「添加设置所属项目」）。 */
  const runMove = async (row: LibraryRow, toProject: string) => {
    if (toProject === row.project) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await onMove(row.kind, row.name, row.project, toProject);
      setMessage({ text, kind: "ok" });
      setExpandedKey(null);
      setMoveDrafts((prev) => ({ ...prev, [`${row.key}\u0000${row.project}`]: "" }));
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  // ---------------- 批量操作（0.38 对齐 Inbox 勾选批量栏） ----------------
  /** 当前库+筛选下被勾选的行（rowKey = 键+项目，跨项目分组通用）。 */
  const selectedRows = useMemo(
    () => rows.filter((row) => row.kind === activeLib && sel.has(`${row.key}\u0000${row.project}`)),
    [rows, activeLib, sel],
  );
  /** 当前筛选结果的所有 rowKey（全选/清空用）。 */
  const visibleKeys = useMemo(
    () => new Set(groups.flatMap((group) => group.rows.map((row) => `${row.key}\u0000${row.project}`))),
    [groups],
  );
  const toggleSel = (rowKey: string, all = false, from?: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (all) {
        // Shift+点选范围多选（Inbox 同款）：from 到 rowKey 之间（按可见顺序）
        const ordered = groups.flatMap((group) =>
          group.rows.map((row) => `${row.key}\u0000${row.project}`),
        );
        const a = ordered.indexOf(from ?? rowKey);
        const b = ordered.indexOf(rowKey);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) next.add(ordered[i]);
          return next;
        }
      }
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };
  const clearSel = () => {
    setSel(new Set());
    setBulkMoveOpen(false);
    setBulkConfirm(false);
    setBulkMoveDraft("");
  };
  /** 批量移动：目标=项目 chip 点击或输入新项目名（单项目库也有去处）。 */
  const runBulkMove = async (toProject: string) => {
    if (selectedRows.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await onBatchMove(
        activeLib,
        selectedRows.map((row) => ({ name: row.name, project: row.project })),
        toProject,
      );
      setMessage({ text, kind: "ok" });
      clearSel();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  /** 批量删除：两步确认（bulkConfirm），完成即清空勾选。 */
  const runBulkDelete = async () => {
    if (selectedRows.length === 0) return;
    if (!bulkConfirm) {
      setBulkConfirm(true);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const text = await onBatchDelete(
        activeLib,
        selectedRows.map((row) => ({ name: row.name, project: row.project })),
      );
      setMessage({ text, kind: "ok" });
      clearSel();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
      setBulkConfirm(false);
    }
  };

  const copyRow = async (row: LibraryRow) => {
    try {
      await navigator.clipboard.writeText(row.ddl);
      setMessage({ text: `已复制「${row.name}」的${row.kind === "ddl" ? "建表语句" : "源码"}`, kind: "ok" });
    } catch {
      setMessage({ text: "复制失败：剪贴板不可用", kind: "error" });
    }
  };

  const isPage = variant === "page";
  // 0.35.3 二轮反馈：page 形态改用速记管理（CaptureManager）的版式——cm-head
  // 式标题行 + 工具行 + 平铺列表；dialog 形态维持原弹窗壳。两种形态共用主体。
  const pageBody = (
    <>
      {/* 工具行：普通态=两库筛选 chips + 项目筛选 + 搜索；勾选后=批量栏（Inbox
          cm-toolbar 原位切换同款，0.38 用户反馈「功能向速记管理面板对齐」——
          批量移动到项目 / 批量删除（两步确认）/ 全选 / 取消） */}
      {sel.size > 0 ? (
        <div className="ddl-mgr-filters is-batch">
          <span className="cm-batch-count">已选择 {sel.size} 条</span>
          <span className="cm-batch-sep" />
          <button
            type="button"
            className="cm-btn"
            disabled={busy}
            title="全选当前筛选结果（再点一次清空）"
            onClick={() => {
              const all = [...visibleKeys];
              setSel((prev) => {
                const allSelected = all.length > 0 && all.every((k) => prev.has(k));
                return allSelected ? new Set() : new Set(all);
              });
            }}
          >
            {(() => {
              const keys = [...visibleKeys];
              return keys.length > 0 && keys.every((k) => sel.has(k)) ? "全不选" : "全选";
            })()}
          </button>
          <span className="cm-batch-sep" />
          {bulkMoveOpen ? (
            <span className="ddl-mgr-bulk-move">
              <input
                autoFocus
                type="text"
                className="ddl-mgr-extra-input"
                placeholder="目标项目名（留空=未分组）"
                title="输入目标项目名；留空把选中语句移回未分组段落"
                value={bulkMoveDraft}
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setBulkMoveDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void runBulkMove(bulkMoveDraft.trim());
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setBulkMoveOpen(false);
                  }
                }}
              />
              {filterProjects
                .filter((name) => name !== "")
                .map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="ddl-mgr-proj-chip"
                    disabled={busy}
                    title={`移动到「${name}」的段落`}
                    onClick={() => void runBulkMove(name)}
                  >
                    {name}
                  </button>
                ))}
              <button
                type="button"
                className="cm-btn"
                disabled={busy}
                onClick={() => void runBulkMove(bulkMoveDraft.trim())}
              >
                移动
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="cm-btn"
              disabled={busy}
              onClick={() => {
                setBulkMoveOpen(true);
                setBulkMoveDraft("");
                setBulkConfirm(false);
              }}
            >
              移动到项目…
            </button>
          )}
          <button
            type="button"
            className={`cm-btn${bulkConfirm ? " cm-btn-danger" : ""}`}
            disabled={busy}
            title={bulkConfirm ? "再点一次确认删除（不可恢复，两步确认）" : "从库笔记里删除选中的语句"}
            onClick={() => void runBulkDelete()}
          >
            {bulkConfirm ? `确认删除 ${sel.size} 条？` : "删除"}
          </button>
          <button type="button" className="cm-btn cm-btn-ghost" onClick={clearSel}>
            取消
          </button>
        </div>
      ) : (
      <div className="ddl-mgr-filters">
        <button
          type="button"
          className={`ddl-mgr-filter${activeLib === "ddl" ? " is-on" : ""}`}
          onClick={() => {
            setLibFilter("ddl");
            setConfirmKey(null);
            setSel(new Set());
          }}
        >
          数据表 <b>{tables.size}</b>
        </button>
        {includeJava && (
          <button
            type="button"
            className={`ddl-mgr-filter${activeLib === "java" ? " is-on" : ""}`}
            onClick={() => {
              setLibFilter("java");
              setConfirmKey(null);
              setSel(new Set());
            }}
          >
            Java 实体 <b>{classes.size}</b>
          </button>
        )}
        <span className="ddl-mgr-filter-spacer" />
        <input
          ref={searchRef}
          type="text"
          className="ddl-mgr-search"
          placeholder={activeLib === "ddl" ? "搜索表名 / 项目…" : "搜索类名 / 项目…"}
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      )}
      {/* 0.38 用户反馈「类似于 inbox，添加一些筛选功能」+ 实测「项目筛选功能也没
          有看到」：项目筛选 chips 行——此前只在 ≥2 个项目时渲染，全库未分组时
          整行消失，用户以为没这功能。改为只要有条目就显示（全部 + 各项目）；
          与搜索叠加过滤；批量态整行隐藏（批量栏原位顶替） */}
      {!isBatch && filterProjects.length >= 1 && (
        <div className="ddl-mgr-projrow">
          <button
            type="button"
            className={`ddl-mgr-proj-chip${projectFilter === "" ? " is-on" : ""}`}
            onClick={() => {
              setProjectFilter("");
              setConfirmKey(null);
              setSel(new Set());
            }}
          >
            全部
          </button>
          {filterProjects.map((name) => (
            <button
              key={name || "\u0000"}
              type="button"
              className={`ddl-mgr-proj-chip${projectFilter === name ? " is-on" : ""}`}
              onClick={() => {
                setProjectFilter(name);
                setConfirmKey(null);
                setSel(new Set());
              }}
            >
              {name || "未分组"}
            </button>
          ))}
        </div>
      )}
      <div className="ddl-mgr-list">
        {total === 0 ? (
          <div className="ddl-mgr-empty">
            {activeLib === "ddl" ? "库里还没有建表语句" : "库里还没有实体类"}——用「收录语句」弹窗（默认 Ctrl+Alt+J）粘贴即可收录。
          </div>
        ) : shown === 0 ? (
          <div className="ddl-mgr-empty">
            {query.trim() ? `没有匹配「${query}」的条目` : "这个项目下还没有条目"}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.project || "\u0000"} className="ddl-mgr-group">
              <div className="ddl-mgr-project">
                {group.project || "未分组"}
                <span className="ddl-mgr-count">{group.rows.length}</span>
              </div>
              {group.rows.map((row) => {
                const rowKey = `${row.key}\u0000${row.project}`;
                const expanded = expandedKey === rowKey;
                return (
                  <div
                    className={`ddl-mgr-entry${sel.has(rowKey) ? " is-sel" : ""}`}
                    key={`${row.kind}:${rowKey}`}
                  >
                    <div className="ddl-mgr-row">
                    {/* 0.38 对齐 Inbox：行首勾选框，勾选后进批量栏（Shift+点选范围多选） */}
                    <input
                      type="checkbox"
                      className="cm-check"
                      checked={sel.has(rowKey)}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (event.shiftKey && lastCheckedKeyRef.current) {
                          event.preventDefault();
                          toggleSel(rowKey, true, lastCheckedKeyRef.current);
                          return;
                        }
                      }}
                      onChange={() => {
                        toggleSel(rowKey);
                        lastCheckedKeyRef.current = rowKey;
                      }}
                      title="勾选进批量操作（Shift+点选范围多选）"
                    />
                    <span className="ddl-mgr-name" title={row.name}>
                      {row.name}
                    </span>
                      <span className="ddl-mgr-preview" title={firstLine(row.ddl)}>
                        {firstLine(row.ddl)}
                      </span>
                      {/* 0.38 用户反馈「默认显示几个按钮，其他的隐藏起来，可以手动
                          展开」：行尾只留 定位 + ⋯，复制/移动项目/删除收进展开行 */}
                      <button type="button" title="打开库笔记并跳到这一条" disabled={busy} onClick={() => onJump(row.kind, row.name, row.project)}>
                        定位
                      </button>
                      <button
                        type="button"
                        className={`ddl-mgr-more${expanded ? " is-open" : ""}`}
                        title={expanded ? "收起" : "更多操作（复制 / 移动项目 / 删除）"}
                        aria-expanded={expanded}
                        onClick={() => {
                          setExpandedKey(expanded ? null : rowKey);
                          setConfirmKey(null);
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                    {expanded && (
                      <div className="ddl-mgr-extra">
                        <button type="button" disabled={busy} onClick={() => void copyRow(row)}>
                          复制
                        </button>
                        <button
                          type="button"
                          className={confirmKey === rowKey ? "is-confirm" : ""}
                          title={confirmKey === rowKey ? "再点一次确认删除" : "从库笔记里删除这一条"}
                          disabled={busy}
                          onClick={() => void runDelete(row)}
                        >
                          {confirmKey === rowKey ? "确认？" : "删除"}
                        </button>
                        <span className="ddl-mgr-extra-label">移动到项目：</span>
                        <div className="ddl-mgr-extra-projs">
                          {filterProjects
                            .filter((name) => name !== row.project)
                            .map((name) => (
                              <button
                                key={name || "\u0000"}
                                type="button"
                                className="ddl-mgr-proj-chip"
                                disabled={busy}
                                title={name ? `移动到「${name}」的段落` : "移动到未分组段落"}
                                onClick={() => void runMove(row, name)}
                              >
                                {name || "未分组"}
                              </button>
                            ))}
                          {/* 0.38 实测「这个功能用不了」：全库只有一个项目（如全未分组）
                              时 chips 全被排除，没有任何可去目标——补输入新项目的通道，
                              直接把语句移进新建的 ## 项目段落 */}
                          <input
                            type="text"
                            className="ddl-mgr-extra-input"
                            placeholder="新项目名…"
                            title="输入新项目名，语句移进新建的 ## 项目段落"
                            value={moveDrafts[rowKey] ?? ""}
                            spellCheck={false}
                            disabled={busy}
                            onChange={(event) =>
                              setMoveDrafts((prev) => ({ ...prev, [rowKey]: event.target.value }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void runMove(row, (moveDrafts[rowKey] ?? "").trim());
                              }
                            }}
                          />
                          <button
                            type="button"
                            disabled={busy || !(moveDrafts[rowKey] ?? "").trim()}
                            onClick={() => void runMove(row, (moveDrafts[rowKey] ?? "").trim())}
                          >
                            移动
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="quick-capture-foot">
        {message && <span className={`add-word-message is-${message.kind}`}>{message.text}</span>}
        <span className="spacer" />
        <button type="button" className="btn" disabled={busy} onClick={() => onOpenNote("ddl")}>
          打开 {ddlPath}
        </button>
        {includeJava && (
          <button type="button" className="btn" disabled={busy} onClick={() => onOpenNote("java")}>
            打开 {javaPath}
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      {!isPage && <div className="menu-backdrop" onClick={onClose} />}
      {isPage ? (
        <div className="ddl-manager-page" role="dialog" aria-label="语句库管理">
          <div className="ddl-mgr-page-head">
            <div className="ddl-mgr-page-titles">
              <h2 className="ddl-mgr-page-title">语句库管理</h2>
              <p className="ddl-mgr-page-subtitle">数据表 DDL 与 Java 实体的查看、定位与删除</p>
            </div>
            <span className="cm-head-stats" title="已收录的数据表与实体类数量">
              <b>{tables.size}</b> 数据表
              {includeJava && (
                <>
                  <i>·</i>
                  <b>{classes.size}</b> 实体类
                </>
              )}
            </span>
            <span className="ddl-mgr-page-spacer" />
            <button type="button" className="ddl-mgr-page-close" title="返回笔记 (Esc)" onClick={onClose}>
              <kbd>Esc</kbd>
            </button>
          </div>
          {pageBody}
        </div>
      ) : (
        <div className="quick-capture ddl-manager" role="dialog" aria-label="语句库管理">
          <div className="quick-capture-head">
            <span className="quick-capture-title">语句库管理（DDL / Java 实体）</span>
            <span className="spacer" />
            <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
              <kbd>Esc</kbd> 关闭
            </button>
          </div>
          {pageBody}
        </div>
      )}
    </>
  );
}

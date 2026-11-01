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
  onOpenNote,
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
  onOpenNote: (kind: LibraryKind) => void;
}) {
  const [tab, setTab] = useState<LibraryKind>("ddl");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // 两步确认：记录待删行的 key（键+项目），再点一次才真删；点别处/换页签重置
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const library = tab === "ddl" ? tables : classes;
  const rows: LibraryRow[] = useMemo(() => {
    const out: LibraryRow[] = [];
    for (const [key, entries] of library) {
      for (const entry of entries) {
        out.push({ key, name: tab === "ddl" ? ddlEntryName(entry.ddl) || key : key, project: entry.project, ddl: entry.ddl });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return out;
  }, [library, tab]);

  // 分组按库笔记里段落的出场顺序（projects），面板里新出现的项目排最后
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((row) => row.name.toLowerCase().includes(q) || row.project.toLowerCase().includes(q))
      : rows;
    const order = [...projects.filter((name) => name !== "" || filtered.some((row) => row.project === ""))];
    for (const row of filtered) if (!order.includes(row.project)) order.push(row.project);
    return order
      .map((project) => ({ project, rows: filtered.filter((row) => row.project === project) }))
      .filter((group) => group.rows.length > 0);
  }, [rows, projects, query]);

  const total = rows.length;
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
      const text = await onDelete(tab, row.name, row.project);
      setMessage({ text, kind: "ok" });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
      setConfirmKey(null);
    }
  };

  const copyRow = async (row: LibraryRow) => {
    try {
      await navigator.clipboard.writeText(row.ddl);
      setMessage({ text: `已复制「${row.name}」的${tab === "ddl" ? "建表语句" : "源码"}`, kind: "ok" });
    } catch {
      setMessage({ text: "复制失败：剪贴板不可用", kind: "error" });
    }
  };

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="quick-capture ddl-manager" role="dialog" aria-label="语句库管理">
        <div className="quick-capture-head">
          <span className="quick-capture-title">语句库管理（DDL / Java 实体）</span>
          <span className="spacer" />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>
        <div className="ddl-mgr-tabs">
          <button type="button" className={tab === "ddl" ? "is-on" : ""} onClick={() => { setTab("ddl"); setConfirmKey(null); }}>
            数据表 {tables.size}
          </button>
          {javaPath && (
            <button type="button" className={tab === "java" ? "is-on" : ""} onClick={() => { setTab("java"); setConfirmKey(null); }}>
              Java 实体 {classes.size}
            </button>
          )}
          <span className="spacer" />
          <input
            ref={searchRef}
            type="text"
            className="ddl-mgr-search"
            placeholder="搜索表名 / 类名 / 项目…"
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
        <div className="ddl-mgr-list">
          {total === 0 ? (
            <div className="ddl-mgr-empty">
              库里还没有{tab === "ddl" ? "建表语句" : "实体类"}——用「收录语句」弹窗（默认 Ctrl+Alt+J）粘贴即可收录。
            </div>
          ) : shown === 0 ? (
            <div className="ddl-mgr-empty">没有匹配「{query}」的条目</div>
          ) : (
            groups.map((group) => (
              <div key={group.project || "\u0000"} className="ddl-mgr-group">
                <div className="ddl-mgr-project">
                  {group.project || "未分组"}
                  <span className="ddl-mgr-count">{group.rows.length}</span>
                </div>
                {group.rows.map((row) => {
                  const rowKey = `${row.key}\u0000${row.project}`;
                  return (
                    <div className="ddl-mgr-row" key={rowKey}>
                      <span className="ddl-mgr-name" title={row.name}>
                        {row.name}
                      </span>
                      <span className="ddl-mgr-preview" title={firstLine(row.ddl)}>
                        {firstLine(row.ddl)}
                      </span>
                      <button type="button" title="打开库笔记并跳到这一条" disabled={busy} onClick={() => onJump(tab, row.name, row.project)}>
                        定位
                      </button>
                      <button type="button" title="复制语句/源码" disabled={busy} onClick={() => void copyRow(row)}>
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
          {javaPath && (
            <button type="button" className="btn" disabled={busy} onClick={() => onOpenNote("java")}>
              打开 {javaPath}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

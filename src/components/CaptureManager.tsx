/**
 * 速记管理（独立视图，占据编辑区；命令面板或 Ctrl+Alt+M 打开，Esc 退出）。
 *
 * 面向「收件仓库」的整理工作台：
 * - 顶栏：收件仓库切换（最近仓库 + 选择其他目录）+ 全部/未归档/已归档 + 刷新；
 * - 左栏：标签聚合（收件仓库所有速记行里的 #tag 去重计数，多选=任一命中，
 *   另有「无标签」）+ 归档目标（仓库 + 笔记，可跨仓库）+ 批量加标签/批量归档；
 * - 右栏：速记按日期分组（新在前），行级 归档/撤销归档，勾选支持 Shift 范围多选。
 *
 * 归档 = 源行尾打 `^archived` 标记（不删，与待办墓碑同思路）+ 条目追加到目标
 * 笔记末尾（剥掉标记，作为普通列表项）。数据自己扫（listEntries + 逐篇读 .md，
 * 小并发），不经过 App 的 entries——收件仓库通常不是当前仓库，文件树里没有它。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listEntries, pickDirectory, readNoteOptional, writeNote } from "../lib/api";
import {
  ARCHIVE_MARK,
  archivedLineForTarget,
  detectEol,
  lineAddTagEdit,
  lineArchiveEdit,
  parseCaptureEntries,
  type CaptureEntry,
} from "../lib/capture";
import { normalizeTagName } from "../lib/tags";
import { IconRefresh, IconX } from "./icons";

/** 「无标签」筛选项的内部键（不是真标签名）。 */
const NO_TAG = "__none__";

export interface VaultOption {
  value: string;
  label: string;
}

export default function CaptureManager({
  inboxVault,
  onInboxVaultChange,
  vaultOptions,
  currentVault,
  onClose,
  notice,
}: {
  /** 收件仓库绝对路径（settings.quickCaptureVault）；空串 = 未配置。 */
  inboxVault: string;
  onInboxVaultChange: (vault: string) => void;
  /** 仓库下拉候选（最近 + 当前 + 已配置的收件仓库，App 侧已去重）。 */
  vaultOptions: VaultOption[];
  currentVault: string | null;
  onClose: () => void;
  notice: (message: string, kind?: "info" | "error") => void;
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
              if (note) entries.push(...parseCaptureEntries(files[index], note.content));
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

  // ------------------------------------------------------------- 筛选与聚合

  const [scope, setScope] = useState<"active" | "archived" | "all">("active");
  const [tagSel, setTagSel] = useState<Set<string>>(new Set());

  /** 标签聚合：收件仓库所有速记行的 #tag → 条数；外加「无标签」条数。 */
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

  const filtered = useMemo(
    () =>
      scan.entries.filter((entry) => {
        if (scope === "active" && entry.archived) return false;
        if (scope === "archived" && !entry.archived) return false;
        if (tagSel.size > 0) {
          const hit = [...tagSel].some((tag) =>
            tag === NO_TAG ? entry.tags.length === 0 : entry.tags.includes(tag),
          );
          if (!hit) return false;
        }
        return true;
      }),
    [scan.entries, scope, tagSel],
  );

  /** 按日期分组（时间戳的日期部分；没有的归「未标注日期」）。条目已按时间倒序。 */
  const groups = useMemo(() => {
    const map = new Map<string, CaptureEntry[]>();
    for (const entry of filtered) {
      const key = entry.timestamp ? entry.timestamp.slice(0, 10) : "未标注日期";
      const bucket = map.get(key);
      if (bucket) bucket.push(entry);
      else map.set(key, [entry]);
    }
    return [...map.entries()];
  }, [filtered]);

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
        // Shift 范围多选：从上次勾选的条目到本次（按当前过滤列表的顺序）
        const keys = filtered.map(keyOf);
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

  // ------------------------------------------------------------- 归档目标

  const [targetVault, setTargetVault] = useState(currentVault ?? "");
  const [targetNotes, setTargetNotes] = useState<string[]>([]);
  const [targetNote, setTargetNote] = useState("");
  /** 归档/加标签进行中（按钮禁用，防重复提交）。 */
  const [busy, setBusy] = useState(false);
  /** 批量加标签的输入草稿。 */
  const [newTag, setNewTag] = useState("");

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
        // TODO(调试): 定位「目标笔记列表为空」后移除
        console.log("[capture-notes] loaded", notes.length, targetVault);
        setTargetNotes(notes);
        setTargetNote((prev) => (notes.includes(prev) ? prev : ""));
      })
      .catch((e) => {
        // TODO(调试): 定位「目标笔记列表为空」后移除
        console.error("[capture-notes] failed", targetVault, e);
        if (!cancelled) {
          setTargetNotes([]);
          setTargetNote("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [targetVault]);

  // ------------------------------------------------------------- 落盘操作

  /**
   * 按行重写一批速记文件：plan = 文件 → (行号 → 行变换)。
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

  /** 批量归档：源行打 ^archived 标记；条目按时间正序追加到目标笔记末尾。 */
  const archiveSelected = useCallback(async () => {
    if (!inboxVault) return;
    if (!targetVault || !targetNote) {
      notice("先在左栏选择归档目标笔记", "error");
      return;
    }
    const chosen = filtered.filter((entry) => sel.has(keyOf(entry)) && !entry.archived);
    if (chosen.length === 0) return;
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

      // 目标笔记：时间正序追加（读起来是顺序），缺文件就按「# 文件名」建头
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
      notice(`已归档 ${chosen.length} 条到 ${targetNote.replace(/^.*\//, "")}`);
      clearSel();
      setScanToken((value) => value + 1);
    } catch (e) {
      notice(`归档失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  }, [inboxVault, targetVault, targetNote, filtered, sel, rewriteLines, notice, clearSel]);

  /** 撤销归档：剥掉源行的 ^archived 标记。 */
  const unarchiveEntry = useCallback(
    async (entry: CaptureEntry) => {
      if (!inboxVault) return;
      setBusy(true);
      try {
        const plan = new Map<string, Map<number, (line: string) => string | null>>([
          [entry.file, new Map([[entry.line, (line) => lineArchiveEdit(line, false)]])],
        ]);
        const changed = await rewriteLines(inboxVault, plan);
        if (changed > 0) {
          notice(`已撤销归档：${entry.text.slice(0, 24)}…`);
          setScanToken((value) => value + 1);
        }
      } catch (e) {
        notice(`撤销归档失败：${e}`, "error");
      } finally {
        setBusy(false);
      }
    },
    [inboxVault, rewriteLines, notice],
  );

  /** 给勾选的条目批量加标签。 */
  const addTagToSelected = useCallback(async () => {
    const tag = normalizeTagName(newTag);
    if (!tag) {
      notice("标签名不合法（不能含空格）", "error");
      return;
    }
    const chosen = filtered.filter((entry) => sel.has(keyOf(entry)));
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      const plan = new Map<string, Map<number, (line: string) => string | null>>();
      for (const entry of chosen) {
        let bucket = plan.get(entry.file);
        if (!bucket) {
          bucket = new Map();
          plan.set(entry.file, bucket);
        }
        bucket.set(entry.line, (line) => lineAddTagEdit(line, tag));
      }
      const files = await rewriteLines(inboxVault, plan);
      notice(files > 0 ? `已给选中条目加上 #${tag}（更新 ${files} 个文件）` : "选中的条目都已带这个标签");
      setNewTag("");
      clearSel();
      setScanToken((value) => value + 1);
    } catch (e) {
      notice(`加标签失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  }, [newTag, inboxVault, filtered, sel, rewriteLines, notice, clearSel]);

  // ------------------------------------------------------------- 渲染

  const scopeTabs: { value: typeof scope; label: string }[] = [
    { value: "active", label: "未归档" },
    { value: "archived", label: "已归档" },
    { value: "all", label: "全部" },
  ];

  if (!inboxVault) {
    return (
      <div className="capture-manager">
        <div className="capture-manager-head">
          <span className="capture-manager-title">速记管理</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" title="返回笔记 (Esc)" onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
        <div className="capture-manager-empty">
          还没有配置收件仓库。在 设置 → 通用 → 快速笔记 里选择一个仓库作为收件仓库，
          之后 Ctrl+Alt+N 的速记都会落到那里，再回到这里集中整理。
        </div>
      </div>
    );
  }

  return (
    <div className="capture-manager">
      <div className="capture-manager-head">
        <span className="capture-manager-title">速记管理</span>
        <select
          className="capture-vault-select"
          value={inboxVault}
          title="收件仓库（速记落点）"
          onChange={(event) => {
            if (event.target.value === "__pick__") {
              void pickDirectory("选择速记收件仓库").then((picked) => {
                if (picked) onInboxVaultChange(picked);
              });
              return;
            }
            onInboxVaultChange(event.target.value);
          }}
        >
          {!vaultOptions.some((option) => option.value === inboxVault) && (
            <option value={inboxVault}>
              {inboxVault.replace(/^.*[\\/]/, "")}（当前配置）
            </option>
          )}
          {vaultOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value="__pick__">选择其他目录…</option>
        </select>
        <div className="capture-scope" role="tablist" aria-label="归档范围">
          {scopeTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={scope === tab.value}
              className={`capture-scope-tab${scope === tab.value ? " is-on" : ""}`}
              onClick={() => setScope(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          title="重新扫描收件仓库"
          onClick={() => setScanToken((value) => value + 1)}
        >
          <IconRefresh size={14} />
        </button>
        <span className="spacer" />
        <span className="capture-scan-meta">
          {scan.loading ? "扫描中…" : `${scan.files} 个文件 · ${scan.entries.length} 条速记`}
        </span>
        <button type="button" className="icon-btn" title="返回笔记 (Esc)" onClick={onClose}>
          <IconX size={14} />
        </button>
      </div>

      <div className="capture-manager-body">
        <aside className="capture-side">
          <div className="capture-side-title">标签筛选</div>
          {tagCounts.tags.length === 0 && tagCounts.untagged === 0 && (
            <div className="capture-side-empty">还没有带标签的速记</div>
          )}
          {tagCounts.tags.map((tag) => (
            <label key={tag.name} className="capture-tag-row">
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
              <span className="capture-tag-name">#{tag.name}</span>
              <span className="spacer" />
              <span className="capture-tag-count">{tag.count}</span>
            </label>
          ))}
          {tagCounts.untagged > 0 && (
            <label className="capture-tag-row">
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
              <span className="capture-tag-name">无标签</span>
              <span className="spacer" />
              <span className="capture-tag-count">{tagCounts.untagged}</span>
            </label>
          )}
          {tagSel.size > 0 && (
            <button type="button" className="capture-clear" onClick={() => setTagSel(new Set())}>
              清除筛选
            </button>
          )}

          <div className="capture-side-title">归档目标</div>
          <select
            className="capture-target-select"
            value={targetVault}
            title="目标仓库（默认当前仓库，可跨仓库归档）"
            onChange={(event) => setTargetVault(event.target.value)}
          >
            {!vaultOptions.some((option) => option.value === targetVault) && targetVault && (
              <option value={targetVault}>{targetVault.replace(/^.*[\\/]/, "")}（当前仓库）</option>
            )}
            {vaultOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="capture-target-select"
            value={targetNote}
            title="目标笔记（速记将追加到它的末尾）"
            onChange={(event) => setTargetNote(event.target.value)}
          >
            <option value="">{targetNotes.length === 0 ? "（该仓库没有笔记）" : "选择笔记…"}</option>
            {targetNotes.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>

          <div className="capture-side-title">批量操作</div>
          <div className="capture-batch">
            <input
              type="text"
              className="capture-tag-input"
              value={newTag}
              placeholder="给选中加标签…"
              onChange={(event) => setNewTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addTagToSelected();
              }}
            />
            <button
              type="button"
              className="btn btn-mini"
              disabled={busy || sel.size === 0 || !newTag.trim()}
              onClick={() => void addTagToSelected()}
              title={`给选中的 ${sel.size} 条速记追加标签`}
            >
              加标签
            </button>
          </div>
          <button
            type="button"
            className="btn btn-primary capture-archive-btn"
            disabled={busy || sel.size === 0 || !targetVault || !targetNote}
            onClick={() => void archiveSelected()}
            title={`把选中的 ${sel.size} 条速记追加到目标笔记，并在源行打 ${ARCHIVE_MARK} 标记`}
          >
            批量归档{sel.size > 0 ? ` (${sel.size})` : ""}
          </button>
          <div className="capture-side-hint">
            归档不删除：源速记打 {ARCHIVE_MARK} 标记（可撤销），内容追加到目标笔记末尾。
          </div>
        </aside>

        <div className="capture-list">
          {scan.error && <div className="capture-list-error">{scan.error}</div>}
          {scan.loading && <div className="capture-list-empty">正在扫描收件仓库…</div>}
          {!scan.loading && !scan.error && groups.length === 0 && (
            <div className="capture-list-empty">
              {scope === "active" ? "没有未归档的速记。" : "这里还没有速记。"}
              {` 用 Ctrl+Alt+N 或命令面板的「快速笔记」随手记，记录会出现在这里。`}
            </div>
          )}
          {groups.map(([date, entries]) => (
            <div key={date} className="capture-group">
              <div className="capture-group-head">
                <span>{date}</span>
                <span className="spacer" />
                <span className="capture-group-count">{entries.length} 条</span>
              </div>
              {entries.map((entry) => {
                const key = keyOf(entry);
                return (
                  <div key={key} className={`capture-row${entry.archived ? " is-archived" : ""}`}>
                    <input
                      type="checkbox"
                      className="capture-row-check"
                      checked={sel.has(key)}
                      // 普通勾选走 onChange（与标签筛选同一模式，受控更新）；
                      // onClick 只在 Shift+点选时接手：preventDefault 挡掉浏览器
                      // 自己的切换（否则 onChange 再翻一次），然后做范围多选
                      onChange={() => toggleSelect(entry, false)}
                      onClick={(event) => {
                        if (event.shiftKey && lastCheckedRef.current) {
                          event.preventDefault();
                          toggleSelect(entry, true);
                        }
                      }}
                      title="勾选（Shift+点选范围多选）"
                    />
                    <span className="capture-row-time">
                      {entry.timestamp ? entry.timestamp.slice(11) : "--:--"}
                    </span>
                    {entry.tags.length > 0 && (
                      <span className="capture-row-tags">
                        {entry.tags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className="capture-row-tag"
                            title={`筛选 #${tag}`}
                            onClick={() =>
                              setTagSel((prev) => {
                                const next = new Set(prev);
                                if (next.has(tag)) next.delete(tag);
                                else next.add(tag);
                                return next;
                              })
                            }
                          >
                            #{tag}
                          </button>
                        ))}
                      </span>
                    )}
                    <span className="capture-row-text" title={entry.text}>
                      {entry.text}
                    </span>
                    {entry.source && (
                      <span className="capture-row-src" title={`来自 ${entry.source}`}>
                        @{entry.source}
                      </span>
                    )}
                    {entry.archived ? (
                      <button
                        type="button"
                        className="capture-row-act"
                        disabled={busy}
                        onClick={() => void unarchiveEntry(entry)}
                        title="撤销归档（去掉源行的 ^archived 标记）"
                      >
                        撤销归档
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="capture-row-act"
                        disabled={busy || !targetVault || !targetNote}
                        onClick={() => {
                          setSel(new Set([key]));
                          lastCheckedRef.current = key;
                          window.setTimeout(() => void archiveSelected(), 0);
                        }}
                        title="追加到目标笔记并标记已归档"
                      >
                        归档
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 设置 → 快捷键：独立面板（Obsidian 式快捷键管理）。
 *
 * 结构：粘性头部（标题 + 恢复默认/导入/导出）→ 搜索 → 筛选胶囊 + 统计 →
 * 按功能分组的命令列表。行内编辑：点键位进入录入态（实时回显组合，Enter 保存、
 * Esc 取消），组合被其他命令占用时就地显示冲突警告，不静默抢占。
 *
 * 业务逻辑全部来自 `hotkeys.ts`（绑定表/覆盖存储/捕获挂起），本组件只做交互。
 * 仅在用户切到「快捷键」分区时挂载——Ctrl+F 聚焦本搜索、录入监听都只在此时生效。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../lib/api";
import {
  allBindings,
  comboOf,
  comboOfCode,
  COMMAND_KEYS,
  exportBindings,
  formatKey,
  HOTKEY_GROUPS,
  importBindings,
  keycapParts,
  onHotkeysChange,
  resetAllBindings,
  setBinding,
  setCapturing,
  type CommandKeys,
  type HotkeyGroupId,
} from "../lib/hotkeys";

type FilterId = "all" | "assigned" | "unassigned" | "modified";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "assigned", label: "已分配" },
  { id: "unassigned", label: "未分配" },
  { id: "modified", label: "已修改" },
];

interface Capture {
  id: string;
  /** 要替换的键位下标；"add" = 追加新键位。 */
  slot: number | "add";
}

interface Pending {
  /** 已按下的组合（实时回显）；null = 还没有有效按键。 */
  combo: string | null;
  hint: string | null;
  /** 组合被其他命令占用时指向那条命令。 */
  conflict: CommandKeys | null;
}

function defaultKeysOf(id: string): string {
  return COMMAND_KEYS.find((c) => c.id === id)?.keys.join(",") ?? "";
}

export default function HotkeysPane() {
  const [bindings, setBindings] = useState(allBindings);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [capture, setCapture] = useState<Capture | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => onHotkeysChange(() => setBindings(allBindings())), []);

  const showToast = (text: string, kind: "ok" | "error" = "ok") => {
    setToast({ text, kind });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };

  // Ctrl+F：聚焦本分区搜索框（本组件挂载即代表快捷键分区处于激活态）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 录入态：实时回显按键，Enter 保存、Esc 取消；期间挂起全局快捷键
  useEffect(() => {
    if (!capture) return;
    setCapturing(true);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapture(null);
        setPending(null);
        return;
      }
      if (event.key === "Enter") {
        if (pending?.combo && !pending.conflict) {
          applyCapture(capture, pending.combo);
        }
        return;
      }
      const combo = comboOfCode(event) ?? comboOf(event);
      const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !/^F\d+$/.test(event.key);
      if (bare) {
        setPending({ combo: null, hint: "组合需包含 Ctrl / Alt / Win 或功能键", conflict: null });
        return;
      }
      const conflict =
        bindings.find((c) => c.id !== capture.id && c.keys.includes(combo)) ?? null;
      setPending({ combo, conflict, hint: null });
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setCapturing(false);
    };
  }, [capture, pending, bindings]);

  /** 把录入的组合写入目标槽位并结束录入。 */
  const applyCapture = (target: Capture, combo: string) => {
    const command = bindings.find((c) => c.id === target.id);
    const keys = [...(command?.keys ?? [])];
    if (target.slot === "add") {
      if (!keys.includes(combo)) keys.push(combo);
    } else {
      keys[target.slot] = combo;
    }
    setBinding(target.id, keys);
    setCapture(null);
    setPending(null);
  };

  const endCaptureAndGoto = (conflict: CommandKeys) => {
    setCapture(null);
    setPending(null);
    requestAnimationFrame(() => {
      const row = document.getElementById(`hotkey-row-${conflict.id}`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashId(conflict.id);
      window.setTimeout(() => setFlashId((current) => (current === conflict.id ? null : current)), 1500);
    });
  };

  const onImport = async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      const count = importBindings(await readTextFile(picked));
      showToast(count > 0 ? `快捷键配置已导入（${count} 条自定义）` : "文件里没有自定义键位");
    } catch (e) {
      showToast(`导入失败：${e}`, "error");
    }
  };

  const onExport = async () => {
    try {
      const path = await save({
        defaultPath: "quick-note-hotkeys.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await writeTextFile(path, exportBindings());
      showToast("快捷键配置已导出");
    } catch (e) {
      showToast(`导出失败：${e}`, "error");
    }
  };

  // 过滤：搜索（名称/描述/键位文本）+ 状态筛选
  const q = query.trim().toLowerCase();
  const matchQuery = (command: CommandKeys) => {
    if (!q) return true;
    if (command.label.toLowerCase().includes(q)) return true;
    if ((command.desc ?? "").toLowerCase().includes(q)) return true;
    return command.keys.some(
      (combo) =>
        combo.toLowerCase().includes(q) || formatKey(combo).toLowerCase().replace(/\s/g, "").includes(q),
    );
  };
  const visible = useMemo(() => {
    return bindings.filter((command) => {
      if (!matchQuery(command)) return false;
      if (filter === "assigned") return command.keys.length > 0;
      if (filter === "unassigned") return command.keys.length === 0;
      if (filter === "modified") return command.keys.join(",") !== defaultKeysOf(command.id);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- q/filter 变化即重算
  }, [bindings, q, filter]);

  const assigned = bindings.filter((c) => c.keys.length > 0).length;
  const modified = bindings.filter((c) => c.keys.join(",") !== defaultKeysOf(c.id)).length;

  const renderRow = (command: CommandKeys) => {
    const isDefault = command.keys.join(",") === defaultKeysOf(command.id);
    const capturing = capture?.id === command.id;
    const conflictHere = pending?.conflict?.id === command.id;
    return (
      <div
        key={command.id}
        id={`hotkey-row-${command.id}`}
        className={`settings-row hotkey-row${flashId === command.id ? " is-flash" : ""}${
          conflictHere ? " is-conflict" : ""
        }`}
        title={command.desc ? `${command.label} — ${command.desc}` : command.label}
      >
        <span className="hotkey-labelbox">
          <span className="hotkey-name">{command.label}</span>
          {command.desc && <span className="hotkey-desc">{command.desc}</span>}
        </span>

        <span className="hotkey-row-side">
          {capturing ? (
            <span className="hotkey-capture">
              <span className="shortcut-capture">正在录入快捷键…</span>
              {pending?.combo && (
                <span className="keycap-set is-live">
                  {keycapParts(pending.combo).map((key) => (
                    <kbd className="keycap" key={key}>
                      {key}
                    </kbd>
                  ))}
                </span>
              )}
              {!pending?.combo && !pending?.hint && (
                <span className="hotkey-capture-hint">按下组合键</span>
              )}
              {pending?.hint && <span className="hotkey-warn">{pending.hint}</span>}
              {pending?.conflict && (
                <span className="hotkey-warn">
                  ⚠ 该快捷键已被「{pending.conflict.label}」使用
                  <button
                    type="button"
                    className="hotkey-warn-btn"
                    onClick={() => endCaptureAndGoto(pending.conflict as CommandKeys)}
                  >
                    查看冲突
                  </button>
                  <button
                    type="button"
                    className="hotkey-warn-btn"
                    onClick={() => setPending({ combo: null, hint: null, conflict: null })}
                  >
                    重新设置
                  </button>
                </span>
              )}
              {pending?.combo && !pending.conflict && (
                <span className="hotkey-capture-hint">Enter 保存 · Esc 取消</span>
              )}
            </span>
          ) : (
            <>
              {command.keys.length === 0 && <span className="hotkey-unset">未设置</span>}
              {command.keys.map((combo, index) => (
                <span className="keycap-set" key={`${combo}-${index}`}>
                  <button
                    type="button"
                    className="keycap-group"
                    title="点击修改这个快捷键"
                    onClick={() => setCapture({ id: command.id, slot: index })}
                  >
                    {keycapParts(combo).map((key, keyIndex) => (
                      <kbd className="keycap" key={keyIndex}>
                        {key}
                      </kbd>
                    ))}
                  </button>
                  <button
                    type="button"
                    className="hotkey-remove"
                    title="移除这个快捷键"
                    aria-label={`移除 ${formatKey(combo)}`}
                    onClick={() => setBinding(command.id, command.keys.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {!isDefault && <span className="hotkey-modified">已修改</span>}
              <button
                type="button"
                className="hotkey-plus"
                title={command.keys.length > 0 ? "添加一个快捷键" : "设置快捷键"}
                onClick={() => setCapture({ id: command.id, slot: "add" })}
              >
                ＋
              </button>
              {!isDefault && (
                <button
                  type="button"
                  className="shortcut-reset"
                  title="恢复默认键位"
                  onClick={() => setBinding(command.id, null)}
                >
                  ↺
                </button>
              )}
            </>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="hotkey-pane">
      <div className="hotkey-head">
        <div className="hotkey-head-row">
          <div className="hotkey-head-text">
            <span className="hotkey-title">快捷键</span>
            <span className="hotkey-subtitle">自定义 Quick Note 的键盘操作</span>
          </div>
          <div className="hotkey-head-actions">
            <button
              type="button"
              className="hotkey-action"
              onClick={() => setConfirmReset(true)}
              disabled={modified === 0}
            >
              恢复默认
            </button>
            <button type="button" className="hotkey-action" onClick={() => void onImport()}>
              导入
            </button>
            <button type="button" className="hotkey-action" onClick={() => void onExport()}>
              导出
            </button>
          </div>
        </div>

        <div className="hotkey-search">
          <span className="hotkey-search-icon" aria-hidden>
            🔍
          </span>
          <input
            ref={searchRef}
            type="search"
            placeholder="搜索快捷键或命令…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                if (query) setQuery("");
                else searchRef.current?.blur();
              }
            }}
          />
        </div>

        <div className="hotkey-toolbar">
          <div className="hotkey-filters" role="group" aria-label="筛选命令">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`hotkey-filter${filter === item.id ? " is-on" : ""}`}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="hotkey-stats">
            {bindings.length} 个命令 · {assigned} 个已分配 · {bindings.length - assigned} 个未分配 ·{" "}
            {modified} 个已修改
          </span>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="hotkey-empty">没有匹配「{query.trim() || FILTERS.find((f) => f.id === filter)?.label}」的命令</div>
      ) : (
        HOTKEY_GROUPS.map((group) => {
          const rows = visible.filter((command) => command.group === (group.id as HotkeyGroupId));
          if (rows.length === 0) return null;
          return (
            <div className="hotkey-group" key={group.id}>
              <div className="hotkey-group-title">
                {group.label}
                <span className="hotkey-group-count">{rows.length}</span>
              </div>
              <div className="hotkey-group-rows">{rows.map(renderRow)}</div>
            </div>
          );
        })
      )}

      {confirmReset && (
        <div className="hotkey-modal" role="dialog" aria-label="恢复默认快捷键">
          <div className="hotkey-modal-card">
            <div className="hotkey-modal-title">恢复默认快捷键？</div>
            <p className="hotkey-modal-text">将清除全部自定义键位，恢复为默认设置。</p>
            <div className="hotkey-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmReset(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  resetAllBindings();
                  setConfirmReset(false);
                  showToast("已恢复默认快捷键");
                }}
              >
                恢复默认
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`hotkey-toast is-${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

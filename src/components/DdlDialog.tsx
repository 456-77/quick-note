/**
 * 建表语句收录弹窗（0.31 用户反馈）：快捷键（默认 Ctrl+Alt+T）唤起，粘贴一段
 * CREATE TABLE（可多条），自动识别表名，确认后合并进仓库内的 DDL 笔记
 * （路径见 设置 → 编辑；同名表的旧段整段替换，新表追加到文末）。
 *
 * 保存由父组件做（读盘-合并-写盘-重载悬浮库一条线都在 App 侧），弹窗只管
 * 输入与识别反馈。Enter 不提交（多行文本），Ctrl+Enter = 收录，Esc = 关闭。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { extractTableNames } from "../lib/ddl";

export default function DdlDialog({
  onSubmit,
  onClose,
  ddlPath,
}: {
  /** 落盘由父组件做。返回结果文案；抛错显示在弹窗里。 */
  onSubmit: (ddlText: string) => Promise<string>;
  onClose: () => void;
  /** DDL 笔记路径（提示文案里显示，让用户知道语句存去了哪）。 */
  ddlPath: string;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const tables = useMemo(() => extractTableNames(draft), [draft]);

  const submit = async () => {
    if (!tables.length || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await onSubmit(draft);
      setMessage({ text, kind: "ok" });
      setDraft("");
      areaRef.current?.focus();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="quick-capture ddl-dialog" role="dialog" aria-label="收录建表语句">
        <div className="quick-capture-head">
          <span className="quick-capture-title">收录建表语句</span>
          <span className="spacer" />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>
        <textarea
          ref={areaRef}
          className="ddl-textarea"
          placeholder={"粘贴 CREATE TABLE 语句（可多条），表名自动识别，例如：\n\nCREATE TABLE ids_check_scenario (\n  id bigint NOT NULL,\n  ...\n) COMMENT '检查场景';"}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="quick-capture-help">
          <span>
            {tables.length > 0
              ? `识别到 ${tables.length} 张表：${tables.slice(0, 6).join("、")}${tables.length > 6 ? " …" : ""}`
              : "等待 CREATE TABLE 语句…"}
          </span>
          <span className="spacer" />
          <span>保存到 {ddlPath} · 同名表替换旧版</span>
        </div>
        <div className="quick-capture-foot">
          {message && (
            <span className={`add-word-message is-${message.kind}`}>{message.text}</span>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-primary quick-capture-save"
            disabled={tables.length === 0 || busy}
            onClick={() => void submit()}
          >
            {busy ? "保存中…" : "收录"}
          </button>
        </div>
      </div>
    </>
  );
}

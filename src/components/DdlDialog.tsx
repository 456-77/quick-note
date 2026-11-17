/**
 * 语句收录弹窗（0.31 用户反馈）：快捷键（默认 Ctrl+Alt+J，可改绑）唤起，粘贴一段
 * CREATE TABLE（可多条）或 Java 类定义（0.34.13 扩展：class/interface/enum/record），
 * 自动识别表名/类名，确认后合并进仓库内对应的库笔记（DDL 笔记 / Java 实体笔记，
 * 路径见 设置 → 编辑）。
 *
 * 0.39.17 用户反馈「这里也修改下，去掉项目」：收录不再问项目段落（`## 项目`），
 * 只问标签——语句统一落未分组区，语义归属全部由语句上方的 `@tags` 行表达
 * （单个标签也写，因为没有段落名可回落）。标签候选 = 两库出现过的全部标签，
 * 也可以直接输入新标签；留空 = 无标签。
 *
 * 保存由父组件做（读盘-合并-写盘-重载悬浮库一条线都在 App 侧，按粘贴内容自动
 * 路由到 DDL 库 / 实体库），弹窗只管输入与识别反馈。Enter 不提交（多行文本），
 * Ctrl+Enter = 收录，Esc = 关闭。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { extractTableNames } from "../lib/ddl";
import { extractClassNames } from "../lib/javaEntity";
import ComboInput from "./ComboInput";
import { DialogPinButton, useDialogDrag, useDialogPinned } from "./DialogDragPin";

/**
 * 上一次收录用的标签串（0.38「设置项目默认是上一次使用的」沿用；键名保留旧值，
 * 0.39.17 起语义从「项目」改为「标签串」——用户此前输入的项目名大多就是标签）。
 */
export const DDL_LAST_TAGS_KEY = "quicknote.ddl.lastProject";

/** 读取上次收录用的标签串（没有/读不到返回空串）。 */
export function lastDdlTags(): string {
  try {
    return localStorage.getItem(DDL_LAST_TAGS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** 记住这次收录用的标签串（收录成功后由弹窗自己调用）。 */
export function rememberDdlTags(tags: string): void {
  try {
    if (tags) localStorage.setItem(DDL_LAST_TAGS_KEY, tags);
    else localStorage.removeItem(DDL_LAST_TAGS_KEY);
  } catch {
    // 尽力而为
  }
}

export default function DdlDialog({
  onSubmit,
  onClose,
  ddlPath,
  tagSuggestions = [],
}: {
  /** 落盘由父组件做。返回结果文案；抛错显示在弹窗里。tags = 输入的全部标签词。 */
  onSubmit: (ddlText: string, tags: string[]) => Promise<string>;
  onClose: () => void;
  /** DDL 笔记路径（提示文案里显示，让用户知道语句存去了哪）。 */
  ddlPath: string;
  /** 两库出现过的标签（去重）；下拉候选。 */
  tagSuggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  // 0.38 用户反馈「设置项目默认是上一次使用的」：初始值读上次收录用的标签串
  const [tags, setTags] = useState(() => lastDdlTags());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const tagsRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const tables = useMemo(() => extractTableNames(draft), [draft]);
  const classes = useMemo(() => extractClassNames(draft), [draft]);

  const submit = async () => {
    if ((!tables.length && !classes.length) || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      // 空格/逗号/顿号/分号（含全角）拆词，全部作为标签写入语句的 @tags 行
      //（0.39.17 起单个标签也写——没有段落名可回落了）
      const parts = tags
        .split(/[\s,，、;；]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      const text = await onSubmit(draft, [...new Set(parts)]);
      rememberDdlTags(parts.join(" "));
      setMessage({ text, kind: "ok" });
      setDraft("");
      areaRef.current?.focus();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const targetHint = [
    tables.length > 0 ? ddlPath : null,
    classes.length > 0 ? "Java实体笔记" : null,
  ]
    .filter(Boolean)
    .join(" / ");

  // 头部拖拽移动（0.39.19 用户反馈）
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogDrag = useDialogDrag(dialogRef);
  // 固定后弹窗常驻：不渲染遮罩（点背后的应用照常可操作），点外也不关闭
  const [pinned, setPinned] = useDialogPinned();

  return (
    <>
      {!pinned && <div className="menu-backdrop" onClick={onClose} />}
      <div ref={dialogRef} className="quick-capture ddl-dialog" role="dialog" aria-label="收录建表语句">
        <div className="quick-capture-head" {...dialogDrag}>
          <span className="quick-capture-title">收录语句（DDL / Java 实体）</span>
          <span className="spacer" />
          <DialogPinButton pinned={pinned} onToggle={() => setPinned((value) => !value)} />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>
        <textarea
          ref={areaRef}
          className="ddl-textarea"
          placeholder={
            "粘贴 CREATE TABLE 语句（可多条）或 Java 类源码，名称自动识别，例如：\n\nCREATE TABLE app_user (\n  id bigint NOT NULL,\n  ...\n) COMMENT '用户表';\n\npublic class AppUser { ... }"
          }
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
        <div className="ddl-project-row">
          <label>标签</label>
          {/* 0.38 用户反馈「下拉框风格要对齐软件」：ComboInput 自绘候选列表。
              0.39.17 用户反馈「去掉项目」：这一行只收标签（@tags 行），候选来自
              两库出现过的标签；多项目复用同一语句在管理面板里追加更多标签。 */}
          <ComboInput
            inputRef={tagsRef}
            ariaLabel="语句标签"
            value={tags}
            onChange={setTags}
            suggestions={tagSuggestions.filter((name) => name !== "")}
            placeholder="标签名，空格/逗号分隔可加多个 · 留空 = 无标签"
            title="空格/逗号分隔可一次写多个标签（@tags 行）。例：海亮 中远 → 标签为海亮+中远"
          />
        </div>
        <div className="quick-capture-help">
          <span>
            {tables.length + classes.length > 0
              ? `识别到 ${tables.length} 张表、${classes.length} 个类：${[...tables, ...classes].slice(0, 6).join("、")}${tables.length + classes.length > 6 ? " …" : ""}`
              : "等待 CREATE TABLE 语句或 Java 类定义…"}
          </span>
          <span className="spacer" />
          <span>
            {targetHint ? `保存到 ${targetHint} · 同名表/类替换` : "等待可识别的内容…"}
          </span>
        </div>
        <div className="quick-capture-foot">
          {message && (
            <span className={`add-word-message is-${message.kind}`}>{message.text}</span>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-primary quick-capture-save"
            disabled={(tables.length === 0 && classes.length === 0) || busy}
            onClick={() => void submit()}
          >
            {busy ? "保存中…" : "收录"}
          </button>
        </div>
      </div>
    </>
  );
}

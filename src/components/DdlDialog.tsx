/**
 * 语句收录弹窗（0.31 用户反馈）：快捷键（默认 Ctrl+Alt+J，可改绑）唤起，粘贴一段
 * CREATE TABLE（可多条）或 Java 类定义（0.34.13 扩展：class/interface/enum/record），
 * 自动识别表名/类名，确认后合并进仓库内对应的库笔记（DDL 笔记 / Java 实体笔记，
 * 路径见 设置 → 编辑）。
 *
 * 0.34.13 多项目（用户反馈「同时开发多个项目，存在表名复用的情况，考虑添加
 * ddl 语句时，添加项目的填入」）：新增项目输入框——语句归入该项目段落
 * （`## 项目名`），已有同名表/类只在该项目段落内替换；下拉候选来自库笔记里
 * 出现过的项目名，也可以直接输入新项目名；留空 = 未分组（默认）。
 *
 * 保存由父组件做（读盘-合并-写盘-重载悬浮库一条线都在 App 侧，按粘贴内容自动
 * 路由到 DDL 库 / 实体库），弹窗只管输入与识别反馈。Enter 不提交（多行文本），
 * Ctrl+Enter = 收录，Esc = 关闭。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { extractTableNames } from "../lib/ddl";
import { extractClassNames } from "../lib/javaEntity";
import ComboInput from "./ComboInput";

/** 上一次收录用的项目（0.38 用户反馈「设置项目默认是上一次使用的」）。 */
export const DDL_LAST_PROJECT_KEY = "quicknote.ddl.lastProject";

/** 读取上次使用的项目名（没有/读不到返回空串=未分组）。 */
export function lastDdlProject(): string {
  try {
    return localStorage.getItem(DDL_LAST_PROJECT_KEY) ?? "";
  } catch {
    return "";
  }
}

/** 记住这次用的项目（收录成功后由 App 侧调用）。 */
export function rememberDdlProject(project: string): void {
  try {
    if (project) localStorage.setItem(DDL_LAST_PROJECT_KEY, project);
    else localStorage.removeItem(DDL_LAST_PROJECT_KEY);
  } catch {
    // 尽力而为
  }
}

export default function DdlDialog({
  onSubmit,
  onClose,
  ddlPath,
  projects = [],
}: {
  /** 落盘由父组件做。返回结果文案；抛错显示在弹窗里。project = 选定的项目名。 */
  onSubmit: (ddlText: string, project: string) => Promise<string>;
  onClose: () => void;
  /** DDL 笔记路径（提示文案里显示，让用户知道语句存去了哪）。 */
  ddlPath: string;
  /** 库里出现过的项目名（去重含「默认」）；下拉候选。 */
  projects?: string[];
}) {
  // 0.38 用户反馈「设置项目默认是上一次使用的」：初始值读上次收录用的项目
  const [draft, setDraft] = useState("");
  const [project, setProject] = useState(() => lastDdlProject());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const projectRef = useRef<HTMLInputElement | null>(null);

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
      const text = await onSubmit(draft, project.trim());
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

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="quick-capture ddl-dialog" role="dialog" aria-label="收录建表语句">
        <div className="quick-capture-head">
          <span className="quick-capture-title">收录语句（DDL / Java 实体）</span>
          <span className="spacer" />
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
          <label>项目 / 标签</label>
          {/* 0.38 用户反馈「下拉框风格要对齐软件」：原生 datalist 是浏览器控件
              （深色主题里泛白突兀），换 ComboInput 自定义候选列表。
              0.39 起项目段落名同时是语句的默认标签；多项目复用同一语句可在
              管理面板（Ctrl+Alt+K）里追加多个标签。 */}
          <ComboInput
            inputRef={projectRef}
            ariaLabel="所属项目"
            value={project}
            onChange={setProject}
            suggestions={projects.filter((name) => name !== "")}
            placeholder="留空 = 默认（未分组）"
            title="语句归入该项目段落（## 项目名），段落名同时作为默认标签；多项目复用可在管理面板追加标签"
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
            {targetHint ? `保存到 ${targetHint} · 同名同项目内替换` : "等待可识别的内容…"}
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

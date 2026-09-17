/**
 * 设置面板：左侧分类导航 + 右侧配置区，顶部搜索框实时过滤设置项。
 *
 * 结构上的硬约束来自 GUI 验收脚本（它们按 DOM 契约驱动面板）：
 *   - 根节点类名必须是 `.settings-panel`（开合判断）；
 *   - 所有设置行都是 `.settings-row` 且第一个 span 是标签文本（按标签找控件）；
 *   - 「粘贴时保存附件」的复选框必须是面板里**第一个** checkbox（DOM 顺序：
 *     通用 → 外观 → 日记与附件 → 云同步 → 快捷键 → 关于）；
 *   - 第一个 `input[type=text]` 必须是「附件保存目录」。
 * 非激活分区**渲染但隐藏**：脚本是程序化赋值，隐藏元素照样能触发 onChange。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DAILY_CONFIG_FILE } from "../lib/daily";
import type { Settings } from "../lib/settings";
import type { DailyController } from "../lib/useDaily";
import type { SyncController } from "../lib/useSync";
import {
  IconCalendarPlus,
  IconListTree,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconX,
} from "./icons";

type SectionId = "general" | "appearance" | "daily" | "sync" | "shortcuts" | "about";

const SECTIONS: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "general", label: "通用", icon: <IconSettings size={14} /> },
  { id: "appearance", label: "外观", icon: <IconSparkles size={14} /> },
  { id: "daily", label: "日记与附件", icon: <IconCalendarPlus size={14} /> },
  { id: "sync", label: "云同步", icon: <IconRefresh size={14} /> },
  { id: "shortcuts", label: "快捷键", icon: <IconListTree size={14} /> },
  { id: "about", label: "关于", icon: <span className="settings-nav-logo">i</span> },
];

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  applySettings: (patch: Partial<Settings>) => void;
  daily: DailyController;
  sync: SyncController;
  customCssDraft: string;
  onCustomCssChange: (value: string) => void;
  appVersion: string;
  updateCheck: { state: "idle" | "checking" | "done" | "error"; message: string; url?: string };
  checkUpdate: () => void;
  openReleasePage: (url?: string) => void;
}

/** 设置面板里的说明文字：默认只显示一个「?」，点击才展开。 */
function Hint({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <p className="settings-hint">
      <button
        type="button"
        className="hint-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={open ? "收起说明" : "查看说明"}
      >
        ?
      </button>
      {open && <span className="hint-body">{children}</span>}
    </p>
  );
}

export default function SettingsDialog({
  open,
  onClose,
  settings,
  applySettings,
  daily,
  sync,
  customCssDraft,
  onCustomCssChange,
  appVersion,
  updateCheck,
  checkUpdate,
  openReleasePage,
}: Props) {
  const [active, setActive] = useState<SectionId>("general");
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 打开时重置到第一页并清空搜索
  useEffect(() => {
    if (open) {
      setActive("general");
      setQuery("");
    }
  }, [open]);

  // 搜索过滤：按行标签文本匹配；命中时显示全部分区（匹配行为 display:none 的反面）
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      // 还原：行全部显示，分区只显示激活的那个（由下面的 render 分支控制）
      root.querySelectorAll<HTMLElement>(".settings-sec").forEach((sec) => {
        sec
          .querySelectorAll<HTMLElement>(".settings-row, .settings-hint, .settings-actions, .settings-group")
          .forEach((row) => {
            row.style.display = "";
          });
      });
      return;
    }
    root.querySelectorAll<HTMLElement>(".settings-sec").forEach((sec) => {
      let visibleRows = 0;
      sec
        .querySelectorAll<HTMLElement>(".settings-row, .settings-hint, .settings-actions, .settings-group")
        .forEach((row) => {
          const label = row.classList.contains("settings-group")
            ? (row.textContent ?? "")
            : (row.querySelector("span")?.textContent ?? row.textContent ?? "");
          const hit = label.toLowerCase().includes(q);
          row.style.display = hit ? "" : "none";
          if (hit && row.classList.contains("settings-row")) visibleRows += 1;
        });
      sec.style.display = visibleRows > 0 ? "" : "none";
    });
  }, [query, active, open]);

  if (!open) return null;

  const searching = query.trim() !== "";

  return (
    <div className="settings-panel" role="dialog" aria-label="设置">
      <div className="settings-nav">
        <div className="settings-nav-head">
          <span className="settings-nav-title">设置</span>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="关闭设置（Esc）"
            aria-label="关闭设置"
          >
            <IconX size={14} />
          </button>
        </div>
        <div className="settings-search">
          <IconSearch size={13} />
          {/* type=search：GUI 验收按「面板里第一个 input[type=text] = 附件目录」定位控件 */}
          <input
            type="search"
            placeholder="搜索设置…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
          />
        </div>
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`settings-nav-item${!searching && active === section.id ? " is-on" : ""}`}
            onClick={() => {
              setActive(section.id);
              setQuery("");
            }}
          >
            {section.icon}
            <span>{section.label}</span>
          </button>
        ))}
      </div>

      <div className="settings-body" ref={bodyRef}>
        {/* 顺序即 DOM 顺序：gui 验收依赖「第一个 checkbox 是粘贴开关、
            第一个 text input 是附件目录」，不要调整分区先后。 */}
        <section className="settings-sec" data-sec="general" style={{ display: searching || active === "general" ? undefined : "none" }}>
          <div className="settings-group">通用</div>
          <label className="settings-row">
            <span>插入链接写法</span>
            <select
              value={settings.linkFormat}
              onChange={(event) =>
                applySettings({ linkFormat: event.target.value as Settings["linkFormat"] })
              }
            >
              <option value="wiki">Wiki：![[图.png]]</option>
              <option value="markdown">Markdown：![](/attachments/图.png)</option>
            </select>
          </label>
          <label className="settings-row">
            <span>粘贴时保存附件</span>
            <input
              type="checkbox"
              checked={settings.savePastedAttachments}
              onChange={(event) =>
                applySettings({ savePastedAttachments: event.target.checked })
              }
            />
          </label>
          <Hint>
            粘贴图片或文件会保存到附件目录（重名自动加序号，不覆盖已有文件），并在光标处插入链接。
            附件目录在「日记与附件」分组里设置，与 Obsidian 插件共用；同步开启后贴的图会自动上传。
          </Hint>
        </section>

        <section className="settings-sec" data-sec="appearance" style={{ display: searching || active === "appearance" ? undefined : "none" }}>
          <div className="settings-group">外观</div>
          <label className="settings-row">
            <span>主题</span>
            <select
              value={settings.theme}
              onChange={(event) =>
                applySettings({ theme: event.target.value as Settings["theme"] })
              }
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
              <option value="system">跟随系统</option>
            </select>
          </label>
          <Hint>
            深色是默认主题；「跟随系统」会在系统明暗切换时自动跟着变。
          </Hint>
          <div className="settings-group">自定义样式</div>
          <textarea
            className="custom-css-input"
            rows={6}
            spellCheck={false}
            value={customCssDraft}
            placeholder={"/* 覆盖 Markdown 渲染样式，例如： */\n.cm-lp-heading { font-weight: 500; }\n.cm-lp-table { font-size: 12px; }"}
            onChange={(event) => onCustomCssChange(event.target.value)}
          />
          <Hint>
            这段 CSS 会即时注入并保存在本机（不进仓库），用来微调 Markdown 渲染效果。
            常用选择器：<code>.cm-content</code> 正文、<code>.cm-lp-heading</code> 标题行、
            <code>.cm-lp-table</code> 表格、<code>.cm-lp-callout-note</code> 等 callout 容器、
            <code>.cm-lp-mermaid</code> mermaid 图。清空即恢复默认。
          </Hint>
        </section>

        <section className="settings-sec" data-sec="daily" style={{ display: searching || active === "daily" ? undefined : "none" }}>
          <div className="settings-group">日记与附件（写入库内 {DAILY_CONFIG_FILE}，与 Obsidian 插件共用）</div>
          <label className="settings-row">
            <span>附件保存目录</span>
            <input
              type="text"
              value={daily.settings.pastedImageFolder}
              placeholder="attachments（留空即仓库根目录）"
              onChange={(event) => daily.updateSettings({ pastedImageFolder: event.target.value })}
            />
          </label>
          <Hint>
            附件目录在库内配置里（键名与插件相同：pastedImageFolder），两边换用不用设两次；
            同步开启后多台设备自动一致。改这里会写入库内文件。
          </Hint>
          <label className="settings-row">
            <span>日记目录</span>
            <input
              type="text"
              value={daily.settings.folder}
              placeholder="日记（留空即仓库根目录）"
              onChange={(event) => daily.updateSettings({ folder: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>日期格式</span>
            <input
              type="text"
              value={daily.settings.dateFormat}
              placeholder="YYYY-MM-DD"
              onChange={(event) => daily.updateSettings({ dateFormat: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>启用日记模板</span>
            <input
              type="checkbox"
              checked={daily.settings.dailyTemplateEnabled}
              onChange={(event) =>
                daily.updateSettings({ dailyTemplateEnabled: event.target.checked })
              }
            />
          </label>
          <label className="settings-row">
            <span>日记模板文件</span>
            <input
              type="text"
              value={daily.settings.dailyTemplatePath}
              placeholder="模板/日记模板.md"
              onChange={(event) => daily.updateSettings({ dailyTemplatePath: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>启用周记模板</span>
            <input
              type="checkbox"
              checked={daily.settings.weeklyTemplateEnabled}
              onChange={(event) =>
                daily.updateSettings({ weeklyTemplateEnabled: event.target.checked })
              }
            />
          </label>
          <label className="settings-row">
            <span>周记模板文件</span>
            <input
              type="text"
              value={daily.settings.weeklyTemplatePath}
              placeholder="模板/周记模板.md"
              onChange={(event) => daily.updateSettings({ weeklyTemplatePath: event.target.value })}
            />
          </label>
          <Hint>
            日期格式是 moment 语法（插件同一套），它同时决定日记文件名与待办分桶。模板支持
            {" "}<code>{"{{title}}"}</code>、<code>{"{{date}}"}</code>、<code>{"{{date:格式}}"}</code>、
            <code>{"{{week}}"}</code>、<code>{"{{time}}"}</code>；未知占位符原样保留。
            这几项与插件共用一份配置，改动会写到库内文件。
          </Hint>
        </section>

        <section className="settings-sec" data-sec="sync" style={{ display: searching || active === "sync" ? undefined : "none" }}>
          <div className="settings-group">云同步（本机设置，不会写进仓库）</div>
          <label className="settings-row">
            <span>启用自动同步</span>
            <input
              type="checkbox"
              checked={sync.config.enabled}
              onChange={(event) => sync.updateConfig({ enabled: event.target.checked })}
            />
          </label>
          <label className="settings-row">
            <span>服务端地址</span>
            <input
              type="text"
              value={sync.config.serverUrl}
              placeholder="http://your-server:8080"
              onChange={(event) => sync.updateConfig({ serverUrl: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>账号</span>
            <input
              type="text"
              value={sync.config.username}
              autoComplete="off"
              onChange={(event) => sync.updateConfig({ username: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>密码</span>
            <input
              type="password"
              value={sync.config.password}
              autoComplete="off"
              onChange={(event) => sync.updateConfig({ password: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>推送范围</span>
            <select
              value={sync.config.scope}
              onChange={(event) =>
                sync.updateConfig({ scope: event.target.value as "folder" | "vault" })
              }
            >
              <option value="folder">仅日记目录</option>
              <option value="vault">整个仓库</option>
            </select>
          </label>
          <label className="settings-row">
            <span>云端仓库名</span>
            <input
              type="text"
              value={sync.config.vaultName}
              placeholder={`留空即用仓库文件夹名：${sync.vaultName}`}
              onChange={(event) => sync.updateConfig({ vaultName: event.target.value })}
            />
          </label>
          <Hint>
            与 Obsidian 插件共用同一个云端仓库。仓库名要与插件所在库的名字一致，否则会同步到
            另一个云端仓库（表现为「同步成功但数据没过来」）。正文、待办与<b>附件</b>（按笔记
            引用上传、本地缺的从云端补下）都会同步；服务端地址、账号与密码只存在本机，
            不会写进仓库。
          </Hint>
          <div className="settings-actions">
            <button type="button" className="btn" onClick={() => sync.syncNow()}>
              立即同步
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sync.resetCursorAndSync()}
              title="游标归零后重新全量拉取一次；本地状态异常时用它"
            >
              重置游标并重拉
            </button>
          </div>
        </section>

        <section className="settings-sec" data-sec="shortcuts" style={{ display: searching || active === "shortcuts" ? undefined : "none" }}>
          <div className="settings-group">快捷键</div>
          <div className="settings-row"><span>命令面板 / 全局搜索</span><kbd>Ctrl K</kbd><kbd>Ctrl P</kbd></div>
          <div className="settings-row"><span>新建笔记</span><kbd>Ctrl N</kbd></div>
          <div className="settings-row"><span>保存当前笔记</span><kbd>Ctrl S</kbd></div>
          <div className="settings-row"><span>切换 实时 / 源码</span><kbd>Ctrl E</kbd></div>
          <div className="settings-row"><span>收起 / 展开文件栏</span><kbd>Ctrl B</kbd></div>
          <div className="settings-row"><span>收起 / 展开右侧面板</span><kbd>Ctrl Shift B</kbd></div>
          <div className="settings-row"><span>专注模式（隐藏侧栏）</span><kbd>Ctrl Shift F</kbd></div>
          <div className="settings-row"><span>表格内跳格</span><kbd>Tab</kbd><kbd>Shift Tab</kbd></div>
          <div className="settings-row"><span>表格/图表回到源码</span><span className="settings-value">双击图表区</span></div>
          <div className="settings-row"><span>系统浏览器打开链接</span><kbd>Ctrl 点击</kbd></div>
          <div className="settings-row"><span>关闭标签</span><span className="settings-value">中键点击标签</span></div>
        </section>

        <section className="settings-sec" data-sec="about" style={{ display: searching || active === "about" ? undefined : "none" }}>
          <div className="settings-group">软件更新</div>
          <div className="settings-row">
            <span>当前版本</span>
            <span className="settings-value">v{appVersion || "…"}</span>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="btn"
              disabled={updateCheck.state === "checking"}
              onClick={() => void checkUpdate()}
            >
              {updateCheck.state === "checking" ? "检查中…" : "检查更新"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void openReleasePage(updateCheck.url)}
              title="在系统浏览器中打开 GitHub 发布页"
            >
              打开发布页
            </button>
          </div>
          {updateCheck.state !== "idle" && (
            <p className={`settings-hint${updateCheck.state === "error" ? " hint-error" : ""}`}>
              {updateCheck.message}
            </p>
          )}
          <div className="settings-group">关于</div>
          <p className="settings-hint">
            Quick Note — 本地优先的个人知识管理系统。文件保持纯 Markdown，
            可与 Obsidian 及 quick-daily-note 插件共用同一个仓库并同步。
          </p>
        </section>
      </div>
    </div>
  );
}

/**
 * 设置面板：左侧分类导航 + 右侧配置区，顶部搜索框实时过滤设置项。
 *
 * 结构上的硬约束来自 GUI 验收脚本（它们按 DOM 契约驱动面板）：
 *   - 根节点类名必须是 `.settings-panel`（开合判断）；
 *   - 所有设置行都是 `.settings-row` 且第一个 span 是标签文本（按标签找控件）；
 *   - 「粘贴时保存附件」的复选框必须是面板里**第一个** checkbox（DOM 顺序：
 *     通用 → 外观 → 日记与附件 → 云同步 → 快捷键 → 关于）；
 *   - 第一个 `input[type=text]` 必须是「附件保存目录」——外观里的背景图选择因此
 *     用下拉框（select），日记分区之前的文本输入也不能用 type=text。
 * 非激活分区**渲染但隐藏**：脚本是程序化赋值，隐藏元素照样能触发 onChange。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DAILY_CONFIG_FILE } from "../lib/daily";
import {
  allBindings,
  COMMAND_KEYS,
  comboOf,
  formatKey,
  onHotkeysChange,
  setBinding,
  setCapturing,
} from "../lib/hotkeys";
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
  /** 仓库内的图片路径（背景图下拉框的候选）。 */
  imagePaths: string[];
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
  imagePaths,
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

  // 快捷键：绑定表 + 「捕获下一次按键」的命令 id。捕获期间全局匹配被挂起
  // （hotkeys.isCapturing），按 Ctrl+B 重绑才不会顺手把文件栏切了。
  const [bindings, setBindings] = useState(allBindings);
  const [capturingId, setCapturingId] = useState<string | null>(null);
  useEffect(() => onHotkeysChange(() => setBindings(allBindings())), []);
  useEffect(() => {
    if (!open) return;
    if (!capturingId) {
      setCapturing(false);
      return;
    }
    setCapturing(true);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setCapturing(false);
      setCapturingId(null);
      if (event.key === "Escape") return; // Esc = 取消本次绑定
      // 只收带修饰键的组合（或功能键）：全局命令绑单个字母会让每次打字都触发命令
      const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !/^F\d+$/.test(event.key);
      if (bare) return;
      const combo = comboOf(event);
      // 同一组合绑给了别的命令时，从那边移除（覆盖写法，不动它的其余键位）
      for (const other of bindings) {
        if (other.id !== capturingId && other.keys.includes(combo)) {
          setBinding(other.id, other.keys.filter((key) => key !== combo));
        }
      }
      setBinding(capturingId, [combo]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setCapturing(false);
    };
  }, [capturingId, open, bindings]);

  // 打开时重置到第一页并清空搜索；关闭时取消未完成的键位捕获
  useEffect(() => {
    if (open) {
      setActive("general");
      setQuery("");
    } else {
      setCapturingId(null);
      setCapturing(false);
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
          <label className="settings-row">
            <span>粘贴代码自动识别语言</span>
            <input
              type="checkbox"
              checked={daily.settings.autoDetectCodeLang}
              onChange={(event) =>
                daily.updateSettings({ autoDetectCodeLang: event.target.checked })
              }
            />
          </label>
          <Hint>
            粘贴一段代码时自动识别语言（30+ 种）并包成围栏代码块；已带围栏的代码、
            代码块内部的粘贴不会被改写。开关存在库内配置里（与 Obsidian 插件共用）。
          </Hint>
          <label className="settings-row">
            <span>打开笔记时</span>
            <select
              value={settings.openNoteMode}
              onChange={(event) =>
                applySettings({ openNoteMode: event.target.value as Settings["openNoteMode"] })
              }
            >
              <option value="replace">替换当前标签（Obsidian 式）</option>
              <option value="newTab">新开一个标签页</option>
            </select>
          </label>
          <Hint>
            只影响打开**没打开过**的笔记：替换模式下标签数不增长，点文件树就像翻页；
            已打开过的笔记永远切回原有标签，两种模式一致。标签多时可以在标签栏上
            用滚轮左右滑动。
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
          <label className="settings-row">
            <span>Markdown 渲染风格</span>
            <select
              value={settings.renderStyle}
              onChange={(event) =>
                applySettings({ renderStyle: event.target.value as Settings["renderStyle"] })
              }
            >
              <option value="default">默认</option>
              <option value="blueTopaz">Blue Topaz 风</option>
            </select>
          </label>
          <Hint>
            Blue Topaz 风仿照 Obsidian 社区主题 Blue Topaz 的正文观感：彩色标题层级、
            蓝色标题下划线、着色表头与加重的 callout / 引用块。只影响渲染样式，
            不改任何文件内容；与下方「自定义样式」叠加生效（自定义的优先级更高）。
          </Hint>
          <label className="settings-row">
            <span>显示行号数字</span>
            <input
              type="checkbox"
              checked={settings.showLineNumbers}
              onChange={(event) => applySettings({ showLineNumbers: event.target.checked })}
            />
          </label>
          <Hint>
            默认关闭（笔记不是代码）。打开后编辑区左缘显示行号，与当前行高亮联动。
          </Hint>
          <div className="settings-group">全局背景（每设备独立，存本机）</div>
          <label className="settings-row">
            <span>启用背景图片</span>
            <input
              type="checkbox"
              checked={settings.bgEnabled}
              onChange={(event) => applySettings({ bgEnabled: event.target.checked })}
            />
          </label>
          <label className="settings-row">
            <span>背景图片</span>
            <select
              value={settings.bgImagePath}
              onChange={(event) =>
                applySettings({
                  bgImagePath: event.target.value,
                  // 选了图顺手启用；选回「无」就一并关掉，避免开着背景却没图的悬空状态
                  bgEnabled: event.target.value ? true : false,
                })
              }
            >
              <option value="">（无背景图）</option>
              {settings.bgImagePath && !imagePaths.includes(settings.bgImagePath) && (
                <option value={settings.bgImagePath}>{settings.bgImagePath}（文件不在仓库里）</option>
              )}
              {imagePaths.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          <Hint>
            下拉框列出当前仓库里的全部图片（png/jpg/gif/webp 等）。想用新图就先把它
            拷进仓库附件目录再回来选。开启后顶栏、侧栏与编辑器卡片会变为半透明让背景
            透出。支持静态图片；刻意不支持视频动态壁纸（常驻解码是内存杀手，与
            「轻量」目标相反）。
          </Hint>
          <label className="settings-row">
            <span>适配方式</span>
            <select
              value={settings.bgFit}
              onChange={(event) =>
                applySettings({ bgFit: event.target.value as Settings["bgFit"] })
              }
            >
              <option value="cover">铺满裁剪（cover）</option>
              <option value="contain">完整显示（contain）</option>
            </select>
          </label>
          <label className="settings-row">
            <span>不透明度</span>
            <input
              type="range" min={0} max={100} step={5}
              value={Math.round(settings.bgOpacity * 100)}
              onChange={(event) => applySettings({ bgOpacity: Number(event.target.value) / 100 })}
            />
          </label>
          <label className="settings-row">
            <span>模糊</span>
            <input
              type="range" min={0} max={30} step={1}
              value={settings.bgBlur}
              onChange={(event) => applySettings({ bgBlur: Number(event.target.value) })}
            />
          </label>
          <label className="settings-row">
            <span>亮度</span>
            <input
              type="range" min={30} max={150} step={5}
              value={settings.bgBrightness}
              onChange={(event) => applySettings({ bgBrightness: Number(event.target.value) })}
            />
          </label>
          <label className="settings-row">
            <span>对比度</span>
            <input
              type="range" min={30} max={150} step={5}
              value={settings.bgContrast}
              onChange={(event) => applySettings({ bgContrast: Number(event.target.value) })}
            />
          </label>
          <label className="settings-row">
            <span>水平位置</span>
            <input
              type="range" min={0} max={100} step={5}
              value={settings.bgPosX}
              onChange={(event) => applySettings({ bgPosX: Number(event.target.value) })}
            />
          </label>
          <label className="settings-row">
            <span>垂直位置</span>
            <input
              type="range" min={0} max={100} step={5}
              value={settings.bgPosY}
              onChange={(event) => applySettings({ bgPosY: Number(event.target.value) })}
            />
          </label>
          <label className="settings-row">
            <span>缩放</span>
            <input
              type="range" min={50} max={200} step={5}
              value={settings.bgScale}
              onChange={(event) => applySettings({ bgScale: Number(event.target.value) })}
            />
          </label>
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
          <div className="settings-group">定时提醒（写入库内配置，与插件共用）</div>
          <label className="settings-row">
            <span>每天提醒添加待办</span>
            <input
              type="checkbox"
              checked={daily.settings.todoReminderEnabled}
              onChange={(event) =>
                daily.updateSettings({ todoReminderEnabled: event.target.checked })
              }
            />
          </label>
          <label className="settings-row">
            <span>提醒时间</span>
            <input
              type="text"
              value={daily.settings.todoReminderTime}
              placeholder="08:00"
              onChange={(event) => daily.updateSettings({ todoReminderTime: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>到点检查未完成待办</span>
            <input
              type="checkbox"
              checked={daily.settings.checkReminderEnabled}
              onChange={(event) =>
                daily.updateSettings({ checkReminderEnabled: event.target.checked })
              }
            />
          </label>
          <label className="settings-row">
            <span>检查时间</span>
            <input
              type="text"
              value={daily.settings.checkReminderTime}
              placeholder="21:00"
              onChange={(event) => daily.updateSettings({ checkReminderTime: event.target.value })}
            />
          </label>
          <Hint>
            两条提醒都以系统通知 + 界面提示的形式出现。启用时如果当天时间点已过，
            当天不再补提醒（从次日生效）；检查提醒只在当日确有未完成待办时触发。
          </Hint>
          <div className="settings-group">天气（写入库内配置，与插件共用）</div>
          <label className="settings-row">
            <span>新建日记时写入天气</span>
            <input
              type="checkbox"
              checked={daily.settings.weatherEnabled}
              onChange={(event) => daily.updateSettings({ weatherEnabled: event.target.checked })}
            />
          </label>
          <label className="settings-row">
            <span>城市</span>
            <input
              type="text"
              value={daily.settings.weatherCity}
              placeholder="北京"
              onChange={(event) => daily.updateSettings({ weatherCity: event.target.value })}
            />
          </label>
          <Hint>
            数据来自 Open-Meteo（免费、无需 API key）。新建日记时抓取一次，
            以引用行（<code>&gt; ☀️ 晴 25°C</code>）插在 frontmatter 之后；
            抓取失败会静默跳过，绝不阻塞日记创建。
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
          <div className="settings-group">快捷键（点击键位重新绑定，Esc 取消）</div>
          {bindings.map((command) => {
            const isDefault =
              command.keys.join(",") === (COMMAND_KEYS.find((c) => c.id === command.id)?.keys.join(",") ?? "");
            return (
              <div className="settings-row" key={command.id}>
                <span>{command.label}</span>
                <span className="shortcut-keys">
                  {capturingId === command.id ? (
                    <span className="shortcut-capture">按任意键组合…（Esc 取消）</span>
                  ) : command.keys.length > 0 ? (
                    command.keys.map((combo) => (
                      <kbd key={combo}>
                        <button
                          type="button"
                          className="shortcut-edit"
                          title="点击修改这个快捷键"
                          onClick={() => setCapturingId(command.id)}
                        >
                          {formatKey(combo)}
                        </button>
                      </kbd>
                    ))
                  ) : (
                    <button
                      type="button"
                      className="shortcut-add"
                      title="未绑定快捷键，点击设置一个"
                      onClick={() => setCapturingId(command.id)}
                    >
                      添加快捷键
                    </button>
                  )}
                  {!isDefault && (
                    <button
                      type="button"
                      className="shortcut-reset"
                      title="恢复默认键位"
                      onClick={() => {
                        setBinding(command.id, null);
                      }}
                    >
                      ↺
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          <Hint>
            与 Obsidian 一样，点命令右侧的键位再按新组合即可重绑定；组合需要带 Ctrl/Alt
            或功能键（避免打字误触）。同一组合绑定到两条命令时，后绑定的一方生效、
            原命令的该键位自动让出。编辑器内的键位（Tab 跳格、双击表格回源码等）不在此列。
          </Hint>
          <div className="settings-group">固定键位</div>
          <div className="settings-row"><span>表格内跳格</span><kbd>Tab</kbd><kbd>Shift Tab</kbd></div>
          <div className="settings-row"><span>表格/图表回到源码</span><span className="settings-value">双击图表区</span></div>
          <div className="settings-row"><span>系统浏览器打开链接</span><kbd>Ctrl 点击</kbd></div>
          <div className="settings-row"><span>关闭标签</span><span className="settings-value">中键点击标签</span></div>
          <div className="settings-row"><span>单元格结构菜单</span><span className="settings-value">右键点击单元格</span></div>
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

import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { languages } from "@codemirror/language-data";
import { separatorFor } from "./lineEndings";
import { blockWidgetsField, livePreviewExtension } from "./livePreview";
import { livePreviewContext, type LivePreviewContext } from "./paths";
import { altClickHandler, linkClickHandler } from "./markdownExtras";
import { customSearchPanel } from "./searchPanel";
import { attachmentPaste, smartPaste, type AttachmentOptions, type CodePasteOptions } from "./paste";
import { toggleCodeBlock, editorShiftTab, editorTab, toggleHeading, toggleInlineCode } from "./codeEdit";
import { bindingFor, comboOf, comboOfCode, isCapturing } from "./hotkeys";
import { syntaxTheme } from "./syntaxTheme";
import { isCursorInTable, tableShiftTab, tableTab } from "./tableEdit";
import type { EditorLanguage } from "./fileTypes";

/** 视图模式：Live Preview（渲染语法）或源码。 */
export type ViewMode = "live" | "source";

/** 按扩展名选语法：Markdown 笔记走 GFM，json/sql/yaml 走各自语言，其余纯文本。 */
function languageExtension(language: EditorLanguage): Extension {
  switch (language) {
    case "markdown":
      return markdown({ base: markdownLanguage, codeLanguages: languages });
    case "json":
      return json();
    case "sql":
      return sql();
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

/**
 * Live Preview 的开关放在 Compartment 里，这样切换模式不必重建整个状态，
 * 撤销历史与光标位置都能保留。
 */
const livePreviewCompartment = new Compartment();

/**
 * 深色标记。CodeMirror 靠它决定光标、选区等内置配色的明暗；它必须随主题重配，
 * 而语法高亮的颜色走 CSS 变量，所以不需要重配。
 */
const darkCompartment = new Compartment();

const modeExtensions = (mode: ViewMode): Extension[] =>
  // 需要整块替换的内容（表格、mermaid 图）必须由 StateField 提供，
  // 因为 CM6 不允许插件产生块级装饰。所以这里同时挂上装饰插件与 StateField。
  mode === "live" ? [livePreviewExtension(), blockWidgetsField] : [];

export function applyMode(view: EditorView, mode: ViewMode): void {
  view.dispatch({ effects: livePreviewCompartment.reconfigure(modeExtensions(mode)) });
}

/** 切换编辑器的明暗标记（不是配色——配色来自 CSS 变量）。 */
export function applyDarkTheme(view: EditorView, isDark: boolean): void {
  view.dispatch({ effects: darkCompartment.reconfigure(EditorView.darkTheme.of(isDark)) });
}

export interface EditorHandle {
  view: EditorView;
  destroy(): void;
}

export interface CreateEditorStateOptions {
  lineEnding: string;
  mode: ViewMode;
  /**
   * 语法（按文件扩展名解析，默认 markdown）。非 markdown 的文件**强制源码视图**：
   * 实时预览的 Markdown 装饰对 JSON/SQL/YAML 没有意义（`# 注释` 会变成标题等）。
   */
  language?: EditorLanguage;
  onDocChanged: () => void;
  /** Mod-S 的处理函数。用读 ref 的包装传入，避免捕获过期的闭包。 */
  onSave?: () => void;
  /** 资源解析上下文（仓库根目录 + 当前笔记路径），用于加载库内图片。 */
  resources?: LivePreviewContext;
  /** 粘贴附件的行为配置；不传则不接管粘贴。 */
  attachment?: AttachmentOptions;
  /** 智能文本粘贴（换行符规范化/表格转换/代码围栏）的配置；不传则不接管。 */
  codePaste?: CodePasteOptions;
  /** 初始是否用深色标记（光标/选区等内置配色）。 */
  dark?: boolean;
  /**
   * 光标进入/离开表格块时回调（表格工具栏的显示依据）。
   * 选区移动不触发 onDocChanged，所以要单独的通道。
   */
  onCursorInTable?: (inside: boolean) => void;
  /** 光标所在行变化时回调（0 基；目录面板高亮当前标题）。 */
  onCursorLine?: (line: number) => void;
}

/**
 * 为一个文档建立编辑器状态。
 *
 * 配置 `EditorState.lineSeparator` 后，CodeMirror 只把这一种分隔符当换行，回车
 * 插入的也是它，`state.sliceDoc()` 会用同一种分隔符拼回字符串——文件因此可以
 * 原样往返，不做任何规范化。这是同步协议（按内容 SHA-256 判增量）能正常工作
 * 的前提：任何隐式改写都会被判成改动，制造虚假冲突。
 *
 * 两个坑：
 *   1. 序列化必须用 `state.sliceDoc()`。`state.doc.toString()` 固定用 `\n`
 *      拼接，会把 CRLF 与仅 CR 的文件悄悄改写成 LF。
 *   2. lineSeparator 是 facet，切换文件时必须随状态一起重建，不能沿用旧状态。
 *
 * 分隔符映射见 `lineEndings.ts`；以上两点由 `scripts/verify-all.sh` 回归覆盖。
 */
export function createEditorState(
  doc: string,
  options: CreateEditorStateOptions,
): EditorState {
  const {
    lineEnding,
    mode,
    language = "markdown",
    onDocChanged,
    onSave,
    resources,
    attachment,
    codePaste: codePasteOptions,
    dark,
    onCursorInTable,
    onCursorLine,
  } = options;
  // 非 Markdown 一律源码视图（无装饰），且 markdown() 语法解析也换成对应语言
  const effectiveMode: ViewMode = language === "markdown" ? mode : "source";
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      syntaxTheme,
      darkCompartment.of(EditorView.darkTheme.of(dark === true)),
      // GFM（表格、任务列表）+ 围栏代码块语法高亮。
      // 语言包由 @codemirror/language-data 动态按需加载，不进入主包。
      languageExtension(language),
      EditorView.lineWrapping,
      EditorState.lineSeparator.of(separatorFor(lineEnding)),
      livePreviewContext.of(
        resources ?? { vaultPath: null, notePath: null, embedIndex: new Map(), generation: 0 },
      ),
      livePreviewCompartment.of(modeExtensions(effectiveMode)),
      attachment ? attachmentPaste(attachment) : [],
      codePasteOptions ? smartPaste(codePasteOptions) : [],
      // 空列表项上回车 = 退出列表（删掉标记）。必须用 highest 压过 lang-markdown
      // 内置 Enter——它同样包在 Prec.high 里，同级时先注册的它会赢，导致
      // 「紧凑两元素列表的空项」不退出而是插空行转松散列表，连按回车退不出
      // 列表。见 exitEmptyListItem。
      Prec.highest(keymap.of([{ key: "Enter", run: exitEmptyListItem }])),
      linkClickHandler(),
      altClickHandler(),
      // 重设计的搜索面板（Ctrl+F）：替代 CM 默认 Find Bar
      customSearchPanel(),
      // 表格里的 Tab 是"下一格"，必须压过 basicSetup 的缩进键位。
      // 光标不在表格里时处理函数返回 false，缩进照常。
      // 裸 Tab / Shift+Tab 是 Obsidian 式缩进：此前没有绑定，按键会按浏览器
      // 默认行为把焦点移出编辑器。
      Prec.high(
        keymap.of([
          { key: "Tab", run: tableTab },
          { key: "S-Tab", run: tableShiftTab },
          { key: "Tab", run: editorTab },
          { key: "S-Tab", run: editorShiftTab },
        ]),
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChanged();
        if (onCursorInTable && (update.docChanged || update.selectionSet)) {
          onCursorInTable(isCursorInTable(update.state));
        }
        if (onCursorLine && (update.docChanged || update.selectionSet)) {
          onCursorLine(update.state.doc.lineAt(update.state.selection.main.head).number - 1);
        }
      }),
      onSave ? modSKeymap(onSave) : [],
      // 行内代码 / 代码块切换（Mod-` 等，键位在「设置 → 快捷键」里可改）。
      // 编辑器内分发：焦点不在编辑器时不接管，全局命令也不受影响。
      editorToggleKeymap(),
    ],
  });
}

/** 行尾空列表项（只有标记没有内容）：`2. `、`- `、`- [ ] ` 等。 */
const EMPTY_LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?\s*$/;

/** 列表项行（取首部缩进用于兄弟判断）。 */
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/;

/**
 * 空列表项上按回车：删掉标记退出列表，回到普通段落。
 *
 * lang-markdown 内置的 insertNewlineContinueMarkup 对「紧凑两元素列表的空项」
 * 有个特殊分支：不退出，而是插一个空行把列表转成松散列表（源码注释
 * "Move second item down, making tight two-item list non-tight"），表现即
 * 1. 测试 / 空行 / 2.，要第三次回车才真正退出——快速连按回车时就是
 * 「隔行续序号、退不出列表」。这里在键位层提前接管，且只查文档文本、
 * 不查语法树，天然免疫快速连按时的增量解析竞态。
 *
 * 仅当紧邻上一行是同缩进的列表兄弟项时接管（这正是内置命令会走错分支的
 * 场景）；单元素列表、空行之后的退出与嵌套层级的降级仍由内置命令处理。
 */
function exitEmptyListItem(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false; // 光标在行尾才接管
  const match = EMPTY_LIST_ITEM_RE.exec(line.text);
  if (!match || line.from === 0) return false;
  const prev = state.doc.lineAt(line.from - 1);
  if (!prev.text.trim()) return false; // 空行之后内置命令本来就会退出
  const prevIndent = LIST_ITEM_RE.exec(prev.text)?.[1];
  if (prevIndent === undefined || prevIndent !== match[1]) return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: match[1] },
    selection: { anchor: line.from + match[1].length },
    userEvent: "input.delete",
  });
  return true;
}

/**
 * 行内代码 / 代码块切换的键位分发。
 *
 * 键位读 hotkeys 的实时绑定表（不是状态创建时的快照），设置面板里改完立即生效。
 * 设置面板「捕获下一次按键」期间让路，否则重绑 Mod-` 会先切一次行内代码。
 */
function editorToggleKeymap(): Extension {
  return EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (isCapturing() || !view.hasFocus) return false;
      // comboOfCode：Shift+反引号在美式键盘上 key 是 "~"，用物理键位兜底
      const combo = comboOfCode(event) ?? comboOf(event);
      if (bindingFor("toggleInlineCode").includes(combo)) {
        event.preventDefault();
        return toggleInlineCode(view);
      }
      if (bindingFor("toggleCodeBlock").includes(combo)) {
        event.preventDefault();
        return toggleCodeBlock(view);
      }
      // 标题 1–6（Ctrl+1..6）：作用于光标所在行，再按同级别取消
      for (let level = 1; level <= 6; level += 1) {
        if (bindingFor(`heading${level}`).includes(combo)) {
          event.preventDefault();
          return toggleHeading(view, level);
        }
      }
      return false;
    },
  });
}

/** Mod-S 保存快捷键。 */
export function modSKeymap(onSave: () => void): Extension {
  return keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        onSave();
        return true;
      },
    },
  ]);
}

export function createEditor(parent: HTMLElement, state: EditorState): EditorHandle {
  const view = new EditorView({ state, parent });
  // dev 调试句柄：GUI 验收脚本（CDP）可以由此直接读编辑器状态，不必碰内部 DOM。
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__qnView = view;
  }
  return {
    view,
    destroy: () => view.destroy(),
  };
}

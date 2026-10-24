import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { keymap } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree, type LanguageDescription } from "@codemirror/language";
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { languages } from "@codemirror/language-data";
import { separatorFor } from "./lineEndings";
import { blockWidgetsField, gutterNumberAlign, livePreviewExtension } from "./livePreview";
import { livePreviewContext, type LivePreviewContext } from "./paths";
import { altClickHandler, linkClickHandler } from "./markdownExtras";
import { ddlHover } from "./ddlHover";
import { customSearchPanel } from "./searchPanel";
import { attachmentPaste, smartPaste, type AttachmentOptions, type CodePasteOptions } from "./paste";
import { codeAtCursor, toggleBold, toggleBulletList, toggleCodeBlock, editorShiftTab, editorTab, toggleHeading, toggleInlineCode, toggleNumberList } from "./codeEdit";
import { markdownPairAction } from "./autoPairs";
import { bindingFor, comboOf, comboOfCode, isCapturing, isHotkeyEnabled } from "./hotkeys";
import { syntaxTheme } from "./syntaxTheme";
import { logLanguageDescription } from "./logLang";
import { isCursorInTable, tableShiftTab, tableTab } from "./tableEdit";
import type { EditorLanguage } from "./fileTypes";

/** 视图模式：Live Preview（渲染语法）或源码。 */
export type ViewMode = "live" | "source";

/** 围栏语言候选：语言包全量 + 自带的 log（```log 块高亮见 logLang.ts）。 */
const fenceLanguages: readonly LanguageDescription[] = [logLanguageDescription, ...languages];

const fenceLangOptions: readonly Completion[] = fenceLanguages.map((language) => ({
  label: language.name,
  alias: language.alias,
  type: "language",
}));

/** 语言名之外的信息（`bash 参数`、`js title=x`）不联想。 */
const FENCE_INFO_RE = /^[\w+#.\-]*$/;

/**
 * 围栏语言联想：光标在 ``` 后面的语言名（CodeInfo）里时，给出全部支持的
 * 语言；选中直接补全（大写输入的 "Log" 会以规范小写 "log" 落盘）。
 * 其他位置返回 null——basicSetup 的 autocompletion 全局兜底，别处不出弹层。
 */
function fenceLangSource(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context;
  ensureSyntaxTree(state, pos, 75);
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  if (node.name !== "CodeInfo") node = syntaxTree(state).resolveInner(pos, 1);
  if (node.name !== "CodeInfo" || node.parent?.name !== "FencedCode") return null;
  const before = state.sliceDoc(node.from, pos);
  if (!FENCE_INFO_RE.test(before)) return null;
  return { from: node.from, to: pos, options: fenceLangOptions, validFor: FENCE_INFO_RE };
}

/** 按扩展名选语法：Markdown 笔记走 GFM，json/sql/yaml 走各自语言，其余纯文本。 */
function languageExtension(language: EditorLanguage): Extension {
  switch (language) {
    case "markdown":
      return markdown({ base: markdownLanguage, codeLanguages: fenceLanguages });
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
 * 资源上下文的 Compartment（0.32 分屏）：stateStore 的存量 EditorState 会在
 * 主编辑器与分屏编辑器之间流转，两边的 notePath 不同——上下文必须随**装它的
 * 视图**重配（applyLivePreviewContext），否则图片/嵌入按另一篇笔记的路径解析。
 */
const livePreviewContextCompartment = new Compartment();

/**
 * 深色标记。CodeMirror 靠它决定光标、选区等内置配色的明暗；它必须随主题重配，
 * 而语法高亮的颜色走 CSS 变量，所以不需要重配。
 */
const darkCompartment = new Compartment();

/**
 * 编辑开关（0.33.0 批C 阅读/编辑分离）：移动端默认阅读态。用
 * EditorView.editable（视图层禁输入）而不是 state.readOnly——任务勾选等
 * widget 的程序 dispatch、选区复制、链接点击在 editable=false 下全部照常。
 * 桌面恒 true；值随 EditorState 进 stateStore 缓存，装载后由 App 统一重配。
 */
const editableCompartment = new Compartment();

/** 重配某个视图的可编辑性（不重建状态，撤销历史与光标保留）。 */
export function applyEditable(view: EditorView, editable: boolean): void {
  // 防御：状态里没有本 Compartment 时（App 的空状态裸 create）reconfigure 会
  // 抛错——空状态自带静态 editable.of(false)，这里跳过即可，别让 effect 崩
  try {
    view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) });
  } catch {
    /* 空状态：静态已禁编辑，无需重配 */
  }
}

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
  /**
   * 文档变更回调（0.32 起带 view 参数）：同一份 EditorState 可能在主编辑器与
   * 分屏编辑器之间流转（stateStore 共享），回调按 view 身份路由写回正确的
   * 路径键——不带 view 的闭包会固化为创建那一刻的归属，流转后写错位置。
   */
  onDocChanged: (view: EditorView) => void;
  /** Mod-S 的处理函数（同样带 view：分屏里保存走分屏的通道）。 */
  onSave?: (view: EditorView) => void;
  /** 资源解析上下文（仓库根目录 + 当前笔记路径），用于加载库内图片。 */
  resources?: LivePreviewContext;
  /** 粘贴附件的行为配置；不传则不接管粘贴。 */
  attachment?: AttachmentOptions;
  /** 智能文本粘贴（换行符规范化/表格转换/代码围栏）的配置；不传则不接管粘贴。 */
  codePaste?: CodePasteOptions;
  /** 初始是否用深色标记（光标/选区等内置配色）。 */
  dark?: boolean;
  /**
   * 光标进入/离开表格块时回调（表格工具栏的显示依据）。
   * 选区移动不触发 onDocChanged，所以要单独的通道。
   */
  onCursorInTable?: (inside: boolean, view: EditorView) => void;
  /** 光标所在行变化时回调（0 基；目录面板高亮当前标题，按 view 路由主/分屏）。 */
  onCursorLine?: (line: number, view: EditorView) => void;
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
      // 0.33.0 批C：初值恒可编辑；移动端由 App 装载后按阅读/编辑态重配
      editableCompartment.of(EditorView.editable.of(true)),
      // GFM（表格、任务列表）+ 围栏代码块语法高亮。
      // 语言包由 @codemirror/language-data 动态按需加载，不进入主包。
      languageExtension(language),
      // 围栏语言联想（```log 输入时弹支持列表，选中补全）。override 全局只此
      // 一源：本编辑器没有别的补全需求，顺带压掉 basicSetup 的空配置
      autocompletion({ override: [fenceLangSource] }),
      // Markdown 成对符号自动闭合（仅 markdown 语言；判定核心在 autoPairs.ts）
      autoPairExtension(language),
      EditorView.lineWrapping,
      EditorState.lineSeparator.of(separatorFor(lineEnding)),
      // 资源上下文进 Compartment（0.32 分屏）：stateStore 里的存量状态装进
      // 分屏视图时要换成分屏自己的上下文（notePath 不同），不能重建状态丢历史
      livePreviewContextCompartment.of(
        livePreviewContext.of(
          resources ?? { vaultPath: null, notePath: null, embedIndex: new Map(), generation: 0 },
        ),
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
      // 表名悬浮预览（0.31）：光标停在已收录的表名上显示建表语句
      ddlHover(),
      // 重设计的搜索面板（Ctrl+F）：替代 CM 默认 Find Bar
      customSearchPanel(),
      // // 表格里的 Tab 是"下一格"，必须压过 basicSetup 的缩进键位。
      // // 光标不在表格里时处理函数返回 false，缩进照常。
      // // 裸 Tab / Shift+Tab 是 Obsidian 式缩进：此前没有绑定，按键会按浏览器
      // // 默认行为把焦点移出编辑器。
      Prec.high(
        keymap.of([
          { key: "Tab", run: tableTab },
          { key: "S-Tab", run: tableShiftTab },
          { key: "Tab", run: editorTab },
          { key: "S-Tab", run: editorShiftTab },
        ]),
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChanged(update.view);
        if (onCursorInTable && (update.docChanged || update.selectionSet)) {
          onCursorInTable(isCursorInTable(update.state), update.view);
        }
        if (onCursorLine && (update.docChanged || update.selectionSet)) {
          onCursorLine(update.state.doc.lineAt(update.state.selection.main.head).number - 1, update.view);
        }
      }),
      onSave ? modSKeymap(onSave) : [],
      // // 行内代码 / 代码块切换（Mod-` 等，键位在「设置 → 快捷键」里可改）。
      // // 编辑器内分发：焦点不在编辑器时不接管，全局命令也不受影响。
      editorToggleKeymap(),
      // 行号对到每行第一个文本行（标题行的 padding 补偿）；源码模式下自愈为无补丁
      gutterNumberAlign(),
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
  if (selection.head !== line.to && selection.head !== line.from) {
    // ① 光标在成对反引号内部（自动闭合把光标留在对内）：跳到闭合反引号之后，
    //    再走内置的列表续行/换行——直接回车会把行内代码劈成两半并把下一个
    //    序号插进劈开的位置，列表渲染错乱
    const before = line.text.slice(0, selection.head - line.from);
    const after = line.text.slice(selection.head - line.from);
    const leftTick = before.length - before.replace(/`+$/, "").length;
    const rightTick = after.length - after.replace(/^`+/, "").length;
    if (leftTick >= 1 && rightTick >= 1) {
      view.dispatch({ selection: { anchor: selection.head + rightTick }, userEvent: "select" });
      return insertNewlineContinueMarkup(view);
    }
  }
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
 * basicSetup 内置 closeBrackets 会配对的字符——在代码语境里这些字符一律改为
 * 原样插入（否则围栏代码块里写 `(`、`"` 会被强行补全，干扰代码内容）。
 */
const CODE_PLAIN_CHARS = new Set(["(", ")", "[", "]", "{", "}", '"', "'"]);

/**
 * Markdown 成对符号自动闭合（判定核心见 autoPairs.ts，本函数只做胶水）：
 * 输入单字符时按语法上下文（围栏/行内代码）与光标前后文本判定动作并改写事务。
 *
 * - 仅 Markdown 语言启用；多光标与 IME 组合不走此路径（交给默认输入）。
 * - `Prec.high` 保证先于 basicSetup 的 closeBrackets：需要接管 `[`（任务列表/图片）
 *   并在代码语境里"原样插入"以压制其配对。
 * - 语法树用 ensureSyntaxTree 强制解析到光标（预算 75ms）——快速输入时增量
 *   解析可能滞后，直接 query 会把围栏内容误判为普通文本。
 */
function autoPairExtension(language: EditorLanguage): Extension {
  if (language !== "markdown") return [];
  return Prec.high(
    EditorView.inputHandler.of((view, from, to, text) => {
      if (text.length !== 1) return false;
      const { state } = view;
      if (state.selection.ranges.length > 1) return false;
      ensureSyntaxTree(state, to, 75);
      let inFence = false;
      let inInlineCode = false;
      for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(to, -1); node; node = node.parent) {
        if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "HTMLBlock") {
          inFence = true;
          break;
        }
        if (node.name === "InlineCode") {
          inInlineCode = true;
          break;
        }
      }
      const action = markdownPairAction(text, {
        before: state.sliceDoc(Math.max(0, from - 120), from),
        after: state.sliceDoc(to, Math.min(state.doc.length, to + 120)),
        hasSelection: from !== to,
        inFence,
        inInlineCode,
      });
      if (import.meta.env.DEV) {
        const w = window as unknown as { __aplog?: string[] };
        (w.__aplog ||= []).push(
          `[ap] ${JSON.stringify(text)} f=${from} t=${to} fence=${inFence} inline=${inInlineCode} → ${action.kind}`,
        );
      }
      if (action.kind === "none") {
        // 代码语境：closeBrackets 的配对字符原样插入（禁用自动闭合）
        if ((inFence || inInlineCode) && CODE_PLAIN_CHARS.has(text)) {
          view.dispatch({
            changes: { from: to, insert: text },
            selection: { anchor: to + 1 },
            userEvent: "input.type",
          });
          return true;
        }
        return false;
      }
      switch (action.kind) {
        case "insert":
          view.dispatch({
            changes: { from: to, insert: action.text },
            selection: { anchor: to + action.cursorOffset },
            userEvent: "input.type",
          });
          return true;
        case "wrap":
          view.dispatch({
            changes: [
              { from, insert: action.opener },
              { from: to, insert: action.closer },
            ],
            selection: EditorSelection.range(from + action.opener.length, to + action.opener.length),
            userEvent: "input.type",
          });
          return true;
        case "grow": {
          const rightChar = action.rightChar ?? action.char;
          const changes =
            from === to
              ? [
                  { from: to, insert: action.char },
                  { from: to + action.rightLen, insert: rightChar },
                ]
              : [
                  { from: from - action.leftLen, insert: action.char },
                  { from: to + action.rightLen, insert: rightChar },
                ];
          view.dispatch({
            changes,
            selection:
              from === to
                ? { anchor: to + 1 }
                : EditorSelection.range(from + action.char.length, to + action.char.length),
            userEvent: "input.type",
          });
          return true;
        }
        case "skip":
          view.dispatch({ selection: { anchor: to + action.by }, userEvent: "select" });
          return true;
        case "edit": {
          const start = from + action.fromOffset;
          view.dispatch({
            changes: {
              from: start,
              to: to + action.toOffset,
              insert: action.text.replace(/\n/g, state.lineBreak),
            },
            selection: { anchor: start + action.cursorOffset },
            userEvent: "input.type",
          });
          return true;
        }
      }
    }),
  );
}

/**
 * 行内代码 / 代码块切换的键位分发。
 *
 * 键位读 hotkeys 的实时绑定表（不是状态创建时的快照），设置面板里改完立即生效。
 * 设置面板「捕获下一次按键」期间让路，否则重绑 Mod-` 会先切一次行内代码。
 * 单条命令被停用（设置页勾选框）后不再响应键盘。
 */
function editorToggleKeymap(): Extension {
  return EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (isCapturing() || !view.hasFocus) return false;
      // comboOfCode：Shift+反引号在美式键盘上 key 是 "~"，用物理键位兜底
      const combo = comboOfCode(event) ?? comboOf(event);
      const hits = (id: string) => isHotkeyEnabled(id) && bindingFor(id).includes(combo);
      if (hits("toggleInlineCode")) {
        event.preventDefault();
        return toggleInlineCode(view);
      }
      if (hits("toggleCodeBlock")) {
        event.preventDefault();
        return toggleCodeBlock(view);
      }
      // 快捷复制光标处的行内代码 / 整个代码块（0.21 用户反馈）；提示走 qn-notice 事件
      if (hits("copyCode")) {
        event.preventDefault();
        const hit = codeAtCursor(view.state);
        if (!hit) {
          window.dispatchEvent(
            new CustomEvent("qn-notice", { detail: { message: "光标不在行内代码或代码块里", kind: "error" } }),
          );
          return true;
        }
        void navigator.clipboard.writeText(hit.text).then(
          () =>
            window.dispatchEvent(
              new CustomEvent("qn-notice", {
                detail: {
                  message:
                    hit.kind === "block"
                      ? `已复制代码块（${hit.text.split("\n").length} 行）`
                      : "已复制行内代码",
                },
              }),
            ),
          () =>
            window.dispatchEvent(
              new CustomEvent("qn-notice", { detail: { message: "复制失败：剪贴板不可用", kind: "error" } }),
            ),
        );
        return true;
      }
      if (hits("toggleBulletList")) {
        event.preventDefault();
        return toggleBulletList(view);
      }
      if (hits("toggleNumberList")) {
        event.preventDefault();
        return toggleNumberList(view);
      }
      // 标题 1–6（Ctrl+1..6）：作用于光标所在行，再按同级别取消
      for (let level = 1; level <= 6; level += 1) {
        if (hits(`heading${level}`)) {
          event.preventDefault();
          return toggleHeading(view, level);
        }
      }
      // 选区标题归一：弹窗选级别（0.20 用户反馈：不是每级一个快捷键）
      if (hits("clampHeading")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("qn-clamp-heading"));
        return true;
      }
      // 粗体（0.21 用户反馈：选中内容加粗快捷键）
      if (hits("toggleBold")) {
        event.preventDefault();
        return toggleBold(view);
      }
      return false;
    },
  });
}

/** Mod-S 保存快捷键（onSave 带 view：主/分屏各走各的保存通道）。 */
export function modSKeymap(onSave: (view: EditorView) => void): Extension {
  return keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: (view) => {
        onSave(view);
        return true;
      },
    },
  ]);
}

/** 换一份资源上下文（0.32 分屏：同一状态流转到另一视图时随视图重配）。 */
export function applyLivePreviewContext(view: EditorView, ctx: LivePreviewContext): void {
  view.dispatch({ effects: livePreviewContextCompartment.reconfigure(livePreviewContext.of(ctx)) });
}

export function createEditor(parent: HTMLElement, state: EditorState): EditorHandle {
  const view = new EditorView({ state, parent });
  // 调试句柄：GUI 验收脚本（CDP）可以由此直接读编辑器状态，不必碰内部 DOM。
  // 无条件暴露：移动端构建没有 dev server，验收（含 Android 冒烟）也需要它；
  // CDP 只能经 adb/调试参数进来，生产环境暴露它没有实际风险。
  (window as unknown as Record<string, unknown>).__qnView = view;
  return {
    view,
    destroy: () => view.destroy(),
  };
}

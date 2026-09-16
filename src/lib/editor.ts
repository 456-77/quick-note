import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { separatorFor } from "./lineEndings";
import { blockWidgetsField, livePreviewExtension } from "./livePreview";
import { livePreviewContext, type LivePreviewContext } from "./paths";
import { linkClickHandler } from "./markdownExtras";
import { attachmentPaste, type AttachmentOptions } from "./paste";
import { syntaxTheme } from "./syntaxTheme";
import { isCursorInTable, tableShiftTab, tableTab } from "./tableEdit";

/** 视图模式：Live Preview（渲染语法）或源码。 */
export type ViewMode = "live" | "source";

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
  onDocChanged: () => void;
  /** Mod-S 的处理函数。用读 ref 的包装传入，避免捕获过期的闭包。 */
  onSave?: () => void;
  /** 资源解析上下文（仓库根目录 + 当前笔记路径），用于加载库内图片。 */
  resources?: LivePreviewContext;
  /** 粘贴附件的行为配置；不传则不接管粘贴。 */
  attachment?: AttachmentOptions;
  /** 初始是否用深色标记（光标/选区等内置配色）。 */
  dark?: boolean;
  /**
   * 光标进入/离开表格块时回调（表格工具栏的显示依据）。
   * 选区移动不触发 onDocChanged，所以要单独的通道。
   */
  onCursorInTable?: (inside: boolean) => void;
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
  const { lineEnding, mode, onDocChanged, onSave, resources, attachment, dark, onCursorInTable } = options;
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      syntaxTheme,
      darkCompartment.of(EditorView.darkTheme.of(dark === true)),
      // GFM（表格、任务列表）+ 围栏代码块语法高亮。
      // 语言包由 @codemirror/language-data 动态按需加载，不进入主包。
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      EditorState.lineSeparator.of(separatorFor(lineEnding)),
      livePreviewContext.of(
        resources ?? { vaultPath: null, notePath: null, embedIndex: new Map(), generation: 0 },
      ),
      livePreviewCompartment.of(modeExtensions(mode)),
      attachment ? attachmentPaste(attachment) : [],
      linkClickHandler(),
      // 表格里的 Tab 是"下一格"，必须压过 basicSetup 的缩进键位。
      // 光标不在表格里时处理函数返回 false，缩进照常。
      Prec.high(
        keymap.of([
          { key: "Tab", run: tableTab },
          { key: "S-Tab", run: tableShiftTab },
        ]),
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChanged();
        if (onCursorInTable && (update.docChanged || update.selectionSet)) {
          onCursorInTable(isCursorInTable(update.state));
        }
      }),
      onSave ? modSKeymap(onSave) : [],
    ],
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
  return {
    view,
    destroy: () => view.destroy(),
  };
}

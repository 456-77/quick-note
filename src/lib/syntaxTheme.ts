/**
 * 代码语法高亮的配色。
 *
 * 用 CSS 变量而不是具体色值：切换主题时高亮跟着变，**不需要重建编辑器状态**。
 * 覆盖的标签是 `@codemirror/language` 内置 defaultHighlightStyle 的超集——内置那份
 * 用的是写死的浅色（#708、#a11…），深色主题下会花掉。
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.atom, t.bool, t.null, t.url, t.labelName], color: "var(--syn-atom)" },
  { tag: [t.literal, t.inserted, t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.regexp, t.escape], color: "var(--syn-regexp)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--syn-def)" },
  { tag: t.local(t.variableName), color: "var(--syn-local)" },
  { tag: [t.typeName, t.namespace], color: "var(--syn-type)" },
  { tag: [t.className, t.definition(t.className)], color: "var(--syn-class)" },
  { tag: [t.special(t.variableName), t.macroName], color: "var(--syn-special)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.meta, t.annotation], color: "var(--syn-meta)" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
  // 文档结构类不加颜色：字号与字重由 Live Preview 的行装饰控制，这里只管颜色继承
  { tag: [t.heading, t.strong], fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
]);

/** 装进编辑器的扩展。配色全走变量，所以主题切换时不用重配。 */
export const syntaxTheme: Extension = syntaxHighlighting(highlightStyle);

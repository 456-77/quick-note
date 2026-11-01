/**
 * Java 实体库（0.34.13 用户反馈「类似于 ddl 语句，对于 java 中的实体也类似
 * 处理；也要考虑多项目中名字复用」）：把实体类源码集中存进仓库内一篇笔记，
 * 笔记里出现类名时悬浮显示该类的源码——与 DDL 库同一套交互与段落格式。
 *
 * ## 收录格式
 *
 * 整篇笔记全文扫描（```java 围栏块、散落的类都算）：`class Foo` /
 * `interface Foo` / `enum Foo` / `record Foo(...)`（可带 public/final/abstract
 * 等修饰）按**类名**收录，值是「从修饰符行首到配对右花括号」的完整源码。
 * 残段（没有配对 `}`）按硬边界兜底：下一个类声明行 / 围栏行 / 8000 字符。
 *
 * ## 多项目
 *
 * 与 ddl.ts 完全同构：`## 项目名` 起段落、未分组兼容老笔记、同名类跨项目
 * 各存一份。段落切割直接复用 ddlSections。
 *
 * ## 纯函数
 *
 * 不碰 DOM、不碰 Tauri，Node 里直接断言（verify-all 的一节）。
 */

import { ddlSections, sectionProjectAt, type DdlEntry, type DdlLibrary } from "./ddl.ts";

const CLASS_RE =
  /(?:^|\n)[ \t]*(?:(?:public|protected|private|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/g;

const MAX_CLASS_LENGTH = 8000;

/** 类名（保持原文大小写；匹配时调用方自行小写化）→ 收录键。 */
export type ClassLibrary = DdlLibrary;

/**
 * 从一段文本（可以是整篇笔记）里抽出全部类型定义，按项目分段归组。
 *
 * 取值范围：声明行首（含修饰符）到**配对右花括号**——花括号计数会跳过字符串
 * 字面量、字符、行/块注释，与 Java 语法对齐；没有配对 `}` 的残段退到硬边界
 * （下一个类声明 / 围栏行）或 8000 字符兜底。同一项目内同名以最后一次出现为准。
 */
export function parseClassLibrary(text: string): ClassLibrary {
  const out: ClassLibrary = new Map();
  const sections = ddlSections(text);
  CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASS_RE.exec(text)) !== null) {
    const name = match[1];
    // 声明起点回退到「这一行的行首」（修饰符之前的缩进不收进源码）
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const rest = text.slice(lineStart);
    const { cut, advance } = classSpan(rest);
    const code = stripFenceLines(rest.slice(0, cut));
    if (name && code) {
      const key = name;
      const project = sectionProjectAt(sections, lineStart);
      const entries = (out.get(key) ?? []).filter((entry) => entry.project !== project);
      entries.push({ project, ddl: code });
      out.set(key, entries);
    }
    // 游标永远向前：从声明行首起消费整个类体
    CLASS_RE.lastIndex = lineStart + advance;
  }
  return out;
}

/**
 * 一个类定义的取值范围（相对文本起点）：配对 `}`、下一个类声明/围栏行、
 * 8000 字符三者取最早；`advance` 带回游标推进量（≥ 头部长度）。
 */
function classSpan(text: string): { cut: number; advance: number } {
  const boundary = nextClassBoundary(text);
  let depth = 0;
  let seenOpen = false;
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i += 1;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      seenOpen = true;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (seenOpen && depth <= 0) {
        const cut = i + 1;
        return { cut, advance: cut };
      }
    }
    if (boundary >= 0 && i >= boundary) break;
    if (i > MAX_CLASS_LENGTH) break;
  }
  // 没有配对 `}`：硬边界 / 兜底长度
  const cut = boundary >= 0 ? boundary : Math.min(text.length, MAX_CLASS_LENGTH);
  return { cut, advance: Math.max(cut, 1) };
}

/** 下一个硬边界（类声明行首或 ``` 围栏行首）的绝对下标；找不到 -1。 */
function nextClassBoundary(text: string): number {
  const re = /^[ \t]*(?:(?:public|protected|private|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\b|^[ \t]*```/gm;
  re.lastIndex = 1; // 跳过自己这个声明的行首（从第 1 个字符起找）
  const at = re.exec(text);
  return at ? at.index : -1;
}

/** 去掉首尾整行的围栏标记（``` / ```java）：悬浮预览只展示类源码本身。 */
function stripFenceLines(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && /^\s*```/.test(lines[0])) lines.shift();
  while (lines.length > 0 && /^\s*```/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n").trim();
}

/** 文本里出现过的全部类名（保持出现顺序，去重）。 */
export function extractClassNames(text: string): string[] {  const seen = new Set<string>();
  const order: string[] = [];
  CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASS_RE.exec(text)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      order.push(match[1]);
    }
  }
  return order;
}

/** 类名（声明里的裸名）→ 匹配该类声明起点的正则。 */
function classAt(name: string, flags: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:(?:public|protected|private|static|final|abstract|sealed)\\s+)*(?:class|interface|enum|record)\\s+${escaped}\\b`,
    flags,
  );
}

/**
 * 把新的一批类源码合进实体库笔记（弹窗「收录」用）。策略与 mergeDdlIntoNote
 * 完全同构：目标项目段落内同名类整段替换；段落内没有的插到段落末尾；
 * 项目不存在就在文末新建 `## 项目` 段落；未分组无段落时追加文末。
 */
export function mergeClassesIntoNote(existing: string, incoming: string, project = ""): string {
  const fresh = parseClassLibrary(incoming);
  if (fresh.size === 0) return existing;
  const batch = new Map<string, string>();
  for (const [name, entries] of fresh) {
    batch.set(name, entries[entries.length - 1].ddl);
  }

  let text = existing;
  const replaced = new Set<string>();
  const sections = ddlSections(text);
  const target = sections.find((section) => section.project === project);
  if (target) {
    const span = text.slice(target.from, target.to);
    const linesOffset = target.from;
    const hits: Array<{ at: number; ddl: string; replaceEnd: number }> = [];
    for (const [name, ddl] of batch) {
      // 逐行找声明行（声明必须顶行首——与解析侧同一口径）
      const re = classAt(name, "gm");
      re.lastIndex = 0;
      const at = re.exec(span);
      if (at) {
        const abs = linesOffset + at.index;
        const { cut } = classSpan(text.slice(abs));
        hits.push({ at: abs, ddl, replaceEnd: abs + cut });
        replaced.add(name);
      }
    }
    hits.sort((a, b) => b.at - a.at);
    for (const hit of hits) {
      text = text.slice(0, hit.at) + hit.ddl + text.slice(hit.replaceEnd);
    }
  }

  const pending = [...batch].filter(([name]) => !replaced.has(name)).map(([, ddl]) => ddl);
  if (pending.length === 0) return text;
  const block = pending.join("\n\n");
  const targetNow = ddlSections(text).find((section) => section.project === project);
  if (targetNow) {
    const insert = `\n\n\`\`\`java\n${block}\n\`\`\`\n`;
    const head = text.slice(0, targetNow.to).replace(/\s*$/, "\n");
    const tail = text.slice(targetNow.to).replace(/^\n*/, "");
    return head + insert + tail;
  }
  const section = `\n\n## ${project}\n\n\`\`\`java\n${block}\n\`\`\`\n`;
  return text.replace(/\s*$/, "") + section;
}

/** 实体库笔记的初始内容（第一次收录时创建）。 */
export function javaNoteIntro(): string {
  return [
    "# Java 实体",
    "",
    "实体类源码集中收录在这里（设置里可改路径）。笔记里光标悬停在已收录的类名上，会浮动显示该类的源码；用「收录建表语句」弹窗粘贴类源码即可收录（自动识别 class/interface/enum/record），`## 项目名` 段落区分同名类。",
    "",
  ].join("\n");
}

// -------------------------------------------------------- Java 着色纯函数

export interface JavaToken {
  from: number;
  text: string;
  /** 与 SqlToken 同一套类名（弹窗复用同一组 CSS）：kw 关键字/注解、str 字符串、
      id 标识符、num 数字、cmt 注释。 */
  cls: "kw" | "str" | "id" | "num" | "cmt";
}

const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
  "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
  "new", "package", "private", "protected", "public", "record", "return", "sealed", "short",
  "static", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try",
  "var", "void", "volatile", "while", "true", "false", "null",
]);

/**
 * Java 源码 → 着色 token 序列（纯函数）。规则：`//` 与 `/* *\/` 注释、"..."
 * 字符串、'...' 字符、@注解、数字、关键字（词边界）；落单的引号按普通文本走。
 */
export function tokenizeJava(code: string): JavaToken[] {
  const out: JavaToken[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") {
      let end = code.indexOf("\n", i);
      if (end < 0) end = code.length;
      out.push({ from: i, text: code.slice(i, end), cls: "cmt" });
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out.push({ from: i, text: code.slice(i, stop), cls: "cmt" });
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) {
        if (code[j] === "\\") j += 1;
        if (code[j] === "\n") break; // 落单引号（没有同行收口）按普通文本走
        j += 1;
      }
      if (j < code.length && code[j] === ch) {
        out.push({ from: i, text: code.slice(i, j + 1), cls: "str" });
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "@" && /[A-Za-z]/.test(code[i + 1] ?? "")) {
      let end = i + 1;
      while (end < code.length && /[A-Za-z0-9_.]/.test(code[end])) end += 1;
      out.push({ from: i, text: code.slice(i, end), cls: "kw" });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[0-9a-fA-FxX._lL]/.test(code[end])) end += 1;
      out.push({ from: i, text: code.slice(i, end), cls: "num" });
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[A-Za-z0-9_$]/.test(code[end])) end += 1;
      const word = code.slice(i, end);
      if (JAVA_KEYWORDS.has(word)) {
        out.push({ from: i, text: word, cls: "kw" });
      } else {
        out.push({ from: i, text: word, cls: "id" });
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 文本里第一个已收录的类名（大小写敏感；复合单元格文本逐词试库）。 */
export function classWordInText(text: string, classes: ClassLibrary): string | null {
  for (const token of text.split(/[^A-Za-z0-9_$]+/)) {
    if (token && classes.has(token)) return token;
  }
  return null;
}

export type { DdlEntry, DdlLibrary };

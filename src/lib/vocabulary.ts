/**
 * 单词本（0.23 用户反馈"添加单词学习功能，类似 IDEA"；0.24 按用户提示词升级为
 * "快速记录 + 快速查词"工具：词条支持释义与备注；0.25 释义自动获取，行格式
 * v3 增加第 4 个可选字段——音标）。
 *
 * 形态：一份普通 Markdown 文本。0.28 起存在**应用配置目录**（vocabulary.md，
 * 所有仓库共用，见 vocabStore.ts），内容仍是用户可手编的纯文本；旧的
 * 仓库根 `单词本.md` 只在迁移时读取（VOCAB_FILENAME 保留给迁移逻辑）。
 * 结构化的"待学习/已掌握"两个小节，每行一条：
 *
 *   # 单词本
 *
 *   ## 待学习
 *
 *   - word — 2026-10-15 · 来源笔记名
 *   - hello
 *   - hscs_hsdt | 数据传输任务接口表 | 测试库用的 — 2026-10-16 · 数据库表清单
 *   - scenario | n. 设想，方案 | 备注可以留空 | /sɪˈnɑːriəʊ/ — 2026-10-17 · 手动添加
 *
 * 行格式 v3（0.25）：词后面可带 ` | 释义 | 备注 | 音标`（都可省略、按需截断）；
 * v2（无音标）与 v1（裸 `- word — meta`）行完全兼容。全部函数是**纯内容变换**
 * （字符串进字符串出），Node 可直接断言；读写文件由调用方（App）负责。
 */

/** 单词本笔记的文件名（仓库根）。 */
export const VOCAB_FILENAME = "单词本.md";

export const VOCAB_SECTION_TODO = "## 待学习";
export const VOCAB_SECTION_DONE = "## 已掌握";

export interface VocabEntry {
  word: string;
  /** 中文释义（v2 字段；手写/旧行可能没有）。 */
  meaning: string;
  /** 备注（v2 字段）。 */
  note: string;
  /** 音标（v3 字段，形如 `/sɪˈnɑːriəʊ/`；旧行/在线查询失败时没有）。 */
  phonetic: string;
  /** 记录时间与来源（"2026-10-15 · 来源笔记"）；手写的行可能没有。 */
  meta: string;
  learned: boolean;
  /** 源文件里的行号（0 基，供按行删除对账）。 */
  line: number;
}

/** 一条记录的源码行：`- word | 释义 | 备注 | 音标 — meta`，空字段按需截断。 */
function entryLine(entry: {
  word: string;
  meaning?: string;
  note?: string;
  phonetic?: string;
  meta: string;
}): string {
  const parts = [
    entry.word,
    entry.meaning?.trim() ?? "",
    entry.note?.trim() ?? "",
    entry.phonetic?.trim() ?? "",
  ];
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  const left = parts.join(" | ");
  return entry.meta ? `- ${left} — ${entry.meta}` : `- ${left}`;
}

/** 全新单词本的初始内容。 */
export function initialVocabulary(): string {
  return `# 单词本\n\n${VOCAB_SECTION_TODO}\n\n${VOCAB_SECTION_DONE}\n`;
}

/**
 * 解析单词本内容。宽容解析：小节缺失、行格式有出入都尽量收进来——文件是用户
 * 可手编的，解析器不该比编辑器还严格。词为空的行跳过；小节之外的条目归入
 * "待学习"；同词后写者胜（重录即更新）。
 */
export function parseVocabulary(content: string): VocabEntry[] {
  const out: VocabEntry[] = [];
  const seen = new Map<string, VocabEntry>();
  let learned = false;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === VOCAB_SECTION_DONE) {
      learned = true;
      continue;
    }
    if (line === VOCAB_SECTION_TODO) {
      learned = false;
      continue;
    }
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2).trim();
    if (!body) continue;
    const dash = body.indexOf(" — ");
    const left = (dash >= 0 ? body.slice(0, dash) : body).trim();
    const meta = dash >= 0 ? body.slice(dash + 3).trim() : "";
    // v2/v3：词后面可带 ` | 释义 | 备注 | 音标`；v1 的裸词行没有竖线，拆出来就是单项。
    // 按竖线拆再逐段 trim：entryLine 写出的「备注留空」行是 ` |  | `（两个相邻
    // 空格），按完整分隔串 " | " 拆会把音标并进备注、音标字段丢失（0.27 批测
    // 抓到的往返 bug：在线查到的音标保存后自己都读不回来）。
    const fields = left.split("|").map((field) => field.trim());
    const word = fields[0] ?? "";
    if (!word) continue;
    const entry: VocabEntry = {
      word,
      meaning: fields[1] ?? "",
      note: fields[2] ?? "",
      phonetic: fields[3] ?? "",
      meta,
      learned,
      line: index,
    };
    const key = word.toLowerCase();
    const old = seen.get(key);
    if (old) {
      // 同词重录：替换原条目（out 里的位置不变，行号取新值）
      out.splice(out.indexOf(old), 1, entry);
    } else {
      seen.set(key, entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * 追加一个词到「待学习」。已有同词（大小写不敏感）时不动内容——重复快捷键
 * 不产生重复行；返回 (新内容, 是否真的新增)。
 */
export function addVocabEntry(
  content: string,
  word: string,
  meta: string,
  meaning = "",
  note = "",
  phonetic = "",
): { content: string; added: boolean } {
  const cleaned = word.trim();
  if (!cleaned) return { content, added: false };
  if (parseVocabulary(content).some((entry) => entry.word.toLowerCase() === cleaned.toLowerCase())) {
    return { content, added: false };
  }
  const line = entryLine({ word: cleaned, meaning, note, phonetic, meta: meta.trim() });
  const lines = content.split(/\r?\n/);
  const todoIndex = lines.findIndex((row) => row.trim() === VOCAB_SECTION_TODO);
  if (todoIndex >= 0) {
    // 插到待学习小节的末尾：跳过小节标题后的空行，走到下一个空行/标题之前
    let end = todoIndex + 1;
    while (end < lines.length && lines[end].trim() === "") end += 1;
    while (end < lines.length && lines[end].trim() !== "" && !lines[end].trim().startsWith("## ")) {
      end += 1;
    }
    lines.splice(end, 0, line);
    return { content: lines.join("\n"), added: true };
  }
  // 没有待学习小节：保留原内容（含已掌握节），补建待学习节
  const base = content.replace(/\s*$/, "");
  const hasDone = base.includes(VOCAB_SECTION_DONE);
  return {
    content: `${base}\n\n${VOCAB_SECTION_TODO}\n\n${line}\n${hasDone ? "" : `${VOCAB_SECTION_DONE}\n`}`,
    added: true,
  };
}

/** 把一个词移入/移出「已掌握」。词不存在或状态没变时原样返回（changed=false）。 */
export function setVocabLearned(
  content: string,
  word: string,
  learned: boolean,
): { content: string; changed: boolean } {
  const entries = parseVocabulary(content);
  const key = word.toLowerCase();
  const hit = entries.find((entry) => entry.word.toLowerCase() === key);
  if (!hit || hit.learned === learned) return { content, changed: false };
  const lines = content.split(/\r?\n/);
  // 移动 = 原行删掉、目标节的开头插一行（刚操作的词最先看到）
  lines.splice(hit.line, 1);
  const targetSection = learned ? VOCAB_SECTION_DONE : VOCAB_SECTION_TODO;
  const sectionIndex = lines.findIndex((row) => row.trim() === targetSection);
  if (sectionIndex >= 0) {
    let insertAt = sectionIndex + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt += 1;
    lines.splice(insertAt, 0, entryLine(hit));
    return { content: lines.join("\n"), changed: true };
  }
  // 目标小节不存在：补建一个（放到文档末尾）
  const base = content.replace(/\s*$/, "");
  return { content: `${base}\n\n${targetSection}\n\n${entryLine(hit)}\n`, changed: true };
}

/** 从单词本删除一个词（两个节都找）。 */
export function removeVocabEntry(
  content: string,
  word: string,
): { content: string; changed: boolean } {
  const key = word.toLowerCase();
  const hit = parseVocabulary(content).find((entry) => entry.word.toLowerCase() === key);
  if (!hit) return { content, changed: false };
  const lines = content.split(/\r?\n/);
  if (lines[hit.line]?.trim().startsWith("- ")) {
    lines.splice(hit.line, 1);
    return { content: lines.join("\n"), changed: true };
  }
  // 行号对不上（内容被并发改过）：按完整行文本兜底找
  const fallback = lines.findIndex((row) => row.trim() === entryLine(hit));
  if (fallback < 0) return { content, changed: false };
  lines.splice(fallback, 1);
  return { content: lines.join("\n"), changed: true };
}

/**
 * 更新一个词的释义/备注（0.24 详情面板的「编辑」）。原行就地重写（meta 保留）；
 * 行号对不上时按完整行文本兜底。词不存在或内容没变时 changed=false。
 */
export function updateVocabEntry(
  content: string,
  word: string,
  patch: { meaning?: string; note?: string; phonetic?: string },
): { content: string; changed: boolean } {
  const key = word.toLowerCase();
  const hit = parseVocabulary(content).find((entry) => entry.word.toLowerCase() === key);
  if (!hit) return { content, changed: false };
  const meaning = patch.meaning !== undefined ? patch.meaning.trim() : hit.meaning;
  const note = patch.note !== undefined ? patch.note.trim() : hit.note;
  const phonetic = patch.phonetic !== undefined ? patch.phonetic.trim() : hit.phonetic;
  if (meaning === hit.meaning && note === hit.note && phonetic === hit.phonetic) {
    return { content, changed: false };
  }
  const rebuilt = entryLine({ ...hit, meaning, note, phonetic });
  const lines = content.split(/\r?\n/);
  if (lines[hit.line]?.trim().startsWith("- ")) {
    lines[hit.line] = rebuilt;
    return { content: lines.join("\n"), changed: true };
  }
  const fallback = lines.findIndex((row) => row.trim() === entryLine(hit));
  if (fallback < 0) return { content, changed: false };
  lines[fallback] = rebuilt;
  return { content: lines.join("\n"), changed: true };
}

/**
 * 把 `incoming` 里的**新词**并进 `base`（0.28 旧库迁移与 0.29 云同步共用）：
 * 同词保留 base 的释义/备注/状态；incoming 侧新增的词若标记「已掌握」则落进
 * 对应小节。整体是 **union 语义——只加不删**：任何一端的词都不会被合并弄丢，
 * 云同步靠这一点保证无墓碑的账户级同步不丢数据。
 */
export function mergeVocabulary(base: string, incoming: string): string {
  const existing = new Set(
    parseVocabulary(base).map((entry) => entry.word.toLowerCase()),
  );
  let content = base;
  for (const entry of parseVocabulary(incoming)) {
    if (existing.has(entry.word.toLowerCase())) continue;
    const added = addVocabEntry(content, entry.word, entry.meta, entry.meaning, entry.note, entry.phonetic);
    if (!added.added) continue;
    content = added.content;
    existing.add(entry.word.toLowerCase());
    if (entry.learned) {
      content = setVocabLearned(content, entry.word, true).content;
    }
  }
  return content;
}

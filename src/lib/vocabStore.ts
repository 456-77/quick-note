/**
 * 单词本的存储（0.28 用户反馈：单词本应该按账户共用，而不是一个仓库一份）。
 *
 * 单词本从「仓库根的 单词本.md」搬到**应用配置目录**的 `vocabulary.md`：
 * 换仓库、多窗口、多个库看到的是同一份词库；仍然是不随仓库同步的本机文件
 * （与同步账号无关，纯粹是这台设备的学习记录）。
 *
 * 旧数据的迁移是**每个仓库一次**的合并：
 * - 首次使用（全局文件不存在）：直接采用当前仓库的 单词本.md（保留小节结构）；
 * - 之后打开每个仓库：把该库 单词本.md 里的新词并进全局（同词保留全局的
 *   释义/状态），并用 `vocabulary-migrated.json` 记下已迁移的仓库路径。
 * 记过标记就不再读那个库的旧文件——否则用户删掉的词会在下次打开库时复活。
 */

import { readAppText, readNoteOptional, writeAppText } from "./api.ts";
import {
  VOCAB_FILENAME,
  addVocabEntry,
  initialVocabulary,
  parseVocabulary,
  setVocabLearned,
} from "./vocabulary.ts";

/** 账户级单词本在应用配置目录下的文件名。 */
export const VOCAB_GLOBAL_FILE = "vocabulary.md";
/** 已迁移仓库清单（JSON 字符串数组）。 */
const VOCAB_MIGRATED_FILE = "vocabulary-migrated.json";

/** 本会话已处理过的仓库（避免每次面板刷新都读一遍标记文件）。 */
const migratedThisSession = new Set<string>();

function vaultKey(vault: string): string {
  return vault.replace(/[\\/]+$/, "");
}

/** 合并一个仓库的旧单词本（只加新词；同词保留全局条目的内容与状态）。 */
function mergeVaultContent(globalContent: string, localContent: string): string {
  const existing = new Set(
    parseVocabulary(globalContent).map((entry) => entry.word.toLowerCase()),
  );
  let content = globalContent;
  for (const entry of parseVocabulary(localContent)) {
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

async function markMigrated(vault: string): Promise<void> {
  try {
    const raw = await readAppText(VOCAB_MIGRATED_FILE);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    const keys = Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string")
      : [];
    const key = vaultKey(vault);
    if (!keys.includes(key)) {
      keys.push(key);
      await writeAppText(VOCAB_MIGRATED_FILE, JSON.stringify(keys, null, 2));
    }
  } catch {
    // 标记写不上只会导致下次再合并一遍（同词去重），不阻塞单词本使用
  }
  migratedThisSession.add(vaultKey(vault));
}

async function migratedVaults(): Promise<string[]> {
  try {
    const raw = await readAppText(VOCAB_MIGRATED_FILE);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 读账户级单词本。首次调用会创建全局文件，并把当前仓库的旧 单词本.md
 * 合并进来（每个仓库只做一次）。
 */
export async function loadVocabularyContent(vault: string | null): Promise<string> {
  const global = await readAppText(VOCAB_GLOBAL_FILE);
  let content = global;
  if (content === null) {
    const local = vault
      ? await readNoteOptional(vault, VOCAB_FILENAME).catch(() => null)
      : null;
    content = local?.content ?? initialVocabulary();
    await writeAppText(VOCAB_GLOBAL_FILE, content);
  }

  if (!vault) return content;
  const key = vaultKey(vault);
  if (migratedThisSession.has(key)) return content;
  const migrated = await migratedVaults();
  if (migrated.includes(key)) {
    migratedThisSession.add(key);
    return content;
  }
  const local = await readNoteOptional(vault, VOCAB_FILENAME).catch(() => null);
  const merged = local ? mergeVaultContent(content, local.content) : content;
  if (merged !== content) {
    await writeAppText(VOCAB_GLOBAL_FILE, merged);
    content = merged;
  }
  await markMigrated(vault);
  return content;
}

/** 写账户级单词本（所有仓库共用这一份）。 */
export async function saveVocabularyContent(content: string): Promise<void> {
  await writeAppText(VOCAB_GLOBAL_FILE, content);
}

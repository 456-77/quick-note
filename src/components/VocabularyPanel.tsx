/**
 * 单词本面板（0.23 新增，右侧面板「单词」页签）。
 *
 * 数据源是仓库根的 `单词本.md`（格式见 vocabulary.ts 的文件头说明）：面板只做
 * 读取 → 解析 → 行级变换 → 写回，文件本身保持用户可手编的普通 Markdown。
 * 打开面板 / 仓库切换 / 文件树 revision 变化时重读；手动改了文件点「刷新」即可。
 */

import { useCallback, useEffect, useState } from "react";
import { readNoteOptional, writeNote } from "../lib/api";
import {
  VOCAB_FILENAME,
  addVocabEntry,
  parseVocabulary,
  removeVocabEntry,
  setVocabLearned,
  type VocabEntry,
} from "../lib/vocabulary";

interface Props {
  vault: string | null;
  /** 文件树代际：仓库文件变动（含单词本被手改）时重读。 */
  revision: number;
  onOpen: (path: string) => void;
  notice: (message: string, kind?: "info" | "error") => void;
}

export default function VocabularyPanel({ vault, revision, onOpen, notice }: Props) {
  const [entries, setEntries] = useState<VocabEntry[]>([]);
  const [hasFile, setHasFile] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!vault) {
      setEntries([]);
      setHasFile(false);
      return;
    }
    try {
      const note = await readNoteOptional(vault, VOCAB_FILENAME);
      if (!note) {
        setEntries([]);
        setHasFile(false);
        return;
      }
      setEntries(parseVocabulary(note.content));
      setHasFile(true);
    } catch {
      setEntries([]);
      setHasFile(false);
    }
  }, [vault]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  /** 行级变换的公共骨架：读 → 变换 → 写回 → 刷新列表。 */
  const mutate = useCallback(
    async (transform: (content: string) => string, message?: string) => {
      if (!vault || busy) return;
      setBusy(true);
      try {
        const note = await readNoteOptional(vault, VOCAB_FILENAME);
        const content = note?.content ?? "";
        const next = transform(content);
        if (next === content) return;
        await writeNote(vault, VOCAB_FILENAME, next, false);
        if (message) notice(message);
      } catch (e) {
        notice(`单词本操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        setBusy(false);
        void reload();
      }
    },
    [vault, busy, notice, reload],
  );

  const addDraft = useCallback(() => {
    const word = draft.trim();
    if (!word) return;
    setDraft("");
    const today = new Date();
    const pad = (v: number) => String(v).padStart(2, "0");
    const meta = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} · 手动添加`;
    void mutate(
      (content) => addVocabEntry(content, word, meta).content,
      `已加入单词本：${word}`,
    );
  }, [draft, mutate]);

  const todo = entries.filter((entry) => !entry.learned);
  const done = entries.filter((entry) => entry.learned);

  if (!vault) {
    return <div className="vocab-panel vocab-empty">打开仓库后可使用单词本。</div>;
  }

  return (
    <div className="vocab-panel">
      <div className="vocab-toolbar">
        <input
          type="text"
          className="vocab-input"
          placeholder="输入单词，回车加入…"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addDraft();
            }
          }}
        />
        <button type="button" className="btn btn-mini" title="重新读取单词本.md" onClick={() => void reload()}>
          刷新
        </button>
        <button type="button" className="btn btn-mini" title="在编辑器中打开单词本.md" onClick={() => onOpen(VOCAB_FILENAME)}>
          打开
        </button>
      </div>

      {!hasFile && (
        <p className="vocab-hint">
          还没有单词本。在笔记里选中一个词按 <kbd>Ctrl+Alt+V</kbd>，或上面手动添加——
          单词记在仓库根的「{VOCAB_FILENAME}」里，随时可手改。
        </p>
      )}

      <div className="vocab-section">
        <div className="vocab-section-title">待学习 <span className="vocab-count">{todo.length}</span></div>
        {todo.length === 0 && <div className="vocab-empty-row">空——选中生词按 Ctrl+Alt+V 收进来</div>}
        {todo.map((entry) => (
          <div key={entry.line} className="vocab-row" title={entry.meta || undefined}>
            <span className="vocab-word">{entry.word}</span>
            <span className="vocab-spacer" />
            <button
              type="button"
              className="vocab-act"
              title="标记为已掌握"
              disabled={busy}
              onClick={() => void mutate((content) => setVocabLearned(content, entry.word, true).content)}
            >
              ✓
            </button>
            <button
              type="button"
              className="vocab-act"
              title="删除"
              disabled={busy}
              onClick={() => void mutate((content) => removeVocabEntry(content, entry.word).content)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="vocab-section">
        <div className="vocab-section-title">已掌握 <span className="vocab-count">{done.length}</span></div>
        {done.map((entry) => (
          <div key={entry.line} className="vocab-row is-learned" title={entry.meta || undefined}>
            <span className="vocab-word">{entry.word}</span>
            <span className="vocab-spacer" />
            <button
              type="button"
              className="vocab-act"
              title="移回待学习"
              disabled={busy}
              onClick={() => void mutate((content) => setVocabLearned(content, entry.word, false).content)}
            >
              ↩
            </button>
            <button
              type="button"
              className="vocab-act"
              title="删除"
              disabled={busy}
              onClick={() => void mutate((content) => removeVocabEntry(content, entry.word).content)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

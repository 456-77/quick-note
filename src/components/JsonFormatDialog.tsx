/**
 * JSON 文本格式转换面板（0.34.13 用户反馈「添加快捷键唤起一个文本格式转换面板，
 * 可以自动将 json 数据进行格式化；若原 json 数据被转换成了字符串，能够转换回来」）。
 *
 * 打开时预填编辑器选区（没有选区就是空的，手动贴也行）；转换都在面板内完成、
 * 不动笔记，满意再「写回笔记」（替换原选区 / 插入光标处）或复制走。
 * 转换逻辑在 lib/jsonFormat.ts（纯函数，verify-all 有断言）：
 * - 格式化 / 压缩：字符串化的 JSON（可多层）自动解包到最深一层；
 * - 转为字符串：任意文本转义成一个 JSON 字符串字面量（反向）；
 * - 还原为 JSON：字符串字面量解开，内容是 JSON 就顺手格式化。
 */

import { useEffect, useRef, useState } from "react";
import { beautifyJson, fromJsonString, minifyJson, toJsonString } from "../lib/formatJson";

export default function JsonFormatDialog({
  initialText,
  onApply,
  onClose,
}: {
  /** 打开时的预填文本（编辑器选区；可为空）。 */
  initialText: string;
  /** 写回笔记：替换原选区 / 插入光标处（App 侧实现）。 */
  onApply: (text: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(initialText);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const outputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const run = (label: string, fn: (text: string) => string) => {
    try {
      const result = fn(input);
      setOutput(result);
      setError(null);
      // 结果给到输出框后把焦点挪过去，方便直接 Ctrl+A 复制
      requestAnimationFrame(() => outputRef.current?.focus());
    } catch (e) {
      setError(`${label}：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const restore = () => {
    try {
      const raw = fromJsonString(input);
      // 解出来的内容若是 JSON 就顺手格式化；不是就原样展示（纯字符串也合法）
      try {
        setOutput(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
      } catch {
        setOutput(raw);
      }
      setError(null);
      requestAnimationFrame(() => outputRef.current?.focus());
    } catch (e) {
      setError(`还原字符串：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const apply = () => {
    if (!output.trim()) {
      // 还没转换过：格式化一次直接写回（最常见的「选中→唤起→回车」路径）
      try {
        onApply(beautifyJson(input));
      } catch (e) {
        setError(`写回：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    onApply(output);
  };

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="jsonfmt" role="dialog" aria-label="文本格式转换">
        <div className="jsonfmt-head">
          <span className="jsonfmt-title">JSON 格式转换</span>
          <span className="spacer" />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>

        <textarea
          ref={inputRef}
          className="jsonfmt-io"
          rows={8}
          spellCheck={false}
          value={input}
          placeholder="粘贴或选中 JSON / 被字符串化的 JSON…"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              apply();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />

        <div className="jsonfmt-actions">
          <button type="button" onClick={() => run("格式化", beautifyJson)} title="解析并缩进展开；字符串化的 JSON 自动解包">
            格式化
          </button>
          <button type="button" onClick={() => run("压缩", minifyJson)} title="压成单行">
            压缩
          </button>
          <button type="button" onClick={() => run("转字符串", toJsonString)} title="整段文本转义成一个 JSON 字符串（可塞进配置/代码）">
            转为字符串
          </button>
          <button type="button" onClick={restore} title='把 "…\…" 这样的字符串字面量解回 JSON（多层一次解开）'>
            还原为 JSON
          </button>
          <button
            type="button"
            title="把上面的结果搬到输入框，接着做下一步转换（例如 转为字符串 → 还原 验证往返）"
            onClick={() => {
              if (!output.trim()) return;
              setInput(output);
              setOutput("");
              setError(null);
              inputRef.current?.focus();
            }}
          >
            结果↑输入
          </button>
          <span className="spacer" />
          <button
            type="button"
            disabled={!output.trim()}
            title={output.trim() ? "把结果写回笔记（替换原选区 / 插入光标处）" : "先转换一次，再写回"}
            onClick={() => {
              if (output.trim()) onApply(output);
            }}
          >
            写回笔记
          </button>
          <button
            type="button"
            disabled={!output.trim()}
            title="复制结果"
            onClick={() => void navigator.clipboard.writeText(output)}
          >
            复制结果
          </button>
        </div>

        {error && <div className="jsonfmt-error">{error}</div>}

        <textarea
          ref={outputRef}
          className="jsonfmt-io"
          rows={8}
          spellCheck={false}
          readOnly
          value={output}
          placeholder="转换结果显示在这里…"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="jsonfmt-help">
          <span>转换只在面板里进行，点「写回笔记」才会动笔记</span>
        </div>
      </div>
    </>
  );
}

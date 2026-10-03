/**
 * 快速笔记捕获弹窗：一条速记追加进「收件仓库」（不切换当前仓库、不新开标签）。
 *
 * 场景：正在别的仓库里干活，突然想记一条电脑操作技巧——按快捷键（默认
 * Ctrl+Alt-N，可在设置 → 快捷键 里改）唤起这里，Enter 写入收件箱继续干活。
 *
 * 交互：Enter = 记下来，Shift+Enter = 换行（正文支持多行，写进收件文件的是
 * 缩进续行），Ctrl/Cmd+Enter 任意焦点都可提交，Esc / 点遮罩 = 关闭。
 * 图片：工具条选图或直接往输入框（正文/标签框都行）粘贴截图，缩略图条里点开
 * 可预览（Esc 关、←/→ 切），随正文一起写入收件仓库的附件目录，正文里以
 * `![[图.png]]` 嵌入（归档到目标笔记时跟着走）。
 * 标签是 chip 输入组件——输入后 Enter 生成标签、Backspace 删最后一个。
 * 提交由父组件做 IO，返回是否成功：失败（仓库没配、写盘出错）弹窗保持展开便于重试。
 */

import { useEffect, useRef, useState } from "react";
import { toBase64 } from "../lib/paste";
import { normalizeTagName } from "../lib/tags";
import { IconX } from "./icons";

/** 随速记附带的图片：文件名/类型用于落盘命名，base64 用于写附件。 */
export interface CaptureImage {
  name: string;
  type: string;
  base64: string;
}

export default function QuickCaptureDialog({
  target,
  tagSuggestions,
  onSubmit,
  onClose,
  onOpenSettings,
  initialDraft = "",
}: {
  target: string;
  tagSuggestions: string[];
  /** text 已去掉首尾空行（内部换行保留），tags 已规范去重，images 待落盘。返回是否成功（成功关窗）。 */
  onSubmit: (text: string, tags: string[], images: CaptureImage[]) => Promise<boolean>;
  onClose: () => void;
  /** 未配置收件仓库时提示里给一个直达设置的入口。 */
  onOpenSettings: () => void;
  /** 系统分享带入的预填文本（A3：分享到 Quick Note）。 */
  initialDraft?: string;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [images, setImages] = useState<CaptureImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在预览的图片下标（null = 预览没开）。 */
  const [preview, setPreview] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const tagRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 预览浮层开着时：Esc 关预览（不关弹窗）、←/→ 切图。捕获阶段拦下，
  // 别让textarea/标签框的 Esc 兜底把整个弹窗带走
  useEffect(() => {
    if (preview === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPreview(null);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        setPreview((prev) => {
          if (prev === null) return prev;
          const step = event.key === "ArrowLeft" ? -1 : 1;
          return (prev + step + images.length) % images.length;
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview, images.length]);

  /** 把输入框里的文字落成一个标签 chip。 */
  const commitTag = (): boolean => {
    const name = normalizeTagName(tagDraft);
    if (!name) {
      setTagDraft("");
      return false;
    }
    setTags((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setTagDraft("");
    return true;
  };

  /** 收下图片文件（选图或粘贴）：读成 base64 备着，落盘在提交时由父组件做。 */
  const addImages = async (files: File[]) => {
    const picked = files.filter((file) => file.type.startsWith("image/"));
    if (picked.length === 0) return;
    const added: CaptureImage[] = [];
    for (const file of picked) {
      try {
        added.push({
          name: file.name || "clipboard.png",
          type: file.type,
          base64: toBase64(new Uint8Array(await file.arrayBuffer())),
        });
      } catch (e) {
        setError(`图片读取失败：${e}`);
      }
    }
    if (added.length > 0) setImages((prev) => [...prev, ...added]);
  };

  const submit = async () => {
    if (busy) return;
    // 正文保留内部换行（首尾空行去掉）；纯图片也能记一条
    const text = draft.replace(/^\n+|\n+$/g, "").trimEnd();
    if (!text && images.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (await onSubmit(text, tags, images)) {
        onClose();
        return;
      }
    } catch (e) {
      setError(String(e));
      return;
    } finally {
      setBusy(false);
    }
    // onSubmit 返回 false：父组件已给出原因（未配置等），这里不重复弹错
  };

  /** 标签输入框里的 Enter：有内容 = 生成标签；已空 = 直接提交整条速记。 */
  const tagInputEnter = () => {
    if (tagDraft.trim()) {
      commitTag();
      return;
    }
    void submit();
  };

  // 保存位置展示：文件里的 {{date}} 就地展开（与 App 侧写入口径一致）
  const [fileHint, vaultHint] = target ? target.split(" · ") : ["", ""];
  const displayFile = (fileHint || "").replace(
    /\{\{date\}\}/g,
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(
      new Date().getDate(),
    ).padStart(2, "0")}`,
  );

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="quick-capture" role="dialog" aria-label="快速笔记">
        <div className="quick-capture-head">
          <span className="quick-capture-title">快速笔记</span>
          <span className="spacer" />
          <button type="button" className="quick-capture-esc" title="关闭 (Esc)" onClick={onClose}>
            <kbd>Esc</kbd> 关闭
          </button>
        </div>

        <textarea
          ref={inputRef}
          rows={5}
          value={draft}
          placeholder="记录想法...（可粘贴截图）"
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (files.length > 0) {
              event.preventDefault();
              void addImages(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="quick-capture-help">
          <span>
            <kbd>Enter</kbd> 保存 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
          </span>
          <span className="spacer" />
          <span>
            <kbd>{navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"}</kbd>+
            <kbd>Enter</kbd> 保存
          </span>
        </div>

        {images.length > 0 && (
          <div className="quick-capture-imgs">
            {images.map((image, index) => (
              <figure key={`${image.name}-${index}`} className="quick-capture-imgs-item">
                <img
                  src={`data:${image.type};base64,${image.base64}`}
                  alt={image.name}
                  title={`点击预览 ${image.name}`}
                  onClick={() => setPreview(index)}
                />
                <button
                  type="button"
                  className="quick-capture-imgs-x"
                  title={`移除 ${image.name}`}
                  onClick={() => {
                    setImages((prev) => prev.filter((_, i) => i !== index));
                    setPreview((prev) => (prev === null || prev < index ? prev : prev - 1));
                  }}
                >
                  <IconX size={10} />
                </button>
              </figure>
            ))}
          </div>
        )}

        <div className="quick-capture-tags">
          {tags.map((tag) => (
            <span key={tag} className="quick-capture-tag">
              #{tag}
              <button
                type="button"
                className="quick-capture-tag-x"
                title={`移除 #${tag}`}
                onClick={() => setTags((prev) => prev.filter((item) => item !== tag))}
              >
                <IconX size={9} />
              </button>
            </span>
          ))}
          <input
            ref={tagRef}
            type="text"
            className="quick-capture-tags-input"
            list="quick-capture-tag-options"
            value={tagDraft}
            placeholder={tags.length > 0 ? "加标签…" : "标签（Enter 生成，可留空）"}
            title="标签写进速记行，速记管理里聚合筛选"
            onChange={(event) => setTagDraft(event.target.value)}
            onPaste={(event) => {
              // 焦点在标签框时粘贴的截图也归入正文图片，别让粘贴默默无操作
              const files = Array.from(event.clipboardData.files).filter((file) =>
                file.type.startsWith("image/"),
              );
              if (files.length > 0) {
                event.preventDefault();
                void addImages(files);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                tagInputEnter();
              }
              if (event.key === "Backspace" && !tagDraft && tags.length > 0) {
                event.preventDefault();
                setTags((prev) => prev.slice(0, -1));
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <datalist id="quick-capture-tag-options">
            {tagSuggestions.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </div>

        <div className="quick-capture-foot">
          {target ? (
            <span className="quick-capture-target" title={target}>
              <span className="quick-capture-target-file">{displayFile}</span>
              {vaultHint && <span className="quick-capture-target-vault">· {vaultHint}</span>}
            </span>
          ) : (
            <button type="button" className="quick-capture-setup" onClick={onOpenSettings}>
              还没选择收件仓库，去设置 → 通用 里配置
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="quick-capture-img-btn"
            title="添加图片（写入收件仓库的附件目录）"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            ＋图片
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              void addImages(Array.from(event.target.files ?? []));
              event.target.value = ""; // 同名文件再选也能触发 onChange
            }}
          />
          <button
            type="button"
            className="btn btn-primary quick-capture-save"
            disabled={!draft.trim() && images.length === 0}
            onClick={() => void submit()}
          >
            {busy ? "记下中…" : "记下来"}
          </button>
        </div>
        {error && <div className="quick-capture-error">{error}</div>}
      </div>

      {preview !== null && images[preview] && (
        <div
          className="quick-capture-imgview"
          role="dialog"
          aria-label="图片预览"
          onClick={() => setPreview(null)}
        >
          <img
            src={`data:${images[preview].type};base64,${images[preview].base64}`}
            alt={images[preview].name}
            title="点击图片外的任意位置关闭（←/→ 切换）"
            onClick={(event) => event.stopPropagation()}
          />
          <div className="quick-capture-imgview-cap">
            {images[preview].name} · <kbd>Esc</kbd> 关闭 · <kbd>←</kbd>/<kbd>→</kbd> 切换
          </div>
        </div>
      )}
    </>
  );
}

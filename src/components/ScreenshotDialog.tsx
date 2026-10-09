/**
 * 截图预览与 OCR 弹窗（0.20 用户需求：全局快捷键截图 + 识别图中文本）。
 *
 * 流程：全局快捷键（settings.screenshotHotkey）→ Rust 抓整个虚拟屏幕回传 base64 →
 * 这里展示并框选 → 识别文本（Windows OCR，走 Rust 的 PowerShell WinRT 通道）或
 * 把选区（未选则整图）存为当前仓库附件并插入链接。
 *
 * 选区是**显示坐标**，裁剪/识别前按图片自然尺寸换算；裁剪在 canvas 里做，
 * data URL 直读，不落临时文件。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { screenshotOcr } from "../lib/api";
import { linkTextFor } from "../lib/attachments";
import { IconX } from "./icons";

interface Props {
  open: boolean;
  /** PNG base64（无 `data:` 前缀）；null = 还没有截图。 */
  imageBase64: string | null;
  onClose: () => void;
  notice: (message: string, kind?: "info" | "error") => void;
  /** 把文本插入当前笔记光标处（OCR 结果 / 附件链接都走这里）。 */
  insertText: (text: string) => void;
  /** 保存图片为当前仓库附件，返回仓库内相对路径（失败 null）。 */
  saveAttachment: (name: string, base64: string) => Promise<string | null>;
  /** 附件链接写法。 */
  linkFormat: () => "wiki" | "markdown";
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 本地时间戳文件名：截图-20261009-174530.png（同秒连截靠序号兜底由调用方保证）。 */
function stampName(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return `截图-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`;
}

export default function ScreenshotDialog({
  open,
  imageBase64,
  onClose,
  notice,
  insertText,
  saveAttachment,
  linkFormat,
}: Props) {
  const [select, setSelect] = useState<Rect | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const seq = useRef(0);

  // 每次换图重置框选与识别结果
  useEffect(() => {
    setSelect(null);
    setOcrText(null);
  }, [imageBase64]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  /** 选区（显示坐标）换算成自然坐标；没选就是整图。 */
  const regionBase64 = useCallback(async (): Promise<string> => {
    const img = imgRef.current;
    if (!img || !imageBase64) return imageBase64 ?? "";
    const naturalW = img.naturalWidth;
    const naturalH = img.naturalHeight;
    let sx = 0;
    let sy = 0;
    let sw = naturalW;
    let sh = naturalH;
    if (select && select.w > 2 && select.h > 2) {
      const rect = img.getBoundingClientRect();
      const ratioX = naturalW / rect.width;
      const ratioY = naturalH / rect.height;
      sx = Math.max(0, Math.round(select.x * ratioX));
      sy = Math.max(0, Math.round(select.y * ratioY));
      sw = Math.min(naturalW - sx, Math.round(select.w * ratioX));
      sh = Math.min(naturalH - sy, Math.round(select.h * ratioY));
    }
    if (sx === 0 && sy === 0 && sw === naturalW && sh === naturalH) return imageBase64;
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 不可用");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const url = canvas.toDataURL("image/png");
    return url.slice(url.indexOf(",") + 1);
  }, [imageBase64, select]);

  const recognize = useCallback(async () => {
    if (!imageBase64 || ocrBusy) return;
    setOcrBusy(true);
    try {
      const base64 = await regionBase64();
      const text = await screenshotOcr(base64);
      setOcrText(text);
      if (!text.trim()) notice("没有识别出文字（图片里可能没有文本，或缺少 OCR 语言包）");
      else notice(`识别完成，${text.length} 个字符`);
    } catch (e) {
      notice(`识别失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setOcrBusy(false);
    }
  }, [imageBase64, ocrBusy, regionBase64, notice]);

  const saveToNote = useCallback(async () => {
    if (!imageBase64 || saveBusy) return;
    setSaveBusy(true);
    try {
      const base64 = await regionBase64();
      seq.current += 1;
      const name = stampName(new Date()).replace(/\.png$/, `-${seq.current}.png`);
      const relative = await saveAttachment(name, base64);
      if (!relative) {
        notice("尚未打开仓库，无法保存截图", "error");
        return;
      }
      insertText(linkTextFor(relative, linkFormat()));
      notice(`已保存截图：${relative}`);
      onClose();
    } catch (e) {
      notice(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaveBusy(false);
    }
  }, [imageBase64, saveBusy, regionBase64, saveAttachment, linkFormat, insertText, notice, onClose]);

  const copyImage = useCallback(async () => {
    try {
      const base64 = await regionBase64();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) }),
      ]);
      notice("截图已复制到剪贴板");
    } catch (e) {
      notice(`复制失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [regionBase64, notice]);

  if (!open || !imageBase64) return null;

  const onMouseDown = (event: React.MouseEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setSelect({ x: dragRef.current.x, y: dragRef.current.y, w: 0, h: 0 });
  };
  const onMouseMove = (event: React.MouseEvent<HTMLImageElement>) => {
    const start = dragRef.current;
    if (!start) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
    setSelect({
      x: Math.min(start.x, x),
      y: Math.min(start.y, y),
      w: Math.abs(x - start.x),
      h: Math.abs(y - start.y),
    });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div className="modal-backdrop shot-backdrop" onClick={onClose}>
      <div
        className="modal-card shot-card"
        role="dialog"
        aria-label="截图与识别"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span>截图{select && select.w > 2 ? "（已框选区域）" : "（拖动框选，不选则整图）"}</span>
          <span className="cm-spacer" />
          <button type="button" className="shot-btn" disabled={ocrBusy} onClick={() => void recognize()}>
            {ocrBusy ? "识别中…" : "识别文本"}
          </button>
          <button type="button" className="shot-btn" disabled={saveBusy} onClick={() => void saveToNote()}>
            {saveBusy ? "保存中…" : "存入笔记"}
          </button>
          <button type="button" className="shot-btn" onClick={() => void copyImage()}>
            复制图片
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>
        <div className="shot-stage">
          <img
            ref={imgRef}
            src={`data:image/png;base64,${imageBase64}`}
            alt="屏幕截图"
            className="shot-img"
            draggable={false}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={endDrag}
          />
          {select && select.w > 2 && select.h > 2 && (
            <div
              className="shot-selection"
              style={{ left: select.x, top: select.y, width: select.w, height: select.h }}
            />
          )}
        </div>
        {ocrText !== null && (
          <div className="shot-ocr">
            <textarea
              className="shot-ocr-text"
              value={ocrText}
              placeholder="这里显示识别出的文本（可直接修改）"
              onChange={(event) => setOcrText(event.target.value)}
              rows={Math.min(10, Math.max(3, ocrText.split("\n").length + 1))}
            />
            <div className="shot-ocr-actions">
              <button
                type="button"
                className="shot-btn"
                onClick={() =>
                  void navigator.clipboard.writeText(ocrText).then(
                    () => notice("识别文本已复制"),
                    () => notice("复制失败：剪贴板不可用", "error"),
                  )
                }
              >
                复制文本
              </button>
              <button
                type="button"
                className="shot-btn shot-btn-primary"
                onClick={() => {
                  insertText(ocrText);
                  notice("识别文本已插入当前笔记");
                  onClose();
                }}
                disabled={!ocrText.trim()}
              >
                插入到笔记
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 图片裁剪弹窗：拖拽选择区域，确认后按原图分辨率裁切并**覆写原文件**。
 *
 * 交互自 quick-daily-note 插件的 ImageCropModal 移植（拖拽出选区 → 松开出现
 * 裁剪按钮 → 覆写保存）；落盘走 writeBinary（允许覆盖指定路径），写完用
 * bumpImageEpoch 让所有已渲染的同图立刻重载。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readBinary, writeBinary } from "../lib/api";
import { bumpImageEpoch } from "../lib/livePreview";
import { blobTypeOf } from "../lib/imageOps";
import { IconX } from "./icons";

interface Props {
  open: boolean;
  vault: string;
  /** 仓库相对路径（覆写目标）。 */
  path: string;
  onClose: () => void;
  /** 裁剪成功后的提示通道。 */
  notice: (message: string, kind?: "info" | "error") => void;
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function ImageCropDialog({ open, vault, path, onClose, notice }: Props) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [hint, setHint] = useState("按住鼠标在图片上拖拽，选择要保留的区域");
  const [busy, setBusy] = useState(false);

  const areaRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // 打开时加载原图；关闭/换文件时释放 Blob URL
  useEffect(() => {
    if (!open || !vault || !path) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setRect(null);
    setSize(null);
    setHint("按住鼠标在图片上拖拽，选择要保留的区域");
    void (async () => {
      try {
        const data = await readBinary(vault, path);
        const bytes = base64ToBytes(data.base64);
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: blobTypeOf(path) });
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setImageUrl(objectUrl);
      } catch (e) {
        if (!cancelled) {
          notice(`读取图片失败：${e}`, "error");
          onClose();
        }
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setImageUrl(null);
      imageRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vault, path]);

  const toAreaPoint = useCallback((event: MouseEvent | React.MouseEvent) => {
    const area = areaRef.current;
    if (!area) return { x: 0, y: 0 };
    const bounds = area.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
    };
  }, []);

  const onMouseMove = useCallback(
    (event: MouseEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const point = toAreaPoint(event);
      setRect({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      });
    },
    [toAreaPoint],
  );

  const onMouseUp = useCallback(() => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    dragStart.current = null;
  }, [onMouseMove]);

  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault();
    dragStart.current = toAreaPoint(event);
    setRect({ x: dragStart.current.x, y: dragStart.current.y, w: 0, h: 0 });
    setHint("松开鼠标完成选区");
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // 选区太小说明是误触，弹窗里提示重选（与插件同一阈值）
  const validRect = rect !== null && rect.w >= 2 && rect.h >= 2;

  const applyCrop = async () => {
    const area = areaRef.current;
    const image = imageRef.current;
    if (!area || !image || !rect || !validRect || busy) return;
    setBusy(true);
    try {
      const bounds = area.getBoundingClientRect();
      const scaleX = image.naturalWidth / bounds.width;
      const scaleY = image.naturalHeight / bounds.height;
      const sx = Math.max(0, Math.round(rect.x * scaleX));
      const sy = Math.max(0, Math.round(rect.y * scaleY));
      const sw = Math.max(1, Math.round(rect.w * scaleX));
      const sh = Math.max(1, Math.round(rect.h * scaleY));

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 不可用");
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("裁剪结果生成失败");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeBinary(vault, path, toBase64(bytes));
      bumpImageEpoch();
      notice("已裁剪图片（原文件已覆写）");
      onClose();
    } catch (e) {
      notice(`裁剪失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card crop-card"
        role="dialog"
        aria-label={`裁剪图片 ${path}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span>裁剪图片：{path.split("/").pop()}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>
        {imageUrl && (
          <div className="crop-area" ref={areaRef} onMouseDown={startDrag}>
            <img
              ref={imageRef}
              src={imageUrl}
              alt="待裁剪"
              draggable={false}
              onLoad={() => {
                const image = imageRef.current;
                if (image) setSize({ w: image.naturalWidth, h: image.naturalHeight });
              }}
            />
            {rect && (
              <div
                className="crop-select"
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
              />
            )}
            {rect && validRect && (
              <div className="crop-size" style={{ left: rect.x, top: Math.max(0, rect.y - 20) }}>
                {Math.round(rect.w)} × {Math.round(rect.h)}
              </div>
            )}
          </div>
        )}
        <div className="crop-foot">
          <span className="crop-hint">
            {size ? `原图 ${size.w} × ${size.h} · ` : ""}
            {hint}
          </span>
          <span className="spacer" />
          {validRect && (
            <button type="button" className="btn" disabled={busy} onClick={() => void applyCrop()}>
              {busy ? "裁剪中…" : "裁剪（覆写原文件）"}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

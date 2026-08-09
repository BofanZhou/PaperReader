/**
 * components/pdf/PaperImage.tsx —— 论文图片统一加载组件
 *
 * 用 base64 IPC（read_image_base64 命令）加载，**绕开 asset 协议**。
 * 背景：Windows 上 asset 协议对 `C:\Users\...\papers\...`（反斜杠 URL）的
 * scope 匹配不可靠（原图视图 PDF 403、PDFViewer figure 403 同根因），
 * 而 IPC 直传 base64 100% 可靠。
 *
 * 加载中显示占位，失败显示具体错误（便于诊断）。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";

interface Props {
  /** 图片绝对路径（papers/.../work/_images/xxx.png） */
  path: string;
  alt: string;
  className?: string;
  /** 最大高度 px（默认 420） */
  maxHeight?: number;
}

export function PaperImage({ path, alt, className = "", maxHeight = 420 }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    invoke<string>("read_image_base64", { path })
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <div className="my-3 rounded-md border border-dashed border-error/30 bg-error/5 p-4 text-center text-xs text-error">
        <div className="font-medium">{alt}</div>
        <div className="mt-1 text-fg-tertiary">图片加载失败：{error}</div>
      </div>
    );
  }
  if (!src) {
    return (
      <div className="my-3 flex h-24 items-center justify-center rounded-md border border-border bg-bg-secondary/50 text-xs text-fg-tertiary">
        <Loader2 className="mr-1 size-3.5 animate-spin" /> 图片加载中…
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className={`rounded object-contain ${className}`}
      style={{ maxHeight: maxHeight, maxWidth: "100%" }}
      draggable={false}
    />
  );
}

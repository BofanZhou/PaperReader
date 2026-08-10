/**
 * lib/exportPdf.ts —— Prompt 9 导出翻译 PDF
 *
 * 流程（浏览器端生成，pdf-lib）：
 * 1. 读取系统 CJK 字体（read_system_font，base64）→ pdf-lib embedFont
 * 2. pdfjs 打开 papers/{uuid}/original.pdf（IPC base64）
 * 3. 逐页：pdfjs render 到离屏 canvas → PNG → pdf-lib 嵌入为整页背景
 *    （背景保留图表/公式/页眉页脚原样）
 * 4. 对文字元素（段落/标题/图注等）：白色矩形遮盖原文 → 按 bbox 绘制译文
 *    （中文自动缩小字号；长文本按 bbox 宽度自动换行）
 * 5. 高亮批注层：半透明彩色矩形 + 「N」标记（元素有高亮时）
 * 6. 保存并触发下载（save dialog + fs 写入）
 */
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readSystemFont } from "./env";
import type { ParsedElement, ParsedResult } from "./env";

export interface ExportOptions {
  parsed: ParsedResult;
  /** element_id → 译文（ODL 元素级翻译结果） */
  translations: Record<string, string>;
  /** 原图 PDF 路径（papers/{uuid}/original.pdf，用于 pdfjs 渲染底图） */
  originalPdfPath: string;
  /** 高亮：elementId → 高亮色 */
  highlights?: { elementId: string; color: string }[];
  onProgress?: (done: number, total: number) => void;
  onStatus?: (msg: string) => void;
}

/** base64 → Uint8Array（分块解码，防超大字符串栈溢出） */
function base64ToBytes(b64: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor((b64.length * 3) / 4));
  let outLen = 0;
  const CHUNK = 0x4000;
  for (let i = 0; i < b64.length; i += CHUNK) {
    const chunk = b64.slice(i, i + CHUNK);
    const bin = atob(chunk);
    for (let j = 0; j < bin.length; j++) bytes[outLen++] = bin.charCodeAt(j);
  }
  return bytes.subarray(0, outLen);
}

/** 按 bbox 宽度换行（中文/英文混排按字符测量） */
function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const lines: string[] = [];
  let line = "";
  for (const ch of clean) {
    const test = line + ch;
    if (line && font.widthOfTextAtSize(test, fontSize) > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * 导出翻译 PDF：返回保存路径（用户取消返回 null）。
 */
export async function exportTranslatedPdf(opts: ExportOptions): Promise<string | null> {
  const { parsed, translations, originalPdfPath, highlights, onProgress, onStatus } = opts;
  onStatus?.("准备导出…");

  // 3. pdf-lib 新文档（尺寸 = 原页 pt）
  const outPdf = await PDFDocument.create();
  outPdf.registerFontkit(fontkit); // 自定义字体（系统 CJK）需要显式注册

  // 1. CJK 字体（必须绑定到 outPdf；失败则回退——中文显示方框但流程不中断）
  let cjkFont: PDFFont | null = null;
  try {
    const b64 = await readSystemFont();
    cjkFont = await outPdf.embedFont(base64ToBytes(b64));
  } catch {
    cjkFont = null;
  }

  // 2. pdfjs 打开原 PDF
  onStatus?.("加载原 PDF…");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const b64 = await invoke<string>("read_pdf_base64", { path: originalPdfPath });
  const task = pdfjs.getDocument({ data: base64ToBytes(b64) });
  const srcPdf = await task.promise;
  const total = Math.min(srcPdf.numPages, parsed.pages.length || srcPdf.numPages);

  const hlMap = new Map((highlights ?? []).map((h) => [h.elementId, h.color]));

  for (let p = 1; p <= total; p++) {
    onProgress?.(p - 1, total);
    onStatus?.(`渲染第 ${p}/${total} 页…`);

    const srcPage = await srcPdf.getPage(p);
    const viewport = srcPage.getViewport({ scale: 1 });
    const pageW = viewport.width; // pt
    const pageH = viewport.height;

    // 渲染底图 PNG（2x 清晰度）
    const RENDER_SCALE = 2;
    const vp2 = srcPage.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp2.width);
    canvas.height = Math.floor(vp2.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 canvas 渲染上下文");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // pdfjs v6：RenderParameters 需要 canvas（canvasContext 可选）
    await srcPage.render({ canvas, canvasContext: ctx, viewport: vp2 }).promise;
    const dataUrl = canvas.toDataURL("image/png");
    const pngBytes = base64ToBytes(dataUrl.split(",")[1]);
    canvas.width = 0;
    canvas.height = 0;

    // 新页面（pt 尺寸）
    const page = outPdf.addPage([pageW, pageH]);
    const pngImg = await outPdf.embedPng(pngBytes);
    page.drawImage(pngImg, { x: 0, y: 0, width: pageW, height: pageH });

    // 4. 文字遮盖 + 译文（bbox 为 PDF bottom-left 坐标，与 pdf-lib 一致）
    const parsedPage = parsed.pages.find((pp) => pp.pageNumber === p);
    const els: ParsedElement[] = parsedPage?.elements ?? [];
    for (const el of els) {
      const translated = translations[el.id];
      const hl = hlMap.get(el.id);
      const isText = el.type === "paragraph" || el.type === "heading" || el.type === "caption" || el.type === "formula";
      if (!isText && !hl) continue; // figure/table 背景已保留，除非需要高亮

      const b = el.bbox;
      const x = b.left;
      const y = b.bottom;
      const w = Math.max(4, b.right - b.left);
      const h = Math.max(6, b.top - b.bottom);

      // 5. 高亮层（垫底）：半透明彩色矩形 + N 标记
      if (hl) {
        const c = hexToRgb(hl);
        page.drawRectangle({ x, y, width: w, height: h, color: rgb(c.r, c.g, c.b), opacity: 0.25 });
      }

      // 有译文才遮盖原文并绘制译文
      if (translated && translated.trim() && isText && cjkFont) {
        page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1) });
        const fontSize = Math.max(6, Math.min(12, h * 0.75));
        const maxWidth = Math.max(8, w - 4);
        const lines = wrapText(translated, cjkFont, fontSize, maxWidth);
        const lineH = fontSize * 1.35;
        // 垂直居中：首行基线 = bottom + fontSize + 剩余空间的一半
        let ty = y + fontSize + (h - lines.length * lineH) / 2;
        for (const line of lines) {
          if (ty > y + h || ty - fontSize < y) break; // 超出 bbox 上下界
          page.drawText(line, { x: x + 2, y: ty, size: fontSize, font: cjkFont, color: rgb(0, 0, 0) });
          ty -= lineH;
        }
      }
    }
  }

  onStatus?.("生成文件…");
  const bytes = await outPdf.save();

  const dest = await save({
    defaultPath: `translated-${parsed.title ? sanitizeFileName(parsed.title) : "paper"}.pdf`,
    filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
  });
  if (!dest) return null; // 用户取消

  await writeFile(dest, bytes);
  await task.destroy().catch(() => {});
  onProgress?.(total, total);
  onStatus?.("导出完成");
  return dest;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 1, g: 0.843, b: 0 }; // 默认金黄
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

function sanitizeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

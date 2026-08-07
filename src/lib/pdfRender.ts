/**
 * lib/pdfRender.ts —— PDF.js 加载与渲染工具
 *
 * - worker 通过 `?url` 导入，打包为独立 asset，避免 CORS/构建坑
 * - bbox 转换：PDF 坐标（BOTTOM-LEFT 原点，pt）→ 屏幕坐标（TOP-LEFT，px）
 */
import * as pdfjsLib from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { convertFileSrc } from "@tauri-apps/api/core";

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;

/** 本地绝对路径 → PDF.js 可加载的 URL（Tauri asset protocol）。
 *  浏览器 dev 模式（无 Tauri internals）直接返回原值，避免 import 崩溃。 */
export function toAssetUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return convertFileSrc(pathOrUrl);
  }
  return pathOrUrl;
}

/** 文档级单例缓存（避免重复 getDocument） */
const docCache = new Map<string, pdfjsLib.PDFDocumentProxy>();

/** 加载 PDF 文档（带缓存，Tauri 本地路径需先 convertFileSrc） */
export async function loadPdf(url: string): Promise<pdfjsLib.PDFDocumentProxy> {
  const cached = docCache.get(url);
  if (cached) return cached;
  const doc = await pdfjsLib.getDocument({ url, disableAutoFetch: false }).promise;
  docCache.set(url, doc);
  return doc;
}

export interface RenderPageOptions {
  /** 渲染目标 canvas */
  canvas: HTMLCanvasElement;
  page: pdfjsLib.PDFPageProxy;
  /** 目标渲染宽度（px）；高度按页面宽高比自动推导 */
  width: number;
}

/** 将 PDF 页面渲染到 canvas（devicePixelRatio 适配，保证清晰度）。
 *
 *  pdfjs v6 的 RenderParameters：必填 `canvas`（canvasContext 仅向后兼容），
 *  且调用方负责设置 canvas 物理尺寸 + 传 `transform` 缩放（v6 不会自动处理 dpr）。
 */
export async function renderPageToCanvas({ canvas, page, width }: RenderPageOptions): Promise<number> {
  const dpr = window.devicePixelRatio || 1;
  const viewport1 = page.getViewport({ scale: 1 });
  const ratio = width / viewport1.width;
  const viewport = page.getViewport({ scale: ratio });
  const height = Math.round(viewport.height);

  // 关键：CSS 尺寸按逻辑像素，canvas 位图按 dpr 放大（传 transform 对应放大）
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);

  const transform: number[] = [dpr, 0, 0, dpr, 0, 0];
  await page.render({ canvas, viewport, transform }).promise;
  return height;
}

export interface BboxScreen {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * PDF 坐标 → 屏幕坐标。
 * PDF bbox 是 BOTTOM-LEFT 原点（pt），屏幕是 TOP-LEFT（px）。
 * @param bbox   PDF 坐标 [left, bottom, right, top]
 * @param pageH  PDF 页面高度（pt）
 * @param scale  页面渲染缩放（渲染宽度 / PDF 宽度）
 */
export function bboxToScreen(
  bbox: { left: number; bottom: number; right: number; top: number },
  pageH: number,
  scale: number,
): BboxScreen {
  const left = bbox.left * scale;
  // PDF bottom → 屏幕 top：top = (pageH - bbox.top) * scale
  const top = (pageH - bbox.top) * scale;
  const width = (bbox.right - bbox.left) * scale;
  const height = (bbox.top - bbox.bottom) * scale;
  return { left, top, width, height };
}

/** 公式检测：常见数学符号 / LaTeX 标记 */
const FORMULA_RE =
  /[∑∫√∞πΔθλµ∂∇∈∉⊆∪∩±×÷=<>≈≠≤≥→←⇒⇔αβγδ]|\\(frac|sum|int|sqrt|infty|pi|theta|lambda|mu|partial|nabla|cdot|times|rightarrow|leftarrow|geq|leq)\b|\^\d|_\d/g;

export function looksLikeFormula(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 3) return false;
  return FORMULA_RE.test(t);
}

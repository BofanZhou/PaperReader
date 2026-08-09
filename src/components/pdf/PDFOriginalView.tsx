/**
 * components/pdf/PDFOriginalView.tsx —— 原图视图（pdf-original，第 5 种模式）
 *
 * 方案（2026-08-09 决策，用户拍板）：
 * - pdfjs 渲染原 PDF 页面为 canvas 底图（排版 100% 准确）
 * - 上方叠加透明文本层（Google PDF Viewer 风格）：
 *   - 页面有文本层 → pdfjs getTextContent + renderTextLayer（同坐标系，像素对齐）
 *   - 页面无文本层（扫描版）→ canvas 图像 → 后端 Tesseract OCR → 像素坐标叠加
 *     （Tesseract 跑在 pdfjs 渲染结果上，OCR 像素坐标 = canvas 坐标，天然对齐）
 * - 用户看到原图，但文字可选中 → 翻译/高亮（复用父级 SelectionPopup）
 *
 * 依赖 pdfjs-dist（懒加载：仅进入本视图才下载 ~750KB 主库 + worker）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
// ?url 只引入 worker 文件 URL 常量（不打包 worker 代码进主包）
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { ContextMenuAction, PDFViewerProps } from "../../types/pdf";

interface PageSize {
  w: number;
  h: number;
}

interface Props {
  /** papers/{uuid}/original.pdf 绝对路径（get_paper_pdf_path 获取） */
  pdfPath: string;
  onSelectText?: PDFViewerProps["onSelectText"];
  onContextMenuAction?: PDFViewerProps["onContextMenuAction"];
}

interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAGE_GAP = 24; // 页间距 px
const PAGE_OVERSCAN = 2; // 可视范围外预渲染页数
const MAX_PDF_PAGES = 800; // 防御：超大 PDF 限制

/**
 * 原图视图：pdfjs 渲染 + 透明文本层（textContent / OCR 两级降级）+ 虚拟滚动
 */
export function PDFOriginalView({ pdfPath, onSelectText, onContextMenuAction }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // pdfjs v6：销毁走 loadingTask.destroy()（PDFDocumentProxy 无 destroy）
  const loadingTaskRef = useRef<import("pdfjs-dist").PDFDocumentLoadingTask | null>(null);
  const [pdfDoc, setPdfDoc] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);

  // 加载 PDF + 计算各页 css 尺寸（按容器基准宽度等比缩放）
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setNumPages(0);
    setPageSizes([]);
    setPdfDoc(null);

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const task = pdfjs.getDocument({ url: convertFileSrc(pdfPath) });
        loadingTaskRef.current = task;
        const pdf = await task.promise;
        if (cancelled) {
          task.destroy();
          return;
        }
        setPdfDoc(pdf);
        const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
        setNumPages(n);
        // 用第一页宽度定基准 scale（阅读区约 760px 内容宽）
        const p1 = await pdf.getPage(1);
        const baseScale = 760 / p1.getViewport({ scale: 1 }).width;
        const sizes: PageSize[] = [];
        for (let i = 1; i <= n; i++) {
          const p = await pdf.getPage(i);
          const vp = p.getViewport({ scale: baseScale });
          sizes.push({ w: Math.round(vp.width), h: Math.round(vp.height) });
          p.cleanup();
        }
        if (cancelled) return;
        setPageSizes(sizes);
        setRange([0, Math.min(PAGE_OVERSCAN * 2 + 1, n)]);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();

    return () => {
      cancelled = true;
      loadingTaskRef.current?.destroy();
      loadingTaskRef.current = null;
    };
  }, [pdfPath]);

  // 虚拟滚动：按滚动位置计算可视页范围（线性扫描页高，论文量级可接受）
  const updateRange = useCallback(() => {
    const el = containerRef.current;
    if (!el || !pageSizes.length) return;
    const scrollTop = el.scrollTop;
    const viewH = el.clientHeight;
    let acc = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < pageSizes.length; i++) {
      const h = pageSizes[i].h + PAGE_GAP;
      const pageTop = acc;
      const pageBottom = acc + h;
      if (pageBottom > scrollTop && pageTop < scrollTop + viewH) {
        if (first < 0) first = i;
        last = i;
      }
      acc += h;
    }
    if (first < 0) first = 0;
    if (last < 0) last = 0;
    setRange([Math.max(0, first - PAGE_OVERSCAN), Math.min(pageSizes.length - 1, last + PAGE_OVERSCAN)]);
  }, [pageSizes]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateRange, { passive: true });
    window.addEventListener("resize", updateRange);
    // 首次挂载后计算（等布局稳定）
    const t = window.setTimeout(updateRange, 50);
    return () => {
      el.removeEventListener("scroll", updateRange);
      window.removeEventListener("resize", updateRange);
      window.clearTimeout(t);
    };
  }, [updateRange, pageSizes.length]);

  const handleSelect = useCallback(
    (_e: React.MouseEvent, _pageNum: number) => {
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (!text) return;
        const rangeObj = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        const rect = rangeObj?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        onSelectText?.({
          x: rect.left,
          y: rect.bottom + 6,
          width: rect.width,
          height: rect.height,
          text,
          elementId: null, // 原图视图无 ODL 元素粒度
          range: null,
          isFormula: false,
        });
      });
    },
    [onSelectText],
  );

  const handleContext = useCallback((e: React.MouseEvent, text: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, text });
  }, []);

  const fireAction = useCallback(
    (kind: ContextMenuAction["kind"]) => {
      if (!menu) return;
      onContextMenuAction?.({ kind, elementId: "", text: menu.text });
      setMenu(null);
    },
    [menu, onContextMenuAction],
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close, { once: true });
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && setMenu(null);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-error/30 bg-error/10 p-4 text-sm text-error">
          原图视图加载失败：{loadError}
          <div className="mt-2 text-xs text-fg-secondary">可切换到「原文」视图继续阅读</div>
        </div>
      </div>
    );
  }

  // 页面 div 按文档流自然堆叠（每页高度 = 页高 + 间距），虚拟滚动仅控制渲染范围
  const pages = [];
  for (let i = 0; i < numPages; i++) {
    const size = pageSizes[i];
    const inRange = i >= range[0] && i <= range[1];
    pages.push(
      <div
        key={i}
        style={{ height: size ? size.h + PAGE_GAP : 0, position: "relative" }}
      >
        {size && inRange && pdfDoc && (
          <PageCanvas
            pdf={pdfDoc}
            pageNum={i + 1}
            cssWidth={size.w}
            cssHeight={size.h}
            onSelect={(e) => handleSelect(e, i + 1)}
            onContext={(e, text) => handleContext(e, text)}
          />
        )}
      </div>,
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto overflow-x-hidden bg-bg-tertiary/40">
      <div className="mx-auto w-fit px-6 py-4" data-testid="pdf-original-view">
        {pages}
      </div>
      {menu && (
        <div
          className="fixed z-50 min-w-40 overflow-hidden rounded-md border border-border bg-bg-secondary py-1 text-sm shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          {(
            [
              ["highlight", "高亮"],
              ["copy-original", "复制原文"],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              onClick={() => fireAction(kind)}
              className="block w-full px-3 py-1.5 text-left hover:bg-accent/20"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 单页：canvas 底图 + 透明文本层（textContent 优先，空则 OCR） */
function PageCanvas({
  pdf,
  pageNum,
  cssWidth,
  cssHeight,
  onSelect,
  onContext,
}: {
  pdf: import("pdfjs-dist").PDFDocumentProxy;
  pageNum: number;
  cssWidth: number;
  cssHeight: number;
  onSelect: (e: React.MouseEvent) => void;
  onContext: (e: React.MouseEvent, text: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  // pdfjs 渲染任务：同一 canvas 并发多次 render() 会抛错
  // （StrictMode 双执行 / 虚拟滚动重挂载 / deps 变化重跑时旧任务未完成）
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [status, setStatus] = useState<"rendering" | "text" | "ocr" | "error">("rendering");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("rendering");
    setErrorMsg(null);

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const page = await pdf.getPage(pageNum);
        const dpr = window.devicePixelRatio || 1;
        // css 尺寸已由父级按基准宽算好；viewport 用对应 scale
        const scale = cssWidth / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        const textLayer = textLayerRef.current;
        if (!canvas || !textLayer) return;

        // 取消上一次可能未完成的渲染（同一 canvas 不允许并发 render）
        renderTaskRef.current?.cancel();
        renderTaskRef.current = null;

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("无法创建 canvas 上下文");

        // pdfjs v6：RenderParameters 需要 canvas（canvasContext 可选）
        const renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTaskRef.current = renderTask;
        try {
          await renderTask.promise;
        } catch (e) {
          // 取消导致的 AbortException：组件已卸载/重渲染，静默忽略
          if (cancelled) return;
          throw e;
        }
        if (cancelled) return;

        // 文本层：先试 pdfjs textContent（同坐标系，天然对齐）。
        // pdfjs v6 API：new TextLayer({textContentSource, container, viewport}).render()
        const textContent = await page.getTextContent();
        if (textContent.items.length > 0) {
          const tl = new pdfjs.TextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport,
          });
          await tl.render();
          if (!cancelled) setStatus("text");
          return;
        }

        // 扫描版：canvas 图像 → 后端 Tesseract OCR（像素坐标 = canvas 像素）
        setStatus("ocr");
        const blob: Blob = await new Promise((res, rej) =>
          canvas.toBlob((b) => (b ? res(b) : rej(new Error("canvas 转图失败"))), "image/png"),
        );
        const b64 = await blobToBase64(blob);
        const res = await invoke<{ words: OcrWord[] }>("ocr_page_image", {
          imageBase64: b64,
        });
        if (cancelled) return;
        // OCR 坐标基于 canvas 像素（宽 = cssWidth*dpr）→ css 坐标 = 像素 / dpr
        for (const w of res.words) {
          const span = document.createElement("span");
          span.textContent = w.text;
          span.style.left = `${w.x / dpr}px`;
          span.style.top = `${w.y / dpr}px`;
          span.style.fontSize = `${Math.max(6, w.h / dpr)}px`;
          span.style.position = "absolute";
          span.style.whiteSpace = "pre";
          textLayer.appendChild(span);
        }
        if (!cancelled) setStatus("text");
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      // 卸载/重挂时取消未完成的渲染，避免同一 canvas 并发 render
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageNum, cssWidth, cssHeight]);

  return (
    <div
      className="relative"
      style={{ width: cssWidth, height: cssHeight }}
      data-testid="pdf-original-page"
    >
      <canvas ref={canvasRef} className="block" onMouseUp={onSelect} onContextMenu={(e) => onContext(e, "")} />
      <div
        ref={textLayerRef}
        className="textLayer"
        onMouseUp={onSelect}
        onContextMenu={(e) => {
          const sel = window.getSelection()?.toString().trim() ?? "";
          onContext(e, sel);
        }}
      />
      {status === "rendering" && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-fg-tertiary">
          渲染中…
        </div>
      )}
      {status === "ocr" && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/50 text-xs text-fg-secondary">
          扫描页 OCR 识别中…
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center rounded border border-error/30 bg-error/10 p-3 text-xs text-error">
          {errorMsg ?? "页面渲染失败"}
        </div>
      )}
    </div>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        const base64 = result.includes(",") ? result.split(",")[1] : result;
        resolve(base64);
      } else {
        reject(new Error("读取图片失败"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

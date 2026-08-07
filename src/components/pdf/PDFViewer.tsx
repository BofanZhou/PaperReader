/**
 * components/pdf/PDFViewer.tsx —— Prompt 3 核心渲染组件
 *
 * - 用 pdfjs-dist 把 PDF 渲染到 Canvas（离屏缓存，双语模式复用同一份位图）
 * - 上方叠加透明 TextLayer：每个 element 绝对定位 div（bbox 转换 + scale）
 * - 虚拟滚动：IntersectionObserver 只渲染可视区域 ±2 页
 * - 三种模式：original / translated / bilingual（双语左右分栏 + 同步滚动）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  bboxToScreen,
  loadPdf,
  looksLikeFormula,
  toAssetUrl,
} from "../../lib/pdfRender";
import * as pdfjsLib from "pdfjs-dist";
import type {
  ContextMenuAction,
  ParsedElement,
  ParsedPage,
  PDFViewerProps,
  SelectionState,
  ViewMode,
} from "../../types/pdf";
import { HIGHLIGHT_COLORS } from "../../types/pdf";

/** 预渲染页面数（前后各） */
const PRELOAD = 2;
/** 页面间距 */
const PAGE_GAP = 24;

interface PageSlotProps {
  page: ParsedPage;
  pageWidth: number;
  viewport?: pdfjsLib.PageViewport;
  mode: ViewMode;
  visible: boolean;
  offscreen: HTMLCanvasElement | null;
  translations?: Record<string, string>;
  highlights?: PDFViewerProps["highlights"];
  registerSentinel: (el: HTMLDivElement | null, pageNum: number) => void;
  onSelect: (e: MouseEvent, el: ParsedElement, page: ParsedPage) => void;
  onContext: (e: MouseEvent, el: ParsedElement) => void;
}

/** 单页：canvas 底图 + TextLayer */
function PageSlot({
  page,
  pageWidth,
  viewport,
  mode,
  visible,
  offscreen,
  translations,
  highlights,
  registerSentinel,
  onSelect,
  onContext,
}: PageSlotProps) {
  // 与 canvas 渲染使用完全相同的 viewport，确保坐标空间一致
  const pageW = viewport ? viewport.width : pageWidth;
  const pageH = viewport ? viewport.height : page.height * (pageWidth / page.width);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 离屏 canvas 就绪后画到 DOM canvas（避免重渲染）
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !offscreen) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(offscreen, 0, 0, c.width, c.height);
  }, [offscreen, pageWidth]);

  const textContent = useCallback(
    (el: ParsedElement) => {
      if (mode === "translated" || mode === "bilingual") {
        return translations?.[el.id] || el.text;
      }
      return el.text;
    },
    [mode, translations],
  );

  const highlightFor = useCallback(
    (elId: string): string | null => {
      const h = highlights?.find((x) => x.elementId === elId && !x.range);
      if (!h) return null;
      return HIGHLIGHT_COLORS.find((c) => c.id === h.colorId)?.hex ?? "#FFD700";
    },
    [highlights],
  );

  return (
    <div
      className="relative mx-auto"
      style={{ width: pageW, marginBottom: PAGE_GAP }}
      data-page={page.pageNumber}
    >
      {/* 调试信息 overlay */}
      <div className="pointer-events-none absolute left-0 top-0 z-10 px-1 py-0.5 text-[10px] text-red-600/80 bg-yellow-100/80 rounded">
        P{page.pageNumber} {pageW.toFixed(0)}×{pageH.toFixed(0)} rot={viewport?.rotation ?? 0}
      </div>

      {/* 页面占位 sentinel（虚拟滚动观察点） */}
      <div
        ref={(el) => registerSentinel(el, page.pageNumber)}
        className="relative overflow-hidden rounded-sm shadow-[0_2px_12px_rgba(0,0,0,0.15)]"
        style={{ width: pageW, height: pageH }}
      >
        {/* canvas 底图 */}
        <canvas
          ref={canvasRef}
          width={Math.floor(pageW * (window.devicePixelRatio || 1))}
          height={Math.floor(pageH * (window.devicePixelRatio || 1))}
          className="absolute inset-0 block"
          style={{ width: pageW, height: pageH }}
        />

        {/* TextLayer：元素绝对定位层 */}
        {visible && (
          <div className="absolute inset-0 select-text" data-textlayer>
            {page.elements.map((el) => {
              // 优先使用 pdfjs viewport 的坐标转换，处理 crop box / rotation 偏移
              const box = (() => {
                if (viewport) {
                  const [x1, y1] = viewport.convertToViewportPoint(el.bbox.left, el.bbox.bottom);
                  const [x2, y2] = viewport.convertToViewportPoint(el.bbox.right, el.bbox.top);
                  const left = Math.min(x1, x2);
                  const top = Math.min(y1, y2);
                  const width = Math.abs(x2 - x1);
                  const height = Math.abs(y2 - y1);
                  return { left, top, width, height };
                }
                const scale = pageW / page.width;
                return bboxToScreen(el.bbox, pageH, scale);
              })();
              const hl = highlightFor(el.id);
              return (
                <div
                  key={el.id}
                  data-pd-el={el.id}
                  data-pd-type={el.type}
                  onMouseUp={(e) => onSelect(e.nativeEvent, el, page)}
                  onContextMenu={(e) => onContext(e.nativeEvent, el)}
                  className="absolute cursor-text rounded-[1px] transition-colors hover:bg-accent/20"
                  style={{
                    left: box.left,
                    top: box.top,
                    width: box.width,
                    height: box.height,
                    fontSize: el.fontSize ? Math.max(4, el.fontSize * (pageW / page.width)) : undefined,
                    lineHeight: el.fontSize ? `${Math.max(4, el.fontSize * (pageW / page.width) * 1.35)}px` : "1.35",
                    overflow: "hidden",
                    wordBreak: "break-word",
                    background: hl ? `${hl}55` : undefined,
                    boxShadow: hl ? `inset 0 0 0 1.5px ${hl}` : undefined,
                    // 调试：显示 TextLayer 边框与半透明文字，便于排查错位问题
                    border: "1px solid rgba(255,0,0,0.4)",
                    color: "rgba(255,0,0,0.6)",
                  }}
                >
                  <span className="whitespace-pre-wrap">{textContent(el)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* 未渲染时的骨架 */}
        {!visible && (
          <div className="absolute inset-0 animate-pulse bg-bg-tertiary/60" aria-hidden />
        )}
      </div>
    </div>
  );
}

export function PDFViewer(props: PDFViewerProps) {
  const { pdfUrl, result, mode = "original", translations, highlights, onSelectText, onContextMenuAction, onPageVisible } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState<number>(0);
  const [docError, setDocError] = useState<string | null>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set());
  const [offscreens, setOffscreens] = useState<Map<number, HTMLCanvasElement>>(() => new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; el: ParsedElement; text: string } | null>(null);

  const sentinelRefs = useRef(new Map<number, HTMLDivElement>());
  const offscreenMapRef = useRef(new Map<number, HTMLCanvasElement>());
  const viewportMapRef = useRef(new Map<number, pdfjsLib.PageViewport>());
  const renderingRef = useRef(new Set<number>());
  const docRef = useRef<Awaited<ReturnType<typeof loadPdf>> | null>(null);

  // 容器宽度（响应式）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setPageWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 文档加载
  useEffect(() => {
    let cancelled = false;
    setDocError(null);
    setOffscreens(new Map());
    offscreenMapRef.current.clear();
    renderingRef.current.clear();
    setVisiblePages(new Set());
    docRef.current = null;
    loadPdf(toAssetUrl(pdfUrl))
      .then((doc) => {
        if (!cancelled) docRef.current = doc;
      })
      .catch((e) => {
        if (!cancelled) setDocError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  // 渲染可见页（离屏缓存）
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || pageWidth <= 0) return;
    const wanted = [...visiblePages].filter(
      (p) => p >= 1 && p <= result.pages.length && !offscreenMapRef.current.has(p) && !renderingRef.current.has(p),
    );
    wanted.forEach((pageNum) => {
      renderingRef.current.add(pageNum);
      doc
        .getPage(pageNum)
        .then((pdfPage) => {
          const viewport1 = pdfPage.getViewport({ scale: 1 });
          const ratio = pageWidth / viewport1.width;
          const viewport = pdfPage.getViewport({ scale: ratio });
          const dpr = window.devicePixelRatio || 1;
          const oc = document.createElement("canvas");
          oc.width = Math.floor(viewport.width * dpr);
          oc.height = Math.floor(viewport.height * dpr);
          const transform: number[] = [dpr, 0, 0, dpr, 0, 0];
          // pdfjs v6：RenderParameters 必填 canvas（canvasContext 兼容但推荐 canvas）
          return pdfPage.render({ canvas: oc, viewport, transform }).promise.then(() => {
            viewportMapRef.current.set(pageNum, viewport);
            return oc;
          });
        })
        .then((oc) => {
          offscreenMapRef.current.set(pageNum, oc);
          setOffscreens(new Map(offscreenMapRef.current));
        })
        .catch((e) => {
          console.warn(`渲染第 ${pageNum} 页失败:`, e);
          setDocError((prev) => prev ?? `第 ${pageNum} 页渲染失败: ${e}`);
        })
        .finally(() => {
          renderingRef.current.delete(pageNum);
        });
    });
  }, [visiblePages, pageWidth, result.pages]);

  // IntersectionObserver：只渲染可视区域 ±2 页
  useEffect(() => {
    const sentinels = sentinelRefs.current;
    const obs = new IntersectionObserver(
      (entries) => {
        const next = new Set<number>(visiblePages);
        for (const en of entries) {
          const pageNum = Number((en.target as HTMLElement).dataset.pageNum);
          if (en.isIntersecting) {
            for (let i = Math.max(1, pageNum - PRELOAD); i <= Math.min(result.pages.length, pageNum + PRELOAD); i++) {
              next.add(i);
            }
          } else {
            next.delete(pageNum);
          }
        }
        setVisiblePages(next);
      },
      { root: containerRef.current, rootMargin: "200px" },
    );
    sentinels.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.pages.length, pageWidth]);

  const registerSentinel = useCallback((el: HTMLDivElement | null, pageNum: number) => {
    if (el) {
      el.dataset.pageNum = String(pageNum);
      sentinelRefs.current.set(pageNum, el);
    } else {
      sentinelRefs.current.delete(pageNum);
    }
  }, []);

  // 文本选中 → 上报（弹窗由父级渲染，PDFViewer 只负责发现选区）
  const handleSelect = useCallback(
    (_e: MouseEvent, el: ParsedElement, _page: ParsedPage) => {
      // 延迟到 mouseup 后再读 selection（让浏览器完成选区更新）
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (!text) return;
        const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        const rect = range?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        onSelectText?.({
          x: rect.left,
          y: rect.bottom + 6,
          text,
          elementId: el.id,
          range: null,
          isFormula: looksLikeFormula(text),
        });
      });
    },
    [onSelectText],
  );

  // 右键菜单
  const handleContext = useCallback(
    (e: MouseEvent, el: ParsedElement) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, el, text: el.text });
    },
    [],
  );

  const fireAction = useCallback(
    (kind: ContextMenuAction["kind"]) => {
      if (!menu) return;
      onContextMenuAction?.({ kind, elementId: menu.el.id, text: menu.text });
      setMenu(null);
    },
    [menu, onContextMenuAction],
  );

  // 点击空白处关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close, { once: true });
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  // bilingual：右栏复用渲染结果（共享 offscreens map）
  const leftMode: ViewMode = mode === "bilingual" ? "original" : mode;
  const rightMode: ViewMode = mode === "bilingual" ? "translated" : mode;

  const renderColumn = useCallback(
    (colMode: ViewMode) => (
      <div className="h-full flex-1 overflow-y-auto overflow-x-hidden px-6 py-4" data-scroll-col>
        {result.pages.map((page) => (
          <PageSlot
            key={page.pageNumber}
            page={page}
            pageWidth={pageWidth}
            viewport={viewportMapRef.current.get(page.pageNumber)}
            mode={colMode}
            visible={visiblePages.has(page.pageNumber)}
            offscreen={offscreens.get(page.pageNumber) ?? null}
            translations={translations}
            highlights={highlights}
            registerSentinel={registerSentinel}
            onSelect={handleSelect}
            onContext={handleContext}
          />
        ))}
      </div>
    ),
    [result.pages, pageWidth, visiblePages, offscreens, translations, highlights, registerSentinel, handleSelect, handleContext],
  );

  // 双语同步滚动
  useEffect(() => {
    if (mode !== "bilingual") return;
    const cols = containerRef.current?.querySelectorAll<HTMLElement>("[data-scroll-col]");
    if (!cols || cols.length < 2) return;
    const [left, right] = cols;
    let syncing = false;
    const onScroll = (src: HTMLElement, dst: HTMLElement) => () => {
      if (syncing) return;
      syncing = true;
      dst.scrollTop = src.scrollTop;
      requestAnimationFrame(() => (syncing = false));
    };
    const lh = onScroll(left, right);
    const rh = onScroll(right, left);
    left.addEventListener("scroll", lh);
    right.addEventListener("scroll", rh);
    return () => {
      left.removeEventListener("scroll", lh);
      right.removeEventListener("scroll", rh);
    };
  }, [mode, result.pages.length]);

  // 页面可见性回调
  useEffect(() => {
    if (!onPageVisible) return;
    visiblePages.forEach((p) => onPageVisible(p, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePages]);

  return (
    <div ref={containerRef} className="relative flex h-full w-full overflow-hidden bg-bg-tertiary/40">      {docError && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/80 p-6">
          <div className="max-w-md rounded-lg border border-error/40 bg-bg-secondary p-4 text-center">
            <p className="text-sm font-medium text-error">PDF 渲染失败</p>
            <p className="mt-2 whitespace-pre-wrap break-all text-xs text-fg-secondary">{docError}</p>
          </div>
        </div>
      )}

      {/* 渲染列 */}
      <div className="flex h-full w-full">
        {renderColumn(leftMode)}
        {mode === "bilingual" && (
          <>
            <div className="h-full w-px shrink-0 bg-border" aria-hidden />
            {renderColumn(rightMode)}
          </>
        )}
      </div>

      {/* 右键菜单 */}
      {menu && (
        <div
          className="fixed z-50 min-w-40 overflow-hidden rounded-md border border-border bg-bg-secondary py-1 text-sm shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          {(
            [
              ["highlight", "高亮"],
              ["note", "添加笔记"],
              ["copy-original", "复制原文"],
              ["copy-translated", "复制译文"],
              ["ai-discuss", "AI 讨论"],
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

export type { SelectionState };

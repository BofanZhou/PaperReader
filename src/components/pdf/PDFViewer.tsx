/**
 * components/pdf/PDFViewer.tsx —— Prompt 3 阅读视图（纯 DOM 版）
 *
 * 设计决策（用户 2026-08-07 调整）：放弃 Canvas 像素渲染 PDF 底图，
 * 因为识别文字与 PDF 原文难以像素重合。改为：
 * - 只渲染 OpenDataLoader 识别出的文字（按 reading_order 流式排版）
 * - 图表（figure / table）在原阅读位置插入展示
 * - 三种模式：original / translated / bilingual（对照双栏同步滚动）
 * - 保留：文字选中浮动弹窗、右键菜单、高亮
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { looksLikeFormula } from "../../lib/textUtils";
import { PaperImage } from "./PaperImage";
import type {
  ContextMenuAction,
  ParsedElement,
  ParsedPage,
  PDFViewerProps,
  SelectionState,
  ViewMode,
} from "../../types/pdf";
import { HIGHLIGHT_COLORS } from "../../types/pdf";

/** 表格文本（table_to_text 输出）→ 行列结构 */
function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.split(" | ").map((c) => c.trim()))
    .filter((row) => row.some(Boolean));
}

/** 高亮颜色：命中 elementId 且无 range 时整块高亮（返回 CSS 变量，主题自适应） */
function highlightColorFor(elId: string, highlights: PDFViewerProps["highlights"]): string | null {
  const h = highlights?.find((x) => x.elementId === elId && !x.range);
  if (!h) return null;
  return HIGHLIGHT_COLORS.find((c) => c.id === h.colorId)?.cssVar ?? "var(--hl-insight)";
}

interface BlockProps {
  el: ParsedElement;
  /** 实际显示的文本（译文模式可能被替换） */
  displayText: string;
  highlight: string | null;
  onSelect: (e: React.MouseEvent, el: ParsedElement) => void;
  onContext: (e: React.MouseEvent, el: ParsedElement) => void;
}

/** 单个元素块：按类型渲染（标题/段落/图注/公式/图片/表格） */
function ElementBlock({ el, displayText, highlight, onSelect, onContext }: BlockProps) {
  const common = {
    "data-pd-el": el.id,
    "data-pd-type": el.type,
    onMouseUp: (e: React.MouseEvent) => onSelect(e, el),
    onContextMenu: (e: React.MouseEvent) => onContext(e, el),
  } as const;

  // 高亮基于 CSS 变量渲染（P2-2）：半透明底色用 color-mix（WebView2/Chromium 111+ 支持），
  // 主题切换（--hl-* 变量变化）自动生效，无需 JS 感知主题
  const hlStyle = highlight
    ? {
        backgroundColor: `color-mix(in srgb, ${highlight} 33%, transparent)`,
        boxShadow: `inset 0 0 0 1.5px ${highlight}`,
      }
    : undefined;

  // 图片：卡片化展示，保留原位置（base64 IPC 加载，绕开 asset 协议 403）
  if (el.type === "figure" && el.imageSrc) {
    return (
      <figure
        {...common}
        className="my-4 flex flex-col items-center gap-2 rounded-xl border border-border bg-bg-secondary/40 p-3 shadow-sm"
        style={hlStyle}
      >
        <PaperImage path={el.imageSrc} alt={displayText || "figure"} maxHeight={420} />
        {displayText && (
          <figcaption className="max-w-full px-1 text-center text-xs leading-relaxed text-fg-tertiary">
            {displayText}
          </figcaption>
        )}
      </figure>
    );
  }

  // 表格：卡片化 + 表头行 + 斑马纹
  if (el.type === "table") {
    const rows = tableRows(displayText);
    return (
      <div {...common} className="my-4 overflow-x-auto rounded-xl border border-border bg-bg-secondary/40 shadow-sm" style={hlStyle}>
        <table className="w-full border-collapse text-[13px] leading-relaxed">
          {rows.length > 0 && (
            <thead>
              <tr>
                {rows[0].map((c, j) => (
                  <th key={j} className="border-b border-border bg-bg-tertiary/60 px-2.5 py-1.5 text-left font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.slice(1).map((cells, i) => (
              <tr key={i} className={i % 2 === 1 ? "bg-bg-tertiary/30" : undefined}>
                {cells.map((c, j) => (
                  <td key={j} className="border-b border-border/60 px-2.5 py-1.5 align-top">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // 标题：按 headingLevel 分级（字号梯度 + 段前间距 + 深浅层次）
  if (el.type === "heading") {
    const level = Math.min(4, Math.max(1, el.headingLevel ?? 1));
    const headingCls = [
      "my-4 text-[22px] font-bold leading-snug text-fg",          // H1
      "my-3.5 text-[19px] font-semibold leading-snug text-fg",    // H2
      "my-3 text-[16px] font-semibold leading-snug text-fg",      // H3
      "my-2.5 text-[14.5px] font-semibold leading-snug text-fg-secondary", // H4
    ];
    return (
      <div {...common} className={headingCls[level - 1] ?? "my-2.5 font-semibold text-fg"} style={hlStyle}>
        {displayText}
      </div>
    );
  }

  // 图注 / 公式 / 段落
  if (el.type === "caption") {
    return (
      <p {...common} className="my-1 text-xs leading-relaxed text-fg-tertiary" style={hlStyle}>
        {displayText}
      </p>
    );
  }
  if (el.type === "formula") {
    return (
      <div {...common} className="my-2 overflow-x-auto rounded-md bg-bg-secondary/40 px-3 py-2 text-center font-mono text-sm leading-relaxed text-fg" style={hlStyle}>
        {displayText}
      </div>
    );
  }
  return (
    <p {...common} className="my-2 text-[15px] leading-[1.75] text-fg" style={hlStyle}>
      {displayText}
    </p>
  );
}

/** 单页：标题页眉 + 元素流 */
function PageSection({
  page,
  mode,
  translations,
  highlights,
  onSelect,
  onContext,
}: {
  page: ParsedPage;
  mode: ViewMode;
  translations?: Record<string, string>;
  highlights?: PDFViewerProps["highlights"];
  onSelect: (e: React.MouseEvent, el: ParsedElement) => void;
  onContext: (e: React.MouseEvent, el: ParsedElement) => void;
}) {
  // 按阅读顺序排序（useMemo：元素多时不重复 sort）
  const sorted = useMemo(
    () => [...page.elements].sort((a, b) => a.readingOrder - b.readingOrder),
    [page.elements],
  );

  const textFor = useCallback(
    (el: ParsedElement) => {
      if (mode === "translated" || mode === "bilingual") {
        return translations?.[el.id] ?? el.text;
      }
      return el.text;
    },
    [mode, translations],
  );

  return (
    <section className="mx-auto mb-6 w-full max-w-[780px] rounded-lg border border-border bg-bg px-6 py-5 shadow-sm">
      <header className="mb-4 flex items-center justify-center gap-3">
        <span className="h-px flex-1 bg-border/60" aria-hidden />
        <span className="text-[11px] font-medium tracking-widest text-fg-tertiary">第 {page.pageNumber} 页</span>
        <span className="h-px flex-1 bg-border/60" aria-hidden />
      </header>
      {sorted.map((el) => {
        // 空文本元素（解析兜底遗留）不渲染，但图片元素允许无文本
        const hasFigureImage = el.type === "figure" && el.imageSrc;
        if (!el.text.trim() && !hasFigureImage) {
          return null;
        }
        return (
          <ElementBlock
            key={el.id}
            el={el}
            displayText={textFor(el)}
            highlight={highlightColorFor(el.id, highlights)}
            onSelect={onSelect}
            onContext={onContext}
          />
        );
      })}
    </section>
  );
}

export function PDFViewer(props: PDFViewerProps) {
  const { result, mode, translations, highlights, onSelectText, onContextMenuAction } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; el: ParsedElement; text: string } | null>(null);

  // 文本选中 → 上报（弹窗由父级渲染）
  const handleSelect = useCallback(
    (_e: React.MouseEvent, el: ParsedElement) => {
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
          width: rect.width,
          height: rect.height,
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
  const handleContext = useCallback((e: React.MouseEvent, el: ParsedElement) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, el, text: el.text });
  }, []);

  const fireAction = useCallback(
    (kind: ContextMenuAction["kind"]) => {
      if (!menu) return;
      onContextMenuAction?.({ kind, elementId: menu.el.id, text: menu.text });
      setMenu(null);
    },
    [menu, onContextMenuAction],
  );

  // 点击空白处 / Esc 关闭右键菜单
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

  // 单栏渲染（双语由 Workspace 层拆分渲染两栏）
  const renderColumn = useCallback(
    (colMode: ViewMode) => (
      <div className="h-full w-full overflow-y-auto overflow-x-hidden px-4 py-4" data-scroll-col>
        {result.pages.map((page) => (
          <PageSection
            key={page.pageNumber}
            page={page}
            mode={colMode}
            translations={translations}
            highlights={highlights}
            onSelect={handleSelect}
            onContext={handleContext}
          />
        ))}
      </div>
    ),
    [result.pages, translations, highlights, handleSelect, handleContext],
  );

  return (
    <div ref={containerRef} data-testid="pdf-viewer" className="relative flex h-full w-full overflow-hidden bg-bg-tertiary/40">
      <div className="flex h-full w-full">{renderColumn(mode)}</div>

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

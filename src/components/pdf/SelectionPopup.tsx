/**
 * components/pdf/SelectionPopup.tsx —— 选中即翻译浮动弹窗（PaperMind 风格）
 *
 * - 高亮颜色选择（黄/绿/蓝/红）
 * - 翻译按钮 + 目标语言快速切换（🇨🇳/🇬🇧/🇯🇵）
 * - 笔记按钮、AI 讨论按钮（将选中文本注入聊天）
 * - 公式检测：包含数学符号时显示"解释公式"按钮
 * - 翻译结果区域：长翻译默认折叠 4 行，支持展开/折叠
 * - 弹窗限制在阅读区域内（由父级传入容器 rect，自动翻转防止溢出）
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bookmark, Copy, MessageSquare, Sigma, Sparkles, X } from "lucide-react";
import type { HighlightColorId, SelectionState, TargetLang } from "../../types/pdf";
import { HIGHLIGHT_COLORS, TARGET_LANGS } from "../../types/pdf";

export interface SelectionPopupProps {
  selection: SelectionState;
  /** 阅读区容器（用于限制弹窗边界，不覆盖侧边栏） */
  containerRect: DOMRect | null;
  /** 已选中的高亮颜色（最近一次） */
  activeColor?: HighlightColorId;
  /** 当前翻译结果（未翻译为 null） */
  translation?: { target: TargetLang; text: string } | null;
  /** 是否正在翻译 */
  translating?: boolean;
  onTranslate: (text: string, lang: TargetLang) => void;
  onHighlight: (colorId: HighlightColorId) => void;
  onNote: (text: string) => void;
  onAiDiscuss: (text: string) => void;
  onExplainFormula: (text: string) => void;
  onClose: () => void;
}

const POPUP_GAP = 8;
const MAX_WIDTH = 380;

export function SelectionPopup({
  selection,
  containerRect,
  activeColor = "yellow",
  translation,
  translating = false,
  onTranslate,
  onHighlight,
  onNote,
  onAiDiscuss,
  onExplainFormula,
  onClose,
}: SelectionPopupProps) {
  const [target, setTarget] = useState<TargetLang>("zh");
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: selection.x, top: selection.y });

  // 弹窗位置：限制在容器内，必要时翻转（选中在下方 → 弹窗放上方）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 120;
    const rect = containerRect;
    let left = selection.x;
    let top = selection.y + POPUP_GAP; // 默认在选区下方

    if (rect) {
      // 水平方向不越界（不覆盖侧边栏）
      if (left + w > rect.right - 8) left = rect.right - w - 8;
      if (left < rect.left + 8) left = rect.left + 8;
      // 垂直方向：下方放不下就翻到上方
      if (top + h > rect.bottom - 8) {
        top = selection.y - h - POPUP_GAP;
      }
      if (top < rect.top + 8) top = rect.top + 8;
    } else {
      left = Math.max(8, left);
      if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    }
    setPos({ left, top });
  }, [selection.x, selection.y, containerRect, translation, expanded]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const showTranslation = Boolean(translation || translating);
  const needsCollapse = Boolean(translation && translation.text.length > 120 && !expanded);

  return (
    <div
      ref={ref}
      className="fixed z-40 overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-[0_8px_32px_rgba(0,0,0,0.18)]"
      style={{ left: pos.left, top: pos.top, width: "auto", maxWidth: MAX_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 工具栏行 */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        {/* 高亮颜色 */}
        <div className="flex items-center gap-1" title="高亮颜色">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.id}
              onClick={() => onHighlight(c.id)}
              title={`高亮（${c.label}）`}
              className="size-5 rounded-full border border-black/10 transition-transform hover:scale-110"
              style={{
                backgroundColor: c.hex,
                outline: activeColor === c.id ? "2px solid var(--accent)" : "none",
                outlineOffset: 1,
              }}
            />
          ))}
        </div>

        <div className="mx-1 h-4 w-px bg-border" aria-hidden />

        {/* 翻译按钮 */}
        <button
          onClick={() => onTranslate(selection.text, target)}
          disabled={translating}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/15 disabled:opacity-50"
        >
          <Sparkles className="size-3.5" aria-hidden />
          {translating ? "翻译中…" : "翻译"}
        </button>

        {/* 目标语言切换 */}
        <div className="flex items-center gap-0.5 rounded-md bg-bg-tertiary/70 p-0.5">
          {TARGET_LANGS.map((l) => (
            <button
              key={l.id}
              onClick={() => setTarget(l.id)}
              title={l.label}
              className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                target === l.id ? "bg-accent/20 text-accent" : "text-fg-tertiary hover:text-fg"
              }`}
            >
              {l.flag}
            </button>
          ))}
        </div>

        <div className="mx-1 h-4 w-px bg-border" aria-hidden />

        {/* 笔记 / AI 讨论 / 公式 */}
        <button
          onClick={() => onNote(selection.text)}
          title="添加笔记"
          className="rounded-md p-1 text-fg-secondary hover:bg-accent/15 hover:text-accent"
        >
          <Bookmark className="size-3.5" aria-hidden />
        </button>
        <button
          onClick={() => onAiDiscuss(selection.text)}
          title="AI 讨论"
          className="rounded-md p-1 text-fg-secondary hover:bg-accent/15 hover:text-accent"
        >
          <MessageSquare className="size-3.5" aria-hidden />
        </button>
        {selection.isFormula && (
          <button
            onClick={() => onExplainFormula(selection.text)}
            title="解释公式"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-purple-600 hover:bg-purple-500/15 dark:text-purple-400"
          >
            <Sigma className="size-3.5" aria-hidden /> 解释公式
          </button>
        )}

        <div className="flex-1" />

        <button
          onClick={onClose}
          title="关闭 (Esc)"
          className="rounded-md p-1 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      {/* 选中文本预览（最多 2 行） */}
      <div className="border-t border-border bg-bg-tertiary/40 px-3 py-1.5">
        <p className="line-clamp-2 text-xs leading-relaxed text-fg-secondary">
          <Copy className="mr-1 inline size-3 shrink-0 opacity-50" aria-hidden />
          {selection.text}
        </p>
      </div>

      {/* 翻译结果区：长翻译默认折叠 4 行 */}
      {showTranslation && (
        <div className="border-t border-border px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wide text-fg-tertiary">
              译文 · {TARGET_LANGS.find((l) => l.id === target)?.label}
            </span>
          </div>
          {translating ? (
            <p className="animate-pulse text-xs text-fg-tertiary">正在翻译…</p>
          ) : (
            <>
              <p
                className={`text-xs leading-relaxed ${
                  needsCollapse ? "line-clamp-4" : ""
                }`}
              >
                {translation?.text}
              </p>
              {needsCollapse && (
                <button
                  onClick={() => setExpanded(true)}
                  className="mt-1 text-[11px] text-accent hover:underline"
                >
                  展开全部
                </button>
              )}
              {expanded && (
                <button
                  onClick={() => setExpanded(false)}
                  className="mt-1 text-[11px] text-accent hover:underline"
                >
                  折叠
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export type { TargetLang };

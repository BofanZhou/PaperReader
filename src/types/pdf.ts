/**
 * types/pdf.ts —— Prompt 3 类型定义
 *
 * PDF 渲染相关类型：视图模式、PDF 页面渲染 props、选中状态、高亮。
 * 与 Rust 端 ParsedResult（camelCase）保持命名一致。
 */

import type { Bbox, ElementType, ParsedResult, ParsedElement, ParsedPage } from "../lib/env";

export type { Bbox, ElementType, ParsedResult, ParsedElement, ParsedPage };

/** 阅读视图模式：pdf-original（pdfjs 原图）/ restructured（AI 重排，规划中）/ translated（译文）/ bilingual（对照） */
export type ViewMode = "pdf-original" | "restructured" | "translated" | "bilingual";

/**
 * 高亮颜色（Engineering Supplement §1.2 设计系统，P2-2 对齐）
 *
 * 6 分类语义 id + 亮/暗双主题值。色值由 index.css 的 --hl-* CSS 变量提供
 * （单一来源，主题切换自动生效）；此处引用变量而非硬编码 Hex。
 * 半透明渲染（高亮底色）用 color-mix 基于该变量生成。
 */
export const HIGHLIGHT_COLORS = [
  { id: "insight", label: "洞察", cssVar: "var(--hl-insight)" },
  { id: "question", label: "疑问", cssVar: "var(--hl-question)" },
  { id: "conclusion", label: "结论", cssVar: "var(--hl-conclusion)" },
  { id: "method", label: "方法", cssVar: "var(--hl-method)" },
  { id: "experiment", label: "实验", cssVar: "var(--hl-experiment)" },
  { id: "to-read", label: "待读", cssVar: "var(--hl-to-read)" },
] as const;

export type HighlightColorId = (typeof HIGHLIGHT_COLORS)[number]["id"];

/** 高亮标注 */
export interface Highlight {
  id: string;
  elementId: string;
  colorId: HighlightColorId;
  /** 字符偏移 [start, end]，在 element.text 内的区间；缺省表示整个元素 */
  range?: [number, number];
  note?: string;
  createdAt: number;
}

/** 目标语言 */
export type TargetLang = "zh" | "en" | "ja";

export const TARGET_LANGS: { id: TargetLang; label: string; flag: string }[] = [
  { id: "zh", label: "中文", flag: "🇨🇳" },
  { id: "en", label: "English", flag: "🇬🇧" },
  { id: "ja", label: "日本語", flag: "🇯🇵" },
];

/** 文本选中状态（SelectionPopup 触发） */
export interface SelectionState {
  /** 屏幕坐标（固定定位用） */
  x: number;
  y: number;
  /** 选区尺寸（px，弹窗定位用） */
  width?: number;
  height?: number;
  /** 选中的纯文本 */
  text: string;
  /** 命中元素 id（可能跨元素，取第一个） */
  elementId: string | null;
  /** 在元素文本内的字符偏移（近似，用于高亮 range） */
  range: [number, number] | null;
  /** 是否疑似公式 */
  isFormula: boolean;
}

/** 翻译结果（Prompt 4 接入真实引擎前先由调用方注入） */
export interface Translation {
  elementId: string;
  target: TargetLang;
  text: string;
  /** 原文（展示对照用） */
  sourceText?: string;
}

/** PDFViewer 渲染 props */
export interface PDFViewerProps {
  /** 解析结果（含页面尺寸 + 元素） */
  result: ParsedResult;
  mode: ViewMode;
  /** 缩放比例（1 = 100%） */
  scale?: number;
  /** 元素级翻译（Prompt 4 接入；缺省回退原文） */
  translations?: Record<string, string>;
  /** 句子级数据（Prompt 3 骨架：sentenceId → 段落切分），未接入时可省略 */
  sentences?: Record<string, unknown>;
  highlights?: Highlight[];
  onSelectText?: (sel: SelectionState) => void;
  onContextMenuAction?: (action: ContextMenuAction) => void;
  onPageVisible?: (pageNumber: number, visible: boolean) => void;
}

/** 右键菜单动作 */
export interface ContextMenuAction {
  kind: "highlight" | "note" | "copy-original" | "copy-translated" | "ai-discuss";
  elementId: string;
  text: string;
}

/** 句号 / 问号 / 感叹号等句子分隔符（句子切分用） */
export const SENTENCE_BREAK_RE = /(?<=[.!?。！？；;])\s+/;

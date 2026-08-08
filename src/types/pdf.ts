/**
 * types/pdf.ts —— Prompt 3 类型定义
 *
 * PDF 渲染相关类型：视图模式、PDF 页面渲染 props、选中状态、高亮。
 * 与 Rust 端 ParsedResult（camelCase）保持命名一致。
 */

import type { Bbox, ElementType, ParsedResult, ParsedElement, ParsedPage } from "../lib/env";

export type { Bbox, ElementType, ParsedResult, ParsedElement, ParsedPage };

/** 三种阅读视图模式 */
export type ViewMode = "original" | "translated" | "bilingual";

/** 高亮颜色（PaperMind 风格） */
export const HIGHLIGHT_COLORS = [
  { id: "yellow", hex: "#FFD700", label: "黄色" },
  { id: "green", hex: "#90EE90", label: "绿色" },
  { id: "blue", hex: "#87CEEB", label: "蓝色" },
  { id: "red", hex: "#FFB6C1", label: "红色" },
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

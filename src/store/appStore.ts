import { create } from "zustand";
import { onPdfProgress, parsePdf, type ParsedResult, type ParseProgress } from "../lib/env";
import {
  onTranslateProgress,
  translatePaper,
  type TranslateProgress,
  type TranslateResult,
} from "../lib/ai";

export type ViewMode = "original" | "translated" | "bilingual";

export const MODELS = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "kimi-k3", label: "Kimi K3（开放平台）" },
  { id: "kimi-code", label: "Kimi for Coding（会员）" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

type ParseState = "idle" | "parsing" | "error" | "success";
type TranslateState = "idle" | "translating" | "error" | "success";

interface AppState {
  currentFile: string | null;
  viewMode: ViewMode;
  model: ModelId;

  // PDF 解析
  parseState: ParseState;
  parseProgress: ParseProgress | null;
  parsedResult: ParsedResult | null;
  parseError: string | null;

  // 翻译
  translateState: TranslateState;
  translateProgress: TranslateProgress | null;
  /** element_id → 译文 */
  translations: Record<string, string> | null;
  translateError: string | null;
  estimatedCostUsd: number | null;

  setCurrentFile: (path: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setModel: (model: ModelId) => void;
  runParse: () => Promise<void>;
  resetParse: () => void;
  runTranslate: () => Promise<void>;
  resetTranslate: () => void;
}

let unlistenProgress: (() => void) | null = null;
let unlistenTranslate: (() => void) | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  currentFile: null,
  viewMode: "original",
  model: "deepseek-v4-flash",

  parseState: "idle",
  parseProgress: null,
  parsedResult: null,
  parseError: null,

  translateState: "idle",
  translateProgress: null,
  translations: null,
  translateError: null,
  estimatedCostUsd: null,

  setCurrentFile: (path) => {
    set({ currentFile: path });
    if (path) {
      get().runParse();
    }
  },

  setViewMode: (mode) => set({ viewMode: mode }),
  setModel: (model) => set({ model }),

  runParse: async () => {
    const { currentFile } = get();
    if (!currentFile) return;

    set({ parseState: "parsing", parseProgress: null, parseError: null });

    if (!unlistenProgress) {
      onPdfProgress((p: ParseProgress) => set({ parseProgress: p })).then(
        (fn: () => void) => {
          unlistenProgress = fn;
        },
      );
    }

    try {
      const result = await parsePdf(currentFile);
      set({ parseState: "success", parsedResult: result, parseError: null });
    } catch (e) {
      set({ parseState: "error", parseError: String(e) });
    }
  },

  resetParse: () =>
    set({
      parseState: "idle",
      parseProgress: null,
      parsedResult: null,
      parseError: null,
      // 切换论文时清空翻译
      translateState: "idle",
      translateProgress: null,
      translations: null,
      translateError: null,
      estimatedCostUsd: null,
    }),

  runTranslate: async () => {
    const { currentFile, model } = get();
    if (!currentFile) return;
    if (get().translateState === "translating") return;

    set({ translateState: "translating", translateProgress: null, translateError: null });

    if (!unlistenTranslate) {
      onTranslateProgress((p: TranslateProgress) => set({ translateProgress: p })).then(
        (fn: () => void) => {
          unlistenTranslate = fn;
        },
      );
    }

    try {
      const result: TranslateResult = await translatePaper(currentFile, "zh", model);
      set({
        translateState: "success",
        translations: result.translations,
        estimatedCostUsd: result.estimatedCostUsd,
        translateError: null,
      });
    } catch (e) {
      set({ translateState: "error", translateError: String(e) });
    }
  },

  resetTranslate: () =>
    set({
      translateState: "idle",
      translateProgress: null,
      translations: null,
      translateError: null,
      estimatedCostUsd: null,
    }),
}));

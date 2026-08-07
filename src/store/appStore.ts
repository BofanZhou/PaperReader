import { create } from "zustand";
import { onPdfProgress, parsePdf, type ParsedResult, type ParseProgress } from "../lib/env";

export type ViewMode = "original" | "translated" | "bilingual";

export const MODELS = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

type ParseState = "idle" | "parsing" | "error" | "success";

interface AppState {
  currentFile: string | null;
  viewMode: ViewMode;
  model: ModelId;

  // PDF 解析
  parseState: ParseState;
  parseProgress: ParseProgress | null;
  parsedResult: ParsedResult | null;
  parseError: string | null;

  setCurrentFile: (path: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setModel: (model: ModelId) => void;
  runParse: () => Promise<void>;
  resetParse: () => void;
}

let unlistenProgress: (() => void) | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  currentFile: null,
  viewMode: "original",
  model: "deepseek-v4-flash",

  parseState: "idle",
  parseProgress: null,
  parsedResult: null,
  parseError: null,

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
    }),
}));

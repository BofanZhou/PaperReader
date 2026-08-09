import { create } from "zustand";
import { onPdfProgress, parsePdf, type ParsedResult, type ParseProgress } from "../lib/env";
import {
  aiRestructure,
  getAiConfig,
  onRestructureProgress,
  onTranslateProgress,
  translatePaper,
  type ModelConfig,
  type RestructureProgress,
  type TranslateProgress,
  type TranslateResult,
} from "../lib/ai";

export type ViewMode = "pdf-original" | "restructured" | "translated" | "bilingual";

type ParseState = "idle" | "parsing" | "error" | "success";
type TranslateState = "idle" | "translating" | "error" | "success";

/**
 * 请求序号：用于作废过期的在途请求（代码审查 P2 翻译/解析竞态）。
 * 切换论文时递增，旧请求返回后被丢弃，避免 A 论文结果污染 B 论文。
 */
let parseReqId = 0;
let translateReqId = 0;
let restructureReqId = 0;

interface AppState {
  currentFile: string | null;
  viewMode: ViewMode;
  /** 当前翻译模型 ID（从后端模型列表加载，见 loadModels） */
  model: string;
  /** 模型列表（单一数据源 = Rust default_models()，经 get_ai_config 下发） */
  models: ModelConfig[];
  modelsLoaded: boolean;

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

  // AI 重排
  restructureState: "idle" | "running" | "error" | "success";
  restructureProgress: RestructureProgress | null;
  restructuredDoc: string | null;
  restructureError: string | null;

  setCurrentFile: (path: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setModel: (model: string) => void;
  loadModels: () => Promise<void>;
  runParse: () => Promise<void>;
  resetParse: () => void;
  runTranslate: () => Promise<void>;
  resetTranslate: () => void;
  runRestructure: (force?: boolean) => Promise<void>;
  resetRestructure: () => void;
}

let unlistenProgress: (() => void) | null = null;
let unlistenTranslate: (() => void) | null = null;
let unlistenRestructure: (() => void) | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  currentFile: null,
  viewMode: "pdf-original",
  model: "deepseek-v4-flash",
  models: [],
  modelsLoaded: false,

  parseState: "idle",
  parseProgress: null,
  parsedResult: null,
  parseError: null,

  translateState: "idle",
  translateProgress: null,
  translations: null,
  translateError: null,
  estimatedCostUsd: null,

  restructureState: "idle",
  restructureProgress: null,
  restructuredDoc: null,
  restructureError: null,

  /**
   * 切换论文：立即清空上一份论文的全部内容（解析结果 + 译文 + 进度），
   * 并递增请求序号作废在途的解析/翻译请求。
   */
  setCurrentFile: (path) => {
    const { currentFile } = get();
    if (currentFile === path) return;
    // 作废在途请求
    parseReqId++;
    translateReqId++;
    restructureReqId++;
    set({
      currentFile: path,
      parseState: path ? "idle" : "idle",
      parseProgress: null,
      parsedResult: null,
      parseError: null,
      translateState: "idle",
      translateProgress: null,
      translations: null,
      translateError: null,
      estimatedCostUsd: null,
      restructureState: "idle",
      restructureProgress: null,
      restructuredDoc: null,
      restructureError: null,
    });
    if (path) {
      void get().runParse();
    }
  },

  setViewMode: (mode) => set({ viewMode: mode }),
  setModel: (model) => set({ model }),

  /** 从后端加载模型列表（P6 单源化：删除前端硬编码 MODELS） */
  loadModels: async () => {
    try {
      const cfg = await getAiConfig();
      set((s) => ({
        models: cfg.models,
        modelsLoaded: true,
        // 已手动选过模型则保留；否则用后端默认
        model: s.model && cfg.models.some((m) => m.id === s.model) ? s.model : cfg.defaultModel,
      }));
    } catch (e) {
      // 加载失败不阻塞：保留现有模型，下次打开设置面板会重试
      console.error("[appStore] 加载模型列表失败:", e);
      set({ modelsLoaded: true });
    }
  },

  runParse: async () => {
    const { currentFile } = get();
    if (!currentFile) return;

    const reqId = ++parseReqId;
    const fileAtStart = currentFile;
    set({ parseState: "parsing", parseProgress: null, parseError: null, parsedResult: null });

    if (!unlistenProgress) {
      onPdfProgress((p: ParseProgress) => set({ parseProgress: p })).then(
        (fn: () => void) => {
          unlistenProgress = fn;
        },
      );
    }

    try {
      const result = await parsePdf(fileAtStart);
      // 已切换论文 → 丢弃过期结果
      if (reqId !== parseReqId || get().currentFile !== fileAtStart) return;
      set({ parseState: "success", parsedResult: result, parseError: null });
    } catch (e) {
      if (reqId !== parseReqId || get().currentFile !== fileAtStart) return;
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

    const reqId = ++translateReqId;
    const fileAtStart = currentFile;
    set({ translateState: "translating", translateProgress: null, translateError: null });

    if (!unlistenTranslate) {
      onTranslateProgress((p: TranslateProgress) => set({ translateProgress: p })).then(
        (fn: () => void) => {
          unlistenTranslate = fn;
        },
      );
    }

    try {
      const result: TranslateResult = await translatePaper(fileAtStart, "zh", model);
      // 已切换论文 / 已发起新翻译 → 丢弃过期结果（P2 竞态修复）
      if (reqId !== translateReqId || get().currentFile !== fileAtStart) return;
      set({
        translateState: "success",
        translations: result.translations,
        estimatedCostUsd: result.estimatedCostUsd,
        translateError: null,
      });
    } catch (e) {
      if (reqId !== translateReqId || get().currentFile !== fileAtStart) return;
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

  runRestructure: async (force = false) => {
    const { currentFile } = get();
    if (!currentFile) return;
    if (get().restructureState === "running") return;

    const reqId = ++restructureReqId;
    const fileAtStart = currentFile;
    set({ restructureState: "running", restructureProgress: null, restructureError: null });

    if (!unlistenRestructure) {
      onRestructureProgress((p: RestructureProgress) => set({ restructureProgress: p })).then(
        (fn: () => void) => {
          unlistenRestructure = fn;
        },
      );
    }

    try {
      const doc = await aiRestructure(fileAtStart, force);
      // 已切换论文 / 已发起新重排 → 丢弃过期结果
      if (reqId !== restructureReqId || get().currentFile !== fileAtStart) return;
      set({ restructureState: "success", restructuredDoc: doc.markdown, restructureError: null });
    } catch (e) {
      if (reqId !== restructureReqId || get().currentFile !== fileAtStart) return;
      set({ restructureState: "error", restructureError: String(e) });
    }
  },

  resetRestructure: () =>
    set({
      restructureState: "idle",
      restructureProgress: null,
      restructuredDoc: null,
      restructureError: null,
    }),
}));

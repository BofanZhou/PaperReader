import { create } from "zustand";

export type ViewMode = "original" | "translated" | "bilingual";

export const MODELS = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

interface AppState {
  currentFile: string | null;
  viewMode: ViewMode;
  model: ModelId;
  setCurrentFile: (path: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setModel: (model: ModelId) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentFile: null,
  viewMode: "original",
  model: "deepseek-v4-flash",
  setCurrentFile: (path) => set({ currentFile: path }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setModel: (model) => set({ model }),
}));

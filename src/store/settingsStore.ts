/**
 * store/settingsStore.ts —— Prompt 9 设置面板状态（持久化到 SQLite settings 表）
 *
 * 覆盖：显示设置（主题模式/字体大小/行距/分栏比例）+ 翻译设置（源/目标语言、
 * 术语注入、句子对齐、本地缓存）。所有 setter 更新内存并异步写 SQLite
 * （失败仅告警，SQLite 不可用时以默认值运行）。
 */
import { create } from "zustand";
import { getSetting, setSetting } from "../lib/db";

export type ThemeMode = "light" | "dark" | "system";

export interface SettingsState {
  loaded: boolean;

  // 显示设置
  themeMode: ThemeMode;
  fontSize: number; // px, 12-24
  lineHeight: number; // 1.0-2.0
  splitRatio: number; // 对照模式左栏占比 0.3-0.7

  // 翻译设置
  sourceLang: string;
  targetLang: string;
  termInjection: boolean;
  sentenceAlign: boolean;
  localCache: boolean;

  load: () => Promise<void>;
  setThemeMode: (m: ThemeMode) => void;
  setFontSize: (v: number) => void;
  setLineHeight: (v: number) => void;
  setSplitRatio: (v: number) => void;
  setSourceLang: (v: string) => void;
  setTargetLang: (v: string) => void;
  setTermInjection: (v: boolean) => void;
  setSentenceAlign: (v: boolean) => void;
  setLocalCache: (v: boolean) => void;
}

const KEYS = {
  themeMode: "reader.themeMode",
  fontSize: "reader.fontSize",
  lineHeight: "reader.lineHeight",
  splitRatio: "reader.splitRatio",
  sourceLang: "trans.sourceLang",
  targetLang: "trans.targetLang",
  termInjection: "trans.termInjection",
  sentenceAlign: "trans.sentenceAlign",
  localCache: "trans.localCache",
};

async function readNum(key: string, def: number): Promise<number> {
  try {
    const v = await getSetting(key);
    if (v === null) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  } catch {
    return def;
  }
}

async function readBool(key: string, def: boolean): Promise<boolean> {
  try {
    const v = await getSetting(key);
    return v === null ? def : v === "1" || v === "true";
  } catch {
    return def;
  }
}

function persist(key: string, value: string | number | boolean) {
  setSetting(key, String(value)).catch((e) => console.error(`[settings] 持久化 ${key} 失败:`, e));
}

const DEFAULT: Pick<
  SettingsState,
  | "themeMode"
  | "fontSize"
  | "lineHeight"
  | "splitRatio"
  | "sourceLang"
  | "targetLang"
  | "termInjection"
  | "sentenceAlign"
  | "localCache"
> = {
  themeMode: "system",
  fontSize: 14,
  lineHeight: 1.6,
  splitRatio: 0.5,
  sourceLang: "en",
  targetLang: "zh",
  termInjection: true,
  sentenceAlign: false,
  localCache: true,
};

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULT,
  loaded: false,

  load: async () => {
    try {
      const [themeMode, fontSize, lineHeight, splitRatio, sourceLang, targetLang, termInjection, sentenceAlign, localCache] =
        await Promise.all([
          getSetting(KEYS.themeMode).then((v) => (v === "light" || v === "dark" || v === "system" ? v : "system")),
          readNum(KEYS.fontSize, DEFAULT.fontSize),
          readNum(KEYS.lineHeight, DEFAULT.lineHeight),
          readNum(KEYS.splitRatio, DEFAULT.splitRatio),
          getSetting(KEYS.sourceLang).then((v) => v ?? DEFAULT.sourceLang),
          getSetting(KEYS.targetLang).then((v) => v ?? DEFAULT.targetLang),
          readBool(KEYS.termInjection, DEFAULT.termInjection),
          readBool(KEYS.sentenceAlign, DEFAULT.sentenceAlign),
          readBool(KEYS.localCache, DEFAULT.localCache),
        ]);
      set({
        themeMode,
        fontSize: Math.min(24, Math.max(12, fontSize)),
        lineHeight: Math.min(2, Math.max(1, lineHeight)),
        splitRatio: Math.min(0.7, Math.max(0.3, splitRatio)),
        sourceLang,
        targetLang,
        termInjection,
        sentenceAlign,
        localCache,
        loaded: true,
      });
    } catch (e) {
      console.error("[settings] 加载设置失败，使用默认值:", e);
      set({ loaded: true });
    }
  },

  setThemeMode: (m) => {
    set({ themeMode: m });
    persist(KEYS.themeMode, m);
  },
  setFontSize: (v) => {
    set({ fontSize: Math.min(24, Math.max(12, v)) });
    persist(KEYS.fontSize, Math.min(24, Math.max(12, v)));
  },
  setLineHeight: (v) => {
    set({ lineHeight: Math.min(2, Math.max(1, v)) });
    persist(KEYS.lineHeight, Math.min(2, Math.max(1, v)));
  },
  setSplitRatio: (v) => {
    set({ splitRatio: Math.min(0.7, Math.max(0.3, v)) });
    persist(KEYS.splitRatio, Math.min(0.7, Math.max(0.3, v)));
  },
  setSourceLang: (v) => {
    set({ sourceLang: v });
    persist(KEYS.sourceLang, v);
  },
  setTargetLang: (v) => {
    set({ targetLang: v });
    persist(KEYS.targetLang, v);
  },
  setTermInjection: (v) => {
    set({ termInjection: v });
    persist(KEYS.termInjection, v);
  },
  setSentenceAlign: (v) => {
    set({ sentenceAlign: v });
    persist(KEYS.sentenceAlign, v);
  },
  setLocalCache: (v) => {
    set({ localCache: v });
    persist(KEYS.localCache, v);
  },
}));

/**
 * lib/ai.ts —— AI 服务前端封装（Prompt 4 底座）
 *
 * - API Key 只存 Rust 端系统凭据管理器（keyring），前端不落盘
 * - 模型配置 / Key 状态查询、保存、测试连接、chat 补全
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ModelConfig {
  id: string;
  label: string;
  provider: "deepseek" | "kimi" | "kimi-code";
  apiModel: string;
  baseUrl: string;
  contextWindow: number;
  maxOutputTokens?: number;
  temperature?: number;
  priceInput: number;
  priceOutput: number;
}

export interface ProviderKeyStatus {
  provider: string;
  configured: boolean;
}

export interface AiConfig {
  models: ModelConfig[];
  defaultModel: string;
  keys: ProviderKeyStatus[];
}

export interface ChatResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 获取模型列表 + Key 配置状态（不含 Key 本身） */
export const getAiConfig = (): Promise<AiConfig> => invoke<AiConfig>("get_ai_config");

/** 保存默认模型 */
export const saveAiConfig = (defaultModel: string): Promise<void> =>
  invoke("save_ai_config", { defaultModel });

/** 保存 API Key 到系统凭据管理器 */
export const saveApiKey = (provider: string, key: string): Promise<void> =>
  invoke("save_api_key", { provider, key });

/** 删除 API Key */
export const deleteApiKey = (provider: string): Promise<void> =>
  invoke("delete_api_key", { provider });

/** 测试连接（GET /models） */
export const testConnection = (provider: string): Promise<string> =>
  invoke<string>("test_connection", { provider });

/** 非流式 chat 补全 */
export const chatCompletion = (
  prompt: string,
  opts?: { system?: string; modelId?: string },
): Promise<ChatResult> =>
  invoke<ChatResult>("chat_completion", {
    prompt,
    system: opts?.system ?? null,
    modelId: opts?.modelId ?? "deepseek-v4-flash",
    stream: false,
  });

/** 流式 chat 补全：订阅 ai-chunk 事件逐段收到文本增量 */
export const streamChat = async (
  prompt: string,
  onChunk: (delta: string) => void,
  opts?: { system?: string; modelId?: string },
): Promise<{ cancel: () => void }> => {
  const unlisten = await listen<string>("ai-chunk", (e) => onChunk(e.payload));
  // 触发流式请求（不 await 完成，事件驱动）
  invoke<ChatResult>("chat_completion", {
    prompt,
    system: opts?.system ?? null,
    modelId: opts?.modelId ?? "deepseek-v4-flash",
    stream: true,
  }).catch((e) => onChunk(`\n[错误] ${e}`));
  return {
    cancel: () => {
      unlisten();
    },
  };
};

export type { UnlistenFn };

// ========== 论文翻译（Prompt 4） ==========

export interface TranslateProgress {
  done: number;
  total: number;
  message: string;
}

export interface TranslateResult {
  translations: Record<string, string>;
  modelId: string;
  targetLang: string;
  totalElements: number;
  translatedCount: number;
  estimatedCostUsd: number;
  /** 实际输入 tokens（模型 usage 汇总） */
  promptTokens?: number;
  /** 命中前缀缓存的 tokens（DeepSeek 计费便宜约 10 倍） */
  cacheHitTokens?: number;
}

/** 翻译整篇论文（Rust 端自动分段/缓存/进度） */
export const translatePaper = (
  pdfPath: string,
  targetLang: string,
  modelId: string,
): Promise<TranslateResult> =>
  invoke<TranslateResult>("translate_paper", { pdfPath, targetLang, modelId });

/** 订阅翻译进度事件 */
export const onTranslateProgress = (cb: (p: TranslateProgress) => void): Promise<UnlistenFn> =>
  listen<TranslateProgress>("translate-progress", (event) => cb(event.payload));

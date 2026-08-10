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

/** 流式 chat 补全：订阅 ai-chunk 事件逐段收到文本增量；done 在流结束后 resolve */
export const streamChat = async (
  prompt: string,
  onChunk: (delta: string) => void,
  opts?: { system?: string; modelId?: string },
): Promise<{ cancel: () => void; done: Promise<void> }> => {
  // cancel 后不再向回调投递任何增量/错误（原实现仅 unlisten，迟到的 chunk 仍会回调）
  let cancelled = false;
  let unlistenCalled = false;
  const emit = (delta: string) => {
    if (!cancelled) onChunk(delta);
  };
  const unlisten = await listen<string>("ai-chunk", (e) => emit(e.payload));
  const cleanup = () => {
    if (!unlistenCalled) {
      unlistenCalled = true;
      unlisten();
    }
  };
  // invoke 的 Promise 在 Rust 端整段流式完成后 resolve（等价于「流结束」信号）
  const done = invoke<ChatResult>("chat_completion", {
    prompt,
    system: opts?.system ?? null,
    modelId: opts?.modelId ?? "deepseek-v4-flash",
    stream: true,
  })
    .catch((e) => emit(`\n[错误] ${e}`))
    .then(cleanup);
  return {
    cancel: () => {
      cancelled = true;
      cleanup();
    },
    done,
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

/** 翻译 AI 重排后的 Markdown 文档 */
export interface RestructuredTranslationResult {
  markdown: string;
  modelId: string;
  targetLang: string;
  promptTokens: number;
  estimatedCostUsd: number;
}

export const translateRestructuredDoc = (
  pdfPath: string,
  targetLang: string,
  modelId: string,
): Promise<RestructuredTranslationResult> =>
  invoke<RestructuredTranslationResult>("translate_restructured_doc", { pdfPath, targetLang, modelId });

// ========== AI 重排（Prompt 4 §9-14，Phase 1） ==========

export interface RestructureProgress {
  stage: string; // prepare | calling | done
  percent: number;
  message: string;
}

export interface RestructuredDoc {
  markdown: string;
  figureCount: number;
  promptTokens: number;
  estimatedCostUsd: number;
  generatedAt: string;
}

/** 读取 AI 重排产物（不存在返回 NOT_FOUND 错误） */
export const getRestructuredDoc = (pdfPath: string): Promise<string> =>
  invoke<string>("get_restructured_doc", { pdfPath });

/** 执行 AI 重排（force=true 强制重新生成） */
export const aiRestructure = (pdfPath: string, force?: boolean): Promise<RestructuredDoc> =>
  invoke<RestructuredDoc>("ai_restructure", { pdfPath, force: force ?? false });

/** 订阅 AI 重排进度事件 */
export const onRestructureProgress = (cb: (p: RestructureProgress) => void): Promise<UnlistenFn> =>
  listen<RestructureProgress>("restructure-progress", (event) => cb(event.payload));

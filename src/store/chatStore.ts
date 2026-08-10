/**
 * store/chatStore.ts —— AI 聊天侧边栏状态（Prompt 4 §7）
 *
 * - 消息列表（user / assistant）+ 流式输出状态
 * - 对话历史以「多轮压缩」形式拼进单条 prompt（后端 chat_completion 只收单 prompt）
 * - 流式：复用 streamChat（Rust SSE → ai-chunk 事件逐段回调；done 在流结束后 resolve）
 * - 模型：跟随主界面当前选中的模型（useAppStore.model）
 */
import { create } from "zustand";
import { streamChat } from "../lib/ai";
import { useAppStore } from "./appStore";

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 是否正在流式生成 */
  streaming?: boolean;
}

interface ChatState {
  messages: ChatMsg[];
  streaming: boolean;
  /** 发送一条消息（可选注入论文上下文） */
  ask: (input: string, opts?: { context?: string; system?: string }) => Promise<void>;
  /** 停止当前流式生成 */
  stop: () => void;
  /** 清空对话 */
  reset: () => void;
}

let msgId = 0;
const nextId = () => `chat-${Date.now()}-${msgId++}`;

let currentCancel: (() => void) | null = null;

/** 对话历史压缩：保留最近 8 条，控制 token 占用 */
function buildPrompt(messages: ChatMsg[], input: string, context?: string): string {
  const parts: string[] = [];
  if (context) {
    parts.push(`【论文上下文】\n${context.slice(0, 4000)}`);
  }
  const recent = messages.slice(-8);
  for (const m of recent) {
    parts.push(`${m.role === "user" ? "用户" : "助手"}：${m.content}`);
  }
  parts.push(`用户：${input}`);
  return parts.join("\n\n");
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: false,

  ask: async (input, opts) => {
    const text = input.trim();
    if (!text || get().streaming) return;

    const prevMessages = get().messages; // 快照（不含本条），避免 prompt 里重复拼接
    const userMsg: ChatMsg = { id: nextId(), role: "user", content: text };
    const assistantId = nextId();
    set({
      messages: [...prevMessages, userMsg, { id: assistantId, role: "assistant", content: "", streaming: true }],
      streaming: true,
    });

    const prompt = buildPrompt(prevMessages, text, opts?.context);
    const system =
      opts?.system ??
      "你是一位学术论文阅读助手（PaperReader）。回答准确、专业、简洁，优先引用论文上下文；" +
        "涉及公式用 LaTeX 表示；不要编造论文中不存在的内容。";
    const modelId = useAppStore.getState().model;

    const onChunk = (delta: string) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + delta } : m,
        ),
      }));
    };

    // 收尾：把半截内容保留为普通消息（幂等，取消与 done 都可能触发）
    let finished = false;
    const completeOnce = () => {
      if (finished) return;
      finished = true;
      set((s) => ({
        streaming: false,
        messages: s.messages.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
      }));
      currentCancel = null;
    };

    const handle = await streamChat(prompt, onChunk, { system, modelId });
    currentCancel = () => {
      handle.cancel();
      completeOnce();
    };
    handle.done.then(completeOnce).catch(completeOnce);
  },

  stop: () => {
    currentCancel?.();
    currentCancel = null;
  },

  reset: () => {
    currentCancel?.();
    currentCancel = null;
    set({ messages: [], streaming: false });
  },
}));

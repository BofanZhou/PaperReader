/**
 * components/chat/ChatSidebar.tsx —— AI 聊天侧边栏（Prompt 4 §7）
 *
 * - 消息列表（用户 / 助手），助手消息流式输出
 * - 快捷操作：总结全文 / 分析方法 / 证据回顾（注入论文上下文）
 * - 输入框：Enter 发送、Shift+Enter 换行；流式中可停止
 * - 选中文本「AI 讨论」会跳转到本标签并自动注入
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Send, Square, Sparkles } from "lucide-react";
import { useChatStore } from "../../store/chatStore";
import { useAppStore } from "../../store/appStore";

/** 从解析结果抽取论文正文摘要（前若干字符），作为问答上下文 */
function buildPaperContext(maxLen = 4000): string {
  const result = useAppStore.getState().parsedResult;
  if (!result) return "";
  const parts: string[] = [];
  if (result.title) parts.push(`标题：${result.title}`);
  if (result.author) parts.push(`作者：${result.author}`);
  let len = parts.join("\n").length;
  outer: for (const page of result.pages) {
    const sorted = [...page.elements].sort((a, b) => a.readingOrder - b.readingOrder);
    for (const el of sorted) {
      const t = el.text.trim();
      if (!t) continue;
      if (parts.length > 1 && len + t.length > maxLen) break outer;
      if (el.type === "heading" || el.type === "paragraph" || el.type === "caption") {
        parts.push(t);
        len += t.length;
      }
    }
  }
  return parts.join("\n");
}

const QUICK_ACTIONS: { label: string; prompt: string }[] = [
  { label: "总结全文", prompt: "请总结这篇论文的核心内容、主要贡献与结论，分条列出。" },
  { label: "分析方法", prompt: "请分析这篇论文使用的研究方法、实验设计与数据来源。" },
  { label: "证据回顾", prompt: "请回顾论文中的关键证据、数据结论与图表要点。" },
];

export function ChatSidebar() {
  const { messages, streaming, ask, stop, reset } = useChatStore();
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  // 新消息/流式增量 → 自动滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || streaming) return;
    setInput("");
    void ask(t, { context: buildPaperContext() });
  };

  const runQuick = (prompt: string) => {
    if (streaming) return;
    void ask(prompt, { context: buildPaperContext() });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：标题 + 清空 */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-3.5 text-accent" /> AI 解答
        </span>
        <button
          type="button"
          onClick={reset}
          disabled={messages.length === 0}
          title="清空对话"
          className="rounded p-1 text-fg-tertiary transition-colors hover:bg-accent/20 hover:text-fg disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>

      {/* 消息列表 */}
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="flex flex-col gap-1.5 pt-2 text-center">
            <p className="text-xs text-fg-tertiary">选中论文文本后点「AI 讨论」，或使用快捷操作。</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => runQuick(q.prompt)}
                  disabled={streaming}
                  className="rounded-lg border border-border bg-bg-secondary/60 px-3 py-2 text-xs text-fg-secondary transition-colors hover:border-accent/50 hover:text-fg disabled:opacity-40"
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-accent px-3 py-2 text-xs leading-relaxed text-fg-inverse">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[95%] whitespace-pre-wrap rounded-xl rounded-bl-sm border border-border bg-bg-secondary px-3 py-2 text-xs leading-relaxed text-fg">
                {m.content || (m.streaming ? "…" : "")}
                {m.streaming && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
              </div>
            </div>
          ),
        )}
      </div>

      {/* 输入区 */}
      <div className="border-t border-border p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
            placeholder="与 AI 讨论论文…（Enter 发送）"
            className="max-h-32 min-h-[52px] flex-1 resize-none rounded-lg border border-border bg-bg-secondary/60 px-2.5 py-1.5 text-xs leading-relaxed text-fg outline-none placeholder:text-fg-tertiary focus:border-accent/60"
          />
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              title="停止生成"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-error/40 text-error transition-colors hover:bg-error/10"
            >
              <Square className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => send(input)}
              disabled={!input.trim()}
              title="发送"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-fg-inverse transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {streaming ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            </button>
          )}
        </div>
        <p className="mt-1 text-center text-[10px] text-fg-tertiary">模型跟随顶部选择 · 流式输出</p>
      </div>
    </div>
  );
}

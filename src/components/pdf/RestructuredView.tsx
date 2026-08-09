/**
 * components/pdf/RestructuredView.tsx —— AI 重排视图（Phase 1）
 *
 * 状态机：
 * - **未生成**：显示 ODL 解析内容（流式排版，复用 PDFViewer），顶部「AI 重排」按钮
 * - **生成中**：进度条 + 仍展示 ODL 内容（不让用户失去阅读上下文）
 * - **已生成**：切换为 Markdown 渲染（react-markdown + `[图N]` 映射 + 「重新生成」）
 * - **生成失败**：保留 ODL 展示 + 错误提示 + 重试按钮
 *
 * 图片兜底：`onError` 渲染 alt 文本（避免 broken icon 占用版面）。
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { PDFViewer } from "./PDFViewer";
import { RestructuredMarkdown } from "./RestructuredMarkdown";
import { getRestructuredDoc } from "../../lib/ai";
import { useAppStore } from "../../store/appStore";

interface Props {
  pdfPath: string;
}

export function RestructuredView({ pdfPath }: Props) {
  const parsedResult = useAppStore((s) => s.parsedResult);
  const restructureState = useAppStore((s) => s.restructureState);
  const restructureProgress = useAppStore((s) => s.restructureProgress);
  const restructuredDoc = useAppStore((s) => s.restructuredDoc);
  const restructureError = useAppStore((s) => s.restructureError);
  const runRestructure = useAppStore((s) => s.runRestructure);

  const [loadStatus, setLoadStatus] = useState<"loading" | "missing" | "ready">("loading");
  const [localDoc, setLocalDoc] = useState<string | null>(null);

  // 挂载时先尝试读取已有重排文档
  useEffect(() => {
    let cancelled = false;
    setLoadStatus("loading");
    setLocalDoc(null);
    getRestructuredDoc(pdfPath)
      .then((md) => {
        if (cancelled) return;
        setLocalDoc(md);
        setLoadStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setLoadStatus("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [pdfPath]);

  // 文档存在性：store 里有更新结果 / 本地已加载到 / 任何为真
  const doc = restructuredDoc ?? localDoc;
  const hasDoc = doc !== null;
  const running = restructureState === "running";

  const handleGenerate = useCallback(() => {
    // force=true：磁盘残留的脏 restructured.md 不会作废新的重排
    void runRestructure(true);
  }, [runRestructure]);

  // ========== 已生成：Markdown 渲染 + 重新生成按钮 ==========
  if (hasDoc && doc) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-bg-secondary/95 px-4 py-2 backdrop-blur">
          <div className="flex items-center gap-2 text-xs text-fg-tertiary">
            <Sparkles className="size-3.5" />
            <span>AI 重排</span>
          </div>
          <Button variant="ghost" size="sm" onClick={handleGenerate} disabled={running}>
            <RefreshCw /> 重新生成
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">
          <RestructuredMarkdown markdown={doc} parsedResult={parsedResult} />
        </div>
      </div>
    );
  }

  // ========== 未生成 / 加载中 / 生成中 / 失败：显示 ODL 解析内容 + 顶部 AI 重排按钮 ==========
  const banner = (
    <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-bg-secondary/95 px-4 py-2 backdrop-blur">
      <div className="flex items-center gap-2 text-xs">
        {running ? (
          <>
            <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden />
            <span className="text-fg-secondary">{restructureProgress?.message ?? "正在 AI 重排…"}</span>
          </>
        ) : loadStatus === "loading" ? (
          <span className="text-fg-tertiary">加载中…</span>
        ) : loadStatus === "ready" ? (
          <>
            <span className="text-fg-secondary">AI 重排</span>
            <span className="text-fg-tertiary">·</span>
            <span className="text-fg-tertiary">已生成</span>
          </>
        ) : (
          <>
            <span className="text-fg-secondary">ODL 解析结果</span>
            <span className="text-fg-tertiary">·</span>
            <span className="text-fg-tertiary">未重排</span>
          </>
        )}
      </div>
      <Button size="sm" onClick={handleGenerate} disabled={running}>
        {running ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {running ? "重排中" : loadStatus === "ready" ? "重新生成" : "AI 重排"}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {banner}
      {running && restructureProgress && (
        <div className="px-4 py-1">
          <Progress value={restructureProgress.percent} />
        </div>
      )}
      {restructureError && (
        <div className="mx-4 mt-2 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          AI 重排失败：{restructureError}
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {parsedResult ? (
          // 复用 PDFViewer 渲染 ODL 流式内容（mode="translated" + 空 translations → 显示原文）
          <PDFViewer result={parsedResult} mode="translated" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-fg-tertiary">
            解析结果未就绪
          </div>
        )}
      </div>
    </div>
  );
}

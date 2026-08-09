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
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { PDFViewer } from "./PDFViewer";
import { PaperImage } from "./PaperImage";
import { getRestructuredDoc } from "../../lib/ai";
import { useAppStore } from "../../store/appStore";
import type { ParsedResult } from "../../lib/env";

interface Props {
  pdfPath: string;
}

/** 自定义 rehype-sanitize schema：允许 [图N] 占位符使用的 fig:// 协议 */
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), "fig"],
  },
};

/** 从解析结果提取图序 imageSrc 列表（严格按 readingOrder 出现的 figure） */
function collectFigureSrcs(result: ParsedResult | null): string[] {
  if (!result) return [];
  const srcs: string[] = [];
  for (const page of result.pages) {
    const sorted = [...page.elements].sort((a, b) => a.readingOrder - b.readingOrder);
    for (const el of sorted) {
      if (el.type === "figure" && el.imageSrc) {
        srcs.push(el.imageSrc);
      }
    }
  }
  return srcs;
}

/**
 * 论文图片（共用 PaperImage：base64 IPC 加载，绕开 asset 协议 403）。
 * 包装为 figure + figcaption。
 */
function FigureImage({ path, alt }: { path: string; alt: string }) {
  return (
    <figure className="my-3">
      <PaperImage path={path} alt={alt} maxHeight={420} />
      <figcaption className="mt-1 text-center text-xs text-fg-tertiary">{alt}</figcaption>
    </figure>
  );
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
  const figures = useMemo(() => collectFigureSrcs(parsedResult), [parsedResult]);

  const handleGenerate = useCallback(() => {
    // force=true：磁盘残留的脏 restructured.md 不会作废新的重排
    void runRestructure(true);
  }, [runRestructure]);

  // [图N] → fig://N 占位（react-markdown 按 image 处理）
  const preparedMarkdown = useMemo(() => {
    if (!doc) return "";
    return doc.replace(/\[图(\d+)\]/g, "![图$1](fig://$1)");
  }, [doc]);

  // ========== 已生成：Markdown 渲染 + 重新生成按钮 ==========
  if (hasDoc && doc) {
    return (
      <div className="h-full overflow-y-auto bg-bg-primary">
        <div className="mx-auto max-w-3xl px-6 py-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-fg-tertiary">
              <Sparkles className="size-3.5" />
              <span>AI 重排 · {figures.length > 0 ? `${figures.length} 张图` : "无图"}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={handleGenerate} disabled={running}>
              <RefreshCw /> 重新生成
            </Button>
          </div>
          <article className="prose-sm max-w-none text-sm leading-relaxed text-fg [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_p]:my-2 [&_li]:my-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-bg-tertiary [&_pre]:p-3 [&_code]:text-xs">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
              components={{
                img: ({ src, alt }) => {
                  const m = /^fig:\/\/(\d+)$/.exec(src ?? "");
                  if (m) {
                    const idx = parseInt(m[1], 10) - 1;
                    const imgSrc = figures[idx];
                    if (imgSrc) {
                      // base64 IPC 加载（asset 协议在 Windows 上对反斜杠 URL 匹配不稳）
                      return <FigureImage path={imgSrc} alt={alt ?? `图${m[1]}`} />;
                    }
                    return (
                      <figure className="my-3 rounded-md border border-dashed border-border bg-bg-secondary/50 p-6 text-center text-xs text-fg-tertiary">
                        {alt ?? `图${m[1]}`}（未找到对应图片）
                      </figure>
                    );
                  }
                  return <img src={src} alt={alt ?? ""} className="mx-auto max-h-[420px] rounded-md border border-border" />;
                },
              }}
            >
              {preparedMarkdown}
            </ReactMarkdown>
          </article>
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
            <span className="text-fg-tertiary">{figures.length > 0 ? `${figures.length} 张图` : "无图"}</span>
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

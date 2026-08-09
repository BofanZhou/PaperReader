import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "../../store/appStore";
import { getLastParseLog } from "../../lib/env";
import { chatCompletion } from "../../lib/ai";
import { cn } from "../../lib/utils";
import { PDFViewer } from "../pdf/PDFViewer";
import { PDFOriginalView } from "../pdf/PDFOriginalView";
import { RestructuredView } from "../pdf/RestructuredView";
import { RestructuredMarkdown } from "../pdf/RestructuredMarkdown";
import { SelectionPopup } from "../pdf/SelectionPopup";
import type {
  ContextMenuAction,
  Highlight,
  HighlightColorId,
  SelectionState,
  TargetLang,
} from "../../types/pdf";

const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 360;

interface Props {
  onOpenFile: () => void;
}

/** 将 Rust 端错误码转为可读的引导提示 */
function friendlyParseError(err: string): { title: string; desc: string } {
  if (err.includes("ENV:OPENDATALOADER_NOT_READY"))
    return { title: "解析引擎未就绪", desc: "请点击右上角设置 → 环境管理，安装 OpenDataLoader 后再试" };
  if (err.includes("ENV:PYTHON_NOT_READY"))
    return { title: "Python 未安装", desc: "请先安装 Python 运行环境" };
  if (err.includes("ERR:SCANNED_PDF"))
    return { title: "PDF 疑似扫描版", desc: "当前 PDF 没有文本层，建议启用混合（hybrid）解析模式" };
  if (err.includes("ERR:TIMEOUT"))
    return { title: "解析超时", desc: "文件较大或过于复杂，建议分段解析" };
  if (err.includes("ENV:PDF_NOT_FOUND"))
    return { title: "文件不存在", desc: "请重新选择 PDF 文件" };
  return { title: "解析失败", desc: err.replace(/^ERR:PARSE_FAILED:/, "") || err };
}

/** 主体工作区：左侧 PDF 阅读区 + 右侧可拖拽侧边栏 */
export function Workspace({ onOpenFile }: Props) {
  const {
    currentFile,
    parseState,
    parseProgress,
    parsedResult,
    parseError,
    runParse,
    viewMode,
    translations,
    translateState,
    translateProgress,
    translateError,
    restructuredTranslation,
  } = useAppStore();
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const dragging = useRef(false);

  // 说明：解析由 store.setCurrentFile 统一触发（含竞态防护与状态清空），
  // 这里不再重复监听 currentFile 调 runParse，避免同一文件被解析两次。

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const rect = document.getElementById("workspace")?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, rect.right - ev.clientX));
      setSidebarWidth(width);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div id="workspace" className="flex flex-1 overflow-hidden">
      {/* PDF 阅读区 */}
      <div className="pdf-area flex-1 overflow-hidden">
        {!currentFile ? (
          <EmptyHome onOpenFile={onOpenFile} />
        ) : parseState === "parsing" ? (
          <ParsingView fileName={fileName(currentFile)} progress={parseProgress} />
        ) : parseState === "error" ? (
          <ErrorView fileName={fileName(currentFile)} error={parseError} onRetry={() => runParse().catch(() => {})} onOpenFile={onOpenFile} />
        ) : parsedResult ? (
          <ReaderView
            result={parsedResult}
            viewMode={viewMode}
            translations={translations}
            translateState={translateState}
            translateProgress={translateProgress}
            translateError={translateError}
            restructuredTranslation={restructuredTranslation}
          />
        ) : (
          <EmptyHome onOpenFile={onOpenFile} />
        )}
      </div>

      {/* 拖拽分隔条 */}
      <div
        className="w-1 shrink-0 cursor-col-resize border-x border-border bg-bg-tertiary/50 transition-colors hover:bg-accent/40"
        onMouseDown={onDragStart}
        title="拖拽调整侧边栏宽度"
        aria-label="调整侧边栏宽度"
        role="separator"
        tabIndex={0}
      />

      {/* 侧边栏 */}
      <div
        className="shrink-0 border-l border-border bg-bg-secondary"
        style={{ width: sidebarWidth }}
      >
        <Sidebar />
      </div>
    </div>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 未打开文件时的首页 */
function EmptyHome({ onOpenFile }: { onOpenFile: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-accent-subtle">
        <BookOpen className="size-8 text-accent" aria-hidden />
      </div>
      <div className="text-center">
        <p className="text-base font-medium">打开 PDF 开始阅读</p>
        <p className="mt-1 text-sm text-fg-tertiary">支持原文 / 译文 / 对照三种阅读模式</p>
      </div>
      <Button onClick={onOpenFile}>
        <FolderOpen aria-hidden /> 打开文件
      </Button>
    </div>
  );
}

/** 解析中 */
function ParsingView({ fileName, progress }: { fileName: string; progress: { percent: number; message: string } | null }) {
  return (
    <div data-testid="parsing-progress" className="flex h-full flex-col items-center justify-center gap-5 p-8">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="size-5 animate-spin text-accent" aria-hidden />
        正在解析 {fileName}
      </div>
      {progress ? (
        <div className="w-full max-w-sm space-y-2">
          <Progress value={progress.percent} />
          <p className="text-center text-xs text-fg-secondary">{progress.message}</p>
        </div>
      ) : (
        <p className="text-xs text-fg-tertiary">首次解析需启动引擎，约需数秒…</p>
      )}
      <p className="text-xs text-fg-tertiary">解析结果将自动缓存，再次打开同一 PDF 秒开</p>
    </div>
  );
}

/** 解析错误 + 引导 */
function ErrorView({ fileName, error, onRetry, onOpenFile }: { fileName: string; error: string | null; onRetry: () => void; onOpenFile: () => void }) {
  const info = friendlyParseError(error ?? "");
  const lines = info.desc.split("\n");
  const headline = lines[0] ?? "";
  const rest = lines.slice(1).join("\n");

  const handleOpenLog = async () => {
    try {
      const path = await getLastParseLog();
      await openPath(path);
    } catch (e) {
      // 如果获取/打开失败，降级打开日志目录
      const { appDataDir } = await import("@tauri-apps/api/path");
      const dir = await appDataDir();
      await openPath(`${dir}/logs`).catch(() => {});
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <AlertTriangle className="size-12 text-error" aria-hidden />
      <div className="text-center">
        <p className="text-sm font-medium">{fileName}</p>
        <p className="mt-2 text-base font-medium">{info.title}</p>
        <p className="mt-1 max-w-2xl text-left text-sm font-medium text-fg">{headline}</p>
      </div>
      {rest && (
        <div className="max-h-[40vh] w-full max-w-2xl overflow-auto rounded-lg border border-border bg-bg-secondary p-3">
          <pre className="whitespace-pre-wrap text-left text-xs text-fg-secondary">{rest}</pre>
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden /> 重试
        </Button>
        <Button variant="outline" size="sm" onClick={handleOpenLog}>
          <FileText aria-hidden /> 查看详细日志
        </Button>
        <Button size="sm" onClick={onOpenFile}>
          <FolderOpen aria-hidden /> 更换文件
        </Button>
      </div>
    </div>
  );
}

/** 阅读视图（Prompt 3/4）：纯 DOM 文字阅读 + 图表原位置 + 选中即翻译浮动弹窗 */
function ReaderView({
  result,
  viewMode,
  translations,
  translateState,
  translateProgress,
  translateError,
  restructuredTranslation,
}: {
  result: import("../../lib/env").ParsedResult;
  viewMode: "pdf-original" | "restructured" | "translated" | "bilingual";
  translations: Record<string, string> | null;
  translateState: "idle" | "translating" | "error" | "success";
  translateProgress: import("../../lib/ai").TranslateProgress | null;
  translateError: string | null;
  restructuredTranslation: string | null;
}) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [activeColor, setActiveColor] = useState<HighlightColorId>("insight");
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [translation, setTranslation] = useState<{ target: TargetLang; text: string } | null>(null);
  const [translating, setTranslating] = useState(false);
  // 原图视图：解析副本 original.pdf 路径（pdfjs 渲染用）
  const [originalPdfPath, setOriginalPdfPath] = useState<string | null>(null);
  // 对照模式左栏 source（原图 或 AI 重排）
  const [leftSource, setLeftSource] = useState<"pdf-original" | "restructured">("pdf-original");

  // 原图视图下获取 papers/{uuid}/original.pdf（源文件可能已移动，副本始终存在）
  useEffect(() => {
    if (viewMode !== "pdf-original" && !(viewMode === "bilingual" && leftSource === "pdf-original")) return;
    let cancelled = false;
    const file = useAppStore.getState().currentFile;
    if (!file) return;
    setOriginalPdfPath(null);
    invoke<string>("get_paper_pdf_path", { pdfPath: file })
      .then((p) => {
        if (!cancelled) setOriginalPdfPath(p);
      })
      .catch(() => {
        if (!cancelled) setOriginalPdfPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [viewMode, leftSource]);

  // 阅读区边界（弹窗不覆盖侧边栏）
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => setContainerRect(el.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleSelectText = useCallback((sel: SelectionState) => {
    setSelection(sel);
    setTranslation(null);
  }, []);

  const { model } = useAppStore();

  // 选中即翻译（单段，真实调用；整篇翻译走顶部按钮）
  const handleTranslate = useCallback(async (text: string, lang: TargetLang) => {
    setTranslating(true);
    try {
      const langName = { zh: "中文", en: "英文", ja: "日文" }[lang];
      const res = await chatCompletion(
        `把以下论文文本翻译为${langName}，只输出译文，不要解释：\n\n${text}`,
        {
          system: "你是一位专业的学术论文翻译专家。译文忠实原文、术语准确、保留学术语气。",
          // 用用户当前选择的模型（不再硬编码 deepseek-v4-flash）
          modelId: model,
        },
      );
      setTranslation({ target: lang, text: res.text });
    } catch (e) {
      setTranslation({ target: lang, text: `翻译失败：${e}` });
    } finally {
      setTranslating(false);
    }
  }, [model]);

  const handleHighlight = useCallback(
    (colorId: HighlightColorId) => {
      if (!selection?.elementId) return;
      const h: Highlight = {
        id: typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `hl-${Date.now()}`,
        elementId: selection.elementId,
        colorId,
        range: selection.range ?? undefined,
        createdAt: Date.now(),
      };
      setHighlights((prev) => [...prev, h]);
      setSelection(null);
    },
    [selection],
  );

  const handleNote = useCallback((text: string) => {
    // Prompt 6 接入完整笔记系统；当前先保留选中态
    console.info("[note] 选中文本已保留，笔记系统将在 Prompt 6 接入:", text.slice(0, 50));
  }, []);

  const handleAiDiscuss = useCallback((text: string) => {
    // Prompt 4 接入聊天侧边栏
    console.info("[ai-discuss] 将选中文本注入聊天（Prompt 4）:", text.slice(0, 50));
  }, []);

  const handleExplainFormula = useCallback((text: string) => {
    console.info("[formula] 公式解释（Prompt 4）:", text.slice(0, 50));
  }, []);

  const handleContextMenuAction = useCallback(
    (action: ContextMenuAction) => {
      switch (action.kind) {
        case "highlight":
          setHighlights((prev) => [
            ...prev,
            {
              id: crypto.randomUUID?.() ?? `hl-${Date.now()}`,
              elementId: action.elementId,
              colorId: activeColor,
              createdAt: Date.now(),
            },
          ]);
          break;
        case "copy-original":
          navigator.clipboard.writeText(action.text).catch(() => {});
          break;
        case "copy-translated":
          navigator.clipboard.writeText(action.text).catch(() => {});
          break;
        case "note":
          handleNote(action.text);
          break;
        case "ai-discuss":
          handleAiDiscuss(action.text);
          break;
      }
    },
    [activeColor, handleNote, handleAiDiscuss],
  );

  return (
    <div ref={areaRef} className="relative h-full overflow-hidden">
      {/* 译文/对照模式但尚未翻译 → 顶部提示条（原图/原文视图不显示） */}
      {(viewMode === "translated" || viewMode === "bilingual") && translateState === "idle" && !translations && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-accent-subtle px-4 py-1.5 text-xs text-accent">
          <span>尚未翻译全文，点击顶部「⚡ 翻译」按钮生成整篇译文</span>
        </div>
      )}
      {(viewMode === "translated" || viewMode === "bilingual") && translateState === "translating" && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-accent-subtle px-4 py-1.5 text-xs text-accent">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          <span>{translateProgress?.message ?? "正在翻译…"}</span>
        </div>
      )}
      {(viewMode === "translated" || viewMode === "bilingual") && translateState === "error" && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-error/10 px-4 py-1.5 text-xs text-error">
          <AlertTriangle className="size-3.5" aria-hidden />
          <span className="max-w-[80%] truncate">翻译失败：{translateError ?? "未知错误"}</span>
        </div>
      )}
      {(viewMode === "translated" || viewMode === "bilingual") && translateState === "success" && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-success/10 px-4 py-1.5 text-xs text-success">
          <CheckCircle2 className="size-3.5" aria-hidden />
          <span>{translateProgress?.message ?? "翻译完成"}</span>
        </div>
      )}

      {viewMode === "pdf-original" ? (
        originalPdfPath ? (
          <PDFOriginalView
            pdfPath={originalPdfPath}
            onSelectText={handleSelectText}
            onContextMenuAction={handleContextMenuAction}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-fg-tertiary">
            正在获取原图…
          </div>
        )
      ) : viewMode === "restructured" ? (
        <RestructuredView pdfPath={useAppStore.getState().currentFile ?? ""} />
      ) : viewMode === "translated" ? (
        restructuredTranslation ? (
          <RestructuredMarkdown markdown={restructuredTranslation} parsedResult={result} />
        ) : (
          <PDFViewer
            result={result}
            mode="translated"
            translations={translations ?? undefined}
            highlights={highlights}
            onSelectText={handleSelectText}
            onContextMenuAction={handleContextMenuAction}
          />
        )
      ) : viewMode === "bilingual" ? (
        <div className="flex h-full">
          {/* 左栏：原图 或 AI 重排（toggle） */}
          <div className="relative flex-1 border-r border-border">
            {leftSource === "pdf-original" ? (
              originalPdfPath ? (
                <PDFOriginalView
                  pdfPath={originalPdfPath}
                  onSelectText={handleSelectText}
                  onContextMenuAction={handleContextMenuAction}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-fg-tertiary">正在获取原图…</div>
              )
            ) : (
              <RestructuredView pdfPath={useAppStore.getState().currentFile ?? ""} />
            )}
            {/* 左栏 source 切换（绝对定位浮在顶部） */}
            <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-border bg-bg-secondary/95 px-1 py-0.5 text-xs shadow-sm backdrop-blur">
              <button
                onClick={() => setLeftSource("pdf-original")}
                className={cn(
                  "rounded-full px-2.5 py-0.5 transition-colors",
                  leftSource === "pdf-original" ? "bg-accent text-fg-inverse" : "text-fg-secondary hover:text-fg",
                )}
              >
                原图
              </button>
              <button
                onClick={() => setLeftSource("restructured")}
                className={cn(
                  "rounded-full px-2.5 py-0.5 transition-colors",
                  leftSource === "restructured" ? "bg-accent text-fg-inverse" : "text-fg-secondary hover:text-fg",
                )}
              >
                AI 重排
              </button>
            </div>
          </div>
          {/* 右栏：译文（优先展示 AI 重排文档的译文） */}
          <div className="flex-1">
            {restructuredTranslation ? (
              <RestructuredMarkdown markdown={restructuredTranslation} parsedResult={result} />
            ) : (
              <PDFViewer
                result={result}
                mode="translated"
                translations={translations ?? undefined}
                highlights={highlights}
                onSelectText={handleSelectText}
                onContextMenuAction={handleContextMenuAction}
              />
            )}
          </div>
        </div>
      ) : (
        <PDFViewer
          result={result}
          mode="translated"
          translations={translations ?? undefined}
          highlights={highlights}
          onSelectText={handleSelectText}
          onContextMenuAction={handleContextMenuAction}
        />
      )}

      {selection && (
        <SelectionPopup
          selection={selection}
          containerRect={containerRect}
          activeColor={activeColor}
          translation={translation}
          translating={translating}
          onTranslate={handleTranslate}
          onHighlight={(c) => {
            setActiveColor(c);
            handleHighlight(c);
          }}
          onNote={handleNote}
          onAiDiscuss={handleAiDiscuss}
          onExplainFormula={handleExplainFormula}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}

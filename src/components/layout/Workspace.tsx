import { useCallback, useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  BookOpen,
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
import { PDFViewer } from "../pdf/PDFViewer";
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
  const { currentFile, parseState, parseProgress, parsedResult, parseError, runParse, viewMode } =
    useAppStore();
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const dragging = useRef(false);
  const parsedFileRef = useRef<string | null>(null);

  // currentFile 变化 → 自动解析
  useEffect(() => {
    if (currentFile && parsedFileRef.current !== currentFile) {
      parsedFileRef.current = currentFile;
      runParse().catch(() => {
        /* 错误已写入 store */
      });
    }
  }, [currentFile, runParse]);

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
        ) : parsedResult && currentFile ? (
          <ReaderView result={parsedResult} pdfPath={currentFile} viewMode={viewMode} />
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
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8">
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

/** 阅读视图（Prompt 3）：PDF.js 渲染 + 选中即翻译浮动弹窗 */
function ReaderView({
  result,
  pdfPath,
  viewMode,
}: {
  result: import("../../lib/env").ParsedResult;
  pdfPath: string;
  viewMode: "original" | "translated" | "bilingual";
}) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [activeColor, setActiveColor] = useState<HighlightColorId>("yellow");
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [translation, setTranslation] = useState<{ target: TargetLang; text: string } | null>(null);
  const [translating, setTranslating] = useState(false);

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

  // 翻译 stub：Prompt 4 接入真实翻译引擎前，先返回占位（保留完整交互链路）
  const handleTranslate = useCallback(async (text: string, lang: TargetLang) => {
    setTranslating(true);
    try {
      await new Promise((r) => setTimeout(r, 500));
      setTranslation({
        target: lang,
        text: `【译文待接入 · Prompt 4 翻译引擎】\n${text}`,
      });
    } finally {
      setTranslating(false);
    }
  }, []);

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
      <PDFViewer
        pdfUrl={pdfPath}
        result={result}
        mode={viewMode}
        highlights={highlights}
        onSelectText={handleSelectText}
        onContextMenuAction={handleContextMenuAction}
      />

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

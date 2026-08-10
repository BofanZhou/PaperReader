import {
  BookOpen,
  FileDown,
  FolderOpen,
  Loader2,
  Moon,
  Settings,
  Sun,
  Zap,
} from "lucide-react";
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { useAppStore, type ViewMode } from "../../store/appStore";
import type { Theme } from "../../hooks/useTheme";
import { exportTranslatedPdf } from "../../lib/exportPdf";
import { SettingsDialog } from "../settings/SettingsDialog";

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: "pdf-original", label: "原图" },
  { id: "restructured", label: "AI 重排" },
  { id: "translated", label: "译文" },
  { id: "bilingual", label: "对照" },
];

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenFile: () => void;
}

export function TopToolbar({ theme, onToggleTheme, onOpenFile }: Props) {
  const { viewMode, setViewMode, model, setModel, models, currentFile, runTranslate, translateState } = useAppStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportLabel, setExportLabel] = useState("");
  const translating = translateState === "translating";

  // Prompt 9：导出翻译 PDF（需先解析 + 生成元素级译文）
  const handleExport = useCallback(async () => {
    const { parsedResult, translations } = useAppStore.getState();
    if (!currentFile || !parsedResult || !translations || Object.keys(translations).length === 0) {
      window.alert("请先解析论文并生成翻译（工具栏「翻译」按钮），再导出翻译 PDF。");
      return;
    }
    setExporting(true);
    setExportLabel("准备…");
    try {
      const originalPdfPath = await invoke<string>("get_paper_pdf_path", { pdfPath: currentFile });
      const dest = await exportTranslatedPdf({
        parsed: parsedResult,
        translations,
        originalPdfPath,
        onProgress: (done, total) => setExportLabel(`${done}/${total}`),
        onStatus: (m) => setExportLabel(m),
      });
      if (dest) window.alert(`翻译 PDF 已导出：\n${dest}`);
    } catch (e) {
      window.alert(`导出失败：${String(e)}`);
    } finally {
      setExporting(false);
      setExportLabel("");
    }
  }, [currentFile]);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg px-3">
      {/* 左侧：logo + 打开文件 */}
      <div className="flex items-center gap-1.5">
        <BookOpen className="size-5 text-accent" aria-hidden />
        <span className="mr-2 text-sm font-semibold">PaperReader</span>
        <Button variant="secondary" size="sm" onClick={onOpenFile} aria-label="打开 PDF 文件">
          <FolderOpen aria-hidden /> 打开文件
        </Button>
      </div>

      {/* 中间：视图模式切换 */}
      <div className="flex flex-1 items-center justify-center">
        <div className="inline-flex items-center rounded-lg bg-bg-tertiary p-0.5" role="tablist" aria-label="阅读视图">
          {VIEW_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={viewMode === m.id}
              onClick={() => setViewMode(m.id)}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm transition-colors",
                viewMode === m.id
                  ? "bg-bg text-fg shadow-sm"
                  : "text-fg-secondary hover:text-fg",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* 右侧：模型选择 + 翻译 + 设置 + 主题 */}
      <div className="flex items-center gap-2">
        {models.length > 0 ? (
          <Select value={model} onValueChange={(v) => setModel(v)}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label="选择翻译模型">
              <SelectValue placeholder="选择翻译模型" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div
            className="h-8 w-44 rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs text-fg-tertiary"
            title="模型列表加载中"
          >
            加载模型…
          </div>
        )}

        <Button size="sm" disabled={!currentFile || translating} onClick={() => runTranslate().catch(() => {})} aria-label="翻译当前论文">
          <Zap aria-hidden /> {translating ? "翻译中…" : "翻译"}
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={!currentFile || exporting}
              onClick={() => void handleExport()}
              aria-label="导出翻译 PDF"
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileDown aria-hidden />}
              {exporting ? (exportLabel || "导出中…") : "导出"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>导出翻译 PDF（保留图表/公式/页眉页脚，译文覆盖原文）</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label="切换明暗主题">
              {theme === "light" ? <Moon aria-hidden /> : <Sun aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>切换明暗主题</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label="设置">
              <Settings aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>设置</TooltipContent>
        </Tooltip>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}

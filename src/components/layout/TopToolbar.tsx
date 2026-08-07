import {
  BookOpen,
  FolderOpen,
  Moon,
  Settings,
  Sun,
  Zap,
} from "lucide-react";
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
import { MODELS, useAppStore, type ViewMode } from "../../store/appStore";
import type { Theme } from "../../hooks/useTheme";

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: "original", label: "原文" },
  { id: "translated", label: "译文" },
  { id: "bilingual", label: "对照" },
];

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenFile: () => void;
}

export function TopToolbar({ theme, onToggleTheme, onOpenFile }: Props) {
  const { viewMode, setViewMode, model, setModel, currentFile } = useAppStore();

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
        <Select value={model} onValueChange={(v) => setModel(v as typeof model)}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="选择翻译模型">
            <SelectValue placeholder="选择翻译模型" />
          </SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button size="sm" disabled={!currentFile} aria-label="翻译当前论文">
          <Zap aria-hidden /> 翻译
        </Button>

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
            <Button variant="ghost" size="icon" onClick={() => {}} aria-label="设置">
              <Settings aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>设置（即将上线）</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

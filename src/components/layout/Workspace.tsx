import { useCallback, useRef, useState } from "react";
import { FileText, FolderOpen, BookOpen } from "lucide-react";
import { Button } from "../ui/button";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "../../store/appStore";

const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 360;

interface Props {
  onOpenFile: () => void;
}

/** 主体工作区：左侧 PDF 阅读区 + 右侧可拖拽侧边栏 */
export function Workspace({ onOpenFile }: Props) {
  const { currentFile } = useAppStore();
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const dragging = useRef(false);

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
        {currentFile ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
            <FileText className="size-12 text-fg-tertiary" aria-hidden />
            <div className="text-center">
              <p className="text-sm font-medium">{currentFile.split(/[\\/]/).pop()}</p>
              <p className="mt-1 text-xs text-fg-tertiary">
                PDF 解析与渲染将在下一步（Prompt 2/3）接入
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={onOpenFile}>
              <FolderOpen aria-hidden /> 更换文件
            </Button>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-accent-subtle">
              <BookOpen className="size-8 text-accent" aria-hidden />
            </div>
            <div className="text-center">
              <p className="text-base font-medium">打开 PDF 开始阅读</p>
              <p className="mt-1 text-sm text-fg-tertiary">
                支持原文 / 译文 / 对照三种阅读模式
              </p>
            </div>
            <Button onClick={onOpenFile}>
              <FolderOpen aria-hidden /> 打开文件
            </Button>
          </div>
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

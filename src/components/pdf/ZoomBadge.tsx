/**
 * components/pdf/ZoomBadge.tsx —— 缩放比例角标 + 一键重置按钮
 *
 * 悬浮在阅读视图角落，展示当前缩放百分比；点击重置按钮恢复 100% 并回到顶部。
 * 依赖父级定位（absolute 定位，父级需 relative）。
 */
import { RotateCcw } from "lucide-react";
import { cn } from "../../lib/utils";

interface Props {
  zoom: number;
  onReset: () => void;
  className?: string;
}

export function ZoomBadge({ zoom, onReset, className }: Props) {
  return (
    <div
      className={cn(
        "absolute bottom-3 right-3 z-30 flex items-center gap-1.5 rounded-full border border-border bg-bg-secondary/90 px-2.5 py-1 text-xs shadow-sm backdrop-blur",
        className,
      )}
    >
      <span className="tabular-nums text-fg-secondary">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={onReset}
        title="重置缩放（Ctrl+滚轮可缩放）"
        aria-label="重置缩放"
        className="rounded-full p-1 text-fg-tertiary transition-colors hover:bg-accent/20 hover:text-fg"
      >
        <RotateCcw className="size-3.5" />
      </button>
    </div>
  );
}

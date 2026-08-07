import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Download, Loader2, RefreshCw, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Progress } from "../ui/progress";
import { ScrollArea } from "../ui/scroll-area";
import {
  checkEnvironment,
  installComponent,
  onEnvProgress,
  type ComponentStatus,
  type EnvComponent,
  type EnvironmentReport,
  type InstallProgress,
} from "../../lib/env";
import { setCachedEnvironmentReport, clearCachedEnvironmentReport } from "../../lib/envCache";
import { cn } from "../../lib/utils";

const COMPONENT_META: Record<EnvComponent, { label: string; desc: string }> = {
  java: { label: "Java JRE 17", desc: "OpenDataLoader 运行所需" },
  python: { label: "Python 3.11", desc: "PDF 解析引擎运行环境" },
  opendataloader: { label: "OpenDataLoader", desc: "本地 PDF 解析引擎" },
};

const ORDER: EnvComponent[] = ["java", "python", "opendataloader"];

interface Props {
  open: boolean;
  onComplete: (report: EnvironmentReport) => void;
  onSkip: () => void;
}

type Installing = EnvComponent | "all" | null;

export function EnvironmentSetupDialog({ open, onComplete, onSkip }: Props) {
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [installing, setInstalling] = useState<Installing>(null);
  const [progress, setProgress] = useState<Partial<Record<EnvComponent, InstallProgress>>>({});
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await checkEnvironment();
      if (!mounted.current) return;
      setReport(r);
      setCachedEnvironmentReport(r);
      if (r.allReady) onComplete(r);
    } catch {
      clearCachedEnvironmentReport();
    }
  }, [onComplete]);

  useEffect(() => {
    mounted.current = true;
    if (open) {
      setError(null);
      refresh();
    }
    return () => {
      mounted.current = false;
    };
  }, [open, refresh]);

  // 订阅安装进度
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | null = null;
    onEnvProgress((p) => {
      if (!mounted.current) return;
      setProgress((prev) => ({ ...prev, [p.component]: p }));
      if (p.stage === "error") {
        setInstalling(null);
        setError(p.message);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [open]);

  const handleInstall = async (component: EnvComponent | "all") => {
    setError(null);
    setInstalling(component);
    setProgress({});
    try {
      const r = await installComponent(component);
      if (!mounted.current) return;
      setReport(r);
      setCachedEnvironmentReport(r);
      if (r.allReady) onComplete(r);
    } catch (e) {
      setInstalling(null);
      setError(String(e));
    }
  };

  const isInstallingAny = installing !== null;
  const status = (comp: EnvComponent): ComponentStatus | undefined =>
    report?.[comp];

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="size-5 text-accent" />
            环境准备
          </DialogTitle>
          <DialogDescription>
            PaperReader 需要以下运行时组件（首次安装约需下载 165MB，安装后不再重复下载）
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[46vh] pr-2">
          <div className="space-y-3">
            {ORDER.map((comp) => {
              const s = status(comp);
              const meta = COMPONENT_META[comp];
              const prog = progress[comp];
              const isInstalling = installing === comp || installing === "all";
              return (
                <div
                  key={comp}
                  className="flex items-center gap-3 rounded-lg border border-border bg-bg-secondary p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{meta.label}</span>
                      <StatusBadge status={s} installing={isInstalling} />
                    </div>
                    <p className="mt-0.5 text-xs text-fg-secondary">{meta.desc}</p>
                    {s?.path && (
                      <p className="mt-0.5 truncate text-xs text-fg-tertiary">{s.path}</p>
                    )}
                    {isInstalling && prog && (
                      <div className="mt-2">
                        <Progress value={prog.percent} />
                        <p className="mt-1 text-xs text-fg-secondary">{prog.message}</p>
                      </div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={s?.installed || isInstallingAny}
                    onClick={() => handleInstall(comp)}
                  >
                    {isInstalling ? <Loader2 className="animate-spin" /> : "安装"}
                  </Button>
                </div>
              );
            })}
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">
              {error}
            </div>
          )}

          {/* 高级选项 */}
          <div className="mt-4 rounded-lg border border-border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-xs text-fg-secondary hover:text-fg"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              高级选项（跳过安装 / 自定义路径）
              <ChevronDown className={cn("size-4 transition-transform", showAdvanced && "rotate-180")} />
            </button>
            {showAdvanced && (
              <div className="space-y-2 border-t border-border p-3">
                <p className="text-xs text-fg-tertiary">
                  若您已在本机安装 Java / Python，可直接进入应用，之后可在设置面板中配置自定义路径。
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isInstallingAny}
                  onClick={() => onSkip()}
                >
                  跳过安装，直接进入
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={isInstallingAny}
            onClick={refresh}
          >
            <RefreshCw /> 重新检测
          </Button>
          <Button
            size="sm"
            disabled={isInstallingAny || (report?.allReady ?? false)}
            onClick={() => handleInstall("all")}
          >
            {installing === "all" ? <Loader2 className="animate-spin" /> : <Download />}
            一键安装缺失组件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({
  status,
  installing,
}: {
  status: ComponentStatus | undefined;
  installing: boolean;
}) {
  if (installing) {
    return (
      <Badge variant="info">
        <Loader2 className="mr-0.5 size-3 animate-spin" /> 安装中
      </Badge>
    );
  }
  if (!status) return null;
  if (status.installed) {
    return (
      <Badge variant="success">
        <CheckCircle2 className="mr-0.5 size-3" /> {status.version ?? "已安装"}
      </Badge>
    );
  }
  return (
    <Badge variant="error">
      <XCircle className="mr-0.5 size-3" /> 未安装
    </Badge>
  );
}

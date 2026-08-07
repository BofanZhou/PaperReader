import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { BookOpen, Loader2 } from "lucide-react";
import { TooltipProvider } from "./components/ui/tooltip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { EnvironmentSetupDialog } from "./components/env/EnvironmentSetupDialog";
import { TopToolbar } from "./components/layout/TopToolbar";
import { Workspace } from "./components/layout/Workspace";
import { useTheme } from "./hooks/useTheme";
import { checkEnvironment, type EnvironmentReport } from "./lib/env";
import {
  clearCachedEnvironmentReport,
  getCachedEnvironmentReport,
  setCachedEnvironmentReport,
} from "./lib/envCache";
import { useAppStore } from "./store/appStore";

type Phase = "checking" | "env-setup" | "ready";

function Splash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-accent-subtle">
        <BookOpen className="size-8 text-accent" aria-hidden />
      </div>
      <p className="text-sm text-fg-secondary">PaperReader 正在启动…</p>
      <Loader2 className="size-5 animate-spin text-accent" aria-hidden />
    </div>
  );
}

function App() {
  const { theme, toggleTheme } = useTheme();
  const { setCurrentFile } = useAppStore();
  const [phase, setPhase] = useState<Phase>("checking");

  // 首次启动：检测环境（优先使用缓存）
  useEffect(() => {
    let cancelled = false;

    const cached = getCachedEnvironmentReport();
    if (cached) {
      setPhase(cached.allReady ? "ready" : "env-setup");
      // 后台异步刷新一次缓存，避免系统环境变化后缓存过期
      checkEnvironment()
        .then((r) => {
          if (cancelled) return;
          setCachedEnvironmentReport(r);
          if (!r.allReady) setPhase("env-setup");
        })
        .catch(() => clearCachedEnvironmentReport());
      return () => {
        cancelled = true;
      };
    }

    checkEnvironment()
      .then((r) => {
        if (cancelled) return;
        setCachedEnvironmentReport(r);
        setPhase(r.allReady ? "ready" : "env-setup");
      })
      .catch(() => {
        if (!cancelled) setPhase("env-setup");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnvComplete = useCallback((report: EnvironmentReport) => {
    setCachedEnvironmentReport(report);
    setPhase("ready");
  }, []);

  const handleOpenFile = useCallback(async () => {
    const file = await open({
      multiple: false,
      filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
    });
    if (typeof file === "string") {
      setCurrentFile(file);
    }
  }, [setCurrentFile]);

  return (
    <TooltipProvider>
      <ErrorBoundary>
        <div className="flex h-full flex-col overflow-hidden">
          {phase === "checking" && <Splash />}

          {phase === "env-setup" && (
            <EnvironmentSetupDialog
              open
              onComplete={handleEnvComplete}
              onSkip={() => setPhase("ready")}
            />
          )}

          {phase === "ready" && (
            <>
              <TopToolbar
                theme={theme}
                onToggleTheme={toggleTheme}
                onOpenFile={handleOpenFile}
              />
              <Workspace onOpenFile={handleOpenFile} />
            </>
          )}
        </div>
      </ErrorBoundary>
    </TooltipProvider>
  );
}

export default App;

/**
 * settings/tabs/EnvironmentTab.tsx —— 环境设置（Prompt 9 §9）
 * 显示当前 Java / Python / OpenDataLoader 路径与版本、重新检测环境按钮、
 * 打开安装引导（复用 EnvironmentSetupDialog）。
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, Settings2, XCircle } from "lucide-react";
import { Button } from "../../ui/button";
import {
  checkEnvironment,
  type ComponentStatus,
  type EnvironmentReport,
} from "../../../lib/env";
import {
  clearCachedEnvironmentReport,
  setCachedEnvironmentReport,
} from "../../../lib/envCache";
import { EnvironmentSetupDialog } from "../../env/EnvironmentSetupDialog";

const META: { key: keyof Omit<EnvironmentReport, "allReady">; label: string; desc: string }[] = [
  { key: "java", label: "Java JRE 17", desc: "OpenDataLoader 运行所需" },
  { key: "python", label: "Python", desc: "PDF 解析引擎运行环境" },
  { key: "opendataloader", label: "OpenDataLoader", desc: "本地 PDF 解析引擎" },
];

function StatusRow({ label, desc, st }: { label: string; desc: string; st: ComponentStatus }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-bg-secondary/60 p-3">
      {st.installed ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <XCircle className="mt-0.5 size-4 shrink-0 text-error" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {label}
          {st.version ? <span className="ml-2 text-xs text-fg-tertiary">{st.version}</span> : null}
        </p>
        <p className="text-xs text-fg-tertiary">{desc}</p>
        {st.path ? (
          <p className="mt-1 truncate font-mono text-xs text-fg-secondary" title={st.path}>
            {st.path}
          </p>
        ) : (
          <p className="mt-1 text-xs text-error">{st.error ?? "未安装"}</p>
        )}
      </div>
    </div>
  );
}

export function EnvironmentTab() {
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const r = await checkEnvironment();
      setReport(r);
      setCachedEnvironmentReport(r);
    } catch (e) {
      clearCachedEnvironmentReport();
      setReport(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleComplete = useCallback((r: EnvironmentReport) => {
    setReport(r);
    setSetupOpen(false);
  }, []);

  return (
    <div className="space-y-4">
      <section className="flex items-center gap-2">
        <div className="mr-auto text-sm text-fg-secondary">
          {report ? (
            report.allReady ? (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="size-4" aria-hidden /> 环境就绪，可正常解析 PDF
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-error">
                <XCircle className="size-4" aria-hidden /> 部分组件缺失，解析可能失败
              </span>
            )
          ) : (
            "环境信息加载中…"
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={checking}>
          {checking ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          重新检测
        </Button>
        <Button variant="outline" size="sm" onClick={() => setSetupOpen(true)}>
          <Settings2 aria-hidden /> 安装/修复组件
        </Button>
      </section>

      <section className="space-y-2">
        {META.map((m) => (
          <StatusRow key={m.key} label={m.label} desc={m.desc} st={report ? report[m.key] : ({ installed: false, version: null, path: null, error: "检测中…" } as ComponentStatus)} />
        ))}
      </section>

      <p className="text-xs leading-relaxed text-fg-tertiary">
        组件路径由应用自动检测。若已手动安装到非默认位置，可通过「安装/修复组件」引导重新检测；
        高级自定义路径配置将在后续版本开放（当前版本自动探测系统 PATH 与默认安装目录）。
      </p>

      <EnvironmentSetupDialog open={setupOpen} onComplete={handleComplete} onSkip={() => setSetupOpen(false)} />
    </div>
  );
}

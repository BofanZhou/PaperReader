/**
 * components/settings/SettingsDialog.tsx —— 设置面板（Prompt 4 底座）
 *
 * - 模型选择（默认翻译模型）
 * - API Key 管理：输入 / 保存 / 删除 / 测试连接
 * - Key 安全说明：只存系统凭据管理器，不上传、不进 Git
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Plug, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  deleteApiKey,
  getAiConfig,
  saveAiConfig,
  saveApiKey,
  testConnection,
  type AiConfig,
  type ModelConfig,
  type ProviderKeyStatus,
} from "../../lib/ai";
import { useAppStore } from "../../store/appStore";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PROVIDER_LABEL: Record<string, string> = {
  deepseek: "DeepSeek",
  kimi: "Kimi 开放平台",
  "kimi-code": "Kimi for Coding",
};

export function SettingsDialog({ open, onOpenChange }: Props) {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ provider: string; ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // 打开时刷新配置
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    getAiConfig()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        // Key 已配置的 provider 输入框留空（不显示已有 Key）
        setKeyInputs({});
      })
      .catch((e) => setTestResult({ provider: "system", ok: false, msg: String(e) }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSaveKey = useCallback(async (provider: string) => {
    const key = keyInputs[provider]?.trim();
    if (!key) return;
    setSaving(provider);
    setTestResult(null);
    try {
      await saveApiKey(provider, key);
      setKeyInputs((prev) => ({ ...prev, [provider]: "" }));
      // 保底：给 Windows Credential Manager ~100ms 落盘时间，避免 keyring 3.x
      // 在 Windows 上偶发的"刚写完立刻读不到"瞬时一致性问题。
      await new Promise((r) => setTimeout(r, 100));
      const cfg = await getAiConfig();
      setConfig(cfg);
      setTestResult({ provider, ok: true, msg: `${PROVIDER_LABEL[provider]} API Key 已安全保存` });
    } catch (e) {
      setTestResult({ provider, ok: false, msg: String(e) });
    } finally {
      setSaving(null);
    }
  }, [keyInputs]);

  const handleDeleteKey = useCallback(async (provider: string) => {
    setSaving(provider);
    try {
      await deleteApiKey(provider);
      const cfg = await getAiConfig();
      setConfig(cfg);
      setTestResult({ provider, ok: true, msg: `${PROVIDER_LABEL[provider]} API Key 已删除` });
    } catch (e) {
      setTestResult({ provider, ok: false, msg: String(e) });
    } finally {
      setSaving(null);
    }
  }, []);

  const handleTest = useCallback(async (provider: string) => {
    setTesting(provider);
    setTestResult(null);
    try {
      const msg = await testConnection(provider);
      setTestResult({ provider, ok: true, msg });
    } catch (e) {
      setTestResult({ provider, ok: false, msg: String(e) });
    } finally {
      setTesting(null);
    }
  }, []);

  const handleChangeModel = useCallback(async (modelId: string) => {
    if (!config) return;
    setConfig({ ...config, defaultModel: modelId });
    try {
      await saveAiConfig(modelId);
      // 同步工具栏当前模型（保持"默认模型"与"当前选择"一致）
      useAppStore.getState().setModel(modelId);
    } catch (e) {
      setTestResult({ provider: "system", ok: false, msg: String(e) });
    }
  }, [config]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="settings-dialog">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>模型与 API Key 配置。Key 仅保存在本机系统凭据管理器中。</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-secondary">
            <Loader2 className="size-4 animate-spin" aria-hidden /> 加载配置…
          </div>
        ) : (
          <div className="space-y-6">
            {/* 默认模型 */}
            {config && (
              <section>
                <h3 className="mb-2 text-sm font-medium">默认翻译模型</h3>
                <Select value={config.defaultModel} onValueChange={handleChangeModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {config.models.map((m: ModelConfig) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                        <span className="ml-2 text-xs text-fg-tertiary">
                          ${m.priceInput}/$ {m.priceOutput} / 1M · {m.contextWindow >= 1000000 ? "1M" : `${Math.round(m.contextWindow / 1000)}K`} ctx
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </section>
            )}

            {/* API Key 管理 */}
            <section className="space-y-4">
              <h3 className="text-sm font-medium">API Key 管理</h3>
              {config?.keys.map((k: ProviderKeyStatus) => (
                <div key={k.provider} className="rounded-lg border border-border bg-bg-secondary/60 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <KeyRound className="size-4 text-fg-secondary" aria-hidden />
                    <span className="text-sm font-medium">{PROVIDER_LABEL[k.provider]}</span>
                    {k.configured ? (
                      <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
                        <ShieldCheck className="size-3" aria-hidden /> 已配置
                      </span>
                    ) : (
                      <span className="ml-auto rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-fg-tertiary">
                        未配置
                      </span>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showKeys[k.provider] ? "text" : "password"}
                        placeholder={k.configured ? "已保存（重新输入以覆盖）" : `输入 ${PROVIDER_LABEL[k.provider]} API Key`}
                        value={keyInputs[k.provider] ?? ""}
                        onChange={(e) => setKeyInputs((prev) => ({ ...prev, [k.provider]: e.target.value }))}
                        className="w-full rounded-md border border-border bg-bg px-3 py-2 pr-9 text-sm outline-none focus:border-accent"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKeys((prev) => ({ ...prev, [k.provider]: !prev[k.provider] }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-tertiary hover:text-fg"
                        aria-label={showKeys[k.provider] ? "隐藏 Key" : "显示 Key"}
                      >
                        {showKeys[k.provider] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>

                    <Button
                      size="sm"
                      disabled={!keyInputs[k.provider]?.trim() || saving === k.provider}
                      onClick={() => handleSaveKey(k.provider)}
                    >
                      {saving === k.provider ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : "保存"}
                    </Button>

                    {k.configured && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={testing === k.provider}
                          onClick={() => handleTest(k.provider)}
                        >
                          {testing === k.provider ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Plug className="size-3.5" aria-hidden />
                          )}
                          测试
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={saving === k.provider}
                          onClick={() => handleDeleteKey(k.provider)}
                          aria-label={`删除 ${PROVIDER_LABEL[k.provider]} Key`}
                          title="删除 Key"
                        >
                          <Trash2 className="size-4 text-error" aria-hidden />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </section>

            {/* 测试/保存结果 */}
            {testResult && (
              <div
                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                  testResult.ok ? "border-success/40 bg-success/10 text-success" : "border-error/40 bg-error/10 text-error"
                }`}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                ) : (
                  <span className="mt-0.5 shrink-0">⚠️</span>
                )}
                <span className="break-all">{testResult.msg}</span>
              </div>
            )}

            {/* 安全说明 */}
            <section className="rounded-lg border border-border/60 bg-bg-tertiary/40 p-3 text-xs leading-relaxed text-fg-tertiary">
              <p className="mb-1 font-medium text-fg-secondary">🔒 安全说明</p>
              <ul className="list-inside list-disc space-y-0.5">
                <li>API Key 只保存到 <b>Windows 凭据管理器</b>（系统级加密），不会写入任何配置文件</li>
                <li>项目上传 GitHub 不会包含 Key（配置文件中不含密钥）</li>
                <li>请求出错时日志会自动脱敏，Key 不会出现在错误信息里</li>
                <li>DeepSeek V4 Flash 为默认模型（$0.14/$0.28 per 1M，1M 上下文）</li>
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

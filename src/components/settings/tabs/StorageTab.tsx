/**
 * settings/tabs/StorageTab.tsx —— 存储管理（Prompt 9 §7）
 * 已导入论文列表（标题/页数/翻译状态/操作）、单篇删除/全部清理、
 * 缓存大小显示、数据导出/导入（JSON 备份恢复，含设置与论文元数据）。
 */
import { useCallback, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { AlertTriangle, Download, FolderOpen, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button } from "../../ui/button";
import {
  deletePaper,
  getAllSettings,
  listPapers,
  setSetting,
  type PaperRow,
} from "../../../lib/db";
import { deletePaperDir, papersCacheSize } from "../../../lib/env";
import { useSettingsStore } from "../../../store/settingsStore";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "未翻译",
  translating: "翻译中",
  done: "已翻译",
  partial: "部分翻译",
};

export function StorageTab() {
  const [papers, setPapers] = useState<PaperRow[] | null>(null);
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loadSettings = useSettingsStore((s) => s.load);

  const refresh = useCallback(async () => {
    try {
      const [ps, size] = await Promise.all([listPapers(), papersCacheSize()]);
      setPapers(ps);
      setCacheSize(size);
    } catch (e) {
      setMsg({ ok: false, text: `读取存储信息失败: ${String(e)}` });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = useCallback(
    async (paper: PaperRow) => {
      setBusy(paper.id);
      setMsg(null);
      try {
        await deletePaper(paper.id); // DB 行（ON DELETE CASCADE 连带子表）
        await deletePaperDir(paper.id); // 文件缓存目录
        setMsg({ ok: true, text: `已删除《${paper.title ?? paper.file_path}》` });
        await refresh();
      } catch (e) {
        setMsg({ ok: false, text: `删除失败: ${String(e)}` });
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const handleClearAll = useCallback(async () => {
    if (!papers?.length) return;
    if (!window.confirm(`确定清理全部 ${papers.length} 篇论文缓存？此操作不可恢复。`)) return;
    setBusy("all");
    setMsg(null);
    try {
      for (const p of papers) {
        await deletePaper(p.id).catch(() => {});
        await deletePaperDir(p.id).catch(() => {});
      }
      setMsg({ ok: true, text: "已清理全部论文缓存" });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: `清理失败: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [papers, refresh]);

  const handleExport = useCallback(async () => {
    setBusy("export");
    setMsg(null);
    try {
      const [settings, ps] = await Promise.all([getAllSettings(), listPapers()]);
      const backup = { app: "paperreader", version: 1, exportedAt: new Date().toISOString(), settings, papers: ps };
      const dest = await save({
        defaultPath: `paperreader-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON 备份", extensions: ["json"] }],
      });
      if (!dest) return; // 用户取消
      await writeTextFile(dest, JSON.stringify(backup, null, 2));
      setMsg({ ok: true, text: `备份已导出：${dest}` });
    } catch (e) {
      setMsg({ ok: false, text: `导出失败: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }, []);

  const handleImport = useCallback(async () => {
    setBusy("import");
    setMsg(null);
    try {
      const src = await open({
        multiple: false,
        filters: [{ name: "JSON 备份", extensions: ["json"] }],
      });
      if (typeof src !== "string") return; // 用户取消
      const raw = await readTextFile(src);
      const data = JSON.parse(raw) as { settings?: Record<string, string> };
      if (!data || typeof data !== "object" || !data.settings) {
        setMsg({ ok: false, text: "备份文件格式无效（缺少 settings 字段）" });
        return;
      }
      let n = 0;
      for (const [k, v] of Object.entries(data.settings)) {
        await setSetting(k, String(v));
        n++;
      }
      await loadSettings(); // 重新加载设置到内存
      setMsg({ ok: true, text: `已导入 ${n} 项设置（主题/字号/翻译偏好已生效）` });
    } catch (e) {
      setMsg({ ok: false, text: `导入失败: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [loadSettings]);

  const deleting = (id: string) => busy === id;
  const anyBusy = busy !== null;

  return (
    <div className="space-y-4">
      {/* 缓存大小 + 操作 */}
      <section className="flex flex-wrap items-center gap-2">
        <div className="mr-auto text-sm text-fg-secondary">
          缓存占用：<b>{cacheSize === null ? "计算中…" : formatBytes(cacheSize)}</b>
          <span className="ml-2 text-xs text-fg-tertiary">（论文解析副本 + 图片 + 翻译缓存）</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={anyBusy}>
          <RefreshCw aria-hidden /> 刷新
        </Button>
        <Button variant="outline" size="sm" onClick={() => void handleExport()} disabled={anyBusy}>
          <Download aria-hidden /> 导出备份
        </Button>
        <Button variant="outline" size="sm" onClick={() => void handleImport()} disabled={anyBusy}>
          <Upload aria-hidden /> 导入备份
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleClearAll()}
          disabled={anyBusy || !papers?.length}
          className="text-error hover:bg-error/10"
        >
          <Trash2 aria-hidden /> 全部清理
        </Button>
      </section>

      {/* 消息 */}
      {msg && (
        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
            msg.ok ? "border-success/40 bg-success/10 text-success" : "border-error/40 bg-error/10 text-error"
          }`}
        >
          {msg.ok ? <span>✓</span> : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span className="break-all">{msg.text}</span>
        </div>
      )}

      {/* 论文列表 */}
      <section>
        <h3 className="mb-2 text-sm font-medium">
          已导入论文（{papers ? papers.length : "…"}）
        </h3>
        {papers === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-fg-secondary">
            <Loader2 className="size-4 animate-spin" aria-hidden /> 加载列表…
          </div>
        ) : papers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-fg-tertiary">
            尚未导入任何论文。打开 PDF 解析后会自动记录到这里。
          </div>
        ) : (
          <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {papers.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-lg border border-border bg-bg-secondary/40 px-3 py-2">
                <FolderOpen className="size-4 shrink-0 text-fg-tertiary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg" title={p.file_path}>
                    {p.title ?? p.file_path}
                  </p>
                  <p className="text-xs text-fg-tertiary">
                    {p.page_count ? `${p.page_count} 页 · ` : ""}
                    {STATUS_LABEL[p.translation_status ?? "pending"] ?? p.translation_status}
                    {p.created_at ? ` · ${p.created_at.slice(0, 10)}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={anyBusy}
                  onClick={() => void handleDelete(p)}
                  aria-label="删除该论文缓存"
                  title="删除该论文缓存"
                  className="text-error hover:bg-error/10"
                >
                  {deleting(p.id) ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs leading-relaxed text-fg-tertiary">
        删除论文会同时移除数据库记录与本地缓存目录（papers/&lt;uuid&gt;），不可恢复。备份导出的 JSON
        含全部设置与论文元数据，可用于迁移到其它设备（论文正文缓存请手动拷贝 papers 目录）。
      </p>
    </div>
  );
}

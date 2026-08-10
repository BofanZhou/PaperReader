/**
 * settings/tabs/TermsTab.tsx —— 术语库设置（Prompt 9 §8）
 * 基础术语库下载（内置种子）、自定义术语库导入（CSV/JSON）、术语库统计。
 * 术语数据存 SQLite terms 表（P5 术语库的存储地基）。
 */
import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { BookMarked, Download, Loader2, Upload } from "lucide-react";
import { Button } from "../../ui/button";
import { countTerms, importTerms, listTerms, type TermRow } from "../../../lib/db";

/** 内置基础术语种子（学术论文高频通用术语，用户可后续自定义覆盖） */
const BASE_TERMS: { term: string; translation: string; definition?: string; domain?: string }[] = [
  { term: "abstract", translation: "摘要", domain: "通用" },
  { term: "introduction", translation: "引言", domain: "通用" },
  { term: "methodology", translation: "方法", domain: "通用" },
  { term: "conclusion", translation: "结论", domain: "通用" },
  { term: "literature review", translation: "文献综述", domain: "通用" },
  { term: "experiment", translation: "实验", domain: "通用" },
  { term: "baseline", translation: "基线", domain: "通用" },
  { term: "benchmark", translation: "基准测试", domain: "通用" },
  { term: "state-of-the-art", translation: "最先进水平", domain: "通用" },
  { term: "hypothesis", translation: "假设", domain: "通用" },
  { term: "correlation", translation: "相关性", domain: "统计" },
  { term: "regression", translation: "回归", domain: "统计" },
  { term: "variance", translation: "方差", domain: "统计" },
  { term: "gradient", translation: "梯度", domain: "数学" },
  { term: "convergence", translation: "收敛性", domain: "数学" },
  { term: "iteration", translation: "迭代", domain: "算法" },
  { term: "complexity", translation: "复杂度", domain: "算法" },
  { term: "robustness", translation: "鲁棒性", domain: "工程" },
  { term: "throughput", translation: "吞吐量", domain: "系统" },
  { term: "latency", translation: "延迟", domain: "系统" },
];

function parseCsv(text: string): { term: string; translation: string; definition?: string; domain?: string }[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const rows: { term: string; translation: string; definition?: string; domain?: string }[] = [];
  const start = /term\s*[,，]/.test(lines[0]) ? 1 : 0; // 跳过表头行
  for (const line of lines.slice(start)) {
    // 支持逗号或制表符分隔（简单解析，不带引号转义）
    const parts = line.split(/[,，\t]/).map((p) => p.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    rows.push({
      term: parts[0],
      translation: parts[1],
      definition: parts[2] || undefined,
      domain: parts[3] || undefined,
    });
  }
  return rows;
}

function parseJson(text: string): { term: string; translation: string; definition?: string; domain?: string }[] {
  const data = JSON.parse(text);
  const arr: unknown[] = Array.isArray(data) ? data : data?.terms;
  if (!Array.isArray(arr)) throw new Error("JSON 需为数组或含 terms 数组的对象");
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      term: String(x.term ?? "").trim(),
      translation: String(x.translation ?? x.zh ?? "").trim(),
      definition: x.definition ? String(x.definition) : undefined,
      domain: x.domain ? String(x.domain) : undefined,
    }))
    .filter((r) => r.term && r.translation);
}

export function TermsTab() {
  const [total, setTotal] = useState<number | null>(null);
  const [rows, setRows] = useState<TermRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [n, ts] = await Promise.all([countTerms(), listTerms(50)]);
      setTotal(n);
      setRows(ts);
    } catch (e) {
      setMsg({ ok: false, text: `读取术语库失败: ${String(e)}` });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDownloadBase = useCallback(async () => {
    setBusy("base");
    setMsg(null);
    try {
      const added = await importTerms(BASE_TERMS);
      setMsg({ ok: true, text: `基础术语库已导入（新增 ${added} 条）` });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: `导入失败: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleImport = useCallback(async () => {
    setBusy("import");
    setMsg(null);
    try {
      const src = await open({
        multiple: false,
        filters: [
          { name: "术语库文件", extensions: ["csv", "json"] },
        ],
      });
      if (typeof src !== "string") return;
      const text = await readTextFile(src);
      const rows = src.toLowerCase().endsWith(".json") ? parseJson(text) : parseCsv(text);
      if (rows.length === 0) {
        setMsg({ ok: false, text: "文件中没有可导入的术语条目（需要 term,translation 两列）" });
        return;
      }
      const added = await importTerms(rows);
      setMsg({ ok: true, text: `已导入 ${rows.length} 条（新增 ${added} 条，重复条目已跳过）` });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: `导入失败: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  return (
    <div className="space-y-4">
      {/* 统计 + 操作 */}
      <section className="flex flex-wrap items-center gap-2">
        <div className="mr-auto text-sm text-fg-secondary">
          术语库共 <b>{total === null ? "…" : total}</b> 条
        </div>
        <Button variant="outline" size="sm" onClick={() => void handleDownloadBase()} disabled={busy !== null}>
          {busy === "base" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download aria-hidden />}
          下载基础术语库
        </Button>
        <Button variant="outline" size="sm" onClick={() => void handleImport()} disabled={busy !== null}>
          {busy === "import" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Upload aria-hidden />}
          导入 CSV/JSON
        </Button>
      </section>

      {/* 消息 */}
      {msg && (
        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
            msg.ok ? "border-success/40 bg-success/10 text-success" : "border-error/40 bg-error/10 text-error"
          }`}
        >
          <span className="mt-0.5 shrink-0">{msg.ok ? "✓" : "⚠️"}</span>
          <span className="break-all">{msg.text}</span>
        </div>
      )}

      {/* 术语列表 */}
      <section>
        <h3 className="mb-2 text-sm font-medium">最近条目</h3>
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-fg-tertiary">
            <BookMarked className="mx-auto mb-2 size-5" aria-hidden />
            术语库为空。点击"下载基础术语库"或导入自定义 CSV/JSON 文件。
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-bg-tertiary/60">
                  <th className="px-3 py-1.5 text-left font-medium">术语</th>
                  <th className="px-3 py-1.5 text-left font-medium">译文</th>
                  <th className="px-3 py-1.5 text-left font-medium">领域</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.term} className="border-t border-border/60">
                    <td className="px-3 py-1.5 text-fg">{r.term}</td>
                    <td className="px-3 py-1.5 text-fg-secondary">{r.translation}</td>
                    <td className="px-3 py-1.5 text-xs text-fg-tertiary">{r.domain ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs leading-relaxed text-fg-tertiary">
        CSV 格式：<code>term,translation[,definition,domain]</code>（首行可为表头）；JSON 格式：数组或
        <code>{"{terms:[...]}"}</code>，条目含 term / translation 字段。翻译时开启「术语预注入」即可生效。
      </p>
    </div>
  );
}

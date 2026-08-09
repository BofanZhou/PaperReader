/**
 * components/pdf/RestructuredMarkdown.tsx —— AI 重排 Markdown 渲染器（复用）
 *
 * 负责把 `[图N]` / `[表N]` 映射为本地图片，并渲染 LaTeX 公式。
 * 被 RestructuredView、译文模式、对照模式共用。
 *
 * 设计要点：
 * 1. 占位符通过**字符串切分**直接渲染为 React 组件，绕开 ReactMarkdown
 *    对自定义协议图片的兼容问题（裂图）。
 * 2. 公式：先做兜底自动包裹（AI 未加 `$...$` 时也能渲染），再用
 *    remark-math + rehype-katex（output=html）渲染。
 * 3. 图片/表格找不到时显示占位，有文本表格时降级为文本表格。
 */
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { PaperImage } from "./PaperImage";
import type { ParsedResult } from "../../lib/env";
import "katex/dist/katex.min.css";

interface Props {
  markdown: string;
  parsedResult?: ParsedResult | null;
}

type AssetType = "figure" | "table";

/** 按 readingOrder 收集 figure/table 的 imageSrc（按全局阅读顺序） */
function collectAssetSrcs(result: ParsedResult | null, kind: AssetType): string[] {
  if (!result) return [];
  const srcs: string[] = [];
  for (const page of result.pages) {
    const sorted = [...page.elements].sort((a, b) => a.readingOrder - b.readingOrder);
    for (const el of sorted) {
      if (el.type === kind && el.imageSrc) {
        srcs.push(el.imageSrc);
      }
    }
  }
  return srcs;
}

/** 按 readingOrder 收集 table 元素的文本（用于截图缺失时降级为文本表格） */
function collectTableTexts(result: ParsedResult | null): string[] {
  if (!result) return [];
  const texts: string[] = [];
  for (const page of result.pages) {
    const sorted = [...page.elements].sort((a, b) => a.readingOrder - b.readingOrder);
    for (const el of sorted) {
      if (el.type === "table" && el.text) {
        texts.push(el.text);
      }
    }
  }
  return texts;
}

function FigureImage({ path, alt }: { path: string; alt: string }) {
  return (
    <figure className="my-3">
      <PaperImage path={path} alt={alt} maxHeight={420} />
      <figcaption className="mt-1 text-center text-xs text-fg-tertiary">{alt}</figcaption>
    </figure>
  );
}

function TableImage({ path, alt }: { path: string; alt: string }) {
  return (
    <figure className="my-3">
      <PaperImage path={path} alt={alt} maxHeight={520} />
      <figcaption className="mt-1 text-center text-xs text-fg-tertiary">{alt}</figcaption>
    </figure>
  );
}

function MissingAsset({ alt, hint }: { alt: string; hint?: string }) {
  return (
    <figure className="my-3 rounded-md border border-dashed border-border bg-bg-secondary/50 p-6 text-center text-xs text-fg-tertiary">
      <div>{alt}（未找到对应资源）</div>
      {hint && <div className="mt-1 text-fg-tertiary/80">{hint}</div>}
    </figure>
  );
}

function TableTextFallback({ text, alt }: { text: string; alt: string }) {
  return (
    <div className="my-3">
      <div className="mb-1 text-center text-xs text-fg-tertiary">{alt}（文本表格，截图未生成）</div>
      <div className="overflow-x-auto rounded-md border border-border bg-bg-secondary/40 p-3">
        <pre className="text-xs leading-relaxed text-fg-primary whitespace-pre-wrap">{text}</pre>
      </div>
    </div>
  );
}

type Segment =
  | { kind: "text"; content: string }
  | { kind: "figure"; index: number; alt: string }
  | { kind: "table"; index: number; alt: string };

/** 匹配 `[图N]` / `[表N]`（前面不是 `!`，避免把已是 markdown 图片的占位符重复切分） */
const PLACEHOLDER_RE = /(?<!!)\[(图|表)(\d+)\]/g;

function splitByPlaceholders(md: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(md)) !== null) {
    if (m.index > last) {
      segs.push({ kind: "text", content: md.slice(last, m.index) });
    }
    const typeChar = m[1];
    const num = parseInt(m[2], 10);
    segs.push({
      kind: typeChar === "图" ? "figure" : "table",
      index: num,
      alt: `${typeChar}${num}`,
    });
    last = m.index + m[0].length;
  }
  if (last < md.length) {
    segs.push({ kind: "text", content: md.slice(last) });
  }
  return segs;
}

const LATEX_CMD_RE = /\\(?:frac|sqrt|sum|int|tag|left|right|cdot|partial|pi|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|tau|phi|omega|infty|pm|times|div|approx|le|ge|prod|cup|cap|notin|subset|supset|ln|log|sin|cos|tan|exp)\b/;
const HAS_MATH_DELIM = /\$[\s\S]*?\$/;

/**
 * 兜底：AI 未用 `$...$` 包裹的 LaTeX 公式段落，自动用 `$$...$$` 包裹。
 * 只处理「整段都是 LaTeX」的情况，避免误包正文。
 */
function autoWrapLatex(md: string): string {
  return md.split(/\n{2,}/).map((para) => {
    const t = para.trim();
    if (!t) return para;
    if (HAS_MATH_DELIM.test(t)) return para;
    if (LATEX_CMD_RE.test(t) && /[\\{}]/.test(t)) {
      return `$$\n${t}\n$$`;
    }
    return para;
  }).join("\n\n");
}

export function RestructuredMarkdown({ markdown, parsedResult }: Props) {
  const figures = useMemo(() => collectAssetSrcs(parsedResult ?? null, "figure"), [parsedResult]);
  const tables = useMemo(() => collectAssetSrcs(parsedResult ?? null, "table"), [parsedResult]);
  const tableTexts = useMemo(() => collectTableTexts(parsedResult ?? null), [parsedResult]);

  const segments = useMemo(() => {
    const wrapped = autoWrapLatex(markdown);
    return splitByPlaceholders(wrapped);
  }, [markdown]);

  return (
    <div className="h-full overflow-y-auto bg-bg-primary">
      <div className="mx-auto max-w-3xl px-6 py-5">
        <article className="prose-sm max-w-none text-sm leading-relaxed text-fg [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_p]:my-2 [&_li]:my-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-bg-tertiary [&_pre]:p-3 [&_code]:text-xs">
          {segments.map((seg, i) => {
            if (seg.kind === "text") {
              if (!seg.content.trim()) return null;
              return (
                <ReactMarkdown
                  key={`t-${i}`}
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[[rehypeKatex, { output: "html" }]]}
                >
                  {seg.content}
                </ReactMarkdown>
              );
            }
            if (seg.kind === "figure") {
              const imgSrc = figures[seg.index - 1];
              if (imgSrc) return <FigureImage key={`f-${i}`} path={imgSrc} alt={seg.alt} />;
              return (
                <MissingAsset
                  key={`f-${i}`}
                  alt={seg.alt}
                  hint="可在解析时重新生成 PDF 截图，或确认该图已被解析。"
                />
              );
            }
            // table
            const imgSrc = tables[seg.index - 1];
            if (imgSrc) return <TableImage key={`t-${i}`} path={imgSrc} alt={seg.alt} />;
            const text = tableTexts[seg.index - 1];
            if (text) return <TableTextFallback key={`tt-${i}`} text={text} alt={seg.alt} />;
            return (
              <MissingAsset
                key={`t-${i}`}
                alt={seg.alt}
                hint="解析未识别到表格。建议重新解析，或在设置中开启混合（hybrid）模式。"
              />
            );
          })}
        </article>
      </div>
    </div>
  );
}

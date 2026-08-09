/**
 * components/pdf/RestructuredMarkdown.tsx —— AI 重排 Markdown 渲染器（复用）
 *
 * 负责把 `[图N]` / `[表N]` 映射为本地图片，并渲染 LaTeX 公式。
 * 被 RestructuredView、译文模式、对照模式共用。
 *
 * 设计要点：
 * 1. 不依赖 rehype-sanitize 放行自定义协议，直接把占位符转成 markdown image，
 *    再用自定义 img 组件映射回 parsed.json 中的 imageSrc。
 * 2. 公式使用 remark-math + rehype-katex（output=html）渲染。
 * 3. 图片/表格找不到时显示占位，不裂图。
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

/** 按 readingOrder 收集 figure/table 的 imageSrc */
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

function MissingAsset({ alt }: { alt: string }) {
  return (
    <figure className="my-3 rounded-md border border-dashed border-border bg-bg-secondary/50 p-6 text-center text-xs text-fg-tertiary">
      {alt}（未找到对应资源）
    </figure>
  );
}

const FIG_RE = /^fig:\/\/(\d+)$/;
const TBL_RE = /^tbl:\/\/(\d+)$/;

export function RestructuredMarkdown({ markdown, parsedResult }: Props) {
  const figures = useMemo(() => collectAssetSrcs(parsedResult ?? null, "figure"), [parsedResult]);
  const tables = useMemo(() => collectAssetSrcs(parsedResult ?? null, "table"), [parsedResult]);

  const prepared = useMemo(
    () =>
      markdown
        // 负向回顾 (?<!!) 避免把已经是 markdown image 的占位符重复替换
        .replace(/(?<!!)\[图(\d+)\]/g, "![图$1](fig://$1)")
        .replace(/(?<!!)\[表(\d+)\]/g, "![表$1](tbl://$1)"),
    [markdown],
  );

  return (
    <div className="h-full overflow-y-auto bg-bg-primary">
      <div className="mx-auto max-w-3xl px-6 py-5">
        <article className="prose-sm max-w-none text-sm leading-relaxed text-fg [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_p]:my-2 [&_li]:my-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-bg-tertiary [&_pre]:p-3 [&_code]:text-xs">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { output: "html" }]]}
            components={{
              img: ({ src, alt }) => {
                const fig = src ? FIG_RE.exec(src) : null;
                if (fig) {
                  const idx = parseInt(fig[1], 10) - 1;
                  const imgSrc = figures[idx];
                  if (imgSrc) return <FigureImage path={imgSrc} alt={alt ?? `图${fig[1]}`} />;
                  return <MissingAsset alt={alt ?? `图${fig[1]}`} />;
                }
                const tbl = src ? TBL_RE.exec(src) : null;
                if (tbl) {
                  const idx = parseInt(tbl[1], 10) - 1;
                  const imgSrc = tables[idx];
                  if (imgSrc) return <TableImage path={imgSrc} alt={alt ?? `表${tbl[1]}`} />;
                  return <MissingAsset alt={alt ?? `表${tbl[1]}`} />;
                }
                // 其它图片（网络/http 等）直接渲染
                return (
                  <img
                    src={src}
                    alt={alt ?? ""}
                    className="mx-auto max-h-[420px] rounded-md border border-border"
                  />
                );
              },
            }}
          >
            {prepared}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}

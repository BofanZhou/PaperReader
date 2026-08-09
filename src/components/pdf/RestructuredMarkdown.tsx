/**
 * components/pdf/RestructuredMarkdown.tsx —— AI 重排 Markdown 渲染器（复用）
 *
 * 负责把 `[图N]` 映射为 `fig://N` 图片占位符，并通过 PaperImage 加载本地图片。
 * 被 RestructuredView、译文模式、对照模式共用。
 */
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { PaperImage } from "./PaperImage";
import type { ParsedResult } from "../../lib/env";

interface Props {
  markdown: string;
  parsedResult?: ParsedResult | null;
}

/** 自定义 rehype-sanitize schema：允许 [图N] 占位符使用的 fig:// 协议 */
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), "fig"],
  },
};

/** 从解析结果提取图序 imageSrc 列表（严格按 readingOrder 出现的 figure） */
function collectFigureSrcs(result: ParsedResult | null): string[] {
  if (!result) return [];
  const srcs: string[] = [];
  for (const page of result.pages) {
    const sorted = [...page.elements].sort((a, b) => a.readingOrder - b.readingOrder);
    for (const el of sorted) {
      if (el.type === "figure" && el.imageSrc) {
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

export function RestructuredMarkdown({ markdown, parsedResult }: Props) {
  const figures = useMemo(() => collectFigureSrcs(parsedResult ?? null), [parsedResult]);
  const prepared = useMemo(() => markdown.replace(/\[图(\d+)\]/g, "![图$1](fig://$1)"), [markdown]);

  return (
    <div className="h-full overflow-y-auto bg-bg-primary">
      <div className="mx-auto max-w-3xl px-6 py-5">
        <article className="prose-sm max-w-none text-sm leading-relaxed text-fg [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_p]:my-2 [&_li]:my-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-bg-tertiary [&_pre]:p-3 [&_code]:text-xs">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
            components={{
              img: ({ src, alt }) => {
                const m = /^fig:\/\/(\d+)$/.exec(src ?? "");
                if (m) {
                  const idx = parseInt(m[1], 10) - 1;
                  const imgSrc = figures[idx];
                  if (imgSrc) {
                    return <FigureImage path={imgSrc} alt={alt ?? `图${m[1]}`} />;
                  }
                  return (
                    <figure className="my-3 rounded-md border border-dashed border-border bg-bg-secondary/50 p-6 text-center text-xs text-fg-tertiary">
                      {alt ?? `图${m[1]}`}（未找到对应图片）
                    </figure>
                  );
                }
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

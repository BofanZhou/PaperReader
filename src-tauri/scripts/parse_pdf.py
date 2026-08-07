#!/usr/bin/env python3
"""PaperReader PDF 解析包装脚本（Prompt 2）

职责：
1. 调用 OpenDataLoader 解析 PDF → 原始 JSON（含 bbox，BOTTOM-LEFT 坐标）
2. 用 pypdf 获取页面尺寸（OpenDataLoader JSON 不含尺寸）
3. 转换为 PaperReader 统一内部格式（按页分组、类型映射、reading_order）
4. 写入 papers/{uuid}/parsed.json

用法：
    python parse_pdf.py <pdf_path> <output_dir> <work_dir>
  - output_dir: papers/{uuid}/，最终 parsed.json 写到这里
  - work_dir:   临时目录，opendataloader 原始输出放这里（含 _images/）

进度协议（stdout 输出，Rust 端逐行读取）：
    PROGRESS <stage> <percent> <message>
  stages: starting | parsing | converting | done

结果协议：
    OUTPUT <path>      成功，输出 parsed.json 路径
    ERROR <message>    失败，message 包含完整 traceback（多行以 \n 转义）
"""

import glob
import json
import os
import sys
import traceback

import opendataloader_pdf
from pypdf import PdfReader

# OpenDataLoader 元素类型 → PaperReader 元素类型
TYPE_MAP = {
    "paragraph": "paragraph",
    "heading": "heading",
    "caption": "caption",
    "table": "table",
    "image": "figure",
    "list": "paragraph",
    "formula": "formula",
}

PROGRESS = "PROGRESS"


def progress(stage: str, percent: int, message: str) -> None:
    print(f"{PROGRESS} {stage} {percent} {message}", flush=True)


def error_out(message: str) -> None:
    """输出 ERROR 行；多行信息替换为字面 \n，避免破坏行协议。"""
    safe = message.replace("\r", "").replace("\n", "\\n")
    print(f"ERROR {safe}", flush=True)


def table_to_text(el: dict) -> str:
    """将 OpenDataLoader 表格结构转为文本（单元格内容按行 | 分隔）"""
    lines = []
    for row in el.get("rows", []):
        cells = []
        for cell in row.get("cells", []):
            texts = []
            for kid in cell.get("kids", []):
                if kid.get("content"):
                    texts.append(kid["content"])
            cells.append(" ".join(texts))
        lines.append(" | ".join(cells))
    return "\n".join(lines)


def convert(raw: dict, page_sizes: list[tuple[float, float]]) -> dict:
    """OpenDataLoader 原始 JSON → PaperReader 内部格式"""
    pages: dict[int, list[dict]] = {}
    reading_order = 0
    for el in raw.get("kids", []):
        page_num = int(el.get("page number", 1))
        if page_num < 1:
            continue
        bbox = el.get("bounding box") or [0.0, 0.0, 0.0, 0.0]
        etype = TYPE_MAP.get(el.get("type", "paragraph"), "paragraph")

        text = el.get("content") or ""
        if el.get("type") == "table":
            text = table_to_text(el)
        # 图片元素：记录图片源文件（相对 work_dir 的 _images/ 目录）
        img_src = el.get("source") if el.get("type") == "image" else None

        pages.setdefault(page_num, []).append(
            {
                "id": str(el.get("id", reading_order)),
                "type": etype,
                "bbox": {
                    "left": bbox[0],
                    "bottom": bbox[1],
                    "right": bbox[2],
                    "top": bbox[3],
                },
                "text": text,
                "font": el.get("font"),
                "font_size": el.get("font size"),
                "heading_level": el.get("heading level"),
                "reading_order": reading_order,
                "image_src": img_src,
            }
        )
        reading_order += 1

    result = {
        "pdfPath": raw.get("file name", ""),
        "title": (raw.get("title") or "").strip() or None,
        "author": (raw.get("author") or "").strip() or None,
        "pages": [
            {
                "pageNumber": i + 1,
                "width": page_sizes[i][0],
                "height": page_sizes[i][1],
                "elements": pages.get(i + 1, []),
            }
            for i in range(len(page_sizes))
        ],
    }
    return result


def run_opendataloader(pdf_path: str, work_dir: str, force_ocr: bool = False) -> None:
    """调用 OpenDataLoader 解析；force_ocr 用于扫描版 fallback。"""
    kwargs = {
        "input_path": [pdf_path],
        "output_dir": work_dir,
        "format": "json",
    }
    if force_ocr:
        kwargs["force_ocr"] = True
        kwargs["ocr_engine"] = "tesseract"
    opendataloader_pdf.convert(**kwargs)


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: parse_pdf.py <pdf_path> <output_dir> <work_dir>", file=sys.stderr)
        return 2

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]
    work_dir = sys.argv[3]

    try:
        progress("starting", 2, "启动解析引擎")
        os.makedirs(work_dir, exist_ok=True)
        os.makedirs(output_dir, exist_ok=True)

        # 1. OpenDataLoader 解析（普通模式；若失败且疑似扫描版则尝试 force_ocr fallback）
        progress("parsing", 10, "正在解析 PDF（首次需启动 JVM，约 6 秒）")
        try:
            run_opendataloader(pdf_path, work_dir, force_ocr=False)
        except Exception as first_err:
            # 第一次解析失败：尝试 hybrid / OCR 模式
            progress("parsing", 15, "普通模式失败，尝试 OCR 混合模式")
            try:
                run_opendataloader(pdf_path, work_dir, force_ocr=True)
            except Exception as ocr_err:
                raise RuntimeError(
                    f"普通模式与 OCR 模式均解析失败。\n"
                    f"普通模式错误: {first_err}\n"
                    f"OCR 模式错误: {ocr_err}"
                ) from first_err
        progress("parsing", 65, "PDF 解析完成")

        # 2. 定位输出 JSON
        json_files = glob.glob(os.path.join(work_dir, "*.json"))
        if not json_files:
            raise RuntimeError("OpenDataLoader 未生成输出 JSON")
        with open(json_files[0], encoding="utf-8") as f:
            raw = json.load(f)

        # 3. pypdf 页面尺寸
        progress("converting", 72, "读取页面尺寸")
        reader = PdfReader(pdf_path)
        page_sizes = [
            (float(p.mediabox.width), float(p.mediabox.height)) for p in reader.pages
        ]
        if not page_sizes:
            raise RuntimeError("无法读取 PDF 页面")

        # 4. 转换为内部格式
        progress("converting", 85, "整理版面元素")
        result = convert(raw, page_sizes)

        # 5. 写入 parsed.json
        out_path = os.path.join(output_dir, "parsed.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        progress("done", 100, f"解析完成，共 {len(page_sizes)} 页")
        print(f"OUTPUT {out_path}", flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        error_out(f"{e}\n{tb}")
        # 同时把 traceback 写到 stderr，便于本地调试
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

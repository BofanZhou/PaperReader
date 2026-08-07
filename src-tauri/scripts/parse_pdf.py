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


import io


class _NullStdout:
    """用于包装 sys.stdout，安全丢弃 OpenDataLoader 的 JAR 实时日志输出。

    OpenDataLoader 的 runner.py 会调用 sys.stdout.buffer.write/flush() 把 Java 日志
    实时写回 stdout。当 Python 被 Tauri 以管道方式启动时，Windows 下对 pipe 的
    raw buffer 调用 flush() 会抛出 OSError: [Errno 22] Invalid argument。
    这里把 buffer 替换为 BytesIO，让 flush 不报错，同时丢弃不需要的 JAR 日志
    （解析结果已经写到 output_dir 的 JSON 文件中）。
    """

    def __init__(self) -> None:
        self.buffer = io.BytesIO()

    def write(self, s: str) -> int:
        return len(s)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False


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

    # Windows pipe 环境下，OpenDataLoader 直接 flush sys.stdout.buffer 会失败。
    # 临时替换 stdout 为安全对象，convert 结束后再恢复，避免影响后续 progress()。
    old_stdout = sys.stdout
    sys.stdout = _NullStdout()
    try:
        opendataloader_pdf.convert(**kwargs)
    finally:
        sys.stdout = old_stdout


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: parse_pdf.py <pdf_path> <output_dir> <work_dir>", file=sys.stderr)
        return 2

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]
    work_dir = sys.argv[3]

    # 诊断信息：帮助排查 Tauri 与命令行行为差异
    progress("starting", 1, f"Python: {sys.executable} ({sys.version.split()[0]})")
    progress("starting", 2, f"opendataloader_pdf: {opendataloader_pdf.__file__}")

    try:
        progress("starting", 3, "启动解析引擎")
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
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else -1
        error_out(f"OpenDataLoader 调用导致 Python 进程退出 (exit code={code})")
        traceback.print_exc(file=sys.stderr)
        return 1
    except BaseException as e:  # noqa: BLE001
        tb = traceback.format_exc()
        error_out(f"{type(e).__name__}: {e}\n{tb}")
        # 同时把 traceback 写到 stderr，便于本地调试
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

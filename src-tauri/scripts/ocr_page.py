#!/usr/bin/env python3
"""PaperReader 原图视图扫描页 OCR（Tesseract-on-render）

前端把 pdfjs 渲染出的页面图像（PNG，base64）传过来，这里用系统 tesseract
做 OCR，返回 word 级像素坐标。坐标 = 输入图像分辨率（与调用方 canvas 同
坐标系），前端可直接在该 canvas 上叠加透明文本层——天然对齐。

用法：
    python ocr_page.py <image_base64> [lang]
    - lang 默认 "chi_sim+eng"
输出（stdout，JSON）：
    {"words": [{"text", "x", "y", "w", "h"}, ...]}
    {"error": "..."}  失败时
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile

# 与 parse_pdf.py 的 ensure_hybrid_backend 相同的 tesseract 探测策略：
# PATH 优先，常见安装路径兜底（避免硬编码单一路径）。
_TESS_CANDIDATES = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    "/usr/bin/tesseract",
    "/usr/local/bin/tesseract",
]


def find_tesseract() -> str | None:
    exe = shutil.which("tesseract")
    if exe:
        return exe
    for cand in _TESS_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    return None


def parse_tsv(tsv: str) -> list[dict]:
    """tesseract TSV → word 级 [{text, x, y, w, h}]（过滤低置信度）。"""
    words: list[dict] = []
    lines = tsv.strip().splitlines()
    if not lines:
        return words
    header = lines[0].split("\t")
    col = {name: i for i, name in enumerate(header)}
    for line in lines[1:]:
        cols = line.split("\t")
        if len(cols) <= max(col.values()):
            continue
        text = cols[col["text"]].strip() if col["text"] < len(cols) else ""
        conf_raw = cols[col["conf"]] if col["conf"] < len(cols) else "-1"
        if not text or conf_raw in ("-1", ""):
            continue
        try:
            conf = float(conf_raw)
        except ValueError:
            continue
        if conf < 40:  # 低置信度词丢弃，避免文本层噪声
            continue
        words.append({
            "text": text,
            "x": int(float(cols[col["left"]])),
            "y": int(float(cols[col["top"]])),
            "w": int(float(cols[col["width"]])),
            "h": int(float(cols[col["height"]])),
        })
    return words


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: ocr_page.py <image_base64> [lang]"}), file=sys.stdout)
        return 2

    image_base64 = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "chi_sim+eng"

    tess = find_tesseract()
    if not tess:
        print(json.dumps({"error": "未找到 tesseract，请安装 Tesseract-OCR（含 chi_sim/eng 语言包）"}), file=sys.stdout)
        return 1

    try:
        data = base64.b64decode(image_base64)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"base64 解码失败: {e}"}), file=sys.stdout)
        return 1

    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".png")
        with os.fdopen(fd, "wb") as f:
            f.write(data)

        proc = subprocess.run(
            [tess, tmp, "stdout", "-l", lang, "tsv"],
            capture_output=True, text=True, timeout=180,
        )
        if proc.returncode != 0:
            print(json.dumps({"error": f"tesseract 失败: {(proc.stderr or proc.stdout)[:500]}"}), file=sys.stdout)
            return 1
        print(json.dumps({"words": parse_tsv(proc.stdout)}, ensure_ascii=False), file=sys.stdout)
        return 0
    except subprocess.TimeoutExpired:
        print(json.dumps({"error": "OCR 超时（图片过大，请缩小后重试）"}), file=sys.stdout)
        return 1
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"OCR 异常: {e}"}), file=sys.stdout)
        return 1
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())

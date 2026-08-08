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
import re
import shutil
import socket
import subprocess
import sys
import time
import traceback

import opendataloader_pdf
from pypdf import PdfReader

# 强制 stdout/stderr 使用 UTF-8 —— Rust 端 BufReader::lines() 按 UTF-8 解析；
# Windows 上 Python 默认 cp936，含中文消息时会导致 Rust 端读流中断。
# reconfigure 是 no-op 若 stdout 已被替换（如 _NullStdout）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

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

# 用 ContextVar 让 main() 把 output_dir 传给 error_out()，避免函数签名被层层穿透。
# 即便 output_dir 还没设置（main() 早期），error_out 也能优雅退化只写 stdout。
from contextvars import ContextVar  # noqa: E402
_ERROR_LOG_DIR: ContextVar = ContextVar("error_log_dir", default=None)


def safe_print(*args, **kwargs) -> bool:
    """print 包装：捕获 Tauri 子进程上下文下的 pipe 问题。

    Windows 上 Tauri 用 Stdio::piped() 创建 4KB buffer 的 pipe，父进程读不及
    或 pipe 异常关闭时，Python print 会抛 BrokenPipeError 或 OSError [Errno 22]
    Invalid argument。这种情况下继续解析才是用户想要的（结果写到 output_dir
    文件），不应让 pipe 异常杀掉 Python 进程。

    返回 True 表示写出去了；False 表示 pipe 不可写。
    """
    try:
        print(*args, **kwargs)
        return True
    except (BrokenPipeError, ValueError, OSError):
        return False


def progress(stage: str, percent: int, message: str) -> None:
    safe_print(f"{PROGRESS} {stage} {percent} {message}", flush=True)


def error_out(message: str) -> None:
    """输出 ERROR 行；多行信息替换为字面 \\n，避免破坏行协议。

    三重兜底：
    1. 按协议写 stdout（Rust 端按行解析）
    2. stdout / 后续 stderr 也 broken 时，写到 output_dir/ERROR_{ts}.log
       （彻底绕开 pipe，错误详情不会丢失）
    """
    safe = message.replace("\r", "").replace("\n", "\\n")
    line = f"ERROR {safe}"
    safe_print(line, flush=True)  # 主通道：stdout（失败也无所谓）
    # 备用通道：stderr（多行原貌，供 Rust 端 stderr collector 兜底）
    try:
        sys.stderr.write(message + "\n")
        sys.stderr.flush()
    except (BrokenPipeError, ValueError, OSError):
        pass

    # 终极兜底：output_dir/ERROR_{ts}.log —— 完全不依赖 pipe
    fallback_dir = _ERROR_LOG_DIR.get(None)
    if fallback_dir:
        try:
            # 加微秒避免同秒多次失败互相覆盖
            from datetime import datetime
            ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            with open(
                os.path.join(fallback_dir, f"ERROR_{ts}.log"), "w", encoding="utf-8"
            ) as f:
                f.write(message + "\n")
        except OSError:
            pass


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


def list_to_text(el: dict) -> str:
    """将 OpenDataLoader list 结构转为文本（每条 list item 独占一行）

    参考文献列表被识别为 list 类型时，容器本身的 content 为 None，
    真实内容在 list items[*].content（以及它们自身的 kids[*].content）。
    之前没递归提取，导致参考文献页全部为空。
    """
    parts: list[str] = []
    for item in el.get("list items", []) or []:
        text = item.get("content")
        if text:
            parts.append(text)
        # list item 自身可能是多段（跨行/跨栏），用 kids 把每段也加进来
        for kid in item.get("kids", []) or []:
            ktext = kid.get("content")
            if ktext:
                parts.append(ktext)
    return "\n".join(parts)


# ========== 噪声过滤（页眉/页脚/版权/脚注/logo） ==========
#
# OpenDataLoader 会把期刊页眉、页脚版权、通讯作者脚注、期刊 logo 等当成普通
# 元素输出，导致正文被"页眉-正文-页脚-版权"穿插，阅读体验很差。这些元素
# 有稳定的内容模式 / 位置特征，在此统一过滤。

# 内容模式（小写匹配，强规则：命中即丢弃）
_NOISE_PATTERNS = [
    # 英文论文：版权 / 期刊页眉 / 脚注
    r"all rights reserved",
    r"see front matter",
    r"journal homepage",
    r"sciencedirect",
    r"contents lists available",
    r"corresponding author",
    r"issn\s*[:：]",
    r"copyright\s*©|©",
    r"\(c\)\s*20\d\d",
    r"tel\.?\s*[:：]",
    r"fax\s*[:：]",
    r"e-?mail\s*address",
    r"e-?mail\s*[:：]\s*\S+@",      # E-mail: xxx@yyy（无 address 字样也命中）
    r"^\s*\d+\s*$",                # 纯页码
    r"pii\s*[:：]",
    r"doi\s*[:：]",
    # 中文学位/期刊论文：首页底部作者脚注特征
    r"收稿日期",
    r"修回日期",
    r"基金项目",
    r"作者简介",
    r"通讯作者",
    r"编辑部网址",
    r"引用格式[：:]",
    r"^\s*[\*◆●]\s*[收稿作通]",  # 脚注开头标记（* 收稿 / * 作者简介 等）
]

# 图片：小于该尺寸（pt）视为 logo / 装饰碎片
_LOGO_MAX_DIM = 100


def _is_noise(el: dict, page_h: float) -> bool:
    """判断单个元素是否为页眉/页脚/版权/脚注/logo 等噪声。"""
    etype = el.get("type")
    bbox = el.get("bounding box") or [0.0, 0.0, 0.0, 0.0]
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    top_y = bbox[3]
    bottom_y = bbox[1]
    text = (el.get("content") or "").strip()

    # 1. 图片：小尺寸 → logo / 装饰碎片
    if etype == "image":
        return w < _LOGO_MAX_DIM or h < _LOGO_MAX_DIM

    # 2. 空文本的非图像、非表格、非列表元素（list / paragraph 无内容）→ 丢弃
    #    注意：table / list 元素没有 content（数据在 rows / list items 里），
    #    不能按此规则过滤，否则参考文献页会全部丢空
    if not text and etype not in ("table", "list"):
        return True

    low = text.lower()

    # 3. 内容模式（强规则）
    if any(re.search(p, low) for p in _NOISE_PATTERNS):
        return True

    # 4. 位置弱规则（顶部/底部边缘 + 短文本 → 页眉页脚）
    if page_h > 0:
        if top_y > page_h * 0.93 and len(text) < 90:
            return True
        if bottom_y < page_h * 0.05 and len(text) < 90:
            return True
        # 顶部区域的短标题型页眉（如期刊名被识别成 heading）
        if top_y > page_h * 0.85 and etype in ("heading", "paragraph") and len(text) < 60:
            return True

    return False


def _safe_int(value, default=None):
    """OpenDataLoader 的 heading level / page number 等字段类型不稳定（可能是
    int / float / str / None），统一转 int，失败时返回 default。"""
    if value is None:
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def convert(raw: dict, page_sizes: list[tuple[float, float]], work_dir: str) -> dict:
    """OpenDataLoader 原始 JSON → PaperReader 内部格式

    work_dir 用于把 image 元素的 source（相对 _images/ 的路径）补全为绝对路径，
    前端 convertFileSrc 可直接加载。
    """
    pages: dict[int, list[dict]] = {}
    reading_order = 0
    for el in raw.get("kids", []):
        page_num = _safe_int(el.get("page number"), default=1) or 1
        if page_num < 1:
            continue
        # 噪声过滤：页眉/页脚/版权/脚注/logo 不进入阅读视图
        page_h = page_sizes[page_num - 1][1] if page_num - 1 < len(page_sizes) else 0
        if _is_noise(el, page_h):
            continue
        bbox = el.get("bounding box") or [0.0, 0.0, 0.0, 0.0]
        etype = TYPE_MAP.get(el.get("type", "paragraph"), "paragraph")

        text = el.get("content") or ""
        if el.get("type") == "table":
            text = table_to_text(el)
        elif el.get("type") == "list":
            # 参考文献等列表内容在 list items[*]，容器 content 经常为空
            text = list_to_text(el) or text
        # 图片元素：source 是相对 work_dir 的路径（如 _images/xxx.png），
        # 补全为绝对路径，前端 convertFileSrc 才能加载。
        img_src = None
        if el.get("type") == "image":
            src = el.get("source")
            if src:
                img_src = os.path.abspath(os.path.join(work_dir, src))

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
                # Rust 端 ParsedElement 用 #[serde(rename_all = "camelCase")]，
                # 前端 ParsedElement 类型也是 camelCase。Python 写出 parsed.json
                # 时必须用 camelCase，否则缓存反序列化时 missing field。
                "fontSize": el.get("font size"),
                "headingLevel": _safe_int(el.get("heading level")),
                "readingOrder": reading_order,
                "imageSrc": img_src,
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


# ========== hybrid（docling-fast 后端）进程管理 ==========
#
# hybrid 模式 = 本地 Java 快速处理简单页 + 复杂页（扫描/表格/公式）路由到
# docling-fast AI 后端，基准测试准确率显著高于纯 Java（表格 0.49→0.93）。
# 后端是常驻 HTTP 服务（默认 localhost:5002），首次调用需下载模型。
#
# 启动要点（Windows 实战验证）：
#   1. OCR 引擎用 tesseract（本机已装 + chi_sim/eng 语言包），避免 easyocr 大模型下载
#   2. 后端进程必须注入 tesseract 目录到 PATH（anaconda python 的 PATH 里没有）
#   3. HF_ENDPOINT 指向 hf-mirror.com —— 国内网络直连 huggingface.co 超时，
#      docling 首次转换会从 HF 下载版面模型（几分钟，之后走本地缓存）

HYBRID_PORT = 5002
HF_ENDPOINT = "https://hf-mirror.com"


def _backend_alive(port: int) -> bool:
    """探测后端 TCP 端口是否可连（不等于初始化完成，但够用）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.8)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def ensure_hybrid_backend() -> bool:
    """确保 docling hybrid 后端在跑；未跑则启动并等待就绪。
    返回 True = 本次新启动了后端（调用方可用于进度提示）。"""
    if _backend_alive(HYBRID_PORT):
        return False

    # 注入运行环境：tesseract PATH + HF 镜像
    env = os.environ.copy()
    tess_dir = r"C:\Program Files\Tesseract-OCR"
    if os.path.isdir(tess_dir) and tess_dir not in env.get("PATH", ""):
        env["PATH"] = tess_dir + ";" + env.get("PATH", "")
    env.setdefault("HF_ENDPOINT", HF_ENDPOINT)

    # 后端可执行：优先 PATH，否则用当前 Python 同目录 Scripts（anaconda 布局）
    hy = shutil.which("opendataloader-pdf-hybrid")
    if not hy:
        scripts = os.path.join(os.path.dirname(sys.executable), "Scripts")
        cand = os.path.join(scripts, "opendataloader-pdf-hybrid.exe")
        if os.path.exists(cand):
            hy = cand
    if not hy:
        raise RuntimeError("未找到 opendataloader-pdf-hybrid，请先 pip install 'opendataloader-pdf[hybrid]'")

    # detached 常驻启动（不随本脚本退出）；stdout/stderr 丢弃
    DETACHED = 0x00000008 | 0x00000200
    subprocess.Popen(
        [hy, "--port", str(HYBRID_PORT), "--ocr-engine", "tesseract",
         "--ocr-lang", "chi_sim,eng", "--log-level", "warning"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=DETACHED, close_fds=True,
    )
    # 轮询就绪（后端初始化 + 首次模型下载可能较久，放宽到 180s）
    for _ in range(90):
        if _backend_alive(HYBRID_PORT):
            return True
        time.sleep(2)
    raise RuntimeError("hybrid 后端启动超时（首次使用需联网下载模型，请重试）")


def run_opendataloader(pdf_path: str, work_dir: str, force_ocr: bool = False) -> None:
    """调用 OpenDataLoader 解析；force_ocr 用于扫描版 fallback。

    quiet=True 是关键：让 OpenDataLoader 走 subprocess.run 模式（runner.py:37-54）
    而非 streaming Popen（runner.py:57-81）。后者会在 JAR 逐行输出时调用
    sys.stdout.buffer.flush()，在 Windows + Tauri 子进程管道下会抛
    OSError: [Errno 22] Invalid argument —— 这是当前解析失败的根因。
    quiet 模式下 JAR 输出在内部被读取并丢弃，生成结果仍写到 output_dir 文件。
    """
    # hybrid 全局启用（用户决策）：docling 后端增强复杂页提取
    started_new = ensure_hybrid_backend()
    if started_new:
        progress("parsing", 12, "hybrid 后端启动中（首次使用需联网下载模型，可能等待 1-5 分钟）")
    kwargs = {
        "input_path": [pdf_path],
        "output_dir": work_dir,
        "format": "json",
        "quiet": True,
        # cluster = 边框 + 聚类检测，能识别无边框表格（default 只认有边框的）
        "table_method": "cluster",
        # 路由复杂页（扫描/表格/公式）到 docling-fast 后端
        "hybrid": "docling-fast",
        # 后端异常时回退纯 Java 解析（单点故障不致命）
        "hybrid_fallback": True,
    }
    if force_ocr:
        kwargs["force_ocr"] = True
        kwargs["ocr_engine"] = "tesseract"

    # 兜底：替换 sys.stdout 为安全对象，避免即便 quiet=True 时仍有边缘场景
    # 触发对 sys.stdout.buffer 的 raw 操作。
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

    # 让 error_out() 知道兜底日志写哪里；这里设上兜底，覆盖 OpenDataLoader
    # 后续任意时刻抛错（包括 pipe broken）都能落盘。
    _ERROR_LOG_DIR.set(output_dir)

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
        result = convert(raw, page_sizes, work_dir)

        # 5. 写入 parsed.json
        out_path = os.path.join(output_dir, "parsed.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        progress("done", 100, f"解析完成，共 {len(page_sizes)} 页")
        safe_print(f"OUTPUT {out_path}", flush=True)
        return 0
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else -1
        error_out(f"OpenDataLoader 调用导致 Python 进程退出 (exit code={code})")
        try:
            traceback.print_exc(file=sys.stderr)
        except (BrokenPipeError, ValueError, OSError):
            pass
        return 1
    except BaseException as e:  # noqa: BLE001
        tb = traceback.format_exc()
        error_out(f"{type(e).__name__}: {e}\n{tb}")
        # 同时把 traceback 写到 stderr，便于本地调试（pipe 坏了就算了）
        try:
            traceback.print_exc(file=sys.stderr)
        except (BrokenPipeError, ValueError, OSError):
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())

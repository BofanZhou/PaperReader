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
    r"^\s*第\s*\d+\s*页\s*$",      # 中文页码页眉（第 2 页）
    r"pii\s*[:：]",
    r"doi\s*[:：]",
    # Elsevier 文章信息块（article info）
    r"article history",
    r"received in revised form",
    r"available online",
    r"^received\s+\d+\s+\S+",      # Received 9 September 2011
    r"accepted\s+\d+\s+\S+",
    r"^\s*(?:[A-Za-z]\s+){4,}[A-Za-z]\s*$",  # 字母空格装饰（a b s t r a c t）
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

    # 后处理（可读性优化）：双栏重排 → 断句合并 → 标题识别增强
    _post_process(pages, page_sizes)
    # 重排/合并后重新分配全局 readingOrder（页间顺序不变，页内按新顺序）
    order = 0
    for p in range(len(page_sizes)):
        for el in pages.get(p + 1, []):
            el["readingOrder"] = order
            order += 1

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


# ========== 可读性后处理（本地启发式，零成本） ==========
#
# A-1 双栏重排：学术论文多为双栏，OpenDataLoader 的 kids 顺序对部分版面仍非
#     人眼阅读序。按 bbox.left 聚成左右两簇（判断足够保守：两簇各 ≥3 元素、
#     簇中心距 > 35% 页宽），栏内按 top 降序（人眼自上而下），横跨元素
#     （跨栏标题/图表，宽 ≥ 70% 页宽）按 top 排序置前。
# A-2 断句合并：相邻 paragraph 前段不以句末标点结尾、后段非大写开头 → 拼接，
#     修复「集电气、机 / 械、材料和计算机」这类被切碎的句子。
# A-3/4 标题识别 + 字号聚类：编号标题（1. / 1.2 / 第X章）、全大写短行、
#     以及字号显著大于正文的短行 → 强制 headingLevel。

_SENT_END = ".!?。！？"
_CJK_MIN, _CJK_MAX = 0x4E00, 0x9FFF
_CJK_EXT_MIN, _CJK_EXT_MAX = 0x3400, 0x4DBF
_NUM_HEADING_RE = re.compile(r"^\s*(\d+(?:\.\d+)*)\.?\s+(\S+)")
_CN_HEADING_RE = re.compile(r"^\s*第[一二三四五六七八九十百千]+[章节篇]")
_CAPS_HEADING_RE = re.compile(r"^\s*[A-Z][A-Z0-9\s&()\-/:,]{3,80}$")


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return (_CJK_MIN <= cp <= _CJK_MAX) or (_CJK_EXT_MIN <= cp <= _CJK_EXT_MAX)


def _is_two_column(elements: list[dict], page_w: float) -> bool:
    """保守判断：文本元素 left 中心是否分成左右两簇。"""
    xs = [
        (el["bbox"]["left"] + el["bbox"]["right"]) / 2
        for el in elements
        if el["bbox"]["right"] - el["bbox"]["left"] < page_w * 0.7
    ]
    if len(xs) < 6:
        return False
    left = [x for x in xs if x < page_w * 0.5]
    right = [x for x in xs if x >= page_w * 0.5]
    if len(left) < 3 or len(right) < 3:
        return False
    lc = sum(left) / len(left)
    rc = sum(right) / len(right)
    return (rc - lc) > page_w * 0.35


def _reorder_two_column(elements: list[dict], page_w: float) -> list[dict]:
    """双栏重排：横跨元素（宽≥70%页宽，如跨栏标题/表格/图）作为「带」分隔锚点，
    锚点之间的栏内容按 左栏(top 降序) → 右栏(top 降序) 输出，锚点本身插在
    对应阅读位置（而不是全部前置）。实现人眼阅读顺序：上到下、每带内左→右。"""
    full = sorted(
        (el for el in elements if el["bbox"]["right"] - el["bbox"]["left"] >= page_w * 0.7),
        key=lambda e: e["bbox"]["top"], reverse=True,
    )
    cols = [
        el for el in elements
        if el["bbox"]["right"] - el["bbox"]["left"] < page_w * 0.7
    ]
    left = sorted(
        (el for el in cols if el["bbox"]["left"] < page_w * 0.5),
        key=lambda e: e["bbox"]["top"], reverse=True,
    )
    right = sorted(
        (el for el in cols if el["bbox"]["left"] >= page_w * 0.5),
        key=lambda e: e["bbox"]["top"], reverse=True,
    )
    if not full:
        return left + right

    result: list[dict] = []
    prev_top = float("inf")
    for anchor in full:
        a_top = anchor["bbox"]["top"]
        # 当前锚点之上、上一锚点之下的栏内容（left/right 已 top 降序，过滤保持有序）
        result += [e for e in left if a_top < e["bbox"]["top"] <= prev_top]
        result += [e for e in right if a_top < e["bbox"]["top"] <= prev_top]
        result.append(anchor)
        prev_top = a_top
    # 最底部锚点之下的剩余内容
    result += [e for e in left if e["bbox"]["top"] <= prev_top]
    result += [e for e in right if e["bbox"]["top"] <= prev_top]
    return result


def _try_join(a: dict, b: dict) -> str | None:
    """若 a、b 是同一句被切开，返回拼接文本；否则 None。"""
    if a["type"] != "paragraph" or b["type"] != "paragraph":
        return None
    ta = a["text"].rstrip()
    tb = b["text"].lstrip()
    if not ta or not tb:
        return None
    if ta[-1] in _SENT_END:
        return None  # 前段是完整句
    # 后段以编号标题开头（"5.1. Influencing..."）→ 是两个标题，不拼
    if re.match(r"^\s*\d+(\.\d+)*\.?\s+\S", tb):
        return None
    # 前段疑似编号标题（"3.3.1 局部抽排烟" 短行无句号）→ 不与其后正文拼接
    if re.match(r"^\s*\d+(\.\d+)*\.?\s+\S", ta) and "。" not in ta and len(ta) < 40:
        return None
    # 英文后段以大写开头 → 疑似新句，保守不拼；中文无大小写
    if tb[0].isupper():
        return None
    # 中中相接不加空格，其余加空格
    if _is_cjk(ta[-1]) and _is_cjk(tb[0]):
        return ta + tb
    return ta + " " + tb


def _merge_sentence_fragments(elements: list[dict]) -> list[dict]:
    """贪心链式合并断句：a+b 成功则替换 a、删 b，继续用合并结果比下一个。"""
    if len(elements) < 2:
        return elements
    out: list[dict] = []
    i = 0
    while i < len(elements):
        cur = elements[i]
        # 尝试与后续元素链式合并
        j = i + 1
        while j < len(elements):
            merged = _try_join(cur, elements[j])
            if merged is None:
                break
            cur = dict(cur, text=merged)
            j += 1
        out.append(cur)
        i = j
    return out


def _enhance_headings(elements: list[dict]) -> None:
    """标题识别增强（可读性优化）：
    - 编号标题（1. / 1.2 / 第X章）、全大写短行 → 标 heading 并规范层级
    - 字号显著大于正文的短行 → heading（仅对 paragraph）
    对 OpenDataLoader 已标的 heading 也会重新规范层级（其层级常混乱）。"""
    # 该页正文众数字号（标题不算）
    sizes = [el["fontSize"] for el in elements
             if el["type"] != "heading" and isinstance(el.get("fontSize"), (int, float))]
    body_size = max(set(sizes), key=sizes.count) if sizes else None

    for el in elements:
        if el["type"] not in ("paragraph", "heading"):
            continue
        text = el["text"].strip()
        if not text or len(text) > 80:
            continue
        # 排除年份开头的正文行（"2023 年的研究"/"2023 The ..."），防误标标题
        if re.match(r"^\s*\d{4}\s*年", text) or re.match(r"^\s*\d{4}\s+[A-Z]", text):
            continue
        m = _NUM_HEADING_RE.match(text)
        if m:
            # 正文段（含中文句号、或过长）不以数字开头当标题
            if "。" in text or len(text) > 60:
                continue
            depth = m.group(1).count(".") + 1
            first_word = m.group(2)
            # 排除 "3 A A" / "4 2020" 类：编号后首词是单字符或纯数字 → 不是标题
            if len(first_word) == 1 or first_word.isdigit():
                continue
            el["headingLevel"] = min(depth, 3)
            el["type"] = "heading"
            continue
        if _CN_HEADING_RE.match(text):
            el["headingLevel"] = 1
            el["type"] = "heading"
            continue
        if _CAPS_HEADING_RE.match(text):
            el["headingLevel"] = 1
            el["type"] = "heading"
            continue
        # 非编号标题：短行 + 字号明显大于正文（≥1.2x）→ 章节标题（仅 paragraph）
        if el["type"] != "paragraph":
            continue
        fs = el.get("fontSize")
        if body_size and isinstance(fs, (int, float)) and fs >= body_size * 1.2:
            if len(text) <= 30 and text[-1] not in _SENT_END:
                el["headingLevel"] = 1
                el["type"] = "heading"


def _table_has_content(text: str) -> bool:
    """表格是否含实际内容（' |  | ' 这种分隔符+空单元格不算）。"""
    return any(c.strip() for c in text.split("|"))


# 表格内容行的判定：短（≤180 字符）、不以句末标点结尾（可能以数字/括号结尾）
_TABLE_ROW_END = ".!?。！？"
# 排除明显不是表格行的开头：年份起句、图注、编号标题、LaTeX 公式、OCR 数学符号
_TABLE_ROW_EXCLUDE = re.compile(r"^\s*(\d{4}\s|fig\.?\s*\d|\d+(\.\d+)*\.\s|\$|\\[a-z]+|[ðþ¼√])")

def _is_table_row_candidate(el: dict) -> bool:
    """疑似表格内容行：短、无句末标点、非标题/图注/公式/刻度。"""
    if el["type"] != "paragraph":
        return False
    t = el["text"].strip()
    if not t:
        return False
    if len(t) > 180:
        return False
    if t[-1] in _TABLE_ROW_END:
        return False
    if _TABLE_ROW_EXCLUDE.match(t):
        return False
    # 行内含 OCR 数学符号（ð þ ¼ √ 等）→ 公式行，非表格
    if re.search(r"[ðþ¼√∑∫±≈≡]", t):
        return False
    # 纯数字/刻度行（"3.5"、"0.80"、"1E-08 1E-07"）→ 图表坐标轴
    if re.match(r"^[\d\s.+\-Ee%]+$", t):
        return False
    # 变量等式/图例（"d/r = 0"、"ha = h - r"、"kl/kaq = 1E-6"）→ 图表图例
    if re.match(r"^[a-zA-Z0-9/]+\s*=\s*", t):
        return False
    # 公式残留小词（"h2"、"where"、"and"、"1 r"、"q r2"）→ 非表格
    if len(t) <= 8 and t.islower():
        return False
    if re.match(r"^\d+\s+[a-z]", t):
        return False
    # 含从属连词的长行（the/that/which 等）→ 正文句子（表格行是短语/值，不用连词）
    if len(t) > 40 and re.search(r"\b(the|that|which|with|their|because|however)\b", t):
        return False
    return True


def _make_table_from_rows(rows: list[dict], first: dict) -> dict:
    """把连续表格行合并为一个 table 元素（text 每行一段，| 分列）。"""
    lines = []
    for r in rows:
        t = r["text"].strip()
        lines.append(t)
    return {
        "id": first["id"],
        "type": "table",
        "bbox": first["bbox"],
        "text": "\n".join(lines),
        "font": first.get("font"),
        "fontSize": first.get("fontSize"),
        "headingLevel": 0,
        "readingOrder": first["readingOrder"],
        "imageSrc": None,
    }


def _detect_table_runs(elements: list[dict]) -> list[dict]:
    """检测「表格内容区段」：候选行（短、无句末标点、非公式/标题）按 bbox top
    聚类成带，带间距紧凑（<60pt）则归同一区段，区段 ≥4 行 → 合并为 table 元素。
    不依赖 kids 顺序（表格行常散落在正文之间）。"""
    cands = [el for el in elements if _is_table_row_candidate(el)]
    if len(cands) < 4:
        return elements
    # 排除 figure 内部/紧邻的候选行（图表坐标轴/图例文字不算表格行，bbox 外扩 30pt）
    fig_boxes = [el["bbox"] for el in elements if el["type"] == "figure"]
    if fig_boxes:
        def _inside_figure(c: dict) -> bool:
            cx = (c["bbox"]["left"] + c["bbox"]["right"]) / 2
            cy = (c["bbox"]["bottom"] + c["bbox"]["top"]) / 2
            return any(
                fb["left"] - 30 <= cx <= fb["right"] + 30
                and fb["bottom"] - 30 <= cy <= fb["top"] + 30
                for fb in fig_boxes
            )
        cands = [c for c in cands if not _inside_figure(c)]
    if len(cands) < 4:
        return elements
    # 按 top 聚类成带（同带 top 差 < 30pt）
    cands_sorted = sorted(cands, key=lambda e: e["bbox"]["top"], reverse=True)
    bands: list[list[dict]] = [[cands_sorted[0]]]
    for c in cands_sorted[1:]:
        if abs(bands[-1][-1]["bbox"]["top"] - c["bbox"]["top"]) < 30:
            bands[-1].append(c)
        else:
            bands.append([c])
    # 带间距紧凑则合并为区段
    segments: list[list[dict]] = []
    cur = list(bands[0])
    for band in bands[1:]:
        cur_bottom = min(e["bbox"]["top"] for e in cur)
        band_top = max(e["bbox"]["top"] for e in band)
        if cur_bottom - band_top < 60:
            cur.extend(band)
        else:
            if len(cur) >= 4:
                segments.append(cur)
            cur = list(band)
    if len(cur) >= 4:
        segments.append(cur)
    if not segments:
        return elements

    used_ids = {e["id"] for seg in segments for e in seg}
    out: list[dict] = []
    # 区段按 top 降序（页面从上到下）输出为 table
    table_els = [
        _make_table_from_rows(seg, seg[0])
        for seg in sorted(segments, key=lambda s: max(e["bbox"]["top"] for e in s), reverse=True)
    ]
    for el in elements:
        if el["id"] in used_ids:
            continue
        out.append(el)
    # 把表格插回原位置：按 readingOrder 与剩余元素穿插（简单起见 append 到页尾前按 top 插）
    # 表格作为块级元素，按 top 排序后 merge
    merged = sorted(out + table_els, key=lambda e: (e["bbox"]["top"]), reverse=True)
    return merged


def _rebuild_empty_tables(elements: list[dict]) -> list[dict]:
    """修复 OpenDataLoader 表格空壳：
    1. 若能按 bbox 从同页散落段落重组出内容 → 填入表格；
    2. 若表格 bbox 内无内容且无散落文本可并入（引擎空壳/误判）→ 丢弃空表格
       （内容本来就在段落流里，保留段落即不丢内容，同时避免前端渲染空表格占位）。
    行 = top 聚类（相邻 top 差显著大则切行），列 = 行内按 left 排序。"""
    paragraphs = [el for el in elements if el["type"] == "paragraph"]
    out: list[dict] = []
    used_ids: set[str] = set()
    for el in elements:
        if el["type"] != "table" or _table_has_content(el["text"]):
            out.append(el)
            continue
        if not paragraphs:
            continue  # 无可重建来源 → 丢弃空壳表格
        b = el["bbox"]
        inside = [
            p for p in paragraphs
            if p["id"] not in used_ids
            and b["left"] <= (p["bbox"]["left"] + p["bbox"]["right"]) / 2 <= b["right"]
            and b["bottom"] <= (p["bbox"]["bottom"] + p["bbox"]["top"]) / 2 <= b["top"]
        ]
        if not inside:
            continue  # bbox 内无散落文本 → 空壳/误判，丢弃
        # 行聚类：top 降序（页面上→下），相邻 gap 显著大则新行
        inside_sorted = sorted(inside, key=lambda p: p["bbox"]["top"], reverse=True)
        tops = [p["bbox"]["top"] for p in inside_sorted]
        gaps = [tops[i] - tops[i + 1] for i in range(len(tops) - 1)]
        median_gap = sorted(gaps)[len(gaps) // 2] if gaps else 12.0
        row_threshold = max(median_gap * 2, 10)
        rows: list[list[dict]] = [[inside_sorted[0]]]
        for p in inside_sorted[1:]:
            if rows[-1][-1]["bbox"]["top"] - p["bbox"]["top"] > row_threshold:
                rows.append([p])
            else:
                rows[-1].append(p)
        lines = []
        for row in rows:
            row_sorted = sorted(row, key=lambda p: p["bbox"]["left"])
            lines.append(" | ".join(p["text"].strip() for p in row_sorted))
        el["text"] = "\n".join(lines)
        used_ids.update(p["id"] for p in inside)
        out.append(el)
    # 移除被并入表格的段落
    if used_ids:
        out = [el for el in out if not (el["type"] == "paragraph" and el["id"] in used_ids)]
    return out


def _post_process(pages: dict[int, list[dict]], page_sizes: list[tuple[float, float]]) -> None:
    """逐页应用：表格空壳重建 → 双栏重排 → 断句合并 → 标题增强（原地修改 pages）。"""
    for i, (w, _h) in enumerate(page_sizes):
        els = pages.get(i + 1)
        if not els:
            continue
        els = _rebuild_empty_tables(els)
        els = _detect_table_runs(els)
        if _is_two_column(els, w):
            els = _reorder_two_column(els, w)
        els = _merge_sentence_fragments(els)
        _enhance_headings(els)
        pages[i + 1] = els


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

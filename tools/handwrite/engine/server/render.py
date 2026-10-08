#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render.py — 把手写参数翻译成 Handright 的 Template，并输出 PNG 预览 / PDF。

设计要点：
  * 所有参数都是“像素”为单位，因为 Handright 内部就是按像素排版；
    页面尺寸按 dpi 从毫米换算（A4 = 210x297mm）。
  * 纸张可以是纯白、米黄、横线本、方格本——直接在背景图上画线，
    再让 Handright 把墨迹“盖”上去（它写的是整像素，所以线不会被墨晕开）。
  * PDF 三种写法：
      lossless —— 自己写 PDF（FlateDecode RGB），无损且支持彩色墨；
      g4       —— 交给 Pillow 存 1bit CCITT G4，体积极小（只能单色）；
      jpeg     —— Pillow 默认的 DCTDecode，兼容性最好但有振铃伪影。
"""
from __future__ import annotations

import io
import math
import time
import zlib
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import handright
from fontlib import FONTS_DIR, display_label
from PIL import Image, ImageDraw, ImageFont

MM_PER_INCH = 25.4
PAGE_PRESETS_MM = {
    "A4": (210.0, 297.0),
    "A5": (148.0, 210.0),
    "B5": (176.0, 250.0),
    "Letter": (215.9, 279.4),
}
MAX_TEXT_CHARS = 200_000


class RenderError(Exception):
    """参数冲突 / 无法排版，给前端展示友好提示用。"""


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _hex_to_rgb(value: str, fallback: Tuple[int, int, int]) -> Tuple[int, int, int]:
    if not value:
        return fallback
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return fallback
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return fallback


def _luminance(rgb: Tuple[int, int, int]) -> float:
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


@dataclass
class RenderParams:
    """一次渲染的全部可调参数（前端参数面板一一对应）。"""

    # —— 字体 ——
    font: str = "merged.ttf"
    font_size: int = 38

    # —— 页面 ——
    page_size: str = "A4"
    page_w_mm: float = 210.0
    page_h_mm: float = 297.0
    dpi: float = 150.0
    margin: int = 70

    # —— 行 / 字 ——
    line_spacing: int = 64
    line_spacing_sigma: float = 4.0
    font_size_sigma: float = 1.5
    word_spacing: int = 1
    word_spacing_sigma: float = 1.5

    # —— 笔迹抖动 ——
    jitter_x: float = 1.6
    jitter_y: float = 1.6
    perturb_theta: float = 0.06
    seed: str = ""
    grid_layout: bool = False

    # —— 墨色与纸张 ——
    ink: str = "#191919"
    paper: str = "blank"          # blank | lined | grid
    paper_color: str = "#ffffff"
    rule_color: str = "#cfd8e3"
    rule_spacing: int = 0         # 0 = 跟随行距
    margin_line: bool = False
    margin_line_color: str = "#f0b4b4"

    # —— 避头尾 ——
    start_chars: str = ""
    end_chars: str = "，。》？；：’”】｝、！％）,.>?;:]}!%)′″℃℉"

    # —— 输出 ——
    pdf_mode: str = "lossless"    # lossless | g4 | jpeg
    jpeg_quality: int = 88
    # 超采样倍数：先按 s 倍分辨率渲染（字体、行距、边距、抖动全部同比放大），
    # 再用 LANCZOS 降回目标尺寸 → 得到带抗锯齿的笔迹边缘。
    # 1 = 关闭（Handright 原始的纯 1 位硬边，最快）；2 = 默认；3 = 最细腻。
    supersample: int = 2

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, object]]) -> RenderParams:
        params = cls()
        if not data:
            return params
        fields = {f for f in params.__dataclass_fields__}
        for key, value in data.items():
            if key not in fields or value is None:
                continue
            current = getattr(params, key)
            try:
                if isinstance(current, bool):
                    setattr(params, key, bool(value) if not isinstance(value, str)
                            else value.strip().lower() in ("1", "true", "yes", "on"))
                elif isinstance(current, int) and not isinstance(current, bool):
                    setattr(params, key, round(float(value)))
                elif isinstance(current, float):
                    setattr(params, key, float(value))
                else:
                    setattr(params, key, str(value))
            except (TypeError, ValueError):
                continue
        params.sanitize()
        return params

    def sanitize(self) -> List[str]:
        """夹到合法范围，返回给用户看的提示。

        提示是“粘性”的：from_dict() 和 render() 都会调用本方法，多次调用
        不能把已经产生的提示弄丢（否则前端就看不到“行距已自动调整”这类信息）。
        """
        notes: List[str] = list(getattr(self, "_notes", []))
        self.font_size = int(_clamp(self.font_size, 8, 200))
        self.dpi = _clamp(self.dpi, 72.0, 600.0)
        self.margin = int(_clamp(self.margin, 0, 400))
        self.line_spacing = int(_clamp(self.line_spacing, 8, 400))
        self.line_spacing_sigma = _clamp(self.line_spacing_sigma, 0.0, 40.0)
        self.font_size_sigma = _clamp(self.font_size_sigma, 0.0, 20.0)
        self.word_spacing = int(_clamp(self.word_spacing, -20, 100))
        self.word_spacing_sigma = _clamp(self.word_spacing_sigma, 0.0, 40.0)
        self.jitter_x = _clamp(self.jitter_x, 0.0, 30.0)
        self.jitter_y = _clamp(self.jitter_y, 0.0, 30.0)
        self.perturb_theta = _clamp(self.perturb_theta, 0.0, 0.6)
        self.rule_spacing = int(_clamp(self.rule_spacing, 0, 400))
        self.jpeg_quality = int(_clamp(self.jpeg_quality, 30, 100))
        self.supersample = int(_clamp(self.supersample, 1, 3))

        # Handright 的硬性约束：line_spacing 必须 >= font_size
        if self.line_spacing < self.font_size:
            msg = f"行距必须 ≥ 字号，已自动把行距从 {self.line_spacing} 调到 {self.font_size}"
            if msg not in notes:
                notes.append(msg)
            self.line_spacing = self.font_size
        if self.word_spacing <= -self.font_size // 2:
            fixed = -(self.font_size // 2) + 1
            msg = f"字距下限是 -字号/2，已自动从 {self.word_spacing} 调到 {fixed}"
            if msg not in notes:
                notes.append(msg)
            self.word_spacing = fixed
        if self.page_size in PAGE_PRESETS_MM:
            self.page_w_mm, self.page_h_mm = PAGE_PRESETS_MM[self.page_size]
        else:
            self.page_w_mm = _clamp(self.page_w_mm, 50.0, 1000.0)
            self.page_h_mm = _clamp(self.page_h_mm, 50.0, 1000.0)
        if self.paper not in ("blank", "lined", "grid"):
            self.paper = "blank"
        if self.pdf_mode not in ("lossless", "g4", "jpeg"):
            self.pdf_mode = "lossless"
        if not self.font:
            self.font = "merged.ttf"
        self._notes = notes
        return notes

    # —— 派生量 ——
    def page_px(self, scale: int = 1) -> Tuple[int, int]:
        """页面像素尺寸。scale = 超采样倍数时的内部渲染尺寸。"""
        w = round(self.page_w_mm / MM_PER_INCH * self.dpi) * scale
        h = round(self.page_h_mm / MM_PER_INCH * self.dpi) * scale
        if max(w, h) > 65_000:
            raise RenderError("页面像素尺寸过大（超过 65000px），请降低 DPI 或纸张尺寸")
        return w, h

    def eff_rule_spacing(self) -> int:
        return self.rule_spacing or self.line_spacing

    @property
    def ink_rgb(self) -> Tuple[int, int, int]:
        return _hex_to_rgb(self.ink, (25, 25, 25))

    @property
    def is_single_color_ink(self) -> bool:
        return _luminance(self.ink_rgb) < 90


def build_background(params: RenderParams, scale: int = 1) -> Image.Image:
    """生成纸张：纯白 / 米黄 / 横线本 / 方格本。scale 见 RenderParams.supersample。"""
    w, h = params.page_px(scale)
    bg = Image.new("RGB", (w, h), _hex_to_rgb(params.paper_color, (255, 255, 255)))

    if params.paper == "blank":
        return bg

    draw = ImageDraw.Draw(bg)
    rule = _hex_to_rgb(params.rule_color, (207, 216, 227))
    margin = params.margin * scale
    font_size = params.font_size * scale
    line_spacing = params.line_spacing * scale
    spacing = params.eff_rule_spacing() * scale
    top = margin + line_spacing - font_size
    line_w = max(1, round(scale * 0.7))     # 1px 的线在 2x 下画 1~2px，降采样后是柔和的细线

    # 第一条横线画在第一行基线下方一点，之后每隔 spacing 一条
    y = top + font_size + 8 * scale
    while y < h - margin // 2:
        draw.line([(margin // 2, y), (w - margin // 2, y)], fill=rule, width=line_w)
        y += spacing

    if params.paper == "grid":
        x = margin // 2
        while x < w - margin // 2:
            draw.line([(x, margin // 2), (x, h - margin // 2)], fill=rule, width=line_w)
            x += spacing

    if params.margin_line:
        x = max((params.margin - 12) * scale, 8)
        draw.line([(x, 0), (x, h)],
                  fill=_hex_to_rgb(params.margin_line_color, (240, 180, 180)), width=line_w)

    return bg


def build_template(params: RenderParams, background: Image.Image,
                   font_path: Path, scale: int = 1) -> handright.Template:
    """按 scale 同比放大所有像素量，保证排版结果与 1x 完全一致。"""
    font = ImageFont.truetype(str(font_path), params.font_size * scale)
    features = frozenset()
    if params.grid_layout:
        features = frozenset({handright.Feature.GRID_LAYOUT})
    return handright.Template(
        background=background,
        font=font,
        line_spacing=params.line_spacing * scale,
        fill=params.ink_rgb,
        left_margin=params.margin * scale,
        top_margin=params.margin * scale,
        right_margin=params.margin * scale,
        bottom_margin=params.margin * scale,
        line_spacing_sigma=params.line_spacing_sigma * scale,
        font_size_sigma=params.font_size_sigma * scale,
        word_spacing=params.word_spacing * scale,
        word_spacing_sigma=params.word_spacing_sigma * scale,
        start_chars=params.start_chars,
        end_chars=params.end_chars,
        perturb_x_sigma=params.jitter_x * scale,
        perturb_y_sigma=params.jitter_y * scale,
        perturb_theta_sigma=params.perturb_theta,
        features=features,
    )


def font_path_for(name: str) -> Path:
    """只允许 fonts/ 目录下的 ttf，避免路径穿越。"""
    candidate = (FONTS_DIR / Path(name).name)
    if candidate.suffix.lower() not in (".ttf", ".otf", ".ttc"):
        raise RenderError(f"不支持的字体格式：{name}")
    if not candidate.is_file():
        raise RenderError(f"字体不存在：{name}")
    return candidate


def _check_layout(params: RenderParams, text: str) -> None:
    w, h = params.page_px()
    if len(text) > MAX_TEXT_CHARS:
        raise RenderError(f"文本太长（{len(text)} 字），上限 {MAX_TEXT_CHARS} 字")
    if h < params.margin * 2 + params.line_spacing:
        raise RenderError("页面高度放不下一行：请减小页边距或行距，或换更大的纸")
    if w < params.margin * 2 + params.font_size:
        raise RenderError("页面宽度放不下一个字：请减小页边距或字号")


def render(text: str, params: RenderParams) -> Dict[str, object]:
    """渲染正文，返回页面图片和统计信息。"""
    notes = params.sanitize()
    _check_layout(params, text)
    font_path = font_path_for(params.font)

    t0 = time.time()
    scale = params.supersample
    background = build_background(params, scale)
    template = build_template(params, background, font_path, scale)
    seed = params.seed.strip() or None
    pages = list(handright.handwrite(text, template, seed=seed))

    # 超采样降回目标分辨率：这一步产生抗锯齿的笔迹边缘（等价于 PDF 阅读器
    # 光栅化时做的平滑，也就是压缩包原版在阅读器里看起来的样子）。
    base_w, base_h = params.page_px()
    if scale > 1:
        pages = [p.resize((base_w, base_h), Image.LANCZOS) for p in pages]
    render_ms = int((time.time() - t0) * 1000)

    if not pages:
        raise RenderError("没有渲染出任何页面，请检查文本内容")

    if params.pdf_mode == "g4" and not params.is_single_color_ink:
        notes.append(
            f"CCITT G4 只能存单色，墨色 {params.ink} 会按亮度二值化成黑色；"
            "想保留彩色请用「无损」模式"
        )

    stats = {
        "chars": len(text),
        "lines": text.count("\n") + 1,
        "pages": len(pages),
        "render_ms": render_ms,
        "font": params.font,
        "font_label": display_label(params.font),
        "page_w": pages[0].width,
        "page_h": pages[0].height,
        "dpi": params.dpi,
        "pdf_mode": params.pdf_mode,
        "supersample": params.supersample,
        "render_px": f"{base_w * scale}x{base_h * scale}",
    }
    return {"pages": pages, "stats": stats, "params": params, "warnings": notes}


# ——————————————————————————————— 输出 ———————————————————————————————


def page_to_png(page: Image.Image, max_width: Optional[int] = None) -> bytes:
    """预览图：转成调色板 PNG（≤256 色）。

    纸色/墨色只有两种时就是 2 色 PNG，极小；开了超采样后会有抗锯齿灰阶，
    调色板仍然能无损地表达这些灰阶，同时体积远小于 RGB PNG。
    """
    img = page
    if max_width and img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, max(1, round(img.height * ratio))), Image.LANCZOS)

    rgb = img.convert("RGB")
    out = rgb.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.NONE)

    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def pages_to_pdf(pages: List[Image.Image], params: RenderParams) -> bytes:
    """按 pdf_mode 组装 PDF。"""
    if params.pdf_mode == "g4":
        buf = io.BytesIO()
        bits = [p.convert("1", dither=Image.NONE) for p in pages]
        bits[0].save(
            buf, format="PDF", save_all=True, append_images=bits[1:],
            resolution=params.dpi,
        )
        return buf.getvalue()

    if params.pdf_mode == "jpeg":
        buf = io.BytesIO()
        pages[0].save(
            buf, format="PDF", save_all=True, append_images=pages[1:],
            resolution=params.dpi, quality=params.jpeg_quality,
        )
        return buf.getvalue()

    return _write_lossless_pdf(pages, params.dpi)


def _indexed_planes(page: Image.Image) -> Tuple[bytes, bytes, int]:
    """把页面压成 16 色调色板 + 4bit/像素的索引数据（无损表达抗锯齿灰阶）。

    返回 (打包好的像素字节, 调色板 hex 字符串, 每行字节数)。
    """
    rgb = page.convert("RGB")
    quant = rgb.quantize(colors=16, method=Image.MEDIANCUT, dither=Image.NONE)
    palette = quant.getpalette() or []
    palette = (palette + [0] * 48)[:48]                 # 固定 16 色 → hival=15，索引=采样值
    width, height = quant.size
    idx = quant.tobytes()                                # 1 字节/像素的索引
    row_bytes = (width + 1) // 2
    out = bytearray(row_bytes * height)
    for y in range(height):
        src = y * width
        dst = y * row_bytes
        for x in range(0, width, 2):
            hi = idx[src + x]
            lo = idx[src + x + 1] if x + 1 < width else 0
            out[dst + (x >> 1)] = ((hi & 0x0F) << 4) | (lo & 0x0F)
    return bytes(out), bytes(palette).hex(), row_bytes


def _write_lossless_pdf(pages: List[Image.Image], dpi: float) -> bytes:
    """最小可用的 PDF 写入器：每页一个 FlateDecode 的 16 色索引图，无损。

    自己写是因为 Pillow 的 PDF 插件对非 1bit 图一律用 DCTDecode（JPEG，
    有损、笔画周围会有振铃伪影）。这里用 4bit 索引 + zlib，既保留抗锯齿
    灰阶（和阅读器里的观感一致），体积又只有 RGB 的二十分之一左右。
    """
    objects: List[bytes] = []
    page_objs: List[int] = []

    def add(obj: bytes) -> int:
        objects.append(obj)
        return len(objects)

    # 占位：1 = Catalog, 2 = Pages
    add(b"")   # 1
    add(b"")   # 2

    for page in pages:
        raw, palette_hex, _row_bytes = _indexed_planes(page)
        comp = zlib.compress(raw, 9)
        w, h = page.size
        pt_w = w / dpi * 72.0
        pt_h = h / dpi * 72.0

        img_obj = add(
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
            b"/ColorSpace [/Indexed /DeviceRGB 15 <%s>] /BitsPerComponent 4 "
            b"/Filter /FlateDecode /Length %d >>\nstream\n"
            % (w, h, palette_hex.encode(), len(comp))
            + comp
            + b"\nendstream"
        )
        content = b"q %.4f 0 0 %.4f 0 0 cm /Im0 Do Q" % (pt_w, pt_h)
        content_obj = add(
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
        )
        page_obj = add(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.4f %.4f] "
            b"/Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>"
            % (pt_w, pt_h, img_obj, content_obj)
        )
        page_objs.append(page_obj)

    kids = b" ".join(b"%d 0 R" % o for o in page_objs)
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_objs))

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: List[int] = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += (
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, xref_pos)
    )
    return bytes(out)


def describe(params: RenderParams, stats: Dict[str, object], warnings: List[str]) -> str:
    """底部日志条的内容（模仿 Overleaf 的编译日志）。"""
    lines = [
        f"[OK] 渲染完成 · {stats['pages']} 页 · {stats['render_ms']} ms",
        (
            f"字体 {stats['font']}（{stats['font_label']}）@ {params.font_size}px，"
            f"行距 {params.line_spacing}px，"
            f"纸张 {params.page_w_mm:.0f}x{params.page_h_mm:.0f}mm @ {params.dpi:.0f}dpi"
        ),
        (
            f"抖动 x={params.jitter_x} y={params.jitter_y} θ={params.perturb_theta}rad，"
            f"seed={params.seed.strip() or '(随机)'}，墨色 {params.ink}"
        ),
        (
            f"正文 {stats['chars']} 字 / {stats['lines']} 行 → {stats['pages']} 页，"
            f"像素 {stats['page_w']}x{stats['page_h']}，PDF 模式 {params.pdf_mode}"
        ),
    ]
    for w in warnings:
        lines.append(f"[提示] {w}")
    return "\n".join(lines)


def estimate_pages(text: str, params: RenderParams) -> int:
    """粗略估算页数（不渲染），用于输入时实时提示。"""
    try:
        w, h = params.page_px()
    except RenderError:
        return 0
    usable_w = w - 2 * params.margin
    usable_h = h - 2 * params.margin
    if usable_w <= 0 or usable_h <= 0:
        return 0
    per_line = max(1, int(usable_w // (params.font_size + params.word_spacing)))
    lines_per_page = max(1, int(usable_h // params.line_spacing))
    lines = 0
    for para in text.split("\n"):
        lines += max(1, math.ceil(len(para) / per_line)) if para else 1
    return max(1, math.ceil(lines / lines_per_page))


def defaults() -> Dict[str, object]:
    params = RenderParams()
    data = asdict(params)
    data["filename_hint"] = "作业.pdf"
    return data


def asdict_params(params: RenderParams) -> Dict[str, object]:
    """回显给前端（前端用它同步滑块，保证服务端夹取后的值可见）。"""
    return asdict(params)

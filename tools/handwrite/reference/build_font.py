#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_font.py — 把"中文手写体(主)"和"衬线体(补数学符号)"合并成一个字体文件。

为什么需要它：
  Handright 单字体渲染、不做字体回退。开源中文手写体（如 Google Fonts 的 Long
  Cang 龙藏体）几乎都不带希腊字母 αβλ、上下标 ₁₂ⁿᴴ、以及 ‖Σ∏⊥∈≠⇒ 这类数学符号，
  直接用会丢字。于是我们把两个字体合并：
    * 有手写体字形的字符  → 用手写体（保留手写感）
    * 手写体缺的字符       → 用 DejaVu Serif（覆盖全、含数学符号）
  这样 Handright 喂这一个 merged.ttf 就能渲染全部内容。

用法：
  python build_font.py \
      --handwriting /path/to/LongCang-Regular.ttf \
      --serif /usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf \
      --out fonts/merged.ttf
"""
import argparse
import sys

from fontTools.misc.transform import Transform
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont


def strip_extra_tables(font: TTFont) -> None:
    """删掉两个字体间会冲突的表（MATH/GSUB/GPOS 等），否则 pyftmerge 会报错。"""
    for t in ["MATH", "GSUB", "GPOS", "GDEF", "vhea", "vmtx", "BASE", "JSTF"]:
        if t in font:
            del font[t]


def rescale_upm(font: TTFont, target_upm: int) -> None:
    """把字体的单位 em 缩放到 target_upm，使两个字体可合并。"""
    upm = font["head"].unitsPerEm
    factor = target_upm / upm
    glyf = font["glyf"]
    glyph_set = font.getGlyphSet()
    for name in font.getGlyphOrder():
        pen = TTGlyphPen(glyph_set)
        tpen = TransformPen(pen, Transform(factor, 0, 0, factor, 0, 0))
        glyph_set[name].draw(tpen)
        glyf[name] = pen.glyph()
    font["head"].unitsPerEm = target_upm
    for name, (aw, lsb) in list(font["hmtx"].metrics.items()):
        font["hmtx"].metrics[name] = (max(1, round(aw * factor)), round(lsb * factor))
    font["hhea"].ascent = round(font["hhea"].ascent * factor)
    font["hhea"].descent = round(font["hhea"].descent * factor)
    font["hhea"].lineGap = round(font["hhea"].lineGap * factor)


def merge(handwriting_path: str, serif_path: str, out_path: str) -> None:
    hand = TTFont(handwriting_path)
    target_upm = hand["head"].unitsPerEm

    serif = TTFont(serif_path)
    strip_extra_tables(serif)
    rescale_upm(serif, target_upm)
    serif.save("_serif_rescaled.ttf")

    # fontTools.merge: 同一字符冲突时先出现的字体胜出 → 手写体(hand)优先。
    from fontTools.merge import Merger
    merged = Merger().merge([handwriting_path, "_serif_rescaled.ttf"])
    merged.save(out_path)

    # 自检
    cmap = TTFont(out_path).getBestCmap()
    need = "矩阵理论设证明 αβγλξημδεΣ∏⊥∈≠⇒‖∥₀₁₂ₙ⁻¹ᴴᵀ∀·"
    miss = [c for c in need if ord(c) not in cmap]
    if miss:
        print(f"[警告] 合并后仍缺字符: {''.join(miss)}", file=sys.stderr)
    else:
        print(f"[OK] 合并字体已生成: {out_path}（中文手写 + 数学符号全覆盖）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--handwriting", required=True,
                    help="中文手写体 ttf 路径，如 Google Fonts 的 LongCang-Regular.ttf")
    ap.add_argument("--serif", default="/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
                    help="补数学符号的衬线体 ttf，默认 DejaVu Serif")
    ap.add_argument("--out", default="fonts/merged.ttf")
    args = ap.parse_args()
    merge(args.handwriting, args.serif, args.out)


if __name__ == "__main__":
    main()

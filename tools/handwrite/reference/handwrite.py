#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
handwrite.py — 把一段文字渲染成"看起来像手写"的 A4 PDF。

基于开源库 Handright (https://github.com/Gsllchb/Handright)。
核心：用 PIL 在白底上逐字绘制，配合随机抖动（位移/旋转/字号）让排版不那么整齐，
从而产生手写感。内容完全由你提供的 txt 决定。

用法：
  python handwrite.py --input example/homework.txt --out 作业.pdf \
      --font fonts/merged.ttf --font-size 38

可调参数（抖动越大约潦草，越大约整齐）：
  --perturb 0.06   字符旋转 sigma
  --jitter  1.6    字符横/纵位移 sigma
  --line-spacing 64
"""
import argparse

import handright
from PIL import Image, ImageFont


def build_template(bg_size, font_path, font_size, fill, args):
    font = ImageFont.truetype(font_path, font_size)
    bg = Image.new("RGB", bg_size, "white")
    return handright.Template(
        background=bg,
        font=font,
        line_spacing=args.line_spacing,
        fill=fill,
        left_margin=args.margin,
        top_margin=args.margin,
        right_margin=args.margin,
        bottom_margin=args.margin,
        line_spacing_sigma=args.line_spacing_sigma,
        font_size_sigma=args.font_size_sigma,
        word_spacing=args.word_spacing,
        word_spacing_sigma=args.word_spacing_sigma,
        perturb_x_sigma=args.jitter,
        perturb_y_sigma=args.jitter,
        perturb_theta_sigma=args.perturb,
    )


def main():
    ap = argparse.ArgumentParser(description="把文字渲染成手写风格 A4 PDF")
    ap.add_argument("--input", required=True, help="待渲染的纯文本文件")
    ap.add_argument("--out", default="handwork.pdf", help="输出 PDF 路径")
    ap.add_argument("--font", default="fonts/merged.ttf",
                    help="字体路径（用 build_font.py 生成的 merged.ttf）")
    ap.add_argument("--font-size", type=int, default=38)
    ap.add_argument("--margin", type=int, default=70)
    ap.add_argument("--line-spacing", type=int, default=64)
    ap.add_argument("--line-spacing-sigma", type=float, default=4.0)
    ap.add_argument("--font-size-sigma", type=float, default=1.5)
    ap.add_argument("--word-spacing", type=int, default=1)
    ap.add_argument("--word-spacing-sigma", type=float, default=1.5)
    ap.add_argument("--jitter", type=float, default=1.6, help="字符横/纵位移抖动 sigma")
    ap.add_argument("--perturb", type=float, default=0.06, help="字符旋转抖动 sigma")
    ap.add_argument("--color", default="25,25,25", help="墨色 R,G,B，默认深灰")
    ap.add_argument("--dpi", type=float, default=150.0)
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as f:
        text = f.read()

    # A4 @ dpi 下的像素尺寸
    w = round(8.27 * args.dpi)
    h = round(11.69 * args.dpi)
    r, g, b = (int(x) for x in args.color.split(","))

    tpl = build_template((w, h), args.font, args.font_size, (r, g, b), args)
    pages = list(handright.handwrite(text, tpl))
    print(f"共 {len(pages)} 页")
    pages[0].save(args.out, save_all=True, append_images=pages[1:], resolution=args.dpi)
    print(f"已保存: {args.out}")


if __name__ == "__main__":
    main()

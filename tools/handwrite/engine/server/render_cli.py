#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render_cli.py — 渲染引擎的无头入口（不经过 HTTP）。

给 `node cli.mjs render/preview` 用，也可以单独跑：

    python engine/server/render_cli.py --input example/homework.txt --out out/作业.pdf
    python engine/server/render_cli.py --input a.txt --out a.pdf \
        --params '{"paper":"lined","ink":"#12305f","jitter_x":2.2}'
    python engine/server/render_cli.py --input a.txt --preview png --preview-dir out

参数含义与网页版完全一致（见 ../README.md 的参数表）；`--params` 是 JSON，
键名与 RenderParams 字段一致，优先级高于单独的命令行开关。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import render as render_mod  # noqa: E402 - 需要先把本目录加进 sys.path
from render import RenderError, RenderParams  # noqa: E402


def build_params(args: argparse.Namespace) -> RenderParams:
    data = {}
    if args.params:
        data.update(json.loads(args.params))
    for key in ("font", "ink", "paper", "pdf_mode", "seed", "page_size"):
        value = getattr(args, key, None)
        if value is not None:
            data[key] = value
    for key in ("font_size", "line_spacing", "line_spacing_sigma", "font_size_sigma",
                "word_spacing", "word_spacing_sigma", "margin", "dpi",
                "jitter_x", "jitter_y", "perturb_theta", "supersample", "jpeg_quality"):
        value = getattr(args, key, None)
        if value is not None:
            data[key] = value
    if args.grid_layout:
        data["grid_layout"] = True
    if args.lined:
        data.update({"paper": "lined", "margin_line": True})

    # 位置参数：--input/-i 没给就用 stdin 或示例
    return RenderParams.from_dict(data)


def main() -> int:
    ap = argparse.ArgumentParser(description="把文本渲染成手写风 A4 PDF / PNG（无 HTTP）")
    ap.add_argument("-i", "--input", help="正文文件（默认读 stdin）")
    ap.add_argument("-o", "--out", help="输出 PDF（默认 out/<input>.pdf）")
    ap.add_argument("--out-dir", default=None, help="输出目录（默认 <工具目录>/out）")
    ap.add_argument("--preview", choices=["png", "none"], default="none",
                    help="额外导出预览图：png=每页一张；none=不导出（默认）")
    ap.add_argument("--preview-dir", help="预览图目录（默认与 PDF 同目录）")
    ap.add_argument("--preview-width", type=int, default=0,
                    help="预览图宽度上限（0=原始像素）")
    ap.add_argument("--params", help="JSON 参数覆盖，如 '{\"jitter_x\":2.2}'")
    ap.add_argument("--font")
    ap.add_argument("--font-size", type=int)
    ap.add_argument("--line-spacing", type=int)
    ap.add_argument("--line-spacing-sigma", type=float)
    ap.add_argument("--font-size-sigma", type=float)
    ap.add_argument("--word-spacing", type=int)
    ap.add_argument("--word-spacing-sigma", type=float)
    ap.add_argument("--margin", type=int)
    ap.add_argument("--dpi", type=float)
    ap.add_argument("--jitter-x", type=float)
    ap.add_argument("--jitter-y", type=float)
    ap.add_argument("--perturb-theta", type=float, help="笔画旋转抖动 σ（弧度）")
    ap.add_argument("--ink", help="墨色，如 '#12305f'")
    ap.add_argument("--paper", choices=["blank", "lined", "grid"])
    ap.add_argument("--lined", action="store_true", help="等价于 --paper lined（带左侧红线）")
    ap.add_argument("--grid-layout", action="store_true", help="按等宽格子排版")
    ap.add_argument("--page-size", choices=["A4", "A5", "B5", "Letter"])
    ap.add_argument("--supersample", type=int, choices=[1, 2, 3],
                    help="抗锯齿倍数：1=关闭（最快）/ 2=默认 / 3=最细腻")
    ap.add_argument("--pdf-mode", choices=["lossless", "g4", "jpeg"])
    ap.add_argument("--jpeg-quality", type=int)
    ap.add_argument("--seed", help="固定随机种子（同样的输入可复现同一份手写）")
    ap.add_argument("--json", action="store_true", help="把结果以 JSON 输出到 stdout")
    args = ap.parse_args()

    tool_root = HERE.parent.parent
    out_dir = Path(args.out_dir) if args.out_dir else tool_root / "out"

    if args.input:
        text = Path(args.input).read_text(encoding="utf-8")
        stem = Path(args.input).stem
    else:
        if sys.stdin.isatty():
            ap.error("没有 --input 且 stdin 不是管道，不知道该渲染什么")
        text = sys.stdin.read()
        stem = "stdin"
    if not text.strip():
        print("❌ 正文是空的", file=sys.stderr)
        return 1

    try:
        params = build_params(args)
        t0 = time.time()
        result = render_mod.render(text, params)
    except RenderError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = Path(args.out) if args.out else out_dir / f"{stem}.pdf"
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    pdf_bytes = render_mod.pages_to_pdf(result["pages"], params)
    pdf_path.write_bytes(pdf_bytes)

    previews = []
    if args.preview == "png":
        preview_dir = Path(args.preview_dir) if args.preview_dir else pdf_path.parent
        preview_dir.mkdir(parents=True, exist_ok=True)
        for index, page in enumerate(result["pages"], start=1):
            png_path = preview_dir / f"{pdf_path.stem}-p{index}.png"
            png_path.write_bytes(render_mod.page_to_png(
                page, max_width=args.preview_width or None))
            previews.append(str(png_path))

    stats = dict(result["stats"])
    stats["elapsed_ms"] = int((time.time() - t0) * 1000)
    stats["pdf"] = str(pdf_path)
    stats["pdf_kb"] = round(len(pdf_bytes) / 1024, 1)
    stats["previews"] = previews
    stats["warnings"] = result["warnings"]

    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    else:
        print(render_mod.describe(params, stats, result["warnings"]))
        print(f"已保存: {pdf_path}（{stats['pdf_kb']} KB）")
        for png in previews:
            print(f"预览图: {png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

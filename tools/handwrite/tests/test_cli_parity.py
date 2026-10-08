#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_cli_parity.py — 校验「引擎默认参数」与「原始实现 reference/handwrite.py」是否一致。

做三件事：
  1. 直接从 reference/handwrite.py 源码里解析 argparse 默认值，逐项对账引擎的 cli_defaults；
  2. 对账 Handright 自己的 start_chars / end_chars 默认值（CLI 没传，走的就是这套默认）；
  3. 真跑一遍：原始 CLI 生成 PDF、引擎渲染同一段文字，比较页数、页面尺寸和墨迹覆盖率，
     确认两者观感一致（墨迹量差在 ±25% 以内，抗锯齿方式不同会有小差异）。

用法：
    node cli.mjs test parity          # 推荐：引擎会在需要时自动起服务
    .venv/bin/python tests/test_cli_parity.py
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

from PIL import Image

PROJECT = Path(__file__).resolve().parents[1]   # tools/handwrite
REFERENCE_CLI = PROJECT / "reference" / "handwrite.py"
BASE = os.environ.get("BASE", "http://127.0.0.1:8899").rstrip("/")
UA = {"User-Agent": "Mozilla/5.0 cli-parity-test"}
PASS: List[str] = []
FAIL: List[str] = []

# 网页版字段 ← handwrite.py 的命令行参数
FIELD_MAP = {
    "font_size": ("--font-size", int),
    "margin": ("--margin", int),
    "line_spacing": ("--line-spacing", int),
    "line_spacing_sigma": ("--line-spacing-sigma", float),
    "font_size_sigma": ("--font-size-sigma", float),
    "word_spacing": ("--word-spacing", int),
    "word_spacing_sigma": ("--word-spacing-sigma", float),
    "jitter_x": ("--jitter", float),
    "jitter_y": ("--jitter", float),
    "perturb_theta": ("--perturb", float),
    "dpi": ("--dpi", float),
}


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  {'✓' if cond else '✗'} {name}" + (f" — {detail}" if detail else ""))


def get_json(path: str) -> Dict[str, Any]:
    # BASE 由环境变量给出（默认本地服务），不是不可信输入
    req = urllib.request.Request(BASE + path, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def post_json(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **UA}, method="POST")
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.load(resp)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(BASE + url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def parse_cli_defaults() -> Dict[str, str]:
    """从 reference/handwrite.py 源码里抠出每个 --flag 的 default。"""
    src = REFERENCE_CLI.read_text(encoding="utf-8")
    defaults: Dict[str, str] = {}
    for m in re.finditer(r'add_argument\(\s*"(--[a-z0-9-]+)"((?:[^()]|\([^()]*\))*?)\)\s*\n', src, re.DOTALL):
        flag, body = m.group(1), m.group(2)
        # default 可能是带引号的字符串（比如 --color "25,25,25"），引号里的逗号不能当分隔符
        dm = re.search(r'default=("(?:[^"]*)"|\'(?:[^\']*)\'|[^,]+?)(?:,|$)', body)
        if dm:
            defaults[flag] = dm.group(1).strip()
    return defaults


def ink_reference(img: Image.Image) -> float:
    """墨迹覆盖率（含抗锯齿灰阶的视觉重量），百分比。"""
    hist = img.convert("L").histogram()
    total = sum(hist)
    return sum((255 - i) * hist[i] for i in range(256)) / (255 * total) * 100


def main() -> int:
    print(f"BASE = {BASE}")
    cfg = get_json("/api/config")
    cli = cfg["cli_defaults"]
    defaults = cfg["defaults"]

    print("\n[1] 逐项对账 handwrite.py 的 argparse 默认值")
    parsed = parse_cli_defaults()
    check("解析到 handwrite.py 的默认值", len(parsed) >= 10, f"{len(parsed)} 个参数")
    for field, (flag, cast) in FIELD_MAP.items():
        want = cast(parsed[flag]) if flag in parsed else None
        got = cli.get(field)
        check(f"{field:20s} == {flag}", want == got, f"CLI={want!r} web={got!r}")

    ink_rgb = tuple(int(cli["ink"].lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
    cli_color = tuple(int(x) for x in parsed.get("--color", "25,25,25").strip('"').split(",")[:3])
    check("ink == --color", ink_rgb == cli_color, f"CLI={cli_color} web={ink_rgb}")
    check("page_size/dpi 换算出的像素尺寸是 A4@150dpi",
          round(cli["page_w_mm"] / 25.4 * cli["dpi"]) == 1240
          and round(cli["page_h_mm"] / 25.4 * cli["dpi"]) == 1754,
          f"{cli['page_w_mm']}x{cli['page_h_mm']}mm @{cli['dpi']}dpi")
    check("font == --font 的字体", cli["font"] == "merged.ttf", cli["font"])
    check("paper 是纯白（CLI 用 Image.new('RGB', size, 'white')）",
          cli["paper"] == "blank" and cli["paper_color"].lower() == "#ffffff")
    check("seed 为空（CLI 不固定种子，每次都不一样）", cli.get("seed", "") == "")
    check("pdf_mode 之外的参数都来自 CLI（网页版新增项不参与对账）",
          set(cli) - set(defaults) == set())

    print("\n[2] 对账 Handright 的避头尾默认值（CLI 没传，走的就是它）")
    try:
        sys.path.insert(0, str(PROJECT / "engine" / "server"))
        from handright._template import Template
        check("end_chars == Template._DEFAULT_END_CHARS",
              cli["end_chars"] == Template._DEFAULT_END_CHARS,
              f"{len(cli['end_chars'])} 个字符")
        check("start_chars == Template._DEFAULT_START_CHARS",
              cli["start_chars"] == Template._DEFAULT_START_CHARS)
    except Exception as exc:  # noqa: BLE001 - 环境缺 handright 时给出可读的失败原因
        check("能导入 Handright 对账避头尾", False, str(exc))

    print("\n[3] 实跑对账：同一段文字，CLI vs 网页版")
    text_path = PROJECT / "example" / "homework.txt"
    text = text_path.read_text(encoding="utf-8")
    tmp = Path(tempfile.mkdtemp(prefix="parity-"))
    try:
        cli_pdf = tmp / "cli.pdf"
        subprocess.run(
            [str(PROJECT / ".venv/bin/python"), str(REFERENCE_CLI),
             "--input", str(text_path), "--out", str(cli_pdf)],
            cwd=PROJECT, check=True, capture_output=True)
        check("原始 CLI 能跑通（reference/handwrite.py）",
              cli_pdf.is_file() and cli_pdf.stat().st_size > 0,
              f"{cli_pdf.stat().st_size / 1024:.0f}KB")

        data = post_json("/api/render", {"text": text, "params": cli})
        stats = data["stats"]
        check("网页版按 cli_defaults 渲染成功", bool(data.get("ok")),
              f"{stats['pages']} 页 · {stats['render_ms']}ms · 超采样 {stats['supersample']}×")

        # CLI 页数与网页页数
        info = subprocess.run(["pdfinfo", str(cli_pdf)], capture_output=True,
                              text=True, check=False).stdout
        cli_pages = int(re.search(r"Pages:\s+(\d+)", info).group(1))
        check("页数一致", cli_pages == stats["pages"], f"CLI={cli_pages} web={stats['pages']}")

        if shutil.which("pdftoppm"):
            subprocess.run(["pdftoppm", "-r", "150", "-png", "-f", "1", "-l", "1",
                            str(cli_pdf), str(tmp / "cli")], check=True)
            cli_png = next(tmp.glob("cli-*.png"))
            web_png = tmp / "web.png"
            web_png.write_bytes(fetch(data["pages"][0]["url"]))
            a = Image.open(cli_png)
            b = Image.open(web_png)
            check("首页尺寸一致（±2px）",
                  abs(a.width - b.width) <= 2 and abs(a.height - b.height) <= 2,
                  f"CLI={a.size} web={b.size}")
            ma, mb = ink_reference(a), ink_reference(b)
            diff = abs(mb - ma) / ma
            check("墨迹覆盖率一致（±25%，两者抗锯齿方式不同）", diff <= 0.25,
                  f"CLI={ma:.2f}% web={mb:.2f}% 相对差 {diff * 100:.1f}%")
            if diff > 0.25:
                print(f"     提示：网页版超采样={stats['supersample']}×，可调到 1× 对比")
    except FileNotFoundError as exc:
        check("本地能跑 CLI 对比（跳过）", False, f"缺少工具：{exc}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

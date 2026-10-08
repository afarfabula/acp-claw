#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fontlib.py — 字体库：把手写体和数学符号衬线体合并，供 Web 端选择。

这个模块是 build_font.py 的工程化版本，差别有三点：
  1. 两个字体都会清理 MATH/GSUB/GPOS 等冲突表（build_font.py 只清了 serif 那个，
     遇到自带 MATH 表的手写体会崩在 MathGlyphInfo has no mergeMap）。
  2. 合并结果按“手写体文件名”缓存，合并过一次就不再重复合并。
  3. 提供字体清单（family / 中文名 / 覆盖率 / 大小）给前端下拉框用。

用法（批量构建所有已下载的手写体）：
    python fontlib.py --build-all
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import threading
from pathlib import Path
from typing import Dict, List, Optional

from fontTools.merge import Merger
from fontTools.misc.transform import Transform
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent.parent
FONTS_DIR = PROJECT_ROOT / "fonts"
SRC_DIR = FONTS_DIR / "src"

# 冲突表：两个字体里同时存在、且 pyftmerge 无法合并的表。
CONFLICT_TABLES = ("MATH", "GSUB", "GPOS", "GDEF", "vhea", "vmtx", "BASE", "JSTF")

# 合并后必须存在的字符（沿用 build_font.py 的自检字符集）
REQUIRED_CHARS = "矩阵理论设证明 αβγλξημδεΣ∏⊥∈≠⇒‖∥₀₁₂ₙ⁻¹ᴴᵀ∀·"

# 手写体中文名（前端下拉框展示用）
DISPLAY_NAMES = {
    "longcang": "龙藏体",
    "mashanzheng": "马善政楷书",
    "zhimangxing": "志莽行书",
    "liujianmaocao": "刘建毛草",
    "zcoolxiaowei": "站酷小薇",
}

_MERGE_LOCK = threading.Lock()

# 文件名别名：龙藏体就是仓库里自带的 merged.ttf，避免出现两个一模一样的字体。
NAME_ALIASES = {"longcang": "merged.ttf"}


def find_serif_font() -> Path:
    """找一个带完整数学符号的衬线体。优先 DejaVu Serif（仓库 README 的默认）。"""
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerifCondensed.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    ]
    for c in candidates:
        if Path(c).is_file():
            return Path(c)
    for root in ("/usr/share/fonts", "/usr/local/share/fonts"):
        for p in Path(root).rglob("*Serif*.ttf"):
            return p
    raise FileNotFoundError("找不到可用的衬线体（DejaVu Serif），请用 --serif 显式指定。")


def strip_extra_tables(font: TTFont) -> None:
    """删掉两个字体间会冲突的表（MATH/GSUB/GPOS 等），否则 Merger 会报错。"""
    for t in CONFLICT_TABLES:
        if t in font:
            del font[t]


def rescale_upm(font: TTFont, target_upm: int) -> None:
    """把字体的 unitsPerEm 缩放到 target_upm，使两个字体可合并。"""
    upm = font["head"].unitsPerEm
    if upm == target_upm:
        return
    factor = target_upm / upm
    glyf = font["glyf"]
    glyph_set = font.getGlyphSet()
    for name in font.getGlyphOrder():
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(TransformPen(pen, Transform(factor, 0, 0, factor, 0, 0)))
        glyf[name] = pen.glyph()
    font["head"].unitsPerEm = target_upm
    for name, (aw, lsb) in list(font["hmtx"].metrics.items()):
        font["hmtx"].metrics[name] = (max(1, round(aw * factor)), round(lsb * factor))
    font["hhea"].ascent = round(font["hhea"].ascent * factor)
    font["hhea"].descent = round(font["hhea"].descent * factor)
    font["hhea"].lineGap = round(font["hhea"].lineGap * factor)


def merge_fonts(
    handwriting: Path,
    out: Path,
    serif: Optional[Path] = None,
    verbose: bool = True,
) -> Dict[str, object]:
    """把手写体 + 数学符号衬线体合并成 out。

    同一字符冲突时先出现的字体胜出 → 手写体优先，缺的用衬线体补。
    """
    serif = serif or find_serif_font()
    handwriting = Path(handwriting)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with _MERGE_LOCK:
        hand = TTFont(str(handwriting))
        target_upm = hand["head"].unitsPerEm
        strip_extra_tables(hand)
        hand_path = out.parent / f".tmp-hand-{handwriting.stem}.ttf"
        hand.save(str(hand_path))
        del hand

        serif_font = TTFont(str(serif))
        strip_extra_tables(serif_font)
        rescale_upm(serif_font, target_upm)
        serif_path = out.parent / f".tmp-serif-{serif.stem}.ttf"
        serif_font.save(str(serif_path))
        del serif_font

        try:
            merged = Merger().merge([str(hand_path), str(serif_path)])
            merged.save(str(out))
        finally:
            for p in (hand_path, serif_path):
                try:
                    p.unlink()
                except OSError:
                    pass

    cmap = TTFont(str(out)).getBestCmap()
    missing = [c for c in REQUIRED_CHARS if ord(c) not in cmap]
    report = {
        "handwriting": handwriting.name,
        "serif": serif.name,
        "out": out.name,
        "missing": "".join(missing),
        "ok": not missing,
    }
    if verbose:
        if missing:
            print(f"[警告] {out.name} 合并后仍缺字符: {''.join(missing)}", file=sys.stderr)
        else:
            print(f"[OK] {out.name}：中文手写 + 数学符号全覆盖")
    return report


def merged_name_for(handwriting: Path) -> str:
    """merged-<family>.ttf，family 取文件名里第一段（去掉 -Regular 之类）。"""
    stem = Path(handwriting).stem
    stem = re.sub(
        r"[-_ ](Regular|Bold|Light|Medium|Italic|Book|SemiBold|Thin|Black)$",
        "", stem, flags=re.IGNORECASE,
    )
    slug = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower() or "custom"
    if slug in NAME_ALIASES:
        return NAME_ALIASES[slug]
    return f"merged-{slug}.ttf"


def ensure_merged(handwriting: Path, serif: Optional[Path] = None) -> Path:
    """返回手写体对应的合并字体路径，没有就现场合并。"""
    out = FONTS_DIR / merged_name_for(handwriting)
    if out.is_file() and out.stat().st_size > 0:
        return out
    merge_fonts(Path(handwriting), out, serif=serif)
    return out


def font_family_of(path: Path) -> str:
    try:
        name = TTFont(str(path), lazy=True)["name"].getDebugName(1)
        return name or Path(path).stem
    except Exception:  # noqa: BLE001 - 读不出字体名就退回文件名，不该因此报错
        return Path(path).stem


def display_label(font_id: str) -> str:
    base = Path(font_id).stem
    if base.startswith("merged"):
        base = base[len("merged"):].lstrip("-_")
    key = re.sub(r"[^a-z0-9]+", "", base.lower())
    title = DISPLAY_NAMES.get(key)
    if title:
        return title
    if not key:
        return "龙藏体"
    return base


def _coverage_pct(path: Path) -> int:
    """GB2312 汉字覆盖率，给前端显示。"""
    try:
        cmap = TTFont(str(path), lazy=True).getBestCmap()
    except Exception:  # noqa: BLE001
        return 0
    total = found = 0
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except Exception:  # noqa: BLE001
                continue
            if "\u4e00" <= ch <= "\u9fff":
                total += 1
                if ord(ch) in cmap:
                    found += 1
    return round(found / total * 100) if total else 0


def list_fonts(refresh: bool = False) -> List[Dict[str, object]]:
    """列出可选的合并字体（fonts/merged*.ttf）。"""
    cache_file = FONTS_DIR / ".fontlist.json"
    if cache_file.is_file() and not refresh:
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            if cached:
                return cached
        except Exception:  # noqa: BLE001
            pass

    items: List[Dict[str, object]] = []
    for path in sorted(FONTS_DIR.glob("merged*.ttf")):
        items.append({
            "id": path.name,
            "label": display_label(path.name),
            "family": font_family_of(path),
            "size_kb": round(path.stat().st_size / 1024),
            "coverage": _coverage_pct(path),
        })
    # merged.ttf（仓库自带的默认字体）排在最前
    items.sort(key=lambda i: (i["id"] != "merged.ttf", str(i["label"])))
    try:
        cache_file.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    return items


def build_all(serif: Optional[Path] = None) -> List[Dict[str, object]]:
    """把 fonts/src/*.ttf 全部合并到 fonts/。"""
    reports: List[Dict[str, object]] = []
    sources = sorted(SRC_DIR.glob("*.ttf"))
    if not sources:
        print(f"没有找到源手写体：{SRC_DIR}", file=sys.stderr)
        return reports
    for src in sources:
        out = FONTS_DIR / merged_name_for(src)
        if out.is_file():
            print(f"[跳过] {out.name} 已存在（删除该文件可强制重新合并）")
            continue
        reports.append(merge_fonts(src, out, serif=serif))
    list_fonts(refresh=True)
    return reports


def main() -> None:
    ap = argparse.ArgumentParser(description="字体合并 / 字体清单")
    ap.add_argument("--handwriting", help="手写体 ttf")
    ap.add_argument("--serif", help="补数学符号的衬线体 ttf")
    ap.add_argument("--out", help="输出路径")
    ap.add_argument("--build-all", action="store_true", help="合并 fonts/src 下所有手写体")
    ap.add_argument("--list", action="store_true", help="打印字体清单")
    args = ap.parse_args()

    serif = Path(args.serif) if args.serif else None
    if args.build_all:
        build_all(serif=serif)
    elif args.handwriting:
        out = Path(args.out) if args.out else FONTS_DIR / merged_name_for(args.handwriting)
        merge_fonts(Path(args.handwriting), out, serif=serif)
    if args.list or not (args.build_all or args.handwriting):
        print(json.dumps(list_fonts(refresh=True), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

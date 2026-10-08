#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_fonts.py — 下载网页版用的 5 款开源中文手写体（SIL OFL 1.1）。

仓库里不放字体二进制（50MB+），克隆后跑一次这个脚本 + fontlib 重建就行：

    node cli.mjs fonts --fetch --build      # 从工具根目录一行搞定
    # 或者手动：
    python engine/server/fetch_fonts.py          # 下载到 fonts/src/
    python engine/server/fontlib.py --build-all  # 合并数学符号 → fonts/merged*.ttf

字体来源是 Google Fonts 官方仓库的镜像（jsdelivr 加速），也可以自己从
https://fonts.google.com 下载同名文件放进 fonts/src/。
"""
from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parent.parent / "fonts" / "src"

# ofl 路径 → 文件名（都是 Google Fonts 仓库里的手写体，OFL 1.1）
FONTS = {
    "longcang/LongCang-Regular.ttf": "龙藏体",
    "mashanzheng/MaShanZheng-Regular.ttf": "马善政楷书",
    "zhimangxing/ZhiMangXing-Regular.ttf": "志莽行书",
    "liujianmaocao/LiuJianMaoCao-Regular.ttf": "刘建毛草",
    "zcoolxiaowei/ZCOOLXiaoWei-Regular.ttf": "站酷小薇",
}

MIRRORS = [
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/{path}",
    "https://raw.githubusercontent.com/google/fonts/main/ofl/{path}",
]

UA = {"User-Agent": "Mozilla/5.0 handwrite-web font fetcher"}


def download(url: str, dest: Path, timeout: int = 120) -> None:
    req = urllib.request.Request(url, headers=UA)          # 固定 HTTPS 地址，不是不可信输入
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    if len(data) < 100_000:
        raise ValueError(f"返回内容太小（{len(data)} 字节），可能不是字体")
    dest.write_bytes(data)


def verify(path: Path) -> str:
    """确认是能打开的 TrueType，并返回字体名 + GB2312 覆盖率。"""
    font = TTFont(str(path), lazy=True)
    cmap = font.getBestCmap()
    total = found = 0
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except Exception:  # noqa: BLE001 - 非法编码组合，跳过即可
                continue
            if "\u4e00" <= ch <= "\u9fff":
                total += 1
                if ord(ch) in cmap:
                    found += 1
    family = font["name"].getDebugName(1) or path.stem
    return f"{family} · GB2312 {found / total * 100:.0f}%"


def main() -> int:
    ap = argparse.ArgumentParser(description="下载开源中文手写体到 fonts/src/")
    ap.add_argument("--force", action="store_true", help="已存在也重新下载")
    args = ap.parse_args()

    SRC_DIR.mkdir(parents=True, exist_ok=True)
    failed = []
    for rel, label in FONTS.items():
        name = Path(rel).name
        dest = SRC_DIR / name
        if dest.is_file() and not args.force:
            try:
                print(f"[跳过] {name} 已存在（{verify(dest)}）")
                continue
            except Exception as exc:  # noqa: BLE001 - 文件坏了就重下
                print(f"[重下] {name} 无法解析：{exc}")

        for mirror in MIRRORS:
            url = mirror.format(path=rel)
            try:
                t0 = time.time()
                download(url, dest)
                print(f"[OK] {name}（{label}）← {url.split('/')[2]}  "
                      f"{dest.stat().st_size / 1024 / 1024:.1f}MB  {time.time() - t0:.1f}s  {verify(dest)}")
                break
            except (urllib.error.URLError, ValueError, TimeoutError) as exc:
                print(f"[失败] {url} → {exc}")
        else:
            failed.append(name)

    if failed:
        print(f"\n以下字体没下下来：{', '.join(failed)}", file=sys.stderr)
        print("可以手动从 https://fonts.google.com 下载后放进 fonts/src/", file=sys.stderr)
        return 1
    print("\n下一步：python engine/server/fontlib.py --build-all（或 node cli.mjs fonts --build）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

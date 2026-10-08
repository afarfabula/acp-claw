#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""screenshot.py — 用无头浏览器给界面拍几张图，方便肉眼验收 / 回归对比。

用法：
    python webapp/tests/screenshot.py            # 默认 http://127.0.0.1:8899
依赖：playwright（.venv/bin/pip install playwright && playwright install chromium）
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8899").rstrip("/")
# 默认把截图写到 /tmp（可用 SHOT_OUT 覆盖）：只是临时产物，不污染仓库
OUT = Path(os.environ.get("SHOT_OUT", "/tmp/handwrite-shots"))  # noqa: S108


def shot(page, name: str) -> None:
    path = OUT / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    print(f"  → {path}  ({path.stat().st_size // 1024} KB)")


def wait_idle(page, timeout: int = 180_000) -> None:
    """等渲染真正结束（#loading 遮罩由 compile() 的 finally 负责隐藏）。"""
    page.wait_for_function(
        "() => { const el = document.querySelector('#loading'); return !!el && el.hidden === true; }",
        timeout=timeout,
    )
    page.wait_for_timeout(250)


def param_probe(page) -> dict:
    """读几个关键控件的当前值，用来断言「载入示例 / 撤销参数」真的改了参数。"""
    return page.evaluate(
        """() => {
            const val = (key) => {
                const sel = `.field[data-field="${key}"] input, .field[data-field="${key}"] select`;
                const el = document.querySelector(sel);
                return el ? String(el.value) : null;
            };
            const card = document.querySelector('.font-card.is-active');
            const chip = document.querySelector('#parity-footer');
            return { jitter_x: val('jitter_x'), paper: val('paper'),
                     ink: val('ink'), font: card ? card.dataset.font : null,
                     page_size: val('page_size'), supersample: val('supersample'),
                     parity: chip ? chip.textContent.trim() : null };
        }"""
    )


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1680, "height": 1000},
                                device_scale_factor=1)
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        print("[1] 首屏（空状态）")
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(600)
        shot(page, "01-empty")

        print("[2] 载入示例 + 重新渲染")
        page.click("#btn-example")
        # 等示例文本真的填进编辑器（走公网时 fetch 可能比本地慢）
        page.wait_for_function(
            "() => { const el = document.querySelector('#text-stats');"
            " return el && !/^0 字/.test(el.textContent); }",
            timeout=60_000,
        )
        page.click("#btn-compile")
        page.wait_for_selector(".paper img", timeout=120_000)
        wait_idle(page)
        shot(page, "02-rendered")
        pages = page.eval_on_selector_all(".page-wrap", "els => els.length")
        print(f"     预览页数：{pages}")

        print("[3] 参数面板各标签")
        for tab in ("layout", "hand", "paper", "font", "out"):
            page.click(f'.tab[data-tab="{tab}"]')
            page.wait_for_timeout(350)
            shot(page, f"03-tab-{tab}")

        print("[4] 横线本 + 蓝笔 + 潦草预设 + 展开日志")
        page.click('.tab[data-tab="paper"]')
        page.click('.field[data-field="__preset_paper"] .preset:nth-child(2)')
        page.click('.field[data-field="__preset_ink"] .preset:nth-child(2)')
        page.click('.tab[data-tab="hand"]')
        page.click('.field[data-field="__preset_hand"] .preset:nth-child(3)')
        page.click("#log-toggle")
        page.click("#btn-compile")
        wait_idle(page)
        shot(page, "04-lined-blue")

        print("[5] 换字体（马善政楷书）")
        page.click('.tab[data-tab="font"]')
        page.wait_for_timeout(250)
        page.click('.font-card[data-font="merged-mashanzheng.ttf"]')
        page.click("#btn-compile")
        wait_idle(page)
        shot(page, "05-font-mashanzheng")

        print("[6] PDF 视图 + 放大")
        page.click('.seg button[data-view="pdf"]')
        page.wait_for_timeout(2500)
        shot(page, "06-pdf-view")
        page.click('.seg button[data-view="image"]')
        page.click("#zoom-in")
        page.click("#zoom-in")
        page.wait_for_timeout(600)
        shot(page, "07-zoomed")

        print("[7] 调坏参数 → 载入示例（应连参数一起覆盖）")
        page.click('.tab[data-tab="hand"]')
        page.click('.field[data-field="__preset_hand"] .preset:nth-child(4)')   # 狂草
        page.click('.tab[data-tab="paper"]')
        page.click('.field[data-field="__preset_paper"] .preset:nth-child(3)')  # 方格本
        page.click('.field[data-field="__preset_ink"] .preset:nth-child(3)')    # 红笔
        page.wait_for_timeout(300)
        wrecked = param_probe(page)
        page.screenshot(path=str(OUT / "08-wrecked-params.png"))
        page.click('.tab[data-tab="text"]')
        page.click("#btn-example")
        wait_idle(page)
        restored = param_probe(page)
        page.screenshot(path=str(OUT / "09-example-params.png"))
        ok = (restored["jitter_x"] == "1.6" and restored["paper"] == "blank"
              and restored["ink"] == "#191919" and restored["font"] == "merged.ttf")
        print(f"      调坏后={wrecked}")
        print(f"      载入示例后={restored}")
        if not ok:
            errors.append(f"载入示例没有覆盖全部参数：{restored}")

        print("[8] 撤销参数（回到上一次渲染那套）")
        page.click('.tab[data-tab="hand"]')
        page.click('.field[data-field="__preset_hand"] .preset:nth-child(4)')   # 再调坏一次
        page.wait_for_timeout(200)
        before = param_probe(page)
        page.click("#btn-compile")
        wait_idle(page)
        after_render = param_probe(page)
        page.click("#btn-undo")
        wait_idle(page)
        after_undo = param_probe(page)
        page.screenshot(path=str(OUT / "10-after-undo.png"))
        print(f"      调坏={before} → 渲染={after_render} → 撤销后={after_undo}")
        if after_undo["jitter_x"] != "1.6":
            errors.append(f"撤销参数没有回到 1.6，实际 {after_undo['jitter_x']}")

        print("[9] 一键对齐压缩包默认（并核对对账芯片）")
        page.click('.tab[data-tab="hand"]')
        page.click('.field[data-field="__preset_hand"] .preset:nth-child(2)')   # 自然
        page.click('.tab[data-tab="paper"]')
        page.click('.field[data-field="__preset_paper"] .preset:nth-child(4)')  # 米黄稿纸
        page.wait_for_timeout(300)
        off = param_probe(page)
        page.click("#btn-reset")          # 恢复压缩包默认并重渲染
        wait_idle(page)
        on = param_probe(page)
        page.screenshot(path=str(OUT / "12-parity-aligned.png"))
        print(f"      调偏后芯片: {off['parity']}")
        print(f"      对齐后芯片: {on['parity']}  参数: {on}")
        if "一致" not in (on["parity"] or ""):
            errors.append(f"一键对齐后芯片没有显示一致：{on['parity']}")
        if on["supersample"] != "2":
            errors.append(f"默认超采样应为 2，实际 {on['supersample']}")

        print("[10] 窄屏（响应式）")
        page.set_viewport_size({"width": 820, "height": 1000})
        page.wait_for_timeout(500)
        shot(page, "11-narrow")

        browser.close()
        if errors:
            print("\n控制台错误：")
            for e in errors[:20]:
                print("  ! " + e)
            return 1
        print("\n没有控制台错误。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

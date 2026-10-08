#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""smoke_test.py — 端到端冒烟测试（对着已在跑的服务打接口）。

用法：
    node cli.mjs test smoke                      # 推荐：引擎会在需要时自动起服务
    .venv/bin/python tests/smoke_test.py         # 默认 http://127.0.0.1:8899
    BASE=https://write.example.org .venv/bin/python tests/smoke_test.py

覆盖：健康检查、配置、示例文本、多种参数组合的渲染、预览图、PDF 下载、
以及参数冲突时是否给出友好错误。
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

BASE = os.environ.get("BASE", "http://127.0.0.1:8899").rstrip("/")
# 默认把产物写到 /tmp（可用 SMOKE_OUT 覆盖）：只是临时产物，不污染仓库
OUT = Path(os.environ.get("SMOKE_OUT", "/tmp/handwrite-smoke"))  # noqa: S108
PROJECT = Path(__file__).resolve().parents[1]   # tools/handwrite
PASS, FAIL = [], []

# Cloudflare 的 Bot Fight Mode 会拦 `Python-urllib/x.y` 这种默认 UA（返回 403），
# 所以测试时统一用一个普通浏览器 UA。
UA = os.environ.get(
    "SMOKE_UA",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0.0.0 Safari/537.36",
)


def request(path: str, method: str = "GET", payload: Optional[Dict[str, Any]] = None,
            timeout: float = 120.0) -> Tuple[int, bytes, Dict[str, str]]:
    data = None
    headers = {"User-Agent": UA}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    # BASE 由调用方通过环境变量给出（默认本地 http://127.0.0.1:8899），不是不可信输入
    req = urllib.request.Request(BASE + path, data=data, headers=headers,
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers or {})


def jload(body: bytes) -> Dict[str, Any]:
    try:
        return json.loads(body.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    mark = "✓" if cond else "✗"
    print(f"  {mark} {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    text = (PROJECT / "example" / "homework.txt").read_text(encoding="utf-8")
    print(f"BASE = {BASE}")

    print("\n[1] 基础接口")
    status, body, _ = request("/healthz")
    check("/healthz 200", status == 200, f"HTTP {status}")
    status, body, _ = request("/api/config")
    cfg = jload(body)
    check("/api/config 返回字体清单", status == 200 and len(cfg.get("fonts", [])) >= 1,
          f"{len(cfg.get('fonts', []))} 个字体")
    check("/api/config 有默认参数", len(cfg.get("defaults", {})) > 15,
          f"{len(cfg.get('defaults', {}))} 个字段")
    status, body, _ = request("/api/example")
    example = jload(body)
    check("/api/example 有示例文本", status == 200 and len(example.get("text", "")) > 100)
    ex_params = example.get("params", {}) or {}
    default_keys = set(cfg.get("defaults", {})) - {"filename_hint"}
    check("/api/example 带一整套参数", bool(ex_params) and len(ex_params) >= 25,
          f"{len(ex_params)} 个参数")
    check("/api/example 的参数无遗漏", default_keys and not (default_keys - set(ex_params)),
          f"缺少：{sorted(default_keys - set(ex_params))}")
    check("/api/config 也带示例参数",
          len(cfg.get("example_params", {}) or {}) >= 25)
    check("/api/config 带压缩包默认参数（供一键对齐）",
          len(cfg.get("cli_defaults", {}) or {}) >= 25
          and len(cfg.get("parity_fields", []) or []) >= 20,
          f"{len(cfg.get('parity_fields', []))} 个对账字段")
    check("默认开启超采样抗锯齿", int(cfg.get("defaults", {}).get("supersample", 0)) >= 2)
    status, body, _ = request("/")
    check("首页可访问", status == 200 and b"<title>" in body)
    for asset in ("/static/style.css", "/static/app.js", "/static/vendor/codemirror.bundle.js"):
        status, _, _ = request(asset)
        check(f"静态资源 {asset}", status == 200, f"HTTP {status}")

    print("\n[2] 渲染矩阵")
    cases = [
        ("默认龙藏体", {"font": "merged.ttf"}, text[:800]),
        ("马善政+横线本+蓝笔", {"font": "merged-mashanzheng.ttf", "paper": "lined",
                          "margin_line": True, "ink": "#12305f", "jitter_x": 2.0,
                          "jitter_y": 2.0, "perturb_theta": 0.1}, text[:800]),
        ("方格本+格子对齐", {"paper": "grid", "grid_layout": True, "font": "merged-zcoolxiaowei.ttf"},
         text[:400]),
        ("狂草抖动", {"jitter_x": 3.6, "jitter_y": 3.2, "perturb_theta": 0.16,
                   "font_size_sigma": 3.0}, text[:400]),
        ("G4 单色输出", {"pdf_mode": "g4", "ink": "#191919"}, text[:400]),
        ("JPEG 输出", {"pdf_mode": "jpeg", "jpeg_quality": 92}, text[:400]),
        ("行距小于字号（应自动修正）", {"font_size": 60, "line_spacing": 40}, text[:200]),
        ("固定种子可复现", {"seed": "smoke-42", "jitter_x": 2.0}, text[:300]),
        ("超采样 1×（关闭抗锯齿）", {"supersample": 1, "seed": "aa"}, text[:300]),
        ("超采样 3×（最细腻）", {"supersample": 3, "seed": "aa"}, text[:300]),
    ]
    jobs = {}
    for name, params, sample in cases:
        status, body, _ = request("/api/render", "POST",
                                  {"text": sample, "params": dict(params, seed=params.get("seed", ""))})
        ok = status == 200
        data = jload(body)
        if not ok or not data.get("ok"):
            check(name, False, f"HTTP {status} {data.get('error', '')[:80]}")
            continue
        stats = data["stats"]
        jobs[name] = data
        check(name, True,
              f"{stats['pages']} 页 {stats['render_ms']}ms PDF {data['pdf_kb']}KB "
              f"字体={stats['font_label']}")
        if data.get("warnings"):
            print(f"      提示: {data['warnings']}")

    print("\n[3] 预览图与 PDF")
    for name, data in jobs.items():
        job = data["job"]
        status, png, headers = request(f"/api/png/{job}/1.png")
        ok = status == 200 and png[:8] == b"\x89PNG\r\n\x1a\n"
        check(f"{name} · 预览图是合法 PNG", ok, f"{len(png)}B")
        if name == "默认龙藏体":
            (OUT / "page1.png").write_bytes(png)
        status, pdf, headers = request(f"/api/pdf/{job}.pdf?dl=1&name=smoke.pdf")
        is_pdf = status == 200 and pdf[:5] == b"%PDF-"
        check(f"{name} · PDF 可下载", is_pdf, f"{len(pdf) / 1024:.0f}KB")
        if name == "默认龙藏体":
            (OUT / "out.pdf").write_bytes(pdf)
        disp = headers.get("content-disposition", "")
        if name == "默认龙藏体":
            check("下载响应带文件名", "filename" in disp.lower(), disp)

    print("\n[4] 错误处理")
    status, body, _ = request("/api/render", "POST",
                              {"text": "x", "params": {"font": "../../etc/passwd"}})
    data = jload(body)
    check("非法字体路径被拒绝", status == 400 and not data.get("ok"),
          data.get("error", "")[:60])
    status, body, _ = request("/api/render", "POST", {"text": "x" * 200_001, "params": {}})
    data = jload(body)
    check("超长文本被拒绝", status == 400 and "太长" in data.get("error", ""),
          data.get("error", "")[:60])
    status, body, _ = request("/api/render", "POST", {"text": "", "params": {}})
    data = jload(body)
    check("空文本给出友好提示", status == 400 and "没有渲染" in data.get("error", ""),
          data.get("error", "")[:60])
    status, body, _ = request("/api/render", "POST",
                              {"text": "测试", "params": {"page_size": "B5", "dpi": 320}})
    data = jload(body)
    check("B5 + 320dpi 可渲染", status == 200 and data.get("ok"),
          f"{data.get('stats', {}).get('page_w')}x{data.get('stats', {}).get('page_h')}px")
    status, _, _ = request("/api/pdf/../../etc/passwd.pdf")
    check("路径穿越被挡住", status in (400, 404), f"HTTP {status}")

    print("\n[5] 确定性（同种子两次渲染应完全一致）")
    if "固定种子可复现" in jobs:
        job = jobs["固定种子可复现"]["job"]
        status, body, _ = request("/api/render", "POST",
                                  {"text": text[:300], "params": {"seed": "smoke-42", "jitter_x": 2.0}})
        same = jload(body)["stats"]["pages"] == jobs["固定种子可复现"]["stats"]["pages"]
        check("两次页数一致", same)
        _, png2, _ = request(f"/api/png/{jload(body)['job']}/1.png")
        _, png1, _ = request(f"/api/png/{job}/1.png")
        check("两次像素完全一致", png1 == png2)

    print(f"\n结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print(f"产物目录：{OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

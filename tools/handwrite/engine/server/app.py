#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""app.py — Web 服务：把一个 JSON 参数包变成手写风 A4 PDF。

接口：
  GET  /                     前端页面
  GET  /api/config           默认参数 + 字体清单 + 预设
  POST /api/render           渲染（返回预览图 URL、PDF URL、日志）
  GET  /api/png/{job}/{n}.png  单页预览图
  GET  /api/pdf/{job}.pdf      下载/预览 PDF（?dl=1 强制下载）
  POST /api/fonts            上传手写体 ttf，服务端自动合并数学符号后入库
  GET  /healthz              健康检查
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

import fontlib
import render as render_mod
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from render import RenderError, RenderParams

HERE = Path(__file__).resolve().parent
WEB_DIR = HERE.parent / "web"
PROJECT_DIR = HERE.parent.parent
# 渲染产物放临时目录（可用 HANDWRITE_WORKDIR 覆盖），只保留最近 40 次
# 渲染产物放临时目录（可用 HANDWRITE_WORKDIR 覆盖），只保留最近 40 次
WORK_DIR = Path(os.environ.get("HANDWRITE_WORKDIR", "/tmp/handwrite-web"))  # noqa: S108
JOBS_DIR = WORK_DIR / "jobs"
UPLOAD_DIR = fontlib.SRC_DIR
MAX_JOBS = 40
MAX_UPLOAD_BYTES = 80 * 1024 * 1024

JOBS_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

RENDER_SEMAPHORE = threading.BoundedSemaphore(8)

app = FastAPI(title="手写作业生成器", docs_url="/api/docs", openapi_url="/api/openapi.json")


class RenderRequest(BaseModel):
    text: str = Field(default="", description="要渲染的正文")
    params: Dict[str, object] = Field(default_factory=dict)


def _job_dir(job: str) -> Path:
    if not job or "/" in job or ".." in job:
        raise HTTPException(status_code=400, detail="非法的任务 ID")
    return JOBS_DIR / job


def _cleanup_jobs(keep: int = MAX_JOBS) -> None:
    """只保留最近的若干次渲染结果，避免 /tmp 越堆越大。"""
    try:
        jobs = sorted(JOBS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    except FileNotFoundError:
        return
    for old in jobs[keep:]:
        shutil.rmtree(old, ignore_errors=True)


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    # 静态资源带上 mtime 版本号：Cloudflare 默认会把 .js/.css 缓存 4 小时，
    # 带 ?v= 的新 URL 能立刻绕过旧缓存，用户不用手动强刷。
    for name in ("style.css", "app.js", "vendor/codemirror.bundle.js"):
        path = WEB_DIR / "static" / name
        if not path.is_file():
            continue
        stamp = int(path.stat().st_mtime)
        html = html.replace(f'"/static/{name}"', f'"/static/{name}?v={stamp}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/healthz")
def healthz() -> Dict[str, object]:
    return {"ok": True, "fonts": len(fontlib.list_fonts()), "jobs": len(list(JOBS_DIR.iterdir()))}


PRESETS: Dict[str, Dict[str, object]] = {
    "工整": {"jitter_x": 0.6, "jitter_y": 0.6, "perturb_theta": 0.02,
             "line_spacing_sigma": 1.2, "font_size_sigma": 0.4, "word_spacing_sigma": 0.4},
    "自然": {"jitter_x": 1.6, "jitter_y": 1.6, "perturb_theta": 0.06,
             "line_spacing_sigma": 4.0, "font_size_sigma": 1.5, "word_spacing_sigma": 1.5},
    "潦草": {"jitter_x": 2.6, "jitter_y": 2.4, "perturb_theta": 0.10,
             "line_spacing_sigma": 6.0, "font_size_sigma": 2.4, "word_spacing_sigma": 2.4},
    "狂草": {"jitter_x": 3.6, "jitter_y": 3.2, "perturb_theta": 0.16,
             "line_spacing_sigma": 9.0, "font_size_sigma": 3.4, "word_spacing_sigma": 3.4},
}

# 「压缩包原始实现」的参数真身：逐项对应 handwrite.py 的 argparse 默认值，
# 所以点一下就能回到「python handwrite.py --input example/homework.txt --out 作业.pdf」的效果。
# 任何一项都要和压缩包里的 handwrite.py 保持一致，webapp/tests/test_cli_parity.py 会自动校验。
CLI_DEFAULTS: Dict[str, object] = dict(
    render_mod.defaults(),
    font="merged.ttf",
    page_size="A4",
    dpi=150.0,
    margin=70,
    font_size=38,
    line_spacing=64,
    line_spacing_sigma=4.0,
    font_size_sigma=1.5,
    word_spacing=1,
    word_spacing_sigma=1.5,
    jitter_x=1.6,
    jitter_y=1.6,
    perturb_theta=0.06,
    seed="",                       # CLI 不固定种子：每次渲染都不一样
    grid_layout=False,
    ink="#191919",
    paper="blank",
    paper_color="#ffffff",
    rule_color="#bccbdd",
    rule_spacing=0,
    margin_line=False,
    margin_line_color="#f0b4b4",
    # start_chars / end_chars 用 RenderParams 的默认值 —— 它俩就是 Handright 的
    # Template._DEFAULT_START_CHARS / _DEFAULT_END_CHARS（CLI 没传，走同一套默认）。
)
CLI_DEFAULTS.pop("filename_hint", None)

# 「载入示例」= 压缩包那套参数（正文 + 全部参数一起覆盖）
EXAMPLE_PARAMS: Dict[str, object] = dict(
    CLI_DEFAULTS,
    # 输出格式是网页版新增的选项，不影响字形观感：默认无损、2x 超采样抗锯齿
    pdf_mode="lossless",
    jpeg_quality=88,
    supersample=2,
)


INK_PRESETS: Dict[str, Dict[str, object]] = {
    "黑笔": {"ink": "#191919"},
    "蓝笔": {"ink": "#12305f"},
    "红笔": {"ink": "#8f1d1d"},
    "铅笔": {"ink": "#5a5a5a"},
}
PAPER_PRESETS: Dict[str, Dict[str, object]] = {
    "白纸": {"paper": "blank", "paper_color": "#ffffff"},
    "横线本": {"paper": "lined", "paper_color": "#fffdf7", "rule_color": "#bccbdd",
               "rule_spacing": 0, "margin_line": True},
    "方格本": {"paper": "grid", "paper_color": "#fffdf7", "rule_color": "#c8d4e2",
               "rule_spacing": 0, "margin_line": False},
    "米黄稿纸": {"paper": "blank", "paper_color": "#fbf6e8"},
}

# 和压缩包对齐的"观感参数"：这些字段才决定字长什么样。
# pdf_mode / jpeg_quality / supersample 是网页版新增的输出与抗锯齿选项，不计入对齐比较。
PARITY_FIELDS = (
    "font", "font_size", "page_size", "dpi", "margin", "line_spacing",
    "line_spacing_sigma", "font_size_sigma", "word_spacing", "word_spacing_sigma",
    "jitter_x", "jitter_y", "perturb_theta", "seed", "grid_layout", "ink",
    "paper", "paper_color", "rule_color", "rule_spacing", "margin_line",
    "margin_line_color", "start_chars", "end_chars",
)


@app.get("/api/config")
def config() -> Dict[str, object]:
    return {
        "defaults": render_mod.defaults(),
        "cli_defaults": CLI_DEFAULTS,
        "example_params": EXAMPLE_PARAMS,
        "fonts": fontlib.list_fonts(),
        "presets": {
            "handwriting": PRESETS,
            "ink": INK_PRESETS,
            "paper": PAPER_PRESETS,
            # 一键回到压缩包原始实现的全部参数
            "cli": {"压缩包原始默认（CLI 等价）": CLI_DEFAULTS},
        },
        "page_presets": {k: list(v) for k, v in render_mod.PAGE_PRESETS_MM.items()},
        "limits": {"max_text_chars": render_mod.MAX_TEXT_CHARS},
        "parity_fields": list(PARITY_FIELDS),
    }


@app.get("/api/example")
def api_example() -> Dict[str, object]:
    """示例正文 + 一套完整的推荐参数（前端「载入示例」会连参数一起覆盖）。"""
    path = PROJECT_DIR / "example" / "homework.txt"
    if not path.is_file():
        return {"ok": False, "text": "", "params": {}, "error": "示例文件不存在"}
    return {
        "ok": True,
        "text": path.read_text(encoding="utf-8"),
        "name": path.name,
        "params": EXAMPLE_PARAMS,
    }


@app.post("/api/render")
def api_render(req: RenderRequest) -> JSONResponse:
    params = RenderParams.from_dict(req.params)
    with RENDER_SEMAPHORE:
        try:
            result = render_mod.render(req.text, params)
        except RenderError as exc:
            return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - 兜底：任何渲染异常都变成 JSON 错误而不是 500 页面
            return JSONResponse(
                status_code=500,
                content={"ok": False, "error": f"{type(exc).__name__}: {exc}"},
            )

        job = f"{int(time.time() * 1000):x}-{secrets.token_hex(3)}"
        job_dir = _job_dir(job)
        job_dir.mkdir(parents=True, exist_ok=True)

        pages = result["pages"]
        page_meta: List[Dict[str, object]] = []
        for i, page in enumerate(pages, start=1):
            (job_dir / f"p{i}.png").write_bytes(render_mod.page_to_png(page, max_width=1600))
            page_meta.append({"n": i, "url": f"/api/png/{job}/{i}.png",
                              "w": page.width, "h": page.height})

        pdf_bytes = render_mod.pages_to_pdf(pages, params)
        (job_dir / "out.pdf").write_bytes(pdf_bytes)

        stats = dict(result["stats"])
        stats["pdf_kb"] = round(len(pdf_bytes) / 1024, 1)
        warnings = list(result["warnings"])
        log = render_mod.describe(params, stats, warnings)
        (job_dir / "meta.json").write_text(
            json.dumps({"params": render_mod.asdict_params(params), "stats": stats},
                       ensure_ascii=False, indent=2), encoding="utf-8")

    _cleanup_jobs()
    return JSONResponse({
        "ok": True,
        "job": job,
        "pages": page_meta,
        "pdf_url": f"/api/pdf/{job}.pdf",
        "pdf_kb": stats["pdf_kb"],
        "stats": stats,
        "warnings": warnings,
        "log": log,
        "params_echo": render_mod.asdict_params(params),
    })


@app.get("/api/png/{job}/{index}.png")
def api_png(job: str, index: int) -> FileResponse:
    path = _job_dir(job) / f"p{index}.png"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="预览图不存在")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})


@app.get("/api/pdf/{job}.pdf")
def api_pdf(job: str, dl: int = Query(default=0), name: Optional[str] = None) -> FileResponse:
    path = _job_dir(job) / "out.pdf"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="PDF 不存在")
    filename = (name or "手写作业").strip() or "手写作业"
    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"
    disposition = "attachment" if dl else "inline"
    return FileResponse(
        path,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"{disposition}; filename*=UTF-8''{_url_quote(filename)}",
            "Cache-Control": "no-cache",
        },
    )


def _url_quote(value: str) -> str:
    from urllib.parse import quote
    return quote(value, safe="")


@app.get("/api/fonts")
def api_fonts() -> Dict[str, object]:
    return {"fonts": fontlib.list_fonts(refresh=True)}


@app.post("/api/fonts")
async def api_upload_font(request: Request, file: UploadFile = File(...)) -> JSONResponse:
    name = Path(file.filename or "custom.ttf").name
    if Path(name).suffix.lower() not in (".ttf", ".otf", ".ttc"):
        return JSONResponse(status_code=400,
                            content={"ok": False, "error": "只支持 .ttf / .otf / .ttc 字体文件"})
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        return JSONResponse(status_code=400,
                            content={"ok": False, "error": "字体文件太大（上限 80MB）"})
    src_path = UPLOAD_DIR / name
    src_path.write_bytes(data)

    t0 = time.time()
    try:
        with RENDER_SEMAPHORE:
            merged = fontlib.ensure_merged(src_path)
    except Exception as exc:  # noqa: BLE001 - 字体合并失败要原样把原因告诉用户
        return JSONResponse(status_code=400, content={
            "ok": False,
            "error": f"字体合并失败：{type(exc).__name__}: {exc}",
        })
    fonts = fontlib.list_fonts(refresh=True)
    entry = next((f for f in fonts if f["id"] == merged.name), None)
    return JSONResponse({
        "ok": True,
        "font": entry,
        "fonts": fonts,
        "elapsed_ms": int((time.time() - t0) * 1000),
    })


app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")


@app.middleware("http")
async def _no_store_api(request: Request, call_next):
    """接口结果一律不缓存（预览图和 PDF 是 job 级唯一 URL，也不用 CDN 缓存）。"""
    response = await call_next(request)
    if request.url.path.startswith("/api/") or request.url.path == "/healthz":
        response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        # 默认监听所有网卡（内网 + 隧道都要能连上），需要收紧可用 HOST=127.0.0.1
        host=os.environ.get("HOST", "0.0.0.0"),  # noqa: S104
        port=int(os.environ.get("PORT", "8899")),
        log_level="info",
    )

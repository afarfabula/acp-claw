---
name: handwrite
description: 把一段文字渲染成「看起来像手写」的 A4 PDF（手写体 + 逐笔画抖动），支持中文作业/报告/情书，数学符号自动补齐
trigger: 当用户要求把文字/作业/报告渲染成手写体、生成"手写风格 PDF"、"假装手写的作业"、调整手写潦草程度或笔迹抖动参数时
---

# 手写作业生成器（handwrite）

代码在仓库 `acp-claw/tools/handwrite`，工作区入口是软链接 `~/.acp-claw/tools/handwrite`。
引擎是 [Handright](https://github.com/Gsllchb/Handright)（逐字排版 + 逐笔画随机扰动），
字体是中文字手写体与 DejaVu Serif 合并后的 `fonts/merged*.ttf`（补 α β λ ‖·‖² 等数学符号）。
无 GPU、无模型、纯本地，3 页作业约 4 秒。

## 常用命令

```bash
cd ~/.acp-claw/tools/handwrite

node cli.mjs doctor                 # 先体检：依赖 / 字体是否就绪
node cli.mjs setup --with-fonts     # 首次使用：建 .venv + 装依赖 + 下载并合并字体

node cli.mjs render -i 作业.txt -o 作业.pdf --preview png
node cli.mjs preview -i 作业.txt    # 只要预览图
cat 作业.txt | node cli.mjs render -o 作业.pdf

node cli.mjs serve                  # 网页版 http://127.0.0.1:8899（边看边调参数）
node cli.mjs params                 # 打印全部默认参数
node cli.mjs fonts                  # 有哪些手写体
node cli.mjs test smoke|parity      # 冒烟 / 与原始实现对账
```

## 直接可用的调用（不需要先 setup 也能跑，会自动退回系统 python）

```bash
node ~/.acp-claw/tools/handwrite/cli.mjs render \
  -i /path/to/text.txt -o /path/to/out.pdf --preview png
```

## 调参要点（`--params '<json>'`，键名详见 tools/handwrite/README.md）

| 想要的效果 | 怎么调 |
|---|---|
| 更潦草 | `{"jitter_x":2.6,"jitter_y":2.4,"perturb_theta":0.1,"line_spacing_sigma":6}` |
| 更工整 | `{"jitter_x":0.6,"jitter_y":0.6,"perturb_theta":0.02,"font_size_sigma":0.4}` |
| 蓝笔 / 红笔 | `--ink '#12305f'` / `--ink '#8f1d1d'` |
| 横线本 / 方格本 | `--paper lined` / `--paper grid`（可加 `{"margin_line":true}` 画左侧红线） |
| 字大一点 | `--font-size 44 --line-spacing 76`（行距必须 ≥ 字号） |
| 可复现同一份手写 | `--seed 任意字符串`（留空则每次都不同） |
| 体积最小的 PDF | `--pdf-mode g4`（单色 CCITT，3 页约 50KB） |
| 更快（牺牲平滑度） | `{"supersample":1}`（默认 2；1 就是原始 CLI 的硬边效果） |
| 换手写体 | `--font merged-mashanzheng.ttf`（马善政楷书）/ `merged-zcoolxiaowei.ttf` 等 |

默认参数与最初的 `reference/handwrite.py` **逐项一致**（有 `node cli.mjs test parity` 自动校验），
想要"原版观感"就保持默认。

## 回答用户时的要点

* 先跑 `node cli.mjs doctor`；缺依赖/字体时提示一句 `node cli.mjs setup --with-fonts`（约 1 分钟）。
* 渲染产物默认落在 `tools/handwrite/out/`，把绝对路径告诉用户，并提醒可以打印后拍照交作业。
* 用户说"效果不好/太潦草/太整齐"时，改 `jitter_*`、`perturb_theta`、`line_spacing_sigma` 即可；
  不要重写渲染代码。
* 用户想在浏览器里自己调，就跑 `node cli.mjs serve` 并给出 `http://127.0.0.1:8899`；
  网页版有「对账芯片」和「撤销参数（Alt+Z）」，改坏了能一键回退。
* 沙箱内可正常运行（纯本地 CPU，无网络需求；只有 `setup` / `fonts --fetch` / 上传字体需要网络）。

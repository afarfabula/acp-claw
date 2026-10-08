# reference —— 最初版本（默认参数的真身）

这两个脚本是项目的原始形态，功能上已被 `engine/` + `cli.mjs` 覆盖，但**故意保留**：

* `handwrite.py` —— 最初的单文件 CLI：文本 → 手写风 PDF。
  `node cli.mjs params` 打印的默认值、网页版「对账芯片」比对的基准，
  都来自这个文件的 argparse 默认值（`tests/test_cli_parity.py` 会解析源码逐项校验）。
* `build_font.py` —— 最初的手写体 + DejaVu Serif 合并脚本。
  它只清理了衬线体一侧的 `MATH/GSUB/GPOS` 冲突表，遇到自带 `MATH` 表的手写体会崩；
  `engine/server/fontlib.py` 是修好并工程化后的版本（两侧都清、带缓存、带覆盖率自检）。

直接跑原始版本（仍然可用，效果与"网页版 supersample=1"一致 —— 硬边、无抗锯齿）：

```bash
cd tools/handwrite
.venv/bin/python reference/handwrite.py --input example/homework.txt --out out/reference.pdf

# 原始字体合并（不推荐，用 engine/server/fontlib.py 代替）
.venv/bin/python reference/build_font.py \
    --handwriting fonts/src/LongCang-Regular.ttf \
    --serif /usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf \
    --out fonts/merged-custom.ttf
```

两者跑出来的差异（为什么不再直接用它们）：

1. **没有抗锯齿**：Handright 输出纯 1 位像素，屏幕上笔画发毛、断成虚线；
   阅读器/打印机显示 PDF 时才平滑，所以只有放到浏览器里看才暴露。
2. **参数少**：没有纸张（横线本/方格本）、墨色十六进制、超采样、PDF 压缩模式等选项。
3. **字体合并健壮性**：见上。

保留它们的价值：**可对账**。任何时候都能跑 `node cli.mjs test parity` 确认引擎与原始实现
的页数、页面尺寸、墨迹覆盖率一致（当前误差 ≈ 4%）。

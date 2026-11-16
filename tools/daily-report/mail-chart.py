#!/usr/bin/env python3

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_REGULAR = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
BG = "#f8fafc"
TEXT = "#0f172a"
MUTED = "#64748b"


def font(path, size):
    return ImageFont.truetype(path, size)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: mail-chart.py <input.json> <output.png>")

    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    output = Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)

    scale = 2
    width, height = 1200 * scale, 720 * scale
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)

    title_font = font(FONT_BOLD, 48 * scale)
    subtitle_font = font(FONT_REGULAR, 25 * scale)
    label_font = font(FONT_REGULAR, 28 * scale)
    count_font = font(FONT_BOLD, 22 * scale)
    small_font = font(FONT_REGULAR, 20 * scale)

    title = payload.get("title", "邮件分类")
    subtitle = payload.get("subtitle", "")
    items = [item for item in payload.get("items", []) if item.get("value", 0) > 0]
    total = sum(float(item["value"]) for item in items)

    draw.text((70 * scale, 45 * scale), title, fill=TEXT, font=title_font)
    if subtitle:
        draw.text((72 * scale, 115 * scale), subtitle, fill=MUTED, font=subtitle_font)

    box = (75 * scale, 190 * scale, 735 * scale, 665 * scale)
    if total == 0:
        draw.ellipse(box, fill="#e2e8f0")
        message = payload.get("emptyLabel", "暂无消费记录")
        bbox = draw.textbbox((0, 0), message, font=label_font)
        draw.text(
            (
                (box[0] + box[2] - (bbox[2] - bbox[0])) / 2,
                (box[1] + box[3] - (bbox[3] - bbox[1])) / 2,
            ),
            message,
            fill=MUTED,
            font=label_font,
        )
    else:
        start = -90.0
        for item in items:
            value = float(item["value"])
            extent = 360.0 * value / total
            draw.pieslice(box, start=start, end=start + extent, fill=item["color"])
            start += extent
        center = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        radius = (box[2] - box[0]) * 0.27
        draw.ellipse(
            (
                center[0] - radius,
                center[1] - radius,
                center[0] + radius,
                center[1] + radius,
            ),
            fill=BG,
        )
        total_text = payload.get("totalLabel", f"{total:,.2f}")
        bbox = draw.textbbox((0, 0), total_text, font=title_font)
        draw.text(
            (
                center[0] - (bbox[2] - bbox[0]) / 2,
                center[1] - (bbox[3] - bbox[1]) / 2 - 18 * scale,
            ),
            total_text,
            fill=TEXT,
            font=title_font,
        )
        unit = payload.get("unit", "")
        bbox = draw.textbbox((0, 0), unit, font=small_font)
        draw.text(
            (
                center[0] - (bbox[2] - bbox[0]) / 2,
                center[1] + 42 * scale,
            ),
            unit,
            fill=MUTED,
            font=small_font,
        )

    legend_x = 790 * scale
    legend_y = 205 * scale
    row_height = 52 * scale
    for item in items:
        value = float(item["value"])
        percent = 100.0 * value / total if total else 0
        draw.rounded_rectangle(
            (
                legend_x,
                legend_y + 12 * scale,
                legend_x + 27 * scale,
                legend_y + 39 * scale,
            ),
            radius=7 * scale,
            fill=item["color"],
        )
        draw.text(
            (legend_x + 48 * scale, legend_y),
            str(item["label"]),
            fill=TEXT,
            font=label_font,
        )
        value_format = payload.get("valueFormat", "integer")
        display_value = (
            f"{value:,.2f}" if value_format == "money" else f"{value:,}"
        )
        draw.text(
            (legend_x + 385 * scale, legend_y),
            f"{display_value}  {percent:.0f}%",
            fill=MUTED,
            font=count_font,
            anchor="ra",
        )
        legend_y += row_height

    footer = payload.get("footer", "")
    if footer:
        draw.text((72 * scale, 680 * scale), footer, fill=MUTED, font=small_font)

    resample = getattr(Image, "Resampling", Image).LANCZOS
    image.resize((1200, 720), resample).save(output, "PNG")
    print(json.dumps({"ok": True, "path": str(output), "total": total}))


if __name__ == "__main__":
    main()

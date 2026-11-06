#!/usr/bin/env python3
"""Compose the real browser captures into compact review sheets (no road pixels altered)."""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "docs/evidence/roads"
data = json.loads((OUT / "manifest.json").read_text())
W, H, HEADER, ROWHEAD = 840, 525, 104, 48
BG, FG, MUTED, ACCENT = "#0b121b", "#edf5fa", "#a6bac8", "#59c7ee"
font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
bold_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
font = ImageFont.truetype(font_path, 20)
small = ImageFont.truetype(font_path, 16)
bold = ImageFont.truetype(bold_path, 27)

def sheet(name, title, subtitle, columns):
    canvas = Image.new("RGB", (W * 2, HEADER + len(data["sites"]) * (H + ROWHEAD)), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((28, 20), title, font=bold, fill=FG)
    draw.text((28, 60), subtitle, font=small, fill=MUTED)
    for row, site in enumerate(data["sites"]):
        y = HEADER + row * (H + ROWHEAD)
        draw.text((28, y + 11), f'{site["name"]}   ·   X {site["x"]} / Z {site["z"]}', font=font, fill=ACCENT)
        for col, (suffix, label) in enumerate(columns):
            image = Image.open(OUT / f'{site["id"]}-{suffix}.jpg').convert("RGB")
            image = image.resize((W, H), Image.Resampling.LANCZOS)
            canvas.paste(image, (col * W, y + ROWHEAD))
            draw.rectangle((col * W + 12, y + ROWHEAD + H - 34, col * W + 218, y + ROWHEAD + H - 8), fill="#08101bdc")
            draw.text((col * W + 20, y + ROWHEAD + H - 32), label, font=small, fill=FG)
    canvas.save(OUT / name, quality=91, optimize=True)

sheet("00-3d-map-comparison.jpg", "Leonida Drive · дорожная сеть: 3D / карта",
      "Одинаковые мировые координаты и сопоставимый масштаб · реальные WebGL и Canvas кадры",
      [("top", "3D · вид сверху"), ("map", "Карта · тот же центр")])
sheet("01-opposite-angles.jpg", "Leonida Drive · проверка с противоположных сторон",
      "Юго-восток и северо-запад · видны съезды, верхние уровни, стыки и разметка",
      [("oblique-se", "3D · юго-восток"), ("oblique-nw", "3D · северо-запад")])

cards = []
for site in data["sites"]:
    cards.append(f'''<section><h2>{site["name"]}</h2><p>X {site["x"]} · Z {site["z"]} · {site["mpp"]} m/px</p><div class="grid">'''
                 + ''.join(f'<a href="{site["id"]}-{suffix}.jpg"><img loading="lazy" src="{site["id"]}-{suffix}.jpg"><span>{label}</span></a>'
                           for suffix, label in [("oblique-se", "3D · SE"), ("oblique-nw", "3D · NW"), ("top", "3D · top"), ("map", "Map")])
                 + '</div></section>')
(OUT / "index.html").write_text(f'''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Дороги Leonida — визуальные доказательства</title>
<style>body{{margin:0;background:{BG};color:{FG};font:16px/1.5 system-ui,sans-serif}}main{{max-width:1500px;margin:auto;padding:32px}}h1{{font-size:32px;margin-bottom:4px}}h2{{margin-bottom:0}}p{{color:{MUTED};margin-top:4px}}.hero{{display:block;margin:24px 0}}.hero img{{width:100%;border-radius:10px}}.grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}}.grid img{{width:100%;display:block;border-radius:7px}}a{{color:{ACCENT};text-decoration:none}}a span{{display:block;padding:5px}}section{{margin:38px 0}}@media(max-width:700px){{.grid{{grid-template-columns:1fr}}main{{padding:14px}}}}</style>
<main><h1>Дороги, развязки и перекрёстки</h1><p>16 исходных кадров реального запущенного проекта · YANIS v17 · без дорисовки дорожной геометрии</p>
<a class="hero" href="00-3d-map-comparison.jpg"><img src="00-3d-map-comparison.jpg"></a>
<a class="hero" href="01-opposite-angles.jpg"><img src="01-opposite-angles.jpg"></a>
<h2>Исходные кадры · 1440 × 900</h2>{''.join(cards)}</main></html>''')
print(OUT / "00-3d-map-comparison.jpg")
print(OUT / "01-opposite-angles.jpg")
print(OUT / "index.html")

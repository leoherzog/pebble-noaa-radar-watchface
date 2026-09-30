#!/usr/bin/env python3
"""Build a gallery contact sheet: contact.py <platform> [gallery-dir]

Lays the twelve tiles of screenshots/gallery/<platform>/ out four across and
three down at 2x nearest-neighbour, each under an "NN Name" label taken from
scenarios.json, and writes gallery/contact-<platform>.png. Tile size comes from
the tiles themselves, so any display shape works.

    uv run --with pillow python screenshots/tools/contact.py chalk
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
COLS, ROWS = 4, 3
SCALE = 2          # nearest-neighbour; any interpolation smears the slot text
GAP = 10           # between tiles and around the sheet
LABEL = 20         # label band above each tile
BG = (20, 20, 24)
INK = (240, 240, 240)


def main():
    platform = sys.argv[1]
    gallery = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "gallery")
    scen = [s for s in json.load(open(os.path.join(HERE, "scenarios.json")))
            if s["id"] <= COLS * ROWS]
    tiles = []
    for s in scen:
        path = os.path.join(gallery, platform, "%02d-%s.png" % (s["id"], s["slug"]))
        tiles.append((s, Image.open(path).convert("RGB")))
    w, h = tiles[0][1].size
    if any(t.size != (w, h) for _, t in tiles):
        sys.exit("tiles differ in size")

    tw, th = w * SCALE, h * SCALE
    sheet = Image.new("RGB", (GAP + COLS * (tw + GAP),
                              GAP + ROWS * (LABEL + th + GAP)), BG)
    d = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(10)
    for i, (s, t) in enumerate(tiles):
        x = GAP + (i % COLS) * (tw + GAP)
        y = GAP + LABEL + (i // COLS) * (LABEL + th + GAP)
        sheet.paste(t.resize((tw, th), Image.NEAREST), (x, y))
        d.text((x + 2, y - 15), "%02d %s" % (s["id"], s["name"]), font=font, fill=INK)

    out = os.path.normpath(os.path.join(gallery, "contact-%s.png" % platform))
    sheet.save(out)
    print("%s  %dx%d" % (out, sheet.width, sheet.height))


if __name__ == "__main__":
    main()

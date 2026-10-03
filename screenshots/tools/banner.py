#!/usr/bin/env python3
"""Build 720x320 appstore marketing banners from the staged store screenshots.

One banner per platform, since the Pebble/Rebble portals keep a separate asset
collection per platform. The hero store screenshot goes on the glass of the
Pebble developer site's device artwork, over the topo+radar backdrop that
banner_bg.py fetches.

    uv run --with pillow --with resvg-py python screenshots/tools/banner.py

Run from noaa-us-weather-radar/.
"""

import argparse
import io
import os

# Not cairosvg: it drops a button from the Time 2 frame and misdraws the Time
# Round's glass.
import resvg_py
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 720, 320

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "..", "store")
OUT = os.path.join(HERE, "..", "banner")

# The device artwork is not kept in this repo. It is read from the sdk-docs
# checkout beside the project, or from BANNER_FRAME_DIR.
FRAME_DIR = os.environ.get("BANNER_FRAME_DIR", os.path.join(
    HERE, "..", "..", "..", "reference", "sdk-docs", "source", "assets", "images", "pebbles"))
FRAME_URL = "https://developer.repebble.com/assets/images/pebbles/%s.svg"

# Fedora's redhat-display-fonts and redhat-text-fonts install here. Without
# root, extract the two RPMs (`dnf download`, `rpm2cpio | cpio -idm`) and point
# BANNER_FONT_DIR at the extracted usr/share/fonts/redhat.
FONT_DIR = os.environ.get("BANNER_FONT_DIR", "/usr/share/fonts/redhat")
F_BLACK = os.path.join(FONT_DIR, "RedHatDisplay-Black.otf")
F_BOLD = os.path.join(FONT_DIR, "RedHatDisplay-Bold.otf")
F_MED = os.path.join(FONT_DIR, "RedHatText-Medium.otf")
F_SEMI = os.path.join(FONT_DIR, "RedHatText-Bold.otf")

HERO = "1_minneapolis-derecho"        # the store screenshot on the glass
DEFAULT_BG = "washington-dc-severe"   # scenario 11, fetched by banner_bg.py

# Device frames by file stem, each with the display's top-left corner in frame
# pixels. The artwork is drawn in screen pixels, so at 1:1 the screenshot lands
# on the glass unscaled, and the origin centres it there.
FRAMES = {
    "core-time2-red": (47, 102),
    "core-time2-blue": (47, 102),
    "pebble-time-white": (62, 117),
    "pebble-time-black": (62, 117),
    "pebble-time-red": (62, 117),
    "core-time-round2-black-20": (36, 100),
    "core-time-round2-rosegold-14": (36, 100),
    "pebble-time-round-black-20": (55, 123),
    "pebble-time-round-red-14": (56, 123),
}

# frame:    a FRAMES key, the colour to swap
# cx, cy:   banner position of the frame's centre. Straps run off the top and
#           bottom edges. The Time 2 body is taller than the banner, so it sits
#           low: top lugs and strap in view, the lower glass running off.
# title_w:  widest the title may set before it meets the watch
PLATFORMS = {
    "emery": {"frame": "core-time2-red", "cx": 561, "cy": 188, "title_w": 354,
              "name": "Pebble Time 2"},
    "basalt": {"frame": "pebble-time-white", "cx": 572, "cy": 160, "title_w": 366,
               "name": "Pebble Time"},
    "gabbro": {"frame": "core-time-round2-rosegold-14", "cx": 548, "cy": 160, "title_w": 318,
               "name": "Pebble Round 2"},
    "chalk": {"frame": "pebble-time-round-red-14", "cx": 562, "cy": 160, "title_w": 354,
              "name": "Pebble Time Round"},
}

TITLE = ["NOAA US", "WEATHER RADAR"]
TAGLINE = "Live storm radar over a topo map of\nwherever you happen to be standing."
FOOTER = "NOAA · National Weather Service · USGS · United States only"

INK = (255, 255, 255)
DIM = (198, 207, 218)
FAINT = (139, 148, 161)

# NWS-ish reflectivity ramp, used as a thin accent rule under the title. It is
# not a legend: the face's live MRMS layer uses a different ramp.
RAMP = [
    (0x40, 0xE0, 0x40), (0x00, 0xC0, 0x00), (0x00, 0x90, 0x00),
    (0xFF, 0xFF, 0x00), (0xFF, 0xC0, 0x00), (0xFF, 0x80, 0x00),
    (0xFF, 0x00, 0x00), (0xC0, 0x00, 0x00), (0xFF, 0x00, 0xFF),
]


def shot(platform, scene):
    return Image.open(os.path.join(STORE, "%s_%s.png" % (platform, scene))).convert("RGBA")


def frame(name):
    """Rasterize a device frame at 1:1. Returns RGBA."""
    path = os.path.join(FRAME_DIR, name + ".svg")
    if not os.path.exists(path):
        raise SystemExit("no frame at %s -- save %s there, or point BANNER_FRAME_DIR "
                         "at a directory that has it" % (path, FRAME_URL % name))
    return Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_path=path))).convert("RGBA")


def watch(platform):
    """The device: its frame with the hero screenshot on the glass, over a drop
    shadow. Returns RGBA, the frame centred in it."""
    name = PLATFORMS[platform]["frame"]
    card = frame(name)
    # The screenshot goes on at native pixels and is never resampled: any
    # interpolation turns the halo'd slot text to mush. A round capture
    # carries the display's own mask as alpha.
    card.alpha_composite(shot(platform, HERO), FRAMES[name])

    pad = 40  # room for the shadow
    out = Image.new("RGBA", (card.width + pad * 2, card.height + pad * 2), (0, 0, 0, 0))
    sil = Image.new("L", out.size, 0)
    sil.paste(card.getchannel("A").point(lambda a: a * 190 // 255), (pad, pad + 10))
    out.putalpha(sil.filter(ImageFilter.GaussianBlur(14)))
    out.alpha_composite(card, (pad, pad))
    return out


def backdrop(bg_path):
    """The banner_bg.py fetch cropped to 720x320, blurred and scrimmed."""
    src = Image.open(bg_path).convert("RGB")
    k = max(W / src.width, H / src.height)
    if k != 1.0:
        src = src.resize((int(src.width * k + 0.5), int(src.height * k + 0.5)), Image.LANCZOS)
    left, top = (src.width - W) // 2, (src.height - H) // 2
    bg = src.crop((left, top, left + W, top + H)).convert("RGBA")
    bg = bg.filter(ImageFilter.GaussianBlur(1.6))
    return scrim(bg, 0.34)


def scrim(bg, knock):
    """Knock the image back, then lay a left-heavy gradient so the type reads."""
    bg = Image.blend(bg, Image.new("RGBA", (W, H), (14, 16, 20, 255)), knock)
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for x in range(W):
        t = min(1.0, max(0.0, (x - 40) / 480.0))
        a = int(236 * (1 - t) ** 1.35 + 26)
        vd.line((x, 0, x, H), fill=(11, 13, 17, a))
    bg.alpha_composite(veil)
    return bg


def fit(text, path, size, max_w):
    while size > 10:
        f = ImageFont.truetype(path, size)
        if f.getlength(text) <= max_w:
            return f
        size -= 1
    return ImageFont.truetype(path, size)


def tracked(d, xy, text, font, fill, track=0):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += font.getlength(ch) + track
    return x


def build(platform, bg_path):
    cfg = PLATFORMS[platform]
    img = backdrop(bg_path)

    w = watch(platform)
    img.alpha_composite(w, (cfg["cx"] - w.width // 2, cfg["cy"] - w.height // 2))

    d = ImageDraw.Draw(img)
    x = 48

    # kicker
    f_kick = ImageFont.truetype(F_SEMI, 13)
    tracked(d, (x, 44), "FOR " + cfg["name"].upper(), f_kick, FAINT, track=2.2)

    # title, over its own soft shadow -- the backdrop has bright radar cores in
    # this band and the scrim alone doesn't hold the counters open
    y = 68
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    yy = y
    for line in TITLE:
        f = fit(line, F_BLACK, 45, cfg["title_w"])
        sd.text((x, yy + 2), line, font=f, fill=(6, 8, 12, 170))
        yy += 46
    img.alpha_composite(shade.filter(ImageFilter.GaussianBlur(7)))
    d = ImageDraw.Draw(img)
    for line in TITLE:
        f = fit(line, F_BLACK, 45, cfg["title_w"])
        d.text((x, y), line, font=f, fill=INK)
        y += 46

    # reflectivity ramp rule
    y += 12
    seg = 22
    for i, c in enumerate(RAMP):
        d.rectangle((x + i * seg, y, x + (i + 1) * seg - 2, y + 5), fill=c)

    # tagline
    y += 24
    f_tag = ImageFont.truetype(F_MED, 17)
    for line in TAGLINE.split("\n"):
        d.text((x, y), line, font=f_tag, fill=DIM)
        y += 23

    # footer
    f_foot = ImageFont.truetype(F_MED, 12)
    d.text((x, H - 40), FOOTER, font=f_foot, fill=FAINT)

    return img.convert("RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bg", default=os.path.join(OUT, "bg_%s.png" % DEFAULT_BG),
                    help="topo+radar backdrop from banner_bg.py")
    ap.add_argument("--platform", action="append", choices=list(PLATFORMS))
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    if not os.path.exists(a.bg):
        raise SystemExit("no backdrop at %s -- run banner_bg.py first" % a.bg)

    os.makedirs(a.out, exist_ok=True)
    for p in (a.platform or list(PLATFORMS)):
        img = build(p, a.bg)
        assert img.size == (W, H), img.size
        path = os.path.join(a.out, "%s_banner.png" % p)
        img.save(path)
        print("%s  %dx%d" % (path, img.width, img.height))


if __name__ == "__main__":
    main()

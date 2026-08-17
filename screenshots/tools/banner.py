#!/usr/bin/env python3
"""Build 720x320 appstore marketing banners from the staged store screenshots.

One banner per platform, since the Pebble/Rebble portals keep a separate asset
collection per platform. Everything is drawn from assets already in the repo:
the hero screenshot goes in a drawn watch frame, and the background is another
screenshot from the same set, scaled up.

    uv run --with pillow python screenshots/tools/banner.py            # all three
    uv run --with pillow python screenshots/tools/banner.py --style crisp

Run from noaa-us-weather-radar/.
"""

import argparse
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 720, 320

STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "store")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "banner")

FONT_DIR = "/usr/share/fonts/redhat"
F_BLACK = os.path.join(FONT_DIR, "RedHatDisplay-Black.otf")
F_BOLD = os.path.join(FONT_DIR, "RedHatDisplay-Bold.otf")
F_MED = os.path.join(FONT_DIR, "RedHatText-Medium.otf")
F_SEMI = os.path.join(FONT_DIR, "RedHatText-Bold.otf")

# Hero = the screenshot inside the watch. Backdrop = the screenshot blown up
# behind it. Deliberately different scenes so the banner does not read as one
# image duplicated at two sizes.
HERO = "1_minneapolis-derecho"
BACKDROP = "2_washington-dc-severe"
DEFAULT_BG = "washington-dc-severe"   # scenario 11, fetched by banner_bg.py

# shape:  how the display and the body are drawn
# scale:  pixel scale for the screenshot (1.5 is done as x3 nearest, then /2 box)
# bezel:  body inset around the display, (x, y) for rect / single value for round
PLATFORMS = {
    "emery": {"shape": "rect", "scale": 1.0, "bezel": (18, 26), "name": "Pebble Time 2"},
    "basalt": {"shape": "rect", "scale": 1.5, "bezel": (18, 26), "name": "Pebble Time"},
    "gabbro": {"shape": "round", "scale": 1.0, "bezel": 14, "name": "Pebble Round 2"},
}

TITLE = ["NOAA US", "WEATHER RADAR"]
TAGLINE = "Live storm radar over a topo map of\nwherever you happen to be standing."
FOOTER = "NOAA · National Weather Service · USGS · United States only"

INK = (255, 255, 255)
DIM = (198, 207, 218)
FAINT = (139, 148, 161)
BODY = (38, 40, 45)
BODY_EDGE = (66, 70, 78)
STRAP = (30, 32, 36)

# NWS-ish reflectivity ramp, used as a thin accent rule under the title.
RAMP = [
    (0x40, 0xE0, 0x40), (0x00, 0xC0, 0x00), (0x00, 0x90, 0x00),
    (0xFF, 0xFF, 0x00), (0xFF, 0xC0, 0x00), (0xFF, 0x80, 0x00),
    (0xFF, 0x00, 0x00), (0xC0, 0x00, 0x00), (0xFF, 0x00, 0xFF),
]


def shot(platform, scene):
    return Image.open(os.path.join(STORE, "%s_%s.png" % (platform, scene))).convert("RGBA")


def pixel_scale(img, scale):
    """Nearest-neighbour only -- these are 16-colour 4bpp frames and any
    interpolation turns the halo'd slot text to mush. At basalt's 1.5x the
    uneven pixel split is visible on glyph stems and still reads sharper than
    the x3-then-box alternative, which was tried and looked soft."""
    if scale == 1.0:
        return img
    return img.resize((int(img.width * scale), int(img.height * scale)), Image.NEAREST)


def round_mask(size):
    m = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def rounded_mask(w, h, r):
    m = Image.new("L", (w * 4, h * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * 4 - 1, h * 4 - 1), radius=r * 4, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def watch(platform):
    """Draw the device: straps, body, bezel highlight, screen. Returns RGBA."""
    cfg = PLATFORMS[platform]
    screen = pixel_scale(shot(platform, HERO), cfg["scale"])
    sw, sh = screen.size

    if cfg["shape"] == "round":
        b = cfg["bezel"]
        bw = bh = sw + b * 2
        radius = bw // 2
    else:
        bx, by = cfg["bezel"]
        bw, bh = sw + bx * 2, sh + by * 2
        radius = 26

    pad = 60  # room for straps and the shadow
    card = Image.new("RGBA", (bw + pad * 2, bh + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    x0, y0 = pad, pad

    # Straps, drawn first so the body sits on top of them. Tapered, and on the
    # round body they start well inside the circle -- a straight bar the full
    # width of the lug would poke out past the bezel where the circle narrows.
    frac = 0.60 if cfg["shape"] == "rect" else 0.46
    strap_w = int(bw * frac)
    sx = x0 + (bw - strap_w) // 2
    tap = int(strap_w * 0.10)
    inset = 40 if cfg["shape"] == "rect" else int(bh * 0.16)
    d.polygon([(sx, y0 + inset), (sx + strap_w, y0 + inset),
               (sx + strap_w - tap, 0), (sx + tap, 0)], fill=STRAP)
    d.polygon([(sx, y0 + bh - inset), (sx + strap_w, y0 + bh - inset),
               (sx + strap_w - tap, card.height - 1), (sx + tap, card.height - 1)], fill=STRAP)

    # body
    if cfg["shape"] == "round":
        d.ellipse((x0, y0, x0 + bw - 1, y0 + bh - 1), fill=BODY, outline=BODY_EDGE, width=2)
    else:
        d.rounded_rectangle((x0, y0, x0 + bw - 1, y0 + bh - 1), radius=radius,
                            fill=BODY, outline=BODY_EDGE, width=2)
        # side buttons
        d.rounded_rectangle((x0 + bw - 3, y0 + bh // 2 - 26, x0 + bw + 4, y0 + bh // 2 + 26),
                            radius=4, fill=BODY_EDGE)
        d.rounded_rectangle((x0 - 5, y0 + bh // 2 - 14, x0 + 2, y0 + bh // 2 + 14),
                            radius=4, fill=BODY_EDGE)

    # screen
    px, py = x0 + (bw - sw) // 2, y0 + (bh - sh) // 2
    if cfg["shape"] == "round":
        screen.putalpha(round_mask(sw))
    else:
        screen.putalpha(rounded_mask(sw, sh, 6))
    card.alpha_composite(screen, (px, py))

    # drop shadow, from the body silhouette only
    sil = Image.new("L", card.size, 0)
    ds = ImageDraw.Draw(sil)
    if cfg["shape"] == "round":
        ds.ellipse((x0, y0, x0 + bw - 1, y0 + bh - 1), fill=190)
    else:
        ds.rounded_rectangle((x0, y0, x0 + bw - 1, y0 + bh - 1), radius=radius, fill=190)
    shadow = Image.new("RGBA", card.size, (0, 0, 0, 0))
    shadow.putalpha(sil.filter(ImageFilter.GaussianBlur(14)))
    out = Image.new("RGBA", card.size, (0, 0, 0, 0))
    out.alpha_composite(shadow, (0, 10))
    out.alpha_composite(card)
    return out


def backdrop(platform, style, bg_path=None):
    """720x320 background: a real topo+radar fetch if one has been made
    (banner_bg.py), else a screenshot blown up, else flat."""
    if style == "panel":
        return Image.new("RGBA", (W, H), (18, 20, 24, 255))

    if style == "photo":
        src = Image.open(bg_path).convert("RGB")
        k = max(W / src.width, H / src.height)
        if k != 1.0:
            src = src.resize((int(src.width * k + 0.5), int(src.height * k + 0.5)), Image.LANCZOS)
        left, top = (src.width - W) // 2, (src.height - H) // 2
        bg = src.crop((left, top, left + W, top + H)).convert("RGBA")
        bg = bg.filter(ImageFilter.GaussianBlur(1.6))
        return scrim(bg, 0.34)

    src = shot(platform, BACKDROP).convert("RGB")
    k = max(W / src.width, H / src.height)
    up = src.resize((int(src.width * (int(k) + 1)), int(src.height * (int(k) + 1))), Image.NEAREST)
    if up.width < W or up.height < H:
        up = up.resize((max(W, up.width), max(H, up.height)), Image.NEAREST)
    left = (up.width - W) // 2
    top = int((up.height - H) * 0.35)
    bg = up.crop((left, top, left + W, top + H)).convert("RGBA")

    if style == "bleed":
        bg = bg.filter(ImageFilter.GaussianBlur(7))
    return scrim(bg, 0.42)


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


def build(platform, style, bg_path=None):
    cfg = PLATFORMS[platform]
    img = backdrop(platform, style, bg_path)

    w = watch(platform)
    cx = 548 if cfg["shape"] == "rect" else 556
    img.alpha_composite(w, (cx - w.width // 2, H // 2 - w.height // 2))

    d = ImageDraw.Draw(img)
    x = 48
    # the round body reaches further left than the rectangular ones, so the
    # title has to give it room or "RADAR" runs into the bezel
    max_w = 366 if cfg["shape"] == "rect" else 336

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
        f = fit(line, F_BLACK, 45, max_w)
        sd.text((x, yy + 2), line, font=f, fill=(6, 8, 12, 170))
        yy += 46
    img.alpha_composite(shade.filter(ImageFilter.GaussianBlur(7)))
    d = ImageDraw.Draw(img)
    for line in TITLE:
        f = fit(line, F_BLACK, 45, max_w)
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
    ap.add_argument("--style", default="photo", choices=["photo", "bleed", "crisp", "panel"])
    ap.add_argument("--bg", default=os.path.join(OUT, "bg_%s.png" % DEFAULT_BG),
                    help="topo+radar backdrop from banner_bg.py (style=photo)")
    ap.add_argument("--platform", action="append", choices=list(PLATFORMS))
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--suffix", default="")
    a = ap.parse_args()

    if a.style == "photo" and not os.path.exists(a.bg):
        raise SystemExit("no backdrop at %s -- run banner_bg.py first" % a.bg)

    os.makedirs(a.out, exist_ok=True)
    for p in (a.platform or list(PLATFORMS)):
        img = build(p, a.style, a.bg)
        assert img.size == (W, H), img.size
        path = os.path.join(a.out, "%s_banner%s.png" % (p, a.suffix))
        img.save(path)
        print("%s  %dx%d" % (path, img.width, img.height))


if __name__ == "__main__":
    main()

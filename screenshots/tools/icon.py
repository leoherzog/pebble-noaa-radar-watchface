#!/usr/bin/env python3
"""Build the appstore icons, screenshots/icon/icon_80x80.png and icon_144x144.png.

One pinned scene, Hurricane Ian's eye off Cayo Costa, from the two services
banner_bg.py asks: the topo as a backdrop, the radar cut to four flat tiers so
the storm reads as one shape at 80 px, and the face's centre marker in the eye.
Each size is fetched at SS times its pixels and box-averaged down, never scaled
from the other.

    uv run --with pillow --with numpy python screenshots/tools/icon.py

Run from noaa-us-weather-radar/.
"""

import argparse
import io
import math
import os
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

SIZES = (80, 144)
SS = 8

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "icon")

BASEMAP_URL = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/export"
IEM_URL = "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi"
UA = "pebble-noaa-radar-icon (pebble-radar@herzog.tech)"

# The scene. LAT/LON is the centre of the eye, so the marker lands in it, and
# the span leaves the Florida coast and open Gulf showing at the edges. The
# archive needs full seconds in TIME (screenshots.md).
LAT, LON = 26.50, -82.34
SPAN_KM = 175
TIME = "2022-09-28T17:45:00Z"

# Flat tiers by position on the archive's colour ramp (see ramp()), weakest
# first. Anything below the first floor is left as map, which opens the gaps
# between rainbands. Classic NWS colours, like the gallery's, at floors picked
# for the icon: not a legend, and not the shipped MRMS ramp.
TIERS = (
    (2.55, (22, 150, 40)),
    (3.60, (255, 228, 20)),
    (4.60, (255, 140, 0)),
    (5.35, (228, 24, 36)),
)
SMOOTH = 0.016       # Gaussian radius on the ramp position, as a share of the width

# Backdrop: the topo with its colour pushed and its land tinted towards paper,
# so land, water and roads still separate at 80 px.
LAND_TINT = (0.97, 0.93, 0.80)
MAP_COLOR = 1.7

# The face's marker, a white disc under a red dot, as shares of the width. The
# dark edge keeps the disc visible on the pale water in the eye.
MARKER = ((0.074, (24, 40, 60)), (0.062, (255, 255, 255)), (0.036, (235, 20, 30)))


def bbox(lat, lon, span_m):
    w = span_m / math.cos(math.radians(lat))
    cx = lon * 20037508.34 / 180
    cy = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180) * 20037508.34 / 180
    return "%f,%f,%f,%f" % (cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    img = Image.open(io.BytesIO(data))
    img.load()
    return img.convert("RGBA")


def ramp(radar):
    """Position of each pixel on IEM's n0q colour ramp, as a float array.

    0 is dry, 1 the fringe below light rain, then green 2 to 3, olive 3 to 4,
    yellow 4 to 5, orange 5 to 6, and 6.5 for red and the hail colours past it.
    """
    a = np.asarray(radar).astype(np.float32)
    r, g, b, alpha = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    wet = alpha > 0
    hot = wet & ((g < 60) | ((r > 220) & (b > 200)))
    lit = wet & ~hot & (b < 60)
    pos = np.where(wet, 1.0, 0.0).astype(np.float32)
    green = lit & (r < 40)
    olive = lit & (r >= 40) & (r < 250)
    yellow = lit & (r >= 250) & (g >= 186)
    orange = lit & (r >= 250) & (g < 186)
    pos[green] = 2 + np.clip((209 - g[green]) / 115, 0, 1)
    pos[olive] = 3 + (r[olive] - 40) / 210
    pos[yellow] = 4 + np.clip((226 - g[yellow]) / 40, 0, 1)
    pos[orange] = 5 + (186 - g[orange]) / 86
    pos[hot] = 6.5
    return pos


def backdrop(base):
    a = np.asarray(base.convert("RGB")).astype(np.float32)
    land = (a[..., 2] - a[..., 0]) <= 25
    a[land] *= np.array(LAND_TINT, np.float32)
    img = Image.fromarray(a.astype(np.uint8))
    return np.array(ImageEnhance.Color(img).enhance(MAP_COLOR))


def render(n):
    big = n * SS
    bb = bbox(LAT, LON, SPAN_KM * 1000)
    base = get("%s?bbox=%s&bboxSR=3857&imageSR=3857&size=%d,%d&format=png32"
               "&transparent=false&f=image" % (BASEMAP_URL, bb, big, big))
    radar = get("%s?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=nexrad-n0q-wmst"
                "&SRS=EPSG:3857&BBOX=%s&WIDTH=%d&HEIGHT=%d&FORMAT=image/png"
                "&TRANSPARENT=TRUE&TIME=%s" % (IEM_URL, bb, big, big, TIME))

    # Blurring the ramp position before cutting it turns the radar's blocky
    # bins into smooth contours. 36 steps per ramp unit fit 6.5 into a byte.
    pos = Image.fromarray((ramp(radar) * 36).astype(np.uint8))
    pos = np.asarray(pos.filter(ImageFilter.GaussianBlur(big * SMOOTH))) / 36.0

    px = backdrop(base)
    for floor, rgb in TIERS:
        px[pos >= floor] = rgb
    img = Image.fromarray(px)

    d = ImageDraw.Draw(img)
    for share, rgb in MARKER:
        rad = share * big
        d.ellipse([big / 2 - rad, big / 2 - rad, big / 2 + rad - 1, big / 2 + rad - 1], fill=rgb)

    wet = float((pos >= TIERS[0][0]).mean())
    return img.reduce(SS), wet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    for n in SIZES:
        img, wet = render(n)
        path = os.path.normpath(os.path.join(a.out, "icon_%dx%d.png" % (n, n)))
        img.save(path, optimize=True)
        print("%s  %dx%d  %d B  %.0f%% radar" % (path, img.width, img.height,
                                                os.path.getsize(path), wet * 100))


if __name__ == "__main__":
    main()

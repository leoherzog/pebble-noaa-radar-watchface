#!/usr/bin/env python3
"""Fetch a 720x320 topo+radar backdrop for the appstore banner.

The banner background can't come from a watch screenshot -- a 200x228 frame
blown up 4x is mush, and the watch's own text comes up with it. This asks the
same two services the phone asks, at banner size, for one of the archived radar
frames in scenarios.json. Same Web Mercator math as index.js:1298-1305.

Full colour, not the 16-colour composite: it's a decorative wash sitting behind
type, not a claim about what the watch renders.

    uv run --with pillow python screenshots/tools/banner_bg.py --scenario 3

Writes screenshots/banner/bg_<slug>.png. Run from noaa-us-weather-radar/.
"""

import argparse
import io
import json
import math
import os
import urllib.request

from PIL import Image

W, H = 720, 320
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "banner")

BASEMAP_URL = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/export"
IEM_URL = "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi"
ZOOM_WIDTHS = [100000, 250000, 500000]
UA = "pebble-noaa-radar-banner (pebble-radar@herzog.tech)"


def bbox(lat, lon, span_m):
    w = span_m / math.cos(math.radians(lat))
    h = w * H / W
    cx = lon * 20037508.34 / 180
    cy = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180) * 20037508.34 / 180
    return "%f,%f,%f,%f" % (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    img = Image.open(io.BytesIO(data))
    img.load()
    return img.convert("RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", type=int, required=True, help="id in scenarios.json")
    ap.add_argument("--span-km", type=float, default=None, help="override the scenario's zoom")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    scenarios = json.load(open(os.path.join(HERE, "scenarios.json")))
    s = next(x for x in scenarios if x["id"] == a.scenario)
    span = a.span_km * 1000 if a.span_km else ZOOM_WIDTHS[s["zoom"]]
    bb = bbox(s["lat"], s["lon"], span)

    base = get("%s?bbox=%s&bboxSR=3857&imageSR=3857&size=%d,%d&format=png32"
               "&transparent=false&f=image" % (BASEMAP_URL, bb, W, H))
    # The archive wants full seconds -- a minute-precision stamp comes back as a
    # WMS XML exception under HTTP 200 (screenshots.md).
    radar = get("%s?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=nexrad-n0q-wmst"
                "&SRS=EPSG:3857&BBOX=%s&WIDTH=%d&HEIGHT=%d&FORMAT=image/png"
                "&TRANSPARENT=TRUE&TIME=%s" % (IEM_URL, bb, W, H, s["time"]))

    out = base.copy()
    out.alpha_composite(radar)
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "bg_%s.png" % s["slug"])
    out.convert("RGB").save(path)

    alpha = radar.getchannel("A").histogram()
    wet = (W * H - alpha[0]) / float(W * H)
    print("%s  %dx%d  %.1f%% radar coverage" % (path, out.width, out.height, wet * 100))


if __name__ == "__main__":
    main()

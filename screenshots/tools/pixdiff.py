#!/usr/bin/env python3
"""Pixel-diff two gallery trees. pixdiff.py <dir-a> <dir-b>

Reports, per tile, the number of differing pixels. Zero is the pass criterion
for any tile whose every slot string is deterministic -- CLAUDE.md's rule is
that text-geometry changes must be caught by pixel diff and never by eye, since
a one-pixel drift is invisible to a human and fatal to the auto-font invariant.

ImageMagick is not installed here; PIL is. Note that a missing file is reported
as MISSING rather than skipped: a silently absent tile would otherwise read as
a pass.
"""
import os
import sys

from PIL import Image, ImageChops


def diff(a, b):
    ia = Image.open(a).convert("RGB")
    ib = Image.open(b).convert("RGB")
    if ia.size != ib.size:
        return None, "size %s vs %s" % (ia.size, ib.size)
    n = sum(1 for p in ImageChops.difference(ia, ib).getdata() if p != (0, 0, 0))
    return n, "%d/%d px" % (n, ia.size[0] * ia.size[1])


def main():
    da, db = sys.argv[1], sys.argv[2]
    worst = 0
    missing = 0
    for plat in sorted(os.listdir(da)):
        pa = os.path.join(da, plat)
        if not os.path.isdir(pa):
            continue
        for tile in sorted(os.listdir(pa)):
            if not tile.endswith(".png"):
                continue
            fa, fb = os.path.join(pa, tile), os.path.join(db, plat, tile)
            if not os.path.exists(fb):
                print("MISSING  %-8s %s" % (plat, tile))
                missing += 1
                continue
            n, note = diff(fa, fb)
            if n is None:
                print("SIZEDIFF %-8s %-34s %s" % (plat, tile, note))
                worst = max(worst, 1)
            else:
                print("%-8s %-8s %-34s %s" % ("OK" if n == 0 else "DIFF",
                                              plat, tile, note))
                worst = max(worst, n)
    print("\nworst=%d differing pixels, %d missing" % (worst, missing))
    return 1 if (worst or missing) else 0


if __name__ == "__main__":
    sys.exit(main())

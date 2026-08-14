#!/usr/bin/env python3
"""Seed one scenario's settings into a platform's pypkjs localStorage.

pypkjs persists localStorage as a Python dbm.dumb database at
  ~/.local/share/pebble-sdk/<active-sdk-version>/<platform>/localstorage/<app-uuid>
with plain UTF-8 string values. Writing 'cfg2' there is equivalent to saving
the Clay settings page: index.js's 'ready' handler replays that blob verbatim
to the watch. Zoom / ManualLoc / RadarMode / WxUnits are phone-side only and
live in their own keys -- RadarMode in particular must NOT appear inside cfg2,
which carries watch-bound keys exclusively.

'RadarArchive' is the temporary gallery-capture key: an ISO timestamp makes
index.js pull the radar layer from IEM's archived NEXRAD WMS instead of live
MRMS. See screenshots.md.

Usage: seed.py <platform> <scenario-id> [scenarios.json]
"""
import dbm.dumb
import json
import os
import shutil
import sys

# Read from package.json rather than hardcoded: the localstorage file is named
# for the app UUID, so a stale copy here seeds a store no emulator reads, exits
# 0, and renders the whole gallery at watch-side defaults -- the same silent
# double failure the SDK-version note below describes.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "..", "package.json")) as _f:
    APP_UUID = json.load(_f)["pebble"]["uuid"]

# That directory is keyed on the ACTIVE SDK version (pebble-tool's
# sdk/__init__.py get_sdk_persist_dir), so a hardcoded version is a silent
# double failure after an SDK switch: the wipe and the seed both land in a
# directory no emulator reads, seed.py still exits 0, and the tile renders at
# watch-side defaults against an un-wiped flash. Resolve it from the active SDK
# instead. PEBBLE_EMULATOR_VERSION pins an older one, for regenerating a
# gallery against its original firmware -- pass the same value to capture.sh,
# which forwards it as --sdk. Note that pinning only works if the .pbw was
# built by that SDK too: a newer build stamps a higher SDK minor and older
# firmware refuses to install it, so pin with `pebble sdk activate <ver>` and a
# rebuild, not with this variable alone.
_ROOT = os.path.expanduser("~/.local/share/pebble-sdk")
_VER = os.environ.get("PEBBLE_EMULATOR_VERSION")
if not _VER:
    with open(os.path.join(_ROOT, "SDKs", "current",
                           "sdk-core", "manifest.json")) as _f:
        _VER = json.load(_f)["version"]
SDK = os.path.join(_ROOT, _VER)


def main():
    platform, sid = sys.argv[1], int(sys.argv[2])
    path = sys.argv[3] if len(sys.argv) > 3 else \
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenarios.json")
    scen = next(s for s in json.load(open(path)) if s["id"] == sid)

    # A stale blob is worse than none: sizeof(Settings) did not change when
    # radar_mode was removed, so a previous-layout blob still passes
    # load_settings()'s guard and misparses into invisible text. Wipe both the
    # persisted watch settings and the whole localstorage dir every time.
    flash = os.path.join(SDK, platform, "qemu_spi_flash.bin")
    if os.path.exists(flash):
        os.remove(flash)                       # re-extracted from the SDK on boot
    lsdir = os.path.join(SDK, platform, "localstorage")
    if os.path.isdir(lsdir):
        shutil.rmtree(lsdir)
    os.makedirs(lsdir, exist_ok=True)

    db = dbm.dumb.open(os.path.join(lsdir, APP_UUID), "n")
    db["cfg2"] = json.dumps(scen["cfg"])
    db["Zoom"] = str(scen["zoom"])
    db["ManualLoc"] = "%s,%s" % (scen["lat"], scen["lon"])   # '' would mean GPS
    db["RadarMode"] = str(scen["mode"])
    db["WxUnits"] = str(scen["units"])
    db["RadarArchive"] = scen["time"]
    db.close()

    print("seeded %s/%02d %s  loc=%s,%s zoom=%d mode=%d units=%d radar=%s"
          % (platform, sid, scen["slug"], scen["lat"], scen["lon"],
             scen["zoom"], scen["mode"], scen["units"], scen["time"]))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Seed one scenario's settings into a platform's pypkjs localStorage.

pypkjs persists localStorage as a Python dbm.dumb database at
  ~/.local/share/pebble-sdk/<active-sdk-version>/<platform>/localstorage/<app-uuid>
with plain UTF-8 string values. Writing 'cfg2' there is equivalent to saving
the Clay settings page: index.js's 'ready' handler replays that blob verbatim
to the watch. Zoom / ManualLoc / RadarMode / WxUnits are phone-side only and
live in their own keys; RadarMode in particular must not appear inside cfg2,
which carries watch-bound keys exclusively.

'RadarArchive' is read only by the temporary radarUrl() patch in
screenshots.md: an ISO timestamp there makes index.js pull the radar layer
from IEM's archived NEXRAD WMS instead of live MRMS.

Usage: seed.py <platform> <scenario-id> [scenarios.json]
"""
import dbm.dumb
import json
import os
import shutil
import sys

# Read from package.json: the localstorage file is named for the app UUID, and
# a stale hardcoded copy would seed a store no emulator reads, exit 0, and
# render the whole gallery at watch-side defaults.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "..", "package.json")) as _f:
    APP_UUID = json.load(_f)["pebble"]["uuid"]

# The persist directory is keyed on the active SDK version (pebble-tool's
# sdk/__init__.py get_sdk_persist_dir). A hardcoded version would, after an SDK
# switch, wipe and seed a directory no emulator reads, still exit 0, and render
# every tile at watch-side defaults against an un-wiped flash.
# PEBBLE_EMULATOR_VERSION pins another version; pass the same value to
# capture.sh, which forwards it as --sdk. Pinning also needs the .pbw rebuilt
# under that SDK (`pebble sdk activate <ver>`), because older firmware refuses a
# bundle stamped with a newer SDK minor.
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

    # Wipe the watch flash and the whole localstorage dir every time. The flash
    # holds the last run's settings and persisted composite, which the face
    # draws at launch before the cfg2 replay or any transfer lands.
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

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

A scenario's 'weather' field is written by hand: 'obs', 'fcst' and 'alerts'
hold the inputs index.js caches as wx_obs, wx_fcst and wx_alerts, without
stamps. Each record is built here in the shape index.js persists it and
stamped with the seed time, and assembleWx() builds every string from it, so
each platform fits and abbreviates its own text. 'WxPinned' is read only by
the temporary fetchWeather() patch, which then sends the seeded weather and
fetches nothing.

Usage: seed.py <platform> <scenario-id> [scenarios.json]
"""
import dbm.dumb
import json
import os
import shutil
import sys
import time

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

# Every key index.js's obsRecord() writes. A key the scenario omits is seeded
# as null, the value a station that drops the field leaves.
OBS_KEYS = ("temp", "desc", "dp", "rh", "ws", "wd", "wg", "hi", "wc", "pr")
FCST_KEYS = ("d", "t", "s", "n")              # fetchFcst()'s period
ALERT_KEYS = ("e", "sv", "ur", "on", "ex")    # fetchAlerts()'s feature

# The ranks index.js's WX_SEV and WX_URG give the API's words.
WX_SEV = {"Extreme": 4, "Severe": 3, "Moderate": 2, "Minor": 1}
WX_URG = {"Immediate": 3, "Expected": 2, "Future": 1}

# An alert with no 'on' or 'ex' began an hour before the seed and lapses six
# hours after it.
ALERT_ON, ALERT_EX = "-1h", "+6h"
_UNIT = {"m": 60, "h": 3600, "d": 86400}


def _check(what, rec, keys):
    """Exit on a key index.js would never read, which is a typo."""
    bad = sorted(set(rec) - set(keys))
    if bad:
        sys.exit("%s: unknown key(s) %s; expected %s"
                 % (what, ", ".join(bad), ", ".join(keys)))


def _rank(what, table, word):
    if word not in table:
        sys.exit("%s: %r is not one of %s" % (what, word, ", ".join(table)))
    return table[word]


def _offset(what, s, now):
    """'-1h', '+45m' or '+2d' from the seed time, as epoch seconds; None is 0,
    which index.js reads as no onset or no expiry."""
    if s is None:
        return 0
    try:
        return now + int(s[:-1]) * _UNIT[s[-1]]
    except (KeyError, TypeError, ValueError):
        sys.exit("%s: %r is not an offset like -1h, +45m or +2d" % (what, s))


def weather_records(wx, now_ms):
    """A scenario's 'weather' field as the localStorage records index.js
    persists, keyed by storage key.

    obs: temp and dp in degC, rh in percent, ws and wg in km/h, wd in degrees,
    hi and wc in degC, pr in Pa.
    fcst: up to two periods, each {n: name, d: daytime, t: degF, s: text}.
    alerts: each {e: event, sv: severity word}, plus optionally ur (urgency
    word, default Expected) and on / ex (offsets from the seed time).
    """
    _check("weather", wx, ("obs", "fcst", "alerts"))
    now = now_ms // 1000
    out = {}
    if "obs" in wx:
        _check("weather.obs", wx["obs"], OBS_KEYS)
        rec = {k: wx["obs"].get(k) for k in OBS_KEYS}
        rec["desc"] = rec["desc"] or ""
        rec["t"] = now_ms
        out["wx_obs"] = rec
    if "fcst" in wx:
        if len(wx["fcst"]) > 2:
            sys.exit("weather.fcst: index.js keeps two periods")
        periods = []
        for p in wx["fcst"]:
            _check("weather.fcst", p, FCST_KEYS)
            periods.append({"d": bool(p.get("d")), "t": p.get("t"),
                            "s": p.get("s", ""), "n": p.get("n", "")})
        out["wx_fcst"] = {"t": now_ms, "p": periods}
    if "alerts" in wx:
        feats = []
        for a in wx["alerts"]:
            _check("weather.alerts", a, ALERT_KEYS)
            if "e" not in a or "sv" not in a:
                sys.exit("weather.alerts: an alert needs e and sv")
            feats.append({
                "e": a["e"],
                "sv": _rank("weather.alerts sv", WX_SEV, a["sv"]),
                "ur": _rank("weather.alerts ur", WX_URG, a.get("ur", "Expected")),
                "on": _offset("weather.alerts on", a.get("on", ALERT_ON), now),
                "ex": _offset("weather.alerts ex", a.get("ex", ALERT_EX), now),
            })
        out["wx_alerts"] = {"t": now_ms, "f": feats}
    return out


def main():
    platform, sid = sys.argv[1], int(sys.argv[2])
    path = sys.argv[3] if len(sys.argv) > 3 else \
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenarios.json")
    scen = next(s for s in json.load(open(path)) if s["id"] == sid)
    # Built before the wipe, so a bad field exits with the store untouched.
    wx = scen.get("weather")
    recs = weather_records(wx, int(time.time() * 1000)) if wx else {}

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
    for key, rec in recs.items():
        db[key] = json.dumps(rec, separators=(",", ":"))
    if wx:
        db["WxPinned"] = "1"
    db.close()

    print("seeded %s/%02d %s  loc=%s,%s zoom=%d mode=%d units=%d radar=%s wx=%s"
          % (platform, sid, scen["slug"], scen["lat"], scen["lon"],
             scen["zoom"], scen["mode"], scen["units"], scen["time"],
             ",".join(sorted(wx)) if wx else "live"))


if __name__ == "__main__":
    main()

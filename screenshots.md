# Gallery screenshots

How `screenshots/gallery/` is produced, and why each tile is what it is.

Twelve scenarios × three platforms (emery, basalt, gabbro) = 36 tiles, plus one
contact sheet per platform. Regenerating them is `screenshots/tools/capture.sh
<platform> <id>`, but **two temporary source patches have to be reapplied
first** — see [Reproducing](#reproducing).

This file is the gallery's own record. General emulator behaviour — `--vnc`,
`pkill`, one-shell-invocation, localstorage seeding, which `emu-*` commands
work — lives in the workspace `CLAUDE.md`, and is referenced rather than
repeated here. Facts that ended up in both (the radar-source survey, the
`emu-set-time` traps, the decode ceilings) are carried in full there; what
appears here is the gallery-specific consequence plus a pointer. If you change
one, check the other.

## The radar imagery is archived, not live

Live MRMS shows whatever weather exists at capture time, which makes a
twelve-city gallery a matter of luck — most cities are clear most of the time.
Each tile therefore pins a **specific historical 5-minute frame** from the Iowa
Environmental Mesonet's archived NEXRAD `n0q` WMS, which covers 2011-02-16
onward at `PT5M` (from its `GetCapabilities`).

The timestamp travels in the URL, so **the system clock stays at the present**.
That matters: `libfaketime` into the past breaks TLS, because a live
certificate's `notBefore` can be more recent than the faked date, and the
failure is silent (fetches just stop).

Three things about the archive that are worth not rediscovering:

- **`TIME` needs full seconds.** `2026-08-10T21:00Z` returns a MapServer
  PostGIS error as a WMS XML exception under HTTP 200, which `fetchPng()` would
  report only as a transcode failure.
- **Same `TIME` → byte-identical composite.** Verified: 0.00% pixel diff, same
  8,595 B. Captures are reproducible and the `tx_hash` cache is not fought.
- **The colour ramp is not the shipped one**, so the radar colours in these
  tiles are not the colours the shipped face renders — accepted for gallery
  imagery only. CLAUDE.md's "On swapping the radar source" note in the Image
  pipeline section carries the survey behind that: how far the two ramps differ,
  why this source may not ship, and why NOAA's own time-enabled service — which
  *is* faithful — could not be used here either.

Every chosen frame was verified through the real pipeline (`shrinkPng` →
`buildComposite`) at all three display sizes before any emulator ran, using the
per-platform decode ceilings in CLAUDE.md's Memory section. Worst utilisation is
New Orleans on gabbro at **20,538 B against a 28,986 B ceiling (71%)** — a
harder case than anything the earlier live sweep found, so those table rows were
updated from this run. (This line previously read 29,968 B / 69%, which
disagreed with CLAUDE.md's table by 982 B: it never absorbed the persisted-
composite `.text` cost. The figure above is the SDK 4.33 re-measurement and now
matches. The `verify` percentages in `scenarios.json` were recomputed against
the corrected ceilings afterwards — every gabbro row, and New Orleans on emery,
had been left against the superseded ones.)

### How the frames were chosen

A scan sampled the archive 4×/day across a season per city (~250–600 samples
each, ~16 s per 250), scoring each frame on wet coverage, warm-colour (high
dBZ) fraction and tier count.

The first objective simply maximised those, and it was **wrong**: it returned
90%+ coverage every time — Hurricane Ida over New Orleans at 95.8% wet — and a
tile that is a solid slab of colour with no visible basemap is not a watchface
screenshot. The scoring now rewards coverage only inside a 15–45% band and
penalises it past that, so the map still reads underneath. One tile (New
Orleans) is deliberately pinned outside the band because Francine's eye is
worth more than the score.

## The twelve tiles

Slot columns are in **display order**: Top 1 / Top 2 / Bottom 1 / Bottom 2.
Fonts are XS/S/M/L/XL, `L*` meaning "Large, shrink to fit".

| # | Location | Radar frame (UTC) | Zoom | Mode | Clock | Fmt | Slots | Fonts | Text / outline | Other |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | Grand Rapids MI | 2025-08-16 20:45 | City | translucent | Sat 18:42 | 12h | — / Time / Date / — | XL, S | white / black | scattered cells over the city |
| 02 | Minneapolis MN | 2025-06-29 03:00 | State | opaque | Wed 21:15 | 24h | Weekday / Time / Date / Battery | S, L, S, XS | yellow / black | battery 42%, BT badge on |
| 03 | New Orleans LA | 2024-09-11 18:20 | Region | opaque | Sun 07:28 | 12h | Conditions / Time / High-Low / — | XS, XL, S | cyan / navy | **Hurricane Francine's eye** |
| 04 | Oklahoma City OK | 2025-06-26 21:00 | City | opaque | now + 7 min | 24h | Alerts-else-Conditions / Time / Date / Radar Age | XS, L, XS, XS | red / white | supercells; Radar Age reads `7 min` |
| 05 | Dallas TX | 2025-04-20 03:10 | State | translucent | Thu 16:05 | 12h | — / Time / Forecast / — | L\*, XS | black / white | **shrink-to-fit** font |
| 06 | Miami FL | 2024-10-09 18:05 | Region | translucent | Mon 12:00 | 12h | — / Time / — / — | XL | magenta / white | single-line minimal, battery 100% |
| 07 | Denver CO | 2025-06-26 02:55 | City | translucent | Tue 06:50 | 24h | Heart Rate / Time / Steps / Distance | XS, L, XS, XS | green / black | health slots (stubbed, see below) |
| 08 | Phoenix AZ | 2024-07-26 02:45 | State | opaque | Fri 20:33 | 12h | — / Time / ISO Date / — | XL, M | orange / black | monsoon cells, battery 21% |
| 09 | Seattle WA | 2024-12-07 17:55 | Region | translucent | Mon 15:20 | 24h | Conditions / Time / Weekday / Bluetooth | XS, L, S, XS | white / dark blue | **metric units**; all-low-dBZ rain |
| 10 | New York NY | 2025-09-05 03:20 | City | opaque | Sun 09:07 | 12h | — / Time / Date / — | XL, M | black / yellow | dark-on-light inversion |
| 11 | Washington DC | 2025-07-31 18:10 | State | opaque | Sat 23:48 | 24h | High-Low / Time / Date / Battery | XS, L, XS, XS | white / dark red | metric; battery 15% |
| 12 | Honolulu HI | 2025-03-17 05:50 | City | translucent | Fri 14:26 | 12h | Lat/Long / Time / Weekday / — | XS, L, S | navy / white | non-CONUS, Lat/Long slot |

Coverage of the variety axes: **zoom** City ×5, State ×4, Region ×3 · **radar
mode** translucent ×6, opaque ×6 · **clock** 12h ×7, 24h ×5 · **line count** 1,
2, 3 and 4 all present · **units** imperial ×10, metric ×2 · every font size
including shrink-to-fit · twelve distinct text/outline colour pairs · slot kinds
Time, Date, Weekday, ISO Date, Battery, Bluetooth, Heart Rate, Steps, Distance,
Radar Age, Lat/Long, Current Conditions, Today's Forecast, High/Low and
Alerts-else-Conditions.

**The weather strings are live, not historical.** `api.weather.gov` has no
usable archive (its `/alerts` endpoint accepts `start`/`end` but retains only
about a week — measured: Aug 4 returns, Aug 1 is empty), and gridpoint
forecasts are current-only. So a tile pairs 2024 radar with today's forecast
text. That is deliberate and was agreed; the strings are there to show the
slots working, not to describe the storm.

## Watch clock

Each tile sets its own clock via `pebble emu-set-time`, which moves only the
watch. The general behaviour — why it beats libfaketime here, why it has to run
*after* the final `pebble install`, and the 3 h `WX_MAX_AGE` ceiling on forward
motion — is in CLAUDE.md under "Running the emulator from a non-graphical
shell". What is specific to this gallery:

- Eleven tiles are set **backwards**, to spread times of day and weekdays across
  the sheet. Backwards is unbounded, so those values are free.
- **Tile 04 is the exception**, set to `now + 7 min`, because it is the tile that
  displays Radar Age — `watch_now - s_radar_time` — and a backwards clock clamps
  that to `0 min`. Seven minutes reads as a plausible age and stays far inside
  the 3 h weather window.
- `emu-set-time` no-opped once in 36 captures here (emery/12, which came out at
  wall-clock time and was simply re-run). Read the tiles back.

## Reproducing

Two temporary source patches are needed, and **both are reverted in the
committed tree** because neither may ship.

**1. `src/pkjs/index.js`** — route the radar layer to the archive. Add after
`exportUrl()`:

```js
function radarUrl(bbox) {
  var t;
  try { t = localStorage.getItem('RadarArchive'); } catch (e) { t = null; }
  if (!t) return exportUrl(RADAR_URL, bbox, true);
  return 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi' +
    '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=nexrad-n0q-wmst' +
    '&SRS=EPSG:3857&BBOX=' + bbox +
    '&WIDTH=' + IMG_W + '&HEIGHT=' + IMG_H +
    '&FORMAT=image/png&TRANSPARENT=TRUE&TIME=' + t;
}
```

and change the radar fetch in `locationSuccess()` (the call at `index.js:1406`) from
`fetchPng(exportUrl(RADAR_URL, bbox, true), …)` to `fetchPng(radarUrl(bbox), …)`.

**2. `src/c/main.c`** — fake the health slots, needed only by tile 07.
Under SDK 4.33 `emu-steps` works on emery and gabbro but **basalt still
no-ops** (its QEMU image is byte-identical to 4.17's), and `emu-heart-rate`
leaves the slot at `-- bpm` everywhere — so the stub is still required for a
full three-platform sweep. See CLAUDE.md for the per-platform detail and for
the two ways this test yields a false positive (positional args, and testing
with the stub still applied). Insert at the top of `format_slot()`, before its
`switch`:

```c
  switch (kind) {
    case 2:  snprintf(buf, size, "%d", 10247); return;   // Steps
    case 8:  snprintf(buf, size, "4.6 mi");    return;   // Distance
    case 12: snprintf(buf, size, "72 bpm");    return;   // Heart rate
    default: break;
  }
```

Then `pebble build`, and:

```sh
for p in emery basalt gabbro; do
  for i in $(seq 1 12); do bash screenshots/tools/capture.sh "$p" "$i"; done
done
```

About 40 s per tile, ~25 minutes for all 36. Revert both patches afterwards and
`pebble clean && pebble build` to confirm the heap report is unchanged.

### The tools

- `screenshots/tools/scenarios.json` — the twelve scenarios: location, radar
  timestamp, zoom, mode, units, battery, clock, and the full `cfg2` blob.
- `screenshots/tools/seed.py` — writes one scenario into a platform's pypkjs
  `dbm.dumb` localStorage (`cfg2` plus the phone-side keys), after wiping
  `qemu_spi_flash.bin` and the whole localstorage directory. Both the seeding
  format and why the wipe is mandatory rather than hygiene are in CLAUDE.md.
  It does not write `TimelineAlerts`, so every tile runs at that setting's *on*
  default: one extra alerts fetch and one failing timeline-token attempt per
  tile, both harmless and neither visible in the capture. Seed the key to `'0'`
  if a scenario needs the off arm.
- `screenshots/tools/capture.sh` — one tile end to end, ~40 s. `GALLERY_DIR`
  redirects the output; `PEBBLE_EMULATOR_VERSION` pins the emulator's SDK and
  is forwarded to every emulator-touching command as `--sdk`.
- `screenshots/tools/sweep.sh` — drives `capture.sh` over a set of platforms
  and scenarios. It exists so the invoking command line is just
  `bash sweep.sh …`: `capture.sh` runs `pkill -f 'qemu-pebbl[e]'`, and the
  bracket trick only stops the pattern matching *its own* literal — a loop
  typed at the prompt that mentions qemu would be killed by it.
- `screenshots/tools/pixdiff.py` — pixel-diffs two gallery trees and reports
  differing-pixel counts per tile. ImageMagick's `compare` is **not** installed
  here; this uses PIL. A missing tile is reported, not skipped, so an absent
  file cannot read as a pass.
- `screenshots/tools/emu-probe.sh` — re-tests the firmware-dependent emu-*
  commands after an SDK upgrade, with the health stub reverted and
  non-colliding injection values.
- `screenshots/tools/banner.py` and `banner_bg.py` — the 720×320 appstore
  marketing banners in `screenshots/banner/`, one per platform. No emulator
  involved: the watch screen is a `screenshots/store/` PNG at native pixels and
  the backdrop is a plain topo+radar fetch at banner size. Rationale and the
  build command are in `STORE.md` under Marketing banner. If a gallery
  re-capture changes `screenshots/store/`, re-run `banner.py` — it reads those
  files directly.

**Two scenarios are diff gates rather than gallery tiles.** 13
(`autofont-deterministic`) puts three of four slots on auto fonts with every
string deterministic — Lat/Long, Time, Date, ISO date, no weather and no health
— which is the only way to pixel-diff the shrink-to-fit path that CLAUDE.md
says must never be judged by eye. 14 (`textwidth-stress`) puts **both outer
bands** on Weekday at a fixed Extra Small font, where a round display's chord is
narrowest — so any change in text metrics or in outer-band placement moves those
glyphs and shows up as a diff. Both were captured on all three platforms before
and after the 4.17→4.33 upgrade and came back **0 differing pixels**.

Be clear about what 14 does *not* cover, because its slug oversells it. Weekday
is `strftime("%A")`, formatted entirely watch-side (`main.c`, `format_slot()`),
so it never touches `fitWx`/`budgetFor`/`CHAR_BUDGET_*` — those apply only to
the weather slots (15–21), whose strings are cut on the phone. Nor does it reach
a truncation boundary: the seeded clock renders `Saturday`, and the longest
weekday is `Wednesday` at 9 characters, far inside any budget. **The phone-side
width fitting and the watch's trailing ellipsis have no diff gate.** Covering
them would need a scenario on a weather slot seeded with a long `WX_*` string.

**Comparing two gallery passes.** `capture.sh` writes straight over the
committed tile, so a before/after comparison must redirect one pass or it
compares each tile against itself and reports zero differences no matter what
changed:

```sh
GALLERY_DIR=/tmp/gallery-old bash screenshots/tools/sweep.sh "emery basalt gabbro" "1 2 3 6 7 8 10 12 13 14"
# ... change something ...
GALLERY_DIR=/tmp/gallery-new bash screenshots/tools/sweep.sh "emery basalt gabbro" "1 2 3 6 7 8 10 12 13 14"
python3 screenshots/tools/pixdiff.py /tmp/gallery-old /tmp/gallery-new
```

Expect 0 on every tile **except** 03, whose top band carries a live NWS weather
string. Tiles whose only diff is the clock digits are the intermittent
`emu-set-time` no-op, not a regression — confirm by checking that the
phone-side `Composite … hash <h>` line matches across the two runs, which
settles whether the *image* changed independently of the text.

`capture.sh` is written to fail loudly rather than emit a wrong tile: it checks
the exit status of `emu-time-format`, `emu-battery` and `emu-set-time` (each
tries to launch a *second* emulator and exits 1 if the flags are missing), and
it polls the log for `Decoded composite` with a 240 s deadline instead of
sleeping a fixed interval. It also keeps the whole emulator sequence inside one
shell invocation and drives `pkill` from a script file — both load-bearing, and
both explained in CLAUDE.md. Do not inline its commands into a compound shell
command.

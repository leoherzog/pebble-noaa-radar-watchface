# Gallery screenshots

How `screenshots/gallery/` is produced, and why each tile is what it is.

Twelve scenarios × four platforms (emery, basalt, gabbro, chalk) = 48 tiles,
plus one contact sheet per platform. Regenerating them is
`screenshots/tools/capture.sh <platform> <id>`, but **three temporary source
patches have to be applied first** — see [Reproducing](#reproducing).

General emulator behaviour, such as `--vnc`, `pkill`, one shell invocation
and localstorage seeding, lives in the workspace `CLAUDE.md`. The radar-source
survey, the `emu-set-time` traps, which `emu-*` commands work on which
platform, the scratch-copy lock trap and the decode ceilings appear in both
files; change them together.

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
  PostGIS error as a WMS XML exception under HTTP 200, which `fetchPng()` logs
  only as `Not a PNG`.
- **Same `TIME` → byte-identical composite, while the basemap holds still.**
  The radar frame is pinned, so the `tx_hash` cache is not fought. The
  USGS topo layer is live, though, and is re-rendered from time to time:
  labels move, and roads and water fold to different palette entries. A tile
  re-captured weeks later can differ from the committed one across the whole
  map, so judge a code change against a same-day capture of the old build,
  never against the committed tiles.
- **The colour ramp is not the shipped one.** IEM serves the classic NWS ramp,
  which the shipped MRMS layer does not use, so these tiles do not show the
  shipped colours. That is accepted for gallery imagery only; this source must
  not ship. NOAA's own time-enabled service matches the shipped ramp but keeps
  only four hours, too little for a gallery. CLAUDE.md's "Swapping the radar
  source" paragraph, under Image pipeline, has the survey.

Every frame goes through the shipped pipeline (the `fetchPng()` shrink, then
`buildComposite()` with the round mask on gabbro and chalk) at all four display
sizes, and fits each platform's decode limit in CLAUDE.md's Memory section with
room to spare. The tightest fit is Seattle on chalk at **8,842 B, under two
fifths of the largest composite chalk accepts**. `scenarios.json` records each
frame's composite bytes, pre-fold colour count and share of that limit under
`verify`. The limit moves with the build heap and the bytes with the basemap,
so recompute a percentage from fresh bytes before quoting it.

The emulator runs the same `composite.js`, so a capture log's `Composite <N> B,
<C> colors -> <F>, hash <h>` line matches a node measurement of the same frame
byte for byte, provided both fetched the basemap on the same day.

### How the frames were chosen

A scan sampled the archive four times a day across a season per city, scoring
each frame on wet coverage, warm-colour (high dBZ) fraction and tier count.

Coverage is rewarded only inside a 15–45% band and penalised past it.
Maximising it picks frames that are a solid slab of colour with no visible
basemap, which is not a watchface screenshot. New Orleans is deliberately
pinned outside the band because Francine's eye is worth more than the score.

## The twelve tiles

Slot columns are in **display order**: Top 1 / Top 2 / Bottom 1 / Bottom 2.
Fonts are XS/S/M/L/XL, a `*` meaning shrink to fit.

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
| 10 | New York NY | 2025-09-05 03:20 | City | opaque | capture day 09:07 | 12h | — / Time / Sunrise-Sunset / Humidity | XL, M\*, XS | black / yellow | dark-on-light inversion |
| 11 | Washington DC | 2025-07-31 18:10 | State | opaque | Sat 23:48 | 24h | High-Low / Time / Wind / Pressure | XS, L, XS, XS | white / dark red | metric; battery 15% |
| 12 | Honolulu HI | 2025-03-17 05:50 | City | translucent | Fri 14:26 | 12h | Lat/Long / Time / Weekday / — | XS, L, S | navy / white | non-CONUS, Lat/Long slot |

Coverage of the variety axes: **zoom** City ×5, State ×4, Region ×3 · **radar
mode** translucent ×6, opaque ×6 · **clock** 12h ×7, 24h ×5 · **line count** 1,
2, 3 and 4 all present · **units** imperial ×10, metric ×2 · every fixed size
except Super Large, plus two shrink-to-fit sizes · twelve distinct text/outline
colour pairs · slot kinds Time, Date, Weekday, ISO Date, Battery, Bluetooth,
Heart Rate, Steps, Distance, Radar Age, Lat/Long, Current Conditions, Today's
Forecast, High/Low, Humidity, Wind, Pressure, Sunrise/Sunset and
Alerts-else-Conditions.

**The weather strings are pinned, not live and not historical.**
`api.weather.gov` has no usable archive: `/alerts` retains about a week and
gridpoint forecasts are current-only. So each of the six weather tiles (03, 04,
05, 09, 10, 11) carries a `weather` field in `scenarios.json`, recorded once
from a live fetch at its location, and every platform and every re-capture
renders the same text. The text is there to show the slots working, not to
describe the archived storm. [Pinned weather](#pinned-weather) says how it is
seeded and re-recorded.

## Platform differences

The four platforms run the same scenarios unchanged. basalt and chalk run
frozen firmware and QEMU images, and most of what differs follows that line.
`emu-probe.sh` re-tests the first three rows:

| | emery | basalt | gabbro | chalk |
|---|---|---|---|---|
| `emu-steps` moves Steps | yes | no | yes | no |
| `emu-heart-rate` moves Heart Rate | yes | no | no | no |
| `pebble screenshot` works after `emu-bt-connection --connected no` | yes | no | yes | no |
| `emu-set-timeline-quick-view` obstructs the face | yes | untested | yes | no |
| Battery reads in steps of | 1% | 10% | 1% | 10% |
| Persisted composite (`Restored composite` in the log) | yes | no | yes | no |

- **Injected health shows only from the face's next minute tick**, so a
  screenshot taken seconds after `emu-steps` or `emu-heart-rate` still reads
  `0` and `-- bpm`. Neither command moves Distance, and both exit 0 where they
  do nothing, so tile 07 keeps the `format_slot()` stub below on every
  platform.
- **`emu-bt-connection --connected no` does drop the link**, and the watch
  shows it 20–30 s later, badge included. On basalt and chalk the drop also
  cuts pebble-tool's own channel, so `pebble screenshot` and every later
  `emu-*` command time out. On chalk a VNC framebuffer grab still sees the
  face, but in different colours from `pebble screenshot`, so it cannot stand
  in for a tile. No tile shows the badge.
- **Tile 02's 42% battery reads `40%` on basalt and chalk.**
- **Without a persisted composite**, a relaunch's first frame comes from the
  phone's `Replaying last composite`. `persist_get_max_size()` is a constant
  4096 on basalt and chalk, which compiles the watch-side cache out. The
  `Decoded composite` line is still the one to poll for.
- **chalk's Quick View layout cannot be captured in the emulator.** Its
  unobstructed area stays 180 px tall with or without a pin.
- **No tile sets an outer line above Small**, so chalk's outer-line cap never
  fires and every chalk tile uses the scenario's own sizes. On gabbro and chalk
  every line narrows to the chord of the circle at its height (CLAUDE.md, Text
  slot layout), so a round tile can shorten or ellipsize a string that fits on
  a rectangle.
- **A chalk tile takes about a minute**, against about 40 s elsewhere, and its
  boot fails more often. The first `pebble install` sometimes exits at once
  with `[Errno 111] Connection refused`; `capture.sh` retries, and a retry that
  half-boots waits out the full 420 s timeout before the tile fails. Re-run any
  tile the sweep reports as failed.

## Watch clock

Each tile sets its own clock via `pebble emu-set-time`, which moves only the
watch. The general behaviour — why it beats libfaketime here, why it has to run
*after* the final `pebble install`, and the 3 h `WX_MAX_AGE` ceiling on forward
motion — is in CLAUDE.md under "Running the emulator from a non-graphical
shell". What is specific to this gallery:

- Ten tiles are set **backwards**, to spread times of day and weekdays across
  the sheet. Backwards is free except for a sun slot: the phone computes the
  span for the real date, and the watch renders a span that starts after its own
  tomorrow as a date.
- **Tile 10 shows Sunrise/Sunset**, so its clock is `today 09:07:00`, which
  `capture.sh` resolves on the capture date. Capture it after 06:07 local time:
  any earlier and the watch runs more than 3 h ahead of the phone, so
  `WX_MAX_AGE` blanks its Humidity slot to `--`.
- **Tile 04 is set forwards**, to `now + 7 min`, because it is the tile that
  displays Radar Age — `watch_now - s_radar_time` — and a backwards clock clamps
  that to `0 min`. Seven minutes reads as a plausible age and stays far inside
  the 3 h weather window. It is the one tile whose clock differs across
  platforms, by the time between their captures, which `sweep.sh`'s
  tile-major order keeps to about a minute per platform.
- `emu-set-time` occasionally no-ops, leaving a tile at wall-clock time. Read
  the tiles back and re-run any that did.
- `pebble screenshot` resyncs the watch clock to host time after it captures.
  The tile is unaffected, but anything the app logs after the screenshot
  describes host time, not the frame photographed.

## Pinned weather

A weather tile's `weather` field holds the `wx_obs`, `wx_fcst` and
`wx_alerts` records its slots read, in exactly the shape `index.js` persists
them: `t` in epoch milliseconds, values in the API's own units, so the tile's
`units` setting still converts them. `seed.py` writes each record with `t`
restamped to seed time, which holds `fetchWeather()` behind its 9-minute
observation and 59-minute forecast gates for the whole capture, and shifts
every alert `on` and `ex` by the same amount. It also writes `wx_lkey`,
without which `fetchWeather()` drops every cache as another place's, and
`WxPinned` for patch 3. `fetchObs()` tests the station's own timestamp
against its 2 h window only on a live response and never persists it, so `t`
is the only stamp to move.

To re-record a tile, delete its `weather` field and capture it once from the
patched build; without `WxPinned` every fetch is live. Before the next
`seed.py` run wipes it, read the records out of the platform's pypkjs store at
`~/.local/share/pebble-sdk/<sdk-version>/<platform>/localstorage/<app-uuid>`
and paste them into the field. Keep only what the slots read: `wx_obs` for
Current Conditions, Temperature, Feels Like, Dew Point, Humidity, Wind,
Pressure and the alert-else-Conditions slots, `wx_fcst` for the forecast and
High/Low slots, `wx_alerts` for any alert slot. The records are
platform-independent, so one capture on any platform serves all four.

The phone fits each string to the display only when it assembles the payload,
so one record can still abbreviate differently per platform. basalt uses the
144 px table on every line and chalk on its inner lines, chalk's outer lines
cap at Small, and gabbro's outer lines have their own table
(`ROUND_PLATFORMS` in `index.js`). After a capture, `wx_payload` in the same
store holds the strings the phone sent.

Tile 10's sun span is not pinned. The phone computes it from its own clock,
so it rolls to the next day's pair at New York's sunset; capture all four
platforms of that tile on the same side of it.

## Reproducing

Three temporary source patches are needed, and **all three are reverted in
the committed tree** because none may ship.

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

and change the radar fetch in `locationSuccess()` from
`fetchPng(exportUrl(RADAR_URL, bbox, true), …)` to `fetchPng(radarUrl(bbox), …)`.

**2. `src/c/main.c`** — fake the health slots, needed only by tile 07.
Injection moves Steps only on emery and gabbro, Heart Rate only on emery and
Distance nowhere (see [Platform differences](#platform-differences)), so a
four-platform sweep needs this stub. Revert it before running `emu-probe.sh`,
which would otherwise report a false positive. Insert at the top of
`format_slot()`, before its `switch`:

```c
  switch (kind) {
    case 2:  snprintf(buf, size, "%d", 10247); return;   // Steps
    case 8:  snprintf(buf, size, "4.6 mi");    return;   // Distance
    case 12: snprintf(buf, size, "72 bpm");    return;   // Heart rate
    default: break;
  }
```

**3. `src/pkjs/index.js`** — serve the seeded alerts. `/alerts/active` is
refetched on every heartbeat with no interval gate, so a seeded `wx_alerts`
would be overwritten by live alerts. Add as the first line of
`fetchAlerts()`:

```js
  if (localStorage.getItem('WxPinned')) { cb(); return; }
```

`seed.py` sets `WxPinned` only for a scenario with a `weather` field. The
early return also skips the timeline push, which the emulator cannot deliver
anyway.

Then `pebble build`, and:

```sh
bash screenshots/tools/sweep.sh "emery basalt gabbro chalk" "10 1 2 3 4 5 6 7 8 9 11 12"
```

`sweep.sh` runs tile-major: all four platforms capture one tile before the
next tile starts, so tile 04's clock differs least across platforms. Tile 10
goes first because its clock resolves on the capture date: a late-evening
sweep that reached it after midnight would set it more than 3 h ahead of the
phone (see [Watch clock](#watch-clock)). About 45 s per tile on emery and
gabbro, 50 s on basalt and up to a minute on chalk, so roughly 40 minutes for
all 48, plus 7 minutes for each boot that half-fails and waits out its
timeout. Revert the patches afterwards and `pebble clean && pebble build` to
confirm the heap report is unchanged.

The patches can instead go in a scratch copy of the project, leaving the
committed tree untouched. Run the committed tools from inside the copy:
`pebble install` takes the `.pbw` from the working directory, while tiles land
in the tools' own tree unless `GALLERY_DIR` redirects them. Copy the project
without `build/` and `.lock-waf_linux_build`: `pebble clean` in a copy that
kept the lock deletes the original's `build/` and lock file.

Then rebuild each contact sheet, and re-copy the store screenshots and banners
if tiles 02, 11, 05, 03 or 10 changed:

```sh
uv run --with pillow python screenshots/tools/contact.py <platform>
```

### The tools

- `screenshots/tools/scenarios.json` — the twelve tiles plus the two diff gates
  below: location, radar timestamp, zoom, mode, units, battery, clock, the full
  `cfg2` blob, each tile's per-platform composite under `verify`, and the
  weather tiles' pinned records under `weather`. A clock is
  `YYYY-MM-DD HH:MM:SS`, `today HH:MM:SS` (the capture date) or `now+<N>m`.
- `screenshots/tools/seed.py` — writes one scenario into a platform's pypkjs
  `dbm.dumb` localStorage (`cfg2`, the phone-side keys and any pinned weather),
  after wiping `qemu_spi_flash.bin` and the whole localstorage directory. Both
  the seeding format and why the wipe is mandatory rather than hygiene are in
  CLAUDE.md. It does not write `TimelineAlerts`, so every tile runs at that
  setting's *on* default. A tile without pinned weather makes one extra alerts
  fetch, plus a `TL insertTimelinePin unavailable` log line when the point has
  a severe alert; a pinned tile makes no NWS request at all. Neither is visible
  in the capture. Seed the key to `'0'` if a scenario needs the off arm.
- `screenshots/tools/capture.sh` — one tile end to end, printing its elapsed
  seconds. `GALLERY_DIR` redirects the output; `PEBBLE_EMULATOR_VERSION` pins
  the emulator's SDK and is forwarded to every emulator-touching command as
  `--sdk`. The `.pbw` must be built by that SDK too. Logs go to
  `/tmp/pebble-gallery-logs/`: `<platform>-<NN>-<slug>.log` from the app and
  `.boot.log` from the booting install.
- `screenshots/tools/sweep.sh` — drives `capture.sh` over a set of platforms
  and scenarios, tile-major. It exists so the invoking command line is just
  `bash sweep.sh …`: `capture.sh` runs `pkill -f 'qemu-pebbl[e]'`, and the
  bracket trick only stops the pattern matching *its own* literal — a loop
  typed at the prompt that mentions qemu would be killed by it.
- `screenshots/tools/contact.py` — builds `gallery/contact-<platform>.png` from
  that platform's twelve tiles: four across, 2× nearest-neighbour, each under
  its number and name from `scenarios.json`. Tile size comes from the tiles, so
  any display shape works.
- `screenshots/tools/pixdiff.py` — pixel-diffs two gallery trees and reports
  differing-pixel counts per tile, using PIL. Tiles are enumerated from the
  first tree; one missing from the second is reported rather than skipped, but
  one missing from the first is never compared.
- `screenshots/tools/emu-probe.sh` — re-tests the firmware-dependent emu-*
  commands after an SDK upgrade, with the health stub reverted and
  non-colliding injection values. It screenshots after the next minute tick,
  then drops the Bluetooth link last and reports whether a second screenshot
  still gets through, since on some platforms the drop ends the session.
- `screenshots/tools/banner.py` and `banner_bg.py` — the 720×320 appstore
  marketing banners in `screenshots/banner/`, one per platform. No emulator
  involved: the watch screen is a `screenshots/store/` PNG at native pixels and
  the backdrop is a plain topo+radar fetch at banner size. Rationale and the
  build command are in `STORE.md` under Marketing banner. `screenshots/store/`
  holds renamed copies of gallery tiles 02, 11, 05, 03 and 10 for each
  platform, 20 files; after re-capturing any of those, re-copy it and re-run
  `banner.py`, which reads the store files.

**Two scenarios are diff gates rather than gallery tiles.** 13
(`autofont-deterministic`) puts three of four slots on auto fonts with every
string deterministic — Lat/Long, Time, Date, ISO date, no weather and no health
— which is the only way to pixel-diff the shrink-to-fit path that CLAUDE.md
says must never be judged by eye. 14 (`textwidth-stress`) puts **both outer
bands** on Weekday at a fixed Extra Small font, where a round display's chord is
narrowest — so any change in text metrics or in outer-band placement moves those
glyphs and shows up as a diff. Neither gate uses Super Large, fixed or
shrink-to-fit.

Despite its slug, 14 does not cover width fitting. Weekday is `strftime("%A")`
in `format_slot()`, formatted watch-side, so it never reaches
`fitWx`/`budgetFor`/`CHAR_BUDGET_*`, which apply only to the phone-formatted
weather slots (15–28 and 31). Nor does it reach a truncation boundary: at its
Extra Small font even `Wednesday` fits easily. **The phone-side width fitting
and the watch's trailing ellipsis have no diff gate**; covering them would need
a scenario whose pinned `weather` holds a string longer than its budget.

**Comparing two gallery passes.** `capture.sh` writes straight over the
committed tile, so a before/after comparison must redirect one pass or it
compares each tile against itself and reports zero differences no matter what
changed:

```sh
GALLERY_DIR=/tmp/gallery-old bash screenshots/tools/sweep.sh "emery basalt gabbro chalk" "10 1 2 3 5 6 7 8 9 11 12 13 14"
# ... change something ...
GALLERY_DIR=/tmp/gallery-new bash screenshots/tools/sweep.sh "emery basalt gabbro chalk" "10 1 2 3 5 6 7 8 9 11 12 13 14"
uv run --with pillow python screenshots/tools/pixdiff.py /tmp/gallery-old /tmp/gallery-new
```

Expect 0 on every tile, provided both passes run on the same day and on the
same side of New York's sunset: the basemap drifts over weeks, tile 10's clock
resolves on the capture date, and its sun span rolls to the next day's pair at
sunset. Tile 04 is left out because its `now+7m` clock moves with capture time.
Tiles whose only diff is the clock digits are the intermittent `emu-set-time`
no-op, not a regression — confirm by checking that the phone-side
`Composite … hash <h>` line matches across the two runs, which settles
whether the *image* changed independently of the text.

To compare two builds, run each from its own scratch copy (see
[Reproducing](#reproducing)) with its own `GALLERY_DIR`. A baseline copy made
with `git archive <commit>` needs the working tree's `screenshots/tools/`
copied over it, since scenarios, pinned weather and clock forms change with
the gallery.

`capture.sh` is written to fail loudly rather than emit a wrong tile: it checks
the exit status of `emu-time-format`, `emu-battery` and `emu-set-time` (each
tries to launch a *second* emulator and exits 1 if the flags are missing), and
it polls the log for `Decoded composite` with a 240 s deadline instead of
sleeping a fixed interval. It then keeps the log attached until the phone's
`Composite … hash` line lands too, since on a relaunch that line follows the
replayed frame's decode. It also keeps the whole emulator sequence inside one
shell invocation and drives `pkill` from a script file, for reasons given in
CLAUDE.md; do not inline its commands into a compound shell command.

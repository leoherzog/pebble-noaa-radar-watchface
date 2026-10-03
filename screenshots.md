# Gallery screenshots

How `screenshots/gallery/` is produced, and why each tile is what it is.

Twelve scenarios × four platforms (emery, basalt, gabbro, chalk) = 48 tiles,
plus one contact sheet per platform. Regenerating them is
`screenshots/tools/capture.sh <platform> <id>`, but **three temporary source
patches have to be applied first**; see [Reproducing](#reproducing).

General emulator traps live in the workspace `CLAUDE.md`. This file holds what
is specific to the gallery.

## The radar imagery is archived, not live

Live MRMS shows whatever weather exists at capture time, which makes a
twelve-city gallery a matter of luck: most cities are clear most of the time.
Each tile therefore pins a **specific historical 5-minute frame** from the Iowa
Environmental Mesonet's archived NEXRAD `n0q` WMS, which covers 2011-02-16
onward at `PT5M` (from its `GetCapabilities`).

The timestamp travels in the URL, so **the system clock stays at the present**,
clear of the silent TLS failure CLAUDE.md records for a clock faked into the
past.

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
  so the tiles do not show the shipped MRMS colours. That is accepted for
  gallery imagery only; this source must not ship. NOAA's time-enabled service
  has the shipped ramp but keeps only four hours, too little for a gallery.
  CLAUDE.md's "Swapping the radar source" has the survey.

Every frame goes through the shipped pipeline (the `fetchPng()` shrink, then
`buildComposite()` with the round mask on gabbro and chalk) at all four display
sizes, and fits each platform's decode limit in CLAUDE.md's Memory section with
room to spare. The tightest fit, Seattle on chalk at 8,842 B, is under two
fifths of the largest composite chalk accepts. A capture log's `Composite <N> B`
line gives a frame's current bytes, which move with the basemap. A node run of
`composite.js` on the same frame matches it byte for byte when both fetched the
basemap on the same day.

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
| 03 | New Orleans LA | 2024-09-11 18:20 | Region | opaque | Sun 07:28 | 12h | Conditions / Time / Active Alerts / High-Low | XS, XL, M\*, S\* | cyan / navy | **Hurricane Francine's eye**, `Hurricane Warning` |
| 04 | Oklahoma City OK | 2025-06-26 21:00 | City | opaque | now + 7 min | 24h | Alerts-else-Conditions / Time / Date / Radar Age | XS, L, XS, XS | red / white | supercells; Radar Age reads `7 min` |
| 05 | Dallas TX | 2025-04-20 03:10 | State | translucent | Thu 16:05 | 12h | — / Time / Forecast / — | L\*, XS | black / white | **shrink-to-fit** font |
| 06 | Miami FL | 2024-10-09 18:05 | Region | translucent | Mon 12:00 | 12h | — / Time / — / — | XL | magenta / white | single-line minimal, battery 100% |
| 07 | Denver CO | 2025-06-26 02:55 | City | translucent | Tue 06:50 | 24h | Heart Rate / Time / Steps / Distance | XS, L, XS, XS | green / black | health slots (stubbed, see below) |
| 08 | Phoenix AZ | 2024-07-26 02:45 | State | opaque | Fri 20:33 | 12h | — / Time / ISO Date / Active Alerts | XL, M, S | orange / black | monsoon cells, battery 21%; `Heat Advisory`, `Heat Adv` on chalk |
| 09 | Seattle WA | 2024-12-07 17:55 | Region | translucent | Mon 15:20 | 24h | Conditions / Time / Weekday / Bluetooth | XS, L, S, XS | white / dark blue | **metric units**; all-low-dBZ rain |
| 10 | New York NY | 2025-09-05 03:20 | City | opaque | capture day 09:07 | 12h | — / Time / Sunrise-Sunset / Humidity | XL, M\*, XS | black / yellow | dark-on-light inversion |
| 11 | Washington DC | 2025-07-31 18:10 | State | opaque | Sat 23:48 | 24h | High-Low / Time / Wind / Pressure | XS, L, XS, XS | white / dark red | metric; battery 15% |
| 12 | Honolulu HI | 2025-03-17 05:50 | City | translucent | Fri 14:26 | 12h | Lat/Long / Time / Weekday / — | XS, L, S | navy / white | non-CONUS, Lat/Long slot |

Between them the tiles cover every zoom, translucent and opaque radar, both
clock formats, both unit systems, one to four lines, and every fixed size
except Super Large, plus shrink-to-fit. The slot kinds covered are Time, Date,
Weekday, ISO Date, Battery, Bluetooth, Heart Rate, Steps, Distance, Radar Age,
Lat/Long, Current Conditions, Today's Forecast, High/Low, Humidity, Wind,
Pressure, Sunrise/Sunset, Active Alerts and Alerts-else-Conditions.

**The weather strings are pinned, not live and not historical.**
`api.weather.gov` has no usable archive: `/alerts` retains about a week and
gridpoint forecasts are current-only. So each of the seven weather tiles (03,
04, 05, 08, 09, 10, 11) carries a hand-written `weather` field in
`scenarios.json`, and every re-capture renders from the same inputs. Tiles 03
and 08 are written to suit their scenes, a hurricane at landfall and a desert
heat wave; the others show the slots working and do not describe the archived
storm. [Pinned weather](#pinned-weather) says how the field is written and
seeded.

## Platform differences

The four platforms run the same scenarios unchanged. basalt and chalk run
frozen firmware and QEMU images, and most of what differs follows that line.
`emu-probe.sh` re-tests the first three rows:

| | emery | basalt | gabbro | chalk |
|---|---|---|---|---|
| `emu-steps` moves Steps | yes | no | yes | no |
| `emu-heart-rate` moves Heart Rate | yes | no | no | no |
| `pebble screenshot` works after `emu-bt-connection --connected no` | yes | no | yes | no |
| `emu-set-timeline-quick-view` obstructs the face | yes | yes | yes | no |
| Battery reads in steps of | 1% | 10% | 1% | 10% |
| Persisted composite (`Restored composite` in the log) | yes | no | yes | no |

- **No platform's injection moves all three of tile 07's health slots**, so
  tile 07 keeps the `format_slot()` stub ([patch 2](#reproducing)) on every
  platform.
- **On chalk a VNC framebuffer grab still sees the face after the Bluetooth
  drop**, but in different colours from `pebble screenshot`, so it cannot stand
  in for a tile. No tile shows the disconnected badge.
- **Tile 02's 42% battery reads `40%` on basalt and chalk.**
- **basalt and chalk have no persisted composite**, so a relaunch's first frame
  there comes from the phone's `Replaying last composite`. Poll for `Decoded
  composite` on every platform.
- **No tile sets an outer line above Small**, so chalk's outer-line cap never
  fires and every chalk tile uses the scenario's own sizes. On gabbro and chalk
  every line narrows to the chord of the circle at its height (CLAUDE.md, Text
  slot layout), so a round tile can shorten or ellipsize a string that fits on
  a rectangle.
- **chalk's boot fails more often.** The first `pebble install` sometimes exits
  at once with `[Errno 111] Connection refused`. `boot()` in `emu.sh` retries
  once, and a retry that half-boots waits out the 420 s timeout before the tile
  fails. Re-run any tile the sweep reports as failed.

## Watch clock

Each tile sets its own clock with `pebble emu-set-time`. Its traps, including
the clock race in `pebble screenshot`, are in CLAUDE.md under "Running the
emulator from a non-graphical shell". What is specific to this gallery:

- Ten tiles are set **backwards**, to spread times of day and weekdays across
  the sheet. Backwards is free except for a sun slot: the phone computes the
  span for the real date, and the watch renders a span that starts after its own
  tomorrow as a date.
- **Tile 10 shows Sunrise/Sunset**, so its clock is `today 09:07:00`, which
  `capture.sh` resolves on the capture date. Capture it after 06:07 local time:
  any earlier and the watch runs more than 3 h ahead of the phone, so
  `WX_MAX_AGE` blanks its Humidity slot to `--`.
- **Tile 04 is set forwards**, to `now + 7 min`, because it is the tile that
  displays Radar Age, `watch_now - s_radar_time`, and a backwards clock clamps
  that to `0 min`. Seven minutes reads as a plausible age and stays far inside
  the 3 h weather window. It is the one tile whose clock differs across
  platforms, by the time between their captures, which `sweep.sh`'s tile-major
  order keeps small.

## Pinned weather

A weather tile's `weather` field is written by hand, and holds inputs, never
finished strings. `seed.py` builds the `wx_obs`, `wx_fcst` and `wx_alerts`
records from it in the shape `index.js` persists them, stamped with the seed
time, and `assembleWx()` builds every string from those. The tile's `units`
setting still converts the values, and each platform fits and abbreviates its
own text. Write only what the tile's slots read:

| Field | Feeds | Entry |
|---|---|---|
| `obs` | Current Conditions, Temperature, Feels Like, Dew Point, Humidity, Wind, Pressure and the alert-else-Conditions slots | one observation in the API's units: `temp`, `dp`, `hi` and `wc` in °C, `desc`, `rh` in percent, `ws` and `wg` in km/h, `wd` in degrees, `pr` in Pa |
| `fcst` | the forecast and High/Low slots | the first two forecast periods in order, each `n` (its name), `d` (true for a daytime period), `t` in °F and `s` (the short forecast) |
| `alerts` | every alert slot | a list of alerts, each `e` (the event name) and `sv` (Extreme, Severe, Moderate or Minor), plus optionally `ur`, `on` and `ex` |

```json
"weather": {
  "obs": { "temp": 26, "desc": "Rain", "ws": 56, "wd": 70, "wg": 93 },
  "fcst": [
    { "n": "Today", "d": true, "t": 82, "s": "Hurricane Conditions" },
    { "n": "Tonight", "d": false, "t": 74, "s": "Tropical Storm Conditions" }
  ],
  "alerts": [
    { "e": "Hurricane Warning", "sv": "Extreme" },
    { "e": "Flood Watch", "sv": "Severe", "ur": "Future", "on": "+3h", "ex": "+2d" }
  ]
}
```

- **An `obs` key left out is seeded as `null`**, which is what a station that
  drops the field leaves, and its slot reads `--`.
- **High/Low labels the periods in order**, so a daytime first period reads
  `H 82° L 74°` and a night one `L 74° H 82°`.
- **Alert times are offsets from the seed time**: `-1h`, `+45m`, `+2d`. `on`
  defaults to `-1h` and `ex` to `+6h`, an alert in effect with hours left. A
  future `on` makes the alert upcoming: Active Alerts leaves it out, and
  Alerts + Upcoming shows it with its lead time, `Flood Watch in 3h`, when it
  ranks first. `null` means no onset or no expiry.
- **`sv` and `ur` rank the alerts** as `WX_SEV` and `WX_URG` do in `index.js`,
  and a line shows the top one's name, with `+n` for the rest. `ur` is
  Immediate, Expected or Future, and defaults to Expected.
- **`"alerts": []` pins no alert**, which is how tile 04's
  Alerts-else-Conditions line shows its conditions.
- **`seed.py` exits on a key or word it does not know**, before it wipes the
  store.

`seed.py` also writes `WxPinned`, and patch 3 then sends the assembled payload
on every heartbeat and fetches nothing. A slot whose field is missing
therefore reads `--`, or nothing for an alert slot, instead of going to NWS.
The phone decides in effect or upcoming on its own clock; the watch only
clears an alert once its own clock passes `ex`, so a tile clock set forwards
must stay short of it.

The phone fits each string to the display only when it assembles the payload,
so one input can abbreviate differently per platform; CLAUDE.md's Weather
slots section has the budget tables. After a capture, `wx_payload` in the
platform's pypkjs store at
`~/.local/share/pebble-sdk/<sdk-version>/<platform>/localstorage/<app-uuid>`
holds the strings the phone sent.

Tile 10's sun span is not pinned. The phone computes it from its own clock,
so it rolls to the next day's pair at New York's sunset; capture all four
platforms of that tile on the same side of it.

## Reproducing

Three temporary source patches are needed, and **all three are reverted in
the committed tree** because none may ship.

**1. `src/pkjs/index.js`**: route the radar layer to the archive. Add after
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

**2. `src/c/main.c`**: fake the health slots, needed only by tile 07 (see
[Platform differences](#platform-differences)). Revert it before running
`emu-probe.sh`, which would otherwise report a false positive. Insert at the
top of `format_slot()`, before its `switch`:

```c
  switch (kind) {
    case 2:  snprintf(buf, size, "%d", 10247); return;   // Steps
    case 8:  snprintf(buf, size, "4.6 mi");    return;   // Distance
    case 12: snprintf(buf, size, "72 bpm");    return;   // Heart rate
    default: break;
  }
```

**3. `src/pkjs/index.js`**: send the seeded weather and fetch nothing. Add as
the first line of `fetchWeather()`:

```js
  if (localStorage.getItem('WxPinned')) { sendWx(assembleWx(lat, lon)); return; }
```

`seed.py` sets `WxPinned` only for a scenario with a `weather` field. The
early return skips every NWS request, so no interval gate, location change or
live alert can replace a seeded record. It also skips the timeline push, which
the emulator cannot deliver anyway.

Then `pebble build`, and:

```sh
bash screenshots/tools/sweep.sh "emery basalt gabbro chalk" "10 1 2 3 4 5 6 7 8 9 11 12"
```

`sweep.sh` runs tile-major: all four platforms capture one tile before the
next tile starts, so tile 04's clock differs least across platforms. Tile 10
goes first because its clock resolves on the capture date: a late-evening
sweep that reached it after midnight would set it more than 3 h ahead of the
phone (see [Watch clock](#watch-clock)). All 48 tiles take roughly 40 minutes,
longer for each boot that half-fails. Revert the patches afterwards and
`pebble clean && pebble build` to confirm the heap report is unchanged.

The patches can instead go in a scratch copy of the project, leaving the
committed tree untouched; make the copy as CLAUDE.md's `.lock-waf_linux_build`
bullet says. Run the committed tools from inside the copy: `pebble install`
takes the `.pbw` from the working directory, while tiles land in the tools' own
tree unless `GALLERY_DIR` redirects them.

Then rebuild each contact sheet:

```sh
uv run --with pillow python screenshots/tools/contact.py <platform>
```

`screenshots/store/` holds copies of tiles 02, 11, 05, 03 and 10 for each
platform, under the names in STORE.md's Screenshots table. If any of those
tiles changed, re-copy it and re-run `banner.py`, which reads the store files.

### The tools

All of them live in `screenshots/tools/`.

- `scenarios.json`: the twelve tiles plus the two diff gates below, each with
  location, radar timestamp, zoom, mode, units, battery, clock, the full `cfg2`
  blob and, for a weather tile, its hand-written `weather` inputs
  ([Pinned weather](#pinned-weather)). A clock is `YYYY-MM-DD HH:MM:SS`,
  `today HH:MM:SS` (the capture date) or `now+<N>m`.
- `seed.py <platform> <scenario-id>`: wipes `qemu_spi_flash.bin` and the whole
  localstorage directory, then writes the scenario into the platform's pypkjs
  store: `cfg2`, the phone-side keys and the weather records. CLAUDE.md has the
  seeding format and why the wipe is mandatory. It does not write
  `TimelineAlerts`, so every tile runs with pins on: a tile without pinned
  weather makes one extra alerts fetch, plus a `TL insertTimelinePin
  unavailable` log line when the point has a severe alert, while a pinned tile
  makes no NWS request at all. Neither shows in the capture; seed the key to
  `'0'` if a scenario needs the off arm. The flash wipe makes every capture a
  first run on the watch, logged as `First run, text size <n>`, and the seeded
  `cfg2` then sets all four sizes, so the emulator's Text Size never reaches a
  tile.
- `emu.sh`: sourced by `capture.sh` and `emu-probe.sh`, never run. It holds
  `cleanup`, `boot` with its single retry, `relaunch_logged`, and the `--sdk`
  argument built from `PEBBLE_EMULATOR_VERSION` that both scripts pass to every
  `pebble` command.
- `capture.sh <platform> <id>`: one tile end to end, printing its elapsed
  seconds and exiting non-zero on any failed step. `GALLERY_DIR`
  redirects the output. `PEBBLE_EMULATOR_VERSION` pins the emulator's SDK, which
  must also have built the `.pbw`. Logs go to
  `${TMPDIR:-/tmp}/pebble-gallery-logs/<platform>-<NN>-<slug>.log`, with a
  `.boot.log` beside it from the booting install.
- `sweep.sh "<platforms>" "<ids>"`: runs `capture.sh` over them tile-major and
  counts failures. Use it rather than a loop typed at the prompt; its header
  says why.
- `contact.py <platform> [gallery-dir]`: builds `gallery/contact-<platform>.png`
  from that platform's twelve tiles.
- `pixdiff.py <dir-a> <dir-b>`: counts differing pixels per tile, for the tiles
  in `<dir-a>`.
- `emu-probe.sh <platform> [scenario-id]`: re-tests the firmware-dependent
  `emu-*` commands after an SDK upgrade, on scenario 07 by default, with the
  health stub reverted. Its screenshots and logs go to
  `${TMPDIR:-/tmp}/emu-probe-<platform>-<id>*`.
- `banner_bg.py` and `banner.py`: the banner backdrop and the four store
  banners in `screenshots/banner/`, built as STORE.md's Marketing banner says.
- `icon.py`: the two store icons in `screenshots/icon/`, built as STORE.md's
  Icons section says.

**Two scenarios are diff gates rather than gallery tiles.** 13
(`autofont-deterministic`) puts three of four slots on auto fonts with every
string deterministic (Lat/Long, Time, Date, ISO date, no weather and no
health), which is the only way to pixel-diff the shrink-to-fit path that
CLAUDE.md says must never be judged by eye. 14 (`textwidth-stress`) puts
**both outer bands** on Weekday at a fixed Extra Small font, where a round
display's chord is narrowest, so any change in text metrics or in outer-band
placement moves those glyphs and shows up as a diff. Neither gate uses Super
Large, fixed or shrink-to-fit. Neither covers the first-run sizes either: every
scenario seeds `cfg2`, which sets all four sizes, so a first-run change needs a
capture from a store with no `cfg2` (CLAUDE.md, "Running the emulator from a
non-graphical shell").

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
A tile whose only diff is the clock digits shows the screenshot clock race (see
[Watch clock](#watch-clock)), not a regression. Confirm it by checking that the
phone-side `Composite … hash <h>` line matches across the two runs, which
settles whether the *image* changed independently of the text.

To compare two builds, run each from its own scratch copy (see
[Reproducing](#reproducing)) with its own `GALLERY_DIR`. A baseline copy made
with `git archive <commit>` needs the working tree's `screenshots/tools/`
copied over it, since the tools, scenarios, pinned weather and clock forms
change with the gallery.

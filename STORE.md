# Pebble App Store Listing

Copy and assets for the
[appstore listing](https://apps.repebble.com/2029ab9c84f946e1b125f8e0): what
`pebble publish` prompts for, plus the fields the web dashboard
(`appstore-api.repebble.com/dashboard`) lets you edit afterwards. The full
description must not go live before the build whose features it names.

## App name

NOAA US Weather Radar

(Must match `pebble.displayName` in `package.json`, which the PBW carries as
`longName`. The CLI offers it as the default — press Enter to keep it.)

## Tagline

A highly customizable NOAA storm radar watchface

## Short description

Live NOAA base reflectivity radar on top of a USGS topographic map,
centered on your location or a specified location.  Customize with time, date,
health stats, and/or National Weather Service conditions, forecasts and alerts.
Four text lines, three zoom levels, and your choice of colors. United States only.

## Full description

Your watch can tell you it's raining. Wouldn't it be better if it showed you the
storm?

NOAA US Weather Radar fills your Pebble's screen with live weather radar
centered on your location — the same NOAA base reflectivity imagery you'd check
on your phone, composited over a USGS topographic basemap and refreshed as often
as every five minutes.

Your phone does the heavy lifting. It finds your location, fetches the map
imagery and National Weather Service data, blends the radar into the basemap,
squeezes the result down to something a tiny watch can decode, and streams it
over Bluetooth. The watch just draws it.

**Features**

- Full-screen live radar over a topographic basemap, with a marker at your position
- Follows you as you move, or pin it to a fixed latitude and longitude
- Three zoom levels — City (100 km), State (250 km), or Region (500 km) across the screen
- Four configurable text lines: time, date, weekday, steps, distance, calories, sleep, heart rate, battery, Bluetooth, radar age, lat/long and more, each with its own size from Extra Small up to Super Large, including shrink-to-fit
- Follows your watch's Text Size: if it is set to Larger when the face first runs, the time starts at Super Large and, on Pebble Time 2 and Pebble Round 2, the date at Extra Large
- Custom text and outline colors — every line gets a halo so it stays readable over busy map areas
- National Weather Service weather: current conditions, temperature, feels like, dew point, humidity, wind, pressure, today's forecast, tonight/tomorrow, high/low, and active alerts, in imperial or metric units
- Sunrise/sunset and the golden hour window, computed for your exact location and shown in your watch's own 12- or 24-hour format
- Alert-aware lines that show your normal weather until an alert takes over, or count down to one that hasn't started yet, and clear themselves when the alert expires even if your phone is out of reach
- Severe alerts pushed to your Pebble timeline as pins that last as long as the alert does, multi-day alerts included, with yellow cards for watches and red for warnings
- Translucent, opaque, or radar off entirely — it makes a fine plain topo map face
- A Bluetooth badge appears the moment your phone goes out of range, so you know the radar has stopped updating
- Frugal by design: imagery is cut to 16 colors before it leaves the phone, an unchanged refresh isn't sent to the watch at all, and weather is only fetched when a weather line is actually configured or timeline pins are on

Radar, basemap, and weather come from NOAA, the USGS National Map, and
api.weather.gov — all free, no API keys, no accounts.

**Before you install**

- Coverage is **United States only**. These are US government services; there is
  no imagery or weather outside the country.
- Needs the Pebble phone app for location, networking, and settings. The
  yellow and red timeline cards need version 1.14.0.1 or newer.
- Works on Pebble Time / Time Steel (basalt), Pebble Time Round (chalk),
  Pebble Time 2 (emery), and Pebble Round 2 (gabbro).
- On Pebble Time Round, the outermost top and bottom lines go up to Small,
  because that is where the round screen is narrowest.

## Category

Not applicable: `pebble publish` skips the category prompt for watchfaces, and
the Rebble portal takes neither a category nor app icons for them.

## Icons

`screenshots/icon/icon_80x80.png` is the Small Icon and
`screenshots/icon/icon_144x144.png` the Large Icon, both uploaded under App
Icons in the web dashboard. `pebble publish` asks for icons only while creating
a watchapp, so it never prompts for these.

Icons are optional for a watchface, and both sizes are recommendations. The
store keeps whatever file it is given, PNG, GIF or JPEG, with or without alpha,
and serves it as `list_image` in its API. The web store shows a face's icon
only where the listing has no screenshot; the listing page and the Pebble phone
app show icons for watchapps alone. Where the web store shows an icon it rounds
the corners and draws the border itself, so both files are opaque full-bleed
squares.

The icon in the watch's own Watchfaces list is not a store asset. It is the
build resource `resources/images/menu_icon.png`.

Built by `screenshots/tools/icon.py`:

```sh
uv run --with pillow --with numpy python screenshots/tools/icon.py
```

- The **scene** is Hurricane Ian's eye off Cayo Costa at 2022-09-28 17:45Z,
  175 km across: USGS topo under archived NEXRAD, the gallery's two sources.
  The radar frame is pinned, so a re-run differs only when the basemap has been
  re-rendered.
- The **radar** is smoothed and cut to four flat tiers, so the storm reads as
  one shape at 80 px, where a scaled screenshot is mud. Rain below the lowest
  tier is left out, which shows the map between the rainbands.
- The **marker** is the face's white ring and red dot, enlarged, in the eye.
- Each size is fetched at eight times its pixels and box-averaged down. Neither
  is scaled from the other.
- The tiers are classic NWS colours at floors picked for the icon. They are not
  a legend, and not the shipped MRMS ramp.

## Keywords

weather, radar, noaa, nws, storm, rain, forecast, map, alerts, severe weather,
lightning, hurricane, tornado, precipitation, meteorology

## Screenshots

Five scenes, staged in `screenshots/store/` at native resolution for each
platform — 20 files, since each platform gets its own asset collection. Names
are already in the form `pebble publish` requires (the uploader infers the
platform from everything before the first underscore, so a filename that doesn't
start with `emery_`, `basalt_`, `gabbro_` or `chalk_` is rejected).

| # | Scene | File (per platform) | What it shows |
|---|---|---|---|
| 1 | Minneapolis, MN | `<platform>_1_minneapolis-derecho.png` | A derecho west of the Twin Cities, yellow text, weekday / time / date / battery on all four lines |
| 2 | Washington, DC | `<platform>_2_washington-dc-severe.png` | A line of storms over the Mid-Atlantic at State zoom, 24-hour clock, metric throughout — high/low in °C, wind in km/h, pressure in mb |
| 3 | Dallas, TX | `<platform>_3_dallas-squall-line.png` | Translucent radar over the metroplex with the map showing through, the time at shrink-to-fit above today's forecast |
| 4 | New Orleans, LA | `<platform>_4_new-orleans-francine.png` | Hurricane Francine's eye at Region zoom, opaque radar, current conditions on top, a Hurricane Warning and high/low below |
| 5 | New York, NY | `<platform>_5_new-york-summer-storm.png` | City zoom over the harbor, dark text on a yellow halo — the inverted color scheme — with the sunrise/sunset span and humidity |

## Marketing banner

Four, one per platform, in `screenshots/banner/` at exactly **720×320**:
`emery_banner.png`, `basalt_banner.png`, `gabbro_banner.png`,
`chalk_banner.png`. Each asset collection is per-platform, so each gets a banner
showing that device: the same Minneapolis derecho scene as screenshot 1, on that
watch's own frame at its own pixel count.

Uploaded from the web dashboard; `pebble publish` never asks for a banner, and a
banner is a store asset rather than a build, so it needs no `version` bump.

Built by `screenshots/tools/banner.py` from assets already in the repo, plus one
fetched backdrop and the device frames in the `reference/sdk-docs` checkout:

```sh
uv run --with pillow python screenshots/tools/banner_bg.py --scenario 11 --span-km 380
uv run --with pillow --with resvg-py python screenshots/tools/banner.py
```

- The **watch** is the device artwork the Pebble developer site frames its own
  screenshots in: the SVGs in `reference/sdk-docs` under
  `source/assets/images/pebbles/`, served at
  `https://developer.repebble.com/assets/images/pebbles/<frame>.svg`. They are
  not copied into this repo, and `BANNER_FRAME_DIR` points `banner.py` at
  another directory. `PLATFORMS` names one frame per platform:
  `core-time2-red`, `pebble-time-white`, `core-time-round2-rosegold-14` and
  `pebble-time-round-red-14`. Any other `FRAMES` key for the same watch swaps
  the colour. Rasterize with `resvg-py`: `cairosvg` drops a button from the
  Time 2 frame and misdraws the Time Round's glass.
- The **watch screen** is a `screenshots/store/` PNG at native pixels, 1:1 on
  every platform, so the 16-colour composite and the halo'd slot text stay
  crisp. Nothing is interpolated. The frames are drawn in screen pixels, so the
  screenshot lands on the glass unscaled, at the origin `FRAMES` holds for each
  frame: the display centred on the frame's glass. A round capture keeps the
  display mask it carries as alpha.
- A frame is taller than the banner, so the straps run off the top and bottom
  edges. The Pebble Time 2 body alone is 366 px at 1:1, so that watch sits low,
  with its top lugs and strap in view and its lower edge off the banner. The
  other three show the whole case, and the Round 2's lug tips run off with its
  strap.
- The **backdrop** is a real 720×320 USGS topo plus archived NEXRAD fetch of
  the Washington DC scene (scenario 11, widened to a 380 km span), blurred and
  scrimmed. A blown-up screenshot is mush and drags the watch's clock text with
  it. It is full colour rather than the 16-colour composite, because it is a
  wash behind type, not a claim about what the watch renders. `banner_bg.py`
  uses the same Web Mercator math as `locationSuccess()` in `index.js`, and the
  archive needs full seconds in `TIME`.
- The nine-swatch rule under the title is decoration in classic NWS radar
  colours, like the archived backdrop's. It is not a legend for the face, whose
  live MRMS layer uses a different ramp.

Alternate styles exist behind `--style` (`bleed` and `crisp` build the backdrop
out of a screenshot, `panel` is flat dark) if the fetched backdrop ever needs to
be dropped; `HERO`/`BACKDROP` at the top of the script pick the scenes.

## Release notes — v1.2.1

- **Watchfaces list icon** — the face shows a hurricane icon in the watch's Watchfaces list, in place of the generic one

## Release notes — v1.2.0

Pebble Time Round (chalk) support, and a better fit on round screens:

- **Pebble Time Round** — the face runs on Pebble Time Round. Its outermost top and bottom lines go up to Small, where the round screen is narrowest, and a larger size saved for those lines drops to Small
- **Text stays inside the circle** — on Pebble Time Round and Pebble Round 2, each line fits the width of the screen at its height, shrinking or shortening instead of being cut off by the bezel
- **Bluetooth badge on round watches** — moves to the left edge of the screen, where the round display can show it

And for every watch:

- **Super Large** — a sixth text size, fixed or shrink-to-fit. A Super Large 12-hour clock uses a one-letter am/pm ("10:00p") so it fits
- **Alerts, else Upcoming, else Conditions** — a new line option that shows an alert in effect; if none is, it counts down to the most serious one that hasn't started yet ("Flood Watch in 3h"), and failing that shows current conditions
- **High / Low on narrow lines** — shortens cleanly ("H82° L64°", then just the next high or low) instead of cutting a number off partway
- **Follows Text Size on a fresh install** — if the watch's Text Size is set to Larger, the time starts at Super Large and, on Pebble Time 2 and Pebble Round 2, the date at Extra Large. Installs that already have settings are not changed
- **Watch and warning colors** — a severe alert's timeline card is yellow for a watch and red for a warning. Requires Pebble app 1.14.0.1 or newer.
- **Bugfix for Timeline pins** — a pin for an alert longer than a day now stays until the alert ends, instead of dropping off after 24 hours

## Release notes — v1.1.0

Nine new text-line options:

- **Temperature** — the current temperature on its own, without the conditions text
- **Feels Like** — heat index or wind chill when either genuinely applies, otherwise the air temperature
- **Dew Point**
- **Humidity**
- **Wind** — direction and speed, with the gust appended when it meaningfully exceeds the sustained wind
- **Pressure** — barometric, in inHg or millibars
- **Tonight/Tomorrow Forecast** — the next forecast period, prefixed with its own name ("Tonight: Partly Cloudy") when the line is wide enough
- **Sunrise / Sunset** — the daylight span, computed for your exact location rather than fetched
- **Golden Hour** — the next golden-hour window, shown as a range

And one settings change:

- **The "Temperature" setting is now "Units"** — Imperial (°F, mph, inHg) or Metric (°C, km/h, mb), so one choice drives temperature, wind and pressure together instead of temperature alone

## Release notes — v1.0.0

:tada: Initial release!

## App information

- **Author / company**: Leo Herzog (`companyName` in the built PBW)
- **Version**: 1.2.1 (`versionLabel`)
- **UUID**: `6808fb9d-6728-4be3-8e2a-e65cba4e94c6`
- **Type**: watchface
- **Platforms**: emery, basalt, gabbro, chalk
- **License**: MIT
- **Source URL**: `https://github.com/leoherzog/pebble-noaa-radar-watchface`
- **Support email**: pebble-radar@herzog.tech

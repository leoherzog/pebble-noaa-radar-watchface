# Pebble App Store Listing

Draft copy and assets for the appstore listing. Everything here is what
`pebble publish` prompts for, plus the fields the web dashboard
(`appstore-api.repebble.com/dashboard`) lets you edit afterwards.

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
- Four configurable text lines: time, date, weekday, steps, distance, calories, sleep, heart rate, battery, Bluetooth, radar age, lat/long and more, each with its own size, including shrink-to-fit
- Custom text and outline colors — every line gets a halo so it stays readable over busy map areas
- National Weather Service weather: current conditions, temperature, feels like, dew point, humidity, wind, pressure, today's forecast, tonight/tomorrow, high/low, and active alerts, in imperial or metric units
- Sunrise/sunset and the golden hour window, computed for your exact location and shown in your watch's own 12- or 24-hour format
- Alert-aware lines that show your normal weather until a watch or warning takes over, and clear themselves when the alert expires even if your phone is out of reach
- Severe alerts pushed to your Pebble timeline as pins that last as long as the alert does
- Translucent, opaque, or radar off entirely — it makes a fine plain topo map face
- A Bluetooth badge appears the moment your phone goes out of range, so you know the radar has stopped updating
- Frugal by design: imagery is cut to 16 colors before it leaves the phone, an unchanged refresh isn't sent to the watch at all, and weather is only fetched when a weather line is actually configured

Radar, basemap, and weather come from NOAA, the USGS National Map, and
api.weather.gov — all free, no API keys, no accounts.

**Before you install**

- Coverage is **United States only**. These are US government services; there is
  no imagery or weather outside the country.
- Needs the Pebble phone app for location, networking, and settings.
- Works on Pebble Time / Time Steel (basalt), Pebble Time 2 (emery), and
  Pebble Round 2 (gabbro). Pebble Time Round (chalk) is not supported — its
  180×180 screen clips the outer text lines and has too little memory to decode a
  map image during heavy weather.

## Category

Not applicable. `pebble publish` skips the category prompt for watchfaces
(`app_type == "watchface"`), and the Rebble portal docs confirm watchfaces take
neither a category nor app icons. Nothing to prepare.

## Icons

Not required. The 80×80 / 144×144 icon prompts in `pebble publish` are
watchapp-only. The skill's `create_app_icons.py` does not apply here.

## Keywords

weather, radar, noaa, nws, storm, rain, forecast, map, alerts, severe weather,
lightning, hurricane, tornado, precipitation, meteorology

## Screenshots

Five scenes, staged in `screenshots/store/` at native resolution for each
platform — 15 files, since each platform gets its own asset collection. Names
are already in the form `pebble publish` requires (the uploader infers the
platform from everything before the first underscore, so a filename that doesn't
start with `emery_`, `basalt_` or `gabbro_` is rejected).

| # | Scene | File (per platform) | What it shows |
|---|---|---|---|
| 1 | Minneapolis, MN | `<platform>_1_minneapolis-derecho.png` | A derecho west of the Twin Cities, yellow text, weekday / time / date / battery on all four lines |
| 2 | Washington, DC | `<platform>_2_washington-dc-severe.png` | A line of storms over the Mid-Atlantic at State zoom, 24-hour clock, metric throughout — high/low in °C, wind in km/h with a gust, pressure in mb |
| 3 | Dallas, TX | `<platform>_3_dallas-squall-line.png` | Translucent radar over the metroplex with the map showing through, forecast line at shrink-to-fit |
| 4 | New Orleans, LA | `<platform>_4_new-orleans-francine.png` | Hurricane Francine's eye at Region zoom, opaque radar, current conditions on top and high/low below |
| 5 | New York, NY | `<platform>_5_new-york-summer-storm.png` | City zoom over the harbor, dark text on a yellow halo — the inverted color scheme — with the sunrise/sunset span and humidity |

## Marketing banner

Three, one per platform, in `screenshots/banner/` at exactly **720×320**:
`emery_banner.png`, `basalt_banner.png`, `gabbro_banner.png`. Each asset
collection is per-platform, so each gets a banner showing that device — the same
Minneapolis derecho scene as screenshot 1, in the right body shape at the right
pixel count.

Uploaded from the web dashboard; `pebble publish` never asks for a banner, and a
banner is a store asset rather than a build, so it needs no `version` bump.

Built by `screenshots/tools/banner.py` from assets already in the repo, plus one
fetched backdrop:

```sh
uv run --with pillow python screenshots/tools/banner_bg.py --scenario 11 --span-km 380
uv run --with pillow python screenshots/tools/banner.py
```

- The **watch screen** is a `screenshots/store/` PNG at native pixels — emery and
  gabbro at 1:1, basalt at 1.5× nearest-neighbour — so the 16-colour composite
  and the halo'd slot text stay crisp. Nothing is interpolated.
- The **backdrop** is a real 720×320 USGS topo + archived NEXRAD fetch of the
  Washington DC scene (scenario 11, widened to a 380 km span for the framing),
  blurred and scrimmed. A screenshot blown up 4× was tried first and is mush,
  and it drags the watch's own clock text up with it. Full colour, not the
  16-colour composite: it is a wash behind type, not a claim about what the
  watch renders. `banner_bg.py` uses the same Web Mercator math as
  `index.js:1298`, and the archive still needs full seconds in `TIME`.
- The banner is the one place the reflectivity ramp appears as itself — a nine-
  swatch rule under the title, standing in for a legend the face has no room for.

Alternate styles exist behind `--style` (`bleed` and `crisp` build the backdrop
out of a screenshot, `panel` is flat dark) if the fetched backdrop ever needs to
be dropped; `HERO`/`BACKDROP` at the top of the script pick the scenes.

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
- **Version**: 1.1.0 (`versionLabel`)
- **UUID**: `6808fb9d-6728-4be3-8e2a-e65cba4e94c6`
- **Type**: watchface
- **Platforms**: emery, basalt, gabbro
- **License**: MIT
- **Source URL**: `https://github.com/leoherzog/pebble-noaa-radar-watchface`
- **Support email**: pebble-radar@herzog.tech

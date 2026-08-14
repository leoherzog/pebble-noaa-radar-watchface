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
- National Weather Service weather: current conditions, today's forecast, high/low, and active alerts, in Fahrenheit or Celsius
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
| 2 | Washington, DC | `<platform>_2_washington-dc-severe.png` | A line of storms over the Mid-Atlantic at State zoom, metric high/low, 24-hour clock, battery |
| 3 | Dallas, TX | `<platform>_3_dallas-squall-line.png` | Translucent radar over the metroplex with the map showing through, forecast line at shrink-to-fit |
| 4 | New Orleans, LA | `<platform>_4_new-orleans-francine.png` | Hurricane Francine's eye at Region zoom, opaque radar, current conditions on top and high/low below |
| 5 | New York, NY | `<platform>_5_new-york-summer-storm.png` | City zoom over the harbor, dark text on a yellow halo — the inverted color scheme |

## Marketing banner

None made. Optional for watchfaces (the portal takes one; the CLI never asks for
it). Can be added later from the web dashboard.

## Release notes — v1.0.0

:tada: Initial release!

## App information

- **Author / company**: Leo Herzog (`companyName` in the built PBW)
- **Version**: 1.0.0 (`versionLabel`)
- **UUID**: `6808fb9d-6728-4be3-8e2a-e65cba4e94c6`
- **Type**: watchface
- **Platforms**: emery, basalt, gabbro
- **License**: MIT
- **Source URL**: `https://github.com/leoherzog/pebble-noaa-radar-watchface` —
  the repo exists and `remote.origin.url` is set to its SSH form
  (`git@github.com:leoherzog/pebble-noaa-radar-watchface.git`), so check what the
  CLI derives from that before accepting the prefilled value.
- **Support email**: pebble-radar@herzog.tech

## How to publish

```sh
cd noaa-us-weather-radar
pebble login                 # currently logged out; opens a browser, else prints a URL
pebble publish --no-gif-all-platforms --release-notes "Initial release."
```

At the Screenshots prompt choose **2) Select local screenshot/GIF files** and
paste the fifteen paths from `screenshots/store/`.

Three things to know going in:

- **`--no-gif-all-platforms` is not optional here.** The default GIF capture
  path launches each emulator with VNC disabled and shells out to `ffmpeg`,
  neither of which works on this machine.
- **Publishing is immediate.** `--is-published` is effectively a no-op — both the
  create-app and the release upload hardcode `visible: true` and
  `isPublished: true`. There is no staged release from the CLI.
- **Screenshots cannot be skipped** on a first publish; the skip option only
  appears for apps that already exist in the store.


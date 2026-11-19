# Claude working notes: watchface → watchapp conversion

Working notes for turning this fork (of `leoherzog/pebble-noaa-radar-watchface`)
into a Pebble **watchapp** with interactive controls. Primary target is the
**Pebble Time 2 (emery, 200x228)**.

## Current state of the code (as forked)

- `package.json` → `pebble.watchapp.watchface: true`, so it builds as a watchface.
  Targets: emery, basalt, gabbro, chalk.
- `src/c/main.c` (~1400 lines) is the watch side. It receives the radar
  composite in chunks (`IMG_TOTAL` / `IMG_OFFSET` / `IMG_DATA`), draws text
  slots and the BT indicator, and persists the last image (`IMG_META_KEY` / `IMG_DATA_KEY`).
- `src/pkjs/` is the phone side:
  - `index.js` handles fetching, messaging, weather text and refresh timing
  - `composite.js` builds the radar and basemap composite (upng-js + pako)
  - `timeline.js` handles timeline pins and alerts
  - `config.js` / `custom-clay.js` hold the Clay settings page
- The phone replays the last composite at startup.

## Requirements agreed so far (2026-11-18)

- Convert the watchface to a watchapp with interactive controls (zoom; other controls not decided yet).
- The watch holds only one image at a time, with no multi-frame cache on the watch.
- Changing zoom flushes the cache and fetches a fresh frame.
- The image updates when zoom or display type changes, and once a minute while the app is open.
- **No persistent-storage caching for startup:**
  - Remove the watch-side persisted composite (`IMG_META_KEY` / `IMG_DATA_KEY` save/load).
  - Remove the phone-side startup replay of the last composite.
  - Keep only the caching needed while running: in-memory state, and possibly
    the phone basemap cache so the topo map isn't refetched every minute at
    the same zoom and location.

## Still open

- Full requirements list.
- Button mapping (Up/Down = zoom in/out? Select = display type? Long-press?).
- Zoom levels and limits.
- Which text slots and features to keep in app mode.
- Timeline alert behaviour.

## Likely first code changes

1. `package.json`: set `watchface: false` (or remove it) so the build is an app.
2. `main.c`: add a click config provider (`window_set_click_config_provider`)
   and new message key(s) such as `ZOOM` / `DISPLAY_TYPE` sent to the phone.
3. `index.js`: handle the zoom and display-type messages, flush the in-memory
   frame, refetch, and run a 60 s refresh timer while the app is open.
4. Remove the persisted-image save/load and the phone startup replay.

/**
 * NOAA US Weather Radar — Pebble watchface
 *
 * Fullscreen live radar map centered on the user's location. PebbleKit JS
 * fetches both imagery layers (USGS Topo basemap + NOAA MRMS base
 * reflectivity), BLENDS THEM INTO ONE 16-color image on the phone, and streams
 * that single composite here as raw PNG bytes over AppMessage, decoded with
 * gbitmap_create_from_png_data(). The watch holds one frame and draws it; it
 * does no compositing, no translucency and no layer selection of its own.
 * Doing the blend on the phone is what frees a whole FRAME_BYTES of heap --
 * see DECODE_HEADROOM below.
 *
 * Four configurable text slots (Clay) stack around the middle: Top Line 2
 * and Bottom Line 1 sit centered on the 25% and 75% height lines, with
 * Top Line 1 above the former and Bottom Line 2 below the latter -- see
 * apply_slot_layout() for the two cases that override this: a short screen
 * pulls the inner anchors inward, and an outer line whose inner neighbour is
 * None centres in its edge quarter instead of stacking against the vacated
 * anchor. The exact screen center carries a small location marker,
 * and the top-left corner carries a Bluetooth badge while the phone is
 * unreachable.
 *
 * Battery-efficient: MINUTE_UNIT ticks only. No floating point.
 */

#include <pebble.h>

// Bumped from 1 when the blob became versioned. A version byte alone could not
// safely reject the old layout -- byte 0 there was a slot code, which can hold
// the same value as a version number -- so the unversioned blob is orphaned
// under key 1 instead of being read and misparsed. `pebble wipe` clears it;
// nothing reads it.
#define SETTINGS_KEY 2

// ---- Persisted composite ---------------------------------------------------
// The frame lives only in heap, so every relaunch -- and a watchface is
// relaunched every time the user opens the menu and comes back -- used to start
// on the grey rect until a whole transfer arrived. The PNG the last successful
// decode came from is cached here instead, and restored in init() before the
// first render.
//
// A persist VALUE is capped at 256 B (PERSIST_DATA_MAX_LENGTH) on every
// platform, so the bytes are split across IMG_MAX_KEYS consecutive keys with a
// small versioned header in IMG_META_KEY. Keys start well above SETTINGS_KEY;
// key 1 is the orphaned pre-versioning settings blob.
//
// The per-APP total is what differs, and it is a firmware capability rather
// than a platform fact, so it is queried rather than assumed: measured in QEMU,
// emery and gabbro report 1 MiB and store 51,200 B without complaint, while
// basalt reports 4,096, fills at 5,632 B and then fails EVERY subsequent write
// including overwrites of existing keys -- which would silently break the
// persist_write_data(SETTINGS_KEY, ...) in inbox_received_callback(), the only
// place settings are written. A composite does not fit there in the
// first place (5,632 B of store against a 7,873 B worst-case composite), so the
// gate below both keeps the feature off basalt and keeps it from ever filling a
// store it shares with the settings. On a platform where the macro is a literal
// the comparison folds at compile time and the bodies vanish.
#define IMG_META_KEY        3
#define IMG_DATA_KEY        16
#define IMG_MAX_KEYS        96                 // 96 * 256 = 24,576 B
#define IMG_CACHE_VERSION   1
#define IMG_CACHE_MIN_STORE (64 * 1024)
#define IMG_CACHE_MAX_BYTES ((uint32_t)IMG_MAX_KEYS * PERSIST_DATA_MAX_LENGTH)

#define NUM_SLOTS 4
#define SLOT_NONE 4       // "None" in the slot-code list below

// A decoded frame is a fullscreen 16-color PNG: 4bpp palettized, rows padded
// to a byte. Decoding costs that output bitmap plus an inflate buffer of the
// same order -- 2x the frame -- and the budget below adds half a frame of
// slack for allocator overhead and fragmentation.
//
// The slack has to be proportional, not fixed. emery's original guard asked a
// flat 64 KB, which is 2.9x its frame and affordable only because its heap is
// 5.2 frames deep; basalt's heap is only 4.3 frames deep, so a multiplier that
// is free on emery starves it. 2.5x is what basalt can carry.
//
// Only ONE frame is ever resident now that pkjs composites the two layers
// before sending, so the peak this guards fell from ~3.5x FRAME_BYTES (two
// resident frames + a decode) to ~2.5x (one resident frame, destroyed before
// its replacement decodes). The arithmetic below is unchanged; what changed is
// that heap_bytes_free() is a whole frame larger when it runs. Two consequences
// worth knowing: disabling radar no longer frees a bitmap (the composite is
// always one full frame), and clear weather is no longer nearly free (an
// all-transparent radar PNG used to collapse to a ~1 KB decode).
#define FRAME_BYTES     (((PBL_DISPLAY_WIDTH + 1) / 2) * PBL_DISPLAY_HEIGHT)
#define DECODE_HEADROOM (FRAME_BYTES * 5 / 2)

// Display order, top to bottom.
enum { SLOT_TOP1, SLOT_TOP2, SLOT_BOT1, SLOT_BOT2 };

// Slot codes: 0 Time, 1 Date, 2 Steps, 3 Battery, 4 None, 5 Weekday,
// 6 ISO date, 7 Bluetooth, 8 Distance, 9 Active cal, 10 Total cal,
// 11 Sleep, 12 Heart rate, 13 Radar age, 14 Lat/Long,
// 15 Current conditions, 16 Today's forecast, 17 High/Low, 18 Active alerts,
// 19 Alerts + upcoming, 20 Alerts else High/Low, 21 Alerts else Conditions.
//
// The persisted blob is VERSIONED, not inferred. load_settings() accepts it
// only when its length and its version byte both match this build, and falls
// back to defaults otherwise -- so fields may be added, removed, reordered or
// retyped freely: bump SETTINGS_VERSION and the stale blob is discarded rather
// than misread. Nothing here is append-only any more.
//
// That is a deliberate trade. The previous scheme inferred a blob's vintage
// from its LENGTH, which forced every field into append order and broke down
// entirely when a new field fit inside the struct's tail padding (sizeof did
// not change, so a stale blob was indistinguishable from a current one) --
// each such field then needed its own in-band "0 means unset" sentinel. The
// cost of versioning is that a layout change resets every watch-bound setting
// once -- nine dropdowns, a toggle and two colors, as the struct below stands.
// The cost of the old scheme was paid by every future author.
//
// !! READ THE TRIPWIRE BELOW BEFORE TOUCHING THIS NUMBER OR THE STRUCT. !!
// radar_mode was removed from this struct when compositing moved to the phone,
// and SETTINGS_VERSION was deliberately NOT bumped, on the explicit instruction
// that nobody runs this build yet. That is only safe because every dev device
// is wiped (`pebble wipe`, plus the pkjs localstorage directory) -- it is NOT
// safe in general, for the reason the tripwire spells out.
#define SETTINGS_VERSION 1

typedef struct {
  uint8_t version;              // SETTINGS_VERSION at write time
  uint8_t slots[NUM_SLOTS];     // display order: Top 1, Top 2, Bottom 1, Bottom 2
  uint8_t fonts[NUM_SLOTS];     // 0-4 = fixed XS..XL; 5-9 = auto, ceiling = value-5
  // GColor8 .argb bytes. The text color is applied to all four TextLayers;
  // the outline color is the halo pass painted under them (map_update_proc).
  uint8_t text_argb;
  uint8_t outline_argb;
  uint8_t refresh_min;          // heartbeat period in minutes; divides 60
  uint8_t bt_badge;             // Bluetooth disconnection indicator; 0 = hidden
  // Last known position, degrees x100, sent by pkjs. Persisted so the
  // Lat/Long slot has something to show before the first fix arrives. Last
  // because it is the only 4-byte member: leading it would pad the struct.
  int32_t lat100;
  int32_t lon100;
} Settings;

// TRIPWIRE, and a warning about the one that got away.
//
// Removing radar_mode did NOT change sizeof(Settings). The struct declared 14
// bytes before the two int32s and now declares 13; both pad to 16, so sizeof
// stayed 24 (verified by compiling both layouts with this project's own
// arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb). load_settings() validates length
// AND version, and the version was deliberately not bumped -- so a blob written
// by the PREVIOUS build passes both arms of that guard and is misparsed one byte
// early: text_argb reads the old radar_mode (0/1/2, a GColor8 with a == 0, i.e.
// INVISIBLE slot text), outline_argb reads the old text_argb, and the two tail
// bytes survive only by luck. Silent, with no symptom but a face that renders
// no text. Wiping the watch is the only cure; this build ships assuming that
// happened, because the face has no users yet.
//
// This is the second time this project has hit the "tail padding absorbed the
// field" hazard -- it is exactly why length inference was abandoned for a
// version byte (see the block above). If you change this layout again, the
// answer is to BUMP SETTINGS_VERSION, not to reason about whether sizeof moved.
//
// _Static_assert is C11 and the SDK's -std is not guaranteed, hence the
// portable negative-array form. If this fires, the layout changed: bump
// SETTINGS_VERSION, then update the number here.
typedef char settings_layout_check[(sizeof(Settings) == 24) ? 1 : -1];

// ============================================================================
// GLOBAL STATE
// ============================================================================

static Settings   s_settings;
static Window    *s_main_window;
static Layer     *s_map_layer;      // full-bounds, owns the update proc
static TextLayer *s_slot_layers[NUM_SLOTS];
// The one composited frame: basemap and radar already blended by pkjs.
static GBitmap   *s_image;          // NULL until first decode
static uint8_t   *s_rx_buf;         // malloc'd PNG accumulator, NULL when idle
static uint32_t   s_rx_total;       // 0 when idle
static uint32_t   s_rx_len;         // bytes written so far
static bool       s_decode_retry;   // one re-request per failed decode
static char       s_slot_bufs[NUM_SLOTS][32];
// When PKJS FETCHED the radar layer behind the composite on screen -- not when
// the watch decoded anything. The phone sends it explicitly (RADAR_TIME),
// because with the transfer cache an unchanged composite is not re-sent, so a
// decode is no longer a reliable heartbeat for the Radar Age slot. 0 = the
// radar layer is disabled.
static time_t     s_radar_time;
// What the persisted composite holds, mirrored in RAM so the common case --
// the phone re-sending a frame we already cached, which is exactly what a
// relaunch produces -- costs a checksum rather than ~35 flash writes.
// s_saved_len 0 means "nothing cached that matches what is on screen".
static uint32_t   s_saved_len;
static uint32_t   s_saved_sum;
static int32_t    s_saved_stamp;

// ---- Weather (slots 15-21) -------------------------------------------------
// Finished strings assembled, unit-converted and width-fitted by pkjs; the
// watch only ever copies them and compares `now - stamp`. Nothing here is
// persisted: pkjs replays its last payload on 'ready'.
#define WX_MAX_AGE (3 * 60 * 60)   // beyond this the link is genuinely stuck

static char   s_wx_cond[32], s_wx_fcst[32], s_wx_hilo[32];
static char   s_wx_alert[32], s_wx_alert2[32];
static time_t s_wx_time;                  // WX_TIME, for staleness
static time_t s_wx_exp, s_wx_exp2;        // per-slot alert expiry

// Both arrays are in display order, so these are plain lookups. They were
// switch statements until the blob became versioned: the two original slots
// had to keep their historical positions in the struct, and display order
// could not be an index. The historical NAMES survive on the wire only, and
// only inside the key table in inbox_received_callback().
static uint8_t slot_kind(int i) {
  return s_settings.slots[i];
}

// Font byte encoding: 0-4 = fixed XS..XL; 5-9 = auto ("shrink to fit"),
// ceiling = value - 5.
static uint8_t slot_font_raw(int i) {
  return s_settings.fonts[i];
}

// Auto: raw 5..9 ONLY. An out-of-range byte (a future encoding block saved
// by a newer build, or plain corruption) reads as FIXED Extra Large via
// slot_font()'s clamp below — the same answer the pre-auto binary gave it —
// rather than silently becoming "auto, ceiling XL".
static bool slot_font_auto(int i) {
  uint8_t f = slot_font_raw(i);
  return f >= 5 && f <= 9;
}

// Ceiling: raw >= 5 ? raw - 5 : raw, clamped to 4. The size dropdown means
// "at most this size": the band is reserved at the ceiling and only the
// glyphs shrink inside it, so the face never moves in response to content.
static uint8_t slot_font(int i) {
  uint8_t f = slot_font_raw(i);
  if (f >= 5) {
    f -= 5;
  }
  return f > 4 ? 4 : f;
}

// Font ladder for the size dropdowns: XS..XL. FONT_H is the layer frame
// height; FONT_OFF is subtracted from the slot's height line, lifting the
// frame by about half its height so it straddles that line instead of
// hanging below it (index 3 sits 1 px lower than exact center).
static const char *FONT_KEYS[5] = {
  FONT_KEY_GOTHIC_14_BOLD, FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_24_BOLD,
  FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_BITHAM_30_BLACK,
};
static const int8_t FONT_H[5]   = { 18, 22, 28, 34, 36 };
static const int8_t FONT_OFF[5] = {  9, 11, 14, 16, 18 };

// The few pixels TextLayer effectively insets from its frame. Not derivable
// from a header; corrected from screenshots.
#define TEXT_MARGIN 4

// The band an auto line shrinks inside is fixed by apply_slot_layout() from
// the CEILING font; only the glyph placement inside it follows the resolved
// font. s_resolved caches the last placed font per slot so update_slots()
// re-places only when the resolved size actually changed.
static int16_t s_band_y[NUM_SLOTS], s_band_h[NUM_SLOTS];
static uint8_t s_resolved[NUM_SLOTS];

// Largest ladder step whose text fits the band on one line.
// Measured with GTextOverflowModeWordWrap, NOT TrailingEllipsis: the ellipsis
// mode reports the size of the TRUNCATED text, so every font would appear to
// fit and the loop would always return the ceiling. The fit test is on
// height, not width -- the box is two lines tall and wrapping to a second
// line is the failure condition, which also catches a long single word that
// width alone would not. Needs no GContext, so it is callable from
// update_slots() outside a render pass.
static uint8_t resolve_font(int i, const char *s, int16_t band_w) {
  uint8_t max = slot_font(i);
  if (!slot_font_auto(i) || !s || !s[0]) {
    // Fixed lines always take their configured size; an EMPTY string resolves
    // to the ceiling, so the line does not sit tiny and then jump when the
    // value arrives (Steps before health data).
    return max;
  }
  for (int f = max; f > 0; f--) {
    GSize sz = graphics_text_layout_get_content_size(
        s, fonts_get_system_font(FONT_KEYS[f]),
        GRect(0, 0, band_w - TEXT_MARGIN, FONT_H[f] * 2),
        GTextOverflowModeWordWrap, GTextAlignmentCenter);
    if (sz.h <= FONT_H[f]) {
      return f;      // did not need a second line
    }
  }
  return 0;          // Extra Small and still too wide: the ellipsis takes it
}

// Vertically centre the resolved font in its fixed band (TextLayer has no
// vertical centering of its own -- a Small font in a Large band would float
// at the top of it). place_slot() NEVER consults neighbouring slots, which is
// the property that guarantees a re-size cannot cascade. A None slot keeps
// its zero-height frame regardless of the resolved font.
// `w` is the unobstructed width both callers already hold. Passing it rather
// than re-deriving it here keeps the frame exactly as wide as the width the
// layout math used, and drops this function's dependency on s_main_window.
static void place_slot(int i, uint8_t f, int16_t w) {
  int16_t h = (slot_kind(i) == SLOT_NONE) ? 0 : FONT_H[f];
  layer_set_frame(text_layer_get_layer(s_slot_layers[i]),
                  GRect(0, s_band_y[i] + (s_band_h[i] - h) / 2, w, h));
  text_layer_set_font(s_slot_layers[i], fonts_get_system_font(FONT_KEYS[f]));
}

// ============================================================================
// TEXT SLOTS
// ============================================================================

// Conditions / forecast / high-low: "--" when there is no data or when the
// payload is stale (phone unreachable for WX_MAX_AGE).
// Takes `now` rather than reading the clock itself, matching fmt_alert below:
// cases 20/21 call both, and one instant per format_slot() keeps an alert's
// expiry test and a payload's staleness test from landing on either side of a
// second boundary.
static void fmt_wx(char *buf, size_t size, const char *src, time_t now) {
  if (!s_wx_time || now - s_wx_time > WX_MAX_AGE || src[0] == '\0') {
    snprintf(buf, size, "--");
  } else {
    snprintf(buf, size, "%s", src);
  }
}

// Alerts: empty string when the buffer is empty OR when now > exp. An alert
// self-clears on its own NWS expiry even if the phone is unreachable, so a
// disconnected watch can never keep displaying a warning that has lapsed.
// Alerts deliberately do NOT fall back to "--": absence of an alert and
// absence of data render identically, and of the two failure directions,
// showing nothing is the honest one.
static void fmt_alert(char *buf, size_t size, const char *src,
                      time_t exp, time_t now) {
  if (src[0] == '\0' || (exp && now > exp)) {
    buf[0] = '\0';
  } else {
    snprintf(buf, size, "%s", src);
  }
}

// Format one slot's string into buf. Pure formatting: no TextLayer access,
// so update_slots() can compare the result against the previous contents and
// re-measure only when the string actually changed.
static void format_slot(uint8_t kind, char *buf, size_t size) {
  time_t now = time(NULL);
  // Never NULL: the firmware's localtime (pbl_override_localtime in
  // reference/PebbleOS/src/fw/applib/pbl_std/pbl_std.c) returns the app-state
  // tm unconditionally, so the strftime cases below need no NULL guard. Called
  // per slot rather than hoisted into update_slots() on purpose -- that tm is a
  // shared singleton the health service also writes, and a fresh call here
  // makes the aliasing impossible by construction.
  struct tm *tick_time = localtime(&now);

  switch (kind) {
    case 0:  // Time
      if (clock_is_24h_style()) {
        strftime(buf, size, "%H:%M", tick_time);
      } else {
        // 12h: no leading zero, lowercase meridiem attached ("5:04pm").
        // Built from tm fields directly: newlib's strftime has no %-I to
        // drop the zero and %p is uppercase.
        int h12 = tick_time->tm_hour % 12;
        if (h12 == 0) h12 = 12;
        snprintf(buf, size, "%d:%02d%s", h12, tick_time->tm_min,
                 tick_time->tm_hour < 12 ? "am" : "pm");
      }
      break;
    case 1:  // Date
      strftime(buf, size, "%a %b %d", tick_time);
      break;
    case 2:  // Steps
      snprintf(buf, size, "%d", (int)health_service_sum_today(HealthMetricStepCount));
      break;
    case 3: {  // Battery, with charging indicator
      BatteryChargeState st = battery_state_service_peek();
      snprintf(buf, size, "%s%d%%",
               (st.is_charging || st.is_plugged) ? "+" : "", st.charge_percent);
      break;
    }
    case 5:  // Weekday
      strftime(buf, size, "%A", tick_time);
      break;
    case 6:  // ISO date
      strftime(buf, size, "%Y-%m-%d", tick_time);
      break;
    case 7:  // Bluetooth
      snprintf(buf, size, "%s",
               connection_service_peek_pebble_app_connection() ? "Connected"
                                                               : "Disconnected");
      break;
    case 8: {  // Distance walked today
      int m = (int)health_service_sum_today(HealthMetricWalkedDistanceMeters);
      if (health_service_get_measurement_system_for_display(
              HealthMetricWalkedDistanceMeters) == MeasurementSystemImperial) {
        int tenths = (m * 10 + 804) / 1609;
        snprintf(buf, size, "%d.%d mi", tenths / 10, tenths % 10);
      } else {
        int tenths = (m + 50) / 100;
        snprintf(buf, size, "%d.%d km", tenths / 10, tenths % 10);
      }
      break;
    }
    case 9:  // Active calories
      snprintf(buf, size, "%d act",
               (int)health_service_sum_today(HealthMetricActiveKCalories));
      break;
    case 10:  // Total calories (active + resting)
      snprintf(buf, size, "%d cal",
               (int)(health_service_sum_today(HealthMetricActiveKCalories) +
                     health_service_sum_today(HealthMetricRestingKCalories)));
      break;
    case 11: {  // Last night's sleep
      int s = (int)health_service_sum_today(HealthMetricSleepSeconds);
      snprintf(buf, size, "%dh %02dm", s / 3600, (s % 3600) / 60);
      break;
    }
    case 12: {  // Heart rate
      int bpm = (int)health_service_peek_current_value(HealthMetricHeartRateBPM);
      if (bpm > 0) {
        snprintf(buf, size, "%d bpm", bpm);
      } else {
        snprintf(buf, size, "-- bpm");
      }
      break;
    }
    case 13:  // Radar age
      // s_radar_time is the PHONE's fetch clock, so the difference can come out
      // negative when the two clocks disagree; clamp rather than print "-1 min".
      if (s_radar_time) {
        int mins = (int)((now - s_radar_time) / 60);
        if (mins < 0) mins = 0;
        snprintf(buf, size, "%d min", mins);
      } else {
        snprintf(buf, size, "no radar");
      }
      break;
    case 14:  // Current lat/long (degrees x100 from pkjs)
      if (s_settings.lat100 || s_settings.lon100) {
        int la = s_settings.lat100, lo = s_settings.lon100;
        int laa = la < 0 ? -la : la, loa = lo < 0 ? -lo : lo;
        snprintf(buf, size, "%s%d.%02d,%s%d.%02d",
                 la < 0 ? "-" : "", laa / 100, laa % 100,
                 lo < 0 ? "-" : "", loa / 100, loa % 100);
      } else {
        snprintf(buf, size, "--");
      }
      break;
    case 15: fmt_wx(buf, size, s_wx_cond, now); break;
    case 16: fmt_wx(buf, size, s_wx_fcst, now); break;
    case 17: fmt_wx(buf, size, s_wx_hilo, now); break;
    case 18: fmt_alert(buf, size, s_wx_alert, s_wx_exp, now); break;
    case 19: fmt_alert(buf, size, s_wx_alert2, s_wx_exp2, now); break;
    case 20:  // alert, else high/low
    case 21:  // alert, else current conditions
      // The alert is tested FIRST, so a stale-data "--" can never mask a live
      // alert; fmt_alert's empty string is the "no alert" signal, so expiry
      // and staleness are already handled by the two helpers. Both branches
      // run every update_slots() call (once a minute), which is what makes
      // the revert-on-expiry happen without a message from the phone.
      fmt_alert(buf, size, s_wx_alert, s_wx_exp, now);
      if (buf[0] == '\0') {
        fmt_wx(buf, size, kind == 20 ? s_wx_hilo : s_wx_cond, now);
      }
      break;
    default:  // None
      buf[0] = '\0';
      break;
  }
}

static void update_slots(void) {
  if (!s_slot_layers[0]) {
    return;   // a tick or config message beat the window load
  }
  GRect b = layer_get_unobstructed_bounds(window_get_root_layer(s_main_window));
  for (int i = 0; i < NUM_SLOTS; i++) {
    char tmp[sizeof(s_slot_bufs[0])];
    // strftime returns 0 and leaves the buffer's contents unspecified when the
    // formatted result does not fit, so start every slot from an empty string.
    tmp[0] = '\0';
    format_slot(slot_kind(i), tmp, sizeof(tmp));
    // Re-resolve only when the string actually changed -- Time changes once a
    // minute, Steps a few times an hour, alerts rarely, Battery hardly at all.
    // Fixed lines resolve straight to their configured size, so they can
    // never see a resolved change here and never re-place.
    if (strcmp(tmp, s_slot_bufs[i]) != 0) {
      strcpy(s_slot_bufs[i], tmp);
      uint8_t f = resolve_font(i, s_slot_bufs[i], b.size.w);
      if (f != s_resolved[i]) {
        s_resolved[i] = f;
        place_slot(i, f, b.size.w);   // the band is fixed; only the glyphs move
      }
      // Inside the branch on purpose. text_layer_set_text() does NOT compare
      // (PebbleOS applib/ui/text_layer.c -- unlike set_text_color and friends it
      // has no early return), so calling it unconditionally dirtied the window
      // on every update_slots(), which repaints the whole layer tree. That made
      // the redraw flag in inbox_received_callback() and connection_callback()'s
      // layer_mark_dirty() dead code. The layers already point at these buffers
      // (bound once in main_window_load), so re-pointing when nothing changed
      // bought nothing but the repaint.
      text_layer_set_text(s_slot_layers[i], s_slot_bufs[i]);
    }
  }
}

static void apply_slot_layout(void) {
  if (!s_slot_layers[0]) {
    return;   // config arrived before the window loaded
  }
  // Unobstructed bounds: the Timeline Quick View covers the bottom of the
  // screen (59 px on emery), which would otherwise bisect the bottom slots.
  GRect b = layer_get_unobstructed_bounds(window_get_root_layer(s_main_window));

  uint8_t f[NUM_SLOTS];
  for (int i = 0; i < NUM_SLOTS; i++) {
    f[i] = slot_font(i);
  }

  // Height each line claims in the stack. A line set to None claims nothing:
  // that is a configuration choice, fixed until the user revisits the settings
  // page, unlike a line whose string is momentarily empty (Steps before health
  // data arrives), which keeps its full band so the face does not jump.
  int h[NUM_SLOTS];
  for (int i = 0; i < NUM_SLOTS; i++) {
    h[i] = (slot_kind(i) == SLOT_NONE) ? 0 : FONT_H[f[i]];
  }

  // The inner pair keeps the 25%/75% height lines it has always used; the
  // outer pair takes the full height of its own frame immediately beyond it,
  // so raising either inner line's size pushes its outer neighbour outward
  // rather than overlapping it.
  int inner_top = b.size.h / 4 - FONT_OFF[f[SLOT_TOP2]];
  int inner_bot = b.size.h * 3 / 4 - FONT_OFF[f[SLOT_BOT1]];

  // ...but a short display may not have room beyond those lines for the outer
  // pair. With all four lines occupied at the default sizes, basalt's 168 px
  // would hang Top Line 1 4 px off the top and Bottom Line 2 4 px off the
  // bottom; emery's 228 px has the slack at every combination. Where the outer
  // band does not fit, move the inner line inward to make room: the quarter
  // lines are a preference, staying on screen is not. Only a font change, a
  // slot switching to or from None, or an obstruction can trigger this, so the
  // face still never moves in response to content alone.
  if (inner_top < h[SLOT_TOP1]) {
    inner_top = h[SLOT_TOP1];
  }
  int bot_limit = b.size.h - h[SLOT_BOT1] - h[SLOT_BOT2];
  if (inner_bot > bot_limit) {
    inner_bot = bot_limit;
  }
  // A display too short to seat every occupied line at the chosen sizes -- the
  // Quick View leaves basalt about 117 px, which four large lines exceed. The
  // inner pair carries the primary readout, so it is the outer pair that gets
  // pushed past the edge rather than the two inner lines colliding mid-screen.
  if (inner_bot < inner_top + h[SLOT_TOP2]) {
    inner_bot = inner_top + h[SLOT_TOP2];
  }

  int y[NUM_SLOTS];
  y[SLOT_TOP1] = inner_top - h[SLOT_TOP1];
  y[SLOT_TOP2] = inner_top;
  y[SLOT_BOT1] = inner_bot;
  y[SLOT_BOT2] = inner_bot + h[SLOT_BOT1];

  // An outer line is a satellite of its inner neighbour's band -- but when
  // that neighbour is None there is no band to stack against, and the outer
  // line would slide inward to the vacated anchor (Radar Age at 67% height
  // with Bottom Line 1 disabled). Treat the outer lines as edge lines
  // instead: center the band in its edge quarter (top edge..25% / 75%..bottom
  // edge), clamped on-screen when the quarter is shorter than the band (Quick
  // View). Geometry still depends only on slot kinds and fonts, so the
  // face-never-moves-on-content invariant holds.
  if (slot_kind(SLOT_TOP2) == SLOT_NONE && h[SLOT_TOP1] > 0) {
    int yy = (b.size.h / 4 - h[SLOT_TOP1]) / 2;
    y[SLOT_TOP1] = yy < 0 ? 0 : yy;
  }
  if (slot_kind(SLOT_BOT1) == SLOT_NONE && h[SLOT_BOT2] > 0) {
    int yy = b.size.h * 3 / 4 + (b.size.h / 4 - h[SLOT_BOT2]) / 2;
    if (yy + h[SLOT_BOT2] > b.size.h) {
      yy = b.size.h - h[SLOT_BOT2];
    }
    y[SLOT_BOT2] = yy;
  }

  // The bands come from the CEILING font, so the numbers above are unchanged
  // from the fixed-size layout; auto only moves glyphs inside these bands.
  // Re-resolve against the current strings: a font or slot change can alter a
  // ceiling. On an obstruction change the band WIDTH is unchanged, so the
  // resolved sizes cannot change and this amounts to a re-place.
  for (int i = 0; i < NUM_SLOTS; i++) {
    s_band_y[i] = y[i];
    s_band_h[i] = h[i];
    s_resolved[i] = resolve_font(i, s_slot_bufs[i], b.size.w);
    place_slot(i, s_resolved[i], b.size.w);
  }
}

static void unobstructed_did_change(void *context) {
  apply_slot_layout();
}

// ============================================================================
// IMAGE REQUESTS
// ============================================================================

// Purely a corruption guard now that the blob is versioned -- it used to also
// carry the "0 means the field predates this build" sentinel, which versioning
// retired. A 0 would be a DIVISION BY ZERO in tick_handler's tm_min modulo,
// not a cosmetic default, so it is applied at every write and not only at
// load. Config values are divisors of 60 to keep that modulo aligned to the
// hour; a non-divisor merely ticks unevenly, so it is not worth rejecting.
static uint8_t sanitize_refresh(uint8_t m) {
  return (m == 0 || m > 60) ? 10 : m;
}

// The heartbeat, and the watch's half of the phone's transfer cache. pkjs
// hashes each composite it builds and skips the transfer when the bytes match
// what it believes we already hold, so we have to tell it whether we hold
// anything at all.
//
// The wire values are 2 and 1, never 0: pkjs gates on
// `if (e.payload['REQUEST_IMAGES'])`, a truthiness test, so a 0 would be
// silently ignored and the heartbeat would stop dead.
//   2 = "I have no image" -> send unconditionally, bypassing the hash cache.
//   1 = "I have one"      -> skip if the composite is unchanged.
static void request_images(bool need_image) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
    dict_write_uint8(iter, MESSAGE_KEY_REQUEST_IMAGES, need_image ? 2 : 1);
    app_message_outbox_send();
  }
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  update_slots();

  // Heartbeat: refresh the composite (and weather, which rides the same request
  // on the phone) every refresh_min minutes -- user-configurable, default 10,
  // the MRMS update cadence. Two caches on the phone are keyed off the flag we
  // send: pkjs commits its basemap cache key when the fetch succeeds, and its
  // transfer hash when the last chunk is ACKed, so a transfer the watch refused
  // or that pkjs gave up on is never re-offered unless the watch says it is
  // still missing.
  if (tick_time->tm_min % s_settings.refresh_min == 0) {
    request_images(!s_image);
  }
}

static void battery_callback(BatteryChargeState state) {
  update_slots();
}

static void connection_callback(bool connected) {
  update_slots();
  // update_slots() only repaints when a slot's STRING changed, and the badge
  // does not depend on any slot -- with no Bluetooth slot configured, nothing
  // above would dirty anything and the badge would never appear or clear.
  if (s_map_layer) {   // a state change can beat the window load
    layer_mark_dirty(s_map_layer);
  }
}

// ============================================================================
// PERSISTED COMPOSITE
// ============================================================================

// Written LAST, so a write that dies partway through the data keys can never
// look like a complete cache. Read back all-or-nothing, exactly like the
// settings blob: wrong version, wrong size, impossible length or a checksum
// that does not match means the whole cache is ignored, never partly trusted.
typedef struct {
  uint8_t  version;      // IMG_CACHE_VERSION at write time
  uint8_t  keys;         // data keys actually used
  uint32_t len;          // PNG bytes
  uint32_t sum;          // over those bytes
  int32_t  stamp;        // the RADAR_TIME that belonged to this frame
} ImgMeta;

// FNV-1a. Not for security -- it is here so a torn or partially rewritten
// cache is detected before the bytes reach the PNG decoder, which fails
// SILENTLY (see the decode path) and would leave a blank face with no clue why.
static uint32_t img_sum(const uint8_t *b, uint32_t n) {
  uint32_t h = 2166136261u;
  for (uint32_t i = 0; i < n; i++) {
    h = (h ^ b[i]) * 16777619u;
  }
  return h;
}

static bool img_cache_available(void) {
  return persist_get_max_size() >= IMG_CACHE_MIN_STORE;
}

// Cache the PNG the frame now on screen was decoded from. Called at the decode,
// which is the only point where those bytes exist: s_rx_buf is freed
// immediately afterwards, and holding a copy resident instead would cost
// another 8-20 KB of heap on the platform (gabbro) with the least of it.
static void save_image(const uint8_t *buf, uint32_t len) {
  if (!img_cache_available() || len == 0 || len > IMG_CACHE_MAX_BYTES) {
    return;   // too big to cache is not an error: the frame still displays
  }
  uint32_t sum = img_sum(buf, len);
  if (len == s_saved_len && sum == s_saved_sum) {
    return;   // already cached -- the relaunch case, and the common one
  }

  // Drop the header before touching the data keys: until it is rewritten the
  // cache reads as absent, which is the only safe state to be in mid-write.
  persist_delete(IMG_META_KEY);
  s_saved_len = 0;

  uint32_t off = 0;
  int k = 0;
  while (off < len) {
    uint32_t n = len - off;
    if (n > PERSIST_DATA_MAX_LENGTH) {
      n = PERSIST_DATA_MAX_LENGTH;
    }
    if (persist_write_data(IMG_DATA_KEY + k, buf + off, n) != (int)n) {
      APP_LOG(APP_LOG_LEVEL_WARNING, "Image cache write failed at key %d", k);
      return;
    }
    off += n;
    k++;
  }

  ImgMeta m = { .version = IMG_CACHE_VERSION, .keys = (uint8_t)k,
                .len = len, .sum = sum, .stamp = (int32_t)s_radar_time };
  if (persist_write_data(IMG_META_KEY, &m, sizeof(m)) != (int)sizeof(m)) {
    return;
  }
  s_saved_len = len;
  s_saved_sum = sum;
  s_saved_stamp = m.stamp;
  APP_LOG(APP_LOG_LEVEL_INFO, "Cached composite (%d bytes, %d keys)",
          (int)len, k);
}

// RADAR_TIME arrives in its own message AFTER the transfer it belongs to, so
// the stamp save_image() could see was the previous frame's. Correcting it is
// one 16-byte key, and it is what makes Radar Age honest at the instant a
// restored frame appears -- the whole point of restoring one.
static void save_image_stamp(void) {
  if (!s_saved_len || !s_image || (int32_t)s_radar_time == s_saved_stamp) {
    return;   // nothing cached, or nothing on screen it could describe
  }
  ImgMeta m;
  if (persist_read_data(IMG_META_KEY, &m, sizeof(m)) != (int)sizeof(m)) {
    return;
  }
  m.stamp = (int32_t)s_radar_time;
  if (persist_write_data(IMG_META_KEY, &m, sizeof(m)) == (int)sizeof(m)) {
    s_saved_stamp = m.stamp;
  }
}

// Rebuild s_image from the cache. Caller must have s_image NULL: this is init,
// or the moment after a failed decode destroyed the frame it was replacing.
static bool load_image(void) {
  if (!img_cache_available()) {
    return false;
  }
  ImgMeta m;
  if (persist_read_data(IMG_META_KEY, &m, sizeof(m)) != (int)sizeof(m) ||
      m.version != IMG_CACHE_VERSION || m.len == 0 ||
      m.len > IMG_CACHE_MAX_BYTES || m.keys == 0 || m.keys > IMG_MAX_KEYS) {
    return false;
  }
  // The same budget the header handler applies, for the same reason: a decode
  // that runs short hands back a GBitmap with a NULL pixel buffer rather than
  // failing loudly. Nothing else is resident at init, so this is generous
  // there; it is load-bearing on the post-failed-decode path.
  if (heap_bytes_free() < m.len + DECODE_HEADROOM) {
    return false;
  }
  uint8_t *buf = malloc(m.len);
  if (!buf) {
    return false;
  }
  uint32_t off = 0;
  for (int k = 0; k < (int)m.keys; k++) {
    uint32_t n = m.len - off;
    if (n > PERSIST_DATA_MAX_LENGTH) {
      n = PERSIST_DATA_MAX_LENGTH;
    }
    if (persist_read_data(IMG_DATA_KEY + k, buf + off, n) != (int)n) {
      free(buf);
      return false;
    }
    off += n;
  }
  if (off != m.len || img_sum(buf, m.len) != m.sum) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "Image cache checksum mismatch, ignoring");
    free(buf);
    return false;
  }

  s_image = gbitmap_create_from_png_data(buf, m.len);
  if (s_image && !gbitmap_get_data(s_image)) {   // silent-failure check again
    gbitmap_destroy(s_image);
    s_image = NULL;
  }
  free(buf);
  if (!s_image) {
    return false;
  }
  s_saved_len = m.len;
  s_saved_sum = m.sum;
  s_saved_stamp = m.stamp;
  // Adopt the cached frame's own stamp, so Radar Age describes the pixels that
  // are actually on screen from the first render rather than reading 'no radar'
  // until the phone's next RADAR_TIME lands.
  s_radar_time = (time_t)m.stamp;
  APP_LOG(APP_LOG_LEVEL_INFO, "Restored composite (%d bytes), heap now %d",
          (int)m.len, (int)heap_bytes_free());
  return true;
}

// ============================================================================
// APPMESSAGE
// ============================================================================

// Copy one weather cstring into its buffer, NUL-terminating explicitly.
static void wx_copy(DictionaryIterator *iter, uint32_t key,
                    char *dst, size_t size) {
  Tuple *t = dict_find(iter, key);
  if (t) {
    strncpy(dst, t->value->cstring, size - 1);
    dst[size - 1] = '\0';
  }
}

// Bytes a resident bitmap will give back when it is destroyed before decoding.
static uint32_t bitmap_bytes(GBitmap *bmp) {
  if (!bmp) {
    return 0;
  }
  return (uint32_t)gbitmap_get_bytes_per_row(bmp) * gbitmap_get_bounds(bmp).size.h;
}

// Tear down the PNG accumulator and return the receive state machine to idle.
static void rx_reset(void) {
  free(s_rx_buf);          // free(NULL) is a no-op
  s_rx_buf = NULL;
  s_rx_total = 0;
  s_rx_len = 0;
}

static void inbox_received_callback(DictionaryIterator *iter, void *ctx) {
  // ---- Config block ----------------------------------------------------
  // The only place the wire's historical naming is decoded. TopSlot/TopFont
  // are Top Line 2 and BottomSlot/BottomFont are Bottom Line 1: those were the
  // first two lines shipped, and the outer pair was added around them. The
  // keys cannot be renamed without resetting every phone-side saved config,
  // so they stay -- but the mapping to display order stops here, and nothing
  // downstream of these tables knows about it.
  // Not static: MESSAGE_KEY_* are resolved at load time, not compile time, so
  // they cannot initialize a static array ("initializer element is not
  // constant"). Two stack arrays per config message is not worth working
  // around with a lazy-init.
  const uint32_t SLOT_KEYS[NUM_SLOTS] = {
    MESSAGE_KEY_TopSlot1, MESSAGE_KEY_TopSlot,
    MESSAGE_KEY_BottomSlot, MESSAGE_KEY_BottomSlot2
  };
  const uint32_t FONT_KEYS[NUM_SLOTS] = {
    MESSAGE_KEY_TopFont1, MESSAGE_KEY_TopFont,
    MESSAGE_KEY_BottomFont, MESSAGE_KEY_BottomFont2
  };
  Tuple *slot_t[NUM_SLOTS], *font_t[NUM_SLOTS];
  // One flag for both tuple kinds: they are only ever tested together, and a
  // slot switching to or from None changes the stack geometry just as a font
  // change does, since a None line no longer reserves a band (see
  // apply_slot_layout). Geometry depends on slot KIND, not only on font.
  bool slot_cfg_changed = false;
  for (int i = 0; i < NUM_SLOTS; i++) {
    slot_t[i] = dict_find(iter, SLOT_KEYS[i]);
    font_t[i] = dict_find(iter, FONT_KEYS[i]);
    if (slot_t[i] || font_t[i]) slot_cfg_changed = true;
  }
  Tuple *lat_t    = dict_find(iter, MESSAGE_KEY_Lat);
  Tuple *lon_t    = dict_find(iter, MESSAGE_KEY_Lon);
  Tuple *tc_t     = dict_find(iter, MESSAGE_KEY_TextColor);
  Tuple *oc_t     = dict_find(iter, MESSAGE_KEY_OutlineColor);
  Tuple *ri_t     = dict_find(iter, MESSAGE_KEY_RefreshInterval);
  Tuple *btb_t    = dict_find(iter, MESSAGE_KEY_BtIndicator);


  if (slot_cfg_changed || lat_t || lon_t ||
      tc_t || oc_t || ri_t || btb_t) {
    // Snapshot before the writes below so the persist at the end can be
    // skipped when nothing actually changed: pkjs re-sends Lat/Lon on every
    // heartbeat (RefreshInterval, default 10 min), and an unchanged position
    // would otherwise cost a flash write every heartbeat forever.
    // memcpy/memcmp span the struct's padding as well as its fields, but both
    // sides carry the same padding bytes -- nothing here writes to it -- so
    // the comparison is exact.
    Settings prev;
    memcpy(&prev, &s_settings, sizeof(prev));

    // Set by the branches that change what map_update_proc draws (OutlineColor,
    // BtIndicator) and consumed once below. Deliberately NOT conditioned on the
    // memcmp result: a re-save with unchanged values still repaints. Redrawing
    // on every heartbeat's Lat/Lon message would be wasted work, which is why
    // this is a flag and not an unconditional dirty.
    //
    // RadarMode used to set it too, and since every config save carried that
    // key it was the de-facto catch-all repaint for the whole config page. It
    // is gone (the mode is phone-side now), so the remaining setters have to
    // stand on their own. TextColor deliberately does not set it: its setter
    // calls text_layer_set_text_color, which dirties the text layers, and the
    // firmware render walk repaints the ENTIRE layer tree on any dirty
    // (reference/PebbleOS/src/fw/applib/ui/layer.c -- no per-layer dirty
    // check), so the halo underneath repaints in the same pass.
    bool redraw = false;

    for (int i = 0; i < NUM_SLOTS; i++) {
      if (slot_t[i]) s_settings.slots[i] = (uint8_t)slot_t[i]->value->int32;
      if (font_t[i]) s_settings.fonts[i] = (uint8_t)font_t[i]->value->int32;
    }
    // Zoom is deliberately absent, and RadarMode is now too: pkjs owns the bbox
    // math and the blend, and re-composites and re-sends by itself when the
    // webview closes. Translucency and the disabled case are both applied
    // before the bytes ever leave the phone, so there is nothing here to store
    // and nothing to redraw -- a mode change arrives as a new composite.
    if (lat_t)    s_settings.lat100      = lat_t->value->int32;
    if (lon_t)    s_settings.lon100      = lon_t->value->int32;
    // Colors arrive as 0xRRGGBB from the Clay color pickers; GColorFromHEX is
    // integer-only (shifts and masks), so the no-floating-point rule holds.
    if (tc_t) {
      s_settings.text_argb = GColorFromHEX(tc_t->value->int32).argb;
      for (int i = 0; i < NUM_SLOTS; i++) {
        if (s_slot_layers[i]) {
          text_layer_set_text_color(s_slot_layers[i],
                                    (GColor){ .argb = s_settings.text_argb });
        }
      }
    }
    if (oc_t) {
      s_settings.outline_argb = GColorFromHEX(oc_t->value->int32).argb;
      redraw = true;   // the halo pass lives in map_update_proc
    }
    // Takes effect on the next matching minute tick; nothing to redraw or
    // re-layout. No catch-up request either: the save that delivered this
    // already made pkjs refetch everything it needed.
    if (ri_t) {
      s_settings.refresh_min = sanitize_refresh((uint8_t)ri_t->value->int32);
    }
    if (btb_t) {
      s_settings.bt_badge = btb_t->value->int32 ? 1 : 0;
      redraw = true;
    }
    if (memcmp(&prev, &s_settings, sizeof(prev)) != 0) {
      persist_write_data(SETTINGS_KEY, &s_settings, sizeof(s_settings));
    }
    if (redraw && s_map_layer) {   // config can be dispatched before window load
      layer_mark_dirty(s_map_layer);
    }
    if (slot_cfg_changed) {
      apply_slot_layout();   // nothing else here moves the slots
    }
    // Unconditional: the Lat/Long slot has to refresh even when nothing was
    // persisted or redrawn. Self-guards against arriving before window load.
    update_slots();
  }

  // ---- Weather block -----------------------------------------------------
  // One message carries every populated weather key, assembled on the phone.
  // WX_TIME is the phone's FETCH time (pkjs replays its last payload on
  // 'ready', so receipt-stamping would relabel hour-old data as fresh). No
  // apply_slot_layout() -- weather never changes slot geometry -- and no early
  // return, so an image transfer in the same callback path is unaffected.
  Tuple *wx_time_t = dict_find(iter, MESSAGE_KEY_WX_TIME);
  if (wx_time_t) {
    wx_copy(iter, MESSAGE_KEY_WX_COND,   s_wx_cond,   sizeof(s_wx_cond));
    wx_copy(iter, MESSAGE_KEY_WX_FCST,   s_wx_fcst,   sizeof(s_wx_fcst));
    wx_copy(iter, MESSAGE_KEY_WX_HILO,   s_wx_hilo,   sizeof(s_wx_hilo));
    wx_copy(iter, MESSAGE_KEY_WX_ALERT,  s_wx_alert,  sizeof(s_wx_alert));
    wx_copy(iter, MESSAGE_KEY_WX_ALERT2, s_wx_alert2, sizeof(s_wx_alert2));
    Tuple *exp_t  = dict_find(iter, MESSAGE_KEY_WX_EXP);
    Tuple *exp2_t = dict_find(iter, MESSAGE_KEY_WX_EXP2);
    if (exp_t)  s_wx_exp  = (time_t)exp_t->value->uint32;
    if (exp2_t) s_wx_exp2 = (time_t)exp2_t->value->uint32;
    s_wx_time = (time_t)wx_time_t->value->uint32;
    update_slots();
  }

  // ---- Radar timestamp ---------------------------------------------------
  // pkjs's radar FETCH time, not a decode time: with the transfer cache an
  // unchanged composite is not re-sent, so a decode is no longer a reliable
  // heartbeat for the Radar Age slot and the timestamp has to travel
  // explicitly. Sent at the commit point -- immediately on a skip, and from the
  // final-chunk ACK on a send -- so a transfer that dies halfway advances
  // nothing. 0 = the radar layer is disabled, which format_slot renders as
  // "no radar". Its own block, not part of the config block above: it is not
  // persisted settings and must not enter the memcmp-guarded persist.
  //
  // int32, like every other numeric tuple here: pkjs marshals a plain JS number
  // as a 4-byte int, and the union's uint8 member is only valid for a 1-byte
  // tuple. Unix seconds fit in an int32 until 2038.
  Tuple *rt_t = dict_find(iter, MESSAGE_KEY_RADAR_TIME);
  if (rt_t) {
    s_radar_time = (time_t)rt_t->value->int32;
    update_slots();
    save_image_stamp();   // keep the cached frame's age honest across relaunches
  }

  // ---- Header block ----------------------------------------------------
  Tuple *total_t = dict_find(iter, MESSAGE_KEY_IMG_TOTAL);
  if (total_t) {
    rx_reset();   // one teardown point for the three receive-state fields
    s_rx_total = total_t->value->uint32;

    // Reject the impossible, and refuse a transfer we cannot afford to decode.
    // A decode that runs short fails silently -- the firmware hands back a
    // GBitmap with a NULL pixel buffer (see the check after the decode below)
    // -- and by then the frame being replaced is already destroyed, so the
    // headroom is required up front rather than discovered afterwards.
    // The phone emits the composite as a 16-color 4-bit PNG, so decoding costs
    // the output bitmap plus an inflate buffer of the same order -- see
    // DECODE_HEADROOM. That the source is 4bpp is a load-bearing promise from
    // the phone, NOT something this guard enforces: an 8bpp source would need
    // ~4x the frame against a 2.5x headroom, and a compressed one can pass both
    // clauses here and still run short at decode. What contains that is the
    // NULL-pixel-buffer check after the decode below, with the load_image()
    // restore and re-request behind it.
    // The image being replaced is destroyed before the decode, so its bytes
    // count as available here -- otherwise every refresh after the first
    // would be refused.
    uint32_t avail = heap_bytes_free() + bitmap_bytes(s_image);
    if (s_rx_total == 0 || s_rx_total > FRAME_BYTES * 2 ||
        avail < s_rx_total + DECODE_HEADROOM) {
      APP_LOG(APP_LOG_LEVEL_WARNING, "Rejecting transfer of %d bytes (avail %d)",
              (int)s_rx_total, (int)avail);
      s_rx_total = 0;
      return;
    }

    s_rx_buf = malloc(s_rx_total);
    if (!s_rx_buf) {
      s_rx_total = 0;
      return;
    }
  }

  // ---- Data block ------------------------------------------------------
  Tuple *data_t = dict_find(iter, MESSAGE_KEY_IMG_DATA);
  Tuple *off_t  = dict_find(iter, MESSAGE_KEY_IMG_OFFSET);
  if (!s_rx_buf || !data_t || !off_t) {
    return;
  }

  uint32_t off = off_t->value->uint32;
  uint16_t len = data_t->length;

  // Ordering invariant; duplicates after a lost ACK land here and are dropped.
  if (off != s_rx_len || off + len > s_rx_total) {
    return;
  }

  memcpy(s_rx_buf + off, data_t->value->data, len);
  s_rx_len += len;

  // ---- Finalize --------------------------------------------------------
  if (s_rx_len == s_rx_total) {
    // Destroy the old bitmap BEFORE decoding: cuts peak heap by the
    // FRAME_BYTES the resident frame holds (~23 KB on emery, ~12 KB on basalt),
    // and those bytes were already counted as available in the guard above.
    // Nothing is rendered between here and the layer_mark_dirty below.
    if (s_image) {
      gbitmap_destroy(s_image);
      s_image = NULL;
    }

    s_image = gbitmap_create_from_png_data(s_rx_buf, s_rx_total);
    // The firmware ignores the decoder's return value and hands back the
    // zeroed GBitmap it malloc'd (gbitmap_png.c gbitmap_create_from_png_data),
    // contrary to the header's "NULL if it could not be created". A failed
    // decode is only visible as a NULL pixel buffer.
    if (s_image && !gbitmap_get_data(s_image)) {
      gbitmap_destroy(s_image);
      s_image = NULL;
    }
    APP_LOG(APP_LOG_LEVEL_INFO, "Decoded composite (%d bytes), heap now %d",
            (int)s_rx_total, (int)heap_bytes_free());

    // Cache what decoded, so the next relaunch starts with this frame instead
    // of the grey rect. Before rx_reset(), which frees the bytes; and only on
    // success, so a frame that could not be decoded is never restored later.
    if (s_image) {
      save_image(s_rx_buf, s_rx_total);
    }

    rx_reset();   // after the log above, which reads s_rx_total

    // The old bitmap is gone by now, so a NULL decode would leave the layer
    // blank until the next tick. Ask once for a fresh copy; the flag keeps a
    // failing image from re-requesting back-to-back at fetch pace. It does NOT
    // stop the retrying: the flag clears only on a successful decode, and the
    // heartbeat re-offers the composite anyway (a NULL s_image makes
    // tick_handler ask for one), so a permanently undecodable image is retried
    // every refresh_min minutes forever -- just never in a tight loop.
    if (s_image) {
      s_decode_retry = false;
    } else {
      // The frame this transfer was replacing is already destroyed, but the
      // cache still holds the last one that DID decode -- older, and different
      // bytes from the ones that just failed, so restoring it is not a retry of
      // the same failure. Grey is now the fallback's fallback. Attempted before
      // the rate-limit arm and independently of it: that flag governs only the
      // re-REQUEST, and a second consecutive failure destroys the restored
      // frame too, so gating the restore on it would blank the face for good.
      load_image();
      // Unconditionally on the failure path, restored or not: a restored frame
      // is OLDER than the one that just failed, so the real bytes are still
      // wanted. The flag rate-limits this to one re-request per run of
      // failures, exactly as before.
      if (!s_decode_retry) {
        APP_LOG(APP_LOG_LEVEL_ERROR, "Decode failed");
        s_decode_retry = true;
        // Explicitly true, not !s_image: the reason is "bypass the phone's
        // transfer-hash cache", which would otherwise skip re-sending bytes it
        // believes we already hold. That the bitmap is usually NULL here is a
        // coincidence of this call site -- and since load_image() may just have
        // filled it, !s_image would now actively suppress the resend.
        request_images(true);
      }
    }

    // Dirty only: no slot string derives from the frame. Radar Age is stamped by
    // the RADAR_TIME message pkjs enqueues from the final chunk's ACK.
    if (s_map_layer) layer_mark_dirty(s_map_layer);
  }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", (int)reason);
  // A dropped message breaks the offset chain. Tear down and re-request: pkjs
  // keeps streaming the rest of a transfer we can no longer accept, and would
  // otherwise believe an image it never delivered had arrived.
  //
  // MUST be true, not !s_image. AppMessage ACKs delivery, so the phone cannot
  // see that we threw this transfer away -- it will complete the remaining
  // chunks and COMMIT the composite's hash as ours. The previous composite is
  // usually still resident here, so !s_image would be false and the phone's
  // cache would then skip the re-send of an image we never assembled, until the
  // bbox happened to move. This and the phone's abort-clear are two halves of
  // one fix; neither works alone.
  bool mid_transfer = s_rx_buf != NULL;
  rx_reset();
  if (mid_transfer) {
    request_images(true);
  }
}

static void outbox_failed_callback(DictionaryIterator *iterator,
                                   AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox send failed!");
}

// ============================================================================
// DRAWING
// ============================================================================

// ---- Bluetooth badge -------------------------------------------------------
// The firmware ships a CONNECTIVITY_BLUETOOTH_DISCONNECTED bitmap, but no app
// can reach it: every app-facing resource entry point is scoped to the app's
// own resource bank (PebbleOS applib_resource_get_handle(), and
// gbitmap_create_with_resource() which passes sys_get_current_resource_num()),
// and the one call that takes a bank number -- gbitmap_create_with_resource_
// system() -- is absent from the SDK's exported_symbols.json. Fonts are the
// only system asset handed to apps. It would not be the artwork below in any
// case: that 25x25 asset (and its four CONNECTIVITY_BLUETOOTH_* siblings, all
// of which share one glyph and differ only in the modifier beside it) draws a
// *watch* pictogram with an X, not a slashed rune. Nothing in PebbleOS or the
// SDK docs ships a slashed Bluetooth rune; the SDK's own watchface tutorial
// uses a plain rune, visible only while disconnected.
//
// Bundling our own PNG is the documented alternative and what the SDK tutorial
// does, but an app-bank resource is always applib_malloc'd: mmap-from-flash is
// attempted only for SYSTEM_APP (applib_resource_mmap_or_load), so the bitmap
// would sit in the same heap the decode guard is rationing, which basalt
// clears by ~19%. The rune is drawn from line segments instead -- zero heap,
// no resource, and it picks up the configured text/outline colors for free.
//
// Deliberately a fixed pixel size rather than a fraction of the display. This
// is a corner badge, not layout: it should read identically on every platform
// instead of growing with the screen.
#define BT_HALF   6    // half-width of the rune's flags
#define BT_HEIGHT 20   // top vertex to bottom vertex
#define BT_INSET  3    // whole badge, slash overhang included, from the corner
// Odd values ONLY. graphics_context_set_stroke_width() stores an even width as
// given, but the drawing routines silently change it, so an even value never
// draws the width it reads. Which direction is NOT what the SDK says: the doc
// comment on that function (PebbleOS gcontext.h, and the identical text in the
// SDK's pebble.h) claims an even width rounds "down to the previous integral
// value", while the implementation rounds it UP -- prv_adjust_stroked_line_
// width() in PebbleOS graphics_line.c is `if (*width % 2 == 0) (*width)++;`,
// and graphics_draw_line() routes through it for any stroke_width > 1. Firmware
// source over header docs, per the same rule the rest of this file follows: an
// even value here would draw one px THICKER than it reads, not thinner.
// 1/3 is also the only pair legible at this size: the flags are BT_HALF
// px from the stem, and at a 3 px glyph with a 5 px halo they merge into a
// solid blob. Enlarging the rune enough to carry a 3 px stroke would roughly
// double the badge again, which is a lot of basalt's 144x168 to spend on a
// corner indicator.
#define BT_STROKE 1    // glyph; halo draws at BT_STROKE + 2 -> 1 px each side

// ...which is why a thicker rune is built out of 1 px strokes rather than by
// raising BT_STROKE: an extra copy of the polyline offset 1 px in x renders as
// a true 2 px, the width the API cannot express. Offset in x because nothing in
// the rune is horizontal -- the stem is vertical, the flags run at ~40 degrees
// -- so every stroke gains width; an offset along either diagonal would leave
// the flag pair parallel to it as thin as before. The copies are drawn inside
// each pass, so the halo still completes before the first glyph pixel lands.
//
// Costs no footprint: the extra copy extends the rune to cx + BT_HALF + 1,
// which is exactly the slash's right edge, so the badge box is unchanged.
#define BT_RUNE_COPIES 2   // 1 = single stroke; 2 = effective 2 px

// The slash. Its angle is not a style choice: the rune's four flag segments
// already run at ~40 degrees in BOTH diagonal directions, so a 45-degree slash
// -- either way round -- lands parallel to two of them and reads as a fifth
// flag rather than a strike-through. Only a markedly steeper line separates,
// hence a half-width narrower than the rune's height is tall. It also has to
// overhang the rune at both ends; stopping at the glyph's bounding box reads
// as another stroke of the glyph. Bottom-left to top-right, which crosses the
// stem at the one place the rune has no detail of its own.
#define BT_SLASH_HALF 7   // half-width; > BT_HALF, so it sets the badge width
#define BT_SLASH_OVER 2   // overhang past the rune's top and bottom vertices

// The slash's glyph pass ignores TextColor and draws red -- the same red as the
// center marker's dot, the face's one existing "this is not chrome" color. Only
// the glyph: the halo underneath stays OutlineColor, so the slash keeps the
// contrast guarantee the rest of the badge has over arbitrary imagery, and it
// stays separated from the rune even when TextColor is itself red.
//
// Hardcoded rather than a Clay picker: it marks a fault, and a fault indicator
// the user can quietly recolor into the background is worse than no setting.
// Both target platforms are color; a future b/w platform renders GColorRed as
// black (GColor8 nearest-match), which is legible against the white halo but
// loses the distinction from the rune -- revisit the slash there, not here.
#define BT_SLASH_COLOR GColorRed

// Two passes: the whole polyline in the outline color at a thicker stroke,
// then the whole polyline in the text color. Same halo trick as the text pass,
// and for the same reason -- the badge sits over arbitrary radar imagery. The
// outline pass has to finish before the glyph pass starts, or a later outline
// segment would paint over an earlier glyph segment at the crossings.
//
// The slash then repeats both passes AFTER the rune is complete, which is what
// makes it read as lying on top: its outline pass reprints the halo color over
// the rune's glyph pixels, leaving a 1 px gap either side of the slash at every
// crossing. Drawing it as a seventh point of the polyline instead would let the
// two shapes' glyph strokes touch, and the slash would disappear into the rune.
static void draw_bt_badge(GContext *ctx, GRect bounds) {
  // Every point in the badge, from one origin: p is the rune as a single open
  // polyline, in draw order -- upper-left flag tip -> lower-right flag tip ->
  // bottom vertex -> up the stem to the top vertex -> upper-right flag tip ->
  // lower-left flag tip; the first and last segments cross the stem, which is
  // what forms the X. s is the slash's two endpoints.
  //
  // The slash's endpoints derive from the same cx/y0 as the rune: the two
  // shapes have to share an origin or they drift apart, and the drift would be
  // invisible until someone changed an inset.
  //
  // The slash is the widest and tallest part of the badge, so BT_INSET is
  // measured from its extents, not the rune's -- otherwise the overhang would
  // hang off the top-left corner of the screen.
  int16_t cx = bounds.origin.x + BT_INSET + BT_SLASH_HALF;
  int16_t y0 = bounds.origin.y + BT_INSET + BT_SLASH_OVER;
  int16_t q  = BT_HEIGHT / 4;
  GPoint p[6], s[2];
  p[0] = GPoint(cx - BT_HALF, y0 + q);
  p[1] = GPoint(cx + BT_HALF, y0 + 3 * q);
  p[2] = GPoint(cx,           y0 + BT_HEIGHT);
  p[3] = GPoint(cx,           y0);
  p[4] = GPoint(cx + BT_HALF, y0 + q);
  p[5] = GPoint(cx - BT_HALF, y0 + 3 * q);
  s[0] = GPoint(cx - BT_SLASH_HALF, y0 + BT_HEIGHT + BT_SLASH_OVER);
  s[1] = GPoint(cx + BT_SLASH_HALF, y0 - BT_SLASH_OVER);

  GColor outline = (GColor){ .argb = s_settings.outline_argb };

  // Rune: halo pass, then glyph pass, each drawing every copy.
  for (int pass = 0; pass < 2; pass++) {
    graphics_context_set_stroke_color(
        ctx, pass ? (GColor){ .argb = s_settings.text_argb } : outline);
    graphics_context_set_stroke_width(ctx, pass ? BT_STROKE : BT_STROKE + 2);
    for (int dx = 0; dx < BT_RUNE_COPIES; dx++) {
      for (int i = 0; i < 5; i++) {
        graphics_draw_line(ctx, GPoint(p[i].x + dx, p[i].y),
                           GPoint(p[i + 1].x + dx, p[i + 1].y));
      }
    }
  }

  // Slash: the same two passes, over the finished rune.
  for (int pass = 0; pass < 2; pass++) {
    graphics_context_set_stroke_color(ctx, pass ? BT_SLASH_COLOR : outline);
    graphics_context_set_stroke_width(ctx, pass ? BT_STROKE : BT_STROKE + 2);
    graphics_draw_line(ctx, s[0], s[1]);
  }
}

static void map_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  // 1. Composite map — basemap and radar already blended by pkjs, so this is
  // the only bitmap draw. Opaque, drawn as-served, no recoloring, at the
  // default GCompOpAssign the context enters every update proc with.
  //
  // There is deliberately no compositing-mode set here any more. The old radar
  // overlay pass set GCompOpSet and never restored it -- harmless only because
  // steps 2-4 below draw no bitmaps. If a second bitmap draw is ever added to
  // this proc, do not reintroduce a mode set without restoring it.
  if (s_image) {
    graphics_draw_bitmap_in_rect(ctx, s_image, bounds);
  } else {
    graphics_context_set_fill_color(ctx, GColorLightGray);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  }

  // 2. Center marker — white ring + red dot.
  GPoint c = grect_center_point(&bounds);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_circle(ctx, c, 4);
  graphics_context_set_fill_color(ctx, GColorRed);
  graphics_fill_circle(ctx, c, 2);

  // 3. Bluetooth badge — top-left, shown ONLY while the phone is unreachable.
  // Visible-means-disconnected is the watchface convention (and what the SDK
  // tutorial does); the slash is belt-and-braces on top of that, so the badge
  // does not have to be read as "absence means fine". The firmware's own icons
  // pair a glyph with a separate X instead, but those are drawn against a
  // cleared status bar, where a second symbol has room; here it is one glyph
  // over live imagery.
  // Peeked rather than cached: connection_callback() dirties this layer, so a
  // render can only ever follow the state it is about to draw. Drawn BEFORE
  // the text pass so an overlapping line wins the corner.
  if (s_settings.bt_badge && !connection_service_peek_pebble_app_connection()) {
    draw_bt_badge(ctx, bounds);
  }

  // 4. Text halo — each occupied line drawn 8x at ±1 px offsets in the
  // outline color, UNDERNEATH the TextLayers (added after this layer, and
  // sibling render order is add order), which keep drawing the glyphs in the
  // text color untouched. Geometry is the TextLayer's own frame and the text
  // is the same buffer the TextLayer points at, so this pass cannot disagree
  // with place_slot()/update_slots(). No sync hooks are needed either: the
  // firmware render walk repaints the ENTIRE layer tree whenever any layer is
  // dirtied (PebbleOS src/fw/applib/ui/layer.c — the traversal has no
  // per-layer dirty check), so text_layer_set_text() repaints the halo in the
  // same pass. The draw box mirrors the frame 1:1 because this layer fills
  // the window: both are in window coordinates.
  graphics_context_set_text_color(ctx,
                                  (GColor){ .argb = s_settings.outline_argb });
  for (int i = 0; i < NUM_SLOTS; i++) {
    if (!s_slot_layers[i] || slot_kind(i) == SLOT_NONE || !s_slot_bufs[i][0]) {
      continue;
    }
    GRect r = layer_get_frame(text_layer_get_layer(s_slot_layers[i]));
    GFont font = fonts_get_system_font(FONT_KEYS[s_resolved[i]]);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        GRect o = r;
        o.origin.x += dx;
        o.origin.y += dy;
        graphics_draw_text(ctx, s_slot_bufs[i], font, o,
                           GTextOverflowModeTrailingEllipsis,
                           GTextAlignmentCenter, NULL);
      }
    }
  }
}

// ============================================================================
// WINDOW HANDLERS
// ============================================================================

static void main_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_map_layer = layer_create(bounds);            // added FIRST -> drawn first
  layer_set_update_proc(s_map_layer, map_update_proc);
  layer_add_child(window_layer, s_map_layer);

  // The real frames and fonts come from the size dropdowns via
  // apply_slot_layout() below, so the frame passed here is a throwaway.
  for (int i = 0; i < NUM_SLOTS; i++) {
    s_slot_layers[i] = text_layer_create(GRect(0, 0, bounds.size.w, 0));
    text_layer_set_background_color(s_slot_layers[i], GColorClear);
    text_layer_set_text_alignment(s_slot_layers[i], GTextAlignmentCenter);
    text_layer_set_text_color(s_slot_layers[i],
                              (GColor){ .argb = s_settings.text_argb });
    // Bind the buffer once, here: update_slots() only calls set_text when a
    // string CHANGES, so a slot whose string is "" from boot would otherwise
    // keep text == NULL. main_window_unload() clears s_slot_layers[] but not
    // s_slot_bufs, so on a window reload every unchanged slot would come back
    // permanently blank. Done before the layers are added to the window, while
    // layer->window is still NULL, so the mark_dirty inside costs nothing.
    text_layer_set_text(s_slot_layers[i], s_slot_bufs[i]);
  }

  apply_slot_layout();

  for (int i = 0; i < NUM_SLOTS; i++) {
    layer_add_child(window_layer, text_layer_get_layer(s_slot_layers[i]));
  }

  update_slots();
}

static void main_window_unload(Window *window) {
  for (int i = 0; i < NUM_SLOTS; i++) {
    text_layer_destroy(s_slot_layers[i]);
    s_slot_layers[i] = NULL;   // neither the receive state machine nor a
  }                            // config message may follow a dangling
  layer_destroy(s_map_layer);  // pointer if it lands after the window is gone
  if (s_image) gbitmap_destroy(s_image);
  s_map_layer = NULL;
  s_image = NULL;
  rx_reset();
}

// ============================================================================
// APPLICATION LIFECYCLE
// ============================================================================

static void load_settings(void) {
  s_settings = (Settings){
    .version      = SETTINGS_VERSION,
    // Display order. Top Line 1 and Bottom Line 2 default to None, so the
    // out-of-the-box face is the original two lines: Time over Date.
    .slots        = { SLOT_NONE, 0, 1, SLOT_NONE },
    // Medium (Gothic 24 Bold), Extra Large (Bitham 30 Black),
    // Large (Gothic 28 Bold), Medium.
    .fonts        = { 2, 4, 3, 2 },
    .text_argb    = GColorBlackARGB8,
    .outline_argb = GColorWhiteARGB8,
    .refresh_min  = 10,
    .bt_badge     = 1,
  };

  // Versioned, all-or-nothing: the stored blob is taken only if it is exactly
  // this struct's size AND carries this build's version. An older layout, a
  // truncated write or flash corruption all land in the same branch -- do
  // nothing, and keep the defaults above. There is no per-field migration and
  // no partial acceptance, which is the whole point of the version byte.
  //
  // Read into a scratch copy rather than over s_settings: a rejected blob must
  // not be able to leave the live settings half-overwritten.
  Settings stored;
  int read = persist_read_data(SETTINGS_KEY, &stored, sizeof(stored));
  if (read == (int)sizeof(Settings) && stored.version == SETTINGS_VERSION) {
    s_settings = stored;
  }

  // Corruption guard only (see sanitize_refresh): a 0 here would divide by
  // zero on the first tick, and a versioned blob can still be a corrupt one.
  s_settings.refresh_min = sanitize_refresh(s_settings.refresh_min);
}

static void init(void) {
  load_settings();

  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load = main_window_load,
    .unload = main_window_unload
  });
  window_stack_push(s_main_window, true);

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
  battery_state_service_subscribe(battery_callback);
  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = connection_callback
  });
  unobstructed_area_service_subscribe((UnobstructedAreaHandlers) {
    .did_change = unobstructed_did_change
  }, NULL);

  // Register AppMessage callbacks BEFORE opening
  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);

  app_message_open(app_message_inbox_size_maximum(), 64);  // outbox: one small int

  // AFTER app_message_open, deliberately: the 8,200 B inbox is a permanent
  // allocation, and a decode that fitted only because the inbox had not been
  // claimed yet would trade a grey frame for a dead AppMessage channel.
  // Nothing has rendered at this point -- the window is pushed but the render
  // walk runs from the event loop -- so the FIRST frame painted already carries
  // the map, which is the whole point of the cache.
  if (load_image()) {
    update_slots();   // Radar Age adopts the restored frame's own stamp
  }

  // No launch request here: pkjs restarts with the watchface and its own
  // 'ready' handler fetches both layers and composites them, so asking again
  // only duplicates it. That handler also forces the transfer through its hash
  // cache, which is what gets a frame onto a freshly relaunched face.
}

static void deinit(void) {
  tick_timer_service_unsubscribe();
  battery_state_service_unsubscribe();
  connection_service_unsubscribe();
  unobstructed_area_service_unsubscribe();
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
  return 0;
}

/**
 * NOAA US Weather Radar — Pebble watchface
 *
 * Fullscreen radar map centered on the user's location. PebbleKit JS blends a
 * USGS Topo basemap with NOAA MRMS reflectivity into one 16-color PNG and
 * streams it here over AppMessage; the watch decodes and draws that frame and
 * overlays four configurable text slots (see apply_slot_layout()), a center
 * marker and a Bluetooth badge. MINUTE_UNIT ticks only, no floating point.
 */

#include <pebble.h>

// Key 1 may hold an unversioned pre-release blob whose first byte can equal a
// version number, so it is never read or reused. `pebble wipe` clears it.
#define SETTINGS_KEY 2

// ---- Persisted composite ---------------------------------------------------
// The frame lives only in heap, and a watchface relaunches every time the user
// opens the menu and comes back, so the PNG the last successful decode came
// from is cached here and restored in init() before the first render.
//
// A persist value is capped at 256 B (PERSIST_DATA_MAX_LENGTH) on every
// platform, so the bytes span up to IMG_MAX_KEYS keys from IMG_DATA_KEY, with
// a versioned header in IMG_META_KEY.
//
// The per-app total is a firmware capability, so it is queried, not assumed.
// basalt reports 4,096 B, fills at 5,632 B against a 7,873 B worst-case
// composite, and once full fails every later write including overwrites of
// existing keys, which would silently break the settings write in
// inbox_received_callback(). The gate keeps the cache off any store it could
// fill. Where persist_get_max_size() is a literal the comparison folds at
// compile time and the bodies vanish, as on basalt and chalk.
#define IMG_META_KEY        3
#define IMG_DATA_KEY        16
#define IMG_MAX_KEYS        96                 // 96 * 256 = 24,576 B
#define IMG_CACHE_VERSION   1
#define IMG_CACHE_MIN_STORE (64 * 1024)
#define IMG_CACHE_MAX_BYTES ((uint32_t)IMG_MAX_KEYS * PERSIST_DATA_MAX_LENGTH)

#define NUM_SLOTS 4
#define SLOT_NONE 4       // "None" in the slot-code list below

// A decoded frame is a fullscreen 16-color PNG: 4bpp palettized, rows padded
// to a byte. The firmware decoder (upng.c upng_decode_image) inflates into one
// buffer of FRAME_BYTES plus a byte per row, unfilters it in place, and the
// GBitmap adopts that buffer. Measured on all four platforms, a decode needs
// FRAME_BYTES + PBL_DISPLAY_HEIGHT + about 1.8 KB of free heap beyond the
// compressed input, whatever the composite's size. DECODE_HEADROOM's 1.5x
// leaves the rest of half a frame as slack, thinnest on basalt at about 4 KB.
//
// The measured need is a hard floor: a decode that runs 8 to at least 264 B
// short faults the app inside the decoder (consistent with tinflate's
// unchecked code-length malloc); only from about 408 B short does it fail
// cleanly with a NULL-pixel bitmap. So the header guard is the one thing
// between a tight heap and a crash, and the need belongs to the firmware's
// decoder: re-measure it after any SDK change before lowering the multiplier.
//
// The budget covers one decode, not two frames, because only one frame is
// ever resident: pkjs does the blend, and the resident frame is destroyed
// before its replacement decodes. That frame is always full-size, even with
// radar disabled or a clear sky.
#define FRAME_BYTES     (((PBL_DISPLAY_WIDTH + 1) / 2) * PBL_DISPLAY_HEIGHT)
#define DECODE_HEADROOM (FRAME_BYTES * 3 / 2)

// Display order, top to bottom.
enum { SLOT_TOP1, SLOT_TOP2, SLOT_BOT1, SLOT_BOT2 };

// Slot codes: 0 Time, 1 Date, 2 Steps, 3 Battery, 4 None, 5 Weekday,
// 6 ISO date, 7 Bluetooth, 8 Distance, 9 Active cal, 10 Total cal,
// 11 Sleep, 12 Heart rate, 13 Radar age, 14 Lat/Long,
// 15 Current conditions, 16 Today's forecast, 17 High/Low, 18 Active alerts,
// 19 Alerts + upcoming, 20 Alerts else High/Low, 21 Alerts else Conditions,
// 22 Temperature, 23 Feels like, 24 Dew point, 25 Humidity, 26 Wind,
// 27 Pressure, 28 Tonight/Tomorrow, 29 Sunrise/Sunset, 30 Golden hour,
// 31 Alerts else upcoming else Conditions.
//
// The persisted blob is versioned: load_settings() accepts it only when its
// length and version byte both match this build, and otherwise keeps the
// defaults. Bump SETTINGS_VERSION for any layout change (add, remove, reorder
// or retype a field); every watch-bound setting then resets once. Length is
// not a version: a reorder, a same-size retype or a field added in the three
// padding bytes before lat100 all keep sizeof, and without a bump a blob
// already on a user's watch passes both checks and is silently misparsed.
#define SETTINGS_VERSION 1

typedef struct {
  uint8_t version;              // SETTINGS_VERSION at write time
  uint8_t slots[NUM_SLOTS];     // display order: Top 1, Top 2, Bottom 1, Bottom 2
  uint8_t fonts[NUM_SLOTS];     // encoding: see slot_font_raw()
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

// Tripwire for layout changes that move sizeof. It cannot see one that keeps
// sizeof, which is why SETTINGS_VERSION is bumped for every layout change.
// If it fires, bump SETTINGS_VERSION, then update the number here.
// Negative-array form because _Static_assert is C11 and the SDK builds with
// -std=c99.
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
// When pkjs fetched the radar layer behind the composite on screen, sent as
// RADAR_TIME; not a decode time, since an unchanged composite is not re-sent.
// 0 = the radar layer is disabled.
static time_t     s_radar_time;
// What the persisted composite holds, mirrored in RAM so that the phone
// re-sending a frame we already cached (what every relaunch produces) costs a
// checksum rather than a rewrite of every key. s_saved_len 0 means "nothing
// cached that matches what is on screen".
static uint32_t   s_saved_len;
static uint32_t   s_saved_sum;
static int32_t    s_saved_stamp;

// ---- Weather (slots 15-31) -------------------------------------------------
// Finished strings assembled, unit-converted and width-fitted by pkjs; the
// watch only ever copies them and compares `now - stamp`. Nothing here is
// persisted: pkjs replays its last payload on 'ready'.
#define WX_MAX_AGE (3 * 60 * 60)   // beyond this the link is genuinely stuck

static char   s_wx_cond[32], s_wx_fcst[32], s_wx_hilo[32];
static char   s_wx_alert[32], s_wx_alert2[32];
static char   s_wx_temp[32], s_wx_feels[32], s_wx_dew[32], s_wx_hum[32];
static char   s_wx_wind[32], s_wx_pres[32], s_wx_fcst2[32];
static time_t s_wx_time;                  // WX_TIME, for staleness
static time_t s_wx_exp, s_wx_exp2;        // per-slot alert expiry
// Sun events, as absolute instants rather than finished strings -- the one
// weather group the phone cannot format, because 12/24-hour is
// clock_is_24h_style(), a watch setting that never leaves the watch. Four
// int32s also cost less than four more 32-byte buffers. 0 = no such event
// (polar day/night, where the phone's SunCalc has no answer to give).
static time_t s_wx_sunrise, s_wx_sunset;
static time_t s_wx_gold1, s_wx_gold2;     // golden hour span, start and end

// Both arrays are in display order. The historical wire names are mapped to
// display order only in inbox_received_callback()'s key tables.
static uint8_t slot_kind(int i) {
  return s_settings.slots[i];
}

// Font byte encoding: 0-4 = fixed XS..XL; 5-9 = auto ("shrink to fit"),
// ceiling = value - 5; 10 = fixed Super Large; 11 = auto, ceiling Super
// Large. Super Large is appended rather than slotted in at 5 because the
// phone's saved Clay values keep their meaning only if no code is renumbered.
static uint8_t slot_font_raw(int i) {
  return s_settings.fonts[i];
}

#define FONT_SUPER 5   // ladder index of Super Large
#define NUM_FONTS  6

// Auto: raw 5..9 and 11 only. An out-of-range byte (a newer encoding, or
// corruption) reads as fixed Extra Large via slot_font()'s clamp rather than
// as "auto, ceiling XL".
static bool slot_font_auto(int i) {
  uint8_t f = slot_font_raw(i);
  return (f >= 5 && f <= 9) || f == 11;
}

// Ceiling as a ladder index. The size dropdown means "at most this size": the
// band is reserved at the ceiling and only the glyphs shrink inside it, so
// the face never moves in response to content.
static uint8_t slot_font(int i) {
  uint8_t f = slot_font_raw(i);
  if (f == 10 || f == 11) {
    f = FONT_SUPER;
  } else {
    if (f >= 5) {
      f -= 5;
    }
    if (f > 4) {
      f = 4;
    }
  }
#if defined(PBL_PLATFORM_CHALK)
  // chalk's outer lines sit where the bezel leaves a few characters at Medium
  // and up. Its settings page offers them only up to Small, but a replayed
  // config saved for another watch can still carry a larger size.
  if ((i == SLOT_TOP1 || i == SLOT_BOT2) && f > 1) {
    f = 1;   // Small; an auto line stays auto under the lower ceiling
  }
#endif
  return f;
}

// Font ladder for the size dropdowns: XS..XL, Super Large. FONT_H is the
// layer frame height; FONT_OFF is subtracted from the slot's height line,
// lifting the frame by about half its height so it straddles that line
// instead of hanging below it (index 3 sits 1 px lower than exact center).
// Super Large is Bitham 42 Bold: the largest system font declared with full
// Basic Latin on every platform, so "pm" and weather text render. Roboto 49
// is digits-only and LECO 60 is absent on basalt. System fonts cost no app
// heap: their FontInfo lives in a kernel table.
static const char *FONT_KEYS[NUM_FONTS] = {
  FONT_KEY_GOTHIC_14_BOLD, FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_24_BOLD,
  FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_BITHAM_30_BLACK, FONT_KEY_BITHAM_42_BOLD,
};
static const int8_t FONT_H[NUM_FONTS]   = { 18, 22, 28, 34, 36, 50 };
static const int8_t FONT_OFF[NUM_FONTS] = {  9, 11, 14, 16, 18, 25 };

// The few pixels TextLayer effectively insets from its frame. Not derivable
// from a header; corrected from screenshots.
#define TEXT_MARGIN 4

// The band an auto line shrinks inside is fixed by apply_slot_layout() from
// the ceiling font; only the glyph placement inside it, and on a round display
// the frame width, follows the resolved font. s_resolved caches the last
// placed font per slot so update_slots() re-places only when the resolved size
// actually changed.
static int16_t s_band_y[NUM_SLOTS], s_band_h[NUM_SLOTS];
static uint8_t s_resolved[NUM_SLOTS];
// Full width the bands span. Set with them by apply_slot_layout(), which
// main_window_load() runs before update_slots() can get past its
// s_slot_layers guard.
static int16_t s_layout_w;

#if defined(PBL_ROUND)
// First and last rows of glyph ink below the frame top, per ladder font;
// measured from screenshots.
static const int8_t FONT_INK_TOP[NUM_FONTS] = {  5,  6, 10, 10,  9, 12 };
static const int8_t FONT_INK_BOT[NUM_FONTS] = { 15, 20, 27, 31, 34, 48 };

static int32_t isqrt32(int32_t v) {
  int32_t r = 0;
  while ((r + 1) * (r + 1) <= v) {
    r++;
  }
  return r;
}

// Visible width of window row y: the chord of the circle inscribed in the
// display, rounded down. The display fixes the circle whatever the
// obstruction. Centred, the chord never reaches a pixel outside the
// firmware's round mask (display_getafix.c) on chalk or gabbro.
static int16_t chord_w(int y) {
  int32_t d = 2 * y - (PBL_DISPLAY_HEIGHT - 1);
  int32_t v = (int32_t)PBL_DISPLAY_WIDTH * PBL_DISPLAY_WIDTH - d * d;
  return v > 0 ? (int16_t)isqrt32(v) : 0;
}
#endif

// Frame width of slot i drawn in font f. On a round display it is the visible
// chord at f's ink row nearer the bezel, with f centred in the band as
// place_slot() draws it, plus TEXT_MARGIN, so the box resolve_font() measures
// is the chord itself; otherwise, and for a None band, the full width.
static int16_t slot_width(int i, uint8_t f) {
#if defined(PBL_ROUND)
  if (s_band_h[i] > 0) {
    // Taken at f, not the ceiling, so a line that shrinks gains the width its
    // smaller glyphs sit in. The chord narrows monotonically away from the
    // centre row, so the narrowest visible row is one of the ink extremes.
    int16_t y = s_band_y[i] + (s_band_h[i] - FONT_H[f]) / 2;
    int16_t a = chord_w(y + FONT_INK_TOP[f]);
    int16_t c = chord_w(y + FONT_INK_BOT[f]);
    int16_t w = (a < c ? a : c) + TEXT_MARGIN;
    return w < s_layout_w ? w : s_layout_w;
  }
#endif
  return s_layout_w;
}

// Largest ladder step whose text fits the band on one line.
// Measured with GTextOverflowModeWordWrap, not TrailingEllipsis: the ellipsis
// mode reports the size of the truncated text, so every font would appear to
// fit and the loop would always return the ceiling. The fit test is on
// height, not width -- the box is two lines tall and wrapping to a second
// line is the failure condition, which also catches a long single word that
// width alone would not. Needs no GContext, so it is callable from
// update_slots() outside a render pass.
static uint8_t resolve_font(int i, const char *s) {
  uint8_t max = slot_font(i);
  if (!slot_font_auto(i) || !s || !s[0]) {
    // Fixed lines always take their configured size; an empty string resolves
    // to the ceiling, so the line does not sit tiny and then jump when the
    // value arrives (Steps before health data).
    return max;
  }
  for (int f = max; f > 0; f--) {
    GSize sz = graphics_text_layout_get_content_size(
        s, fonts_get_system_font(FONT_KEYS[f]),
        GRect(0, 0, slot_width(i, f) - TEXT_MARGIN, FONT_H[f] * 2),
        GTextOverflowModeWordWrap, GTextAlignmentCenter);
    if (sz.h <= FONT_H[f]) {
      return f;      // did not need a second line
    }
  }
  return 0;          // Extra Small and still too wide: the ellipsis takes it
}

// Vertically centre the resolved font in its fixed band (TextLayer has no
// vertical centering of its own). place_slot() never consults neighbouring
// slots, which guarantees a re-size cannot cascade. A None slot keeps its
// zero-height frame regardless of the resolved font.
static void place_slot(int i, uint8_t f) {
  int16_t h = (slot_kind(i) == SLOT_NONE) ? 0 : FONT_H[f];
  int16_t w = slot_width(i, f);
  layer_set_frame(text_layer_get_layer(s_slot_layers[i]),
                  GRect((s_layout_w - w) / 2,
                        s_band_y[i] + (s_band_h[i] - h) / 2, w, h));
  text_layer_set_font(s_slot_layers[i], fonts_get_system_font(FONT_KEYS[f]));
}

// ============================================================================
// TEXT SLOTS
// ============================================================================

// Weather strings: "--" when there is no data or the payload is stale (phone
// unreachable for WX_MAX_AGE). Takes `now` like fmt_alert, so cases 20, 21
// and 31, which call both, test expiry and staleness against one instant.
static void fmt_wx(char *buf, size_t size, const char *src, time_t now) {
  if (!s_wx_time || now - s_wx_time > WX_MAX_AGE || src[0] == '\0') {
    snprintf(buf, size, "--");
  } else {
    snprintf(buf, size, "%s", src);
  }
}

// Alerts: empty string when the buffer is empty or when now > exp. An alert
// self-clears on its own NWS expiry even if the phone is unreachable, so a
// disconnected watch can never keep displaying a warning that has lapsed.
// Alerts deliberately do not fall back to "--": absence of an alert and
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

// Render an absolute instant as a wall-clock time in the watch's own 12/24
// style. clock_is_24h_style() never leaves the watch, which is why the sun
// slots arrive as numbers.
//
// The meridiem is a single letter ("6:12a"). Strings built here get none of
// the phone's width machinery (char budget, abbreviation table, shorter-form
// ladder), and the saved character lets a golden-hour range fit two times and
// a separator in one slot.
static void fmt_clock(char *buf, size_t size, time_t t, bool meridiem) {
  // localtime() honours the time_t passed to it (pbl_override_localtime ->
  // sys_localtime_r in reference/PebbleOS/src/fw/applib/pbl_std/pbl_std.c),
  // but fills a shared app-state tm, so consume its fields before the next
  // call. fmt_span is the caller that has to care.
  struct tm *lt = localtime(&t);
  if (clock_is_24h_style()) {
    snprintf(buf, size, "%02d:%02d", lt->tm_hour, lt->tm_min);
  } else {
    int h12 = lt->tm_hour % 12;
    if (h12 == 0) h12 = 12;
    snprintf(buf, size, "%d:%02d%s", h12, lt->tm_min,
             meridiem ? (lt->tm_hour < 12 ? "a" : "p") : "");
  }
}

// A span end is displayable while it is still ahead, plus one refresh
// interval of grace. An instant does not go stale the way fmt_wx's data does;
// it passes. pkjs sends the next span whose end is ahead, so an end falls
// behind only between heartbeats, and without the grace the slot would blank
// from that end until the next heartbeat. Past the grace the phone is
// unreachable and the value really is wrong.
static bool sun_showable(time_t t, time_t now) {
  return t != 0 && now - t <= (time_t)s_settings.refresh_min * 60;
}

static bool is_leap(int year) {
  return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

// True when the event is past tomorrow in local calendar terms, where a bare
// clock time would read as today. Inside the Arctic a sun event can be days
// out, and then the date is the useful half.
//
// The test is the calendar, not a lead-time cutoff: real lead times run as a
// continuum from 24 h to a week, so any cutoff mislabels some. Compared on
// local yday/year rather than by dividing seconds, because a local day is not
// 86,400 s long across a DST change. Events are within a week either way, so
// only adjacent years can arise.
static bool sun_far(time_t t, time_t now) {
  struct tm *lt = localtime(&now);
  int nyday = lt->tm_yday, nyear = lt->tm_year;
  int diff;
  lt = localtime(&t);          // shared tm: read `now`'s fields out first
  if (lt->tm_year == nyear) {
    diff = lt->tm_yday - nyday;
  } else if (lt->tm_year == nyear + 1) {
    diff = lt->tm_yday + (is_leap(1900 + nyear) ? 366 : 365) - nyday;
  } else if (lt->tm_year == nyear - 1) {
    // Behind us, across New Year. Reachable: fmt_span passes the start of a
    // window in progress, so at 00:30 on 1 January a window that opened at
    // 22:45 on 31 December lands here. It is now, not far; the catch-all
    // below would render "Dec 31".
    return false;
  } else {
    return true;               // more than a year out, which cannot be soon
  }
  return diff > 1;
}

// "Jan 23": the label for an event past tomorrow.
static void fmt_sun_date(char *buf, size_t size, time_t t) {
  strftime(buf, size, "%b %d", localtime(&t));
}

// A pair of instants as a range, "7:48-8:31p". Used by both sun slots --
// Sunrise/Sunset is the daylight span, Golden Hour the golden one -- because
// the two are the same shape and the phone sends each as a coherent pair
// rather than as two independently-resolved "next" values.
//
// Keyed on the end being showable, so a span already in progress keeps
// rendering rather than blanking halfway through: that is what lets the
// Sunrise/Sunset slot go on showing this morning's sunrise all afternoon, and
// it matches how the phone chooses which span to send.
static void fmt_span(char *buf, size_t size, time_t a, time_t b, time_t now) {
  if (!a || !sun_showable(b, now)) {
    snprintf(buf, size, "--");
    return;
  }
  // A window days out gets its date instead of a range: two clock times and a
  // separator say nothing about which day, and there is no room for both.
  if (sun_far(a, now)) {
    fmt_sun_date(buf, size, a);
    return;
  }
  // Both meridiems are read before either string is built: localtime returns
  // a pointer to one shared tm, so the second call would otherwise overwrite
  // the first one's answer.
  struct tm *lt = localtime(&a);
  bool pm_a = lt->tm_hour >= 12;
  lt = localtime(&b);
  bool pm_b = lt->tm_hour >= 12;
  char s1[12], s2[12];
  // One meridiem, on the end, whenever both ends share it, which is the
  // normal case for a golden window. A daylight span straddles noon, as can a
  // golden window at high latitudes (an Arctic winter sunrise after 11:00),
  // and then each end carries its own.
  fmt_clock(s1, sizeof(s1), a, pm_a != pm_b);
  fmt_clock(s2, sizeof(s2), b, true);
  snprintf(buf, size, "%s-%s", s1, s2);
}

// Format one slot's string into buf. Pure formatting: no TextLayer access,
// so update_slots() can compare the result against the previous contents and
// re-measure only when the string actually changed. `super` is true when the
// line's ceiling is Super Large.
static void format_slot(uint8_t kind, bool super, char *buf, size_t size) {
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
      // Super Large takes the sun slots' one-letter meridiem: "10:00pm" is
      // 177 px in Bitham 42 Bold against basalt's 140, "10:00p" is 139.
      if (super) {
        fmt_clock(buf, size, now, true);
      } else if (clock_is_24h_style()) {
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
      // s_radar_time is the phone's fetch clock, so the difference can come out
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
      // The alert is tested first, so a stale-data "--" can never mask a live
      // alert; fmt_alert's empty string is the "no alert" signal, so expiry
      // and staleness are already handled by the two helpers. Both branches
      // run every update_slots() call (once a minute), which is what makes
      // the revert-on-expiry happen without a message from the phone.
      fmt_alert(buf, size, s_wx_alert, s_wx_exp, now);
      if (buf[0] == '\0') {
        fmt_wx(buf, size, kind == 20 ? s_wx_hilo : s_wx_cond, now);
      }
      break;
    case 31:  // alert, else upcoming alert, else current conditions
      // In-effect alerts strictly first. WX_ALERT2 is the top-ranked alert of
      // all of them, so once nothing is in effect it is the top-ranked upcoming
      // one, with its lead time ("in 3h"). Same expiry and staleness handling
      // as cases 20/21, one step longer.
      fmt_alert(buf, size, s_wx_alert, s_wx_exp, now);
      if (buf[0] == '\0') {
        fmt_alert(buf, size, s_wx_alert2, s_wx_exp2, now);
      }
      if (buf[0] == '\0') {
        fmt_wx(buf, size, s_wx_cond, now);
      }
      break;
    case 22: fmt_wx(buf, size, s_wx_temp,  now); break;
    case 23: fmt_wx(buf, size, s_wx_feels, now); break;
    case 24: fmt_wx(buf, size, s_wx_dew,   now); break;
    case 25: fmt_wx(buf, size, s_wx_hum,   now); break;
    case 26: fmt_wx(buf, size, s_wx_wind,  now); break;
    case 27: fmt_wx(buf, size, s_wx_pres,  now); break;
    case 28: fmt_wx(buf, size, s_wx_fcst2, now); break;
    case 29: fmt_span(buf, size, s_wx_sunrise, s_wx_sunset, now); break;
    case 30: fmt_span(buf, size, s_wx_gold1,   s_wx_gold2,  now); break;
    default:  // None
      buf[0] = '\0';
      break;
  }
}

static void update_slots(void) {
  if (!s_slot_layers[0]) {
    return;   // a tick or config message beat the window load
  }
  for (int i = 0; i < NUM_SLOTS; i++) {
    char tmp[sizeof(s_slot_bufs[0])];
    // strftime returns 0 and leaves the buffer's contents unspecified when the
    // formatted result does not fit, so start every slot from an empty string.
    tmp[0] = '\0';
    format_slot(slot_kind(i), slot_font(i) == FONT_SUPER, tmp, sizeof(tmp));
    // Re-resolve only when the string changed. Fixed lines resolve straight
    // to their configured size, so they never re-place.
    if (strcmp(tmp, s_slot_bufs[i]) != 0) {
      strcpy(s_slot_bufs[i], tmp);
      uint8_t f = resolve_font(i, s_slot_bufs[i]);
      if (f != s_resolved[i]) {
        s_resolved[i] = f;
        place_slot(i, f);   // the band is fixed; only the glyphs move
      }
      // Inside the branch on purpose: text_layer_set_text() has no equality
      // check (PebbleOS applib/ui/text_layer.c), and its dirty repaints the
      // whole layer tree. Called unconditionally, it would make the redraw
      // flag in inbox_received_callback() and connection_callback()'s
      // layer_mark_dirty() dead code. The layers already point at these
      // buffers (bound in main_window_load), so this call is only for the
      // repaint.
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

  // The inner pair sits on the 25%/75% height lines; the outer pair takes the
  // full height of its own frame immediately beyond it, so raising either
  // inner line's size pushes its outer neighbour outward rather than
  // overlapping it.
  // A round display's Quick View covers only rows below the centre, so its top
  // half keeps the full display's quarter line; anchored on the unobstructed
  // height, the top lines would rise to where the circle cuts them short.
  int top_h = PBL_IF_ROUND_ELSE(PBL_DISPLAY_HEIGHT, b.size.h);
  int inner_top = top_h / 4 - FONT_OFF[f[SLOT_TOP2]];
  int inner_bot = b.size.h * 3 / 4 - FONT_OFF[f[SLOT_BOT1]];

  // A short display may lack room for the outer pair beyond those lines
  // (basalt, all four lines at default sizes). Where the outer band does not
  // fit, move the inner line inward: the quarter lines are a preference,
  // staying on screen is not. Only a font change, a slot switching to or from
  // None, or an obstruction can trigger this, so the face never moves in
  // response to content.
  if (inner_top < h[SLOT_TOP1]) {
    inner_top = h[SLOT_TOP1];
  }
  int bot_limit = b.size.h - h[SLOT_BOT1] - h[SLOT_BOT2];
  if (inner_bot > bot_limit) {
    inner_bot = bot_limit;
  }
  // A display too short to seat every occupied line at the chosen sizes (the
  // Quick View leaves basalt about 117 px, which four large lines exceed).
  // The inner pair carries the primary readout, so rather than let the two
  // inner lines collide mid-screen, the bottom lines stack below Top Line 2
  // and run past the bottom edge, Bottom Line 2 first. Top Line 1 stays on
  // screen: inner_top was already clamped to its height above.
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
    int yy = (top_h / 4 - h[SLOT_TOP1]) / 2;
    y[SLOT_TOP1] = yy < 0 ? 0 : yy;
  }
  if (slot_kind(SLOT_BOT1) == SLOT_NONE && h[SLOT_BOT2] > 0) {
    int yy = b.size.h * 3 / 4 + (b.size.h / 4 - h[SLOT_BOT2]) / 2;
    if (yy + h[SLOT_BOT2] > b.size.h) {
      yy = b.size.h - h[SLOT_BOT2];
    }
    y[SLOT_BOT2] = yy;
  }

  // Bands come from the ceiling font; auto only moves glyphs inside them.
  // Re-resolve against the current strings, since a font or slot change can
  // alter a ceiling, and on a round display a band that moves changes width.
  s_layout_w = b.size.w;
  for (int i = 0; i < NUM_SLOTS; i++) {
    s_band_y[i] = y[i];
    s_band_h[i] = h[i];
    s_resolved[i] = resolve_font(i, s_slot_bufs[i]);
    place_slot(i, s_resolved[i]);
  }
}

static void unobstructed_did_change(void *context) {
  apply_slot_layout();
}

// ============================================================================
// IMAGE REQUESTS
// ============================================================================

// Corruption guard. A 0 would divide by zero in tick_handler's tm_min modulo,
// so it is applied at every write as well as at load. Config values divide 60
// to keep the heartbeat aligned to the hour; a non-divisor merely ticks
// unevenly, so it is not rejected.
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
//   2 = "I have no image" -> bypass the committed hash cache; bytes already
//                            in flight or delivered this pass are not re-sent.
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

  // Heartbeat: refresh the composite (and weather, which rides the same
  // request on the phone) every refresh_min minutes. A transfer the watch
  // refused is still ACKed chunk by chunk, so pkjs commits its hash and
  // re-offers those bytes only when this flag says the watch has no frame.
  if (tick_time->tm_min % s_settings.refresh_min == 0) {
    request_images(!s_image);
  }
}

static void battery_callback(BatteryChargeState state) {
  update_slots();
}

static void connection_callback(bool connected) {
  update_slots();
  // update_slots() only repaints when a slot's string changed, and the badge
  // does not depend on any slot -- with no Bluetooth slot configured, nothing
  // above would dirty anything and the badge would never appear or clear.
  if (s_map_layer) {   // a state change can beat the window load
    layer_mark_dirty(s_map_layer);
  }
}

// ============================================================================
// PERSISTED COMPOSITE
// ============================================================================

// Written last, so a write that dies partway through the data keys can never
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
// silently (see the decode path) and would leave a blank face with no clue why.
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
// another 8-20 KB of heap on gabbro, the cache platform with the fewest frames
// of heap.
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

// RADAR_TIME arrives in its own message after the transfer it belongs to, so
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
  // that runs short faults the app or hands back a GBitmap with a NULL pixel
  // buffer (see DECODE_HEADROOM). On emery and gabbro IMG_CACHE_MAX_BYTES keeps
  // a cached frame inside it, so this is a backstop.
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
  // The only place the wire's historical naming is decoded: TopSlot/TopFont
  // are Top Line 2 and BottomSlot/BottomFont are Bottom Line 1. The keys
  // cannot be renamed without resetting every phone-side saved config, so the
  // mapping to display order stops here.
  // Not static: MESSAGE_KEY_* are resolved at load time, not compile time, so
  // they cannot initialize a static array ("initializer element is not
  // constant"). Two stack arrays per message are not worth a lazy-init.
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
  // change does, since a None line reserves no band (see
  // apply_slot_layout). Geometry depends on slot kind, not only on font.
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

    // Set by the branches that change what map_update_proc draws
    // (OutlineColor, BtIndicator) and consumed once below. Not conditioned on
    // the memcmp: a re-save with unchanged values still repaints. A flag
    // rather than an unconditional dirty, so the heartbeat's Lat/Lon message
    // does not redraw. TextColor needs no flag: text_layer_set_text_color
    // dirties the text layers, and the firmware render walk repaints the whole
    // layer tree on any dirty (reference/PebbleOS/src/fw/applib/ui/layer.c),
    // halo included.
    bool redraw = false;

    for (int i = 0; i < NUM_SLOTS; i++) {
      if (slot_t[i]) s_settings.slots[i] = (uint8_t)slot_t[i]->value->int32;
      if (font_t[i]) s_settings.fonts[i] = (uint8_t)font_t[i]->value->int32;
    }
    // Zoom and RadarMode are phone-side: pkjs owns the bbox math and the blend
    // and re-sends a composite when the webview closes, so there is nothing
    // here to store or redraw.
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
  // WX_TIME is the phone's fetch time (pkjs replays its last payload on
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
    wx_copy(iter, MESSAGE_KEY_WX_TEMP,   s_wx_temp,   sizeof(s_wx_temp));
    wx_copy(iter, MESSAGE_KEY_WX_FEELS,  s_wx_feels,  sizeof(s_wx_feels));
    wx_copy(iter, MESSAGE_KEY_WX_DEW,    s_wx_dew,    sizeof(s_wx_dew));
    wx_copy(iter, MESSAGE_KEY_WX_HUM,    s_wx_hum,    sizeof(s_wx_hum));
    wx_copy(iter, MESSAGE_KEY_WX_WIND,   s_wx_wind,   sizeof(s_wx_wind));
    wx_copy(iter, MESSAGE_KEY_WX_PRES,   s_wx_pres,   sizeof(s_wx_pres));
    wx_copy(iter, MESSAGE_KEY_WX_FCST2,  s_wx_fcst2,  sizeof(s_wx_fcst2));
    Tuple *exp_t  = dict_find(iter, MESSAGE_KEY_WX_EXP);
    Tuple *exp2_t = dict_find(iter, MESSAGE_KEY_WX_EXP2);
    if (exp_t)  s_wx_exp  = (time_t)exp_t->value->uint32;
    if (exp2_t) s_wx_exp2 = (time_t)exp2_t->value->uint32;
    // Sun events. int32, like RADAR_TIME: pkjs marshals a plain JS number as
    // a 4-byte int, and the union's smaller members are only valid for a
    // smaller tuple. An absent key assigns 0 rather than skipping, because 0
    // is meaningful here (no such event at this latitude today).
    Tuple *sr_t = dict_find(iter, MESSAGE_KEY_WX_SUNRISE);
    Tuple *ss_t = dict_find(iter, MESSAGE_KEY_WX_SUNSET);
    Tuple *g1_t = dict_find(iter, MESSAGE_KEY_WX_GOLD1);
    Tuple *g2_t = dict_find(iter, MESSAGE_KEY_WX_GOLD2);
    s_wx_sunrise = sr_t ? (time_t)sr_t->value->int32 : 0;
    s_wx_sunset  = ss_t ? (time_t)ss_t->value->int32 : 0;
    s_wx_gold1   = g1_t ? (time_t)g1_t->value->int32 : 0;
    s_wx_gold2   = g2_t ? (time_t)g2_t->value->int32 : 0;
    s_wx_time = (time_t)wx_time_t->value->uint32;
    update_slots();
  }

  // ---- Radar timestamp ---------------------------------------------------
  // pkjs's radar fetch time, sent explicitly because a composite pkjs skips as
  // unchanged is never decoded here. It arrives at the phone's commit point,
  // so a transfer that dies halfway advances nothing. 0 = radar disabled
  // ("no radar"). Kept out of the config block: it is not a setting and must
  // not enter the memcmp-guarded persist.
  //
  // Read as int32: pkjs marshals a plain JS number as a 4-byte int, and the
  // union's uint8 member is only valid for a 1-byte tuple. Unix seconds fit
  // in an int32 until 2038.
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
    // A decode that runs slightly short faults the app, and one that runs
    // further short fails silently (a GBitmap with a NULL pixel buffer,
    // checked after the decode below); either way the frame being replaced
    // is already destroyed, so the headroom is required up front (see
    // DECODE_HEADROOM).
    // DECODE_HEADROOM is sized for the phone's 4bpp PNG, and nothing here
    // checks bit depth: s_rx_total is the compressed size, so a deeper source
    // passes both clauses even though it inflates to more (about 2x the frame
    // at 8bpp). The NULL-pixel-buffer check and the load_image() restore
    // behind it contain a decode that runs well short, not one that lands in
    // the crash window.
    // The image being replaced is destroyed before the decode, so its bytes
    // count as available; otherwise every refresh after the first would be
    // refused.
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
      // Fragmentation can refuse a block the total-free guard above accepted.
      APP_LOG(APP_LOG_LEVEL_WARNING, "Rx malloc of %d bytes failed (free %d)",
              (int)s_rx_total, (int)heap_bytes_free());
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
    // Destroy the old bitmap before decoding: it cuts peak heap by a whole
    // FRAME_BYTES, and those bytes were already counted as available in the
    // guard above. Nothing is rendered between here and the layer_mark_dirty
    // below.
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
    // failing image from re-requesting back-to-back at fetch pace. It does not
    // stop the retrying: the flag clears only on a successful decode, and the
    // heartbeat re-offers the composite anyway (a NULL s_image makes
    // tick_handler ask for one), so a permanently undecodable image is retried
    // every refresh_min minutes forever -- just never in a tight loop.
    if (s_image) {
      s_decode_retry = false;
    } else {
      // The frame this transfer was replacing is gone, but the cache still
      // holds the last one that did decode: older, different bytes, so
      // restoring it is not a retry of the same failure. Attempted before and
      // independently of the rate-limit flag, which governs only the
      // re-request: a second consecutive failure destroys the restored frame
      // too, so gating the restore on the flag would blank the face for good.
      load_image();
      // Re-request whether or not the restore worked: a restored frame is
      // older than the one that failed. The flag limits this to one
      // re-request per run of failures.
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
  // Must be true, not !s_image. AppMessage ACKs delivery, so the phone cannot
  // see that we threw this transfer away -- it will complete the remaining
  // chunks and commit the composite's hash as ours. The previous composite is
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
// The firmware's CONNECTIVITY_BLUETOOTH_* bitmaps are out of reach: app
// resource calls are scoped to the app's own bank, and
// gbitmap_create_with_resource_system() is not in the SDK's
// exported_symbols.json. A bundled PNG would be applib_malloc'd (only system
// apps mmap resources from flash) out of the heap the decode guard rations.
// So the rune is drawn from line segments: zero heap, no resource, and it
// takes the configured text/outline colors.
//
// A fixed pixel size rather than a fraction of the display: the badge should
// read the same on every platform.
#define BT_HALF   6    // half-width of the rune's flags
#define BT_HEIGHT 20   // top vertex to bottom vertex
#define BT_INSET  3    // whole badge, slash overhang included, from the edge
// Odd values only. An even width is stored as given but drawn one px thicker:
// prv_adjust_stroked_line_width() in PebbleOS graphics_line.c rounds it up,
// although the gcontext.h doc says down. 1/3 is also the only legible pair at
// this size: with a 3 px glyph and a 5 px halo the flags, BT_HALF px from the
// stem, merge into a blob, and a rune large enough for that stroke would
// spend too much of basalt's 144x168 on a corner indicator.
#define BT_STROKE 1    // glyph; halo draws at BT_STROKE + 2 -> 1 px each side

// A thicker rune is therefore built from 1 px strokes rather than by raising
// BT_STROKE: a copy of the polyline offset 1 px in x renders as a true 2 px,
// a width the API cannot express. Offset in x because nothing in the rune is
// horizontal, so every stroke gains width; a diagonal offset would leave the
// flags parallel to it as thin as before. The copies are drawn inside each
// pass, so the halo completes before the first glyph pixel. The copy ends at
// cx + BT_HALF + 1, the slash's right edge, so the badge box is unchanged.
#define BT_RUNE_COPIES 2   // 1 = single stroke; 2 = effective 2 px

// The slash. Its angle is not a style choice: the rune's four flag segments
// already run at ~40 degrees in both diagonal directions, so a 45-degree slash
// -- either way round -- lands parallel to two of them and reads as a fifth
// flag rather than a strike-through. Only a markedly steeper line separates,
// hence a half-width narrower than the rune's height is tall. It also has to
// overhang the rune at both ends; stopping at the glyph's bounding box reads
// as another stroke of the glyph. Bottom-left to top-right, which crosses the
// stem at the one place the rune has no detail of its own.
#define BT_SLASH_HALF 7   // half-width; > BT_HALF, so it sets the badge width
#define BT_SLASH_OVER 2   // overhang past the rune's top and bottom vertices
// Rows the slash spans, the badge's tallest part; its halo adds one each side.
#define BT_BOX_H (BT_HEIGHT + 2 * BT_SLASH_OVER + 1)

// The slash's glyph pass draws red, like the center marker's dot, whatever
// TextColor is. Its halo stays OutlineColor, so the slash keeps the badge's
// contrast over imagery and stays separated from the rune even when TextColor
// is red. Hardcoded rather than a Clay picker: a fault indicator the user can
// recolor into the background is worse than no setting. Every target
// platform is color; a b/w platform would render GColorRed as black and lose
// the distinction from the rune, so revisit the slash there.
#define BT_SLASH_COLOR GColorRed

// Two passes: the whole polyline in the outline color at a thicker stroke,
// then in the text color, the same halo trick as the text pass because the
// badge sits over arbitrary imagery. The outline pass must finish first, or a
// later outline segment paints over an earlier glyph segment at a crossing.
//
// The slash repeats both passes after the rune is complete, so its outline
// cuts a 1 px gap in the rune either side of it. As a seventh polyline point
// its glyph stroke would touch the rune's and vanish into it.
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
  int16_t left = bounds.origin.x + BT_INSET;
  int16_t top  = bounds.origin.y + BT_INSET;
#if defined(PBL_ROUND)
  // A round display has no corner, so the badge sits at 9 o'clock: no text
  // band occupies mid-height at default sizes, and the centre marker is far
  // off. BT_INSET then runs from the bezel at the halo's outermost rows, the
  // narrowest the badge spans.
  top = bounds.origin.y + (bounds.size.h - BT_BOX_H) / 2;
  int16_t cw = chord_w(top - 1);
  int16_t cb = chord_w(top + BT_BOX_H);
  if (cb < cw) {
    cw = cb;
  }
  left = bounds.origin.x + (bounds.size.w - cw) / 2 + BT_INSET;
#endif
  int16_t cx = left + BT_SLASH_HALF;
  int16_t y0 = top + BT_SLASH_OVER;
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

  // 1. Composite map, basemap and radar already blended by pkjs: the only
  // bitmap draw, at the default GCompOpAssign the context enters every update
  // proc with. If another bitmap draw is added, restore any compositing mode
  // it sets.
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

  // 3. Bluetooth badge, top-left or at 9 o'clock on a round display, shown
  // only while the phone is unreachable (the watchface convention). The slash
  // makes it read as "disconnected" on its own, without relying on that
  // convention. Peeked rather than cached: connection_callback() dirties this
  // layer, so a render always follows the state it draws. Drawn before the
  // text pass so an overlapping line wins the spot.
  if (s_settings.bt_badge && !connection_service_peek_pebble_app_connection()) {
    draw_bt_badge(ctx, bounds);
  }

  // 4. Text halo — each occupied line drawn 8x at ±1 px offsets in the
  // outline color, underneath the TextLayers (added after this layer, and
  // sibling render order is add order), which keep drawing the glyphs in the
  // text color untouched. Geometry is the TextLayer's own frame and the text
  // is the same buffer the TextLayer points at, so this pass cannot disagree
  // with place_slot()/update_slots(). No sync hooks are needed either: the
  // firmware render walk repaints the entire layer tree whenever any layer is
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
    // string changes, so a slot whose string is "" from boot would otherwise
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
    // out-of-the-box face is two lines: Time over Date.
    .slots        = { SLOT_NONE, 0, 1, SLOT_NONE },
    // Medium (Gothic 24 Bold), Extra Large (Bitham 30 Black),
    // Large (Gothic 28 Bold), Medium.
    .fonts        = { 2, 4, 3, 2 },
    .text_argb    = GColorBlackARGB8,
    .outline_argb = GColorWhiteARGB8,
    .refresh_min  = 10,
    .bt_badge     = 1,
  };

  // Take the stored blob only if it is exactly this struct's size and carries
  // this build's version; an older layout, a truncated write or corruption all
  // keep the defaults above. Read into a scratch copy so a rejected blob cannot
  // leave the live settings half-overwritten.
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

  // Register AppMessage callbacks before opening
  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);

  app_message_open(app_message_inbox_size_maximum(), 64);  // outbox: one small int

  // After app_message_open, deliberately: the 8,200 B inbox is a permanent
  // allocation, and a decode that fitted only because the inbox had not been
  // claimed yet would trade a grey frame for a dead AppMessage channel.
  // Nothing has rendered at this point -- the window is pushed but the render
  // walk runs from the event loop -- so the first frame painted already carries
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

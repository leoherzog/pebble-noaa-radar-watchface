/**
 * NOAA US Weather Radar: Pebble watchface.
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
// The PNG of the last successful decode, restored in init() before the first
// render, because a watchface relaunches whenever the user opens the menu and
// comes back. A persist value is capped at 256 B on every platform, so the
// bytes span IMG_MAX_KEYS keys from IMG_DATA_KEY behind a versioned header.
//
// The per-app store size is a firmware capability, so it is queried. basalt's
// fills at 5,632 B against a 9,739 B worst-case composite, and once full fails
// every later write including overwrites, which would silently break the
// settings write; the cache never shares a store it could fill. Where
// persist_get_max_size() is a literal, as on basalt and chalk, the gate folds
// at compile time and the cache code vanishes.
#define IMG_META_KEY        3
#define IMG_DATA_KEY        16
#define IMG_MAX_KEYS        96                 // 96 * 256 = 24,576 B
#define IMG_CACHE_VERSION   1
#define IMG_CACHE_MIN_STORE (64 * 1024)
#define IMG_CACHE_MAX_BYTES ((uint32_t)IMG_MAX_KEYS * PERSIST_DATA_MAX_LENGTH)

#define NUM_SLOTS 4
#define SLOT_NONE 4       // "None" in config.js SLOT_OPTIONS

// A decoded frame is 4bpp, rows padded to a byte. The firmware decoder
// (upng.c upng_decode_image) inflates into one buffer of FRAME_BYTES plus a
// byte per row, which the GBitmap adopts; measured on all four platforms, a
// decode needs FRAME_BYTES + PBL_DISPLAY_HEIGHT + about 1.8 KB free beyond the
// compressed input. DECODE_HEADROOM's 1.5x leaves the rest of half a frame as
// slack, thinnest on basalt at about 4 KB.
//
// The need is a hard floor: a decode 8 to at least 264 B short faults the app
// inside the decoder, and only from about 408 B short does it fail cleanly.
// Re-measure it after any SDK change before lowering the multiplier. The
// budget is one frame, never two, because the resident frame is destroyed
// before its replacement decodes; it is full-size even with radar disabled.
#define FRAME_BYTES     (((PBL_DISPLAY_WIDTH + 1) / 2) * PBL_DISPLAY_HEIGHT)
#define DECODE_HEADROOM (FRAME_BYTES * 3 / 2)

// Display order, top to bottom.
enum { SLOT_TOP1, SLOT_TOP2, SLOT_BOT1, SLOT_BOT2 };

// load_settings() accepts the stored blob only when its length and version
// both match this build; anything else is a first run. Bump SETTINGS_VERSION
// for any layout change (add, remove, reorder or retype a field), which resets
// every watch-bound setting once. Length is not a version: a reorder, a
// same-size retype or a field in the three padding bytes before lat100 keeps
// sizeof, and an unbumped blob already on a watch is then silently misparsed.
#define SETTINGS_VERSION 1

typedef struct {
  uint8_t version;              // SETTINGS_VERSION at write time
  uint8_t slots[NUM_SLOTS];     // display order: Top 1, Top 2, Bottom 1, Bottom 2
  // Font bytes, display order: 0-4 fixed XS..XL; 5-9 auto with ceiling
  // value - 5; 10 fixed Super Large; 11 auto, ceiling Super Large. Super Large
  // is appended because a renumbered code changes every saved Clay value.
  uint8_t fonts[NUM_SLOTS];
  // GColor8 .argb: text for the TextLayers, outline for the halo under them.
  uint8_t text_argb;
  uint8_t outline_argb;
  uint8_t refresh_min;          // heartbeat period in minutes; divides 60
  uint8_t bt_badge;             // Bluetooth disconnection indicator; 0 = hidden
  // Degrees x100 from pkjs, persisted so Lat/Long shows before a fix. Last,
  // because a leading 4-byte member would pad the struct.
  int32_t lat100;
  int32_t lon100;
} Settings;

// Breaks the build if sizeof moves. It cannot see a layout change that keeps
// sizeof, so bump SETTINGS_VERSION regardless, then update the number here.
// Negative-array form because the SDK builds with -std=c99.
typedef char settings_layout_check[(sizeof(Settings) == 24) ? 1 : -1];

// ---- First-run sizes -------------------------------------------------------
// The platform's default Text Size, which the public header leaves out
// (firmware applib/preferred_content_size.h). preferred_content_size() reports
// on this build's own scale, so anything above the default is Larger.
#define CONTENT_SIZE_DEFAULT \
  (PBL_DISPLAY_HEIGHT >= 200 ? PreferredContentSizeLarge \
                             : PreferredContentSizeMedium)

// Font bytes (Settings.fonts) a first run takes when Text Size is above the
// default, in display order: one rung up, shrink to fit, where that fits.
// Each must be a size the settings page offers or custom-clay.js maps to one.
static const uint8_t LARGER_FONTS[NUM_SLOTS] =
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_GABBRO)
    { 8, 11, 9, 8 };
#elif defined(PBL_PLATFORM_CHALK)
    { 2, 11, 3, 2 };   // outer lines stay under their Small cap (slot_font())
#else
    // An Extra Large date runs to 194 px, which only emery and gabbro fit, so
    // a platform with no measured row keeps it Large.
    { 8, 11, 3, 8 };
#endif

// ==== Global state ==========================================================

static Settings   s_settings;
static Window    *s_main_window;
static Layer     *s_map_layer;      // full-bounds, owns the update proc
static TextLayer *s_slot_layers[NUM_SLOTS];
static GBitmap   *s_image;          // the composite; NULL until first decode
static uint8_t   *s_rx_buf;         // malloc'd PNG accumulator, NULL when idle
static uint32_t   s_rx_total;       // 0 when idle
static uint32_t   s_rx_len;         // bytes written so far
static bool       s_decode_retry;   // the last decode failed; clears on success
static char       s_slot_bufs[NUM_SLOTS][32];
// pkjs's fetch time for the radar behind the frame on screen, not a decode
// time, since an unchanged composite is never re-sent. 0 = radar disabled.
static time_t     s_radar_time;

// ---- Weather (slots 15-31) -------------------------------------------------
// Finished strings from pkjs; the watch only copies them and compares
// `now - stamp`. Not persisted: pkjs replays its last payload on 'ready'.
#define WX_MAX_AGE (3 * 60 * 60)   // beyond this the link is genuinely stuck

static char   s_wx_cond[32], s_wx_fcst[32], s_wx_hilo[32];
static char   s_wx_alert[32], s_wx_alert2[32];
static char   s_wx_temp[32], s_wx_feels[32], s_wx_dew[32], s_wx_hum[32];
static char   s_wx_wind[32], s_wx_pres[32], s_wx_fcst2[32];
static time_t s_wx_time;                  // WX_TIME, for staleness
static time_t s_wx_exp, s_wx_exp2;        // per-slot alert expiry
// Sun events arrive as instants, not strings, because 12/24-hour is a watch
// setting the phone never sees. 0 = no such event (polar day or night).
static time_t s_wx_sunrise, s_wx_sunset;
static time_t s_wx_gold1, s_wx_gold2;     // golden hour span, start and end

// Display order. The historical wire names are mapped to it only in
// inbox_received_callback()'s key tables.
static uint8_t slot_kind(int i) {
  return s_settings.slots[i];
}

#define FONT_SUPER 5   // ladder index of Super Large
#define NUM_FONTS  6

// Auto: raw 5..9 and 11 only. An out-of-range byte (a newer encoding, or
// corruption) reads as fixed Extra Large via slot_font()'s clamp rather than
// as "auto, ceiling XL".
static bool slot_font_auto(int i) {
  uint8_t f = s_settings.fonts[i];
  return (f >= 5 && f <= 9) || f == 11;
}

// Ceiling as a ladder index. The band is reserved at the ceiling and only the
// glyphs shrink inside it, so the face never moves in response to content.
static uint8_t slot_font(int i) {
  uint8_t f = s_settings.fonts[i];
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
  // chalk's bezel leaves its outer lines a few characters at Medium and up.
  // Clamped here although its settings page stops at Small, because a config
  // saved for another watch can be replayed.
  if ((i == SLOT_TOP1 || i == SLOT_BOT2) && f > 1) {
    f = 1;   // Small; an auto line stays auto under the lower ceiling
  }
#endif
  return f;
}

// The size ladder, XS..XL then Super Large. FONT_H is the frame height;
// FONT_OFF lifts the frame so it straddles its anchor line (index 3 sits 1 px
// low). Super Large is Bitham 42 Bold, the largest system font with full Basic
// Latin on every platform: Roboto 49 is digits-only and LECO 60 is absent on
// basalt.
static const char *FONT_KEYS[NUM_FONTS] = {
  FONT_KEY_GOTHIC_14_BOLD, FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_24_BOLD,
  FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_BITHAM_30_BLACK, FONT_KEY_BITHAM_42_BOLD,
};
static const int8_t FONT_H[NUM_FONTS]   = { 18, 22, 28, 34, 36, 50 };
static const int8_t FONT_OFF[NUM_FONTS] = {  9, 11, 14, 16, 18, 25 };

// The inset TextLayer effectively leaves inside its frame, from screenshots.
#define TEXT_MARGIN 4

// Bands are fixed by apply_slot_layout() from the ceiling font, and a band's
// height is 0 exactly when its slot is None. Only glyph placement, and on a
// round display the frame width, follows the resolved font in s_resolved.
static int16_t s_band_y[NUM_SLOTS], s_band_h[NUM_SLOTS];
static uint8_t s_resolved[NUM_SLOTS];

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
// display, rounded down, whatever the obstruction. Centred, it never reaches a
// pixel outside the firmware's round mask (display_getafix.c) on chalk or
// gabbro.
static int16_t chord_w(int y) {
  int32_t d = 2 * y - (PBL_DISPLAY_HEIGHT - 1);
  int32_t v = (int32_t)PBL_DISPLAY_WIDTH * PBL_DISPLAY_WIDTH - d * d;
  return v > 0 ? (int16_t)isqrt32(v) : 0;
}
#endif

// Frame width of slot i in font f. On a round display it is the visible chord
// at f's ink row nearer the bezel, plus TEXT_MARGIN, so the box resolve_font()
// measures is the chord itself; otherwise, and for a None band, full width.
static int16_t slot_width(int i, uint8_t f) {
#if defined(PBL_ROUND)
  if (s_band_h[i] > 0) {
    // At f, not the ceiling, so a shrinking line gains width. The chord
    // narrows away from the centre row, so the narrowest row is an ink extreme.
    int16_t y = s_band_y[i] + (s_band_h[i] - FONT_H[f]) / 2;
    int16_t a = chord_w(y + FONT_INK_TOP[f]);
    int16_t c = chord_w(y + FONT_INK_BOT[f]);
    int16_t w = (a < c ? a : c) + TEXT_MARGIN;
    return w < PBL_DISPLAY_WIDTH ? w : PBL_DISPLAY_WIDTH;
  }
#endif
  return PBL_DISPLAY_WIDTH;
}

// Largest ladder step whose text fits the band on one line. Measured with
// WordWrap against a two-line box, testing height, which also catches a single
// word too long for the width: TrailingEllipsis reports the truncated size, so
// every font would fit. Needs no GContext, so update_slots() can call it
// outside a render pass.
static uint8_t resolve_font(int i, const char *s) {
  uint8_t max = slot_font(i);
  if (!slot_font_auto(i) || !s || !s[0]) {
    // An empty string resolves to the ceiling, so a line does not sit tiny and
    // then jump when its value arrives.
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

// Centre the resolved font vertically in its fixed band, which TextLayer
// cannot do itself. Never consults neighbouring slots, so a re-size cannot
// cascade.
static void place_slot(int i, uint8_t f) {
  int16_t h = s_band_h[i] ? FONT_H[f] : 0;
  int16_t w = slot_width(i, f);
  layer_set_frame(text_layer_get_layer(s_slot_layers[i]),
                  GRect((PBL_DISPLAY_WIDTH - w) / 2,
                        s_band_y[i] + (s_band_h[i] - h) / 2, w, h));
  text_layer_set_font(s_slot_layers[i], fonts_get_system_font(FONT_KEYS[f]));
}

// ==== Text slots ============================================================

// "--" when there is no data or the payload is older than WX_MAX_AGE. Takes
// `now`, like fmt_alert, so the alert cascade tests both against one instant.
static void fmt_wx(char *buf, size_t size, const char *src, time_t now) {
  if (!s_wx_time || now - s_wx_time > WX_MAX_AGE || src[0] == '\0') {
    snprintf(buf, size, "--");
  } else {
    snprintf(buf, size, "%s", src);
  }
}

// Empty when there is no alert or it has expired, so a lapsed warning clears
// even with the phone unreachable. Never "--": absence of an alert and of data
// render alike, and showing nothing is the honest failure.
static void fmt_alert(char *buf, size_t size, const char *src,
                      time_t exp, time_t now) {
  if (src[0] == '\0' || (exp && now > exp)) {
    buf[0] = '\0';
  } else {
    snprintf(buf, size, "%s", src);
  }
}

// An instant as a wall-clock time in the watch's own 12/24-hour style, with
// mer meridiem letters in 12-hour mode ("6:12", "6:12p", "6:12pm"). Strings
// built here get none of the phone's width machinery.
static void fmt_clock(char *buf, size_t size, time_t t, int mer) {
  // localtime() honours the time_t passed to it (pbl_override_localtime ->
  // sys_localtime_r in reference/PebbleOS/fw/applib/pbl_std/pbl_std.c),
  // but fills a shared app-state tm, so consume its fields before the next
  // call. fmt_span is the caller that has to care.
  struct tm *lt = localtime(&t);
  if (clock_is_24h_style()) {
    snprintf(buf, size, "%02d:%02d", lt->tm_hour, lt->tm_min);
  } else {
    // Built from tm fields: newlib's strftime has no %-I and its %p is
    // uppercase.
    int h12 = lt->tm_hour % 12;
    if (h12 == 0) h12 = 12;
    snprintf(buf, size, "%d:%02d%s%s", h12, lt->tm_min,
             mer ? (lt->tm_hour < 12 ? "a" : "p") : "", mer == 2 ? "m" : "");
  }
}

// A span end is shown while it is ahead, plus one refresh interval of grace:
// pkjs sends the next span only on a heartbeat, so without it the slot would
// blank between an end and that heartbeat. Past the grace the phone is
// unreachable and the value really is wrong.
static bool sun_showable(time_t t, time_t now) {
  return t != 0 && now - t <= (time_t)s_settings.refresh_min * 60;
}

static bool is_leap(int year) {
  return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

// True when the event is past tomorrow in local calendar terms, where a bare
// clock time would read as today. A calendar test, because lead times run
// continuously from 24 h to a week and any cutoff mislabels some; compared on
// local yday and year, because a local day is not 86,400 s across a DST
// change. Events are within a week, so only adjacent years arise.
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
    // Behind us across New Year: fmt_span passes the start of a window in
    // progress, which is now, not far. The catch-all would render "Dec 31".
    return false;
  } else {
    return true;               // more than a year out, which cannot be soon
  }
  return diff > 1;
}

// A pair of instants as a range, "7:48-8:31p", for both sun slots; the phone
// sends each span as a coherent pair. Keyed on the end, so a span in progress
// keeps rendering, which matches how the phone picks the span to send.
static void fmt_span(char *buf, size_t size, time_t a, time_t b, time_t now) {
  if (!a || !sun_showable(b, now)) {
    snprintf(buf, size, "--");
    return;
  }
  // A span days out shows its date, since a range cannot also say which day.
  if (sun_far(a, now)) {
    strftime(buf, size, "%b %d", localtime(&a));   // "Jan 23"
    return;
  }
  // Read both meridiems before building either string: localtime fills one
  // shared tm, so a second call overwrites the first one's answer.
  struct tm *lt = localtime(&a);
  bool pm_a = lt->tm_hour >= 12;
  lt = localtime(&b);
  bool pm_b = lt->tm_hour >= 12;
  char s1[12], s2[12];
  // One meridiem, on the end, when both ends share it; a span that straddles
  // noon gives each end its own.
  fmt_clock(s1, sizeof(s1), a, pm_a != pm_b);
  fmt_clock(s2, sizeof(s2), b, 1);
  snprintf(buf, size, "%s-%s", s1, s2);
}

// Format one slot's string into buf, with no TextLayer access, so
// update_slots() can re-measure only when the string changed. `super` is true
// when the line's ceiling is Super Large.
static void format_slot(uint8_t kind, bool super, char *buf, size_t size) {
  time_t now = time(NULL);
  // Never NULL: the firmware's localtime (pbl_override_localtime in
  // reference/PebbleOS/fw/applib/pbl_std/pbl_std.c) returns the app-state tm
  // unconditionally. Called per slot, not hoisted into update_slots(), because
  // the health service also writes that shared tm.
  struct tm *tick_time = localtime(&now);

  switch (kind) {
    case 0:  // Time
      // Super Large takes the sun slots' one-letter meridiem: "10:00pm" is
      // 177 px in Bitham 42 Bold against basalt's 140, "10:00p" is 139.
      fmt_clock(buf, size, now, super ? 1 : 2);
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
    case 15: fmt_wx(buf, size, s_wx_cond, now); break;   // Current Conditions
    case 16: fmt_wx(buf, size, s_wx_fcst, now); break;   // Today's Forecast
    case 17: fmt_wx(buf, size, s_wx_hilo, now); break;   // High / Low
    case 18:  // Active Alerts
      fmt_alert(buf, size, s_wx_alert, s_wx_exp, now);
      break;
    case 19:  // Alerts + Upcoming
      fmt_alert(buf, size, s_wx_alert2, s_wx_exp2, now);
      break;
    case 20:  // Alerts, else High / Low
    case 21:  // Alerts, else Conditions
    case 31:  // Alerts, else Upcoming, else Conditions
      // The alert is tested first, so a stale "--" never masks a live one, and
      // the cascade re-runs every update_slots(), which reverts an expired
      // alert with no message from the phone. WX_ALERT2 ranks every alert, so
      // once none is in effect it is the top upcoming one ("in 3h").
      fmt_alert(buf, size, s_wx_alert, s_wx_exp, now);
      if (kind == 31 && !buf[0]) {
        fmt_alert(buf, size, s_wx_alert2, s_wx_exp2, now);
      }
      if (!buf[0]) {
        fmt_wx(buf, size, kind == 20 ? s_wx_hilo : s_wx_cond, now);
      }
      break;
    case 22: fmt_wx(buf, size, s_wx_temp,  now); break;   // Temperature
    case 23: fmt_wx(buf, size, s_wx_feels, now); break;   // Feels Like
    case 24: fmt_wx(buf, size, s_wx_dew,   now); break;   // Dew Point
    case 25: fmt_wx(buf, size, s_wx_hum,   now); break;   // Humidity
    case 26: fmt_wx(buf, size, s_wx_wind,  now); break;   // Wind
    case 27: fmt_wx(buf, size, s_wx_pres,  now); break;   // Pressure
    case 28: fmt_wx(buf, size, s_wx_fcst2, now); break;   // Tonight/Tomorrow
    case 29:  // Sunrise / Sunset
      fmt_span(buf, size, s_wx_sunrise, s_wx_sunset, now);
      break;
    case 30:  // Golden Hour
      fmt_span(buf, size, s_wx_gold1, s_wx_gold2, now);
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
  for (int i = 0; i < NUM_SLOTS; i++) {
    char tmp[sizeof(s_slot_bufs[0])];
    // strftime returns 0 and leaves the buffer's contents unspecified when the
    // formatted result does not fit, so start every slot from an empty string.
    tmp[0] = '\0';
    format_slot(slot_kind(i), slot_font(i) == FONT_SUPER, tmp, sizeof(tmp));
    // Re-resolve only when the string changed; a fixed line never re-places.
    if (strcmp(tmp, s_slot_bufs[i]) != 0) {
      strcpy(s_slot_bufs[i], tmp);
      uint8_t f = resolve_font(i, s_slot_bufs[i]);
      if (f != s_resolved[i]) {
        s_resolved[i] = f;
        place_slot(i, f);   // the band is fixed; only the glyphs move
      }
      // Gated on purpose: text_layer_set_text() has no equality check
      // (PebbleOS fw/applib/ui/text_layer.c) and repaints the whole layer
      // tree, so an ungated call would make the config redraw flag and
      // connection_callback()'s layer_mark_dirty() dead code. The layers
      // already point at these buffers, so this call is only for the repaint.
      text_layer_set_text(s_slot_layers[i], s_slot_bufs[i]);
    }
  }
}

static void apply_slot_layout(void) {
  if (!s_slot_layers[0]) {
    return;   // config arrived before the window loaded
  }
  // Unobstructed, so Quick View cannot bisect the bottom slots.
  GRect b = layer_get_unobstructed_bounds(window_get_root_layer(s_main_window));

  uint8_t f[NUM_SLOTS];
  for (int i = 0; i < NUM_SLOTS; i++) {
    f[i] = slot_font(i);
  }

  // A None line claims no height. A line whose string is momentarily empty
  // keeps its full band, so the face does not jump.
  int h[NUM_SLOTS];
  for (int i = 0; i < NUM_SLOTS; i++) {
    h[i] = (slot_kind(i) == SLOT_NONE) ? 0 : FONT_H[f[i]];
  }

  // The inner pair sits on the 25%/75% lines and the outer pair stacks beyond
  // it. A round Quick View covers only rows below the centre, so the top half
  // anchors on the full display; on the unobstructed height the top lines
  // would rise to where the circle cuts them short.
  int top_h = PBL_IF_ROUND_ELSE(PBL_DISPLAY_HEIGHT, b.size.h);
  int inner_top = top_h / 4 - FONT_OFF[f[SLOT_TOP2]];
  int inner_bot = b.size.h * 3 / 4 - FONT_OFF[f[SLOT_BOT1]];

  // Where an outer band does not fit, the inner line moves inward: the quarter
  // lines are a preference, staying on screen is not. Only fonts, None slots
  // and obstruction trigger this, so the face never moves on content.
  if (inner_top < h[SLOT_TOP1]) {
    inner_top = h[SLOT_TOP1];
  }
  int bot_limit = b.size.h - h[SLOT_BOT1] - h[SLOT_BOT2];
  if (inner_bot > bot_limit) {
    inner_bot = bot_limit;
  }
  // Too short to seat every line: rather than let the inner pair collide, the
  // bottom lines stack below Top Line 2 and run off the bottom edge, Bottom
  // Line 2 first. Top Line 1 stays on screen, clamped above.
  if (inner_bot < inner_top + h[SLOT_TOP2]) {
    inner_bot = inner_top + h[SLOT_TOP2];
  }

  int y[NUM_SLOTS];
  y[SLOT_TOP1] = inner_top - h[SLOT_TOP1];
  y[SLOT_TOP2] = inner_top;
  y[SLOT_BOT1] = inner_bot;
  y[SLOT_BOT2] = inner_bot + h[SLOT_BOT1];

  // An outer line whose inner neighbour is None would slide inward to the
  // vacated anchor, so it centres in its edge quarter instead, clamped on
  // screen when Quick View shortens the quarter below the band.
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

  // Re-resolve against the current strings: a font or slot change can alter a
  // ceiling, and on a round display a band that moves changes width.
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

// ==== Image requests ========================================================

// Corruption guard, applied at every write and at load: a 0 would divide by
// zero in tick_handler. A non-divisor of 60 only ticks unevenly, so it passes.
static uint8_t sanitize_refresh(uint8_t m) {
  return (m == 0 || m > 60) ? 10 : m;
}

// The heartbeat, which also tells pkjs's transfer cache whether a frame is
// held: 2 = none (bypass the committed hash; bytes in flight or delivered this
// pass are still not re-sent), 1 = one (skip if unchanged). Never 0: pkjs
// gates on a truthiness test, so a 0 would silently stop the heartbeat.
static void request_images(bool need_image) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
    dict_write_uint8(iter, MESSAGE_KEY_REQUEST_IMAGES, need_image ? 2 : 1);
    app_message_outbox_send();
  }
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  update_slots();

  // Weather rides the same request. A transfer the watch refused is still
  // ACKed chunk by chunk, so pkjs commits its hash and re-offers those bytes
  // only when this flag says the watch has no frame.
  if (tick_time->tm_min % s_settings.refresh_min == 0) {
    request_images(!s_image);
  }
}

static void battery_callback(BatteryChargeState state) {
  update_slots();
}

static void connection_callback(bool connected) {
  update_slots();
  // update_slots() repaints only on a changed string, and the badge depends on
  // no slot.
  if (s_map_layer) {   // a state change can beat the window load
    layer_mark_dirty(s_map_layer);
  }
}

// ==== Persisted composite ===================================================

// The header key, written last and deleted first, so a write that dies
// partway reads as absent. Read all-or-nothing: a wrong version, size, length
// or checksum ignores the whole cache.
typedef struct {
  uint8_t  version;      // IMG_CACHE_VERSION at write time
  uint8_t  keys;         // data keys actually used
  uint32_t len;          // PNG bytes
  uint32_t sum;          // over those bytes
  int32_t  stamp;        // the RADAR_TIME that belonged to this frame
} ImgMeta;

// The header in flash, mirrored in RAM so that a resend of the cached frame,
// which every relaunch produces, costs a checksum rather than a rewrite. len 0
// means nothing cached matches the screen, and then no stamp may be written.
static ImgMeta s_saved;

// FNV-1a, so a torn cache is caught before it reaches the PNG decoder, which
// fails silently.
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

// Cache the PNG the frame on screen was decoded from. Called at the decode,
// the only point those bytes exist: a resident copy would cost heap.
static void save_image(const uint8_t *buf, uint32_t len) {
  if (!img_cache_available()) {
    return;
  }
  if (len == 0 || len > IMG_CACHE_MAX_BYTES) {
    // Too big to cache is not an error. Clearing the mirror keeps
    // save_image_stamp() from writing this frame's stamp onto the older one.
    s_saved.len = 0;
    return;
  }
  uint32_t sum = img_sum(buf, len);
  if (len == s_saved.len && sum == s_saved.sum) {
    return;   // already cached: every relaunch lands here
  }

  // Until the header is rewritten the cache reads as absent, the only safe
  // state mid-write.
  persist_delete(IMG_META_KEY);
  s_saved.len = 0;

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
  s_saved = m;
  APP_LOG(APP_LOG_LEVEL_INFO, "Cached composite (%d bytes, %d keys)",
          (int)len, k);
}

// RADAR_TIME arrives after the transfer it belongs to, so save_image() stored
// the previous frame's stamp. One header write corrects it, so a restored
// frame's Radar Age is honest from its first render.
static void save_image_stamp(void) {
  if (!img_cache_available() || !s_saved.len || !s_image ||
      (int32_t)s_radar_time == s_saved.stamp) {
    return;   // nothing cached, or nothing on screen it could describe
  }
  ImgMeta m = s_saved;
  m.stamp = (int32_t)s_radar_time;
  if (persist_write_data(IMG_META_KEY, &m, sizeof(m)) == (int)sizeof(m)) {
    s_saved = m;
  }
}

// Decode into s_image, which must be NULL, so one frame is resident at most.
// On a failed decode the firmware returns a zeroed GBitmap, not NULL
// (gbitmap_png.c gbitmap_create_from_png_data), so failure shows only as a
// NULL pixel buffer.
static void decode_frame(const uint8_t *png, uint32_t len) {
  s_image = gbitmap_create_from_png_data(png, len);
  if (s_image && !gbitmap_get_data(s_image)) {
    gbitmap_destroy(s_image);
    s_image = NULL;
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
  // The header handler's budget (see DECODE_HEADROOM). IMG_CACHE_MAX_BYTES
  // keeps a cached frame inside it, so this is a backstop.
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

  decode_frame(buf, m.len);
  free(buf);
  if (!s_image) {
    return false;
  }
  s_saved = m;
  // Adopt the frame's own stamp, so Radar Age describes these pixels from the
  // first render.
  s_radar_time = (time_t)m.stamp;
  APP_LOG(APP_LOG_LEVEL_INFO, "Restored composite (%d bytes), heap now %d",
          (int)m.len, (int)heap_bytes_free());
  return true;
}

// ==== AppMessage ============================================================

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

// An int32 tuple as a time_t, 0 when absent. pkjs marshals a plain JS number
// as a 4-byte int, and the union's smaller members are valid only for a
// smaller tuple.
static time_t tuple_time(DictionaryIterator *iter, uint32_t key) {
  Tuple *t = dict_find(iter, key);
  return t ? (time_t)t->value->int32 : 0;
}

// The image transfer: header, chunks in strict order, then decode. Called last
// from inbox_received_callback(), so its early returns skip nothing else.
static void rx_image(DictionaryIterator *iter) {
  // ---- Header block ----------------------------------------------------
  Tuple *total_t = dict_find(iter, MESSAGE_KEY_IMG_TOTAL);
  if (total_t) {
    rx_reset();   // one teardown point for the three receive-state fields
    s_rx_total = total_t->value->uint32;

    // Refuse up front: a decode that runs short faults the app or fails
    // silently, and by then the frame it replaces is gone. Nothing checks bit
    // depth, so a PNG deeper than the phone's 4bpp passes and can land in the
    // crash window. The resident frame is destroyed before the decode, so its
    // bytes count as available, or every refresh after the first is refused.
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
    // Destroy before decode, never decode-then-swap: the guard counted these
    // bytes as available. Nothing renders before the layer_mark_dirty below.
    if (s_image) {
      gbitmap_destroy(s_image);
      s_image = NULL;
    }

    decode_frame(s_rx_buf, s_rx_total);
    APP_LOG(APP_LOG_LEVEL_INFO, "Decoded composite (%d bytes), heap now %d",
            (int)s_rx_total, (int)heap_bytes_free());

    // Cache only what decoded, before rx_reset() frees the bytes.
    if (s_image) {
      save_image(s_rx_buf, s_rx_total);
    }

    rx_reset();   // after the log above, which reads s_rx_total

    // s_decode_retry allows one re-request per run of failures and gates
    // RADAR_TIME. It clears on success alone, and the heartbeat re-offers a
    // frame whenever s_image is NULL, so an undecodable image is retried every
    // refresh_min minutes, never in a tight loop.
    if (s_image) {
      s_decode_retry = false;
    } else {
      // Restore the last frame that did decode, whatever the flag: a second
      // consecutive failure destroys the restored frame too, so gating the
      // restore on the flag would blank the face for good.
      load_image();
      // Re-request either way: a restored frame is older than the one that
      // failed.
      if (!s_decode_retry) {
        APP_LOG(APP_LOG_LEVEL_ERROR, "Decode failed");
        s_decode_retry = true;
        // True, not !s_image: it must bypass the phone's hash cache, and
        // load_image() may just have filled s_image.
        request_images(true);
      }
    }

    // No slot string derives from the frame; Radar Age follows the
    // RADAR_TIME pkjs sends on the final chunk's ACK.
    if (s_map_layer) layer_mark_dirty(s_map_layer);
  }
}

static void inbox_received_callback(DictionaryIterator *iter, void *ctx) {
  // ---- Config block ----------------------------------------------------
  // The only decode of the historical wire names: TopSlot/TopFont are Top
  // Line 2 and BottomSlot/BottomFont Bottom Line 1, and renaming them resets
  // every saved phone-side config. Not static: MESSAGE_KEY_* are resolved at
  // load time, so they cannot initialize a static array.
  const uint32_t SLOT_KEYS[NUM_SLOTS] = {
    MESSAGE_KEY_TopSlot1, MESSAGE_KEY_TopSlot,
    MESSAGE_KEY_BottomSlot, MESSAGE_KEY_BottomSlot2
  };
  const uint32_t FONT_KEYS[NUM_SLOTS] = {
    MESSAGE_KEY_TopFont1, MESSAGE_KEY_TopFont,
    MESSAGE_KEY_BottomFont, MESSAGE_KEY_BottomFont2
  };
  Tuple *slot_t[NUM_SLOTS], *font_t[NUM_SLOTS];
  // One flag for slots and fonts: a slot switching to or from None moves the
  // stack just as a font change does.
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
    // Snapshot so the persist is skipped when nothing changed: pkjs re-sends
    // Lat/Lon every heartbeat. memcmp also spans padding, which nothing here
    // writes, so the comparison is exact.
    Settings prev;
    memcpy(&prev, &s_settings, sizeof(prev));

    // Set when what map_update_proc draws changes, even on an unchanged
    // re-save, and never by the heartbeat's Lat/Lon. TextColor needs none:
    // setting it dirties the text layers, and the render walk repaints the
    // whole tree on any dirty (reference/PebbleOS/fw/applib/ui/layer.c).
    bool redraw = false;

    for (int i = 0; i < NUM_SLOTS; i++) {
      if (slot_t[i]) s_settings.slots[i] = (uint8_t)slot_t[i]->value->int32;
      if (font_t[i]) s_settings.fonts[i] = (uint8_t)font_t[i]->value->int32;
    }
    // Zoom and RadarMode are phone-side and never reach the watch.
    if (lat_t)    s_settings.lat100      = lat_t->value->int32;
    if (lon_t)    s_settings.lon100      = lon_t->value->int32;
    // Colors arrive as 0xRRGGBB; GColorFromHEX is integer-only.
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
    // Takes effect on the next matching tick. No catch-up request: the save
    // that delivered it already made pkjs refetch.
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
    // Unconditional: the Lat/Long slot refreshes even when nothing was
    // persisted or redrawn.
    update_slots();
  }

  // ---- Size query --------------------------------------------------------
  // pkjs asks while it holds no saved config, so its settings page can show
  // this watch's sizes. The reply reuses the config's font keys. A busy outbox
  // drops it and nothing here retries: pkjs asks again.
  if (dict_find(iter, MESSAGE_KEY_REQUEST_FONTS)) {
    DictionaryIterator *out;
    if (app_message_outbox_begin(&out) == APP_MSG_OK) {
      for (int i = 0; i < NUM_SLOTS; i++) {
        dict_write_uint8(out, FONT_KEYS[i], s_settings.fonts[i]);
      }
      app_message_outbox_send();
    }
  }

  // ---- Weather block -----------------------------------------------------
  // WX_TIME is the phone's fetch time: pkjs replays its last payload on
  // 'ready', so receipt-stamping would relabel hour-old data as fresh. Weather
  // never changes slot geometry.
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
    // An absent sun key assigns 0 rather than skipping, because 0 is
    // meaningful here (no such event at this latitude today).
    s_wx_sunrise = tuple_time(iter, MESSAGE_KEY_WX_SUNRISE);
    s_wx_sunset  = tuple_time(iter, MESSAGE_KEY_WX_SUNSET);
    s_wx_gold1   = tuple_time(iter, MESSAGE_KEY_WX_GOLD1);
    s_wx_gold2   = tuple_time(iter, MESSAGE_KEY_WX_GOLD2);
    s_wx_time = (time_t)wx_time_t->value->uint32;
    update_slots();
  }

  // ---- Radar timestamp ---------------------------------------------------
  // Sent explicitly because a composite pkjs skips as unchanged is never
  // decoded here, and only at the phone's commit, so a transfer that dies
  // halfway advances nothing. Not a setting, so it stays out of the persisted
  // blob. Read as int32, as in tuple_time(); Unix seconds fit until 2038.
  // Ignored while the last decode has failed: it dates bytes that never
  // reached the screen, and a frame load_image() restored keeps its own stamp.
  Tuple *rt_t = dict_find(iter, MESSAGE_KEY_RADAR_TIME);
  if (rt_t && !s_decode_retry) {
    s_radar_time = (time_t)rt_t->value->int32;
    update_slots();
    save_image_stamp();   // keep the cached frame's age honest across relaunches
  }

  rx_image(iter);
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", (int)reason);
  // A dropped message breaks the offset chain, but pkjs still completes and
  // commits the transfer. Request with true, not !s_image: the previous frame
  // is usually still resident, so !s_image would let the phone's cache skip
  // an image never assembled. Pairs with the phone clearing tx_hash on abort.
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

// ==== Drawing ===============================================================

// ---- Bluetooth badge -------------------------------------------------------
// Drawn from line segments: the firmware's Bluetooth bitmaps are out of an
// app's reach (gbitmap_create_with_resource_system() is not exported), and a
// bundled PNG would be malloc'd from the heap the decode guard rations. Fixed
// pixel sizes, so it reads the same on every platform.
#define BT_HALF   6    // half-width of the rune's flags
#define BT_HEIGHT 20   // top vertex to bottom vertex
#define BT_INSET  3    // whole badge, slash overhang included, from the edge
// Odd values only: the firmware draws an even width 1 px thicker
// (prv_adjust_stroked_line_width() in graphics_line.c), whatever gcontext.h
// says. 1/3 is the only legible pair at this size: a 3 px glyph in a 5 px
// halo merges the flags into a blob.
#define BT_STROKE 1    // glyph; halo draws at BT_STROKE + 2 -> 1 px each side
// A thicker rune is built from 1 px copies offset in x, a 2 px width the API
// cannot express; x because no stroke in the rune is horizontal. The last copy
// ends at the slash's right edge, so a third would widen the badge.
#define BT_RUNE_COPIES 2   // 1 = single stroke; 2 = effective 2 px
// The slash runs markedly steeper than 45 degrees, or it lands parallel to two
// flags and reads as a fifth, and overhangs both vertices, or it reads as part
// of the glyph. Bottom-left to top-right crosses the stem where the rune has
// no detail of its own.
#define BT_SLASH_HALF 7   // half-width; > BT_HALF, so it sets the badge width
#define BT_SLASH_OVER 2   // overhang past the rune's top and bottom vertices
// Rows the slash spans, the badge's tallest part; its halo adds one each side.
#define BT_BOX_H (BT_HEIGHT + 2 * BT_SLASH_OVER + 1)
// Red whatever TextColor is, over an OutlineColor halo: a fault indicator the
// user can recolor into the background is worse than no setting. A b/w
// platform would draw it black like the rune, so revisit it there.
#define BT_SLASH_COLOR GColorRed

// Halo pass, then glyph pass: an outline segment drawn after a glyph segment
// would paint over it at a crossing. The slash repeats both passes over the
// finished rune, so its halo cuts a 1 px gap either side; as a seventh
// polyline point its glyph stroke would vanish into the rune's.
static void draw_bt_badge(GContext *ctx, GRect bounds) {
  // p is the rune as one open polyline whose first and last segments cross
  // the stem to form the X; s is the slash. Both derive from one origin, or an
  // inset change would drift them apart, and BT_INSET is measured from the
  // slash, the badge's widest and tallest part.
  int16_t left = bounds.origin.x + BT_INSET;
  int16_t top  = bounds.origin.y + BT_INSET;
#if defined(PBL_ROUND)
  // No corner on a round display, so the badge sits at 9 o'clock, clear of
  // the text bands at default sizes, BT_INSET from the bezel at the halo's
  // outermost rows.
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

  // The only bitmap draw, at the default GCompOpAssign the context enters
  // every update proc with. A bitmap draw added later must restore any
  // compositing mode it sets.
  if (s_image) {
    graphics_draw_bitmap_in_rect(ctx, s_image, bounds);
  } else {
    graphics_context_set_fill_color(ctx, GColorLightGray);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  }

  // Center marker: white ring, red dot.
  GPoint c = grect_center_point(&bounds);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_circle(ctx, c, 4);
  graphics_context_set_fill_color(ctx, GColorRed);
  graphics_fill_circle(ctx, c, 2);

  // The badge shows only while the phone is unreachable. Peeked, not cached:
  // connection_callback() dirties this layer. Drawn before the text pass, so
  // an overlapping line wins the spot.
  if (s_settings.bt_badge && !connection_service_peek_pebble_app_connection()) {
    draw_bt_badge(ctx, bounds);
  }

  // Text halo: each occupied line drawn 8 times at ±1 px in the outline color,
  // under the TextLayers, which are added after this layer and draw the
  // glyphs. It reads each TextLayer's own frame and buffer, so it cannot
  // disagree with place_slot(), and needs no sync hook: the render walk
  // repaints the whole layer tree on any dirty
  // (reference/PebbleOS/fw/applib/ui/layer.c). This layer fills the window, so
  // a frame is also a draw box.
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

// ==== Window handlers =======================================================

static void main_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_map_layer = layer_create(bounds);            // added first, so drawn first
  layer_set_update_proc(s_map_layer, map_update_proc);
  layer_add_child(window_layer, s_map_layer);

  // A throwaway frame: apply_slot_layout() below sets the real ones.
  for (int i = 0; i < NUM_SLOTS; i++) {
    s_slot_layers[i] = text_layer_create(GRect(0, 0, bounds.size.w, 0));
    text_layer_set_background_color(s_slot_layers[i], GColorClear);
    text_layer_set_text_alignment(s_slot_layers[i], GTextAlignmentCenter);
    text_layer_set_text_color(s_slot_layers[i],
                              (GColor){ .argb = s_settings.text_argb });
    // Bound once, here: update_slots() sets text only on a change, and
    // main_window_unload() keeps s_slot_bufs, so an unchanged slot would stay
    // blank after a window reload. Before layer_add_child, so it costs no
    // render.
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

// ==== Application lifecycle =================================================

static void load_settings(void) {
  s_settings = (Settings){
    .version      = SETTINGS_VERSION,
    // Display order: Time over Date, outer lines None.
    .slots        = { SLOT_NONE, 0, 1, SLOT_NONE },
    // Medium (Gothic 24 Bold), Extra Large (Bitham 30 Black),
    // Large (Gothic 28 Bold), Medium.
    .fonts        = { 2, 4, 3, 2 },
    .text_argb    = GColorBlackARGB8,
    .outline_argb = GColorWhiteARGB8,
    .refresh_min  = 10,
    .bt_badge     = 1,
  };

  // Read into a scratch copy so a rejected blob cannot leave the live settings
  // half-overwritten.
  Settings stored;
  int read = persist_read_data(SETTINGS_KEY, &stored, sizeof(stored));
  if (read == (int)sizeof(Settings) && stored.version == SETTINGS_VERSION) {
    s_settings = stored;
  } else {
    // First run: the system Text Size picks the sizes, once. The write makes
    // the choice final, because every later launch loads this blob, so a
    // Text Size change afterwards never resizes the face.
    PreferredContentSize size = preferred_content_size();
    if (size > CONTENT_SIZE_DEFAULT) {
      memcpy(s_settings.fonts, LARGER_FONTS, sizeof(LARGER_FONTS));
    }
    persist_write_data(SETTINGS_KEY, &s_settings, sizeof(s_settings));
    APP_LOG(APP_LOG_LEVEL_INFO, "First run, text size %d", (int)size);
  }

  // A versioned blob can still be corrupt (see sanitize_refresh()).
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

  // Outbox: REQUEST_IMAGES (9 B) or the four-size reply (33 B).
  app_message_open(app_message_inbox_size_maximum(), 64);

  // After app_message_open(), so the permanent inbox is already claimed: a
  // decode that fitted only without it would leave AppMessage dead. Nothing
  // has rendered yet, since the render walk runs from the event loop, so the
  // first frame painted carries the map.
  if (load_image()) {
    update_slots();   // Radar Age adopts the restored frame's own stamp
  }

  // No launch request: pkjs's 'ready' handler fetches and forces a transfer
  // past its hash cache, so asking here would only duplicate it.
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

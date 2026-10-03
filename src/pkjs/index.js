/**
 * NOAA US Weather Radar: PebbleKit JS
 *
 * Fetches a USGS Topo basemap and the NOAA MRMS reflectivity overlay at the
 * watch's display size, blends them into one 4bpp PNG (composite.js) so the
 * watch holds a single frame, and streams it in AppMessage chunks unless a
 * content hash shows the watch already has those bytes. Also assembles the
 * weather payload and pushes severe-alert timeline pins. All floating point
 * lives here; the watch only sees bytes and integers.
 */

var Clay = require('@rebble/clay');
// PNG codec for the fetched layers. Each 256-color layer is re-quantized to
// 16 colors (shrinkPng) before the blend: blending the originals gives more
// output colors, no byte saving and a muddy result.
var UPNG = require('upng-js');
// The blend, the palette fold and the 4bpp PNG encoder. Kept in its own
// module so it stays pure arithmetic over typed arrays (no Pebble APIs, no
// localStorage) and can be exercised offline against frozen source imagery.
var composite = require('./composite');
// Severe-alert filtering, pin ids, pin JSON and dedupe bookkeeping. Kept pure
// (no Pebble APIs, no localStorage, no module state) so a node harness can
// exercise it offline. Webpack bundles only this file's require graph, so a
// src/pkjs/*.js not required here compiles to nothing.
var timeline = require('./timeline');
// Sunrise/sunset/golden-hour math for the sun slots. Pinned to 1.x (^1.9.0):
// 2.x's CommonJS build is ES6 (const, destructuring), which the legacy pkjs
// runtime cannot parse. Everything else in this file is ES5 for the same
// reason.
var SunCalc = require('suncalc');
var clayConfig = require('./config');
// Config-page logic (show/hide the manual-location input, block an invalid
// save, fit chalk's outer size dropdowns). Injected into the page by
// toString(), so it shares no scope with this file.
var customClay = require('./custom-clay');
// Initialize Clay (autoHandleEvents off: we persist locally and re-fetch)
var clay = new Clay(clayConfig, customClay, { autoHandleEvents: false });

var BASEMAP_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/export';
var RADAR_URL = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer/export';

var ZOOM_WIDTHS = [100000, 250000, 500000];   // City, State, Region (meters)

// Both layers are requested at exactly the display's size: the composite
// fills the watch's full bounds, and the firmware tiles or crops a mismatched
// bitmap rather than scaling it. Defaults are emery's; 'ready' narrows them
// to the watch actually connected.
// One row per targetPlatforms entry in package.json, and adding a platform
// means adding both: a row for a platform the watch's heap guard would refuse
// is worse than none. A round platform also needs a ROUND_PLATFORMS row.
var PLATFORM_SIZES = {
  basalt:  [144, 168],
  emery:   [200, 228],
  gabbro:  [260, 260],
  chalk:   [180, 180]
};
var IMG_W = 200;
var IMG_H = 228;
// The connected watch's ROUND_PLATFORMS row, or null for a rectangular or
// unknown watch. 'ready' sets it with IMG_W/IMG_H.
var WATCH_ROUND = null;

var FALLBACK_LAT = 40.69;                     // Statue of Liberty
var FALLBACK_LON = -74.04;

// "lat, lon" (comma or space separated) in decimal degrees -> {lat, lon},
// or null. Must stay in sync with parseLoc() in custom-clay.js, which cannot
// share this function: Clay injects it into the config page by toString().
function parseManualLoc(s) {
  var m = /^\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)\s*$/
            .exec(String(s || ''));
  if (!m) return null;
  var lat = parseFloat(m[1]);
  var lon = parseFloat(m[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: lat, lon: lon };
}

// The phone-side enum settings' defaults, read by numSetting() and compared
// against by webviewclosed, so a Save that leaves one at its default is no
// change. Each must equal its item's defaultValue in config.js. Each name is
// both a Clay messageKey and a localStorage key: renaming one, or renumbering
// its values, changes every saved choice.
var SETTING_DEFAULTS = { Zoom: 1, RadarMode: 1, WxUnits: 0, TimelineAlerts: 1 };

// A bounded-enum setting from localStorage, with the default branched
// explicitly rather than clamped into: the keys are null until the first Save,
// and Number(null) is 0, so a plain clamp would read a fresh install as the
// enum's zero value. '' (a cleared key), NaN and out-of-range values fall back
// too, so a corrupt value can never leave the domain.
function numSetting(key, lo, hi) {
  var def = SETTING_DEFAULTS[key];
  var raw = localStorage.getItem(key);
  var v = (raw === null || raw === '') ? def : Number(raw);
  if (isNaN(v) || v < lo || v > hi) v = def;
  return v;
}

// Stores a phone-side setting's string and returns true when it differs from
// the stored one, an absent or '' value reading as def.
function storeSetting(key, val, def) {
  var changed = val !== (localStorage.getItem(key) || String(def));
  localStorage.setItem(key, val);
  return changed;
}

// 0 Disabled, 1 Translucent, 2 Opaque.
function radarMode() {
  return numSetting('RadarMode', 0, 2);
}

// Push NWS severe alerts into the timeline as pins. On by default only
// through numSetting's explicit default branch.
function timelineAlerts() {
  return numSetting('TimelineAlerts', 0, 1) === 1;
}

// The parsed tl_pins map, the timeline's counterpart of tx_hash. It needs no
// pendingHash-style companion only because insertTimelinePin is synchronous:
// each commit lands before a duplicated heartbeat can plan again, and an
// asynchronous delivery route would need that record back.
var tlState = null;

// Swallows a quota throw, as writeWx does: this cache shares localStorage with
// two base64 PNGs, and a throw must never escape into the alert path.
function tlSaveState() {
  try { localStorage.setItem('tl_pins', JSON.stringify(tlState)); }
  catch (e) { console.log('TL state write failed: ' + e); }
}

// Local pins through Pebble.insertTimelinePin() only, with no timeline web API
// fallback: a runtime without it gets no pins.

// Pushes what the alert list implies, or with `features` null (a failed fetch)
// renews multi-day pins from tl_pins. fetchAlerts calls it only with the
// setting on and after done(), so it cannot stall or alter the weather message.
function pushTimelinePins(features) {
  var nowSec = Math.floor(Date.now() / 1000);
  // The local midnight a multi-day pin's start steps to, read
  // DAY_ROLL_SLACK_SEC ahead so a beat just short of midnight takes that day.
  var day = new Date((nowSec + timeline.DAY_ROLL_SLACK_SEC) * 1000);
  day.setHours(0, 0, 0, 0);
  var dayStartSec = Math.floor(day.getTime() / 1000);
  var st = tlState || readWx('tl_pins');
  var plan = features ? timeline.planPins(features, st, nowSec, dayStartSec)
                      : timeline.renewPins(st, nowSec, dayStartSec);
  tlState = plan.state;
  // A renewal changes no state, so it writes only below, if it had pins to
  // insert.
  if (features) tlSaveState();

  // The only sign of a Severe feature planPins dropped for want of a VTEC key;
  // if it is ever non-zero in the field, revisit that rather than add an
  // unstable fallback id. Counted here so planPins keeps its two-field result.
  var noVtec = 0, tracked = 0, i, k;
  for (i = 0; features && i < features.length; i++) {
    var pr = features[i] && features[i].properties;
    if (timeline.isSevere(pr) && !timeline.pinIdFor(pr, nowSec)) noVtec++;
  }
  // Not tlState.hasOwnProperty(k): a stored key of that name would shadow the
  // method, and the call would throw.
  for (k in tlState) {
    if (Object.prototype.hasOwnProperty.call(tlState, k)) tracked++;
  }
  // Logged on every fetch, zero included: in clear weather it is the only
  // evidence the feature runs at all.
  console.log('TL ' + plan.puts.length + ' pin(s) to ' +
              (features ? 'push' : 'renew') + ', ' + tracked + ' tracked' +
              (noVtec ? ', ' + noVtec + ' skipped with no VTEC key' : ''));

  if (!plan.puts.length) return;
  if (typeof Pebble.insertTimelinePin !== 'function') {
    // Reached only with something to push, so this line's absence proves
    // nothing about the runtime.
    console.log('TL insertTimelinePin unavailable on this runtime; no pins');
    return;
  }
  // Per pin, so one pin the runtime dislikes cannot stop the rest of the plan
  // or undo a commit already made.
  plan.puts.forEach(function (p) {
    try {
      Pebble.insertTimelinePin(p.pin);
      // The insert reports nothing, so a commit means only "did not throw";
      // never committing would re-insert every tracked pin forever.
      timeline.commitPin(tlState, p.id, p.sig);
      console.log('TL pin ' + p.id + ' pushed, ' + p.pin.time + ' +' +
                  p.pin.duration + 'm');
    } catch (e) { console.log('TL push failed: ' + e); }
  });
  // Once, after the loop: a pin that threw has no commit, so the next
  // heartbeat retries it.
  tlSaveState();
}

// ---------------------------------------------------------------------------
// Transfer state machine
// ---------------------------------------------------------------------------

var CHUNK = 4096;      // the inbox is 8200 B on all four platforms; the
                       // header tuples add ~50 B
// The single-slot serialiser carries two kinds of work, dispatched on `kind`:
//   {kind: 'img', bytes, hash, radarTime, key | replay}: a chunked composite
//   {kind: 'msg', dict: {...}}: one whole AppMessage
// The chunked protocol depends on strictly ordered ACKs, and firing an
// unrelated sendAppMessage mid-transfer risks a NACK on the chunk in flight,
// so every other AppMessage (settings, weather, Lat/Lon, RADAR_TIME, the size
// query) must go through this same queue as a msg item.
var tx = null;         // current item (+ offset/retries while sending)
var queue = [];        // pending items, in the order the work became ready
var gen = 0;           // bumped when the bbox moves; stale fetches drop out
// Hash of the composite currently queued or in flight. In memory only, and
// distinct from the committed tx_hash: QEMU delivers each REQUEST_IMAGES up to
// three times, and without this all three identical composites would enqueue
// before the first one commits.
var pendingHash = null;

function enqueue(item) {
  queue.push(item);
  pump();
}

function pump() {
  if (tx) return;
  if (queue.length === 0) return;
  tx = queue.shift();
  tx.retries = 0;
  tx.offset = 0;       // img: the chunk cursor; unused by msg items
  send(tx);
}

// The dict for this item's next dispatch: a msg item's whole payload, or an
// img item's chunk at t.offset.
function dictFor(t) {
  if (t.kind === 'msg') return t.dict;
  var end = Math.min(t.offset + CHUNK, t.bytes.length);
  var d = {
    'IMG_OFFSET': t.offset,
    // Must be a plain Array of numbers: a raw Uint8Array is not reliably
    // marshalled as a byte array by PebbleKit JS.
    'IMG_DATA': Array.prototype.slice.call(t.bytes.subarray(t.offset, end))
  };
  if (t.offset === 0) {
    // The header opens the transfer; later chunks route off it.
    d['IMG_TOTAL'] = t.bytes.length;
  }
  return d;
}

// Both kinds share one send/ACK/NACK policy: the t !== tx guard, 3 retries at
// 500 ms, and clearing tx on completion so the next item pumps.
// Every callback carries the item it belongs to. An ACK that arrives after
// resetTransfers() has moved on must not advance the transfer that replaced it,
// or two send chains run at once and the watch drops every out-of-order chunk.
function send(t) {
  if (t !== tx) return;
  Pebble.sendAppMessage(dictFor(t),
                        function () { onAck(t); },
                        function () { onNack(t); });
}

function onAck(t) {
  if (t !== tx) return;
  t.retries = 0;                  // per chunk, not per transfer
  // A msg item is done at its first ACK and has no .bytes to test, so this
  // must come first.
  if (t.kind !== 'msg') {
    t.offset += CHUNK;
    if (t.offset < t.bytes.length) {
      send(t);
      return;
    }
  }
  tx = null;
  // The final chunk's ACK is the commit point, and it comes after tx is
  // cleared: the enqueue below pumps, and a still-set tx would make that pump
  // a no-op and strand the RADAR_TIME message.
  if (t.kind === 'img') {
    // Only here, never at enqueue time: a transfer that dies halfway must not
    // poison the cache into skipping forever.
    try { localStorage.setItem('tx_hash', t.hash); } catch (e) {}
    // The bytes too, for replayComposite. One key holds bbox, hash, stamp and
    // bytes, because a replay is correct only if all four agree; a quota throw
    // leaves the previous blob intact. t.key is the bbox this composite was
    // built for, never bm_key, which a failed basemap write leaves naming the
    // previous place.
    if (!t.replay) {
      try {
        localStorage.setItem('tx_replay', JSON.stringify({
          k: t.key,
          h: t.hash,
          t: t.radarTime,
          d: b64encode(t.bytes)
        }));
      } catch (e) {
        console.log('Replay cache write failed: ' + e);
      }
    }
    if (pendingHash === t.hash) pendingHash = null;
    enqueue({ kind: 'msg', dict: { 'RADAR_TIME': t.radarTime } });
  }
  pump();
}

function onNack(t) {
  if (t !== tx) return;
  t.retries++;
  if (t.retries <= 3) {
    setTimeout(function () { send(t); }, 500);   // a chunk retries at the same offset
  } else {
    console.log('Giving up on ' + (t.kind === 'msg' ? 'message' : 'image'));
    // The watch's resident image is whatever it was: it destroys the old
    // bitmap only when a transfer finalizes. But we no longer know that it
    // matches tx_hash, so the cache has to forget.
    if (t.kind === 'img') clearTxHash();
    tx = null;
    pump();
  }
}

// Drop every queued and in-flight image: a composite mid-transfer is
// superseded by the one this pass is about to build. newArea (the bbox moved)
// also bumps gen so fetches for the old area drop out. msg items are never
// dropped, since losing a weather payload would silently lose an alert
// update. The t !== tx guards in the send path make abandoning the in-flight
// item safe.
function resetTransfers(newArea) {
  if (newArea) gen++;
  var dropped = false;
  queue = queue.filter(function (q) {
    if (q.kind === 'img') { dropped = true; return false; }
    return true;
  });
  if (tx && tx.kind === 'img') { tx = null; dropped = true; }
  // Clear the cache only when the watch's resident image actually became
  // indeterminate. This runs on every heartbeat, and an unconditional clear
  // would mean the cache never skips anything.
  if (dropped || newArea) clearTxHash();
}

// Forget which composite the watch is believed to hold, so the next one is
// sent unconditionally.
function clearTxHash() {
  pendingHash = null;
  try { localStorage.removeItem('tx_hash'); } catch (e) {}
  // tx_replay is deliberately kept. tx_hash means "the watch is displaying
  // these bytes", which is what became unknown; tx_replay means "the last
  // composite we know landed, for bbox k", which is still true, and its key
  // gate is what makes replaying it safe.
}

// Fill a watch that has no frame from the last composite we delivered, instead
// of leaving it grey for the whole fetch -> blend -> transfer round trip that
// the caller is about to start. The location fix runs before this, so its
// latency (up to the 15 s getCurrentPosition timeout) is still grey. The real
// pass runs behind this and either hashes equal (and is skipped) or
// supersedes this frame.
//
// Two rules keep it honest. It replays only a composite built for this bbox:
// a move or a zoom change finds no match and the face stays grey rather than
// showing the wrong place. And it re-sends the stored radar stamp, never
// `now`, so the Radar Age slot dates the pixels on screen.
function replayComposite(key) {
  var r = readWx('tx_replay');
  if (!r || r.k !== key) return;
  var bytes = b64decode(r.d);
  console.log('Replaying last composite, ' + bytes.length + ' B, hash ' + r.h);
  pendingHash = r.h;
  // The blob on disk already holds these bytes, so this item's ACK must not
  // rewrite it.
  enqueue({ kind: 'img', bytes: bytes, hash: r.h, radarTime: r.t, replay: true });
}

// ---------------------------------------------------------------------------
// Base64 helpers (localStorage stores strings only)
// ---------------------------------------------------------------------------

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(bytes) {
  var out = '';
  var i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  var rem = bytes.length - i;
  if (rem === 1) {
    out += B64[bytes[i] >> 2] + B64[(bytes[i] << 4) & 63] + '==';
  } else if (rem === 2) {
    out += B64[bytes[i] >> 2] +
           B64[((bytes[i] << 4) | (bytes[i + 1] >> 4)) & 63] +
           B64[(bytes[i + 1] << 2) & 63] + '=';
  }
  return out;
}

function b64decode(str) {
  var clean = str.replace(/=+$/, '');
  var len = (clean.length * 3) >> 2;
  var bytes = new Uint8Array(len);
  var acc = 0, bits = 0, p = 0;
  for (var i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[p++] = (acc >> bits) & 0xFF;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

// Quantize a fetched layer to 16 colors; see the UPNG require for why both
// blend inputs need it. The basemap cache stores this output.
function shrinkPng(bytes) {
  var img = UPNG.decode(bytes.buffer);
  var rgba = UPNG.toRGBA8(img)[0];
  return new Uint8Array(UPNG.encode([rgba], img.width, img.height, 16));
}

// PNG bytes -> RGBA. UPNG.toRGBA8(img)[0] is an ArrayBuffer, not a typed
// array, so the wrapper is required.
function rgbaOf(bytes) {
  var img = UPNG.decode(bytes.buffer);
  return new Uint8Array(UPNG.toRGBA8(img)[0]);
}

// cb(bytes) on success, cb(null) on any failure. Both layers join before the
// blend, so every path must call back: a join waiting on a callback that
// never fires just leaks.
function fetchPng(url, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.responseType = 'arraybuffer';
  xhr.timeout = 20000;
  xhr.onload = function () {
    // Read xhr.response exactly once. The pkjs bridge hands back a real
    // ArrayBuffer only on the first read of the property; every later read
    // yields a wrapper that still reports .byteLength but that no typed array
    // can consume, so `new Uint8Array(...)` would silently come back empty.
    var buf = xhr.response;
    if (xhr.status !== 200 || !buf) {
      console.log('Fetch failed (' + xhr.status + '): ' + url);
      cb(null);
      return;
    }
    var b = new Uint8Array(buf);
    // ArcGIS answers a bad bbox or a service outage with HTTP 200 and a JSON
    // error document, which must never reach the decoder.
    if (b.length < 8 || b[0] !== 0x89 || b[1] !== 0x50 ||
        b[2] !== 0x4E || b[3] !== 0x47) {
      console.log('Not a PNG (' + b.length + ' bytes): ' + url);
      cb(null);
      return;
    }
    try {
      b = shrinkPng(b);
    } catch (e) {
      // No send-as-is fallback: blending a 256-color input is the muddy case
      // the quantize step exists to prevent. Skip the update instead.
      console.log('Transcode failed, skipping update: ' + e);
      cb(null);
      return;
    }
    cb(b);
  };
  xhr.onerror = function () {
    console.log('Fetch error: ' + url);
    cb(null);
  };
  xhr.ontimeout = function () {
    console.log('Fetch timeout: ' + url);
    cb(null);
  };
  xhr.send();
}

function exportUrl(base, bbox, transparent) {
  return base +
    '?bbox=' + bbox +
    '&bboxSR=3857&imageSR=3857&size=' + IMG_W + ',' + IMG_H + '&format=png8' +
    '&transparent=' + (transparent ? 'true' : 'false') +
    '&f=image';
}

// ---------------------------------------------------------------------------
// Weather (slots 15-31): the NWS JSON API at api.weather.gov, no key.
// 15-28 and 31 are fetched; 29-30 (sun times) are computed here from the
// location. Every string is assembled, unit-converted, abbreviated and
// width-fitted here. The watch receives finished strings, two alert expiries,
// the fetch time, and four sun instants that it formats itself.
// ---------------------------------------------------------------------------

var WX_BASE = 'https://api.weather.gov';

// Which WX_* string each weather slot code displays: the one place a weather
// slot is registered. WX_SLOTS, the per-string width budgets and the
// per-resource fetch gates all derive from it, because a hand-synced code
// list drifts silently.
var WX_SLOT_STRINGS = {
  15: ['cond'],   16: ['fcst'],           17: ['hilo'],
  18: ['alert'],  19: ['alert2'],
  20: ['alert', 'hilo'],                  // alert, else high/low
  21: ['alert', 'cond'],                  // alert, else current conditions
  31: ['alert', 'alert2', 'cond'],        // alert, else upcoming, else conditions
  22: ['temp'],   23: ['feels'],          24: ['dew'],
  25: ['hum'],    26: ['wind'],           27: ['pres'],
  28: ['fcst2'],                          // the second forecast period
  // Sun times travel as epoch seconds for the watch to format, since
  // 12/24-hour never leaves the watch, but are registered here so WX_SLOTS
  // and slotsFrom('sun') include them.
  29: ['daylight'], 30: ['gold']
};

// Which resource feeds each string. 'sun' is computed rather than fetched,
// but slotsFrom('sun') gates the computation. A string missing from this
// table is silently never fetched or computed.
var WX_STRING_SOURCE = {
  cond: 'obs', fcst: 'fcst', hilo: 'fcst', alert: 'alerts', alert2: 'alerts',
  temp: 'obs', feels: 'obs', dew: 'obs', hum: 'obs', wind: 'obs', pres: 'obs',
  fcst2: 'fcst',
  daylight: 'sun', gold: 'sun'
};

// for-in rather than Object.keys: nothing else in this file relies on ES5
// object statics, and a missing one here would take the whole weather feature
// down silently. Integer-like keys enumerate in ascending numeric order.
var WX_SLOTS = [];
for (var wxCode in WX_SLOT_STRINGS) WX_SLOTS.push(Number(wxCode));

// Slot codes that display `str`.
function slotsShowing(str) {
  return WX_SLOTS.filter(function (c) {
    return WX_SLOT_STRINGS[c].indexOf(str) >= 0;
  });
}

// Slot codes that display any string fed by resource `src`.
function slotsFrom(src) {
  return WX_SLOTS.filter(function (c) {
    return WX_SLOT_STRINGS[c].some(function (s) {
      return WX_STRING_SOURCE[s] === src;
    });
  });
}

var lastLat = null;   // last rounded fix, for a units-change refetch
var lastLon = null;

// The [slot, font] messageKeys of the four lines, in display order.
// TopSlot/TopFont drive Top Line 2 and BottomSlot/BottomFont Bottom Line 1:
// the names are historical, and renaming a messageKey resets every saved
// config.
var LINE_KEYS = [['TopSlot1', 'TopFont1'], ['TopSlot', 'TopFont'],
                 ['BottomSlot', 'BottomFont'], ['BottomSlot2', 'BottomFont2']];

// [slotCode, fontCode] for each line in display order, from the persisted
// cfg2 blob; budgetFor() reads the index as the line's position. No blob, or
// an unparsable one, reads as no lines configured rather than throwing out of
// 'ready'.
function wxLines() {
  var d = readWx('cfg2');
  return d ? LINE_KEYS.map(function (k) { return [d[k[0]], d[k[1]]]; }) : [];
}

// True when any configured line displays one of these slot codes.
function wxUses(codes) {
  return wxLines().some(function (l) { return codes.indexOf(l[0]) >= 0; });
}

// True when any configured line displays a string fed by resource `src`.
function wxWants(src) {
  return wxUses(slotsFrom(src));
}

// True when a weather slot is actually configured. pkjs sends the watch nothing
// weather-related unless this holds, but it is not the whole gate on touching
// NWS: with timeline pins on (the default) fetchWeather still fetches
// /alerts/active every heartbeat with no weather slot configured. See the
// wantWx/wantPins split in fetchWeather.
function wxNeeded() {
  return wxUses(WX_SLOTS);
}

// Chars that fit, indexed [fontIdx = XS..XL, Super Large]. Estimates,
// deliberately a little wide: fitWx() truncates and the watch-side ellipsis
// is the safety net. Super Large scales Extra Large's budget by the two
// fonts' mean glyph advance (16.8 vs 21.5 px).
var CHAR_BUDGET_144 = [18, 16, 12, 10, 7, 5];
var CHAR_BUDGET_200 = [25, 22, 16, 14, 10, 7];

// Round displays, keyed on getActiveWatchInfo's platform name and never on
// IMG_W, which would give chalk's 180 px the 200 px table. The watch insets
// each band to the visible chord, so the outer lines (Top Line 1, Bottom
// Line 2) get narrower tables of their own. chalk's outer table stops at
// Small because the watch caps those lines there; a larger ceiling reads as
// its last entry. A row here also makes composite.js blank the corners.
var ROUND_PLATFORMS = {
  chalk:  { inner: CHAR_BUDGET_144, outer: [12, 9] },
  gabbro: { inner: CHAR_BUDGET_200, outer: [20, 17, 12, 9, 6, 3] }
};

// The char table for display line i, 0 = Top Line 1 .. 3 = Bottom Line 2.
function budgetTable(i) {
  if (!WATCH_ROUND) return IMG_W >= 180 ? CHAR_BUDGET_200 : CHAR_BUDGET_144;
  return (i === 0 || i === 3) ? WATCH_ROUND.outer : WATCH_ROUND.inner;
}

// The budget is per string, not per slot code: the fallback slots (20, 21,
// 31) display strings other slots also show, so each string takes the
// minimum budget among every line that could display it.
//
// When any line displaying the string uses an auto font (codes 5-9 and 11),
// target the smallest Extra Small budget among those lines instead, so the
// watch has full-length text to shrink. Abbreviating to the ceiling's budget
// would make the string always fit at the ceiling, so the shrink would never
// fire. The 31-char cap still applies: both minimums start there, and
// capBytes backs it up.
function budgetFor(str) {
  var codes = slotsShowing(str);
  var best = 31;
  var autoBest = 31;
  var anyAuto = false;
  wxLines().forEach(function (l, i) {
    if (codes.indexOf(l[0]) < 0) return;
    var table = budgetTable(i);
    if (table[0] < autoBest) autoBest = table[0];
    // Font codes as main.c documents them on Settings.fonts.
    var f = l[1];
    if ((f >= 5 && f <= 9) || f === 11) { anyAuto = true; return; }
    if (f === 10) f = 5;
    else if (!(f >= 0 && f <= 4)) f = 2;
    f = Math.min(f, table.length - 1);
    if (table[f] < best) best = table[f];
  });
  return anyAuto ? autoBest : best;
}

// Stage-2 word-level abbreviation, applied token-wise (multi-word entries
// first so 'Thunderstorm Wind' wins over 'Thunderstorm').
var WX_ABBREV = [
  [/\bThunderstorm Wind\b/gi, 'TSTM Wind'],
  [/\bSmall Craft\b/gi,       'Sm Craft'],
  [/\bExtreme Heat\b/gi,      'Ext Heat'],
  [/\bThunderstorms\b/gi,     'T-Storms'],
  [/\bThunderstorm\b/gi,      'T-Storm'],
  [/\bShowers\b/gi,           'Shwrs'],
  [/\bChance\b/gi,            'Chc'],
  [/\bSlight\b/gi,            'Sl'],
  [/\bPartly\b/gi,            'Ptly'],
  [/\bMostly\b/gi,            'Mstly'],
  [/\bCloudy\b/gi,            'Cldy'],
  [/\bSunny\b/gi,             'Sun'],
  [/\bScattered\b/gi,         'Sctd'],
  [/\bIsolated\b/gi,          'Iso'],
  [/\bWarning\b/gi,           'Wrn'],
  [/\bWatch\b/gi,             'Wtch'],
  [/\bAdvisory\b/gi,          'Adv'],
  [/\bStatement\b/gi,         'Stmt'],
  [/\bSevere\b/gi,            'Svr'],
  [/\bSpecial\b/gi,           'Spcl'],
  [/\bWeather\b/gi,           'Wx'],
  [/\bMarine\b/gi,            'Mar'],
  [/\s+and\s+/gi,             ' & '],
  [/\s+then\s+/gi,            '/']
];

function abbrevWx(s) {
  for (var i = 0; i < WX_ABBREV.length; i++) {
    s = s.replace(WX_ABBREV[i][0], WX_ABBREV[i][1]);
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Three stages, applied in order until it fits: verbatim, word-level
// abbreviation, truncate to the budget (the watch-side ellipsis is the
// safety net for a budget estimated slightly wide).
// splitThen, used by the forecast slots (16 and 28), adds a stage 2.5: keep
// only the text before the first `then` (a '/' after stage 2) when the whole
// thing still does not fit; `Mstly Cldy` beats `Mstly Cldy/Chc Sh…`.
// The budget only ever comes from budgetFor(), which caps at 31, so no upper
// clamp is needed; the lower one is, since callers subtract a suffix length
// that can take it negative.
function fitWx(s, budget, splitThen) {
  if (budget < 1) budget = 1;
  s = String(s || '').trim();
  if (s.length <= budget) return s;
  s = abbrevWx(s);
  if (s.length <= budget) return s;
  if (splitThen) {
    var head = s.split('/')[0].trim();
    if (head.length) s = head;
    if (s.length <= budget) return s;
  }
  return s.slice(0, budget).replace(/\s+$/, '');
}

// Cap every outgoing string at 31 bytes + NUL, matching the watch-side
// 32-byte buffers. Bytes, not chars: '°' is two bytes of UTF-8, and a string
// cut mid-sequence would render as garbage.
function utf8len(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);
  }
  return n;
}

function capBytes(s) {
  while (utf8len(s) > 31) s = s.slice(0, s.length - 1);
  return s;
}

// Temperatures render as integers with a degree sign, no unit letter. The
// observation arrives in degC; forecast periods arrive in degF.
//
// One setting drives every unit on the face: a user who asked for Celsius
// wants km/h and millibars with it.
function wxMetric() { return numSetting('WxUnits', 0, 1) === 1; }

function fmtTempFromC(c) {
  return String(Math.round(wxMetric() ? c : c * 9 / 5 + 32)) + '°';
}

function fmtTempFromF(f) {
  return String(Math.round(wxMetric() ? (f - 32) * 5 / 9 : f)) + '°';
}

// A finite number, or null. NWS reports a missing measurement as an explicit
// null inside the value object, and stations routinely drop single fields.
function obsVal(o) {
  return (o && isNum(o.value)) ? o.value : null;
}

function isNum(v) { return typeof v === 'number' && isFinite(v); }

// The longest form that fits the budget, else the last form for the watch's
// ellipsis to cut. Numeric slots use this rather than fitWx, whose tail cut
// turns a number into a different, plausible one ('Feels 78°' cut to 7 reads
// 'Feels 7'). A ladder's last rung should fit a budget of 7, which covers
// every size but the smallest budgets in the tables.
function pickWx(forms, budget) {
  for (var i = 0; i < forms.length; i++) {
    if (forms[i].length <= budget) return forms[i];
  }
  return forms[forms.length - 1];
}

// 16-point compass from degrees. Rounding to 22.5° steps then wrapping at 16
// is what makes 348.75-360 read 'N' rather than falling off the end.
var WIND_DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compass(deg) {
  return WIND_DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// JSON values in localStorage. readWx gives null for a missing or unparsable
// value; writeWx swallows a quota throw.
function readWx(key) {
  var s = localStorage.getItem(key);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function writeWx(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {
    console.log('WX cache write failed: ' + e);
  }
}

// Evict the three per-place resource caches. One site, so a fourth such cache
// cannot be added to one eviction path and forgotten in the other. wx_grid is
// deliberately not here: it self-keys on the location (see getGrid), so only
// the no-coverage latch needs it gone outright.
function dropWxCaches() {
  localStorage.removeItem('wx_obs');
  localStorage.removeItem('wx_fcst');
  localStorage.removeItem('wx_alerts');
}

// An NWS date string to epoch seconds, 0 when absent or unparsable.
var parseEpoch = timeline.parseEpochSec;

// Shared JSON fetch. Read responseText, not response: the pkjs bridge yields
// a usable ArrayBuffer only on the first read of .response (see fetchPng);
// responseText has no such hazard. A JSON.parse failure is caught here, per
// resource, so one bad body cannot take down the other resources.
function fetchJson(url, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.timeout = 20000;
  xhr.setRequestHeader('Accept', 'application/geo+json');
  // api.weather.gov 403s an empty User-Agent. The pkjs runtime already sends
  // one and some runtimes ignore this call, so it is only a backstop.
  try {
    xhr.setRequestHeader('User-Agent', 'pebble-noaa-radar/1.0 (github.com/leoherzog)');
  } catch (e) {}
  xhr.onload = function () {
    var obj = null;
    if (xhr.responseText) {
      try {
        obj = JSON.parse(xhr.responseText);
      } catch (e) {
        console.log('WX bad JSON from ' + url + ': ' + e);
      }
    }
    cb(xhr.status, obj);
  };
  xhr.onerror = function () {
    console.log('WX fetch error: ' + url);
    cb(0, null);
  };
  xhr.ontimeout = function () {
    console.log('WX fetch timeout: ' + url);
    cb(0, null);
  };
  xhr.send();
}

// 429/5xx/timeout: keep the previous payload and retry on the next heartbeat,
// which is already the backoff. A 403 with a problems/ body is the
// diagnostic signature of a rejected User-Agent: a configuration bug, not a
// transient one, so log it loudly.
function logWxFail(what, status, obj) {
  if (status === 403 && obj) {   // status plus the problems/ body
    console.log('WX ' + what + ': 403 from api.weather.gov — User-Agent ' +
                'rejected. This is a CONFIGURATION BUG, not transient: ' +
                JSON.stringify(obj).slice(0, 160));
  } else {
    console.log('WX ' + what + ' fetch failed (' + status +
                '), keeping previous data');
  }
}

// Outside NWS coverage (/points 404 InvalidPoint, /alerts?point 400 "out of
// bounds"): latch "no coverage" against the rounded lat/lon and drop the
// caches so the NWS strings blank; do not retry until the location changes.
function markNoCoverage(lkey) {
  console.log('WX: no NWS coverage at ' + lkey +
              '; weather paused until the location changes');
  try { localStorage.setItem('wx_nocov', lkey); } catch (e) {}
  localStorage.removeItem('wx_grid');
  dropWxCaches();
}

// /points → grid + station ids, fetched once per rounded location: a grid
// cell never moves. Keyed by the same 2-decimal rounded lat/lon the basemap
// cache uses.
function getGrid(lkey, cb) {
  var g = readWx('wx_grid');
  if (g && g.k === lkey) { cb(g); return; }
  fetchJson(WX_BASE + '/points/' + lkey, function (status, obj) {
    // No coverage is status plus the problems/InvalidPoint body: a bare 404
    // from a deploy blip or an intercepting proxy must not latch weather off
    // at a valid US point, so it takes the transient-failure path instead.
    if (status === 404 && obj &&
        String(obj.type || '').indexOf('InvalidPoint') >= 0) {
      markNoCoverage(lkey);
      cb(null);
      return;
    }
    if (status !== 200 || !obj || !obj.properties) {
      logWxFail('points', status, obj);
      cb(null);
      return;
    }
    var stUrl = obj.properties.observationStations;
    // wx_grid never expires, so a partial grid, one with no forecast URL or
    // no stations, serves this pass uncached and is retried next heartbeat:
    // cached, it would kill those slots at this location forever.
    g = { k: lkey, fcst: obj.properties.forecast, st: [] };
    if (!stUrl) { cb(g); return; }
    fetchJson(stUrl + '?limit=3', function (s2, o2) {
      if (s2 !== 200 || !o2 || !o2.features) {
        logWxFail('stations', s2, o2);
        cb(g);
        return;
      }
      g.st = o2.features.slice(0, 3).map(function (f) { return f.id; })
               .filter(function (u) { return !!u; });
      if (g.fcst && g.st.length) writeWx('wx_grid', g);
      cb(g);
    });
  });
}

// Everything /observations/latest carries that a slot can use, in the API's
// own units (degC, km/h, Pa, percent, degrees). assembleWx converts, so a
// units change re-renders straight from cache (see the unitsChanged block).
// Every field is kept whether or not a slot shows it, so a newly configured
// slot fills on the next assembleWx instead of after the 9-minute refetch gate.
function obsRecord(p) {
  return {
    temp: obsVal(p.temperature),
    desc: p.textDescription || '',
    dp:   obsVal(p.dewpoint),
    rh:   obsVal(p.relativeHumidity),
    ws:   obsVal(p.windSpeed),
    wd:   obsVal(p.windDirection),
    wg:   obsVal(p.windGust),
    hi:   obsVal(p.heatIndex),
    wc:   obsVal(p.windChill),
    pr:   obsVal(p.barometricPressure)
  };
}

// Rank a fall-through candidate that lacks a temperature: a description and
// numbers beats a description alone, which beats numbers alone, which beats
// nothing. Ties keep the earlier, nearer station. A fresh station that
// reports a temperature is taken outright by fetchObs() before any ranking,
// even with an empty textDescription. wd and wg do not count as numbers: no
// slot renders either without isNum(obs.ws).
function obsScore(r) {
  var nums = isNum(r.temp) || isNum(r.dp) || isNum(r.rh) || isNum(r.ws) ||
             isNum(r.hi) || isNum(r.wc) || isNum(r.pr);
  return (r.desc ? 2 : 0) + (nums ? 1 : 0);
}

// Observation: the latest from the nearest station whose report is at most
// 2 h old and carries a temperature, falling through to the 2nd then 3rd.
// Failing that, the best partial record by obsScore is kept, since a station
// that drops temperature can still carry dew point, wind or humidity.
function fetchObs(stations, cb) {
  var partial = null;
  var any200 = false;
  function finish(rec) {
    if (rec) {
      rec.t = Date.now();
      writeWx('wx_obs', rec);
    }
    cb();
  }
  function next(i) {
    if (i >= stations.length) {
      // Stations that answered with nothing usable write an all-null
      // obsRecord, every field present, so each slot renders '--'. When every
      // request failed, the previous record stays for the next beat to retry.
      finish(partial || (any200 ? obsRecord({}) : null));
      return;
    }
    fetchJson(stations[i] + '/observations/latest', function (status, obj) {
      if (status === 200 && obj && obj.properties) {
        any200 = true;
        var p = obj.properties;
        var ts = Date.parse(p.timestamp || '');
        if (!isNaN(ts) && Date.now() - ts <= 2 * 3600 * 1000) {
          var rec = obsRecord(p);
          if (rec.temp !== null) {
            finish(rec);
            return;
          }
          if (obsScore(rec) > (partial ? obsScore(partial) : 0)) partial = rec;
        }
      } else {
        logWxFail('observation', status, obj);
      }
      next(i + 1);
    });
  }
  next(0);
}

// Forecast: only the first two periods are kept (slot 16 shows periods[0],
// slot 28 periods[1], and the H/L string derives from the pair). `n` is the
// period's own NWS name ('Tonight', 'Thursday'), which slot 28 prefixes when
// it fits.
function fetchFcst(url, cb) {
  fetchJson(url, function (status, obj) {
    if (status === 200 && obj && obj.properties &&
        obj.properties.periods && obj.properties.periods.length) {
      var p = obj.properties.periods.slice(0, 2).map(function (pd) {
        return { d: !!pd.isDaytime, t: pd.temperature, s: pd.shortForecast || '',
                 n: pd.name || '' };
      });
      writeWx('wx_fcst', { t: Date.now(), p: p });
    } else {
      logWxFail('forecast', status, obj);
    }
    cb();
  });
}

// Alerts: one response, two filters (active already includes future onsets).
// Refetched every heartbeat: max-age=5, and this is the time-critical one.
var WX_SEV = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
var WX_URG = { Immediate: 3, Expected: 2, Future: 1 };

function fetchAlerts(lkey, cb) {
  fetchJson(WX_BASE + '/alerts/active?point=' + lkey + '&status=actual',
            function (status, obj) {
    // Raw features, kept only for the timeline push. The persisted wx_alerts
    // blob keeps its five-field shape and no pin is ever built from it, so a
    // cached entry can never produce a malformed pin, and multi-KB NWS
    // descriptions stay out of a localStorage that holds two base64 PNGs.
    var raw = null;
    // Set only by a failed fetch, which still has to step multi-day pins.
    var renew = false;
    if (status === 200 && obj && obj.features) {
      var feats = obj.features.map(function (ft) {
        var p = ft.properties || {};
        return {
          e:  p.event || '',
          sv: WX_SEV[p.severity] || 0,
          ur: WX_URG[p.urgency] || 0,
          on: parseEpoch(p.onset),
          ex: parseEpoch(p.expires) || parseEpoch(p.ends)
        };
      });
      writeWx('wx_alerts', { t: Date.now(), f: feats });
      raw = obj.features;
    } else if (status === 400 && obj &&
               JSON.stringify(obj).indexOf('out of bounds') >= 0) {
      // Not a renewal: out of bounds is an answer, not a failed fetch.
      markNoCoverage(lkey);
    } else {
      logWxFail('alerts', status, obj);
      renew = true;
    }
    cb();
    // Must run after cb(), fetchWeather's `done()` sentinel, so nothing here
    // can stall `pending` and cost the watch its AppMessage; the try/catch is
    // a second layer. The setting is re-read rather than threaded in because
    // an alert slot also reaches this function with pins off.
    if ((raw || renew) && timelineAlerts()) {
      try { pushTimelinePins(raw); }
      catch (e) { console.log('TL push failed: ' + e); }
    }
  });
}

// Ranking key (first difference wins): severity, urgency, earliest onset.
// Picks the alert whose title shows.
function alertRank(a, b) {
  if (a.sv !== b.sv) return b.sv - a.sv;
  if (a.ur !== b.ur) return b.ur - a.ur;
  return (a.on || 0) - (b.on || 0);
}

// Each alert string's expiry is the minimum expires across the alerts it
// describes: with a +n suffix the whole string, title and count, is only
// accurate until the first member lapses, and the watch cannot recount.
function minExpiry(list) {
  var m = 0;
  list.forEach(function (f) { if (f.ex && (!m || f.ex < m)) m = f.ex; });
  return m;
}

// "{event}{suffix}": the title is fitted to the budget minus the suffix, so
// the count or lead time is never the part that gets truncated.
function alertLine(event, suffix, budget) {
  return fitWx(event, budget - suffix.length) + suffix;
}

// ' +n' for the alerts in `list` behind the first, whose title shows.
function moreSuffix(list) {
  return list.length > 1 ? ' +' + (list.length - 1) : '';
}

// Lead time is relative (an absolute clock time would need the watch's 12/24
// preference, which never leaves the watch): 'in 45m' under an hour, 'in 2d'
// over 24 h, 'in 3h' between.
// The unit is chosen after rounding, so a rounded value can never overflow
// its own bucket: 59m45s is '1h', not '60m'; 23h59m is '1d', not '24h'.
function fmtLead(dtSec) {
  var m = Math.max(1, Math.round(dtSec / 60));
  if (m < 60) return m + 'm';
  var h = Math.round(dtSec / 3600);
  if (h < 24) return h + 'h';
  return Math.max(1, Math.round(dtSec / 86400)) + 'd';
}

function buildAlertStrings(feats, nowSec) {
  var all = feats.slice().sort(alertRank);
  // Active = onset <= now; a null onset is treated as "in effect".
  var active = all.filter(function (f) { return !f.on || f.on <= nowSec; });

  var a = '', aExp = 0;
  if (active.length) {
    a = alertLine(active[0].e, moreSuffix(active), budgetFor('alert'));
    aExp = minExpiry(active);
  }

  var a2 = '', a2Exp = 0;
  if (all.length) {
    var top = all[0];
    var b2 = budgetFor('alert2');
    if (top.on && top.on > nowSec) {
      // The lead time replaces +n, so this string describes one alert and
      // WX_EXP2 is that alert's own expiry, not the set minimum: a short-lived
      // Minor advisory must not blank a future Severe watch hours before it
      // lapses.
      a2 = alertLine(top.e, ' in ' + fmtLead(top.on - nowSec), b2);
      a2Exp = top.ex;
    } else {
      a2 = alertLine(top.e, moreSuffix(all), b2);
      a2Exp = minExpiry(all);
    }
  }
  return { a: a, aExp: aExp, a2: a2, a2Exp: a2Exp };
}

// ---------------------------------------------------------------------------
// Sun times (slots 29-30): computed here from the location, formatted on the
// watch. They cross as int32 epoch seconds because 12/24-hour
// (clock_is_24h_style()) never leaves the watch.
// ---------------------------------------------------------------------------

// Epoch seconds, or 0 when the event does not occur. In polar day and night,
// which NWS covers in Alaska, SunCalc returns an Invalid Date whose NaN would
// marshal into the int32 tuple as garbage rather than as "no event".
function sunSec(d) {
  if (!d) return 0;
  var ms = d.getTime();
  return isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// SunCalc's day is anchored on local solar noon, not UTC, so events it
// returns can be past and the scans walk forward until one is not. Day -1
// serves nextGolden(), where a high-latitude window can be in progress across
// a solar-day boundary. Six days forward because near a polar transition
// consecutive solar days skip an event entirely (up to 4.97 d to the next
// sunrise at Utqiagvik), and a short scan silently reads '--'.
var SUN_DAYS = [-1, 0, 1, 2, 3, 4, 5, 6];

// The daylight window to show, as [sunrise, sunset] epoch seconds, taken as
// a pair from the first solar day whose sunset is still ahead. Resolving each
// to its own next occurrence would, once today's sunrise passes, pair
// tomorrow's sunrise with today's sunset and render a backwards span. SunCalc
// solves both in one call, so a day has both or neither and no cross-day
// pairing is needed; neither is polar day or night, which renders as '--'.
function nextDaylight(lat, lon, nowSec) {
  for (var i = 0; i < SUN_DAYS.length; i++) {
    var t = SunCalc.getTimes(new Date((nowSec + SUN_DAYS[i] * 86400) * 1000),
                             lat, lon);
    var a = sunSec(t.sunrise), b = sunSec(t.sunset);
    if (a && b && b > a && b > nowSec) return [a, b];
  }
  return [0, 0];
}

// The golden hour window to show, as [start, end] epoch seconds, built from
// sorted boundaries rather than same-call pairs. A window opens at sunrise or
// goldenHour and closes at goldenHourEnd or sunset, and the windows are the
// adjacent open->close pairs across the scan. Same-call pairing blanks the
// slot for weeks inside NWS coverage: where the sun rises but never reaches
// 6 deg both golden fields are invalid though the whole day is golden, and in
// polar day the real window pairs goldenHour(d) with goldenHourEnd(d+1).
function nextGolden(lat, lon, nowSec) {
  var ev = [];
  for (var i = 0; i < SUN_DAYS.length; i++) {
    var t = SunCalc.getTimes(new Date((nowSec + SUN_DAYS[i] * 86400) * 1000),
                             lat, lon);
    var marks = [[sunSec(t.sunrise), 1], [sunSec(t.goldenHourEnd), 0],
                 [sunSec(t.goldenHour), 1], [sunSec(t.sunset), 0]];
    for (var j = 0; j < marks.length; j++) {
      // [time, opens, scan day]; a 0 time means the event does not occur.
      if (marks[j][0]) ev.push([marks[j][0], marks[j][1], i]);
    }
  }
  ev.sort(function (a, b) { return a[0] - b[0]; });
  // Ascending, so the first qualifying pair is the earliest window that has
  // not ended, and a window in progress stays on screen. The two boundaries
  // must come from the same or an adjacent scan day: near |lat| 72.58 several
  // consecutive days yield no boundary, and a dangling goldenHour would pair
  // with a goldenHourEnd days later. Adjacency is exactly the polar-day
  // window's reach, since a +86400 s step advances SunCalc's julianCycle by
  // exactly 1, and a wider reach readmits bogus windows.
  for (var k = 0; k + 1 < ev.length; k++) {
    if (ev[k][1] === 1 && ev[k + 1][1] === 0 &&
        ev[k + 1][0] > ev[k][0] && ev[k + 1][0] > nowSec &&
        ev[k + 1][2] - ev[k][2] <= 1) {
      return [ev[k][0], ev[k + 1][0]];
    }
  }
  return [0, 0];
}

// One AppMessage carrying every populated weather key: 19 keys, worst case
// ~600 B against the 8,200 B inbox. Slots 20, 21 and 31 add nothing; the
// watch composes them from strings already sent.
//
// WX_TIME is the oldest fetch time among the observation and forecast that a
// configured line displays, never the assembly time: this payload is re-sent
// and replayed even when every fetch failed, and stamping now would keep the
// watch's 3-hour '--' guard from ever firing. Alerts carry WX_EXP instead, and
// an unconfigured resource going stale in the cache must not blank fresh lines.
function assembleWx(lat, lon) {
  var nowSec = Math.floor(Date.now() / 1000);
  var tOldest = 0;   // ms; 0 = no timed resource contributed
  var pl = {
    'WX_COND': '', 'WX_FCST': '', 'WX_HILO': '',
    'WX_ALERT': '', 'WX_ALERT2': '',
    'WX_TEMP': '', 'WX_FEELS': '', 'WX_DEW': '', 'WX_HUM': '',
    'WX_WIND': '', 'WX_PRES': '', 'WX_FCST2': '',
    // Epoch seconds; 0 = no such event (polar day/night), which the watch
    // renders as '--'.
    'WX_SUNRISE': 0, 'WX_SUNSET': 0, 'WX_GOLD1': 0, 'WX_GOLD2': 0,
    'WX_EXP': 0, 'WX_EXP2': 0, 'WX_TIME': nowSec
  };

  // Each cache is read only when a configured line displays a string it
  // feeds: the caches outlive a slot change, so one cached under an earlier
  // config would otherwise ride every payload. Gate on the resource, not on
  // 'cond': one observation feeds seven strings.
  var obs = wxWants('obs') ? readWx('wx_obs') : null;
  if (obs) {
    // "{temp}° {description}"; either half may be missing. With both missing
    // the string stays empty and the watch, the one place the no-data glyph is
    // chosen, renders '--'.
    var b = budgetFor('cond');
    var t = isNum(obs.temp) ? fmtTempFromC(obs.temp) : '';
    var desc = obs.desc ? fitWx(obs.desc, t ? b - t.length - 1 : b) : '';
    pl['WX_COND'] = t && desc ? t + ' ' + desc : (t || desc);

    // The six single-value strings share that one read, so they carry the
    // same observation instant. They are built whether or not their slot is
    // configured: an unconfigured budget is the 31-char ceiling, and the
    // extra keys cost less than six more gates to keep in sync.
    // Temperature needs no ladder: at most 5 characters ('-100°'), it fits
    // every budget but Super Large on gabbro's outer lines (3).
    pl['WX_TEMP'] = t;
    // Feels Like takes heat index or wind chill only when it moves in that
    // correction's own direction, else the plain temperature. A presence test
    // is the trap: NWS computes heatIndex unconditionally, and in dry air it
    // comes out below the air temperature.
    var feels = null;
    if (isNum(obs.temp)) {
      feels = obs.temp;
      if (isNum(obs.hi) && obs.hi > obs.temp) {
        feels = obs.hi;
      } else if (isNum(obs.wc) && obs.wc < obs.temp) {
        feels = obs.wc;
      }
    } else if (isNum(obs.hi)) {
      feels = obs.hi;          // nothing to compare against; take it as given
    } else if (isNum(obs.wc)) {
      feels = obs.wc;
    }
    if (feels !== null) {
      var ft = fmtTempFromC(feels);
      pl['WX_FEELS'] = pickWx(['Feels ' + ft, 'Fls ' + ft, ft],
                              budgetFor('feels'));
    }
    if (isNum(obs.dp)) {
      var dt = fmtTempFromC(obs.dp);
      pl['WX_DEW'] = pickWx(['Dew ' + dt, 'D ' + dt, dt], budgetFor('dew'));
    }
    if (isNum(obs.rh)) {
      var rh = String(Math.round(obs.rh)) + '%';
      pl['WX_HUM'] = pickWx(['Hum ' + rh, rh], budgetFor('hum'));
    }
    if (isNum(obs.ws)) {
      // km/h from the API either way. NWS codes windGust only when the peak
      // runs 10 kt (~18.5 km/h) above the mean, so the 8 km/h margin below
      // only matters for a non-METAR source.
      var metric = wxMetric();
      var spd = Math.round(metric ? obs.ws : obs.ws / 1.609344);
      var unit = metric ? ' km/h' : ' mph';
      var dir = isNum(obs.wd) ? compass(obs.wd) + ' ' : '';
      var gust = '';
      if (isNum(obs.wg) && obs.wg >= obs.ws + 8) {
        gust = ' G' + Math.round(metric ? obs.wg : obs.wg / 1.609344);
      }
      // Calm is its own word, not '0 mph', but only when nothing gusted.
      pl['WX_WIND'] = (spd === 0 && !gust) ? 'Calm'
        : pickWx([dir + spd + unit + gust, dir + spd + unit, dir + spd],
                 budgetFor('wind'));
    }
    if (isNum(obs.pr)) {
      // Pascals from the API. inHg keeps two decimals (the useful digits are
      // the last two); millibars are whole numbers.
      var pres = wxMetric() ? String(Math.round(obs.pr / 100)) + ' mb'
                            : (obs.pr / 3386.389).toFixed(2) + ' in';
      pl['WX_PRES'] = pickWx([pres, pres.split(' ')[0]], budgetFor('pres'));
    }
    if (!tOldest || obs.t < tOldest) tOldest = obs.t;
  }

  // One gate serves all three strings this block emits: slotsFrom('fcst')
  // covers WX_FCST, WX_HILO and WX_FCST2.
  var fc = wxWants('fcst') ? readWx('wx_fcst') : null;
  if (fc && fc.p && fc.p.length) {
    pl['WX_FCST'] = fitWx(fc.p[0].s, budgetFor('fcst'), true);
    if (fc.p.length >= 2) {
      // The second period, prefixed with its own NWS name when that fits:
      // 'Tonight: Mstly Cldy' says which half of the day it covers. Prose, so
      // the inner fitWx truncation is the right fallback and doubles as
      // pickWx's last rung.
      var b2 = budgetFor('fcst2');
      var s2 = fitWx(fc.p[1].s, b2, true);
      var nm = fc.p[1].n;
      pl['WX_FCST2'] = nm ? pickWx([nm + ': ' + s2, s2], b2) : s2;
      // A period can carry a null temperature: leave the string empty, which
      // the watch renders as '--', rather than send 'H NaN° L 73°'.
      if (typeof fc.p[0].t === 'number' && typeof fc.p[1].t === 'number') {
        // Chronological, with the H/L labels carrying the day/night order, so
        // every value shown keeps its label. Single letters, because the
        // system fonts have no arrow glyphs, a custom font would cost six
        // faces of heap, and 'Hi'/'Lo' at 13 characters overruns the 144 px
        // Medium budget of 12 where this form fits. No gallery scenario covers
        // that, so check any label change against the budget tables.
        var t0 = fmtTempFromF(fc.p[0].t);
        var t1 = fmtTempFromF(fc.p[1].t);
        var a0 = fc.p[0].d ? 'H' : 'L';
        var a1 = fc.p[0].d ? 'L' : 'H';
        var n0 = t0.replace('°', '');
        var n1 = t1.replace('°', '');
        // Width-fitted like every other string, or the auto-font rule could
        // never apply to it. A ladder, not fitWx: a tail cut turns the second
        // number into a plausible wrong one ('H 82° L 6' at 9).
        pl['WX_HILO'] = pickWx([
          a0 + ' ' + t0 + ' ' + a1 + ' ' + t1,   // H 82° L 64°
          a0 + t0 + ' ' + a1 + t1,               // H82° L64°
          a0 + n0 + ' ' + a1 + n1,               // H82 L64
          a0 + ' ' + t0,                         // H 82°
          a0 + n0                                // H82
        ], budgetFor('hilo'));
      }
    }
    if (!tOldest || fc.t < tOldest) tOldest = fc.t;
  }

  // The slot half of fetchWeather's wantAlert, never wantPins: pins alone must
  // not put alert strings in the payload. slotsFrom('alerts') includes the
  // fallback slots, so they keep all of their inputs.
  var al = wxWants('alerts') ? readWx('wx_alerts') : null;
  if (al && al.f) {
    var r = buildAlertStrings(al.f, nowSec);
    pl['WX_ALERT']  = r.a;
    pl['WX_EXP']    = r.aExp;
    pl['WX_ALERT2'] = r.a2;
    pl['WX_EXP2']   = r.a2Exp;
  }
  // Sun times do not fold into tOldest: WX_TIME drives fmt_wx's 3-hour
  // staleness blanking, which is about data going out of date, and the watch
  // tests these instants against its own clock instead.
  if (wxWants('sun') && isNum(lat) && isNum(lon)) {
    var day = nextDaylight(lat, lon, nowSec);
    pl['WX_SUNRISE'] = day[0];
    pl['WX_SUNSET']  = day[1];
    var gold = nextGolden(lat, lon, nowSec);
    pl['WX_GOLD1'] = gold[0];
    pl['WX_GOLD2'] = gold[1];
  }
  if (tOldest) pl['WX_TIME'] = Math.floor(tOldest / 1000);
  // Capped in one place, so no string can reach the watch uncapped.
  for (var k in pl) {
    if (typeof pl[k] === 'string') pl[k] = capBytes(pl[k]);
  }
  return pl;
}

function sendWx(pl) {
  // Persisted for the 'ready' replay, WX_TIME and all.
  try { localStorage.setItem('wx_payload', JSON.stringify(pl)); } catch (e) {}
  enqueue({ kind: 'msg', dict: pl });
}

// The heartbeat entry point. Refetches only the resources that are both
// needed by a configured slot and past their minimum interval, then
// assembles one payload from whatever is cached and queues it.
function fetchWeather(lat, lon) {
  // The alert list feeds both the alert slots and timeline pins, but wantWx
  // alone decides whether anything is sent (see done()), so pins on never
  // change a byte of what the watch receives with no weather slot configured.
  var wantWx = wxNeeded();
  var wantPins = timelineAlerts();
  if (!wantWx && !wantPins) return;
  var lkey = lat.toFixed(2) + ',' + lon.toFixed(2);

  // The three per-resource caches are for a place as well as a time, so a new
  // rounded location drops them: the time gate alone would show a previous
  // city's recent forecast here, and when this beat's alert fetch fails a
  // far-away alert is worse than none. This must run before the no-coverage
  // check: a later covered visit refills the caches while the latch survives,
  // so an uncovered location reached from it, a short hop across a coverage
  // edge, would re-send that place's weather every beat.
  if (localStorage.getItem('wx_lkey') !== lkey) {
    dropWxCaches();
    try { localStorage.setItem('wx_lkey', lkey); } catch (e) {}
  }

  if (localStorage.getItem('wx_nocov') === lkey) {
    // Sun times are as correct outside NWS coverage as inside it, so a
    // configured sun slot still gets its payload, every weather string empty.
    if (wxWants('sun')) sendWx(assembleWx(lat, lon));
    return;
  }

  // The fallback slots need two resources each: 20 = alerts + forecast,
  // 21 and 31 = alerts + observation.
  var wantObs   = wxWants('obs');
  var wantFcst  = wxWants('fcst');
  // One /alerts/active request serves both consumers.
  var wantAlert = wxWants('alerts') || wantPins;

  var now = Date.now();
  var obs = readWx('wx_obs');
  var fcst = readWx('wx_fcst');
  // One minute of slack on the interval gates: a cache is stamped when its
  // response lands, a fetch latency after the minute-aligned heartbeat, so a
  // strict test would refetch each resource at twice its interval plus a
  // beat. The slack still keeps an off-cycle call (webviewclosed) from
  // refetching early against the server's own max-age.
  // `obs.dp === undefined` refetches the {t, temp, desc} blob that 1.0.0
  // wrote once, regardless of age, or a newly configured Dew Point, Humidity,
  // Wind or Pressure would sit on '--' behind the gate. obsRecord() always
  // writes dp, so this fires at most once per install.
  var needObs  = wantObs  && (!obs  || obs.dp === undefined ||
                              now - obs.t  >=  9 * 60 * 1000);
  var needFcst = wantFcst && (!fcst || now - fcst.t >= 59 * 60 * 1000);
  // Alerts go every heartbeat (server max-age=5): no interval check.

  var pending = 1;   // sentinel: done() cannot fire before all branches start
  function done() {
    // wantWx, not `pending === 0` alone: with only pins on, every cache read
    // in assembleWx() is gated off, and the all-empty payload would clobber
    // wx_payload and make main.c blank every weather buffer, invisibly in a
    // screenshot.
    if (--pending === 0 && wantWx) sendWx(assembleWx(lat, lon));
  }

  if (wantAlert) {
    pending++;
    fetchAlerts(lkey, done);
  }
  if (needObs || needFcst) {
    pending++;
    getGrid(lkey, function (grid) {
      if (grid) {
        if (needObs && grid.st.length) {
          pending++;
          fetchObs(grid.st, done);
        }
        if (needFcst && grid.fcst) {
          pending++;
          fetchFcst(grid.fcst, done);
        }
      }
      done();
    });
  }
  done();   // release the sentinel
}

function locationSuccess(rawLat, rawLon, needImage) {
  // Round once, up front, so the cache key and the bbox describe the same
  // place: otherwise a cache hit draws radar over a basemap centered up to
  // half a kilometre away.
  var lat = Math.round(rawLat * 100) / 100;
  var lon = Math.round(rawLon * 100) / 100;

  // Without the explicit default (see numSetting), a fresh install would
  // render at City instead of the State default.
  var zoom = numSetting('Zoom', 0, 2);

  // EPSG:3857 units are metres only at the equator; a projected span W covers
  // W*cos(lat) of ground, so divide it out to make the config labels true.
  var W = ZOOM_WIDTHS[zoom] / Math.cos(lat * Math.PI / 180);
  var H = W * IMG_H / IMG_W;

  // Web Mercator (EPSG:3857)
  var cx = lon * 20037508.34 / 180;
  var cy = Math.log(Math.tan((90 + lat) * Math.PI / 360)) /
           (Math.PI / 180) * 20037508.34 / 180;

  var bbox = [cx - W / 2, cy - H / 2, cx + W / 2, cy + H / 2].join(',');

  // The bbox is a pure function of this key, so a key that no longer matches
  // the cached one means the map has moved, zoomed or was never fetched, and
  // the cached basemap must be refetched rather than blended with radar for a
  // different place. The key carries the image size so a phone paired to a
  // second watch cannot reuse a basemap rendered for the first one's display.
  var key = 'v3_' + IMG_W + 'x' + IMG_H + '_' +
            zoom + '_' + lat.toFixed(2) + '_' + lon.toFixed(2);

  var newArea = (key !== localStorage.getItem('bm_key'));

  resetTransfers(newArea);
  var g = gen;

  // needImage is set on 'ready' (a relaunch) and when the watch sends 2 (no
  // frame, a failed decode, a dropped transfer). tx_hash outlives the
  // watchface, so it must go before this pass composes; the replay's own ACK
  // re-earns it. Everything below is seconds away at best and unbounded with
  // no signal, so answer from the replay cache first.
  if (needImage) {
    clearTxHash();
    replayComposite(key);
  }

  // Tell the watch where it is (degrees x100, integers) for the Lat/Long
  // slot. Queued as a msg item: a bare sendAppMessage here would race with
  // in-flight image chunks.
  enqueue({ kind: 'msg', dict: {
    'Lat': Math.round(lat * 100),
    'Lon': Math.round(lon * 100)
  } });

  // Both layers are inputs to one blend, so they have to join before anything
  // can be sent. `want` is 1 when radar is Disabled: there is no second
  // fetch, and buildComposite reads a null radar buffer as "every pixel has
  // alpha 0", a pass-through basemap.
  var mode = radarMode();
  var want = (mode === 0) ? 1 : 2;
  var got = 0, bmRgba = null, rdRgba = null, failed = false;

  function part(which, rgba) {
    if (g !== gen) return;                     // superseded by a newer location
    if (!rgba) failed = true;
    else if (which === 0) bmRgba = rgba; else rdRgba = rgba;
    if (++got < want) return;
    if (failed || !bmRgba) {
      // A layer is missing => send nothing. The watch keeps showing the last
      // good composite; a basemap-only frame would erase live precipitation,
      // and the Radar Age slot keeps climbing, which is the truth.
      console.log('Composite skipped: a layer is missing');
      bmRgba = null; rdRgba = null;            // release both buffers
      return;
    }
    composeAndSend(bmRgba, rdRgba, mode, key);
    bmRgba = null; rdRgba = null;
  }

  // The basemap is always an input, even with radar Disabled.
  var cached = localStorage.getItem('bm_data');
  if (cached && !newArea) {
    var hit = null;
    try {
      hit = rgbaOf(b64decode(cached));
    } catch (e) {
      // A corrupt cache entry is unrecoverable: drop it so the next beat
      // refetches rather than failing forever.
      console.log('Basemap cache unusable, dropping: ' + e);
      localStorage.removeItem('bm_key');
      localStorage.removeItem('bm_data');
    }
    part(0, hit);
  } else {
    fetchPng(exportUrl(BASEMAP_URL, bbox, false), function (bytes) {
      if (g !== gen) return;   // superseded by a newer location
      if (!bytes) { part(0, null); return; }
      try {
        // Single-entry cache: a zoom change or a move simply overwrites it.
        // Data first: if the payload write throws (quota), the old key stays
        // and the next fix re-fetches instead of serving the wrong place.
        localStorage.setItem('bm_data', b64encode(bytes));
        localStorage.setItem('bm_key', key);
      } catch (e) {
        console.log('Basemap cache write failed: ' + e);
      }
      part(0, rgbaOf(bytes));
    });
  }

  // Radar is always re-fetched, being small and time-sensitive, unless the
  // user disabled the layer entirely.
  if (mode !== 0) {
    fetchPng(exportUrl(RADAR_URL, bbox, true), function (bytes) {
      if (g !== gen) return;   // superseded by a newer location
      part(1, bytes ? rgbaOf(bytes) : null);
    });
  }

  // Weather rides the same heartbeat that got us here, with no timer of its
  // own, and keeps working when the radar layer is Disabled.
  lastLat = lat;
  lastLon = lon;
  fetchWeather(lat, lon);
}

// Blend, hash, and either transfer or skip. Called once per pass, only when
// every input arrived.
function composeAndSend(bmRgba, rdRgba, mode, key) {
  var r;
  try {
    r = composite.buildComposite(bmRgba, rdRgba, mode, IMG_W, IMG_H,
                                 WATCH_ROUND !== null);
  } catch (e) {
    console.log('Composite failed: ' + e);   // send nothing; keep the last good frame
    return;
  }
  var h = composite.hashBytes(r.bytes);
  console.log('Composite ' + r.bytes.length + ' B, ' + r.colors +
              ' colors -> ' + r.folded + ', hash ' + h);
  var committed = localStorage.getItem('tx_hash');
  // pendingHash: these bytes are queued or in flight. tx_hash: an ACK showed
  // the watch displays them, and a frameless report clears it before the
  // pass composes, so there only an ACK since, such as the replay's, counts.
  // Both arms are needed: a replay that ACKs before the fetch returns has
  // already cleared pendingHash.
  if (h === pendingHash || h === committed) {
    // The pending arm logs distinctly, because the log line is the cache's
    // only instrument.
    console.log('Composite unchanged, skipping transfer' +
                (h === pendingHash ? ' (already in flight)' : ''));
    // Stamp the radar time only on a committed match, which rests on an ACK.
    // A pending match may never be drawn, so dating it now could misdate the
    // screen; the pending item's own onAck carries the stamp. After a replay
    // the age therefore reads from the replayed frame's fetch until the next
    // heartbeat re-stamps it, stale-side by design.
    if (h !== pendingHash) {
      enqueue({ kind: 'msg', dict: { 'RADAR_TIME': radarStamp(mode) } });
    }
    return;
  }
  pendingHash = h;
  enqueue({ kind: 'img', bytes: r.bytes, hash: h, radarTime: radarStamp(mode),
            key: key });
}

// When pkjs fetched the radar layer this composite was built from, in unix
// seconds. Not a decode time: the transfer cache skips unchanged composites,
// so a decode is not a reliable Radar Age heartbeat. 0 = the layer is
// Disabled, which the watch renders as 'no radar'.
function radarStamp(mode) {
  return (mode === 0) ? 0 : Math.floor(Date.now() / 1000);
}

function getLocation(needImage) {
  // A manual location bypasses geolocation entirely: no permission prompt,
  // and it keeps working when the phone's location services are off. It flows
  // through the same locationSuccess as a GPS fix, so the map, the weather,
  // and the watch's Lat/Long slot all follow it with no further plumbing.
  var m = parseManualLoc(localStorage.getItem('ManualLoc'));   // '' or absent = GPS
  if (m) {
    locationSuccess(m.lat, m.lon, needImage);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      locationSuccess(pos.coords.latitude, pos.coords.longitude, needImage);
    },
    function (err) {
      console.log('Location error, using fallback: ' + err);
      locationSuccess(FALLBACK_LAT, FALLBACK_LON, needImage);
    },
    { timeout: 15000, maximumAge: 600000 }
  );
}

// ---------------------------------------------------------------------------
// First-run sizes
// ---------------------------------------------------------------------------

// Until the first Save the watch owns the four line sizes (load_settings() in
// main.c). REQUEST_FONTS asks for them, the watch answers with the four font
// keys, and the answer goes into Clay's store, which the settings page reads.
var FONT_KEYS = LINE_KEYS.map(function (k) { return k[1]; });
// How long a settings page waits for that answer. The Pebble app gives
// openURL 10 s from showConfiguration.
var SIZE_WAIT_MS = 3000;
// True once the watch has answered this session, or one page has opened
// without an answer. Later opens never wait.
var sizesSettled = false;
// showConfiguration events waiting on the answer. Each gets its own openURL:
// the Pebble app holds every request open until a URL arrives for it.
var pendingOpens = 0;

function requestFonts() {
  enqueue({ kind: 'msg', dict: { 'REQUEST_FONTS': 1 } });
}

function openConfig() {
  Pebble.openURL(clay.generateUrl());
}

function settleSizes() {
  sizesSettled = true;
  var n = pendingOpens;
  pendingOpens = 0;
  while (n-- > 0) openConfig();
}

// The watch's answer. cfg2 means a Save has happened and the phone owns the
// sizes, so a late answer is dropped. Never write cfg2 from here: it would
// replay as a saved config, to a second watch too.
function onWatchFonts(p) {
  if (!localStorage.getItem('cfg2')) {
    var sizes = {};
    FONT_KEYS.forEach(function (k) {
      // Strings, as a Save stores a select's value.
      if (p[k] !== undefined) sizes[k] = String(p[k]);
    });
    try {
      clay.setSettings(sizes);
      console.log('Watch sizes ' + FONT_KEYS.map(function (k) {
        return sizes[k];
      }).join(',') + ' -> settings page');
    } catch (e) {
      console.log('Watch sizes not stored: ' + e);
    }
  }
  settleSizes();
}

// ---------------------------------------------------------------------------
// Pebble events
// ---------------------------------------------------------------------------

Pebble.addEventListener('showConfiguration', function () {
  if (sizesSettled || localStorage.getItem('cfg2')) {
    openConfig();
    return;
  }
  // The Pebble app can fire this straight after 'ready', before the watch has
  // answered, and a page built now would save default sizes over a face that
  // started larger. Ask again, in case the first request was lost.
  pendingOpens++;
  if (pendingOpens > 1) return;   // the first request's query and timer serve it
  // Armed before the query, so a send that throws cannot cost the page.
  setTimeout(function () {
    if (sizesSettled) return;
    console.log('Watch sizes not received, opening settings without them');
    settleSizes();
  }, SIZE_WAIT_MS);
  requestFonts();
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  // convert=false: the default conversion re-keys everything by numeric
  // messageKey id, so d.TopSlot and the rest would read as undefined.
  var d = clay.getSettings(e.response, false);
  var s = {};
  LINE_KEYS.forEach(function (k) {
    s[k[0]] = Number(d[k[0]].value);
    s[k[1]] = Number(d[k[1]].value);
  });
  s['RefreshInterval'] = Number(d.RefreshInterval.value);
  // Guarded: absent reads as on, the default, not 0.
  s['BtIndicator'] = (d.BtIndicator && !Number(d.BtIndicator.value)) ? 0 : 1;
  // Clay color pickers store an 0xRRGGBB number; the watch quantizes it with
  // GColorFromHEX.
  s['TextColor'] = Number(d.TextColor.value);
  s['OutlineColor'] = Number(d.OutlineColor.value);

  // Zoom, RadarMode, UseGps/ManualLoc, WxUnits and TimelineAlerts are
  // phone-side: none is a package.json messageKey, so they stay out of s and
  // cfg2 and live under their own localStorage keys.
  var zoomChanged = storeSetting('Zoom', String(Number(d.Zoom.value)),
                                 SETTING_DEFAULTS.Zoom);
  // The config page refuses to save with the GPS toggle off and an
  // unparsable box (custom-clay.js disables Save), so a pair that fails to
  // parse here is a stale or hand-built response: fall back to GPS rather
  // than guess. Stored under the single key 'ManualLoc', which getLocation()
  // reads: '' = GPS.
  var mloc = (d.UseGps && !Number(d.UseGps.value))
               ? parseManualLoc(d.ManualLoc && d.ManualLoc.value)
               : null;
  var locChanged = storeSetting('ManualLoc',
                                mloc ? mloc.lat + ',' + mloc.lon : '', '');
  var radarChanged = storeSetting('RadarMode', String(Number(d.RadarMode.value)),
                                  SETTING_DEFAULTS.RadarMode);
  // A units change drops the cached payload and backdates the per-resource
  // stamps so the interval gates open, keeping the unit-agnostic entries for
  // a failed refetch to show. t = 1, not 0: assembleWx folds the oldest stamp
  // with `!tOldest || ...`, and a falsy 0 would stamp stale data with `now`,
  // so the watch's 3-hour '--' guard could never fire.
  var unitsChanged = storeSetting('WxUnits', String(Number(d.WxUnits.value)),
                                  SETTING_DEFAULTS.WxUnits);
  if (unitsChanged) {
    localStorage.removeItem('wx_payload');
    var oldObs = readWx('wx_obs');
    if (oldObs) { oldObs.t = 1; writeWx('wx_obs', oldObs); }
    var oldFcst = readWx('wx_fcst');
    if (oldFcst) { oldFcst.t = 1; writeWx('wx_fcst', oldFcst); }
  }
  // Guarded like UseGps/BtIndicator rather than dereferenced: webviewclosed
  // has no try/catch, and a TypeError here would abort before the cfg2 write
  // below, silently losing every setting the user just saved. Stored as
  // '1'/'0', never String(boolean): 'false' reads back through numSetting as
  // NaN, which folds to the on default and makes Off unreachable.
  var pins = (d.TimelineAlerts && !Number(d.TimelineAlerts.value)) ? '0' : '1';
  var pinsChanged = storeSetting('TimelineAlerts', pins,
                                 SETTING_DEFAULTS.TimelineAlerts);
  if (pinsChanged && pins === '0') {
    // Turning it off forgets what was pushed, so turning it back on re-pushes
    // the alerts still in force, which the user may have swiped away.
    // Inserting an existing id updates that pin, so the cost is a handful of
    // inserts.
    localStorage.removeItem('tl_pins');
    tlState = null;
  }
  // Kept for the next 'ready' to replay, because the link is often busy now
  // and a NACKed settings message would leave the watch diverged for good.
  // Queued, never a bare sendAppMessage, which would race the imagery below.
  // Never rename the key: every install's saved config lives under it.
  localStorage.setItem('cfg2', JSON.stringify(s));
  enqueue({ kind: 'msg', dict: s });
  if (zoomChanged || locChanged || radarChanged) {
    // The blend happens here, so a radar mode change, Disabled included,
    // needs a fresh composite even where the bbox did not move.
    if (radarChanged) clearTxHash();
    getLocation(false);
  } else if (wxNeeded() || pinsChanged) {
    // No imagery to redo, but units or a weather slot may have changed, so
    // refresh from the last fix. `|| pinsChanged` makes turning pins on take
    // effect now rather than up to an hour later; turning them off this way
    // fetches and sends nothing, because fetchWeather self-gates.
    if (lastLat !== null) {
      fetchWeather(lastLat, lastLon);
    } else if (wxNeeded()) {
      // Saved before the first fix: a units change just deleted wx_payload,
      // so resolve a fix and let weather ride along. wxNeeded(), not
      // pinsChanged: 'ready' already called getLocation, which has no
      // in-flight guard, so a second call runs the imagery pass twice, and a
      // pins-only change must not change what the watch receives.
      getLocation(false);
    }
  }
});

Pebble.addEventListener('ready', function () {
  console.log('PebbleKit JS ready!');
  // Size the imagery to the connected watch before the first fetch goes out.
  // getActiveWatchInfo is absent on very old pkjs runtimes and returns an
  // unknown platform on future hardware; both keep the emery defaults.
  var info = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
  var size = info && PLATFORM_SIZES[info.platform];
  if (size) {
    IMG_W = size[0];
    IMG_H = size[1];
  }
  WATCH_ROUND = (info && ROUND_PLATFORMS[info.platform]) || null;
  console.log('Imagery size: ' + IMG_W + 'x' + IMG_H +
              ' (platform ' + ((info && info.platform) || 'unknown') +
              (WATCH_ROUND ? ', round' : '') + ')');
  // Resync a lost save through the queue, not a bare sendAppMessage: the
  // weather replay below enqueues in the same tick, and with two sends in
  // flight the bare one's NACK would go unnoticed, leaving the watch's
  // persisted settings diverged forever. Each try also covers enqueue, so a
  // send that throws cannot skip the getLocation below.
  var cfg = localStorage.getItem('cfg2');
  if (cfg) {
    try { enqueue({ kind: 'msg', dict: JSON.parse(cfg) }); } catch (e) {}
  } else {
    // Nothing saved, so the watch holds its own sizes. Asked first, ahead of
    // any image, so the answer is back before a settings page needs it.
    requestFonts();
  }
  // Replay the last weather payload (same pattern as cfg2): the watch does not
  // persist weather, and a fresh pass waits on a location fix and the network.
  // WX_TIME rides along unchanged, so hour-old data still reads as hour-old.
  var wxp = localStorage.getItem('wx_payload');
  if (wxp && wxNeeded()) {
    try { enqueue({ kind: 'msg', dict: JSON.parse(wxp) }); } catch (e) {}
  }
  // The phone cannot tell whether the relaunched watch restored a persisted
  // frame (emery/gabbro only), so it treats the watch as frameless.
  getLocation(true);
});

Pebble.addEventListener('appmessage', function (e) {
  // The outer test is truthiness, which is why the watch's flag is 2/1 and
  // never 0: a 0 would be silently ignored here and the heartbeat would die.
  // 2 = "I need a frame" -> forget the committed transfer cache and replay.
  if (e.payload['REQUEST_IMAGES']) {
    getLocation(e.payload['REQUEST_IMAGES'] === 2);
  }
  // The watch's answer to REQUEST_FONTS carries all four font keys.
  if (e.payload['TopFont'] !== undefined) {
    onWatchFonts(e.payload);
  }
});

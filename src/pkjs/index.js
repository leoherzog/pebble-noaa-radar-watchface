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
// 16 colors (shrinkPng) before the blend: blending the originals measured
// 37-42 output colors instead of 19-29, with no byte saving and a muddy result.
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

// The manual-location override, stored under one key: '' or absent means GPS,
// anything else is the "lat,lon" webviewclosed validated and wrote.
function manualLocation() {
  var s = localStorage.getItem('ManualLoc');
  return s ? parseManualLoc(s) : null;
}

// A bounded-enum setting from localStorage, with the default branched
// explicitly rather than clamped into: these keys are written only when the
// user saves the config page, so they are null on a fresh install, and
// Number(null) is 0, not NaN — a plain clamp would silently accept it as the
// enum's zero value. '' (a cleared key) reads the same way. Out-of-range and
// NaN fall back too, so a corrupt value can never leave the domain.
function numSetting(key, def, lo, hi) {
  var raw = localStorage.getItem(key);
  var v = (raw === null || raw === '') ? def : Number(raw);
  if (isNaN(v) || v < lo || v > hi) v = def;
  return v;
}

// 0 Disabled, 1 Translucent, 2 Opaque. Phone-side only, like Zoom and
// WxUnits, because the blend happens here. Without the explicit default a
// fresh install would read as Disabled and ship a basemap with no radar.
function radarMode() {
  return numSetting('RadarMode', 1, 0, 2);
}

// Push NWS severe alerts into the timeline as pins. Phone-side only, like
// RadarMode, so the watch never sees the setting. Defaults on through
// numSetting's explicit default branch; do not copy wxMetric()'s `=== '1'`
// idiom, which is a default-off read and would invert it.
function timelineAlerts() {
  return numSetting('TimelineAlerts', 1, 0, 1) === 1;
}

// `tl_pins` is the persisted record of what the timeline already holds, like
// tx_hash. It needs no pendingHash-style companion because insertion is
// synchronous: the commit lands before a duplicated heartbeat (QEMU's triple
// REQUEST_IMAGES, or main.c's failed-decode and dropped-inbox re-requests)
// can re-derive the same candidates. An asynchronous delivery route would
// need that second record back.
var tlState = null;        // parsed tl_pins map, lazily loaded

function tlLoadState() {
  if (tlState) return tlState;
  var s = localStorage.getItem('tl_pins');
  if (s) { try { tlState = JSON.parse(s); } catch (e) { tlState = null; } }
  if (!tlState || typeof tlState !== 'object') tlState = {};
  return tlState;
}

function tlSaveState() {
  // A null tlState means webviewclosed cleared the map; writing
  // JSON.stringify(null) would resurrect the key the toggle removed.
  if (!tlState) return;
  // Same swallow-and-log policy as writeWx: this cache shares a localStorage
  // with two base64 PNGs (bm_data, tx_replay), and a quota throw here must
  // never escape into the alert path.
  try { localStorage.setItem('tl_pins', JSON.stringify(tlState)); }
  catch (e) { console.log('TL state write failed: ' + e); }
}

// Local pins only. Pebble.insertTimelinePin() builds the pin on the phone and
// syncs it to the watch with no service in the loop, so it needs no timeline
// token, API key or appstore listing.
//
// The timeline web API is deliberately not kept as a fallback. The new Pebble
// app does not support it; it only intercepts its own JS's XHRs to
// timeline-api.{rebble.io,getpebble.com}/v1/user/pins and turns them into
// local pins, a shim the user can switch off ('Emulate Timeline Webservice')
// and the docs tell new code not to lean on. A runtime without
// insertTimelinePin (an old pkjs, or Rebble's own app, where a real service
// still exists) therefore gets no pins, rather than this file carrying a
// second delivery path with its own token lifecycle, 410 latch and HTTP
// status ladder that nothing here can exercise.
//
// insertTimelinePin reports nothing (no callback, no status, no throw on a
// rejected pin), so a commit here means only "did not throw". Committing
// anyway is deliberate: never committing would re-insert every tracked pin on
// every heartbeat forever.

// Push whatever this fetch's alert list implies. Called from fetchAlerts only
// with the setting on, and only after it has called done(), so nothing here
// can stall, delay or alter the weather AppMessage.
function pushTimelinePins(features) {
  var nowSec = Math.floor(Date.now() / 1000);
  var st = tlLoadState();
  var plan = timeline.planPins(features, st, nowSec);
  tlState = plan.state;
  tlSaveState();          // persists the GC and the first-seen anchors

  // planPins drops a Severe feature with no VTEC key silently, so this count
  // is the only sign one exists. If it is ever non-zero in the field, revisit
  // the decision rather than bolting on an unstable fallback id. Counted from
  // the module's pure exports so planPins keeps its two-field contract.
  var noVtec = 0, tracked = 0, i, k;
  for (i = 0; i < features.length; i++) {
    var pr = features[i] && features[i].properties;
    if (timeline.isSevere(pr) && !timeline.pinIdFor(pr, nowSec)) noVtec++;
  }
  for (k in tlState) { if (tlState.hasOwnProperty(k)) tracked++; }
  // Logged on every fetch, zero included: in clear weather this line is the
  // only evidence the feature runs, and a broken read of the setting would
  // otherwise look exactly like a quiet sky.
  console.log('TL ' + plan.puts.length + ' pin(s) to push, ' + tracked +
              ' tracked' + (noVtec ? ', ' + noVtec + ' skipped with no VTEC key' : ''));

  if (!plan.puts.length) return;
  if (typeof Pebble.insertTimelinePin !== 'function') {
    // Not an error: such a runtime never shows pins. Reached only when there
    // is something to push, so this line's absence proves nothing about the
    // runtime.
    console.log('TL insertTimelinePin unavailable on this runtime; no pins');
    return;
  }
  // Per pin, not around the loop: one pin the runtime dislikes must not stop
  // the rest of the plan, and a commit that already happened must survive it.
  plan.puts.forEach(function (p) {
    try {
      Pebble.insertTimelinePin(p.pin);
      timeline.commitPin(tlState, p.id, p.sig);
      console.log('TL pin ' + p.id + ' pushed');
    } catch (e) { console.log('TL push failed: ' + e); }
  });
  // Once, after the loop. Every commit above is already in tlState, so a pin
  // that threw is simply absent from it and the next heartbeat retries it.
  tlSaveState();
}

// ---------------------------------------------------------------------------
// Transfer state machine
// ---------------------------------------------------------------------------

var CHUNK = 4096;      // the inbox is 8200 B on all four platforms; the
                       // header tuples add ~50 B
// The single-slot serialiser carries two kinds of work, dispatched on `kind`:
//   {kind: 'img', bytes, hash, radarTime}  — chunked transfer of the composite
//   {kind: 'msg', dict: {...}}             — one whole AppMessage
// The chunked protocol depends on strictly ordered ACKs, and firing an
// unrelated sendAppMessage mid-transfer risks a NACK on the chunk in flight,
// so every other AppMessage (settings, weather, Lat/Lon, RADAR_TIME) must go
// through this same queue as a msg item.
var tx = null;         // current item (+ offset/pending/retries while sending)
var queue = [];        // pending items, in the order the work became ready
var gen = 0;           // bumped when the bbox moves; stale fetches drop out
// Hash of the composite currently queued or in flight. In memory only, and
// distinct from the committed tx_hash: QEMU delivers each REQUEST_IMAGES up to
// three times, and without this all three identical composites would enqueue
// before the first one commits.
var pendingHash = null;
// Hash held by the tx_replay blob, as far as this pkjs session knows. In
// memory only and deliberately pessimistic: a fresh session assumes nothing
// and rewrites the blob at its first commit.
var replayHash = null;
// Hash of a composite actually delivered and ACKed since the watch last said
// it had no frame. Deliberately narrower than tx_hash, which outlives both the
// session and the watchface and so can describe a watch that has since
// relaunched empty; this is cleared the moment a needImage request arrives and
// re-earned by the next ACK. That is what lets a needImage pass skip a
// composite it has already answered — see composeAndSend.
var deliveredHash = null;

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

// The dict for this item's next dispatch. A msg item is its whole payload; an
// img item is one chunk, and building it also records where the transfer will
// stand once the chunk is ACKed. That side effect is why dictFor() runs before
// every dispatch, retries included: without a fresh t.pending the ACK cannot
// advance the offset.
function dictFor(t) {
  if (t.kind === 'msg') return t.dict;
  var end = Math.min(t.offset + CHUNK, t.bytes.length);
  t.pending = end;
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
  // A msg item is done at its first ACK — and has no .bytes to test, so this
  // must come first.
  if (t.kind !== 'msg') {
    t.offset = t.pending;
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
    deliveredHash = t.hash;
    // Keep the bytes too, so a relaunched watch can be filled without a fix,
    // fetch and blend (see replayComposite). One key holds bbox, hash, stamp
    // and bytes: a replay is correct only if all four agree, and separate
    // keys could be left disagreeing by a partial write. A quota throw leaves
    // the previous blob intact.
    // bm_key is this composite's own bbox: resetTransfers() drops an
    // in-flight img when the area moves, and the t !== tx guard keeps a
    // dropped transfer from reaching here.
    // replayHash, not tx_hash, gates the rewrite: tx_hash survives a pkjs
    // restart, so testing it would skip the write whenever the watch already
    // held these bytes, the common case, and leave the blob absent or stale
    // forever. Set only after the write succeeds, so a quota failure retries
    // on the next commit.
    if (replayHash !== t.hash) {
      try {
        localStorage.setItem('tx_replay', JSON.stringify({
          k: localStorage.getItem('bm_key'),
          h: t.hash,
          t: t.radarTime,
          d: b64encode(t.bytes)
        }));
        replayHash = t.hash;
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
  // tx_replay is deliberately not dropped here. tx_hash means "the watch is
  // displaying these bytes", which is what became unknown; tx_replay means
  // "this is the last composite we know landed, for bbox k", which is still
  // true — and its key gate, not this flag, is what makes replaying it safe.
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
// showing the wrong place. And it re-sends the stored
// radar stamp, never `now`, so the Radar Age slot dates the pixels on screen.
function replayComposite(key) {
  var raw = localStorage.getItem('tx_replay');
  if (!raw) return;
  var r;
  try { r = JSON.parse(raw); } catch (e) { return; }
  if (!r || r.k !== key) return;
  // QEMU delivers each REQUEST_IMAGES up to three times; without this the same
  // replay would queue up behind itself.
  if (r.h === pendingHash) return;
  // The blob on disk holds exactly these bytes, so this replay's own ACK must
  // not rewrite it.
  replayHash = r.h;
  var bytes = b64decode(r.d);
  console.log('Replaying last composite, ' + bytes.length + ' B, hash ' + r.h);
  pendingHash = r.h;
  enqueue({ kind: 'img', bytes: bytes, hash: r.h, radarTime: r.t });
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
// Weather (slots 15-31) — NWS JSON API, api.weather.gov. No key, no provider.
// 15-28 and 31 are fetched; 29-30 (sun times) are computed here from the
// location.
// Every string is assembled, unit-converted, abbreviated and width-fitted
// here. The watch receives finished strings, two alert expiries, the fetch
// time, and four sun instants that it formats itself.
// ---------------------------------------------------------------------------

var WX_BASE = 'https://api.weather.gov';

// Which WX_* string each weather slot code displays. This is the one place a
// weather slot is registered: WX_SLOTS, the per-string width budgets and the
// per-resource fetch gates are all derived from it. Hand-synced code lists
// drift silently: a code missing from a fetch gate stops that resource being
// fetched while assembleWx still tries to build its string.
var WX_SLOT_STRINGS = {
  15: ['cond'],   16: ['fcst'],           17: ['hilo'],
  18: ['alert'],  19: ['alert2'],
  20: ['alert', 'hilo'],                  // alert, else high/low
  21: ['alert', 'cond'],                  // alert, else current conditions
  31: ['alert', 'alert2', 'cond'],        // alert, else upcoming, else conditions
  22: ['temp'],   23: ['feels'],          24: ['dew'],
  25: ['hum'],    26: ['wind'],           27: ['pres'],
  28: ['fcst2'],                          // the SECOND forecast period
  // The sun group is the one set of values this file does not format: they
  // travel as epoch seconds because 12/24-hour (clock_is_24h_style()) is a
  // watch setting the phone never sees. They are registered here anyway,
  // since WX_SLOTS and slotsFrom('sun') both derive from this table.
  29: ['daylight'], 30: ['gold']
};

// Which fetched resource feeds each string. 'sun' is computed here rather than
// fetched, so no interval gate uses it, but slotsFrom('sun') still needs the
// name to gate the computation. A string missing from this table is silently
// never fetched or computed.
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

// [slotCode, fontCode] for each of the four lines in display order, from the
// persisted cfg2 blob; budgetFor() reads the index as the line's position.
// The parse is guarded, so a truncated blob cannot throw out of 'ready' and
// take the imagery fetch down with the weather: no blob, or a bad one, reads
// as "no lines configured".
function wxLines() {
  var lines = [];                             // fresh install / bad blob:
  var c = localStorage.getItem('cfg2');       // Time/Date defaults
  if (c) {
    try {
      var d = JSON.parse(c);
      lines = [[d.TopSlot1, d.TopFont1], [d.TopSlot, d.TopFont],
               [d.BottomSlot, d.BottomFont], [d.BottomSlot2, d.BottomFont2]];
    } catch (e) {}
  }
  return lines;
}

// True when any configured line displays one of these slot codes.
function wxUses(codes) {
  return wxLines().some(function (l) { return codes.indexOf(l[0]) >= 0; });
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
// deliberately a little wide — fitWx() truncates and the watch-side ellipsis
// is the safety net (see fitWx, below). Super Large scales Extra Large's
// budget by the two fonts' mean glyph advance (16.8 vs 21.5 px).
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
function budgetFor(codes) {
  var best = 31;
  var autoBest = 31;
  var anyAuto = false;
  wxLines().forEach(function (l, i) {
    if (codes.indexOf(l[0]) < 0) return;
    var table = budgetTable(i);
    if (table[0] < autoBest) autoBest = table[0];
    // Font codes as main.c's slot_font_raw() documents them.
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
// wants km/h and millibars with it. Phone-side only, like Zoom. The messageKey
// stays 'WxUnits' with values 0/1, because renaming a Clay key resets every
// saved config.
function wxMetric() { return localStorage.getItem('WxUnits') === '1'; }

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

// Pick the longest form that fits the budget.
//
// Numeric slots use this rather than fitWx, whose tail truncation turns a
// number into a different, plausible value ('Feels 78°' cut to 7 chars reads
// 'Feels 7'). Their last rungs fit a budget of 7, which covers every size
// but Extra Large on gabbro's outer lines (6) and Super Large on the 144 px
// table (5) and on gabbro's outer lines (3). Wind's overruns 5 ('WSW 12'),
// and at 3 most rungs do; High / Low's ('H82') fits 3 for two-digit
// temperatures. An overrunning last rung is returned anyway for the watch's
// ellipsis.
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

// localStorage JSON helpers for the per-resource caches.
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

function parseEpoch(s) {
  if (!s) return 0;
  var ms = Date.parse(s);
  return isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

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

// 429/5xx/timeout: keep the previous payload, retry on the next heartbeat —
// the heartbeat is already the backoff. A 403 with a problems/ body is the
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

// /points → grid + station ids: fetched once per rounded location, ever —
// max-age ~24 h and a grid cell never moves. Keyed by the same 2-decimal
// rounded lat/lon the basemap cache uses.
function getGrid(lkey, cb) {
  var g = readWx('wx_grid');
  if (g && g.k === lkey) { cb(g); return; }
  fetchJson(WX_BASE + '/points/' + lkey, function (status, obj) {
    // No coverage is status plus the problems/InvalidPoint body: a
    // bare 404 from a deploy blip or an intercepting proxy at a perfectly
    // valid US point must not latch weather off until the location changes.
    // It falls through to the transient-failure path and retries instead.
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
    var fcstUrl = obj.properties.forecast;
    var stUrl = obj.properties.observationStations;
    if (!stUrl) {
      cb({ k: lkey, fcst: fcstUrl, st: [] });   // not cached: retry next time
      return;
    }
    fetchJson(stUrl + '?limit=3', function (s2, o2) {
      if (s2 !== 200 || !o2 || !o2.features) {
        logWxFail('stations', s2, o2);
        // Usable for the forecast this pass, but not cached, so the station
        // list is retried on the next heartbeat.
        cb({ k: lkey, fcst: fcstUrl, st: [] });
        return;
      }
      var st = o2.features.slice(0, 3).map(function (f) { return f.id; })
                 .filter(function (u) { return !!u; });
      g = { k: lkey, fcst: fcstUrl, st: st };
      // wx_grid never expires, so a partial /points response must
      // not be cached: an entry with no forecast URL (or no stations) would
      // silently kill those slots at this location forever. Usable this
      // pass, retried on the next heartbeat — same treatment as !stUrl.
      if (fcstUrl && st.length) {
        writeWx('wx_grid', g);
      }
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

// True when a record carries any numeric at all, description aside. wd and wg
// are deliberately absent: neither is ever rendered on its own (WX_WIND needs
// isNum(obs.ws) first), so a station reporting only a wind direction has
// nothing any slot could display.
function obsHasValue(r) {
  return isNum(r.temp) || isNum(r.dp) || isNum(r.rh) || isNum(r.ws) ||
         isNum(r.hi) || isNum(r.wc) || isNum(r.pr);
}

// Rank a fall-through candidate that lacks a temperature: a description and
// numbers beats a description alone, which beats numbers alone, which beats
// nothing. Ties keep the earlier, nearer station. A fresh station that
// reports a temperature is taken outright by fetchObs() before any ranking,
// even with an empty textDescription.
function obsScore(r) {
  return (r.desc ? 2 : 0) + (obsHasValue(r) ? 1 : 0);
}

// Observation: the latest from the nearest station whose report is at most
// 2 h old and carries a temperature, falling through to the 2nd then 3rd.
// Failing that, the best partial record by obsScore is kept, since a station
// that drops temperature can still carry dew point, wind or humidity.
function fetchObs(stations, cb) {
  var partial = null;
  var any200 = false;
  function next(i) {
    if (i >= stations.length) {
      if (partial) {
        partial.t = Date.now();
        writeWx('wx_obs', partial);
      } else if (any200) {
        // The stations answered but nothing was usable: render '--'. An
        // all-null record, not a hand-built pair, so every field a slot may
        // read is present and explicitly empty.
        var empty = obsRecord({});
        empty.t = Date.now();
        writeWx('wx_obs', empty);
      }
      // else: every request failed — keep the previous data, retry next beat.
      cb();
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
            rec.t = Date.now();
            writeWx('wx_obs', rec);
            cb();
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
// Refetched every heartbeat — max-age=5, this is the time-critical one.
var WX_SEV = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
var WX_URG = { Immediate: 3, Expected: 2, Future: 1 };

function fetchAlerts(lkey, cb) {
  fetchJson(WX_BASE + '/alerts/active?point=' + lkey + '&status=actual',
            function (status, obj) {
    // Raw features, kept only for the timeline push. The PERSISTED wx_alerts
    // blob keeps its five-field shape exactly: pins read the live response, so
    // an entry written by an older build can never produce a malformed pin,
    // and multi-KB NWS descriptions never enter a localStorage that already
    // holds two base64 PNGs.
    var raw = null;
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
      markNoCoverage(lkey);
    } else {
      logWxFail('alerts', status, obj);
    }
    cb();
    // Must run after cb(), fetchWeather's `done()` sentinel, so nothing here
    // can stall `pending` and cost the watch its AppMessage; the try/catch is
    // a second layer. The setting is re-read rather than threaded in because
    // an alert slot also reaches this function with pins off.
    if (raw && timelineAlerts()) {
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

// "{event} +{n}": the title is fitted to the budget minus the suffix, so the
// count is never the part that gets truncated.
function alertLine(event, n, budget) {
  var suffix = n > 0 ? ' +' + n : '';
  return fitWx(event, budget - suffix.length) + suffix;
}

// Lead time is relative (an absolute clock time would need the watch's 12/24
// preference, which never leaves the watch): 'in 45m' under an hour, 'in 2d'
// over 24 h, 'in 3h' between.
// The unit is chosen AFTER rounding, so a rounded value can never overflow
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
    a = alertLine(active[0].e, active.length - 1, budgetFor(slotsShowing('alert')));
    aExp = minExpiry(active);
  }

  var a2 = '', a2Exp = 0;
  if (all.length) {
    var top = all[0];
    var b2 = budgetFor(slotsShowing('alert2'));
    if (top.on && top.on > nowSec) {
      // The lead time replaces +n, so this string describes one alert and
      // WX_EXP2 is that alert's own expiry, not the set minimum: a short-lived
      // Minor advisory must not blank a future Severe watch hours before it
      // lapses.
      var suffix = ' in ' + fmtLead(top.on - nowSec);
      a2 = fitWx(top.e, b2 - suffix.length) + suffix;
      a2Exp = top.ex;
    } else {
      a2 = alertLine(top.e, all.length - 1, b2);
      a2Exp = minExpiry(all);
    }
  }
  return { a: a, aExp: aExp, a2: a2, a2Exp: a2Exp };
}

// ---------------------------------------------------------------------------
// Sun times (slots 29-30): computed here, formatted on the watch.
//
// The only displayed weather values the phone does not format: 12/24-hour is
// clock_is_24h_style(), which never leaves the watch, so they cross as int32
// epoch seconds (also cheaper than four 32-byte buffers). SunCalc is pure
// math over the location, so nothing is fetched for them.
// ---------------------------------------------------------------------------

// Epoch seconds, or 0 when the event does not occur.
//
// Above the Arctic Circle, which NWS covers in Alaska, SunCalc returns an
// Invalid Date during polar day and polar night. Its getTime() is NaN, which
// would marshal into the int32 tuple as garbage rather than as "no event".
function sunSec(d) {
  if (!d) return 0;
  var ms = d.getTime();
  return isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// SunCalc's "day" is anchored on local solar noon, not UTC: getTimes() at
// 19:30 local still returns that evening's sunset. Events it returns can
// therefore be in the past, and the scans walk forward until one is not.
// Day -1 serves nextGolden(), where a high-latitude window can be in progress
// across a solar-day boundary; nextDaylight() cannot use it, but one spare
// getTimes() call is not worth a second array.
//
// Six days forward because near a polar transition consecutive solar days
// skip the event entirely (up to 4.97 d to the next sunrise at Utqiagvik). A
// short scan fails silently: it returns 0 and the slot reads '--'. The scan
// is pure arithmetic, so the reach is close to free.
var SUN_DAYS = [-1, 0, 1, 2, 3, 4, 5, 6];

// The daylight window to show, as [sunrise, sunset] epoch seconds, taken as
// a pair from the first solar day whose sunset is still ahead. Resolving each
// to its own next occurrence would, once today's sunrise passes, pair
// tomorrow's sunrise with today's sunset and render a backwards span. A day
// in progress keeps its own sunrise; the slot rolls to tomorrow after sunset.
//
// Unlike nextGolden, no cross-day pairing is needed: SunCalc derives sunrise
// and sunset from one solve, so a solar day has both or neither. Both absent
// is polar day or polar night, which the watch renders as '--'.
function nextDaylight(lat, lon, nowSec) {
  for (var i = 0; i < SUN_DAYS.length; i++) {
    var t = SunCalc.getTimes(new Date((nowSec + SUN_DAYS[i] * 86400) * 1000),
                             lat, lon);
    var a = sunSec(t.sunrise), b = sunSec(t.sunset);
    if (a && b && b > a && b > nowSec) return [a, b];
  }
  return [0, 0];
}

// The golden hour window to show, as [start, end] epoch seconds.
//
// Built from boundaries rather than same-call pairs. The sun is golden
// between -0.833 deg (sunrise/sunset) and +6 deg, so a window opens at
// sunrise or goldenHour (the evening descent through 6 deg) and closes at
// goldenHourEnd (the morning climb through 6 deg) or sunset. Collect every
// valid boundary across the scan, sort by time, and the windows are the
// adjacent open->close pairs.
//
// Pairing within one getTimes() call blanks the slot for weeks at high
// latitudes inside NWS coverage, in two ways:
//
//   1. When the sun rises but never reaches 6 deg (Anchorage, Fairbanks),
//      both golden fields are Invalid while sunrise/sunset stay valid, yet
//      the whole short day is golden.
//   2. During polar day (Utqiagvik) sunrise/sunset are Invalid, and one
//      call's goldenHour and goldenHourEnd sit ~21 h apart in different
//      windows. The real window pairs goldenHour(d) with goldenHourEnd(d+1).
function nextGolden(lat, lon, nowSec) {
  var ev = [];
  for (var i = 0; i < SUN_DAYS.length; i++) {
    var t = SunCalc.getTimes(new Date((nowSec + SUN_DAYS[i] * 86400) * 1000),
                             lat, lon);
    var marks = [[sunSec(t.sunrise), 1], [sunSec(t.goldenHourEnd), 0],
                 [sunSec(t.goldenHour), 1], [sunSec(t.sunset), 0]];
    for (var j = 0; j < marks.length; j++) {
      // Third element is the scan day the boundary came from; see the
      // adjacency test below. 0 = the event does not occur.
      if (marks[j][0]) ev.push([marks[j][0], marks[j][1], i]);
    }
  }
  ev.sort(function (a, b) { return a[0] - b[0]; });
  // Ascending, so the first qualifying pair is the earliest window that has
  // not ended, and a window in progress stays on screen.
  //
  // The two boundaries must come from the same or an adjacent scan day.
  // Around |lat| 72.58 the midnight-sun minimum altitude drifts across +6 deg
  // mid-scan, so several consecutive days keep the sun above the golden band
  // all day and yield neither mark. Without the test a dangling goldenHour
  // pairs with a goldenHourEnd five or six days later, a multi-day "golden
  // hour" with the sun far above 6 deg.
  //
  // Adjacency is exactly the right bound: a normal window and the all-day
  // case close within their own day, and the polar-day window pairs
  // goldenHour(d) with goldenHourEnd(d+1). A +86400 s step advances SunCalc's
  // julianCycle by exactly 1, so the index difference is the solar-day
  // difference. Only the polar-day edge can strand an open. At the polar-night
  // edge sunrise and sunset come from one solve, so a day has both or neither
  // and self-closes.
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
// WX_TIME is the fetch time, not the assembly time. This payload is re-sent
// every heartbeat and replayed on 'ready' even when every fetch failed, so
// stamping 'now' would relabel hour-old data as fresh and the watch's 3-hour
// '--' guard could never fire. Only the observation and forecast feed
// fmt_wx's staleness check (alerts carry WX_EXP), so the stamp is the oldest
// fetch time among those two that a configured line displays: an
// unconfigured resource going stale in the cache must not blank fresh lines.
function assembleWx(lat, lon) {
  var nowSec = Math.floor(Date.now() / 1000);
  var tOldest = 0;   // ms; 0 = no timed resource contributed
  var pl = {
    'WX_COND': '', 'WX_FCST': '', 'WX_HILO': '',
    'WX_ALERT': '', 'WX_ALERT2': '',
    'WX_TEMP': '', 'WX_FEELS': '', 'WX_DEW': '', 'WX_HUM': '',
    'WX_WIND': '', 'WX_PRES': '', 'WX_FCST2': '',
    // Epoch seconds; 0 = no such event (polar day/night), which the watch
    // renders as '--'. Not strings — see the sun-times section above.
    'WX_SUNRISE': 0, 'WX_SUNSET': 0, 'WX_GOLD1': 0, 'WX_GOLD2': 0,
    'WX_EXP': 0, 'WX_EXP2': 0, 'WX_TIME': nowSec
  };

  // Each cache is read only when a configured line displays one of the
  // strings it feeds. The caches outlive a slot change (dropWxCaches runs
  // only on a location change or no-coverage), so without this a resource
  // cached under a previous config would ride every payload indefinitely.
  // Gate on slotsFrom('obs'), not slotsShowing('cond'): one observation
  // feeds seven strings.
  var obs = wxUses(slotsFrom('obs')) ? readWx('wx_obs') : null;
  if (obs) {
    // "{temp}° {description}"; either half may be missing. Both missing: send
    // nothing and let the watch render '--', the same contract WX_HILO uses
    // below. The no-data glyph is chosen in exactly one place, on the watch.
    var b = budgetFor(slotsShowing('cond'));
    var t = (obs.temp === null || obs.temp === undefined)
              ? '' : fmtTempFromC(obs.temp);
    var desc = obs.desc ? fitWx(obs.desc, t ? b - t.length - 1 : b) : '';
    pl['WX_COND'] = capBytes(t && desc ? t + ' ' + desc : (t || desc));

    // The six single-value strings below share that one cache read, so they
    // carry the same observation instant. They are built whether or not their
    // slot is configured: an unconfigured budget resolves to the 31-char
    // ceiling, and the extra keys cost ~130 B of the 8,200 B inbox, cheaper
    // than six more gates to keep in sync.
    // The one numeric string with no ladder: at most 5 characters ('-100°'),
    // it fits every budget but Super Large on gabbro's outer lines (3).
    if (isNum(obs.temp)) {
      pl['WX_TEMP'] = capBytes(fmtTempFromC(obs.temp));
    }
    // Feels Like takes heat index or wind chill only when it moves in that
    // correction's own direction, else the plain temperature. Testing
    // presence is the trap: NWS computes heatIndex unconditionally, and in
    // dry air it comes out below the air temperature (a Phoenix station at
    // 35.0 C reported 34.0 C), so a presence test would render 'Feels 93°'
    // beside a Temperature slot reading 95°.
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
      pl['WX_FEELS'] = capBytes(pickWx(['Feels ' + ft, 'Fls ' + ft, ft],
                                        budgetFor(slotsShowing('feels'))));
    }
    if (isNum(obs.dp)) {
      var dt = fmtTempFromC(obs.dp);
      pl['WX_DEW'] = capBytes(pickWx(['Dew ' + dt, 'D ' + dt, dt],
                                      budgetFor(slotsShowing('dew'))));
    }
    if (isNum(obs.rh)) {
      var rh = String(Math.round(obs.rh)) + '%';
      pl['WX_HUM'] = capBytes(pickWx(['Hum ' + rh, rh],
                                      budgetFor(slotsShowing('hum'))));
    }
    if (isNum(obs.ws)) {
      // km/h from the API either way. NWS windGust comes from the METAR G
      // group, coded only when the peak runs 10 kt (~18.5 km/h) above the
      // mean, so the 8 km/h margin below only matters for a non-METAR source.
      var metric = wxMetric();
      var spd = Math.round(metric ? obs.ws : obs.ws / 1.609344);
      var unit = metric ? ' km/h' : ' mph';
      var dir = isNum(obs.wd) ? compass(obs.wd) + ' ' : '';
      var gust = '';
      if (isNum(obs.wg) && obs.wg >= obs.ws + 8) {
        gust = ' G' + Math.round(metric ? obs.wg : obs.wg / 1.609344);
      }
      // Calm is its own word, not '0 mph' -- but only when nothing gusted.
      pl['WX_WIND'] = capBytes((spd === 0 && !gust) ? 'Calm'
        : pickWx([dir + spd + unit + gust, dir + spd + unit, dir + spd],
                 budgetFor(slotsShowing('wind'))));
    }
    if (isNum(obs.pr)) {
      // Pascals from the API. inHg keeps two decimals (the useful digits are
      // the last two); millibars are whole numbers.
      var pres = wxMetric() ? String(Math.round(obs.pr / 100)) + ' mb'
                            : (obs.pr / 3386.389).toFixed(2) + ' in';
      pl['WX_PRES'] = capBytes(pickWx([pres, pres.split(' ')[0]],
                                       budgetFor(slotsShowing('pres'))));
    }
    if (!tOldest || obs.t < tOldest) tOldest = obs.t;
  }

  // slotsFrom('fcst') is {16,17,20,28}, covering ALL THREE strings this block
  // emits (WX_FCST, WX_HILO and WX_FCST2), so one gate is enough for the set.
  var fc = wxUses(slotsFrom('fcst')) ? readWx('wx_fcst') : null;
  if (fc && fc.p && fc.p.length) {
    pl['WX_FCST'] = capBytes(fitWx(fc.p[0].s, budgetFor(slotsShowing('fcst')), true));
    // The second period, prefixed with its own NWS name when that fits:
    // 'Tonight: Mstly Cldy' says which half of the day it covers, where
    // 'Mstly Cldy' alone does not. Prose, so the inner fitWx truncation is
    // the right fallback and doubles as pickWx's last rung.
    if (fc.p.length >= 2) {
      var b2 = budgetFor(slotsShowing('fcst2'));
      var s2 = fitWx(fc.p[1].s, b2, true);
      var nm = fc.p[1].n;
      pl['WX_FCST2'] = capBytes(nm ? pickWx([nm + ': ' + s2, s2], b2) : s2);
    }
    // NWS can return a period with a null temperature; the observation path
    // guards this explicitly and slot 17 needs the same — suppress the
    // string (the watch renders '--') rather than send 'H NaN° L 73°'.
    if (fc.p.length >= 2 &&
        typeof fc.p[0].t === 'number' && typeof fc.p[1].t === 'number') {
      // Chronological order in both cases; the H/L labels carry the
      // disambiguation across the day/night boundary, so every value shown
      // keeps its label.
      //
      // Single letters; both alternatives were measured and rejected. The
      // Gothic fonts lack U+2191/2193 and U+25B2/25BC (missing-glyph boxes,
      // while '°' renders), and a custom font would cost six faces of app
      // heap for the size ladder. 'Hi'/'Lo' at 13 characters overruns
      // CHAR_BUDGET_144's Medium budget of 12 and falls to a shorter rung,
      // where this 11-character form fits. No gallery scenario covers that
      // case, so check any label change against the budget tables.
      var t0 = fmtTempFromF(fc.p[0].t);
      var t1 = fmtTempFromF(fc.p[1].t);
      var a0 = fc.p[0].d ? 'H' : 'L';
      var a1 = fc.p[0].d ? 'L' : 'H';
      var n0 = t0.replace('°', '');
      var n1 = t1.replace('°', '');
      // WX_HILO shows in slots 17 and 20, so it is width-fitted like every
      // other string — without a budget the auto-font XS rule could never
      // apply to it either. A ladder, not fitWx: a tail cut splits the second
      // number into a plausible wrong one ('H 82° L 6' at 9).
      pl['WX_HILO'] = capBytes(pickWx([
        a0 + ' ' + t0 + ' ' + a1 + ' ' + t1,   // H 82° L 64°
        a0 + t0 + ' ' + a1 + t1,               // H82° L64°
        a0 + n0 + ' ' + a1 + n1,               // H82 L64
        a0 + ' ' + t0,                         // H 82°
        a0 + n0                                // H82
      ], budgetFor(slotsShowing('hilo'))));
    }
    if (!tOldest || fc.t < tOldest) tOldest = fc.t;
  }

  // The slot half of fetchWeather's wantAlert, never wantPins: pins alone must
  // not put alert strings in the payload. slotsFrom('alerts') includes the
  // fallback slots, so they keep all of their inputs.
  var al = wxUses(slotsFrom('alerts')) ? readWx('wx_alerts') : null;
  if (al && al.f) {
    var r = buildAlertStrings(al.f, nowSec);
    pl['WX_ALERT']  = capBytes(r.a);
    pl['WX_EXP']    = r.aExp;
    pl['WX_ALERT2'] = capBytes(r.a2);
    pl['WX_EXP2']   = r.a2Exp;
  }
  // Sun times do not fold into tOldest: WX_TIME drives fmt_wx's 3-hour
  // staleness blanking, which is about data going out of date, and the watch
  // tests these instants against its own clock instead.
  if (wxUses(slotsFrom('sun')) && isNum(lat) && isNum(lon)) {
    var day = nextDaylight(lat, lon, nowSec);
    pl['WX_SUNRISE'] = day[0];
    pl['WX_SUNSET']  = day[1];
    var gold = nextGolden(lat, lon, nowSec);
    pl['WX_GOLD1'] = gold[0];
    pl['WX_GOLD2'] = gold[1];
  }
  if (tOldest) pl['WX_TIME'] = Math.floor(tOldest / 1000);
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
  // The alert list has two consumers, the watch's alert slots and timeline
  // pins, but wantWx alone decides whether anything is sent (see done()).
  // That separation keeps pins-on from changing a byte of what the watch
  // receives when no weather slot is configured.
  var wantWx = wxNeeded();
  var wantPins = timelineAlerts();
  if (!wantWx && !wantPins) return;
  var lkey = lat.toFixed(2) + ',' + lon.toFixed(2);

  // The per-resource caches are for a PLACE as well as a time (wx_grid keys
  // itself; these three do not): after a flight, yesterday's city's forecast
  // is only 20 minutes old, so the time gate alone would show its H/L here
  // for up to another hour. A new rounded location drops all three — alerts
  // included, since rendering an alert from 2,500 km away if this beat's
  // fetch fails is worse than rendering none.
  //
  // This runs BEFORE the no-coverage check, and must. markNoCoverage() drops
  // the caches when it latches, but a later visit to a covered place refills
  // them while the latch survives — so an uncovered location reached from a
  // covered one would otherwise assemble the PREVIOUS place's weather and
  // re-send it every heartbeat. The latch is keyed on 2-decimal lat/lon
  // (~1.1 km), so that is a short hop across a coverage edge, not a flight.
  if (localStorage.getItem('wx_lkey') !== lkey) {
    dropWxCaches();
    try { localStorage.setItem('wx_lkey', lkey); } catch (e) {}
  }

  if (localStorage.getItem('wx_nocov') === lkey) {
    // Sun times are astronomy, as correct outside NWS coverage as inside it,
    // so a configured sun slot still gets its payload. Every weather string
    // assembles empty: the caches belong to this place, and nothing refills
    // them here.
    if (wxUses(slotsFrom('sun'))) sendWx(assembleWx(lat, lon));
    return;
  }

  // The fallback slots need two resources each: 20 = alerts + forecast,
  // 21 and 31 = alerts + observation.
  var wantObs   = wxUses(slotsFrom('obs'));
  var wantFcst  = wxUses(slotsFrom('fcst'));
  // ORed, not duplicated: one /alerts/active request serves both consumers,
  // so a configured alert slot plus pins-on does not double-request.
  var wantAlert = wxUses(slotsFrom('alerts')) || wantPins;

  var now = Date.now();
  var obs = readWx('wx_obs');
  var fcst = readWx('wx_fcst');
  // One minute of slack on the interval gates: the caches stamp t when the
  // RESPONSE lands, a fetch latency after the minute-aligned heartbeat that
  // started it, so a strict >= test comes up a hair short on every following
  // eligible beat and each resource refetches at DOUBLE its interval plus a
  // beat (observation every 20 min, forecast every 70). The slack absorbs
  // the latency without letting an off-cycle call (webviewclosed) refetch
  // early against the server's own max-age.
  // `obs.dp === undefined` refetches, once and regardless of age, the
  // {t, temp, desc} blob the published 1.0.0 build wrote. Otherwise an
  // upgrading user who configures Dew Point, Humidity, Wind or Pressure sees
  // them sit on '--' for up to nine minutes behind a closed interval gate
  // while Conditions and Temperature render. obsRecord() always writes dp
  // (null when the station drops it), so this fires at most once per install.
  var needObs  = wantObs  && (!obs  || obs.dp === undefined ||
                              now - obs.t  >=  9 * 60 * 1000);
  var needFcst = wantFcst && (!fcst || now - fcst.t >= 59 * 60 * 1000);
  // Alerts go every heartbeat (server max-age=5): no interval check.

  var pending = 1;   // sentinel: done() cannot fire before all branches start
  function done() {
    // wantWx, not `pending === 0` alone: with only pins enabled this fires
    // with every cache read in assembleWx() gated off, and the all-empty
    // payload would clobber wx_payload and enqueue a new AppMessage. main.c
    // accepts it on WX_TIME's mere presence and blanks every weather buffer,
    // invisibly in a screenshot. assembleWx's own alert gate is the second
    // barrier.
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
  var zoom = numSetting('Zoom', 1, 0, 2);

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
  // the cached one means the map has moved (or zoomed, or was never fetched):
  // the cached basemap is for somewhere else and must be refetched, not
  // blended with radar for a different place.
  // 'v3': cache holds 16-color transcoded bytes, and the key carries the image
  // size -- the same phone paired to a second watch must not reuse a basemap
  // rendered for the first one's display.
  var key = 'v3_' + IMG_W + 'x' + IMG_H + '_' +
            zoom + '_' + lat.toFixed(2) + '_' + lon.toFixed(2);

  var newArea = (key !== localStorage.getItem('bm_key'));

  resetTransfers(newArea);
  var g = gen;

  // needImage is set on 'ready' (a relaunch) and when the watch sends 2 (no
  // frame, a failed decode, a dropped transfer). Everything below is seconds
  // away at best and unbounded when the phone has no signal, so answer from
  // the replay cache first.
  if (needImage) {
    // Anything delivered BEFORE the watch told us it was frameless no longer
    // describes it, so deliveredHash starts empty and is re-earned by the
    // replay's own ACK. Without this the skip in composeAndSend could suppress
    // the one transfer that would have filled an empty face -- in the narrow
    // case where the replay could not run (no blob, or a bbox that moved) and
    // pkjs happened to outlive the watchface.
    deliveredHash = null;
    replayComposite(key);
  }

  // Tell the watch where it is (degrees x100, integers) for the Lat/Long
  // slot. Queued as a msg item: a bare sendAppMessage here would race with
  // in-flight image chunks.
  enqueue({ kind: 'msg', dict: {
    'Lat': Math.round(lat * 100),
    'Lon': Math.round(lon * 100)
  } });

  // Both layers are inputs to one blend, so they have to JOIN before anything
  // can be sent. `want` is 1 when radar is Disabled — there is no second
  // fetch, and buildComposite reads a null radar buffer as "every pixel has
  // alpha 0", i.e. a pass-through basemap.
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
    composeAndSend(bmRgba, rdRgba, mode, needImage);
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

  // Radar is always re-fetched — it is small and time-sensitive — unless
  // the user disabled the layer entirely.
  if (mode !== 0) {
    fetchPng(exportUrl(RADAR_URL, bbox, true), function (bytes) {
      if (g !== gen) return;   // superseded by a newer location
      part(1, bytes ? rgbaOf(bytes) : null);
    });
  }

  // Weather rides the same heartbeat that got us here (RefreshInterval,
  // default 10 min) — no timer of its own, and it keeps working when the radar
  // layer is Disabled (that only suppresses the radar fetch above, not the
  // request).
  lastLat = lat;
  lastLon = lon;
  fetchWeather(lat, lon);
}

// Blend, hash, and either transfer or skip. Called once per pass, only when
// every input arrived.
function composeAndSend(bmRgba, rdRgba, mode, needImage) {
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
  // pendingHash and deliveredHash both skip even when needImage is set.
  // needImage bypasses the COMMITTED cache -- the watch says it has no frame,
  // so what we believe it once displayed proves nothing -- but these two say
  // something tx_hash cannot: that THIS pass has already queued (pending) or
  // landed (delivered) these exact bytes on that same frameless watch, which
  // makes sending them again pure duplication. Both arms are needed because
  // which one is true is a race: a replay that ACKs before the fetch returns
  // has already cleared pendingHash by the time we get here.
  //
  // It is safe to be this strict only because replayComposite() answers a
  // frameless watch with real bytes rather than a skip -- the pair is what
  // guarantees a frame still arrives. Do not tighten one without the other.
  if (h === pendingHash || h === deliveredHash || (!needImage && h === committed)) {
    // The pending arm logs distinctly: it means something different about
    // what the watch is showing, and the log line is the cache's only
    // instrument.
    console.log('Composite unchanged, skipping transfer' +
                (h === pendingHash ? ' (already in flight)' : ''));
    // Stamp the radar time only when nothing identical is pending, i.e. on a
    // committed or delivered match: both rest on an ACK, so the watch is known
    // to display these bytes. A pendingHash match is merely queued or in
    // flight; the watch still shows the previous frame (or none), and dating
    // it now would misdate a frame that may never be drawn. The pending item's
    // own onAck carries the correct stamp and fires only if it lands. After a
    // replay the age therefore reads from the replayed frame's fetch until the
    // next heartbeat re-stamps it, stale-side by design.
    if (h !== pendingHash) {
      enqueue({ kind: 'msg', dict: { 'RADAR_TIME': radarStamp(mode) } });
    }
    return;
  }
  pendingHash = h;
  enqueue({ kind: 'img', bytes: r.bytes, hash: h, radarTime: radarStamp(mode) });
}

// When pkjs fetched the radar layer this composite was built from, in unix
// seconds. Not a decode time: the transfer cache skips unchanged composites,
// so a decode is not a reliable Radar Age heartbeat. 0 = the layer is
// Disabled, which the watch renders as 'no radar'.
function radarStamp(mode) {
  return (mode === 0) ? 0 : Math.floor(Date.now() / 1000);
}

function getLocation(needImage) {
  // A manual location bypasses geolocation entirely — no permission prompt,
  // and it keeps working when the phone's location services are off. It flows
  // through the same locationSuccess as a GPS fix, so the map, the weather,
  // and the watch's Lat/Long slot all follow it with no further plumbing.
  var m = manualLocation();
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
// Pebble events
// ---------------------------------------------------------------------------

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  // convert=false: the default conversion re-keys everything by NUMERIC
  // message-key id, so d.TopSlot & co. would all be undefined -> NaN.
  var d = clay.getSettings(e.response, false);
  // TopSlot/TopFont drive Top Line 2 and BottomSlot/BottomFont drive Bottom
  // Line 1. The names are historical; renaming a Clay messageKey resets every
  // saved config.
  var s = {
    'TopSlot1': Number(d.TopSlot1.value),
    'TopFont1': Number(d.TopFont1.value),
    'TopSlot': Number(d.TopSlot.value),
    'TopFont': Number(d.TopFont.value),
    'BottomSlot': Number(d.BottomSlot.value),
    'BottomFont': Number(d.BottomFont.value),
    'BottomSlot2': Number(d.BottomSlot2.value),
    'BottomFont2': Number(d.BottomFont2.value),
    // Watch-bound, unlike Zoom: the watch's tick_handler owns the heartbeat
    // cadence, so the minutes value has to reach it (and replay from cfg2 on
    // 'ready' like every other watch key).
    'RefreshInterval': Number(d.RefreshInterval.value),
    // Guarded like UseGps rather than dereferenced like the older keys: a
    // response from a config page that predates this toggle has no such
    // field, and absent must read as on (the default), not 0.
    'BtIndicator': (d.BtIndicator && !Number(d.BtIndicator.value)) ? 0 : 1,
    // Clay color pickers store the chosen color as an 0xRRGGBB number; the
    // watch quantizes to GColor8 with GColorFromHEX.
    'TextColor': Number(d.TextColor.value),
    'OutlineColor': Number(d.OutlineColor.value)
  };
  // Zoom, RadarMode, UseGps/ManualLoc, WxUnits and TimelineAlerts are
  // phone-side only: never forwarded to the watch, persisted here under their
  // own keys.
  var zoom = Number(d.Zoom.value);
  var zoomChanged = String(zoom) !== localStorage.getItem('Zoom');
  localStorage.setItem('Zoom', String(zoom));
  // The config page refuses to save with the GPS toggle off and an
  // unparsable box (custom-clay.js disables Save), so a pair that fails to
  // parse here is a stale or hand-built response: fall back to GPS rather
  // than guess. Persisted under the single key manualLocation() reads:
  // '' = GPS.
  var mloc = (d.UseGps && !Number(d.UseGps.value))
               ? parseManualLoc(d.ManualLoc && d.ManualLoc.value)
               : null;
  var manual = mloc ? mloc.lat + ',' + mloc.lon : '';
  var locChanged = manual !== (localStorage.getItem('ManualLoc') || '');
  localStorage.setItem('ManualLoc', manual);
  var radar = Number(d.RadarMode.value);
  var radarChanged = String(radar) !== localStorage.getItem('RadarMode');
  localStorage.setItem('RadarMode', String(radar));
  // A units change drops the cached payload and backdates the per-resource
  // stamps so the interval gates open. The entries are kept, since they hold
  // unit-agnostic numbers, so a failed refetch still shows data. t = 1, not
  // 0: assembleWx folds the oldest stamp with `!tOldest || ...`, and a falsy
  // 0 would be skipped, stamping stale data with `now` so the watch's 3-hour
  // '--' guard could never fire.
  var wxUnits = String(Number(d.WxUnits.value));
  var unitsChanged = wxUnits !== (localStorage.getItem('WxUnits') || '0');
  localStorage.setItem('WxUnits', wxUnits);
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
  // Compared against the SAME default numSetting uses, so a fresh install
  // saving the toggle in its default position does not read as a change.
  var pinsChanged = pins !== (localStorage.getItem('TimelineAlerts') || '1');
  localStorage.setItem('TimelineAlerts', pins);
  if (pinsChanged && pins === '0') {
    // Turning it off forgets what was pushed, so turning it back on re-pushes
    // the alerts still in force — the user may have swiped those pins away.
    // Idempotent per id — inserting an existing id updates that pin rather than
    // creating a second one, so the cost is a handful of inserts.
    localStorage.removeItem('tl_pins');
    tlState = null;
  }
  // The link is usually busy right after the webview closes; a silently NACKed
  // settings message would leave the watch's persisted copy diverged forever,
  // so keep a copy to replay on the next 'ready' and send through the queue,
  // never a bare sendAppMessage, which would race the imagery the branches
  // below kick off.
  // 'cfg2', not 'cfg': this blob is replayed verbatim on 'ready', and an old
  // 'cfg' blob still carries RadarMode, which is not a declared messageKey, so
  // replaying it would send an unknown key. Renaming the storage key retires
  // every stale blob.
  localStorage.setItem('cfg2', JSON.stringify(s));
  enqueue({ kind: 'msg', dict: s });
  if (zoomChanged || locChanged) {
    getLocation(true);   // new bbox: the composite must be re-rendered
  } else if (radarChanged) {
    // The blend happens here, so any mode change, including to Disabled,
    // needs a fresh composite.
    clearTxHash();
    getLocation(false);
  } else if (wxNeeded() || pinsChanged) {
    // No imagery to redo, but the weather config may have changed (units, or
    // a weather slot newly assigned): refresh from the last fix. The paths
    // above reach fetchWeather through locationSuccess anyway.
    // `|| pinsChanged` so turning pins on takes effect now rather than at the
    // next heartbeat — up to a full hour at RefreshInterval 60, which reads as
    // a broken toggle. fetchWeather self-gates, so turning pins OFF through
    // this arm is a no-op fetch that sends nothing.
    if (lastLat !== null) {
      fetchWeather(lastLat, lastLon);
    } else if (wxNeeded()) {
      // Settings saved before the first fix resolved (cold GPS): there is no
      // last fix, and a units change just deleted wx_payload, so doing nothing
      // would leave the old units on screen until the next heartbeat. Resolve
      // a fix; weather rides along in locationSuccess.
      //
      // wxNeeded(), not pinsChanged: 'ready' already issued getLocation, which
      // has no in-flight guard, so a second call runs the whole imagery pass
      // twice when the fix lands. A pins-only change has nothing on the watch
      // to redo and must not change what the watch receives, so it waits for
      // the heartbeat.
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
  // persisted settings diverged forever.
  var cfg = localStorage.getItem('cfg2');
  if (cfg) {
    try { enqueue({ kind: 'msg', dict: JSON.parse(cfg) }); } catch (e) {}
  }
  // Replay the last weather payload (same pattern as cfg2): the watch does not
  // persist weather, and a fresh pass waits on a location fix and the network.
  // WX_TIME rides along unchanged, so hour-old data still reads as hour-old.
  var wxp = localStorage.getItem('wx_payload');
  if (wxp && wxNeeded()) {
    try { enqueue({ kind: 'msg', dict: JSON.parse(wxp) }); } catch (e) {}
  }
  // The phone cannot tell whether the relaunched watch restored a persisted
  // frame (emery/gabbro only), so it bypasses the committed transfer cache.
  getLocation(true);
});

Pebble.addEventListener('appmessage', function (e) {
  // The outer test is truthiness, which is why the watch's flag is 2/1 and
  // never 0: a 0 would be silently ignored here and the heartbeat would die.
  // 2 = "I need a frame" -> bypass the committed transfer cache.
  if (e.payload['REQUEST_IMAGES']) {
    getLocation(e.payload['REQUEST_IMAGES'] === 2);
  }
});

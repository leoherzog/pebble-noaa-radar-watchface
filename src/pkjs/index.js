/**
 * NOAA US Weather Radar — PebbleKit JS
 *
 * Fetches a USGS Topo basemap and the NOAA MRMS base reflectivity overlay
 * for the user's location, both as PNG8 at the connected watch's display size,
 * BLENDS them here into a single 16-color image, and streams that one PNG to
 * the watch in AppMessage chunks. The watch just draws it.
 *
 * Compositing on the phone is what lets the watch hold ONE full-screen frame
 * instead of two: peak heap during a decode drops from ~3.5x a frame to ~2.5x.
 * The blend itself, the tier-aware palette fold and the hand-rolled 4bpp PNG
 * encoder all live in composite.js.
 *
 * A content hash of the emitted PNG suppresses the transfer entirely when the
 * watch already holds a byte-identical image — in clear weather the composite
 * is the same run to run, so nothing goes over the air.
 *
 * All floating point (Web Mercator bbox math, the blend) lives here; the watch
 * only ever sees bytes and integers.
 */

// Import the Clay package
var Clay = require('@rebble/clay');
// PNG transcoder: the watch cannot decode the 256-color PNGs the government
// servers send (the on-watch decoder needs ~2x the 8bpp output bitmap, which
// on emery alone would be 45,600 B against a 128 KB heap -- and basalt has
// half that), so every image is re-encoded here to a 16-color 4-bit PNG.
// This now runs on the two INPUTS to the blend rather than on what ships:
// measured, blending the 256-color originals yields 37-42 output colors
// instead of 19-29, no byte saving, and a visibly muddy result. Quantizing
// each layer first is load-bearing, not a leftover.
var UPNG = require('upng-js');
// The blend, the palette fold and the 4bpp PNG encoder. Kept in its own
// module so it stays pure arithmetic over typed arrays (no Pebble APIs, no
// localStorage) and can be exercised offline against frozen source imagery.
var composite = require('./composite');
// Severe-alert filtering, pin id derivation, pin JSON and the dedupe
// bookkeeping. Its own module for the same reason composite.js is: it stays
// pure (no Pebble APIs, no localStorage, no module state) so a node harness
// can exercise the id/duration/truncation rules offline. Nothing here is
// optional -- webpack builds the bundle from THIS file's require graph, and
// an un-required src/pkjs/*.js compiles to nothing at all.
var timeline = require('./timeline');
// Load our Clay configuration file
var clayConfig = require('./config');
// Config-page logic (show/hide the manual-location input, block an invalid
// save). Injected into the page by toString(), so it shares no scope with
// this file.
var customClay = require('./custom-clay');
// Initialize Clay (autoHandleEvents off: we persist locally and re-fetch)
var clay = new Clay(clayConfig, customClay, { autoHandleEvents: false });

var BASEMAP_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/export';
var RADAR_URL = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer/export';

var ZOOM_WIDTHS = [100000, 250000, 500000];   // City, State, Region (meters)

// Both layers are drawn into the watch's full bounds, so they have to be
// requested at exactly the display's size or the firmware scales them and the
// map goes soft. Defaults are emery's; 'ready' narrows them to the watch
// actually connected.
// One row per targetPlatforms entry in package.json — getActiveWatchInfo can
// only ever report a platform this .pbw was built for, and a row for a
// platform the watch-side heap guard would refuse is worse than absent.
// Adding a platform means adding both. chalk is deliberately in neither: it
// is the one round platform that does NOT fit (see CLAUDE.md, Platform
// portability).
var PLATFORM_SIZES = {
  basalt:  [144, 168],
  emery:   [200, 228],
  gabbro:  [260, 260]
};
var IMG_W = 200;
var IMG_H = 228;

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

// 0 Disabled, 1 Translucent, 2 Opaque. Phone-side only now, like Zoom and
// WxUnits: the watch no longer composites, so it has no use for the mode.
// Without the explicit default, a fresh install would read as Disabled and
// ship a basemap with no weather on it.
function radarMode() {
  return numSetting('RadarMode', 1, 0, 2);
}

// Push NWS severe-weather alerts into the Pebble timeline as pins. Phone-side
// only, like RadarMode: the insert happens here and the watch never learns the
// setting exists, so its heap cost is exactly zero. Defaults ON, and the
// default MUST come from numSetting's explicit branch — the key is null on a
// fresh install and Number(null) is 0, which a plain clamp would silently
// accept as "off". (Do not copy wxCelsius()'s `=== '1'` idiom: that is a
// default-OFF read and would invert this.)
function timelineAlerts() {
  return numSetting('TimelineAlerts', 1, 0, 1) === 1;
}

// `tl_pins` is the persisted "the timeline already holds these bytes" record,
// the same idea as tx_hash. It needs no in-memory companion the way tx_hash
// needs pendingHash: insertion is SYNCHRONOUS, so the commit lands before the
// duplicated heartbeat that would otherwise re-derive the same candidates
// (QEMU delivers each REQUEST_IMAGES up to three times, plus the off-cadence
// passes main.c:1116 and main.c:1142 add). An asynchronous delivery route
// would need that second record back.
var tlState = null;        // parsed tl_pins map, lazily loaded

function tlLoadState() {
  if (tlState) return tlState;
  var s = localStorage.getItem('tl_pins');
  if (s) { try { tlState = JSON.parse(s); } catch (e) { tlState = null; } }
  if (!tlState || typeof tlState !== 'object') tlState = {};
  return tlState;
}

function tlSaveState() {
  // Nothing to write once webviewclosed has cleared the map: a PUT that was
  // already on the wire when the user turned the setting off lands here with
  // tlState null, and JSON.stringify(null) is the string "null" — which would
  // resurrect the very key the toggle just removed. (It self-heals on the next
  // load, but "THE ONE EXPLICIT CLEAR" has to actually hold.)
  if (!tlState) return;
  // Same swallow-and-log policy as writeWx: this cache shares a localStorage
  // with two base64 PNGs (bm_data, tx_replay), and a quota throw here must
  // never escape into the alert path.
  try { localStorage.setItem('tl_pins', JSON.stringify(tlState)); }
  catch (e) { console.log('TL state write failed: ' + e); }
}

// Local pins, and only local pins. Pebble.insertTimelinePin() builds the pin on
// the phone and syncs it to the watch with no service in the loop, so it needs
// no timeline token, no API key and NO APPSTORE LISTING — that last clause is
// the only reason this feature works at all on a face that is still
// unpublished, because getTimelineToken() has nothing to return for an app the
// appstore has never seen.
//
// The timeline web API is deliberately NOT kept as a fallback. The new Pebble
// app does not support it at all; what it does is intercept its own JS's XHRs
// to timeline-api.{rebble.io,getpebble.com}/v1/user/pins and turn them into
// local pins — a shim the user can switch off ('Emulate Timeline Webservice'),
// and one the docs tell new code not to lean on. A runtime that lacks
// insertTimelinePin (an old pkjs, or Rebble's own app, where a real service
// still exists) therefore gets NO pins: the feature no-ops rather than carrying
// a second delivery path with its own token lifecycle, 410 latch and HTTP
// status ladder that this project has no way to exercise.
//
// insertTimelinePin reports NOTHING — no callback, no status, no throw on a
// rejected pin — so a commit here means "did not throw", which is weaker than
// the HTTP 200 the web API gave. Committing on it anyway is deliberate: the
// alternative, never committing, would re-insert every tracked pin on every
// heartbeat forever.

// Push whatever this fetch's alert list implies. Called only from the tail of
// fetchAlerts' success branch, only when the setting is on, and only AFTER the
// fetchWeather sentinel has been released — so nothing here can stall, delay
// or alter the AppMessage the watch receives.
function pushTimelinePins(features) {
  var nowSec = Math.floor(Date.now() / 1000);
  var st = tlLoadState();
  var plan = timeline.planPins(features, st, nowSec);
  tlState = plan.state;
  tlSaveState();          // persists the GC and the first-seen anchors

  // The no-VTEC skip is silent by construction — planPins just drops the
  // feature — so without this count a future NWS product that is Severe with
  // no VTEC parameter would never be pinned and nothing would ever say so.
  // Measured 0 of 3,177 today; if it is ever non-zero in the field, revisit the
  // decision rather than bolting on an unstable fallback id. Counted here from
  // the module's own pure exports so planPins keeps its two-field contract.
  var noVtec = 0, tracked = 0, i, k;
  for (i = 0; i < features.length; i++) {
    var pr = features[i] && features[i].properties;
    if (timeline.isSevere(pr) && !timeline.pinIdFor(pr, nowSec)) noVtec++;
  }
  for (k in tlState) { if (tlState.hasOwnProperty(k)) tracked++; }
  // Logged on every fetch, including the zero case, at the same density as
  // 'Composite unchanged, skipping transfer': in clear weather this line is the
  // ONLY evidence the feature is running at all, and a broken read of the
  // setting would otherwise look exactly like a quiet sky.
  console.log('TL ' + plan.puts.length + ' pin(s) to push, ' + tracked +
              ' tracked' + (noVtec ? ', ' + noVtec + ' skipped with no VTEC key' : ''));

  if (!plan.puts.length) return;
  if (typeof Pebble.insertTimelinePin !== 'function') {
    // Not an error state: a runtime with no local-pin support simply never
    // shows pins. Logged once per fetch alongside the plan line above so the
    // reason is visible rather than looking like a quiet sky.
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

var CHUNK = 4096;      // the inbox is 8200 B on all three platforms; the
                       // header tuples add ~50 B
// The single-slot serialiser carries two kinds of work, dispatched on `kind`:
//   {kind: 'img', bytes, hash, radarTime}  — chunked transfer of the composite
//   {kind: 'msg', dict: {...}}             — one whole AppMessage
// The chunked protocol depends on strictly ordered ACKs, and firing an
// unrelated sendAppMessage mid-transfer risks a NACK on the chunk in flight,
// so weather payloads and the Lat/Lon fix go through this same queue.
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
// Hash of a composite actually delivered and ACKed SINCE the watch last said
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
// EVERY dispatch, retries included: without a fresh t.pending the ACK cannot
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
  // The final chunk's ACK is the COMMIT POINT, and it comes after tx is
  // cleared: the enqueue below pumps, and a still-set tx would make that pump
  // a no-op and strand the RADAR_TIME message.
  if (t.kind === 'img') {
    // Only here, never at enqueue time: a transfer that dies halfway must not
    // poison the cache into skipping forever.
    try { localStorage.setItem('tx_hash', t.hash); } catch (e) {}
    deliveredHash = t.hash;
    // Keep the bytes too, so a relaunched watch can be filled from here rather
    // than from a fix, a fetch and a blend (see replayComposite). Written at
    // the same commit point and under the same rule as the hash above.
    // ONE key, holding key+hash+stamp+bytes together: a replay is only correct
    // if all four agree, and separate keys could be left disagreeing by a
    // partial write. A setItem that throws (quota) therefore leaves the
    // previous, still self-consistent, blob in place rather than a mixture.
    // bm_key is the composite's own bbox key here: resetTransfers() drops an
    // in-flight img when the area moves, and the t !== tx guard above means
    // this ACK cannot run for a transfer that was dropped.
    // replayHash, not tx_hash, decides whether the blob needs rewriting: the
    // two are NOT interchangeable. tx_hash survives a pkjs restart, so testing
    // against it would skip the write whenever the watch was already holding
    // these bytes -- which is the common case, and would leave the blob absent
    // or stale forever. Set only after the write succeeds, so a quota failure
    // is retried on the next commit.
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

// newArea: the bbox moved, so everything queued or in flight is imagery for the
// wrong place. There is only one image class now, and a composite mid-transfer
// is superseded by the one this pass is about to build, so any img item is
// dropped either way.
// Only IMAGE items are ever dropped: a weather payload is not invalidated by
// the bbox moving (it is for the same rounded location), and dropping it
// would silently lose an alert update.
// The in-flight item is judged by the same test as the queued ones; the
// t !== tx guards in the send path make abandoning it safe.
function resetTransfers(newArea) {
  if (newArea) gen++;
  var dropped = false;
  queue = queue.filter(function (q) {
    if (q.kind === 'img') { dropped = true; return false; }
    return true;
  });
  if (tx && tx.kind === 'img') { tx = null; dropped = true; }
  // Clear the cache only when the watch's resident image actually became
  // indeterminate. This runs on EVERY heartbeat, and an unconditional clear
  // would mean the cache never skips anything.
  if (dropped || newArea) clearTxHash();
}

// Forget which composite the watch is believed to hold, so the next one is
// sent unconditionally.
function clearTxHash() {
  pendingHash = null;
  try { localStorage.removeItem('tx_hash'); } catch (e) {}
  // tx_replay is deliberately NOT dropped here. tx_hash means "the watch is
  // displaying these bytes", which is what became unknown; tx_replay means
  // "this is the last composite we know landed, for bbox k", which is still
  // true — and its key gate, not this flag, is what makes replaying it safe.
}

// Fill a watch that has no frame from the last composite we delivered, instead
// of leaving it grey for the whole fetch -> blend -> transfer round trip that
// the caller is about to start. (Not the location fix: this runs from
// locationSuccess(), so the fix has already completed and its latency -- up to
// the 15 s getCurrentPosition timeout -- is NOT covered.) The real pass still
// runs behind this and either hashes equal (and is skipped) or supersedes this
// frame.
//
// Two rules keep it honest. It replays only a composite built for THIS bbox --
// a move or a zoom change finds no match and the face stays grey exactly as it
// does today, rather than showing the wrong place. And it re-sends the stored
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

// Quantize a fetched layer to 16 colors. Applied to BOTH blend inputs, even
// though the composite is what ships — see the UPNG require at the top of this
// file for the measurement that makes that load-bearing. This is also what the
// basemap cache stores.
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

// cb(bytes) on success, cb(null) on ANY failure. The explicit failure signal
// is new and load-bearing: the two layers used to transfer independently, so a
// callback that never fired just meant one layer did not refresh. They now
// have to JOIN before anything can be sent, and a join with a callback that
// never fires is a leak, not a decision.
function fetchPng(url, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.responseType = 'arraybuffer';
  xhr.timeout = 20000;
  xhr.onload = function () {
    // Read xhr.response EXACTLY ONCE. The pkjs bridge hands back a real
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
      // No "send as-is" fallback any more: these bytes never reach the watch,
      // and compositing a 256-color input is exactly the muddy case the
      // quantize step exists to prevent. Skip the update instead.
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
// Weather (slots 15-21) — NWS JSON API, api.weather.gov. No key, no provider.
// Every string is assembled, unit-converted, abbreviated and width-fitted
// here; the watch receives finished strings and two expiry timestamps.
// ---------------------------------------------------------------------------

var WX_BASE = 'https://api.weather.gov';

// Which WX_* string each weather slot code displays. This is the ONE place a
// weather slot is registered: WX_SLOTS, the per-string width budgets, and the
// per-resource fetch gates are all derived from it below. These used to be
// eleven hand-synced literal arrays, and the drift failure mode was silent --
// a code missing from a fetch gate stopped the resource being fetched while
// assembleWx went on trying to build a string out of it.
var WX_SLOT_STRINGS = {
  15: ['cond'],   16: ['fcst'],           17: ['hilo'],
  18: ['alert'],  19: ['alert2'],
  20: ['alert', 'hilo'],                  // alert, else high/low
  21: ['alert', 'cond']                   // alert, else current conditions
};

// Which fetched resource feeds each string.
var WX_STRING_SOURCE = {
  cond: 'obs', fcst: 'fcst', hilo: 'fcst', alert: 'alerts', alert2: 'alerts'
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

// [slotCode, fontIdx] for each of the four lines, from the persisted config.
// The parse is guarded (a truncated cfg blob from an interrupted write must
// not throw out of 'ready' and take the imagery fetch down with the weather):
// no cfg, or a bad one, reads as "no lines configured".
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
// weather-related unless this holds — but it is NOT the whole gate on touching
// NWS: with timeline pins on (the default) fetchWeather still fetches
// /alerts/active every heartbeat with no weather slot configured. See the
// wantWx/wantPins split in fetchWeather.
function wxNeeded() {
  return wxUses(WX_SLOTS);
}

// Chars that fit, indexed [fontIdx = XS..XL]. Estimates, deliberately a
// little wide — fitWx() truncates and the watch-side ellipsis is the safety
// net (see fitWx, below).
var CHAR_BUDGET_144 = [18, 16, 12, 10, 7];
var CHAR_BUDGET_200 = [25, 22, 16, 14, 10];

// The budget is per STRING, not per slot code: the two fallback slots (20/21)
// feed off strings they do not name, so each string takes the minimum budget
// among the union of lines that could display it.
//
// Auto font sizes (font values 5-9; see CLAUDE.md "Text slot layout"): when ANY line
// displaying the string is auto, target the Extra Small row instead --
// minimal abbreviation, maximum information, and the watch picks the largest
// size that fits it. Abbreviating to the ceiling's budget would mean the
// string always fits at the ceiling and the shrink never fires (`86° Ptly
// Cl…` at Large when `86° Partly Cloudy` at Medium was available). The
// 31-char cap still applies (the Math.min below, and capBytes).
function budgetFor(codes) {
  var table = IMG_W >= 180 ? CHAR_BUDGET_200 : CHAR_BUDGET_144;
  var best = 31;
  var anyAuto = false;
  wxLines().forEach(function (l) {
    if (codes.indexOf(l[0]) >= 0) {
      var f = l[1];
      if (f >= 5) { anyAuto = true; return; }
      if (!(f >= 0 && f <= 4)) f = 2;
      if (table[f] < best) best = table[f];
    }
  });
  if (anyAuto) return Math.min(table[0], 31);
  return best;
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
// splitThen adds a stage 2.5 for slot 16: keep only the text before the first
// `then` (a '/' after stage 2) when the whole thing still does not fit —
// `Mstly Cldy` is more useful than `Mstly Cldy/Chc Sh…`.
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

// Cap every outgoing string at 31 chars + NUL, matching the watch-side
// buffers — in BYTES, because '°' is two bytes of UTF-8 and a string cut
// mid-sequence would render as garbage.
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
function wxCelsius() { return localStorage.getItem('WxUnits') === '1'; }

function fmtTempFromC(c) {
  return String(Math.round(wxCelsius() ? c : c * 9 / 5 + 32)) + '°';
}

function fmtTempFromF(f) {
  return String(Math.round(wxCelsius() ? (f - 32) * 5 / 9 : f)) + '°';
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

// Evict the three per-PLACE resource caches. One site, so a fourth such cache
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
// a usable ArrayBuffer only on the FIRST read of .response (see fetchPng);
// responseText has no such hazard. A JSON.parse failure is caught here, per
// resource, so one bad body cannot take down the other resources.
function fetchJson(url, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.timeout = 20000;
  xhr.setRequestHeader('Accept', 'application/geo+json');
  // A no-op in some runtimes; harmless. api.weather.gov 403s an EMPTY UA,
  // and the pkjs runtime sends its own non-empty one, so this is belt and
  // braces rather than load-bearing.
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
  if (status === 403 && obj) {   // status PLUS the problems/ body
    console.log('WX ' + what + ': 403 from api.weather.gov — User-Agent ' +
                'rejected. This is a CONFIGURATION BUG, not transient: ' +
                JSON.stringify(obj).slice(0, 160));
  } else {
    console.log('WX ' + what + ' fetch failed (' + status +
                '), keeping previous data');
  }
}

// Outside NWS coverage (48.85,2.35 verified: /points 404 InvalidPoint,
// /alerts?point 400 "out of bounds"): cache "no coverage" against the rounded
// lat/lon, blank all weather slots, do not retry until the location changes.
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
    // No coverage is status PLUS the problems/InvalidPoint body: a
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

// Observation: nearest usable station's latest. Values are frequently null on
// a given station, so fall through to the 2nd then 3rd; an observation older
// than 2 h is unusable too. A station with a description but no temperature
// is kept as a partial in case no better station follows.
function fetchObs(stations, cb) {
  var partial = null;
  var any200 = false;
  function next(i) {
    if (i >= stations.length) {
      if (partial) {
        writeWx('wx_obs', { t: Date.now(), temp: partial.temp, desc: partial.desc });
      } else if (any200) {
        // The stations answered but nothing was usable: render '--'.
        writeWx('wx_obs', { t: Date.now(), temp: null, desc: '' });
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
          var temp = (p.temperature && typeof p.temperature.value === 'number')
                       ? p.temperature.value : null;
          var desc = p.textDescription || '';
          if (temp !== null) {
            writeWx('wx_obs', { t: Date.now(), temp: temp, desc: desc });
            cb();
            return;
          }
          if (desc && !partial) partial = { temp: null, desc: desc };
        }
      } else {
        logWxFail('observation', status, obj);
      }
      next(i + 1);
    });
  }
  next(0);
}

// Forecast: only the first two periods matter (slot 16 = periods[0], slot 17
// derives H/L from the pair), so only they are kept.
function fetchFcst(url, cb) {
  fetchJson(url, function (status, obj) {
    if (status === 200 && obj && obj.properties &&
        obj.properties.periods && obj.properties.periods.length) {
      var p = obj.properties.periods.slice(0, 2).map(function (pd) {
        return { d: !!pd.isDaytime, t: pd.temperature, s: pd.shortForecast || '' };
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
    // STRICTLY downstream of the weather payload. cb() is fetchWeather's
    // `done()` sentinel, so releasing it first makes it structurally
    // impossible for anything here to stall `pending` and leave the watch
    // without its AppMessage; the try/catch is the second layer. The setting
    // is re-read here rather than threaded in, because this function is also
    // entered when an alert SLOT is configured and pins are off.
    if (raw && timelineAlerts()) {
      try { pushTimelinePins(raw); }
      catch (e) { console.log('TL push failed: ' + e); }
    }
  });
}

// Ranking key (first difference wins): severity, urgency, earliest onset.
// Picks the title that shows, and the alert whose expires is sent.
function alertRank(a, b) {
  if (a.sv !== b.sv) return b.sv - a.sv;
  if (a.ur !== b.ur) return b.ur - a.ur;
  return (a.on || 0) - (b.on || 0);
}

// WX_EXP is the MINIMUM expires across the alerts the string describes: with
// a +n suffix the whole string — title and count — is only guaranteed
// accurate until the first member lapses, and the watch cannot recount.
function minExpiry(list) {
  var m = 0;
  list.forEach(function (f) { if (f.ex && (!m || f.ex < m)) m = f.ex; });
  return m;
}

// "{event} +{n}": the suffix is part of the width budget, not an extra — the
// title is abbreviated against budget - len(" +N") whenever n > 0, so the
// count is never the part that gets ellipsized away.
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
      // Lead time REPLACES +n rather than stacking with it — so this string
      // describes exactly ONE alert, and WX_EXP is "the minimum expires
      // across the alerts the string describes": the top alert's
      // own expiry, not the minimum over set members the string never
      // mentions (a short-lived Minor advisory must not blank a future
      // Severe watch hours before it lapses).
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

// One AppMessage carrying every populated weather key (~260 B against an
// 8,200 B inbox). Slots 20/21 add nothing: they are composed on the watch
// from WX_ALERT + WX_HILO / WX_COND.
//
// WX_TIME is the FETCH time, not the assembly time. This payload is re-sent
// every heartbeat and replayed on 'ready' even when every fetch failed and
// the caches went untouched; stamping 'now' each time would relabel
// hour-old data as fresh and the watch's 3-hour '--' guard could never fire
// while the phone stayed reachable. Only the observation and forecast feed
// fmt_wx's staleness check (alerts carry their own WX_EXP expiry), so the
// stamp is the OLDEST fetch time among those two that a configured line
// actually displays — an unconfigured resource going stale in the cache
// must not blank the lines that are fresh.
function assembleWx() {
  var nowSec = Math.floor(Date.now() / 1000);
  var tOldest = 0;   // ms; 0 = no timed resource contributed
  var pl = {
    'WX_COND': '', 'WX_FCST': '', 'WX_HILO': '',
    'WX_ALERT': '', 'WX_ALERT2': '',
    'WX_EXP': 0, 'WX_EXP2': 0, 'WX_TIME': nowSec
  };

  // Each cache is read only when a configured line actually displays one of
  // the strings it feeds. The caches outlive a slot change (dropWxCaches runs
  // on a location change and on no-coverage, never on webviewclosed), so
  // without this a resource left cached by a previous config would ride every
  // payload indefinitely. Re-enabling a slot repopulates the string on the
  // next webviewclosed -> fetchWeather -> sendWx pass, without a refetch.
  var obs = wxUses(slotsShowing('cond')) ? readWx('wx_obs') : null;
  if (obs) {
    // "{temp}° {description}"; either half may be missing. Both missing: send
    // nothing and let the watch render '--', the same contract WX_HILO uses
    // below. The no-data glyph is chosen in exactly one place, on the watch.
    var b = budgetFor(slotsShowing('cond'));
    var t = (obs.temp === null || obs.temp === undefined)
              ? '' : fmtTempFromC(obs.temp);
    var desc = obs.desc ? fitWx(obs.desc, t ? b - t.length - 1 : b) : '';
    pl['WX_COND'] = capBytes(t && desc ? t + ' ' + desc : (t || desc));
    if (!tOldest || obs.t < tOldest) tOldest = obs.t;
  }

  // slotsFrom('fcst') is {16,17,20}, covering BOTH strings this block emits
  // (WX_FCST and WX_HILO), so one gate is enough for the pair.
  var fc = wxUses(slotsFrom('fcst')) ? readWx('wx_fcst') : null;
  if (fc && fc.p && fc.p.length) {
    pl['WX_FCST'] = capBytes(fitWx(fc.p[0].s, budgetFor(slotsShowing('fcst')), true));
    // NWS can return a period with a null temperature; the observation path
    // guards this explicitly and slot 17 needs the same — suppress the
    // string (the watch renders '--') rather than send 'H NaN° L 73°'.
    if (fc.p.length >= 2 &&
        typeof fc.p[0].t === 'number' && typeof fc.p[1].t === 'number') {
      // Chronological order in both cases; the H/L labels carry the
      // disambiguation across the day/night boundary and are never dropped.
      //
      // Single letters, and neither of the two obvious alternatives -- both
      // were built and rejected on measurement, so do not re-propose them.
      // An up/down arrow is not available at all: U+2191/2193 and U+25B2/25BC
      // are ALL absent from the Gothic fonts and render as missing-glyph
      // boxes (verified on-watch in QEMU, emery, 2026-08-13, by stubbing them
      // into format_slot(); degree signs render fine in the same string, so it
      // is a font coverage limit rather than an encoding bug, and a custom
      // font would cost five faces of app heap for the five-size ladder).
      // Spelled-out 'Hi'/'Lo' renders, but at 13 characters it overruns
      // CHAR_BUDGET_144's Medium budget of 12 and truncates to 'Hi 82° Lo 64',
      // dropping the degree sign, where this 11-character form fits exactly.
      // No gallery scenario puts a hilo slot at Medium on basalt, so that
      // regression is invisible in the tiles -- it is a budget-table check.
      var t0 = fmtTempFromF(fc.p[0].t);
      var t1 = fmtTempFromF(fc.p[1].t);
      // WX_HILO shows on lines 17 and 20, so it is width-fitted like every
      // other string — without a budget the auto-font XS rule could never
      // apply to it either.
      pl['WX_HILO'] = capBytes(fitWx(fc.p[0].d ? 'H ' + t0 + ' L ' + t1
                                               : 'L ' + t0 + ' H ' + t1,
                                     budgetFor(slotsShowing('hilo'))));
    }
    if (!tOldest || fc.t < tOldest) tOldest = fc.t;
  }

  // Mirrors fetchWeather's wantAlert. slotsFrom('alerts') is {18,19,20,21},
  // so the fallback slots keep both of their inputs.
  var al = wxUses(slotsFrom('alerts')) ? readWx('wx_alerts') : null;
  if (al && al.f) {
    var r = buildAlertStrings(al.f, nowSec);
    pl['WX_ALERT']  = capBytes(r.a);
    pl['WX_EXP']    = r.aExp;
    pl['WX_ALERT2'] = capBytes(r.a2);
    pl['WX_EXP2']   = r.a2Exp;
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
  // Two consumers of the NWS alert list now: the watch's alert slots, and the
  // timeline pins. wantWx alone still decides whether ANYTHING is sent to the
  // watch — see done(), below. That separation is the whole guarantee that
  // turning pins on changes not one byte of what the watch receives when no
  // weather slot is configured.
  var wantWx = wxNeeded();
  var wantPins = timelineAlerts();
  if (!wantWx && !wantPins) return;
  var lkey = lat.toFixed(2) + ',' + lon.toFixed(2);
  if (localStorage.getItem('wx_nocov') === lkey) return;

  // The per-resource caches are for a PLACE as well as a time (wx_grid keys
  // itself; these three do not): after a flight, yesterday's city's forecast
  // is only 20 minutes old, so the time gate alone would show its H/L here
  // for up to another hour. A new rounded location drops all three — alerts
  // included, since rendering an alert from 2,500 km away if this beat's
  // fetch fails is worse than rendering none.
  if (localStorage.getItem('wx_lkey') !== lkey) {
    dropWxCaches();
    try { localStorage.setItem('wx_lkey', lkey); } catch (e) {}
  }

  // The fallback slots need two resources each: 20 = alerts + forecast,
  // 21 = alerts + observation.
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
  var needObs  = wantObs  && (!obs  || now - obs.t  >=  9 * 60 * 1000);
  var needFcst = wantFcst && (!fcst || now - fcst.t >= 59 * 60 * 1000);
  // Alerts go every heartbeat (server max-age=5): no interval check.

  var pending = 1;   // sentinel: done() cannot fire before all branches start
  function done() {
    // wantWx, not `pending === 0` alone: with only pins enabled, no branch
    // increments `pending` for the watch's sake and this fires with every
    // cache read in assembleWx() gated off — an all-empty payload that would
    // clobber wx_payload and enqueue a NEW AppMessage. main.c accepts it on
    // WX_TIME's mere presence and blanks all five buffers, so the damage is
    // invisible in a screenshot. Two independent barriers keep it impossible:
    // this test, and assembleWx's own alert gate, which stays untouched.
    if (--pending === 0 && wantWx) sendWx(assembleWx());
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

// Takes two numbers rather than a Position: only two of its fields were ever
// read, and two of the three callers had to fabricate a browser API object to
// call it.
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
  // rendered for the first one's display. Still valid under compositing: the
  // stored shape is unchanged, only its consumer moved.
  var key = 'v3_' + IMG_W + 'x' + IMG_H + '_' +
            zoom + '_' + lat.toFixed(2) + '_' + lon.toFixed(2);

  var newArea = (key !== localStorage.getItem('bm_key'));

  resetTransfers(newArea);
  var g = gen;

  // needImage means the watch has no frame at all -- a relaunch, or a decode
  // that failed. Everything below is seconds away at best and unbounded when
  // the phone has no signal, so answer from the replay cache first.
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
      // A layer is missing => send NOTHING. The watch keeps showing the last
      // good composite; a basemap-only frame would erase live precipitation,
      // and the Radar Age slot keeps climbing, which is the truth. This is the
      // graceful degradation the two-layer design got for free.
      console.log('Composite skipped: a layer is missing');
      bmRgba = null; rdRgba = null;            // release both buffers
      return;
    }
    composeAndSend(bmRgba, rdRgba, mode, needImage);
    bmRgba = null; rdRgba = null;
  }

  // The basemap is always needed now — it is an input, not an optional layer.
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
    r = composite.buildComposite(bmRgba, rdRgba, mode, IMG_W, IMG_H);
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
    // The two arms are logged distinctly on purpose: they mean different
    // things about what the watch is showing, and the log line is the only
    // instrument this project has for the cache (there is no test suite).
    console.log('Composite unchanged, skipping transfer' +
                (h === pendingHash ? ' (already in flight)' : ''));
    // Stamp the radar time ONLY when nothing identical is pending, i.e. on a
    // committed OR delivered match — both rest on an ACK, so the watch is known
    // to be displaying these bytes.
    // A pendingHash match means the composite is merely queued or in flight:
    // the watch is showing the PREVIOUS frame (or none), and if that transfer
    // gives up it never will show this one — so dating it "now" would misdate
    // a frame that was never drawn, which is the one thing the explicit
    // RADAR_TIME key exists to prevent. The pending item's own onAck carries
    // the correct stamp and fires only if it lands. After a replay that means
    // the age reads from the replayed frame's own fetch until the next
    // heartbeat re-stamps it — stale-side, which is the honest direction.
    if (h !== pendingHash) {
      enqueue({ kind: 'msg', dict: { 'RADAR_TIME': radarStamp(mode) } });
    }
    return;
  }
  pendingHash = h;
  enqueue({ kind: 'img', bytes: r.bytes, hash: h, radarTime: radarStamp(mode) });
}

// When pkjs fetched the radar layer this composite was built from, in unix
// seconds — NOT a decode time. With the transfer cache an unchanged composite
// is not re-sent, so a decode is no longer a reliable heartbeat for Radar Age.
// 0 = the layer is Disabled, which the watch renders as 'no radar'.
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
  // Line 1: the inner pair kept its original keys when the outer pair was
  // added, so settings saved by an earlier version still apply.
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
    // cadence, so the minutes value has to reach it (and replay from cfg on
    // 'ready' like every other watch key).
    'RefreshInterval': Number(d.RefreshInterval.value),
    // Guarded like UseGps rather than dereferenced like the older keys: a
    // response from a config page that predates this toggle has no such
    // field, and sending 0 for it would silently turn the badge off. Absent
    // means "leave the watch's stored value alone", so default it to on.
    'BtIndicator': (d.BtIndicator && !Number(d.BtIndicator.value)) ? 0 : 1,
    // Clay color pickers store the chosen color as an 0xRRGGBB number; the
    // watch quantizes to GColor8 with GColorFromHEX.
    'TextColor': Number(d.TextColor.value),
    'OutlineColor': Number(d.OutlineColor.value)
  };
  // Zoom, RadarMode, UseGps/ManualLoc, WxUnits and TimelineAlerts are
  // phone-side only: never forwarded to the watch, persisted here under their
  // own keys. RadarMode joined that group with compositing — the blend happens
  // here now, so the watch has no use for the mode at all.
  var zoom = Number(d.Zoom.value);
  var zoomChanged = String(zoom) !== localStorage.getItem('Zoom');
  localStorage.setItem('Zoom', String(zoom));
  // Location source is phone-side only, like Zoom. The config page refuses
  // to save with the GPS toggle off and an unparsable box (custom-clay.js
  // disables Save), so a pair that fails to parse here is a stale or
  // hand-built response: fall back to GPS rather than guess. Persisted under
  // the single key manualLocation() reads: '' = GPS.
  var mloc = (d.UseGps && !Number(d.UseGps.value))
               ? parseManualLoc(d.ManualLoc && d.ManualLoc.value)
               : null;
  var manual = mloc ? mloc.lat + ',' + mloc.lon : '';
  var locChanged = manual !== (localStorage.getItem('ManualLoc') || '');
  localStorage.setItem('ManualLoc', manual);
  var radar = Number(d.RadarMode.value);
  var radarChanged = String(radar) !== localStorage.getItem('RadarMode');
  localStorage.setItem('RadarMode', String(radar));
  // WxUnits is phone-side only, like Zoom: never forwarded to the watch. A
  // units change invalidates the cached weather payload and refetches — the
  // per-resource timestamps are backdated so the min-interval gate opens. The
  // entries themselves are kept (they hold unit-agnostic numbers that render
  // correctly under either setting), so a failed refetch still shows data.
  // t = 1, not 0: assembleWx folds the oldest stamp with `!tOldest || ...`,
  // and a falsy 0 would be skipped there — stale data would then be stamped
  // with `now` and the watch's 3-hour '--' guard could never fire.
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
  // Timeline pins are phone-side only, like WxUnits: pkjs pushes them, so
  // nothing about this reaches the watch. Guarded like UseGps/BtIndicator
  // rather than dereferenced — webviewclosed has no try/catch, and a
  // TypeError here would abort before the cfg2 write below, silently losing
  // EVERY setting the user just saved. Stored as '1'/'0', never
  // String(boolean): 'false' reads back through numSetting as NaN, which
  // folds to the ON default and makes the Off position unreachable.
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
  // so keep a copy to replay on the next 'ready' and send through the queue —
  // never a bare sendAppMessage, which would race the imagery the branches
  // below kick off, and which had no retry policy beyond one blind resend.
  // 'cfg2', not 'cfg': this blob is replayed VERBATIM on 'ready', and an
  // already-persisted one still carries RadarMode, which is no longer a
  // declared messageKey — the replay would try to send an unknown key.
  // Renaming the storage key retires every stale blob deterministically.
  localStorage.setItem('cfg2', JSON.stringify(s));
  enqueue({ kind: 'msg', dict: s });
  if (zoomChanged || locChanged) {
    getLocation(true);   // new bbox: the composite must be re-rendered
  } else if (radarChanged) {
    // Translucency and the enable/disable decision are applied phone-side now,
    // so ANY mode change needs a fresh composite — including -> Disabled,
    // which used to be handled on the watch by destroying the radar bitmap.
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
      // Settings saved before the first getCurrentPosition resolved (cold
      // GPS): there is no last fix, and a units change just deleted
      // wx_payload — silently doing nothing would leave the old units on
      // screen until the next heartbeat. Resolve a fix; weather rides along
      // in locationSuccess.
      //
      // wxNeeded(), not pinsChanged: 'ready' has already issued getLocation
      // and getLocation has no in-flight guard, so a second call here would
      // leave two getCurrentPosition callbacks outstanding and run the whole
      // imagery pass twice when the fix lands. A pins-only change has nothing
      // on the watch to redo, so it can wait for the heartbeat — anything else
      // would change what the watch receives when the toggle is flipped.
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
  console.log('Imagery size: ' + IMG_W + 'x' + IMG_H +
              ' (platform ' + ((info && info.platform) || 'unknown') + ')');
  // Resync a lost save — through the queue, not a bare sendAppMessage: the
  // weather replay below enqueues in the same tick, and two sends in flight
  // at once is exactly the race the serialiser exists to prevent. The one
  // without callbacks (this one, previously) would be the one silently
  // NACKed, leaving the watch's persisted settings diverged forever. The
  // queue also gives it the same 3-retry/500 ms policy as everything else.
  var cfg = localStorage.getItem('cfg2');
  if (cfg) {
    try { enqueue({ kind: 'msg', dict: JSON.parse(cfg) }); } catch (e) {}
  }
  // Replay the last weather payload (same pattern as cfg): the watch
  // persists nothing, and a fresh fetch is minutes of latency away. WX_TIME
  // rides along unchanged, so hour-old data still reads as hour-old.
  var wxp = localStorage.getItem('wx_payload');
  if (wxp && wxNeeded()) {
    try { enqueue({ kind: 'msg', dict: JSON.parse(wxp) }); } catch (e) {}
  }
  // After a relaunch the watch's bitmap is NULL, so the composite must be sent
  // even if it hashes equal to what the cache believes was delivered.
  getLocation(true);
});

Pebble.addEventListener('appmessage', function (e) {
  // The outer test is TRUTHINESS, which is why the watch's flag is 2/1 and
  // never 0: a 0 would be silently ignored here and the heartbeat would die.
  // 2 = "I have no image" (the watch's bitmap is NULL) -> send unconditionally.
  if (e.payload['REQUEST_IMAGES']) {
    getLocation(e.payload['REQUEST_IMAGES'] === 2);
  }
});

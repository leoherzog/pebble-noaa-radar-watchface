/**
 * Timeline pins for severe NWS alerts: turn an /alerts/active feature into the
 * one pin object Pebble.insertTimelinePin() accepts, and decide which pins are
 * worth inserting this heartbeat.
 *
 * Pure and node-requirable: no Pebble APIs, XHR, localStorage, logging or
 * module-level state, and `nowSec` is always a parameter so a harness can pin
 * the clock. index.js owns delivery and every `TL` log line. Strict ES5 (no
 * Map/Set, Object statics or arrow functions), because it ships alongside
 * index.js to the same legacy pkjs runtime.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Runaway guard on inserts per alert fetch, not a rate limit: local pins have
// no service quota. Overflow waits for the next fetch, because planPins
// re-derives the same candidates from persisted state.
var MAX_PUTS_PER_FETCH = 8;

// A conservative clamp, not a known limit: the timeline web API may reject a
// `time` more than 2 days past or 1 year ahead (sdk-docs timeline-public.md),
// and no bound is documented for local pins. The floor sits an hour inside.
// Once a pin's anchor is more than 47 h old it re-clamps on every fetch, so
// the pin's time walks forward with its end fixed and it is re-inserted each
// time. That is current behaviour, not a dedupe bug.
var PIN_TIME_FLOOR_SEC = 47 * 3600;
var PIN_TIME_CEIL_SEC  = 300 * 86400;

// `duration` is a uint16 of minutes and nothing downstream clamps it: an
// out-of-range value is rejected silently (libpebble2 struct.error, pypkjs
// item.rejected) and the pin never appears.
var MAX_DURATION_MIN = 65535;

// Matches the firmware's PIN_DB_MAX_AGE (pin_db.c:26,222): once the watch has
// auto-deleted a pin, our record of having sent it means nothing, and a fresh
// insert for the same id is correctly a fresh creation.
var GC_AGE_SEC = 3 * 86400;

// Runaway guard: tl_pins shares localStorage with two base64 PNGs, where a
// quota throw is swallowed and silently leaves stale data behind. Above the
// cap, ids beyond the 64 soonest-ending are never pinned.
var MAX_STATE_ENTRIES = 64;

// Byte caps, counted by clip(), under the firmware's 63-byte title/subtitle
// and 511-byte body cuts: staying under them means the serializer never
// re-cuts, so it can never split a UTF-8 sequence. A char count would not
// guarantee that.
var BODY_MAX     = 500;
var TITLE_MAX    = 60;
var SUBTITLE_MAX = 40;

// Date's representable range (±8.64e15 ms), in seconds. Outside it
// toISOString throws RangeError, which would break this module's never-throws
// contract.
var MAX_EPOCH_SEC = 8.64e12;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

// FNV-1a 32-bit, 8 hex chars. The shift chain is the FNV prime
// (16777619 === 2^24+2^8+2^7+2^4+2^1+2^0), written out because Math.imul is not
// guaranteed on this runtime.
//
// Do not reuse composite.hashBytes on a string: `h ^= b[i]` coerces each
// character to a number, so every non-digit XORs in as 0 and same-length
// strings that differ only in letters collide on one signature.
function strHash(s) {
  var t = (s === null || s === undefined) ? '' : String(s);
  var h = 2166136261;
  for (var i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

// Local copy of index.js's parseEpoch, because this module imports nothing.
function parseEpochSec(s) {
  if (!s) return 0;
  var ms = Date.parse(s);
  return isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

// A clock this module can actually work from. The typeof is not redundant with
// the range test — null compares as 0 and would date every pin to 1970 — and
// the relational form catches NaN, undefined and non-numeric strings, all of
// which make every comparison false.
function sane(sec) {
  return typeof sec === 'number' && sec > -MAX_EPOCH_SEC && sec < MAX_EPOCH_SEC;
}

// An own-key test for a map read back from storage. tl_pins can hold a key
// named hasOwnProperty, and the method called through the map would then throw.
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Milliseconds stripped so the emitted string matches the documented form and
// the signature cannot be perturbed by a formatting detail.
function isoOf(sec) {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// NWS hard-wraps `description` mid-sentence, so raw text wastes the body cap on
// line breaks. The `|| ''` matters: `description` can be null, even on alerts
// that pass the severity filter.
function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Clips to n UTF-8 bytes, never mid-sequence or between surrogate halves.
// Correct only for well-formed input: a high surrogate followed by any
// character is billed as a 4-byte pair without checking the second half, and
// one at the very end is dropped. Tighten that test if a non-ASCII source ever
// reaches this module.
function clip(s, n) {
  var t = String(s === null || s === undefined ? '' : s);
  var bytes = 0, i, c, w;
  for (i = 0; i < t.length; i++) {
    c = t.charCodeAt(i);
    if (c >= 0xD800 && c < 0xDC00) {
      // High surrogate: only a complete pair is representable, at 4 bytes.
      if (i + 1 >= t.length || bytes + 4 > n) break;
      bytes += 4; i++;
      continue;
    }
    w = (c < 0x80) ? 1 : (c < 0x800 ? 2 : 3);
    if (bytes + w > n) break;
    bytes += w;
  }
  if (i < t.length) t = t.slice(0, i);
  return t.replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------
// The severity filter
// ---------------------------------------------------------------------------

// Two clauses on purpose: over a 7-day corpus they admit exactly the same set
// as the longer rule that also excludes messageType 'Cancel' and VTEC CAN/UPG.
// planPins filters only through buildPin, so it cannot drift from this rule.
function isSevere(props) {
  if (!props) return false;
  // Severity, not event name. Adding a Warning-or-Watch test changes nothing,
  // and "ends with Warning" alone would admit Gale Warning (Moderate/Minor).
  // Severity also covers seasons never sampled, where an event-name allowlist
  // would need its winter rows guessed.
  if (props.severity !== 'Extreme' && props.severity !== 'Severe') return false;
  // Cancellations and upgrades reach /alerts/active as messageType 'Alert'
  // with severity Severe (a headline reading "has been replaced"), and a
  // severity-only filter would pin them as live. urgency Past excludes exactly
  // those: every CAN/UPG message in the corpus carried it and nothing else did.
  return props.urgency !== 'Past';
}

// Deliberately absent:
//   messageType !== 'Cancel': Cancel never appears in /alerts/active, so the
//     clause would never fire yet would look correct in review.
//   VTEC action not in {CAN,UPG}: redundant, and it would couple the filter to
//     the VTEC parse.
//   VTEC action !== 'EXP': wrong. EXP means expiring naturally, and it would
//     drop in-force Tornado Warnings in their final minutes. EXP urgency is
//     never Past, so the rule above keeps them.
//   any `certainty` clause: unmeasured, and severity already encodes the tier.

// ---------------------------------------------------------------------------
// Pin identity
// ---------------------------------------------------------------------------

// P-VTEC: /k.aaa.cccc.pp.s.####.yymmddThhnnZ-yymmddThhnnZ/
var VTEC_RE = /^\/[A-Z]\.[A-Z]{3}\.([A-Z0-9]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.(\d{6})T\d{4}Z-(\d{6})T\d{4}Z/;

// NWS `parameters` values are always ARRAYS of strings, so the VTEC string is
// [0], not the value itself. A single alert can carry several VTEC segments
// concatenated; anchoring at ^ takes the first, which is the one whose ETN
// identifies this product.
function vtecOf(props) {
  var pa = props && props.parameters;
  var v = pa && pa.VTEC;
  var s = (v && v.length) ? v[0] : null;
  if (!s) return null;
  var m = VTEC_RE.exec(String(s));
  if (!m) return null;
  return { office: m[1], phenom: m[2], sig: m[3], etn: m[4],
           beginYY: m[5], endYY: m[6] };
}

// Not the alert's own `id`: it is 69 chars against the 64-char pin id cap, and
// it changes on every reissue, so hashing it would mint a duplicate pin per
// reissue, each persisting 3 days. The VTEC event key is stable across a
// reissue chain.
//
// The year is there because ETNs recycle annually and a DELETEd pin id can
// never be reused. It comes from the VTEC end time, since the begin time is
// 000000T0000Z on every CON/EXT reissue; nowSec is the last resort. An event
// EXTended across New Year mints one extra pin; that is accepted, and burns no
// id because nothing is DELETEd.
function pinIdFor(props, nowSec) {
  var v = vtecOf(props);
  if (!v) return null;
  var yy;
  if (v.endYY !== '000000') yy = v.endYY.slice(0, 2);
  else if (v.beginYY !== '000000') yy = v.beginYY.slice(0, 2);
  else yy = String(new Date(nowSec * 1000).getUTCFullYear()).slice(2);
  return 'wx.20' + yy + '.' + v.office + '.' + v.phenom + '.' + v.sig + '.' + v.etn;
}

// A feature whose VTEC key does not parse is skipped, with no fallback id.
// Every fallback (a hash of `id`, of event+areaDesc+ends) is unstable across
// reissues and would mint duplicates that live 3 days, because nothing is ever
// DELETEd. A missing pin is harmless; a pin flood is not.

// ---------------------------------------------------------------------------
// Pin content
// ---------------------------------------------------------------------------

// The HAZARD.../IMPACT... sections, when present, make a short body where the
// raw description often overruns the body cap. The lookahead ends a section at
// the next ALLCAPS... label or at end of string. No /g flag: a module-level /g
// regex keeps lastIndex between calls, which would make bodyFor, and so
// pinSig, depend on call order.
var HAZARD_RE = /HAZARD\.\.\.(.*?)(?=[A-Z]{4,}\.\.\.|$)/;
var IMPACT_RE = /IMPACT\.\.\.(.*?)(?=[A-Z]{4,}\.\.\.|$)/;

function bodyFor(props) {
  var d = collapse(props && props.description);
  var parts = [];
  var m = HAZARD_RE.exec(d);
  if (m && m[1].trim()) parts.push(m[1].trim());
  m = IMPACT_RE.exec(d);
  if (m && m[1].trim()) parts.push(m[1].trim());
  return clip(parts.length ? parts.join(' ') : d, BODY_MAX);
}

// Only documented system icons. There is no tornado or lightning icon, and an
// invented resource id is refused (pypkjs KeyErrors at serialise time, the
// firmware rejects it).
function iconFor(title) {
  if (/Flood|Rain|Hurricane|Tropical|Marine/.test(title)) {
    return 'system://images/HEAVY_RAIN';
  }
  if (/Snow|Winter|Blizzard|Ice|Freez/.test(title)) {
    return 'system://images/HEAVY_SNOW';
  }
  return 'system://images/GENERIC_WARNING';
}

// Returns {id, pin, time, endSec}, or null (not severe, no VTEC key, or an
// unusable nowSec). anchorSec is the caller's persisted first-seen onset for
// this id, 0 if none: `onset` drifts forward on reissues (the API stamps a
// CON/EXT with its send time), so reading it fresh would walk the pin's start
// forward every heartbeat, silently.
//
// Key insertion order is part of the contract: pinSig hashes
// JSON.stringify(pin), so reordering these assignments re-inserts every live
// pin.
function buildPin(props, anchorSec, nowSec) {
  if (!isSevere(props)) return null;
  // An unrepresentable nowSec would make isoOf throw RangeError; no pin beats
  // one dated off a broken clock.
  if (!sane(nowSec)) return null;
  var id = pinIdFor(props, nowSec);
  if (!id) return null;

  // `ends` before `expires`, the opposite of index.js's `ex`, which is right
  // for when a watch string goes stale and wrong here: `expires` is the
  // product resend deadline, not the hazard end, and can fall days before
  // onset. The fallback is live: `ends` is often null, even on severe alerts.
  var endsSec = parseEpochSec(props.ends);
  var endSec = endsSec || parseEpochSec(props.expires);

  // Covers a null onset, as on status Test alerts if &status=actual is ever
  // dropped from the query.
  var onsetSec = parseEpochSec(props.onset) || parseEpochSec(props.effective) ||
                 parseEpochSec(props.sent) || nowSec;

  var timeSec = (anchorSec > 0) ? anchorSec : onsetSec;
  if (timeSec < nowSec - PIN_TIME_FLOOR_SEC) timeSec = nowSec - PIN_TIME_FLOOR_SEC;
  if (timeSec > nowSec + PIN_TIME_CEIL_SEC)  timeSec = nowSec + PIN_TIME_CEIL_SEC;

  // Duration LAST, derived from the (possibly clamped) time, so the pin's END
  // stays fixed under a moving clamp. The firmware reads time + duration*60 as
  // the end (event.c:214 timeline_event_is_ongoing, timeline.c:431
  // prv_prune_ordered_timeline_list), so holding the end fixed is exactly what
  // makes the pin stop reading as current at expiry, watch-side and offline.
  var mins = endSec ? Math.round((endSec - timeSec) / 60) : 1;
  // With no `ends`, a non-positive span means the resend deadline fell before
  // the time, not that the hazard is over (a new watch for tomorrow can do
  // this). A 1-minute pin would stop reading as current at once, so use an
  // hour; an expiring alert that carries `ends` keeps its short pin.
  if (mins < 1 && !endsSec) mins = 60;
  var duration = Math.max(1, Math.min(MAX_DURATION_MIN, mins));

  // Never run pin text through index.js's fitWx/budgetFor: they fit the watch's
  // text slots and would cut a pin title to 25 characters.
  var title = clip(String(props.event || 'Weather Alert'), TITLE_MAX);
  // areaDesc lists every zone in the segment, ';'-separated, even on a point
  // query, so the subtitle takes the first.
  var area = clip(collapse(props.areaDesc).split(';')[0], SUBTITLE_MAX);
  var body = bodyFor(props);

  // genericPin, never weatherPin: that requires `locationName` and its subtitle
  // takes only numbers and the degree symbol (pin-structure.md:624-626).
  //
  // No color fields: local pins ignore them. `pebble insert-pin` does render
  // backgroundColor, because it bypasses the phone's local-pin path, so an
  // emulator screenshot says nothing about real hardware.
  var layout = { type: 'genericPin', title: title };
  // Omitted, not emptied: an absent field must never enter the signature as ''.
  if (area) layout.subtitle = area;
  if (body) layout.body = body;
  layout.tinyIcon = iconFor(title);

  return {
    id: id,
    pin: { id: id, time: isoOf(timeSec), duration: duration, layout: layout },
    time: timeSec,
    endSec: endSec
  };
}

// Deterministic because buildPin always inserts keys in a fixed order.
function pinSig(pin) {
  return strHash(JSON.stringify(pin));
}

// ---------------------------------------------------------------------------
// Planning and dedupe
// ---------------------------------------------------------------------------

// Returns {puts, state}: the pins to insert this fetch, and the persisted
// dedupe map, mutated in place and returned as the same object. Never throws
// for any input: it runs on an NWS response shape nobody controls, and
// index.js's try/catch is only the second layer.
//
// It never sets `s`, because a plan is not a delivery. Only commitPin does,
// and index.js calls it only once Pebble.insertTimelinePin() has returned
// without throwing, the only evidence that call gives. An insert that throws
// therefore cannot poison the cache into skipping that pin forever.
function planPins(features, state, nowSec) {
  if (!state || typeof state !== 'object') state = {};
  // Same guard as buildPin's, for the same reason: nowSec drives the GC cutoff
  // and every clamp, so an unrepresentable one has no safe interpretation.
  if (!sane(nowSec)) {
    return { puts: [], state: state };
  }

  var k, e, keys = [], i;

  // Shape GC first, so a corrupt entry can never be read as an anchor. A blob
  // written by an older or a future build is discarded per-entry rather than
  // wholesale — one bad key must not cost every live pin its anchor.
  for (k in state) {
    if (!hasOwn(state, k)) continue;
    e = state[k];
    if (!e || typeof e !== 'object' ||
        typeof e.t !== 'number' || !isFinite(e.t) ||
        typeof e.x !== 'number' || !isFinite(e.x)) {
      delete state[k];
    }
  }

  // Duck-typed rather than Array.isArray'd, and length-checked rather than
  // trusted: `features` comes straight off a parsed JSON body.
  var feats = (features && typeof features.length === 'number') ? features : [];
  // One representative per pin id. NWS splits a VTEC product into per-zone
  // segments that arrive as separate features sharing office/phenom/sig/ETN; a
  // candidate per feature would make each insert overwrite the other, and the
  // pin would rewrite itself every heartbeat without the dedupe converging. One
  // id can only hold one segment's text anyway.
  var chosen = {}, ids = [];

  for (i = 0; i < feats.length; i++) {
    var ft = feats[i];
    var props = ft && ft.properties;
    if (!props) continue;
    // pinIdFor first, only to look up the anchor; it is pure, so calling it
    // again inside buildPin costs nothing and keeps buildPin self-contained.
    var id = pinIdFor(props, nowSec);
    if (!id) continue;
    e = state[id];
    var r = buildPin(props, (e && e.t) || 0, nowSec);
    if (!r) continue;
    // The anchor stored on first sight is the post-clamp time, so it never
    // re-derives from a drifting onset, though it can still re-clamp (see
    // PIN_TIME_FLOOR_SEC). Segments after the first all build against the same
    // anchor, which is what keeps them comparable below.
    if (!e) { e = { t: r.time, x: 0, s: null }; state[r.id] = e; }
    // endSec 0 means neither `ends` nor `expires` parsed; the entry still needs
    // a GC key, and time+60 matches the 1-minute duration buildPin emitted.
    var x = r.endSec || (r.time + 60);
    var sig = pinSig(r.pin);
    var c = chosen[r.id];
    if (!c) {
      chosen[r.id] = { sev: (props.severity === 'Extreme') ? 1 : 0,
                       x: x, sig: sig, pin: r.pin };
      ids.push(r.id);
    // Latest end wins, so the surviving pin outlives its siblings rather than
    // expiring while the hazard runs on. The tiebreak is the signature and not
    // feed order: two segments ending at the same instant must resolve the same
    // way on every beat, and nothing promises NWS serialises them in a stable
    // order (nor that this runtime's Array sort is stable).
    } else if (x > c.x || (x === c.x && sig < c.sig)) {
      c.sev = (props.severity === 'Extreme') ? 1 : 0;
      c.x = x; c.sig = sig; c.pin = r.pin;
    }
    // Written here, not after the cap below, which sorts on it: a new entry
    // would otherwise still read x 0 there, so the cap would spare every new
    // entry and evict the survivors of the last plan, and above the cap the
    // dedupe would never converge.
    e.x = chosen[r.id].x;
  }

  // An entry this fetch did not list is dropped once its end is GC_AGE_SEC
  // past.
  //
  // The age test stays off a listed entry: an alert can stay listed days past
  // its stated end, and dropping its entry would re-insert the pin every fetch.
  for (k in state) {
    if (!hasOwn(state, k) || chosen.hasOwnProperty(k)) continue;
    if (state[k].x < nowSec - GC_AGE_SEC) delete state[k];
  }

  // Hard cap, run after the loop. Run before it, the cap could still leave
  // more than MAX_STATE_ENTRIES behind, and evicting lowest-`x` first would
  // match the order the candidate sort pushes in: above the cap every
  // committed entry would be deleted before the next plan read it, and
  // re-inserted forever.
  //
  // Entries this plan did not see go first (deadest end first), then live ones,
  // latest end first. Dropping the latest-ending live entry is the one choice
  // that cannot fight the sort, which ranks soonest-ending first.
  for (k in state) { if (hasOwn(state, k)) keys.push(k); }
  if (keys.length > MAX_STATE_ENTRIES) {
    keys.sort(function (a, b) {
      var la = chosen.hasOwnProperty(a) ? 1 : 0;
      var lb = chosen.hasOwnProperty(b) ? 1 : 0;
      if (la !== lb) return la - lb;
      if (state[a].x !== state[b].x) {
        return la ? state[b].x - state[a].x : state[a].x - state[b].x;
      }
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    for (i = 0; i < keys.length - MAX_STATE_ENTRIES; i++) delete state[keys[i]];
  }

  // Candidates come only from entries that survived the cap, so an evicted id
  // is never pushed.
  var cands = [];
  for (i = 0; i < ids.length; i++) {
    var cid = ids[i];
    e = state[cid];
    if (!e) continue;                    // evicted by the cap just above
    var ch = chosen[cid];
    // Re-insert on any signature change: time, duration, title, subtitle, body
    // or tinyIcon. That is an EXT/CON reissue that moves `ends`, an updated
    // storm description, or an anchor re-clamping past PIN_TIME_FLOOR_SEC.
    // Inserting an existing id updates that pin rather than adding a second.
    if (e.s !== ch.sig) {
      cands.push({ sev: ch.sev,
                   put: { id: cid, pin: ch.pin, sig: ch.sig, endSec: ch.x } });
    }
  }

  // Extreme first, then soonest end, then id. A total order (ids are unique),
  // so the result does not depend on Array.prototype.sort being stable.
  cands.sort(function (a, b) {
    if (a.sev !== b.sev) return b.sev - a.sev;
    if (a.put.endSec !== b.put.endSec) return a.put.endSec - b.put.endSec;
    return a.put.id < b.put.id ? -1 : (a.put.id > b.put.id ? 1 : 0);
  });

  var puts = [];
  for (i = 0; i < cands.length && i < MAX_PUTS_PER_FETCH; i++) puts.push(cands[i].put);
  return { puts: puts, state: state };
}

// Records that the timeline now holds this signature. A missing entry is
// ignored; the next plan recreates it with s null and re-inserts, which is
// wasteful but never wrong.
function commitPin(state, id, sig) {
  if (!state || typeof state !== 'object') state = {};
  if (state[id]) state[id].s = sig;
  return state;
}

// ---------------------------------------------------------------------------
// Exports — all pure; delivery lives in index.js
// ---------------------------------------------------------------------------

module.exports = {
  MAX_PUTS_PER_FETCH: MAX_PUTS_PER_FETCH,
  isSevere:           isSevere,
  pinIdFor:           pinIdFor,
  buildPin:           buildPin,
  pinSig:             pinSig,
  planPins:           planPins,
  commitPin:          commitPin,
  strHash:            strHash
};

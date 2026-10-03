/**
 * Timeline pins for severe NWS alerts: builds the pin object that
 * Pebble.insertTimelinePin() takes from an /alerts/active feature, and plans
 * which pins to insert or renew each heartbeat. Pure and node-requirable: no
 * Pebble APIs, XHR, localStorage, logging or module-level state, and the clock
 * (`nowSec`) and the local day start (`dayStartSec`) are always parameters, so
 * a harness can pin both; index.js owns delivery and every `TL` log line.
 * Strict ES5, and none of ES5's Object statics such as Object.keys, because it
 * ships alongside index.js to the same legacy pkjs runtime.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Runaway guard on inserts per alert fetch, not a rate limit: local pins have
// no service quota. Overflow waits for the next fetch, because planPins
// re-derives the same candidates from persisted state.
var MAX_PUTS_PER_FETCH = 8;

// One day twice over: the phone app keeps a pin on the watch only until its
// `time` plus a day, whatever its duration (libpebble3 TimelineItem.kt), and
// the firmware counts 1440 minutes or more as all-day (event.c).
var DAY_SEC = 86400;

// A plan this close before a local midnight already takes that midnight: the
// heartbeat runs on the watch's minute tick, which the phone's clock can trail.
// It is under the 5-minute minimum refresh, so no scheduled beat steps early.
var DAY_ROLL_SLACK_SEC = 120;

// On the 25 h day when clocks fall back, local midnight turns a day old an hour
// before the next one, so the start moves on by the hour to stay inside the
// sync window.
var DST_SHIFT_SEC = 3600;

// The longest local day. An older day start is a caller bug, and the UTC day
// stands in for it. Declared above DST_SHIFT_SEC, the sum would be NaN and
// every day start would fall back to UTC.
var DAY_MAX_SEC = DAY_SEC + DST_SHIFT_SEC;

// A pin longer than this has to step again, so planPins keeps its layout for
// renewPins.
var ALL_DAY_MIN = 1440;

// A conservative clamp on a future onset, not a known limit. The phone app
// holds a pin back until 5 days before its `time` in any case.
var PIN_TIME_CEIL_SEC = 300 * 86400;

// `duration` is a uint16 of minutes and nothing downstream clamps it: the
// Pebble app wraps it mod 65536, and pypkjs rejects the pin.
var MAX_DURATION_MIN = 65535;

// How long an unlisted entry outlives its pin's end, matching the firmware's
// PIN_DB_MAX_AGE (pin_db.c). An upper bound: the phone app drops its own row a
// day after the pin's `time`, and a later insert of that id is a fresh pin.
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

// Epoch seconds of a date string, or 0 when it is absent or does not parse.
function parseEpochSec(s) {
  if (!s) return 0;
  var ms = Date.parse(s);
  return isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

// A clock this module can actually work from. The typeof is not redundant:
// null passes the range test as 0 and would date every pin to 1970. The
// relational form catches NaN, undefined and non-numeric strings, which fail
// every comparison.
function sane(sec) {
  return typeof sec === 'number' && sec > -MAX_EPOCH_SEC && sec < MAX_EPOCH_SEC;
}

// The latest anchor a pin may take: PIN_TIME_CEIL_SEC ahead, capped at Date's
// range, past which isoOf throws. sane() does not cover this: a clock it
// accepts can sit within PIN_TIME_CEIL_SEC of that limit.
function anchorCeil(nowSec) {
  return Math.min(nowSec + PIN_TIME_CEIL_SEC, MAX_EPOCH_SEC);
}

// An own-key test for a map read back from storage. tl_pins can hold a key
// named hasOwnProperty, and the method called through the map would then throw.
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// The start of the local day nowSec falls in, as the caller computed it, or of
// the UTC day when that value is not within one local day of the clock. Either
// keeps a pin synced; only a local midnight makes that day's row "All day".
function dayStartOf(nowSec, dayStartSec) {
  if (typeof dayStartSec === 'number' &&
      dayStartSec <= nowSec + DAY_ROLL_SLACK_SEC &&
      dayStartSec > nowSec - DAY_MAX_SEC) {
    var ds = Math.floor(dayStartSec);
    if (nowSec + DAY_ROLL_SLACK_SEC - ds >= DAY_SEC) ds += DST_SHIFT_SEC;
    return ds;
  }
  var t = nowSec + DAY_ROLL_SLACK_SEC;
  return t - (((t % DAY_SEC) + DAY_SEC) % DAY_SEC);
}

// The pin's `time`: max(anchor, min(day start, end - 1 day)), so an alert in
// force never leaves the phone app's sync window. A start that is not the
// anchor leaves 1440 minutes or more, which Quick View never shows.
function startFor(anchorSec, endSec, nowSec, dayStartSec) {
  var timeSec = anchorSec;
  if (endSec > 0) {
    var floorSec = Math.min(dayStartOf(nowSec, dayStartSec), endSec - DAY_SEC);
    if (floorSec > timeSec) timeSec = floorSec;
  }
  return timeSec;
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
  // Severity, not event name: "ends with Warning" would admit Gale Warning
  // (Moderate/Minor), and an event allowlist would need rows guessed for
  // seasons never sampled.
  if (props.severity !== 'Extreme' && props.severity !== 'Severe') return false;
  // Cancellations and upgrades arrive as Severe 'Alert' messages, and urgency
  // Past marks exactly those. A messageType 'Cancel' clause would never fire,
  // and a VTEC action 'EXP' clause would drop in-force warnings in their final
  // minutes. A certainty clause is unmeasured, and severity already encodes
  // the tier.
  return props.urgency !== 'Past';
}

// ---------------------------------------------------------------------------
// Pin identity
// ---------------------------------------------------------------------------

// P-VTEC: /k.aaa.cccc.pp.s.####.yymmddThhnnZ-yymmddThhnnZ/
var VTEC_RE = /^\/[A-Z]\.[A-Z]{3}\.([A-Z0-9]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.(\d{6})T\d{4}Z-(\d{6})T\d{4}Z/;

// NWS `parameters` values are always arrays of strings, so the VTEC string is
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

// The VTEC event key, which is stable across a reissue chain, or null. The year
// keeps a new year's event off the old one's tl_pins entry, because ETNs
// recycle annually. It is the VTEC end's, as the begin is 000000T0000Z on every
// CON/EXT reissue; an EXT across New Year mints a second pin.
function pinIdFor(props, nowSec) {
  var v = vtecOf(props);
  // No fallback id: the alert's `id` and every other candidate change on
  // reissue, so each would duplicate the pin, and `id` exceeds the 64-char cap.
  if (!v) return null;
  var yy;
  if (v.endYY !== '000000') yy = v.endYY.slice(0, 2);
  else if (v.beginYY !== '000000') yy = v.beginYY.slice(0, 2);
  else yy = String(new Date(nowSec * 1000).getUTCFullYear()).slice(2);
  return 'wx.20' + yy + '.' + v.office + '.' + v.phenom + '.' + v.sig + '.' + v.etn;
}

// The shape pinIdFor mints. renewPins inserts from persisted state, so it
// checks the key before it trusts the entry. No /g flag: lastIndex would make
// the test depend on call order.
var PIN_ID_RE = /^wx\.\d{4}\.[A-Z0-9]{4}\.[A-Z]{2}\.[A-Z]\.\d{4}$/;

// ---------------------------------------------------------------------------
// Pin content
// ---------------------------------------------------------------------------

// The HAZARD.../IMPACT... sections, when present, make a short body where the
// raw description often overruns the body cap. The lookahead ends a section at
// the next capitalised `WORD...` label or at end of string. No /g flag: a
// module-level /g regex keeps lastIndex between calls, which would make
// bodyFor, and so pinSig, depend on call order.
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

// Only documented system icons. There is no tornado or lightning icon, and the
// phone app and pypkjs both drop an id they do not know, which leaves the pin
// with no icon.
function iconFor(title) {
  if (/Flood|Rain|Hurricane|Tropical|Marine/.test(title)) {
    return 'system://images/HEAVY_RAIN';
  }
  if (/Snow|Winter|Blizzard|Ice|Freez/.test(title)) {
    return 'system://images/HEAVY_SNOW';
  }
  return 'system://images/GENERIC_WARNING';
}

// Card colors by VTEC significance: W is a Warning, A is a Watch, and any other
// takes none. Each must be a string, or the phone app drops the pin, and
// palette-exact (00, 55, AA or FF per channel), where it and pebble-tool agree.
var PIN_COLORS = {
  W: { backgroundColor: '#FF0000', primaryColor: '#FFFFFF' },
  A: { backgroundColor: '#FFFF00', primaryColor: '#000000' }
};

// The pin to insert. pinSig hashes JSON.stringify(pin), so reordering these
// keys re-inserts every live pin.
function pinAt(id, timeSec, mins, layout) {
  return { id: id, time: isoOf(timeSec),
           duration: Math.max(1, Math.min(MAX_DURATION_MIN, mins)),
           layout: layout };
}

// Returns {id, pin, time, anchor, endSec}, or null (not severe, no VTEC key,
// or an unusable nowSec). `time` is the walked start; `anchor` is the
// first-seen onset, which the caller persists and passes back, 0 if none. The
// layout's key order is part of pinSig's contract, as pinAt's is.
function buildPin(props, anchorSec, nowSec, dayStartSec) {
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

  // The persisted anchor wins over a fresh `onset`, which moves forward on
  // reissues: the API stamps a CON/EXT with its send time.
  var anchor = Math.min((anchorSec > 0) ? anchorSec : onsetSec,
                        anchorCeil(nowSec));
  var timeSec = startFor(anchor, endSec, nowSec, dayStartSec);

  // Duration last, from the walked start, so the pin's end stays fixed: the
  // firmware reads time + duration * 60 as the end (event.c
  // timeline_event_is_ongoing).
  var mins = endSec ? Math.round((endSec - timeSec) / 60) : 1;
  // With no `ends`, a non-positive span means the resend deadline fell before
  // the time, not that the hazard is over (a new watch for tomorrow can do
  // this). A 1-minute pin would stop reading as current at once, so use an
  // hour; an expiring alert that carries `ends` keeps its short pin.
  if (mins < 1 && !endsSec) mins = 60;

  // Never run pin text through index.js's fitWx/budgetFor: they fit the watch's
  // text slots and would cut a pin title to 25 characters.
  var title = clip(String(props.event || 'Weather Alert'), TITLE_MAX);
  // areaDesc lists every zone in the segment, ';'-separated, even on a point
  // query, so the subtitle takes the first.
  var area = clip(collapse(props.areaDesc).split(';')[0], SUBTITLE_MAX);
  var body = bodyFor(props);

  // genericPin, never weatherPin: that requires `locationName` and its subtitle
  // takes only numbers and the degree symbol (pin-structure.md:624-626).
  var layout = { type: 'genericPin', title: title };
  // Omitted, not emptied: an absent field must never enter the signature as ''.
  if (area) layout.subtitle = area;
  if (body) layout.body = body;
  layout.tinyIcon = iconFor(title);
  // The significance is part of the pin id, so a pin never changes color. The
  // colors paint only the opened card, its status bar and its action menu; the
  // Timeline list row and Quick View ignore them. vtecOf parses here, because
  // pinIdFor returned an id.
  var colors = PIN_COLORS[vtecOf(props).sig];
  if (colors) {
    layout.backgroundColor = colors.backgroundColor;
    layout.primaryColor = colors.primaryColor;
  }

  return {
    id: id,
    pin: pinAt(id, timeSec, mins, layout),
    time: timeSec,
    anchor: anchor,
    endSec: endSec
  };
}

// Deterministic because pinAt and buildPin insert keys in one fixed order.
function pinSig(pin) {
  return strHash(JSON.stringify(pin));
}

// ---------------------------------------------------------------------------
// Planning and dedupe
// ---------------------------------------------------------------------------

// A state entry is {t, x, s, l}: the first-seen onset, the latest known end,
// the signature the timeline is believed to hold, and the pin's layout while
// it is longer than a day and the last successful fetch listed its alert.

// Returns {puts, state}, the state mutated in place. It does not throw on a
// malformed response, except on a field that is an object with a `toString`
// key. It never sets `s`: only commitPin does, once an insert returns without
// throwing, so a failed insert cannot poison the cache into skipping that pin
// forever.
function planPins(features, state, nowSec, dayStartSec) {
  if (!state || typeof state !== 'object') state = {};
  // Same guard as buildPin's, for the same reason: nowSec drives the GC cutoff
  // and every clamp, so an unrepresentable one has no safe interpretation.
  if (!sane(nowSec)) {
    return { puts: [], state: state };
  }

  var k, e, keys = [], i;

  // Shape GC first, so a corrupt entry can never be read as an anchor. It runs
  // per entry, not on the whole blob, so one bad key cannot cost every live
  // pin its anchor.
  for (k in state) {
    if (!hasOwn(state, k)) continue;
    e = state[k];
    if (!e || typeof e !== 'object' ||
        typeof e.t !== 'number' || !isFinite(e.t) ||
        typeof e.x !== 'number' || !isFinite(e.x)) {
      delete state[k];
    }
  }

  // Duck-typed and length-checked: `features` comes straight off a parsed JSON
  // body.
  var feats = (features && typeof features.length === 'number') ? features : [];
  // One representative per pin id: NWS splits a product into per-zone features
  // sharing one VTEC key, and a candidate per feature would rewrite the pin
  // every heartbeat without the dedupe converging.
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
    var r = buildPin(props, (e && e.t) || 0, nowSec, dayStartSec);
    if (!r) continue;
    // `t` is written once, on first sight, and the start is derived from it on
    // every plan. Segments after the first build against the same anchor, which
    // keeps them comparable below.
    if (!e) { e = { t: r.anchor, x: 0, s: null }; state[r.id] = e; }
    // endSec 0 means neither `ends` nor `expires` parsed; the entry still needs
    // a GC key, and time+60 matches the 1-minute duration buildPin emitted.
    var x = r.endSec || (r.time + 60);
    var sig = pinSig(r.pin);
    // The tiebreak key hashes the layout, not the pin: a key that moved with
    // the start would let two segments swap text at every step.
    var tie = strHash(JSON.stringify(r.pin.layout));
    var c = chosen[r.id];
    if (!c) ids.push(r.id);
    // Latest end wins, so the pin outlives its sibling segments. Equal ends go
    // to the lower layout hash, never to feed order, which NWS does not promise
    // is stable.
    if (!c || x > c.x || (x === c.x && tie < c.tie)) {
      chosen[r.id] = { sev: (props.severity === 'Extreme') ? 1 : 0,
                       x: x, sig: sig, tie: tie, pin: r.pin };
    }
    // Written here, not after the cap, which sorts on it: a new entry would
    // still read x 0 there, the cap would evict the last plan's survivors
    // instead, and above the cap the dedupe would never converge.
    e.x = chosen[r.id].x;
  }

  // An unlisted entry loses its layout, so renewPins cannot keep alive the pin
  // of an alert that left the feed, and is dropped once its end is GC_AGE_SEC
  // past. Never age out a listed entry: an alert can stay listed days past its
  // stated end, and dropping its entry would re-insert the pin every fetch.
  for (k in state) {
    if (!hasOwn(state, k) || chosen.hasOwnProperty(k)) continue;
    if (state[k].x < nowSec - GC_AGE_SEC) delete state[k];
    else delete state[k].l;
  }

  // Hard cap, run after the feature loop, which adds entries. Unlisted entries
  // go first, deadest end first, then listed ones, latest end first: evicting
  // the soonest-ending would match the candidate sort's order, so above the cap
  // every committed entry would be deleted before the next plan read it and
  // re-inserted forever.
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
    // Re-insert on any signature change: a reissue that moves `ends`, updated
    // text, or the start stepping at a local midnight. The colors are fixed per
    // id. Inserting an existing id updates that pin and never adds a second.
    if (e.s !== ch.sig) {
      cands.push({ sev: ch.sev,
                   put: { id: cid, pin: ch.pin, sig: ch.sig, endSec: ch.x } });
    }
    // A pin longer than a day has to step again, so its layout is kept for
    // renewPins: built text of at most about 750 bytes, never the raw alert.
    if (ch.pin.duration > ALL_DAY_MIN) e.l = ch.pin.layout; else delete e.l;
  }

  // Extreme first, then soonest end, then id. A total order (ids are unique),
  // so the result does not depend on Array.prototype.sort being stable.
  cands.sort(function (a, b) {
    if (a.sev !== b.sev) return b.sev - a.sev;
    if (a.put.endSec !== b.put.endSec) return a.put.endSec - b.put.endSec;
    return a.put.id < b.put.id ? -1 : (a.put.id > b.put.id ? 1 : 0);
  });

  var puts = cands.slice(0, MAX_PUTS_PER_FETCH)
                  .map(function (cd) { return cd.put; });
  return { puts: puts, state: state };
}

// The plan when the alert fetch failed: steps each committed pin that still
// has a stored layout, up to its last known end. It creates nothing, extends
// nothing and leaves the state alone; its puts commit as planPins' do.
function renewPins(state, nowSec, dayStartSec) {
  if (!state || typeof state !== 'object') state = {};
  if (!sane(nowSec)) return { puts: [], state: state };

  var cands = [], k, e;
  for (k in state) {
    if (!hasOwn(state, k)) continue;
    e = state[k];
    if (!PIN_ID_RE.test(k) || !e || typeof e !== 'object' ||
        typeof e.s !== 'string' ||
        !e.l || typeof e.l !== 'object' ||
        typeof e.l.type !== 'string' || typeof e.l.title !== 'string' ||
        !sane(e.t) || !(e.t > 0) || !sane(e.x) || !(e.x > nowSec)) continue;
    // Built through startFor and pinAt, as buildPin's is, so a renewed pin and
    // a planned one cannot disagree.
    var timeSec = startFor(Math.min(e.t, anchorCeil(nowSec)), e.x, nowSec,
                           dayStartSec);
    var pin = pinAt(k, timeSec, Math.round((e.x - timeSec) / 60), e.l);
    var sig = pinSig(pin);
    if (sig !== e.s) cands.push({ id: k, pin: pin, sig: sig, endSec: e.x });
  }

  // Soonest end, then id: a total order, as in planPins.
  cands.sort(function (a, b) {
    if (a.endSec !== b.endSec) return a.endSec - b.endSec;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });

  return { puts: cands.slice(0, MAX_PUTS_PER_FETCH), state: state };
}

// Records that the timeline now holds this signature. A missing entry is
// ignored; the next plan recreates it with s null and re-inserts, which is
// wasteful but never wrong.
function commitPin(state, id, sig) {
  if (state && state[id]) state[id].s = sig;
}

// ---------------------------------------------------------------------------
// Exports: all pure; delivery lives in index.js
// ---------------------------------------------------------------------------

module.exports = {
  DAY_ROLL_SLACK_SEC: DAY_ROLL_SLACK_SEC,
  parseEpochSec:      parseEpochSec,
  isSevere:           isSevere,
  pinIdFor:           pinIdFor,
  buildPin:           buildPin,
  pinSig:             pinSig,
  planPins:           planPins,
  renewPins:          renewPins,
  commitPin:          commitPin,
  strHash:            strHash
};

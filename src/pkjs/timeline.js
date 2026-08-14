/**
 * Timeline pins for severe NWS alerts: turn an /alerts/active feature into the
 * one pin object Pebble.insertTimelinePin() accepts, and decide which pins are
 * worth inserting this heartbeat.
 *
 * Everything here is pure arithmetic and string work over the caller's objects:
 * no Pebble APIs, no XHR, no localStorage, no module-level state, no Date.now()
 * (`nowSec` is always a parameter, which is what lets a node harness pin the
 * clock and get byte-identical output). A node harness may require this file
 * freely and call anything in it. Delivery lives in index.js, which owns every
 * `Pebble.*` call in the phone process.
 *
 * Strict ES5 (var, function, no Map/Set, no Object statics, no arrow
 * functions): this ships through the pkjs bundler alongside index.js, whose
 * runtime predates all of them.
 *
 * index.js owns every log line in the phone process, so nothing here logs; a
 * QEMU grep for `TL ` then has exactly one owner.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Runaway guard on work done in one tick, not a rate-limit budget: local pins
// go straight to the phone, so there is no service and no request limit to
// spend. A point query returns 0-1 alerts and whole states carried 0-7 distinct
// pins at an instant, so this has never been the binding constraint. Overflow
// is simply left for the next heartbeat: nothing is lost, because planPins
// re-derives the same candidates from persisted state.
var MAX_PUTS_PER_FETCH = 8;

// The timeline WEB API rejected a `time` more than 2 days past or 1 year
// future (sdk-docs timeline-public.md). That route is deliberately unused here
// (see index.js), and no equivalent bound is documented for local pins, so this
// is kept as a conservative clamp rather than a known limit — the floor sits an
// hour inside it. What makes it live code is measured, not inherited: the live
// active feed never exceeded 14.4 h of onset age, but 17.7% of the 7-day
// archive does.
var PIN_TIME_FLOOR_SEC = 47 * 3600;
var PIN_TIME_CEIL_SEC  = 300 * 86400;

// The wire field is a uint16 of MINUTES. Out of range does not clamp anywhere
// downstream: libpebble2 raises struct.error, pypkjs turns that into
// item.rejected, and the log line goes to /dev/null unless the run was -vv —
// i.e. the pin just never appears. Max observed hazard is 9,458 min, so the
// ceiling is non-binding today and costs one call to be safe forever.
var MAX_DURATION_MIN = 65535;

// Matches the firmware's PIN_DB_MAX_AGE (pin_db.c:26,222): once the watch has
// auto-deleted a pin, our record of having sent it means nothing, and a fresh
// PUT for the same id is correctly a fresh creation.
var GC_AGE_SEC = 3 * 86400;

// Purely a runaway guard — a point query yields 0-1 alerts, so this cannot bite
// in normal operation. It exists because tl_pins shares a localStorage with two
// base64 PNGs, where a quota throw is swallowed by the writer and silently
// leaves stale data behind.
var MAX_STATE_ENTRIES = 64;

// The firmware and emulator cut title/subtitle at 63 BYTES and body at 511, so
// these caps are BYTES too and clip() counts them as such. They were char
// counts first, which is the same number for every NWS product measured (0 of
// 6,000 corpus messages and 0 of 34 Puerto Rico ones carried a non-ASCII byte;
// every one is language en-US) — but the guarantee that the serializer never
// re-cuts, and therefore can never split a UTF-8 sequence, is the whole reason
// the caps exist, and a char count does not deliver it for a product NWS has
// not yet shipped. 60 chars of emoji measured 140 bytes against a 63-byte cut.
var BODY_MAX     = 500;
var TITLE_MAX    = 60;
var SUBTITLE_MAX = 40;

// Date's own representable range (±8.64e15 ms), in seconds. Anything outside it
// makes toISOString throw RangeError, which would break this module's "never
// throws for any input" contract from a caller's bad clock rather than from bad
// NWS data. index.js always passes Math.floor(Date.now()/1000), so this is a
// contract guard, not a live path.
var MAX_EPOCH_SEC = 8.64e12;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

// FNV-1a 32-bit, 8 hex chars. The shift chain is the FNV prime
// (16777619 === 2^24+2^8+2^7+2^4+2^1+2^0), written out because Math.imul is not
// guaranteed on this runtime.
//
// composite.hashBytes is deliberately NOT reused: measured, given a JS string it
// degenerates to a length-only hash — two distinct 26-char urn:oid strings both
// produced '1a:47083d3f' — because it does `h ^= b[i]` and a one-character
// string coerces to NaN. Every same-length alert would collapse onto one
// signature and no update would ever be pushed.
function strHash(s) {
  var t = (s === null || s === undefined) ? '' : String(s);
  var h = 2166136261;
  for (var i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

// Local copy of index.js's parseEpoch, because this module imports nothing. NWS
// stamps are ISO 8601 with numeric offsets, never 'Z' (7 distinct offsets
// observed); Date.parse handles them, which index.js already relies on.
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

// Milliseconds stripped so the emitted string matches the documented form and
// the signature cannot be perturbed by a formatting detail.
function isoOf(sec) {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// NWS hard-wraps `description` with real newlines mid-sentence, so slicing it
// raw produces broken line breaks and wastes the 512-char budget. The String()
// coercion is load-bearing too: description is null on 4 of 6,050 corpus
// alerts, one of them a Special Marine Warning that passes the severity filter.
function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Clips to n UTF-8 BYTES, never mid-sequence and never between the halves of a
// surrogate pair — for ASCII, which is all NWS has ever emitted, this is
// byte-for-byte the old character slice. The pair handling is deliberately
// crude and only correct for well-formed input: a high surrogate is taken as
// the start of a pair on the strength of a following character alone, without
// checking it is a low surrogate. So a high surrogate at the very END of the
// string is dropped (it cannot be encoded), but one followed by anything else
// is passed through and billed 4 bytes. Unreachable for NWS — 0 of 6,050 corpus
// messages carried a non-ASCII byte — and tightening the test is the fix if a
// non-ASCII source ever appears here.
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

// Two clauses, and exactly two. Measured over a 6,050-message corpus (7 days of
// status=actual, the API's full archive retention) this is SET-IDENTICAL to the
// longer rule that also excludes messageType 'Cancel' and VTEC actions CAN/UPG:
// 3,177 of 6,050 messages, 1,170 distinct pins nationwide over 7 days.
//
// Applied in exactly one place — inside buildPin — so planPins cannot drift
// from it.
function isSevere(props) {
  if (!props) return false;
  // severity, not the event name. `Gale Warning` is Moderate/Minor, so the
  // "endswith Warning" shortcut is false in general -- and it is redundant
  // anyway: filtering on severity alone returned the identical set (3,179 of
  // 5,288 non-Cancel messages) as filtering on severity AND Warning-or-Watch.
  // Severity is also self-maintaining across seasons: Winter Storm Warning
  // could not be sampled in August (7-day archive retention), and an
  // event-name allowlist would have needed its winter rows guessed.
  if (props.severity !== 'Extreme' && props.severity !== 'Severe') return false;
  // Cancellations and upgrades LEAK into /alerts/active as messageType
  // 'Alert' with severity 'Severe' -- three were live in a single snapshot,
  // e.g. a Fire Weather Watch whose headline reads "has been replaced".
  // A severity-only filter pins those as live warnings. urgency Past filters
  // them exactly: every CAN/UPG message in the corpus carries it and nothing
  // else ever does, and it wrongly drops zero non-terminal severe alerts.
  // (The set claim is the load-bearing part and is what was tested. The count
  // was recorded twice from the same 6,050-message sweep and disagrees with
  // itself -- 766 here, 740 in CLAUDE.md -- and the 7-day archive retention
  // means the corpus is gone, so neither figure is quoted as fact any more.)
  return props.urgency !== 'Past';
}

// Deliberately absent, each measured rather than assumed:
//   messageType !== 'Cancel'  — redundant, and Cancel never appears in
//     /alerts/active at all (0/367 live, 0/36 archived Cancels present), so the
//     clause would never fire yet would look correct in review.
//   VTEC action not in {CAN,UPG} — redundant, and it would force the VTEC parse
//     to run before the filter, coupling two independent decisions.
//   VTEC action !== 'EXP' — WRONG. EXP means expiring naturally, not cancelled;
//     it would drop 451 severe messages including in-force Tornado Warnings in
//     their final minutes. EXP urgency is Immediate/Expected/Future, never Past,
//     so the rule above correctly keeps them.
//   any `certainty` clause — unmeasured, and severity already encodes the tier.

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

// The alert's own `id` is not usable twice over: it is 69 chars on all 6,050
// sampled (the limit is 64), and it CHANGES on every reissue — hashing it would
// mint a fresh pin per heartbeat, up to 19 duplicate pins for one warning, each
// persisting 3 days with no recovery path. The VTEC event key is the stable
// identity: measured unchanged across all 162 reference-linked message pairs,
// and present on 100% of severity-filtered alerts (3,177/3,177).
//
// The year is worth its 5 chars because the ETN recycles annually and a DELETEd
// pin id can never be reused — an id collision a year later would make a real
// alert un-pinnable. It comes from the VTEC END time because the BEGIN time is
// literally 000000T0000Z on every CON/EXT reissue, so a begin-derived year would
// be unstable along the chain. nowSec is the last resort only.
//
// Accepted edge: an event EXTended across a New Year boundary mints one extra
// pin. Once a year at worst, and no id is burned because nothing is DELETEd.
function pinIdFor(props, nowSec) {
  var v = vtecOf(props);
  if (!v) return null;
  var yy;
  if (v.endYY !== '000000') yy = v.endYY.slice(0, 2);
  else if (v.beginYY !== '000000') yy = v.beginYY.slice(0, 2);
  else yy = String(new Date(nowSec * 1000).getUTCFullYear()).slice(2);
  return 'wx.20' + yy + '.' + v.office + '.' + v.phenom + '.' + v.sig + '.' + v.etn;
}

// A feature whose VTEC key does not parse is skipped entirely, with no fallback
// id. Every available fallback (a hash of `id`, of event+areaDesc+ends) is
// unstable across reissues and would mint duplicates that live 3 days with no
// recovery path, because we never DELETE. It measured 0/3,177 on the severe
// filter set, so the path would be untested as well as harmful when it fired.
// A missing pin degrades to exactly today's behaviour; a pin flood does not.

// ---------------------------------------------------------------------------
// Pin content
// ---------------------------------------------------------------------------

// The structured sections are present on ~60% of severe alerts (1,891/3,177)
// and run ~60-100 chars combined — "60 mph wind gusts. Expect damage to roofs,
// siding, and trees." — which beats the raw text badly, since 21.4% of severe
// alerts exceed the 512-char body limit outright. The lookahead ends a section
// at the next ALLCAPS...  label or at end of string.
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

// All three resource ids are documented and were resolved in the emulator's own
// layouts.json (GENERIC_WARNING=28, HEAVY_RAIN=52, HEAVY_SNOW=53). There is no
// tornado or lightning icon: do NOT invent a resource id, an unknown one
// KeyErrors at serialise time in pypkjs and is refused by the firmware.
function iconFor(title) {
  if (/Flood|Rain|Hurricane|Tropical|Marine/.test(title)) {
    return 'system://images/HEAVY_RAIN';
  }
  if (/Snow|Winter|Blizzard|Ice|Freez/.test(title)) {
    return 'system://images/HEAVY_SNOW';
  }
  return 'system://images/GENERIC_WARNING';
}

// anchorSec is the caller's persisted first-seen onset for this pin id (0 when
// none is recorded yet). It exists because `onset` drifts FORWARD on 96% of
// multi-message VTEC chains — a CON/EXT reissue carries VTEC start 000000T0000Z
// and the API stamps onset with the send time — so reading onset fresh each
// heartbeat makes the pin's start walk forward every 10 minutes and jump in the
// user's timeline. Silently, since every PUT succeeds.
//
// Key insertion order is part of the contract: pinSig hashes
// JSON.stringify(pin), so reordering these assignments re-PUTs every live pin.
function buildPin(props, anchorSec, nowSec) {
  if (!isSevere(props)) return null;
  // A nowSec Date cannot represent (NaN, undefined, 1e18) would make isoOf
  // throw RangeError out of a function documented never to throw. No pin is
  // better than a pin dated off a clock that is not a clock; the comparison
  // form is deliberate, since every relational test against NaN is false.
  if (!sane(nowSec)) return null;
  var id = pinIdFor(props, nowSec);
  if (!id) return null;

  // End FIRST, and from `ends` before `expires` — the OPPOSITE preference from
  // index.js's `ex`, which is right for its own question ("when does this watch
  // STRING go stale") and wrong here. `expires` is the product RESEND deadline,
  // not the hazard end: expires-onset is <= 0 for 4.6% of non-Cancel messages,
  // worst case -5,430 minutes (an Extreme Heat Watch whose expires falls 4 days
  // before its onset). The || fallback is live code, not decoration: `ends` is
  // null 16.9% of the time, including 15 Flood Warnings and 10 Hurricane
  // Watches that pass the severity filter.
  var endsSec = parseEpochSec(props.ends);
  var endSec = endsSec || parseEpochSec(props.expires);

  // onset measured never-null across all 6,050 corpus alerts; the chain costs
  // nothing and covers the status:Test shape (null onset) if &status=actual is
  // ever lost.
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
  // The floor matters: 2.3% of messages compute <= 0 even with (ends||expires).
  var mins = endSec ? Math.round((endSec - timeSec) / 60) : 1;
  // A non-positive span from a `ends`-less alert is not a hazard that is over,
  // it is the RESEND deadline being read as one: measured across the corpus at
  // each message's own send time, 118 of 3,165 pins computed <= 1 minute, and
  // the two that were NOT already-expiring VTEC EXP messages were brand-new
  // watches for TOMORROW whose `expires` fell before their own onset. A
  // 1-minute pin lands at the right time and then stops reading as current one
  // minute later (event.c:214 timeline_event_is_ongoing), i.e. never shows for
  // the hazard it describes. An hour is the honest floor for "end unknown"; a
  // real EXP still gets its short pin, because those carry `ends`.
  if (mins < 1 && !endsSec) mins = 60;
  var duration = Math.max(1, Math.min(MAX_DURATION_MIN, mins));

  // `event` is 11-32 chars and never null, so it needs no abbreviation — and
  // must never be run through index.js's fitWx/budgetFor, which exist to fit
  // the watch's four text slots against a pixel budget and would cut a pin
  // title to 25 characters.
  var title = clip(String(props.event || 'Weather Alert'), TITLE_MAX);
  // areaDesc reaches 1,174 chars on area-wide queries. A point query returns
  // one segment, so the split is the safety net rather than the normal path.
  var area = clip(collapse(props.areaDesc).split(';')[0], SUBTITLE_MAX);
  var body = bodyFor(props);

  // genericPin, always. NEVER weatherPin: it requires `locationName` and its
  // subtitle supports only numbers and the degree symbol (pin-structure.md:
  // 624-626). This exact combination — GENERIC_WARNING + title + subtitle +
  // body — was rendered on emery and read back off a screenshot, so it is
  // known to display.
  //
  // No color fields. Local pins ignore primaryColor/secondaryColor/
  // backgroundColor outright, so a severity color would be dead weight on the
  // only route that ships. Note the emulator DISAGREES here: `pebble
  // insert-pin` injects over the SDK's own websocket rather than through the
  // phone's local-pin path, and it does honour backgroundColor — an earlier
  // screenshot showed the severity color rendering. That screenshot was not
  // evidence about real hardware.
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

// Decide what to PUT this fetch, and maintain the persisted dedupe map in the
// same pass. MUTATES `state` and returns the same object identity, so the
// caller writes back exactly what it passed in.
//
// This never throws for any input, deliberately: it runs off an NWS response
// shape nobody controls, from a code path that must never disturb the weather
// payload, and index.js's try/catch is the SECOND layer, not the first.
//
// It does NOT set `s` on anything — a plan is not a delivery. Only commitPin
// does, and index.js calls it only once insertTimelinePin has returned without
// throwing, exactly as tx_hash is committed only on the final chunk's ACK: a
// push that dies halfway must not poison the cache into skipping that pin
// forever. (That is weaker proof than the ACK — the local-pin call reports
// nothing at all — which index.js records at its call site.)
function planPins(features, state, nowSec) {
  if (!state || typeof state !== 'object') state = {};
  // Same guard as buildPin's, for the same reason: nowSec drives the GC cutoff
  // and every clamp, so an unrepresentable one has no safe interpretation.
  if (!sane(nowSec)) {
    return { puts: [], state: state };
  }

  var k, e, keys = [], i;

  // GC first, so a corrupt or expired entry can never be read as an anchor. A
  // blob written by an older or a future build is discarded per-entry rather
  // than wholesale — one bad key must not cost every live pin its anchor.
  for (k in state) {
    if (!state.hasOwnProperty(k)) continue;
    e = state[k];
    if (!e || typeof e !== 'object' ||
        typeof e.t !== 'number' || !isFinite(e.t) ||
        typeof e.x !== 'number' || !isFinite(e.x) ||
        e.x < nowSec - GC_AGE_SEC) {
      delete state[k];
    }
  }

  // Duck-typed rather than Array.isArray'd, and length-checked rather than
  // trusted: `features` comes straight off a parsed JSON body.
  var feats = (features && typeof features.length === 'number') ? features : [];
  // ONE representative per pin id, chosen here rather than downstream. NWS
  // splits a single VTEC product into per-zone segments that arrive as separate
  // features carrying the same office/phenom/sig/ETN: 15 of 142 distinct pin
  // ids in one live nationwide feed had 2-10 of them (a Hurricane Watch had
  // 10). Pushing a candidate per feature made the same id appear twice in one
  // plan, so each insert overwrote the other and only the last one's signature
  // was committed — the user's pin rewrote itself with a different county group
  // every heartbeat, forever, and the dedupe never converged. Collapsing is not
  // a loss: one pin id can only ever hold one segment's text.
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
    // The anchor stored on first sight is the POST-clamp time, so a clamped
    // anchor is remembered as clamped and does not re-derive from a drifting
    // onset on the next beat. Segments after the first therefore all build
    // against the same anchor, which is what keeps them comparable below.
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
    // Written here and not after the cap below, which sorts on it: an entry
    // created this pass would otherwise still read x 0 there, so the cap would
    // spare every new entry and evict the ones that survived the last plan —
    // measured as 8 PUTs a beat forever on a nationwide feed carrying well over
    // the MAX_STATE_ENTRIES cap. (Two such feeds were used across this section's
    // reproductions, 127 and 142 distinct ids; which one produced this figure
    // was not written down, so it is deliberately not named here.)
    e.x = chosen[r.id].x;
  }

  // Hard cap, run AFTER the loop. Running it before was doubly wrong: one plan
  // could still leave more than MAX_STATE_ENTRIES behind (measured: 64 seeded
  // plus a 12-alert feed left 76), and — worse — it evicted lowest-`x` first,
  // which is exactly the order the candidate sort below pushes in. Above 64
  // distinct ids every entry committed on a 200 was deleted before the next
  // plan could read it, recreated with s null, and re-inserted forever: measured at
  // 8 PUTs a beat for 60 straight beats on the live nationwide feed, the same
  // 8 ids every time, while the other 119 alerts were never pushed at all.
  //
  // So: entries this plan did not see go first (deadest end first — they have
  // left the feed), and only then live ones, LAST end first. Dropping the
  // latest-ending live entry is the one choice that cannot fight the sort,
  // which ranks soonest-ending first.
  for (k in state) { if (state.hasOwnProperty(k)) keys.push(k); }
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

  // Candidates come from what SURVIVED the cap, so an evicted id is never
  // pushed — that is the other half of the convergence fix above.
  var cands = [];
  for (i = 0; i < ids.length; i++) {
    var cid = ids[i];
    e = state[cid];
    if (!e) continue;                    // evicted by the cap just above
    var ch = chosen[cid];
    // Re-insert on any signature change — time, duration, title, subtitle,
    // body or tinyIcon. In practice that is an EXT/CON reissue that moves
    // `ends`, or an updated storm description. Both are genuine updates to the
    // SAME id (inserting an existing id updates that pin), not duplicates.
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

// Record that the TIMELINE now holds this signature. A missing entry is not an
// error — the guard is defensive, not a case anyone has produced: insertion is
// synchronous and the GC runs at the top of planPins, so nothing can drop an
// entry between a plan and its commit. If one ever were dropped, the next plan
// recreates it with s null and re-pushes — wasteful at worst, never wrong.
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

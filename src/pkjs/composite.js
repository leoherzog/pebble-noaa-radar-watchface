/**
 * Phone-side compositing: blend the USGS topo basemap and the NOAA MRMS
 * reflectivity overlay into ONE 16-color 4bpp PNG, so the watch holds a single
 * frame instead of two and never composites at draw time.
 *
 * Everything here is pure arithmetic over typed arrays: no Pebble APIs, no
 * localStorage, no module-level state. Width and height are PARAMETERS, never
 * captured — index.js's IMG_W/IMG_H are reassigned at 'ready' from the
 * connected watch's platform, and a module that captured them at load time
 * would render emery-sized imagery on basalt.
 *
 * Strict ES5 (var, no Map/Set, no arrow functions): this ships through the
 * pkjs bundler alongside index.js, which deliberately avoids ES5 object
 * statics and newer collection types.
 */

// zlib for the IDAT. Declared in package.json rather than leaned on as a
// hoisted transitive dep of upng-js: a future upng bump that nests its own
// copy would otherwise break the build.
var pako = require('pako');

// ---------------------------------------------------------------------------
// The pixel rule
// ---------------------------------------------------------------------------
//
// Per pixel, one 6-bit display color (2 bits per channel, 0..3 each):
//
//   a = radarAlpha >> 6                          (0..3)
//   translucent && a == 3  ->  a = 2             (was main.c's palette rewrite)
//   a == 0  ->  floor(basemap)   >>6 per channel
//   a == 3  ->  floor(radar)     >>6 per channel
//   else    ->  round(blend)     round(v/85) per channel, f = a/3
//
// The asymmetry is deliberate and is the whole point: DO NOT RE-QUANTIZE A
// VALUE YOU DID NOT COMPUTE. Where alpha is 0 or 3 the output IS a source
// color, so it passes through with exactly the >>6 the watch itself would have
// applied — which keeps opaque mode pixel-exact with what the watch renders
// today. Only genuinely blended pixels are rounded to nearest, because
// flooring a linear mix lands it in the wrong bucket and reads muddy.
// Measured: rounding everywhere shifts the NWS ramp a full tier (yellow reads
// as orange, i.e. moderate rain looks heavy); flooring everywhere makes
// translucent muddy. This split rule is the one that gets both.
//
// In translucent mode the a === 3 branch is unreachable by construction (alpha
// 3 was downgraded to 2). That is correct, not dead code.
//
// The tier label used by the fold is the radar SOURCE color (floored to 6-bit)
// wherever a > 0, and -1 elsewhere.

// bmRgba: quantized basemap RGBA, w*h*4. rdRgba: quantized radar RGBA, or null
// when the radar layer is Disabled (every pixel then reads as a === 0, i.e. a
// pass-through basemap). radarMode: 0 disabled, 1 translucent, 2 opaque.
// Returns {bytes: Uint8Array PNG, colors: exact palette size, folded: after fold}.
function buildComposite(bmRgba, rdRgba, radarMode, w, h) {
  var translucent = (radarMode === 1);
  var n = w * h;
  var fb = new Uint8Array(n);              // 6-bit display color per pixel
  var tally = new Int32Array(64 * 65);     // [outColor * 65 + (tierLabel + 1)]
  var i;

  for (i = 0; i < n; i++) {
    var p = i * 4;
    var br = bmRgba[p], bg = bmRgba[p + 1], bb = bmRgba[p + 2];
    var a = 0, sr = 0, sg = 0, sb = 0;
    if (rdRgba) {
      a = rdRgba[p + 3] >> 6;                    // 0..3
      if (translucent && a === 3) a = 2;         // was main.c's palette rewrite
      sr = rdRgba[p]; sg = rdRgba[p + 1]; sb = rdRgba[p + 2];
    }
    var out;
    if (a === 0) {
      out = ((br >> 6) << 4) | ((bg >> 6) << 2) | (bb >> 6);     // pass through
    } else if (a === 3) {
      out = ((sr >> 6) << 4) | ((sg >> 6) << 2) | (sb >> 6);     // pass through
    } else {
      var f = a / 3, g = 1 - f;                                  // computed
      out = (Math.round((sr * f + br * g) / 85) << 4) |
            (Math.round((sg * f + bg * g) / 85) << 2) |
             Math.round((sb * f + bb * g) / 85);
    }
    fb[i] = out;
    var tr = (a > 0) ? (((sr >> 6) << 4) | ((sg >> 6) << 2) | (sb >> 6)) : -1;
    tally[out * 65 + tr + 1]++;
  }

  // One tier label per output color: the tier that contributed the most pixels
  // to it. Ties resolve to the LOWEST label index, where -1 (non-radar) sorts
  // first — fixed here rather than left to a sort's stability, because the
  // transfer cache only ever hits if identical inputs give byte-identical
  // output.
  var tier = new Int16Array(64), hist = new Int32Array(64);
  var c, t, exact = 0;
  for (c = 0; c < 64; c++) {
    var bestN = -1, bestT = -1, sum = 0;
    for (t = 0; t < 65; t++) {
      var v = tally[c * 65 + t];
      sum += v;
      if (v > bestN) { bestN = v; bestT = t - 1; }
    }
    tier[c] = bestT;
    hist[c] = sum;
    if (sum) exact++;                    // distinct output colors before the fold
  }

  var f16 = foldTo16(hist, tier);
  var pal = f16.pal, map = f16.map;

  var index = new Uint8Array(64);
  for (i = 0; i < pal.length; i++) index[pal[i]] = i;
  var idx = new Uint8Array(n);
  for (i = 0; i < n; i++) idx[i] = index[map[fb[i]]];

  return {
    bytes: png4(idx, pal, w, h),
    colors: exact,
    folded: pal.length
  };
}

// ---------------------------------------------------------------------------
// The tier-aware fold
// ---------------------------------------------------------------------------
//
// After mapping to the display's 2-bits-per-channel space the composite is
// ALREADY an indexed image of at most 64 colors (19-29 in practice), so the
// palette is ENUMERATED, never searched for. UPNG.encode(..., 16) must never
// be run on the composite: that generic quantizer dithers and minimizes
// squared error as if the image were continuous-tone, and measured it gets
// 13-43% of pixels wrong — yellow bands render as solid orange, red cores
// vanish.
//
// When the enumeration exceeds 16 entries it is folded, and the fold POLICY
// matters more than anything else here. Merging by "fewest pixels changed"
// alone eats the high-dBZ cores, because they are the rarest pixels.
// Protecting everything radar-derived is also wrong: under translucency nearly
// every color is radar-derived, so the damage just moves to the basemap (one
// measured test went 0.04% -> 26% of pixels). The correct rule, and the only
// one that measured zero tier damage: NEVER merge two different reflectivity
// tiers. Merging within a tier, or between two non-radar colors, is free.
// Do not touch the cost function.
function foldTo16(hist, tier) {
  // Float64, not Int32: dist * pop * 1e9 reaches ~9e18, which a double holds
  // exactly enough for ordering and an int32 does not hold at all.
  var h = new Float64Array(64), map = new Uint8Array(64), cols = [];
  var c, i, j;
  for (c = 0; c < 64; c++) {
    h[c] = hist[c];
    map[c] = c;
    if (hist[c]) cols.push(c);
  }
  while (cols.length > 16) {
    var bi = 0, bj = 1, best = Infinity;
    for (i = 0; i < cols.length; i++) {
      for (j = i + 1; j < cols.length; j++) {
        var A = cols[i], B = cols[j];
        // Squared distance in the EXPANDED (v*85) space.
        var dr = (((A >> 4) & 3) - ((B >> 4) & 3)) * 85;
        var dg = (((A >> 2) & 3) - ((B >> 2) & 3)) * 85;
        var db = ((A & 3) - (B & 3)) * 85;
        var cost = (dr * dr + dg * dg + db * db) * Math.min(h[A], h[B]);
        var ta = tier[A], tb = tier[B];
        if (ta !== tb && ta !== -1 && tb !== -1) cost *= 1e9;
        // Strict <, with ascending iteration: the winner is deterministic.
        if (cost < best) { best = cost; bi = i; bj = j; }
      }
    }
    var keep = h[cols[bi]] >= h[cols[bj]] ? cols[bi] : cols[bj];
    var drop = (keep === cols[bi]) ? cols[bj] : cols[bi];
    for (c = 0; c < 64; c++) if (map[c] === drop) map[c] = keep;
    h[keep] += h[drop];
    h[drop] = 0;
    // tier[] is fixed at build time and never updated during folding: a
    // survivor keeps its own label. This matches the validated reference.
    cols.splice(cols.indexOf(drop), 1);
  }
  // cols was built ascending and splice preserves order, so the emitted
  // palette is always ascending by 6-bit value — deterministic palette order
  // is what makes the hash cache able to hit at all.
  return { pal: cols, map: map };
}

// ---------------------------------------------------------------------------
// Hand-rolled 4bpp palettized PNG
// ---------------------------------------------------------------------------
//
// Constraints below are verified against the firmware decoder
// (reference/PebbleOS/src/fw/applib/vendor/uPNG/upng.c and
// .../graphics/gbitmap_png.c). Violate any of them and the decode fails
// SILENTLY — the firmware hands back a GBitmap with a NULL pixel buffer:
//
//   - Exactly ONE IDAT chunk. upng.c carries "TODO: fix for multiple
//     consecutive IDAT chunks (PBL-14294)". Never split it.
//   - zlib-wrapped deflate, not raw: uz_inflate checks the 2-byte header
//     ((b0*256+b1) % 31 == 0, (b0 & 15) == 8, (b0 >> 4) <= 7) and rejects a
//     preset dictionary. pako.deflate at default windowBits emits 78 DA.
//   - No interlace, compression method 0, filter method 0, filter type 0 on
//     every row.
//   - PLTE of exactly 48 bytes: gbitmap_png.c pads the palette to 1 << bpp =
//     16 entries anyway, and palette_entries = data_length / 3, so a short
//     PLTE would leave entries at (0,0,0).
//   - No tRNS: absent alpha means GColorFromRGBA(..., UINT8_MAX) => a = 3,
//     fully opaque. Correct — the composite is opaque and the watch draws it
//     at the default GCompOpAssign.
//   - uPNG does not verify chunk CRCs, but emit correct ones anyway: upng-js,
//     used by the offline checks, does.

var SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

var CRC_T = (function () {
  var t = new Uint32Array(256), c, n, k;
  for (n = 0; n < 256; n++) {
    c = n;
    for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b, from, to) {
  var c = 0xFFFFFFFF;
  for (var i = from; i < to; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {          // type: 4 ASCII chars
  var out = new Uint8Array(12 + data.length), L = data.length, i;
  out[0] = (L >>> 24) & 255; out[1] = (L >>> 16) & 255;
  out[2] = (L >>> 8) & 255;  out[3] = L & 255;
  for (i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  var c = crc32(out, 4, 8 + L);
  out[8 + L] = (c >>> 24) & 255; out[9 + L] = (c >>> 16) & 255;
  out[10 + L] = (c >>> 8) & 255; out[11 + L] = c & 255;
  return out;
}

function concat(parts) {
  var total = 0, i;
  for (i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total), at = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
  return out;
}

function png4(idx, pal, w, h) {
  var rowB = (w + 1) >> 1;
  var raw = new Uint8Array((rowB + 1) * h), x, y, i;
  for (y = 0; y < h; y++) {
    var ro = y * (rowB + 1);
    raw[ro] = 0;                                   // filter type 0, every row
    for (x = 0; x < w; x++) {
      var v = idx[y * w + x];
      raw[ro + 1 + (x >> 1)] |= (x & 1) ? v : (v << 4);
    }
  }
  var ihdr = new Uint8Array(13);
  ihdr[0] = (w >>> 24) & 255; ihdr[1] = (w >>> 16) & 255;
  ihdr[2] = (w >>> 8) & 255;  ihdr[3] = w & 255;
  ihdr[4] = (h >>> 24) & 255; ihdr[5] = (h >>> 16) & 255;
  ihdr[6] = (h >>> 8) & 255;  ihdr[7] = h & 255;
  ihdr[8] = 4;      // bit depth 4
  ihdr[9] = 3;      // color type 3, palette
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;        // deflate / filter 0 / no interlace
  // ALWAYS 16 entries, zero-padded. Emitted as (v * 85) per channel because
  // the watch decodes palette entries with GColorFromRGBA, which truncates
  // (>>6), and (v * 85) >> 6 == v exactly for v in {0,1,2,3}. That is
  // arithmetic, not a firmware coupling.
  var plte = new Uint8Array(48);
  for (i = 0; i < pal.length; i++) {
    plte[i * 3]     = ((pal[i] >> 4) & 3) * 85;
    plte[i * 3 + 1] = ((pal[i] >> 2) & 3) * 85;
    plte[i * 3 + 2] = (pal[i] & 3) * 85;
  }
  var idat = pako.deflate(raw, { level: 9 });      // zlib-wrapped, ONE chunk
  return concat([SIG,
                 pngChunk('IHDR', ihdr),
                 pngChunk('PLTE', plte),
                 pngChunk('IDAT', idat),
                 pngChunk('IEND', new Uint8Array(0))]);
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

// FNV-1a 32-bit over the emitted PNG bytes, length-prefixed. The shift form of
// the prime multiply avoids depending on Math.imul; the length prefix costs
// nothing and removes the whole class of same-length collisions.
function hashBytes(b) {
  var h = 0x811C9DC5;
  for (var i = 0; i < b.length; i++) {
    h ^= b[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return b.length.toString(16) + ':' + (h >>> 0).toString(16);
}

module.exports = { buildComposite: buildComposite, hashBytes: hashBytes };

/**
 * Phone-side compositing: blend the USGS topo basemap and the NOAA MRMS
 * reflectivity overlay into one 16-color 4bpp PNG, so the watch holds a single
 * frame and never composites. Pure and node-requirable, in strict ES5 for the
 * legacy pkjs runtime. Width, height and roundness are parameters, never
 * captured: index.js sets IMG_W/IMG_H and WATCH_ROUND at 'ready', so a
 * load-time capture would render emery-sized imagery on basalt.
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
//   translucent && a == 3  ->  a = 2
//   a == 0  ->  floor(basemap)   >>6 per channel
//   a == 3  ->  floor(radar)     >>6 per channel
//   else    ->  round(blend)     round(v/85) per channel, f = a/3
//
// The asymmetry is deliberate: never re-quantize a value you did not compute.
// Where alpha is 0 or 3 the output is a source color and passes through with
// the watch's own >>6; only blended pixels are rounded to nearest. Rounding
// everywhere shifts the NWS ramp a full tier (yellow reads as orange, so
// moderate rain looks heavy); flooring everywhere makes translucent muddy.
//
// The a === 3 branch is unreachable in translucent mode and needed in opaque.
//
// The tier label used by the fold is the radar SOURCE color (floored to 6-bit)
// wherever a > 0, and -1 elsewhere.

// bmRgba: quantized basemap RGBA, w*h*4. rdRgba: quantized radar RGBA, or null
// when the radar layer is Disabled (every pixel then reads as a === 0, i.e. a
// pass-through basemap). radarMode: 0 disabled, 1 translucent, 2 opaque.
// round: the display is round. Pixels it hides then carry no weight in the
// histogram, the tier labels or the fold, and are all written as palette
// index 0, which exists because some pixel always shows.
// Returns {bytes: Uint8Array PNG, colors: exact palette size over the visible
// pixels, folded: after fold}.
function buildComposite(bmRgba, rdRgba, radarMode, w, h, round) {
  var translucent = (radarMode === 1);
  var n = w * h;
  var fb = new Uint8Array(n);              // 6-bit display color per pixel
  var tally = new Int32Array(64 * 65);     // [outColor * 65 + (tierLabel + 1)]
  var i;
  var hidden = hiddenPixels(w, h, round);

  for (i = 0; i < n; i++) {
    if (hidden && hidden[i]) continue;
    var p = i * 4;
    var br = bmRgba[p], bg = bmRgba[p + 1], bb = bmRgba[p + 2];
    var a = 0, sr = 0, sg = 0, sb = 0;
    if (rdRgba) {
      a = rdRgba[p + 3] >> 6;                    // 0..3
      if (translucent && a === 3) a = 2;
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
  for (i = 0; i < n; i++) {
    idx[i] = (hidden && hidden[i]) ? 0 : index[map[fb[i]]];
  }

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
// already indexed, at most 64 colors, so the palette is enumerated, never
// searched for. Never run UPNG.encode(..., 16) on it: that quantizer dithers
// as if the image were continuous-tone, turning yellow bands orange and
// erasing red cores.
//
// Above 16 entries the palette is folded, and the policy matters most.
// Merging by fewest pixels changed eats the rare high-dBZ cores; protecting
// everything radar-derived moves the damage to the basemap under
// translucency. So two different reflectivity tiers merge only as a last
// resort (cost x 1e9); merging within a tier or with a non-radar color costs
// normally. Do not touch the cost function.
function foldTo16(hist, tier) {
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
    // tier[] is fixed before folding and never updated: a survivor keeps its
    // own label.
    cols.splice(cols.indexOf(drop), 1);
  }
  // cols was built ascending and splice preserves order, so the emitted
  // palette is always ascending by 6-bit value — deterministic palette order
  // is what makes the hash cache able to hit at all.
  return { pal: cols, map: map };
}

// ---------------------------------------------------------------------------
// Round-display corners
// ---------------------------------------------------------------------------
//
// The firmware's topleft_mask for each round display, keyed by width: row y
// shows columns [m, w - 1 - m] with m = mask[min(y, h - 1 - y)]
// (reference/PebbleOS src/fw/board/displays/display_getafix.c; 180 is
// g_gbitmap_legacy_3x_data_row_infos, the table SDK 4.33's chalk QEMU image
// carries too).
// Only these tables are safe: a computed circle one pixel too tight would
// blank a pixel the watch shows. The watch draws the composite at its full
// bounds, so frame pixels and display pixels coincide.
var ROUND_MASK = {
  180: [
    76, 71, 66, 63, 60, 57, 55, 52, 50, 48, 46, 45, 43, 41, 40, 38, 37,
    36, 34, 33, 32, 31, 29, 28, 27, 26, 25, 24, 23, 22, 22, 21, 20, 19,
    18, 18, 17, 16, 15, 15, 14, 13, 13, 12, 12, 11, 10, 10, 9, 9, 8, 8, 7,
    7, 7, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ],
  260: [
    113, 107, 102, 98, 94, 90, 87, 85, 82, 80, 77, 75, 73, 71, 69, 67, 65, 64,
    62, 60, 59, 57, 56, 54, 53, 52, 50, 49, 48, 46, 45, 44, 43, 42, 41, 40, 39,
    38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 29, 28, 27, 26, 26, 25, 24, 23, 23,
    22, 21, 21, 20, 19, 19, 18, 18, 17, 16, 16, 15, 15, 14, 14, 13, 13, 12, 12,
    11, 11, 10, 10, 10, 9, 9, 8, 8, 8, 7, 7, 6, 6, 6, 5, 5, 5, 5, 4, 4, 4, 4, 3,
    3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0
  ]
};

// 1 for each pixel of a w x h frame that a round display hides, or null when
// every pixel shows: a rectangular display, or a size with no ROUND_MASK row.
function hiddenPixels(w, h, round) {
  var mask = (round && w === h) ? ROUND_MASK[w] : null;
  if (!mask) return null;
  var out = new Uint8Array(w * h), x, y, m;
  for (y = 0; y < h; y++) {
    m = mask[Math.min(y, h - 1 - y)];
    for (x = 0; x < m; x++) out[y * w + x] = out[y * w + w - 1 - x] = 1;
  }
  return out;
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
//   - uPNG does not verify chunk CRCs; emit correct ones anyway so the file
//     stays a valid PNG for any other decoder.

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

// FNV-1a 32-bit over the emitted PNG bytes, with the length prepended to the
// result so inputs of different lengths never collide. The shift form of the
// prime multiply avoids depending on Math.imul. Bytes only: on a JS string
// every non-digit character XORs in as 0.
function hashBytes(b) {
  var h = 0x811C9DC5;
  for (var i = 0; i < b.length; i++) {
    h ^= b[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return b.length.toString(16) + ':' + (h >>> 0).toString(16);
}

module.exports = { buildComposite: buildComposite, hashBytes: hashBytes };

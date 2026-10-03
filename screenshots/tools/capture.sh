#!/usr/bin/env bash
# Capture one gallery tile: capture.sh <platform> <scenario-id>
#
# Run it only as `bash capture.sh ...`, for the pkill reason in emu.sh.
set -uo pipefail

PLATFORM="${1:?platform}"
SID="${2:?scenario id}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(cd "$HERE/../.." && pwd)"
# shellcheck source=emu.sh
source "$HERE/emu.sh"
# GALLERY_DIR overrides where tiles land. The default overwrites the committed
# tile, so a before/after comparison must redirect one pass or it diffs each
# tile against itself and always reports zero.
OUTDIR="${GALLERY_DIR:-$PROJ/screenshots/gallery}/$PLATFORM"
LOGDIR="${TMPDIR:-/tmp}/pebble-gallery-logs"
mkdir -p "$OUTDIR" "$LOGDIR"

# One parse of scenarios.json for the three static fields. Safe to split on
# whitespace: slugs are hyphenated with no spaces, fmt is 12h/24h, battery is an
# int. The 'clock' field is read where it is applied, so a now+ clock counts
# from that moment.
read -r SLUG FMT BATT < <(python3 -c "
import json
s=[x for x in json.load(open('$HERE/scenarios.json')) if x['id']==$SID][0]
print('%02d-%s %s %s' % (s['id'], s['slug'], s['fmt'], s['battery']))")

OUT="$OUTDIR/$SLUG.png"
LOG="$LOGDIR/$PLATFORM-$SLUG.log"

boot "[$PLATFORM/$SLUG]" "$PLATFORM" "$SID" "$LOGDIR/$PLATFORM-$SLUG.boot.log"

# These two work against a running --vnc emulator only with the flags spelled
# out; otherwise they try to launch a second emulator, print "Emulator launch
# timed out" and exit 1, leaving the setting unapplied and the tile silently
# wrong. The exit status is honest here, so it is checked.
pebble emu-time-format --emulator "$PLATFORM" --vnc "${SDKARG[@]}" --format "$FMT" >/dev/null 2>&1 \
  || { echo "[$PLATFORM/$SLUG] emu-time-format FAILED"; cleanup; exit 1; }
pebble emu-battery --emulator "$PLATFORM" --vnc "${SDKARG[@]}" --percent "$BATT" >/dev/null 2>&1 \
  || { echo "[$PLATFORM/$SLUG] emu-battery FAILED"; cleanup; exit 1; }

DECODED=0
if relaunch_logged "$PLATFORM" "$LOG"; then
  DECODED=1
  # On a relaunch the replayed frame decodes before the phone's fresh
  # `Composite <N> B ... hash <h>` line prints, and that hash is what tells two
  # passes' images apart, so stay attached until it lands too.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    grep -q "Composite [0-9]" "$LOG" 2>/dev/null && break
    sleep 2
  done
fi
kill "$LOGPID" >/dev/null 2>&1

if [ "$DECODED" -ne 1 ]; then
  echo "[$PLATFORM/$SLUG] NO DECODE within 240s -- see $LOG"
  grep -Ei "fail|error|refus|skip" "$LOG" | tail -5
  cleanup
  exit 2
fi

sleep 4        # let the frame paint and the text slots settle

# Applied after the final `pebble install`, which resyncs the watch clock from
# the host and silently discards an earlier emu-set-time (exit status 0).
CLOCK=$(python3 -c "
import json, time
s=[x for x in json.load(open('$HERE/scenarios.json')) if x['id']==$SID][0]
c=s.get('clock') or ''
if c.startswith('now+'):
    print(int(time.time()) + int(c[4:].rstrip('m')) * 60)
elif c.startswith('today '):
    print(int(time.mktime(time.strptime(time.strftime('%Y-%m-%d ') + c[6:],
                                        '%Y-%m-%d %H:%M:%S'))))
elif c:
    print(int(time.mktime(time.strptime(c, '%Y-%m-%d %H:%M:%S'))))
") || { echo "[$PLATFORM/$SLUG] clock FAILED to resolve"; cleanup; exit 1; }
if [ -n "$CLOCK" ]; then
  pebble emu-set-time --emulator "$PLATFORM" --vnc "${SDKARG[@]}" "$CLOCK" >/dev/null 2>&1 \
    || { echo "[$PLATFORM/$SLUG] emu-set-time FAILED"; cleanup; exit 1; }
  sleep 5      # the clock change ticks the face; let it repaint
fi

pebble screenshot --no-open --emulator "$PLATFORM" --vnc "${SDKARG[@]}" "$OUT" >/dev/null 2>&1
RC=$?
cleanup

if [ $RC -ne 0 ] || [ ! -s "$OUT" ]; then
  echo "[$PLATFORM/$SLUG] SCREENSHOT FAILED"
  exit 3
fi
echo "[$PLATFORM/$SLUG] ok -> $OUT ($(stat -c%s "$OUT") B, ${SECONDS} s)"

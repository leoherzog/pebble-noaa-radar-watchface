#!/usr/bin/env bash
# Capture one gallery tile: capture.sh <platform> <scenario-id>
#
# Everything the emulator touches happens inside this ONE script invocation --
# emulator state lives in /tmp/pb-emulator.json and is validated by pid, so a
# `screenshot` issued from a different shell will not find an emulator this
# shell launched and will try to boot a second one.
#
# Every pebble command that touches the emulator passes --vnc. Without a
# display QEMU dies on "Could not initialize SDL"; worse, a flagless command
# against a running VNC emulator SIGKILLs it and spawns a doomed replacement,
# which looks like a crash rather than a state mismatch.
#
# NOTE on pkill: the pattern below is bracketed so it cannot match itself, but
# that only holds because this file is driven as `bash capture.sh ...` -- the
# invoking command line contains no occurrence of the target string. Never
# inline these commands into a compound shell command that mentions qemu.
set -uo pipefail

PLATFORM="${1:?platform}"
SID="${2:?scenario id}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(cd "$HERE/../.." && pwd)"
# GALLERY_DIR overrides where tiles land. The default writes straight over the
# committed tile, so a before/after comparison MUST redirect one of the two
# passes -- otherwise the diff compares a tile against itself and reports zero
# differences no matter what changed.
OUTDIR="${GALLERY_DIR:-$PROJ/screenshots/gallery}/$PLATFORM"
LOGDIR="${TMPDIR:-/tmp}/pebble-gallery-logs"
mkdir -p "$OUTDIR" "$LOGDIR"

# Pin the emulator to a specific SDK's firmware. Accepted by install, logs,
# screenshot and every emu-* command. Only meaningful when the .pbw was built
# by that same SDK -- see seed.py.
SDKARG=()
[ -n "${PEBBLE_EMULATOR_VERSION:-}" ] && SDKARG=(--sdk "$PEBBLE_EMULATOR_VERSION")

# One parse of scenarios.json for the three static fields. Safe to split on
# whitespace: slugs are hyphenated with no spaces, fmt is 12h/24h, battery is an
# int. The 'clock' field is deliberately NOT read here -- see the block below.
read -r SLUG FMT BATT < <(python3 -c "
import json
s=[x for x in json.load(open('$HERE/scenarios.json')) if x['id']==$SID][0]
print('%02d-%s %s %s' % (s['id'], s['slug'], s['fmt'], s['battery']))")

OUT="$OUTDIR/$SLUG.png"
LOG="$LOGDIR/$PLATFORM-$SLUG.log"

cleanup() {
  pkill -f 'qemu-pebbl[e]'  >/dev/null 2>&1
  pkill -f 'pypkj[s]'       >/dev/null 2>&1
  rm -f "${TMPDIR:-/tmp}/pb-emulator.json"
  sleep 1
}

cleanup
python3 "$HERE/seed.py" "$PLATFORM" "$SID" || exit 1

# First install boots the emulator. Wrap ONLY this one in a timeout: boot
# occasionally half-fails (qemu alive, pypkjs dead, state file never written)
# and `pebble install` then waits forever. Children inherit the env.
echo "[$PLATFORM/$SLUG] booting..."
timeout 420 pebble install --emulator "$PLATFORM" --vnc "${SDKARG[@]}" >/dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "[$PLATFORM/$SLUG] boot failed, retrying once"
  cleanup
  python3 "$HERE/seed.py" "$PLATFORM" "$SID" >/dev/null || exit 1
  timeout 420 pebble install --emulator "$PLATFORM" --vnc "${SDKARG[@]}" >/dev/null 2>&1 || {
    echo "[$PLATFORM/$SLUG] BOOT FAILED"; cleanup; exit 1; }
fi

# These two DO work against a running --vnc emulator, but they need the flags
# spelled out or they try to launch a second emulator, print "Emulator launch
# timed out" and exit 1 -- leaving the setting unapplied and the tile silently
# wrong. The exit status is honest here, so it is checked.
pebble emu-time-format --emulator "$PLATFORM" --vnc "${SDKARG[@]}" --format "$FMT" >/dev/null 2>&1 \
  || { echo "[$PLATFORM/$SLUG] emu-time-format FAILED"; cleanup; exit 1; }
pebble emu-battery --emulator "$PLATFORM" --vnc "${SDKARG[@]}" --percent "$BATT" >/dev/null 2>&1 \
  || { echo "[$PLATFORM/$SLUG] emu-battery FAILED"; cleanup; exit 1; }


# Attach logs, then install a SECOND time. The first install's
# fetch->transfer->decode outruns the log attach, so the marker would be
# missed; the relaunch replays the whole lifecycle with logs attached, and the
# relaunched watch has a NULL bitmap so it forces the transfer past the hash
# cache. The basemap now comes from the localstorage cache the first run wrote.
: > "$LOG"
pebble logs --emulator "$PLATFORM" --vnc "${SDKARG[@]}" >>"$LOG" 2>&1 &
LOGPID=$!
sleep 3
pebble install --emulator "$PLATFORM" --vnc "${SDKARG[@]}" >/dev/null 2>&1

# Poll for the decode. The per-layer 'Decoded image 0/1' markers no longer
# exist -- the phone composites, so there is one 'Decoded composite' line.
DEADLINE=$((SECONDS + 240))
DECODED=0
while [ $SECONDS -lt $DEADLINE ]; do
  if grep -q "Decoded composite" "$LOG" 2>/dev/null; then DECODED=1; break; fi
  sleep 3
done
kill $LOGPID >/dev/null 2>&1

if [ "$DECODED" -ne 1 ]; then
  echo "[$PLATFORM/$SLUG] NO DECODE within 240s -- see $LOG"
  grep -Ei "fail|error|refus|skip" "$LOG" | tail -5
  cleanup
  exit 2
fi

sleep 4        # let the frame paint and the text slots settle

# Watch clock, applied LAST. Only the WATCH moves -- the phone keeps real time,
# so nothing here touches TLS validity or the pkjs 2 h observation gate.
# It has to come after the final `pebble install`, which resyncs the emulated
# RTC from the host and silently discards an earlier emu-set-time (exit status
# stays 0, so the tile just comes out at wall-clock time).
# Backwards is the safe direction: fmt_wx() blanks a payload to "--" once
# watch_now - WX_TIME exceeds 3 h, which a past clock can never trigger, and a
# past clock also leaves alert expiries in the future.
CLOCK=$(python3 -c "
import json, time
s=[x for x in json.load(open('$HERE/scenarios.json')) if x['id']==$SID][0]
c=s.get('clock') or ''
if c.startswith('now+'):
    print(int(time.time()) + int(c[4:].rstrip('m')) * 60)
elif c:
    print(int(time.mktime(time.strptime(c, '%Y-%m-%d %H:%M:%S'))))
")
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
echo "[$PLATFORM/$SLUG] ok -> $OUT ($(stat -c%s "$OUT") B)"

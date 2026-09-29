#!/usr/bin/env bash
# Capture one gallery tile: capture.sh <platform> <scenario-id>
#
# The whole emulator sequence runs inside this one invocation: emulator state
# lives in /tmp/pb-emulator.json and is validated by pid, so a command from
# another shell will not find this emulator and will boot a second one.
#
# Every emulator command passes --vnc. Without a display QEMU dies on "Could
# not initialize SDL", and a flagless command against a running VNC emulator
# SIGKILLs it and spawns a replacement that dies the same way.
#
# The pkill patterns are bracketed so they cannot match themselves, which holds
# only while this file runs as `bash capture.sh ...`. Never inline these
# commands into a compound shell command that mentions qemu.
set -uo pipefail

PLATFORM="${1:?platform}"
SID="${2:?scenario id}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(cd "$HERE/../.." && pwd)"
# GALLERY_DIR overrides where tiles land. The default overwrites the committed
# tile, so a before/after comparison must redirect one pass or it diffs each
# tile against itself and always reports zero.
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
# int. The 'clock' field is deliberately not read here; see the block below.
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

# First install boots the emulator. Wrap only this one in a timeout: boot
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

# These two work against a running --vnc emulator only with the flags spelled
# out; otherwise they try to launch a second emulator, print "Emulator launch
# timed out" and exit 1, leaving the setting unapplied and the tile silently
# wrong. The exit status is honest here, so it is checked.
pebble emu-time-format --emulator "$PLATFORM" --vnc "${SDKARG[@]}" --format "$FMT" >/dev/null 2>&1 \
  || { echo "[$PLATFORM/$SLUG] emu-time-format FAILED"; cleanup; exit 1; }
pebble emu-battery --emulator "$PLATFORM" --vnc "${SDKARG[@]}" --percent "$BATT" >/dev/null 2>&1 \
  || { echo "[$PLATFORM/$SLUG] emu-battery FAILED"; cleanup; exit 1; }


# Attach logs, then install a second time. The first install's
# fetch->transfer->decode outruns the log attach, so the marker would be
# missed; the relaunch replays the lifecycle with logs attached, and the pkjs
# `ready` handler forces a send past the hash cache. The basemap comes from
# the localstorage cache the first run wrote.
: > "$LOG"
pebble logs --emulator "$PLATFORM" --vnc "${SDKARG[@]}" >>"$LOG" 2>&1 &
LOGPID=$!
sleep 3
pebble install --emulator "$PLATFORM" --vnc "${SDKARG[@]}" >/dev/null 2>&1

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

# Watch clock, applied last. Only the watch moves; the phone keeps real time,
# so nothing here touches TLS validity or the pkjs 2 h observation gate.
# It has to come after the final `pebble install`, which resyncs the emulated
# RTC from the host and silently discards an earlier emu-set-time (exit status
# stays 0, so the tile just comes out at wall-clock time).
# Backwards is the safe direction for weather: fmt_wx() blanks a payload to
# "--" once watch_now - WX_TIME exceeds 3 h, which a past clock never triggers,
# and alert expiries stay in the future. Sun slots are the exception: a span
# starting after the watch's tomorrow renders as a date, so a scenario showing
# one needs its clock on the capture date.
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

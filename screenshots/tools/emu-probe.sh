#!/usr/bin/env bash
# Probe the emulator-control commands whose behaviour is firmware-dependent:
#   emu-probe.sh <platform> [scenario-id (default 7)] [scenarios.json]
#
# Boots scenario 07 by default (the only one with health slots: Heart Rate,
# Steps, Distance), injects values, and screenshots. Then it drops the
# Bluetooth link and reports whether a second screenshot still gets through.
# Both optional arguments are passed straight through to seed.py. Run it only
# as `bash emu-probe.sh <platform>`, for the same pkill reason as capture.sh.
#
# Two rules this script exists to enforce:
#
#  1. The format_slot() health stub must be reverted before running this. The
#     stub prints 10247 / 4.6 mi / 72 bpm, and the real code path formats
#     identically, so with the stub in place every platform renders those values
#     whether or not the firmware handler exists: a guaranteed false positive.
#     The injected values below are chosen not to collide with it.
#
#  2. emu-steps and emu-heart-rate take positional arguments, not --steps/--bpm.
#     With a flag they exit 2 on an argparse error before touching the
#     emulator, which reads as "the command ran and did nothing".
#
# Every command carries --emulator and --vnc spelled out. A flagless one
# SIGKILLs the running QEMU because the VNC state differs, then spawns a
# replacement with no display, which dies. So the flagless arm is not tested
# here: it would destroy the emulator under test.
set -uo pipefail

P="${1:?platform}"
SID="${2:-7}"
SCEN="${3:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${TMPDIR:-/tmp}/emu-probe-$P-$SID.png"
OUT_BT="${TMPDIR:-/tmp}/emu-probe-$P-$SID-bt.png"
LOG="${TMPDIR:-/tmp}/emu-probe-$P-$SID.log"

STEPS=3141          # not the stub's 10247
BPM=88              # not the stub's 72

cleanup() {
  pkill -f 'qemu-pebbl[e]' >/dev/null 2>&1
  pkill -f 'pypkj[s]'      >/dev/null 2>&1
  rm -f "${TMPDIR:-/tmp}/pb-emulator.json"
  sleep 1
}

cleanup
python3 "$HERE/seed.py" "$P" "$SID" $SCEN >/dev/null || exit 1

echo "[$P] booting..."
timeout 420 pebble install --emulator "$P" --vnc >/dev/null 2>&1 || {
  echo "[$P] boot failed, retrying once"
  cleanup
  python3 "$HERE/seed.py" "$P" "$SID" $SCEN >/dev/null || exit 1
  timeout 420 pebble install --emulator "$P" --vnc >/dev/null 2>&1 || {
    echo "[$P] BOOT FAILED"; cleanup; exit 1; }
}

: > "$LOG"
pebble logs --emulator "$P" --vnc >>"$LOG" 2>&1 &
LOGPID=$!
sleep 3
pebble install --emulator "$P" --vnc >/dev/null 2>&1

DEADLINE=$((SECONDS + 240))
while [ $SECONDS -lt $DEADLINE ]; do
  grep -q "Decoded composite" "$LOG" 2>/dev/null && break
  sleep 3
done
kill $LOGPID >/dev/null 2>&1

probe() {   # probe <label> <cmd...>
  local label="$1"; shift
  timeout 60 "$@" >/dev/null 2>&1
  echo "[$P] $label -> exit $?"
}

probe "emu-steps $STEPS"      pebble emu-steps      --emulator "$P" --vnc "$STEPS"
probe "emu-heart-rate $BPM"   pebble emu-heart-rate --emulator "$P" --vnc "$BPM"

# The face shows injected values only from its next minute tick, so a
# screenshot taken seconds after the injection still reads 0 / -- bpm.
sleep $((65 - 10#$(date +%S)))
pebble screenshot --no-open --emulator "$P" --vnc "$OUT" >/dev/null 2>&1
RC=$?
[ $RC -eq 0 ] && [ -s "$OUT" ] \
  && echo "[$P] shot -> $OUT" \
  || echo "[$P] SCREENSHOT FAILED"

# Last, because the drop can end the session. The watch shows it 20-30 s after
# the command, badge included when the scenario enables it. On some platforms
# it also cuts pebble-tool's own channel, and every later command, screenshot
# included, then times out.
probe "emu-bt-connection no"  pebble emu-bt-connection --emulator "$P" --vnc --connected no
sleep 40
if timeout 90 pebble screenshot --no-open --emulator "$P" --vnc "$OUT_BT" >/dev/null 2>&1; then
  echo "[$P] shot after the drop -> $OUT_BT"
else
  echo "[$P] screenshot fails after emu-bt-connection no: the drop cut the tool's channel"
fi
cleanup

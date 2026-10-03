#!/usr/bin/env bash
# Probe the emulator-control commands whose behaviour is firmware-dependent:
#   emu-probe.sh <platform> [scenario-id (default 7)]
#
# Boots scenario 07 by default (the only one with health slots: Heart Rate,
# Steps, Distance), injects values, and screenshots. Then it drops the
# Bluetooth link and reports whether a second screenshot still gets through.
# Run it only as `bash emu-probe.sh <platform>`, for the pkill reason in emu.sh.
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
# Every command carries --emulator and --vnc spelled out, so the flagless arm
# is never tested: it would SIGKILL the emulator under test (see emu.sh).
set -uo pipefail

P="${1:?platform}"
SID="${2:-7}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=emu.sh
source "$HERE/emu.sh"
OUT="${TMPDIR:-/tmp}/emu-probe-$P-$SID.png"
OUT_BT="${TMPDIR:-/tmp}/emu-probe-$P-$SID-bt.png"
LOG="${TMPDIR:-/tmp}/emu-probe-$P-$SID.log"

STEPS=3141          # not the stub's 10247
BPM=88              # not the stub's 72

boot "[$P]" "$P" "$SID" "${TMPDIR:-/tmp}/emu-probe-$P-$SID.boot.log"
relaunch_logged "$P" "$LOG"
kill "$LOGPID" >/dev/null 2>&1

probe() {   # probe <label> <cmd...>
  local label="$1"; shift
  timeout 60 "$@" >/dev/null 2>&1
  echo "[$P] $label -> exit $?"
}

probe "emu-steps $STEPS"      pebble emu-steps      --emulator "$P" --vnc "${SDKARG[@]}" "$STEPS"
probe "emu-heart-rate $BPM"   pebble emu-heart-rate --emulator "$P" --vnc "${SDKARG[@]}" "$BPM"

# The face shows injected values only from its next minute tick, so a
# screenshot taken seconds after the injection still reads 0 / -- bpm.
sleep $((65 - 10#$(date +%S)))
pebble screenshot --no-open --emulator "$P" --vnc "${SDKARG[@]}" "$OUT" >/dev/null 2>&1
RC=$?
[ $RC -eq 0 ] && [ -s "$OUT" ] \
  && echo "[$P] shot -> $OUT" \
  || echo "[$P] SCREENSHOT FAILED"

# Last, because the drop can end the session. The watch shows it 20-30 s after
# the command, badge included when the scenario enables it. On some platforms
# it also cuts pebble-tool's own channel, and every later command, screenshot
# included, then times out.
probe "emu-bt-connection no"  pebble emu-bt-connection --emulator "$P" --vnc "${SDKARG[@]}" --connected no
sleep 40
if timeout 90 pebble screenshot --no-open --emulator "$P" --vnc "${SDKARG[@]}" "$OUT_BT" >/dev/null 2>&1; then
  echo "[$P] shot after the drop -> $OUT_BT"
else
  echo "[$P] screenshot fails after emu-bt-connection no: the drop cut the tool's channel"
fi
cleanup

# shellcheck shell=bash
# Emulator steps shared by capture.sh and emu-probe.sh. Source it; never run it.
#
# The whole emulator sequence runs inside one invocation: emulator state lives
# in /tmp/pb-emulator.json and is validated by pid, so a command from another
# shell will not find this emulator and will boot a second one.
#
# Every emulator command passes --vnc. Without a display QEMU dies on "Could
# not initialize SDL", and a flagless command against a running VNC emulator
# SIGKILLs it and spawns a replacement that dies the same way.
#
# The pkill patterns are bracketed so they cannot match themselves, which holds
# only while the sourcing script runs as `bash <script> ...`. Never inline these
# commands into a compound shell command that mentions qemu.

EMU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pins the emulator to one SDK's firmware; install, logs, screenshot and every
# emu-* command accept it. Only meaningful when that SDK built the .pbw too.
SDKARG=()
if [ -n "${PEBBLE_EMULATOR_VERSION:-}" ]; then
  SDKARG=(--sdk "$PEBBLE_EMULATOR_VERSION")
fi

cleanup() {
  pkill -f 'qemu-pebbl[e]'  >/dev/null 2>&1
  pkill -f 'pypkj[s]'       >/dev/null 2>&1
  rm -f "${TMPDIR:-/tmp}/pb-emulator.json"
  sleep 1
}

# boot <tag> <platform> <scenario-id> <bootlog>: seed and boot, retrying once
# after a cleanup and reseed; exits the script if both fail. Only this install
# gets a timeout: boot occasionally half-fails (qemu alive, pypkjs dead, state
# file never written) and the install then waits forever. Children inherit the
# env.
boot() {
  local tag="$1" p="$2" sid="$3" log="$4"
  cleanup
  python3 "$EMU_DIR/seed.py" "$p" "$sid" || exit 1
  echo "$tag booting..."
  timeout 420 pebble install --emulator "$p" --vnc "${SDKARG[@]}" >"$log" 2>&1 && return 0
  echo "$tag boot failed, retrying once (see $log)"
  cleanup
  python3 "$EMU_DIR/seed.py" "$p" "$sid" >/dev/null || exit 1
  timeout 420 pebble install --emulator "$p" --vnc "${SDKARG[@]}" >>"$log" 2>&1 && return 0
  echo "$tag BOOT FAILED"; cleanup; exit 1
}

# relaunch_logged <platform> <log>: attach logs, then install again. The first
# install's fetch, transfer and decode outrun the attach; the relaunch replays
# them on the basemap the first run cached, and its `ready` handler forces a
# send past the hash cache.
# Returns 0 once "Decoded composite" is logged, 1 after 240 s; sets LOGPID.
relaunch_logged() {
  local p="$1" log="$2" deadline
  : > "$log"
  pebble logs --emulator "$p" --vnc "${SDKARG[@]}" >>"$log" 2>&1 &
  LOGPID=$!
  sleep 3
  pebble install --emulator "$p" --vnc "${SDKARG[@]}" >/dev/null 2>&1
  deadline=$((SECONDS + 240))
  while [ $SECONDS -lt "$deadline" ]; do
    grep -q "Decoded composite" "$log" 2>/dev/null && return 0
    sleep 3
  done
  return 1
}

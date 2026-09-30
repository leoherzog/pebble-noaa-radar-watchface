#!/usr/bin/env bash
# Drive capture.sh over a set of scenarios on a set of platforms, tile-major:
# every platform captures one scenario before the next scenario starts, so the
# content that moves with capture time (tile 04's clock) differs least.
#
# Exists so the invoking command line is just `bash sweep.sh ...`: capture.sh
# runs `pkill -f 'qemu-pebbl[e]'`, and the bracket trick only protects against
# the pattern matching its own literal: if the driving command line mentions
# qemu anywhere, pkill still kills the session.
#
# Usage: sweep.sh "<platforms>" "<scenario ids>"
#   GALLERY_DIR=/somewhere  bash sweep.sh "emery basalt" "1 2 13"
set -uo pipefail

PLATFORMS="${1:?platforms}"
SCENARIOS="${2:?scenario ids}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAIL=0
for i in $SCENARIOS; do
  for p in $PLATFORMS; do
    bash "$HERE/capture.sh" "$p" "$i" || { echo "!! FAILED $p/$i (rc=$?)"; FAIL=$((FAIL+1)); }
  done
done

echo "=== sweep done: $FAIL failure(s) ==="
exit $((FAIL > 0))

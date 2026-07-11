#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BENCHMARK="$SCRIPT_DIR/benchmark-initial-image-preheat-planner.sh"

report="$(
  "$BENCHMARK" \
    --asset-count=4 \
    --window-size=2 \
    --window-step=1 \
    --window-count=3 \
    --pixel-width=8 \
    --pixel-height=8 \
    --samples=2 \
    --warmup=0
)"

rg -q '"accessesPhotoLibrary" : false' <<<"$report"
rg -q '"independentFullWindowStarts"' <<<"$report"
rg -q '"startsPerSample" : 6' <<<"$report"
rg -q '"startsPerSample" : 4' <<<"$report"
rg -q '"stopsPerSample" : 2' <<<"$report"

set +e
overflow_error="$(
  "$BENCHMARK" \
    --asset-count=2 \
    --window-size=1 \
    --window-step=1 \
    --window-count=2 \
    --pixel-width=1 \
    --pixel-height=1 \
    --samples=9223372036854775807 \
    --warmup=1 \
    2>&1
)"
overflow_status=$?
set -e

if ((overflow_status == 0)); then
  print -u2 -- "Expected overflowing sample work to fail."
  exit 1
fi
rg -q 'Samples plus warmup overflowed the bounded work model' <<<"$overflow_error"

print -r -- "Initial-image preheat planner benchmark harness passed."

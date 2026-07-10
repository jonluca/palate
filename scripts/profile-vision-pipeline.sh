#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

typeset -a default_arguments
default_arguments=(
  --mode vision
  --batch-sizes 500
  --iterations 20
  --warmup 2
  --max-assets 4400
  --vision-sample 200
  --vision-concurrency 2
  --vision-pipeline-depth 4
)

export PALATE_PHOTOS_PROFILE_RESULT="${PALATE_PHOTOS_PROFILE_RESULT:-$ROOT_DIR/.build/vision-pipeline-profile.json}"
zsh "$SCRIPT_DIR/profile-photos-library.sh" "${default_arguments[@]}" "$@"

if [[ ! -s "$PALATE_PHOTOS_PROFILE_RESULT" ]]; then
  print -u2 "Vision pipeline profiler did not produce a report"
  exit 1
fi

VISION_PARITY="$(/usr/bin/plutil -extract vision.validation.exactOutcomeParity raw -o - "$PALATE_PHOTOS_PROFILE_RESULT" 2>/dev/null || true)"
VISION_COMPARISON_RUNS="$(/usr/bin/plutil -extract vision.validation.comparisonRuns raw -o - "$PALATE_PHOTOS_PROFILE_RESULT" 2>/dev/null || true)"
VISION_PROCESSED_COUNT="$(/usr/bin/plutil -extract vision.processedSampleCount raw -o - "$PALATE_PHOTOS_PROFILE_RESULT" 2>/dev/null || true)"

if [[ "$VISION_PARITY" != "true" ]]; then
  print -u2 "Vision pipeline profiler did not produce an exact parity result"
  exit 1
fi
if [[ ! "$VISION_COMPARISON_RUNS" =~ '^[1-9][0-9]*$' ]]; then
  print -u2 "Vision pipeline profiler did not execute comparison runs"
  exit 1
fi
if [[ ! "$VISION_PROCESSED_COUNT" =~ '^[1-9][0-9]*$' ]]; then
  print -u2 "Vision pipeline profiler did not process real Photos assets"
  exit 1
fi

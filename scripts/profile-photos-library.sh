#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="${PALATE_PHOTOS_PROFILER_APP:-$ROOT_DIR/.build/PalatePhotosProfiler.app}"
OPEN_COMMAND="${PALATE_PHOTOS_PROFILER_OPEN_COMMAND:-/usr/bin/open}"

if [[ "${PALATE_SKIP_PHOTOS_PROFILER_BUILD:-0}" != "1" ]]; then
  PALATE_PHOTOS_PROFILER_APP="$APP_PATH" zsh "$SCRIPT_DIR/build-photos-profiler.sh" >&2
fi

if [[ ! -d "$APP_PATH" ]]; then
  print -u2 "Profiler app not found at $APP_PATH"
  print -u2 "Build it first with: zsh scripts/build-photos-profiler.sh"
  exit 1
fi
if [[ ! -x "$OPEN_COMMAND" ]]; then
  print -u2 "Photos profiler launch command is not executable: $OPEN_COMMAND"
  exit 1
fi

if [[ $# -eq 0 ]]; then
  set -- \
    --batch-sizes 2000,500,250 \
    --iterations 5 \
    --warmup 1
fi

AUTHORIZATION_TIMEOUT_SECONDS="${PALATE_PHOTOS_AUTHORIZATION_TIMEOUT_SECONDS:-}"
if [[ -n "$AUTHORIZATION_TIMEOUT_SECONDS" ]]; then
  if [[ "$AUTHORIZATION_TIMEOUT_SECONDS" != <-> ]] \
    || (( AUTHORIZATION_TIMEOUT_SECONDS < 1 || AUTHORIZATION_TIMEOUT_SECONDS > 300 )); then
    print -u2 "PALATE_PHOTOS_AUTHORIZATION_TIMEOUT_SECONDS must be an integer from 1 through 300"
    exit 2
  fi
  set -- "$@" --authorization-timeout-ms "$(( AUTHORIZATION_TIMEOUT_SECONDS * 1000 ))"
fi

STDOUT_FILE="$(mktemp -t palate-photos-profiler-stdout)"
STDERR_FILE="$(mktemp -t palate-photos-profiler-stderr)"
trap 'rm -f -- "$STDOUT_FILE" "$STDERR_FILE"' EXIT

set +e
"$OPEN_COMMAND" \
  -n \
  -W \
  --stdout "$STDOUT_FILE" \
  --stderr "$STDERR_FILE" \
  "$APP_PATH" \
  --args "$@"
OPEN_STATUS=$?
set -e

if [[ -s "$STDERR_FILE" ]]; then
  /bin/cat "$STDERR_FILE" >&2
fi
if [[ ! -s "$STDOUT_FILE" ]]; then
  print -u2 "Profiler produced no JSON output"
  exit 1
fi

/usr/bin/plutil -convert json -o /dev/null "$STDOUT_FILE"
RESULT_PATH="${PALATE_PHOTOS_PROFILE_RESULT:-$ROOT_DIR/.build/photos-profile-$(date -u +%Y%m%dT%H%M%SZ).json}"
/usr/bin/install -d "$(dirname -- "$RESULT_PATH")"
/usr/bin/install -m 600 "$STDOUT_FILE" "$RESULT_PATH"
/bin/cat "$STDOUT_FILE"

REPORT_STATUS="$(/usr/bin/plutil -extract status raw -o - "$STDOUT_FILE" 2>/dev/null || true)"
if [[ "$REPORT_STATUS" != "ok" ]]; then
  exit 1
fi
if [[ $OPEN_STATUS -ne 0 ]]; then
  exit "$OPEN_STATUS"
fi

VISION_SAMPLE_COUNT="$(/usr/bin/plutil -extract configuration.visionSampleCount raw -o - "$STDOUT_FILE" 2>/dev/null || true)"
if [[ ! "$VISION_SAMPLE_COUNT" =~ ^[0-9]+$ ]]; then
  print -u2 "Photos profiler success report is missing configuration.visionSampleCount"
  exit 1
fi
VISION_PARITY="$(/usr/bin/plutil -extract vision.validation.exactOutcomeParity raw -o - "$STDOUT_FILE" 2>/dev/null || true)"
if (( VISION_SAMPLE_COUNT > 0 )) && [[ "$VISION_PARITY" != "true" ]]; then
  print -u2 "Vision baseline/pipeline outcome parity failed"
  exit 1
fi

PROFILE_MODE="$(/usr/bin/plutil -extract configuration.mode raw -o - "$STDOUT_FILE" 2>/dev/null || true)"
if [[ "$PROFILE_MODE" == "thumbnail-scroll" ]]; then
  for validation_key in \
    globallyDisjointAssignments \
    everyVisibleWindowCompletedExactly \
    noRawIdentifiersEncoded \
    logicalPreheatEmptyAfterEnd \
    schedulerStateEmptyAfterCacheCleanup
  do
    validation_value="$(
      /usr/bin/plutil \
        -extract "thumbnailScroll.validation.$validation_key" \
        raw \
        -o - \
        "$STDOUT_FILE" \
        2>/dev/null || true
    )"
    if [[ "$validation_value" != "true" ]]; then
      print -u2 "Thumbnail-scroll validation failed: $validation_key"
      exit 1
    fi
  done
fi
if [[ "$PROFILE_MODE" == "preview-cards" ]]; then
  for validation_key in \
    globallyDisjointAssignments \
    counterbalancedRecencyExecutionAndGeometry \
    mixedMediaCoverage \
    everyStripBecameRenderable \
    everyRequestCompletedExactly \
    matchingRequestedAndFinalDigests \
    validDecodedDimensions \
    noUnexpectedOrStaleEvents \
    candidateStoreSchedulerQuiescent \
    candidatePreheatUnused \
    noRawIdentifiersEncoded
  do
    validation_value="$(
      /usr/bin/plutil \
        -extract "previewCards.validation.$validation_key" \
        raw \
        -o - \
        "$STDOUT_FILE" \
        2>/dev/null || true
    )"
    if [[ "$validation_value" != "true" ]]; then
      print -u2 "Preview-card validation failed: $validation_key"
      exit 1
    fi
  done
fi

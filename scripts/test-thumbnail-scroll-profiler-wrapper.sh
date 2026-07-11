#!/bin/zsh
set -euo pipefail

ROOT_DIRECTORY="${0:A:h:h}"
WRAPPER_PATH="$ROOT_DIRECTORY/scripts/profile-thumbnail-scroll.sh"
FAKE_OPEN_PATH="$ROOT_DIRECTORY/scripts/fixtures/photos-profiler-wrapper/fake-open.sh"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-thumbnail-scroll-wrapper.XXXXXX")"
FAKE_APP_PATH="$TEMPORARY_DIRECTORY/PalatePhotosProfiler.app"
REPORT_PATH="$TEMPORARY_DIRECTORY/report.json"
RESULT_PATH="$TEMPORARY_DIRECTORY/result.json"
ARGUMENTS_PATH="$TEMPORARY_DIRECTORY/arguments.txt"

cleanup() {
  rm -rf -- "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT

mkdir -p "$FAKE_APP_PATH"
print -r -- '{
  "schemaVersion": 1,
  "status": "ok",
  "configuration": { "mode": "thumbnail-scroll", "visionSampleCount": 0 },
  "thumbnailScroll": {
    "validation": {
      "globallyDisjointAssignments": true,
      "everyVisibleWindowCompletedExactly": true,
      "noRawIdentifiersEncoded": true,
      "logicalPreheatEmptyAfterEnd": true,
      "schedulerStateEmptyAfterCacheCleanup": true
    }
  }
}' > "$REPORT_PATH"

env \
  PALATE_SKIP_PHOTOS_PROFILER_BUILD=1 \
  PALATE_PHOTOS_PROFILER_APP="$FAKE_APP_PATH" \
  PALATE_PHOTOS_PROFILER_OPEN_COMMAND="$FAKE_OPEN_PATH" \
  PALATE_PHOTOS_PROFILER_FAKE_REPORT="$REPORT_PATH" \
  PALATE_PHOTOS_PROFILER_FAKE_ARGUMENTS="$ARGUMENTS_PATH" \
  PALATE_PHOTOS_PROFILE_RESULT="$RESULT_PATH" \
  zsh "$WRAPPER_PATH" \
  > /dev/null

cmp -s "$REPORT_PATH" "$RESULT_PATH"
[[ "$(stat -f '%Lp' "$RESULT_PATH")" == "600" ]]

assert_option_value() {
  local option="$1"
  local expected="$2"
  awk -v option="$option" -v expected="$expected" '
    previous == option && $0 == expected { found = 1 }
    { previous = $0 }
    END { exit found ? 0 : 1 }
  ' "$ARGUMENTS_PATH"
}

assert_option_value "--mode" "thumbnail-scroll"
assert_option_value "--scroll-visible-rows" "4"
assert_option_value "--scroll-ahead-rows" "3"
assert_option_value "--scroll-behind-rows" "1"
assert_option_value "--scroll-fling-windows" "4"
assert_option_value "--scroll-width" "480"
assert_option_value "--scroll-height" "480"
assert_option_value "--scroll-iterations" "4"
assert_option_value "--scroll-rss-sample-ms" "5"

print "Thumbnail-scroll profiler wrapper test passed: isolated mode, production defaults, exact report retention, and mode-0600 output."

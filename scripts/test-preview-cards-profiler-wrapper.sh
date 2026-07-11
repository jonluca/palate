#!/bin/zsh
set -euo pipefail

ROOT_DIRECTORY="${0:A:h:h}"
WRAPPER_PATH="$ROOT_DIRECTORY/scripts/profile-preview-cards.sh"
FAKE_OPEN_PATH="$ROOT_DIRECTORY/scripts/fixtures/photos-profiler-wrapper/fake-open.sh"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-preview-cards-wrapper.XXXXXX")"
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
  "configuration": { "mode": "preview-cards", "visionSampleCount": 0 },
  "previewCards": {
    "validation": {
      "globallyDisjointAssignments": true,
      "counterbalancedRecencyExecutionAndGeometry": true,
      "mixedMediaCoverage": true,
      "everyStripBecameRenderable": true,
      "everyRequestCompletedExactly": true,
      "matchingRequestedAndFinalDigests": true,
      "validDecodedDimensions": true,
      "noUnexpectedOrStaleEvents": true,
      "candidateStoreSchedulerQuiescent": true,
      "candidatePreheatUnused": true,
      "noRawIdentifiersEncoded": true
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

assert_option_value "--mode" "preview-cards"
assert_option_value "--preview-visible-cards" "4"
assert_option_value "--preview-width" "1200"
assert_option_value "--preview-height" "320"
assert_option_value "--preview-iterations" "12"
assert_option_value "--preview-timeout-ms" "30000"
assert_option_value "--preview-rss-sample-ms" "5"

print "Preview-card profiler wrapper test passed: isolated cold-card mode, exact report retention, strict validation, and mode-0600 output."

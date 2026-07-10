#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_PATH=""
DATABASE_PATH=""
PAGE_SIZE=""
OUTPUT_PREFIX=""
EXPECTED_FIXTURE_COUNT="13059"
TIMEOUT_SECONDS="180"
MANUAL_LAUNCH=0

usage() {
  print "Usage: validate-macos-vision-result-page.sh --app=PATH --database=PATH --page-size=N --output-prefix=PATH [options]"
  print ""
  print "  --expected-fixture-count=N  Previously classified rows to retest (default: 13059)"
  print "  --timeout-seconds=N         Completion timeout after trigger (default: 180)"
  print "  --manual-launch             Wait for Xcode to launch Palate instead of opening --app"
  print ""
  print "The script snapshots and restores the database, launches Palate, then waits for"
  print "OUTPUT_PREFIX.trigger. Create that file immediately before triggering Deep Scan."
}

for argument in "$@"; do
  case "$argument" in
    --app=*) APP_PATH="${argument#*=}" ;;
    --database=*) DATABASE_PATH="${argument#*=}" ;;
    --page-size=*) PAGE_SIZE="${argument#*=}" ;;
    --output-prefix=*) OUTPUT_PREFIX="${argument#*=}" ;;
    --expected-fixture-count=*) EXPECTED_FIXTURE_COUNT="${argument#*=}" ;;
    --timeout-seconds=*) TIMEOUT_SECONDS="${argument#*=}" ;;
    --manual-launch) MANUAL_LAUNCH=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      print -u2 "Unknown argument: $argument"
      usage >&2
      exit 2
      ;;
  esac
done

if (( ! MANUAL_LAUNCH )) && [[ ! -d "$APP_PATH" || ! -x "$APP_PATH/Palate" ]]; then
  print -u2 "A built Palate.app is required via --app"
  exit 2
fi
if [[ ! -f "$DATABASE_PATH" ]]; then
  print -u2 "The live SQLite database is required via --database"
  exit 2
fi
if [[ ! "$PAGE_SIZE" =~ ^[0-9]+$ ]] || (( PAGE_SIZE < 1 || PAGE_SIZE > 2000 )); then
  print -u2 "--page-size must be an integer from 1 through 2000"
  exit 2
fi
if [[ -z "$OUTPUT_PREFIX" ]]; then
  print -u2 "--output-prefix is required"
  exit 2
fi
if [[ ! "$EXPECTED_FIXTURE_COUNT" =~ ^[0-9]+$ ]] || (( EXPECTED_FIXTURE_COUNT < 1 )); then
  print -u2 "--expected-fixture-count must be a positive integer"
  exit 2
fi
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS < 1 )); then
  print -u2 "--timeout-seconds must be a positive integer"
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT_PREFIX")"
SNAPSHOT_PATH="$OUTPUT_PREFIX.original.db"
RUN_DATABASE_PATH="$OUTPUT_PREFIX.result.db"
SAMPLES_PATH="$OUTPUT_PREFIX.samples.tsv"
REPORT_PATH="$OUTPUT_PREFIX.json"
TRIGGER_PATH="$OUTPUT_PREFIX.trigger"
VALIDATION_RUN_ID="vision-page-$PAGE_SIZE-$$-$(date +%s)"
RESTORED=0

ORIGINAL_RESULT_PAGE_SIZE="$(launchctl getenv PALATE_VISION_RESULT_PAGE_SIZE 2>/dev/null || true)"
ORIGINAL_CLASSIFICATION_STRATEGY="$(launchctl getenv PALATE_VISION_CLASSIFICATION_STRATEGY 2>/dev/null || true)"
ORIGINAL_VISION_CONCURRENCY="$(launchctl getenv PALATE_VISION_CONCURRENCY 2>/dev/null || true)"
ORIGINAL_PIPELINE_DEPTH="$(launchctl getenv PALATE_VISION_PIPELINE_DEPTH 2>/dev/null || true)"
ORIGINAL_VALIDATION_RUN_ID="$(launchctl getenv PALATE_VISION_VALIDATION_RUN_ID 2>/dev/null || true)"

restore_launch_environment_value() {
  local key="$1"
  local value="$2"
  if [[ -n "$value" ]]; then
    launchctl setenv "$key" "$value"
  else
    launchctl unsetenv "$key" || true
  fi
}

stop_palate() {
  pkill -TERM -x Palate 2>/dev/null || true
  for _ in {1..10}; do
    pgrep -x Palate >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  # Xcode's Designed-for-iPhone runner intercepts app signals while attached.
  local app_pid parent_pid parent_command
  app_pid="$(pgrep -x Palate | head -1 || true)"
  if [[ -n "$app_pid" ]]; then
    parent_pid="$(ps -o ppid= -p "$app_pid" | tr -d ' ')"
    parent_command="$(ps -o comm= -p "$parent_pid" || true)"
    if [[ "$parent_command" == */debugserver ]]; then
      kill -TERM "$parent_pid" 2>/dev/null || true
    fi
  fi
  for _ in {1..10}; do
    pgrep -x Palate >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  pkill -KILL -x Palate 2>/dev/null || true
  for _ in {1..40}; do
    pgrep -x Palate >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  print -u2 "Palate did not terminate"
  return 1
}

restore_database() {
  if (( RESTORED )); then
    return
  fi
  RESTORED=1
  stop_palate || true
  restore_launch_environment_value PALATE_VISION_RESULT_PAGE_SIZE "$ORIGINAL_RESULT_PAGE_SIZE"
  restore_launch_environment_value PALATE_VISION_CLASSIFICATION_STRATEGY "$ORIGINAL_CLASSIFICATION_STRATEGY"
  restore_launch_environment_value PALATE_VISION_CONCURRENCY "$ORIGINAL_VISION_CONCURRENCY"
  restore_launch_environment_value PALATE_VISION_PIPELINE_DEPTH "$ORIGINAL_PIPELINE_DEPTH"
  restore_launch_environment_value PALATE_VISION_VALIDATION_RUN_ID "$ORIGINAL_VALIDATION_RUN_ID"
  if [[ -f "$SNAPSHOT_PATH" ]]; then
    rm -f "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
    cp -p "$SNAPSHOT_PATH" "$DATABASE_PATH"
  fi
}

handle_signal() {
  local exit_code="$1"
  trap - INT TERM HUP
  restore_database
  exit "$exit_code"
}

trap restore_database EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

stop_palate
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
cp -p "$DATABASE_PATH" "$SNAPSHOT_PATH"
ORIGINAL_SHA256="$(shasum -a 256 "$SNAPSHOT_PATH" | awk '{print $1}')"
EXPECTED_FOOD_COUNT="$(sqlite3 "$SNAPSHOT_PATH" "SELECT COUNT(*) FROM photos WHERE foodDetected = 1;")"
EXPECTED_FOOD_VISIT_COUNT="$(sqlite3 "$SNAPSHOT_PATH" "SELECT COUNT(*) FROM visits WHERE foodProbable = 1;")"
FIXTURE_COUNT="$(sqlite3 "$SNAPSHOT_PATH" "SELECT COUNT(*) FROM photos WHERE allLabels IS NOT NULL;")"
if (( FIXTURE_COUNT != EXPECTED_FIXTURE_COUNT )); then
  print -u2 "Expected $EXPECTED_FIXTURE_COUNT classified fixture rows, found $FIXTURE_COUNT"
  exit 1
fi

sqlite3 "$DATABASE_PATH" <<SQL
ATTACH DATABASE '$SNAPSHOT_PATH' AS reference;
BEGIN IMMEDIATE;
UPDATE photos
SET foodDetected = 0,
    foodLabels = NULL,
    foodConfidence = NULL,
    allLabels = NULL
WHERE foodDetected IS NULL;
UPDATE photos
SET foodDetected = NULL,
    foodLabels = NULL,
    foodConfidence = NULL,
    allLabels = NULL
WHERE id IN (SELECT id FROM reference.photos WHERE allLabels IS NOT NULL);
UPDATE visits SET foodProbable = 0;
COMMIT;
DETACH DATABASE reference;
SQL

PENDING_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM photos WHERE foodDetected IS NULL;")"
if (( PENDING_COUNT != EXPECTED_FIXTURE_COUNT )); then
  print -u2 "Fixture preparation produced $PENDING_COUNT pending rows, expected $EXPECTED_FIXTURE_COUNT"
  exit 1
fi

rm -f "$TRIGGER_PATH" "$RUN_DATABASE_PATH" "$SAMPLES_PATH" "$REPORT_PATH"
print "elapsed_s\tpending\trss_kib" > "$SAMPLES_PATH"
launchctl setenv PALATE_VISION_RESULT_PAGE_SIZE "$PAGE_SIZE"
launchctl setenv PALATE_VISION_VALIDATION_RUN_ID "$VALIDATION_RUN_ID"
launchctl unsetenv PALATE_VISION_CLASSIFICATION_STRATEGY || true
launchctl unsetenv PALATE_VISION_CONCURRENCY || true
launchctl unsetenv PALATE_VISION_PIPELINE_DEPTH || true
if (( MANUAL_LAUNCH )); then
  print "READY_TO_LAUNCH page_size=$PAGE_SIZE"
else
  open "$APP_PATH"
fi

for _ in {1..1200}; do
  APP_PID="$(pgrep -x Palate | head -1 || true)"
  [[ -n "$APP_PID" ]] && break
  sleep 0.1
done
if [[ -z "${APP_PID:-}" ]]; then
  print -u2 "Palate did not launch"
  exit 1
fi

PROCESS_ENVIRONMENT="$(ps eww -p "$APP_PID" -o command=)"
EXPECTED_PAGE_ENV="PALATE_VISION_RESULT_PAGE_SIZE=$PAGE_SIZE"
EXPECTED_RUN_ENV="PALATE_VISION_VALIDATION_RUN_ID=$VALIDATION_RUN_ID"
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_PAGE_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_RUN_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit the requested validation environment"
  exit 1
fi
ATTESTED_RUN_ID="$VALIDATION_RUN_ID"
ATTESTED_PAGE_SIZE="$PAGE_SIZE"
ATTESTED_OBSERVED_EPOCH="$(date +%s.%N)"
print \
  "READY page_size=$PAGE_SIZE observed_process_page_size=$ATTESTED_PAGE_SIZE pid=$APP_PID trigger=$TRIGGER_PATH"
TRIGGER_WAIT_STARTED="$(date +%s)"
while [[ ! -s "$TRIGGER_PATH" ]]; do
  if (( $(date +%s) - TRIGGER_WAIT_STARTED >= 300 )); then
    print -u2 "Timed out waiting for $TRIGGER_PATH"
    exit 1
  fi
  sleep 0.1
done
TRIGGER_EPOCH="$(head -1 "$TRIGGER_PATH")"
if [[ ! "$TRIGGER_EPOCH" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  print -u2 "Trigger file must contain an epoch timestamp"
  exit 1
fi

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
OBSERVED_PROGRESS=0
FIRST_PROGRESS_EPOCH=""
while true; do
  NOW_EPOCH="$(date +%s.%N)"
  ELAPSED="$(awk -v now="$NOW_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.3f", now - start }')"
  PENDING_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM photos WHERE foodDetected IS NULL;")"
  RSS_KIB="$(ps -o rss= -p "$APP_PID" | tr -d ' ' || true)"
  [[ -n "$RSS_KIB" ]] || RSS_KIB=0
  print "$ELAPSED\t$PENDING_COUNT\t$RSS_KIB" >> "$SAMPLES_PATH"
  if (( PENDING_COUNT < EXPECTED_FIXTURE_COUNT && ! OBSERVED_PROGRESS )); then
    OBSERVED_PROGRESS=1
    FIRST_PROGRESS_EPOCH="$NOW_EPOCH"
  fi
  if (( PENDING_COUNT == 0 && OBSERVED_PROGRESS )); then
    ACTUAL_FOOD_VISIT_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE foodProbable = 1;")"
    if (( ACTUAL_FOOD_VISIT_COUNT == EXPECTED_FOOD_VISIT_COUNT )); then
      FINISH_EPOCH="$NOW_EPOCH"
      break
    fi
  fi
  if (( $(date +%s) >= DEADLINE )); then
    print -u2 "Timed out with $PENDING_COUNT pending rows"
    exit 1
  fi
  sleep 0.2
done

TRIGGER_WALL_SECONDS="$(awk -v finish="$FINISH_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", finish - start }')"
FIRST_DURABLE_PROGRESS_SECONDS="$(awk -v first="$FIRST_PROGRESS_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", first - start }')"
DURABLE_TAIL_SECONDS="$(awk -v finish="$FINISH_EPOCH" -v first="$FIRST_PROGRESS_EPOCH" 'BEGIN { printf "%.6f", finish - first }')"
WALL_SECONDS="$DURABLE_TAIL_SECONDS"
MAX_RSS_KIB="$(awk 'NR > 1 && $3 > maximum { maximum = $3 } END { print maximum + 0 }' "$SAMPLES_PATH")"
stop_palate
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null

read PHOTO_MISMATCH_COUNT VISIT_MISMATCH_COUNT <<<"$(sqlite3 -separator ' ' "$DATABASE_PATH" <<SQL
ATTACH DATABASE '$SNAPSHOT_PATH' AS reference;
WITH photo_mismatches AS (
  SELECT expected.id
  FROM reference.photos AS expected
  LEFT JOIN photos AS current USING (id)
  WHERE expected.allLabels IS NOT NULL
    AND (
      current.id IS NULL
      OR current.foodDetected IS NOT expected.foodDetected
      OR current.foodConfidence IS NOT expected.foodConfidence
      OR (SELECT json_group_array(json_object(
            'label', json_extract(value, '\$.label'),
            'confidence', json_extract(value, '\$.confidence')
          )) FROM json_each(current.foodLabels))
         IS NOT
         (SELECT json_group_array(json_object(
            'label', json_extract(value, '\$.label'),
            'confidence', json_extract(value, '\$.confidence')
          )) FROM json_each(expected.foodLabels))
      OR (SELECT json_group_array(json_object(
            'label', json_extract(value, '\$.label'),
            'confidence', json_extract(value, '\$.confidence')
          )) FROM json_each(current.allLabels))
         IS NOT
         (SELECT json_group_array(json_object(
            'label', json_extract(value, '\$.label'),
            'confidence', json_extract(value, '\$.confidence')
          )) FROM json_each(expected.allLabels))
    )
  UNION ALL
  SELECT current.id
  FROM photos AS current
  LEFT JOIN reference.photos AS expected USING (id)
  WHERE expected.id IS NULL
), visit_mismatches AS (
  SELECT expected.id
  FROM reference.visits AS expected
  LEFT JOIN visits AS current USING (id)
  WHERE current.id IS NULL OR current.foodProbable IS NOT expected.foodProbable
  UNION ALL
  SELECT current.id
  FROM visits AS current
  LEFT JOIN reference.visits AS expected USING (id)
  WHERE expected.id IS NULL
)
SELECT (SELECT COUNT(*) FROM photo_mismatches),
       (SELECT COUNT(*) FROM visit_mismatches);
DETACH DATABASE reference;
SQL
)"

ACTUAL_FOOD_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM photos WHERE foodDetected = 1;")"
INTEGRITY="$(sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;")"
if (( PHOTO_MISMATCH_COUNT != 0 || VISIT_MISMATCH_COUNT != 0 )); then
  print -u2 "Parity failed: $PHOTO_MISMATCH_COUNT photo mismatches, $VISIT_MISMATCH_COUNT visit mismatches"
  exit 1
fi
if (( ACTUAL_FOOD_COUNT != EXPECTED_FOOD_COUNT )); then
  print -u2 "Food count mismatch: expected $EXPECTED_FOOD_COUNT, found $ACTUAL_FOOD_COUNT"
  exit 1
fi
if [[ "$INTEGRITY" != "ok" ]]; then
  print -u2 "SQLite integrity failed: $INTEGRITY"
  exit 1
fi

cp -p "$DATABASE_PATH" "$RUN_DATABASE_PATH"
jq -n \
  --arg status "ok" \
  --argjson pageSize "$PAGE_SIZE" \
  --argjson fixtureCount "$FIXTURE_COUNT" \
  --argjson expectedFoodCount "$EXPECTED_FOOD_COUNT" \
  --argjson expectedFoodVisitCount "$EXPECTED_FOOD_VISIT_COUNT" \
  --argjson photoMismatchCount "$PHOTO_MISMATCH_COUNT" \
  --argjson visitMismatchCount "$VISIT_MISMATCH_COUNT" \
  --argjson wallSeconds "$WALL_SECONDS" \
  --argjson triggerWallSeconds "$TRIGGER_WALL_SECONDS" \
  --argjson firstDurableProgressSeconds "$FIRST_DURABLE_PROGRESS_SECONDS" \
  --argjson durableTailSeconds "$DURABLE_TAIL_SECONDS" \
  --argjson maxRssKiB "$MAX_RSS_KIB" \
  --arg integrity "$INTEGRITY" \
  --arg originalSha256 "$ORIGINAL_SHA256" \
  --arg samplesPath "$SAMPLES_PATH" \
  --arg validationRunId "$ATTESTED_RUN_ID" \
  --argjson attestedPageSize "$ATTESTED_PAGE_SIZE" \
  --argjson attestedObservedAtEpochSeconds "$ATTESTED_OBSERVED_EPOCH" \
  '{
    schemaVersion: 2,
    status: $status,
    pageSize: $pageSize,
    fixtureCount: $fixtureCount,
    expectedFoodCount: $expectedFoodCount,
    expectedFoodVisitCount: $expectedFoodVisitCount,
    wallSeconds: $wallSeconds,
    timing: {
      firstDurableProgressToCompletionSeconds: $durableTailSeconds,
      triggerToDurableCompletionSeconds: $triggerWallSeconds,
      triggerToFirstDurableProgressSeconds: $firstDurableProgressSeconds,
      samplingIntervalSeconds: 0.2
    },
    maxRssKiB: $maxRssKiB,
    runtimeAttestation: {
      runId: $validationRunId,
      observedProcessPageSize: $attestedPageSize,
      observedAtEpochSeconds: $attestedObservedAtEpochSeconds,
      source: "process-environment-plus-native-resolver-tests"
    },
    validation: {
      exactSemanticPhotoParity: ($photoMismatchCount == 0),
      photoMismatchCount: $photoMismatchCount,
      exactVisitFoodParity: ($visitMismatchCount == 0),
      visitMismatchCount: $visitMismatchCount,
      pendingCount: 0,
      integrity: $integrity
    },
    originalDatabaseSha256: $originalSha256,
    samplesPath: $samplesPath
  }' > "$REPORT_PATH"

restore_database
RESTORED_SHA256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
if [[ "$RESTORED_SHA256" != "$ORIGINAL_SHA256" ]]; then
  print -u2 "Database restoration hash mismatch"
  exit 1
fi

print "COMPLETE report=$REPORT_PATH wall_seconds=$WALL_SECONDS durable_tail_seconds=$DURABLE_TAIL_SECONDS max_rss_kib=$MAX_RSS_KIB restored_sha256=$RESTORED_SHA256"

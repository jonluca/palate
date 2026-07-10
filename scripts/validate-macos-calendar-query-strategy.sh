#!/bin/zsh
set -euo pipefail

APP_PATH=""
DATABASE_PATH=""
REFERENCE_DATABASE_PATH=""
QUERY_STRATEGY=""
QUERY_GAP_DAYS="7"
OUTPUT_PREFIX=""
EXPECTED_VISIT_COUNT="6511"
EXPECTED_CALENDAR_LINK_COUNT="2000"
TIMEOUT_SECONDS="180"
MANUAL_LAUNCH=0

usage() {
  print "Usage: validate-macos-calendar-query-strategy.sh --database=PATH --strategy=broad|sparse --output-prefix=PATH [options]"
  print ""
  print "  --app=PATH                         Built Palate.app (required without --manual-launch)"
  print "  --reference-database=PATH          Read-only parity reference (default: live snapshot)"
  print "  --gap-days=N                       Sparse coalescing gap, 0 through 365 (default: 7)"
  print "  --expected-visit-count=N           Controlled visit fixture size (default: 6511)"
  print "  --expected-calendar-link-count=N   Expected restored Calendar links (default: 2000)"
  print "  --timeout-seconds=N                Completion timeout after trigger (default: 180)"
  print "  --manual-launch                    Wait for Xcode Run Without Building"
  print ""
  print "The script snapshots and restores the database, clears only derived Calendar fields,"
  print "launches Palate with the requested native query strategy, and waits for OUTPUT_PREFIX.trigger."
  print "Write a fractional epoch timestamp (date +%s.%N) into that file immediately before"
  print "triggering Rescan Photos. Timing covers the prefix through durable Calendar restoration,"
  print "including PhotoKit/grouping before Calendar and excluding later rescan phases."
}

for argument in "$@"; do
  case "$argument" in
    --app=*) APP_PATH="${argument#*=}" ;;
    --database=*) DATABASE_PATH="${argument#*=}" ;;
    --reference-database=*) REFERENCE_DATABASE_PATH="${argument#*=}" ;;
    --strategy=*) QUERY_STRATEGY="${argument#*=}" ;;
    --gap-days=*) QUERY_GAP_DAYS="${argument#*=}" ;;
    --output-prefix=*) OUTPUT_PREFIX="${argument#*=}" ;;
    --expected-visit-count=*) EXPECTED_VISIT_COUNT="${argument#*=}" ;;
    --expected-calendar-link-count=*) EXPECTED_CALENDAR_LINK_COUNT="${argument#*=}" ;;
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
if [[ -n "$REFERENCE_DATABASE_PATH" && ! -f "$REFERENCE_DATABASE_PATH" ]]; then
  print -u2 "--reference-database must name an existing SQLite database"
  exit 2
fi
if [[ -n "$REFERENCE_DATABASE_PATH" && "$REFERENCE_DATABASE_PATH" -ef "$DATABASE_PATH" ]]; then
  print -u2 "--reference-database must not alias the live database"
  exit 2
fi
if [[ "$QUERY_STRATEGY" != "broad" && "$QUERY_STRATEGY" != "sparse" ]]; then
  print -u2 "--strategy must be broad or sparse"
  exit 2
fi
if ! awk -v value="$QUERY_GAP_DAYS" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value >= 0 && value <= 365) }'; then
  print -u2 "--gap-days must be a finite number from 0 through 365"
  exit 2
fi
if [[ -z "$OUTPUT_PREFIX" ]]; then
  print -u2 "--output-prefix is required"
  exit 2
fi
if [[ ! "$EXPECTED_VISIT_COUNT" =~ ^[0-9]+$ ]] || (( EXPECTED_VISIT_COUNT < 1 )); then
  print -u2 "--expected-visit-count must be a positive integer"
  exit 2
fi
if [[ ! "$EXPECTED_CALENDAR_LINK_COUNT" =~ ^[0-9]+$ ]] || (( EXPECTED_CALENDAR_LINK_COUNT < 1 )); then
  print -u2 "--expected-calendar-link-count must be a positive integer"
  exit 2
fi
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS < 1 )); then
  print -u2 "--timeout-seconds must be a positive integer"
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT_PREFIX")"
VALIDATION_RUN_ID="calendar-query-$QUERY_STRATEGY-$$-$(date +%s)-$RANDOM"
SNAPSHOT_PATH="$OUTPUT_PREFIX.$VALIDATION_RUN_ID.original.db"
SNAPSHOT_TEMP_PATH="$SNAPSHOT_PATH.tmp"
RUN_DATABASE_PATH="$OUTPUT_PREFIX.result.db"
RUN_DATABASE_TEMP_PATH="$RUN_DATABASE_PATH.tmp-$VALIDATION_RUN_ID"
SAMPLES_PATH="$OUTPUT_PREFIX.samples.tsv"
REPORT_PATH="$OUTPUT_PREFIX.json"
REPORT_TEMP_PATH="$REPORT_PATH.tmp-$VALIDATION_RUN_ID"
TRIGGER_PATH="$OUTPUT_PREFIX.trigger"
ATTESTATION_PATH="$DATABASE_PATH.calendar-validation-$VALIDATION_RUN_ID.json"
RESTORE_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.tmp"
ATTESTATION_DIRECTORY="$(dirname "$ATTESTATION_PATH")"
ATTESTATION_TIMEOUT_SECONDS=60
TRIGGER_MAX_AGE_SECONDS=30
TARGET_SAMPLING_INTERVAL_SECONDS=0.2
SNAPSHOT_READY=0
RESTORED=0
ORIGINAL_SHA256=""
if [[ -n "$REFERENCE_DATABASE_PATH" ]]; then
  REFERENCE_DATABASE_PATH="${REFERENCE_DATABASE_PATH:A}"
  if [[ "$REFERENCE_DATABASE_PATH" == "${RUN_DATABASE_PATH:A}" ]] \
    || [[ -e "$RUN_DATABASE_PATH" && "$REFERENCE_DATABASE_PATH" -ef "$RUN_DATABASE_PATH" ]]; then
    print -u2 "--reference-database must not alias the result database output"
    exit 2
  fi
fi
if [[ ! -d "$ATTESTATION_DIRECTORY" || ! -w "$ATTESTATION_DIRECTORY" ]]; then
  print -u2 "The live database directory must be writable for native attestation: $ATTESTATION_DIRECTORY"
  exit 1
fi

ORIGINAL_QUERY_STRATEGY="$(launchctl getenv PALATE_CALENDAR_QUERY_STRATEGY 2>/dev/null || true)"
ORIGINAL_QUERY_GAP_DAYS="$(launchctl getenv PALATE_CALENDAR_QUERY_GAP_DAYS 2>/dev/null || true)"
ORIGINAL_VALIDATION_RUN_ID="$(launchctl getenv PALATE_CALENDAR_VALIDATION_RUN_ID 2>/dev/null || true)"
ORIGINAL_ATTESTATION_PATH="$(launchctl getenv PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH 2>/dev/null || true)"
ORIGINAL_RESULT_PAGE_SIZE="$(launchctl getenv PALATE_VISION_RESULT_PAGE_SIZE 2>/dev/null || true)"
ORIGINAL_CLASSIFICATION_STRATEGY="$(launchctl getenv PALATE_VISION_CLASSIFICATION_STRATEGY 2>/dev/null || true)"
ORIGINAL_VISION_CONCURRENCY="$(launchctl getenv PALATE_VISION_CONCURRENCY 2>/dev/null || true)"
ORIGINAL_PIPELINE_DEPTH="$(launchctl getenv PALATE_VISION_PIPELINE_DEPTH 2>/dev/null || true)"
ORIGINAL_QUERY_STRATEGY_SET=$(( ${#ORIGINAL_QUERY_STRATEGY} > 0 ))
ORIGINAL_QUERY_GAP_DAYS_SET=$(( ${#ORIGINAL_QUERY_GAP_DAYS} > 0 ))
ORIGINAL_VALIDATION_RUN_ID_SET=$(( ${#ORIGINAL_VALIDATION_RUN_ID} > 0 ))
ORIGINAL_ATTESTATION_PATH_SET=$(( ${#ORIGINAL_ATTESTATION_PATH} > 0 ))
ORIGINAL_RESULT_PAGE_SIZE_SET=$(( ${#ORIGINAL_RESULT_PAGE_SIZE} > 0 ))
ORIGINAL_CLASSIFICATION_STRATEGY_SET=$(( ${#ORIGINAL_CLASSIFICATION_STRATEGY} > 0 ))
ORIGINAL_VISION_CONCURRENCY_SET=$(( ${#ORIGINAL_VISION_CONCURRENCY} > 0 ))
ORIGINAL_PIPELINE_DEPTH_SET=$(( ${#ORIGINAL_PIPELINE_DEPTH} > 0 ))

restore_launch_environment_value() {
  local key="$1"
  local value="$2"
  local was_set="$3"
  if (( was_set )); then
    if ! launchctl setenv "$key" "$value"; then
      print -u2 "Failed to restore launch environment value: $key"
      return 1
    fi
  else
    if ! launchctl unsetenv "$key"; then
      print -u2 "Failed to unset launch environment value: $key"
      return 1
    fi
  fi
}

remove_database_sidecars() {
  local database_path="$1"
  rm -f -- "$database_path-wal" "$database_path-shm"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

immutable_sqlite_uri() {
  local database_path="$1"
  local encoded_path
  encoded_path="$(jq -nr --arg path "${database_path:A}" '$path | @uri')"
  print -rn -- "file:$encoded_path?mode=ro&immutable=1"
}

assert_wal_checkpoint() {
  local database_path="$1"
  local checkpoint_result busy log_frames checkpointed_frames wal_size
  if ! checkpoint_result="$(sqlite3 "$database_path" "PRAGMA wal_checkpoint(TRUNCATE);")"; then
    print -u2 "WAL checkpoint failed for $database_path"
    return 1
  fi
  IFS='|' read -r busy log_frames checkpointed_frames <<< "$checkpoint_result"
  if [[ ! "$busy" =~ ^[0-9]+$ || ! "$log_frames" =~ ^[0-9]+$ || ! "$checkpointed_frames" =~ ^[0-9]+$ ]] \
    || (( busy != 0 )); then
    print -u2 "WAL checkpoint was not complete for $database_path: $checkpoint_result"
    return 1
  fi
  if [[ -e "$database_path-wal" ]]; then
    wal_size="$(wc -c < "$database_path-wal" | tr -d ' ')"
    if [[ ! "$wal_size" =~ ^[0-9]+$ ]] || (( wal_size != 0 )); then
      print -u2 "WAL remained nonempty after checkpoint for $database_path: $wal_size bytes"
      return 1
    fi
  fi
}

stop_palate() {
  pkill -TERM -x Palate 2>/dev/null || true
  for _ in {1..10}; do
    pgrep -x Palate >/dev/null 2>&1 || return 0
    sleep 0.1
  done

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
  local restore_failed=0
  local restored_temp_sha restored_live_sha

  if (( SNAPSHOT_READY && ! RESTORED )); then
    if ! stop_palate; then
      print -u2 "Cannot safely restore the database while Palate is running"
      restore_failed=1
    elif [[ ! -f "$SNAPSHOT_PATH" ]]; then
      print -u2 "The validated per-run snapshot is missing: $SNAPSHOT_PATH"
      restore_failed=1
    else
      if ! rm -f -- "$RESTORE_TEMP_PATH"; then
        print -u2 "Failed to remove a stale restoration temporary file"
        restore_failed=1
      fi
      remove_database_sidecars "$RESTORE_TEMP_PATH" || restore_failed=1
      if (( ! restore_failed )) && ! cp -p "$SNAPSHOT_PATH" "$RESTORE_TEMP_PATH"; then
        print -u2 "Failed to prepare the atomic database restoration copy"
        restore_failed=1
      fi
      if (( ! restore_failed )); then
        if ! restored_temp_sha="$(sha256_file "$RESTORE_TEMP_PATH")"; then
          print -u2 "Failed to hash the prepared restoration copy"
          restore_failed=1
        elif [[ "$restored_temp_sha" != "$ORIGINAL_SHA256" ]]; then
          print -u2 "Prepared restoration copy hash mismatch"
          restore_failed=1
        fi
      fi
      if (( ! restore_failed )) && ! remove_database_sidecars "$DATABASE_PATH"; then
        print -u2 "Failed to remove live database sidecars before restoration"
        restore_failed=1
      fi
      if (( ! restore_failed )) && ! mv -f -- "$RESTORE_TEMP_PATH" "$DATABASE_PATH"; then
        print -u2 "Failed to atomically replace the live database"
        restore_failed=1
      fi
      if (( ! restore_failed )); then
        if ! remove_database_sidecars "$DATABASE_PATH"; then
          print -u2 "Failed to remove restored live database sidecars"
          restore_failed=1
        elif ! restored_live_sha="$(sha256_file "$DATABASE_PATH")"; then
          print -u2 "Failed to hash the restored live database"
          restore_failed=1
        elif [[ "$restored_live_sha" != "$ORIGINAL_SHA256" ]]; then
          print -u2 "Restored live database hash mismatch"
          restore_failed=1
        else
          RESTORED=1
        fi
      fi
    fi
  fi

  if ! restore_launch_environment_value PALATE_CALENDAR_QUERY_STRATEGY "$ORIGINAL_QUERY_STRATEGY" "$ORIGINAL_QUERY_STRATEGY_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_CALENDAR_QUERY_GAP_DAYS "$ORIGINAL_QUERY_GAP_DAYS" "$ORIGINAL_QUERY_GAP_DAYS_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_CALENDAR_VALIDATION_RUN_ID "$ORIGINAL_VALIDATION_RUN_ID" "$ORIGINAL_VALIDATION_RUN_ID_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH "$ORIGINAL_ATTESTATION_PATH" "$ORIGINAL_ATTESTATION_PATH_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_VISION_RESULT_PAGE_SIZE "$ORIGINAL_RESULT_PAGE_SIZE" "$ORIGINAL_RESULT_PAGE_SIZE_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_VISION_CLASSIFICATION_STRATEGY "$ORIGINAL_CLASSIFICATION_STRATEGY" "$ORIGINAL_CLASSIFICATION_STRATEGY_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_VISION_CONCURRENCY "$ORIGINAL_VISION_CONCURRENCY" "$ORIGINAL_VISION_CONCURRENCY_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_VISION_PIPELINE_DEPTH "$ORIGINAL_PIPELINE_DEPTH" "$ORIGINAL_PIPELINE_DEPTH_SET"; then restore_failed=1; fi

  rm -f -- "$ATTESTATION_PATH" "$ATTESTATION_PATH.tmp" "$SNAPSHOT_TEMP_PATH" "$RESTORE_TEMP_PATH" "$RUN_DATABASE_TEMP_PATH" "$REPORT_TEMP_PATH" || restore_failed=1
  remove_database_sidecars "$SNAPSHOT_PATH" || restore_failed=1
  remove_database_sidecars "$RUN_DATABASE_PATH" || restore_failed=1
  remove_database_sidecars "$RESTORE_TEMP_PATH" || restore_failed=1
  (( restore_failed == 0 ))
}

handle_signal() {
  local exit_code="$1"
  trap '' INT TERM HUP
  exit "$exit_code"
}

handle_exit() {
  local exit_code="$?"
  trap - EXIT
  if ! restore_database; then
    print -u2 "One or more restoration steps failed"
    (( exit_code == 0 )) && exit_code=1
  fi
  exit "$exit_code"
}

trap handle_exit EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

stop_palate
assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
rm -f -- "$SNAPSHOT_PATH" "$SNAPSHOT_TEMP_PATH"
remove_database_sidecars "$SNAPSHOT_PATH"
cp -p "$DATABASE_PATH" "$SNAPSHOT_TEMP_PATH"
LIVE_SHA256="$(sha256_file "$DATABASE_PATH")"
SNAPSHOT_TEMP_SHA256="$(sha256_file "$SNAPSHOT_TEMP_PATH")"
if [[ "$SNAPSHOT_TEMP_SHA256" != "$LIVE_SHA256" ]]; then
  print -u2 "Snapshot copy hash mismatch"
  exit 1
fi
mv -f -- "$SNAPSHOT_TEMP_PATH" "$SNAPSHOT_PATH"
ORIGINAL_SHA256="$(sha256_file "$SNAPSHOT_PATH")"
if [[ "$ORIGINAL_SHA256" != "$LIVE_SHA256" ]]; then
  print -u2 "Final snapshot hash mismatch"
  exit 1
fi
SNAPSHOT_READY=1
LIVE_ORIGINAL_SNAPSHOT_PATH="${SNAPSHOT_PATH:A}"
LIVE_ORIGINAL_SNAPSHOT_URI="$(immutable_sqlite_uri "$LIVE_ORIGINAL_SNAPSHOT_PATH")"
read \
  LIVE_ORIGINAL_VISIT_COUNT \
  LIVE_ORIGINAL_LINK_COUNT \
  LIVE_ORIGINAL_DISTINCT_EVENT_COUNT \
  LIVE_ORIGINAL_PHOTO_COUNT \
  LIVE_ORIGINAL_SUGGESTION_COUNT \
  LIVE_ORIGINAL_METADATA_COUNT \
  <<<"$(sqlite3 -readonly -separator ' ' "$LIVE_ORIGINAL_SNAPSHOT_URI" \
    "SELECT (SELECT COUNT(*) FROM visits), (SELECT COUNT(*) FROM visits WHERE calendarEventId IS NOT NULL), (SELECT COUNT(DISTINCT calendarEventId) FROM visits WHERE calendarEventId IS NOT NULL), (SELECT COUNT(*) FROM photos), (SELECT COUNT(*) FROM visit_suggested_restaurants), (SELECT COUNT(*) FROM app_metadata);")"
if (( LIVE_ORIGINAL_VISIT_COUNT != EXPECTED_VISIT_COUNT )); then
  print -u2 "Expected $EXPECTED_VISIT_COUNT visit rows, found $LIVE_ORIGINAL_VISIT_COUNT"
  exit 1
fi
if (( LIVE_ORIGINAL_LINK_COUNT != EXPECTED_CALENDAR_LINK_COUNT )); then
  print -u2 "Expected $EXPECTED_CALENDAR_LINK_COUNT Calendar links, found $LIVE_ORIGINAL_LINK_COUNT"
  exit 1
fi

if [[ -n "$REFERENCE_DATABASE_PATH" ]]; then
  PARITY_REFERENCE_PATH="$REFERENCE_DATABASE_PATH"
  PARITY_REFERENCE_SELECTION="explicit"
else
  PARITY_REFERENCE_PATH="$LIVE_ORIGINAL_SNAPSHOT_PATH"
  PARITY_REFERENCE_SELECTION="live-original-snapshot"
fi
for reference_sidecar_suffix in -wal -journal; do
  if [[ -s "$PARITY_REFERENCE_PATH$reference_sidecar_suffix" ]]; then
    print -u2 "Parity reference has a nonempty transaction sidecar and is not a deterministic standalone database: $PARITY_REFERENCE_PATH$reference_sidecar_suffix"
    exit 1
  fi
done
PARITY_REFERENCE_SHA256="$(sha256_file "$PARITY_REFERENCE_PATH")"
PARITY_REFERENCE_URI="$(immutable_sqlite_uri "$PARITY_REFERENCE_PATH")"
if ! REFERENCE_COUNTS="$(sqlite3 -readonly -separator ' ' "$PARITY_REFERENCE_URI" \
  "SELECT (SELECT COUNT(*) FROM visits), (SELECT COUNT(*) FROM visits WHERE calendarEventId IS NOT NULL), (SELECT COUNT(DISTINCT calendarEventId) FROM visits WHERE calendarEventId IS NOT NULL), (SELECT COUNT(*) FROM photos), (SELECT COUNT(*) FROM visit_suggested_restaurants), (SELECT COUNT(*) FROM app_metadata);")"; then
  print -u2 "Unable to read the parity reference as an immutable SQLite database"
  exit 1
fi
read \
  REFERENCE_VISIT_COUNT \
  REFERENCE_LINK_COUNT \
  REFERENCE_DISTINCT_EVENT_COUNT \
  REFERENCE_PHOTO_COUNT \
  REFERENCE_SUGGESTION_COUNT \
  REFERENCE_METADATA_COUNT \
  <<<"$REFERENCE_COUNTS"
REFERENCE_INTEGRITY="$(sqlite3 -readonly "$PARITY_REFERENCE_URI" "PRAGMA integrity_check;")"
REFERENCE_FOREIGN_KEY_VIOLATION_COUNT="$(sqlite3 -readonly "$PARITY_REFERENCE_URI" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
if [[ "$REFERENCE_INTEGRITY" != "ok" ]] || (( REFERENCE_FOREIGN_KEY_VIOLATION_COUNT != 0 )); then
  print -u2 "Parity reference SQLite validation failed: integrity=$REFERENCE_INTEGRITY foreign_keys=$REFERENCE_FOREIGN_KEY_VIOLATION_COUNT"
  exit 1
fi
if (( REFERENCE_VISIT_COUNT != LIVE_ORIGINAL_VISIT_COUNT \
  || REFERENCE_LINK_COUNT != LIVE_ORIGINAL_LINK_COUNT \
  || REFERENCE_DISTINCT_EVENT_COUNT != LIVE_ORIGINAL_DISTINCT_EVENT_COUNT \
  || REFERENCE_PHOTO_COUNT != LIVE_ORIGINAL_PHOTO_COUNT \
  || REFERENCE_SUGGESTION_COUNT != LIVE_ORIGINAL_SUGGESTION_COUNT \
  || REFERENCE_METADATA_COUNT != LIVE_ORIGINAL_METADATA_COUNT )); then
  print -u2 "Parity reference does not match the controlled live fixture counts"
  print -u2 "  live: visits=$LIVE_ORIGINAL_VISIT_COUNT links=$LIVE_ORIGINAL_LINK_COUNT events=$LIVE_ORIGINAL_DISTINCT_EVENT_COUNT photos=$LIVE_ORIGINAL_PHOTO_COUNT suggestions=$LIVE_ORIGINAL_SUGGESTION_COUNT metadata=$LIVE_ORIGINAL_METADATA_COUNT"
  print -u2 "  reference: visits=$REFERENCE_VISIT_COUNT links=$REFERENCE_LINK_COUNT events=$REFERENCE_DISTINCT_EVENT_COUNT photos=$REFERENCE_PHOTO_COUNT suggestions=$REFERENCE_SUGGESTION_COUNT metadata=$REFERENCE_METADATA_COUNT"
  exit 1
fi
if [[ "$(sha256_file "$PARITY_REFERENCE_PATH")" != "$PARITY_REFERENCE_SHA256" ]]; then
  print -u2 "Parity reference changed during read-only preflight validation"
  exit 1
fi

VISIT_COUNT="$REFERENCE_VISIT_COUNT"
EXPECTED_LINK_COUNT="$REFERENCE_LINK_COUNT"
EXPECTED_DISTINCT_EVENT_COUNT="$REFERENCE_DISTINCT_EVENT_COUNT"
EXPECTED_PHOTO_COUNT="$REFERENCE_PHOTO_COUNT"
EXPECTED_SUGGESTION_COUNT="$REFERENCE_SUGGESTION_COUNT"
EXPECTED_METADATA_COUNT="$REFERENCE_METADATA_COUNT"

sqlite3 "$DATABASE_PATH" <<'SQL'
BEGIN IMMEDIATE;
UPDATE visits
SET calendarEventId = NULL,
    calendarEventTitle = NULL,
    calendarEventLocation = NULL,
    calendarEventIsAllDay = NULL
WHERE calendarEventId IS NOT NULL
   OR calendarEventTitle IS NOT NULL
   OR calendarEventLocation IS NOT NULL
   OR calendarEventIsAllDay IS NOT NULL;
COMMIT;
SQL

PREPARED_LINK_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE calendarEventId IS NOT NULL;")"
if (( PREPARED_LINK_COUNT != 0 )); then
  print -u2 "Calendar fixture preparation left $PREPARED_LINK_COUNT linked visits"
  exit 1
fi

rm -f -- "$TRIGGER_PATH" "$RUN_DATABASE_PATH" "$RUN_DATABASE_TEMP_PATH" "$SAMPLES_PATH" "$REPORT_PATH" "$REPORT_TEMP_PATH" "$ATTESTATION_PATH" "$ATTESTATION_PATH.tmp"
remove_database_sidecars "$RUN_DATABASE_PATH"
remove_database_sidecars "$RUN_DATABASE_TEMP_PATH"
print "observed_elapsed_s\tcalendar_links\trss_kib" > "$SAMPLES_PATH"
launchctl setenv PALATE_CALENDAR_QUERY_STRATEGY "$QUERY_STRATEGY"
launchctl setenv PALATE_CALENDAR_QUERY_GAP_DAYS "$QUERY_GAP_DAYS"
launchctl setenv PALATE_CALENDAR_VALIDATION_RUN_ID "$VALIDATION_RUN_ID"
launchctl setenv PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH "$ATTESTATION_PATH"
launchctl unsetenv PALATE_VISION_RESULT_PAGE_SIZE || true
launchctl unsetenv PALATE_VISION_CLASSIFICATION_STRATEGY || true
launchctl unsetenv PALATE_VISION_CONCURRENCY || true
launchctl unsetenv PALATE_VISION_PIPELINE_DEPTH || true
if (( MANUAL_LAUNCH )); then
  print "READY_TO_LAUNCH strategy=$QUERY_STRATEGY gap_days=$QUERY_GAP_DAYS"
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
EXPECTED_STRATEGY_ENV="PALATE_CALENDAR_QUERY_STRATEGY=$QUERY_STRATEGY"
EXPECTED_GAP_ENV="PALATE_CALENDAR_QUERY_GAP_DAYS=$QUERY_GAP_DAYS"
EXPECTED_RUN_ENV="PALATE_CALENDAR_VALIDATION_RUN_ID=$VALIDATION_RUN_ID"
EXPECTED_ATTESTATION_ENV="PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH=$ATTESTATION_PATH"
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_STRATEGY_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_GAP_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_RUN_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_ATTESTATION_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit the requested Calendar validation environment"
  exit 1
fi

ATTESTATION_WAIT_STARTED="$(date +%s)"
while true; do
  if [[ -s "$ATTESTATION_PATH" ]] && jq -e . "$ATTESTATION_PATH" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before producing the native Calendar validation attestation"
    exit 1
  fi
  if (( $(date +%s) - ATTESTATION_WAIT_STARTED >= ATTESTATION_TIMEOUT_SECONDS )); then
    print -u2 "Timed out waiting for native Calendar validation attestation: $ATTESTATION_PATH"
    exit 1
  fi
  sleep 0.05
done

if ! jq -e \
  --arg runId "$VALIDATION_RUN_ID" \
  --arg strategy "$QUERY_STRATEGY" \
  --argjson gapDays "$QUERY_GAP_DAYS" \
  'type == "object"
   and ((.runId | type) == "string")
   and (.runId == $runId)
   and ((.resolvedStrategy | type) == "string")
   and (.resolvedStrategy == $strategy)
   and ((.resolvedGapDays | type) == "number")
   and (.resolvedGapDays == $gapDays)' \
  "$ATTESTATION_PATH" >/dev/null; then
  print -u2 "Native Calendar validation attestation did not exactly match the requested run, strategy, and gap"
  exit 1
fi
ATTESTED_RUN_ID="$(jq -r '.runId' "$ATTESTATION_PATH")"
ATTESTED_STRATEGY="$(jq -r '.resolvedStrategy' "$ATTESTATION_PATH")"
ATTESTED_GAP_DAYS="$(jq -r '.resolvedGapDays' "$ATTESTATION_PATH")"
ATTESTED_OBSERVED_EPOCH="$(date +%s.%N)"
print \
  "READY strategy=$QUERY_STRATEGY gap_days=$QUERY_GAP_DAYS pid=$APP_PID trigger=$TRIGGER_PATH"

TRIGGER_WAIT_STARTED="$(date +%s)"
while [[ ! -s "$TRIGGER_PATH" ]]; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before the Rescan Photos trigger was recorded"
    exit 1
  fi
  if (( $(date +%s) - TRIGGER_WAIT_STARTED >= 300 )); then
    print -u2 "Timed out waiting for $TRIGGER_PATH"
    exit 1
  fi
  sleep 0.1
done
TRIGGER_EPOCH="$(< "$TRIGGER_PATH")"
if [[ ! "$TRIGGER_EPOCH" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  print -u2 "Trigger file must contain an epoch timestamp"
  exit 1
fi
TRIGGER_OBSERVED_EPOCH="$(date +%s.%N)"
if ! awk \
  -v trigger="$TRIGGER_EPOCH" \
  -v attested="$ATTESTED_OBSERVED_EPOCH" \
  -v observed="$TRIGGER_OBSERVED_EPOCH" \
  -v max_age="$TRIGGER_MAX_AGE_SECONDS" \
  'BEGIN { exit !(trigger >= attested && trigger <= observed && observed - trigger <= max_age) }'; then
  print -u2 "Trigger timestamp must be after native attestation, nonfuture, and no more than $TRIGGER_MAX_AGE_SECONDS seconds old"
  exit 1
fi

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while true; do
  LINK_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE calendarEventId IS NOT NULL;")"
  COUNT_OBSERVED_EPOCH="$(date +%s.%N)"
  ELAPSED="$(awk -v now="$COUNT_OBSERVED_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.3f", now - start }')"
  RSS_KIB="$(ps -o rss= -p "$APP_PID" | tr -d ' ' || true)"
  [[ -n "$RSS_KIB" ]] || RSS_KIB=0
  print "$ELAPSED\t$LINK_COUNT\t$RSS_KIB" >> "$SAMPLES_PATH"
  if (( LINK_COUNT == EXPECTED_LINK_COUNT )); then
    FINISH_EPOCH="$COUNT_OBSERVED_EPOCH"
    break
  fi
  if (( LINK_COUNT > EXPECTED_LINK_COUNT )); then
    print -u2 "Calendar link count exceeded the expected fixture: $LINK_COUNT"
    exit 1
  fi
  if (( $(date +%s) >= DEADLINE )); then
    print -u2 "Timed out with $LINK_COUNT of $EXPECTED_LINK_COUNT Calendar links"
    exit 1
  fi
  sleep "$TARGET_SAMPLING_INTERVAL_SECONDS"
done

WALL_SECONDS="$(awk -v finish="$FINISH_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", finish - start }')"
MAX_RSS_KIB="$(awk 'NR > 1 && $3 > maximum { maximum = $3 } END { print maximum + 0 }' "$SAMPLES_PATH")"
stop_palate
assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
if [[ "$(sha256_file "$PARITY_REFERENCE_PATH")" != "$PARITY_REFERENCE_SHA256" ]]; then
  print -u2 "Parity reference changed before result validation"
  exit 1
fi
SQL_ESCAPED_PARITY_REFERENCE_URI="$(print -rn -- "$PARITY_REFERENCE_URI" | sed "s/'/''/g")"

read VISIT_MISMATCH_COUNT PHOTO_MISMATCH_COUNT SUGGESTION_MISMATCH_COUNT METADATA_MISMATCH_COUNT <<<"$(sqlite3 -separator ' ' "$DATABASE_PATH" <<SQL
ATTACH DATABASE '$SQL_ESCAPED_PARITY_REFERENCE_URI' AS reference;
WITH visit_mismatches AS (
  SELECT expected.id
  FROM reference.visits AS expected
  LEFT JOIN visits AS current USING (id)
  WHERE current.id IS NULL
     OR current.restaurantId IS NOT expected.restaurantId
     OR current.suggestedRestaurantId IS NOT expected.suggestedRestaurantId
     OR current.status IS NOT expected.status
     OR current.startTime IS NOT expected.startTime
     OR current.endTime IS NOT expected.endTime
     OR current.centerLat IS NOT expected.centerLat
     OR current.centerLon IS NOT expected.centerLon
     OR current.photoCount IS NOT expected.photoCount
     OR current.foodProbable IS NOT expected.foodProbable
     OR current.calendarEventId IS NOT expected.calendarEventId
     OR current.calendarEventTitle IS NOT expected.calendarEventTitle
     OR current.calendarEventLocation IS NOT expected.calendarEventLocation
     OR current.calendarEventIsAllDay IS NOT expected.calendarEventIsAllDay
     OR current.notes IS NOT expected.notes
     OR current.exportedToCalendarId IS NOT expected.exportedToCalendarId
     OR current.awardAtVisit IS NOT expected.awardAtVisit
  UNION ALL
  SELECT current.id
  FROM visits AS current
  LEFT JOIN reference.visits AS expected USING (id)
  WHERE expected.id IS NULL
), photo_mismatches AS (
  SELECT expected.id
  FROM reference.photos AS expected
  LEFT JOIN photos AS current USING (id)
  WHERE current.id IS NULL
     OR current.uri IS NOT expected.uri
     OR current.creationTime IS NOT expected.creationTime
     OR current.latitude IS NOT expected.latitude
     OR current.longitude IS NOT expected.longitude
     OR current.visitId IS NOT expected.visitId
     OR current.foodDetected IS NOT expected.foodDetected
     OR current.foodLabels IS NOT expected.foodLabels
     OR current.foodConfidence IS NOT expected.foodConfidence
     OR current.allLabels IS NOT expected.allLabels
     OR current.mediaType IS NOT expected.mediaType
     OR current.duration IS NOT expected.duration
  UNION ALL
  SELECT current.id
  FROM photos AS current
  LEFT JOIN reference.photos AS expected USING (id)
  WHERE expected.id IS NULL
), suggestion_mismatches AS (
  SELECT expected.visitId, expected.restaurantId
  FROM reference.visit_suggested_restaurants AS expected
  LEFT JOIN visit_suggested_restaurants AS current
    ON current.visitId = expected.visitId
   AND current.restaurantId = expected.restaurantId
  WHERE current.visitId IS NULL
     OR current.distance IS NOT expected.distance
  UNION ALL
  SELECT current.visitId, current.restaurantId
  FROM visit_suggested_restaurants AS current
  LEFT JOIN reference.visit_suggested_restaurants AS expected
    ON expected.visitId = current.visitId
   AND expected.restaurantId = current.restaurantId
  WHERE expected.visitId IS NULL
), metadata_mismatches AS (
  SELECT expected.key
  FROM reference.app_metadata AS expected
  LEFT JOIN app_metadata AS current USING (key)
  WHERE current.key IS NULL
     OR current.value IS NOT expected.value
  UNION ALL
  SELECT current.key
  FROM app_metadata AS current
  LEFT JOIN reference.app_metadata AS expected USING (key)
  WHERE expected.key IS NULL
)
SELECT (SELECT COUNT(*) FROM visit_mismatches),
       (SELECT COUNT(*) FROM photo_mismatches),
       (SELECT COUNT(*) FROM suggestion_mismatches),
       (SELECT COUNT(*) FROM metadata_mismatches);
DETACH DATABASE reference;
SQL
)"
if [[ "$(sha256_file "$PARITY_REFERENCE_PATH")" != "$PARITY_REFERENCE_SHA256" ]]; then
  print -u2 "Parity reference changed during result validation"
  exit 1
fi

ACTUAL_LINK_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE calendarEventId IS NOT NULL;")"
ACTUAL_DISTINCT_EVENT_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(DISTINCT calendarEventId) FROM visits WHERE calendarEventId IS NOT NULL;")"
ACTUAL_PHOTO_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM photos;")"
ACTUAL_SUGGESTION_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visit_suggested_restaurants;")"
ACTUAL_METADATA_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM app_metadata;")"
INTEGRITY="$(sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;")"
FOREIGN_KEY_VIOLATION_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
VALIDATION_STATUS="ok"
VALIDATION_FAILURES=()
if (( VISIT_MISMATCH_COUNT != 0 || PHOTO_MISMATCH_COUNT != 0 || SUGGESTION_MISMATCH_COUNT != 0 || METADATA_MISMATCH_COUNT != 0 )); then
  VALIDATION_FAILURES+=("Parity failed: $VISIT_MISMATCH_COUNT visit mismatches, $PHOTO_MISMATCH_COUNT photo mismatches, $SUGGESTION_MISMATCH_COUNT suggestion mismatches, $METADATA_MISMATCH_COUNT metadata mismatches")
fi
if (( ACTUAL_LINK_COUNT != EXPECTED_LINK_COUNT || ACTUAL_DISTINCT_EVENT_COUNT != EXPECTED_DISTINCT_EVENT_COUNT )); then
  VALIDATION_FAILURES+=("Calendar result count mismatch: expected $EXPECTED_LINK_COUNT links across $EXPECTED_DISTINCT_EVENT_COUNT events, found $ACTUAL_LINK_COUNT links across $ACTUAL_DISTINCT_EVENT_COUNT events")
fi
if (( ACTUAL_PHOTO_COUNT != EXPECTED_PHOTO_COUNT )); then
  VALIDATION_FAILURES+=("Photo count mismatch: expected $EXPECTED_PHOTO_COUNT, found $ACTUAL_PHOTO_COUNT")
fi
if (( ACTUAL_SUGGESTION_COUNT != EXPECTED_SUGGESTION_COUNT )); then
  VALIDATION_FAILURES+=("Visit suggestion count mismatch: expected $EXPECTED_SUGGESTION_COUNT, found $ACTUAL_SUGGESTION_COUNT")
fi
if (( ACTUAL_METADATA_COUNT != EXPECTED_METADATA_COUNT )); then
  VALIDATION_FAILURES+=("App metadata count mismatch: expected $EXPECTED_METADATA_COUNT, found $ACTUAL_METADATA_COUNT")
fi
if [[ "$INTEGRITY" != "ok" ]] || (( FOREIGN_KEY_VIOLATION_COUNT != 0 )); then
  VALIDATION_FAILURES+=("SQLite validation failed: integrity=$INTEGRITY foreign_keys=$FOREIGN_KEY_VIOLATION_COUNT")
fi
if (( ${#VALIDATION_FAILURES} > 0 )); then
  VALIDATION_STATUS="failed"
fi

remove_database_sidecars "$DATABASE_PATH"
rm -f -- "$RUN_DATABASE_TEMP_PATH"
remove_database_sidecars "$RUN_DATABASE_TEMP_PATH"
cp -p "$DATABASE_PATH" "$RUN_DATABASE_TEMP_PATH"
CURRENT_RESULT_SHA256="$(sha256_file "$DATABASE_PATH")"
COPIED_RESULT_SHA256="$(sha256_file "$RUN_DATABASE_TEMP_PATH")"
if [[ "$COPIED_RESULT_SHA256" != "$CURRENT_RESULT_SHA256" ]]; then
  print -u2 "Result database copy hash mismatch"
  exit 1
fi
mv -f -- "$RUN_DATABASE_TEMP_PATH" "$RUN_DATABASE_PATH"
remove_database_sidecars "$RUN_DATABASE_PATH"
VALIDATION_FAILURES_JSON='[]'
if (( ${#VALIDATION_FAILURES} > 0 )); then
  VALIDATION_FAILURES_JSON="$(printf '%s\n' "${VALIDATION_FAILURES[@]}" | jq -R . | jq -s .)"
fi
jq -n \
  --arg status "$VALIDATION_STATUS" \
  --argjson failureReasons "$VALIDATION_FAILURES_JSON" \
  --arg strategy "$QUERY_STRATEGY" \
  --argjson gapDays "$QUERY_GAP_DAYS" \
  --arg attestedRunId "$ATTESTED_RUN_ID" \
  --arg attestedStrategy "$ATTESTED_STRATEGY" \
  --argjson attestedGapDays "$ATTESTED_GAP_DAYS" \
  --argjson attestedObservedAtEpochSeconds "$ATTESTED_OBSERVED_EPOCH" \
  --argjson triggerEpochSeconds "$TRIGGER_EPOCH" \
  --argjson triggerObservedAtEpochSeconds "$TRIGGER_OBSERVED_EPOCH" \
  --argjson triggerMaxAgeSeconds "$TRIGGER_MAX_AGE_SECONDS" \
  --argjson visitCount "$VISIT_COUNT" \
  --argjson calendarLinkCount "$ACTUAL_LINK_COUNT" \
  --argjson distinctEventCount "$ACTUAL_DISTINCT_EVENT_COUNT" \
  --argjson photoCount "$ACTUAL_PHOTO_COUNT" \
  --argjson suggestionCount "$ACTUAL_SUGGESTION_COUNT" \
  --argjson metadataCount "$ACTUAL_METADATA_COUNT" \
  --argjson visitMismatchCount "$VISIT_MISMATCH_COUNT" \
  --argjson photoMismatchCount "$PHOTO_MISMATCH_COUNT" \
  --argjson suggestionMismatchCount "$SUGGESTION_MISMATCH_COUNT" \
  --argjson metadataMismatchCount "$METADATA_MISMATCH_COUNT" \
  --argjson wallSeconds "$WALL_SECONDS" \
  --argjson targetSamplingIntervalSeconds "$TARGET_SAMPLING_INTERVAL_SECONDS" \
  --argjson maxRssKiB "$MAX_RSS_KIB" \
  --arg integrity "$INTEGRITY" \
  --argjson foreignKeyViolationCount "$FOREIGN_KEY_VIOLATION_COUNT" \
  --arg liveDatabasePath "${DATABASE_PATH:A}" \
  --arg liveOriginalSnapshotPath "$LIVE_ORIGINAL_SNAPSHOT_PATH" \
  --arg liveOriginalSha256 "$ORIGINAL_SHA256" \
  --argjson liveOriginalVisitCount "$LIVE_ORIGINAL_VISIT_COUNT" \
  --argjson liveOriginalCalendarLinkCount "$LIVE_ORIGINAL_LINK_COUNT" \
  --argjson liveOriginalDistinctEventCount "$LIVE_ORIGINAL_DISTINCT_EVENT_COUNT" \
  --argjson liveOriginalPhotoCount "$LIVE_ORIGINAL_PHOTO_COUNT" \
  --argjson liveOriginalSuggestionCount "$LIVE_ORIGINAL_SUGGESTION_COUNT" \
  --argjson liveOriginalMetadataCount "$LIVE_ORIGINAL_METADATA_COUNT" \
  --arg parityReferencePath "$PARITY_REFERENCE_PATH" \
  --arg parityReferenceSha256 "$PARITY_REFERENCE_SHA256" \
  --arg parityReferenceSelection "$PARITY_REFERENCE_SELECTION" \
  --arg parityReferenceIntegrity "$REFERENCE_INTEGRITY" \
  --argjson parityReferenceForeignKeyViolationCount "$REFERENCE_FOREIGN_KEY_VIOLATION_COUNT" \
  --argjson parityReferenceVisitCount "$REFERENCE_VISIT_COUNT" \
  --argjson parityReferenceCalendarLinkCount "$REFERENCE_LINK_COUNT" \
  --argjson parityReferenceDistinctEventCount "$REFERENCE_DISTINCT_EVENT_COUNT" \
  --argjson parityReferencePhotoCount "$REFERENCE_PHOTO_COUNT" \
  --argjson parityReferenceSuggestionCount "$REFERENCE_SUGGESTION_COUNT" \
  --argjson parityReferenceMetadataCount "$REFERENCE_METADATA_COUNT" \
  --arg resultSha256 "$CURRENT_RESULT_SHA256" \
  --arg resultDatabasePath "${RUN_DATABASE_PATH:A}" \
  --arg attestationPath "$ATTESTATION_PATH" \
  --arg samplesPath "$SAMPLES_PATH" \
  '{
    schemaVersion: 3,
    status: $status,
    strategy: $strategy,
    sparseCoalescingGapDays: $gapDays,
    fixture: {
      visits: $visitCount,
      calendarLinks: $calendarLinkCount,
      distinctEvents: $distinctEventCount,
      photos: $photoCount,
      visitSuggestedRestaurants: $suggestionCount,
      appMetadata: $metadataCount
    },
    timing: {
      wallSeconds: $wallSeconds,
      scope: "trigger-to-durable-calendar-restoration for the Rescan Photos prefix through Calendar matching; includes PhotoKit asset metadata scanning and visit grouping/indexing before Calendar matching; excludes post-Calendar phases and is not isolated EventKit latency",
      isolatedEventKitLatency: false,
      excludesPostCalendarPhases: true,
      targetSamplingIntervalSeconds: $targetSamplingIntervalSeconds,
      triggerEpochSeconds: $triggerEpochSeconds,
      triggerObservedAtEpochSeconds: $triggerObservedAtEpochSeconds,
      triggerMaximumAcceptedAgeSeconds: $triggerMaxAgeSeconds
    },
    maxRssKiB: $maxRssKiB,
    runtimeAttestation: {
      runId: $attestedRunId,
      resolvedStrategy: $attestedStrategy,
      resolvedGapDays: $attestedGapDays,
      observedAtEpochSeconds: $attestedObservedAtEpochSeconds,
      source: "native-runtime-attestation-file-and-process-environment",
      sourcePathDuringRun: $attestationPath
    },
    validation: {
      failureReasons: $failureReasons,
      exactVisitParityExcludingUpdatedAt: ($visitMismatchCount == 0),
      visitMismatchCount: $visitMismatchCount,
      exactPhotoParity: ($photoMismatchCount == 0),
      photoMismatchCount: $photoMismatchCount,
      exactVisitSuggestedRestaurantParity: ($suggestionMismatchCount == 0),
      visitSuggestedRestaurantMismatchCount: $suggestionMismatchCount,
      exactAppMetadataParity: ($metadataMismatchCount == 0),
      appMetadataMismatchCount: $metadataMismatchCount,
      integrity: $integrity,
      foreignKeyViolationCount: $foreignKeyViolationCount
    },
    liveOriginalDatabase: {
      livePath: $liveDatabasePath,
      snapshotPath: $liveOriginalSnapshotPath,
      sha256: $liveOriginalSha256,
      fixture: {
        visits: $liveOriginalVisitCount,
        calendarLinks: $liveOriginalCalendarLinkCount,
        distinctEvents: $liveOriginalDistinctEventCount,
        photos: $liveOriginalPhotoCount,
        visitSuggestedRestaurants: $liveOriginalSuggestionCount,
        appMetadata: $liveOriginalMetadataCount
      }
    },
    parityReferenceDatabase: {
      selection: $parityReferenceSelection,
      path: $parityReferencePath,
      sha256: $parityReferenceSha256,
      accessMode: "immutable-read-only",
      integrity: $parityReferenceIntegrity,
      foreignKeyViolationCount: $parityReferenceForeignKeyViolationCount,
      fixture: {
        visits: $parityReferenceVisitCount,
        calendarLinks: $parityReferenceCalendarLinkCount,
        distinctEvents: $parityReferenceDistinctEventCount,
        photos: $parityReferencePhotoCount,
        visitSuggestedRestaurants: $parityReferenceSuggestionCount,
        appMetadata: $parityReferenceMetadataCount
      }
    },
    resultDatabase: {
      path: $resultDatabasePath,
      sha256: $resultSha256
    },
    samplesPath: $samplesPath
  }' > "$REPORT_TEMP_PATH"
mv -f -- "$REPORT_TEMP_PATH" "$REPORT_PATH"

if [[ "$VALIDATION_STATUS" != "ok" ]]; then
  for failure_reason in "${VALIDATION_FAILURES[@]}"; do
    print -u2 "$failure_reason"
  done
  print -u2 "Failure artifacts retained: result=$RUN_DATABASE_PATH report=$REPORT_PATH"
  exit 1
fi

restore_database
RESTORED_SHA256="$(sha256_file "$DATABASE_PATH")"
if [[ "$RESTORED_SHA256" != "$ORIGINAL_SHA256" ]]; then
  print -u2 "Database restoration hash mismatch"
  exit 1
fi

print "COMPLETE report=$REPORT_PATH wall_seconds=$WALL_SECONDS max_rss_kib=$MAX_RSS_KIB restored_sha256=$RESTORED_SHA256"

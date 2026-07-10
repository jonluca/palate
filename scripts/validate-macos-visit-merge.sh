#!/bin/zsh
set -euo pipefail

SCRIPT_DIRECTORY="${0:A:h}"
ROOT_DIRECTORY="${SCRIPT_DIRECTORY:h}"
HELPER_PATH="$SCRIPT_DIRECTORY/macos-visit-merge-fixture.mjs"

APP_PATH=""
DATABASE_PATH=""
OUTPUT_PREFIX=""
NODE_BINARY="${PALATE_NODE_BINARY:-}"
TIMEOUT_SECONDS="120"
SAMPLE_INTERVAL_SECONDS="0.05"
MANUAL_LAUNCH=0
RETAIN_SENSITIVE_ARTIFACTS=0

usage() {
  print "Usage: validate-macos-visit-merge.sh --app=PATH --database=PATH --output-prefix=PATH [options]"
  print ""
  print "  --node=PATH                 Node 24+ executable with node:sqlite"
  print "  --timeout-seconds=N         Completion timeout after trigger (default: 120)"
  print "  --sample-interval=N         Progress/RSS sample interval in seconds (default: 0.05)"
  print "  --manual-launch             Wait for Xcode Run Without Building"
  print "  --retain-sensitive-artifacts Keep snapshot, prepared fixture, reference, and ID manifest after success"
  print ""
  print "The validator stops Palate, checkpoints and snapshots the supplied live database,"
  print "derives a 37x5 fixture in a copy, generates an independent legacy reference, and"
  print "atomically installs only the prepared copy for the production run. It waits for"
  print "OUTPUT_PREFIX.trigger. Write the current fractional epoch to that file immediately"
  print "before confirming Settings > Advanced Settings > Merge Duplicate Visits > Merge All."
  print "Every exit and signal stops Palate, restores launch state, and atomically restores"
  print "the original database with an exact SHA-256 check. Use --manual-launch for the"
  print "Designed-for-iPhone Release bundle; direct open is not the supported real run path."
  print "If Xcode was already running before READY_TO_LAUNCH, quit and reopen it after that"
  print "message so its child process can inherit the validation environment. A missing"
  print "environment marker causes a safe failure and restoration before any trigger."
}

for argument in "$@"; do
  case "$argument" in
    --app=*) APP_PATH="${argument#*=}" ;;
    --database=*) DATABASE_PATH="${argument#*=}" ;;
    --output-prefix=*) OUTPUT_PREFIX="${argument#*=}" ;;
    --node=*) NODE_BINARY="${argument#*=}" ;;
    --timeout-seconds=*) TIMEOUT_SECONDS="${argument#*=}" ;;
    --sample-interval=*) SAMPLE_INTERVAL_SECONDS="${argument#*=}" ;;
    --manual-launch) MANUAL_LAUNCH=1 ;;
    --retain-sensitive-artifacts) RETAIN_SENSITIVE_ARTIFACTS=1 ;;
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

if [[ ! -d "$APP_PATH" || ! -x "$APP_PATH/Palate" ]]; then
  print -u2 "A built Palate.app is required via --app"
  exit 2
fi
if [[ ! -s "$APP_PATH/main.jsbundle" ]]; then
  print -u2 "The app must contain a nonempty Release main.jsbundle"
  exit 2
fi
if [[ ! -f "$DATABASE_PATH" ]]; then
  print -u2 "The live SQLite database is required via --database"
  exit 2
fi
if [[ -z "$OUTPUT_PREFIX" ]]; then
  print -u2 "--output-prefix is required"
  exit 2
fi
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS < 1 )); then
  print -u2 "--timeout-seconds must be a positive integer"
  exit 2
fi
if ! awk -v value="$SAMPLE_INTERVAL_SECONDS" \
  'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value >= 0.01 && value <= 1) }'; then
  print -u2 "--sample-interval must be a number from 0.01 through 1"
  exit 2
fi
if [[ ! -f "$HELPER_PATH" ]]; then
  print -u2 "Fixture helper is missing: $HELPER_PATH"
  exit 2
fi
if [[ -z "$NODE_BINARY" ]]; then
  NODE_BINARY="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "$NODE_BINARY" ]]; then
  bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  [[ -x "$bundled_node" ]] && NODE_BINARY="$bundled_node"
fi
if [[ -z "$NODE_BINARY" || ! -x "$NODE_BINARY" ]]; then
  print -u2 "Node 24+ is required; provide it with --node=PATH"
  exit 2
fi
if ! NODE_NO_WARNINGS=1 "$NODE_BINARY" -e \
  'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); db.close();' \
  >/dev/null 2>&1; then
  print -u2 "The selected Node executable does not provide node:sqlite"
  exit 2
fi

for dependency in awk codesign jq lsof pgrep pkill ps shasum sqlite3 stat; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    print -u2 "Missing dependency: $dependency"
    exit 2
  fi
done

mkdir -p "${OUTPUT_PREFIX:h}"
RUN_ID="visit-merge-$$-$(date +%s)-$RANDOM"
SNAPSHOT_PATH="$OUTPUT_PREFIX.$RUN_ID.original.db"
SNAPSHOT_TEMP_PATH="$SNAPSHOT_PATH.tmp"
PREPARED_PATH="$OUTPUT_PREFIX.$RUN_ID.prepared.db"
PREPARED_TEMP_PATH="$PREPARED_PATH.tmp"
REFERENCE_PATH="$OUTPUT_PREFIX.$RUN_ID.reference.db"
REFERENCE_TEMP_PATH="$REFERENCE_PATH.tmp"
REFERENCE_REPORT_PATH="$OUTPUT_PREFIX.reference.json"
MANIFEST_PATH="$OUTPUT_PREFIX.fixture.json"
RESULT_PATH="$OUTPUT_PREFIX.result.db"
RESULT_TEMP_PATH="$RESULT_PATH.tmp-$RUN_ID"
VALIDATION_REPORT_PATH="$OUTPUT_PREFIX.validation.json"
REPORT_PATH="$OUTPUT_PREFIX.json"
REPORT_TEMP_PATH="$REPORT_PATH.tmp-$RUN_ID"
SAMPLES_PATH="$OUTPUT_PREFIX.samples.tsv"
TRIGGER_PATH="$OUTPUT_PREFIX.trigger"
INSTALL_TEMP_PATH="$DATABASE_PATH.install-$RUN_ID.tmp"
RESTORE_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.tmp"
SNAPSHOT_READY=0
LIVE_REPLACED=0
RESTORED=0
CLEANUP_FINISHED=0
PRESERVE_FAILURE_ARTIFACTS=0
ORIGINAL_SHA256=""
PREPARED_SHA256=""
REFERENCE_SHA256=""

ORIGINAL_VALIDATION_RUN_ID="$(launchctl getenv PALATE_VISIT_MERGE_VALIDATION_RUN_ID 2>/dev/null || true)"
ORIGINAL_VALIDATION_RUN_ID_SET=$(( ${#ORIGINAL_VALIDATION_RUN_ID} > 0 ))

restore_launch_environment_value() {
  local key="$1"
  local value="$2"
  local was_set="$3"
  if (( was_set )); then
    launchctl setenv "$key" "$value"
  else
    launchctl unsetenv "$key"
  fi
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

attest_running_app_bytes() {
  local app_pid="$1"
  local process_executable_path process_app_path process_executable_sha256 process_bundle_sha256
  process_executable_path="$(
    lsof -a -p "$app_pid" -d txt -Fn 2>/dev/null \
      | awk '/^n/ && substr($0, 2) ~ /\/Palate[.]app\/Palate$/ { print substr($0, 2); exit }'
  )"
  if [[ -z "$process_executable_path" ]]; then
    print -u2 "Could not resolve the launched Palate executable for PID $app_pid"
    return 1
  fi
  process_app_path="${process_executable_path:h}"
  if [[ ! -x "$process_executable_path" || ! -s "$process_app_path/main.jsbundle" ]]; then
    print -u2 "The launched Palate process does not expose a complete Release bundle at $process_app_path"
    return 1
  fi
  if ! codesign --verify --deep --strict --verbose=2 "$process_app_path"; then
    print -u2 "The launched Palate bundle failed code-signature verification"
    return 1
  fi
  process_executable_sha256="$(sha256_file "$process_executable_path")"
  process_bundle_sha256="$(sha256_file "$process_app_path/main.jsbundle")"
  if [[ "$process_executable_sha256" != "$APP_EXECUTABLE_SHA256" ]] \
    || [[ "$process_bundle_sha256" != "$APP_BUNDLE_SHA256" ]]; then
    print -u2 "The launched Palate bytes do not match the supplied Release app"
    print -u2 "Expected executable=$APP_EXECUTABLE_SHA256 bundle=$APP_BUNDLE_SHA256"
    print -u2 "Observed executable=$process_executable_sha256 bundle=$process_bundle_sha256"
    return 1
  fi
  PROCESS_EXECUTABLE_PATH="$process_executable_path"
  PROCESS_APP_PATH="$process_app_path"
  PROCESS_EXECUTABLE_SHA256="$process_executable_sha256"
  PROCESS_BUNDLE_SHA256="$process_bundle_sha256"
}

remove_database_sidecars() {
  local database_path="$1"
  rm -f -- "$database_path-wal" "$database_path-shm" "$database_path-journal"
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
    wal_size="$(stat -f '%z' "$database_path-wal")"
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

restore_database_and_environment() {
  local restore_failed=0
  local prepared_restore_sha restored_live_sha
  if (( CLEANUP_FINISHED )); then
    return 0
  fi

  if ! stop_palate; then
    print -u2 "Cannot safely restore the database while Palate is running"
    restore_failed=1
  fi
  if (( SNAPSHOT_READY && ! RESTORED )); then
    if [[ ! -f "$SNAPSHOT_PATH" ]]; then
      print -u2 "The validated per-run snapshot is missing: $SNAPSHOT_PATH"
      restore_failed=1
    fi
    if (( ! restore_failed )); then
      rm -f -- "$RESTORE_TEMP_PATH"
      remove_database_sidecars "$RESTORE_TEMP_PATH"
      if ! cp -p "$SNAPSHOT_PATH" "$RESTORE_TEMP_PATH"; then
        print -u2 "Failed to prepare the atomic database restoration copy"
        restore_failed=1
      elif ! prepared_restore_sha="$(sha256_file "$RESTORE_TEMP_PATH")"; then
        print -u2 "Failed to hash the prepared restoration copy"
        restore_failed=1
      elif [[ "$prepared_restore_sha" != "$ORIGINAL_SHA256" ]]; then
        print -u2 "Prepared restoration copy hash mismatch"
        restore_failed=1
      fi
    fi
    if (( ! restore_failed )); then
      remove_database_sidecars "$DATABASE_PATH"
      if ! mv -f -- "$RESTORE_TEMP_PATH" "$DATABASE_PATH"; then
        print -u2 "Failed to atomically replace the live database"
        restore_failed=1
      else
        remove_database_sidecars "$DATABASE_PATH"
        restored_live_sha="$(sha256_file "$DATABASE_PATH")"
        if [[ "$restored_live_sha" != "$ORIGINAL_SHA256" ]]; then
          print -u2 "Restored live database hash mismatch"
          restore_failed=1
        else
          RESTORED=1
        fi
      fi
    fi
  fi

  if ! restore_launch_environment_value \
    PALATE_VISIT_MERGE_VALIDATION_RUN_ID \
    "$ORIGINAL_VALIDATION_RUN_ID" \
    "$ORIGINAL_VALIDATION_RUN_ID_SET"; then
    print -u2 "Failed to restore PALATE_VISIT_MERGE_VALIDATION_RUN_ID"
    restore_failed=1
  fi
  rm -f -- \
    "$SNAPSHOT_TEMP_PATH" "$PREPARED_TEMP_PATH" "$REFERENCE_TEMP_PATH" \
    "$RESULT_TEMP_PATH" "$REPORT_TEMP_PATH" "$INSTALL_TEMP_PATH" "$RESTORE_TEMP_PATH"
  remove_database_sidecars "$SNAPSHOT_PATH"
  remove_database_sidecars "$PREPARED_PATH"
  remove_database_sidecars "$REFERENCE_PATH"
  remove_database_sidecars "$RESULT_PATH"
  remove_database_sidecars "$INSTALL_TEMP_PATH"
  remove_database_sidecars "$RESTORE_TEMP_PATH"
  if (( restore_failed == 0 )); then
    CLEANUP_FINISHED=1
    return 0
  fi
  return 1
}

handle_signal() {
  local exit_code="$1"
  trap '' INT TERM HUP
  exit "$exit_code"
}

handle_exit() {
  local exit_code="$?"
  local restoration_succeeded=0
  trap - EXIT
  if restore_database_and_environment; then
    restoration_succeeded=1
  else
    print -u2 "One or more restoration steps failed"
    (( exit_code == 0 )) && exit_code=1
  fi
  if (( exit_code != 0 && restoration_succeeded && RESTORED \
    && ! RETAIN_SENSITIVE_ARTIFACTS && ! PRESERVE_FAILURE_ARTIFACTS )); then
    rm -f -- "$SNAPSHOT_PATH" "$PREPARED_PATH" "$REFERENCE_PATH" "$MANIFEST_PATH"
    remove_database_sidecars "$SNAPSHOT_PATH"
    remove_database_sidecars "$PREPARED_PATH"
    remove_database_sidecars "$REFERENCE_PATH"
    print -u2 "Removed sensitive intermediate databases after safe restoration; diagnostic JSON/result artifacts, if any, remain under $OUTPUT_PREFIX"
  fi
  exit "$exit_code"
}

trap handle_exit EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

# Verify the bundle before any database mutation.
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
APP_EXECUTABLE_SHA256="$(sha256_file "$APP_PATH/Palate")"
APP_BUNDLE_SHA256="$(sha256_file "$APP_PATH/main.jsbundle")"

stop_palate
assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
ORIGINAL_QUICK_CHECK="$(sqlite3 "$DATABASE_PATH" "PRAGMA quick_check;")"
ORIGINAL_FOREIGN_KEY_VIOLATION_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
if [[ "$ORIGINAL_QUICK_CHECK" != "ok" ]] || (( ORIGINAL_FOREIGN_KEY_VIOLATION_COUNT != 0 )); then
  print -u2 "Original database failed preflight validation: quick_check=$ORIGINAL_QUICK_CHECK foreign_keys=$ORIGINAL_FOREIGN_KEY_VIOLATION_COUNT"
  exit 1
fi
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

rm -f -- \
  "$PREPARED_PATH" "$PREPARED_TEMP_PATH" "$REFERENCE_PATH" "$REFERENCE_TEMP_PATH" \
  "$REFERENCE_REPORT_PATH" "$MANIFEST_PATH" "$RESULT_PATH" "$RESULT_TEMP_PATH" \
  "$VALIDATION_REPORT_PATH" "$REPORT_PATH" "$REPORT_TEMP_PATH" "$SAMPLES_PATH" "$TRIGGER_PATH"
remove_database_sidecars "$PREPARED_PATH"
remove_database_sidecars "$REFERENCE_PATH"
remove_database_sidecars "$RESULT_PATH"

cp -p "$SNAPSHOT_PATH" "$PREPARED_TEMP_PATH"
if [[ "$(sha256_file "$PREPARED_TEMP_PATH")" != "$ORIGINAL_SHA256" ]]; then
  print -u2 "Prepared fixture source copy hash mismatch"
  exit 1
fi
mv -f -- "$PREPARED_TEMP_PATH" "$PREPARED_PATH"
NODE_NO_WARNINGS=1 "$NODE_BINARY" "$HELPER_PATH" prepare \
  --database="$PREPARED_PATH" \
  --manifest="$MANIFEST_PATH"
remove_database_sidecars "$PREPARED_PATH"
PREPARED_SHA256="$(sha256_file "$PREPARED_PATH")"
if [[ "$(jq -r '.databaseSha256' "$MANIFEST_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Prepared fixture manifest hash mismatch"
  exit 1
fi
if ! jq -e \
  '.prepared.mergeableGroupCount == 37
   and .prepared.mergeCount == 148
   and .constants.expectedLegacyMergeExecutionCalls == 1628
   and (.selectedVisitIds | length) == 185
   and (.targetVisitIds | length) == 37
   and (.sourceVisitIds | length) == 148' \
  "$MANIFEST_PATH" >/dev/null; then
  print -u2 "Prepared fixture manifest does not have the required 37x5 shape"
  exit 1
fi

cp -p "$PREPARED_PATH" "$REFERENCE_TEMP_PATH"
if [[ "$(sha256_file "$REFERENCE_TEMP_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Reference source copy hash mismatch"
  exit 1
fi
mv -f -- "$REFERENCE_TEMP_PATH" "$REFERENCE_PATH"
NODE_NO_WARNINGS=1 "$NODE_BINARY" "$HELPER_PATH" reference \
  --database="$REFERENCE_PATH" \
  --manifest="$MANIFEST_PATH" \
  --report="$REFERENCE_REPORT_PATH"
remove_database_sidecars "$REFERENCE_PATH"
REFERENCE_SHA256="$(sha256_file "$REFERENCE_PATH")"
if [[ "$(jq -r '.databaseSha256' "$REFERENCE_REPORT_PATH")" != "$REFERENCE_SHA256" ]]; then
  print -u2 "Reference report hash mismatch"
  exit 1
fi

# Install only the prepared copy after the original snapshot and oracle are durable.
rm -f -- "$INSTALL_TEMP_PATH"
remove_database_sidecars "$INSTALL_TEMP_PATH"
cp -p "$PREPARED_PATH" "$INSTALL_TEMP_PATH"
if [[ "$(sha256_file "$INSTALL_TEMP_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Prepared installation copy hash mismatch"
  exit 1
fi
remove_database_sidecars "$DATABASE_PATH"
mv -f -- "$INSTALL_TEMP_PATH" "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
LIVE_REPLACED=1
if [[ "$(sha256_file "$DATABASE_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Installed fixture hash mismatch"
  exit 1
fi

print "elapsed_s\tfixture_visits\trss_kib\tcpu_percent\twal_bytes" > "$SAMPLES_PATH"
launchctl setenv PALATE_VISIT_MERGE_VALIDATION_RUN_ID "$RUN_ID"
if (( MANUAL_LAUNCH )); then
  print "READY_TO_LAUNCH run_id=$RUN_ID"
else
  open "$APP_PATH"
fi

APP_PID=""
for _ in {1..1200}; do
  APP_PID="$(pgrep -x Palate | head -1 || true)"
  [[ -n "$APP_PID" ]] && break
  sleep 0.1
done
if [[ -z "$APP_PID" ]]; then
  print -u2 "Palate did not launch"
  exit 1
fi
PROCESS_ENVIRONMENT="$(ps eww -p "$APP_PID" -o command=)"
EXPECTED_RUN_ENV="PALATE_VISIT_MERGE_VALIDATION_RUN_ID=$RUN_ID"
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_RUN_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit the requested visit-merge validation run"
  exit 1
fi
if ! attest_running_app_bytes "$APP_PID"; then
  print -u2 "Withholding READY and the merge trigger from the unattested Palate build; restoring the fixture"
  exit 1
fi
PROCESS_OBSERVED_EPOCH="$(date +%s.%N)"
PRE_TRIGGER_FIXTURE_COUNT="$(sqlite3 "$DATABASE_PATH" \
  "SELECT COUNT(*) FROM visits WHERE restaurantId LIKE '__palate_merge_validation_restaurant_%';")"
if (( PRE_TRIGGER_FIXTURE_COUNT != 185 )); then
  print -u2 "The launched app changed the prepared fixture before the trigger: $PRE_TRIGGER_FIXTURE_COUNT rows"
  exit 1
fi
print "READY run_id=$RUN_ID pid=$APP_PID trigger=$TRIGGER_PATH expected_merges=148"

TRIGGER_WAIT_STARTED="$(date +%s)"
while [[ ! -s "$TRIGGER_PATH" ]]; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before the Merge All trigger was recorded"
    exit 1
  fi
  if (( $(date +%s) - TRIGGER_WAIT_STARTED >= 300 )); then
    print -u2 "Timed out waiting for $TRIGGER_PATH"
    exit 1
  fi
  sleep 0.1
done
TRIGGER_EPOCH="$(< "$TRIGGER_PATH")"
TRIGGER_OBSERVED_EPOCH="$(date +%s.%N)"
if [[ ! "$TRIGGER_EPOCH" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  print -u2 "Trigger file must contain an epoch timestamp"
  exit 1
fi
if ! awk \
  -v trigger="$TRIGGER_EPOCH" \
  -v launched="$PROCESS_OBSERVED_EPOCH" \
  -v observed="$TRIGGER_OBSERVED_EPOCH" \
  'BEGIN { exit !(trigger >= launched && trigger <= observed && observed - trigger <= 30) }'; then
  print -u2 "Trigger timestamp must follow launch observation, be nonfuture, and be no more than 30 seconds old"
  exit 1
fi

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while true; do
  OBSERVED_EPOCH="$(date +%s.%N)"
  ELAPSED_SECONDS="$(awk -v now="$OBSERVED_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", now - start }')"
  FIXTURE_COUNT="$(sqlite3 "$DATABASE_PATH" \
    "SELECT COUNT(*) FROM visits WHERE restaurantId LIKE '__palate_merge_validation_restaurant_%';")"
  RSS_KIB="$(ps -o rss= -p "$APP_PID" | tr -d ' ' || true)"
  CPU_PERCENT="$(ps -o %cpu= -p "$APP_PID" | tr -d ' ' || true)"
  [[ -n "$RSS_KIB" ]] || RSS_KIB=0
  [[ -n "$CPU_PERCENT" ]] || CPU_PERCENT=0
  if [[ -e "$DATABASE_PATH-wal" ]]; then
    WAL_BYTES="$(stat -f '%z' "$DATABASE_PATH-wal" 2>/dev/null || print 0)"
  else
    WAL_BYTES=0
  fi
  print "$ELAPSED_SECONDS\t$FIXTURE_COUNT\t$RSS_KIB\t$CPU_PERCENT\t$WAL_BYTES" >> "$SAMPLES_PATH"
  if (( FIXTURE_COUNT == 37 )); then
    FINISH_EPOCH="$OBSERVED_EPOCH"
    break
  fi
  if (( FIXTURE_COUNT < 37 || FIXTURE_COUNT > 185 )); then
    print -u2 "Fixture visit count left its valid bounds: $FIXTURE_COUNT"
    exit 1
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before the merge completed"
    exit 1
  fi
  if (( $(date +%s) >= DEADLINE )); then
    print -u2 "Timed out with $FIXTURE_COUNT of 185 fixture visits remaining"
    exit 1
  fi
  sleep "$SAMPLE_INTERVAL_SECONDS"
done

WALL_SECONDS="$(awk -v finish="$FINISH_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", finish - start }')"
TRIGGER_MS="$(awk -v value="$TRIGGER_EPOCH" 'BEGIN { printf "%.0f", value * 1000 }')"
FINISH_MS="$(awk -v value="$FINISH_EPOCH" 'BEGIN { printf "%.0f", value * 1000 }')"
MAX_RSS_KIB="$(awk 'NR > 1 && $3 > maximum { maximum = $3 } END { print maximum + 0 }' "$SAMPLES_PATH")"
BASELINE_RSS_KIB="$(awk 'NR == 2 { print $3 + 0 }' "$SAMPLES_PATH")"
MAX_WAL_BYTES="$(awk 'NR > 1 && $5 > maximum { maximum = $5 } END { print maximum + 0 }' "$SAMPLES_PATH")"
MAX_CPU_PERCENT="$(awk 'NR > 1 && $4 > maximum { maximum = $4 } END { print maximum + 0 }' "$SAMPLES_PATH")"
RSS_DELTA_KIB=$(( MAX_RSS_KIB - BASELINE_RSS_KIB ))

if ! attest_running_app_bytes "$APP_PID"; then
  print -u2 "The launched Palate bundle changed before validation completed"
  exit 1
fi
stop_palate
assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
if [[ "$(sha256_file "$REFERENCE_PATH")" != "$REFERENCE_SHA256" ]]; then
  print -u2 "Independent reference changed during the app run"
  exit 1
fi
cp -p "$DATABASE_PATH" "$RESULT_TEMP_PATH"
RESULT_SHA256="$(sha256_file "$DATABASE_PATH")"
if [[ "$(sha256_file "$RESULT_TEMP_PATH")" != "$RESULT_SHA256" ]]; then
  print -u2 "Result database copy hash mismatch"
  exit 1
fi
mv -f -- "$RESULT_TEMP_PATH" "$RESULT_PATH"
remove_database_sidecars "$RESULT_PATH"

set +e
NODE_NO_WARNINGS=1 "$NODE_BINARY" "$HELPER_PATH" validate \
  --candidate="$RESULT_PATH" \
  --reference="$REFERENCE_PATH" \
  --prepared="$PREPARED_PATH" \
  --manifest="$MANIFEST_PATH" \
  --trigger-ms="$TRIGGER_MS" \
  --finish-ms="$FINISH_MS" \
  --report="$VALIDATION_REPORT_PATH"
VALIDATION_EXIT_STATUS="$?"
set -e
VALIDATION_STATUS="$(jq -r '.status' "$VALIDATION_REPORT_PATH" 2>/dev/null || print failed)"
if [[ "$(sha256_file "$REFERENCE_PATH")" != "$REFERENCE_SHA256" ]]; then
  print -u2 "Independent reference changed during semantic validation"
  exit 1
fi
if [[ "$(sha256_file "$PREPARED_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Prepared fixture changed during semantic validation"
  exit 1
fi
if [[ "$(jq -r '.files.referenceSha256 // empty' "$VALIDATION_REPORT_PATH" 2>/dev/null || true)" != "$REFERENCE_SHA256" ]] \
  || [[ "$(jq -r '.files.preparedSha256 // empty' "$VALIDATION_REPORT_PATH" 2>/dev/null || true)" != "$PREPARED_SHA256" ]]; then
  print -u2 "Semantic validation did not attest the expected prepared/reference hashes"
  exit 1
fi

if ! restore_database_and_environment; then
  print -u2 "Database or launch-environment restoration failed"
  exit 1
fi
RESTORED_SHA256="$(sha256_file "$DATABASE_PATH")"
RESTORED_QUICK_CHECK="$(sqlite3 "$DATABASE_PATH" "PRAGMA quick_check;")"
RESTORED_FOREIGN_KEY_VIOLATION_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
if [[ "$RESTORED_SHA256" != "$ORIGINAL_SHA256" || "$RESTORED_QUICK_CHECK" != "ok" ]] \
  || (( RESTORED_FOREIGN_KEY_VIOLATION_COUNT != 0 )); then
  print -u2 "Restored database failed final validation"
  exit 1
fi
assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"

jq -n \
  --arg status "$VALIDATION_STATUS" \
  --arg runId "$RUN_ID" \
  --argjson wallSeconds "$WALL_SECONDS" \
  --argjson sampleIntervalSeconds "$SAMPLE_INTERVAL_SECONDS" \
  --argjson maxRssKiB "$MAX_RSS_KIB" \
  --argjson baselineRssKiB "$BASELINE_RSS_KIB" \
  --argjson rssDeltaKiB "$RSS_DELTA_KIB" \
  --argjson maxCpuPercent "$MAX_CPU_PERCENT" \
  --argjson maxWalBytes "$MAX_WAL_BYTES" \
  --arg executableSha256 "$APP_EXECUTABLE_SHA256" \
  --arg bundleSha256 "$APP_BUNDLE_SHA256" \
  --arg processExecutablePath "$PROCESS_EXECUTABLE_PATH" \
  --arg processAppPath "$PROCESS_APP_PATH" \
  --arg processExecutableSha256 "$PROCESS_EXECUTABLE_SHA256" \
  --arg processBundleSha256 "$PROCESS_BUNDLE_SHA256" \
  --arg originalSha256 "$ORIGINAL_SHA256" \
  --arg preparedSha256 "$PREPARED_SHA256" \
  --arg referenceSha256 "$REFERENCE_SHA256" \
  --arg resultSha256 "$RESULT_SHA256" \
  --arg restoredSha256 "$RESTORED_SHA256" \
  --arg resultPath "${RESULT_PATH:A}" \
  --arg referencePath "${REFERENCE_PATH:A}" \
  --arg manifestPath "${MANIFEST_PATH:A}" \
  --arg samplesPath "${SAMPLES_PATH:A}" \
  --arg validationPath "${VALIDATION_REPORT_PATH:A}" \
  --arg originalSnapshotPath "${SNAPSHOT_PATH:A}" \
  --arg preparedPath "${PREPARED_PATH:A}" \
  --arg referenceReportPath "${REFERENCE_REPORT_PATH:A}" \
  --argjson retainSensitiveArtifacts "$RETAIN_SENSITIVE_ARTIFACTS" \
  --slurpfile fixture "$MANIFEST_PATH" \
  --slurpfile reference "$REFERENCE_REPORT_PATH" \
  --slurpfile validation "$VALIDATION_REPORT_PATH" \
  '{
    schemaVersion: 1,
    status: $status,
    runId: $runId,
    timing: {
      triggerToDurableCompletionSeconds: $wallSeconds,
      scope: "manual Merge All confirmation to the first sample observing 37 surviving fixture targets",
      includesManualDispatchAndSamplingDelay: true,
      sampleIntervalSeconds: $sampleIntervalSeconds
    },
    process: {
      maxRssKiB: $maxRssKiB,
      baselineRssKiB: $baselineRssKiB,
      rssDeltaKiB: $rssDeltaKiB,
      sampledMaxCpuPercent: $maxCpuPercent
    },
    sqliteIo: { sampledMaxWalBytes: $maxWalBytes },
    app: {
      executableSha256: $executableSha256,
      mainJsBundleSha256: $bundleSha256,
      launch: "Xcode Run Without Building on My Mac (Designed for iPhone) when --manual-launch is used",
      runningExecutablePath: $processExecutablePath,
      runningAppPath: $processAppPath,
      runningExecutableSha256: $processExecutableSha256,
      runningMainJsBundleSha256: $processBundleSha256,
      suppliedBundleBytesMatched: true
    },
    fixture: {
      kind: $fixture[0].fixtureKind,
      sourceStats: $fixture[0].source.selectedStats,
      prepared: $fixture[0].prepared,
      groups: $fixture[0].constants.groupCount,
      visitsPerGroup: $fixture[0].constants.visitsPerGroup,
      mergeCount: $fixture[0].constants.expectedMergeCount
    },
    structuralCalls: {
      legacyMergeExecution: $fixture[0].constants.expectedLegacyMergeExecutionCalls,
      legacyFullPath: $fixture[0].constants.expectedLegacyFullPathCalls,
      referenceObserved: $reference[0].executionCalls,
      candidateStatements: $fixture[0].constants.expectedCandidateStatementCalls,
      candidateTransactionControl: $fixture[0].constants.expectedCandidateTransactionControlCalls,
      candidateFullPath: $fixture[0].constants.expectedCandidateFullPathCalls,
      candidateClaimSource: "isolated tests/profile; app validation does not instrument the Expo SQLite connection"
    },
    validation: $validation[0],
    database: {
      originalSha256: $originalSha256,
      preparedSha256: $preparedSha256,
      independentReferenceSha256: $referenceSha256,
      resultSha256: $resultSha256,
      restoredSha256: $restoredSha256,
      restoredByteIdentical: ($originalSha256 == $restoredSha256),
      restoredQuickCheck: "ok",
      restoredForeignKeyViolationCount: 0
    },
    artifacts: {
      resultDatabase: $resultPath,
      independentReferenceDatabase: $referencePath,
      fixtureManifest: $manifestPath,
      samples: $samplesPath,
      detailedValidation: $validationPath,
      independentReferenceReport: $referenceReportPath,
      sensitive: {
        originalSnapshot: $originalSnapshotPath,
        preparedFixture: $preparedPath,
        independentReferenceDatabase: $referencePath,
        fixtureManifest: $manifestPath,
        resultDatabase: $resultPath,
        cleanupPolicy: (if $status == "ok" and $retainSensitiveArtifacts == 0
          then "snapshot, prepared fixture, reference database, and ID manifest removed after byte-identical restoration; result retained by request"
          else "all artifacts retained for diagnosis or explicit retention"
          end)
      }
    }
  }' > "$REPORT_TEMP_PATH"
mv -f -- "$REPORT_TEMP_PATH" "$REPORT_PATH"

if (( VALIDATION_EXIT_STATUS != 0 )) || [[ "$VALIDATION_STATUS" != "ok" ]]; then
  PRESERVE_FAILURE_ARTIFACTS=1
  print -u2 "Visit-merge semantic parity failed; artifacts retained under $OUTPUT_PREFIX"
  exit 1
fi

if (( ! RETAIN_SENSITIVE_ARTIFACTS )); then
  rm -f -- "$SNAPSHOT_PATH" "$PREPARED_PATH" "$REFERENCE_PATH" "$MANIFEST_PATH"
  remove_database_sidecars "$SNAPSHOT_PATH"
  remove_database_sidecars "$PREPARED_PATH"
  remove_database_sidecars "$REFERENCE_PATH"
fi

print "COMPLETE report=$REPORT_PATH wall_seconds=$WALL_SECONDS max_rss_kib=$MAX_RSS_KIB restored_sha256=$RESTORED_SHA256"

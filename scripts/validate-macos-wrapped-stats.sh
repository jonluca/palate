#!/bin/zsh
set -euo pipefail

SCRIPT_DIRECTORY="${0:A:h}"
HELPER_PATH="$SCRIPT_DIRECTORY/macos-wrapped-stats-fixture.mjs"

APP_PATH=""
DATABASE_PATH=""
OUTPUT_PREFIX=""
NODE_BINARY="${PALATE_NODE_BINARY:-}"
TIMEOUT_SECONDS="120"
SAMPLE_INTERVAL_SECONDS="0.05"
MANUAL_LAUNCH=0
RETAIN_SENSITIVE_ARTIFACTS=0

usage() {
  print "Usage: validate-macos-wrapped-stats.sh --app=PATH --database=PATH --output-prefix=PATH [options]"
  print ""
  print "  --node=PATH                  Node 24+ executable with node:sqlite"
  print "  --timeout-seconds=N          Visual-ready timeout after trigger (default: 120)"
  print "  --sample-interval=N          RSS/CPU sample interval in seconds (default: 0.05)"
  print "  --manual-launch              Wait for Xcode Run Without Building"
  print "  --retain-sensitive-artifacts Keep original/prepared copies and fixture IDs"
  print ""
  print "The runner stops Palate, checkpoints and snapshots the supplied database, prepares"
  print "a one-real-visit-per-year fixture only in a copy, writes an independent oracle,"
  print "and atomically installs that copy. It then verifies that the running process inherited"
  print "this run ID and that lsof resolves executable/main.jsbundle bytes identical to --app."
  print "Only then does it print READY. Write a fresh fractional epoch to OUTPUT_PREFIX.trigger"
  print "immediately before tapping Stats. After the all-time screen is stable, choose 2025,"
  print "wait for stable content, and write a fresh epoch to OUTPUT_PREFIX.visual-ready."
  print "The measured trigger-to-visual-ready interval includes manual UI work and is noisy."
  print "Do not approve macOS privacy, Accessibility, or Automation prompts during a run."
  print "For a real run, --manual-launch is required. After READY_TO_LAUNCH, quit/reopen"
  print "Xcode so it inherits the run marker. The checked-in scheme currently uses Debug for"
  print "Run; this tool does not edit it. In Xcode, set Run > Info > Build Configuration to"
  print "Release, then use Product > Perform Action > Run Without Building. Build the matching"
  print "product into Xcode's product directory first, for example:"
  print "  PALATE_XCODE_CONFIGURATION=Release PALATE_CODE_SIGNING_ALLOWED=YES \\"
  print "  PALATE_DERIVED_DATA_PATH=\"\$HOME/Library/Developer/Xcode/DerivedData\" \\"
  print "  scripts/build-macos-designed-app.sh"
  print "Pass the printed Palate.app path as --app. The runner safely"
  print "rejects Debug/stale bytes before it prints READY or accepts a trigger."
  print "EXIT/INT/TERM/HUP always stop Palate and restore the original database byte-for-byte."
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
  print -u2 "A built Palate.app with an executable Palate binary is required via --app"
  exit 2
fi
if [[ ! -s "$APP_PATH/main.jsbundle" ]]; then
  print -u2 "The app must contain a nonempty Release main.jsbundle"
  exit 2
fi
if [[ ! -f "$DATABASE_PATH" ]]; then
  print -u2 "The SQLite database is required via --database"
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
if (( ! MANUAL_LAUNCH )) && [[ "${PALATE_WRAPPED_STATS_ALLOW_DIRECT_OPEN_FOR_TESTS:-0}" != "1" ]]; then
  print -u2 "Real validation requires --manual-launch; direct open is reserved for the fake contract harness"
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
APP_PATH="${APP_PATH:A}"
DATABASE_PATH="${DATABASE_PATH:A}"
OUTPUT_PREFIX="${OUTPUT_PREFIX:A}"
RUN_ID="wrapped-stats-$$-$(date +%s)-$RANDOM"
SCHEME_PATH="$SCRIPT_DIRECTORY/../ios/Palate.xcodeproj/xcshareddata/xcschemes/Palate.xcscheme"
SCHEME_RUN_CONFIGURATION="unknown"
if [[ -f "$SCHEME_PATH" ]]; then
  SCHEME_RUN_CONFIGURATION="$(awk '
    /<LaunchAction/ { in_launch = 1 }
    in_launch && /buildConfiguration =/ {
      line = $0
      sub(/^.*buildConfiguration = "/, "", line)
      sub(/".*$/, "", line)
      print line
      exit
    }
  ' "$SCHEME_PATH")"
  [[ -n "$SCHEME_RUN_CONFIGURATION" ]] || SCHEME_RUN_CONFIGURATION="unknown"
fi
SNAPSHOT_PATH="$OUTPUT_PREFIX.$RUN_ID.original.db"
SNAPSHOT_TEMP_PATH="$SNAPSHOT_PATH.tmp"
PREPARED_PATH="$OUTPUT_PREFIX.$RUN_ID.prepared.db"
PREPARED_TEMP_PATH="$PREPARED_PATH.tmp"
MANIFEST_PATH="$OUTPUT_PREFIX.fixture.json"
ORACLE_PATH="$OUTPUT_PREFIX.oracle.json"
RESULT_PATH="$OUTPUT_PREFIX.result.db"
RESULT_TEMP_PATH="$RESULT_PATH.tmp-$RUN_ID"
VALIDATION_PATH="$OUTPUT_PREFIX.validation.json"
REPORT_PATH="$OUTPUT_PREFIX.json"
REPORT_TEMP_PATH="$REPORT_PATH.tmp-$RUN_ID"
SAMPLES_PATH="$OUTPUT_PREFIX.samples.tsv"
TRIGGER_PATH="$OUTPUT_PREFIX.trigger"
VISUAL_READY_PATH="$OUTPUT_PREFIX.visual-ready"
INSTALL_TEMP_PATH="$DATABASE_PATH.install-$RUN_ID.tmp"
RESTORE_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.tmp"
SNAPSHOT_READY=0
RESTORED=0
CLEANUP_FINISHED=0
PRESERVE_FAILURE_ARTIFACTS=0
ORIGINAL_SHA256=""
PREPARED_SHA256=""
APP_PID=""

ORIGINAL_RUN_ID="$(launchctl getenv PALATE_WRAPPED_STATS_VALIDATION_RUN_ID 2>/dev/null || true)"
ORIGINAL_RUN_ID_SET=$(( ${#ORIGINAL_RUN_ID} > 0 ))

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

remove_database_sidecars() {
  local database_path="$1"
  rm -f -- "$database_path-wal" "$database_path-shm" "$database_path-journal"
}

assert_wal_checkpoint() {
  local database_path="$1"
  local checkpoint_result busy log_frames checkpointed_frames wal_size
  checkpoint_result="$(sqlite3 "$database_path" "PRAGMA wal_checkpoint(TRUNCATE);")" || {
    print -u2 "WAL checkpoint failed for $database_path"
    return 1
  }
  IFS='|' read -r busy log_frames checkpointed_frames <<< "$checkpoint_result"
  if [[ ! "$busy" =~ ^[0-9]+$ || ! "$log_frames" =~ ^[0-9]+$ || ! "$checkpointed_frames" =~ ^[0-9]+$ ]] \
    || (( busy != 0 )); then
    print -u2 "WAL checkpoint was incomplete for $database_path: $checkpoint_result"
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
  local initial_pid initial_parent_pid initial_parent_command
  initial_pid="$(pgrep -x Palate | head -1 || true)"
  initial_parent_pid=""
  if [[ -n "$initial_pid" ]]; then
    initial_parent_pid="$(ps -o ppid= -p "$initial_pid" | tr -d ' ')"
    initial_parent_command="$(ps -o comm= -p "$initial_parent_pid" || true)"
    if [[ "$initial_parent_command" != */debugserver ]]; then
      initial_parent_pid=""
    fi
  fi
  pkill -TERM -x Palate 2>/dev/null || true
  if [[ -n "$initial_parent_pid" ]]; then
    kill -TERM "$initial_parent_pid" 2>/dev/null || true
  fi
  for _ in {1..10}; do
    pgrep -x Palate >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  local process_pid parent_pid parent_command
  process_pid="$(pgrep -x Palate | head -1 || true)"
  if [[ -n "$process_pid" ]]; then
    parent_pid="$(ps -o ppid= -p "$process_pid" | tr -d ' ')"
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

restore_launch_environment() {
  if (( ORIGINAL_RUN_ID_SET )); then
    launchctl setenv PALATE_WRAPPED_STATS_VALIDATION_RUN_ID "$ORIGINAL_RUN_ID"
  else
    launchctl unsetenv PALATE_WRAPPED_STATS_VALIDATION_RUN_ID
  fi
}

restore_database_and_environment() {
  local restore_failed=0 prepared_restore_sha restored_sha
  (( CLEANUP_FINISHED )) && return 0
  if ! stop_palate; then
    print -u2 "Cannot safely restore while Palate is running"
    restore_failed=1
  fi
  if (( SNAPSHOT_READY && ! RESTORED )); then
    if [[ ! -f "$SNAPSHOT_PATH" ]]; then
      print -u2 "Validated per-run snapshot is missing: $SNAPSHOT_PATH"
      restore_failed=1
    fi
    if (( ! restore_failed )); then
      rm -f -- "$RESTORE_TEMP_PATH"
      remove_database_sidecars "$RESTORE_TEMP_PATH"
      if ! cp -p "$SNAPSHOT_PATH" "$RESTORE_TEMP_PATH"; then
        print -u2 "Failed to prepare the restoration copy"
        restore_failed=1
      else
        prepared_restore_sha="$(sha256_file "$RESTORE_TEMP_PATH")"
        if [[ "$prepared_restore_sha" != "$ORIGINAL_SHA256" ]]; then
          print -u2 "Prepared restoration copy hash mismatch"
          restore_failed=1
        fi
      fi
    fi
    if (( ! restore_failed )); then
      remove_database_sidecars "$DATABASE_PATH"
      if ! mv -f -- "$RESTORE_TEMP_PATH" "$DATABASE_PATH"; then
        print -u2 "Failed to atomically restore the database"
        restore_failed=1
      else
        remove_database_sidecars "$DATABASE_PATH"
        restored_sha="$(sha256_file "$DATABASE_PATH")"
        if [[ "$restored_sha" != "$ORIGINAL_SHA256" ]]; then
          print -u2 "Restored database hash mismatch"
          restore_failed=1
        else
          RESTORED=1
        fi
      fi
    fi
  fi
  if ! restore_launch_environment; then
    print -u2 "Failed to restore PALATE_WRAPPED_STATS_VALIDATION_RUN_ID"
    restore_failed=1
  fi
  rm -f -- \
    "$SNAPSHOT_TEMP_PATH" "$PREPARED_TEMP_PATH" "$RESULT_TEMP_PATH" \
    "$REPORT_TEMP_PATH" "$INSTALL_TEMP_PATH" "$RESTORE_TEMP_PATH"
  remove_database_sidecars "$SNAPSHOT_PATH"
  remove_database_sidecars "$PREPARED_PATH"
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

handle_error() {
  local exit_code="$?"
  trap - ZERR
  handle_exit "$exit_code"
}

handle_exit() {
  local exit_code="$?"
  if (( $# > 0 )); then
    exit_code="$1"
  fi
  local restoration_succeeded=0
  trap - EXIT
  trap - ZERR
  if restore_database_and_environment; then
    restoration_succeeded=1
  else
    print -u2 "One or more restoration steps failed"
    (( exit_code == 0 )) && exit_code=1
  fi
  if (( exit_code != 0 && restoration_succeeded && RESTORED \
    && ! RETAIN_SENSITIVE_ARTIFACTS && ! PRESERVE_FAILURE_ARTIFACTS )); then
    rm -f -- "$SNAPSHOT_PATH" "$PREPARED_PATH" "$MANIFEST_PATH" "$ORACLE_PATH" "$RESULT_PATH"
    remove_database_sidecars "$SNAPSHOT_PATH"
    remove_database_sidecars "$PREPARED_PATH"
    remove_database_sidecars "$RESULT_PATH"
    print -u2 "Removed sensitive fixture intermediates after byte-identical restoration"
  fi
  exit "$exit_code"
}

trap handle_exit EXIT
trap handle_error ZERR
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

attest_process_bundle() {
  local process_executable process_app process_executable_sha process_bundle_sha process_codesign_output
  process_executable="$(lsof -a -p "$APP_PID" -d txt -Fn 2>/dev/null \
    | sed -n 's/^n//p' \
    | awk '/\/Palate[.]app\/Palate$/ { print; exit }')"
  if [[ -z "$process_executable" || ! -f "$process_executable" ]]; then
    print -u2 "lsof could not resolve the running Palate.app executable"
    return 1
  fi
  process_app="${process_executable:h}"
  if [[ ! -s "$process_app/main.jsbundle" ]]; then
    print -u2 "Running process bundle has no nonempty main.jsbundle: $process_app"
    return 1
  fi
  process_codesign_output="$(codesign --verify --deep --strict --verbose=2 "$process_app" 2>&1)" || {
    print -u2 "$process_codesign_output"
    print -u2 "Running process bundle failed strict code-signature verification"
    return 1
  }
  process_executable_sha="$(sha256_file "$process_executable")"
  process_bundle_sha="$(sha256_file "$process_app/main.jsbundle")"
  if [[ "$process_executable_sha" != "$APP_EXECUTABLE_SHA256" \
    || "$process_bundle_sha" != "$APP_BUNDLE_SHA256" ]]; then
    print -u2 "Running process bundle mismatch before trigger: supplied=$APP_PATH actual=$process_app"
    print -u2 "Executable supplied=$APP_EXECUTABLE_SHA256 actual=$process_executable_sha"
    print -u2 "main.jsbundle supplied=$APP_BUNDLE_SHA256 actual=$process_bundle_sha"
    return 1
  fi
  PROCESS_EXECUTABLE_PATH="$process_executable"
  PROCESS_APP_PATH="$process_app"
  PROCESS_EXECUTABLE_SHA256="$process_executable_sha"
  PROCESS_BUNDLE_SHA256="$process_bundle_sha"
}

validate_timestamp() {
  local label="$1" value="$2" minimum="$3" observed="$4"
  if [[ ! "$value" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    print -u2 "$label file must contain an epoch timestamp"
    return 1
  fi
  if ! awk -v value="$value" -v minimum="$minimum" -v observed="$observed" \
    'BEGIN { exit !(value >= minimum && value <= observed && observed - value <= 30) }'; then
    print -u2 "$label timestamp must follow its lower bound, be nonfuture, and be no more than 30 seconds old"
    return 1
  fi
}

# Verify supplied bundle before the first database mutation.
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
APP_EXECUTABLE_SHA256="$(sha256_file "$APP_PATH/Palate")"
APP_BUNDLE_SHA256="$(sha256_file "$APP_PATH/main.jsbundle")"

stop_palate
assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
ORIGINAL_QUICK_CHECK="$(sqlite3 "$DATABASE_PATH" "PRAGMA quick_check;")"
ORIGINAL_INTEGRITY_CHECK="$(sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;")"
ORIGINAL_FOREIGN_KEYS="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
if [[ "$ORIGINAL_QUICK_CHECK" != "ok" || "$ORIGINAL_INTEGRITY_CHECK" != "ok" ]] \
  || (( ORIGINAL_FOREIGN_KEYS != 0 )); then
  print -u2 "Original database failed preflight validation"
  exit 1
fi
assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"

rm -f -- "$SNAPSHOT_PATH" "$SNAPSHOT_TEMP_PATH"
cp -p "$DATABASE_PATH" "$SNAPSHOT_TEMP_PATH"
LIVE_SHA256="$(sha256_file "$DATABASE_PATH")"
if [[ "$(sha256_file "$SNAPSHOT_TEMP_PATH")" != "$LIVE_SHA256" ]]; then
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
  "$PREPARED_PATH" "$PREPARED_TEMP_PATH" "$MANIFEST_PATH" "$ORACLE_PATH" \
  "$RESULT_PATH" "$RESULT_TEMP_PATH" "$VALIDATION_PATH" "$REPORT_PATH" \
  "$REPORT_TEMP_PATH" "$SAMPLES_PATH" "$TRIGGER_PATH" "$VISUAL_READY_PATH"
remove_database_sidecars "$PREPARED_PATH"
remove_database_sidecars "$RESULT_PATH"
cp -p "$SNAPSHOT_PATH" "$PREPARED_TEMP_PATH"
if [[ "$(sha256_file "$PREPARED_TEMP_PATH")" != "$ORIGINAL_SHA256" ]]; then
  print -u2 "Prepared source copy hash mismatch"
  exit 1
fi
mv -f -- "$PREPARED_TEMP_PATH" "$PREPARED_PATH"
NODE_NO_WARNINGS=1 "$NODE_BINARY" "$HELPER_PATH" prepare \
  --database="$PREPARED_PATH" --manifest="$MANIFEST_PATH"
remove_database_sidecars "$PREPARED_PATH"
PREPARED_SHA256="$(sha256_file "$PREPARED_PATH")"
if [[ "$(jq -r '.databaseSha256' "$MANIFEST_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Prepared fixture manifest hash mismatch"
  exit 1
fi
if ! jq -e \
  '.constants.firstYear == 2012
   and .constants.lastYear == 2026
   and .constants.yearCount == 15
   and .constants.legacyAllTimeSqlCalls == 39
   and .constants.candidateAllTimeSqlCalls == 20
   and .constants.selectedYearSqlCalls == 19
   and .prepared.confirmedVisits == 15
   and .prepared.uniqueRestaurants == 1
   and (.selectedVisitIds | length) == 15' \
  "$MANIFEST_PATH" >/dev/null; then
  print -u2 "Prepared fixture does not have the required 15-year shape"
  exit 1
fi
NODE_NO_WARNINGS=1 "$NODE_BINARY" "$HELPER_PATH" oracle \
  --database="$PREPARED_PATH" --report="$ORACLE_PATH"
if ! jq -e \
  '.status == "ok"
   and .availableYears == [2026,2025,2024,2023,2022,2021,2020,2019,2018,2017,2016,2015,2014,2013,2012]
   and .allTime.confirmedVisits == 15
   and .allTime.uniqueRestaurants == 1
   and .allTime.threeStarVisits == 15
   and .allTime.accumulatedStars == 45
   and .allTime.michelinStats.threeStars == 15
   and .allTime.michelinStats.distinctThreeStars == 1
   and .allTime.michelinStats.totalStarredVisits == 15
   and .allTime.michelinStats.distinctStarredRestaurants == 1
   and .allTime.michelinStats.totalAccumulatedStars == 45
   and .allTime.michelinStats.distinctStars == 3
   and .allTime.michelinStats.greenStarVisits == 0
   and (.allTime.mapPoints | length) == 1
   and .selected2025.confirmedVisits == 1
   and .selected2025.michelinStats.threeStars == 1
   and .selected2025.michelinStats.distinctThreeStars == 1
   and .selected2025.michelinStats.totalAccumulatedStars == 3
   and .structuralCalls.candidateAllTimeSqlCalls == 20
   and .structuralCalls.selectedYearSqlCalls == 19' \
  "$ORACLE_PATH" >/dev/null; then
  print -u2 "Independent Wrapped Stats oracle failed its required invariants"
  exit 1
fi

# Install only after the snapshot, fixture manifest, and independent oracle are durable.
rm -f -- "$INSTALL_TEMP_PATH"
cp -p "$PREPARED_PATH" "$INSTALL_TEMP_PATH"
if [[ "$(sha256_file "$INSTALL_TEMP_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Prepared installation copy hash mismatch"
  exit 1
fi
remove_database_sidecars "$DATABASE_PATH"
mv -f -- "$INSTALL_TEMP_PATH" "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
if [[ "$(sha256_file "$DATABASE_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Installed fixture hash mismatch"
  exit 1
fi

print "elapsed_s\trss_kib\tcpu_percent\twal_bytes" > "$SAMPLES_PATH"
launchctl setenv PALATE_WRAPPED_STATS_VALIDATION_RUN_ID "$RUN_ID"
if (( MANUAL_LAUNCH )); then
  print "MANUAL_RELEASE_REQUIRED shared_scheme_run_configuration=$SCHEME_RUN_CONFIGURATION expected_app=$APP_PATH"
  print "READY_TO_LAUNCH run_id=$RUN_ID"
else
  open "$APP_PATH"
fi

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
EXPECTED_ENVIRONMENT="PALATE_WRAPPED_STATS_VALIDATION_RUN_ID=$RUN_ID"
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_ENVIRONMENT "* ]]; then
  print -u2 "Running Palate did not inherit this Wrapped Stats validation run ID"
  exit 1
fi
attest_process_bundle
PROCESS_OBSERVED_EPOCH="$(date +%s.%N)"
if [[ "$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE status = 'confirmed';")" != "15" ]]; then
  print -u2 "Running app changed the fixture before trigger"
  exit 1
fi
print "READY run_id=$RUN_ID pid=$APP_PID trigger=$TRIGGER_PATH visual_ready=$VISUAL_READY_PATH"

TRIGGER_WAIT_STARTED="$(date +%s)"
while [[ ! -s "$TRIGGER_PATH" ]]; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before the Stats trigger was recorded"
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
validate_timestamp "Trigger" "$TRIGGER_EPOCH" "$PROCESS_OBSERVED_EPOCH" "$TRIGGER_OBSERVED_EPOCH"

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while [[ ! -s "$VISUAL_READY_PATH" ]]; do
  OBSERVED_EPOCH="$(date +%s.%N)"
  ELAPSED_SECONDS="$(awk -v now="$OBSERVED_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", now - start }')"
  RSS_KIB="$(ps -o rss= -p "$APP_PID" | tr -d ' ' || true)"
  CPU_PERCENT="$(ps -o %cpu= -p "$APP_PID" | tr -d ' ' || true)"
  [[ -n "$RSS_KIB" ]] || RSS_KIB=0
  [[ -n "$CPU_PERCENT" ]] || CPU_PERCENT=0
  if [[ -e "$DATABASE_PATH-wal" ]]; then
    WAL_BYTES="$(stat -f '%z' "$DATABASE_PATH-wal" 2>/dev/null || print 0)"
  else
    WAL_BYTES=0
  fi
  print "$ELAPSED_SECONDS\t$RSS_KIB\t$CPU_PERCENT\t$WAL_BYTES" >> "$SAMPLES_PATH"
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before visual-ready was recorded"
    exit 1
  fi
  if (( $(date +%s) >= DEADLINE )); then
    print -u2 "Timed out waiting for $VISUAL_READY_PATH"
    exit 1
  fi
  sleep "$SAMPLE_INTERVAL_SECONDS"
done
VISUAL_READY_EPOCH="$(< "$VISUAL_READY_PATH")"
VISUAL_OBSERVED_EPOCH="$(date +%s.%N)"
validate_timestamp "Visual-ready" "$VISUAL_READY_EPOCH" "$TRIGGER_EPOCH" "$VISUAL_OBSERVED_EPOCH"
WALL_SECONDS="$(awk -v finish="$VISUAL_READY_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", finish - start }')"

# Re-attest the exact process bundle after the measured interaction.
attest_process_bundle
MAX_RSS_KIB="$(awk 'NR > 1 && $2 > maximum { maximum = $2 } END { print maximum + 0 }' "$SAMPLES_PATH")"
BASELINE_RSS_KIB="$(awk 'NR == 2 { print $2 + 0 }' "$SAMPLES_PATH")"
[[ -n "$BASELINE_RSS_KIB" ]] || BASELINE_RSS_KIB=0
MAX_CPU_PERCENT="$(awk 'NR > 1 && $3 > maximum { maximum = $3 } END { print maximum + 0 }' "$SAMPLES_PATH")"
MAX_WAL_BYTES="$(awk 'NR > 1 && $4 > maximum { maximum = $4 } END { print maximum + 0 }' "$SAMPLES_PATH")"
RSS_DELTA_KIB=$(( MAX_RSS_KIB - BASELINE_RSS_KIB ))

stop_palate
assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
cp -p "$DATABASE_PATH" "$RESULT_TEMP_PATH"
RESULT_SHA256="$(sha256_file "$DATABASE_PATH")"
if [[ "$(sha256_file "$RESULT_TEMP_PATH")" != "$RESULT_SHA256" ]]; then
  print -u2 "Result database copy hash mismatch"
  exit 1
fi
mv -f -- "$RESULT_TEMP_PATH" "$RESULT_PATH"
remove_database_sidecars "$RESULT_PATH"

if NODE_NO_WARNINGS=1 "$NODE_BINARY" "$HELPER_PATH" validate \
  --candidate="$RESULT_PATH" --prepared="$PREPARED_PATH" \
  --manifest="$MANIFEST_PATH" --report="$VALIDATION_PATH"; then
  VALIDATION_EXIT_STATUS=0
else
  VALIDATION_EXIT_STATUS="$?"
fi
VALIDATION_STATUS="$(jq -r '.status' "$VALIDATION_PATH" 2>/dev/null || print failed)"
if (( MAX_WAL_BYTES != 0 )); then
  print -u2 "Wrapped Stats session wrote to the database WAL: $MAX_WAL_BYTES bytes"
  VALIDATION_STATUS="failed"
  VALIDATION_EXIT_STATUS=1
fi
if [[ "$(sha256_file "$PREPARED_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Prepared fixture changed during validation"
  exit 1
fi
if [[ "$(jq -r '.files.preparedSha256 // empty' "$VALIDATION_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Semantic validation did not attest the prepared database hash"
  exit 1
fi

if ! restore_database_and_environment; then
  print -u2 "Database or launch-environment restoration failed"
  exit 1
fi
RESTORED_SHA256="$(sha256_file "$DATABASE_PATH")"
RESTORED_QUICK_CHECK="$(sqlite3 "$DATABASE_PATH" "PRAGMA quick_check;")"
RESTORED_INTEGRITY_CHECK="$(sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;")"
RESTORED_FOREIGN_KEYS="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
if [[ "$RESTORED_SHA256" != "$ORIGINAL_SHA256" || "$RESTORED_QUICK_CHECK" != "ok" \
  || "$RESTORED_INTEGRITY_CHECK" != "ok" ]] || (( RESTORED_FOREIGN_KEYS != 0 )); then
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
  --arg suppliedAppPath "$APP_PATH" \
  --arg processAppPath "$PROCESS_APP_PATH" \
  --arg executableSha256 "$APP_EXECUTABLE_SHA256" \
  --arg bundleSha256 "$APP_BUNDLE_SHA256" \
  --arg sharedSchemeRunConfiguration "$SCHEME_RUN_CONFIGURATION" \
  --arg originalSha256 "$ORIGINAL_SHA256" \
  --arg preparedSha256 "$PREPARED_SHA256" \
  --arg resultSha256 "$RESULT_SHA256" \
  --arg restoredSha256 "$RESTORED_SHA256" \
  --arg resultPath "$RESULT_PATH" \
  --arg samplesPath "$SAMPLES_PATH" \
  --arg validationPath "$VALIDATION_PATH" \
  --arg originalSnapshotPath "$SNAPSHOT_PATH" \
  --arg preparedPath "$PREPARED_PATH" \
  --arg manifestPath "$MANIFEST_PATH" \
  --arg oraclePath "$ORACLE_PATH" \
  --argjson retainSensitiveArtifacts "$RETAIN_SENSITIVE_ARTIFACTS" \
  --slurpfile fixture "$MANIFEST_PATH" \
  --slurpfile oracle "$ORACLE_PATH" \
  --slurpfile validation "$VALIDATION_PATH" \
  '{
    schemaVersion: 1,
    status: $status,
    runId: $runId,
    timing: {
      triggerToVisualReadySeconds: $wallSeconds,
      scope: "manual Stats tap through stable all-time content and stable 2025 selection",
      includesManualUiWork: true,
      isolatedSqlBenchmark: false,
      sampleIntervalSeconds: $sampleIntervalSeconds
    },
    process: {
      maxRssKiB: $maxRssKiB,
      baselineRssKiB: $baselineRssKiB,
      rssDeltaKiB: $rssDeltaKiB,
      sampledMaxCpuPercent: $maxCpuPercent,
      sampledMaxWalBytes: $maxWalBytes
    },
    app: {
      suppliedAppPath: $suppliedAppPath,
      attestedProcessAppPath: $processAppPath,
      executableSha256: $executableSha256,
      mainJsBundleSha256: $bundleSha256,
      sharedSchemeRunConfigurationObservedBeforeLaunch: $sharedSchemeRunConfiguration,
      processBundleMatchesSuppliedBundle: true
    },
    fixture: {
      schemaVersion: $fixture[0].schemaVersion,
      fixtureKind: $fixture[0].fixtureKind,
      constants: {
        firstYear: $fixture[0].constants.firstYear,
        lastYear: $fixture[0].constants.lastYear,
        yearCount: $fixture[0].constants.yearCount,
        legacyAllTimeSqlCalls: $fixture[0].constants.legacyAllTimeSqlCalls,
        candidateAllTimeSqlCalls: $fixture[0].constants.candidateAllTimeSqlCalls,
        selectedYearSqlCalls: $fixture[0].constants.selectedYearSqlCalls
      },
      prepared: $fixture[0].prepared,
      integrity: $fixture[0].integrity
    },
    oracle: {
      schemaVersion: $oracle[0].schemaVersion,
      status: $oracle[0].status,
      allTime: ($oracle[0].allTime | {
        confirmedVisits,
        uniqueRestaurants,
        totalPhotos,
        averagePhotos,
        calendarLinkedVisits,
        foodProbableVisits,
        threeStarVisits,
        accumulatedStars,
        michelinStats,
        mapPointCount: (.mapPoints | length)
      }),
      selected2025: ($oracle[0].selected2025 | {
        year,
        confirmedVisits,
        uniqueRestaurants,
        totalPhotos,
        averagePhotos,
        calendarLinkedVisits,
        foodProbableVisits,
        threeStarVisits,
        accumulatedStars,
        michelinStats,
        mapPointCount: (.mapPoints | length)
      }),
      structuralCalls: $oracle[0].structuralCalls,
      integrity: $oracle[0].integrity
    },
    validation: $validation[0],
    database: {
      originalSha256: $originalSha256,
      preparedSha256: $preparedSha256,
      resultSha256: $resultSha256,
      restoredSha256: $restoredSha256,
      restoredByteIdentical: ($originalSha256 == $restoredSha256),
      restoredQuickCheck: "ok",
      restoredIntegrityCheck: "ok",
      restoredForeignKeyViolationCount: 0
    },
    artifacts: {
      samples: $samplesPath,
      detailedValidation: $validationPath,
      sensitive: {
        originalSnapshot: $originalSnapshotPath,
        preparedFixture: $preparedPath,
        fixtureManifest: $manifestPath,
        oracle: $oraclePath,
        resultDatabase: $resultPath,
        cleanupPolicy: (if $status == "ok" and $retainSensitiveArtifacts == 0
          then "original snapshot, prepared fixture, ID manifest, raw oracle, and result database removed after byte-identical restoration; the retained report contains aggregate-only fixture/oracle data"
          else "sensitive intermediates retained for diagnosis or explicit retention"
          end)
      }
    }
  }' > "$REPORT_TEMP_PATH"
mv -f -- "$REPORT_TEMP_PATH" "$REPORT_PATH"

if (( VALIDATION_EXIT_STATUS != 0 )) || [[ "$VALIDATION_STATUS" != "ok" ]]; then
  PRESERVE_FAILURE_ARTIFACTS=1
  print -u2 "Wrapped Stats read-only parity failed; diagnostic fixture artifacts retained"
  exit 1
fi

if (( ! RETAIN_SENSITIVE_ARTIFACTS )); then
  rm -f -- "$SNAPSHOT_PATH" "$PREPARED_PATH" "$MANIFEST_PATH" "$ORACLE_PATH" "$RESULT_PATH"
  remove_database_sidecars "$SNAPSHOT_PATH"
  remove_database_sidecars "$PREPARED_PATH"
  remove_database_sidecars "$RESULT_PATH"
fi

print "COMPLETE report=$REPORT_PATH wall_seconds=$WALL_SECONDS max_rss_kib=$MAX_RSS_KIB restored_sha256=$RESTORED_SHA256"

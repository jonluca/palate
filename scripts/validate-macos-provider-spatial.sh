#!/bin/zsh
set -euo pipefail

SCRIPT_DIRECTORY="${0:A:h}"

APP_PATH=""
DATABASE_PATH=""
OUTPUT_PREFIX=""
MIGRATION_TIMEOUT_SECONDS=180
UI_TIMEOUT_SECONDS=300
MANUAL_LAUNCH=0
SKIP_UI_PAUSE=0

usage() {
  print "Usage: validate-macos-provider-spatial.sh --app=PATH --database=PATH --output-prefix=PATH [options]"
  print ""
  print "  --migration-timeout-seconds=N  R-Tree migration timeout (default: 180)"
  print "  --ui-timeout-seconds=N         Read-only UI inspection timeout (default: 300)"
  print "  --manual-launch                Wait for Xcode Run Without Building"
  print "  --skip-ui-pause                Validate startup migration without a UI pause"
  print ""
  print "This runner never opens the source database before snapshotting it. It stops Palate,"
  print "copies the main database and every existing WAL/SHM/journal sidecar byte-for-byte,"
  print "prepares a disposable copy with the provider R-Tree removed, and installs only that"
  print "copy. The signed running app must inherit this run ID and match the supplied executable"
  print "and main.jsbundle before validation continues. The runner verifies R-Tree schema,"
  print "triggers, integrity, coverage, query-plan readiness, and byte-stable non-spatial tables."
  print ""
  print "After UI_READY, inspect Calendar Imports read-only and write a fresh fractional epoch"
  print "to the printed marker. Do not tap import, dismiss, rescan, merge, or Photos scan controls."
  print "For --manual-launch, quit and reopen Xcode after READY_TO_LAUNCH so it inherits the"
  print "run marker, then Run Without Building the exact matching Release product."
  print "EXIT/INT/TERM/HUP stop Palate and restore the exact original main DB and sidecar set."
}

for argument in "$@"; do
  case "$argument" in
    --app=*) APP_PATH="${argument#*=}" ;;
    --database=*) DATABASE_PATH="${argument#*=}" ;;
    --output-prefix=*) OUTPUT_PREFIX="${argument#*=}" ;;
    --migration-timeout-seconds=*) MIGRATION_TIMEOUT_SECONDS="${argument#*=}" ;;
    --ui-timeout-seconds=*) UI_TIMEOUT_SECONDS="${argument#*=}" ;;
    --manual-launch) MANUAL_LAUNCH=1 ;;
    --skip-ui-pause) SKIP_UI_PAUSE=1 ;;
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
  print -u2 "The Palate SQLite database is required via --database"
  exit 2
fi
if [[ -z "$OUTPUT_PREFIX" ]]; then
  print -u2 "--output-prefix is required"
  exit 2
fi
for timeout_value in "$MIGRATION_TIMEOUT_SECONDS" "$UI_TIMEOUT_SECONDS"; do
  if [[ ! "$timeout_value" =~ ^[0-9]+$ ]] || (( timeout_value < 1 )); then
    print -u2 "Timeouts must be positive integers"
    exit 2
  fi
done
if (( ! MANUAL_LAUNCH )) && [[ "${PALATE_PROVIDER_SPATIAL_ALLOW_DIRECT_OPEN_FOR_TESTS:-0}" != "1" ]]; then
  print -u2 "Real validation requires --manual-launch; direct open is reserved for isolated harness tests"
  exit 2
fi

for dependency in awk codesign dwarfdump jq lsof open pgrep pkill plutil ps shasum sort sqlite3 stat; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    print -u2 "Missing dependency: $dependency"
    exit 2
  fi
done

mkdir -p "${OUTPUT_PREFIX:h}"
APP_PATH="${APP_PATH:A}"
DATABASE_PATH="${DATABASE_PATH:A}"
OUTPUT_PREFIX="${OUTPUT_PREFIX:A}"

RUN_ID="provider-spatial-$$-$(date +%s)-$RANDOM"
RUN_ENVIRONMENT_KEY="PALATE_PROVIDER_SPATIAL_VALIDATION_RUN_ID"
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
SNAPSHOT_WAL_PATH="$SNAPSHOT_PATH-wal"
SNAPSHOT_SHM_PATH="$SNAPSHOT_PATH-shm"
SNAPSHOT_JOURNAL_PATH="$SNAPSHOT_PATH-journal"
PREPARED_PATH="$OUTPUT_PREFIX.$RUN_ID.prepared.db"
INSTALL_TEMP_PATH="$DATABASE_PATH.install-$RUN_ID.tmp"
RESTORE_MAIN_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.main.tmp"
RESTORE_WAL_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.wal.tmp"
RESTORE_SHM_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.shm.tmp"
RESTORE_JOURNAL_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.journal.tmp"
REPORT_PATH="$OUTPUT_PREFIX.json"
REPORT_TEMP_PATH="$REPORT_PATH.tmp-$RUN_ID"
UI_READY_PATH="$OUTPUT_PREFIX.ui-ready"
CRASH_REPORT_DIRECTORY="$HOME/Library/Logs/DiagnosticReports"

SNAPSHOT_READY=0
RESTORED=0
CLEANUP_FINISHED=0
APP_PID=""
APP_BUNDLE_ID=""
APP_EXECUTABLE_UUIDS=""
BASELINE_CRASH_REPORT_COUNT=0
MATCHING_NEW_CRASH_REPORT_COUNT=0
CRASH_GUARD_START_EPOCH=0
CRASH_GUARD_END_EPOCH=0
ORIGINAL_SHA256=""
ORIGINAL_WAL_SHA256=""
ORIGINAL_SHM_SHA256=""
ORIGINAL_JOURNAL_SHA256=""
ORIGINAL_WAL_PRESENT=0
ORIGINAL_SHM_PRESENT=0
ORIGINAL_JOURNAL_PRESENT=0

typeset -A BASELINE_CRASH_INCIDENTS

ORIGINAL_RUN_ID="$(launchctl getenv "$RUN_ENVIRONMENT_KEY" 2>/dev/null || true)"
ORIGINAL_RUN_ID_SET=$(( ${#ORIGINAL_RUN_ID} > 0 ))

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

mach_o_uuids() {
  dwarfdump --uuid "$1" 2>/dev/null | awk '/^UUID:/ { print tolower($2) }' | sort -u
}

crash_report_summary() {
  jq -rs '
    if length >= 2 and (.[0] | type) == "object" and (.[1] | type) == "object" then
      [
        (.[0].incident_id // ""),
        (.[0].bundleID // ""),
        (.[0].slice_uuid // ""),
        (.[1].procName // ""),
        (.[1].procLaunch // ""),
        (.[1].captureTime // .[0].timestamp // "")
      ] | @tsv
    else
      empty
    end
  ' "$1" 2>/dev/null
}

ips_timestamp_epoch() {
  local timestamp="$1" local_time whole_seconds timezone parsed
  [[ "$timestamp" == *" "* ]] || return 1
  timezone="${timestamp##* }"
  local_time="${timestamp% *}"
  whole_seconds="${local_time%%.*}"
  parsed="$(date -j -f '%Y-%m-%d %H:%M:%S %z' "$whole_seconds $timezone" '+%s' 2>/dev/null)" || return 1
  [[ "$parsed" =~ '^[0-9]+$' ]] || return 1
  print -r -- "$parsed"
}

crash_uuid_matches_app() {
  local expected_uuid crash_uuid="${1:l}"
  for expected_uuid in ${(f)APP_EXECUTABLE_UUIDS}; do
    [[ "$expected_uuid" == "$crash_uuid" ]] && return 0
  done
  return 1
}

capture_crash_report_baseline() {
  local crash_path summary incident_id capture_timestamp incident_key
  local -a crash_paths
  local baseline_count=0
  crash_paths=(
    "$CRASH_REPORT_DIRECTORY"/Palate*.ips(N)
    "$CRASH_REPORT_DIRECTORY"/Retired/Palate*.ips(N)
  )
  BASELINE_CRASH_INCIDENTS=()
  for crash_path in "${crash_paths[@]}"; do
    summary="$(crash_report_summary "$crash_path" || true)"
    [[ -n "$summary" ]] || continue
    IFS=$'\t' read -r incident_id _ _ _ _ capture_timestamp <<< "$summary"
    [[ -n "$incident_id" ]] || continue
    incident_key="${incident_id:l}"
    if [[ -z "${BASELINE_CRASH_INCIDENTS[$incident_key]-}" ]]; then
      (( baseline_count += 1 ))
    fi
    BASELINE_CRASH_INCIDENTS[$incident_key]="$capture_timestamp"
  done
  BASELINE_CRASH_REPORT_COUNT="$baseline_count"
  CRASH_GUARD_START_EPOCH="$(date +%s)"
}

matching_new_crash_report_count() {
  local process_observed_epoch="$1" run_end_epoch="$2"
  local crash_path summary incident_id bundle_id slice_uuid process_name process_launch capture_time
  local incident_key launch_epoch capture_epoch
  local -a crash_paths
  local matching_count=0
  crash_paths=(
    "$CRASH_REPORT_DIRECTORY"/Palate*.ips(N)
    "$CRASH_REPORT_DIRECTORY"/Retired/Palate*.ips(N)
  )
  for crash_path in "${crash_paths[@]}"; do
    summary="$(crash_report_summary "$crash_path" || true)"
    [[ -n "$summary" ]] || continue
    IFS=$'\t' read -r incident_id bundle_id slice_uuid process_name process_launch capture_time <<< "$summary"
    [[ -n "$incident_id" && -n "$slice_uuid" ]] || continue
    incident_key="${incident_id:l}"
    [[ -z "${BASELINE_CRASH_INCIDENTS[$incident_key]-}" ]] || continue
    [[ "$bundle_id" == "$APP_BUNDLE_ID" && "$process_name" == "Palate" ]] || continue
    crash_uuid_matches_app "$slice_uuid" || continue
    launch_epoch="$(ips_timestamp_epoch "$process_launch" || true)"
    capture_epoch="$(ips_timestamp_epoch "$capture_time" || true)"
    [[ -n "$launch_epoch" && -n "$capture_epoch" ]] || continue
    if (( launch_epoch + 5 >= CRASH_GUARD_START_EPOCH
      && launch_epoch <= process_observed_epoch + 5
      && capture_epoch + 1 >= launch_epoch
      && capture_epoch <= run_end_epoch + 15 )); then
      (( matching_count += 1 ))
    fi
  done
  print -r -- "$matching_count"
}

assert_no_new_matching_crash_report() {
  local process_observed_epoch="${PROCESS_OBSERVED_EPOCH%%.*}"
  local wait_for_reporter="${1:-0}" deadline now
  if (( wait_for_reporter )); then
    deadline=$(( $(date +%s) + 10 ))
  else
    deadline="$(date +%s)"
  fi
  while true; do
    CRASH_GUARD_END_EPOCH="$(date +%s)"
    MATCHING_NEW_CRASH_REPORT_COUNT="$(matching_new_crash_report_count \
      "$process_observed_epoch" "$CRASH_GUARD_END_EPOCH")"
    if (( MATCHING_NEW_CRASH_REPORT_COUNT != 0 )); then
      print -u2 "Detected $MATCHING_NEW_CRASH_REPORT_COUNT new Palate crash report(s) matching this signed run"
      return 1
    fi
    now="$(date +%s)"
    (( now >= deadline )) && return 0
    sleep 1
  done
}

sqlite_scalar() {
  local database_path="$1" sql="$2"
  sqlite3 -batch -noheader -cmd ".timeout 5000" "$database_path" "$sql"
}

remove_database_sidecars() {
  local database_path="$1"
  rm -f -- "$database_path-wal" "$database_path-shm" "$database_path-journal"
}

remove_database_set() {
  local database_path="$1"
  rm -f -- "$database_path"
  remove_database_sidecars "$database_path"
}

copy_and_attest() {
  local source_path="$1"
  local destination_path="$2"
  local temporary_path="$destination_path.tmp-$RUN_ID"
  rm -f -- "$temporary_path"
  cp -p "$source_path" "$temporary_path"
  local source_hash destination_hash
  source_hash="$(sha256_file "$source_path")"
  destination_hash="$(sha256_file "$temporary_path")"
  if [[ "$source_hash" != "$destination_hash" ]]; then
    rm -f -- "$temporary_path"
    print -u2 "Copy hash mismatch: $source_path"
    return 1
  fi
  mv -f -- "$temporary_path" "$destination_path"
  print -r -- "$source_hash"
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
  for _ in {1..20}; do
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
  for _ in {1..20}; do
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

assert_source_database_unopened() {
  local holder_output
  local -a source_paths
  source_paths=("$DATABASE_PATH")
  [[ -e "$DATABASE_PATH-wal" ]] && source_paths+=("$DATABASE_PATH-wal")
  [[ -e "$DATABASE_PATH-shm" ]] && source_paths+=("$DATABASE_PATH-shm")
  [[ -e "$DATABASE_PATH-journal" ]] && source_paths+=("$DATABASE_PATH-journal")
  holder_output="$(lsof -Fn -- "${source_paths[@]}" 2>/dev/null || true)"
  if [[ -n "$holder_output" ]]; then
    print -u2 "Another process still has the source database or a sidecar open"
    return 1
  fi
}

restore_launch_environment() {
  if (( ORIGINAL_RUN_ID_SET )); then
    launchctl setenv "$RUN_ENVIRONMENT_KEY" "$ORIGINAL_RUN_ID"
  else
    launchctl unsetenv "$RUN_ENVIRONMENT_KEY"
  fi
}

verify_optional_original() {
  local source_path="$1" expected_present="$2" expected_hash="$3" label="$4"
  if (( expected_present )); then
    if [[ ! -f "$source_path" || "$(sha256_file "$source_path")" != "$expected_hash" ]]; then
      print -u2 "$label no longer matches its original snapshot"
      return 1
    fi
  elif [[ -e "$source_path" ]]; then
    print -u2 "$label appeared after the original snapshot"
    return 1
  fi
}

verify_original_source_set() {
  if [[ ! -f "$DATABASE_PATH" || "$(sha256_file "$DATABASE_PATH")" != "$ORIGINAL_SHA256" ]]; then
    print -u2 "Source main database changed before disposable installation"
    return 1
  fi
  verify_optional_original "$DATABASE_PATH-wal" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "Source WAL"
  verify_optional_original "$DATABASE_PATH-shm" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "Source SHM"
  verify_optional_original "$DATABASE_PATH-journal" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "Source journal"
}

prepare_restore_file() {
  local snapshot_path="$1" temporary_path="$2" expected_hash="$3"
  rm -f -- "$temporary_path"
  cp -p "$snapshot_path" "$temporary_path"
  if [[ "$(sha256_file "$temporary_path")" != "$expected_hash" ]]; then
    print -u2 "Prepared restore file hash mismatch: $snapshot_path"
    return 1
  fi
}

restore_database_and_environment() {
  local restore_failed=0
  (( CLEANUP_FINISHED )) && return 0
  if ! stop_palate; then
    print -u2 "Cannot safely restore while Palate is running"
    restore_failed=1
  fi
  if (( SNAPSHOT_READY && ! RESTORED )) && ! assert_source_database_unopened; then
    print -u2 "Cannot safely restore while another process holds the installed database open"
    restore_failed=1
  fi
  if (( SNAPSHOT_READY && ! RESTORED )); then
    if [[ ! -f "$SNAPSHOT_PATH" ]]; then
      print -u2 "Original main-database snapshot is missing: $SNAPSHOT_PATH"
      restore_failed=1
    fi
    if (( ! restore_failed )); then
      prepare_restore_file "$SNAPSHOT_PATH" "$RESTORE_MAIN_TEMP_PATH" "$ORIGINAL_SHA256" || restore_failed=1
      if (( ORIGINAL_WAL_PRESENT )); then
        prepare_restore_file "$SNAPSHOT_WAL_PATH" "$RESTORE_WAL_TEMP_PATH" "$ORIGINAL_WAL_SHA256" || restore_failed=1
      fi
      if (( ORIGINAL_SHM_PRESENT )); then
        prepare_restore_file "$SNAPSHOT_SHM_PATH" "$RESTORE_SHM_TEMP_PATH" "$ORIGINAL_SHM_SHA256" || restore_failed=1
      fi
      if (( ORIGINAL_JOURNAL_PRESENT )); then
        prepare_restore_file "$SNAPSHOT_JOURNAL_PATH" "$RESTORE_JOURNAL_TEMP_PATH" "$ORIGINAL_JOURNAL_SHA256" || restore_failed=1
      fi
    fi
    if (( ! restore_failed )); then
      remove_database_set "$DATABASE_PATH"
      mv -f -- "$RESTORE_MAIN_TEMP_PATH" "$DATABASE_PATH" || restore_failed=1
      if (( ! restore_failed && ORIGINAL_WAL_PRESENT )); then
        mv -f -- "$RESTORE_WAL_TEMP_PATH" "$DATABASE_PATH-wal" || restore_failed=1
      fi
      if (( ! restore_failed && ORIGINAL_SHM_PRESENT )); then
        mv -f -- "$RESTORE_SHM_TEMP_PATH" "$DATABASE_PATH-shm" || restore_failed=1
      fi
      if (( ! restore_failed && ORIGINAL_JOURNAL_PRESENT )); then
        mv -f -- "$RESTORE_JOURNAL_TEMP_PATH" "$DATABASE_PATH-journal" || restore_failed=1
      fi
    fi
    if (( ! restore_failed )); then
      if [[ "$(sha256_file "$DATABASE_PATH")" != "$ORIGINAL_SHA256" ]]; then
        print -u2 "Restored main database hash mismatch"
        restore_failed=1
      fi
      verify_optional_original "$DATABASE_PATH-wal" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "Restored WAL" || restore_failed=1
      verify_optional_original "$DATABASE_PATH-shm" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "Restored SHM" || restore_failed=1
      verify_optional_original "$DATABASE_PATH-journal" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "Restored journal" || restore_failed=1
      (( ! restore_failed )) && RESTORED=1
    fi
  fi
  restore_launch_environment || restore_failed=1
  if (( ! restore_failed )); then
    CLEANUP_FINISHED=1
    return 0
  fi
  return 1
}

remove_sensitive_artifacts() {
  remove_database_set "$SNAPSHOT_PATH"
  remove_database_set "$PREPARED_PATH"
  rm -f -- "$SNAPSHOT_WAL_PATH" "$SNAPSHOT_SHM_PATH" "$SNAPSHOT_JOURNAL_PATH"
  rm -f -- "$INSTALL_TEMP_PATH" "$RESTORE_MAIN_TEMP_PATH" "$RESTORE_WAL_TEMP_PATH"
  rm -f -- "$RESTORE_SHM_TEMP_PATH" "$RESTORE_JOURNAL_TEMP_PATH" "$UI_READY_PATH" "$REPORT_TEMP_PATH"
  rm -f -- \
    "$SNAPSHOT_PATH.tmp-$RUN_ID" "$SNAPSHOT_WAL_PATH.tmp-$RUN_ID" \
    "$SNAPSHOT_SHM_PATH.tmp-$RUN_ID" "$SNAPSHOT_JOURNAL_PATH.tmp-$RUN_ID" \
    "$PREPARED_PATH.tmp-$RUN_ID" "$PREPARED_PATH-wal.tmp-$RUN_ID" \
    "$PREPARED_PATH-shm.tmp-$RUN_ID" "$PREPARED_PATH-journal.tmp-$RUN_ID" \
    "$INSTALL_TEMP_PATH.tmp-$RUN_ID"
  remove_database_sidecars "$INSTALL_TEMP_PATH"
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
  local exit_code="${1:-$?}"
  trap - EXIT ZERR
  trap '' INT TERM HUP
  local restoration_succeeded=0
  if restore_database_and_environment; then
    restoration_succeeded=1
    remove_sensitive_artifacts
  else
    print -u2 "CRITICAL: exact database restoration failed; recovery snapshots were retained:"
    print -u2 "  main=$SNAPSHOT_PATH"
    (( ORIGINAL_WAL_PRESENT )) && print -u2 "  wal=$SNAPSHOT_WAL_PATH"
    (( ORIGINAL_SHM_PRESENT )) && print -u2 "  shm=$SNAPSHOT_SHM_PATH"
    (( ORIGINAL_JOURNAL_PRESENT )) && print -u2 "  journal=$SNAPSHOT_JOURNAL_PATH"
  fi
  if (( ! restoration_succeeded && exit_code == 0 )); then
    exit_code=1
  fi
  exit "$exit_code"
}

trap handle_exit EXIT
trap handle_error ZERR
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

attest_process_bundle() {
  local process_executable process_app process_executable_sha process_bundle_sha process_codesign_output process_cdhash
  local process_executable_uuids
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
  process_cdhash="$(codesign -dvvv "$process_app" 2>&1 | sed -n 's/^CDHash=//p' | head -1)"
  process_executable_uuids="$(mach_o_uuids "$process_executable")"
  if [[ "$process_executable_sha" != "$APP_EXECUTABLE_SHA256" \
    || "$process_bundle_sha" != "$APP_BUNDLE_SHA256" \
    || -z "$process_cdhash" || "$process_cdhash" != "$APP_CDHASH" \
    || -z "$process_executable_uuids" || "$process_executable_uuids" != "$APP_EXECUTABLE_UUIDS" ]]; then
    print -u2 "Running process bundle mismatch: supplied=$APP_PATH actual=$process_app"
    return 1
  fi
  PROCESS_APP_PATH="$process_app"
  PROCESS_EXECUTABLE_SHA256="$process_executable_sha"
  PROCESS_BUNDLE_SHA256="$process_bundle_sha"
  PROCESS_CDHASH="$process_cdhash"
  PROCESS_EXECUTABLE_UUIDS="$process_executable_uuids"
}

attest_process_database() {
  local expected_identity open_path
  local -a open_paths
  expected_identity="$(stat -f '%d:%i' "$DATABASE_PATH")"
  open_paths=("${(@f)$(lsof -a -p "$APP_PID" -Fn 2>/dev/null | sed -n 's/^n//p')}")
  for open_path in "${open_paths[@]}"; do
    if [[ -f "$open_path" && "$(stat -f '%d:%i' "$open_path" 2>/dev/null || true)" == "$expected_identity" ]]; then
      return 0
    fi
  done
  print -u2 "Running Palate process does not hold the installed disposable database open"
  return 1
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

assert_checkpoint() {
  local database_path="$1" checkpoint_result busy log_frames checkpointed_frames
  checkpoint_result="$(sqlite_scalar "$database_path" "PRAGMA wal_checkpoint(TRUNCATE);")"
  IFS='|' read -r busy log_frames checkpointed_frames <<< "$checkpoint_result"
  if [[ ! "$busy" =~ ^[0-9]+$ || ! "$log_frames" =~ ^[0-9]+$ || ! "$checkpointed_frames" =~ ^[0-9]+$ ]] \
    || (( busy != 0 )); then
    print -u2 "WAL checkpoint was incomplete for $database_path: $checkpoint_result"
    return 1
  fi
}

nonspatial_table_list() {
  sqlite_scalar "$1" "SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'michelin_restaurant_spatial_index%'
    ORDER BY name;"
}

nonspatial_schema_digest() {
  sqlite3 -batch -noheader -separator $'\x1f' "$1" "SELECT type, name, tbl_name, COALESCE(sql, '')
    FROM sqlite_schema
    WHERE name NOT LIKE 'michelin_restaurant_spatial_index%'
      AND name NOT LIKE 'michelin_provider_spatial_%'
    ORDER BY type, name;" | shasum -a 256 | awk '{print $1}'
}

table_content_digest() {
  local database_path="$1" table_name="$2" digest
  if [[ ! "$table_name" =~ '^[A-Za-z0-9_]+$' ]]; then
    print -u2 "Unsafe table name in digest plan: $table_name"
    return 1
  fi
  digest="$(sqlite3 -batch -noheader -cmd ".mode quote" "$database_path" \
    "SELECT rowid, * FROM \"$table_name\" ORDER BY rowid;" \
    | shasum -a 256 | awk '{print $1}')"
  if [[ ! "$digest" =~ '^[0-9a-f]{64}$' ]]; then
    print -u2 "Could not compute canonical content digest for table $table_name"
    return 1
  fi
  print -r -- "$digest"
}

typeset -A BASELINE_TABLE_HASHES
BASELINE_TABLE_LIST=""
BASELINE_SCHEMA_DIGEST=""

capture_nonspatial_baseline() {
  local table_name
  BASELINE_TABLE_LIST="$(nonspatial_table_list "$PREPARED_PATH")"
  if [[ -z "$BASELINE_TABLE_LIST" ]]; then
    print -u2 "Prepared database has no application tables"
    return 1
  fi
  for table_name in ${(f)BASELINE_TABLE_LIST}; do
    BASELINE_TABLE_HASHES[$table_name]="$(table_content_digest "$PREPARED_PATH" "$table_name")"
  done
  BASELINE_SCHEMA_DIGEST="$(nonspatial_schema_digest "$PREPARED_PATH")"
}

assert_nonspatial_unchanged() {
  local current_table_list table_name current_hash
  current_table_list="$(nonspatial_table_list "$DATABASE_PATH")"
  if [[ "$current_table_list" != "$BASELINE_TABLE_LIST" ]]; then
    print -u2 "Non-spatial table set changed while the disposable database was installed"
    return 1
  fi
  if [[ "$(nonspatial_schema_digest "$DATABASE_PATH")" != "$BASELINE_SCHEMA_DIGEST" ]]; then
    print -u2 "Non-spatial schema changed while the disposable database was installed"
    return 1
  fi
  for table_name in ${(f)BASELINE_TABLE_LIST}; do
    current_hash="$(table_content_digest "$DATABASE_PATH" "$table_name")"
    if [[ "$current_hash" != "${BASELINE_TABLE_HASHES[$table_name]}" ]]; then
      print -u2 "Application table changed during provider-spatial validation: $table_name"
      return 1
    fi
  done
}

SPATIAL_VIRTUAL_TABLE_COUNT=0
SPATIAL_TRIGGER_COUNT=0
SPATIAL_SHADOW_TABLE_COUNT=0
VALID_GUIDE_COUNT=0
SPATIAL_ROW_COUNT=0
SPATIAL_ISSUE_COUNT=0
RTREE_CHECK=""
CANDIDATE_COUNT=0
PLAN_USES_RTREE=0
PLAN_USES_ROWID_LOOKUP=0
ACTIVE_DATASET_METADATA_PRESENT=0

validate_spatial_database() {
  local anchor anchor_latitude anchor_longitude candidate_sql query_plan quick_check integrity_check foreign_keys
  SPATIAL_VIRTUAL_TABLE_COUNT="$(sqlite_scalar "$DATABASE_PATH" "SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table' AND name = 'michelin_restaurant_spatial_index'
      AND LOWER(sql) LIKE '%using rtree%';")"
  SPATIAL_TRIGGER_COUNT="$(sqlite_scalar "$DATABASE_PATH" "SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = 'michelin_restaurants'
      AND name IN ('michelin_provider_spatial_insert', 'michelin_provider_spatial_update', 'michelin_provider_spatial_delete')
      AND (
        (name = 'michelin_provider_spatial_insert'
          AND LOWER(sql) LIKE '%after insert on michelin_restaurants%'
          AND LOWER(sql) LIKE '%insert or replace into michelin_restaurant_spatial_index%')
        OR
        (name = 'michelin_provider_spatial_update'
          AND LOWER(sql) LIKE '%after update of latitude, longitude on michelin_restaurants%'
          AND LOWER(sql) LIKE '%delete from michelin_restaurant_spatial_index%'
          AND LOWER(sql) LIKE '%insert or replace into michelin_restaurant_spatial_index%')
        OR
        (name = 'michelin_provider_spatial_delete'
          AND LOWER(sql) LIKE '%after delete on michelin_restaurants%'
          AND LOWER(sql) LIKE '%delete from michelin_restaurant_spatial_index%')
      );")"
  SPATIAL_SHADOW_TABLE_COUNT="$(sqlite_scalar "$DATABASE_PATH" "SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table'
      AND name IN ('michelin_restaurant_spatial_index_node', 'michelin_restaurant_spatial_index_parent',
                   'michelin_restaurant_spatial_index_rowid');")"
  if (( SPATIAL_VIRTUAL_TABLE_COUNT != 1 || SPATIAL_TRIGGER_COUNT != 3 || SPATIAL_SHADOW_TABLE_COUNT != 3 )); then
    print -u2 "Provider R-Tree schema or trigger set is incomplete"
    return 1
  fi

  quick_check="$(sqlite_scalar "$DATABASE_PATH" "PRAGMA quick_check;")"
  integrity_check="$(sqlite_scalar "$DATABASE_PATH" "PRAGMA integrity_check;")"
  foreign_keys="$(sqlite_scalar "$DATABASE_PATH" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
  RTREE_CHECK="$(sqlite_scalar "$DATABASE_PATH" "SELECT rtreecheck('michelin_restaurant_spatial_index');")"
  if [[ "$quick_check" != "ok" || "$integrity_check" != "ok" || "$RTREE_CHECK" != "ok" ]] \
    || (( foreign_keys != 0 )); then
    print -u2 "Disposable database or provider R-Tree failed integrity validation"
    return 1
  fi

  VALID_GUIDE_COUNT="$(sqlite_scalar "$DATABASE_PATH" "SELECT COUNT(*) FROM michelin_restaurants
    WHERE latitude BETWEEN -90.0 AND 90.0
      AND longitude BETWEEN -180.0 AND 180.0
      AND NOT (latitude = 0.0 AND longitude = 0.0);")"
  SPATIAL_ROW_COUNT="$(sqlite_scalar "$DATABASE_PATH" "SELECT COUNT(*) FROM michelin_restaurant_spatial_index;")"
  SPATIAL_ISSUE_COUNT="$(sqlite_scalar "$DATABASE_PATH" "SELECT
    (SELECT COUNT(*)
     FROM michelin_restaurants m
     LEFT JOIN michelin_restaurant_spatial_index spatial ON spatial.restaurantRowId = m.rowid
     WHERE m.latitude BETWEEN -90.0 AND 90.0
       AND m.longitude BETWEEN -180.0 AND 180.0
       AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)
       AND (spatial.restaurantRowId IS NULL
         OR NOT (m.latitude BETWEEN spatial.minimumLatitude AND spatial.maximumLatitude)
         OR NOT (m.longitude BETWEEN spatial.minimumLongitude AND spatial.maximumLongitude)
         OR spatial.maximumLatitude - spatial.minimumLatitude > 0.001
         OR spatial.maximumLongitude - spatial.minimumLongitude > 0.001))
    +
    (SELECT COUNT(*)
     FROM michelin_restaurant_spatial_index spatial
     LEFT JOIN michelin_restaurants m ON m.rowid = spatial.restaurantRowId
     WHERE m.rowid IS NULL
       OR NOT (m.latitude BETWEEN -90.0 AND 90.0
         AND m.longitude BETWEEN -180.0 AND 180.0
         AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)));")"
  if (( VALID_GUIDE_COUNT < 1 || SPATIAL_ROW_COUNT != VALID_GUIDE_COUNT || SPATIAL_ISSUE_COUNT != 0 )); then
    print -u2 "Provider R-Tree coverage does not match valid guide coordinates"
    return 1
  fi

  ACTIVE_DATASET_METADATA_PRESENT="$(sqlite_scalar "$DATABASE_PATH" "SELECT EXISTS(
    SELECT 1 FROM app_metadata WHERE key = 'michelin_dataset_version');")"
  anchor="$(sqlite_scalar "$DATABASE_PATH" "SELECT printf('%.17g|%.17g', m.latitude, m.longitude)
    FROM michelin_restaurants m
    WHERE m.latitude BETWEEN -90.0 AND 90.0
      AND m.longitude BETWEEN -180.0 AND 180.0
      AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)
      AND (NOT EXISTS (SELECT 1 FROM app_metadata WHERE key = 'michelin_dataset_version')
        OR m.datasetVersion = (SELECT value FROM app_metadata WHERE key = 'michelin_dataset_version'))
    ORDER BY m.rowid LIMIT 1;")"
  if [[ ! "$anchor" =~ '^-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?\|-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' ]]; then
    print -u2 "No active valid guide coordinate is available for the candidate-query probe"
    return 1
  fi
  IFS='|' read -r anchor_latitude anchor_longitude <<< "$anchor"
  candidate_sql="WITH reservation_bounds(
      reservationOrdinal,
      minimumLatitude,
      maximumLatitude,
      firstMinimumLongitude,
      firstMaximumLongitude,
      hasSecondLongitudeInterval,
      secondMinimumLongitude,
      secondMaximumLongitude
    ) AS (VALUES (0, $anchor_latitude, $anchor_latitude,
      $anchor_longitude, $anchor_longitude, 0, 0, 0))
    SELECT COUNT(*)
    FROM reservation_bounds q
    CROSS JOIN michelin_restaurant_spatial_index spatial
      ON spatial.minimumLatitude <= q.maximumLatitude
     AND spatial.maximumLatitude >= q.minimumLatitude
     AND (
       (spatial.minimumLongitude <= q.firstMaximumLongitude
         AND spatial.maximumLongitude >= q.firstMinimumLongitude)
       OR
       (q.hasSecondLongitudeInterval = 1
         AND spatial.minimumLongitude <= q.secondMaximumLongitude
         AND spatial.maximumLongitude >= q.secondMinimumLongitude)
     )
    CROSS JOIN michelin_restaurants m ON m.rowid = spatial.restaurantRowId
    WHERE (NOT EXISTS (SELECT 1 FROM app_metadata WHERE key = 'michelin_dataset_version')
        OR m.datasetVersion = (SELECT value FROM app_metadata WHERE key = 'michelin_dataset_version'));"
  CANDIDATE_COUNT="$(sqlite_scalar "$DATABASE_PATH" "$candidate_sql")"
  query_plan="$(sqlite3 -batch -noheader "$DATABASE_PATH" "EXPLAIN QUERY PLAN $candidate_sql")"
  [[ "$query_plan" == *"VIRTUAL TABLE INDEX"* ]] && PLAN_USES_RTREE=1 || PLAN_USES_RTREE=0
  [[ "$query_plan" == *"INTEGER PRIMARY KEY"* ]] && PLAN_USES_ROWID_LOOKUP=1 || PLAN_USES_ROWID_LOOKUP=0
  if (( CANDIDATE_COUNT < 1 || PLAN_USES_RTREE != 1 || PLAN_USES_ROWID_LOOKUP != 1 )); then
    print -u2 "Provider candidate query is not ready to use the R-Tree/rowid lookup path"
    return 1
  fi

  assert_nonspatial_unchanged
}

# Verify the supplied signed bytes before taking any source snapshot.
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
APP_EXECUTABLE_SHA256="$(sha256_file "$APP_PATH/Palate")"
APP_BUNDLE_SHA256="$(sha256_file "$APP_PATH/main.jsbundle")"
APP_CDHASH="$(codesign -dvvv "$APP_PATH" 2>&1 | sed -n 's/^CDHash=//p' | head -1)"
APP_BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$APP_PATH/Info.plist" 2>/dev/null || true)"
APP_EXECUTABLE_UUIDS="$(mach_o_uuids "$APP_PATH/Palate")"
if [[ -z "$APP_CDHASH" || -z "$APP_BUNDLE_ID" || -z "$APP_EXECUTABLE_UUIDS" ]]; then
  print -u2 "The supplied app has no readable signed CDHash, bundle ID, or Mach-O UUID"
  exit 1
fi

stop_palate
assert_source_database_unopened
rm -f -- "$REPORT_TEMP_PATH" "$UI_READY_PATH"
remove_database_set "$SNAPSHOT_PATH"
remove_database_set "$PREPARED_PATH"

# Snapshot without opening SQLite: this preserves the exact source main/WAL/SHM/journal bytes.
ORIGINAL_SHA256="$(copy_and_attest "$DATABASE_PATH" "$SNAPSHOT_PATH")"
if [[ -f "$DATABASE_PATH-wal" ]]; then
  ORIGINAL_WAL_PRESENT=1
  ORIGINAL_WAL_SHA256="$(copy_and_attest "$DATABASE_PATH-wal" "$SNAPSHOT_WAL_PATH")"
fi
if [[ -f "$DATABASE_PATH-shm" ]]; then
  ORIGINAL_SHM_PRESENT=1
  ORIGINAL_SHM_SHA256="$(copy_and_attest "$DATABASE_PATH-shm" "$SNAPSHOT_SHM_PATH")"
fi
if [[ -f "$DATABASE_PATH-journal" ]]; then
  ORIGINAL_JOURNAL_PRESENT=1
  ORIGINAL_JOURNAL_SHA256="$(copy_and_attest "$DATABASE_PATH-journal" "$SNAPSHOT_JOURNAL_PATH")"
fi
SNAPSHOT_READY=1
verify_original_source_set

# Recreate the original file set under a disposable basename, then checkpoint only that copy.
copy_and_attest "$SNAPSHOT_PATH" "$PREPARED_PATH" >/dev/null
(( ORIGINAL_WAL_PRESENT )) && copy_and_attest "$SNAPSHOT_WAL_PATH" "$PREPARED_PATH-wal" >/dev/null
(( ORIGINAL_SHM_PRESENT )) && copy_and_attest "$SNAPSHOT_SHM_PATH" "$PREPARED_PATH-shm" >/dev/null
(( ORIGINAL_JOURNAL_PRESENT )) && copy_and_attest "$SNAPSHOT_JOURNAL_PATH" "$PREPARED_PATH-journal" >/dev/null
assert_checkpoint "$PREPARED_PATH"
remove_database_sidecars "$PREPARED_PATH"

PREPARED_QUICK_CHECK="$(sqlite_scalar "$PREPARED_PATH" "PRAGMA quick_check;")"
PREPARED_INTEGRITY_CHECK="$(sqlite_scalar "$PREPARED_PATH" "PRAGMA integrity_check;")"
PREPARED_FOREIGN_KEYS="$(sqlite_scalar "$PREPARED_PATH" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
if [[ "$PREPARED_QUICK_CHECK" != "ok" || "$PREPARED_INTEGRITY_CHECK" != "ok" ]] \
  || (( PREPARED_FOREIGN_KEYS != 0 )); then
  print -u2 "Disposable source copy failed integrity validation"
  exit 1
fi

REQUIRED_SCHEMA_COUNT="$(sqlite_scalar "$PREPARED_PATH" "SELECT
  (SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name IN
    ('app_metadata','food_keywords','ignored_locations','michelin_restaurants','photos','restaurants','visits',
     'visit_suggested_restaurants','reservation_import_sources','dismissed_reservation_import_sources',
     'reservation_import_review_exclusions','dismissed_calendar_events'))
  +
  (SELECT COUNT(*) FROM pragma_table_info('visits') WHERE name IN ('exportedToCalendarId','awardAtVisit'))
  +
  (SELECT COUNT(*) FROM pragma_table_info('photos') WHERE name IN ('allLabels','mediaType','duration'))
  +
  (SELECT COUNT(*) FROM pragma_table_info('michelin_restaurants') WHERE name IN ('latestAwardYear','datasetVersion')); ")"
if (( REQUIRED_SCHEMA_COUNT != 19 )); then
  print -u2 "Source database has pending non-spatial migrations; refusing an ambiguous validation run"
  exit 1
fi
if [[ "$(sqlite_scalar "$PREPARED_PATH" "SELECT COUNT(*) FROM ignored_locations;")" != "0" ]]; then
  print -u2 "Source has ignored locations; startup could reject pending visits, so this isolated run is unsafe"
  exit 1
fi

# Remove any prior prototype index so the signed app must perform the migration under test.
sqlite_scalar "$PREPARED_PATH" "DROP TRIGGER IF EXISTS michelin_provider_spatial_insert;
  DROP TRIGGER IF EXISTS michelin_provider_spatial_update;
  DROP TRIGGER IF EXISTS michelin_provider_spatial_delete;
  DROP TABLE IF EXISTS michelin_restaurant_spatial_index;" >/dev/null
assert_checkpoint "$PREPARED_PATH"
remove_database_sidecars "$PREPARED_PATH"
if [[ "$(sqlite_scalar "$PREPARED_PATH" "SELECT COUNT(*) FROM sqlite_schema
  WHERE name LIKE 'michelin_restaurant_spatial_index%'
     OR name LIKE 'michelin_provider_spatial_%';")" != "0" ]]; then
  print -u2 "Could not remove the prior provider-spatial schema from the disposable copy"
  exit 1
fi
PREPARED_SHA256="$(sha256_file "$PREPARED_PATH")"
capture_nonspatial_baseline

# Install only after the exact source snapshot and disposable baseline are durable.
verify_original_source_set
copy_and_attest "$PREPARED_PATH" "$INSTALL_TEMP_PATH" >/dev/null
remove_database_sidecars "$DATABASE_PATH"
mv -f -- "$INSTALL_TEMP_PATH" "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
if [[ "$(sha256_file "$DATABASE_PATH")" != "$PREPARED_SHA256" ]]; then
  print -u2 "Installed disposable database hash mismatch"
  exit 1
fi

capture_crash_report_baseline
launchctl setenv "$RUN_ENVIRONMENT_KEY" "$RUN_ID"
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
EXPECTED_ENVIRONMENT="$RUN_ENVIRONMENT_KEY=$RUN_ID"
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_ENVIRONMENT "* ]]; then
  print -u2 "Running Palate did not inherit this provider-spatial validation run ID"
  exit 1
fi
attest_process_bundle
PROCESS_OBSERVED_EPOCH="$(date +%s.%N)"

MIGRATION_DEADLINE=$(( $(date +%s) + MIGRATION_TIMEOUT_SECONDS ))
while true; do
  if [[ "$(sqlite_scalar "$DATABASE_PATH" "SELECT
    (SELECT COUNT(*) FROM sqlite_schema
      WHERE type='table' AND name='michelin_restaurant_spatial_index') = 1
    AND
    (SELECT COUNT(*) FROM sqlite_schema
      WHERE type='trigger' AND tbl_name='michelin_restaurants'
        AND name IN ('michelin_provider_spatial_insert', 'michelin_provider_spatial_update',
                     'michelin_provider_spatial_delete')) = 3
    AND
    (SELECT COUNT(*) FROM michelin_restaurant_spatial_index) =
      (SELECT COUNT(*) FROM michelin_restaurants
       WHERE latitude BETWEEN -90.0 AND 90.0
         AND longitude BETWEEN -180.0 AND 180.0
         AND NOT (latitude = 0.0 AND longitude = 0.0));" 2>/dev/null || print 0)" == "1" ]]; then
      break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before creating the provider R-Tree"
    exit 1
  fi
  if (( $(date +%s) >= MIGRATION_DEADLINE )); then
    print -u2 "Timed out waiting for the provider R-Tree migration"
    exit 1
  fi
  sleep 0.1
done
MIGRATION_READY_EPOCH="$(date +%s.%N)"
MIGRATION_SECONDS="$(awk -v finish="$MIGRATION_READY_EPOCH" -v start="$PROCESS_OBSERVED_EPOCH" \
  'BEGIN { printf "%.6f", finish - start }')"
validate_spatial_database
attest_process_bundle
attest_process_database

if (( ! SKIP_UI_PAUSE )); then
  print "UI_READY run_id=$RUN_ID pid=$APP_PID marker=$UI_READY_PATH"
  print "Inspect Calendar Imports read-only; do not import, dismiss, rescan, merge, or start a Photos scan."
  UI_DEADLINE=$(( $(date +%s) + UI_TIMEOUT_SECONDS ))
  while [[ ! -s "$UI_READY_PATH" ]]; do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      print -u2 "Palate exited before read-only UI inspection completed"
      exit 1
    fi
    if (( $(date +%s) >= UI_DEADLINE )); then
      print -u2 "Timed out waiting for $UI_READY_PATH"
      exit 1
    fi
    sleep 0.1
  done
  UI_READY_EPOCH="$(< "$UI_READY_PATH")"
  UI_OBSERVED_EPOCH="$(date +%s.%N)"
  validate_timestamp "UI-ready" "$UI_READY_EPOCH" "$MIGRATION_READY_EPOCH" "$UI_OBSERVED_EPOCH"
else
  UI_READY_EPOCH="$MIGRATION_READY_EPOCH"
fi

# Re-attest and revalidate after any read-only UI navigation.
assert_no_new_matching_crash_report 0
attest_process_bundle
attest_process_database
validate_spatial_database
stop_palate
assert_no_new_matching_crash_report 1
validate_spatial_database
DISPOSABLE_WAL_BYTES=0
if [[ -e "$DATABASE_PATH-wal" ]]; then
  DISPOSABLE_WAL_BYTES="$(stat -f '%z' "$DATABASE_PATH-wal")"
fi
assert_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
MIGRATED_SHA256="$(sha256_file "$DATABASE_PATH")"

if ! restore_database_and_environment; then
  print -u2 "Exact database or launch-environment restoration failed"
  exit 1
fi

RESTORED_SHA256="$(sha256_file "$DATABASE_PATH")"
if [[ "$RESTORED_SHA256" != "$ORIGINAL_SHA256" ]]; then
  print -u2 "Restored main database differs from the source snapshot"
  exit 1
fi

jq -n \
  --arg runId "$RUN_ID" \
  --argjson migrationSeconds "$MIGRATION_SECONDS" \
  --argjson uiInspectionCompleted "$(( ! SKIP_UI_PAUSE ))" \
  --arg suppliedAppPath "$APP_PATH" \
  --arg processAppPath "$PROCESS_APP_PATH" \
  --arg executableSha256 "$APP_EXECUTABLE_SHA256" \
  --arg bundleSha256 "$APP_BUNDLE_SHA256" \
  --arg cdhash "$APP_CDHASH" \
  --arg bundleId "$APP_BUNDLE_ID" \
  --arg sharedSchemeRunConfiguration "$SCHEME_RUN_CONFIGURATION" \
  --argjson baselineCrashReportCount "$BASELINE_CRASH_REPORT_COUNT" \
  --argjson matchingNewCrashReportCount "$MATCHING_NEW_CRASH_REPORT_COUNT" \
  --arg originalSha256 "$ORIGINAL_SHA256" \
  --arg preparedSha256 "$PREPARED_SHA256" \
  --arg migratedSha256 "$MIGRATED_SHA256" \
  --arg restoredSha256 "$RESTORED_SHA256" \
  --argjson originalWalPresent "$ORIGINAL_WAL_PRESENT" \
  --argjson originalShmPresent "$ORIGINAL_SHM_PRESENT" \
  --argjson originalJournalPresent "$ORIGINAL_JOURNAL_PRESENT" \
  --arg originalWalSha256 "$ORIGINAL_WAL_SHA256" \
  --arg originalShmSha256 "$ORIGINAL_SHM_SHA256" \
  --arg originalJournalSha256 "$ORIGINAL_JOURNAL_SHA256" \
  --argjson virtualTableCount "$SPATIAL_VIRTUAL_TABLE_COUNT" \
  --argjson triggerCount "$SPATIAL_TRIGGER_COUNT" \
  --argjson shadowTableCount "$SPATIAL_SHADOW_TABLE_COUNT" \
  --argjson validGuideCount "$VALID_GUIDE_COUNT" \
  --argjson spatialRowCount "$SPATIAL_ROW_COUNT" \
  --argjson issueCount "$SPATIAL_ISSUE_COUNT" \
  --arg rtreeCheck "$RTREE_CHECK" \
  --argjson candidateCount "$CANDIDATE_COUNT" \
  --argjson planUsesRtree "$PLAN_USES_RTREE" \
  --argjson planUsesRowidLookup "$PLAN_USES_ROWID_LOOKUP" \
  --argjson activeDatasetMetadataPresent "$ACTIVE_DATASET_METADATA_PRESENT" \
  --argjson applicationTableCount "${#BASELINE_TABLE_HASHES[@]}" \
  --argjson disposableWalBytes "$DISPOSABLE_WAL_BYTES" \
  '{
    schemaVersion: 1,
    status: "ok",
    validation: "macos-provider-spatial",
    runId: $runId,
    timing: {
      processObservedToIntegrationReadySeconds: $migrationSeconds,
      scope: "signed-process attestation plus external readiness polling; migration may already be complete",
      comparativePerformanceMeasurement: false,
      uiInspectionCompleted: ($uiInspectionCompleted == 1),
      uiInspectionMode: "read-only marker; no provider import, dismissal, Calendar mutation, or Photos scan"
    },
    app: {
      suppliedAppPath: $suppliedAppPath,
      attestedProcessAppPath: $processAppPath,
      executableSha256: $executableSha256,
      mainJsBundleSha256: $bundleSha256,
      cdhash: $cdhash,
      bundleId: $bundleId,
      sharedSchemeRunConfigurationObservedBeforeLaunch: $sharedSchemeRunConfiguration,
      processBundleMatchesSuppliedBundle: true,
      processDatabaseMatchesSuppliedDatabase: true
    },
    crashGuard: {
      baselineIncidentCount: $baselineCrashReportCount,
      matchingNewReportCount: $matchingNewCrashReportCount,
      matchCriteria: "bundle ID + attested executable UUID + process launch window",
      rawCrashContentIncluded: false
    },
    spatial: {
      virtualTableCount: $virtualTableCount,
      triggerCount: $triggerCount,
      shadowTableCount: $shadowTableCount,
      validGuideCount: $validGuideCount,
      indexedRowCount: $spatialRowCount,
      issueCount: $issueCount,
      rtreeCheck: $rtreeCheck,
      candidateProbeCount: $candidateCount,
      candidatePlanUsesRtree: ($planUsesRtree == 1),
      candidatePlanUsesRowidLookup: ($planUsesRowidLookup == 1),
      activeDatasetMetadataPresent: ($activeDatasetMetadataPresent == 1)
    },
    isolation: {
      nonSpatialApplicationTableCount: $applicationTableCount,
      nonSpatialSchemaUnchanged: true,
      nonSpatialTableContentsUnchanged: true,
      disposableWalBytesBeforeCheckpoint: $disposableWalBytes,
      aggregateOnlyReport: true
    },
    restoration: {
      originalMainSha256: $originalSha256,
      preparedMainSha256: $preparedSha256,
      migratedMainSha256: $migratedSha256,
      restoredMainSha256: $restoredSha256,
      originalWal: {present: ($originalWalPresent == 1), sha256: (if $originalWalPresent == 1 then $originalWalSha256 else null end)},
      originalShm: {present: ($originalShmPresent == 1), sha256: (if $originalShmPresent == 1 then $originalShmSha256 else null end)},
      originalJournal: {present: ($originalJournalPresent == 1), sha256: (if $originalJournalPresent == 1 then $originalJournalSha256 else null end)},
      exactMainAndSidecarSetRestored: true,
      sensitiveDatabaseCopiesRetained: false
    }
  }' > "$REPORT_TEMP_PATH"
mv -f -- "$REPORT_TEMP_PATH" "$REPORT_PATH"
remove_sensitive_artifacts

print "COMPLETE report=$REPORT_PATH integration_ready_seconds=$MIGRATION_SECONDS indexed_rows=$SPATIAL_ROW_COUNT restored_sha256=$RESTORED_SHA256"

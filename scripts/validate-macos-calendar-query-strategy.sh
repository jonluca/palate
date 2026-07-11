#!/bin/zsh
set -euo pipefail
umask 077

APP_PATH=""
DATABASE_PATH=""
REFERENCE_DATABASE_PATH=""
CAPTURE_REFERENCE_DATABASE_PATH=""
CAPTURE_REFERENCE_DATABASE_PROVIDED=0
CAPTURE_EXPECTED_CALENDAR_LINK_COUNT=""
CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_PROVIDED=0
ALLOW_REFERENCE_FIXTURE_GROWTH=0
QUERY_STRATEGY=""
QUERY_GAP_DAYS="7"
OUTPUT_PREFIX=""
EXPECTED_VISIT_COUNT="6511"
EXPECTED_CALENDAR_LINK_COUNT="2000"
TIMEOUT_SECONDS="180"
MANUAL_LAUNCH=0
RETAIN_RAW_DATABASES=0
RECOVER_STALE_GUARD=0
PHOTO_SCAN_STRATEGY=""
PHOTO_SCAN_STRATEGY_PROVIDED=0
EXPECTED_PHOTO_SCAN_IMPLEMENTATION=""
NATIVE_DEFAULT_PHOTO_SCAN_STRATEGY="incremental"

usage() {
  print "Usage: validate-macos-calendar-query-strategy.sh --database=PATH --strategy=broad|sparse --output-prefix=PATH [options]"
  print ""
  print "  --app=PATH                         Exact signed Release Palate.app used to attest the launched copy"
  print "  --reference-database=PATH          Read-only parity reference (default: live snapshot)"
  print "  --capture-reference-database=PATH  Capture a validated incremental result as a private reference DB"
  print "  --capture-expected-calendar-link-count=N"
  print "                                     Enable capture fixture growth with this post-scan completion target"
  print "  --allow-reference-fixture-growth   Allow an explicit incremental reference to grow fixture aggregates"
  print "  --gap-days=N                       Sparse coalescing gap, 0 through 365 (default: 7)"
  print "  --expected-visit-count=N           Controlled visit fixture size (default: 6511)"
  print "  --expected-calendar-link-count=N   Expected restored Calendar links (default: 2000)"
  print "  --timeout-seconds=N                Completion timeout after trigger (default: 180)"
  print "  --photo-scan-strategy=VALUE        Photo scan strategy: legacy or incremental (default: native incremental)"
  print "  --expected-photo-scan-implementation=VALUE"
  print "                                     Require legacy, identifier-list, or database-backed native attestation"
  print "  --retain-raw-databases             Retain private snapshot/result DBs after verified restoration"
  print "  --recover-stale-guard              Restore an interrupted run; requires only --database"
  print "  --manual-launch                    Wait for Xcode Run Without Building"
  print ""
  print "The script snapshots and restores the database, clears only derived Calendar fields,"
  print "launches Palate with the requested native query strategy, and waits for OUTPUT_PREFIX.trigger."
  print "Write a fractional epoch timestamp (date +%s.%N) into that file immediately before"
  print "triggering Rescan Photos. Timing covers the prefix through durable Calendar restoration,"
  print "including PhotoKit/grouping before Calendar and excluding later rescan phases."
  print "Reference capture is incremental-only, cannot be combined with --reference-database,"
  print "and publishes a mode-0600 database only after full validation succeeds."
  print "Fixture growth requires an explicit capture Calendar target; exact replay of that"
  print "capture requires --reference-database plus --allow-reference-fixture-growth."
}

for argument in "$@"; do
  case "$argument" in
    --app=*) APP_PATH="${argument#*=}" ;;
    --database=*) DATABASE_PATH="${argument#*=}" ;;
    --reference-database=*) REFERENCE_DATABASE_PATH="${argument#*=}" ;;
    --capture-reference-database=*)
      CAPTURE_REFERENCE_DATABASE_PATH="${argument#*=}"
      CAPTURE_REFERENCE_DATABASE_PROVIDED=1
      ;;
    --capture-expected-calendar-link-count=*)
      CAPTURE_EXPECTED_CALENDAR_LINK_COUNT="${argument#*=}"
      CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_PROVIDED=1
      ;;
    --allow-reference-fixture-growth) ALLOW_REFERENCE_FIXTURE_GROWTH=1 ;;
    --strategy=*) QUERY_STRATEGY="${argument#*=}" ;;
    --gap-days=*) QUERY_GAP_DAYS="${argument#*=}" ;;
    --output-prefix=*) OUTPUT_PREFIX="${argument#*=}" ;;
    --expected-visit-count=*) EXPECTED_VISIT_COUNT="${argument#*=}" ;;
    --expected-calendar-link-count=*) EXPECTED_CALENDAR_LINK_COUNT="${argument#*=}" ;;
    --timeout-seconds=*) TIMEOUT_SECONDS="${argument#*=}" ;;
    --photo-scan-strategy=*)
      PHOTO_SCAN_STRATEGY="${argument#*=}"
      PHOTO_SCAN_STRATEGY_PROVIDED=1
      ;;
    --expected-photo-scan-implementation=*)
      EXPECTED_PHOTO_SCAN_IMPLEMENTATION="${argument#*=}"
      ;;
    --retain-raw-databases) RETAIN_RAW_DATABASES=1 ;;
    --recover-stale-guard) RECOVER_STALE_GUARD=1 ;;
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

recover_stale_guard() {
  if [[ -z "$DATABASE_PATH" ]]; then
    print -u2 "--recover-stale-guard requires --database"
    return 2
  fi

  local database_path="${DATABASE_PATH:A}"
  local database_directory="${database_path:h}"
  local lock_path="$database_path.palate-calendar-validation.lock"
  local guard_path="$database_path.palate-calendar-validation.guard"
  local manifest_path="$guard_path/manifest.json"
  local recovery_id="calendar-query-recovery-$$-$(date +%s)-$RANDOM"
  local main_temp_path="$database_path.restore-$recovery_id.main.tmp"
  local wal_temp_path="$database_path.restore-$recovery_id.wal.tmp"
  local shm_temp_path="$database_path.restore-$recovery_id.shm.tmp"
  local journal_temp_path="$database_path.restore-$recovery_id.journal.tmp"
  local restore_failed=0
  local guard_removed=0
  local main_hash main_mode wal_present wal_hash wal_mode
  local shm_present shm_hash shm_mode journal_present journal_hash journal_mode
  local retain_raw_databases snapshot_path result_database_path reference_capture_path created_by_run_id output_prefix
  local sensitive_temporary_path
  local -a sensitive_temporary_paths=()
  local key was_set value
  local -a launch_environment_keys=(
    PALATE_CALENDAR_QUERY_STRATEGY
    PALATE_CALENDAR_QUERY_GAP_DAYS
    PALATE_CALENDAR_VALIDATION_RUN_ID
    PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH
    PALATE_VISION_RESULT_PAGE_SIZE
    PALATE_VISION_CLASSIFICATION_STRATEGY
    PALATE_VISION_CONCURRENCY
    PALATE_VISION_PIPELINE_DEPTH
    PALATE_PHOTO_SCAN_STRATEGY
    PALATE_PHOTO_SCAN_VALIDATION_RUN_ID
    PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH
  )

  if [[ ! -d "$database_directory" || ! -w "$database_directory" ]]; then
    print -u2 "The database directory must exist and be writable for recovery: $database_directory"
    return 2
  fi
  for dependency in awk head jq lockf lsof pgrep pkill ps shasum stat tr; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
      print -u2 "Missing recovery dependency: $dependency"
      return 2
    fi
  done
  if [[ -L "$lock_path" ]]; then
    print -u2 "Refusing a symlinked database recovery lock: $lock_path"
    return 1
  fi
  exec 9> "$lock_path"
  chmod 600 "$lock_path"
  if ! lockf -s -t 5 9; then
    print -u2 "Another Calendar/Photo validation already owns this database lock: $lock_path"
    return 75
  fi
  if [[ ! -d "$guard_path" || -L "$guard_path" || ! -f "$manifest_path" || -L "$manifest_path" ]]; then
    print -u2 "No valid durable recovery guard exists for: $database_path"
    return 66
  fi

  if ! jq -e \
    --arg databasePath "$database_path" \
    '
      def sha256: type == "string" and test("^[0-9a-fA-F]{64}$");
      def mode: type == "string" and test("^[0-7]{3,4}$");
      def valid_component($component; $required):
        (($component | type) == "object")
        and (($component.present | type) == "boolean")
        and (($required | not) or $component.present)
        and (if $component.present then
          ($component.sha256 | sha256)
          and ($component.mode | mode)
          and (($component.size | type) == "number")
          and ($component.size >= 0)
          and (($component.size | floor) == $component.size)
        else
          $component.sha256 == null
          and $component.mode == null
          and $component.size == null
        end);
      def valid_environment:
        type == "object"
        and ((.wasSet | type) == "boolean")
        and ((.value | type) == "string");
      type == "object"
      and .schemaVersion == 1
      and .databasePath == $databasePath
      and ((.createdByRunId | type) == "string" and (.createdByRunId | length) > 0)
      and ((.components | type) == "object")
      and valid_component(.components.main; true)
      and valid_component(.components.wal; false)
      and valid_component(.components.shm; false)
      and valid_component(.components.journal; false)
      and ((.launchEnvironment | type) == "object")
      and ((.launchEnvironment | keys | sort) == ([
          "PALATE_CALENDAR_QUERY_STRATEGY",
          "PALATE_CALENDAR_QUERY_GAP_DAYS",
          "PALATE_CALENDAR_VALIDATION_RUN_ID",
          "PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH",
          "PALATE_VISION_RESULT_PAGE_SIZE",
          "PALATE_VISION_CLASSIFICATION_STRATEGY",
          "PALATE_VISION_CONCURRENCY",
          "PALATE_VISION_PIPELINE_DEPTH",
          "PALATE_PHOTO_SCAN_STRATEGY",
          "PALATE_PHOTO_SCAN_VALIDATION_RUN_ID",
          "PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH"
        ] | sort))
      and all(.launchEnvironment[]; valid_environment)
      and ((.artifactCleanup | type) == "object")
      and ((.artifactCleanup.retainRawDatabases | type) == "boolean")
      and ((.artifactCleanup.snapshotPath | type) == "string")
      and ((.artifactCleanup.snapshotPath | length) > 0)
      and ((.artifactCleanup.resultDatabasePath | type) == "string")
      and ((.artifactCleanup.resultDatabasePath | length) > 0)
      and (((.artifactCleanup.referenceCapturePath? // null) == null)
        or (((.artifactCleanup.referenceCapturePath | type) == "string")
          and (.artifactCleanup.referenceCapturePath | startswith("/"))))
      and ((.artifactCleanup.temporaryPaths | type) == "array")
      and all(.artifactCleanup.temporaryPaths[];
        type == "string"
        and startswith("/")
        and (endswith(".tmp") or contains(".tmp-")))
    ' "$manifest_path" >/dev/null; then
    print -u2 "The durable recovery manifest is invalid; the guard was retained: $manifest_path"
    return 1
  fi

  recovery_stop_palate() {
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
    print -u2 "Palate did not terminate during stale-guard recovery"
    return 1
  }

  recovery_assert_database_unopened() {
    local holder_output
    local -a database_paths=()
    [[ -e "$database_path" ]] && database_paths+=("$database_path")
    [[ -e "$database_path-wal" ]] && database_paths+=("$database_path-wal")
    [[ -e "$database_path-shm" ]] && database_paths+=("$database_path-shm")
    [[ -e "$database_path-journal" ]] && database_paths+=("$database_path-journal")
    (( ${#database_paths} == 0 )) && return 0
    holder_output="$(lsof -Fn -- "${database_paths[@]}" 2>/dev/null || true)"
    if [[ -n "$holder_output" ]]; then
      print -u2 "Another process still has the database or a sidecar open during recovery"
      return 1
    fi
  }

  recovery_sha256_file() {
    shasum -a 256 "$1" | awk '{print $1}'
  }

  recovery_prepare_component() {
    local protected_path="$1"
    local temporary_path="$2"
    local expected_hash="$3"
    if ! rm -f -- "$temporary_path"; then
      return 1
    fi
    if ! cp "$protected_path" "$temporary_path"; then
      return 1
    fi
    if ! chmod 600 "$temporary_path"; then
      return 1
    fi
    if [[ "$(recovery_sha256_file "$temporary_path")" != "$expected_hash" ]]; then
      print -u2 "Prepared stale-guard component hash mismatch: $protected_path"
      return 1
    fi
  }

  recovery_verify_component() {
    local component_path="$1"
    local expected_present="$2"
    local expected_hash="$3"
    local expected_mode="$4"
    local label="$5"
    if (( expected_present )); then
      if [[ ! -f "$component_path" || -L "$component_path" \
        || "$(recovery_sha256_file "$component_path")" != "$expected_hash" \
        || "$(stat -f '%Lp' "$component_path")" != "$expected_mode" ]]; then
        print -u2 "$label does not match the durable recovery manifest"
        return 1
      fi
    elif [[ -e "$component_path" ]]; then
      print -u2 "$label exists but was absent from the durable recovery manifest"
      return 1
    fi
  }

  recovery_durability_sync() {
    local phase="${1:-recovery-restored-database}"
    if [[ -n "${PALATE_CALENDAR_HARNESS_FAKE_STATE:-}" \
      && -d "$PALATE_CALENDAR_HARNESS_FAKE_STATE" \
      && "${PALATE_CALENDAR_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE:-}" == "$phase" ]]; then
      print -u2 "Injected durability sync failure: $phase"
      return 1
    fi
    if [[ "${PALATE_CALENDAR_HARNESS_TEST_SKIP_DURABILITY_SYNC:-0}" == "1" \
      && -n "${PALATE_CALENDAR_HARNESS_FAKE_STATE:-}" \
      && -d "$PALATE_CALENDAR_HARNESS_FAKE_STATE" ]]; then
      return 0
    fi
    /bin/sync
  }

  recovery_launch_environment_key_is_set() {
    local environment_key="$1"
    launchctl print "gui/$UID" 2>/dev/null \
      | awk -v key="$environment_key" '$1 == key && $2 == "=>" { found = 1 } END { exit !found }'
  }

  recovery_remove_guard() {
    if [[ -n "${PALATE_CALENDAR_HARNESS_FAKE_STATE:-}" \
      && -d "$PALATE_CALENDAR_HARNESS_FAKE_STATE" \
      && "${PALATE_CALENDAR_HARNESS_TEST_FAIL_GUARD_REMOVAL:-0}" == "1" ]]; then
      print -u2 "Injected durable recovery guard removal failure"
      return 1
    fi
    rm -rf -- "$guard_path" || return 1
    if [[ -e "$guard_path" ]]; then
      print -u2 "The durable recovery guard still exists after removal: $guard_path"
      return 1
    fi
  }

  recovery_cleanup_raw_databases() {
    if [[ -n "$reference_capture_path" ]]; then
      rm -f -- \
        "$reference_capture_path" \
        "$reference_capture_path-wal" \
        "$reference_capture_path-shm" \
        "$reference_capture_path-journal" || return 1
    fi
    for sensitive_temporary_path in "${sensitive_temporary_paths[@]}"; do
      rm -f -- \
        "$sensitive_temporary_path" \
        "$sensitive_temporary_path-wal" \
        "$sensitive_temporary_path-shm" \
        "$sensitive_temporary_path-journal" || return 1
    done
    if (( retain_raw_databases )); then
      return 0
    fi
    if [[ -n "${PALATE_CALENDAR_HARNESS_FAKE_STATE:-}" \
      && -d "$PALATE_CALENDAR_HARNESS_FAKE_STATE" \
      && "${PALATE_CALENDAR_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP:-0}" == "1" ]]; then
      print -u2 "Injected default raw database cleanup failure"
      return 1
    fi
    if ! rm -f -- \
      "$snapshot_path" "$snapshot_path-wal" "$snapshot_path-shm" "$snapshot_path-journal" \
      "$result_database_path" "$result_database_path-wal" \
      "$result_database_path-shm" "$result_database_path-journal"; then
      return 1
    fi
  }

  recovery_cleanup_temporary_files() {
    rm -f -- "$main_temp_path" "$wal_temp_path" "$shm_temp_path" "$journal_temp_path" || true
  }
  trap recovery_cleanup_temporary_files EXIT

  main_hash="$(jq -r '.components.main.sha256' "$manifest_path")"
  main_mode="$(jq -r '.components.main.mode' "$manifest_path")"
  created_by_run_id="$(jq -r '.createdByRunId' "$manifest_path")"
  wal_present="$(jq -r 'if .components.wal.present then 1 else 0 end' "$manifest_path")"
  wal_hash="$(jq -r '.components.wal.sha256 // ""' "$manifest_path")"
  wal_mode="$(jq -r '.components.wal.mode // ""' "$manifest_path")"
  shm_present="$(jq -r 'if .components.shm.present then 1 else 0 end' "$manifest_path")"
  shm_hash="$(jq -r '.components.shm.sha256 // ""' "$manifest_path")"
  shm_mode="$(jq -r '.components.shm.mode // ""' "$manifest_path")"
  journal_present="$(jq -r 'if .components.journal.present then 1 else 0 end' "$manifest_path")"
  journal_hash="$(jq -r '.components.journal.sha256 // ""' "$manifest_path")"
  journal_mode="$(jq -r '.components.journal.mode // ""' "$manifest_path")"
  retain_raw_databases="$(jq -r 'if .artifactCleanup.retainRawDatabases then 1 else 0 end' "$manifest_path")"
  snapshot_path="$(jq -r '.artifactCleanup.snapshotPath' "$manifest_path")"
  result_database_path="$(jq -r '.artifactCleanup.resultDatabasePath' "$manifest_path")"
  reference_capture_path="$(jq -r '.artifactCleanup.referenceCapturePath // ""' "$manifest_path")"
  sensitive_temporary_paths=("${(@f)$(jq -r '.artifactCleanup.temporaryPaths[]' "$manifest_path")}")
  output_prefix="${snapshot_path%.$created_by_run_id.original.db}"
  if [[ "$snapshot_path" != /* || "$result_database_path" != /* \
    || "${snapshot_path:A}" == "$database_path" \
    || "${result_database_path:A}" == "$database_path" \
    || "${snapshot_path:A}" == "$guard_path" \
    || "${result_database_path:A}" == "$guard_path" \
    || "$snapshot_path" != *.$created_by_run_id.original.db \
    || "$result_database_path" != "$output_prefix.result.db" ]]; then
    recovery_cleanup_temporary_files
    trap - EXIT
    print -u2 "The durable recovery manifest contains unsafe cleanup paths; the guard was retained"
    return 1
  fi
  if [[ -n "$reference_capture_path" ]] \
    && { [[ "$reference_capture_path" != /* ]] \
      || [[ "${reference_capture_path:A}" == "$database_path" ]] \
      || [[ "${reference_capture_path:A}" == "$database_path-wal" ]] \
      || [[ "${reference_capture_path:A}" == "$database_path-shm" ]] \
      || [[ "${reference_capture_path:A}" == "$database_path-journal" ]] \
      || [[ "${reference_capture_path:A}" == "$guard_path" ]] \
      || [[ "${reference_capture_path:A}" == "${snapshot_path:A}" ]] \
      || [[ "${reference_capture_path:A}" == "${result_database_path:A}" ]]; }; then
    recovery_cleanup_temporary_files
    trap - EXIT
    print -u2 "The durable recovery manifest contains an unsafe reference-capture path; the guard was retained"
    return 1
  fi
  for sensitive_temporary_path in "${sensitive_temporary_paths[@]}"; do
    if [[ "${sensitive_temporary_path:A}" == "$database_path" \
      || "${sensitive_temporary_path:A}" == "$guard_path" ]]; then
      recovery_cleanup_temporary_files
      trap - EXIT
      print -u2 "The durable recovery manifest aliases a protected path; the guard was retained"
      return 1
    fi
  done

  recovery_stop_palate || restore_failed=1
  (( ! restore_failed )) && recovery_assert_database_unopened || restore_failed=1
  (( ! restore_failed )) && recovery_verify_component "$guard_path/main" 1 "$main_hash" 600 "Protected main database" || restore_failed=1
  (( ! restore_failed )) && recovery_verify_component "$guard_path/wal" "$wal_present" "$wal_hash" 600 "Protected WAL" || restore_failed=1
  (( ! restore_failed )) && recovery_verify_component "$guard_path/shm" "$shm_present" "$shm_hash" 600 "Protected SHM" || restore_failed=1
  (( ! restore_failed )) && recovery_verify_component "$guard_path/journal" "$journal_present" "$journal_hash" 600 "Protected journal" || restore_failed=1
  (( ! restore_failed )) && recovery_prepare_component "$guard_path/main" "$main_temp_path" "$main_hash" || restore_failed=1
  if (( ! restore_failed && wal_present )); then
    recovery_prepare_component "$guard_path/wal" "$wal_temp_path" "$wal_hash" || restore_failed=1
  fi
  if (( ! restore_failed && shm_present )); then
    recovery_prepare_component "$guard_path/shm" "$shm_temp_path" "$shm_hash" || restore_failed=1
  fi
  if (( ! restore_failed && journal_present )); then
    recovery_prepare_component "$guard_path/journal" "$journal_temp_path" "$journal_hash" || restore_failed=1
  fi

  if (( ! restore_failed )); then
    rm -f -- "$database_path" "$database_path-wal" "$database_path-shm" "$database_path-journal" || restore_failed=1
  fi
  if (( ! restore_failed )); then
    mv -f -- "$main_temp_path" "$database_path" || restore_failed=1
    (( ! restore_failed )) && chmod "$main_mode" "$database_path" || restore_failed=1
    if (( ! restore_failed && wal_present )); then
      mv -f -- "$wal_temp_path" "$database_path-wal" || restore_failed=1
      (( ! restore_failed )) && chmod "$wal_mode" "$database_path-wal" || restore_failed=1
    fi
    if (( ! restore_failed && shm_present )); then
      mv -f -- "$shm_temp_path" "$database_path-shm" || restore_failed=1
      (( ! restore_failed )) && chmod "$shm_mode" "$database_path-shm" || restore_failed=1
    fi
    if (( ! restore_failed && journal_present )); then
      mv -f -- "$journal_temp_path" "$database_path-journal" || restore_failed=1
      (( ! restore_failed )) && chmod "$journal_mode" "$database_path-journal" || restore_failed=1
    fi
  fi

  (( ! restore_failed )) && recovery_verify_component "$database_path" 1 "$main_hash" "$main_mode" "Restored main database" || restore_failed=1
  (( ! restore_failed )) && recovery_verify_component "$database_path-wal" "$wal_present" "$wal_hash" "$wal_mode" "Restored WAL" || restore_failed=1
  (( ! restore_failed )) && recovery_verify_component "$database_path-shm" "$shm_present" "$shm_hash" "$shm_mode" "Restored SHM" || restore_failed=1
  (( ! restore_failed )) && recovery_verify_component "$database_path-journal" "$journal_present" "$journal_hash" "$journal_mode" "Restored journal" || restore_failed=1
  (( ! restore_failed )) && recovery_durability_sync recovery-restored-database || restore_failed=1

  if (( ! restore_failed )); then
    for key in "${launch_environment_keys[@]}"; do
      was_set="$(jq -r --arg key "$key" 'if .launchEnvironment[$key].wasSet then 1 else 0 end' "$manifest_path")"
      value="$(jq -r --arg key "$key" '.launchEnvironment[$key].value' "$manifest_path")"
      if (( was_set )); then
        if ! launchctl setenv "$key" "$value" \
          || [[ "$(launchctl getenv "$key" 2>/dev/null || true)" != "$value" ]] \
          || ! recovery_launch_environment_key_is_set "$key"; then
          print -u2 "Failed to exactly restore launch environment value: $key"
          restore_failed=1
        fi
      else
        if ! launchctl unsetenv "$key" || recovery_launch_environment_key_is_set "$key"; then
          print -u2 "Failed to exactly unset launch environment value: $key"
          restore_failed=1
        fi
      fi
    done
  fi
  if (( ! restore_failed )); then
    recovery_cleanup_raw_databases || restore_failed=1
  fi
  if (( ! restore_failed )); then
    if recovery_remove_guard; then
      guard_removed=1
      if ! recovery_durability_sync recovery-guard-removed; then
        print -u2 "The database and launch environment were restored, but durable guard deletion could not be confirmed"
        restore_failed=1
      fi
    else
      restore_failed=1
    fi
  fi
  if (( restore_failed )); then
    recovery_cleanup_temporary_files
    trap - EXIT
    if (( guard_removed )); then
      print -u2 "Stale-guard recovery did not complete successfully; the guard is no longer present: $guard_path"
    else
      print -u2 "Stale-guard recovery failed; the durable guard was retained: $guard_path"
    fi
    return 1
  fi

  recovery_cleanup_temporary_files
  trap - EXIT
  print "RECOVERED_STALE_GUARD database=$database_path restored_sha256=$main_hash"
}

if (( RECOVER_STALE_GUARD )); then
  recover_stale_guard
  exit $?
fi

if [[ ! -d "$APP_PATH" || ! -x "$APP_PATH/Palate" || ! -s "$APP_PATH/main.jsbundle" ]]; then
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
if (( CAPTURE_REFERENCE_DATABASE_PROVIDED )) && [[ -z "$CAPTURE_REFERENCE_DATABASE_PATH" ]]; then
  print -u2 -- "--capture-reference-database requires a nonempty output path"
  exit 2
fi
if (( CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_PROVIDED )) \
  && { [[ ! "$CAPTURE_EXPECTED_CALENDAR_LINK_COUNT" =~ ^[0-9]+$ ]] \
    || (( CAPTURE_EXPECTED_CALENDAR_LINK_COUNT < 1 )); }; then
  print -u2 -- "--capture-expected-calendar-link-count must be a positive integer"
  exit 2
fi
if (( CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_PROVIDED && ! CAPTURE_REFERENCE_DATABASE_PROVIDED )); then
  print -u2 -- "--capture-expected-calendar-link-count requires --capture-reference-database"
  exit 2
fi
if (( ALLOW_REFERENCE_FIXTURE_GROWTH )) && [[ -z "$REFERENCE_DATABASE_PATH" ]]; then
  print -u2 -- "--allow-reference-fixture-growth requires --reference-database"
  exit 2
fi
if [[ -n "$REFERENCE_DATABASE_PATH" ]] && (( CAPTURE_REFERENCE_DATABASE_PROVIDED )); then
  print -u2 -- "--capture-reference-database is incompatible with --reference-database"
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
if (( PHOTO_SCAN_STRATEGY_PROVIDED )) \
  && [[ "$PHOTO_SCAN_STRATEGY" != "legacy" && "$PHOTO_SCAN_STRATEGY" != "incremental" ]]; then
  print -u2 -- "--photo-scan-strategy must be legacy or incremental"
  exit 2
fi
if [[ -n "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" ]] \
  && [[ "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" != "legacy" \
    && "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" != "identifier-list" \
    && "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" != "database-backed" ]]; then
  print -u2 -- "--expected-photo-scan-implementation must be legacy, identifier-list, or database-backed"
  exit 2
fi

EFFECTIVE_PHOTO_SCAN_STRATEGY="${PHOTO_SCAN_STRATEGY:-$NATIVE_DEFAULT_PHOTO_SCAN_STRATEGY}"
if (( CAPTURE_REFERENCE_DATABASE_PROVIDED )) \
  && [[ "$EFFECTIVE_PHOTO_SCAN_STRATEGY" != "incremental" ]]; then
  print -u2 -- "--capture-reference-database requires an incremental Photo scan"
  exit 2
fi
if (( ALLOW_REFERENCE_FIXTURE_GROWTH )) \
  && [[ "$EFFECTIVE_PHOTO_SCAN_STRATEGY" != "incremental" ]]; then
  print -u2 -- "--allow-reference-fixture-growth requires an incremental Photo scan"
  exit 2
fi
if (( CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_PROVIDED )) \
  && (( CAPTURE_EXPECTED_CALENDAR_LINK_COUNT < EXPECTED_CALENDAR_LINK_COUNT )); then
  print -u2 -- "--capture-expected-calendar-link-count must not be below --expected-calendar-link-count"
  exit 2
fi
REFERENCE_CAPTURE_MODE="$CAPTURE_REFERENCE_DATABASE_PROVIDED"
BOOTSTRAP_CAPTURE_GROWTH_MODE="$CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_PROVIDED"
REFERENCE_FIXTURE_GROWTH_MODE="$ALLOW_REFERENCE_FIXTURE_GROWTH"
if (( CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_PROVIDED )); then
  CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_JSON="$CAPTURE_EXPECTED_CALENDAR_LINK_COUNT"
else
  CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_JSON=null
fi
if [[ "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" == "legacy" \
  && "$EFFECTIVE_PHOTO_SCAN_STRATEGY" != "legacy" ]] \
  || [[ -n "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" \
    && "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" != "legacy" \
    && "$EFFECTIVE_PHOTO_SCAN_STRATEGY" != "incremental" ]]; then
  print -u2 "Expected Photo scan implementation is incompatible with the requested strategy"
  exit 2
fi
if (( PHOTO_SCAN_STRATEGY_PROVIDED )); then
  REQUESTED_PHOTO_SCAN_STRATEGY_LABEL="$PHOTO_SCAN_STRATEGY"
  REQUESTED_PHOTO_SCAN_STRATEGY_JSON="\"$PHOTO_SCAN_STRATEGY\""
else
  REQUESTED_PHOTO_SCAN_STRATEGY_LABEL="native-default"
  REQUESTED_PHOTO_SCAN_STRATEGY_JSON=null
fi

VALIDATION_RUN_ID="calendar-query-$QUERY_STRATEGY-photo-$EFFECTIVE_PHOTO_SCAN_STRATEGY-$$-$(date +%s)-$RANDOM"
SNAPSHOT_PATH="$OUTPUT_PREFIX.$VALIDATION_RUN_ID.original.db"
SNAPSHOT_TEMP_PATH="$SNAPSHOT_PATH.tmp"
SNAPSHOT_WAL_PATH="$SNAPSHOT_PATH-wal"
SNAPSHOT_SHM_PATH="$SNAPSHOT_PATH-shm"
SNAPSHOT_JOURNAL_PATH="$SNAPSHOT_PATH-journal"
RUN_DATABASE_PATH="$OUTPUT_PREFIX.result.db"
RUN_DATABASE_TEMP_PATH="$RUN_DATABASE_PATH.tmp-$VALIDATION_RUN_ID"
SAMPLES_PATH="$OUTPUT_PREFIX.samples.tsv"
REPORT_PATH="$OUTPUT_PREFIX.json"
REPORT_TEMP_PATH="$REPORT_PATH.tmp-$VALIDATION_RUN_ID"
REPORT_RESTORED_TEMP_PATH="$REPORT_PATH.restored.tmp-$VALIDATION_RUN_ID"
TRIGGER_PATH="$OUTPUT_PREFIX.trigger"
ATTESTATION_PATH="$DATABASE_PATH.calendar-validation-$VALIDATION_RUN_ID.json"
PHOTO_SCAN_ATTESTATION_PATH="$DATABASE_PATH.photo-scan-validation-$VALIDATION_RUN_ID.json"
RESTORE_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.tmp"
ATTESTATION_DIRECTORY="$(dirname "$ATTESTATION_PATH")"
ATTESTATION_TIMEOUT_SECONDS=60
TRIGGER_MAX_AGE_SECONDS=30
TARGET_SAMPLING_INTERVAL_SECONDS=0.2
SNAPSHOT_READY=0
GUARD_READY=0
RESTORED=0
CAPTURE_REFERENCE_OUTPUT_CREATED=0
DEFER_GUARD_REMOVAL=0
ORIGINAL_SHA256=""
DATABASE_PATH="${DATABASE_PATH:A}"
APP_PATH="${APP_PATH:A}"
DATABASE_LOCK_PATH="$DATABASE_PATH.palate-calendar-validation.lock"
DATABASE_GUARD_PATH="$DATABASE_PATH.palate-calendar-validation.guard"
DATABASE_GUARD_STAGE_PATH="$DATABASE_GUARD_PATH.staging"
GUARD_MAIN_PATH="$DATABASE_GUARD_PATH/main"
GUARD_WAL_PATH="$DATABASE_GUARD_PATH/wal"
GUARD_SHM_PATH="$DATABASE_GUARD_PATH/shm"
GUARD_JOURNAL_PATH="$DATABASE_GUARD_PATH/journal"
GUARD_MANIFEST_PATH="$DATABASE_GUARD_PATH/manifest.json"
GUARD_STAGE_MAIN_PATH="$DATABASE_GUARD_STAGE_PATH/main"
GUARD_STAGE_WAL_PATH="$DATABASE_GUARD_STAGE_PATH/wal"
GUARD_STAGE_SHM_PATH="$DATABASE_GUARD_STAGE_PATH/shm"
GUARD_STAGE_JOURNAL_PATH="$DATABASE_GUARD_STAGE_PATH/journal"
GUARD_STAGE_MANIFEST_PATH="$DATABASE_GUARD_STAGE_PATH/manifest.json"
INSTALL_TEMP_PATH="$DATABASE_PATH.install-$VALIDATION_RUN_ID.tmp"
RESTORE_WAL_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.wal.tmp"
RESTORE_SHM_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.shm.tmp"
RESTORE_JOURNAL_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.journal.tmp"
ORIGINAL_WAL_PRESENT=0
ORIGINAL_SHM_PRESENT=0
ORIGINAL_JOURNAL_PRESENT=0
ORIGINAL_WAL_SHA256=""
ORIGINAL_SHM_SHA256=""
ORIGINAL_JOURNAL_SHA256=""
ORIGINAL_MAIN_MODE=""
ORIGINAL_WAL_MODE=""
ORIGINAL_SHM_MODE=""
ORIGINAL_JOURNAL_MODE=""
if (( REFERENCE_CAPTURE_MODE )); then
  CAPTURE_REFERENCE_DATABASE_PATH="${CAPTURE_REFERENCE_DATABASE_PATH:A}"
  CAPTURE_REFERENCE_TEMP_PATH="$CAPTURE_REFERENCE_DATABASE_PATH.tmp-$VALIDATION_RUN_ID"
  CAPTURE_REFERENCE_DIRECTORY="${CAPTURE_REFERENCE_DATABASE_PATH:h}"
  if [[ ! -d "$CAPTURE_REFERENCE_DIRECTORY" || ! -w "$CAPTURE_REFERENCE_DIRECTORY" ]]; then
    print -u2 "The reference-capture output directory must exist and be writable: $CAPTURE_REFERENCE_DIRECTORY"
    exit 2
  fi
  for capture_output_path in \
    "$CAPTURE_REFERENCE_DATABASE_PATH" \
    "$CAPTURE_REFERENCE_DATABASE_PATH-wal" \
    "$CAPTURE_REFERENCE_DATABASE_PATH-shm" \
    "$CAPTURE_REFERENCE_DATABASE_PATH-journal"; do
    if [[ -e "$capture_output_path" || -L "$capture_output_path" ]]; then
      print -u2 "Refusing to overwrite an existing reference-capture database component: $capture_output_path"
      exit 2
    fi
  done
else
  CAPTURE_REFERENCE_TEMP_PATH="$OUTPUT_PREFIX.reference-capture.tmp-$VALIDATION_RUN_ID"
fi
if [[ -n "$REFERENCE_DATABASE_PATH" ]]; then
  REFERENCE_DATABASE_PATH="${REFERENCE_DATABASE_PATH:A}"
  if [[ "$REFERENCE_DATABASE_PATH" == "${RUN_DATABASE_PATH:A}" ]] \
    || [[ -e "$RUN_DATABASE_PATH" && "$REFERENCE_DATABASE_PATH" -ef "$RUN_DATABASE_PATH" ]]; then
    print -u2 "--reference-database must not alias the result database output"
    exit 2
  fi
fi

if (( REFERENCE_CAPTURE_MODE )); then
  typeset -a CAPTURE_RESERVED_PATHS=(
    "$DATABASE_PATH-wal"
    "$DATABASE_PATH-shm"
    "$DATABASE_PATH-journal"
    "$SNAPSHOT_PATH"
    "$SNAPSHOT_TEMP_PATH"
    "$SNAPSHOT_WAL_PATH"
    "$SNAPSHOT_SHM_PATH"
    "$SNAPSHOT_JOURNAL_PATH"
    "$RUN_DATABASE_PATH"
    "$RUN_DATABASE_TEMP_PATH"
    "$SAMPLES_PATH"
    "$REPORT_PATH"
    "$REPORT_TEMP_PATH"
    "$REPORT_RESTORED_TEMP_PATH"
    "$TRIGGER_PATH"
    "$ATTESTATION_PATH"
    "$PHOTO_SCAN_ATTESTATION_PATH"
    "$RESTORE_TEMP_PATH"
    "$RESTORE_WAL_TEMP_PATH"
    "$RESTORE_SHM_TEMP_PATH"
    "$RESTORE_JOURNAL_TEMP_PATH"
    "$INSTALL_TEMP_PATH"
    "$CAPTURE_REFERENCE_TEMP_PATH"
    "$DATABASE_LOCK_PATH"
    "$DATABASE_GUARD_PATH"
    "$DATABASE_GUARD_STAGE_PATH"
  )
  for reserved_path in "${CAPTURE_RESERVED_PATHS[@]}"; do
    if [[ "$CAPTURE_REFERENCE_DATABASE_PATH" == "${reserved_path:A}" ]] \
      || [[ -e "$reserved_path" && "$CAPTURE_REFERENCE_DATABASE_PATH" -ef "$reserved_path" ]]; then
      print -u2 "Reference-capture output must not alias another output artifact: $reserved_path"
      exit 2
    fi
  done
fi

typeset -a OUTPUT_ARTIFACT_PATHS=(
  "$SNAPSHOT_PATH"
  "$SNAPSHOT_TEMP_PATH"
  "$SNAPSHOT_WAL_PATH"
  "$SNAPSHOT_SHM_PATH"
  "$SNAPSHOT_JOURNAL_PATH"
  "$RUN_DATABASE_PATH"
  "$RUN_DATABASE_TEMP_PATH"
  "$SAMPLES_PATH"
  "$REPORT_PATH"
  "$REPORT_TEMP_PATH"
  "$REPORT_RESTORED_TEMP_PATH"
  "$TRIGGER_PATH"
  "$ATTESTATION_PATH"
  "$PHOTO_SCAN_ATTESTATION_PATH"
  "$RESTORE_TEMP_PATH"
  "$RESTORE_WAL_TEMP_PATH"
  "$RESTORE_SHM_TEMP_PATH"
  "$RESTORE_JOURNAL_TEMP_PATH"
  "$INSTALL_TEMP_PATH"
  "$CAPTURE_REFERENCE_TEMP_PATH"
  "$DATABASE_LOCK_PATH"
  "$DATABASE_GUARD_PATH"
  "$DATABASE_GUARD_STAGE_PATH"
)
if (( REFERENCE_CAPTURE_MODE )); then
  OUTPUT_ARTIFACT_PATHS+=("$CAPTURE_REFERENCE_DATABASE_PATH")
fi
for artifact_path in "${OUTPUT_ARTIFACT_PATHS[@]}"; do
  if [[ "${artifact_path:A}" == "$DATABASE_PATH" ]] \
    || [[ -e "$artifact_path" && "$artifact_path" -ef "$DATABASE_PATH" ]]; then
    print -u2 "Output artifact must not alias the live database: $artifact_path"
    exit 2
  fi
  if [[ -n "$REFERENCE_DATABASE_PATH" ]] \
    && { [[ "${artifact_path:A}" == "$REFERENCE_DATABASE_PATH" ]] \
      || [[ -e "$artifact_path" && "$artifact_path" -ef "$REFERENCE_DATABASE_PATH" ]]; }; then
    print -u2 "Output artifact must not alias the parity reference: $artifact_path"
    exit 2
  fi
done
for retained_path in "$SAMPLES_PATH" "$REPORT_PATH"; do
  if [[ -e "$retained_path" ]]; then
    print -u2 "Refusing to overwrite an existing retained artifact: $retained_path"
    exit 2
  fi
done
if (( RETAIN_RAW_DATABASES )) && [[ -e "$RUN_DATABASE_PATH" ]]; then
  print -u2 "Refusing to overwrite an existing retained artifact: $RUN_DATABASE_PATH"
  exit 2
fi
if [[ ! -d "$ATTESTATION_DIRECTORY" || ! -w "$ATTESTATION_DIRECTORY" ]]; then
  print -u2 "The live database directory must be writable for native attestation: $ATTESTATION_DIRECTORY"
  exit 1
fi

for dependency in awk codesign jq lockf lsof pgrep pkill ps sed shasum sqlite3 stat; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    print -u2 "Missing dependency: $dependency"
    exit 2
  fi
done

exec 9> "$DATABASE_LOCK_PATH"
chmod 600 "$DATABASE_LOCK_PATH"
if ! lockf -s -t 0 9; then
  print -u2 "Another Calendar/Photo validation already owns this database lock: $DATABASE_LOCK_PATH"
  exit 75
fi
mkdir -p "$(dirname "$OUTPUT_PREFIX")"

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
APP_EXECUTABLE_SHA256="$(shasum -a 256 "$APP_PATH/Palate" | awk '{print $1}')"
APP_BUNDLE_SHA256="$(shasum -a 256 "$APP_PATH/main.jsbundle" | awk '{print $1}')"

if [[ -L "$DATABASE_GUARD_PATH" || -L "$DATABASE_GUARD_STAGE_PATH" ]]; then
  print -u2 "Refusing a symlinked database recovery guard"
  exit 1
fi
if [[ -e "$DATABASE_GUARD_PATH" ]]; then
  print -u2 "A durable recovery guard from an interrupted validation must be restored before continuing: $DATABASE_GUARD_PATH"
  exit 74
fi
if [[ -e "$DATABASE_GUARD_STAGE_PATH" ]]; then
  rm -rf -- "$DATABASE_GUARD_STAGE_PATH"
fi

launch_environment_key_is_set() {
  local key="$1"
  launchctl print "gui/$UID" 2>/dev/null \
    | awk -v key="$key" '$1 == key && $2 == "=>" { found = 1 } END { exit !found }'
}

ORIGINAL_QUERY_STRATEGY="$(launchctl getenv PALATE_CALENDAR_QUERY_STRATEGY 2>/dev/null || true)"
ORIGINAL_QUERY_GAP_DAYS="$(launchctl getenv PALATE_CALENDAR_QUERY_GAP_DAYS 2>/dev/null || true)"
ORIGINAL_VALIDATION_RUN_ID="$(launchctl getenv PALATE_CALENDAR_VALIDATION_RUN_ID 2>/dev/null || true)"
ORIGINAL_ATTESTATION_PATH="$(launchctl getenv PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH 2>/dev/null || true)"
ORIGINAL_RESULT_PAGE_SIZE="$(launchctl getenv PALATE_VISION_RESULT_PAGE_SIZE 2>/dev/null || true)"
ORIGINAL_CLASSIFICATION_STRATEGY="$(launchctl getenv PALATE_VISION_CLASSIFICATION_STRATEGY 2>/dev/null || true)"
ORIGINAL_VISION_CONCURRENCY="$(launchctl getenv PALATE_VISION_CONCURRENCY 2>/dev/null || true)"
ORIGINAL_PIPELINE_DEPTH="$(launchctl getenv PALATE_VISION_PIPELINE_DEPTH 2>/dev/null || true)"
ORIGINAL_PHOTO_SCAN_STRATEGY="$(launchctl getenv PALATE_PHOTO_SCAN_STRATEGY 2>/dev/null || true)"
ORIGINAL_PHOTO_VALIDATION_RUN_ID="$(launchctl getenv PALATE_PHOTO_SCAN_VALIDATION_RUN_ID 2>/dev/null || true)"
ORIGINAL_PHOTO_ATTESTATION_PATH="$(launchctl getenv PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH 2>/dev/null || true)"
ORIGINAL_QUERY_STRATEGY_SET=0
ORIGINAL_QUERY_GAP_DAYS_SET=0
ORIGINAL_VALIDATION_RUN_ID_SET=0
ORIGINAL_ATTESTATION_PATH_SET=0
ORIGINAL_RESULT_PAGE_SIZE_SET=0
ORIGINAL_CLASSIFICATION_STRATEGY_SET=0
ORIGINAL_VISION_CONCURRENCY_SET=0
ORIGINAL_PIPELINE_DEPTH_SET=0
ORIGINAL_PHOTO_SCAN_STRATEGY_SET=0
ORIGINAL_PHOTO_VALIDATION_RUN_ID_SET=0
ORIGINAL_PHOTO_ATTESTATION_PATH_SET=0
launch_environment_key_is_set PALATE_CALENDAR_QUERY_STRATEGY && ORIGINAL_QUERY_STRATEGY_SET=1
launch_environment_key_is_set PALATE_CALENDAR_QUERY_GAP_DAYS && ORIGINAL_QUERY_GAP_DAYS_SET=1
launch_environment_key_is_set PALATE_CALENDAR_VALIDATION_RUN_ID && ORIGINAL_VALIDATION_RUN_ID_SET=1
launch_environment_key_is_set PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH && ORIGINAL_ATTESTATION_PATH_SET=1
launch_environment_key_is_set PALATE_VISION_RESULT_PAGE_SIZE && ORIGINAL_RESULT_PAGE_SIZE_SET=1
launch_environment_key_is_set PALATE_VISION_CLASSIFICATION_STRATEGY && ORIGINAL_CLASSIFICATION_STRATEGY_SET=1
launch_environment_key_is_set PALATE_VISION_CONCURRENCY && ORIGINAL_VISION_CONCURRENCY_SET=1
launch_environment_key_is_set PALATE_VISION_PIPELINE_DEPTH && ORIGINAL_PIPELINE_DEPTH_SET=1
launch_environment_key_is_set PALATE_PHOTO_SCAN_STRATEGY && ORIGINAL_PHOTO_SCAN_STRATEGY_SET=1
launch_environment_key_is_set PALATE_PHOTO_SCAN_VALIDATION_RUN_ID && ORIGINAL_PHOTO_VALIDATION_RUN_ID_SET=1
launch_environment_key_is_set PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH && ORIGINAL_PHOTO_ATTESTATION_PATH_SET=1

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
  rm -f -- "$database_path-wal" "$database_path-shm" "$database_path-journal"
}

remove_database_set() {
  local database_path="$1"
  local removal_failed=0
  rm -f -- "$database_path" || removal_failed=1
  remove_database_sidecars "$database_path" || removal_failed=1
  (( removal_failed == 0 ))
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

durability_sync() {
  local phase="${1:-unspecified}"
  if [[ -n "${PALATE_CALENDAR_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_CALENDAR_HARNESS_FAKE_STATE" \
    && "${PALATE_CALENDAR_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE:-}" == "$phase" ]]; then
    print -u2 "Injected durability sync failure: $phase"
    return 1
  fi
  if [[ "${PALATE_CALENDAR_HARNESS_TEST_SKIP_DURABILITY_SYNC:-0}" == "1" \
    && -n "${PALATE_CALENDAR_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_CALENDAR_HARNESS_FAKE_STATE" ]]; then
    return 0
  fi
  /bin/sync
}

remove_database_guard() {
  if [[ -n "${PALATE_CALENDAR_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_CALENDAR_HARNESS_FAKE_STATE" \
    && "${PALATE_CALENDAR_HARNESS_TEST_FAIL_GUARD_REMOVAL:-0}" == "1" ]]; then
    print -u2 "Injected durable recovery guard removal failure"
    return 1
  fi
  rm -rf -- "$DATABASE_GUARD_PATH" || return 1
  if [[ -e "$DATABASE_GUARD_PATH" ]]; then
    print -u2 "The durable recovery guard still exists after removal: $DATABASE_GUARD_PATH"
    return 1
  fi
}

copy_and_attest_private() {
  local source_path="$1"
  local destination_path="$2"
  local temporary_path="$destination_path.tmp-$VALIDATION_RUN_ID"
  local source_hash_before source_hash_after destination_hash
  source_hash_before="$(sha256_file "$source_path")"
  rm -f -- "$temporary_path"
  cp "$source_path" "$temporary_path"
  chmod 600 "$temporary_path"
  source_hash_after="$(sha256_file "$source_path")"
  destination_hash="$(sha256_file "$temporary_path")"
  if [[ "$source_hash_before" != "$source_hash_after" || "$source_hash_before" != "$destination_hash" ]]; then
    rm -f -- "$temporary_path"
    print -u2 "Database component changed while it was being copied: $source_path"
    return 1
  fi
  mv -f -- "$temporary_path" "$destination_path"
  print -r -- "$source_hash_before"
}

assert_database_unopened() {
  local holder_output
  local -a database_paths=("$DATABASE_PATH")
  [[ -e "$DATABASE_PATH-wal" ]] && database_paths+=("$DATABASE_PATH-wal")
  [[ -e "$DATABASE_PATH-shm" ]] && database_paths+=("$DATABASE_PATH-shm")
  [[ -e "$DATABASE_PATH-journal" ]] && database_paths+=("$DATABASE_PATH-journal")
  holder_output="$(lsof -Fn -- "${database_paths[@]}" 2>/dev/null || true)"
  if [[ -n "$holder_output" ]]; then
    print -u2 "Another process still has the live database or a sidecar open"
    return 1
  fi
}

verify_optional_component() {
  local component_path="$1"
  local expected_present="$2"
  local expected_hash="$3"
  local expected_mode="$4"
  local label="$5"
  if (( expected_present )); then
    if [[ ! -f "$component_path" || -L "$component_path" \
      || "$(sha256_file "$component_path")" != "$expected_hash" ]]; then
      print -u2 "$label no longer matches its protected copy"
      return 1
    fi
    if [[ -n "$expected_mode" && "$(stat -f '%Lp' "$component_path")" != "$expected_mode" ]]; then
      print -u2 "$label mode no longer matches its protected copy"
      return 1
    fi
  elif [[ -e "$component_path" ]]; then
    print -u2 "$label appeared even though it was absent from the protected set"
    return 1
  fi
}

capture_database_guard() {
  local main_size wal_size=0 shm_size=0 journal_size=0
  stop_palate
  assert_database_unopened
  mkdir -m 700 "$DATABASE_GUARD_STAGE_PATH"

  ORIGINAL_MAIN_MODE="$(stat -f '%Lp' "$DATABASE_PATH")"
  main_size="$(stat -f '%z' "$DATABASE_PATH")"
  ORIGINAL_SHA256="$(copy_and_attest_private "$DATABASE_PATH" "$GUARD_STAGE_MAIN_PATH")"
  if [[ -f "$DATABASE_PATH-wal" ]]; then
    ORIGINAL_WAL_PRESENT=1
    ORIGINAL_WAL_MODE="$(stat -f '%Lp' "$DATABASE_PATH-wal")"
    wal_size="$(stat -f '%z' "$DATABASE_PATH-wal")"
    ORIGINAL_WAL_SHA256="$(copy_and_attest_private "$DATABASE_PATH-wal" "$GUARD_STAGE_WAL_PATH")"
  fi
  if [[ -f "$DATABASE_PATH-shm" ]]; then
    ORIGINAL_SHM_PRESENT=1
    ORIGINAL_SHM_MODE="$(stat -f '%Lp' "$DATABASE_PATH-shm")"
    shm_size="$(stat -f '%z' "$DATABASE_PATH-shm")"
    ORIGINAL_SHM_SHA256="$(copy_and_attest_private "$DATABASE_PATH-shm" "$GUARD_STAGE_SHM_PATH")"
  fi
  if [[ -f "$DATABASE_PATH-journal" ]]; then
    ORIGINAL_JOURNAL_PRESENT=1
    ORIGINAL_JOURNAL_MODE="$(stat -f '%Lp' "$DATABASE_PATH-journal")"
    journal_size="$(stat -f '%z' "$DATABASE_PATH-journal")"
    ORIGINAL_JOURNAL_SHA256="$(copy_and_attest_private "$DATABASE_PATH-journal" "$GUARD_STAGE_JOURNAL_PATH")"
  fi

  if [[ "$(sha256_file "$DATABASE_PATH")" != "$ORIGINAL_SHA256" ]]; then
    print -u2 "Live main database changed before the recovery guard was sealed"
    return 1
  fi
  verify_optional_component "$DATABASE_PATH-wal" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "$ORIGINAL_WAL_MODE" "Live WAL"
  verify_optional_component "$DATABASE_PATH-shm" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "$ORIGINAL_SHM_MODE" "Live SHM"
  verify_optional_component "$DATABASE_PATH-journal" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "$ORIGINAL_JOURNAL_MODE" "Live journal"

  jq -n \
    --arg databasePath "$DATABASE_PATH" \
    --arg runId "$VALIDATION_RUN_ID" \
    --arg mainSha256 "$ORIGINAL_SHA256" \
    --arg mainMode "$ORIGINAL_MAIN_MODE" \
    --argjson mainSize "$main_size" \
    --argjson walPresent "$ORIGINAL_WAL_PRESENT" \
    --arg walSha256 "$ORIGINAL_WAL_SHA256" \
    --arg walMode "$ORIGINAL_WAL_MODE" \
    --argjson walSize "$wal_size" \
    --argjson shmPresent "$ORIGINAL_SHM_PRESENT" \
    --arg shmSha256 "$ORIGINAL_SHM_SHA256" \
    --arg shmMode "$ORIGINAL_SHM_MODE" \
    --argjson shmSize "$shm_size" \
    --argjson journalPresent "$ORIGINAL_JOURNAL_PRESENT" \
    --arg journalSha256 "$ORIGINAL_JOURNAL_SHA256" \
    --arg journalMode "$ORIGINAL_JOURNAL_MODE" \
    --argjson journalSize "$journal_size" \
    --arg queryStrategy "$ORIGINAL_QUERY_STRATEGY" \
    --argjson queryStrategySet "$ORIGINAL_QUERY_STRATEGY_SET" \
    --arg queryGapDays "$ORIGINAL_QUERY_GAP_DAYS" \
    --argjson queryGapDaysSet "$ORIGINAL_QUERY_GAP_DAYS_SET" \
    --arg validationRunId "$ORIGINAL_VALIDATION_RUN_ID" \
    --argjson validationRunIdSet "$ORIGINAL_VALIDATION_RUN_ID_SET" \
    --arg attestationPath "$ORIGINAL_ATTESTATION_PATH" \
    --argjson attestationPathSet "$ORIGINAL_ATTESTATION_PATH_SET" \
    --arg resultPageSize "$ORIGINAL_RESULT_PAGE_SIZE" \
    --argjson resultPageSizeSet "$ORIGINAL_RESULT_PAGE_SIZE_SET" \
    --arg classificationStrategy "$ORIGINAL_CLASSIFICATION_STRATEGY" \
    --argjson classificationStrategySet "$ORIGINAL_CLASSIFICATION_STRATEGY_SET" \
    --arg visionConcurrency "$ORIGINAL_VISION_CONCURRENCY" \
    --argjson visionConcurrencySet "$ORIGINAL_VISION_CONCURRENCY_SET" \
    --arg pipelineDepth "$ORIGINAL_PIPELINE_DEPTH" \
    --argjson pipelineDepthSet "$ORIGINAL_PIPELINE_DEPTH_SET" \
    --arg photoScanStrategy "$ORIGINAL_PHOTO_SCAN_STRATEGY" \
    --argjson photoScanStrategySet "$ORIGINAL_PHOTO_SCAN_STRATEGY_SET" \
    --arg photoValidationRunId "$ORIGINAL_PHOTO_VALIDATION_RUN_ID" \
    --argjson photoValidationRunIdSet "$ORIGINAL_PHOTO_VALIDATION_RUN_ID_SET" \
    --arg photoAttestationPath "$ORIGINAL_PHOTO_ATTESTATION_PATH" \
    --argjson photoAttestationPathSet "$ORIGINAL_PHOTO_ATTESTATION_PATH_SET" \
    --argjson retainRawDatabases "$RETAIN_RAW_DATABASES" \
    --arg snapshotPath "${SNAPSHOT_PATH:A}" \
    --arg resultDatabasePath "${RUN_DATABASE_PATH:A}" \
    --arg referenceCapturePath "$CAPTURE_REFERENCE_DATABASE_PATH" \
    --argjson referenceCaptureRequested "$REFERENCE_CAPTURE_MODE" \
    --arg snapshotTempPath "${SNAPSHOT_TEMP_PATH:A}" \
    --arg runDatabaseTempPath "${RUN_DATABASE_TEMP_PATH:A}" \
    --arg installTempPath "${INSTALL_TEMP_PATH:A}" \
    --arg restoreMainTempPath "${RESTORE_TEMP_PATH:A}" \
    --arg restoreWalTempPath "${RESTORE_WAL_TEMP_PATH:A}" \
    --arg restoreShmTempPath "${RESTORE_SHM_TEMP_PATH:A}" \
    --arg restoreJournalTempPath "${RESTORE_JOURNAL_TEMP_PATH:A}" \
    --arg captureReferenceTempPath "${CAPTURE_REFERENCE_TEMP_PATH:A}" \
    '{
      schemaVersion: 1,
      databasePath: $databasePath,
      createdByRunId: $runId,
      components: {
        main: {present: true, sha256: $mainSha256, size: $mainSize, mode: $mainMode},
        wal: {present: ($walPresent == 1), sha256: (if $walPresent == 1 then $walSha256 else null end), size: (if $walPresent == 1 then $walSize else null end), mode: (if $walPresent == 1 then $walMode else null end)},
        shm: {present: ($shmPresent == 1), sha256: (if $shmPresent == 1 then $shmSha256 else null end), size: (if $shmPresent == 1 then $shmSize else null end), mode: (if $shmPresent == 1 then $shmMode else null end)},
        journal: {present: ($journalPresent == 1), sha256: (if $journalPresent == 1 then $journalSha256 else null end), size: (if $journalPresent == 1 then $journalSize else null end), mode: (if $journalPresent == 1 then $journalMode else null end)}
      },
      launchEnvironment: {
        PALATE_CALENDAR_QUERY_STRATEGY: {wasSet: ($queryStrategySet == 1), value: $queryStrategy},
        PALATE_CALENDAR_QUERY_GAP_DAYS: {wasSet: ($queryGapDaysSet == 1), value: $queryGapDays},
        PALATE_CALENDAR_VALIDATION_RUN_ID: {wasSet: ($validationRunIdSet == 1), value: $validationRunId},
        PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH: {wasSet: ($attestationPathSet == 1), value: $attestationPath},
        PALATE_VISION_RESULT_PAGE_SIZE: {wasSet: ($resultPageSizeSet == 1), value: $resultPageSize},
        PALATE_VISION_CLASSIFICATION_STRATEGY: {wasSet: ($classificationStrategySet == 1), value: $classificationStrategy},
        PALATE_VISION_CONCURRENCY: {wasSet: ($visionConcurrencySet == 1), value: $visionConcurrency},
        PALATE_VISION_PIPELINE_DEPTH: {wasSet: ($pipelineDepthSet == 1), value: $pipelineDepth},
        PALATE_PHOTO_SCAN_STRATEGY: {wasSet: ($photoScanStrategySet == 1), value: $photoScanStrategy},
        PALATE_PHOTO_SCAN_VALIDATION_RUN_ID: {wasSet: ($photoValidationRunIdSet == 1), value: $photoValidationRunId},
        PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH: {wasSet: ($photoAttestationPathSet == 1), value: $photoAttestationPath}
      },
      artifactCleanup: {
        retainRawDatabases: ($retainRawDatabases == 1),
        snapshotPath: $snapshotPath,
        resultDatabasePath: $resultDatabasePath,
        referenceCapturePath: (if $referenceCaptureRequested == 1 then $referenceCapturePath else null end),
        temporaryPaths: [
          $snapshotTempPath,
          $runDatabaseTempPath,
          $installTempPath,
          $restoreMainTempPath,
          $restoreWalTempPath,
          $restoreShmTempPath,
          $restoreJournalTempPath,
          $captureReferenceTempPath
        ]
      }
    }' > "$GUARD_STAGE_MANIFEST_PATH.tmp"
  chmod 600 "$GUARD_STAGE_MANIFEST_PATH.tmp"
  mv -f -- "$GUARD_STAGE_MANIFEST_PATH.tmp" "$GUARD_STAGE_MANIFEST_PATH"
  if ! durability_sync guard-stage; then
    return 1
  fi
  mv -- "$DATABASE_GUARD_STAGE_PATH" "$DATABASE_GUARD_PATH"
  if ! durability_sync guard-published; then
    return 1
  fi
  GUARD_READY=1
}

prepare_restore_file() {
  local protected_path="$1"
  local temporary_path="$2"
  local expected_hash="$3"
  if ! rm -f -- "$temporary_path"; then
    return 1
  fi
  if ! cp "$protected_path" "$temporary_path"; then
    return 1
  fi
  if ! chmod 600 "$temporary_path"; then
    return 1
  fi
  if [[ "$(sha256_file "$temporary_path")" != "$expected_hash" ]]; then
    print -u2 "Prepared restoration component hash mismatch: $protected_path"
    return 1
  fi
}

immutable_sqlite_uri() {
  local database_path="$1"
  local encoded_path
  encoded_path="$(jq -nr --arg path "${database_path:A}" '$path | @uri')"
  print -rn -- "file:$encoded_path?mode=ro&immutable=1"
}

logical_fixture_digest() {
  local database_path="$1"
  sqlite3 -readonly "$database_path" <<'SQL'
SELECT hex(sha3_query(
         'SELECT id,restaurantId,suggestedRestaurantId,status,startTime,endTime,centerLat,centerLon,photoCount,foodProbable,calendarEventId,calendarEventTitle,calendarEventLocation,calendarEventIsAllDay,notes,exportedToCalendarId,awardAtVisit FROM visits ORDER BY id',
         256
       )) || ':' ||
       hex(sha3_query(
         'SELECT id,uri,creationTime,latitude,longitude,visitId,foodDetected,foodLabels,foodConfidence,allLabels,mediaType,duration FROM photos ORDER BY id',
         256
       )) || ':' ||
       hex(sha3_query(
         'SELECT visitId,restaurantId,distance FROM visit_suggested_restaurants ORDER BY visitId,restaurantId',
         256
       )) || ':' ||
       hex(sha3_query(
         'SELECT key,value FROM app_metadata ORDER BY key',
         256
       ));
SQL
}

attest_process_bundle() {
  local process_executable process_app process_codesign_output
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

  PROCESS_EXECUTABLE_PATH="$process_executable"
  PROCESS_APP_PATH="$process_app"
  PROCESS_EXECUTABLE_SHA256="$(sha256_file "$process_executable")"
  PROCESS_BUNDLE_SHA256="$(sha256_file "$process_app/main.jsbundle")"
  if [[ "$PROCESS_EXECUTABLE_SHA256" != "$APP_EXECUTABLE_SHA256" \
    || "$PROCESS_BUNDLE_SHA256" != "$APP_BUNDLE_SHA256" ]]; then
    print -u2 "Running Palate bundle does not match --app"
    print -u2 "Executable expected=$APP_EXECUTABLE_SHA256 actual=$PROCESS_EXECUTABLE_SHA256"
    print -u2 "main.jsbundle expected=$APP_BUNDLE_SHA256 actual=$PROCESS_BUNDLE_SHA256"
    return 1
  fi
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
  if (( GUARD_READY && ! RESTORED )); then
    if ! stop_palate; then
      print -u2 "Cannot safely restore the database while Palate is running"
      restore_failed=1
    elif ! assert_database_unopened; then
      restore_failed=1
    elif [[ ! -f "$GUARD_MANIFEST_PATH" ]] \
      || ! jq -e \
        --arg databasePath "$DATABASE_PATH" \
        --arg runId "$VALIDATION_RUN_ID" \
        '.schemaVersion == 1 and .databasePath == $databasePath and .createdByRunId == $runId' \
        "$GUARD_MANIFEST_PATH" >/dev/null; then
      print -u2 "The durable database recovery manifest is missing or invalid: $GUARD_MANIFEST_PATH"
      restore_failed=1
    else
      if [[ ! -f "$GUARD_MAIN_PATH" || -L "$GUARD_MAIN_PATH" \
        || "$(sha256_file "$GUARD_MAIN_PATH")" != "$ORIGINAL_SHA256" ]]; then
        print -u2 "The protected main database is missing or corrupt"
        restore_failed=1
      fi
      verify_optional_component "$GUARD_WAL_PATH" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "" "Protected WAL" || restore_failed=1
      verify_optional_component "$GUARD_SHM_PATH" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "" "Protected SHM" || restore_failed=1
      verify_optional_component "$GUARD_JOURNAL_PATH" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "" "Protected journal" || restore_failed=1
      if (( ! restore_failed )); then
        prepare_restore_file "$GUARD_MAIN_PATH" "$RESTORE_TEMP_PATH" "$ORIGINAL_SHA256" || restore_failed=1
        if (( ORIGINAL_WAL_PRESENT )); then
          prepare_restore_file "$GUARD_WAL_PATH" "$RESTORE_WAL_TEMP_PATH" "$ORIGINAL_WAL_SHA256" || restore_failed=1
        fi
        if (( ORIGINAL_SHM_PRESENT )); then
          prepare_restore_file "$GUARD_SHM_PATH" "$RESTORE_SHM_TEMP_PATH" "$ORIGINAL_SHM_SHA256" || restore_failed=1
        fi
        if (( ORIGINAL_JOURNAL_PRESENT )); then
          prepare_restore_file "$GUARD_JOURNAL_PATH" "$RESTORE_JOURNAL_TEMP_PATH" "$ORIGINAL_JOURNAL_SHA256" || restore_failed=1
        fi
      fi
      if (( ! restore_failed )); then
        remove_database_set "$DATABASE_PATH" || restore_failed=1
        if (( ! restore_failed )); then
          mv -f -- "$RESTORE_TEMP_PATH" "$DATABASE_PATH" || restore_failed=1
          chmod "$ORIGINAL_MAIN_MODE" "$DATABASE_PATH" || restore_failed=1
        fi
        if (( ! restore_failed && ORIGINAL_WAL_PRESENT )); then
          mv -f -- "$RESTORE_WAL_TEMP_PATH" "$DATABASE_PATH-wal" || restore_failed=1
          chmod "$ORIGINAL_WAL_MODE" "$DATABASE_PATH-wal" || restore_failed=1
        fi
        if (( ! restore_failed && ORIGINAL_SHM_PRESENT )); then
          mv -f -- "$RESTORE_SHM_TEMP_PATH" "$DATABASE_PATH-shm" || restore_failed=1
          chmod "$ORIGINAL_SHM_MODE" "$DATABASE_PATH-shm" || restore_failed=1
        fi
        if (( ! restore_failed && ORIGINAL_JOURNAL_PRESENT )); then
          mv -f -- "$RESTORE_JOURNAL_TEMP_PATH" "$DATABASE_PATH-journal" || restore_failed=1
          chmod "$ORIGINAL_JOURNAL_MODE" "$DATABASE_PATH-journal" || restore_failed=1
        fi
      fi
      if (( ! restore_failed )); then
        if [[ "$(sha256_file "$DATABASE_PATH")" != "$ORIGINAL_SHA256" \
          || "$(stat -f '%Lp' "$DATABASE_PATH")" != "$ORIGINAL_MAIN_MODE" ]]; then
          print -u2 "Restored live database hash mismatch"
          restore_failed=1
        fi
        verify_optional_component "$DATABASE_PATH-wal" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "$ORIGINAL_WAL_MODE" "Restored WAL" || restore_failed=1
        verify_optional_component "$DATABASE_PATH-shm" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "$ORIGINAL_SHM_MODE" "Restored SHM" || restore_failed=1
        verify_optional_component "$DATABASE_PATH-journal" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "$ORIGINAL_JOURNAL_MODE" "Restored journal" || restore_failed=1
        if (( ! restore_failed )); then
          if ! durability_sync restore-database; then
            print -u2 "Failed to durably synchronize the restored database"
            restore_failed=1
          else
            RESTORED=1
          fi
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
  if ! restore_launch_environment_value PALATE_PHOTO_SCAN_STRATEGY "$ORIGINAL_PHOTO_SCAN_STRATEGY" "$ORIGINAL_PHOTO_SCAN_STRATEGY_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_PHOTO_SCAN_VALIDATION_RUN_ID "$ORIGINAL_PHOTO_VALIDATION_RUN_ID" "$ORIGINAL_PHOTO_VALIDATION_RUN_ID_SET"; then restore_failed=1; fi
  if ! restore_launch_environment_value PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH "$ORIGINAL_PHOTO_ATTESTATION_PATH" "$ORIGINAL_PHOTO_ATTESTATION_PATH_SET"; then restore_failed=1; fi

  rm -f -- "$ATTESTATION_PATH" "$ATTESTATION_PATH.tmp" "$PHOTO_SCAN_ATTESTATION_PATH" "$PHOTO_SCAN_ATTESTATION_PATH.tmp" "$SNAPSHOT_TEMP_PATH" "$RESTORE_TEMP_PATH" "$RESTORE_WAL_TEMP_PATH" "$RESTORE_SHM_TEMP_PATH" "$RESTORE_JOURNAL_TEMP_PATH" "$INSTALL_TEMP_PATH" "$RUN_DATABASE_TEMP_PATH" || restore_failed=1
  remove_database_sidecars "$SNAPSHOT_PATH" || restore_failed=1
  remove_database_sidecars "$RUN_DATABASE_PATH" || restore_failed=1
  remove_database_sidecars "$RESTORE_TEMP_PATH" || restore_failed=1
  if (( restore_failed == 0 && GUARD_READY && ! DEFER_GUARD_REMOVAL )); then
    if remove_database_guard; then
      GUARD_READY=0
      if ! durability_sync guard-removed; then
        print -u2 "The database was restored, but durable guard deletion could not be confirmed"
        restore_failed=1
      fi
    else
      print -u2 "Failed to remove the durable database recovery guard"
      restore_failed=1
    fi
  elif (( ! GUARD_READY )) && [[ -d "$DATABASE_GUARD_STAGE_PATH" && ! -L "$DATABASE_GUARD_STAGE_PATH" ]]; then
    rm -rf -- "$DATABASE_GUARD_STAGE_PATH" || restore_failed=1
  fi
  (( restore_failed == 0 ))
}

cleanup_sensitive_database_copies() {
  local cleanup_failed=0
  remove_database_set "$CAPTURE_REFERENCE_TEMP_PATH" || cleanup_failed=1
  if (( RETAIN_RAW_DATABASES )); then
    (( cleanup_failed == 0 ))
    return
  fi
  if [[ -n "${PALATE_CALENDAR_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_CALENDAR_HARNESS_FAKE_STATE" \
    && "${PALATE_CALENDAR_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP:-0}" == "1" ]]; then
    print -u2 "Injected default raw database cleanup failure"
    return 1
  fi
  remove_database_set "$SNAPSHOT_PATH" || cleanup_failed=1
  remove_database_set "$RUN_DATABASE_PATH" || cleanup_failed=1
  (( cleanup_failed == 0 ))
}

handle_signal() {
  local exit_code="$1"
  trap '' INT TERM HUP
  exit "$exit_code"
}

handle_exit() {
  local exit_code="$?"
  local capture_output_cleanup_failed=0
  trap '' INT TERM HUP
  trap - EXIT
  DEFER_GUARD_REMOVAL=0
  if (( exit_code != 0 && CAPTURE_REFERENCE_OUTPUT_CREATED )); then
    if remove_database_set "$CAPTURE_REFERENCE_DATABASE_PATH"; then
      CAPTURE_REFERENCE_OUTPUT_CREATED=0
      durability_sync failed-reference-capture-removed || capture_output_cleanup_failed=1
    else
      print -u2 "Failed to remove the reference-capture output after a later validation failure"
      capture_output_cleanup_failed=1
    fi
    if (( capture_output_cleanup_failed )); then
      DEFER_GUARD_REMOVAL=1
      exit_code=1
    fi
  fi
  if ! restore_database; then
    print -u2 "One or more restoration steps failed"
    (( exit_code == 0 )) && exit_code=1
  elif ! cleanup_sensitive_database_copies; then
    print -u2 "One or more sensitive database copies could not be removed"
    (( exit_code == 0 )) && exit_code=1
  fi
  if (( exit_code != 0 )); then
    rm -f -- "$REPORT_TEMP_PATH" "$REPORT_RESTORED_TEMP_PATH"
  fi
  exit "$exit_code"
}

trap handle_exit EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

capture_database_guard
rm -f -- "$SNAPSHOT_PATH" "$SNAPSHOT_TEMP_PATH"
remove_database_sidecars "$SNAPSHOT_PATH"
copy_and_attest_private "$GUARD_MAIN_PATH" "$SNAPSHOT_PATH" >/dev/null
(( ORIGINAL_WAL_PRESENT )) && copy_and_attest_private "$GUARD_WAL_PATH" "$SNAPSHOT_WAL_PATH" >/dev/null
(( ORIGINAL_SHM_PRESENT )) && copy_and_attest_private "$GUARD_SHM_PATH" "$SNAPSHOT_SHM_PATH" >/dev/null
(( ORIGINAL_JOURNAL_PRESENT )) && copy_and_attest_private "$GUARD_JOURNAL_PATH" "$SNAPSHOT_JOURNAL_PATH" >/dev/null
assert_wal_checkpoint "$SNAPSHOT_PATH"
remove_database_sidecars "$SNAPSHOT_PATH"
PREPARED_SNAPSHOT_SHA256="$(sha256_file "$SNAPSHOT_PATH")"
cp "$SNAPSHOT_PATH" "$INSTALL_TEMP_PATH"
chmod "$ORIGINAL_MAIN_MODE" "$INSTALL_TEMP_PATH"
if [[ "$(sha256_file "$INSTALL_TEMP_PATH")" != "$PREPARED_SNAPSHOT_SHA256" ]]; then
  print -u2 "Prepared live database installation hash mismatch"
  exit 1
fi
remove_database_set "$DATABASE_PATH"
mv -f -- "$INSTALL_TEMP_PATH" "$DATABASE_PATH"
if [[ "$(sha256_file "$DATABASE_PATH")" != "$PREPARED_SNAPSHOT_SHA256" ]]; then
  print -u2 "Installed disposable database hash mismatch"
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
elif (( REFERENCE_CAPTURE_MODE )); then
  PARITY_REFERENCE_PATH="$LIVE_ORIGINAL_SNAPSHOT_PATH"
  PARITY_REFERENCE_SELECTION="live-original-photo-subset-capture"
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
REFERENCE_BASELINE_VISIT_MISMATCH_COUNT=0
REFERENCE_BASELINE_PHOTO_MISMATCH_COUNT=0
REFERENCE_BASELINE_SUGGESTION_MISMATCH_COUNT=0
REFERENCE_BASELINE_METADATA_MISMATCH_COUNT=0
if (( REFERENCE_FIXTURE_GROWTH_MODE )); then
  SQL_ESCAPED_LIVE_ORIGINAL_SNAPSHOT_URI="$(print -rn -- "$LIVE_ORIGINAL_SNAPSHOT_URI" | sed "s/'/''/g")"
  read \
    REFERENCE_BASELINE_VISIT_MISMATCH_COUNT \
    REFERENCE_BASELINE_PHOTO_MISMATCH_COUNT \
    REFERENCE_BASELINE_SUGGESTION_MISMATCH_COUNT \
    REFERENCE_BASELINE_METADATA_MISMATCH_COUNT \
    <<<"$(sqlite3 -readonly -separator ' ' "$PARITY_REFERENCE_URI" <<SQL
ATTACH DATABASE '$SQL_ESCAPED_LIVE_ORIGINAL_SNAPSHOT_URI' AS baseline;
WITH visit_mismatches AS (
  SELECT baseline.id
  FROM baseline.visits AS baseline
  LEFT JOIN visits AS candidate USING (id)
  WHERE candidate.id IS NULL
     OR candidate.restaurantId IS NOT baseline.restaurantId
     OR candidate.suggestedRestaurantId IS NOT baseline.suggestedRestaurantId
     OR candidate.status IS NOT baseline.status
     OR candidate.startTime IS NOT baseline.startTime
     OR candidate.endTime IS NOT baseline.endTime
     OR candidate.centerLat IS NOT baseline.centerLat
     OR candidate.centerLon IS NOT baseline.centerLon
     OR candidate.photoCount IS NOT baseline.photoCount
     OR candidate.foodProbable IS NOT baseline.foodProbable
     OR candidate.notes IS NOT baseline.notes
     OR candidate.exportedToCalendarId IS NOT baseline.exportedToCalendarId
     OR candidate.awardAtVisit IS NOT baseline.awardAtVisit
), photo_mismatches AS (
  SELECT baseline.id
  FROM baseline.photos AS baseline
  LEFT JOIN photos AS candidate USING (id)
  WHERE candidate.id IS NULL
     OR candidate.uri IS NOT baseline.uri
     OR candidate.creationTime IS NOT baseline.creationTime
     OR candidate.latitude IS NOT baseline.latitude
     OR candidate.longitude IS NOT baseline.longitude
     OR candidate.visitId IS NOT baseline.visitId
     OR candidate.foodDetected IS NOT baseline.foodDetected
     OR candidate.foodLabels IS NOT baseline.foodLabels
     OR candidate.foodConfidence IS NOT baseline.foodConfidence
     OR candidate.allLabels IS NOT baseline.allLabels
     OR candidate.mediaType IS NOT baseline.mediaType
     OR candidate.duration IS NOT baseline.duration
), suggestion_mismatches AS (
  SELECT baseline.visitId, baseline.restaurantId
  FROM baseline.visit_suggested_restaurants AS baseline
  LEFT JOIN visit_suggested_restaurants AS candidate
    ON candidate.visitId = baseline.visitId
   AND candidate.restaurantId = baseline.restaurantId
  WHERE candidate.visitId IS NULL
     OR candidate.distance IS NOT baseline.distance
), metadata_mismatches AS (
  SELECT baseline.key
  FROM baseline.app_metadata AS baseline
  LEFT JOIN app_metadata AS candidate USING (key)
  WHERE candidate.key IS NULL
     OR candidate.value IS NOT baseline.value
  UNION ALL
  SELECT candidate.key
  FROM app_metadata AS candidate
  LEFT JOIN baseline.app_metadata AS baseline USING (key)
  WHERE baseline.key IS NULL
)
SELECT (SELECT COUNT(*) FROM visit_mismatches),
       (SELECT COUNT(*) FROM photo_mismatches),
       (SELECT COUNT(*) FROM suggestion_mismatches),
       (SELECT COUNT(*) FROM metadata_mismatches);
DETACH DATABASE baseline;
SQL
)"
fi
REFERENCE_PHOTO_COUNT_DELTA=$(( REFERENCE_PHOTO_COUNT - LIVE_ORIGINAL_PHOTO_COUNT ))
REFERENCE_PHOTO_COUNT_IS_COMPATIBLE=0
if (( REFERENCE_PHOTO_COUNT_DELTA == 0 )); then
  REFERENCE_PHOTO_COUNT_IS_COMPATIBLE=1
elif [[ "$PARITY_REFERENCE_SELECTION" == "explicit" \
  && "$EFFECTIVE_PHOTO_SCAN_STRATEGY" == "incremental" ]] \
  && (( REFERENCE_PHOTO_COUNT_DELTA > 0 )); then
  REFERENCE_PHOTO_COUNT_IS_COMPATIBLE=1
fi
REFERENCE_FIXTURE_COUNTS_ARE_COMPATIBLE=0
if (( REFERENCE_FIXTURE_GROWTH_MODE )); then
  if (( REFERENCE_VISIT_COUNT >= LIVE_ORIGINAL_VISIT_COUNT \
    && REFERENCE_LINK_COUNT >= LIVE_ORIGINAL_LINK_COUNT \
    && REFERENCE_DISTINCT_EVENT_COUNT >= LIVE_ORIGINAL_DISTINCT_EVENT_COUNT \
    && REFERENCE_PHOTO_COUNT_IS_COMPATIBLE \
    && REFERENCE_SUGGESTION_COUNT >= LIVE_ORIGINAL_SUGGESTION_COUNT \
    && REFERENCE_METADATA_COUNT == LIVE_ORIGINAL_METADATA_COUNT \
    && REFERENCE_BASELINE_VISIT_MISMATCH_COUNT == 0 \
    && REFERENCE_BASELINE_PHOTO_MISMATCH_COUNT == 0 \
    && REFERENCE_BASELINE_SUGGESTION_MISMATCH_COUNT == 0 \
    && REFERENCE_BASELINE_METADATA_MISMATCH_COUNT == 0 )); then
    REFERENCE_FIXTURE_COUNTS_ARE_COMPATIBLE=1
  fi
elif (( REFERENCE_VISIT_COUNT == LIVE_ORIGINAL_VISIT_COUNT \
  && REFERENCE_LINK_COUNT == LIVE_ORIGINAL_LINK_COUNT \
  && REFERENCE_DISTINCT_EVENT_COUNT == LIVE_ORIGINAL_DISTINCT_EVENT_COUNT \
  && REFERENCE_PHOTO_COUNT_IS_COMPATIBLE \
  && REFERENCE_SUGGESTION_COUNT == LIVE_ORIGINAL_SUGGESTION_COUNT \
  && REFERENCE_METADATA_COUNT == LIVE_ORIGINAL_METADATA_COUNT )); then
  REFERENCE_FIXTURE_COUNTS_ARE_COMPATIBLE=1
fi
if (( ! REFERENCE_FIXTURE_COUNTS_ARE_COMPATIBLE )); then
  print -u2 "Parity reference does not match the controlled live fixture counts"
  print -u2 "  live: visits=$LIVE_ORIGINAL_VISIT_COUNT links=$LIVE_ORIGINAL_LINK_COUNT events=$LIVE_ORIGINAL_DISTINCT_EVENT_COUNT photos=$LIVE_ORIGINAL_PHOTO_COUNT suggestions=$LIVE_ORIGINAL_SUGGESTION_COUNT metadata=$LIVE_ORIGINAL_METADATA_COUNT"
  print -u2 "  reference: visits=$REFERENCE_VISIT_COUNT links=$REFERENCE_LINK_COUNT events=$REFERENCE_DISTINCT_EVENT_COUNT photos=$REFERENCE_PHOTO_COUNT suggestions=$REFERENCE_SUGGESTION_COUNT metadata=$REFERENCE_METADATA_COUNT"
  print -u2 "  incremental scans may use only a nonnegative photo-count delta that native runtime attestation later explains exactly"
  if (( REFERENCE_FIXTURE_GROWTH_MODE )); then
    print -u2 "  fixture-growth references must preserve every baseline visit/photo/suggestion row and exact metadata while aggregate counts grow only"
  fi
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
if (( BOOTSTRAP_CAPTURE_GROWTH_MODE )); then
  EXPECTED_LINK_COUNT="$CAPTURE_EXPECTED_CALENDAR_LINK_COUNT"
fi

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
PREPARED_LOGICAL_DIGEST="$(logical_fixture_digest "$DATABASE_PATH")"
if [[ -z "$PREPARED_LOGICAL_DIGEST" ]]; then
  print -u2 "Unable to compute the prepared fixture logical digest"
  exit 1
fi

rm -f -- "$TRIGGER_PATH" "$RUN_DATABASE_TEMP_PATH" "$REPORT_TEMP_PATH" "$ATTESTATION_PATH" "$ATTESTATION_PATH.tmp" "$PHOTO_SCAN_ATTESTATION_PATH" "$PHOTO_SCAN_ATTESTATION_PATH.tmp"
remove_database_sidecars "$RUN_DATABASE_PATH"
remove_database_sidecars "$RUN_DATABASE_TEMP_PATH"
print "observed_elapsed_s\tcalendar_links_minus_one_until_photo_attestation\trss_kib" > "$SAMPLES_PATH"
launchctl setenv PALATE_CALENDAR_QUERY_STRATEGY "$QUERY_STRATEGY"
launchctl setenv PALATE_CALENDAR_QUERY_GAP_DAYS "$QUERY_GAP_DAYS"
launchctl setenv PALATE_CALENDAR_VALIDATION_RUN_ID "$VALIDATION_RUN_ID"
launchctl setenv PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH "$ATTESTATION_PATH"
launchctl setenv PALATE_PHOTO_SCAN_VALIDATION_RUN_ID "$VALIDATION_RUN_ID"
launchctl setenv PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH "$PHOTO_SCAN_ATTESTATION_PATH"
launchctl unsetenv PALATE_VISION_RESULT_PAGE_SIZE || true
launchctl unsetenv PALATE_VISION_CLASSIFICATION_STRATEGY || true
launchctl unsetenv PALATE_VISION_CONCURRENCY || true
launchctl unsetenv PALATE_VISION_PIPELINE_DEPTH || true
if (( PHOTO_SCAN_STRATEGY_PROVIDED )); then
  launchctl setenv PALATE_PHOTO_SCAN_STRATEGY "$PHOTO_SCAN_STRATEGY"
else
  launchctl unsetenv PALATE_PHOTO_SCAN_STRATEGY || true
fi
if (( MANUAL_LAUNCH )); then
  print \
    "READY_TO_LAUNCH strategy=$QUERY_STRATEGY gap_days=$QUERY_GAP_DAYS photo_scan_strategy_requested=$REQUESTED_PHOTO_SCAN_STRATEGY_LABEL photo_scan_strategy_expected=$EFFECTIVE_PHOTO_SCAN_STRATEGY photo_scan_implementation_expected=${EXPECTED_PHOTO_SCAN_IMPLEMENTATION:-any} expected_app=$APP_PATH"
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
attest_process_bundle

PROCESS_ENVIRONMENT="$(ps eww -p "$APP_PID" -o command=)"
EXPECTED_STRATEGY_ENV="PALATE_CALENDAR_QUERY_STRATEGY=$QUERY_STRATEGY"
EXPECTED_GAP_ENV="PALATE_CALENDAR_QUERY_GAP_DAYS=$QUERY_GAP_DAYS"
EXPECTED_RUN_ENV="PALATE_CALENDAR_VALIDATION_RUN_ID=$VALIDATION_RUN_ID"
EXPECTED_ATTESTATION_ENV="PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH=$ATTESTATION_PATH"
EXPECTED_PHOTO_VALIDATION_RUN_ENV="PALATE_PHOTO_SCAN_VALIDATION_RUN_ID=$VALIDATION_RUN_ID"
EXPECTED_PHOTO_ATTESTATION_ENV="PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH=$PHOTO_SCAN_ATTESTATION_PATH"
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_STRATEGY_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_GAP_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_RUN_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_ATTESTATION_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_PHOTO_VALIDATION_RUN_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_PHOTO_ATTESTATION_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit the requested Calendar validation environment"
  exit 1
fi
if (( PHOTO_SCAN_STRATEGY_PROVIDED )); then
  EXPECTED_PHOTO_SCAN_ENV="PALATE_PHOTO_SCAN_STRATEGY=$PHOTO_SCAN_STRATEGY"
  if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_PHOTO_SCAN_ENV "* ]]; then
    print -u2 "Launched Palate process did not inherit $EXPECTED_PHOTO_SCAN_ENV"
    exit 1
  fi
  OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY="$PHOTO_SCAN_STRATEGY"
  OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY_LABEL="$PHOTO_SCAN_STRATEGY"
  OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY_JSON="\"$PHOTO_SCAN_STRATEGY\""
elif [[ " $PROCESS_ENVIRONMENT " == *" PALATE_PHOTO_SCAN_STRATEGY="* ]]; then
  print -u2 "Launched Palate process unexpectedly inherited PALATE_PHOTO_SCAN_STRATEGY"
  exit 1
else
  OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY=""
  OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY_LABEL="absent"
  OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY_JSON=null
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
PRETRIGGER_LOGICAL_DIGEST="$(logical_fixture_digest "$DATABASE_PATH")"
if [[ "$PRETRIGGER_LOGICAL_DIGEST" != "$PREPARED_LOGICAL_DIGEST" ]]; then
  print -u2 "Palate mutated the prepared fixture before the timed trigger"
  exit 1
fi
print \
  "READY strategy=$QUERY_STRATEGY gap_days=$QUERY_GAP_DAYS photo_scan_strategy_requested=$REQUESTED_PHOTO_SCAN_STRATEGY_LABEL photo_scan_strategy_observed=$OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY_LABEL photo_scan_strategy_expected=$EFFECTIVE_PHOTO_SCAN_STRATEGY photo_scan_implementation_expected=${EXPECTED_PHOTO_SCAN_IMPLEMENTATION:-any} pid=$APP_PID trigger=$TRIGGER_PATH"

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

PHOTO_SCAN_ATTESTATION_WAIT_STARTED="$(date +%s)"
while true; do
  SAMPLE_OBSERVED_EPOCH="$(date +%s.%N)"
  SAMPLE_ELAPSED="$(awk -v now="$SAMPLE_OBSERVED_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.3f", now - start }')"
  SAMPLE_RSS_KIB="$(ps -o rss= -p "$APP_PID" | tr -d ' ' || true)"
  [[ -n "$SAMPLE_RSS_KIB" ]] || SAMPLE_RSS_KIB=0
  print "$SAMPLE_ELAPSED\t-1\t$SAMPLE_RSS_KIB" >> "$SAMPLES_PATH"
  if [[ -s "$PHOTO_SCAN_ATTESTATION_PATH" ]] \
    && jq -e . "$PHOTO_SCAN_ATTESTATION_PATH" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before producing the native Photo scan attestation"
    exit 1
  fi
  if (( $(date +%s) - PHOTO_SCAN_ATTESTATION_WAIT_STARTED >= ATTESTATION_TIMEOUT_SECONDS )); then
    print -u2 "Timed out waiting for native Photo scan attestation: $PHOTO_SCAN_ATTESTATION_PATH"
    exit 1
  fi
  sleep "$TARGET_SAMPLING_INTERVAL_SECONDS"
done
PHOTO_SCAN_ATTESTATION_OBSERVED_EPOCH="$(date +%s.%N)"
if ! jq -e \
  --arg runId "$VALIDATION_RUN_ID" \
  --argjson configuredStrategy "$REQUESTED_PHOTO_SCAN_STRATEGY_JSON" \
  --arg expectedStrategy "$EFFECTIVE_PHOTO_SCAN_STRATEGY" \
  --arg expectedImplementation "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" \
  --argjson triggerEpoch "$TRIGGER_EPOCH" \
  --argjson observedEpoch "$PHOTO_SCAN_ATTESTATION_OBSERVED_EPOCH" \
  'def nonnegative_integer:
     type == "number" and . >= 0 and floor == .;
   type == "object"
   and (.schemaVersion == 1 or .schemaVersion == 2)
   and .runId == $runId
   and .configuredPhotoScanStrategy == $configuredStrategy
   and .resolvedPhotoScanStrategy == $expectedStrategy
   and .selectedScanKind == $expectedStrategy
   and ($expectedImplementation == ""
     or (.schemaVersion == 2 and .selectedScanImplementation == $expectedImplementation))
   and (.libraryTotalCount | nonnegative_integer)
   and (.unknownVisibleCount | nonnegative_integer)
   and (.excludedVisibleCount | nonnegative_integer)
   and (.excludedPhotosWithLocation | nonnegative_integer)
   and (.excludedSkippedAssets | nonnegative_integer)
   and (.libraryTotalCount == (.unknownVisibleCount + .excludedVisibleCount))
   and ((.excludedPhotosWithLocation + .excludedSkippedAssets) <= .excludedVisibleCount)
   and ($expectedStrategy != "legacy"
     or (.unknownVisibleCount == .libraryTotalCount
       and .excludedVisibleCount == 0
       and .excludedPhotosWithLocation == 0
       and .excludedSkippedAssets == 0))
   and ((.observedAtEpochSeconds | type) == "number")
   and (.observedAtEpochSeconds >= $triggerEpoch)
   and (.observedAtEpochSeconds <= $observedEpoch)' \
  "$PHOTO_SCAN_ATTESTATION_PATH" >/dev/null; then
  print -u2 "Native Photo scan attestation did not prove the requested scan path and balanced counters"
  exit 1
fi
PHOTO_ATTESTED_SELECTED_SCAN_KIND="$(jq -r '.selectedScanKind' "$PHOTO_SCAN_ATTESTATION_PATH")"
PHOTO_ATTESTED_SELECTED_SCAN_IMPLEMENTATION="$(jq -r '.selectedScanImplementation // "unspecified"' "$PHOTO_SCAN_ATTESTATION_PATH")"
PHOTO_ATTESTED_LIBRARY_TOTAL_COUNT="$(jq -r '.libraryTotalCount' "$PHOTO_SCAN_ATTESTATION_PATH")"
PHOTO_ATTESTED_UNKNOWN_VISIBLE_COUNT="$(jq -r '.unknownVisibleCount' "$PHOTO_SCAN_ATTESTATION_PATH")"
PHOTO_ATTESTED_EXCLUDED_VISIBLE_COUNT="$(jq -r '.excludedVisibleCount' "$PHOTO_SCAN_ATTESTATION_PATH")"
CAPTURE_PHOTO_COUNT_DELTA=0
if (( REFERENCE_CAPTURE_MODE )); then
  CAPTURE_PHOTO_COUNT_DELTA="$PHOTO_ATTESTED_UNKNOWN_VISIBLE_COUNT"
  EXPECTED_PHOTO_COUNT=$(( LIVE_ORIGINAL_PHOTO_COUNT + CAPTURE_PHOTO_COUNT_DELTA ))
  if (( PHOTO_ATTESTED_EXCLUDED_VISIBLE_COUNT != LIVE_ORIGINAL_PHOTO_COUNT \
    || PHOTO_ATTESTED_LIBRARY_TOTAL_COUNT != EXPECTED_PHOTO_COUNT )); then
    print -u2 "Native incremental Photo scan attestation did not exactly explain the reference-capture photo-count delta"
    print -u2 "  expected: library=$EXPECTED_PHOTO_COUNT excluded=$LIVE_ORIGINAL_PHOTO_COUNT unknown=$CAPTURE_PHOTO_COUNT_DELTA"
    print -u2 "  attested: library=$PHOTO_ATTESTED_LIBRARY_TOTAL_COUNT excluded=$PHOTO_ATTESTED_EXCLUDED_VISIBLE_COUNT unknown=$PHOTO_ATTESTED_UNKNOWN_VISIBLE_COUNT"
    exit 1
  fi
else
  if (( PHOTO_ATTESTED_LIBRARY_TOTAL_COUNT != REFERENCE_PHOTO_COUNT )); then
    print -u2 "Native Photo scan attestation library total does not match the parity reference photo count"
    exit 1
  fi
  if [[ "$EFFECTIVE_PHOTO_SCAN_STRATEGY" == "incremental" ]] \
    && (( PHOTO_ATTESTED_EXCLUDED_VISIBLE_COUNT != LIVE_ORIGINAL_PHOTO_COUNT \
      || PHOTO_ATTESTED_UNKNOWN_VISIBLE_COUNT != REFERENCE_PHOTO_COUNT_DELTA )); then
    print -u2 "Native incremental Photo scan attestation did not exactly explain the parity reference photo-count delta"
    print -u2 "  expected: library=$REFERENCE_PHOTO_COUNT excluded=$LIVE_ORIGINAL_PHOTO_COUNT unknown=$REFERENCE_PHOTO_COUNT_DELTA"
    print -u2 "  attested: library=$PHOTO_ATTESTED_LIBRARY_TOTAL_COUNT excluded=$PHOTO_ATTESTED_EXCLUDED_VISIBLE_COUNT unknown=$PHOTO_ATTESTED_UNKNOWN_VISIBLE_COUNT"
    exit 1
  fi
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
     OR current.notes IS NOT expected.notes
     OR current.exportedToCalendarId IS NOT expected.exportedToCalendarId
     OR current.awardAtVisit IS NOT expected.awardAtVisit
     OR ($BOOTSTRAP_CAPTURE_GROWTH_MODE = 0 AND (
       current.calendarEventId IS NOT expected.calendarEventId
       OR current.calendarEventTitle IS NOT expected.calendarEventTitle
       OR current.calendarEventLocation IS NOT expected.calendarEventLocation
       OR current.calendarEventIsAllDay IS NOT expected.calendarEventIsAllDay
     ))
  UNION ALL
  SELECT current.id
  FROM visits AS current
  LEFT JOIN reference.visits AS expected USING (id)
  WHERE $BOOTSTRAP_CAPTURE_GROWTH_MODE = 0
    AND expected.id IS NULL
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
  WHERE $REFERENCE_CAPTURE_MODE = 0
    AND expected.id IS NULL
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
  WHERE $BOOTSTRAP_CAPTURE_GROWTH_MODE = 0
    AND expected.visitId IS NULL
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

ACTUAL_VISIT_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits;")"
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
if (( BOOTSTRAP_CAPTURE_GROWTH_MODE )); then
  if (( ACTUAL_LINK_COUNT != EXPECTED_LINK_COUNT \
    || ACTUAL_DISTINCT_EVENT_COUNT < LIVE_ORIGINAL_DISTINCT_EVENT_COUNT )); then
    VALIDATION_FAILURES+=("Bootstrap Calendar growth mismatch: expected $EXPECTED_LINK_COUNT links and at least $LIVE_ORIGINAL_DISTINCT_EVENT_COUNT events, found $ACTUAL_LINK_COUNT links across $ACTUAL_DISTINCT_EVENT_COUNT events")
  fi
  if (( ACTUAL_VISIT_COUNT < LIVE_ORIGINAL_VISIT_COUNT )); then
    VALIDATION_FAILURES+=("Bootstrap visit count shrank: baseline $LIVE_ORIGINAL_VISIT_COUNT, found $ACTUAL_VISIT_COUNT")
  fi
else
  if (( ACTUAL_LINK_COUNT != EXPECTED_LINK_COUNT || ACTUAL_DISTINCT_EVENT_COUNT != EXPECTED_DISTINCT_EVENT_COUNT )); then
    VALIDATION_FAILURES+=("Calendar result count mismatch: expected $EXPECTED_LINK_COUNT links across $EXPECTED_DISTINCT_EVENT_COUNT events, found $ACTUAL_LINK_COUNT links across $ACTUAL_DISTINCT_EVENT_COUNT events")
  fi
  if (( ACTUAL_VISIT_COUNT != REFERENCE_VISIT_COUNT )); then
    VALIDATION_FAILURES+=("Visit count mismatch: expected $REFERENCE_VISIT_COUNT, found $ACTUAL_VISIT_COUNT")
  fi
fi
if (( ACTUAL_PHOTO_COUNT != EXPECTED_PHOTO_COUNT )); then
  VALIDATION_FAILURES+=("Photo count mismatch: expected $EXPECTED_PHOTO_COUNT, found $ACTUAL_PHOTO_COUNT")
fi
if (( BOOTSTRAP_CAPTURE_GROWTH_MODE )); then
  if (( ACTUAL_SUGGESTION_COUNT < LIVE_ORIGINAL_SUGGESTION_COUNT )); then
    VALIDATION_FAILURES+=("Bootstrap visit suggestion count shrank: baseline $LIVE_ORIGINAL_SUGGESTION_COUNT, found $ACTUAL_SUGGESTION_COUNT")
  fi
elif (( ACTUAL_SUGGESTION_COUNT != EXPECTED_SUGGESTION_COUNT )); then
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
CURRENT_RESULT_SHA256="$(sha256_file "$DATABASE_PATH")"
CAPTURE_REFERENCE_PREPARED_JSON=false
CAPTURE_REFERENCE_PUBLISHED_JSON=false
CAPTURE_REFERENCE_SHA256=""
CAPTURE_REFERENCE_INTEGRITY=""
CAPTURE_REFERENCE_FOREIGN_KEY_VIOLATION_COUNT=0
CAPTURE_REFERENCE_PHOTO_COUNT=0
if (( REFERENCE_CAPTURE_MODE )) && [[ "$VALIDATION_STATUS" == "ok" ]]; then
  remove_database_set "$CAPTURE_REFERENCE_TEMP_PATH"
  CAPTURE_REFERENCE_SOURCE_SHA256_BEFORE="$(sha256_file "$DATABASE_PATH")"
  cp "$DATABASE_PATH" "$CAPTURE_REFERENCE_TEMP_PATH"
  chmod 600 "$CAPTURE_REFERENCE_TEMP_PATH"
  CAPTURE_REFERENCE_SHA256="$(sha256_file "$CAPTURE_REFERENCE_TEMP_PATH")"
  CAPTURE_REFERENCE_SOURCE_SHA256_AFTER="$(sha256_file "$DATABASE_PATH")"
  if [[ "$CAPTURE_REFERENCE_SOURCE_SHA256_BEFORE" != "$CURRENT_RESULT_SHA256" \
    || "$CAPTURE_REFERENCE_SOURCE_SHA256_AFTER" != "$CURRENT_RESULT_SHA256" \
    || "$CAPTURE_REFERENCE_SHA256" != "$CURRENT_RESULT_SHA256" \
    || "$(stat -f '%Lp' "$CAPTURE_REFERENCE_TEMP_PATH")" != "600" ]]; then
    print -u2 "Reference-capture database copy did not exactly match the validated result"
    exit 1
  fi
  CAPTURE_REFERENCE_TEMP_URI="$(immutable_sqlite_uri "$CAPTURE_REFERENCE_TEMP_PATH")"
  CAPTURE_REFERENCE_INTEGRITY="$(sqlite3 -readonly "$CAPTURE_REFERENCE_TEMP_URI" "PRAGMA integrity_check;")"
  CAPTURE_REFERENCE_FOREIGN_KEY_VIOLATION_COUNT="$(sqlite3 -readonly "$CAPTURE_REFERENCE_TEMP_URI" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"
  CAPTURE_REFERENCE_PHOTO_COUNT="$(sqlite3 -readonly "$CAPTURE_REFERENCE_TEMP_URI" "SELECT COUNT(*) FROM photos;")"
  if [[ "$CAPTURE_REFERENCE_INTEGRITY" != "ok" ]] \
    || (( CAPTURE_REFERENCE_FOREIGN_KEY_VIOLATION_COUNT != 0 )) \
    || (( CAPTURE_REFERENCE_PHOTO_COUNT != EXPECTED_PHOTO_COUNT )); then
    print -u2 "Reference-capture copy validation failed: integrity=$CAPTURE_REFERENCE_INTEGRITY foreign_keys=$CAPTURE_REFERENCE_FOREIGN_KEY_VIOLATION_COUNT photos=$CAPTURE_REFERENCE_PHOTO_COUNT expected_photos=$EXPECTED_PHOTO_COUNT"
    exit 1
  fi
  CAPTURE_REFERENCE_PREPARED_JSON=true
fi
if (( RETAIN_RAW_DATABASES )); then
  cp "$DATABASE_PATH" "$RUN_DATABASE_TEMP_PATH"
  chmod 600 "$RUN_DATABASE_TEMP_PATH"
  COPIED_RESULT_SHA256="$(sha256_file "$RUN_DATABASE_TEMP_PATH")"
  if [[ "$COPIED_RESULT_SHA256" != "$CURRENT_RESULT_SHA256" ]]; then
    print -u2 "Result database copy hash mismatch"
    exit 1
  fi
  mv -f -- "$RUN_DATABASE_TEMP_PATH" "$RUN_DATABASE_PATH"
  remove_database_sidecars "$RUN_DATABASE_PATH"
else
  remove_database_set "$RUN_DATABASE_PATH"
fi
VALIDATION_FAILURES_JSON='[]'
if (( ${#VALIDATION_FAILURES} > 0 )); then
  VALIDATION_FAILURES_JSON="$(printf '%s\n' "${VALIDATION_FAILURES[@]}" | jq -R . | jq -s .)"
fi
if (( RETAIN_RAW_DATABASES )); then
  RAW_DATABASE_COPIES_RETAINED_JSON=true
  REPORTED_SNAPSHOT_PATH="$LIVE_ORIGINAL_SNAPSHOT_PATH"
  REPORTED_RESULT_DATABASE_PATH="${RUN_DATABASE_PATH:A}"
else
  RAW_DATABASE_COPIES_RETAINED_JSON=false
  REPORTED_SNAPSHOT_PATH=""
  REPORTED_RESULT_DATABASE_PATH=""
fi
SENSITIVE_DATABASE_COPIES_RETAINED_JSON=false
if (( RETAIN_RAW_DATABASES )) || [[ "$CAPTURE_REFERENCE_PREPARED_JSON" == "true" ]]; then
  SENSITIVE_DATABASE_COPIES_RETAINED_JSON=true
fi
RESULT_VISIT_COUNT_DELTA=$(( ACTUAL_VISIT_COUNT - LIVE_ORIGINAL_VISIT_COUNT ))
RESULT_CALENDAR_LINK_COUNT_DELTA=$(( ACTUAL_LINK_COUNT - LIVE_ORIGINAL_LINK_COUNT ))
RESULT_DISTINCT_EVENT_COUNT_DELTA=$(( ACTUAL_DISTINCT_EVENT_COUNT - LIVE_ORIGINAL_DISTINCT_EVENT_COUNT ))
RESULT_PHOTO_COUNT_DELTA=$(( ACTUAL_PHOTO_COUNT - LIVE_ORIGINAL_PHOTO_COUNT ))
RESULT_SUGGESTION_COUNT_DELTA=$(( ACTUAL_SUGGESTION_COUNT - LIVE_ORIGINAL_SUGGESTION_COUNT ))
jq -n \
  --arg status "$VALIDATION_STATUS" \
  --argjson failureReasons "$VALIDATION_FAILURES_JSON" \
  --arg strategy "$QUERY_STRATEGY" \
  --argjson gapDays "$QUERY_GAP_DAYS" \
  --argjson requestedPhotoScanStrategy "$REQUESTED_PHOTO_SCAN_STRATEGY_JSON" \
  --arg expectedResolvedPhotoScanStrategy "$EFFECTIVE_PHOTO_SCAN_STRATEGY" \
  --arg expectedPhotoScanImplementation "$EXPECTED_PHOTO_SCAN_IMPLEMENTATION" \
  --argjson bootstrapCaptureGrowth "$BOOTSTRAP_CAPTURE_GROWTH_MODE" \
  --argjson allowedReferenceFixtureGrowth "$REFERENCE_FIXTURE_GROWTH_MODE" \
  --argjson captureExpectedCalendarLinkCount "$CAPTURE_EXPECTED_CALENDAR_LINK_COUNT_JSON" \
  --argjson referenceCaptureRequested "$REFERENCE_CAPTURE_MODE" \
  --argjson referenceCapturePrepared "$CAPTURE_REFERENCE_PREPARED_JSON" \
  --argjson referenceCapturePublished "$CAPTURE_REFERENCE_PUBLISHED_JSON" \
  --argjson observedProcessPhotoScanStrategy "$OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY_JSON" \
  --slurpfile photoScanAttestation "$PHOTO_SCAN_ATTESTATION_PATH" \
  --arg attestedRunId "$ATTESTED_RUN_ID" \
  --arg attestedStrategy "$ATTESTED_STRATEGY" \
  --argjson attestedGapDays "$ATTESTED_GAP_DAYS" \
  --argjson attestedObservedAtEpochSeconds "$ATTESTED_OBSERVED_EPOCH" \
  --argjson triggerEpochSeconds "$TRIGGER_EPOCH" \
  --argjson triggerObservedAtEpochSeconds "$TRIGGER_OBSERVED_EPOCH" \
  --argjson triggerMaxAgeSeconds "$TRIGGER_MAX_AGE_SECONDS" \
  --argjson visitCount "$ACTUAL_VISIT_COUNT" \
  --argjson expectedCalendarLinkCount "$EXPECTED_LINK_COUNT" \
  --argjson calendarLinkCount "$ACTUAL_LINK_COUNT" \
  --argjson distinctEventCount "$ACTUAL_DISTINCT_EVENT_COUNT" \
  --argjson photoCount "$ACTUAL_PHOTO_COUNT" \
  --argjson expectedPhotoCount "$EXPECTED_PHOTO_COUNT" \
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
  --arg preparedSnapshotSha256 "$PREPARED_SNAPSHOT_SHA256" \
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
  --argjson parityReferencePhotoCountDelta "$REFERENCE_PHOTO_COUNT_DELTA" \
  --argjson parityReferenceSuggestionCount "$REFERENCE_SUGGESTION_COUNT" \
  --argjson parityReferenceMetadataCount "$REFERENCE_METADATA_COUNT" \
  --argjson referenceBaselineVisitMismatchCount "$REFERENCE_BASELINE_VISIT_MISMATCH_COUNT" \
  --argjson referenceBaselinePhotoMismatchCount "$REFERENCE_BASELINE_PHOTO_MISMATCH_COUNT" \
  --argjson referenceBaselineSuggestionMismatchCount "$REFERENCE_BASELINE_SUGGESTION_MISMATCH_COUNT" \
  --argjson referenceBaselineMetadataMismatchCount "$REFERENCE_BASELINE_METADATA_MISMATCH_COUNT" \
  --argjson resultVisitCountDelta "$RESULT_VISIT_COUNT_DELTA" \
  --argjson resultCalendarLinkCountDelta "$RESULT_CALENDAR_LINK_COUNT_DELTA" \
  --argjson resultDistinctEventCountDelta "$RESULT_DISTINCT_EVENT_COUNT_DELTA" \
  --argjson resultPhotoCountDelta "$RESULT_PHOTO_COUNT_DELTA" \
  --argjson resultSuggestionCountDelta "$RESULT_SUGGESTION_COUNT_DELTA" \
  --arg resultSha256 "$CURRENT_RESULT_SHA256" \
  --arg resultDatabasePath "$REPORTED_RESULT_DATABASE_PATH" \
  --argjson rawDatabaseCopiesRetained "$RAW_DATABASE_COPIES_RETAINED_JSON" \
  --argjson sensitiveDatabaseCopiesRetained "$SENSITIVE_DATABASE_COPIES_RETAINED_JSON" \
  --arg reportedSnapshotPath "$REPORTED_SNAPSHOT_PATH" \
  --arg captureReferenceSha256 "$CAPTURE_REFERENCE_SHA256" \
  --arg captureReferenceIntegrity "$CAPTURE_REFERENCE_INTEGRITY" \
  --argjson captureReferenceForeignKeyViolationCount "$CAPTURE_REFERENCE_FOREIGN_KEY_VIOLATION_COUNT" \
  --argjson captureReferencePhotoCount "$CAPTURE_REFERENCE_PHOTO_COUNT" \
  --argjson captureReferencePhotoCountDelta "$CAPTURE_PHOTO_COUNT_DELTA" \
  --arg originalMainMode "$ORIGINAL_MAIN_MODE" \
  --argjson originalWalPresent "$ORIGINAL_WAL_PRESENT" \
  --arg originalWalSha256 "$ORIGINAL_WAL_SHA256" \
  --arg originalWalMode "$ORIGINAL_WAL_MODE" \
  --argjson originalShmPresent "$ORIGINAL_SHM_PRESENT" \
  --arg originalShmSha256 "$ORIGINAL_SHM_SHA256" \
  --arg originalShmMode "$ORIGINAL_SHM_MODE" \
  --argjson originalJournalPresent "$ORIGINAL_JOURNAL_PRESENT" \
  --arg originalJournalSha256 "$ORIGINAL_JOURNAL_SHA256" \
  --arg originalJournalMode "$ORIGINAL_JOURNAL_MODE" \
  --arg attestationPath "$ATTESTATION_PATH" \
  --arg samplesPath "${SAMPLES_PATH:t}" \
  --arg suppliedAppPath "${APP_PATH:t}" \
  --arg suppliedExecutableSha256 "$APP_EXECUTABLE_SHA256" \
  --arg suppliedBundleSha256 "$APP_BUNDLE_SHA256" \
  --arg processAppPath "${PROCESS_APP_PATH:t}" \
  --arg processExecutablePath "${PROCESS_EXECUTABLE_PATH:t}" \
  --arg processExecutableSha256 "$PROCESS_EXECUTABLE_SHA256" \
  --arg processBundleSha256 "$PROCESS_BUNDLE_SHA256" \
  --arg preparedLogicalDigest "$PREPARED_LOGICAL_DIGEST" \
  --arg pretriggerLogicalDigest "$PRETRIGGER_LOGICAL_DIGEST" \
  '{
    schemaVersion: 6,
    status: $status,
    strategy: $strategy,
    sparseCoalescingGapDays: $gapDays,
    configuration: {
      calendarQueryStrategy: $strategy,
      sparseCoalescingGapDays: $gapDays,
      requestedPhotoScanStrategy: $requestedPhotoScanStrategy,
      expectedResolvedPhotoScanStrategy: $expectedResolvedPhotoScanStrategy,
      expectedPhotoScanImplementation: (if $expectedPhotoScanImplementation == "" then null else $expectedPhotoScanImplementation end),
      referenceCaptureRequested: ($referenceCaptureRequested == 1),
      bootstrapCaptureFixtureGrowth: ($bootstrapCaptureGrowth == 1),
      captureExpectedCalendarLinkCount: $captureExpectedCalendarLinkCount,
      allowedReferenceFixtureGrowth: ($allowedReferenceFixtureGrowth == 1)
    },
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
      requestedPhotoScanStrategy: $requestedPhotoScanStrategy,
      observedProcessPhotoScanStrategy: $observedProcessPhotoScanStrategy,
      expectedResolvedPhotoScanStrategy: $expectedResolvedPhotoScanStrategy,
      expectedPhotoScanImplementation: (if $expectedPhotoScanImplementation == "" then null else $expectedPhotoScanImplementation end),
      observedAtEpochSeconds: $attestedObservedAtEpochSeconds,
      source: "native-runtime-attestation-file-and-process-environment",
      sourcePathDuringRun: null,
      photoScan: $photoScanAttestation[0]
    },
    buildAttestation: {
      suppliedAppPath: $suppliedAppPath,
      suppliedExecutableSha256: $suppliedExecutableSha256,
      suppliedMainBundleSha256: $suppliedBundleSha256,
      runningAppPath: $processAppPath,
      runningExecutablePath: $processExecutablePath,
      runningExecutableSha256: $processExecutableSha256,
      runningMainBundleSha256: $processBundleSha256,
      strictCodeSignatureVerified: true,
      exactExecutableMatch: ($suppliedExecutableSha256 == $processExecutableSha256),
      exactMainBundleMatch: ($suppliedBundleSha256 == $processBundleSha256)
    },
    triggerBoundary: {
      preparedLogicalDigest: $preparedLogicalDigest,
      pretriggerLogicalDigest: $pretriggerLogicalDigest,
      unchangedBeforeTrigger: ($preparedLogicalDigest == $pretriggerLogicalDigest)
    },
    validation: {
      failureReasons: $failureReasons,
      visitComparisonMode: (if $bootstrapCaptureGrowth == 1 then "exact-original-subset-excluding-calendar-and-updatedAt" else "exact-parity-excluding-updatedAt" end),
      exactVisitParityExcludingUpdatedAt: (if $bootstrapCaptureGrowth == 1 then null else ($visitMismatchCount == 0) end),
      exactOriginalVisitSubsetPreserved: ($visitMismatchCount == 0),
      visitMismatchCount: $visitMismatchCount,
      photoComparisonMode: (if $referenceCaptureRequested == 1 then "exact-original-subset" else "exact-parity" end),
      exactPhotoParity: (if $referenceCaptureRequested == 1 then null else ($photoMismatchCount == 0) end),
      exactOriginalPhotoSubsetPreserved: ($photoMismatchCount == 0),
      originalPhotoSubsetMismatchCount: $photoMismatchCount,
      photoMismatchCount: $photoMismatchCount,
      exactResultPhotoCount: ($photoCount == $expectedPhotoCount),
      expectedResultPhotoCount: $expectedPhotoCount,
      suggestionComparisonMode: (if $bootstrapCaptureGrowth == 1 then "exact-original-subset" else "exact-parity" end),
      exactVisitSuggestedRestaurantParity: (if $bootstrapCaptureGrowth == 1 then null else ($suggestionMismatchCount == 0) end),
      exactOriginalVisitSuggestedRestaurantSubsetPreserved: ($suggestionMismatchCount == 0),
      visitSuggestedRestaurantMismatchCount: $suggestionMismatchCount,
      exactAppMetadataParity: ($metadataMismatchCount == 0),
      appMetadataMismatchCount: $metadataMismatchCount,
      integrity: $integrity,
      foreignKeyViolationCount: $foreignKeyViolationCount
    },
    fixtureGrowth: {
      bootstrapCaptureEnabled: ($bootstrapCaptureGrowth == 1),
      referenceGrowthAllowed: ($allowedReferenceFixtureGrowth == 1),
      expectedCalendarLinkCount: $expectedCalendarLinkCount,
      visits: $resultVisitCountDelta,
      calendarLinks: $resultCalendarLinkCountDelta,
      distinctEvents: $resultDistinctEventCountDelta,
      photos: $resultPhotoCountDelta,
      visitSuggestedRestaurants: $resultSuggestionCountDelta
    },
    liveOriginalDatabase: {
      livePath: null,
      snapshotPath: (if $rawDatabaseCopiesRetained then $reportedSnapshotPath else null end),
      sha256: $liveOriginalSha256,
      preparedStandaloneSnapshotSha256: $preparedSnapshotSha256,
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
      path: null,
      sha256: $parityReferenceSha256,
      accessMode: "immutable-read-only",
      integrity: $parityReferenceIntegrity,
      foreignKeyViolationCount: $parityReferenceForeignKeyViolationCount,
      photoCountDeltaFromLiveOriginal: $parityReferencePhotoCountDelta,
      fixtureGrowthAllowed: ($allowedReferenceFixtureGrowth == 1),
      baselinePreservation: {
        visitMismatchCount: $referenceBaselineVisitMismatchCount,
        photoMismatchCount: $referenceBaselinePhotoMismatchCount,
        visitSuggestedRestaurantMismatchCount: $referenceBaselineSuggestionMismatchCount,
        appMetadataMismatchCount: $referenceBaselineMetadataMismatchCount
      },
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
      retained: $rawDatabaseCopiesRetained,
      path: (if $rawDatabaseCopiesRetained then $resultDatabasePath else null end),
      sha256: $resultSha256
    },
    referenceCaptureDatabase: {
      requested: ($referenceCaptureRequested == 1),
      captured: $referenceCapturePublished,
      path: null,
      outputPathRedacted: true,
      privateFileMode: (if $referenceCapturePrepared then "600" else null end),
      sha256: (if $referenceCapturePrepared then $captureReferenceSha256 else null end),
      integrity: (if $referenceCapturePrepared then $captureReferenceIntegrity else null end),
      foreignKeyViolationCount: (if $referenceCapturePrepared then $captureReferenceForeignKeyViolationCount else null end),
      photoCountDeltaFromLiveOriginal: (if $referenceCaptureRequested == 1 then $captureReferencePhotoCountDelta else null end),
      expectedPhotoCount: (if $referenceCaptureRequested == 1 then $expectedPhotoCount else null end),
      fixture: (if $referenceCapturePrepared then {
        visits: $visitCount,
        calendarLinks: $calendarLinkCount,
        distinctEvents: $distinctEventCount,
        photos: $captureReferencePhotoCount,
        visitSuggestedRestaurants: $suggestionCount,
        appMetadata: $metadataCount
      } else null end)
    },
    samplesPath: $samplesPath,
    restoration: {
      exactMainAndSidecarSetRestored: false,
      sensitiveDatabaseCopiesRetained: $sensitiveDatabaseCopiesRetained,
      originalMain: {present: true, sha256: $liveOriginalSha256, mode: $originalMainMode},
      originalWal: {present: ($originalWalPresent == 1), sha256: (if $originalWalPresent == 1 then $originalWalSha256 else null end), mode: (if $originalWalPresent == 1 then $originalWalMode else null end)},
      originalShm: {present: ($originalShmPresent == 1), sha256: (if $originalShmPresent == 1 then $originalShmSha256 else null end), mode: (if $originalShmPresent == 1 then $originalShmMode else null end)},
      originalJournal: {present: ($originalJournalPresent == 1), sha256: (if $originalJournalPresent == 1 then $originalJournalSha256 else null end), mode: (if $originalJournalPresent == 1 then $originalJournalMode else null end)}
    }
  }' > "$REPORT_TEMP_PATH"
DEFER_GUARD_REMOVAL=1
restore_database
RESTORED_SHA256="$(sha256_file "$DATABASE_PATH")"
if [[ "$RESTORED_SHA256" != "$ORIGINAL_SHA256" ]]; then
  print -u2 "Database restoration hash mismatch"
  exit 1
fi
if [[ "$CAPTURE_REFERENCE_PREPARED_JSON" == "true" ]]; then
  for capture_output_path in \
    "$CAPTURE_REFERENCE_DATABASE_PATH" \
    "$CAPTURE_REFERENCE_DATABASE_PATH-wal" \
    "$CAPTURE_REFERENCE_DATABASE_PATH-shm" \
    "$CAPTURE_REFERENCE_DATABASE_PATH-journal"; do
    if [[ -e "$capture_output_path" || -L "$capture_output_path" ]]; then
      print -u2 "Reference-capture output appeared during validation; refusing to overwrite it: $capture_output_path"
      exit 1
    fi
  done
  CAPTURE_REFERENCE_TEMP_FILE_ID="$(stat -f '%d:%i' "$CAPTURE_REFERENCE_TEMP_PATH")"
  mv -n -- "$CAPTURE_REFERENCE_TEMP_PATH" "$CAPTURE_REFERENCE_DATABASE_PATH"
  if [[ ! -e "$CAPTURE_REFERENCE_TEMP_PATH" \
    && -f "$CAPTURE_REFERENCE_DATABASE_PATH" \
    && ! -L "$CAPTURE_REFERENCE_DATABASE_PATH" \
    && "$(stat -f '%d:%i' "$CAPTURE_REFERENCE_DATABASE_PATH")" == "$CAPTURE_REFERENCE_TEMP_FILE_ID" ]]; then
    CAPTURE_REFERENCE_OUTPUT_CREATED=1
  else
    print -u2 "Reference-capture database could not be published atomically"
    exit 1
  fi
  if [[ "$(sha256_file "$CAPTURE_REFERENCE_DATABASE_PATH")" != "$CAPTURE_REFERENCE_SHA256" ]]; then
    print -u2 "Published reference-capture database hash does not match the validated result"
    exit 1
  fi
  if [[ "$(stat -f '%Lp' "$CAPTURE_REFERENCE_DATABASE_PATH")" != "600" ]]; then
    print -u2 "Published reference-capture database is not private mode 0600"
    exit 1
  fi
  durability_sync reference-capture-published
  CAPTURE_REFERENCE_PUBLISHED_JSON=true
fi
if ! cleanup_sensitive_database_copies; then
  print -u2 "Sensitive database copy cleanup failed; refusing to publish a report"
  exit 1
fi
jq \
  --arg restoredMainSha256 "$RESTORED_SHA256" \
  --argjson referenceCapturePublished "$CAPTURE_REFERENCE_PUBLISHED_JSON" \
  '.restoration.exactMainAndSidecarSetRestored = true
   | .restoration.restoredMainSha256 = $restoredMainSha256
   | .referenceCaptureDatabase.captured = $referenceCapturePublished' \
  "$REPORT_TEMP_PATH" > "$REPORT_RESTORED_TEMP_PATH"
chmod 600 "$REPORT_RESTORED_TEMP_PATH"
DEFER_GUARD_REMOVAL=0
restore_database
if (( GUARD_READY )); then
  print -u2 "Durable recovery guard remained after reference-capture completion"
  exit 1
fi
mv -f -- "$REPORT_RESTORED_TEMP_PATH" "$REPORT_PATH"
rm -f -- "$REPORT_TEMP_PATH"

if [[ "$VALIDATION_STATUS" != "ok" ]]; then
  for failure_reason in "${VALIDATION_FAILURES[@]}"; do
    print -u2 "$failure_reason"
  done
  if (( RETAIN_RAW_DATABASES )); then
    print -u2 "Failure report and opt-in raw databases retained: result=$RUN_DATABASE_PATH report=$REPORT_PATH"
  else
    print -u2 "Failure report retained without raw database copies: report=$REPORT_PATH"
  fi
  exit 1
fi

print \
  "COMPLETE report=$REPORT_PATH photo_scan_strategy_requested=$REQUESTED_PHOTO_SCAN_STRATEGY_LABEL photo_scan_strategy_observed=$OBSERVED_PROCESS_PHOTO_SCAN_STRATEGY_LABEL photo_scan_implementation_observed=$PHOTO_ATTESTED_SELECTED_SCAN_IMPLEMENTATION wall_seconds=$WALL_SECONDS max_rss_kib=$MAX_RSS_KIB restored_sha256=$RESTORED_SHA256"

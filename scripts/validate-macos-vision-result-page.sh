#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_PATH=""
DATABASE_PATH=""
SEMANTIC_REFERENCE_DATABASE_PATH=""
PAGE_SIZE=""
OUTPUT_PREFIX=""
EXPECTED_FIXTURE_COUNT="13059"
TIMEOUT_SECONDS="180"
MANUAL_LAUNCH=0
RETAIN_RAW_DATABASES=0
RECOVER_STALE_GUARD=0
PAGE_ORCHESTRATION_STRATEGY="serial"
RESULT_TRANSPORT="legacy"
VISIT_FOOD_DETECTION_STRATEGY="full-plan-v1"
VISION_CONCURRENCY_OVERRIDE=""
PIPELINE_DEPTH_OVERRIDE=""
VISION_CONCURRENCY_OVERRIDE_PROVIDED=0
PIPELINE_DEPTH_OVERRIDE_PROVIDED=0
REQUIRE_NATIVE_WORK_COUNTERS=0
NATIVE_DEFAULT_VISION_CONCURRENCY=2
NATIVE_DEFAULT_PIPELINE_DEPTH=4
VALIDATION_TRIGGER_ACTION="confirm-start-deep-scan"
VALIDATION_ENTRYPOINT="isolated-visit-food"

usage() {
  print "Usage: validate-macos-vision-result-page.sh --app=PATH --database=PATH --page-size=N --output-prefix=PATH [options]"
  print ""
  print "  --expected-fixture-count=N  Previously classified rows to retest (default: 13059)"
  print "  --timeout-seconds=N         Completion timeout after trigger (default: 180)"
  print "  --page-orchestration-strategy=MODE  serial or lookahead (default: serial)"
  print "  --result-transport=MODE     legacy or packed-v1 (default: legacy)"
  print "  --visit-food-detection-strategy=MODE  full-plan-v1 or rank3-bulk-tail-v1 (default: full-plan-v1)"
  print "  --vision-concurrency=N      Vision workers, 1 through 16 (default: native 2)"
  print "  --pipeline-depth=N          In-flight PhotoKit/Vision assets, 1 through 64 (default: native 4)"
  print "  --require-native-work-counters  Reject older native attestations without direct dispatch counts"
  print "  --app=PATH                  Exact signed Release Palate.app used to attest the launched copy"
  print "  --semantic-reference-database=PATH  Immutable current-control DB used only for parity"
  print "  --retain-raw-databases      Retain private snapshot/result DBs after verified restoration"
  print "  --recover-stale-guard       Restore an interrupted run; requires only --database"
  print "  --manual-launch             Wait for Xcode to build and launch Palate from the same --app path"
  print ""
  print "The script snapshots and restores the database, launches Palate, then waits for"
  print "OUTPUT_PREFIX.trigger. Create that file immediately before confirming Start Deep Scan."
  print "With the validated run ID and absolute native-attestation path, validation mode"
  print "reroutes only that Deep Scan invocation through the isolated production visit-food phase."
  print "Never use Rescan Now for this harness; its Photos/Calendar phases invalidate isolation."
}

for argument in "$@"; do
  case "$argument" in
    --app=*) APP_PATH="${argument#*=}" ;;
    --database=*) DATABASE_PATH="${argument#*=}" ;;
    --semantic-reference-database=*) SEMANTIC_REFERENCE_DATABASE_PATH="${argument#*=}" ;;
    --page-size=*) PAGE_SIZE="${argument#*=}" ;;
    --output-prefix=*) OUTPUT_PREFIX="${argument#*=}" ;;
    --expected-fixture-count=*) EXPECTED_FIXTURE_COUNT="${argument#*=}" ;;
    --timeout-seconds=*) TIMEOUT_SECONDS="${argument#*=}" ;;
    --page-orchestration-strategy=*) PAGE_ORCHESTRATION_STRATEGY="${argument#*=}" ;;
    --result-transport=*) RESULT_TRANSPORT="${argument#*=}" ;;
    --visit-food-detection-strategy=*) VISIT_FOOD_DETECTION_STRATEGY="${argument#*=}" ;;
    --vision-concurrency=*)
      VISION_CONCURRENCY_OVERRIDE="${argument#*=}"
      VISION_CONCURRENCY_OVERRIDE_PROVIDED=1
      ;;
    --pipeline-depth=*)
      PIPELINE_DEPTH_OVERRIDE="${argument#*=}"
      PIPELINE_DEPTH_OVERRIDE_PROVIDED=1
      ;;
    --require-native-work-counters) REQUIRE_NATIVE_WORK_COUNTERS=1 ;;
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
  # Calendar, Photos, and Vision validators share one mutation namespace.
  local lock_path="$database_path.palate-calendar-validation.lock"
  local guard_path="$database_path.palate-calendar-validation.guard"
  local manifest_path="$guard_path/manifest.json"
  # Keep recovery scratch copies inside the durable guard. If recovery itself
  # is SIGKILLed, the next attempt reuses these paths and the final guard
  # removal cannot leave full private database copies behind.
  local main_temp_path="$guard_path/recovery-main.tmp"
  local wal_temp_path="$guard_path/recovery-wal.tmp"
  local shm_temp_path="$guard_path/recovery-shm.tmp"
  local journal_temp_path="$guard_path/recovery-journal.tmp"
  local restore_failed=0
  local guard_removed=0
  local main_hash main_mode wal_present wal_hash wal_mode
  local shm_present shm_hash shm_mode journal_present journal_hash journal_mode
  local retain_raw_databases snapshot_path result_database_path created_by_run_id output_prefix
  local sensitive_temporary_path
  local -a sensitive_temporary_paths=()
  local key was_set value
  local -a launch_environment_keys=(
    PALATE_VISION_RESULT_PAGE_SIZE
    PALATE_VISION_RESULT_TRANSPORT
    PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH
    PALATE_VISION_CLASSIFICATION_STRATEGY
    PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY
    PALATE_VISION_CONCURRENCY
    PALATE_VISION_PIPELINE_DEPTH
    PALATE_VISION_VALIDATION_RUN_ID
    PALATE_VISIT_FOOD_DETECTION_STRATEGY
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
    print -u2 "Another Vision validation already owns this database lock: $lock_path"
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
      and ((.createdByRunId | type) == "string")
      and (.createdByRunId | test("^[A-Za-z0-9._-]+$"))
      and ((.components | type) == "object")
      and valid_component(.components.main; true)
      and valid_component(.components.wal; false)
      and valid_component(.components.shm; false)
      and valid_component(.components.journal; false)
      and ((.launchEnvironment | type) == "object")
      and .kind == "palate-vision-result-page"
      and (
        ((.launchEnvironment | keys | sort) == ([
            "PALATE_VISION_RESULT_PAGE_SIZE",
            "PALATE_VISION_RESULT_TRANSPORT",
            "PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH",
            "PALATE_VISION_CLASSIFICATION_STRATEGY",
            "PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY",
            "PALATE_VISION_CONCURRENCY",
            "PALATE_VISION_PIPELINE_DEPTH",
            "PALATE_VISION_VALIDATION_RUN_ID",
            "PALATE_VISIT_FOOD_DETECTION_STRATEGY"
          ] | sort))
        or
        ((.launchEnvironment | keys | sort) == ([
            "PALATE_VISION_RESULT_PAGE_SIZE",
            "PALATE_VISION_RESULT_TRANSPORT",
            "PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH",
            "PALATE_VISION_CLASSIFICATION_STRATEGY",
            "PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY",
            "PALATE_VISION_CONCURRENCY",
            "PALATE_VISION_PIPELINE_DEPTH",
            "PALATE_VISION_VALIDATION_RUN_ID"
          ] | sort))
        or
        ((.launchEnvironment | keys | sort) == ([
            "PALATE_VISION_RESULT_PAGE_SIZE",
            "PALATE_VISION_RESULT_TRANSPORT",
            "PALATE_VISION_CLASSIFICATION_STRATEGY",
            "PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY",
            "PALATE_VISION_CONCURRENCY",
            "PALATE_VISION_PIPELINE_DEPTH",
            "PALATE_VISION_VALIDATION_RUN_ID"
          ] | sort))
        or
        ((.launchEnvironment | keys | sort) == ([
            "PALATE_VISION_RESULT_PAGE_SIZE",
            "PALATE_VISION_CLASSIFICATION_STRATEGY",
            "PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY",
            "PALATE_VISION_CONCURRENCY",
            "PALATE_VISION_PIPELINE_DEPTH",
            "PALATE_VISION_VALIDATION_RUN_ID"
          ] | sort))
      )
      and all(.launchEnvironment[]; valid_environment)
      and ((.artifactCleanup | type) == "object")
      and ((.artifactCleanup.retainRawDatabases | type) == "boolean")
      and ((.artifactCleanup.snapshotPath | type) == "string")
      and ((.artifactCleanup.snapshotPath | length) > 0)
      and ((.artifactCleanup.resultDatabasePath | type) == "string")
      and ((.artifactCleanup.resultDatabasePath | length) > 0)
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
    if [[ -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" \
      && -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" \
      && "${PALATE_VISION_PAGE_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE:-}" == "$phase" ]]; then
      print -u2 "Injected durability sync failure: $phase"
      return 1
    fi
    if [[ "${PALATE_VISION_PAGE_HARNESS_TEST_SKIP_DURABILITY_SYNC:-0}" == "1" \
      && -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" \
      && -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" ]]; then
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
    if [[ -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" \
      && -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" \
      && "${PALATE_VISION_PAGE_HARNESS_TEST_FAIL_GUARD_REMOVAL:-0}" == "1" ]]; then
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
    if (( ! retain_raw_databases )); then
      if [[ -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" \
        && -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" \
        && "${PALATE_VISION_PAGE_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP:-0}" == "1" ]]; then
        print -u2 "Injected default raw database cleanup failure"
        return 1
      fi
      if ! rm -f -- \
        "$snapshot_path" "$snapshot_path-wal" "$snapshot_path-shm" "$snapshot_path-journal" \
        "$result_database_path" "$result_database_path-wal" \
        "$result_database_path-shm" "$result_database_path-journal"; then
        return 1
      fi
    fi
    for sensitive_temporary_path in "${sensitive_temporary_paths[@]}"; do
      rm -f -- \
        "$sensitive_temporary_path" \
        "$sensitive_temporary_path.tmp" \
        "$sensitive_temporary_path-wal" \
        "$sensitive_temporary_path-shm" \
        "$sensitive_temporary_path-journal" || return 1
    done
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
  local -a expected_temporary_paths=(
    "$output_prefix.prepared.db.tmp-$created_by_run_id"
    "$result_database_path.tmp-$created_by_run_id"
    "$database_path.install-$created_by_run_id.tmp"
    "$database_path.restore-$created_by_run_id.main.tmp"
    "$database_path.restore-$created_by_run_id.wal.tmp"
    "$database_path.restore-$created_by_run_id.shm.tmp"
    "$database_path.restore-$created_by_run_id.journal.tmp"
  )
  if jq -e \
    '.launchEnvironment | has("PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH")' \
    "$manifest_path" >/dev/null; then
    expected_temporary_paths+=(
      "$database_path.vision-result-transport-attestation.tmp-$created_by_run_id"
    )
  fi
  if (( ${#sensitive_temporary_paths} != ${#expected_temporary_paths} )); then
    recovery_cleanup_temporary_files
    trap - EXIT
    print -u2 "The durable recovery manifest has an unexpected cleanup-path set; the guard was retained"
    return 1
  fi
  local cleanup_path_index
  for (( cleanup_path_index = 1; cleanup_path_index <= ${#expected_temporary_paths}; cleanup_path_index++ )); do
    if [[ "${sensitive_temporary_paths[$cleanup_path_index]}" != "${expected_temporary_paths[$cleanup_path_index]}" ]]; then
      recovery_cleanup_temporary_files
      trap - EXIT
      print -u2 "The durable recovery manifest has an unexpected cleanup path; the guard was retained"
      return 1
    fi
  done
  local -a cleanup_candidate_bases=("${sensitive_temporary_paths[@]}")
  if (( ! retain_raw_databases )); then
    cleanup_candidate_bases+=("$snapshot_path" "$result_database_path")
  fi
  local -a protected_cleanup_paths=(
    "$database_path"
    "$database_path-wal"
    "$database_path-shm"
    "$database_path-journal"
    "$lock_path"
    "$guard_path"
    "$manifest_path"
    "$guard_path/main"
    "$guard_path/wal"
    "$guard_path/shm"
    "$guard_path/journal"
  )
  local cleanup_candidate_base cleanup_candidate_suffix cleanup_candidate protected_cleanup_path
  for cleanup_candidate_base in "${cleanup_candidate_bases[@]}"; do
    for cleanup_candidate_suffix in "" -wal -shm -journal; do
      cleanup_candidate="$cleanup_candidate_base$cleanup_candidate_suffix"
      for protected_cleanup_path in "${protected_cleanup_paths[@]}"; do
        if [[ "${cleanup_candidate:A}" == "${protected_cleanup_path:A}" ]]; then
          recovery_cleanup_temporary_files
          trap - EXIT
          print -u2 "The durable recovery manifest aliases a protected path; the guard was retained"
          return 1
        fi
      done
    done
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

  if (( ! restore_failed )) \
    && [[ -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" ]] \
    && [[ -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" ]] \
    && [[ "${PALATE_VISION_PAGE_HARNESS_TEST_PAUSE_RECOVERY_AFTER_PREPARE:-0}" == "1" ]]; then
    print -r -- "$$" > "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE/recovery-prepared"
    while [[ ! -e "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE/recovery-continue" ]]; do
      sleep 0.01
    done
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
      if ! jq -e --arg key "$key" '.launchEnvironment | has($key)' "$manifest_path" >/dev/null; then
        continue
      fi
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
if [[ -n "$SEMANTIC_REFERENCE_DATABASE_PATH" ]] \
  && { [[ ! -f "$SEMANTIC_REFERENCE_DATABASE_PATH" ]] \
    || [[ -L "$SEMANTIC_REFERENCE_DATABASE_PATH" ]]; }; then
  print -u2 "--semantic-reference-database must be a regular, non-symlinked SQLite file"
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
if [[ "$PAGE_ORCHESTRATION_STRATEGY" != "serial" && "$PAGE_ORCHESTRATION_STRATEGY" != "lookahead" ]]; then
  print -u2 -- "--page-orchestration-strategy must be serial or lookahead"
  exit 2
fi
if [[ "$RESULT_TRANSPORT" != "legacy" && "$RESULT_TRANSPORT" != "packed-v1" ]]; then
  print -u2 -- "--result-transport must be legacy or packed-v1"
  exit 2
fi
if [[ "$VISIT_FOOD_DETECTION_STRATEGY" != "full-plan-v1" \
  && "$VISIT_FOOD_DETECTION_STRATEGY" != "rank3-bulk-tail-v1" ]]; then
  print -u2 -- "--visit-food-detection-strategy must be full-plan-v1 or rank3-bulk-tail-v1"
  exit 2
fi
if (( VISION_CONCURRENCY_OVERRIDE_PROVIDED )) \
  && { [[ ! "$VISION_CONCURRENCY_OVERRIDE" =~ ^[0-9]+$ ]] \
    || (( VISION_CONCURRENCY_OVERRIDE < 1 || VISION_CONCURRENCY_OVERRIDE > 16 )); }; then
  print -u2 -- "--vision-concurrency must be an integer from 1 through 16"
  exit 2
fi
if (( PIPELINE_DEPTH_OVERRIDE_PROVIDED )) \
  && { [[ ! "$PIPELINE_DEPTH_OVERRIDE" =~ ^[0-9]+$ ]] \
    || (( PIPELINE_DEPTH_OVERRIDE < 1 || PIPELINE_DEPTH_OVERRIDE > 64 )); }; then
  print -u2 -- "--pipeline-depth must be an integer from 1 through 64"
  exit 2
fi

EFFECTIVE_VISION_CONCURRENCY="${VISION_CONCURRENCY_OVERRIDE:-$NATIVE_DEFAULT_VISION_CONCURRENCY}"
EFFECTIVE_PIPELINE_DEPTH="${PIPELINE_DEPTH_OVERRIDE:-$NATIVE_DEFAULT_PIPELINE_DEPTH}"
if (( VISION_CONCURRENCY_OVERRIDE_PROVIDED )); then
  VISION_CONCURRENCY_MODE=override
  VISION_CONCURRENCY_OVERRIDDEN_JSON=true
  VISION_CONCURRENCY_ENVIRONMENT_JSON="$VISION_CONCURRENCY_OVERRIDE"
else
  VISION_CONCURRENCY_MODE=native-default
  VISION_CONCURRENCY_OVERRIDDEN_JSON=false
  VISION_CONCURRENCY_ENVIRONMENT_JSON=null
fi
if (( PIPELINE_DEPTH_OVERRIDE_PROVIDED )); then
  PIPELINE_DEPTH_MODE=override
  PIPELINE_DEPTH_OVERRIDDEN_JSON=true
  PIPELINE_DEPTH_ENVIRONMENT_JSON="$PIPELINE_DEPTH_OVERRIDE"
else
  PIPELINE_DEPTH_MODE=native-default
  PIPELINE_DEPTH_OVERRIDDEN_JSON=false
  PIPELINE_DEPTH_ENVIRONMENT_JSON=null
fi

VALIDATION_RUN_ID="vision-page-$PAGE_SIZE-t$RESULT_TRANSPORT-o$PAGE_ORCHESTRATION_STRATEGY-c$EFFECTIVE_VISION_CONCURRENCY-d$EFFECTIVE_PIPELINE_DEPTH-$$-$(date +%s)-$RANDOM"
DATABASE_PATH="${DATABASE_PATH:A}"
APP_PATH="${APP_PATH:A}"
if [[ -n "$SEMANTIC_REFERENCE_DATABASE_PATH" ]]; then
  SEMANTIC_REFERENCE_DATABASE_PATH="${SEMANTIC_REFERENCE_DATABASE_PATH:A}"
  if [[ "$SEMANTIC_REFERENCE_DATABASE_PATH" == "$DATABASE_PATH" \
    || "$SEMANTIC_REFERENCE_DATABASE_PATH" -ef "$DATABASE_PATH" ]]; then
    print -u2 "--semantic-reference-database must not alias the live database"
    exit 2
  fi
fi
SNAPSHOT_PATH="$OUTPUT_PREFIX.$VALIDATION_RUN_ID.original.db"
PREPARED_DATABASE_PATH="$OUTPUT_PREFIX.prepared.db.tmp-$VALIDATION_RUN_ID"
RUN_DATABASE_PATH="$OUTPUT_PREFIX.result.db"
RUN_DATABASE_TEMP_PATH="$RUN_DATABASE_PATH.tmp-$VALIDATION_RUN_ID"
SAMPLES_PATH="$OUTPUT_PREFIX.samples.tsv"
REPORT_PATH="$OUTPUT_PREFIX.json"
REPORT_TEMP_PATH="$REPORT_PATH.tmp-$VALIDATION_RUN_ID"
REPORT_RESTORED_TEMP_PATH="$REPORT_PATH.restored.tmp-$VALIDATION_RUN_ID"
TRIGGER_PATH="$OUTPUT_PREFIX.trigger"
INSTALL_TEMP_PATH="$DATABASE_PATH.install-$VALIDATION_RUN_ID.tmp"
RESTORE_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.main.tmp"
RESTORE_WAL_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.wal.tmp"
RESTORE_SHM_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.shm.tmp"
RESTORE_JOURNAL_TEMP_PATH="$DATABASE_PATH.restore-$VALIDATION_RUN_ID.journal.tmp"
RESULT_TRANSPORT_ATTESTATION_PATH="$DATABASE_PATH.vision-result-transport-attestation.tmp-$VALIDATION_RUN_ID"
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
ORIGINAL_SHA256=""
ORIGINAL_MAIN_MODE=""
ORIGINAL_WAL_PRESENT=0
ORIGINAL_WAL_SHA256=""
ORIGINAL_WAL_MODE=""
ORIGINAL_SHM_PRESENT=0
ORIGINAL_SHM_SHA256=""
ORIGINAL_SHM_MODE=""
ORIGINAL_JOURNAL_PRESENT=0
ORIGINAL_JOURNAL_SHA256=""
ORIGINAL_JOURNAL_MODE=""
SEMANTIC_REFERENCE_MAIN_SIZE=""
SEMANTIC_REFERENCE_MAIN_MODE=""
SEMANTIC_REFERENCE_WAL_PRESENT=0
SEMANTIC_REFERENCE_WAL_SHA256=""
SEMANTIC_REFERENCE_WAL_MODE=""
SEMANTIC_REFERENCE_WAL_SIZE=""
SEMANTIC_REFERENCE_SHM_PRESENT=0
SEMANTIC_REFERENCE_SHM_SHA256=""
SEMANTIC_REFERENCE_SHM_MODE=""
SEMANTIC_REFERENCE_SHM_SIZE=""
SEMANTIC_REFERENCE_JOURNAL_PRESENT=0
SEMANTIC_REFERENCE_JOURNAL_SHA256=""
SEMANTIC_REFERENCE_JOURNAL_MODE=""
SEMANTIC_REFERENCE_JOURNAL_SIZE=""
GUARD_READY=0
RESTORED=0
CLEANUP_ACTIVE=0
PROCESS_APP_PATH=""
PROCESS_EXECUTABLE_PATH=""
PROCESS_EXECUTABLE_SHA256=""
PROCESS_BUNDLE_SHA256=""
TARGET_SAMPLING_INTERVAL_SECONDS=0.2
TRIGGER_MAX_AGE_SECONDS=30

typeset -a OUTPUT_ARTIFACT_PATHS=(
  "$SNAPSHOT_PATH"
  "$PREPARED_DATABASE_PATH"
  "$RUN_DATABASE_PATH"
  "$RUN_DATABASE_TEMP_PATH"
  "$SAMPLES_PATH"
  "$REPORT_PATH"
  "$REPORT_TEMP_PATH"
  "$REPORT_RESTORED_TEMP_PATH"
  "$TRIGGER_PATH"
  "$INSTALL_TEMP_PATH"
  "$RESTORE_TEMP_PATH"
  "$RESTORE_WAL_TEMP_PATH"
  "$RESTORE_SHM_TEMP_PATH"
  "$RESTORE_JOURNAL_TEMP_PATH"
  "$RESULT_TRANSPORT_ATTESTATION_PATH"
  "$DATABASE_LOCK_PATH"
  "$DATABASE_GUARD_PATH"
  "$DATABASE_GUARD_STAGE_PATH"
)
for artifact_path in "${OUTPUT_ARTIFACT_PATHS[@]}"; do
  if [[ "${artifact_path:A}" == "$DATABASE_PATH" ]] \
    || [[ -e "$artifact_path" && "$artifact_path" -ef "$DATABASE_PATH" ]]; then
    print -u2 "Output artifact must not alias the live database: $artifact_path"
    exit 2
  fi
  if [[ -n "$SEMANTIC_REFERENCE_DATABASE_PATH" ]]; then
    for semantic_reference_component_path in \
      "$SEMANTIC_REFERENCE_DATABASE_PATH" \
      "$SEMANTIC_REFERENCE_DATABASE_PATH-wal" \
      "$SEMANTIC_REFERENCE_DATABASE_PATH-shm" \
      "$SEMANTIC_REFERENCE_DATABASE_PATH-journal"; do
      if [[ "${artifact_path:A}" == "${semantic_reference_component_path:A}" ]] \
        || [[ -e "$artifact_path" && -e "$semantic_reference_component_path" \
          && "$artifact_path" -ef "$semantic_reference_component_path" ]]; then
        print -u2 "Output artifact must not alias the semantic reference database or a sidecar: $artifact_path"
        exit 2
      fi
    done
  fi
done
for retained_path in "$SAMPLES_PATH" "$REPORT_PATH"; do
  if [[ -e "$retained_path" || -L "$retained_path" ]]; then
    print -u2 "Refusing to overwrite an existing retained artifact: $retained_path"
    exit 2
  fi
done
for result_component_path in \
  "$RUN_DATABASE_PATH" \
  "$RUN_DATABASE_PATH-wal" \
  "$RUN_DATABASE_PATH-shm" \
  "$RUN_DATABASE_PATH-journal"; do
  if [[ -e "$result_component_path" || -L "$result_component_path" ]]; then
    print -u2 "Refusing to overwrite an existing result database artifact: $result_component_path"
    exit 2
  fi
done

capture_codesign_identity() {
  local app_path="$1"
  local metadata_output requirement_output
  local identifier team_identifier designated_requirement
  if ! metadata_output="$(codesign -d --verbose=4 "$app_path" 2>&1)"; then
    print -u2 "$metadata_output"
    print -u2 "Could not inspect the Palate code-signing identity: $app_path"
    return 1
  fi
  identifier="$(print -r -- "$metadata_output" | sed -n 's/^Identifier=//p' | head -1)"
  team_identifier="$(print -r -- "$metadata_output" | sed -n 's/^TeamIdentifier=//p' | head -1)"
  if ! requirement_output="$(codesign -d -r- "$app_path" 2>&1)"; then
    print -u2 "$requirement_output"
    print -u2 "Could not inspect the Palate designated requirement: $app_path"
    return 1
  fi
  designated_requirement="$(
    print -r -- "$requirement_output" \
      | sed -n 's/^designated => //p' \
      | head -1
  )"
  if [[ -z "$identifier" || -z "$team_identifier" || -z "$designated_requirement" ]]; then
    print -u2 "Palate must have a code-signing identifier, team identifier, and designated requirement: $app_path"
    return 1
  fi
  CAPTURED_CODESIGN_IDENTIFIER="$identifier"
  CAPTURED_CODESIGN_TEAM_IDENTIFIER="$team_identifier"
  CAPTURED_CODESIGN_DESIGNATED_REQUIREMENT="$designated_requirement"
}

verify_strict_app_signature() {
  local app_path="$1"
  local label="$2"
  local verification_output
  verification_output="$(codesign --verify --deep --strict --verbose=2 "$app_path" 2>&1)" || {
    print -u2 "$verification_output"
    print -u2 "$label failed strict code-signature verification"
    return 1
  }
}

for dependency in awk codesign head jq lockf lsof pgrep pkill ps sed shasum sqlite3 stat tr wc; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    print -u2 "Missing dependency: $dependency"
    exit 2
  fi
done

if [[ -L "$DATABASE_LOCK_PATH" ]]; then
  print -u2 "Refusing a symlinked database validation lock: $DATABASE_LOCK_PATH"
  exit 1
fi
exec 9> "$DATABASE_LOCK_PATH"
chmod 600 "$DATABASE_LOCK_PATH"
if ! lockf -s -t 0 9; then
  print -u2 "Another Calendar/Photo/Vision validation already owns this database lock: $DATABASE_LOCK_PATH"
  exit 75
fi

mkdir -p "$(dirname "$OUTPUT_PREFIX")"
APP_CANONICAL_PATH="$APP_PATH"
verify_strict_app_signature "$APP_PATH" "Supplied Palate.app"
capture_codesign_identity "$APP_PATH"
APP_CODESIGN_IDENTIFIER="$CAPTURED_CODESIGN_IDENTIFIER"
APP_CODESIGN_TEAM_IDENTIFIER="$CAPTURED_CODESIGN_TEAM_IDENTIFIER"
APP_CODESIGN_DESIGNATED_REQUIREMENT="$CAPTURED_CODESIGN_DESIGNATED_REQUIREMENT"
APP_EXECUTABLE_SHA256="$(shasum -a 256 "$APP_PATH/Palate" | awk '{print $1}')"
APP_BUNDLE_SHA256="$(shasum -a 256 "$APP_PATH/main.jsbundle" | awk '{print $1}')"
PRELAUNCH_APP_EXECUTABLE_SHA256="$APP_EXECUTABLE_SHA256"
PRELAUNCH_APP_BUNDLE_SHA256="$APP_BUNDLE_SHA256"
PRELAUNCH_APP_CODESIGN_IDENTIFIER="$APP_CODESIGN_IDENTIFIER"
PRELAUNCH_APP_CODESIGN_TEAM_IDENTIFIER="$APP_CODESIGN_TEAM_IDENTIFIER"
PRELAUNCH_APP_CODESIGN_DESIGNATED_REQUIREMENT="$APP_CODESIGN_DESIGNATED_REQUIREMENT"
APP_EXECUTABLE_REFRESHED_AFTER_READY_JSON=false
MANUAL_LAUNCH_JSON=false
if (( MANUAL_LAUNCH )); then
  MANUAL_LAUNCH_JSON=true
fi

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

ORIGINAL_RESULT_PAGE_SIZE="$(launchctl getenv PALATE_VISION_RESULT_PAGE_SIZE 2>/dev/null || true)"
ORIGINAL_RESULT_TRANSPORT="$(launchctl getenv PALATE_VISION_RESULT_TRANSPORT 2>/dev/null || true)"
ORIGINAL_RESULT_TRANSPORT_ATTESTATION_PATH="$(launchctl getenv PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH 2>/dev/null || true)"
ORIGINAL_CLASSIFICATION_STRATEGY="$(launchctl getenv PALATE_VISION_CLASSIFICATION_STRATEGY 2>/dev/null || true)"
ORIGINAL_PAGE_ORCHESTRATION_STRATEGY="$(launchctl getenv PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY 2>/dev/null || true)"
ORIGINAL_VISION_CONCURRENCY="$(launchctl getenv PALATE_VISION_CONCURRENCY 2>/dev/null || true)"
ORIGINAL_PIPELINE_DEPTH="$(launchctl getenv PALATE_VISION_PIPELINE_DEPTH 2>/dev/null || true)"
ORIGINAL_VALIDATION_RUN_ID="$(launchctl getenv PALATE_VISION_VALIDATION_RUN_ID 2>/dev/null || true)"
ORIGINAL_VISIT_FOOD_DETECTION_STRATEGY="$(launchctl getenv PALATE_VISIT_FOOD_DETECTION_STRATEGY 2>/dev/null || true)"
ORIGINAL_RESULT_PAGE_SIZE_SET=0
ORIGINAL_RESULT_TRANSPORT_SET=0
ORIGINAL_RESULT_TRANSPORT_ATTESTATION_PATH_SET=0
ORIGINAL_CLASSIFICATION_STRATEGY_SET=0
ORIGINAL_PAGE_ORCHESTRATION_STRATEGY_SET=0
ORIGINAL_VISION_CONCURRENCY_SET=0
ORIGINAL_PIPELINE_DEPTH_SET=0
ORIGINAL_VALIDATION_RUN_ID_SET=0
ORIGINAL_VISIT_FOOD_DETECTION_STRATEGY_SET=0
launch_environment_key_is_set PALATE_VISION_RESULT_PAGE_SIZE && ORIGINAL_RESULT_PAGE_SIZE_SET=1
launch_environment_key_is_set PALATE_VISION_RESULT_TRANSPORT && ORIGINAL_RESULT_TRANSPORT_SET=1
launch_environment_key_is_set PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH && ORIGINAL_RESULT_TRANSPORT_ATTESTATION_PATH_SET=1
launch_environment_key_is_set PALATE_VISION_CLASSIFICATION_STRATEGY && ORIGINAL_CLASSIFICATION_STRATEGY_SET=1
launch_environment_key_is_set PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY && ORIGINAL_PAGE_ORCHESTRATION_STRATEGY_SET=1
launch_environment_key_is_set PALATE_VISION_CONCURRENCY && ORIGINAL_VISION_CONCURRENCY_SET=1
launch_environment_key_is_set PALATE_VISION_PIPELINE_DEPTH && ORIGINAL_PIPELINE_DEPTH_SET=1
launch_environment_key_is_set PALATE_VISION_VALIDATION_RUN_ID && ORIGINAL_VALIDATION_RUN_ID_SET=1
launch_environment_key_is_set PALATE_VISIT_FOOD_DETECTION_STRATEGY && ORIGINAL_VISIT_FOOD_DETECTION_STRATEGY_SET=1

restore_launch_environment_value() {
  local key="$1"
  local value="$2"
  local was_set="$3"
  if (( was_set )); then
    if ! launchctl setenv "$key" "$value" \
      || [[ "$(launchctl getenv "$key" 2>/dev/null || true)" != "$value" ]] \
      || ! launch_environment_key_is_set "$key"; then
      print -u2 "Failed to exactly restore launch environment value: $key"
      return 1
    fi
  else
    if ! launchctl unsetenv "$key" || launch_environment_key_is_set "$key"; then
      print -u2 "Failed to exactly unset launch environment value: $key"
      return 1
    fi
  fi
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

vision_state_sha256() {
  local database_path="$1"
  sqlite3 "$database_path" <<'SQL'
PRAGMA query_only = ON;
SELECT lower(hex(sha3(
  sha3_query(
    'SELECT id, foodDetected, foodLabels, foodConfidence, allLabels FROM photos ORDER BY id',
    256
  ) || sha3_query(
    'SELECT id, foodProbable FROM visits ORDER BY id',
    256
  ),
  256
)));
SQL
}

remove_database_sidecars() {
  local database_path="$1"
  rm -f -- "$database_path-wal" "$database_path-shm" "$database_path-journal"
}

remove_database_set() {
  local database_path="$1"
  local failed=0
  rm -f -- "$database_path" || failed=1
  remove_database_sidecars "$database_path" || failed=1
  (( failed == 0 ))
}

durability_sync() {
  local phase="${1:-unspecified}"
  if [[ -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" \
    && "${PALATE_VISION_PAGE_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE:-}" == "$phase" ]]; then
    print -u2 "Injected durability sync failure: $phase"
    return 1
  fi
  if [[ "${PALATE_VISION_PAGE_HARNESS_TEST_SKIP_DURABILITY_SYNC:-0}" == "1" \
    && -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" ]]; then
    return 0
  fi
  /bin/sync
}

remove_database_guard() {
  if [[ -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" \
    && "${PALATE_VISION_PAGE_HARNESS_TEST_FAIL_GUARD_REMOVAL:-0}" == "1" ]]; then
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

capture_external_semantic_reference_contract() {
  local component_path component_size suffix
  if [[ ! -f "$SEMANTIC_REFERENCE_DATABASE_PATH" || -L "$SEMANTIC_REFERENCE_DATABASE_PATH" ]]; then
    print -u2 "The external semantic reference main database must remain a regular, non-symlinked file"
    return 1
  fi

  SEMANTIC_REFERENCE_SHA256="$(sha256_file "$SEMANTIC_REFERENCE_DATABASE_PATH")"
  SEMANTIC_REFERENCE_MAIN_MODE="$(stat -f '%Lp' "$SEMANTIC_REFERENCE_DATABASE_PATH")"
  SEMANTIC_REFERENCE_MAIN_SIZE="$(stat -f '%z' "$SEMANTIC_REFERENCE_DATABASE_PATH")"
  for suffix in wal shm journal; do
    component_path="$SEMANTIC_REFERENCE_DATABASE_PATH-$suffix"
    if [[ -e "$component_path" || -L "$component_path" ]]; then
      if [[ ! -f "$component_path" || -L "$component_path" ]]; then
        print -u2 "External semantic reference $suffix must be a regular, non-symlinked file when present"
        return 1
      fi
      component_size="$(stat -f '%z' "$component_path")"
      if [[ "$suffix" == "wal" || "$suffix" == "journal" ]] && (( component_size > 0 )); then
        print -u2 "External semantic reference has a nonempty $suffix; checkpoint a private copy before validation"
        return 1
      fi
      case "$suffix" in
        wal)
          SEMANTIC_REFERENCE_WAL_PRESENT=1
          SEMANTIC_REFERENCE_WAL_SHA256="$(sha256_file "$component_path")"
          SEMANTIC_REFERENCE_WAL_MODE="$(stat -f '%Lp' "$component_path")"
          SEMANTIC_REFERENCE_WAL_SIZE="$component_size"
          ;;
        shm)
          SEMANTIC_REFERENCE_SHM_PRESENT=1
          SEMANTIC_REFERENCE_SHM_SHA256="$(sha256_file "$component_path")"
          SEMANTIC_REFERENCE_SHM_MODE="$(stat -f '%Lp' "$component_path")"
          SEMANTIC_REFERENCE_SHM_SIZE="$component_size"
          ;;
        journal)
          SEMANTIC_REFERENCE_JOURNAL_PRESENT=1
          SEMANTIC_REFERENCE_JOURNAL_SHA256="$(sha256_file "$component_path")"
          SEMANTIC_REFERENCE_JOURNAL_MODE="$(stat -f '%Lp' "$component_path")"
          SEMANTIC_REFERENCE_JOURNAL_SIZE="$component_size"
          ;;
      esac
    fi
  done
}

verify_semantic_reference_component() {
  local component_path="$1"
  local expected_present="$2"
  local expected_hash="$3"
  local expected_mode="$4"
  local expected_size="$5"
  local label="$6"
  verify_optional_component \
    "$component_path" "$expected_present" "$expected_hash" "$expected_mode" "$label" || return 1
  if (( expected_present )) && [[ "$(stat -f '%z' "$component_path")" != "$expected_size" ]]; then
    print -u2 "$label size no longer matches its attested value"
    return 1
  fi
}

verify_external_semantic_reference_contract() {
  [[ -n "$SEMANTIC_REFERENCE_DATABASE_PATH" ]] || return 0
  verify_semantic_reference_component \
    "$SEMANTIC_REFERENCE_DATABASE_PATH" 1 "$SEMANTIC_REFERENCE_SHA256" \
    "$SEMANTIC_REFERENCE_MAIN_MODE" "$SEMANTIC_REFERENCE_MAIN_SIZE" \
    "External semantic reference main" || return 1
  verify_semantic_reference_component \
    "$SEMANTIC_REFERENCE_DATABASE_PATH-wal" "$SEMANTIC_REFERENCE_WAL_PRESENT" \
    "$SEMANTIC_REFERENCE_WAL_SHA256" "$SEMANTIC_REFERENCE_WAL_MODE" \
    "$SEMANTIC_REFERENCE_WAL_SIZE" "External semantic reference WAL" || return 1
  verify_semantic_reference_component \
    "$SEMANTIC_REFERENCE_DATABASE_PATH-shm" "$SEMANTIC_REFERENCE_SHM_PRESENT" \
    "$SEMANTIC_REFERENCE_SHM_SHA256" "$SEMANTIC_REFERENCE_SHM_MODE" \
    "$SEMANTIC_REFERENCE_SHM_SIZE" "External semantic reference SHM" || return 1
  verify_semantic_reference_component \
    "$SEMANTIC_REFERENCE_DATABASE_PATH-journal" "$SEMANTIC_REFERENCE_JOURNAL_PRESENT" \
    "$SEMANTIC_REFERENCE_JOURNAL_SHA256" "$SEMANTIC_REFERENCE_JOURNAL_MODE" \
    "$SEMANTIC_REFERENCE_JOURNAL_SIZE" "External semantic reference journal"
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
    if [[ "$parent_command" == *debugserver ]]; then
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

  [[ "$(sha256_file "$DATABASE_PATH")" == "$ORIGINAL_SHA256" ]]
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
    --arg resultPageSize "$ORIGINAL_RESULT_PAGE_SIZE" \
    --argjson resultPageSizeSet "$ORIGINAL_RESULT_PAGE_SIZE_SET" \
    --arg resultTransport "$ORIGINAL_RESULT_TRANSPORT" \
    --argjson resultTransportSet "$ORIGINAL_RESULT_TRANSPORT_SET" \
    --arg originalResultTransportAttestationPath "$ORIGINAL_RESULT_TRANSPORT_ATTESTATION_PATH" \
    --argjson resultTransportAttestationPathSet "$ORIGINAL_RESULT_TRANSPORT_ATTESTATION_PATH_SET" \
    --arg classificationStrategy "$ORIGINAL_CLASSIFICATION_STRATEGY" \
    --argjson classificationStrategySet "$ORIGINAL_CLASSIFICATION_STRATEGY_SET" \
    --arg pageOrchestrationStrategy "$ORIGINAL_PAGE_ORCHESTRATION_STRATEGY" \
    --argjson pageOrchestrationStrategySet "$ORIGINAL_PAGE_ORCHESTRATION_STRATEGY_SET" \
    --arg visionConcurrency "$ORIGINAL_VISION_CONCURRENCY" \
    --argjson visionConcurrencySet "$ORIGINAL_VISION_CONCURRENCY_SET" \
    --arg pipelineDepth "$ORIGINAL_PIPELINE_DEPTH" \
    --argjson pipelineDepthSet "$ORIGINAL_PIPELINE_DEPTH_SET" \
    --arg validationRunId "$ORIGINAL_VALIDATION_RUN_ID" \
    --argjson validationRunIdSet "$ORIGINAL_VALIDATION_RUN_ID_SET" \
    --arg visitFoodDetectionStrategy "$ORIGINAL_VISIT_FOOD_DETECTION_STRATEGY" \
    --argjson visitFoodDetectionStrategySet "$ORIGINAL_VISIT_FOOD_DETECTION_STRATEGY_SET" \
    --argjson retainRawDatabases "$RETAIN_RAW_DATABASES" \
    --arg snapshotPath "${SNAPSHOT_PATH:A}" \
    --arg resultDatabasePath "${RUN_DATABASE_PATH:A}" \
    --arg preparedDatabasePath "${PREPARED_DATABASE_PATH:A}" \
    --arg runDatabaseTempPath "${RUN_DATABASE_TEMP_PATH:A}" \
    --arg installTempPath "${INSTALL_TEMP_PATH:A}" \
    --arg restoreMainTempPath "${RESTORE_TEMP_PATH:A}" \
    --arg restoreWalTempPath "${RESTORE_WAL_TEMP_PATH:A}" \
    --arg restoreShmTempPath "${RESTORE_SHM_TEMP_PATH:A}" \
    --arg restoreJournalTempPath "${RESTORE_JOURNAL_TEMP_PATH:A}" \
    --arg resultTransportAttestationPath "${RESULT_TRANSPORT_ATTESTATION_PATH:A}" \
    '{
      schemaVersion: 1,
      kind: "palate-vision-result-page",
      databasePath: $databasePath,
      createdByRunId: $runId,
      components: {
        main: {present: true, sha256: $mainSha256, size: $mainSize, mode: $mainMode},
        wal: {present: ($walPresent == 1), sha256: (if $walPresent == 1 then $walSha256 else null end), size: (if $walPresent == 1 then $walSize else null end), mode: (if $walPresent == 1 then $walMode else null end)},
        shm: {present: ($shmPresent == 1), sha256: (if $shmPresent == 1 then $shmSha256 else null end), size: (if $shmPresent == 1 then $shmSize else null end), mode: (if $shmPresent == 1 then $shmMode else null end)},
        journal: {present: ($journalPresent == 1), sha256: (if $journalPresent == 1 then $journalSha256 else null end), size: (if $journalPresent == 1 then $journalSize else null end), mode: (if $journalPresent == 1 then $journalMode else null end)}
      },
      launchEnvironment: {
        PALATE_VISION_RESULT_PAGE_SIZE: {wasSet: ($resultPageSizeSet == 1), value: $resultPageSize},
        PALATE_VISION_RESULT_TRANSPORT: {wasSet: ($resultTransportSet == 1), value: $resultTransport},
        PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH: {wasSet: ($resultTransportAttestationPathSet == 1), value: $originalResultTransportAttestationPath},
        PALATE_VISION_CLASSIFICATION_STRATEGY: {wasSet: ($classificationStrategySet == 1), value: $classificationStrategy},
        PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY: {wasSet: ($pageOrchestrationStrategySet == 1), value: $pageOrchestrationStrategy},
        PALATE_VISION_CONCURRENCY: {wasSet: ($visionConcurrencySet == 1), value: $visionConcurrency},
        PALATE_VISION_PIPELINE_DEPTH: {wasSet: ($pipelineDepthSet == 1), value: $pipelineDepth},
        PALATE_VISION_VALIDATION_RUN_ID: {wasSet: ($validationRunIdSet == 1), value: $validationRunId},
        PALATE_VISIT_FOOD_DETECTION_STRATEGY: {wasSet: ($visitFoodDetectionStrategySet == 1), value: $visitFoodDetectionStrategy}
      },
      artifactCleanup: {
        retainRawDatabases: ($retainRawDatabases == 1),
        snapshotPath: $snapshotPath,
        resultDatabasePath: $resultDatabasePath,
        temporaryPaths: [
          $preparedDatabasePath,
          $runDatabaseTempPath,
          $installTempPath,
          $restoreMainTempPath,
          $restoreWalTempPath,
          $restoreShmTempPath,
          $restoreJournalTempPath,
          $resultTransportAttestationPath
        ]
      }
    }' > "$GUARD_STAGE_MANIFEST_PATH.tmp"
  chmod 600 "$GUARD_STAGE_MANIFEST_PATH.tmp"
  mv -f -- "$GUARD_STAGE_MANIFEST_PATH.tmp" "$GUARD_STAGE_MANIFEST_PATH"
  durability_sync guard-stage
  mv -- "$DATABASE_GUARD_STAGE_PATH" "$DATABASE_GUARD_PATH"
  durability_sync guard-published
  GUARD_READY=1
}

prepare_restore_file() {
  local protected_path="$1"
  local temporary_path="$2"
  local expected_hash="$3"
  rm -f -- "$temporary_path"
  cp "$protected_path" "$temporary_path"
  chmod 600 "$temporary_path"
  if [[ "$(sha256_file "$temporary_path")" != "$expected_hash" ]]; then
    print -u2 "Prepared restoration component hash mismatch: $protected_path"
    return 1
  fi
}

assert_wal_checkpoint() {
  local database_path="$1"
  local checkpoint_result busy log_frames checkpointed_frames wal_size
  checkpoint_result="$(sqlite3 "$database_path" "PRAGMA wal_checkpoint(TRUNCATE);")" || {
    print -u2 "WAL checkpoint failed for $database_path"
    return 1
  }
  IFS='|' read -r busy log_frames checkpointed_frames <<< "$checkpoint_result"
  if [[ ! "$busy" =~ ^[0-9]+$ ]] \
    || { [[ ! "$log_frames" =~ ^[0-9]+$ || ! "$checkpointed_frames" =~ ^[0-9]+$ ]] \
      && [[ "$log_frames|$checkpointed_frames" != "-1|-1" ]]; } \
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

immutable_sqlite_uri() {
  local database_path="$1"
  local encoded_path
  encoded_path="$(jq -nr --arg path "${database_path:A}" '$path | @uri')"
  print -rn -- "file:$encoded_path?mode=ro&immutable=1"
}

refresh_manual_launch_app_attestation() {
  local canonical_path_before canonical_path_after
  local executable_hash_before executable_hash_after
  local bundle_hash_before bundle_hash_after
  canonical_path_before="${APP_PATH:A}"
  if [[ "$canonical_path_before" != "$APP_CANONICAL_PATH" ]]; then
    print -u2 "Manual launch changed the canonical --app path"
    print -u2 "Canonical path expected=$APP_CANONICAL_PATH actual=$canonical_path_before"
    return 1
  fi
  if [[ ! -d "$APP_PATH" || ! -x "$APP_PATH/Palate" || ! -s "$APP_PATH/main.jsbundle" ]]; then
    print -u2 "Manual launch did not leave a complete Palate.app at the canonical --app path"
    return 1
  fi

  executable_hash_before="$(sha256_file "$APP_PATH/Palate")"
  bundle_hash_before="$(sha256_file "$APP_PATH/main.jsbundle")"
  verify_strict_app_signature "$APP_PATH" "Manual launch rebuilt Palate.app" || return 1
  capture_codesign_identity "$APP_PATH" || return 1
  canonical_path_after="${APP_PATH:A}"
  executable_hash_after="$(sha256_file "$APP_PATH/Palate")"
  bundle_hash_after="$(sha256_file "$APP_PATH/main.jsbundle")"

  if [[ "$canonical_path_after" != "$canonical_path_before" \
    || "$canonical_path_after" != "$APP_CANONICAL_PATH" ]]; then
    print -u2 "Manual launch changed the canonical --app path during post-build attestation"
    return 1
  fi
  if [[ "$executable_hash_after" != "$executable_hash_before" \
    || "$bundle_hash_after" != "$bundle_hash_before" ]]; then
    print -u2 "Manual launch rebuilt --app changed during post-build attestation"
    return 1
  fi
  if [[ "$bundle_hash_after" != "$PRELAUNCH_APP_BUNDLE_SHA256" ]]; then
    print -u2 "Manual launch rebuilt --app changed main.jsbundle"
    print -u2 "main.jsbundle expected=$PRELAUNCH_APP_BUNDLE_SHA256 actual=$bundle_hash_after"
    return 1
  fi
  if [[ "$CAPTURED_CODESIGN_IDENTIFIER" != "$PRELAUNCH_APP_CODESIGN_IDENTIFIER" ]]; then
    print -u2 "Manual launch rebuilt --app changed its code-signing identifier"
    return 1
  fi
  if [[ "$CAPTURED_CODESIGN_TEAM_IDENTIFIER" != "$PRELAUNCH_APP_CODESIGN_TEAM_IDENTIFIER" ]]; then
    print -u2 "Manual launch rebuilt --app changed its code-signing team identifier"
    return 1
  fi
  if [[ "$CAPTURED_CODESIGN_DESIGNATED_REQUIREMENT" \
    != "$PRELAUNCH_APP_CODESIGN_DESIGNATED_REQUIREMENT" ]]; then
    print -u2 "Manual launch rebuilt --app changed its designated requirement"
    return 1
  fi

  APP_EXECUTABLE_SHA256="$executable_hash_after"
  APP_BUNDLE_SHA256="$bundle_hash_after"
  APP_CODESIGN_IDENTIFIER="$CAPTURED_CODESIGN_IDENTIFIER"
  APP_CODESIGN_TEAM_IDENTIFIER="$CAPTURED_CODESIGN_TEAM_IDENTIFIER"
  APP_CODESIGN_DESIGNATED_REQUIREMENT="$CAPTURED_CODESIGN_DESIGNATED_REQUIREMENT"
  if [[ "$APP_EXECUTABLE_SHA256" != "$PRELAUNCH_APP_EXECUTABLE_SHA256" ]]; then
    APP_EXECUTABLE_REFRESHED_AFTER_READY_JSON=true
  fi
}

attest_process_bundle() {
  local process_executable process_app
  local executable_hash_before executable_hash_after
  local bundle_hash_before bundle_hash_after
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
  executable_hash_before="$(sha256_file "$process_executable")"
  bundle_hash_before="$(sha256_file "$process_app/main.jsbundle")"
  verify_strict_app_signature "$process_app" "Running process bundle" || return 1
  capture_codesign_identity "$process_app" || return 1
  executable_hash_after="$(sha256_file "$process_executable")"
  bundle_hash_after="$(sha256_file "$process_app/main.jsbundle")"
  if [[ "$executable_hash_after" != "$executable_hash_before" \
    || "$bundle_hash_after" != "$bundle_hash_before" ]]; then
    print -u2 "Running Palate bundle changed during process attestation"
    return 1
  fi
  if [[ "$CAPTURED_CODESIGN_IDENTIFIER" != "$APP_CODESIGN_IDENTIFIER" \
    || "$CAPTURED_CODESIGN_TEAM_IDENTIFIER" != "$APP_CODESIGN_TEAM_IDENTIFIER" \
    || "$CAPTURED_CODESIGN_DESIGNATED_REQUIREMENT" != "$APP_CODESIGN_DESIGNATED_REQUIREMENT" ]]; then
    print -u2 "Running Palate bundle code-signing identity does not match current --app"
    return 1
  fi
  PROCESS_EXECUTABLE_PATH="$process_executable"
  PROCESS_APP_PATH="$process_app"
  PROCESS_EXECUTABLE_SHA256="$executable_hash_after"
  PROCESS_BUNDLE_SHA256="$bundle_hash_after"
  if [[ "$PROCESS_EXECUTABLE_SHA256" != "$APP_EXECUTABLE_SHA256" \
    || "$PROCESS_BUNDLE_SHA256" != "$APP_BUNDLE_SHA256" ]]; then
    print -u2 "Running Palate bundle does not match --app"
    print -u2 "Executable expected=$APP_EXECUTABLE_SHA256 actual=$PROCESS_EXECUTABLE_SHA256"
    print -u2 "main.jsbundle expected=$APP_BUNDLE_SHA256 actual=$PROCESS_BUNDLE_SHA256"
    return 1
  fi
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
        '.schemaVersion == 1
         and .kind == "palate-vision-result-page"
         and .databasePath == $databasePath
         and .createdByRunId == $runId' \
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
        if (( ! restore_failed && ORIGINAL_WAL_PRESENT )); then
          prepare_restore_file "$GUARD_WAL_PATH" "$RESTORE_WAL_TEMP_PATH" "$ORIGINAL_WAL_SHA256" || restore_failed=1
        fi
        if (( ! restore_failed && ORIGINAL_SHM_PRESENT )); then
          prepare_restore_file "$GUARD_SHM_PATH" "$RESTORE_SHM_TEMP_PATH" "$ORIGINAL_SHM_SHA256" || restore_failed=1
        fi
        if (( ! restore_failed && ORIGINAL_JOURNAL_PRESENT )); then
          prepare_restore_file "$GUARD_JOURNAL_PATH" "$RESTORE_JOURNAL_TEMP_PATH" "$ORIGINAL_JOURNAL_SHA256" || restore_failed=1
        fi
      fi
      if (( ! restore_failed )); then
        remove_database_set "$DATABASE_PATH" || restore_failed=1
      fi
      if (( ! restore_failed )); then
        mv -f -- "$RESTORE_TEMP_PATH" "$DATABASE_PATH" || restore_failed=1
        (( ! restore_failed )) && chmod "$ORIGINAL_MAIN_MODE" "$DATABASE_PATH" || restore_failed=1
        if (( ! restore_failed && ORIGINAL_WAL_PRESENT )); then
          mv -f -- "$RESTORE_WAL_TEMP_PATH" "$DATABASE_PATH-wal" || restore_failed=1
          (( ! restore_failed )) && chmod "$ORIGINAL_WAL_MODE" "$DATABASE_PATH-wal" || restore_failed=1
        fi
        if (( ! restore_failed && ORIGINAL_SHM_PRESENT )); then
          mv -f -- "$RESTORE_SHM_TEMP_PATH" "$DATABASE_PATH-shm" || restore_failed=1
          (( ! restore_failed )) && chmod "$ORIGINAL_SHM_MODE" "$DATABASE_PATH-shm" || restore_failed=1
        fi
        if (( ! restore_failed && ORIGINAL_JOURNAL_PRESENT )); then
          mv -f -- "$RESTORE_JOURNAL_TEMP_PATH" "$DATABASE_PATH-journal" || restore_failed=1
          (( ! restore_failed )) && chmod "$ORIGINAL_JOURNAL_MODE" "$DATABASE_PATH-journal" || restore_failed=1
        fi
      fi
      if (( ! restore_failed )); then
        if [[ "$(sha256_file "$DATABASE_PATH")" != "$ORIGINAL_SHA256" \
          || "$(stat -f '%Lp' "$DATABASE_PATH")" != "$ORIGINAL_MAIN_MODE" ]]; then
          print -u2 "Restored live database hash or mode mismatch"
          restore_failed=1
        fi
        verify_optional_component "$DATABASE_PATH-wal" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "$ORIGINAL_WAL_MODE" "Restored WAL" || restore_failed=1
        verify_optional_component "$DATABASE_PATH-shm" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "$ORIGINAL_SHM_MODE" "Restored SHM" || restore_failed=1
        verify_optional_component "$DATABASE_PATH-journal" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "$ORIGINAL_JOURNAL_MODE" "Restored journal" || restore_failed=1
        if (( ! restore_failed )); then
          if durability_sync restore-database; then
            RESTORED=1
          else
            print -u2 "Failed to durably synchronize the restored database"
            restore_failed=1
          fi
        fi
      fi
    fi
  fi

  restore_launch_environment_value PALATE_VISION_RESULT_PAGE_SIZE "$ORIGINAL_RESULT_PAGE_SIZE" "$ORIGINAL_RESULT_PAGE_SIZE_SET" || restore_failed=1
  restore_launch_environment_value PALATE_VISION_RESULT_TRANSPORT "$ORIGINAL_RESULT_TRANSPORT" "$ORIGINAL_RESULT_TRANSPORT_SET" || restore_failed=1
  restore_launch_environment_value PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH "$ORIGINAL_RESULT_TRANSPORT_ATTESTATION_PATH" "$ORIGINAL_RESULT_TRANSPORT_ATTESTATION_PATH_SET" || restore_failed=1
  restore_launch_environment_value PALATE_VISION_CLASSIFICATION_STRATEGY "$ORIGINAL_CLASSIFICATION_STRATEGY" "$ORIGINAL_CLASSIFICATION_STRATEGY_SET" || restore_failed=1
  restore_launch_environment_value PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY "$ORIGINAL_PAGE_ORCHESTRATION_STRATEGY" "$ORIGINAL_PAGE_ORCHESTRATION_STRATEGY_SET" || restore_failed=1
  restore_launch_environment_value PALATE_VISION_CONCURRENCY "$ORIGINAL_VISION_CONCURRENCY" "$ORIGINAL_VISION_CONCURRENCY_SET" || restore_failed=1
  restore_launch_environment_value PALATE_VISION_PIPELINE_DEPTH "$ORIGINAL_PIPELINE_DEPTH" "$ORIGINAL_PIPELINE_DEPTH_SET" || restore_failed=1
  restore_launch_environment_value PALATE_VISION_VALIDATION_RUN_ID "$ORIGINAL_VALIDATION_RUN_ID" "$ORIGINAL_VALIDATION_RUN_ID_SET" || restore_failed=1
  restore_launch_environment_value PALATE_VISIT_FOOD_DETECTION_STRATEGY "$ORIGINAL_VISIT_FOOD_DETECTION_STRATEGY" "$ORIGINAL_VISIT_FOOD_DETECTION_STRATEGY_SET" || restore_failed=1

  remove_database_set "$PREPARED_DATABASE_PATH" || restore_failed=1
  remove_database_set "$RUN_DATABASE_TEMP_PATH" || restore_failed=1
  remove_database_set "$INSTALL_TEMP_PATH" || restore_failed=1
  remove_database_set "$RESTORE_TEMP_PATH" || restore_failed=1
  remove_database_set "$RESTORE_WAL_TEMP_PATH" || restore_failed=1
  remove_database_set "$RESTORE_SHM_TEMP_PATH" || restore_failed=1
  remove_database_set "$RESTORE_JOURNAL_TEMP_PATH" || restore_failed=1
  rm -f -- "$RESULT_TRANSPORT_ATTESTATION_PATH" "$RESULT_TRANSPORT_ATTESTATION_PATH.tmp" || restore_failed=1
  if (( ! GUARD_READY )) && [[ -d "$DATABASE_GUARD_STAGE_PATH" && ! -L "$DATABASE_GUARD_STAGE_PATH" ]]; then
    rm -rf -- "$DATABASE_GUARD_STAGE_PATH" || restore_failed=1
  fi
  (( restore_failed == 0 ))
}

finalize_database_guard() {
  if (( ! GUARD_READY )); then
    return 0
  fi
  if (( ! RESTORED )); then
    print -u2 "Refusing to remove the durable guard before database restoration"
    return 1
  fi
  if ! remove_database_guard; then
    print -u2 "Failed to remove the durable database recovery guard"
    return 1
  fi
  GUARD_READY=0
  if ! durability_sync guard-removed; then
    print -u2 "The database, environment, and raw policy were restored, but durable guard deletion could not be confirmed"
    return 1
  fi
}

cleanup_sensitive_database_copies() {
  remove_database_set "$PREPARED_DATABASE_PATH" || return 1
  if (( RETAIN_RAW_DATABASES )); then
    return 0
  fi
  if [[ -n "${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_VISION_PAGE_HARNESS_FAKE_STATE" \
    && "${PALATE_VISION_PAGE_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP:-0}" == "1" ]]; then
    print -u2 "Injected default raw database cleanup failure"
    return 1
  fi
  local failed=0
  remove_database_set "$SNAPSHOT_PATH" || failed=1
  remove_database_set "$RUN_DATABASE_PATH" || failed=1
  (( failed == 0 ))
}

handle_signal() {
  local exit_code="$1"
  trap '' INT TERM HUP
  exit "$exit_code"
}

handle_exit() {
  local observed_exit_code="$?"
  local exit_code="${1:-$observed_exit_code}"
  if (( CLEANUP_ACTIVE )); then
    exit "$exit_code"
  fi
  CLEANUP_ACTIVE=1
  trap '' INT TERM HUP
  trap - EXIT ZERR
  if ! restore_database; then
    print -u2 "One or more restoration steps failed"
    (( exit_code == 0 )) && exit_code=1
  elif ! cleanup_sensitive_database_copies; then
    print -u2 "One or more sensitive database copies could not be removed"
    (( exit_code == 0 )) && exit_code=1
  elif ! finalize_database_guard; then
    print -u2 "The durable database guard could not be finalized"
    (( exit_code == 0 )) && exit_code=1
  fi
  if (( exit_code != 0 )); then
    local report_was_published=0
    [[ -e "$REPORT_PATH" || -L "$REPORT_PATH" ]] && report_was_published=1
    if ! rm -f -- "$REPORT_TEMP_PATH" "$REPORT_RESTORED_TEMP_PATH" "$REPORT_PATH"; then
      print -u2 "Failed to remove an unpublished validation report artifact"
    elif (( report_was_published )); then
      durability_sync failed-report-removed || \
        print -u2 "Failed to durably synchronize removal of an unpublished validation report"
    fi
  fi
  exit "$exit_code"
}

handle_error() {
  local exit_code="$?"
  if (( ZSH_SUBSHELL > 0 )); then
    return "$exit_code"
  fi
  handle_exit "$exit_code"
}

trap handle_exit EXIT
trap handle_error ZERR
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

if [[ -n "$SEMANTIC_REFERENCE_DATABASE_PATH" ]]; then
  capture_external_semantic_reference_contract
  verify_external_semantic_reference_contract
fi

capture_database_guard

remove_database_set "$SNAPSHOT_PATH"
copy_and_attest_private "$GUARD_MAIN_PATH" "$SNAPSHOT_PATH" >/dev/null
(( ORIGINAL_WAL_PRESENT )) && copy_and_attest_private "$GUARD_WAL_PATH" "$SNAPSHOT_PATH-wal" >/dev/null
(( ORIGINAL_SHM_PRESENT )) && copy_and_attest_private "$GUARD_SHM_PATH" "$SNAPSHOT_PATH-shm" >/dev/null
(( ORIGINAL_JOURNAL_PRESENT )) && copy_and_attest_private "$GUARD_JOURNAL_PATH" "$SNAPSHOT_PATH-journal" >/dev/null
assert_wal_checkpoint "$SNAPSHOT_PATH"
remove_database_sidecars "$SNAPSHOT_PATH"
chmod 600 "$SNAPSHOT_PATH"
STANDALONE_SNAPSHOT_SHA256="$(sha256_file "$SNAPSHOT_PATH")"
SNAPSHOT_URI="$(immutable_sqlite_uri "$SNAPSHOT_PATH")"
SQL_ESCAPED_SNAPSHOT_URI="$(print -rn -- "$SNAPSHOT_URI" | sed "s/'/''/g")"

if [[ -n "$SEMANTIC_REFERENCE_DATABASE_PATH" ]]; then
  SEMANTIC_REFERENCE_SOURCE="external-current-control"
  verify_external_semantic_reference_contract
  SEMANTIC_REFERENCE_URI="$(immutable_sqlite_uri "$SEMANTIC_REFERENCE_DATABASE_PATH")"
  SEMANTIC_REFERENCE_INTEGRITY="$(sqlite3 -readonly "$SEMANTIC_REFERENCE_URI" "PRAGMA integrity_check;")"
  if [[ "$SEMANTIC_REFERENCE_INTEGRITY" != "ok" ]]; then
    print -u2 "The external semantic reference failed SQLite integrity validation"
    exit 1
  fi
  SQL_ESCAPED_SEMANTIC_REFERENCE_URI="$(print -rn -- "$SEMANTIC_REFERENCE_URI" | sed "s/'/''/g")"
  read REFERENCE_PHOTO_ID_MISMATCH_COUNT REFERENCE_VISIT_ID_MISMATCH_COUNT <<<"$(
    sqlite3 -readonly -separator ' ' "$SNAPSHOT_URI" <<SQL
ATTACH DATABASE '$SQL_ESCAPED_SEMANTIC_REFERENCE_URI' AS reference;
SELECT
  (SELECT COUNT(*) FROM (SELECT id FROM photos EXCEPT SELECT id FROM reference.photos))
    + (SELECT COUNT(*) FROM (SELECT id FROM reference.photos EXCEPT SELECT id FROM photos)),
  (SELECT COUNT(*) FROM (SELECT id FROM visits EXCEPT SELECT id FROM reference.visits))
    + (SELECT COUNT(*) FROM (SELECT id FROM reference.visits EXCEPT SELECT id FROM visits));
DETACH DATABASE reference;
SQL
  )"
  if (( REFERENCE_PHOTO_ID_MISMATCH_COUNT != 0 || REFERENCE_VISIT_ID_MISMATCH_COUNT != 0 )); then
    print -u2 "The external semantic reference does not have the exact live photo/visit identity"
    exit 1
  fi
else
  SEMANTIC_REFERENCE_SOURCE="live-original-snapshot"
  SEMANTIC_REFERENCE_SHA256="$STANDALONE_SNAPSHOT_SHA256"
  SEMANTIC_REFERENCE_MAIN_MODE="$(stat -f '%Lp' "$SNAPSHOT_PATH")"
  SEMANTIC_REFERENCE_MAIN_SIZE="$(stat -f '%z' "$SNAPSHOT_PATH")"
  SEMANTIC_REFERENCE_URI="$SNAPSHOT_URI"
  SQL_ESCAPED_SEMANTIC_REFERENCE_URI="$SQL_ESCAPED_SNAPSHOT_URI"
fi

EXPECTED_FOOD_COUNT="$(sqlite3 -readonly "$SEMANTIC_REFERENCE_URI" "SELECT COUNT(*) FROM photos WHERE foodDetected = 1;")"
EXPECTED_FOOD_VISIT_COUNT="$(sqlite3 -readonly "$SEMANTIC_REFERENCE_URI" "SELECT COUNT(*) FROM visits WHERE foodProbable = 1;")"
FIXTURE_COUNT="$(sqlite3 -readonly "$SEMANTIC_REFERENCE_URI" "SELECT COUNT(*) FROM photos WHERE allLabels IS NOT NULL;")"
FIXTURE_WITHOUT_VISIT_COUNT="$(sqlite3 -readonly "$SEMANTIC_REFERENCE_URI" "SELECT COUNT(*) FROM photos WHERE allLabels IS NOT NULL AND visitId IS NULL;")"
if (( FIXTURE_COUNT != EXPECTED_FIXTURE_COUNT )); then
  print -u2 "Expected $EXPECTED_FIXTURE_COUNT classified fixture rows, found $FIXTURE_COUNT"
  exit 1
fi
if (( FIXTURE_WITHOUT_VISIT_COUNT != 0 )); then
  print -u2 "The classified fixture contains $FIXTURE_WITHOUT_VISIT_COUNT photos without a visit"
  exit 1
fi

PREPARED_VISIT_FOOD_SENTINEL=0
if [[ "$VISIT_FOOD_DETECTION_STRATEGY" == "rank3-bulk-tail-v1" ]]; then
  PREPARED_VISIT_FOOD_SENTINEL=-1
fi

cp "$SNAPSHOT_PATH" "$PREPARED_DATABASE_PATH"
chmod 600 "$PREPARED_DATABASE_PATH"
sqlite3 "$PREPARED_DATABASE_PATH" <<SQL
ATTACH DATABASE '$SQL_ESCAPED_SEMANTIC_REFERENCE_URI' AS reference;
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
-- The adaptive arm uses a non-boolean sentinel so its single final visit
-- synchronization is a durable completion boundary even when an attempted
-- asset is missing or fails and therefore correctly remains pending. The
-- full-plan fixture preserves its historical zero initialization exactly.
UPDATE visits SET foodProbable = $PREPARED_VISIT_FOOD_SENTINEL;
COMMIT;
DETACH DATABASE reference;
SQL
assert_wal_checkpoint "$PREPARED_DATABASE_PATH"
remove_database_sidecars "$PREPARED_DATABASE_PATH"
PREPARED_DATABASE_URI="$(immutable_sqlite_uri "$PREPARED_DATABASE_PATH")"
PENDING_COUNT="$(sqlite3 -readonly "$PREPARED_DATABASE_URI" "SELECT COUNT(*) FROM photos WHERE foodDetected IS NULL;")"
if (( PENDING_COUNT != EXPECTED_FIXTURE_COUNT )); then
  print -u2 "Fixture preparation produced $PENDING_COUNT pending rows, expected $EXPECTED_FIXTURE_COUNT"
  exit 1
fi
PREPARED_DATABASE_SHA256="$(sha256_file "$PREPARED_DATABASE_PATH")"
PREPARED_VISION_STATE_SHA256="$(vision_state_sha256 "$PREPARED_DATABASE_URI")"
if [[ ! "$PREPARED_VISION_STATE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  print -u2 "Could not compute the prepared Vision-state digest"
  exit 1
fi

cp "$PREPARED_DATABASE_PATH" "$INSTALL_TEMP_PATH"
chmod "$ORIGINAL_MAIN_MODE" "$INSTALL_TEMP_PATH"
if [[ "$(sha256_file "$INSTALL_TEMP_PATH")" != "$PREPARED_DATABASE_SHA256" ]]; then
  print -u2 "Installed disposable database hash mismatch before installation"
  exit 1
fi
stop_palate
assert_database_unopened
if [[ "$(sha256_file "$DATABASE_PATH")" != "$ORIGINAL_SHA256" \
  || "$(stat -f '%Lp' "$DATABASE_PATH")" != "$ORIGINAL_MAIN_MODE" ]]; then
  print -u2 "The live database changed after durable guard capture"
  exit 1
fi
verify_optional_component "$DATABASE_PATH-wal" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "$ORIGINAL_WAL_MODE" "Pre-install live WAL"
verify_optional_component "$DATABASE_PATH-shm" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "$ORIGINAL_SHM_MODE" "Pre-install live SHM"
verify_optional_component "$DATABASE_PATH-journal" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "$ORIGINAL_JOURNAL_MODE" "Pre-install live journal"
remove_database_set "$DATABASE_PATH"
mv -f -- "$INSTALL_TEMP_PATH" "$DATABASE_PATH"
durability_sync installed-disposable
if [[ "$(sha256_file "$DATABASE_PATH")" != "$PREPARED_DATABASE_SHA256" ]]; then
  print -u2 "Installed disposable database hash mismatch"
  exit 1
fi

rm -f -- \
  "$TRIGGER_PATH" \
  "$REPORT_TEMP_PATH" \
  "$REPORT_RESTORED_TEMP_PATH" \
  "$RESULT_TRANSPORT_ATTESTATION_PATH" \
  "$RESULT_TRANSPORT_ATTESTATION_PATH.tmp"
remove_database_set "$RUN_DATABASE_TEMP_PATH"
remove_database_set "$RUN_DATABASE_PATH"
print "elapsed_s\tpending\trss_kib" > "$SAMPLES_PATH"
chmod 600 "$SAMPLES_PATH"

launchctl setenv PALATE_VISION_RESULT_PAGE_SIZE "$PAGE_SIZE"
launchctl setenv PALATE_VISION_RESULT_TRANSPORT "$RESULT_TRANSPORT"
launchctl setenv PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH "$RESULT_TRANSPORT_ATTESTATION_PATH"
launchctl setenv PALATE_VISION_VALIDATION_RUN_ID "$VALIDATION_RUN_ID"
launchctl setenv PALATE_VISIT_FOOD_DETECTION_STRATEGY "$VISIT_FOOD_DETECTION_STRATEGY"
launchctl unsetenv PALATE_VISION_CLASSIFICATION_STRATEGY
launchctl setenv PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY "$PAGE_ORCHESTRATION_STRATEGY"
if (( VISION_CONCURRENCY_OVERRIDE_PROVIDED )); then
  launchctl setenv PALATE_VISION_CONCURRENCY "$VISION_CONCURRENCY_OVERRIDE"
else
  launchctl unsetenv PALATE_VISION_CONCURRENCY
fi
if (( PIPELINE_DEPTH_OVERRIDE_PROVIDED )); then
  launchctl setenv PALATE_VISION_PIPELINE_DEPTH "$PIPELINE_DEPTH_OVERRIDE"
else
  launchctl unsetenv PALATE_VISION_PIPELINE_DEPTH
fi

if (( MANUAL_LAUNCH )); then
  print \
    "READY_TO_LAUNCH run_id=$VALIDATION_RUN_ID page_size=$PAGE_SIZE result_transport_requested=$RESULT_TRANSPORT result_transport_expected=$RESULT_TRANSPORT visit_food_detection_strategy=$VISIT_FOOD_DETECTION_STRATEGY page_orchestration_strategy=$PAGE_ORCHESTRATION_STRATEGY vision_concurrency=$EFFECTIVE_VISION_CONCURRENCY vision_concurrency_mode=$VISION_CONCURRENCY_MODE pipeline_depth=$EFFECTIVE_PIPELINE_DEPTH pipeline_depth_mode=$PIPELINE_DEPTH_MODE required_action=$VALIDATION_TRIGGER_ACTION validation_entrypoint=$VALIDATION_ENTRYPOINT rescan_allowed=false"
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
if (( MANUAL_LAUNCH )); then
  refresh_manual_launch_app_attestation
fi
attest_process_bundle

PROCESS_ENVIRONMENT="$(ps eww -p "$APP_PID" -o command=)"
EXPECTED_PAGE_ENV="PALATE_VISION_RESULT_PAGE_SIZE=$PAGE_SIZE"
EXPECTED_RESULT_TRANSPORT_ENV="PALATE_VISION_RESULT_TRANSPORT=$RESULT_TRANSPORT"
EXPECTED_RESULT_TRANSPORT_ATTESTATION_PATH_ENV="PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH=$RESULT_TRANSPORT_ATTESTATION_PATH"
EXPECTED_RUN_ENV="PALATE_VISION_VALIDATION_RUN_ID=$VALIDATION_RUN_ID"
EXPECTED_VISIT_FOOD_DETECTION_STRATEGY_ENV="PALATE_VISIT_FOOD_DETECTION_STRATEGY=$VISIT_FOOD_DETECTION_STRATEGY"
EXPECTED_PAGE_ORCHESTRATION_ENV="PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY=$PAGE_ORCHESTRATION_STRATEGY"
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_PAGE_ENV "* ]] \
  || [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_RUN_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit the requested validation environment"
  exit 1
fi
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_PAGE_ORCHESTRATION_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit $EXPECTED_PAGE_ORCHESTRATION_ENV"
  exit 1
fi
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_RESULT_TRANSPORT_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit $EXPECTED_RESULT_TRANSPORT_ENV"
  exit 1
fi
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_RESULT_TRANSPORT_ATTESTATION_PATH_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH"
  exit 1
fi
if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_VISIT_FOOD_DETECTION_STRATEGY_ENV "* ]]; then
  print -u2 "Launched Palate process did not inherit $EXPECTED_VISIT_FOOD_DETECTION_STRATEGY_ENV"
  exit 1
fi
if [[ " $PROCESS_ENVIRONMENT " == *" PALATE_VISION_CLASSIFICATION_STRATEGY="* ]]; then
  print -u2 "Launched Palate process unexpectedly inherited PALATE_VISION_CLASSIFICATION_STRATEGY instead of using the pipeline default"
  exit 1
fi
if (( VISION_CONCURRENCY_OVERRIDE_PROVIDED )); then
  EXPECTED_CONCURRENCY_ENV="PALATE_VISION_CONCURRENCY=$VISION_CONCURRENCY_OVERRIDE"
  if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_CONCURRENCY_ENV "* ]]; then
    print -u2 "Launched Palate process did not inherit $EXPECTED_CONCURRENCY_ENV"
    exit 1
  fi
elif [[ " $PROCESS_ENVIRONMENT " == *" PALATE_VISION_CONCURRENCY="* ]]; then
  print -u2 "Launched Palate process unexpectedly inherited PALATE_VISION_CONCURRENCY"
  exit 1
fi
if (( PIPELINE_DEPTH_OVERRIDE_PROVIDED )); then
  EXPECTED_PIPELINE_DEPTH_ENV="PALATE_VISION_PIPELINE_DEPTH=$PIPELINE_DEPTH_OVERRIDE"
  if [[ " $PROCESS_ENVIRONMENT " != *" $EXPECTED_PIPELINE_DEPTH_ENV "* ]]; then
    print -u2 "Launched Palate process did not inherit $EXPECTED_PIPELINE_DEPTH_ENV"
    exit 1
  fi
elif [[ " $PROCESS_ENVIRONMENT " == *" PALATE_VISION_PIPELINE_DEPTH="* ]]; then
  print -u2 "Launched Palate process unexpectedly inherited PALATE_VISION_PIPELINE_DEPTH"
  exit 1
fi

PROCESS_ENVIRONMENT_RESULT_TRANSPORT="$RESULT_TRANSPORT"
PROCESS_ENVIRONMENT_VISIT_FOOD_DETECTION_STRATEGY="$VISIT_FOOD_DETECTION_STRATEGY"
PROCESS_ENVIRONMENT_OBSERVED_EPOCH="$(date +%s.%N)"
ATTESTED_PAGE_SIZE="$PAGE_SIZE"
ATTESTED_PAGE_ORCHESTRATION_STRATEGY="$PAGE_ORCHESTRATION_STRATEGY"
ATTESTED_VISION_CONCURRENCY="$EFFECTIVE_VISION_CONCURRENCY"
ATTESTED_PIPELINE_DEPTH="$EFFECTIVE_PIPELINE_DEPTH"
PRETRIGGER_VISION_STATE_SHA256="$(vision_state_sha256 "$DATABASE_PATH")"
PRETRIGGER_OBSERVED_EPOCH="$(date +%s.%N)"
if [[ "$PRETRIGGER_VISION_STATE_SHA256" != "$PREPARED_VISION_STATE_SHA256" ]]; then
  print -u2 "Vision fixture state changed between installation and trigger readiness"
  exit 1
fi
print \
  "READY run_id=$VALIDATION_RUN_ID page_size=$PAGE_SIZE observed_process_page_size=$ATTESTED_PAGE_SIZE result_transport_requested=$RESULT_TRANSPORT result_transport_process_environment=$PROCESS_ENVIRONMENT_RESULT_TRANSPORT result_transport_expected=$RESULT_TRANSPORT visit_food_detection_strategy=$PROCESS_ENVIRONMENT_VISIT_FOOD_DETECTION_STRATEGY page_orchestration_strategy=$ATTESTED_PAGE_ORCHESTRATION_STRATEGY vision_concurrency=$ATTESTED_VISION_CONCURRENCY vision_concurrency_mode=$VISION_CONCURRENCY_MODE pipeline_depth=$ATTESTED_PIPELINE_DEPTH pipeline_depth_mode=$PIPELINE_DEPTH_MODE pid=$APP_PID trigger=$TRIGGER_PATH required_action=$VALIDATION_TRIGGER_ACTION validation_entrypoint=$VALIDATION_ENTRYPOINT rescan_allowed=false"

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
TRIGGER_OBSERVED_EPOCH="$(date +%s.%N)"
if ! awk \
  -v trigger="$TRIGGER_EPOCH" \
  -v pretrigger="$PRETRIGGER_OBSERVED_EPOCH" \
  -v observed="$TRIGGER_OBSERVED_EPOCH" \
  -v max_age="$TRIGGER_MAX_AGE_SECONDS" \
  'BEGIN { exit !(trigger >= pretrigger && trigger <= observed && observed - trigger <= max_age) }'; then
  print -u2 "Trigger timestamp must follow pre-trigger fixture attestation, be nonfuture, and no more than $TRIGGER_MAX_AGE_SECONDS seconds old"
  exit 1
fi

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
OBSERVED_PROGRESS=0
FIRST_PROGRESS_EPOCH=""
while true; do
  NOW_EPOCH="$(date +%s.%N)"
  ELAPSED="$(awk -v now="$NOW_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.3f", now - start }')"
  PENDING_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM photos WHERE foodDetected IS NULL;")"
  COMPLETION_SENTINEL_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE foodProbable = -1;")"
  RSS_KIB="$(ps -o rss= -p "$APP_PID" | tr -d ' ' || true)"
  [[ -n "$RSS_KIB" ]] || RSS_KIB=0
  print "$ELAPSED\t$PENDING_COUNT\t$RSS_KIB" >> "$SAMPLES_PATH"
  if (( PENDING_COUNT < EXPECTED_FIXTURE_COUNT && ! OBSERVED_PROGRESS )); then
    OBSERVED_PROGRESS=1
    FIRST_PROGRESS_EPOCH="$NOW_EPOCH"
  fi
  PENDING_REQUIREMENT_SATISFIED=0
  if [[ "$VISIT_FOOD_DETECTION_STRATEGY" == "rank3-bulk-tail-v1" ]] || (( PENDING_COUNT == 0 )); then
    PENDING_REQUIREMENT_SATISFIED=1
  fi
  if (( PENDING_REQUIREMENT_SATISFIED && COMPLETION_SENTINEL_COUNT == 0 && OBSERVED_PROGRESS )); then
    ACTUAL_FOOD_VISIT_COUNT="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE foodProbable = 1;")"
    if (( ACTUAL_FOOD_VISIT_COUNT == EXPECTED_FOOD_VISIT_COUNT )); then
      FINISH_EPOCH="$NOW_EPOCH"
      break
    fi
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print -u2 "Palate exited before Vision validation completed"
    exit 1
  fi
  if (( $(date +%s) >= DEADLINE )); then
    print -u2 "Timed out with $PENDING_COUNT pending rows and $COMPLETION_SENTINEL_COUNT unsynchronized visits"
    exit 1
  fi
  sleep "$TARGET_SAMPLING_INTERVAL_SECONDS"
done

TRIGGER_WALL_SECONDS="$(awk -v finish="$FINISH_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", finish - start }')"
FIRST_DURABLE_PROGRESS_SECONDS="$(awk -v first="$FIRST_PROGRESS_EPOCH" -v start="$TRIGGER_EPOCH" 'BEGIN { printf "%.6f", first - start }')"
DURABLE_TAIL_SECONDS="$(awk -v finish="$FINISH_EPOCH" -v first="$FIRST_PROGRESS_EPOCH" 'BEGIN { printf "%.6f", finish - first }')"
WALL_SECONDS="$DURABLE_TAIL_SECONDS"
MAX_RSS_KIB="$(awk 'NR > 1 && $3 > maximum { maximum = $3 } END { print maximum + 0 }' "$SAMPLES_PATH")"

# Freeze both the database and the native attestation writer before consuming
# the attestation. Extract every reported field from the same validated jq
# read so no later rewrite can mix unvalidated values into the schema-6 report.
stop_palate
assert_database_unopened
if [[ ! -f "$RESULT_TRANSPORT_ATTESTATION_PATH" \
  || -L "$RESULT_TRANSPORT_ATTESTATION_PATH" \
  || ! -s "$RESULT_TRANSPORT_ATTESTATION_PATH" ]]; then
  print -u2 "Native Vision result transport attestation is missing: $RESULT_TRANSPORT_ATTESTATION_PATH"
  exit 1
fi
if ! ATTESTED_RESULT_TRANSPORT_JSON="$(jq -ce \
  --arg runId "$VALIDATION_RUN_ID" \
  --arg resultTransport "$RESULT_TRANSPORT" \
  --argjson triggerEpochSeconds "$TRIGGER_EPOCH" \
  --argjson finishEpochSeconds "$FINISH_EPOCH" \
  --argjson requireNativeWorkCounters "$REQUIRE_NATIVE_WORK_COUNTERS" \
  '
   def nonnegative_integer:
     type == "number" and . >= 0 and (. | floor) == .;
   def common_contract:
     type == "object"
     and .runId == $runId
     and .configuredResultTransport == $resultTransport
     and .resolvedResultTransport == $resultTransport
     and .selectedResultTransport == $resultTransport
     and ((.observedAtEpochSeconds | type) == "number")
     and .observedAtEpochSeconds >= $triggerEpochSeconds
     and .observedAtEpochSeconds <= $finishEpochSeconds;
   if .schemaVersion == 1 then
     select(($requireNativeWorkCounters == 0) and common_contract)
     | {
         schemaVersion,
         runId,
         configuredResultTransport,
         resolvedResultTransport,
         selectedResultTransport,
         observedAtEpochSeconds,
         lastObservedAtEpochSeconds: null,
         nativeWorkCountersAvailable: false,
         nativeWork: null
       }
   elif .schemaVersion == 2 then
     select(
       common_contract
       and ((.lastObservedAtEpochSeconds | type) == "number")
       and .lastObservedAtEpochSeconds >= .observedAtEpochSeconds
       and .lastObservedAtEpochSeconds <= $finishEpochSeconds
       and (.startedBatchCount | nonnegative_integer)
       and (.startedRequestedAssetCount | nonnegative_integer)
       and (.completedBatchCount | nonnegative_integer)
       and (.completedRequestedAssetCount | nonnegative_integer)
       and (.resolvedBatchCount | nonnegative_integer)
       and (.resolvedRequestedAssetCount | nonnegative_integer)
       and (.rejectedBatchCount | nonnegative_integer)
       and (.rejectedRequestedAssetCount | nonnegative_integer)
       and (.cancelledBatchCount | nonnegative_integer)
       and (.cancelledRequestedAssetCount | nonnegative_integer)
       and (.inFlightBatchCount | nonnegative_integer)
       and (.inFlightRequestedAssetCount | nonnegative_integer)
       and .startedBatchCount == (.completedBatchCount + .inFlightBatchCount)
       and .startedRequestedAssetCount == (.completedRequestedAssetCount + .inFlightRequestedAssetCount)
       and .completedBatchCount == (.resolvedBatchCount + .rejectedBatchCount + .cancelledBatchCount)
       and .completedRequestedAssetCount == (.resolvedRequestedAssetCount + .rejectedRequestedAssetCount + .cancelledRequestedAssetCount)
     )
     | {
         schemaVersion,
         runId,
         configuredResultTransport,
         resolvedResultTransport,
         selectedResultTransport,
         observedAtEpochSeconds,
         lastObservedAtEpochSeconds,
         nativeWorkCountersAvailable: true,
         nativeWork: {
           startedBatchCount,
           startedRequestedAssetCount,
           completedBatchCount,
           completedRequestedAssetCount,
           resolvedBatchCount,
           resolvedRequestedAssetCount,
           rejectedBatchCount,
           rejectedRequestedAssetCount,
           cancelledBatchCount,
           cancelledRequestedAssetCount,
           inFlightBatchCount,
           inFlightRequestedAssetCount
         }
       }
   else
     empty
  end' \
  "$RESULT_TRANSPORT_ATTESTATION_PATH")"; then
  jq -c \
    --arg runId "$VALIDATION_RUN_ID" \
    --arg resultTransport "$RESULT_TRANSPORT" \
    --argjson triggerEpochSeconds "$TRIGGER_EPOCH" \
    --argjson finishEpochSeconds "$FINISH_EPOCH" \
    '{
      schemaVersion,
      runIdMatches: (.runId == $runId),
      configuredResultTransport,
      resolvedResultTransport,
      selectedResultTransport,
      requestedResultTransport: $resultTransport,
      observedAtEpochSeconds,
      lastObservedAtEpochSeconds,
      triggerEpochSeconds: $triggerEpochSeconds,
      finishEpochSeconds: $finishEpochSeconds,
      firstObservedWithinTriggerBoundary: (
        ((.observedAtEpochSeconds | type) == "number")
        and .observedAtEpochSeconds >= $triggerEpochSeconds
        and .observedAtEpochSeconds <= $finishEpochSeconds
      ),
      lastObservedWithinFinishBoundary: (
        ((.lastObservedAtEpochSeconds | type) == "number")
        and ((.observedAtEpochSeconds | type) == "number")
        and .lastObservedAtEpochSeconds >= .observedAtEpochSeconds
        and .lastObservedAtEpochSeconds <= $finishEpochSeconds
      ),
      startedBatchCount,
      startedRequestedAssetCount,
      completedBatchCount,
      completedRequestedAssetCount,
      resolvedBatchCount,
      resolvedRequestedAssetCount,
      rejectedBatchCount,
      rejectedRequestedAssetCount,
      cancelledBatchCount,
      cancelledRequestedAssetCount,
      inFlightBatchCount,
      inFlightRequestedAssetCount
    }' \
    "$RESULT_TRANSPORT_ATTESTATION_PATH" >&2 || true
  print -u2 "Native Vision result transport attestation did not match the requested run, transport, trigger boundary, balanced lifecycle, or required direct-counter contract"
  exit 1
fi
ATTESTED_RESULT_TRANSPORT_SCHEMA_VERSION="$(jq -r '.schemaVersion' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_RUN_ID="$(jq -r '.runId' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_CONFIGURED_RESULT_TRANSPORT="$(jq -r '.configuredResultTransport' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_RESOLVED_RESULT_TRANSPORT="$(jq -r '.resolvedResultTransport' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_SELECTED_RESULT_TRANSPORT="$(jq -r '.selectedResultTransport' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_OBSERVED_EPOCH="$(jq -r '.observedAtEpochSeconds' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_LAST_OBSERVED_EPOCH_JSON="$(jq -c '.lastObservedAtEpochSeconds' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
NATIVE_WORK_COUNTERS_AVAILABLE_JSON="$(jq -r '.nativeWorkCountersAvailable' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_STARTED_BATCH_COUNT="$(jq -r '.nativeWork.startedBatchCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_STARTED_REQUESTED_ASSET_COUNT="$(jq -r '.nativeWork.startedRequestedAssetCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_COMPLETED_BATCH_COUNT="$(jq -r '.nativeWork.completedBatchCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_COMPLETED_REQUESTED_ASSET_COUNT="$(jq -r '.nativeWork.completedRequestedAssetCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_RESOLVED_BATCH_COUNT="$(jq -r '.nativeWork.resolvedBatchCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_RESOLVED_REQUESTED_ASSET_COUNT="$(jq -r '.nativeWork.resolvedRequestedAssetCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_REJECTED_BATCH_COUNT="$(jq -r '.nativeWork.rejectedBatchCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_REJECTED_REQUESTED_ASSET_COUNT="$(jq -r '.nativeWork.rejectedRequestedAssetCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_CANCELLED_BATCH_COUNT="$(jq -r '.nativeWork.cancelledBatchCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_CANCELLED_REQUESTED_ASSET_COUNT="$(jq -r '.nativeWork.cancelledRequestedAssetCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_IN_FLIGHT_BATCH_COUNT="$(jq -r '.nativeWork.inFlightBatchCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"
ATTESTED_IN_FLIGHT_REQUESTED_ASSET_COUNT="$(jq -r '.nativeWork.inFlightRequestedAssetCount // "null"' <<< "$ATTESTED_RESULT_TRANSPORT_JSON")"

assert_wal_checkpoint "$DATABASE_PATH"
remove_database_sidecars "$DATABASE_PATH"
if [[ -n "$SEMANTIC_REFERENCE_DATABASE_PATH" ]]; then
  if ! verify_external_semantic_reference_contract; then
    print -u2 "The external semantic reference or one of its sidecars changed during validation"
    exit 1
  fi
fi

RESULT_DATABASE_URI="$(immutable_sqlite_uri "$DATABASE_PATH")"
read FULL_REFERENCE_PHOTO_MISMATCH_COUNT VISIT_MISMATCH_COUNT <<<"$(sqlite3 -readonly -separator ' ' "$RESULT_DATABASE_URI" <<SQL
ATTACH DATABASE '$SQL_ESCAPED_SEMANTIC_REFERENCE_URI' AS reference;
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

PLANNED_SAMPLE_COUNT="$FIXTURE_COUNT"
ATTEMPTED_SAMPLE_COUNT="$FIXTURE_COUNT"
SUCCESSFUL_ATTEMPT_COUNT="$FIXTURE_COUNT"
RETRYABLE_ATTEMPT_COUNT=0
SKIPPED_SAMPLE_COUNT=0
SUCCESSFUL_ATTEMPT_MISMATCH_COUNT="$FULL_REFERENCE_PHOTO_MISMATCH_COUNT"
RETRYABLE_PARTIAL_STATE_COUNT=0
SKIPPED_WRITE_COUNT=0
PHOTO_ID_MISMATCH_COUNT=0
UNPLANNED_PENDING_COUNT=0
PHOTO_MISMATCH_COUNT="$FULL_REFERENCE_PHOTO_MISMATCH_COUNT"
EXPECTED_NATIVE_BATCH_COUNT=$(( (FIXTURE_COUNT + PAGE_SIZE - 1) / PAGE_SIZE ))

if [[ "$VISIT_FOOD_DETECTION_STRATEGY" == "rank3-bulk-tail-v1" ]]; then
  read \
    PLANNED_SAMPLE_COUNT \
    ATTEMPTED_SAMPLE_COUNT \
    SUCCESSFUL_ATTEMPT_COUNT \
    RETRYABLE_ATTEMPT_COUNT \
    SKIPPED_SAMPLE_COUNT \
    SUCCESSFUL_ATTEMPT_MISMATCH_COUNT \
    RETRYABLE_PARTIAL_STATE_COUNT \
    SKIPPED_WRITE_COUNT \
    PHOTO_ID_MISMATCH_COUNT \
    UNPLANNED_PENDING_COUNT \
    EXPECTED_NATIVE_BATCH_COUNT <<<"$(sqlite3 -readonly -separator ' ' "$RESULT_DATABASE_URI" <<SQL
ATTACH DATABASE '$SQL_ESCAPED_SEMANTIC_REFERENCE_URI' AS reference;
WITH reference_plan AS MATERIALIZED (
  SELECT
    expected.id,
    expected.visitId,
    expected.foodDetected,
    expected.foodLabels,
    expected.foodConfidence,
    expected.allLabels,
    ROW_NUMBER() OVER (
      PARTITION BY expected.visitId
      ORDER BY expected.creationTime ASC, expected.id ASC
    ) AS sampleRank
  FROM reference.photos AS expected
  WHERE expected.allLabels IS NOT NULL
), observed_plan AS MATERIALIZED (
  SELECT
    plan.*,
    current.id AS currentId,
    current.foodDetected AS currentFoodDetected,
    current.foodLabels AS currentFoodLabels,
    current.foodConfidence AS currentFoodConfidence,
    current.allLabels AS currentAllLabels,
    CASE
      WHEN plan.sampleRank = 1 THEN 1
      WHEN plan.sampleRank <= 3 THEN NOT EXISTS (
        SELECT 1
        FROM reference_plan AS priorPlan
        INNER JOIN photos AS priorCurrent ON priorCurrent.id = priorPlan.id
        WHERE priorPlan.visitId = plan.visitId
          AND priorPlan.sampleRank < plan.sampleRank
          AND priorCurrent.foodDetected = 1
      )
      ELSE NOT EXISTS (
        SELECT 1
        FROM reference_plan AS priorPlan
        INNER JOIN photos AS priorCurrent ON priorCurrent.id = priorPlan.id
        WHERE priorPlan.visitId = plan.visitId
          AND priorPlan.sampleRank <= 3
          AND priorCurrent.foodDetected = 1
      )
    END AS expectedAttempt
  FROM reference_plan AS plan
  LEFT JOIN photos AS current ON current.id = plan.id
)
SELECT
  (SELECT COUNT(*) FROM observed_plan),
  (SELECT COUNT(*) FROM observed_plan WHERE expectedAttempt),
  (SELECT COUNT(*) FROM observed_plan WHERE expectedAttempt AND currentId IS NOT NULL AND currentFoodDetected IS NOT NULL),
  (SELECT COUNT(*) FROM observed_plan
   WHERE expectedAttempt
     AND currentId IS NOT NULL
     AND currentFoodDetected IS NULL
     AND currentFoodLabels IS NULL
     AND currentFoodConfidence IS NULL
     AND currentAllLabels IS NULL),
  (SELECT COUNT(*) FROM observed_plan WHERE NOT expectedAttempt),
  (SELECT COUNT(*) FROM observed_plan
   WHERE expectedAttempt
     AND currentFoodDetected IS NOT NULL
     AND (
       currentFoodDetected IS NOT foodDetected
       OR currentFoodConfidence IS NOT foodConfidence
       OR (SELECT json_group_array(json_object(
             'label', json_extract(value, '$.label'),
             'confidence', json_extract(value, '$.confidence')
           )) FROM json_each(currentFoodLabels))
          IS NOT
          (SELECT json_group_array(json_object(
             'label', json_extract(value, '$.label'),
             'confidence', json_extract(value, '$.confidence')
           )) FROM json_each(foodLabels))
       OR (SELECT json_group_array(json_object(
             'label', json_extract(value, '$.label'),
             'confidence', json_extract(value, '$.confidence')
           )) FROM json_each(currentAllLabels))
          IS NOT
          (SELECT json_group_array(json_object(
             'label', json_extract(value, '$.label'),
             'confidence', json_extract(value, '$.confidence')
           )) FROM json_each(allLabels))
     )),
  (SELECT COUNT(*) FROM observed_plan
   WHERE expectedAttempt
     AND currentFoodDetected IS NULL
     AND (currentFoodLabels IS NOT NULL OR currentFoodConfidence IS NOT NULL OR currentAllLabels IS NOT NULL)),
  (SELECT COUNT(*) FROM observed_plan
   WHERE NOT expectedAttempt
     AND (currentFoodDetected IS NOT NULL OR currentFoodLabels IS NOT NULL
       OR currentFoodConfidence IS NOT NULL OR currentAllLabels IS NOT NULL)),
  (SELECT COUNT(*) FROM (SELECT id FROM photos EXCEPT SELECT id FROM reference.photos))
    + (SELECT COUNT(*) FROM (SELECT id FROM reference.photos EXCEPT SELECT id FROM photos)),
  (SELECT COUNT(*)
   FROM photos AS current
   INNER JOIN reference.photos AS expected USING (id)
   WHERE expected.allLabels IS NULL AND current.foodDetected IS NULL),
  (SELECT COALESCE(SUM((phaseAttemptCount + $PAGE_SIZE - 1) / $PAGE_SIZE), 0)
   FROM (
     SELECT COUNT(*) AS phaseAttemptCount
     FROM observed_plan
     WHERE expectedAttempt
     GROUP BY CASE WHEN sampleRank <= 3 THEN sampleRank ELSE 4 END
   ));
DETACH DATABASE reference;
SQL
)"
  PHOTO_MISMATCH_COUNT=$((
    SUCCESSFUL_ATTEMPT_MISMATCH_COUNT
    + RETRYABLE_PARTIAL_STATE_COUNT
    + SKIPPED_WRITE_COUNT
    + PHOTO_ID_MISMATCH_COUNT
    + UNPLANNED_PENDING_COUNT
  ))
fi

ACTUAL_FOOD_COUNT="$(sqlite3 -readonly "$RESULT_DATABASE_URI" "SELECT COUNT(*) FROM photos WHERE foodDetected = 1;")"
PENDING_COUNT="$(sqlite3 -readonly "$RESULT_DATABASE_URI" "SELECT COUNT(*) FROM photos WHERE foodDetected IS NULL;")"
ACTUAL_FOOD_VISIT_COUNT="$(sqlite3 -readonly "$RESULT_DATABASE_URI" "SELECT COUNT(*) FROM visits WHERE foodProbable = 1;")"
INVALID_VISIT_FOOD_COUNT="$(sqlite3 -readonly "$RESULT_DATABASE_URI" "SELECT COUNT(*) FROM visits WHERE foodProbable NOT IN (0, 1) OR foodProbable IS NULL;")"
POSITIVE_VISIT_ID_MISMATCH_COUNT="$(sqlite3 -readonly "$RESULT_DATABASE_URI" <<SQL
ATTACH DATABASE '$SQL_ESCAPED_SEMANTIC_REFERENCE_URI' AS reference;
SELECT
  (SELECT COUNT(*) FROM (
    SELECT id FROM visits WHERE foodProbable = 1
    EXCEPT
    SELECT id FROM reference.visits WHERE foodProbable = 1
  ))
  + (SELECT COUNT(*) FROM (
    SELECT id FROM reference.visits WHERE foodProbable = 1
    EXCEPT
    SELECT id FROM visits WHERE foodProbable = 1
  ));
DETACH DATABASE reference;
SQL
)"
INTEGRITY="$(sqlite3 -readonly "$RESULT_DATABASE_URI" "PRAGMA integrity_check;")"
FOREIGN_KEY_VIOLATION_COUNT="$(sqlite3 -readonly "$RESULT_DATABASE_URI" "SELECT COUNT(*) FROM pragma_foreign_key_check;")"

# Preserve the disposable result before enforcing parity so an explicitly
# retained diagnostic run can explain a rejection without ever touching the
# restored live database. Default aggregate-only runs delete this copy.
cp "$DATABASE_PATH" "$RUN_DATABASE_TEMP_PATH"
chmod 600 "$RUN_DATABASE_TEMP_PATH"
assert_wal_checkpoint "$RUN_DATABASE_TEMP_PATH"
remove_database_sidecars "$RUN_DATABASE_TEMP_PATH"
RUN_DATABASE_SHA256="$(sha256_file "$RUN_DATABASE_TEMP_PATH")"
mv -f -- "$RUN_DATABASE_TEMP_PATH" "$RUN_DATABASE_PATH"
chmod 600 "$RUN_DATABASE_PATH"

if (( REQUIRE_NATIVE_WORK_COUNTERS )); then
  NATIVE_WORK_COUNTERS_REQUIRED_JSON=true
else
  NATIVE_WORK_COUNTERS_REQUIRED_JSON=false
fi
NATIVE_WORK_LIFECYCLE_BALANCED_JSON=null
NATIVE_REQUESTED_ASSET_COUNT_MATCHES_ATTEMPTS_JSON=null
NATIVE_BATCH_COUNT_MATCHES_PLAN_JSON=null
ATTEMPT_ACCOUNTING_SOURCE="rank-plan-plus-durable-result-state"
if [[ "$NATIVE_WORK_COUNTERS_AVAILABLE_JSON" == "true" ]]; then
  if (( ATTESTED_REJECTED_BATCH_COUNT != 0 \
    || ATTESTED_REJECTED_REQUESTED_ASSET_COUNT != 0 \
    || ATTESTED_CANCELLED_BATCH_COUNT != 0 \
    || ATTESTED_CANCELLED_REQUESTED_ASSET_COUNT != 0 \
    || ATTESTED_IN_FLIGHT_BATCH_COUNT != 0 \
    || ATTESTED_IN_FLIGHT_REQUESTED_ASSET_COUNT != 0 \
    || ATTESTED_STARTED_BATCH_COUNT != ATTESTED_COMPLETED_BATCH_COUNT \
    || ATTESTED_COMPLETED_BATCH_COUNT != ATTESTED_RESOLVED_BATCH_COUNT \
    || ATTESTED_STARTED_REQUESTED_ASSET_COUNT != ATTESTED_COMPLETED_REQUESTED_ASSET_COUNT \
    || ATTESTED_COMPLETED_REQUESTED_ASSET_COUNT != ATTESTED_RESOLVED_REQUESTED_ASSET_COUNT )); then
    print -u2 "Native Vision dispatch lifecycle did not resolve every started batch and requested asset"
    exit 1
  fi
  NATIVE_WORK_LIFECYCLE_BALANCED_JSON=true

  if (( ATTESTED_STARTED_REQUESTED_ASSET_COUNT != ATTEMPTED_SAMPLE_COUNT )); then
    print -u2 "Native Vision requested-asset count mismatch: direct=$ATTESTED_STARTED_REQUESTED_ASSET_COUNT expected_attempted=$ATTEMPTED_SAMPLE_COUNT"
    exit 1
  fi
  NATIVE_REQUESTED_ASSET_COUNT_MATCHES_ATTEMPTS_JSON=true

  if (( ATTESTED_STARTED_BATCH_COUNT != EXPECTED_NATIVE_BATCH_COUNT )); then
    print -u2 "Native Vision batch count mismatch: direct=$ATTESTED_STARTED_BATCH_COUNT expected=$EXPECTED_NATIVE_BATCH_COUNT"
    exit 1
  fi
  NATIVE_BATCH_COUNT_MATCHES_PLAN_JSON=true
  ATTEMPT_ACCOUNTING_SOURCE="native-dispatch-counters-plus-rank-plan-plus-durable-result-state"
fi

# Prefer direct native dispatch evidence over downstream semantic symptoms. A
# strategy-bypassing UI path can write every fixture row, which would otherwise
# surface only as skipped-row parity drift even though the native counters say
# exactly how much unintended Vision work ran.
if (( PHOTO_MISMATCH_COUNT != 0 || VISIT_MISMATCH_COUNT != 0 )); then
  print -u2 "Parity failed: $PHOTO_MISMATCH_COUNT photo mismatches, $VISIT_MISMATCH_COUNT visit mismatches"
  exit 1
fi
if (( POSITIVE_VISIT_ID_MISMATCH_COUNT != 0 || INVALID_VISIT_FOOD_COUNT != 0 )); then
  print -u2 "Visit food parity failed: $POSITIVE_VISIT_ID_MISMATCH_COUNT positive-ID mismatches, $INVALID_VISIT_FOOD_COUNT invalid values"
  exit 1
fi
if (( PLANNED_SAMPLE_COUNT != FIXTURE_COUNT \
  || ATTEMPTED_SAMPLE_COUNT + SKIPPED_SAMPLE_COUNT != PLANNED_SAMPLE_COUNT \
  || SUCCESSFUL_ATTEMPT_COUNT + RETRYABLE_ATTEMPT_COUNT != ATTEMPTED_SAMPLE_COUNT \
  || PENDING_COUNT != SKIPPED_SAMPLE_COUNT + RETRYABLE_ATTEMPT_COUNT )); then
  print -u2 "Strategy workload accounting failed: planned=$PLANNED_SAMPLE_COUNT attempted=$ATTEMPTED_SAMPLE_COUNT successful=$SUCCESSFUL_ATTEMPT_COUNT retryable=$RETRYABLE_ATTEMPT_COUNT skipped=$SKIPPED_SAMPLE_COUNT pending=$PENDING_COUNT"
  exit 1
fi
if [[ "$VISIT_FOOD_DETECTION_STRATEGY" == "full-plan-v1" ]] \
  && (( ACTUAL_FOOD_COUNT != EXPECTED_FOOD_COUNT )); then
  print -u2 "Food count mismatch: expected $EXPECTED_FOOD_COUNT, found $ACTUAL_FOOD_COUNT"
  exit 1
fi
if [[ "$INTEGRITY" != "ok" ]] || (( FOREIGN_KEY_VIOLATION_COUNT != 0 )); then
  print -u2 "SQLite validation failed: integrity=$INTEGRITY foreign_keys=$FOREIGN_KEY_VIOLATION_COUNT"
  exit 1
fi

if (( RETAIN_RAW_DATABASES )); then
  RAW_DATABASE_COPIES_RETAINED_JSON=true
  REPORTED_SNAPSHOT_PATH="${SNAPSHOT_PATH:t}"
  REPORTED_RESULT_PATH="${RUN_DATABASE_PATH:t}"
else
  RAW_DATABASE_COPIES_RETAINED_JSON=false
  REPORTED_SNAPSHOT_PATH=""
  REPORTED_RESULT_PATH=""
fi

jq -n \
  --arg status "ok" \
  --argjson pageSize "$PAGE_SIZE" \
  --arg resultTransport "$ATTESTED_SELECTED_RESULT_TRANSPORT" \
  --arg requestedResultTransport "$RESULT_TRANSPORT" \
  --arg visitFoodDetectionStrategy "$VISIT_FOOD_DETECTION_STRATEGY" \
  --arg pageOrchestrationStrategy "$PAGE_ORCHESTRATION_STRATEGY" \
  --argjson visionConcurrency "$EFFECTIVE_VISION_CONCURRENCY" \
  --arg visionConcurrencyMode "$VISION_CONCURRENCY_MODE" \
  --argjson visionConcurrencyOverridden "$VISION_CONCURRENCY_OVERRIDDEN_JSON" \
  --argjson visionConcurrencyEnvironmentValue "$VISION_CONCURRENCY_ENVIRONMENT_JSON" \
  --argjson pipelineDepth "$EFFECTIVE_PIPELINE_DEPTH" \
  --arg pipelineDepthMode "$PIPELINE_DEPTH_MODE" \
  --argjson pipelineDepthOverridden "$PIPELINE_DEPTH_OVERRIDDEN_JSON" \
  --argjson pipelineDepthEnvironmentValue "$PIPELINE_DEPTH_ENVIRONMENT_JSON" \
  --argjson fixtureCount "$FIXTURE_COUNT" \
  --argjson expectedFoodCount "$EXPECTED_FOOD_COUNT" \
  --argjson actualFoodCount "$ACTUAL_FOOD_COUNT" \
  --argjson expectedFoodVisitCount "$EXPECTED_FOOD_VISIT_COUNT" \
  --argjson actualFoodVisitCount "$ACTUAL_FOOD_VISIT_COUNT" \
  --argjson plannedSampleCount "$PLANNED_SAMPLE_COUNT" \
  --argjson attemptedSampleCount "$ATTEMPTED_SAMPLE_COUNT" \
  --argjson successfulAttemptCount "$SUCCESSFUL_ATTEMPT_COUNT" \
  --argjson retryableAttemptCount "$RETRYABLE_ATTEMPT_COUNT" \
  --argjson skippedSampleCount "$SKIPPED_SAMPLE_COUNT" \
  --argjson expectedNativeBatchCount "$EXPECTED_NATIVE_BATCH_COUNT" \
  --arg attemptAccountingSource "$ATTEMPT_ACCOUNTING_SOURCE" \
  --argjson nativeWorkCountersRequired "$NATIVE_WORK_COUNTERS_REQUIRED_JSON" \
  --argjson nativeWorkCountersAvailable "$NATIVE_WORK_COUNTERS_AVAILABLE_JSON" \
  --argjson nativeWorkLifecycleBalanced "$NATIVE_WORK_LIFECYCLE_BALANCED_JSON" \
  --argjson nativeRequestedAssetCountMatchesAttempts "$NATIVE_REQUESTED_ASSET_COUNT_MATCHES_ATTEMPTS_JSON" \
  --argjson nativeBatchCountMatchesPlan "$NATIVE_BATCH_COUNT_MATCHES_PLAN_JSON" \
  --argjson successfulAttemptMismatchCount "$SUCCESSFUL_ATTEMPT_MISMATCH_COUNT" \
  --argjson retryablePartialStateCount "$RETRYABLE_PARTIAL_STATE_COUNT" \
  --argjson skippedWriteCount "$SKIPPED_WRITE_COUNT" \
  --argjson photoIdMismatchCount "$PHOTO_ID_MISMATCH_COUNT" \
  --argjson unplannedPendingCount "$UNPLANNED_PENDING_COUNT" \
  --argjson fullReferencePhotoMismatchCount "$FULL_REFERENCE_PHOTO_MISMATCH_COUNT" \
  --argjson photoMismatchCount "$PHOTO_MISMATCH_COUNT" \
  --argjson visitMismatchCount "$VISIT_MISMATCH_COUNT" \
  --argjson positiveVisitIdMismatchCount "$POSITIVE_VISIT_ID_MISMATCH_COUNT" \
  --argjson invalidVisitFoodCount "$INVALID_VISIT_FOOD_COUNT" \
  --argjson pendingCount "$PENDING_COUNT" \
  --argjson wallSeconds "$WALL_SECONDS" \
  --argjson triggerWallSeconds "$TRIGGER_WALL_SECONDS" \
  --argjson firstDurableProgressSeconds "$FIRST_DURABLE_PROGRESS_SECONDS" \
  --argjson durableTailSeconds "$DURABLE_TAIL_SECONDS" \
  --argjson maxRssKiB "$MAX_RSS_KIB" \
  --arg integrity "$INTEGRITY" \
  --argjson foreignKeyViolationCount "$FOREIGN_KEY_VIOLATION_COUNT" \
  --arg originalSha256 "$ORIGINAL_SHA256" \
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
  --arg standaloneSnapshotSha256 "$STANDALONE_SNAPSHOT_SHA256" \
  --arg semanticReferenceSource "$SEMANTIC_REFERENCE_SOURCE" \
  --arg semanticReferenceSha256 "$SEMANTIC_REFERENCE_SHA256" \
  --arg semanticReferenceMainMode "$SEMANTIC_REFERENCE_MAIN_MODE" \
  --arg semanticReferenceMainSize "$SEMANTIC_REFERENCE_MAIN_SIZE" \
  --argjson semanticReferenceWalPresent "$SEMANTIC_REFERENCE_WAL_PRESENT" \
  --arg semanticReferenceWalSha256 "$SEMANTIC_REFERENCE_WAL_SHA256" \
  --arg semanticReferenceWalMode "$SEMANTIC_REFERENCE_WAL_MODE" \
  --arg semanticReferenceWalSize "$SEMANTIC_REFERENCE_WAL_SIZE" \
  --argjson semanticReferenceShmPresent "$SEMANTIC_REFERENCE_SHM_PRESENT" \
  --arg semanticReferenceShmSha256 "$SEMANTIC_REFERENCE_SHM_SHA256" \
  --arg semanticReferenceShmMode "$SEMANTIC_REFERENCE_SHM_MODE" \
  --arg semanticReferenceShmSize "$SEMANTIC_REFERENCE_SHM_SIZE" \
  --argjson semanticReferenceJournalPresent "$SEMANTIC_REFERENCE_JOURNAL_PRESENT" \
  --arg semanticReferenceJournalSha256 "$SEMANTIC_REFERENCE_JOURNAL_SHA256" \
  --arg semanticReferenceJournalMode "$SEMANTIC_REFERENCE_JOURNAL_MODE" \
  --arg semanticReferenceJournalSize "$SEMANTIC_REFERENCE_JOURNAL_SIZE" \
  --arg resultDatabaseSha256 "$RUN_DATABASE_SHA256" \
  --arg samplesPath "${SAMPLES_PATH:t}" \
  --arg validationRunId "$ATTESTED_RUN_ID" \
  --argjson attestedPageSize "$ATTESTED_PAGE_SIZE" \
  --arg configuredResultTransport "$ATTESTED_CONFIGURED_RESULT_TRANSPORT" \
  --arg resolvedResultTransport "$ATTESTED_RESOLVED_RESULT_TRANSPORT" \
  --arg selectedResultTransport "$ATTESTED_SELECTED_RESULT_TRANSPORT" \
  --arg processEnvironmentResultTransport "$PROCESS_ENVIRONMENT_RESULT_TRANSPORT" \
  --arg processEnvironmentVisitFoodDetectionStrategy "$PROCESS_ENVIRONMENT_VISIT_FOOD_DETECTION_STRATEGY" \
  --arg attestedPageOrchestrationStrategy "$ATTESTED_PAGE_ORCHESTRATION_STRATEGY" \
  --argjson attestedVisionConcurrency "$ATTESTED_VISION_CONCURRENCY" \
  --argjson attestedPipelineDepth "$ATTESTED_PIPELINE_DEPTH" \
  --argjson attestedResultTransportSchemaVersion "$ATTESTED_RESULT_TRANSPORT_SCHEMA_VERSION" \
  --argjson attestedObservedAtEpochSeconds "$ATTESTED_OBSERVED_EPOCH" \
  --argjson attestedLastObservedAtEpochSeconds "$ATTESTED_LAST_OBSERVED_EPOCH_JSON" \
  --argjson attestedStartedBatchCount "$ATTESTED_STARTED_BATCH_COUNT" \
  --argjson attestedStartedRequestedAssetCount "$ATTESTED_STARTED_REQUESTED_ASSET_COUNT" \
  --argjson attestedCompletedBatchCount "$ATTESTED_COMPLETED_BATCH_COUNT" \
  --argjson attestedCompletedRequestedAssetCount "$ATTESTED_COMPLETED_REQUESTED_ASSET_COUNT" \
  --argjson attestedResolvedBatchCount "$ATTESTED_RESOLVED_BATCH_COUNT" \
  --argjson attestedResolvedRequestedAssetCount "$ATTESTED_RESOLVED_REQUESTED_ASSET_COUNT" \
  --argjson attestedRejectedBatchCount "$ATTESTED_REJECTED_BATCH_COUNT" \
  --argjson attestedRejectedRequestedAssetCount "$ATTESTED_REJECTED_REQUESTED_ASSET_COUNT" \
  --argjson attestedCancelledBatchCount "$ATTESTED_CANCELLED_BATCH_COUNT" \
  --argjson attestedCancelledRequestedAssetCount "$ATTESTED_CANCELLED_REQUESTED_ASSET_COUNT" \
  --argjson attestedInFlightBatchCount "$ATTESTED_IN_FLIGHT_BATCH_COUNT" \
  --argjson attestedInFlightRequestedAssetCount "$ATTESTED_IN_FLIGHT_REQUESTED_ASSET_COUNT" \
  --argjson processEnvironmentObservedAtEpochSeconds "$PROCESS_ENVIRONMENT_OBSERVED_EPOCH" \
  --arg requiredTriggerAction "$VALIDATION_TRIGGER_ACTION" \
  --arg validationEntrypoint "$VALIDATION_ENTRYPOINT" \
  --arg preparedVisionStateSha256 "$PREPARED_VISION_STATE_SHA256" \
  --arg preTriggerVisionStateSha256 "$PRETRIGGER_VISION_STATE_SHA256" \
  --argjson preTriggerObservedAtEpochSeconds "$PRETRIGGER_OBSERVED_EPOCH" \
  --argjson triggerEpochSeconds "$TRIGGER_EPOCH" \
  --argjson triggerObservedAtEpochSeconds "$TRIGGER_OBSERVED_EPOCH" \
  --argjson durableCompletionObservedAtEpochSeconds "$FINISH_EPOCH" \
  --argjson triggerMaxAgeSeconds "$TRIGGER_MAX_AGE_SECONDS" \
  --argjson manualLaunch "$MANUAL_LAUNCH_JSON" \
  --arg prelaunchExecutableSha256 "$PRELAUNCH_APP_EXECUTABLE_SHA256" \
  --arg prelaunchBundleSha256 "$PRELAUNCH_APP_BUNDLE_SHA256" \
  --argjson executableRefreshedAfterReady "$APP_EXECUTABLE_REFRESHED_AFTER_READY_JSON" \
  --arg codeSigningIdentifier "$APP_CODESIGN_IDENTIFIER" \
  --arg codeSigningTeamIdentifier "$APP_CODESIGN_TEAM_IDENTIFIER" \
  --arg codeSigningDesignatedRequirement "$APP_CODESIGN_DESIGNATED_REQUIREMENT" \
  --arg suppliedAppName "${APP_PATH:t}" \
  --arg suppliedExecutableSha256 "$APP_EXECUTABLE_SHA256" \
  --arg suppliedBundleSha256 "$APP_BUNDLE_SHA256" \
  --arg runningAppName "${PROCESS_APP_PATH:t}" \
  --arg runningExecutableSha256 "$PROCESS_EXECUTABLE_SHA256" \
  --arg runningBundleSha256 "$PROCESS_BUNDLE_SHA256" \
  --argjson rawDatabasesRetained "$RAW_DATABASE_COPIES_RETAINED_JSON" \
  --arg snapshotPath "$REPORTED_SNAPSHOT_PATH" \
  --arg resultDatabasePath "$REPORTED_RESULT_PATH" \
  '{
    schemaVersion: 6,
    schemaCompatibility: {
      previousSchemaVersion: 5,
      semanticFieldsPreserved: true
    },
    status: $status,
    pageSize: $pageSize,
    resultTransport: $resultTransport,
    requestedResultTransport: $requestedResultTransport,
    visitFoodDetectionStrategy: $visitFoodDetectionStrategy,
    pageOrchestrationStrategy: $pageOrchestrationStrategy,
    configuration: {
      resultPageSize: $pageSize,
      resultTransport: $resultTransport,
      requestedResultTransport: $requestedResultTransport,
      expectedResolvedResultTransport: $requestedResultTransport,
      classificationStrategy: "pipeline",
      classificationStrategyMode: "native-default",
      classificationStrategyEnvironmentValue: null,
      visitFoodDetectionStrategy: $visitFoodDetectionStrategy,
      pageOrchestrationStrategy: $pageOrchestrationStrategy,
      visionConcurrency: $visionConcurrency,
      visionConcurrencyMode: $visionConcurrencyMode,
      visionConcurrencyOverridden: $visionConcurrencyOverridden,
      visionConcurrencyEnvironmentValue: $visionConcurrencyEnvironmentValue,
      pipelineDepth: $pipelineDepth,
      pipelineDepthMode: $pipelineDepthMode,
      pipelineDepthOverridden: $pipelineDepthOverridden,
      pipelineDepthEnvironmentValue: $pipelineDepthEnvironmentValue
    },
    fixtureCount: $fixtureCount,
    expectedFoodCount: $expectedFoodCount,
    actualFoodCount: $actualFoodCount,
    expectedFoodVisitCount: $expectedFoodVisitCount,
    actualFoodVisitCount: $actualFoodVisitCount,
    workload: {
      visitFoodDetectionStrategy: $visitFoodDetectionStrategy,
      plannedSamples: $plannedSampleCount,
      attemptedSamples: $attemptedSampleCount,
      successfulAttempts: $successfulAttemptCount,
      retryableAttempts: $retryableAttemptCount,
      skippedSamples: $skippedSampleCount,
      expectedNativeBatchCount: $expectedNativeBatchCount,
      directNativeCountersRequired: $nativeWorkCountersRequired,
      directNativeCountersAvailable: $nativeWorkCountersAvailable,
      attemptAccountingSource: $attemptAccountingSource,
      nativeDispatch: (if $nativeWorkCountersAvailable then {
        startedBatchCount: $attestedStartedBatchCount,
        startedRequestedAssetCount: $attestedStartedRequestedAssetCount,
        completedBatchCount: $attestedCompletedBatchCount,
        completedRequestedAssetCount: $attestedCompletedRequestedAssetCount,
        resolvedBatchCount: $attestedResolvedBatchCount,
        resolvedRequestedAssetCount: $attestedResolvedRequestedAssetCount,
        rejectedBatchCount: $attestedRejectedBatchCount,
        rejectedRequestedAssetCount: $attestedRejectedRequestedAssetCount,
        cancelledBatchCount: $attestedCancelledBatchCount,
        cancelledRequestedAssetCount: $attestedCancelledRequestedAssetCount,
        inFlightBatchCount: $attestedInFlightBatchCount,
        inFlightRequestedAssetCount: $attestedInFlightRequestedAssetCount
      } else null end)
    },
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
      requestedResultTransport: $requestedResultTransport,
      observedProcessResultTransport: $selectedResultTransport,
      expectedResolvedResultTransport: $requestedResultTransport,
      observedProcessResultTransportEnvironmentValue: $processEnvironmentResultTransport,
      resultTransportEnvironmentPresent: true,
      expectedResolvedClassificationStrategy: "pipeline",
      observedProcessClassificationStrategyEnvironmentValue: null,
      classificationStrategyEnvironmentPresent: false,
      classificationStrategyAttestationSource: "validated-environment-absence-plus-native-default",
      expectedResolvedVisitFoodDetectionStrategy: $visitFoodDetectionStrategy,
      observedProcessVisitFoodDetectionStrategyEnvironmentValue: $processEnvironmentVisitFoodDetectionStrategy,
      visitFoodDetectionStrategyEnvironmentPresent: true,
      visitFoodDetectionStrategyAttestationSource: "process-environment-plus-strategy-aware-semantic-oracle",
      expectedResolvedPageOrchestrationStrategy: $attestedPageOrchestrationStrategy,
      observedProcessPageOrchestrationStrategyEnvironmentValue: $attestedPageOrchestrationStrategy,
      pageOrchestrationStrategyEnvironmentPresent: true,
      expectedResolvedVisionConcurrency: $attestedVisionConcurrency,
      observedProcessVisionConcurrencyEnvironmentValue: $visionConcurrencyEnvironmentValue,
      visionConcurrencyEnvironmentPresent: $visionConcurrencyOverridden,
      expectedResolvedPipelineDepth: $attestedPipelineDepth,
      observedProcessPipelineDepthEnvironmentValue: $pipelineDepthEnvironmentValue,
      pipelineDepthEnvironmentPresent: $pipelineDepthOverridden,
      observedAtEpochSeconds: $attestedObservedAtEpochSeconds,
      processEnvironmentObservedAtEpochSeconds: $processEnvironmentObservedAtEpochSeconds,
      nativeResultTransport: {
        schemaVersion: $attestedResultTransportSchemaVersion,
        runId: $validationRunId,
        configuredResultTransport: $configuredResultTransport,
        resolvedResultTransport: $resolvedResultTransport,
        selectedResultTransport: $selectedResultTransport,
        observedAtEpochSeconds: $attestedObservedAtEpochSeconds,
        lastObservedAtEpochSeconds: $attestedLastObservedAtEpochSeconds,
        workCountersAvailable: $nativeWorkCountersAvailable,
        workCounters: (if $nativeWorkCountersAvailable then {
          startedBatchCount: $attestedStartedBatchCount,
          startedRequestedAssetCount: $attestedStartedRequestedAssetCount,
          completedBatchCount: $attestedCompletedBatchCount,
          completedRequestedAssetCount: $attestedCompletedRequestedAssetCount,
          resolvedBatchCount: $attestedResolvedBatchCount,
          resolvedRequestedAssetCount: $attestedResolvedRequestedAssetCount,
          rejectedBatchCount: $attestedRejectedBatchCount,
          rejectedRequestedAssetCount: $attestedRejectedRequestedAssetCount,
          cancelledBatchCount: $attestedCancelledBatchCount,
          cancelledRequestedAssetCount: $attestedCancelledRequestedAssetCount,
          inFlightBatchCount: $attestedInFlightBatchCount,
          inFlightRequestedAssetCount: $attestedInFlightRequestedAssetCount
        } else null end)
      },
      source: "process-environment-plus-native-result-transport-attestation"
    },
    triggerBoundary: {
      requiredAction: $requiredTriggerAction,
      validationEntrypoint: $validationEntrypoint,
      rescanAllowed: false,
      preparedVisionStateSha256: $preparedVisionStateSha256,
      preTriggerVisionStateSha256: $preTriggerVisionStateSha256,
      unchangedBeforeTrigger: ($preparedVisionStateSha256 == $preTriggerVisionStateSha256),
      preTriggerObservedAtEpochSeconds: $preTriggerObservedAtEpochSeconds,
      triggerEpochSeconds: $triggerEpochSeconds,
      triggerObservedAtEpochSeconds: $triggerObservedAtEpochSeconds,
      durableCompletionObservedAtEpochSeconds: $durableCompletionObservedAtEpochSeconds,
      maxTriggerAgeSeconds: $triggerMaxAgeSeconds,
      triggerFollowedPreTriggerAttestation: ($triggerEpochSeconds >= $preTriggerObservedAtEpochSeconds),
      triggerWasNotFutureDated: ($triggerEpochSeconds <= $triggerObservedAtEpochSeconds),
      triggerWasFresh: (($triggerObservedAtEpochSeconds - $triggerEpochSeconds) <= $triggerMaxAgeSeconds)
    },
    buildAttestation: {
      strictCodeSignatureVerified: true,
      manualLaunch: $manualLaunch,
      canonicalAppPathStableAcrossManualRefresh: true,
      signingIdentityStableAcrossManualRefresh: true,
      mainJsBundleStableAcrossManualRefresh: true,
      executableRefreshedAfterReadyToLaunch: $executableRefreshedAfterReady,
      prelaunchExecutableSha256: $prelaunchExecutableSha256,
      prelaunchMainJsBundleSha256: $prelaunchBundleSha256,
      codeSigningIdentifier: $codeSigningIdentifier,
      codeSigningTeamIdentifier: $codeSigningTeamIdentifier,
      codeSigningDesignatedRequirement: $codeSigningDesignatedRequirement,
      suppliedAppName: $suppliedAppName,
      runningAppName: $runningAppName,
      suppliedExecutableSha256: $suppliedExecutableSha256,
      runningExecutableSha256: $runningExecutableSha256,
      suppliedMainJsBundleSha256: $suppliedBundleSha256,
      runningMainJsBundleSha256: $runningBundleSha256,
      exactExecutableMatch: ($suppliedExecutableSha256 == $runningExecutableSha256),
      exactMainJsBundleMatch: ($suppliedBundleSha256 == $runningBundleSha256)
    },
    validation: {
      exactSemanticPhotoParity: ($fullReferencePhotoMismatchCount == 0),
      photoMismatchCount: $fullReferencePhotoMismatchCount,
      exactStrategySemanticPhotoParity: ($photoMismatchCount == 0),
      strategyPhotoMismatchCount: $photoMismatchCount,
      exactFullReferencePhotoParity: ($fullReferencePhotoMismatchCount == 0),
      fullReferencePhotoMismatchCount: $fullReferencePhotoMismatchCount,
      successfulAttemptMismatchCount: $successfulAttemptMismatchCount,
      retryablePartialStateCount: $retryablePartialStateCount,
      skippedWriteCount: $skippedWriteCount,
      photoIdMismatchCount: $photoIdMismatchCount,
      unplannedPendingCount: $unplannedPendingCount,
      exactVisitFoodParity: ($visitMismatchCount == 0),
      visitMismatchCount: $visitMismatchCount,
      exactPositiveVisitSet: ($positiveVisitIdMismatchCount == 0),
      positiveVisitIdMismatchCount: $positiveVisitIdMismatchCount,
      invalidVisitFoodCount: $invalidVisitFoodCount,
      pendingCount: $pendingCount,
      pendingRowsAreExpected: ($pendingCount == ($retryableAttemptCount + $skippedSampleCount)),
      workloadAccountingExact: (
        $plannedSampleCount == $fixtureCount
        and ($attemptedSampleCount + $skippedSampleCount) == $plannedSampleCount
        and ($successfulAttemptCount + $retryableAttemptCount) == $attemptedSampleCount
      ),
      nativeWorkCountersRequired: $nativeWorkCountersRequired,
      nativeWorkCountersAvailable: $nativeWorkCountersAvailable,
      nativeWorkLifecycleBalanced: $nativeWorkLifecycleBalanced,
      nativeRequestedAssetCountMatchesAttempts: $nativeRequestedAssetCountMatchesAttempts,
      nativeBatchCountMatchesPlan: $nativeBatchCountMatchesPlan,
      integrity: $integrity,
      foreignKeyViolationCount: $foreignKeyViolationCount
    },
    originalDatabaseSha256: $originalSha256,
    originalDatabase: {
      main: {present: true, sha256: $originalSha256, mode: $originalMainMode},
      wal: {
        present: ($originalWalPresent == 1),
        sha256: (if $originalWalPresent == 1 then $originalWalSha256 else null end),
        mode: (if $originalWalPresent == 1 then $originalWalMode else null end)
      },
      shm: {
        present: ($originalShmPresent == 1),
        sha256: (if $originalShmPresent == 1 then $originalShmSha256 else null end),
        mode: (if $originalShmPresent == 1 then $originalShmMode else null end)
      },
      journal: {
        present: ($originalJournalPresent == 1),
        sha256: (if $originalJournalPresent == 1 then $originalJournalSha256 else null end),
        mode: (if $originalJournalPresent == 1 then $originalJournalMode else null end)
      }
    },
    standaloneSnapshotSha256: $standaloneSnapshotSha256,
    semanticReference: {
      source: $semanticReferenceSource,
      sha256: $semanticReferenceSha256,
      components: {
        main: {
          present: true,
          sha256: $semanticReferenceSha256,
          mode: $semanticReferenceMainMode,
          bytes: ($semanticReferenceMainSize | tonumber)
        },
        wal: {
          present: ($semanticReferenceWalPresent == 1),
          sha256: (if $semanticReferenceWalPresent == 1 then $semanticReferenceWalSha256 else null end),
          mode: (if $semanticReferenceWalPresent == 1 then $semanticReferenceWalMode else null end),
          bytes: (if $semanticReferenceWalPresent == 1 then ($semanticReferenceWalSize | tonumber) else null end)
        },
        shm: {
          present: ($semanticReferenceShmPresent == 1),
          sha256: (if $semanticReferenceShmPresent == 1 then $semanticReferenceShmSha256 else null end),
          mode: (if $semanticReferenceShmPresent == 1 then $semanticReferenceShmMode else null end),
          bytes: (if $semanticReferenceShmPresent == 1 then ($semanticReferenceShmSize | tonumber) else null end)
        },
        journal: {
          present: ($semanticReferenceJournalPresent == 1),
          sha256: (if $semanticReferenceJournalPresent == 1 then $semanticReferenceJournalSha256 else null end),
          mode: (if $semanticReferenceJournalPresent == 1 then $semanticReferenceJournalMode else null end),
          bytes: (if $semanticReferenceJournalPresent == 1 then ($semanticReferenceJournalSize | tonumber) else null end)
        }
      }
    },
    resultDatabase: {
      sha256: $resultDatabaseSha256,
      retained: $rawDatabasesRetained,
      path: (if $rawDatabasesRetained then $resultDatabasePath else null end)
    },
    rawDatabases: {
      retained: $rawDatabasesRetained,
      snapshotPath: (if $rawDatabasesRetained then $snapshotPath else null end)
    },
    restoration: {
      exactMainAndSidecarSetRestored: false,
      launchEnvironmentRestored: false,
      rawDatabasePolicyApplied: false,
      reportPublishedAfterRestoration: false,
      restoredDatabaseSha256: null
    },
    samplesPath: $samplesPath
  }' > "$REPORT_TEMP_PATH"
chmod 600 "$REPORT_TEMP_PATH"

if ! restore_database; then
  print -u2 "Database restoration failed; refusing to publish a report"
  exit 1
fi
if ! cleanup_sensitive_database_copies; then
  print -u2 "Sensitive database copy cleanup failed; refusing to publish a report"
  exit 1
fi
if ! finalize_database_guard; then
  print -u2 "Durable guard finalization failed; refusing to publish a report"
  exit 1
fi

RESTORED_SHA256="$(sha256_file "$DATABASE_PATH")"
if [[ "$RESTORED_SHA256" != "$ORIGINAL_SHA256" \
  || "$(stat -f '%Lp' "$DATABASE_PATH")" != "$ORIGINAL_MAIN_MODE" ]]; then
  print -u2 "Database restoration hash or mode mismatch; refusing to publish a report"
  exit 1
fi
verify_optional_component "$DATABASE_PATH-wal" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "$ORIGINAL_WAL_MODE" "Published restored WAL"
verify_optional_component "$DATABASE_PATH-shm" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "$ORIGINAL_SHM_MODE" "Published restored SHM"
verify_optional_component "$DATABASE_PATH-journal" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "$ORIGINAL_JOURNAL_MODE" "Published restored journal"
if [[ -n "$SEMANTIC_REFERENCE_DATABASE_PATH" ]]; then
  if ! verify_external_semantic_reference_contract; then
    print -u2 "The external semantic reference or one of its sidecars changed before report publication"
    exit 1
  fi
fi

jq \
  --arg restoredSha256 "$RESTORED_SHA256" \
  '.restoration = {
    exactMainAndSidecarSetRestored: true,
    launchEnvironmentRestored: true,
    rawDatabasePolicyApplied: true,
    reportPublishedAfterRestoration: true,
    restoredDatabaseSha256: $restoredSha256
  }' \
  "$REPORT_TEMP_PATH" > "$REPORT_RESTORED_TEMP_PATH"
chmod 600 "$REPORT_RESTORED_TEMP_PATH"
mv -f -- "$REPORT_RESTORED_TEMP_PATH" "$REPORT_PATH"
rm -f -- "$REPORT_TEMP_PATH"
durability_sync report-published

print "COMPLETE report=$REPORT_PATH result_transport=$ATTESTED_SELECTED_RESULT_TRANSPORT requested_result_transport=$RESULT_TRANSPORT visit_food_detection_strategy=$VISIT_FOOD_DETECTION_STRATEGY planned_samples=$PLANNED_SAMPLE_COUNT attempted_samples=$ATTEMPTED_SAMPLE_COUNT skipped_samples=$SKIPPED_SAMPLE_COUNT retryable_attempts=$RETRYABLE_ATTEMPT_COUNT wall_seconds=$WALL_SECONDS durable_tail_seconds=$DURABLE_TAIL_SECONDS max_rss_kib=$MAX_RSS_KIB restored_sha256=$RESTORED_SHA256"

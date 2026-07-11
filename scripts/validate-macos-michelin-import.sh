#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIRECTORY="${0:A:h}"
ORACLE_HELPER_PATH="$SCRIPT_DIRECTORY/macos-michelin-import-oracle.ts"

APP_PATH=""
DATABASE_PATH=""
OUTPUT_PREFIX=""
STRATEGY=""
TIMEOUT_SECONDS=180
MANUAL_LAUNCH=0
RECOVER_STALE_GUARD=0

usage() {
  print "Usage: validate-macos-michelin-import.sh --app=PATH --database=PATH --output-prefix=PATH --strategy=MODE [options]"
  print ""
  print "  --strategy=MODE        legacy-js-v1 or attach-insert-select-v1"
  print "  --timeout-seconds=N    Timeout after launch and after the trigger (default: 180)"
  print "  --manual-launch        Wait for Xcode to launch the exact signed Release product"
  print "  --recover-stale-guard  Restore an interrupted run; requires only --database"
  print ""
  print "The validator stops Palate and publishes a durable byte-exact guard before"
  print "opening SQLite. It installs only a disposable database copy, primes an expiring"
  print "michelin_import_validation_request plus a stale dataset marker, and requires the"
  print "production import to commit michelin_import_runtime_attestation atomically with"
  print "the new dataset marker. It also verifies the materialized reference bytes and"
  print "all canonical imported fields against an independent legacy-semantics oracle."
  print "After READY, create the printed .trigger file with a fresh fractional epoch"
  print "immediately before opening Home > Restaurants Map (or the equivalent"
  print "palate://restaurants-map deep link). Raw database copies are always deleted;"
  print "the 0600 report is aggregate-only."
}

for argument in "$@"; do
  case "$argument" in
    --app=*) APP_PATH="${argument#*=}" ;;
    --database=*) DATABASE_PATH="${argument#*=}" ;;
    --output-prefix=*) OUTPUT_PREFIX="${argument#*=}" ;;
    --strategy=*) STRATEGY="${argument#*=}" ;;
    --timeout-seconds=*) TIMEOUT_SECONDS="${argument#*=}" ;;
    --manual-launch) MANUAL_LAUNCH=1 ;;
    --recover-stale-guard) RECOVER_STALE_GUARD=1 ;;
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

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

durability_sync() {
  local phase="${1:-unspecified}"
  if [[ -n "${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_MICHELIN_IMPORT_HARNESS_FAKE_STATE" \
    && "${PALATE_MICHELIN_IMPORT_HARNESS_TEST_FAIL_DURABILITY_PHASE:-}" == "$phase" ]]; then
    print -u2 "Injected durability failure: $phase"
    return 1
  fi
  if [[ "${PALATE_MICHELIN_IMPORT_HARNESS_TEST_SKIP_DURABILITY_SYNC:-0}" == "1" \
    && -n "${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_STATE:-}" \
    && -d "$PALATE_MICHELIN_IMPORT_HARNESS_FAKE_STATE" ]]; then
    return 0
  fi
  /bin/sync
}

stop_palate() {
  pkill -TERM -x Palate 2>/dev/null || true
  for _ in {1..20}; do
    pgrep -x Palate >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  local process_pid parent_pid parent_command
  process_pid="$(pgrep -x Palate | head -1 || true)"
  if [[ -n "$process_pid" ]]; then
    parent_pid="$(ps -o ppid= -p "$process_pid" | tr -d ' ')"
    parent_command="$(ps -o comm= -p "$parent_pid" 2>/dev/null || true)"
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

assert_database_unopened_path() {
  local database_path="$1" holder_output suffix
  local -a paths=()
  for suffix in "" -wal -shm -journal; do
    [[ -e "$database_path$suffix" ]] && paths+=("$database_path$suffix")
  done
  (( ${#paths} == 0 )) && return 0
  holder_output="$(lsof -Fn -- "${paths[@]}" 2>/dev/null || true)"
  if [[ -n "$holder_output" ]]; then
    print -u2 "Another process still has the database or a sidecar open: $database_path"
    return 1
  fi
}

verify_component() {
  local component_path="$1" present="$2" expected_hash="$3" expected_mode="$4" label="$5"
  if (( present )); then
    if [[ ! -f "$component_path" || -L "$component_path" \
      || "$(sha256_file "$component_path")" != "$expected_hash" \
      || "$(stat -f '%Lp' "$component_path")" != "$expected_mode" ]]; then
      print -u2 "$label does not match its attested bytes and mode"
      return 1
    fi
  elif [[ -e "$component_path" || -L "$component_path" ]]; then
    print -u2 "$label exists but was absent from the attested set"
    return 1
  fi
}

prepare_restore_component() {
  local protected_path="$1" temporary_path="$2" expected_hash="$3"
  rm -f -- "$temporary_path"
  cp "$protected_path" "$temporary_path"
  chmod 600 "$temporary_path"
  if [[ "$(sha256_file "$temporary_path")" != "$expected_hash" ]]; then
    print -u2 "Prepared restore component hash mismatch: $protected_path"
    return 1
  fi
}

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
  local created_by_run_id main_hash main_mode wal_present wal_hash wal_mode
  local shm_present shm_hash shm_mode journal_present journal_hash journal_mode
  local failed=0 guard_removed=0 suffix present hash mode protected_path live_path temporary_path

  for dependency in awk jq lockf lsof pgrep pkill ps shasum stat tr; do
    command -v "$dependency" >/dev/null 2>&1 || {
      print -u2 "Missing recovery dependency: $dependency"
      return 2
    }
  done
  [[ -d "$database_directory" && -w "$database_directory" ]] || {
    print -u2 "Database directory is not writable: $database_directory"
    return 2
  }
  [[ ! -L "$lock_path" ]] || {
    print -u2 "Refusing symlinked validation lock: $lock_path"
    return 1
  }
  exec 9> "$lock_path"
  chmod 600 "$lock_path"
  lockf -s -t 5 9 || {
    print -u2 "Another Palate validation owns the shared database lock"
    return 75
  }
  if [[ ! -d "$guard_path" || -L "$guard_path" || ! -f "$manifest_path" || -L "$manifest_path" ]]; then
    print -u2 "No valid durable Michelin import recovery guard exists for: $database_path"
    return 66
  fi
  if ! jq -e --arg databasePath "$database_path" '
    def hash: type == "string" and test("^[0-9a-f]{64}$");
    def mode: type == "string" and test("^[0-7]{3,4}$");
    def component($required):
      type == "object" and (.present | type) == "boolean"
      and (($required | not) or .present)
      and (if .present then (.sha256 | hash) and (.mode | mode) and (.size | type) == "number"
           else .sha256 == null and .mode == null and .size == null end);
    type == "object" and .schemaVersion == 1
    and .kind == "palate-michelin-import"
    and .databasePath == $databasePath
    and (.createdByRunId | type) == "string"
    and (.components.main | component(true))
    and (.components.wal | component(false))
    and (.components.shm | component(false))
    and (.components.journal | component(false))
  ' "$manifest_path" >/dev/null; then
    print -u2 "Invalid recovery manifest; guard retained: $manifest_path"
    return 1
  fi
  created_by_run_id="$(jq -r '.createdByRunId' "$manifest_path")"
  if [[ ! "$created_by_run_id" =~ '^[A-Za-z0-9._-]+$' ]]; then
    print -u2 "Recovery manifest has an unsafe run ID; guard retained"
    return 1
  fi
  main_hash="$(jq -r '.components.main.sha256' "$manifest_path")"
  main_mode="$(jq -r '.components.main.mode' "$manifest_path")"
  wal_present="$(jq -r 'if .components.wal.present then 1 else 0 end' "$manifest_path")"
  wal_hash="$(jq -r '.components.wal.sha256 // ""' "$manifest_path")"
  wal_mode="$(jq -r '.components.wal.mode // ""' "$manifest_path")"
  shm_present="$(jq -r 'if .components.shm.present then 1 else 0 end' "$manifest_path")"
  shm_hash="$(jq -r '.components.shm.sha256 // ""' "$manifest_path")"
  shm_mode="$(jq -r '.components.shm.mode // ""' "$manifest_path")"
  journal_present="$(jq -r 'if .components.journal.present then 1 else 0 end' "$manifest_path")"
  journal_hash="$(jq -r '.components.journal.sha256 // ""' "$manifest_path")"
  journal_mode="$(jq -r '.components.journal.mode // ""' "$manifest_path")"

  stop_palate || failed=1
  (( ! failed )) && assert_database_unopened_path "$database_path" || failed=1
  for suffix in main wal shm journal; do
    case "$suffix" in
      main) present=1; hash="$main_hash"; mode="$main_mode"; live_path="$database_path" ;;
      wal) present="$wal_present"; hash="$wal_hash"; mode="$wal_mode"; live_path="$database_path-wal" ;;
      shm) present="$shm_present"; hash="$shm_hash"; mode="$shm_mode"; live_path="$database_path-shm" ;;
      journal) present="$journal_present"; hash="$journal_hash"; mode="$journal_mode"; live_path="$database_path-journal" ;;
    esac
    protected_path="$guard_path/$suffix"
    temporary_path="$guard_path/recovery-$suffix.tmp"
    (( ! failed )) && verify_component "$protected_path" "$present" "$hash" 600 "Protected $suffix" || failed=1
    if (( ! failed && present )); then
      prepare_restore_component "$protected_path" "$temporary_path" "$hash" || failed=1
    fi
  done
  if (( ! failed )); then
    rm -f -- "$database_path" "$database_path-wal" "$database_path-shm" "$database_path-journal" || failed=1
  fi
  for suffix in main wal shm journal; do
    case "$suffix" in
      main) present=1; hash="$main_hash"; mode="$main_mode"; live_path="$database_path" ;;
      wal) present="$wal_present"; hash="$wal_hash"; mode="$wal_mode"; live_path="$database_path-wal" ;;
      shm) present="$shm_present"; hash="$shm_hash"; mode="$shm_mode"; live_path="$database_path-shm" ;;
      journal) present="$journal_present"; hash="$journal_hash"; mode="$journal_mode"; live_path="$database_path-journal" ;;
    esac
    temporary_path="$guard_path/recovery-$suffix.tmp"
    if (( ! failed && present )); then
      mv -f -- "$temporary_path" "$live_path" && chmod "$mode" "$live_path" || failed=1
    fi
    (( ! failed )) && verify_component "$live_path" "$present" "$hash" "$mode" "Restored $suffix" || failed=1
  done
  (( ! failed )) && durability_sync recovery-restored-database || failed=1
  if (( ! failed )); then
    rm -f -- "$database_path.install-$created_by_run_id.tmp" \
      "$database_path.restore-$created_by_run_id.main.tmp" \
      "$database_path.restore-$created_by_run_id.wal.tmp" \
      "$database_path.restore-$created_by_run_id.shm.tmp" \
      "$database_path.restore-$created_by_run_id.journal.tmp" || failed=1
  fi
  if (( ! failed )); then
    rm -rf -- "$guard_path" || failed=1
    [[ ! -e "$guard_path" ]] || failed=1
    if (( ! failed )); then
      guard_removed=1
      durability_sync recovery-guard-removed || failed=1
    fi
  fi
  rm -f -- "$guard_path"/recovery-*.tmp(N) || true
  if (( failed )); then
    if (( guard_removed )); then
      print -u2 "Recovery failed after guard removal; inspect the restored database before retrying"
    else
      print -u2 "Recovery failed; durable guard retained: $guard_path"
    fi
    return 1
  fi
  print "RECOVERED_STALE_GUARD database=$database_path restored_sha256=$main_hash"
}

if (( RECOVER_STALE_GUARD )); then
  recover_stale_guard
  exit $?
fi

if [[ ! -d "$APP_PATH" || ! -x "$APP_PATH/Palate" || ! -s "$APP_PATH/main.jsbundle" ]]; then
  print -u2 "A signed Release Palate.app with an executable and main.jsbundle is required via --app"
  exit 2
fi
if [[ ! -f "$DATABASE_PATH" || -L "$DATABASE_PATH" ]]; then
  print -u2 "A regular non-symlinked live SQLite database is required via --database"
  exit 2
fi
if [[ -z "$OUTPUT_PREFIX" ]]; then
  print -u2 "--output-prefix is required"
  exit 2
fi
if [[ "$STRATEGY" != "legacy-js-v1" && "$STRATEGY" != "attach-insert-select-v1" ]]; then
  print -u2 "--strategy must be legacy-js-v1 or attach-insert-select-v1"
  exit 2
fi
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS < 1 )); then
  print -u2 "--timeout-seconds must be a positive integer"
  exit 2
fi
if (( ! MANUAL_LAUNCH )) && [[ "${PALATE_MICHELIN_IMPORT_HARNESS_ALLOW_DIRECT_OPEN:-0}" != "1" ]]; then
  print -u2 "Real signed validation requires --manual-launch; direct open is test-only"
  exit 2
fi

NODE_BINARY="${PALATE_NODE_BINARY:-node}"
for dependency in awk codesign jq lockf lsof md5 open pgrep pkill ps rg shasum sqlite3 stat tr "$NODE_BINARY"; do
  command -v "$dependency" >/dev/null 2>&1 || {
    print -u2 "Missing dependency: $dependency"
    exit 2
  }
done
if [[ ! -f "$ORACLE_HELPER_PATH" || -L "$ORACLE_HELPER_PATH" ]]; then
  print -u2 "The independent Michelin import oracle helper is missing or unsafe"
  exit 2
fi

APP_PATH="${APP_PATH:A}"
DATABASE_PATH="${DATABASE_PATH:A}"
OUTPUT_PREFIX="${OUTPUT_PREFIX:A}"
if [[ "${DATABASE_PATH:h:t}" != "SQLite" ]]; then
  print -u2 "The Palate database must be inside its Documents/SQLite directory"
  exit 2
fi
DOCUMENTS_DIRECTORY="${DATABASE_PATH:h:h}"
APP_GUIDE_PATH="$APP_PATH/assets/assets/michelin.db"
REPORT_PATH="$OUTPUT_PREFIX.json"
TRIGGER_PATH="$OUTPUT_PREFIX.trigger"
if [[ ! -f "$APP_GUIDE_PATH" || -L "$APP_GUIDE_PATH" ]]; then
  print -u2 "The signed app does not contain a regular bundled Michelin database"
  exit 2
fi
for suffix in -wal -journal; do
  if [[ -e "$APP_GUIDE_PATH$suffix" && "$(stat -f '%z' "$APP_GUIDE_PATH$suffix")" != "0" ]]; then
    print -u2 "The bundled Michelin guide has a nonempty ${suffix#-} sidecar"
    exit 2
  fi
done
if [[ -e "$REPORT_PATH" || -L "$REPORT_PATH" || -e "$TRIGGER_PATH" || -L "$TRIGGER_PATH" ]]; then
  print -u2 "Refusing to overwrite an existing report or trigger for this output prefix"
  exit 2
fi
mkdir -p "${OUTPUT_PREFIX:h}"

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
if (( MANUAL_LAUNCH )) && [[ "$SCHEME_RUN_CONFIGURATION" != "Release" ]]; then
  print -u2 "The shared Xcode LaunchAction must be Release for manual signed validation"
  exit 2
fi

RUN_ID="michelin-import-$$-$(date +%s)-$RANDOM"
LOCK_PATH="$DATABASE_PATH.palate-calendar-validation.lock"
GUARD_PATH="$DATABASE_PATH.palate-calendar-validation.guard"
GUARD_STAGE_PATH="$GUARD_PATH.stage-$RUN_ID"
MANIFEST_PATH="$GUARD_PATH/manifest.json"
GUARD_MAIN_PATH="$GUARD_PATH/main"
GUARD_WAL_PATH="$GUARD_PATH/wal"
GUARD_SHM_PATH="$GUARD_PATH/shm"
GUARD_JOURNAL_PATH="$GUARD_PATH/journal"
PREPARED_DATABASE_PATH="$GUARD_PATH/prepared.db"
COMPARISON_PATH="$GUARD_PATH/import-semantic-comparison.json"
INSTALL_TEMP_PATH="$DATABASE_PATH.install-$RUN_ID.tmp"
RESTORE_MAIN_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.main.tmp"
RESTORE_WAL_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.wal.tmp"
RESTORE_SHM_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.shm.tmp"
RESTORE_JOURNAL_TEMP_PATH="$DATABASE_PATH.restore-$RUN_ID.journal.tmp"
REPORT_TEMP_PATH="$REPORT_PATH.tmp-$RUN_ID"

for output_path in "$REPORT_PATH" "$TRIGGER_PATH" "$REPORT_TEMP_PATH"; do
  for protected_path in \
    "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm" "$DATABASE_PATH-journal" \
    "$LOCK_PATH" "$GUARD_PATH" "$APP_PATH/Palate" "$APP_PATH/main.jsbundle" "$APP_GUIDE_PATH"; do
    if [[ "${output_path:A}" == "${protected_path:A}" ]]; then
      print -u2 "Output artifacts must not alias a protected database or signed-build path"
      exit 2
    fi
  done
done
if [[ -L "$LOCK_PATH" ]]; then
  print -u2 "Refusing a symlinked shared validation lock"
  exit 1
fi
exec 9> "$LOCK_PATH"
chmod 600 "$LOCK_PATH"
if ! lockf -s -t 5 9; then
  print -u2 "Another Calendar/Photos/Michelin validation owns the shared database lock"
  exit 75
fi
if [[ -e "$GUARD_PATH" || -L "$GUARD_PATH" ]]; then
  print -u2 "A durable guard already exists; run --recover-stale-guard first: $GUARD_PATH"
  exit 75
fi
rm -rf -- "$GUARD_STAGE_PATH"

ORIGINAL_MAIN_SHA256=""
ORIGINAL_MAIN_MODE=""
ORIGINAL_MAIN_SIZE=0
ORIGINAL_WAL_PRESENT=0
ORIGINAL_WAL_SHA256=""
ORIGINAL_WAL_MODE=""
ORIGINAL_WAL_SIZE=0
ORIGINAL_SHM_PRESENT=0
ORIGINAL_SHM_SHA256=""
ORIGINAL_SHM_MODE=""
ORIGINAL_SHM_SIZE=0
ORIGINAL_JOURNAL_PRESENT=0
ORIGINAL_JOURNAL_SHA256=""
ORIGINAL_JOURNAL_MODE=""
ORIGINAL_JOURNAL_SIZE=0
GUARD_READY=0
RESTORED=0
CLEANUP_RUNNING=0
SUCCESS=0
APP_PID=""

copy_protected_component() {
  local source="$1" destination="$2" before after copied
  before="$(sha256_file "$source")"
  cp "$source" "$destination.tmp"
  chmod 600 "$destination.tmp"
  after="$(sha256_file "$source")"
  copied="$(sha256_file "$destination.tmp")"
  if [[ "$before" != "$after" || "$before" != "$copied" ]]; then
    rm -f -- "$destination.tmp"
    print -u2 "Database component changed while the guard copied it: $source"
    return 1
  fi
  mv -f -- "$destination.tmp" "$destination"
  print -r -- "$before"
}

capture_guard() {
  local suffix source destination hash mode size
  stop_palate
  assert_database_unopened_path "$DATABASE_PATH"
  mkdir -m 700 "$GUARD_STAGE_PATH"
  if [[ "$(stat -f '%l' "$DATABASE_PATH")" != "1" ]]; then
    print -u2 "Live database has hard-link aliases; refusing unsafe mutation"
    return 1
  fi
  ORIGINAL_MAIN_MODE="$(stat -f '%Lp' "$DATABASE_PATH")"
  ORIGINAL_MAIN_SIZE="$(stat -f '%z' "$DATABASE_PATH")"
  ORIGINAL_MAIN_SHA256="$(copy_protected_component "$DATABASE_PATH" "$GUARD_STAGE_PATH/main")"
  for suffix in wal shm journal; do
    source="$DATABASE_PATH-$suffix"
    destination="$GUARD_STAGE_PATH/$suffix"
    if [[ -e "$source" || -L "$source" ]]; then
      if [[ ! -f "$source" || -L "$source" || "$(stat -f '%l' "$source")" != "1" ]]; then
        print -u2 "Live $suffix must be a regular non-symlinked, unaliased file"
        return 1
      fi
      hash="$(copy_protected_component "$source" "$destination")"
      mode="$(stat -f '%Lp' "$source")"
      size="$(stat -f '%z' "$source")"
      case "$suffix" in
        wal) ORIGINAL_WAL_PRESENT=1; ORIGINAL_WAL_SHA256="$hash"; ORIGINAL_WAL_MODE="$mode"; ORIGINAL_WAL_SIZE="$size" ;;
        shm) ORIGINAL_SHM_PRESENT=1; ORIGINAL_SHM_SHA256="$hash"; ORIGINAL_SHM_MODE="$mode"; ORIGINAL_SHM_SIZE="$size" ;;
        journal) ORIGINAL_JOURNAL_PRESENT=1; ORIGINAL_JOURNAL_SHA256="$hash"; ORIGINAL_JOURNAL_MODE="$mode"; ORIGINAL_JOURNAL_SIZE="$size" ;;
      esac
    fi
  done
  jq -n \
    --arg databasePath "$DATABASE_PATH" --arg runId "$RUN_ID" \
    --arg mainHash "$ORIGINAL_MAIN_SHA256" --arg mainMode "$ORIGINAL_MAIN_MODE" --argjson mainSize "$ORIGINAL_MAIN_SIZE" \
    --argjson walPresent "$ORIGINAL_WAL_PRESENT" --arg walHash "$ORIGINAL_WAL_SHA256" --arg walMode "$ORIGINAL_WAL_MODE" --argjson walSize "$ORIGINAL_WAL_SIZE" \
    --argjson shmPresent "$ORIGINAL_SHM_PRESENT" --arg shmHash "$ORIGINAL_SHM_SHA256" --arg shmMode "$ORIGINAL_SHM_MODE" --argjson shmSize "$ORIGINAL_SHM_SIZE" \
    --argjson journalPresent "$ORIGINAL_JOURNAL_PRESENT" --arg journalHash "$ORIGINAL_JOURNAL_SHA256" --arg journalMode "$ORIGINAL_JOURNAL_MODE" --argjson journalSize "$ORIGINAL_JOURNAL_SIZE" \
    '{
      schemaVersion: 1,
      kind: "palate-michelin-import",
      databasePath: $databasePath,
      createdByRunId: $runId,
      components: {
        main: {present: true, sha256: $mainHash, mode: $mainMode, size: $mainSize},
        wal: {present: ($walPresent == 1), sha256: (if $walPresent == 1 then $walHash else null end), mode: (if $walPresent == 1 then $walMode else null end), size: (if $walPresent == 1 then $walSize else null end)},
        shm: {present: ($shmPresent == 1), sha256: (if $shmPresent == 1 then $shmHash else null end), mode: (if $shmPresent == 1 then $shmMode else null end), size: (if $shmPresent == 1 then $shmSize else null end)},
        journal: {present: ($journalPresent == 1), sha256: (if $journalPresent == 1 then $journalHash else null end), mode: (if $journalPresent == 1 then $journalMode else null end), size: (if $journalPresent == 1 then $journalSize else null end)}
      }
    }' > "$GUARD_STAGE_PATH/manifest.json.tmp"
  chmod 600 "$GUARD_STAGE_PATH/manifest.json.tmp"
  mv -f -- "$GUARD_STAGE_PATH/manifest.json.tmp" "$GUARD_STAGE_PATH/manifest.json"
  durability_sync guard-stage
  mv -- "$GUARD_STAGE_PATH" "$GUARD_PATH"
  GUARD_READY=1
  durability_sync guard-published
}

restore_database() {
  (( RESTORED )) && return 0
  (( GUARD_READY )) || return 0
  local failed=0 suffix present hash mode protected_path temporary_path live_path
  stop_palate || failed=1
  (( ! failed )) && assert_database_unopened_path "$DATABASE_PATH" || failed=1
  for suffix in main wal shm journal; do
    case "$suffix" in
      main) present=1; hash="$ORIGINAL_MAIN_SHA256"; mode="$ORIGINAL_MAIN_MODE"; live_path="$DATABASE_PATH"; temporary_path="$RESTORE_MAIN_TEMP_PATH" ;;
      wal) present="$ORIGINAL_WAL_PRESENT"; hash="$ORIGINAL_WAL_SHA256"; mode="$ORIGINAL_WAL_MODE"; live_path="$DATABASE_PATH-wal"; temporary_path="$RESTORE_WAL_TEMP_PATH" ;;
      shm) present="$ORIGINAL_SHM_PRESENT"; hash="$ORIGINAL_SHM_SHA256"; mode="$ORIGINAL_SHM_MODE"; live_path="$DATABASE_PATH-shm"; temporary_path="$RESTORE_SHM_TEMP_PATH" ;;
      journal) present="$ORIGINAL_JOURNAL_PRESENT"; hash="$ORIGINAL_JOURNAL_SHA256"; mode="$ORIGINAL_JOURNAL_MODE"; live_path="$DATABASE_PATH-journal"; temporary_path="$RESTORE_JOURNAL_TEMP_PATH" ;;
    esac
    protected_path="$GUARD_PATH/$suffix"
    (( ! failed )) && verify_component "$protected_path" "$present" "$hash" 600 "Protected $suffix" || failed=1
    if (( ! failed && present )); then
      prepare_restore_component "$protected_path" "$temporary_path" "$hash" || failed=1
    fi
  done
  (( failed )) && return 1
  rm -f -- "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm" "$DATABASE_PATH-journal" || failed=1
  for suffix in main wal shm journal; do
    case "$suffix" in
      main) present=1; hash="$ORIGINAL_MAIN_SHA256"; mode="$ORIGINAL_MAIN_MODE"; live_path="$DATABASE_PATH"; temporary_path="$RESTORE_MAIN_TEMP_PATH" ;;
      wal) present="$ORIGINAL_WAL_PRESENT"; hash="$ORIGINAL_WAL_SHA256"; mode="$ORIGINAL_WAL_MODE"; live_path="$DATABASE_PATH-wal"; temporary_path="$RESTORE_WAL_TEMP_PATH" ;;
      shm) present="$ORIGINAL_SHM_PRESENT"; hash="$ORIGINAL_SHM_SHA256"; mode="$ORIGINAL_SHM_MODE"; live_path="$DATABASE_PATH-shm"; temporary_path="$RESTORE_SHM_TEMP_PATH" ;;
      journal) present="$ORIGINAL_JOURNAL_PRESENT"; hash="$ORIGINAL_JOURNAL_SHA256"; mode="$ORIGINAL_JOURNAL_MODE"; live_path="$DATABASE_PATH-journal"; temporary_path="$RESTORE_JOURNAL_TEMP_PATH" ;;
    esac
    if (( ! failed && present )); then
      mv -f -- "$temporary_path" "$live_path" && chmod "$mode" "$live_path" || failed=1
    fi
    (( ! failed )) && verify_component "$live_path" "$present" "$hash" "$mode" "Restored $suffix" || failed=1
  done
  (( ! failed )) && durability_sync restored-database || failed=1
  (( ! failed )) || return 1
  RESTORED=1
}

remove_guard() {
  (( GUARD_READY )) || return 0
  rm -rf -- "$GUARD_PATH"
  [[ ! -e "$GUARD_PATH" ]]
  durability_sync guard-removed
  GUARD_READY=0
}

remove_external_raw_temporaries() {
  rm -f -- "$INSTALL_TEMP_PATH" "$RESTORE_MAIN_TEMP_PATH" "$RESTORE_WAL_TEMP_PATH" \
    "$RESTORE_SHM_TEMP_PATH" "$RESTORE_JOURNAL_TEMP_PATH" || return 1
  [[ ! -e "$INSTALL_TEMP_PATH" && ! -e "$RESTORE_MAIN_TEMP_PATH" \
    && ! -e "$RESTORE_WAL_TEMP_PATH" && ! -e "$RESTORE_SHM_TEMP_PATH" \
    && ! -e "$RESTORE_JOURNAL_TEMP_PATH" ]]
}

cleanup() {
  (( CLEANUP_RUNNING )) && return 0
  CLEANUP_RUNNING=1
  local failed=0
  stop_palate || failed=1
  if (( GUARD_READY )); then
    restore_database || failed=1
    remove_external_raw_temporaries || failed=1
    if (( ! failed )); then remove_guard || failed=1; fi
  fi
  rm -f -- "$TRIGGER_PATH" || true
  rm -rf -- "$GUARD_STAGE_PATH" || true
  if (( ! SUCCESS )); then rm -f -- "$REPORT_TEMP_PATH" "$REPORT_PATH" || true; fi
  CLEANUP_RUNNING=0
  if (( failed )); then
    print -u2 "Cleanup could not prove exact restoration. Retained guard: $GUARD_PATH"
    print -u2 "Run: $0 --database='$DATABASE_PATH' --recover-stale-guard"
    return 1
  fi
}

handle_exit() {
  local exit_status=$?
  trap - EXIT INT TERM HUP
  if ! cleanup; then exit 1; fi
  exit "$exit_status"
}
trap handle_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

capture_guard

if (( ORIGINAL_WAL_PRESENT && ORIGINAL_WAL_SIZE > 0 )); then
  print -u2 "Live database had a nonempty WAL after Palate stopped; guard restored it without opening SQLite"
  exit 1
fi
if (( ORIGINAL_JOURNAL_PRESENT && ORIGINAL_JOURNAL_SIZE > 0 )); then
  print -u2 "Live database had a nonempty rollback journal; guard restored it without opening SQLite"
  exit 1
fi

cp "$GUARD_MAIN_PATH" "$PREPARED_DATABASE_PATH"
chmod 600 "$PREPARED_DATABASE_PATH"
(( ORIGINAL_WAL_PRESENT )) && cp "$GUARD_WAL_PATH" "$PREPARED_DATABASE_PATH-wal"
(( ORIGINAL_SHM_PRESENT )) && cp "$GUARD_SHM_PATH" "$PREPARED_DATABASE_PATH-shm"
(( ORIGINAL_JOURNAL_PRESENT )) && cp "$GUARD_JOURNAL_PATH" "$PREPARED_DATABASE_PATH-journal"
sqlite3 "$PREPARED_DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" >/dev/null
rm -f -- "$PREPARED_DATABASE_PATH-wal" "$PREPARED_DATABASE_PATH-shm" "$PREPARED_DATABASE_PATH-journal"
PREPARED_INTEGRITY="$(sqlite3 "$PREPARED_DATABASE_PATH" 'PRAGMA integrity_check;')"
PREPARED_FOREIGN_KEY_VIOLATIONS="$(sqlite3 "$PREPARED_DATABASE_PATH" 'PRAGMA foreign_key_check;' | wc -l | tr -d ' ')"
[[ "$PREPARED_INTEGRITY" == "ok" && "$PREPARED_FOREIGN_KEY_VIOLATIONS" == "0" ]] || {
  print -u2 "Prepared private copy failed integrity or foreign-key validation"
  exit 1
}
[[ "$(sqlite3 "$PREPARED_DATABASE_PATH" "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='app_metadata';")" == "1" ]] || {
  print -u2 "Prepared database does not contain app_metadata"
  exit 1
}

APP_EXECUTABLE_SHA256="$(sha256_file "$APP_PATH/Palate")"
APP_BUNDLE_SHA256="$(sha256_file "$APP_PATH/main.jsbundle")"
APP_GUIDE_SHA256="$(sha256_file "$APP_GUIDE_PATH")"
APP_GUIDE_DATASET_VERSION="$(md5 -q "$APP_GUIDE_PATH")"
MATERIALIZED_REFERENCE_PATH="$DOCUMENTS_DIRECTORY/michelin_reference_${APP_GUIDE_DATASET_VERSION}.db"
if ! rg -a -F -q -- "$APP_GUIDE_DATASET_VERSION" "$APP_PATH/main.jsbundle"; then
  print -u2 "The Release bundle does not attest the bundled Michelin asset content hash"
  exit 1
fi
codesign --verify --deep --strict "$APP_PATH"

REQUEST_EXPIRES_AT_EPOCH_SECONDS=$(( $(date +%s) + 600 ))
STALE_DATASET_VERSION="validation-stale-$RUN_ID"
sqlite3 "$PREPARED_DATABASE_PATH" >/dev/null <<SQL
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
INSERT INTO app_metadata(key, value)
VALUES (
  'michelin_import_validation_request',
  json_object(
    'schemaVersion', 1,
    'runId', '$RUN_ID',
    'requestedStrategy', '$STRATEGY',
    'expiresAtEpochSeconds', $REQUEST_EXPIRES_AT_EPOCH_SECONDS
  )
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
DELETE FROM app_metadata WHERE key = 'michelin_import_runtime_attestation';
INSERT INTO app_metadata(key, value)
VALUES ('michelin_dataset_version', '$STALE_DATASET_VERSION')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
PRAGMA journal_mode = DELETE;
SQL
rm -f -- "$PREPARED_DATABASE_PATH-wal" "$PREPARED_DATABASE_PATH-shm" "$PREPARED_DATABASE_PATH-journal"
[[ "$(sqlite3 "$PREPARED_DATABASE_PATH" "SELECT value FROM app_metadata WHERE key='michelin_dataset_version';")" == "$STALE_DATASET_VERSION" ]]
[[ "$(sqlite3 "$PREPARED_DATABASE_PATH" "SELECT COUNT(*) FROM app_metadata WHERE key='michelin_import_runtime_attestation';")" == "0" ]]
if ! sqlite3 "$PREPARED_DATABASE_PATH" "SELECT value FROM app_metadata WHERE key='michelin_import_validation_request';" \
  | jq -e --arg runId "$RUN_ID" --arg strategy "$STRATEGY" --argjson expires "$REQUEST_EXPIRES_AT_EPOCH_SECONDS" '
      keys == ["expiresAtEpochSeconds", "requestedStrategy", "runId", "schemaVersion"]
      and .schemaVersion == 1 and .runId == $runId
      and .requestedStrategy == $strategy and .expiresAtEpochSeconds == $expires
    ' >/dev/null; then
  print -u2 "Prepared validation request did not round-trip exactly"
  exit 1
fi

cp "$PREPARED_DATABASE_PATH" "$INSTALL_TEMP_PATH"
chmod 600 "$INSTALL_TEMP_PATH"
[[ "$(sha256_file "$INSTALL_TEMP_PATH")" == "$(sha256_file "$PREPARED_DATABASE_PATH")" ]]
rm -f -- "$DATABASE_PATH-wal" "$DATABASE_PATH-shm" "$DATABASE_PATH-journal"
mv -f -- "$INSTALL_TEMP_PATH" "$DATABASE_PATH"
chmod "$ORIGINAL_MAIN_MODE" "$DATABASE_PATH"
durability_sync disposable-installed

PROCESS_LAUNCH_BOUNDARY_EPOCH="$(date +%s.%N)"
print "READY_TO_LAUNCH run_id=$RUN_ID strategy=$STRATEGY app=$APP_PATH"
if (( ! MANUAL_LAUNCH )); then
  PALATE_MICHELIN_IMPORT_HARNESS_FAKE_DATABASE="$DATABASE_PATH" \
    PALATE_MICHELIN_IMPORT_HARNESS_FAKE_TRIGGER="$TRIGGER_PATH" \
    PALATE_MICHELIN_IMPORT_HARNESS_FAKE_RUN_ID="$RUN_ID" \
    PALATE_MICHELIN_IMPORT_HARNESS_FAKE_STRATEGY="$STRATEGY" \
    PALATE_MICHELIN_IMPORT_HARNESS_FAKE_DATASET_VERSION="$APP_GUIDE_DATASET_VERSION" \
    PALATE_MICHELIN_IMPORT_HARNESS_FAKE_GUIDE="$APP_GUIDE_PATH" \
    PALATE_MICHELIN_IMPORT_HARNESS_FAKE_REFERENCE="$MATERIALIZED_REFERENCE_PATH" \
    PALATE_MICHELIN_IMPORT_HARNESS_FAKE_NODE="$NODE_BINARY" \
    PALATE_MICHELIN_IMPORT_HARNESS_FAKE_ORACLE_HELPER="$ORACLE_HELPER_PATH" \
    open -n "$APP_PATH"
fi

PROCESS_DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while (( $(date +%s) <= PROCESS_DEADLINE )); do
  APP_PID="$(pgrep -x Palate | head -1 || true)"
  [[ -n "$APP_PID" ]] && break
  sleep 0.1
done
if [[ -z "$APP_PID" ]]; then
  print -u2 "Timed out waiting for Palate"
  exit 1
fi
RUNNING_EXECUTABLE="$(lsof -a -p "$APP_PID" -d txt -Fn 2>/dev/null | awk '/^n/ {print substr($0, 2); exit}')"
if [[ -z "$RUNNING_EXECUTABLE" || ! -f "$RUNNING_EXECUTABLE" ]]; then
  print -u2 "Could not attest the running Palate executable"
  exit 1
fi
RUNNING_APP_PATH="${RUNNING_EXECUTABLE:h}"
if [[ "${RUNNING_APP_PATH:A}" != "$APP_PATH" \
  || "$(sha256_file "$RUNNING_EXECUTABLE")" != "$APP_EXECUTABLE_SHA256" \
  || ! -s "$RUNNING_APP_PATH/main.jsbundle" \
  || "$(sha256_file "$RUNNING_APP_PATH/main.jsbundle")" != "$APP_BUNDLE_SHA256" \
  || ! -f "$RUNNING_APP_PATH/assets/assets/michelin.db" \
  || "$(sha256_file "$RUNNING_APP_PATH/assets/assets/michelin.db")" != "$APP_GUIDE_SHA256" ]]; then
  print -u2 "Running Palate does not match the attested signed Release app/build/guide"
  exit 1
fi
codesign --verify --deep --strict "$RUNNING_APP_PATH"
PROCESS_ATTESTED_EPOCH="$(date +%s.%N)"
INITIAL_RSS_KIB="$(ps -o rss= -p "$APP_PID" | tr -d ' ' || true)"
[[ "$INITIAL_RSS_KIB" =~ ^[0-9]+$ ]] || INITIAL_RSS_KIB=0
MAX_RSS_KIB="$INITIAL_RSS_KIB"

print "READY run_id=$RUN_ID strategy=$STRATEGY trigger=$TRIGGER_PATH action='Home > Restaurants Map or palate://restaurants-map'"
TRIGGER_DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while [[ ! -s "$TRIGGER_PATH" ]]; do
  kill -0 "$APP_PID" 2>/dev/null || {
    print -u2 "Palate exited before the validation trigger"
    exit 1
  }
  if (( $(date +%s) > TRIGGER_DEADLINE )); then
    print -u2 "Timed out waiting for trigger: $TRIGGER_PATH"
    exit 1
  fi
  sleep 0.05
done
if [[ ! -f "$TRIGGER_PATH" || -L "$TRIGGER_PATH" ]]; then
  print -u2 "Trigger must be a regular non-symlinked file"
  exit 1
fi
TRIGGER_EPOCH="$(tr -d '[:space:]' < "$TRIGGER_PATH")"
if [[ ! "$TRIGGER_EPOCH" =~ '^[0-9]+([.][0-9]+)?$' ]] \
  || ! awk -v trigger="$TRIGGER_EPOCH" -v lower="$PROCESS_ATTESTED_EPOCH" -v upper="$(date +%s.%N)" \
    'BEGIN { exit !(trigger >= lower && trigger <= upper + 2) }'; then
  print -u2 "Trigger timestamp must be fresh and created after process attestation"
  exit 1
fi

COMPLETION_DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
COMPLETION_EPOCH=""
ATTESTATION_JSON=""
while (( $(date +%s) <= COMPLETION_DEADLINE )); do
  kill -0 "$APP_PID" 2>/dev/null || {
    print -u2 "Palate exited before Michelin import completed"
    exit 1
  }
  CURRENT_RSS_KIB="$(ps -o rss= -p "$APP_PID" | tr -d ' ' || true)"
  if [[ "$CURRENT_RSS_KIB" =~ ^[0-9]+$ ]] && (( CURRENT_RSS_KIB > MAX_RSS_KIB )); then
    MAX_RSS_KIB="$CURRENT_RSS_KIB"
  fi
  OBSERVED_DATASET_VERSION="$(sqlite3 -readonly "$DATABASE_PATH" "SELECT value FROM app_metadata WHERE key='michelin_dataset_version';" 2>/dev/null || true)"
  ATTESTATION_JSON="$(sqlite3 -readonly "$DATABASE_PATH" "SELECT value FROM app_metadata WHERE key='michelin_import_runtime_attestation';" 2>/dev/null || true)"
  if [[ "$OBSERVED_DATASET_VERSION" == "$APP_GUIDE_DATASET_VERSION" && -n "$ATTESTATION_JSON" ]]; then
    COMPLETION_EPOCH="$(date +%s.%N)"
    break
  fi
  sleep 0.05
done
if [[ -z "$COMPLETION_EPOCH" ]]; then
  print -u2 "Timed out waiting for the Michelin dataset marker and runtime attestation"
  exit 1
fi

stop_palate
APP_PID=""
assert_database_unopened_path "$DATABASE_PATH"
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" >/dev/null
rm -f -- "$DATABASE_PATH-wal" "$DATABASE_PATH-shm" "$DATABASE_PATH-journal"
RESULT_INTEGRITY="$(sqlite3 "$DATABASE_PATH" 'PRAGMA integrity_check;')"
RESULT_FOREIGN_KEY_VIOLATIONS="$(sqlite3 "$DATABASE_PATH" 'PRAGMA foreign_key_check;' | wc -l | tr -d ' ')"
[[ "$RESULT_INTEGRITY" == "ok" && "$RESULT_FOREIGN_KEY_VIOLATIONS" == "0" ]] || {
  print -u2 "Result database failed integrity or foreign-key validation"
  exit 1
}
ATTESTATION_JSON="$(sqlite3 "$DATABASE_PATH" "SELECT value FROM app_metadata WHERE key='michelin_import_runtime_attestation';")"
if ! print -rn -- "$ATTESTATION_JSON" | jq -e \
  --arg runId "$RUN_ID" --arg strategy "$STRATEGY" --arg datasetVersion "$APP_GUIDE_DATASET_VERSION" \
  --argjson triggerEpoch "$TRIGGER_EPOCH" --argjson completionEpoch "$COMPLETION_EPOCH" '
    keys == [
      "datasetVersion", "fallbackReason", "importedRows", "observedAtEpochSeconds",
      "requestedStrategy", "resolvedStrategy", "runId", "schemaVersion",
      "selectedStrategy", "sourceRows"
    ]
    and .schemaVersion == 1 and .runId == $runId
    and .requestedStrategy == $strategy
    and .resolvedStrategy == $strategy
    and .selectedStrategy == $strategy
    and .fallbackReason == null
    and .datasetVersion == $datasetVersion
    and (.sourceRows | type) == "number" and (.sourceRows | floor) == .sourceRows and .sourceRows > 0
    and (.importedRows | type) == "number" and (.importedRows | floor) == .importedRows and .importedRows > 0
    and .importedRows <= .sourceRows
    and (.observedAtEpochSeconds | type) == "number"
    and (.observedAtEpochSeconds | floor) == .observedAtEpochSeconds
    # Production intentionally records whole epoch seconds. Compare against
    # the enclosing trigger/completion seconds without rejecting subsecond UI timing.
    and .observedAtEpochSeconds >= ($triggerEpoch | floor)
    and .observedAtEpochSeconds <= ($completionEpoch | floor)
  ' >/dev/null; then
  print -u2 "Michelin import runtime attestation did not match the requested and selected strategy"
  exit 1
fi
FINAL_DATASET_VERSION="$(sqlite3 "$DATABASE_PATH" "SELECT value FROM app_metadata WHERE key='michelin_dataset_version';")"
[[ "$FINAL_DATASET_VERSION" == "$APP_GUIDE_DATASET_VERSION" ]] || {
  print -u2 "Michelin dataset marker did not commit with the import attestation"
  exit 1
}
SOURCE_ROWS="$(print -rn -- "$ATTESTATION_JSON" | jq -r '.sourceRows')"
IMPORTED_ROWS="$(print -rn -- "$ATTESTATION_JSON" | jq -r '.importedRows')"
ACTIVE_ROWS="$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM michelin_restaurants WHERE datasetVersion='$APP_GUIDE_DATASET_VERSION';")"
TOTAL_ROWS="$(sqlite3 "$DATABASE_PATH" 'SELECT COUNT(*) FROM michelin_restaurants;')"

if [[ ! -f "$MATERIALIZED_REFERENCE_PATH" || -L "$MATERIALIZED_REFERENCE_PATH" \
  || "$(stat -f '%l' "$MATERIALIZED_REFERENCE_PATH")" != "1" ]]; then
  print -u2 "Production did not materialize one regular unaliased Michelin reference copy"
  exit 1
fi
MATERIALIZED_REFERENCE_SIZE="$(stat -f '%z' "$MATERIALIZED_REFERENCE_PATH")"
MATERIALIZED_REFERENCE_SHA256="$(sha256_file "$MATERIALIZED_REFERENCE_PATH")"
if [[ "$MATERIALIZED_REFERENCE_SIZE" != "$(stat -f '%z' "$APP_GUIDE_PATH")" \
  || "$MATERIALIZED_REFERENCE_SHA256" != "$APP_GUIDE_SHA256" ]]; then
  print -u2 "Production's materialized Michelin reference did not match the signed bundled guide"
  exit 1
fi

if ! "$NODE_BINARY" --no-warnings --experimental-sqlite --experimental-strip-types \
  "$ORACLE_HELPER_PATH" compare \
  --database="$DATABASE_PATH" \
  --guide="$APP_GUIDE_PATH" \
  --dataset-version="$APP_GUIDE_DATASET_VERSION" \
  --output="$COMPARISON_PATH"; then
  print -u2 "Signed Michelin import did not match the independent legacy-semantics oracle"
  exit 1
fi
if [[ ! -f "$COMPARISON_PATH" || -L "$COMPARISON_PATH" \
  || "$(stat -f '%l' "$COMPARISON_PATH")" != "1" \
  || "$(stat -f '%Lp' "$COMPARISON_PATH")" != "600" ]]; then
  print -u2 "Independent Michelin import comparison output was unsafe"
  exit 1
fi
COMPARISON_JSON="$(< "$COMPARISON_PATH")"
if ! print -rn -- "$COMPARISON_JSON" | jq -e \
  --argjson sourceRows "$SOURCE_ROWS" --argjson importedRows "$IMPORTED_ROWS" --argjson activeRows "$ACTIVE_ROWS" '
    .schemaVersion == 1 and .status == "ok"
    and .encoding == {
      schema: "length-prefixed-v1",
      stringEncoding: "utf8",
      floatingPointEncoding: "ieee754-binary64-be",
      integerEncoding: "signed-64-be",
      rowOrder: "id-utf8-binary"
    }
    and .counts.signedGuideSourceRows == $sourceRows
    and .counts.expectedActiveRows == $importedRows
    and .counts.actualActiveRows == $activeRows
    and $importedRows == $activeRows
    and (.digests.expectedCanonicalRowsSha256 | test("^[0-9a-f]{64}$"))
    and .digests.actualCanonicalRowsSha256 == .digests.expectedCanonicalRowsSha256
    and .mismatches == {missingRows: 0, unexpectedRows: 0, contentRows: 0}
    and (.correctness | to_entries | all(.value == true))
  ' >/dev/null; then
  print -u2 "Independent Michelin import comparison did not match runtime aggregate attestation"
  exit 1
fi
if [[ "$(sha256_file "$MATERIALIZED_REFERENCE_PATH")" != "$MATERIALIZED_REFERENCE_SHA256" ]]; then
  print -u2 "Materialized Michelin reference changed during independent comparison"
  exit 1
fi

RESULT_SHA256="$(sha256_file "$DATABASE_PATH")"
TRIGGER_TO_COMPLETION_SECONDS="$(awk -v start="$TRIGGER_EPOCH" -v end="$COMPLETION_EPOCH" 'BEGIN { printf "%.9f", end-start }')"
ATTESTATION_OBSERVED_AT="$(print -rn -- "$ATTESTATION_JSON" | jq -r '.observedAtEpochSeconds')"

restore_database
remove_external_raw_temporaries
remove_guard
verify_component "$DATABASE_PATH" 1 "$ORIGINAL_MAIN_SHA256" "$ORIGINAL_MAIN_MODE" "Final restored main"
verify_component "$DATABASE_PATH-wal" "$ORIGINAL_WAL_PRESENT" "$ORIGINAL_WAL_SHA256" "$ORIGINAL_WAL_MODE" "Final restored WAL"
verify_component "$DATABASE_PATH-shm" "$ORIGINAL_SHM_PRESENT" "$ORIGINAL_SHM_SHA256" "$ORIGINAL_SHM_MODE" "Final restored SHM"
verify_component "$DATABASE_PATH-journal" "$ORIGINAL_JOURNAL_PRESENT" "$ORIGINAL_JOURNAL_SHA256" "$ORIGINAL_JOURNAL_MODE" "Final restored journal"

jq -n \
  --arg runId "$RUN_ID" --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg appBundleName "${APP_PATH:t}" --arg schemeRunConfiguration "$SCHEME_RUN_CONFIGURATION" \
  --arg executableSha256 "$APP_EXECUTABLE_SHA256" --arg bundleSha256 "$APP_BUNDLE_SHA256" \
  --arg guideSha256 "$APP_GUIDE_SHA256" --arg guideVersion "$APP_GUIDE_DATASET_VERSION" \
  --arg materializedGuideSha256 "$MATERIALIZED_REFERENCE_SHA256" --argjson materializedGuideSize "$MATERIALIZED_REFERENCE_SIZE" \
  --arg strategy "$STRATEGY" --arg sourceMainSha256 "$ORIGINAL_MAIN_SHA256" \
  --arg sourceMainMode "$ORIGINAL_MAIN_MODE" --argjson sourceMainSize "$ORIGINAL_MAIN_SIZE" \
  --argjson walPresent "$ORIGINAL_WAL_PRESENT" --arg walSha256 "$ORIGINAL_WAL_SHA256" --arg walMode "$ORIGINAL_WAL_MODE" --argjson walSize "$ORIGINAL_WAL_SIZE" \
  --argjson shmPresent "$ORIGINAL_SHM_PRESENT" --arg shmSha256 "$ORIGINAL_SHM_SHA256" --arg shmMode "$ORIGINAL_SHM_MODE" --argjson shmSize "$ORIGINAL_SHM_SIZE" \
  --argjson journalPresent "$ORIGINAL_JOURNAL_PRESENT" --arg journalSha256 "$ORIGINAL_JOURNAL_SHA256" --arg journalMode "$ORIGINAL_JOURNAL_MODE" --argjson journalSize "$ORIGINAL_JOURNAL_SIZE" \
  --arg resultSha256 "$RESULT_SHA256" --argjson triggerEpoch "$TRIGGER_EPOCH" \
  --argjson completionEpoch "$COMPLETION_EPOCH" --argjson durationSeconds "$TRIGGER_TO_COMPLETION_SECONDS" \
  --argjson initialRssKib "$INITIAL_RSS_KIB" --argjson maxRssKib "$MAX_RSS_KIB" \
  --argjson sourceRows "$SOURCE_ROWS" --argjson importedRows "$IMPORTED_ROWS" \
  --argjson activeRows "$ACTIVE_ROWS" --argjson totalRows "$TOTAL_ROWS" \
  --argjson attestationObservedAt "$ATTESTATION_OBSERVED_AT" \
  --argjson semanticComparison "$COMPARISON_JSON" \
  '{
    schemaVersion: 1,
    status: "ok",
    runId: $runId,
    generatedAt: $generatedAt,
    strategy: $strategy,
    signedBuild: {
      appBundleName: $appBundleName,
      schemeRunConfiguration: $schemeRunConfiguration,
      strictCodeSignatureVerified: true,
      runningBundleMatched: true,
      executableSha256: $executableSha256,
      mainJsBundleSha256: $bundleSha256,
      bundledGuideSha256: $guideSha256,
      bundledGuideDatasetVersion: $guideVersion
    },
    materializedSource: {
      schemaVersion: 1,
      regularUnaliasedFile: true,
      byteIdenticalToSignedBundle: true,
      sha256: $materializedGuideSha256,
      byteSize: $materializedGuideSize
    },
    sourceGuard: {
      capturedBeforeSQLiteAccess: true,
      sharedMutationLock: true,
      durableStaleRecovery: true,
      components: {
        main: {present: true, sha256: $sourceMainSha256, mode: $sourceMainMode, size: $sourceMainSize},
        wal: {present: ($walPresent == 1), sha256: (if $walPresent == 1 then $walSha256 else null end), mode: (if $walPresent == 1 then $walMode else null end), size: (if $walPresent == 1 then $walSize else null end)},
        shm: {present: ($shmPresent == 1), sha256: (if $shmPresent == 1 then $shmSha256 else null end), mode: (if $shmPresent == 1 then $shmMode else null end), size: (if $shmPresent == 1 then $shmSize else null end)},
        journal: {present: ($journalPresent == 1), sha256: (if $journalPresent == 1 then $journalSha256 else null end), mode: (if $journalPresent == 1 then $journalMode else null end), size: (if $journalPresent == 1 then $journalSize else null end)}
      }
    },
    fixture: {
      installedDisposableCopyOnly: true,
      validationRequestSchemaVersion: 1,
      staleDatasetMarkerPrimed: true,
      previousAttestationRemoved: true,
      requestExpirySeconds: 600
    },
    runtimeAttestation: {
      schemaVersion: 1,
      runIdMatched: true,
      requestedStrategy: $strategy,
      resolvedStrategy: $strategy,
      selectedStrategy: $strategy,
      fallbackReason: null,
      datasetVersionMatched: true,
      sourceRows: $sourceRows,
      importedRows: $importedRows,
      observedAtEpochSeconds: $attestationObservedAt,
      committedAtomicallyWithDatasetMarker: true
    },
    semanticParity: $semanticComparison,
    timing: {
      timestampedManualTrigger: true,
      triggerEpochSeconds: $triggerEpoch,
      completionObservedEpochSeconds: $completionEpoch,
      triggerToImportCommitSeconds: $durationSeconds,
      initialRssKib: $initialRssKib,
      maximumObservedRssKib: $maxRssKib
    },
    result: {
      databaseSha256: $resultSha256,
      activeDatasetRows: $activeRows,
      totalGuideRows: $totalRows,
      integrityCheck: "ok",
      foreignKeyViolationCount: 0
    },
    restoration: {
      exactMainWalShmJournalBytesAndModes: true,
      rawPrivateArtifactsDeleted: true,
      aggregateOnlyReport: true
    }
  }' > "$REPORT_TEMP_PATH"
chmod 600 "$REPORT_TEMP_PATH"
mv -f -- "$REPORT_TEMP_PATH" "$REPORT_PATH"
durability_sync report-published
rm -f -- "$TRIGGER_PATH"
SUCCESS=1
print "VALIDATED report=$REPORT_PATH strategy=$STRATEGY duration_seconds=$TRIGGER_TO_COMPLETION_SECONDS imported_rows=$IMPORTED_ROWS"

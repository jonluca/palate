#!/bin/zsh
set -euo pipefail
umask 077

ROOT_DIRECTORY="${0:A:h:h}"
VALIDATOR_PATH="$ROOT_DIRECTORY/scripts/validate-macos-michelin-import.sh"
ORACLE_HELPER_PATH="$ROOT_DIRECTORY/scripts/macos-michelin-import-oracle.ts"
FAKE_HELPER_TEMPLATE="$ROOT_DIRECTORY/scripts/fixtures/michelin-import-harness/fake-macos-command.sh"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-michelin-import-harness.XXXXXX")"
FAKE_HELPER_PATH="$TEMPORARY_DIRECTORY/fake-macos-command.sh"
FAKE_BIN_DIRECTORY="$TEMPORARY_DIRECTORY/bin"
FAKE_STATE_DIRECTORY="$TEMPORARY_DIRECTORY/state"
FAKE_APP_PATH="$TEMPORARY_DIRECTORY/private-build/Palate.app"
DATABASE_PATH="$TEMPORARY_DIRECTORY/private-live/SQLite/photo_foodie.db"
NODE_BINARY="$(command -v node)"

cleanup() {
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    kill -TERM "$(< "$FAKE_STATE_DIRECTORY/pid")" 2>/dev/null || true
  fi
  if [[ "${PALATE_MICHELIN_IMPORT_HARNESS_TEST_KEEP_TEMP:-0}" == "1" ]]; then
    print -u2 "Retained harness directory: $TEMPORARY_DIRECTORY"
  else
    rm -rf -- "$TEMPORARY_DIRECTORY"
  fi
}
trap cleanup EXIT

for dependency in awk jq md5 rg shasum sqlite3 stat zsh; do
  command -v "$dependency" >/dev/null 2>&1 || {
    print -u2 "Missing test dependency: $dependency"
    exit 2
  }
done

mkdir -p "$FAKE_BIN_DIRECTORY" "$FAKE_STATE_DIRECTORY" \
  "$FAKE_APP_PATH/assets/assets" "${DATABASE_PATH:h}"
cp "$FAKE_HELPER_TEMPLATE" "$FAKE_HELPER_PATH"
chmod 700 "$FAKE_HELPER_PATH"
for command_name in codesign lsof open pgrep pkill ps; do
  ln -s "$FAKE_HELPER_PATH" "$FAKE_BIN_DIRECTORY/$command_name"
done
ln -s /usr/bin/true "$FAKE_APP_PATH/Palate"
print -r -- "fixture-release-main-bundle" > "$FAKE_APP_PATH/main.jsbundle"

sqlite3 "$FAKE_APP_PATH/assets/assets/michelin.db" >/dev/null <<'SQL'
PRAGMA journal_mode = DELETE;
CREATE TABLE restaurants (
  id INTEGER PRIMARY KEY,
  name TEXT,
  address TEXT,
  location TEXT,
  latitude TEXT,
  longitude TEXT,
  cuisine TEXT
);
CREATE TABLE restaurant_awards (
  restaurant_id INTEGER,
  year INTEGER,
  distinction TEXT,
  green_star INTEGER
);
INSERT INTO restaurants VALUES
  (1, 'guide-private-one', 'one', 'city', '1', '2', 'test'),
  (2, 'guide-private-two', 'two', 'city', '3', '4', 'test'),
  (3, 'guide-private-invalid', 'three', 'city', '0', '0', 'test');
INSERT INTO restaurant_awards VALUES (1, 2026, 'One Star', 0);
SQL
GUIDE_VERSION="$(md5 -q "$FAKE_APP_PATH/assets/assets/michelin.db")"
MATERIALIZED_REFERENCE_PATH="${DATABASE_PATH:h:h}/michelin_reference_${GUIDE_VERSION}.db"
print -r -- "$GUIDE_VERSION" >> "$FAKE_APP_PATH/main.jsbundle"

export PATH="$FAKE_BIN_DIRECTORY:$PATH"
export PALATE_MICHELIN_IMPORT_HARNESS_FAKE_STATE="$FAKE_STATE_DIRECTORY"
export PALATE_MICHELIN_IMPORT_HARNESS_FAKE_HELPER="$FAKE_HELPER_PATH"
export PALATE_MICHELIN_IMPORT_HARNESS_FAKE_APP="$FAKE_APP_PATH"
export PALATE_MICHELIN_IMPORT_HARNESS_ALLOW_DIRECT_OPEN=1
export PALATE_MICHELIN_IMPORT_HARNESS_TEST_SKIP_DURABILITY_SYNC=1
export PALATE_NODE_BINARY="$NODE_BINARY"

typeset -A ORIGINAL_PRESENT ORIGINAL_HASH ORIGINAL_MODE

create_database_fixture() {
  rm -f -- "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm" "$DATABASE_PATH-journal"
  sqlite3 "$DATABASE_PATH" >/dev/null <<'SQL'
PRAGMA journal_mode = DELETE;
PRAGMA foreign_keys = ON;
CREATE TABLE michelin_restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  cuisine TEXT NOT NULL DEFAULT '',
  latestAwardYear INTEGER,
  award TEXT NOT NULL DEFAULT '',
  datasetVersion TEXT
);
CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  suggestedRestaurantId TEXT,
  FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
);
INSERT INTO app_metadata VALUES ('michelin_dataset_version', 'historical-private-version');
INSERT INTO app_metadata VALUES (
  'michelin_import_runtime_attestation',
  '{"schemaVersion":1,"runId":"stale-private-attestation"}'
);
INSERT INTO michelin_restaurants
  (id, name, latitude, longitude, datasetVersion)
VALUES
  ('michelin-1', 'customer-private-one', 1, 2, 'historical-private-version'),
  ('michelin-2', 'customer-private-two', 3, 4, 'historical-private-version'),
  ('michelin-history', 'customer-private-history', 5, 6, 'older-private-version');
INSERT INTO visits VALUES ('visit-private-one', 'michelin-history');
SQL
  chmod 640 "$DATABASE_PATH"
  : > "$DATABASE_PATH-wal"
  : > "$DATABASE_PATH-shm"
  : > "$DATABASE_PATH-journal"
  chmod 600 "$DATABASE_PATH-wal" "$DATABASE_PATH-journal"
  chmod 644 "$DATABASE_PATH-shm"
}

capture_database_contract() {
  local suffix component_path key
  for suffix in "" -wal -shm -journal; do
    component_path="$DATABASE_PATH$suffix"
    key="${suffix#-}"
    [[ -n "$key" ]] || key=main
    if [[ -f "$component_path" ]]; then
      ORIGINAL_PRESENT[$key]=1
      ORIGINAL_HASH[$key]="$(shasum -a 256 "$component_path" | awk '{print $1}')"
      ORIGINAL_MODE[$key]="$(stat -f '%Lp' "$component_path")"
    else
      ORIGINAL_PRESENT[$key]=0
      ORIGINAL_HASH[$key]=""
      ORIGINAL_MODE[$key]=""
    fi
  done
}

assert_equal() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    print -u2 "$label: expected '$expected', found '$actual'"
    return 1
  fi
}

assert_restored_contract() {
  local label="$1" suffix component_path key
  for suffix in "" -wal -shm -journal; do
    component_path="$DATABASE_PATH$suffix"
    key="${suffix#-}"
    [[ -n "$key" ]] || key=main
    if (( ORIGINAL_PRESENT[$key] )); then
      [[ -f "$component_path" && ! -L "$component_path" ]]
      assert_equal "$(shasum -a 256 "$component_path" | awk '{print $1}')" "${ORIGINAL_HASH[$key]}" "$label $key hash"
      assert_equal "$(stat -f '%Lp' "$component_path")" "${ORIGINAL_MODE[$key]}" "$label $key mode"
    elif [[ -e "$component_path" || -L "$component_path" ]]; then
      print -u2 "$label unexpectedly created $key"
      return 1
    fi
  done
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  if find "${DATABASE_PATH:h}" -maxdepth 2 \
    \( -name 'prepared.db' -o -name '*.tmp' -o -name '*.guard' \) \
    -print -quit | rg -q .; then
    print -u2 "$label left a private raw database artifact"
    return 1
  fi
  [[ ! -f "$FAKE_STATE_DIRECTORY/pid" ]]
}

reset_case() {
  pkill -TERM -x Palate 2>/dev/null || true
  rm -f -- "$FAKE_STATE_DIRECTORY/pid" "$FAKE_STATE_DIRECTORY/simulator.log"
  rm -rf -- \
    "$DATABASE_PATH.palate-calendar-validation.guard" \
    "$DATABASE_PATH.palate-calendar-validation.guard".stage-*(N)
  rm -f -- "$MATERIALIZED_REFERENCE_PATH" "$MATERIALIZED_REFERENCE_PATH"-wal \
    "$MATERIALIZED_REFERENCE_PATH"-shm "$MATERIALIZED_REFERENCE_PATH"-journal
  create_database_fixture
  capture_database_contract
}

wait_for_ready() {
  local log_path="$1" process_pid="$2"
  for _ in {1..1000}; do
    rg -q '^READY ' "$log_path" 2>/dev/null && return 0
    kill -0 "$process_pid" 2>/dev/null || {
      print -u2 "Validator exited before READY"
      sed -n '1,260p' "$log_path" >&2
      return 1
    }
    sleep 0.01
  done
  print -u2 "Timed out waiting for READY"
  sed -n '1,260p' "$log_path" >&2
  return 1
}

record_trigger() {
  local trigger_path="$1"
  print -r -- "$(date +%s.%N)" > "$trigger_path.tmp"
  mv -f -- "$trigger_path.tmp" "$trigger_path"
}

start_validator() {
  local prefix="$1" log_path="$2" strategy="$3" mode="$4"
  PALATE_MICHELIN_IMPORT_HARNESS_FAKE_MODE="$mode" \
    zsh "$VALIDATOR_PATH" \
      --app="$FAKE_APP_PATH" \
      --database="$DATABASE_PATH" \
      --output-prefix="$prefix" \
      --strategy="$strategy" \
      --timeout-seconds=10 > "$log_path" 2>&1 &
  VALIDATOR_PID=$!
}

assert_private_data_absent() {
  local report="$1" private_value
  for private_value in \
    customer-private visit-private guide-private historical-private older-private \
    "$FAKE_APP_PATH" "$DATABASE_PATH" "$TEMPORARY_DIRECTORY"; do
    if rg -F -q -- "$private_value" "$report"; then
      print -u2 "Aggregate report leaked private fixture data: $private_value"
      return 1
    fi
  done
}

run_success_case() {
  local strategy="$1" label="$2"
  local prefix="$TEMPORARY_DIRECTORY/$label" log="$TEMPORARY_DIRECTORY/$label.log"
  reset_case
  start_validator "$prefix" "$log" "$strategy" success
  wait_for_ready "$log" "$VALIDATOR_PID"
  record_trigger "$prefix.trigger"
  if ! wait "$VALIDATOR_PID"; then
    sed -n '1,320p' "$log" >&2
    return 1
  fi
  [[ -f "$prefix.json" && ! -L "$prefix.json" ]]
  assert_equal "$(stat -f '%Lp' "$prefix.json")" 600 "$label report mode"
  jq -e --arg strategy "$strategy" '
    .schemaVersion == 1 and .status == "ok" and .strategy == $strategy
    and .signedBuild.appBundleName == "Palate.app"
    and (.signedBuild | has("appPath") | not)
    and .signedBuild.strictCodeSignatureVerified
    and .signedBuild.runningBundleMatched
    and .materializedSource.schemaVersion == 1
    and .materializedSource.regularUnaliasedFile
    and .materializedSource.byteIdenticalToSignedBundle
    and .materializedSource.sha256 == .signedBuild.bundledGuideSha256
    and .materializedSource.byteSize > 0
    and .sourceGuard.capturedBeforeSQLiteAccess
    and .sourceGuard.sharedMutationLock
    and .sourceGuard.durableStaleRecovery
    and .fixture.validationRequestSchemaVersion == 1
    and .fixture.staleDatasetMarkerPrimed
    and .fixture.previousAttestationRemoved
    and .runtimeAttestation.schemaVersion == 1
    and .runtimeAttestation.runIdMatched
    and .runtimeAttestation.requestedStrategy == $strategy
    and .runtimeAttestation.resolvedStrategy == $strategy
    and .runtimeAttestation.selectedStrategy == $strategy
    and .runtimeAttestation.fallbackReason == null
    and .runtimeAttestation.datasetVersionMatched
    and .runtimeAttestation.sourceRows == 3
    and .runtimeAttestation.importedRows == 2
    and .runtimeAttestation.committedAtomicallyWithDatasetMarker
    and .semanticParity.schemaVersion == 1
    and .semanticParity.status == "ok"
    and .semanticParity.encoding.schema == "length-prefixed-v1"
    and .semanticParity.encoding.floatingPointEncoding == "ieee754-binary64-be"
    and .semanticParity.counts.signedGuideSourceRows == 3
    and .semanticParity.counts.expectedActiveRows == 2
    and .semanticParity.counts.actualActiveRows == 2
    and .semanticParity.digests.expectedCanonicalRowsSha256 == .semanticParity.digests.actualCanonicalRowsSha256
    and .semanticParity.mismatches == {missingRows: 0, unexpectedRows: 0, contentRows: 0}
    and (.semanticParity.correctness | to_entries | all(.value == true))
    and .result.activeDatasetRows == 2
    and .result.integrityCheck == "ok"
    and .result.foreignKeyViolationCount == 0
    and .restoration.exactMainWalShmJournalBytesAndModes
    and .restoration.rawPrivateArtifactsDeleted
    and .restoration.aggregateOnlyReport
    and (.sourceGuard | has("databasePath") | not)
  ' "$prefix.json" >/dev/null
  assert_private_data_absent "$prefix.json"
  [[ ! -e "$prefix.trigger" ]]
  assert_restored_contract "$label"
}

run_attestation_mismatch_case() {
  local prefix="$TEMPORARY_DIRECTORY/attestation-mismatch" log="$TEMPORARY_DIRECTORY/attestation-mismatch.log"
  reset_case
  start_validator "$prefix" "$log" attach-insert-select-v1 attestation-mismatch
  wait_for_ready "$log" "$VALIDATOR_PID"
  record_trigger "$prefix.trigger"
  if wait "$VALIDATOR_PID"; then
    print -u2 "Attestation-mismatch case unexpectedly succeeded"
    return 1
  fi
  rg -q 'runtime attestation did not match' "$log"
  [[ ! -e "$prefix.json" && ! -e "$prefix.trigger" ]]
  assert_restored_contract attestation-mismatch
}

run_same_count_semantic_corruption_case() {
  local prefix="$TEMPORARY_DIRECTORY/same-count-semantic-corruption"
  local log="$TEMPORARY_DIRECTORY/same-count-semantic-corruption.log"
  reset_case
  start_validator "$prefix" "$log" attach-insert-select-v1 same-count-semantic-corruption
  wait_for_ready "$log" "$VALIDATOR_PID"
  record_trigger "$prefix.trigger"
  if wait "$VALIDATOR_PID"; then
    print -u2 "Same-count semantic-corruption case unexpectedly succeeded"
    return 1
  fi
  rg -q 'did not match the independent legacy-semantics oracle' "$log"
  [[ ! -e "$prefix.json" && ! -e "$prefix.trigger" ]]
  assert_restored_contract same-count-semantic-corruption
}

run_materialized_source_mismatch_case() {
  local prefix="$TEMPORARY_DIRECTORY/materialized-source-mismatch"
  local log="$TEMPORARY_DIRECTORY/materialized-source-mismatch.log"
  reset_case
  start_validator "$prefix" "$log" attach-insert-select-v1 materialized-source-mismatch
  wait_for_ready "$log" "$VALIDATOR_PID"
  record_trigger "$prefix.trigger"
  if wait "$VALIDATOR_PID"; then
    print -u2 "Materialized-source mismatch case unexpectedly succeeded"
    return 1
  fi
  rg -q 'materialized Michelin reference did not match' "$log"
  [[ ! -e "$prefix.json" && ! -e "$prefix.trigger" ]]
  assert_restored_contract materialized-source-mismatch
}

run_interrupt_recovery_case() {
  local prefix="$TEMPORARY_DIRECTORY/interrupted" log="$TEMPORARY_DIRECTORY/interrupted.log"
  local recovery_log="$TEMPORARY_DIRECTORY/recovery.log"
  reset_case
  start_validator "$prefix" "$log" attach-insert-select-v1 no-completion
  wait_for_ready "$log" "$VALIDATOR_PID"
  [[ -d "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  kill -KILL "$VALIDATOR_PID"
  wait "$VALIDATOR_PID" 2>/dev/null || true
  [[ -d "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  zsh "$VALIDATOR_PATH" --database="$DATABASE_PATH" --recover-stale-guard > "$recovery_log" 2>&1
  rg -q '^RECOVERED_STALE_GUARD ' "$recovery_log"
  [[ ! -e "$prefix.json" && ! -e "$prefix.trigger" ]]
  assert_restored_contract interrupted-recovery
}

run_success_case attach-insert-select-v1 attach-success
run_success_case legacy-js-v1 legacy-success
run_attestation_mismatch_case
run_same_count_semantic_corruption_case
run_materialized_source_mismatch_case
run_interrupt_recovery_case

if find "$TEMPORARY_DIRECTORY" -type f \
  \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.db-journal' \) \
  ! -path "$DATABASE_PATH" ! -path "$DATABASE_PATH-wal" ! -path "$DATABASE_PATH-shm" \
  ! -path "$DATABASE_PATH-journal" ! -path "$FAKE_APP_PATH/assets/assets/michelin.db" \
  -print -quit | rg -q .; then
  print -u2 "Harness left an unexpected raw private database artifact"
  exit 1
fi

print "macOS Michelin import harness passed: both strategies, exact runtime attestation, independent full-row semantic parity, same-count corruption and materialized-source mismatch rejection, aggregate-only privacy, SIGKILL recovery, raw cleanup, and byte/mode-exact main/WAL/SHM/journal restoration."

#!/bin/zsh
set -euo pipefail
umask 077

ROOT_DIRECTORY="${0:A:h:h}"
VALIDATOR_PATH="$ROOT_DIRECTORY/scripts/validate-macos-michelin-suggestion-index.sh"
FAKE_HELPER_TEMPLATE="$ROOT_DIRECTORY/scripts/fixtures/michelin-suggestion-index-harness/fake-macos-command.sh"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-michelin-suggestion-harness.XXXXXX")"
FAKE_HELPER_PATH="$TEMPORARY_DIRECTORY/fake-macos-command.sh"
FAKE_BIN_DIRECTORY="$TEMPORARY_DIRECTORY/bin"
FAKE_STATE_DIRECTORY="$TEMPORARY_DIRECTORY/state"
FAKE_APP_PATH="$TEMPORARY_DIRECTORY/Palate.app"
MISMATCH_APP_PATH="$TEMPORARY_DIRECTORY/mismatch/Palate.app"
DATABASE_PATH="$TEMPORARY_DIRECTORY/photo_foodie.db"
NODE_BINARY="$(command -v node)"

cleanup() {
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    kill -TERM "$(< "$FAKE_STATE_DIRECTORY/pid")" 2>/dev/null || true
  fi
  if [[ "${PALATE_MICHELIN_SUGGESTION_HARNESS_TEST_KEEP_TEMP:-0}" == "1" ]]; then
    print -u2 "Retained harness directory: $TEMPORARY_DIRECTORY"
  else
    rm -rf -- "$TEMPORARY_DIRECTORY"
  fi
}
trap cleanup EXIT

for dependency in awk jq md5 rg shasum sqlite3 stat zsh "$NODE_BINARY"; do
  command -v "$dependency" >/dev/null 2>&1 || {
    print -u2 "Missing test dependency: $dependency"
    exit 2
  }
done

mkdir -p "$FAKE_BIN_DIRECTORY" "$FAKE_STATE_DIRECTORY/environment" \
  "$FAKE_APP_PATH/assets/assets" "$MISMATCH_APP_PATH/assets/assets"
cp "$FAKE_HELPER_TEMPLATE" "$FAKE_HELPER_PATH"
chmod 700 "$FAKE_HELPER_PATH"
for command_name in codesign launchctl lsof open pgrep pkill ps; do
  ln -s "$FAKE_HELPER_PATH" "$FAKE_BIN_DIRECTORY/$command_name"
done
ln -s /usr/bin/true "$FAKE_APP_PATH/Palate"
print -r -- "fixture-release-main-bundle" > "$FAKE_APP_PATH/main.jsbundle"
ln -s /usr/bin/false "$MISMATCH_APP_PATH/Palate"
print -r -- "mismatched-main-bundle" > "$MISMATCH_APP_PATH/main.jsbundle"

sqlite3 "$FAKE_APP_PATH/assets/assets/michelin.db" >/dev/null <<'SQL'
PRAGMA journal_mode = DELETE;
CREATE TABLE restaurants (
  id INTEGER PRIMARY KEY,
  latitude TEXT,
  longitude TEXT
);
INSERT INTO restaurants VALUES (1, '0', '0.0001');
INSERT INTO restaurants VALUES (2, '0', '0.0010');
INSERT INTO restaurants VALUES (3, '1', '1');
SQL
cp "$FAKE_APP_PATH/assets/assets/michelin.db" "$MISMATCH_APP_PATH/assets/assets/michelin.db"
GUIDE_VERSION="$(md5 -q "$FAKE_APP_PATH/assets/assets/michelin.db")"
print -r -- "$GUIDE_VERSION" >> "$FAKE_APP_PATH/main.jsbundle"

export PATH="$FAKE_BIN_DIRECTORY:$PATH"
export PALATE_NODE_BINARY="$NODE_BINARY"
export PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_STATE="$FAKE_STATE_DIRECTORY"
export PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_HELPER="$FAKE_HELPER_PATH"
export PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_APP="$FAKE_APP_PATH"
export PALATE_MICHELIN_SUGGESTION_HARNESS_ALLOW_DIRECT_OPEN=1
export PALATE_MICHELIN_SUGGESTION_HARNESS_TEST_SKIP_DURABILITY_SYNC=1

typeset -A ORIGINAL_PRESENT ORIGINAL_HASH ORIGINAL_MODE
ORIGINAL_ENVIRONMENT_WAS_SET=0
ORIGINAL_ENVIRONMENT_VALUE=""

create_database_fixture() {
  rm -f -- "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm" "$DATABASE_PATH-journal"
  sqlite3 "$DATABASE_PATH" >/dev/null <<SQL
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
  restaurantId TEXT,
  suggestedRestaurantId TEXT,
  status TEXT NOT NULL,
  startTime INTEGER NOT NULL,
  endTime INTEGER NOT NULL,
  centerLat REAL NOT NULL,
  centerLon REAL NOT NULL,
  photoCount INTEGER NOT NULL DEFAULT 0,
  foodProbable INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
);
CREATE TABLE visit_suggested_restaurants (
  visitId TEXT NOT NULL,
  restaurantId TEXT NOT NULL,
  distance REAL NOT NULL,
  PRIMARY KEY (visitId, restaurantId),
  FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE,
  FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
);
INSERT INTO app_metadata VALUES ('michelin_dataset_version', '$GUIDE_VERSION');
INSERT INTO app_metadata VALUES ('michelin_suggestion_version', '$GUIDE_VERSION:geodesic-v1-r100-r200-l5');
INSERT INTO michelin_restaurants
  (id, name, latitude, longitude, datasetVersion)
VALUES
  ('michelin-1', 'active-one-private', 0, 0.0001, '$GUIDE_VERSION'),
  ('michelin-2', 'active-two-private', 0, 0.0010, '$GUIDE_VERSION'),
  ('michelin-3', 'active-three-private', 1, 1, '$GUIDE_VERSION'),
  ('michelin-stale', 'stale-private', 0, 0, 'historical-private-version');
INSERT INTO visits
  (id, suggestedRestaurantId, status, startTime, endTime, centerLat, centerLon)
VALUES
  ('pending-private-a', 'michelin-stale', 'pending', 1, 2, 0, 0),
  ('pending-private-b', NULL, 'pending', 3, 4, 1, 1),
  ('confirmed-private', 'michelin-stale', 'confirmed', 5, 6, 40, -120);
INSERT INTO visit_suggested_restaurants VALUES ('pending-private-a', 'michelin-stale', 0);
INSERT INTO visit_suggested_restaurants VALUES ('confirmed-private', 'michelin-stale', 12.5);
SQL
  chmod 640 "$DATABASE_PATH"
  : > "$DATABASE_PATH-wal"
  : > "$DATABASE_PATH-shm"
  : > "$DATABASE_PATH-journal"
  chmod 600 "$DATABASE_PATH-wal" "$DATABASE_PATH-journal"
  chmod 644 "$DATABASE_PATH-shm"
}

set_original_environment() {
  local state="$1"
  case "$state" in
    absent)
      launchctl unsetenv PALATE_MICHELIN_SUGGESTION_VALIDATION_RUN_ID
      ORIGINAL_ENVIRONMENT_WAS_SET=0
      ORIGINAL_ENVIRONMENT_VALUE=""
      ;;
    empty)
      launchctl setenv PALATE_MICHELIN_SUGGESTION_VALIDATION_RUN_ID ""
      ORIGINAL_ENVIRONMENT_WAS_SET=1
      ORIGINAL_ENVIRONMENT_VALUE=""
      ;;
    value)
      launchctl setenv PALATE_MICHELIN_SUGGESTION_VALIDATION_RUN_ID "preexisting-private-value"
      ORIGINAL_ENVIRONMENT_WAS_SET=1
      ORIGINAL_ENVIRONMENT_VALUE="preexisting-private-value"
      ;;
    *) return 2 ;;
  esac
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
  local label="$1" suffix component_path key environment_path
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
  environment_path="$FAKE_STATE_DIRECTORY/environment/PALATE_MICHELIN_SUGGESTION_VALIDATION_RUN_ID"
  if (( ORIGINAL_ENVIRONMENT_WAS_SET )); then
    [[ -f "$environment_path" ]]
    assert_equal "$(< "$environment_path")" "$ORIGINAL_ENVIRONMENT_VALUE" "$label environment"
  elif [[ -e "$environment_path" ]]; then
    print -u2 "$label unexpectedly set validation environment"
    return 1
  fi
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  if find "${DATABASE_PATH:h}" -maxdepth 1 -type f \
    \( -name "${DATABASE_PATH:t}.install-*.tmp" -o -name "${DATABASE_PATH:t}.restore-*.tmp" \) \
    -print -quit | rg -q .; then
    print -u2 "$label left a raw install/restore temporary"
    return 1
  fi
  [[ ! -f "$FAKE_STATE_DIRECTORY/pid" ]]
}

reset_case() {
  local environment_state="$1"
  pkill -TERM -x Palate 2>/dev/null || true
  rm -f -- "$FAKE_STATE_DIRECTORY/pid" "$FAKE_STATE_DIRECTORY/simulator.log"
  rm -rf -- \
    "$DATABASE_PATH.palate-calendar-validation.guard" \
    "$DATABASE_PATH.palate-calendar-validation.guard".stage-*(N)
  create_database_fixture
  set_original_environment "$environment_state"
  capture_database_contract
}

wait_for_ready() {
  local log_path="$1" process_pid="$2"
  for _ in {1..1000}; do
    rg -q '^READY ' "$log_path" 2>/dev/null && return 0
    kill -0 "$process_pid" 2>/dev/null || {
      print -u2 "Validator exited before READY"
      sed -n '1,240p' "$log_path" >&2
      return 1
    }
    sleep 0.01
  done
  print -u2 "Timed out waiting for READY"
  sed -n '1,240p' "$log_path" >&2
  return 1
}

record_trigger() {
  local trigger_path="$1"
  print -r -- "$(date +%s.%N)" > "$trigger_path.tmp"
  mv -f -- "$trigger_path.tmp" "$trigger_path"
}

start_validator() {
  local prefix="$1" log_path="$2" mode="$3"
  PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_MODE="$mode" \
    zsh "$VALIDATOR_PATH" \
      --app="$FAKE_APP_PATH" \
      --database="$DATABASE_PATH" \
      --output-prefix="$prefix" \
      --timeout-seconds=10 > "$log_path" 2>&1 &
  VALIDATOR_PID=$!
}

run_success_case() {
  local prefix="$TEMPORARY_DIRECTORY/success" log="$TEMPORARY_DIRECTORY/success.log"
  reset_case empty
  start_validator "$prefix" "$log" success
  wait_for_ready "$log" "$VALIDATOR_PID"
  record_trigger "$prefix.trigger"
  if ! wait "$VALIDATOR_PID"; then
    sed -n '1,280p' "$log" >&2
    return 1
  fi
  [[ -f "$prefix.json" && ! -L "$prefix.json" ]]
  assert_equal "$(stat -f '%Lp' "$prefix.json")" 600 "success report mode"
  jq -e '
    .schemaVersion == 1 and .status == "ok"
    and .signedBuild.appBundleName == "Palate.app"
    and (.signedBuild | has("appPath") | not)
    and .signedBuild.strictCodeSignatureVerified
    and .signedBuild.runningBundleMatched
    and .signedBuild.processEnvironmentRunIdMatched
    and .sourceGuard.capturedBeforeSQLiteAccess
    and .sourceGuard.sharedMutationLock
    and .sourceGuard.durableStaleRecovery
    and .fixture.suggestionVersionRemoved
    and .fixture.pendingSuggestionsCleared
    and .result.status == "ok"
    and .result.correctness.exactActiveGuideProjection
    and .result.correctness.exactStaleGuidePreservation
    and .result.correctness.exactPendingPrimarySuggestions
    and .result.correctness.exactOrderedPendingSuggestionsAndDistanceBits
    and .result.correctness.noStaleGuideSuggestionMatches
    and .result.integrityCheck == "ok"
    and .result.foreignKeyViolationCount == 0
    and .restoration.exactMainWalShmJournalBytesAndModes
    and .restoration.exactLaunchEnvironmentState
    and .restoration.rawPrivateArtifactsDeleted
    and .restoration.aggregateOnlyReport
  ' "$prefix.json" >/dev/null
  if rg -q 'pending-private|confirmed-private|active-one-private|stale-private' "$prefix.json"; then
    print -u2 "Aggregate report leaked fixture identifiers"
    return 1
  fi
  local private_path
  for private_path in "$FAKE_APP_PATH" "$DATABASE_PATH" "$prefix" "$TEMPORARY_DIRECTORY"; do
    if rg -F -q -- "$private_path" "$prefix.json"; then
      print -u2 "Aggregate report leaked a supplied private path"
      return 1
    fi
  done
  [[ ! -e "$prefix.trigger" ]]
  assert_restored_contract success
}

run_parity_failure_case() {
  local prefix="$TEMPORARY_DIRECTORY/parity-failure" log="$TEMPORARY_DIRECTORY/parity-failure.log"
  reset_case absent
  start_validator "$prefix" "$log" parity-failure
  wait_for_ready "$log" "$VALIDATOR_PID"
  record_trigger "$prefix.trigger"
  if wait "$VALIDATOR_PID"; then
    print -u2 "Parity-failure case unexpectedly succeeded"
    return 1
  fi
  rg -q 'did not match the independent oracle' "$log"
  [[ ! -e "$prefix.json" && ! -e "$prefix.trigger" ]]
  assert_restored_contract parity-failure
}

run_build_mismatch_case() {
  local prefix="$TEMPORARY_DIRECTORY/build-mismatch" log="$TEMPORARY_DIRECTORY/build-mismatch.log"
  reset_case value
  PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_RUNNING_APP="$MISMATCH_APP_PATH" \
    start_validator "$prefix" "$log" success
  if wait "$VALIDATOR_PID"; then
    print -u2 "Build-mismatch case unexpectedly succeeded"
    return 1
  fi
  rg -q 'does not match the attested signed Release app/build/guide' "$log"
  [[ ! -e "$prefix.json" ]]
  assert_restored_contract build-mismatch
}

run_nonempty_sidecar_case() {
  local prefix="$TEMPORARY_DIRECTORY/nonempty-sidecar" log="$TEMPORARY_DIRECTORY/nonempty-sidecar.log"
  reset_case absent
  print -rn -- "uncheckpointed-private-wal" > "$DATABASE_PATH-wal"
  chmod 604 "$DATABASE_PATH-wal"
  capture_database_contract
  if PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_MODE=success \
    zsh "$VALIDATOR_PATH" --app="$FAKE_APP_PATH" --database="$DATABASE_PATH" \
      --output-prefix="$prefix" --timeout-seconds=10 > "$log" 2>&1; then
    print -u2 "Nonempty-sidecar case unexpectedly succeeded"
    return 1
  fi
  rg -q 'nonempty WAL' "$log"
  [[ ! -e "$prefix.json" ]]
  assert_restored_contract nonempty-sidecar
}

run_interrupt_recovery_case() {
  local prefix="$TEMPORARY_DIRECTORY/interrupted" log="$TEMPORARY_DIRECTORY/interrupted.log"
  local recovery_log="$TEMPORARY_DIRECTORY/recovery.log"
  reset_case value
  start_validator "$prefix" "$log" no-completion
  wait_for_ready "$log" "$VALIDATOR_PID"
  [[ -d "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  kill -KILL "$VALIDATOR_PID"
  wait "$VALIDATOR_PID" 2>/dev/null || true
  [[ -d "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  zsh "$VALIDATOR_PATH" --database="$DATABASE_PATH" --recover-stale-guard > "$recovery_log" 2>&1
  rg -q '^RECOVERED_STALE_GUARD ' "$recovery_log"
  [[ ! -e "$prefix.json" ]]
  assert_restored_contract interrupted-recovery
}

run_success_case
run_parity_failure_case
run_build_mismatch_case
run_nonempty_sidecar_case
run_interrupt_recovery_case

if find "$TEMPORARY_DIRECTORY" -maxdepth 1 -type f \
  \( -name '*.original.db' -o -name '*.prepared.db' -o -name '*.result.db' -o -name 'oracle.json' \) \
  -print -quit | rg -q .; then
  print -u2 "Harness left a raw private database/oracle artifact"
  exit 1
fi

print "macOS Michelin suggestion-index harness passed: success, bit-parity failure, signed-build mismatch, nonempty sidecar rejection, SIGKILL recovery, aggregate-only reporting, raw cleanup, and exact main/WAL/SHM/journal/environment restoration."

#!/bin/zsh
set -euo pipefail

ROOT_DIRECTORY="${0:A:h:h}"
HARNESS_PATH="$ROOT_DIRECTORY/scripts/validate-macos-visit-merge.sh"
FIXTURE_HELPER_PATH="$ROOT_DIRECTORY/scripts/macos-visit-merge-fixture.mjs"
FAKE_HELPER_PATH="$ROOT_DIRECTORY/scripts/fixtures/visit-merge-harness/fake-macos-command.sh"
NODE_BINARY="${PALATE_NODE_BINARY:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-visit-merge-harness.XXXXXX")"
FAKE_BIN_DIRECTORY="$TEMPORARY_DIRECTORY/bin"
FAKE_STATE_DIRECTORY="$TEMPORARY_DIRECTORY/state"
FAKE_APP_PATH="$TEMPORARY_DIRECTORY/Palate.app"
WRONG_APP_PATH="$TEMPORARY_DIRECTORY/Wrong/Palate.app"
DATABASE_PATH="$TEMPORARY_DIRECTORY/photo_foodie.db"

cleanup() {
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    simulator_pid="$(< "$FAKE_STATE_DIRECTORY/pid")"
    kill -TERM "$simulator_pid" 2>/dev/null || true
  fi
  if [[ "${PALATE_KEEP_VISIT_MERGE_HARNESS_TEMP:-0}" == "1" ]]; then
    print -u2 "Retained visit-merge harness temporary directory: $TEMPORARY_DIRECTORY"
  else
    rm -rf -- "$TEMPORARY_DIRECTORY"
  fi
}
trap cleanup EXIT

for dependency in jq rg shasum sqlite3 zsh; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    print -u2 "Missing dependency: $dependency"
    exit 2
  fi
done
if [[ ! -x "$NODE_BINARY" ]]; then
  print -u2 "Node executable is missing: $NODE_BINARY"
  exit 2
fi

mkdir -p "$FAKE_BIN_DIRECTORY" "$FAKE_STATE_DIRECTORY/environment" "$FAKE_APP_PATH" "$WRONG_APP_PATH"
for command_name in codesign launchctl lsof open pgrep pkill ps; do
  ln -s "$FAKE_HELPER_PATH" "$FAKE_BIN_DIRECTORY/$command_name"
done
ln -s /usr/bin/true "$FAKE_APP_PATH/Palate"
ln -s /usr/bin/true "$FAKE_APP_PATH/main.jsbundle"
ln -s /usr/bin/false "$WRONG_APP_PATH/Palate"
print -r -- "wrong-bundle" > "$WRONG_APP_PATH/main.jsbundle"

export PALATE_VISIT_MERGE_HARNESS_FAKE_STATE="$FAKE_STATE_DIRECTORY"
export PALATE_VISIT_MERGE_HARNESS_FAKE_HELPER="$FAKE_HELPER_PATH"
export PALATE_VISIT_MERGE_HARNESS_FIXTURE_HELPER="$FIXTURE_HELPER_PATH"
export PALATE_VISIT_MERGE_HARNESS_NODE="$NODE_BINARY"
export PATH="$FAKE_BIN_DIRECTORY:$PATH"

sqlite3 "$DATABASE_PATH" <<'SQL'
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE michelin_restaurants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL NOT NULL,
  longitude REAL NOT NULL, address TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', cuisine TEXT NOT NULL DEFAULT '',
  latestAwardYear INTEGER, award TEXT NOT NULL DEFAULT '', datasetVersion TEXT
);
CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE restaurants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL NOT NULL,
  longitude REAL NOT NULL, address TEXT, phone TEXT, website TEXT,
  googlePlaceId TEXT, cuisine TEXT, priceLevel INTEGER, rating REAL, notes TEXT
);
CREATE TABLE visits (
  id TEXT PRIMARY KEY, restaurantId TEXT, suggestedRestaurantId TEXT,
  status TEXT NOT NULL DEFAULT 'pending', startTime INTEGER NOT NULL,
  endTime INTEGER NOT NULL, centerLat REAL NOT NULL, centerLon REAL NOT NULL,
  photoCount INTEGER NOT NULL DEFAULT 0, foodProbable INTEGER NOT NULL DEFAULT 0,
  calendarEventId TEXT, calendarEventTitle TEXT, calendarEventLocation TEXT,
  calendarEventIsAllDay INTEGER, notes TEXT, updatedAt INTEGER,
  exportedToCalendarId TEXT, awardAtVisit TEXT,
  FOREIGN KEY (restaurantId) REFERENCES restaurants(id),
  FOREIGN KEY (suggestedRestaurantId) REFERENCES michelin_restaurants(id)
);
CREATE TABLE visit_suggested_restaurants (
  visitId TEXT NOT NULL, restaurantId TEXT NOT NULL, distance REAL NOT NULL,
  PRIMARY KEY (visitId, restaurantId),
  FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE,
  FOREIGN KEY (restaurantId) REFERENCES michelin_restaurants(id)
);
CREATE TABLE photos (
  id TEXT PRIMARY KEY, uri TEXT NOT NULL, creationTime INTEGER NOT NULL,
  latitude REAL, longitude REAL, visitId TEXT, foodDetected INTEGER,
  foodLabels TEXT, foodConfidence REAL, allLabels TEXT,
  mediaType TEXT DEFAULT 'photo', duration REAL,
  FOREIGN KEY (visitId) REFERENCES visits(id)
);
CREATE TABLE reservation_import_sources (
  sourceEventId TEXT PRIMARY KEY, source TEXT NOT NULL, visitId TEXT NOT NULL,
  importedAt INTEGER NOT NULL,
  FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE
);
CREATE TABLE dismissed_reservation_import_sources (sourceEventId TEXT PRIMARY KEY, dismissedAt INTEGER NOT NULL);
CREATE TABLE reservation_import_review_exclusions (
  fingerprint TEXT PRIMARY KEY, source TEXT NOT NULL, restaurantName TEXT NOT NULL,
  visitDate TEXT NOT NULL, action TEXT NOT NULL, excludedAt INTEGER NOT NULL
);
CREATE TABLE dismissed_calendar_events (calendarEventId TEXT PRIMARY KEY, dismissedAt INTEGER NOT NULL);
CREATE TABLE food_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1, isBuiltIn INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE TABLE ignored_locations (
  id TEXT PRIMARY KEY, latitude REAL NOT NULL, longitude REAL NOT NULL,
  radius REAL NOT NULL DEFAULT 100, name TEXT, createdAt INTEGER NOT NULL
);

WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 100)
INSERT INTO michelin_restaurants (id, name, latitude, longitude, address, location, cuisine, award)
SELECT printf('michelin-%03d', value), printf('Restaurant %03d', value),
       30 + value / 1000.0, -120 - value / 1000.0,
       printf('%d Test Street', value), 'Test', 'Fixture', 'Selected'
FROM sequence;

WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 200)
INSERT INTO visits (
  id, suggestedRestaurantId, status, startTime, endTime, centerLat, centerLon,
  photoCount, foodProbable, calendarEventId, calendarEventTitle,
  calendarEventLocation, calendarEventIsAllDay, notes, updatedAt,
  exportedToCalendarId, awardAtVisit
)
SELECT printf('visit-%03d', value),
       CASE WHEN value % 3 = 0 THEN printf('michelin-%03d', (value % 100) + 1) END,
       'pending', 1600000000000 + value * 86400000,
       1600000000000 + value * 86400000 + (value % 8) * 600000,
       35 + value / 10000.0, -118 - value / 10000.0,
       (value % 9) + 1, CASE WHEN value % 7 = 0 THEN 1 ELSE 0 END,
       CASE WHEN value % 4 = 0 THEN printf('event-%03d', value) END,
       CASE WHEN value % 4 = 0 THEN printf('Calendar %03d', value) END,
       CASE WHEN value % 4 = 0 THEN 'Fixture location' END,
       CASE WHEN value % 4 = 0 THEN 0 END,
       printf('note-%03d', value), value,
       CASE WHEN value % 11 = 0 THEN printf('export-%03d', value) END,
       CASE WHEN value % 5 = 0 THEN 'Bib Gourmand' END
FROM sequence;

WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 400)
INSERT INTO photos (
  id, uri, creationTime, latitude, longitude, visitId, foodDetected,
  foodLabels, foodConfidence, allLabels, mediaType, duration
)
SELECT printf('photo-%03d', value), printf('asset://fixture/%03d', value),
       1600000000000 + value * 1000, 35 + value / 10000.0, -118 - value / 10000.0,
       printf('visit-%03d', ((value - 1) % 200) + 1),
       CASE WHEN value % 5 = 0 THEN 1 ELSE 0 END,
       CASE WHEN value % 5 = 0 THEN '[{"label":"food","confidence":0.9}]' ELSE '[]' END,
       CASE WHEN value % 5 = 0 THEN 0.9 ELSE 0.1 END,
       '[{"label":"fixture","confidence":0.8}]', 'photo', NULL
FROM sequence;

INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance)
SELECT id, printf('michelin-%03d', (CAST(substr(id, 7) AS INTEGER) % 100) + 1),
       CAST(substr(id, 7) AS INTEGER) / 10.0
FROM visits;
INSERT INTO app_metadata VALUES ('fixture-version', '1');
INSERT INTO food_keywords (keyword, enabled, isBuiltIn, createdAt) VALUES ('fixture', 1, 0, 1);
SQL
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
rm -f -- "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
ORIGINAL_DATABASE_SHA256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"

launchctl setenv PALATE_VISIT_MERGE_VALIDATION_RUN_ID "preexisting-visit-merge-run"

assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    print -u2 "$label: expected '$expected', found '$actual'"
    return 1
  fi
}

assert_restored_contract() {
  local label="$1"
  assert_equal \
    "$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')" \
    "$ORIGINAL_DATABASE_SHA256" \
    "$label database hash"
  assert_equal \
    "$(launchctl getenv PALATE_VISIT_MERGE_VALIDATION_RUN_ID)" \
    "preexisting-visit-merge-run" \
    "$label launch environment"
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    print -u2 "$label left the fake Palate process registered"
    return 1
  fi
  assert_equal "$(sqlite3 "$DATABASE_PATH" 'PRAGMA quick_check;')" "ok" "$label quick check"
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" 'SELECT COUNT(*) FROM pragma_foreign_key_check;')" \
    "0" \
    "$label foreign key check"
}

assert_no_sensitive_intermediates() {
  local output_prefix="$1"
  local label="$2"
  local -a sensitive_paths
  sensitive_paths=(
    "$output_prefix".*.original.db(N)
    "$output_prefix".*.prepared.db(N)
    "$output_prefix".*.reference.db(N)
    "$output_prefix.fixture.json"(N)
  )
  if (( ${#sensitive_paths} != 0 )); then
    print -u2 "$label retained unexpected sensitive intermediates: ${sensitive_paths[*]}"
    return 1
  fi
}

wait_for_ready() {
  local log_path="$1"
  local harness_pid="$2"
  for _ in {1..1200}; do
    if rg -q '^READY ' "$log_path" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$harness_pid" 2>/dev/null; then
      print -u2 "Harness exited before READY"
      sed -n '1,240p' "$log_path" >&2
      return 1
    fi
    sleep 0.01
  done
  print -u2 "Timed out waiting for READY"
  sed -n '1,240p' "$log_path" >&2
  return 1
}

wait_for_exit() {
  local harness_pid="$1"
  for _ in {1..1200}; do
    if ! kill -0 "$harness_pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.01
  done
  print -u2 "Timed out waiting for harness rejection"
  return 1
}

record_trigger() {
  local trigger_path="$1"
  print -r -- "$(date +%s.%N)" > "$trigger_path.tmp"
  mv -f -- "$trigger_path.tmp" "$trigger_path"
}

run_case() {
  local case_name="$1"
  local mode="$2"
  local expected_exit_status="$3"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status
  mkdir -p "$output_directory"

  export PALATE_VISIT_MERGE_HARNESS_FAKE_MODE="$mode"
  export PALATE_VISIT_MERGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISIT_MERGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  export PALATE_VISIT_MERGE_HARNESS_FAKE_MANIFEST="$output_prefix.fixture.json"
  if [[ "$mode" == "wrong-app" ]]; then
    export PALATE_VISIT_MERGE_HARNESS_FAKE_PROCESS_APP="$WRONG_APP_PATH"
  else
    export PALATE_VISIT_MERGE_HARNESS_FAKE_PROCESS_APP="$FAKE_APP_PATH"
  fi

  typeset -a shell_arguments
  shell_arguments=()
  [[ "${PALATE_TRACE_VISIT_MERGE_HARNESS:-0}" == "1" ]] && shell_arguments+=(-x)
  zsh "${shell_arguments[@]}" "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --output-prefix="$output_prefix" \
    --node="$NODE_BINARY" \
    --timeout-seconds=5 \
    --sample-interval=0.01 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  if [[ "$mode" == "wrong-app" ]]; then
    wait_for_exit "$harness_pid"
    set +e
    wait "$harness_pid"
    exit_status="$?"
    set -e
    assert_equal "$exit_status" "$expected_exit_status" "$case_name exit status"
    if ! rg -q 'launched Palate bytes do not match|unattested Palate build' "$log_path"; then
      print -u2 "$case_name did not report the process-bundle mismatch"
      sed -n '1,240p' "$log_path" >&2
      return 1
    fi
    assert_restored_contract "$case_name"
    assert_no_sensitive_intermediates "$output_prefix" "$case_name"
    return 0
  fi
  wait_for_ready "$log_path" "$harness_pid"

  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" \
      "SELECT COUNT(*) FROM visits WHERE restaurantId LIKE '__palate_merge_validation_restaurant_%';")" \
    "185" \
    "$case_name prepared fixture count"
  if [[ "$mode" == "hold" ]]; then
    kill -TERM "$harness_pid"
  else
    record_trigger "$output_prefix.trigger"
  fi

  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  assert_equal "$exit_status" "$expected_exit_status" "$case_name exit status"
  assert_restored_contract "$case_name"

  case "$case_name" in
    success)
      jq -e \
        '.status == "ok"
         and .fixture.groups == 37
         and .fixture.visitsPerGroup == 5
         and .fixture.mergeCount == 148
         and .structuralCalls.legacyMergeExecution == 1628
         and .structuralCalls.candidateFullPath == 10
         and .app.suppliedBundleBytesMatched
         and .app.executableSha256 == .app.runningExecutableSha256
         and .app.mainJsBundleSha256 == .app.runningMainJsBundleSha256
         and .validation.parity.visits.mismatchCount == 0
         and .validation.parity.photos.mismatchCount == 0
         and .validation.parity.visitSuggestedRestaurants.mismatchCount == 0
         and .validation.parity.reservationImportSources.mismatchCount == 0
         and .database.restoredByteIdentical
         and (.artifacts.sensitive.cleanupPolicy | contains("removed after byte-identical restoration"))' \
        "$output_prefix.json" >/dev/null
      assert_no_sensitive_intermediates "$output_prefix" "success"
      assert_equal \
        "$(sqlite3 "$output_prefix.result.db" 'SELECT COUNT(*) FROM visits;')" \
        "52" \
        "success result visit count"
      ;;
    parity-failure)
      jq -e \
        '.status == "failed"
         and .validation.parity.photos.mismatchCount == 1
         and (.validation.failureReasons | length) > 0
         and .database.restoredByteIdentical' \
        "$output_prefix.json" >/dev/null
      if [[ ! -f "$output_prefix.fixture.json" ]]; then
        print -u2 "parity-failure did not retain its diagnostic fixture manifest"
        return 1
      fi
      ;;
    signal)
      assert_no_sensitive_intermediates "$output_prefix" "signal"
      ;;
  esac
}

run_case success success 0
run_case parity-failure parity-failure 1
run_case signal hold 143
run_case wrong-app wrong-app 1

print "macOS visit-merge harness contract tests passed: success, process-byte rejection, retained semantic failure, signal cleanup, and byte-identical restoration."

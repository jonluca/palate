#!/bin/zsh
set -euo pipefail

ROOT_DIRECTORY="${0:A:h:h}"
HARNESS_PATH="$ROOT_DIRECTORY/scripts/validate-macos-wrapped-stats.sh"
FIXTURE_HELPER_PATH="$ROOT_DIRECTORY/scripts/macos-wrapped-stats-fixture.mjs"
FAKE_HELPER_PATH="$ROOT_DIRECTORY/scripts/fixtures/wrapped-stats-harness/fake-macos-command.sh"
NODE_BINARY="${PALATE_NODE_BINARY:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-wrapped-stats-harness.XXXXXX")"
FAKE_BIN_DIRECTORY="$TEMPORARY_DIRECTORY/bin"
FAKE_STATE_DIRECTORY="$TEMPORARY_DIRECTORY/state"
MATCH_APP_PATH="$TEMPORARY_DIRECTORY/Palate.app"
MISMATCH_APP_PATH="$TEMPORARY_DIRECTORY/mismatch-bundle/Palate.app"
DATABASE_PATH="$TEMPORARY_DIRECTORY/photo_foodie.db"

cleanup() {
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    simulator_pid="$(< "$FAKE_STATE_DIRECTORY/pid")"
    kill -TERM "$simulator_pid" 2>/dev/null || true
  fi
  if [[ "${PALATE_KEEP_WRAPPED_STATS_HARNESS_TEMP:-0}" == "1" ]]; then
    print -u2 "Retained Wrapped Stats harness temporary directory: $TEMPORARY_DIRECTORY"
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

mkdir -p \
  "$FAKE_BIN_DIRECTORY" "$FAKE_STATE_DIRECTORY/environment" \
  "$MATCH_APP_PATH" "$MISMATCH_APP_PATH"
for command_name in codesign launchctl lsof open pgrep pkill ps; do
  ln -s "$FAKE_HELPER_PATH" "$FAKE_BIN_DIRECTORY/$command_name"
done
ln -s /usr/bin/true "$MATCH_APP_PATH/Palate"
ln -s /usr/bin/true "$MATCH_APP_PATH/main.jsbundle"
ln -s /usr/bin/false "$MISMATCH_APP_PATH/Palate"
ln -s /usr/bin/false "$MISMATCH_APP_PATH/main.jsbundle"

export PALATE_WRAPPED_STATS_HARNESS_FAKE_STATE="$FAKE_STATE_DIRECTORY"
export PALATE_WRAPPED_STATS_HARNESS_FAKE_HELPER="$FAKE_HELPER_PATH"
export PALATE_WRAPPED_STATS_HARNESS_MATCH_APP="$MATCH_APP_PATH"
export PALATE_WRAPPED_STATS_HARNESS_MISMATCH_APP="$MISMATCH_APP_PATH"
export PALATE_WRAPPED_STATS_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
export PALATE_WRAPPED_STATS_ALLOW_DIRECT_OPEN_FOR_TESTS=1
export PATH="$FAKE_BIN_DIRECTORY:$PATH"

sqlite3 "$DATABASE_PATH" >/dev/null <<'SQL'
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE michelin_restaurants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL NOT NULL,
  longitude REAL NOT NULL, address TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', cuisine TEXT NOT NULL DEFAULT '',
  latestAwardYear INTEGER, award TEXT NOT NULL DEFAULT '', datasetVersion TEXT
);
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
CREATE TABLE photos (
  id TEXT PRIMARY KEY, uri TEXT NOT NULL, creationTime INTEGER NOT NULL,
  latitude REAL, longitude REAL, visitId TEXT, foodDetected INTEGER,
  foodLabels TEXT, foodConfidence REAL, allLabels TEXT,
  mediaType TEXT DEFAULT 'photo', duration REAL,
  FOREIGN KEY (visitId) REFERENCES visits(id)
);
CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE food_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT UNIQUE NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  isBuiltIn INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);

INSERT INTO michelin_restaurants (
  id, name, latitude, longitude, address, location, cuisine,
  latestAwardYear, award, datasetVersion
) VALUES (
  'michelin-1', 'ES:SENZ', 47.7856302, 12.4656176,
  'Mietenkamer Straße 65, Grassau, 83224, Germany', 'Grassau, Germany',
  'Creative, Modern Cuisine', 2025, '3 Stars', 'fixture'
);

WITH RECURSIVE years(year) AS (
  SELECT 2012 UNION ALL SELECT year + 1 FROM years WHERE year < 2026
)
INSERT INTO visits (
  id, suggestedRestaurantId, status, startTime, endTime, centerLat, centerLon,
  photoCount, foodProbable, calendarEventId, calendarEventTitle,
  calendarEventLocation, calendarEventIsAllDay, notes, updatedAt
)
SELECT
  printf('visit-%04d', year),
  CASE WHEN year % 3 = 0 THEN 'michelin-1' END,
  'pending',
  CAST(strftime('%s', printf('%04d-06-15 12:00:00', year)) AS INTEGER) * 1000,
  CAST(strftime('%s', printf('%04d-06-15 13:00:00', year)) AS INTEGER) * 1000,
  35.0 + (year - 2012) / 100.0,
  -118.0 - (year - 2012) / 100.0,
  year - 2010,
  CASE WHEN year % 2 = 0 THEN 1 ELSE 0 END,
  CASE WHEN year >= 2016 THEN printf('event-%04d', year) END,
  CASE WHEN year >= 2016 THEN printf('Dinner %04d', year) END,
  CASE WHEN year >= 2016 THEN 'Fixture location' END,
  CASE WHEN year >= 2016 THEN 0 END,
  printf('fixture-%04d', year),
  year
FROM years;

WITH RECURSIVE
years(year) AS (
  SELECT 2012 UNION ALL SELECT year + 1 FROM years WHERE year < 2026
),
numbers(value) AS (
  SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 16
)
INSERT INTO photos (
  id, uri, creationTime, latitude, longitude, visitId,
  foodDetected, foodLabels, foodConfidence, allLabels, mediaType
)
SELECT
  printf('photo-%04d-%02d', year, value),
  printf('asset://fixture/%04d/%02d', year, value),
  CAST(strftime('%s', printf('%04d-06-15 12:00:00', year)) AS INTEGER) * 1000 + value,
  35.0, -118.0, printf('visit-%04d', year),
  CASE WHEN value = 1 THEN 1 ELSE 0 END,
  CASE WHEN value = 1 THEN '[{"label":"food","confidence":0.9}]' ELSE '[]' END,
  CASE WHEN value = 1 THEN 0.9 ELSE 0.1 END,
  '[]', 'photo'
FROM years CROSS JOIN numbers
WHERE value <= year - 2010;

INSERT INTO app_metadata VALUES ('fixture-version', '1');
INSERT INTO food_keywords (keyword, enabled, isBuiltIn, createdAt)
VALUES ('fixture keyword', 1, 1, 1);
SQL
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
rm -f -- "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
ORIGINAL_DATABASE_SHA256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"

launchctl setenv PALATE_WRAPPED_STATS_VALIDATION_RUN_ID "preexisting-wrapped-stats-run"

assert_equal() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    print -u2 "$label: expected '$expected', found '$actual'"
    return 1
  fi
}

assert_prepared_provider_spatial_contract() {
  local label="$1"
  local valid_restaurant_count indexed_restaurant_count
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" "
      SELECT COUNT(*)
      FROM sqlite_schema
      WHERE (type = 'table' AND name IN (
          'michelin_restaurant_spatial_index',
          'michelin_restaurant_spatial_index_node',
          'michelin_restaurant_spatial_index_parent',
          'michelin_restaurant_spatial_index_rowid'
        ))
        OR (type = 'trigger' AND tbl_name = 'michelin_restaurants' AND name IN (
          'michelin_provider_spatial_delete',
          'michelin_provider_spatial_insert',
          'michelin_provider_spatial_update'
        ));
    ")" \
    "7" \
    "$label provider spatial schema object count"
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" "
      SELECT COUNT(*) FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'michelin_restaurant_spatial_index'
        AND lower(sql) LIKE 'create virtual table%using rtree(%';
    ")" \
    "1" \
    "$label provider RTree virtual table count"
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" "
      SELECT COUNT(*) FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'michelin_restaurant_spatial_index_node',
        'michelin_restaurant_spatial_index_parent',
        'michelin_restaurant_spatial_index_rowid'
      );
    ")" \
    "3" \
    "$label provider RTree shadow table count"
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" "
      SELECT group_concat(name, ',')
      FROM (SELECT name FROM pragma_table_info('michelin_restaurant_spatial_index') ORDER BY cid);
    ")" \
    "restaurantRowId,minimumLatitude,maximumLatitude,minimumLongitude,maximumLongitude" \
    "$label provider RTree columns"

  valid_restaurant_count="$(sqlite3 "$DATABASE_PATH" "
    SELECT COUNT(*)
    FROM michelin_restaurants
    WHERE latitude BETWEEN -90.0 AND 90.0
      AND longitude BETWEEN -180.0 AND 180.0
      AND NOT (latitude = 0.0 AND longitude = 0.0);
  ")"
  indexed_restaurant_count="$(sqlite3 "$DATABASE_PATH" \
    "SELECT COUNT(*) FROM michelin_restaurant_spatial_index;")"
  assert_equal "$valid_restaurant_count" "1" "$label valid guide restaurant count"
  assert_equal "$indexed_restaurant_count" "$valid_restaurant_count" "$label provider RTree row parity"
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" "
      SELECT (
        SELECT COUNT(*)
        FROM michelin_restaurants m
        LEFT JOIN michelin_restaurant_spatial_index spatial
          ON spatial.restaurantRowId = m.rowid
        WHERE m.latitude BETWEEN -90.0 AND 90.0
          AND m.longitude BETWEEN -180.0 AND 180.0
          AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)
          AND (
            spatial.restaurantRowId IS NULL
            OR NOT (m.latitude BETWEEN spatial.minimumLatitude AND spatial.maximumLatitude)
            OR NOT (m.longitude BETWEEN spatial.minimumLongitude AND spatial.maximumLongitude)
            OR spatial.maximumLatitude - spatial.minimumLatitude > 0.001
            OR spatial.maximumLongitude - spatial.minimumLongitude > 0.001
          )
      ) + (
        SELECT COUNT(*)
        FROM michelin_restaurant_spatial_index spatial
        LEFT JOIN michelin_restaurants m ON m.rowid = spatial.restaurantRowId
        WHERE m.rowid IS NULL
          OR NOT (
            m.latitude BETWEEN -90.0 AND 90.0
            AND m.longitude BETWEEN -180.0 AND 180.0
            AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)
          )
      );
    ")" \
    "0" \
    "$label provider spatial health"
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" "SELECT rtreecheck('michelin_restaurant_spatial_index');")" \
    "ok" \
    "$label provider RTree integrity"
  if [[ -s "$DATABASE_PATH-wal" ]]; then
    print -u2 "$label created a non-empty WAL before the measured trigger"
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
    "$(launchctl getenv PALATE_WRAPPED_STATS_VALIDATION_RUN_ID)" \
    "preexisting-wrapped-stats-run" \
    "$label launch environment"
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    print -u2 "$label left the fake Palate process registered"
    return 1
  fi
  assert_equal "$(sqlite3 "$DATABASE_PATH" 'PRAGMA quick_check;')" "ok" "$label quick check"
  assert_equal "$(sqlite3 "$DATABASE_PATH" 'PRAGMA integrity_check;')" "ok" "$label integrity check"
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" 'SELECT COUNT(*) FROM pragma_foreign_key_check;')" \
    "0" \
    "$label foreign key check"
}

assert_no_sensitive_intermediates() {
  local output_prefix="$1" label="$2"
  local -a sensitive_paths
  sensitive_paths=(
    "$output_prefix".*.original.db(N)
    "$output_prefix".*.prepared.db(N)
    "$output_prefix.result.db"(N)
    "$output_prefix.fixture.json"(N)
    "$output_prefix.oracle.json"(N)
  )
  if (( ${#sensitive_paths} != 0 )); then
    print -u2 "$label retained unexpected sensitive intermediates: ${sensitive_paths[*]}"
    return 1
  fi
}

assert_sensitive_diagnostics_retained() {
  local output_prefix="$1" label="$2"
  local -a snapshots prepared_databases
  snapshots=("$output_prefix".*.original.db(N))
  prepared_databases=("$output_prefix".*.prepared.db(N))
  if (( ${#snapshots} != 1 || ${#prepared_databases} != 1 )) \
    || [[ ! -f "$output_prefix.result.db" || ! -f "$output_prefix.fixture.json" \
      || ! -f "$output_prefix.oracle.json" || ! -f "$output_prefix.validation.json" ]]; then
    print -u2 "$label did not retain the documented semantic-failure diagnostics"
    return 1
  fi
}

wait_for_ready() {
  local log_path="$1" harness_pid="$2"
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

record_trigger() {
  local trigger_path="$1"
  print -r -- "$(date +%s.%N)" > "$trigger_path.tmp"
  mv -f -- "$trigger_path.tmp" "$trigger_path"
}

start_harness() {
  local mode="$1" output_prefix="$2" log_path="$3"
  export PALATE_WRAPPED_STATS_HARNESS_FAKE_MODE="$mode"
  export PALATE_WRAPPED_STATS_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  export PALATE_WRAPPED_STATS_HARNESS_FAKE_VISUAL_READY="$output_prefix.visual-ready"
  typeset -a shell_arguments
  shell_arguments=()
  [[ "${PALATE_TRACE_WRAPPED_STATS_HARNESS:-0}" == "1" ]] && shell_arguments+=(-x)
  zsh "${shell_arguments[@]}" "$HARNESS_PATH" \
    --app="$MATCH_APP_PATH" \
    --database="$DATABASE_PATH" \
    --output-prefix="$output_prefix" \
    --node="$NODE_BINARY" \
    --timeout-seconds=5 \
    --sample-interval=0.01 \
    > "$log_path" 2>&1 &
  HARNESS_PID="$!"
}

await_status() {
  local harness_pid="$1" expected_status="$2" label="$3"
  local exit_status
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  assert_equal "$exit_status" "$expected_status" "$label exit status"
}

run_interactive_case() {
  local case_name="$1" mode="$2" expected_status="$3"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  mkdir -p "$output_directory"
  start_harness "$mode" "$output_prefix" "$log_path"
  local harness_pid="$HARNESS_PID"
  wait_for_ready "$log_path" "$harness_pid"
  assert_equal \
    "$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE status = 'confirmed';")" \
    "15" \
    "$case_name prepared confirmed count"
  assert_prepared_provider_spatial_contract "$case_name"
  record_trigger "$output_prefix.trigger"
  if [[ "$mode" == "hold" ]]; then
    for _ in {1..200}; do
      [[ -s "$output_prefix.samples.tsv" ]] && break
      sleep 0.01
    done
    kill -TERM "$harness_pid"
  fi
  await_status "$harness_pid" "$expected_status" "$case_name"
  assert_restored_contract "$case_name"

  case "$case_name" in
    success)
      jq -e \
        '.status == "ok"
         and .fixture.schemaVersion == 2
         and .fixture.constants.yearCount == 15
         and .fixture.constants.legacyAllTimeSqlCalls == 39
         and .fixture.constants.candidateAllTimeSqlCalls == 20
         and .fixture.constants.selectedYearSqlCalls == 19
         and .fixture.prepared.providerSpatial.tableName == "michelin_restaurant_spatial_index"
         and .fixture.prepared.providerSpatial.schemaObjectCount == 7
         and .fixture.prepared.providerSpatial.virtualTableCount == 1
         and .fixture.prepared.providerSpatial.shadowTableCount == 3
         and .fixture.prepared.providerSpatial.triggerCount == 3
         and .fixture.prepared.providerSpatial.rtreeCompileOptionEnabled
         and .fixture.prepared.providerSpatial.validGuideRestaurantCount == 1
         and .fixture.prepared.providerSpatial.indexedRestaurantCount == 1
         and .fixture.prepared.providerSpatial.healthIssueCount == 0
         and .fixture.prepared.providerSpatial.rtreeCheck == "ok"
         and .oracle.allTime.confirmedVisits == 15
         and .oracle.allTime.uniqueRestaurants == 1
         and .oracle.allTime.totalPhotos == 135
         and .oracle.allTime.averagePhotos == 9
         and .oracle.allTime.threeStarVisits == 15
         and .oracle.allTime.accumulatedStars == 45
         and .oracle.allTime.michelinStats.threeStars == 15
         and .oracle.allTime.michelinStats.distinctThreeStars == 1
         and .oracle.allTime.michelinStats.totalStarredVisits == 15
         and .oracle.allTime.michelinStats.distinctStarredRestaurants == 1
         and .oracle.allTime.michelinStats.totalAccumulatedStars == 45
         and .oracle.allTime.michelinStats.distinctStars == 3
         and .oracle.allTime.michelinStats.greenStarVisits == 0
         and .oracle.selected2025.confirmedVisits == 1
         and .oracle.selected2025.totalPhotos == 15
         and .oracle.selected2025.michelinStats.threeStars == 1
         and .oracle.selected2025.michelinStats.totalAccumulatedStars == 3
         and (.fixture | has("restaurant") | not)
         and (.fixture | has("selectedVisitIds") | not)
         and (.fixture | has("selectedRows") | not)
         and (.fixture.constants | has("fixtureRestaurantId") | not)
         and (.oracle | has("perYear") | not)
         and (.oracle.allTime | has("mapPoints") | not)
         and (.oracle.allTime | has("monthlyVisits") | not)
         and (.oracle.allTime | has("firstVisitDate") | not)
         and (.oracle.selected2025 | has("mapPoints") | not)
         and .validation.readOnlyParity.matches
         and .validation.readOnlyParity.byteIdentical
         and .validation.readOnlyParity.persistedPragmasMatch
         and (.validation.readOnlyParity.candidateSchemaObjectCount
           == .validation.readOnlyParity.preparedSchemaObjectCount)
         and (.validation.readOnlyParity.candidateTables | index("sqlite_sequence") != null)
         and ([.validation.readOnlyParity.tables[]
           | select(.table | startswith("michelin_restaurant_spatial_index"))] | length) == 4
         and ([.validation.readOnlyParity.tables[]
           | select(.table | startswith("michelin_restaurant_spatial_index"))] | all(.matches))
         and .process.preTriggerWalBytes == 0
         and .process.sampledMaxWalBytes == 0
         and .app.processBundleMatchesSuppliedBundle
         and (.database.preparedSha256 == .database.resultSha256)
         and .database.restoredByteIdentical' \
        "$output_prefix.json" >/dev/null
      if rg -q 'ES:SENZ|Mietenkamer|michelin-1|visit-20[0-9][0-9]|event-20[0-9][0-9]' "$output_prefix.json"; then
        print -u2 "success report retained raw fixture identity"
        return 1
      fi
      assert_no_sensitive_intermediates "$output_prefix" "success"
      ;;
    stale)
      rg -q 'Visual-ready timestamp must follow its lower bound' "$log_path"
      assert_no_sensitive_intermediates "$output_prefix" "stale"
      ;;
    signal)
      assert_no_sensitive_intermediates "$output_prefix" "signal"
      ;;
    mutation)
      rg -q 'Wrapped Stats read-only parity failed; diagnostic fixture artifacts retained' "$log_path"
      jq -e \
        '.status == "failed"
         and (.validation.readOnlyParity.matches | not)
         and (.validation.failureReasons | length) > 0
         and .database.restoredByteIdentical
         and (.fixture | has("selectedVisitIds") | not)
         and (.oracle | has("perYear") | not)' \
        "$output_prefix.json" >/dev/null
      assert_sensitive_diagnostics_retained "$output_prefix" "mutation"
      ;;
    spatial-mutation)
      rg -q 'Wrapped Stats read-only parity failed; diagnostic fixture artifacts retained' "$log_path"
      jq -e \
        '.status == "failed"
         and (.validation.readOnlyParity.matches | not)
         and ([.validation.readOnlyParity.tables[]
           | select(.table | startswith("michelin_restaurant_spatial_index"))
           | select(.matches | not)] | length) > 0
         and (.database.preparedSha256 != .database.resultSha256)
         and .database.restoredByteIdentical' \
        "$output_prefix.json" >/dev/null
      assert_sensitive_diagnostics_retained "$output_prefix" "spatial-mutation"
      ;;
  esac
}

run_mismatch_case() {
  local output_directory="$TEMPORARY_DIRECTORY/mismatch"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  mkdir -p "$output_directory"
  start_harness mismatch "$output_prefix" "$log_path"
  local harness_pid="$HARNESS_PID"
  await_status "$harness_pid" 1 "mismatch"
  if rg -q '^READY ' "$log_path"; then
    print -u2 "mismatch reached READY despite process bundle mismatch"
    return 1
  fi
  if [[ -e "$output_prefix.trigger" ]]; then
    print -u2 "mismatch unexpectedly created a trigger"
    return 1
  fi
  rg -q 'Running process bundle mismatch before trigger' "$log_path"
  assert_restored_contract "mismatch"
  assert_no_sensitive_intermediates "$output_prefix" "mismatch"
}

assert_empty_award_oracle() {
  local edge_database="$TEMPORARY_DIRECTORY/empty-award.db"
  local edge_oracle="$TEMPORARY_DIRECTORY/empty-award.oracle.json"
  cp -p "$DATABASE_PATH" "$edge_database"
  sqlite3 "$edge_database" >/dev/null <<'SQL'
INSERT INTO restaurants (id, name, latitude, longitude, address, cuisine)
SELECT id, name, latitude, longitude, address, cuisine
FROM michelin_restaurants
WHERE id = 'michelin-1';
UPDATE visits
SET status = 'confirmed', restaurantId = 'michelin-1', awardAtVisit = ''
WHERE id = 'visit-2012';
SQL
  NODE_NO_WARNINGS=1 "$NODE_BINARY" "$FIXTURE_HELPER_PATH" oracle \
    --database="$edge_database" --report="$edge_oracle" >/dev/null
  jq -e \
    '.allTime.confirmedVisits == 1
     and .allTime.threeStarVisits == 0
     and .allTime.accumulatedStars == 0
     and .allTime.michelinStats.threeStars == 0
     and .allTime.michelinStats.totalStarredVisits == 0
     and .allTime.michelinStats.distinctStarredRestaurants == 0
     and .allTime.michelinStats.totalAccumulatedStars == 0
     and .allTime.michelinStats.distinctStars == 0' \
    "$edge_oracle" >/dev/null
}

assert_empty_award_oracle
run_interactive_case success success 0
run_mismatch_case
run_interactive_case stale stale 1
run_interactive_case signal hold 143
run_interactive_case mutation mutate 1
run_interactive_case spatial-mutation mutate-spatial 1

print "macOS Wrapped Stats harness contract tests passed: spatial prewarm/health/zero-write parity, pre-trigger bundle mismatch, stale visual-ready rejection, TERM cleanup, semantic and RTree mutation detection, and byte-identical restoration."

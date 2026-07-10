#!/bin/zsh
set -euo pipefail

ROOT_DIRECTORY="${0:A:h:h}"
HARNESS_PATH="$ROOT_DIRECTORY/scripts/validate-macos-calendar-query-strategy.sh"
FAKE_HELPER_PATH="$ROOT_DIRECTORY/scripts/fixtures/calendar-query-harness/fake-macos-command.sh"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-calendar-harness-test.XXXXXX")"
FAKE_BIN_DIRECTORY="$TEMPORARY_DIRECTORY/bin"
FAKE_STATE_DIRECTORY="$TEMPORARY_DIRECTORY/state"
FAKE_APP_PATH="$TEMPORARY_DIRECTORY/Palate.app"
DATABASE_PATH="$TEMPORARY_DIRECTORY/calendar-fixture.db"
REFERENCE_DATABASE_PATH="$TEMPORARY_DIRECTORY/broad-reference.db"
INVALID_REFERENCE_DATABASE_PATH="$TEMPORARY_DIRECTORY/invalid-reference.db"

cleanup() {
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    simulator_pid="$(< "$FAKE_STATE_DIRECTORY/pid")"
    kill -TERM "$simulator_pid" 2>/dev/null || true
  fi
  rm -rf -- "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT

for dependency in jq rg shasum sqlite3; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    print -u2 "Missing dependency: $dependency"
    exit 2
  fi
done

mkdir -p "$FAKE_BIN_DIRECTORY" "$FAKE_STATE_DIRECTORY/environment" "$FAKE_APP_PATH"
for command_name in launchctl open pgrep pkill ps; do
  ln -s "$FAKE_HELPER_PATH" "$FAKE_BIN_DIRECTORY/$command_name"
done
ln -s /usr/bin/true "$FAKE_APP_PATH/Palate"

export PALATE_CALENDAR_HARNESS_FAKE_STATE="$FAKE_STATE_DIRECTORY"
export PALATE_CALENDAR_HARNESS_FAKE_HELPER="$FAKE_HELPER_PATH"
export PATH="$FAKE_BIN_DIRECTORY:$PATH"

sqlite3 "$DATABASE_PATH" >/dev/null <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  restaurantId TEXT,
  suggestedRestaurantId TEXT,
  status TEXT NOT NULL,
  startTime INTEGER NOT NULL,
  endTime INTEGER NOT NULL,
  centerLat REAL NOT NULL,
  centerLon REAL NOT NULL,
  photoCount INTEGER NOT NULL,
  foodProbable INTEGER NOT NULL,
  calendarEventId TEXT,
  calendarEventTitle TEXT,
  calendarEventLocation TEXT,
  calendarEventIsAllDay INTEGER,
  notes TEXT,
  updatedAt INTEGER,
  exportedToCalendarId TEXT,
  awardAtVisit TEXT
);
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  uri TEXT NOT NULL,
  creationTime INTEGER NOT NULL,
  latitude REAL,
  longitude REAL,
  visitId TEXT,
  foodDetected INTEGER,
  foodLabels TEXT,
  foodConfidence REAL,
  allLabels TEXT,
  mediaType TEXT,
  duration REAL
);
CREATE TABLE visit_suggested_restaurants (
  visitId TEXT NOT NULL,
  restaurantId TEXT NOT NULL,
  distance REAL NOT NULL,
  PRIMARY KEY (visitId, restaurantId)
);
CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

INSERT INTO visits (
  id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
  centerLat, centerLon, photoCount, foodProbable, calendarEventId,
  calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
  notes, updatedAt, exportedToCalendarId, awardAtVisit
) VALUES
  ('visit-a', NULL, 'restaurant-a', 'pending', 1000, 2000,
   37.1, -122.1, 1, 1, 'event-a', 'Dinner A', 'Location A', 0,
   'note-a', 10, NULL, NULL),
  ('visit-b', NULL, 'restaurant-b', 'pending', 3000, 4000,
   37.2, -122.2, 1, 0, 'event-b', 'Lunch B', NULL, 0,
   NULL, 20, NULL, NULL);
INSERT INTO photos (
  id, uri, creationTime, latitude, longitude, visitId, foodDetected,
  foodLabels, foodConfidence, allLabels, mediaType, duration
) VALUES
  ('photo-a', 'asset-a', 1500, 37.1, -122.1, 'visit-a', 1,
   '["food"]', 0.9, '["food"]', 'photo', NULL),
  ('photo-b', 'asset-b', 3500, 37.2, -122.2, 'visit-b', 0,
   '[]', 0.1, '["table"]', 'photo', NULL);
INSERT INTO visit_suggested_restaurants VALUES
  ('visit-a', 'restaurant-a', 10.5),
  ('visit-b', 'restaurant-b', 20.5);
INSERT INTO app_metadata VALUES ('fixture-version', '1');
SQL
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
rm -f -- "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
ORIGINAL_DATABASE_SHA256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
cp -p "$DATABASE_PATH" "$REFERENCE_DATABASE_PATH"
sqlite3 "$REFERENCE_DATABASE_PATH" \
  "UPDATE visits SET calendarEventTitle = 'Reference Dinner A' WHERE id = 'visit-a'; PRAGMA wal_checkpoint(TRUNCATE);" \
  >/dev/null
rm -f -- "$REFERENCE_DATABASE_PATH-wal" "$REFERENCE_DATABASE_PATH-shm"
REFERENCE_DATABASE_SHA256="$(shasum -a 256 "$REFERENCE_DATABASE_PATH" | awk '{print $1}')"
cp -p "$DATABASE_PATH" "$INVALID_REFERENCE_DATABASE_PATH"
sqlite3 "$INVALID_REFERENCE_DATABASE_PATH" \
  "DELETE FROM app_metadata; PRAGMA wal_checkpoint(TRUNCATE);" \
  >/dev/null
rm -f -- "$INVALID_REFERENCE_DATABASE_PATH-wal" "$INVALID_REFERENCE_DATABASE_PATH-shm"
INVALID_REFERENCE_DATABASE_SHA256="$(shasum -a 256 "$INVALID_REFERENCE_DATABASE_PATH" | awk '{print $1}')"

typeset -A ORIGINAL_ENVIRONMENT=(
  PALATE_CALENDAR_QUERY_STRATEGY "preexisting-strategy"
  PALATE_CALENDAR_QUERY_GAP_DAYS "12.5"
  PALATE_CALENDAR_VALIDATION_RUN_ID "preexisting-run"
  PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH "/tmp/preexisting calendar attestation.json"
  PALATE_VISION_RESULT_PAGE_SIZE "777"
  PALATE_VISION_CLASSIFICATION_STRATEGY "preexisting-vision"
  PALATE_VISION_CONCURRENCY "3"
  PALATE_VISION_PIPELINE_DEPTH "6"
)

for key value in ${(kv)ORIGINAL_ENVIRONMENT}; do
  launchctl setenv "$key" "$value"
done

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
  local restored_sha256
  restored_sha256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
  assert_equal "$restored_sha256" "$ORIGINAL_DATABASE_SHA256" "$label database hash"

  for key value in ${(kv)ORIGINAL_ENVIRONMENT}; do
    assert_equal "$(launchctl getenv "$key")" "$value" "$label environment $key"
  done

  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    print -u2 "$label left the fake Palate process registered"
    return 1
  fi
}

wait_for_ready() {
  local log_path="$1"
  local process_id="$2"
  for _ in {1..500}; do
    if rg -q '^READY ' "$log_path" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$process_id" 2>/dev/null; then
      print -u2 "Harness exited before READY"
      [[ -f "$log_path" ]] && sed -n '1,200p' "$log_path" >&2
      return 1
    fi
    sleep 0.01
  done
  print -u2 "Timed out waiting for READY"
  [[ -f "$log_path" ]] && sed -n '1,200p' "$log_path" >&2
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
  local expected_status="$3"
  local reference_mode="${4:-live-snapshot}"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local trigger_path="$output_prefix.trigger"
  local harness_pid exit_status
  local -a harness_arguments
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE="$mode"
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$trigger_path"

  harness_arguments=(
    --app="$FAKE_APP_PATH"
    --database="$DATABASE_PATH"
    --strategy=sparse
    --gap-days=7.5
    --output-prefix="$output_prefix"
    --expected-visit-count=2
    --expected-calendar-link-count=2
    --timeout-seconds=5
  )
  if [[ "$reference_mode" == "explicit" ]]; then
    harness_arguments+=(--reference-database="$REFERENCE_DATABASE_PATH")
  fi

  zsh "$HARNESS_PATH" "${harness_arguments[@]}" > "$log_path" 2>&1 &
  harness_pid="$!"

  wait_for_ready "$log_path" "$harness_pid"
  if [[ "$mode" == "hold" ]]; then
    assert_equal \
      "$(sqlite3 "$DATABASE_PATH" "SELECT COUNT(*) FROM visits WHERE calendarEventId IS NOT NULL;")" \
      "0" \
      "$case_name prepared link count"
    kill -TERM "$harness_pid"
  else
    record_trigger "$trigger_path"
  fi

  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  assert_equal "$exit_status" "$expected_status" "$case_name exit status"
  assert_restored_contract "$case_name"

  case "$case_name" in
    success)
      jq -e \
        '.status == "ok"
         and .strategy == "sparse"
         and .sparseCoalescingGapDays == 7.5
         and .fixture.visits == 2
         and .fixture.calendarLinks == 2
         and .validation.exactVisitParityExcludingUpdatedAt
         and .validation.exactPhotoParity
         and .validation.exactVisitSuggestedRestaurantParity
         and .validation.exactAppMetadataParity
         and .liveOriginalDatabase.sha256 == $liveSha
         and .parityReferenceDatabase.selection == "live-original-snapshot"
         and .parityReferenceDatabase.path == .liveOriginalDatabase.snapshotPath
         and .parityReferenceDatabase.sha256 == .liveOriginalDatabase.sha256
         and (.timing.scope | contains("durable-calendar-restoration"))' \
        --arg liveSha "$ORIGINAL_DATABASE_SHA256" \
        "$output_prefix.json" >/dev/null
      assert_equal \
        "$(sqlite3 "$output_prefix.result.db" "SELECT group_concat(calendarEventId, ',') FROM (SELECT calendarEventId FROM visits ORDER BY id);")" \
        "event-a,event-b" \
        "success result database Calendar links"
      ;;
    parity-failure)
      if ! rg -q 'Parity failed' "$log_path"; then
        print -u2 "Parity-failure case did not report its semantic mismatch"
        sed -n '1,200p' "$log_path" >&2
        return 1
      fi
      jq -e \
        '.status == "failed"
         and (.validation.failureReasons | length) > 0
         and .validation.visitMismatchCount == 1
         and (.validation.exactVisitParityExcludingUpdatedAt | not)
         and .validation.exactPhotoParity
         and .validation.exactVisitSuggestedRestaurantParity
         and .validation.exactAppMetadataParity' \
        "$output_prefix.json" >/dev/null
      assert_equal \
        "$(sqlite3 "$output_prefix.result.db" "SELECT calendarEventTitle FROM visits WHERE id = 'visit-a';")" \
        "Incorrect title" \
        "parity-failure retained result database"
      ;;
    explicit-reference)
      jq -e \
        '.status == "ok"
         and .schemaVersion == 3
         and .liveOriginalDatabase.sha256 == $liveSha
         and .parityReferenceDatabase.selection == "explicit"
         and .parityReferenceDatabase.sha256 == $referenceSha
         and .parityReferenceDatabase.path != .liveOriginalDatabase.snapshotPath
         and .parityReferenceDatabase.accessMode == "immutable-read-only"
         and .parityReferenceDatabase.integrity == "ok"
         and .parityReferenceDatabase.foreignKeyViolationCount == 0' \
        --arg liveSha "$ORIGINAL_DATABASE_SHA256" \
        --arg referenceSha "$REFERENCE_DATABASE_SHA256" \
        "$output_prefix.json" >/dev/null
      assert_equal \
        "$(sqlite3 "$output_prefix.result.db" "SELECT calendarEventTitle FROM visits WHERE id = 'visit-a';")" \
        "Reference Dinner A" \
        "explicit-reference result database"
      assert_equal \
        "$(shasum -a 256 "$REFERENCE_DATABASE_PATH" | awk '{print $1}')" \
        "$REFERENCE_DATABASE_SHA256" \
        "explicit-reference source database hash"
      if [[ -e "$REFERENCE_DATABASE_PATH-wal" || -e "$REFERENCE_DATABASE_PATH-shm" ]]; then
        print -u2 "Explicit reference validation created a SQLite sidecar"
        return 1
      fi
      ;;
  esac
}

run_invalid_reference_case() {
  local output_directory="$TEMPORARY_DIRECTORY/invalid-reference"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local exit_status
  mkdir -p "$output_directory"

  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --reference-database="$INVALID_REFERENCE_DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" "1" "invalid-reference exit status"
  if ! rg -q 'does not match the controlled live fixture counts' "$log_path"; then
    print -u2 "Invalid reference did not report its fixture-count failure"
    sed -n '1,200p' "$log_path" >&2
    return 1
  fi
  assert_restored_contract "invalid-reference"
  assert_equal \
    "$(shasum -a 256 "$INVALID_REFERENCE_DATABASE_PATH" | awk '{print $1}')" \
    "$INVALID_REFERENCE_DATABASE_SHA256" \
    "invalid-reference source database hash"
}

run_case success success 0
run_case explicit-reference reference-success 0 explicit
run_case parity-failure parity-failure 1
run_invalid_reference_case
run_case signal hold 143

print "macOS Calendar query harness contract tests passed: live-snapshot reference, explicit read-only reference, invalid reference rejection, semantic failure, and signal restoration."

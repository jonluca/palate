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
GROWTH_REFERENCE_DATABASE_PATH="$TEMPORARY_DIRECTORY/growth-reference.db"
LOWER_PHOTO_REFERENCE_DATABASE_PATH="$TEMPORARY_DIRECTORY/lower-photo-reference.db"
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
for command_name in launchctl open pgrep pkill ps lsof codesign; do
  ln -s "$FAKE_HELPER_PATH" "$FAKE_BIN_DIRECTORY/$command_name"
done
ln -s /usr/bin/true "$FAKE_APP_PATH/Palate"
print -r -- "fixture-release-bundle" > "$FAKE_APP_PATH/main.jsbundle"

export PALATE_CALENDAR_HARNESS_FAKE_STATE="$FAKE_STATE_DIRECTORY"
export PALATE_CALENDAR_HARNESS_FAKE_HELPER="$FAKE_HELPER_PATH"
export PALATE_CALENDAR_HARNESS_FAKE_APP="$FAKE_APP_PATH"
export PALATE_CALENDAR_HARNESS_TEST_SKIP_DURABILITY_SYNC=1
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
  "UPDATE visits SET calendarEventTitle = 'Reference Dinner A' WHERE id = 'visit-a';
   INSERT INTO photos (
     id, uri, creationTime, latitude, longitude, visitId, foodDetected,
     foodLabels, foodConfidence, allLabels, mediaType, duration
   ) VALUES (
     'photo-reference-only', 'asset-reference-only', 4500, 37.3, -122.3,
     NULL, NULL, NULL, NULL, NULL, 'photo', NULL
   );
   PRAGMA wal_checkpoint(TRUNCATE);" \
  >/dev/null
rm -f -- "$REFERENCE_DATABASE_PATH-wal" "$REFERENCE_DATABASE_PATH-shm"
REFERENCE_DATABASE_SHA256="$(shasum -a 256 "$REFERENCE_DATABASE_PATH" | awk '{print $1}')"
cp -p "$DATABASE_PATH" "$GROWTH_REFERENCE_DATABASE_PATH"
sqlite3 "$GROWTH_REFERENCE_DATABASE_PATH" >/dev/null <<'SQL'
UPDATE visits
SET calendarEventTitle = 'Growth Dinner A'
WHERE id = 'visit-a';
INSERT INTO visits (
  id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
  centerLat, centerLon, photoCount, foodProbable, calendarEventId,
  calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
  notes, updatedAt, exportedToCalendarId, awardAtVisit
) VALUES (
  'visit-c', NULL, 'restaurant-c', 'pending', 5000, 6000,
  37.3, -122.3, 1, 1, 'event-c', 'Dinner C', 'Location C', 0,
  NULL, 30, NULL, NULL
);
INSERT INTO photos (
  id, uri, creationTime, latitude, longitude, visitId, foodDetected,
  foodLabels, foodConfidence, allLabels, mediaType, duration
) VALUES (
  'photo-growth-only', 'asset-growth-only', 5500, 37.3, -122.3,
  'visit-c', 1, '["food"]', 0.8, '["food"]', 'photo', NULL
);
INSERT INTO visit_suggested_restaurants
VALUES ('visit-c', 'restaurant-c', 30.5);
PRAGMA wal_checkpoint(TRUNCATE);
SQL
rm -f -- "$GROWTH_REFERENCE_DATABASE_PATH-wal" "$GROWTH_REFERENCE_DATABASE_PATH-shm"
GROWTH_REFERENCE_DATABASE_SHA256="$(shasum -a 256 "$GROWTH_REFERENCE_DATABASE_PATH" | awk '{print $1}')"
cp -p "$DATABASE_PATH" "$LOWER_PHOTO_REFERENCE_DATABASE_PATH"
sqlite3 "$LOWER_PHOTO_REFERENCE_DATABASE_PATH" \
  "DELETE FROM photos WHERE id = 'photo-b'; PRAGMA wal_checkpoint(TRUNCATE);" \
  >/dev/null
rm -f -- "$LOWER_PHOTO_REFERENCE_DATABASE_PATH-wal" "$LOWER_PHOTO_REFERENCE_DATABASE_PATH-shm"
LOWER_PHOTO_REFERENCE_DATABASE_SHA256="$(shasum -a 256 "$LOWER_PHOTO_REFERENCE_DATABASE_PATH" | awk '{print $1}')"
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
  PALATE_PHOTO_SCAN_VALIDATION_RUN_ID "preexisting-photo-run"
  PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH "/tmp/preexisting photo attestation.json"
)
ORIGINAL_PHOTO_SCAN_STRATEGY="legacy"
ORIGINAL_PHOTO_SCAN_STRATEGY_SET=1

for key value in ${(kv)ORIGINAL_ENVIRONMENT}; do
  launchctl setenv "$key" "$value"
done
launchctl setenv PALATE_PHOTO_SCAN_STRATEGY "$ORIGINAL_PHOTO_SCAN_STRATEGY"

set_original_photo_scan_environment() {
  local state="$1"
  if [[ "$state" == "absent" ]]; then
    launchctl unsetenv PALATE_PHOTO_SCAN_STRATEGY
    ORIGINAL_PHOTO_SCAN_STRATEGY=""
    ORIGINAL_PHOTO_SCAN_STRATEGY_SET=0
  else
    launchctl setenv PALATE_PHOTO_SCAN_STRATEGY "$state"
    ORIGINAL_PHOTO_SCAN_STRATEGY="$state"
    ORIGINAL_PHOTO_SCAN_STRATEGY_SET=1
  fi
}

assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    print -u2 -- "$label: expected '$expected', found '$actual'"
    return 1
  fi
}

assert_mode() {
  local file_path="$1"
  local expected="$2"
  local label="$3"
  assert_equal "$(stat -f '%Lp' "$file_path")" "$expected" "$label mode"
}

assert_restored_contract() {
  local label="$1"
  local restored_sha256
  restored_sha256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
  assert_equal "$restored_sha256" "$ORIGINAL_DATABASE_SHA256" "$label database hash"

  for key value in ${(kv)ORIGINAL_ENVIRONMENT}; do
    assert_equal "$(launchctl getenv "$key")" "$value" "$label environment $key"
  done
  if (( ORIGINAL_PHOTO_SCAN_STRATEGY_SET )); then
    assert_equal \
      "$(launchctl getenv PALATE_PHOTO_SCAN_STRATEGY)" \
      "$ORIGINAL_PHOTO_SCAN_STRATEGY" \
      "$label environment PALATE_PHOTO_SCAN_STRATEGY"
  elif [[ -e "$FAKE_STATE_DIRECTORY/environment/PALATE_PHOTO_SCAN_STRATEGY" ]]; then
    print -u2 "$label restored PALATE_PHOTO_SCAN_STRATEGY as set instead of absent"
    return 1
  fi

  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    print -u2 "$label left the fake Palate process registered"
    return 1
  fi
}

wait_for_ready() {
  local log_path="$1"
  local process_id="$2"
  for _ in {1..3000}; do
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
  local photo_scan_strategy="${5:-}"
  local expected_photo_scan_implementation="${6:-}"
  local retain_raw_databases="${7:-0}"
  local capture_reference_database="${8:-0}"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local trigger_path="$output_prefix.trigger"
  local capture_reference_path="$output_directory/captured-reference.db"
  local harness_pid exit_status retained_snapshot
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
  if [[ -n "$photo_scan_strategy" ]]; then
    harness_arguments+=(--photo-scan-strategy="$photo_scan_strategy")
  fi
  if [[ -n "$expected_photo_scan_implementation" ]]; then
    harness_arguments+=(--expected-photo-scan-implementation="$expected_photo_scan_implementation")
  fi
  if (( retain_raw_databases )); then
    harness_arguments+=(--retain-raw-databases)
  fi
  if (( capture_reference_database )); then
    harness_arguments+=(--capture-reference-database="$capture_reference_path")
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

  if (( expected_status == 0 )); then
    local requested_photo_scan_strategy_json=null
    local observed_photo_scan_strategy_json=null
    local expected_resolved_photo_scan_strategy="incremental"
    local requested_photo_scan_strategy_label="native-default"
    local observed_photo_scan_strategy_label="absent"
    local expected_photo_scan_implementation_json=null
    local expected_photo_library_total=2
    if [[ -n "$photo_scan_strategy" ]]; then
      requested_photo_scan_strategy_json="\"$photo_scan_strategy\""
      observed_photo_scan_strategy_json="\"$photo_scan_strategy\""
      expected_resolved_photo_scan_strategy="$photo_scan_strategy"
      requested_photo_scan_strategy_label="$photo_scan_strategy"
      observed_photo_scan_strategy_label="$photo_scan_strategy"
    fi
    if [[ -n "$expected_photo_scan_implementation" ]]; then
      expected_photo_scan_implementation_json="\"$expected_photo_scan_implementation\""
    fi
    if [[ "$reference_mode" == "explicit" ]] || (( capture_reference_database )); then
      expected_photo_library_total=3
    fi
    jq -e \
      '.schemaVersion == 6
       and .configuration.calendarQueryStrategy == "sparse"
       and .configuration.sparseCoalescingGapDays == 7.5
       and .configuration.requestedPhotoScanStrategy == $requested
       and .configuration.expectedResolvedPhotoScanStrategy == $resolved
       and .configuration.expectedPhotoScanImplementation == $implementation
       and .runtimeAttestation.requestedPhotoScanStrategy == $requested
       and .runtimeAttestation.observedProcessPhotoScanStrategy == $observed
       and .runtimeAttestation.expectedResolvedPhotoScanStrategy == $resolved
       and .runtimeAttestation.expectedPhotoScanImplementation == $implementation
       and .runtimeAttestation.photoScan.schemaVersion == 2
       and .runtimeAttestation.photoScan.resolvedPhotoScanStrategy == $resolved
       and .runtimeAttestation.photoScan.selectedScanKind == $resolved
       and .runtimeAttestation.photoScan.selectedScanImplementation
         == (if $resolved == "legacy" then "legacy" else "database-backed" end)
       and .runtimeAttestation.photoScan.libraryTotalCount == $expectedLibraryTotal
       and (.runtimeAttestation.photoScan.libraryTotalCount
         == (.runtimeAttestation.photoScan.unknownVisibleCount
           + .runtimeAttestation.photoScan.excludedVisibleCount))
       and .buildAttestation.strictCodeSignatureVerified
       and .buildAttestation.exactExecutableMatch
       and .buildAttestation.exactMainBundleMatch
       and .triggerBoundary.unchangedBeforeTrigger
       and .restoration.exactMainAndSidecarSetRestored
       and .restoration.sensitiveDatabaseCopiesRetained == (($retained == 1) or ($capture == 1))
       and .resultDatabase.retained == ($retained == 1)' \
      --argjson requested "$requested_photo_scan_strategy_json" \
      --argjson observed "$observed_photo_scan_strategy_json" \
      --arg resolved "$expected_resolved_photo_scan_strategy" \
      --argjson implementation "$expected_photo_scan_implementation_json" \
      --argjson expectedLibraryTotal "$expected_photo_library_total" \
      --argjson retained "$retain_raw_databases" \
      --argjson capture "$capture_reference_database" \
      "$output_prefix.json" >/dev/null
    assert_mode "$output_prefix.json" 600 "$case_name report"
    assert_mode "$output_prefix.samples.tsv" 600 "$case_name samples"
    assert_mode "$DATABASE_PATH.palate-calendar-validation.lock" 600 "$case_name lock"
    [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
    rg -q \
      "^READY .*photo_scan_strategy_requested=$requested_photo_scan_strategy_label photo_scan_strategy_observed=$observed_photo_scan_strategy_label photo_scan_strategy_expected=$expected_resolved_photo_scan_strategy " \
      "$log_path"
  fi

  case "$case_name" in
    success)
      jq -e \
        '.status == "ok"
         and .schemaVersion == 6
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
         and .parityReferenceDatabase.path == null
         and .liveOriginalDatabase.snapshotPath == null
         and .resultDatabase.path == null
         and (.resultDatabase.retained | not)
         and (.timing.scope | contains("durable-calendar-restoration"))' \
        --arg liveSha "$ORIGINAL_DATABASE_SHA256" \
        "$output_prefix.json" >/dev/null
      [[ ! -e "$output_prefix.result.db" ]]
      if find "$output_directory" -type f -name '*.db' -print -quit | grep -q .; then
        print -u2 "success retained a private database without opt-in"
        return 1
      fi
      ;;
    retained-success)
      jq -e \
        '.status == "ok"
         and .schemaVersion == 6
         and .restoration.exactMainAndSidecarSetRestored
         and .restoration.sensitiveDatabaseCopiesRetained
         and .resultDatabase.retained
         and (.resultDatabase.path | type) == "string"
         and (.liveOriginalDatabase.snapshotPath | type) == "string"' \
        "$output_prefix.json" >/dev/null
      assert_equal \
        "$(sqlite3 "$output_prefix.result.db" "SELECT group_concat(calendarEventId, ',') FROM (SELECT calendarEventId FROM visits ORDER BY id);")" \
        "event-a,event-b" \
        "retained-success result database Calendar links"
      assert_mode "$output_prefix.result.db" 600 "retained-success result database"
      retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
      [[ -n "$retained_snapshot" ]]
      assert_mode "$retained_snapshot" 600 "retained-success snapshot"
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
      [[ ! -e "$output_prefix.result.db" ]]
      ;;
    photo-attestation-mismatch)
      rg -q \
        'Native Photo scan attestation did not prove the requested scan path and balanced counters' \
        "$log_path"
      ;;
    photo-implementation-mismatch)
      rg -q \
        'Native Photo scan attestation did not prove the requested scan path and balanced counters' \
        "$log_path"
      ;;
    explicit-reference)
      jq -e \
        '.status == "ok"
         and .schemaVersion == 6
         and .liveOriginalDatabase.sha256 == $liveSha
         and .parityReferenceDatabase.selection == "explicit"
         and .parityReferenceDatabase.sha256 == $referenceSha
         and .parityReferenceDatabase.path == null
         and .parityReferenceDatabase.accessMode == "immutable-read-only"
         and .parityReferenceDatabase.integrity == "ok"
         and .parityReferenceDatabase.foreignKeyViolationCount == 0
         and .parityReferenceDatabase.photoCountDeltaFromLiveOriginal == 1
         and .parityReferenceDatabase.fixture.photos == 3
         and .fixture.photos == 3
         and .runtimeAttestation.photoScan.libraryTotalCount == 3
         and .runtimeAttestation.photoScan.excludedVisibleCount == 2
         and .runtimeAttestation.photoScan.unknownVisibleCount == 1
         and .validation.exactPhotoParity' \
        --arg liveSha "$ORIGINAL_DATABASE_SHA256" \
        --arg referenceSha "$REFERENCE_DATABASE_SHA256" \
        "$output_prefix.json" >/dev/null
      assert_equal \
        "$(sqlite3 "$output_prefix.result.db" "SELECT calendarEventTitle FROM visits WHERE id = 'visit-a';")" \
        "Reference Dinner A" \
        "explicit-reference result database"
      assert_equal \
        "$(sqlite3 "$output_prefix.result.db" "SELECT COUNT(*) FROM photos;")" \
        "3" \
        "explicit-reference result photo count"
      assert_equal \
        "$(sqlite3 "$output_prefix.result.db" "SELECT uri FROM photos WHERE id = 'photo-reference-only';")" \
        "asset-reference-only" \
        "explicit-reference result delta photo"
      assert_equal \
        "$(shasum -a 256 "$REFERENCE_DATABASE_PATH" | awk '{print $1}')" \
        "$REFERENCE_DATABASE_SHA256" \
        "explicit-reference source database hash"
      if [[ -e "$REFERENCE_DATABASE_PATH-wal" || -e "$REFERENCE_DATABASE_PATH-shm" ]]; then
        print -u2 "Explicit reference validation created a SQLite sidecar"
        return 1
      fi
      ;;
    capture-success)
      jq -e \
        '.status == "ok"
         and .configuration.referenceCaptureRequested
         and .parityReferenceDatabase.selection == "live-original-photo-subset-capture"
         and .parityReferenceDatabase.fixture.photos == 2
         and .fixture.photos == 3
         and .runtimeAttestation.photoScan.libraryTotalCount == 3
         and .runtimeAttestation.photoScan.excludedVisibleCount == 2
         and .runtimeAttestation.photoScan.unknownVisibleCount == 1
         and .validation.photoComparisonMode == "exact-original-subset"
         and .validation.exactPhotoParity == null
         and .validation.exactOriginalPhotoSubsetPreserved
         and .validation.originalPhotoSubsetMismatchCount == 0
         and .validation.exactResultPhotoCount
         and .validation.expectedResultPhotoCount == 3
         and .referenceCaptureDatabase.requested
         and .referenceCaptureDatabase.captured
         and .referenceCaptureDatabase.path == null
         and .referenceCaptureDatabase.outputPathRedacted
         and .referenceCaptureDatabase.privateFileMode == "600"
         and .referenceCaptureDatabase.sha256 == $captureSha
         and .referenceCaptureDatabase.integrity == "ok"
         and .referenceCaptureDatabase.foreignKeyViolationCount == 0
         and .referenceCaptureDatabase.photoCountDeltaFromLiveOriginal == 1
         and .referenceCaptureDatabase.expectedPhotoCount == 3
         and .referenceCaptureDatabase.fixture.photos == 3
         and (.resultDatabase.retained | not)' \
        --arg captureSha "$(shasum -a 256 "$capture_reference_path" | awk '{print $1}')" \
        "$output_prefix.json" >/dev/null
      assert_mode "$capture_reference_path" 600 "capture-success reference database"
      assert_equal \
        "$(sqlite3 "$capture_reference_path" "SELECT COUNT(*) FROM photos;")" \
        "3" \
        "capture-success photo count"
      assert_equal \
        "$(sqlite3 "$capture_reference_path" "SELECT uri FROM photos WHERE id = 'photo-capture-only';")" \
        "asset-capture-only" \
        "capture-success newly visible photo"
      assert_equal \
        "$(sqlite3 "$capture_reference_path" "SELECT group_concat(calendarEventId, ',') FROM (SELECT calendarEventId FROM visits ORDER BY id);")" \
        "event-a,event-b" \
        "capture-success Calendar parity"
      [[ ! -e "$output_prefix.result.db" ]]
      ;;
    capture-subset-mismatch)
      jq -e \
        '.status == "failed"
         and .configuration.referenceCaptureRequested
         and (.validation.exactOriginalPhotoSubsetPreserved | not)
         and .validation.originalPhotoSubsetMismatchCount == 1
         and .validation.exactResultPhotoCount
         and .referenceCaptureDatabase.requested
         and (.referenceCaptureDatabase.captured | not)
         and .referenceCaptureDatabase.sha256 == null' \
        "$output_prefix.json" >/dev/null
      [[ ! -e "$capture_reference_path" ]]
      ;;
    capture-count-mismatch)
      jq -e \
        '.status == "failed"
         and .configuration.referenceCaptureRequested
         and .validation.exactOriginalPhotoSubsetPreserved
         and (.validation.exactResultPhotoCount | not)
         and .validation.expectedResultPhotoCount == 3
         and .fixture.photos == 2
         and .referenceCaptureDatabase.requested
         and (.referenceCaptureDatabase.captured | not)' \
        "$output_prefix.json" >/dev/null
      [[ ! -e "$capture_reference_path" ]]
      ;;
  esac
}

run_capture_growth_case() {
  local case_name="$1"
  local fake_mode="$2"
  local expected_status="$3"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local capture_reference_path="$output_directory/captured-growth-reference.db"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE="$fake_mode"
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --photo-scan-strategy=incremental \
    --expected-photo-scan-implementation=database-backed \
    --capture-reference-database="$capture_reference_path" \
    --capture-expected-calendar-link-count=3 \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e

  assert_equal "$exit_status" "$expected_status" "$case_name exit status"
  assert_restored_contract "$case_name"
  assert_mode "$output_prefix.json" 600 "$case_name report"
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]

  if (( expected_status == 0 )); then
    jq -e \
      '.status == "ok"
       and .configuration.referenceCaptureRequested
       and .configuration.bootstrapCaptureFixtureGrowth
       and .configuration.captureExpectedCalendarLinkCount == 3
       and (.configuration.allowedReferenceFixtureGrowth | not)
       and .fixture == {
         visits: 3,
         calendarLinks: 3,
         distinctEvents: 3,
         photos: 3,
         visitSuggestedRestaurants: 3,
         appMetadata: 1
       }
       and .validation.visitComparisonMode == "exact-original-subset-excluding-calendar-and-updatedAt"
       and .validation.exactVisitParityExcludingUpdatedAt == null
       and .validation.exactOriginalVisitSubsetPreserved
       and .validation.exactOriginalPhotoSubsetPreserved
       and .validation.suggestionComparisonMode == "exact-original-subset"
       and .validation.exactVisitSuggestedRestaurantParity == null
       and .validation.exactOriginalVisitSuggestedRestaurantSubsetPreserved
       and .validation.exactAppMetadataParity
       and .validation.exactResultPhotoCount
       and .fixtureGrowth == {
         bootstrapCaptureEnabled: true,
         referenceGrowthAllowed: false,
         expectedCalendarLinkCount: 3,
         visits: 1,
         calendarLinks: 1,
         distinctEvents: 1,
         photos: 1,
         visitSuggestedRestaurants: 1
       }
       and .referenceCaptureDatabase.captured
       and .referenceCaptureDatabase.sha256 == $captureSha
       and .referenceCaptureDatabase.fixture.visits == 3
       and .referenceCaptureDatabase.fixture.calendarLinks == 3
       and .referenceCaptureDatabase.fixture.distinctEvents == 3
       and .referenceCaptureDatabase.fixture.photos == 3
       and .referenceCaptureDatabase.fixture.visitSuggestedRestaurants == 3' \
      --arg captureSha "$(shasum -a 256 "$capture_reference_path" | awk '{print $1}')" \
      "$output_prefix.json" >/dev/null
    assert_mode "$capture_reference_path" 600 "$case_name captured reference"
    assert_equal \
      "$(sqlite3 "$capture_reference_path" "SELECT calendarEventTitle FROM visits WHERE id = 'visit-a';")" \
      "Growth Dinner A" \
      "$case_name recomputed Calendar field"
    assert_equal \
      "$(sqlite3 "$capture_reference_path" "SELECT COUNT(*) FROM visits WHERE id = 'visit-c';")" \
      "1" \
      "$case_name new visit"
    assert_equal \
      "$(sqlite3 "$capture_reference_path" "SELECT COUNT(*) FROM visit_suggested_restaurants;")" \
      "3" \
      "$case_name suggestion growth"
  else
    jq -e \
      '.status == "failed"
       and .configuration.bootstrapCaptureFixtureGrowth
       and (.validation.exactOriginalVisitSubsetPreserved | not)
       and .validation.visitMismatchCount == 1
       and (.validation.exactOriginalVisitSuggestedRestaurantSubsetPreserved | not)
       and .validation.visitSuggestedRestaurantMismatchCount == 1
       and .validation.exactOriginalPhotoSubsetPreserved
       and .validation.exactAppMetadataParity
       and .validation.exactResultPhotoCount
       and .referenceCaptureDatabase.requested
       and (.referenceCaptureDatabase.captured | not)' \
      "$output_prefix.json" >/dev/null
    [[ ! -e "$capture_reference_path" ]]
  fi
}

run_growth_reference_case() {
  local case_name="$1"
  local fake_mode="$2"
  local expected_status="$3"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status sidecar_suffix
  local -a harness_arguments
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE="$fake_mode"
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  harness_arguments=(
    --app="$FAKE_APP_PATH"
    --database="$DATABASE_PATH"
    --reference-database="$GROWTH_REFERENCE_DATABASE_PATH"
    --allow-reference-fixture-growth
    --strategy=sparse
    --gap-days=7.5
    --photo-scan-strategy=incremental
    --expected-photo-scan-implementation=database-backed
    --output-prefix="$output_prefix"
    --expected-visit-count=2
    --expected-calendar-link-count=2
    --timeout-seconds=5
  )
  if (( expected_status == 0 )); then
    harness_arguments+=(--retain-raw-databases)
  fi

  zsh "$HARNESS_PATH" "${harness_arguments[@]}" > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e

  assert_equal "$exit_status" "$expected_status" "$case_name exit status"
  assert_restored_contract "$case_name"
  assert_equal \
    "$(shasum -a 256 "$GROWTH_REFERENCE_DATABASE_PATH" | awk '{print $1}')" \
    "$GROWTH_REFERENCE_DATABASE_SHA256" \
    "$case_name growth reference hash"
  for sidecar_suffix in -wal -shm -journal; do
    [[ ! -e "$GROWTH_REFERENCE_DATABASE_PATH$sidecar_suffix" ]]
  done

  if (( expected_status == 0 )); then
    jq -e \
      '.status == "ok"
       and (.configuration.bootstrapCaptureFixtureGrowth | not)
       and .configuration.allowedReferenceFixtureGrowth
       and .parityReferenceDatabase.selection == "explicit"
       and .parityReferenceDatabase.fixtureGrowthAllowed
       and .parityReferenceDatabase.sha256 == $referenceSha
       and .parityReferenceDatabase.baselinePreservation == {
         visitMismatchCount: 0,
         photoMismatchCount: 0,
         visitSuggestedRestaurantMismatchCount: 0,
         appMetadataMismatchCount: 0
       }
       and .fixture.visits == 3
       and .fixture.calendarLinks == 3
       and .fixture.distinctEvents == 3
       and .fixture.photos == 3
       and .fixture.visitSuggestedRestaurants == 3
       and .validation.exactVisitParityExcludingUpdatedAt
       and .validation.exactPhotoParity
       and .validation.exactVisitSuggestedRestaurantParity
       and .validation.exactAppMetadataParity
       and .fixtureGrowth.referenceGrowthAllowed
       and .fixtureGrowth.visits == 1
       and .fixtureGrowth.calendarLinks == 1
       and .fixtureGrowth.distinctEvents == 1
       and .fixtureGrowth.photos == 1
       and .fixtureGrowth.visitSuggestedRestaurants == 1' \
      --arg referenceSha "$GROWTH_REFERENCE_DATABASE_SHA256" \
      "$output_prefix.json" >/dev/null
    assert_equal \
      "$(sqlite3 "$output_prefix.result.db" "SELECT COUNT(*) FROM visits;")" \
      "3" \
      "$case_name retained result visits"
    assert_equal \
      "$(sqlite3 "$output_prefix.result.db" "SELECT calendarEventTitle FROM visits WHERE id = 'visit-a';")" \
      "Growth Dinner A" \
      "$case_name exact Calendar parity"
  else
    jq -e \
      '.status == "failed"
       and .configuration.allowedReferenceFixtureGrowth
       and .validation.visitMismatchCount == 1
       and (.validation.exactVisitParityExcludingUpdatedAt | not)
       and .validation.exactPhotoParity
       and .validation.exactVisitSuggestedRestaurantParity
       and .validation.exactAppMetadataParity' \
      "$output_prefix.json" >/dev/null
    [[ ! -e "$output_prefix.result.db" ]]
  fi
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

run_reference_photo_preflight_failure_case() {
  local case_name="$1"
  local reference_database_path="$2"
  local reference_database_sha256="$3"
  local photo_scan_strategy="$4"
  local expected_photo_scan_implementation="$5"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local exit_status sidecar_suffix
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=success
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --reference-database="$reference_database_path" \
    --strategy=sparse \
    --gap-days=7.5 \
    --photo-scan-strategy="$photo_scan_strategy" \
    --expected-photo-scan-implementation="$expected_photo_scan_implementation" \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 1 "$case_name exit status"
  rg -q 'Parity reference does not match the controlled live fixture counts' "$log_path"
  rg -q 'incremental scans may use only a nonnegative photo-count delta' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "$case_name"
  assert_equal \
    "$(shasum -a 256 "$reference_database_path" | awk '{print $1}')" \
    "$reference_database_sha256" \
    "$case_name reference database hash"
  for sidecar_suffix in -wal -shm -journal; do
    if [[ -e "$reference_database_path$sidecar_suffix" ]]; then
      print -u2 "$case_name created a reference SQLite sidecar: $sidecar_suffix"
      return 1
    fi
  done
}

run_reference_photo_attestation_mismatch_case() {
  local case_name="reference-photo-attestation-mismatch"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status sidecar_suffix
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=reference-photo-attestation-mismatch
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --reference-database="$REFERENCE_DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --photo-scan-strategy=incremental \
    --expected-photo-scan-implementation=database-backed \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"

  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 1 "$case_name exit status"
  rg -q \
    'Native incremental Photo scan attestation did not exactly explain the parity reference photo-count delta' \
    "$log_path"
  rg -q 'expected: library=3 excluded=2 unknown=1' "$log_path"
  rg -q 'attested: library=3 excluded=3 unknown=0' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "$case_name"
  assert_equal \
    "$(shasum -a 256 "$REFERENCE_DATABASE_PATH" | awk '{print $1}')" \
    "$REFERENCE_DATABASE_SHA256" \
    "$case_name reference database hash"
  for sidecar_suffix in -wal -shm -journal; do
    if [[ -e "$REFERENCE_DATABASE_PATH$sidecar_suffix" ]]; then
      print -u2 "$case_name created a reference SQLite sidecar: $sidecar_suffix"
      return 1
    fi
  done
}

run_invalid_capture_configuration_case() {
  local case_name="$1"
  local invalid_mode="$2"
  local expected_message="$3"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local capture_reference_path="$output_directory/captured-reference.db"
  local log_path="$output_directory/harness.log"
  local exit_status
  local -a harness_arguments
  mkdir -p "$output_directory"

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
  case "$invalid_mode" in
    explicit-reference)
      harness_arguments+=(
        --reference-database="$REFERENCE_DATABASE_PATH"
        --capture-reference-database="$capture_reference_path"
        --photo-scan-strategy=incremental
      )
      ;;
    legacy)
      harness_arguments+=(
        --capture-reference-database="$capture_reference_path"
        --photo-scan-strategy=legacy
      )
      ;;
    empty-path)
      harness_arguments+=(--capture-reference-database=)
      ;;
    capture-target-without-capture)
      harness_arguments+=(--capture-expected-calendar-link-count=3)
      ;;
    capture-target-below-baseline)
      harness_arguments+=(
        --capture-reference-database="$capture_reference_path"
        --capture-expected-calendar-link-count=1
      )
      ;;
    reference-growth-without-reference)
      harness_arguments+=(--allow-reference-fixture-growth)
      ;;
    reference-growth-legacy)
      harness_arguments+=(
        --reference-database="$GROWTH_REFERENCE_DATABASE_PATH"
        --allow-reference-fixture-growth
        --photo-scan-strategy=legacy
      )
      ;;
  esac

  set +e
  zsh "$HARNESS_PATH" "${harness_arguments[@]}" > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 2 "$case_name exit status"
  rg -q -- "$expected_message" "$log_path"
  assert_restored_contract "$case_name"
  [[ ! -e "$output_prefix.json" && ! -e "$capture_reference_path" ]]
}

run_growth_reference_requires_flag_case() {
  local output_directory="$TEMPORARY_DIRECTORY/growth-reference-requires-flag"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local exit_status
  mkdir -p "$output_directory"

  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --reference-database="$GROWTH_REFERENCE_DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --photo-scan-strategy=incremental \
    --expected-photo-scan-implementation=database-backed \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 1 "growth reference without allow flag exit status"
  rg -q 'Parity reference does not match the controlled live fixture counts' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "growth reference without allow flag"
  assert_equal \
    "$(shasum -a 256 "$GROWTH_REFERENCE_DATABASE_PATH" | awk '{print $1}')" \
    "$GROWTH_REFERENCE_DATABASE_SHA256" \
    "growth reference without allow flag source hash"
}

run_invalid_photo_scan_strategy_case() {
  local value="$1"
  local output_directory="$TEMPORARY_DIRECTORY/invalid-photo-scan-${value:-empty}"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local exit_status
  mkdir -p "$output_directory"

  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --photo-scan-strategy="$value" \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" "2" "--photo-scan-strategy=$value exit status"
  rg -q -- '--photo-scan-strategy must be legacy or incremental' "$log_path"
  assert_restored_contract "invalid photo scan strategy $value"
}

run_photo_scan_process_mismatch_case() {
  local output_directory="$TEMPORARY_DIRECTORY/photo-scan-mismatch"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local exit_status
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=photo-scan-mismatch
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --photo-scan-strategy=incremental \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" "1" "photo scan mismatch exit status"
  rg -q 'did not inherit PALATE_PHOTO_SCAN_STRATEGY=incremental' "$log_path"
  assert_restored_contract "photo scan mismatch"
}

run_concurrent_lock_case() {
  local output_directory="$TEMPORARY_DIRECTORY/concurrent-lock"
  local first_prefix="$output_directory/first"
  local second_prefix="$output_directory/second"
  local first_log="$output_directory/first.log"
  local second_log="$output_directory/second.log"
  local first_pid first_exit second_exit
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=hold
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$first_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --output-prefix="$first_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$first_log" 2>&1 &
  first_pid="$!"
  wait_for_ready "$first_log" "$first_pid"

  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --output-prefix="$second_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$second_log" 2>&1
  second_exit="$?"
  set -e
  assert_equal "$second_exit" 75 "concurrent lock contender exit status"
  rg -q 'already owns this database lock' "$second_log"
  [[ ! -e "$second_prefix.json" ]]

  kill -TERM "$first_pid"
  set +e
  wait "$first_pid"
  first_exit="$?"
  set -e
  assert_equal "$first_exit" 143 "concurrent lock owner signal exit status"
  assert_restored_contract "concurrent lock owner"
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
}

run_interrupted_restore_failure_case() {
  local case_name="$1"
  local injection_key="$2"
  local injection_value="$3"
  local expected_message="$4"
  local expect_guard_retained="${5:-1}"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local recovery_log="$output_directory/recovery.log"
  local harness_pid exit_status recovery_status
  local guard_path="$DATABASE_PATH.palate-calendar-validation.guard"
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=hold
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  export "$injection_key=$injection_value"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  kill -TERM "$harness_pid"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  unset "$injection_key"

  assert_equal "$exit_status" 143 "$case_name interrupted exit status"
  rg -q "$expected_message" "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  if (( ! expect_guard_retained )); then
    local retained_snapshot
    [[ ! -e "$guard_path" ]]
    assert_restored_contract "$case_name post-removal sync failure"
    retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
    [[ -n "$retained_snapshot" ]]
    rm -f -- "$retained_snapshot" "$retained_snapshot-wal" "$retained_snapshot-shm" "$retained_snapshot-journal"
    return 0
  fi
  [[ -d "$guard_path" && ! -L "$guard_path" ]]

  set +e
  zsh "$HARNESS_PATH" \
    --database="$DATABASE_PATH" \
    --recover-stale-guard \
    > "$recovery_log" 2>&1
  recovery_status="$?"
  set -e
  if (( recovery_status != 0 )); then
    sed -n '1,200p' "$recovery_log" >&2
  fi
  assert_equal "$recovery_status" 0 "$case_name recovery exit status"
  rg -q '^RECOVERED_STALE_GUARD ' "$recovery_log"
  [[ ! -e "$guard_path" ]]
  assert_restored_contract "$case_name recovery"
}

run_default_raw_cleanup_failure_case() {
  local output_directory="$TEMPORARY_DIRECTORY/raw-cleanup-failure"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status retained_snapshot
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=success
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  export PALATE_CALENDAR_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP=1
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  unset PALATE_CALENDAR_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP

  assert_equal "$exit_status" 1 "raw cleanup failure exit status"
  rg -q 'Sensitive database copy cleanup failed; refusing to publish a report' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  assert_restored_contract "raw cleanup failure"
  retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
  [[ -n "$retained_snapshot" ]]
  assert_mode "$retained_snapshot" 600 "raw cleanup failure private snapshot"
  rm -f -- "$retained_snapshot" "$retained_snapshot-wal" "$retained_snapshot-shm" "$retained_snapshot-journal"
}

run_capture_post_restore_failure_case() {
  local output_directory="$TEMPORARY_DIRECTORY/capture-post-restore-failure"
  local output_prefix="$output_directory/result"
  local capture_reference_path="$output_directory/captured-reference.db"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status
  mkdir -p "$output_directory"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=capture-success
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  export PALATE_CALENDAR_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP=1
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --photo-scan-strategy=incremental \
    --expected-photo-scan-implementation=database-backed \
    --capture-reference-database="$capture_reference_path" \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  unset PALATE_CALENDAR_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP

  assert_equal "$exit_status" 1 "capture post-restore failure exit status"
  rg -q 'Sensitive database copy cleanup failed; refusing to publish a report' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  [[ ! -e "$capture_reference_path" ]]
  assert_restored_contract "capture post-restore failure"
}

run_capture_sigkill_temp_cleanup_case() {
  local output_directory="$TEMPORARY_DIRECTORY/capture-sigkill-temp-cleanup"
  local output_prefix="$output_directory/result"
  local capture_reference_path="$output_directory/captured-reference.db"
  local log_path="$output_directory/harness.log"
  local recovery_log="$output_directory/recovery.log"
  local guard_path="$DATABASE_PATH.palate-calendar-validation.guard"
  local harness_pid killed_exit recovery_status run_id capture_temp_path
  mkdir -p "$output_directory"
  capture_reference_path="${capture_reference_path:A}"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=hold
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --photo-scan-strategy=incremental \
    --expected-photo-scan-implementation=database-backed \
    --capture-reference-database="$capture_reference_path" \
    --retain-raw-databases \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"

  run_id="$(jq -r '.createdByRunId' "$guard_path/manifest.json")"
  capture_temp_path="$capture_reference_path.tmp-$run_id"
  jq -e \
    --arg captureTempPath "$capture_temp_path" \
    --arg capturePath "$capture_reference_path" \
    '.artifactCleanup.retainRawDatabases
     and .artifactCleanup.referenceCapturePath == $capturePath
     and (.artifactCleanup.temporaryPaths | index($captureTempPath) != null)' \
    "$guard_path/manifest.json" >/dev/null
  cp "$DATABASE_PATH" "$capture_temp_path"
  chmod 600 "$capture_temp_path"
  cp "$DATABASE_PATH" "$capture_reference_path"
  chmod 600 "$capture_reference_path"

  kill -KILL "$harness_pid"
  set +e
  wait "$harness_pid"
  killed_exit="$?"
  set -e
  assert_equal "$killed_exit" 137 "capture temp SIGKILL exit status"
  pkill -TERM -x Palate 2>/dev/null || true
  [[ -f "$capture_temp_path" && -f "$capture_reference_path" ]]
  [[ -d "$guard_path" ]]

  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard > "$recovery_log" 2>&1
  recovery_status="$?"
  set -e
  assert_equal "$recovery_status" 0 "capture temp stale-guard recovery exit status"
  rg -q '^RECOVERED_STALE_GUARD ' "$recovery_log"
  [[ ! -e "$capture_temp_path" && ! -e "$capture_reference_path" ]]
  [[ ! -e "$guard_path" ]]
  assert_restored_contract "capture temp stale-guard recovery"
}

run_sigkill_guard_case() {
  local output_directory="$TEMPORARY_DIRECTORY/sigkill-guard"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local corrupt_log="$output_directory/corrupt-recovery.log"
  local sync_log="$output_directory/sync-recovery.log"
  local removal_log="$output_directory/removal-recovery.log"
  local recovery_log="$output_directory/recovery.log"
  local post_removal_prefix="$output_directory/post-removal"
  local post_removal_harness_log="$output_directory/post-removal-harness.log"
  local post_removal_recovery_log="$output_directory/post-removal-recovery.log"
  local saved_manifest="$output_directory/manifest.saved.json"
  local harness_pid killed_exit guard_path recovery_status live_disposable_hash retained_snapshot
  local main_hash wal_hash shm_hash journal_hash main_mode wal_mode shm_mode journal_mode
  mkdir -p "$output_directory"
  guard_path="$DATABASE_PATH.palate-calendar-validation.guard"
  main_hash="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
  wal_hash="$(shasum -a 256 "$DATABASE_PATH-wal" | awk '{print $1}')"
  shm_hash="$(shasum -a 256 "$DATABASE_PATH-shm" | awk '{print $1}')"
  journal_hash="$(shasum -a 256 "$DATABASE_PATH-journal" | awk '{print $1}')"
  main_mode="$(stat -f '%Lp' "$DATABASE_PATH")"
  wal_mode="$(stat -f '%Lp' "$DATABASE_PATH-wal")"
  shm_mode="$(stat -f '%Lp' "$DATABASE_PATH-shm")"
  journal_mode="$(stat -f '%Lp' "$DATABASE_PATH-journal")"

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=hold
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --output-prefix="$output_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  kill -KILL "$harness_pid"
  set +e
  wait "$harness_pid"
  killed_exit="$?"
  set -e
  assert_equal "$killed_exit" 137 "SIGKILL guard exit status"
  pkill -TERM -x Palate 2>/dev/null || true

  [[ ! -e "$output_prefix.json" ]]
  [[ -d "$guard_path" && ! -L "$guard_path" ]]
  assert_mode "$guard_path" 700 "SIGKILL guard directory"
  assert_mode "$guard_path/main" 600 "SIGKILL guard main"
  assert_mode "$guard_path/manifest.json" 600 "SIGKILL guard manifest"
  jq -e \
    --arg databasePath "${DATABASE_PATH:A}" \
    '.schemaVersion == 1
     and .databasePath == $databasePath
     and .components.main.present
     and ((.components.main.sha256 | type) == "string")
     and .launchEnvironment.PALATE_CALENDAR_QUERY_STRATEGY.wasSet
     and .launchEnvironment.PALATE_CALENDAR_QUERY_STRATEGY.value == "preexisting-strategy"
     and (.launchEnvironment.PALATE_PHOTO_SCAN_STRATEGY.wasSet | not)
     and (.artifactCleanup.retainRawDatabases | not)' \
    "$guard_path/manifest.json" >/dev/null

  assert_equal \
    "$(launchctl getenv PALATE_CALENDAR_QUERY_STRATEGY)" \
    "sparse" \
    "SIGKILL leaves validation environment pending recovery"
  live_disposable_hash="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
  cp "$guard_path/manifest.json" "$saved_manifest"
  chmod 600 "$saved_manifest"
  jq --arg corruptHash "$(printf '0%.0s' {1..64})" \
    '.components.main.sha256 = $corruptHash' \
    "$saved_manifest" > "$guard_path/manifest.json.tmp"
  chmod 600 "$guard_path/manifest.json.tmp"
  mv -f -- "$guard_path/manifest.json.tmp" "$guard_path/manifest.json"
  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard > "$corrupt_log" 2>&1
  recovery_status="$?"
  set -e
  assert_equal "$recovery_status" 1 "corrupt stale guard recovery exit status"
  rg -q 'guard was retained' "$corrupt_log"
  [[ -d "$guard_path" ]]
  assert_equal \
    "$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')" \
    "$live_disposable_hash" \
    "corrupt guard refusal leaves the disposable live database untouched"
  cp "$saved_manifest" "$guard_path/manifest.json.tmp"
  chmod 600 "$guard_path/manifest.json.tmp"
  mv -f -- "$guard_path/manifest.json.tmp" "$guard_path/manifest.json"

  export PALATE_CALENDAR_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE=recovery-restored-database
  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard > "$sync_log" 2>&1
  recovery_status="$?"
  set -e
  unset PALATE_CALENDAR_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE
  assert_equal "$recovery_status" 1 "recovery sync failure exit status"
  rg -q 'Injected durability sync failure' "$sync_log"
  [[ -d "$guard_path" ]]

  export PALATE_CALENDAR_HARNESS_TEST_FAIL_GUARD_REMOVAL=1
  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard > "$removal_log" 2>&1
  recovery_status="$?"
  set -e
  unset PALATE_CALENDAR_HARNESS_TEST_FAIL_GUARD_REMOVAL
  assert_equal "$recovery_status" 1 "recovery guard removal failure exit status"
  rg -q 'Injected durable recovery guard removal failure' "$removal_log"
  [[ -d "$guard_path" ]]
  assert_restored_contract "recovery guard removal failure"

  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard > "$recovery_log" 2>&1
  recovery_status="$?"
  set -e
  assert_equal "$recovery_status" 0 "successful stale guard recovery exit status"
  rg -q '^RECOVERED_STALE_GUARD ' "$recovery_log"
  [[ ! -e "$guard_path" ]]
  assert_restored_contract "successful stale guard recovery"
  assert_equal "$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')" "$main_hash" "recovered main hash"
  assert_equal "$(shasum -a 256 "$DATABASE_PATH-wal" | awk '{print $1}')" "$wal_hash" "recovered WAL hash"
  assert_equal "$(shasum -a 256 "$DATABASE_PATH-shm" | awk '{print $1}')" "$shm_hash" "recovered SHM hash"
  assert_equal \
    "$(shasum -a 256 "$DATABASE_PATH-journal" | awk '{print $1}')" \
    "$journal_hash" \
    "recovered journal hash"
  assert_mode "$DATABASE_PATH" "$main_mode" "recovered main"
  assert_mode "$DATABASE_PATH-wal" "$wal_mode" "recovered WAL"
  assert_mode "$DATABASE_PATH-shm" "$shm_mode" "recovered SHM"
  assert_mode "$DATABASE_PATH-journal" "$journal_mode" "recovered journal"
  retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
  [[ -z "$retained_snapshot" ]]

  export PALATE_CALENDAR_HARNESS_FAKE_MODE=hold
  export PALATE_CALENDAR_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH="$post_removal_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --strategy=sparse \
    --gap-days=7.5 \
    --output-prefix="$post_removal_prefix" \
    --expected-visit-count=2 \
    --expected-calendar-link-count=2 \
    --timeout-seconds=5 \
    > "$post_removal_harness_log" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$post_removal_harness_log" "$harness_pid"
  kill -KILL "$harness_pid"
  set +e
  wait "$harness_pid"
  killed_exit="$?"
  set -e
  assert_equal "$killed_exit" 137 "post-removal sync fixture SIGKILL status"
  pkill -TERM -x Palate 2>/dev/null || true
  [[ -d "$guard_path" ]]

  export PALATE_CALENDAR_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE=recovery-guard-removed
  set +e
  zsh "$HARNESS_PATH" \
    --database="$DATABASE_PATH" \
    --recover-stale-guard \
    > "$post_removal_recovery_log" 2>&1
  recovery_status="$?"
  set -e
  unset PALATE_CALENDAR_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE
  assert_equal "$recovery_status" 1 "recovery post-removal sync failure exit status"
  rg -q 'durable guard deletion could not be confirmed' "$post_removal_recovery_log"
  rg -q 'guard is no longer present' "$post_removal_recovery_log"
  [[ ! -e "$guard_path" ]]
  assert_restored_contract "recovery post-removal sync failure"
  retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
  [[ -z "$retained_snapshot" ]]
}

run_exact_sidecar_signal_case() {
  local ready_path="$TEMPORARY_DIRECTORY/crash-wal.ready"
  local writer_log="$TEMPORARY_DIRECTORY/crash-wal.log"
  local writer_pid writer_exit
  local main_hash wal_hash shm_hash journal_hash
  rm -f -- "$ready_path" "$writer_log"

  sqlite3 "$DATABASE_PATH" > "$writer_log" 2>&1 <<SQL &
PRAGMA wal_autocheckpoint = 0;
BEGIN IMMEDIATE;
UPDATE app_metadata SET value = 'wal-guard-fixture' WHERE key = 'fixture-version';
COMMIT;
.shell /usr/bin/touch "$ready_path"
.shell /bin/sleep 30
SQL
  writer_pid="$!"
  for _ in {1..500}; do
    [[ -e "$ready_path" ]] && break
    kill -0 "$writer_pid" 2>/dev/null || break
    sleep 0.01
  done
  [[ -e "$ready_path" ]]
  kill -KILL "$writer_pid"
  set +e
  wait "$writer_pid"
  writer_exit="$?"
  set -e
  assert_equal "$writer_exit" 137 "crashed WAL writer exit status"
  [[ -s "$DATABASE_PATH-wal" && -s "$DATABASE_PATH-shm" ]]
  touch "$DATABASE_PATH-journal"

  main_hash="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
  wal_hash="$(shasum -a 256 "$DATABASE_PATH-wal" | awk '{print $1}')"
  shm_hash="$(shasum -a 256 "$DATABASE_PATH-shm" | awk '{print $1}')"
  journal_hash="$(shasum -a 256 "$DATABASE_PATH-journal" | awk '{print $1}')"
  ORIGINAL_DATABASE_SHA256="$main_hash"

  run_case exact-sidecars-signal hold 143 live-snapshot legacy

  assert_equal "$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')" "$main_hash" "exact sidecar main hash"
  assert_equal "$(shasum -a 256 "$DATABASE_PATH-wal" | awk '{print $1}')" "$wal_hash" "exact sidecar WAL hash"
  assert_equal "$(shasum -a 256 "$DATABASE_PATH-shm" | awk '{print $1}')" "$shm_hash" "exact sidecar SHM hash"
  assert_equal \
    "$(shasum -a 256 "$DATABASE_PATH-journal" | awk '{print $1}')" \
    "$journal_hash" \
    "exact sidecar journal hash"
}

help_output="$(zsh "$HARNESS_PATH" --help)"
[[ "$help_output" == *"--photo-scan-strategy=VALUE"* ]]
[[ "$help_output" == *"--capture-reference-database=PATH"* ]]
[[ "$help_output" == *"--capture-expected-calendar-link-count=N"* ]]
[[ "$help_output" == *"--allow-reference-fixture-growth"* ]]
[[ "$help_output" == *"--recover-stale-guard"* ]]
run_invalid_capture_configuration_case \
  capture-with-explicit-reference \
  explicit-reference \
  '--capture-reference-database is incompatible with --reference-database'
run_invalid_capture_configuration_case \
  capture-with-legacy \
  legacy \
  '--capture-reference-database requires an incremental Photo scan'
run_invalid_capture_configuration_case \
  capture-with-empty-path \
  empty-path \
  '--capture-reference-database requires a nonempty output path'
run_invalid_capture_configuration_case \
  capture-target-without-capture \
  capture-target-without-capture \
  '--capture-expected-calendar-link-count requires --capture-reference-database'
run_invalid_capture_configuration_case \
  capture-target-below-baseline \
  capture-target-below-baseline \
  '--capture-expected-calendar-link-count must not be below --expected-calendar-link-count'
run_invalid_capture_configuration_case \
  reference-growth-without-reference \
  reference-growth-without-reference \
  '--allow-reference-fixture-growth requires --reference-database'
run_invalid_capture_configuration_case \
  reference-growth-legacy \
  reference-growth-legacy \
  '--allow-reference-fixture-growth requires an incremental Photo scan'
for invalid_photo_scan_strategy in "" unknown INCREMENTAL; do
  run_invalid_photo_scan_strategy_case "$invalid_photo_scan_strategy"
done

run_case success success 0 live-snapshot incremental database-backed
run_case retained-success success 0 live-snapshot incremental database-backed 1
run_case legacy-scan success 0 live-snapshot legacy legacy
run_case omitted-with-set-original success 0
run_photo_scan_process_mismatch_case
run_case photo-attestation-mismatch photo-attestation-mismatch 1 live-snapshot incremental
run_case \
  photo-implementation-mismatch \
  photo-implementation-mismatch \
  1 \
  live-snapshot \
  incremental \
  database-backed
run_case explicit-reference reference-success 0 explicit incremental database-backed 1
run_case capture-success capture-success 0 live-snapshot incremental database-backed 0 1
run_case capture-subset-mismatch capture-subset-mismatch 1 live-snapshot incremental database-backed 0 1
run_case capture-count-mismatch capture-count-mismatch 1 live-snapshot incremental database-backed 0 1
run_capture_growth_case capture-growth-success capture-growth-success 0
run_capture_growth_case capture-growth-baseline-mismatch capture-growth-baseline-mismatch 1
run_growth_reference_requires_flag_case
run_growth_reference_case growth-reference-success growth-reference-success 0
run_growth_reference_case growth-reference-mismatch growth-reference-mismatch 1
run_reference_photo_preflight_failure_case \
  reference-higher-photo-legacy \
  "$REFERENCE_DATABASE_PATH" \
  "$REFERENCE_DATABASE_SHA256" \
  legacy \
  legacy
run_reference_photo_preflight_failure_case \
  reference-lower-photo-incremental \
  "$LOWER_PHOTO_REFERENCE_DATABASE_PATH" \
  "$LOWER_PHOTO_REFERENCE_DATABASE_SHA256" \
  incremental \
  database-backed
run_reference_photo_attestation_mismatch_case
run_case parity-failure parity-failure 1 live-snapshot incremental
run_invalid_reference_case
run_concurrent_lock_case
set_original_photo_scan_environment absent
run_case omitted-with-absent-original success 0
run_interrupted_restore_failure_case \
  restore-sync-failure \
  PALATE_CALENDAR_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE \
  restore-database \
  'Failed to durably synchronize the restored database'
run_interrupted_restore_failure_case \
  guard-removal-failure \
  PALATE_CALENDAR_HARNESS_TEST_FAIL_GUARD_REMOVAL \
  1 \
  'Failed to remove the durable database recovery guard'
run_interrupted_restore_failure_case \
  guard-removal-sync-failure \
  PALATE_CALENDAR_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE \
  guard-removed \
  'durable guard deletion could not be confirmed' \
  0
run_default_raw_cleanup_failure_case
run_capture_post_restore_failure_case
run_capture_sigkill_temp_cleanup_case
run_exact_sidecar_signal_case
run_sigkill_guard_case

print "macOS Calendar query harness contract tests passed: photo-scan A/B attestation, strict and bootstrap-growth reference capture, exact growth-reference replay, aggregate-only privacy, exact restoration, concurrent lock rejection, explicit SIGKILL recovery, corruption refusal, launch-environment recovery, and injected restore/removal/post-removal-sync/cleanup failure propagation."

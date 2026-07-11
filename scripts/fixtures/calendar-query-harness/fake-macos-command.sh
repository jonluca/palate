#!/bin/zsh
set -euo pipefail

# Test-only command multiplexer for test-macos-calendar-query-harness.sh.
# Symlink this file as launchctl/open/pgrep/pkill/ps/lsof/codesign inside an isolated PATH.

STATE_DIRECTORY="${PALATE_CALENDAR_HARNESS_FAKE_STATE:?Missing fake state directory}"
HELPER_PATH="${PALATE_CALENDAR_HARNESS_FAKE_HELPER:?Missing fake helper path}"
COMMAND_NAME="${0:t}"

state_path() {
  local key="$1"
  if [[ ! "$key" =~ '^[A-Z0-9_]+$' ]]; then
    print -u2 "Invalid fake environment key: $key"
    return 2
  fi
  print -r -- "$STATE_DIRECTORY/environment/$key"
}

read_state_value() {
  local environment_path
  environment_path="$(state_path "$1")"
  [[ -f "$environment_path" ]] || return 1
  print -rn -- "$(< "$environment_path")"
}

print_environment_if_present() {
  local key="$1"
  local environment_path
  environment_path="$(state_path "$key")"
  if [[ -f "$environment_path" ]]; then
    print -n -- " $key=$(< "$environment_path")"
  fi
}

simulate_palate() {
  trap 'exit 0' INT TERM HUP

  local run_id strategy gap_days attestation_path attestation_temp_path
  run_id="$(read_state_value PALATE_CALENDAR_VALIDATION_RUN_ID)"
  strategy="$(read_state_value PALATE_CALENDAR_QUERY_STRATEGY)"
  gap_days="$(read_state_value PALATE_CALENDAR_QUERY_GAP_DAYS)"
  attestation_path="$(read_state_value PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH)"
  attestation_temp_path="$attestation_path.tmp"

  jq -n \
    --arg runId "$run_id" \
    --arg strategy "$strategy" \
    --argjson gapDays "$gap_days" \
    '{schemaVersion: 1, runId: $runId, resolvedStrategy: $strategy, resolvedGapDays: $gapDays}' \
    > "$attestation_temp_path"
  mv -f -- "$attestation_temp_path" "$attestation_path"

  if [[ "${PALATE_CALENDAR_HARNESS_FAKE_MODE:-success}" == "hold" ]]; then
    while true; do
      sleep 0.05
    done
  fi

  while [[ ! -s "${PALATE_CALENDAR_HARNESS_FAKE_TRIGGER_PATH:?Missing fake trigger path}" ]]; do
    sleep 0.02
  done

  local photo_run_id photo_attestation_path configured_photo_strategy resolved_photo_strategy
  local selected_scan_kind unknown_visible_count excluded_visible_count library_total_count
  local fake_mode="${PALATE_CALENDAR_HARNESS_FAKE_MODE:-success}"
  photo_run_id="$(read_state_value PALATE_PHOTO_SCAN_VALIDATION_RUN_ID)"
  photo_attestation_path="$(read_state_value PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH)"
  configured_photo_strategy=""
  resolved_photo_strategy="incremental"
  if configured_photo_strategy="$(read_state_value PALATE_PHOTO_SCAN_STRATEGY 2>/dev/null)"; then
    resolved_photo_strategy="$configured_photo_strategy"
  fi
  selected_scan_kind="$resolved_photo_strategy"
  if [[ "$fake_mode" == "photo-attestation-mismatch" ]]; then
    selected_scan_kind="legacy"
  fi
  library_total_count=2
  if [[ "$fake_mode" == "reference-success" \
    || "$fake_mode" == "reference-photo-attestation-mismatch" \
    || "$fake_mode" == capture-* \
    || "$fake_mode" == growth-reference-* ]]; then
    library_total_count=3
  fi
  if [[ "$selected_scan_kind" == "legacy" ]]; then
    unknown_visible_count="$library_total_count"
    excluded_visible_count=0
  elif [[ "$fake_mode" == "reference-success" \
    || "$fake_mode" == capture-* \
    || "$fake_mode" == growth-reference-* ]]; then
    unknown_visible_count=1
    excluded_visible_count=2
  elif [[ "$fake_mode" == "reference-photo-attestation-mismatch" ]]; then
    unknown_visible_count=0
    excluded_visible_count=3
  else
    unknown_visible_count=0
    excluded_visible_count=2
  fi
  local selected_scan_implementation="database-backed"
  if [[ "$selected_scan_kind" == "legacy" ]]; then
    selected_scan_implementation="legacy"
  fi
  if [[ "$fake_mode" == "photo-implementation-mismatch" ]]; then
    selected_scan_implementation="identifier-list"
  fi
  local configured_photo_strategy_json=null
  if [[ -n "$configured_photo_strategy" ]]; then
    configured_photo_strategy_json="\"$configured_photo_strategy\""
  fi
  jq -n \
    --arg runId "$photo_run_id" \
    --argjson configuredPhotoScanStrategy "$configured_photo_strategy_json" \
    --arg resolvedPhotoScanStrategy "$resolved_photo_strategy" \
    --arg selectedScanKind "$selected_scan_kind" \
    --arg selectedScanImplementation "$selected_scan_implementation" \
    --argjson libraryTotalCount "$library_total_count" \
    --argjson unknownVisibleCount "$unknown_visible_count" \
    --argjson excludedVisibleCount "$excluded_visible_count" \
    --argjson observedAtEpochSeconds "$(date +%s.%N)" \
    '{
      schemaVersion: 2,
      runId: $runId,
      configuredPhotoScanStrategy: $configuredPhotoScanStrategy,
      resolvedPhotoScanStrategy: $resolvedPhotoScanStrategy,
      selectedScanKind: $selectedScanKind,
      selectedScanImplementation: $selectedScanImplementation,
      libraryTotalCount: $libraryTotalCount,
      unknownVisibleCount: $unknownVisibleCount,
      excludedVisibleCount: $excludedVisibleCount,
      excludedPhotosWithLocation: (if $selectedScanKind == "incremental" then 2 else 0 end),
      excludedSkippedAssets: 0,
      observedAtEpochSeconds: $observedAtEpochSeconds
    }' > "$photo_attestation_path.tmp"
  mv -f -- "$photo_attestation_path.tmp" "$photo_attestation_path"

  local first_title="Dinner A"
  if [[ "$fake_mode" == "parity-failure" ]]; then
    first_title="Incorrect title"
  elif [[ "$fake_mode" == "reference-success" ]]; then
    first_title="Reference Dinner A"
  elif [[ "$fake_mode" == "capture-growth-success" \
    || "$fake_mode" == "capture-growth-baseline-mismatch" \
    || "$fake_mode" == "growth-reference-success" ]]; then
    first_title="Growth Dinner A"
  elif [[ "$fake_mode" == "growth-reference-mismatch" ]]; then
    first_title="Incorrect growth title"
  fi

  if [[ "$fake_mode" == "reference-success" ]]; then
    sqlite3 "${PALATE_CALENDAR_HARNESS_FAKE_DATABASE:?Missing fake database path}" <<'SQL'
INSERT OR IGNORE INTO photos (
  id, uri, creationTime, latitude, longitude, visitId, foodDetected,
  foodLabels, foodConfidence, allLabels, mediaType, duration
) VALUES (
  'photo-reference-only', 'asset-reference-only', 4500, 37.3, -122.3,
  NULL, NULL, NULL, NULL, NULL, 'photo', NULL
);
SQL
  fi

  if [[ "$fake_mode" == "capture-success" || "$fake_mode" == "capture-subset-mismatch" ]]; then
    sqlite3 "${PALATE_CALENDAR_HARNESS_FAKE_DATABASE:?Missing fake database path}" <<'SQL'
INSERT OR IGNORE INTO photos (
  id, uri, creationTime, latitude, longitude, visitId, foodDetected,
  foodLabels, foodConfidence, allLabels, mediaType, duration
) VALUES (
  'photo-capture-only', 'asset-capture-only', 4500, 37.3, -122.3,
  NULL, NULL, NULL, NULL, NULL, 'photo', NULL
);
SQL
  fi
  if [[ "$fake_mode" == "capture-subset-mismatch" ]]; then
    sqlite3 "${PALATE_CALENDAR_HARNESS_FAKE_DATABASE:?Missing fake database path}" \
      "UPDATE photos SET uri = 'incorrect-original-uri' WHERE id = 'photo-a';"
  fi

  if [[ "$fake_mode" == "capture-growth-success" \
    || "$fake_mode" == "capture-growth-baseline-mismatch" \
    || "$fake_mode" == "growth-reference-success" \
    || "$fake_mode" == "growth-reference-mismatch" ]]; then
    sqlite3 "${PALATE_CALENDAR_HARNESS_FAKE_DATABASE:?Missing fake database path}" <<'SQL'
INSERT OR IGNORE INTO visits (
  id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
  centerLat, centerLon, photoCount, foodProbable, calendarEventId,
  calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
  notes, updatedAt, exportedToCalendarId, awardAtVisit
) VALUES (
  'visit-c', NULL, 'restaurant-c', 'pending', 5000, 6000,
  37.3, -122.3, 1, 1, 'event-c', 'Dinner C', 'Location C', 0,
  NULL, 30, NULL, NULL
);
INSERT OR IGNORE INTO photos (
  id, uri, creationTime, latitude, longitude, visitId, foodDetected,
  foodLabels, foodConfidence, allLabels, mediaType, duration
) VALUES (
  'photo-growth-only', 'asset-growth-only', 5500, 37.3, -122.3,
  'visit-c', 1, '["food"]', 0.8, '["food"]', 'photo', NULL
);
INSERT OR IGNORE INTO visit_suggested_restaurants
VALUES ('visit-c', 'restaurant-c', 30.5);
SQL
  fi
  if [[ "$fake_mode" == "capture-growth-baseline-mismatch" ]]; then
    sqlite3 "${PALATE_CALENDAR_HARNESS_FAKE_DATABASE:?Missing fake database path}" <<'SQL'
UPDATE visits SET notes = 'incorrect original note' WHERE id = 'visit-a';
DELETE FROM visit_suggested_restaurants
WHERE visitId = 'visit-a' AND restaurantId = 'restaurant-a';
INSERT OR IGNORE INTO visit_suggested_restaurants
VALUES ('visit-c', 'restaurant-extra', 31.5);
SQL
  fi

  sqlite3 "${PALATE_CALENDAR_HARNESS_FAKE_DATABASE:?Missing fake database path}" <<SQL
BEGIN IMMEDIATE;
UPDATE visits
SET calendarEventId = CASE id
      WHEN 'visit-a' THEN 'event-a'
      WHEN 'visit-b' THEN 'event-b'
    END,
    calendarEventTitle = CASE id
      WHEN 'visit-a' THEN '$first_title'
      WHEN 'visit-b' THEN 'Lunch B'
    END,
    calendarEventLocation = CASE id
      WHEN 'visit-a' THEN 'Location A'
      WHEN 'visit-b' THEN NULL
    END,
    calendarEventIsAllDay = 0
WHERE id IN ('visit-a', 'visit-b');
COMMIT;
SQL

  while true; do
    sleep 0.05
  done
}

if [[ "$COMMAND_NAME" == "fake-macos-command.sh" && "${1:-}" == "__simulate__" ]]; then
  simulate_palate
  exit 0
fi

case "$COMMAND_NAME" in
  launchctl)
    subcommand="${1:-}"
    key="${2:-}"
    case "$subcommand" in
      getenv)
        environment_path="$(state_path "$key")"
        if [[ -f "$environment_path" ]]; then
          print -r -- "$(< "$environment_path")"
        fi
        ;;
      setenv)
        environment_path="$(state_path "$key")"
        value="${3-}"
        mkdir -p "$STATE_DIRECTORY/environment"
        print -rn -- "$value" > "$environment_path.tmp"
        mv -f -- "$environment_path.tmp" "$environment_path"
        ;;
      unsetenv)
        environment_path="$(state_path "$key")"
        rm -f -- "$environment_path" "$environment_path.tmp"
        ;;
      print)
        print "environment = {"
        for environment_file in "$STATE_DIRECTORY"/environment/*(N); do
          print "  ${environment_file:t} => $(< "$environment_file")"
        done
        print "}"
        ;;
      *)
        print -u2 "Unsupported fake launchctl command: $subcommand"
        exit 2
        ;;
    esac
    ;;

  open)
    mkdir -p "$STATE_DIRECTORY"
    nohup "$HELPER_PATH" __simulate__ \
      > "$STATE_DIRECTORY/simulator.log" \
      2>&1 \
      9>&- &
    simulator_pid="$!"
    disown "$simulator_pid" 2>/dev/null || true
    print -r -- "$simulator_pid" > "$STATE_DIRECTORY/pid.tmp"
    mv -f -- "$STATE_DIRECTORY/pid.tmp" "$STATE_DIRECTORY/pid"
    ;;

  pgrep)
    if [[ -f "$STATE_DIRECTORY/pid" ]]; then
      simulator_pid="$(< "$STATE_DIRECTORY/pid")"
      if kill -0 "$simulator_pid" 2>/dev/null; then
        print -r -- "$simulator_pid"
        exit 0
      fi
    fi
    exit 1
    ;;

  pkill)
    if [[ -f "$STATE_DIRECTORY/pid" ]]; then
      simulator_pid="$(< "$STATE_DIRECTORY/pid")"
      if kill -0 "$simulator_pid" 2>/dev/null; then
        kill -TERM "$simulator_pid" 2>/dev/null || true
        for _ in {1..100}; do
          kill -0 "$simulator_pid" 2>/dev/null || break
          sleep 0.01
        done
      fi
      rm -f -- "$STATE_DIRECTORY/pid"
    fi
    ;;

  ps)
    arguments=" $* "
    if [[ "$arguments" == *" command= "* ]]; then
      print -n -- "Palate"
      for key in \
        PALATE_CALENDAR_QUERY_STRATEGY \
        PALATE_CALENDAR_QUERY_GAP_DAYS \
        PALATE_CALENDAR_VALIDATION_RUN_ID \
        PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH \
        PALATE_PHOTO_SCAN_VALIDATION_RUN_ID \
        PALATE_PHOTO_SCAN_VALIDATION_ATTESTATION_PATH; do
        print -n -- " $key=$(read_state_value "$key")"
      done
      if [[ "${PALATE_CALENDAR_HARNESS_FAKE_MODE:-success}" == "photo-scan-mismatch" ]]; then
        print -n -- " PALATE_PHOTO_SCAN_STRATEGY=legacy"
      else
        print_environment_if_present PALATE_PHOTO_SCAN_STRATEGY
      fi
      print
    elif [[ "$arguments" == *" rss= "* ]]; then
      print "123456"
    elif [[ "$arguments" == *" ppid= "* ]]; then
      print "1"
    elif [[ "$arguments" == *" comm= "* ]]; then
      print "/sbin/launchd"
    else
      print -u2 "Unsupported fake ps invocation: $*"
      exit 2
    fi
    ;;

  lsof)
    arguments=" $* "
    if [[ "$arguments" == *" -a "* && "$arguments" == *" -p "* ]]; then
      print "p${3:-0}"
      print "n${PALATE_CALENDAR_HARNESS_FAKE_APP:?Missing fake app path}/Palate"
    else
      exit 1
    fi
    ;;

  codesign)
    exit 0
    ;;

  *)
    print -u2 "Unsupported fake command name: $COMMAND_NAME"
    exit 2
    ;;
esac

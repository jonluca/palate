#!/bin/zsh
set -euo pipefail

# Test-only command multiplexer for test-macos-vision-result-page-harness.sh.
# Symlink this file as codesign/launchctl/lsof/open/pgrep/pkill/ps inside an isolated PATH.

STATE_DIRECTORY="${PALATE_VISION_PAGE_HARNESS_FAKE_STATE:?Missing fake state directory}"
HELPER_PATH="${PALATE_VISION_PAGE_HARNESS_FAKE_HELPER:?Missing fake helper path}"
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

fake_codesign_value() {
  local app_path="$1"
  local marker_name="$2"
  local default_value="$3"
  local marker_path="$app_path/$marker_name"
  if [[ -f "$marker_path" ]]; then
    print -rn -- "$(< "$marker_path")"
  else
    print -rn -- "$default_value"
  fi
}

print_environment_if_present() {
  local key="$1"
  local environment_path
  environment_path="$(state_path "$key")"
  if [[ -f "$environment_path" ]]; then
    print -n -- " $key=$(< "$environment_path")"
  fi
}

write_result_transport_attestation() {
  local mode="${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}"
  local requested_asset_count="$1"
  local native_batch_count="$2"
  if [[ "$mode" == "native-attestation-missing" ]]; then
    return 0
  fi

  local attestation_path run_id configured_transport resolved_transport selected_transport
  attestation_path="$(read_state_value PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH)"
  run_id="$(read_state_value PALATE_VISION_VALIDATION_RUN_ID)"
  configured_transport="$(read_state_value PALATE_VISION_RESULT_TRANSPORT)"
  resolved_transport="$configured_transport"
  selected_transport="$resolved_transport"
  if [[ "$mode" == "native-attestation-mismatch" ]]; then
    if [[ "$selected_transport" == "legacy" ]]; then
      selected_transport="packed-v1"
    else
      selected_transport="legacy"
    fi
  fi

  local observed_epoch
  observed_epoch="$(date +%s.%N)"
  if [[ "$mode" == "native-attestation-v1" ]]; then
    jq -n \
      --arg runId "$run_id" \
      --arg configuredResultTransport "$configured_transport" \
      --arg resolvedResultTransport "$resolved_transport" \
      --arg selectedResultTransport "$selected_transport" \
      --argjson observedAtEpochSeconds "$observed_epoch" \
      '{
        schemaVersion: 1,
        runId: $runId,
        configuredResultTransport: $configuredResultTransport,
        resolvedResultTransport: $resolvedResultTransport,
        selectedResultTransport: $selectedResultTransport,
        observedAtEpochSeconds: $observedAtEpochSeconds
      }' > "$attestation_path.tmp"
    chmod 600 "$attestation_path.tmp"
    mv -f -- "$attestation_path.tmp" "$attestation_path"
    return 0
  fi

  local in_flight_batch_count=0
  local in_flight_requested_asset_count=0
  if [[ "$mode" == "native-work-asset-mismatch" ]]; then
    requested_asset_count=$(( requested_asset_count + 1 ))
  elif [[ "$mode" == "native-work-batch-mismatch" ]]; then
    native_batch_count=$(( native_batch_count + 1 ))
  elif [[ "$mode" == "native-work-unbalanced" ]]; then
    in_flight_batch_count=1
    in_flight_requested_asset_count=1
  fi

  jq -n \
    --arg runId "$run_id" \
    --arg configuredResultTransport "$configured_transport" \
    --arg resolvedResultTransport "$resolved_transport" \
    --arg selectedResultTransport "$selected_transport" \
    --argjson observedAtEpochSeconds "$observed_epoch" \
    --argjson batchCount "$native_batch_count" \
    --argjson requestedAssetCount "$requested_asset_count" \
    --argjson inFlightBatchCount "$in_flight_batch_count" \
    --argjson inFlightRequestedAssetCount "$in_flight_requested_asset_count" \
    '{
      schemaVersion: 2,
      runId: $runId,
      configuredResultTransport: $configuredResultTransport,
      resolvedResultTransport: $resolvedResultTransport,
      selectedResultTransport: $selectedResultTransport,
      observedAtEpochSeconds: $observedAtEpochSeconds,
      lastObservedAtEpochSeconds: $observedAtEpochSeconds,
      startedBatchCount: $batchCount,
      startedRequestedAssetCount: $requestedAssetCount,
      completedBatchCount: $batchCount,
      completedRequestedAssetCount: $requestedAssetCount,
      resolvedBatchCount: $batchCount,
      resolvedRequestedAssetCount: $requestedAssetCount,
      rejectedBatchCount: 0,
      rejectedRequestedAssetCount: 0,
      cancelledBatchCount: 0,
      cancelledRequestedAssetCount: 0,
      inFlightBatchCount: $inFlightBatchCount,
      inFlightRequestedAssetCount: $inFlightRequestedAssetCount
    }' > "$attestation_path.tmp"
  chmod 600 "$attestation_path.tmp"
  mv -f -- "$attestation_path.tmp" "$attestation_path"
}

simulate_palate() {
  trap 'exit 0' INT TERM HUP
  local trigger_path="${PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER:?Missing fake trigger path}"
  while [[ ! -s "$trigger_path" ]]; do
    sleep 0.01
  done

  local database_path="${PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE:?Missing fake database path}"
  local mode="${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}"
  local visit_food_detection_strategy page_size requested_asset_count native_batch_count
  visit_food_detection_strategy="$(read_state_value PALATE_VISIT_FOOD_DETECTION_STRATEGY)"
  page_size="$(read_state_value PALATE_VISION_RESULT_PAGE_SIZE)"
  requested_asset_count="$(sqlite3 "$database_path" 'SELECT COUNT(*) FROM photos WHERE foodDetected IS NULL;')"
  if [[ "$visit_food_detection_strategy" == "rank3-bulk-tail-v1" \
    && "$mode" != "rank3-full-plan-bypass-real-scale" ]]; then
    requested_asset_count=12
    native_batch_count=$((
      (4 + page_size - 1) / page_size
      + (3 + page_size - 1) / page_size
      + (3 + page_size - 1) / page_size
      + (2 + page_size - 1) / page_size
    ))
  else
    native_batch_count=$(( (requested_asset_count + page_size - 1) / page_size ))
  fi
  write_result_transport_attestation "$requested_asset_count" "$native_batch_count"

  if [[ "$mode" == "rank3-full-plan-bypass-real-scale" ]]; then
    # Simulate the historical strategy-bypassing UI path on the real workload
    # shape: all 13,059 rows are dispatched and written even though the rank-3
    # plan calls for 11,439 attempts and 1,620 untouched rows.
    sqlite3 "$database_path" <<'SQL'
BEGIN IMMEDIATE;
UPDATE photos
SET foodDetected = CASE WHEN id = 'large-positive-p00001' THEN 1 ELSE 0 END,
    foodLabels = CASE
      WHEN id = 'large-positive-p00001' THEN '[{"label":"food","confidence":0.9}]'
      ELSE '[]'
    END,
    foodConfidence = CASE WHEN id = 'large-positive-p00001' THEN 0.9 ELSE NULL END,
    allLabels = CASE
      WHEN id = 'large-positive-p00001' THEN '[{"label":"food","confidence":0.9}]'
      ELSE '[{"label":"other","confidence":0.8}]'
    END;
UPDATE visits
SET foodProbable = CASE WHEN id = 'large-positive' THEN 1 ELSE 0 END;
COMMIT;
SQL
  elif [[ "$visit_food_detection_strategy" == "rank3-bulk-tail-v1" ]]; then
    sqlite3 "$database_path" <<'SQL'
BEGIN IMMEDIATE;
UPDATE photos
SET foodDetected = CASE
      WHEN id IN ('candidate-v1-p1', 'candidate-v2-p3', 'candidate-v3-p4') THEN 1
      ELSE 0
    END,
    foodLabels = CASE
      WHEN id IN ('candidate-v1-p1', 'candidate-v2-p3', 'candidate-v3-p4')
        THEN '[{"label":"food","confidence":0.9}]'
      ELSE '[]'
    END,
    foodConfidence = CASE
      WHEN id IN ('candidate-v1-p1', 'candidate-v2-p3', 'candidate-v3-p4') THEN 0.9
      ELSE NULL
    END,
    allLabels = CASE
      WHEN id IN ('candidate-v1-p1', 'candidate-v2-p3', 'candidate-v3-p4')
        THEN '[{"label":"food","confidence":0.9}]'
      ELSE '[{"label":"other","confidence":0.8}]'
    END
WHERE id IN (
  'candidate-v1-p1',
  'candidate-v2-p1', 'candidate-v2-p3',
  'candidate-v3-p1', 'candidate-v3-p2', 'candidate-v3-p3', 'candidate-v3-p4',
  'candidate-v4-p1', 'candidate-v4-p2', 'candidate-v4-p3'
);
UPDATE visits
SET foodProbable = CASE WHEN id IN ('candidate-v1', 'candidate-v2', 'candidate-v3') THEN 1 ELSE 0 END;
COMMIT;
SQL
    if [[ "$mode" == "candidate-skipped-write" ]]; then
      sqlite3 "$database_path" <<'SQL'
UPDATE photos
SET foodDetected = 0,
    foodLabels = '[]',
    foodConfidence = NULL,
    allLabels = '[{"label":"other","confidence":0.8}]'
WHERE id = 'candidate-v1-p2';
SQL
    fi
  else
    sqlite3 "$database_path" <<'SQL'
BEGIN IMMEDIATE;
UPDATE photos
SET foodDetected = 1,
    foodLabels = '[{"label":"food","confidence":0.9}]',
    foodConfidence = 0.9,
    allLabels = '[{"label":"food","confidence":0.9}]'
WHERE id = 'photo-1';
UPDATE visits SET foodProbable = 1 WHERE id = 'visit-1';
COMMIT;
SQL
  fi

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
        [[ -f "$environment_path" ]] && print -r -- "$(< "$environment_path")"
        ;;
      setenv)
        environment_path="$(state_path "$key")"
        mkdir -p "$STATE_DIRECTORY/environment"
        print -rn -- "${3-}" > "$environment_path.tmp"
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
    nohup "$HELPER_PATH" __simulate__ 9>&- > "$STATE_DIRECTORY/simulator.log" 2>&1 &
    simulator_pid="$!"
    disown "$simulator_pid" 2>/dev/null || true
    print -r -- "$simulator_pid" > "$STATE_DIRECTORY/pid.tmp"
    mv -f -- "$STATE_DIRECTORY/pid.tmp" "$STATE_DIRECTORY/pid"
    ;;

  codesign)
    codesign_app_path="${@[-1]}"
    codesign_display=0
    codesign_requirement=0
    for codesign_argument in "$@"; do
      case "$codesign_argument" in
        -d|--display) codesign_display=1 ;;
        -r-) codesign_requirement=1 ;;
      esac
    done
    if (( codesign_requirement )); then
      codesign_designated_requirement="$(fake_codesign_value \
        "$codesign_app_path" \
        .fake-codesign-designated-requirement \
        'identifier "com.jonluca.photo-restaurant-matcher" and anchor apple generic and certificate leaf[subject.OU] = "F35YQQ5672"')"
      print -u2 -- "Executable=$codesign_app_path/Palate"
      print -u2 -- "designated => $codesign_designated_requirement"
    elif (( codesign_display )); then
      codesign_identifier="$(fake_codesign_value \
        "$codesign_app_path" \
        .fake-codesign-identifier \
        com.jonluca.photo-restaurant-matcher)"
      codesign_team_identifier="$(fake_codesign_value \
        "$codesign_app_path" \
        .fake-codesign-team-identifier \
        F35YQQ5672)"
      print -u2 -- "Executable=$codesign_app_path/Palate"
      print -u2 -- "Identifier=$codesign_identifier"
      print -u2 -- "TeamIdentifier=$codesign_team_identifier"
    fi
    exit 0
    ;;

  lsof)
    arguments=" $* "
    if [[ "$arguments" == *" -d txt "* ]]; then
      running_app="${PALATE_VISION_PAGE_HARNESS_FAKE_RUNNING_APP:-${PALATE_VISION_PAGE_HARNESS_FAKE_APP:?Missing fake app path}}"
      print "p${PALATE_VISION_PAGE_HARNESS_FAKE_PROCESS_PID:-4242}"
      print "n$running_app/Palate"
      exit 0
    fi
    # No process owns isolated fixture database files.
    exit 1
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
      if [[ "${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}" == "pretrigger-mutation" ]]; then
        sqlite3 "${PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE:?Missing fake database path}" \
          "UPDATE photos SET foodDetected = 1 WHERE id = 'photo-1';"
      fi
      print -n -- "Palate"
      print_environment_if_present PALATE_VISION_RESULT_PAGE_SIZE
      if [[ "${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}" == "result-transport-mismatch" ]]; then
        if [[ "$(read_state_value PALATE_VISION_RESULT_TRANSPORT)" == "legacy" ]]; then
          print -n -- " PALATE_VISION_RESULT_TRANSPORT=packed-v1"
        else
          print -n -- " PALATE_VISION_RESULT_TRANSPORT=legacy"
        fi
      else
        print_environment_if_present PALATE_VISION_RESULT_TRANSPORT
      fi
      if [[ "${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}" == "attestation-path-mismatch" ]]; then
        print -n -- " PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH=/tmp/wrong-vision-result-transport-attestation"
      else
        print_environment_if_present PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH
      fi
      print_environment_if_present PALATE_VISION_VALIDATION_RUN_ID
      if [[ "${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}" == "classification-mismatch" ]]; then
        print -n -- " PALATE_VISION_CLASSIFICATION_STRATEGY=baseline"
      fi
      if [[ "${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}" == "visit-food-strategy-mismatch" ]]; then
        if [[ "$(read_state_value PALATE_VISIT_FOOD_DETECTION_STRATEGY)" == "full-plan-v1" ]]; then
          print -n -- " PALATE_VISIT_FOOD_DETECTION_STRATEGY=rank3-bulk-tail-v1"
        else
          print -n -- " PALATE_VISIT_FOOD_DETECTION_STRATEGY=full-plan-v1"
        fi
      else
        print_environment_if_present PALATE_VISIT_FOOD_DETECTION_STRATEGY
      fi
      if [[ "${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}" == "orchestration-mismatch" ]]; then
        print -n -- " PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY=serial"
      else
        print_environment_if_present PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY
      fi
      if [[ "${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}" == "concurrency-mismatch" ]]; then
        print -n -- " PALATE_VISION_CONCURRENCY=16"
      else
        print_environment_if_present PALATE_VISION_CONCURRENCY
      fi
      if [[ "${PALATE_VISION_PAGE_HARNESS_FAKE_MODE:-success}" == "pipeline-depth-mismatch" ]]; then
        print -n -- " PALATE_VISION_PIPELINE_DEPTH=64"
      else
        print_environment_if_present PALATE_VISION_PIPELINE_DEPTH
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

  *)
    print -u2 "Unsupported fake command name: $COMMAND_NAME"
    exit 2
    ;;
esac

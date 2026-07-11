#!/bin/zsh
set -euo pipefail

# Test-only command multiplexer. The isolated harness symlinks this file as
# codesign/lsof/open/pgrep/pkill/ps and never places it in a production path.

STATE_DIRECTORY="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_STATE:?Missing fake state directory}"
HELPER_PATH="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_HELPER:?Missing fake helper path}"
COMMAND_NAME="${0:t}"

simulate_palate() {
  trap 'exit 0' INT TERM HUP
  local trigger="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_TRIGGER:?Missing fake trigger}"
  local database="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_DATABASE:?Missing fake database}"
  local run_id="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_RUN_ID:?Missing fake run ID}"
  local strategy="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_STRATEGY:?Missing fake strategy}"
  local dataset_version="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_DATASET_VERSION:?Missing fake dataset version}"
  local guide="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_GUIDE:?Missing fake guide}"
  local reference="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_REFERENCE:?Missing fake materialized reference}"
  local node="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_NODE:?Missing fake Node}"
  local oracle_helper="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_ORACLE_HELPER:?Missing fake oracle helper}"
  local mode="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_MODE:-success}"
  while [[ ! -s "$trigger" ]]; do sleep 0.01; done
  if [[ "$mode" != "no-completion" ]]; then
    local observed_at selected_strategy resolved_strategy
    local -a oracle_arguments=(
      --no-warnings
      --experimental-sqlite
      --experimental-strip-types
      "$oracle_helper"
      apply-fixture
      "--database=$database"
      "--guide=$guide"
      "--dataset-version=$dataset_version"
    )
    [[ "$mode" == "same-count-semantic-corruption" ]] && oracle_arguments+=(--inject-semantic-corruption)
    mkdir -p "${reference:h}"
    cp -f -- "$guide" "$reference"
    if [[ "$mode" == "materialized-source-mismatch" ]]; then
      print -rn -- "mismatch" >> "$reference"
    fi
    "$node" "${oracle_arguments[@]}"
    # Match production's Math.floor(Date.now() / 1000) attestation precision.
    observed_at="$(date +%s)"
    selected_strategy="$strategy"
    resolved_strategy="$strategy"
    if [[ "$mode" == "attestation-mismatch" ]]; then
      selected_strategy="legacy-js-v1"
      [[ "$strategy" == "legacy-js-v1" ]] && selected_strategy="attach-insert-select-v1"
    fi
    sqlite3 "$database" >/dev/null <<SQL
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
INSERT INTO app_metadata(key, value)
VALUES ('michelin_dataset_version', '$dataset_version')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
INSERT INTO app_metadata(key, value)
VALUES (
  'michelin_import_runtime_attestation',
  json_object(
    'requestedStrategy', '$strategy',
    'resolvedStrategy', '$resolved_strategy',
    'fallbackReason', NULL,
    'runId', '$run_id',
    'schemaVersion', 1,
    'selectedStrategy', '$selected_strategy',
    'datasetVersion', '$dataset_version',
    'sourceRows', 3,
    'importedRows', 2,
    'observedAtEpochSeconds', $observed_at
  )
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
COMMIT;
SQL
  fi
  while true; do sleep 0.05; done
}

if [[ "$COMMAND_NAME" == "fake-macos-command.sh" && "${1:-}" == "__simulate__" ]]; then
  simulate_palate
  exit 0
fi

case "$COMMAND_NAME" in
  open)
    nohup "$HELPER_PATH" __simulate__ 9>&- > "$STATE_DIRECTORY/simulator.log" 2>&1 &
    simulator_pid=$!
    disown "$simulator_pid" 2>/dev/null || true
    print -r -- "$simulator_pid" > "$STATE_DIRECTORY/pid.tmp"
    mv -f -- "$STATE_DIRECTORY/pid.tmp" "$STATE_DIRECTORY/pid"
    ;;

  codesign)
    [[ "${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_MODE:-success}" != "signature-failure" ]]
    ;;

  lsof)
    arguments=" $* "
    if [[ "$arguments" == *" -d txt "* ]]; then
      running_app="${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_RUNNING_APP:-${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_APP:?Missing fake app}}"
      print "p${PALATE_MICHELIN_IMPORT_HARNESS_FAKE_PROCESS_PID:-4242}"
      print "n$running_app/Palate"
      exit 0
    fi
    # Isolated fixture files have no external holders.
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
      kill -TERM "$simulator_pid" 2>/dev/null || true
      for _ in {1..100}; do
        kill -0 "$simulator_pid" 2>/dev/null || break
        sleep 0.01
      done
      rm -f -- "$STATE_DIRECTORY/pid"
    fi
    ;;

  ps)
    arguments=" $* "
    if [[ "$arguments" == *" rss= "* ]]; then
      print "123456"
    elif [[ "$arguments" == *" ppid= "* ]]; then
      print "1"
    elif [[ "$arguments" == *" comm= "* ]]; then
      print "/sbin/launchd"
    elif [[ "$arguments" == *" command= "* ]]; then
      print "Palate"
    else
      print -u2 "Unsupported fake ps invocation: $*"
      exit 2
    fi
    ;;

  *)
    print -u2 "Unsupported fake command: $COMMAND_NAME"
    exit 2
    ;;
esac

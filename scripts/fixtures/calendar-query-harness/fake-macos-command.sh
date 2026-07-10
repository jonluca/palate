#!/bin/zsh
set -euo pipefail

# Test-only command multiplexer for test-macos-calendar-query-harness.sh.
# Symlink this file as launchctl/open/pgrep/pkill/ps inside an isolated PATH.

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

  local first_title="Dinner A"
  if [[ "${PALATE_CALENDAR_HARNESS_FAKE_MODE:-success}" == "parity-failure" ]]; then
    first_title="Incorrect title"
  elif [[ "${PALATE_CALENDAR_HARNESS_FAKE_MODE:-success}" == "reference-success" ]]; then
    first_title="Reference Dinner A"
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
    environment_path="$(state_path "$key")"
    case "$subcommand" in
      getenv)
        if [[ -f "$environment_path" ]]; then
          print -r -- "$(< "$environment_path")"
        fi
        ;;
      setenv)
        value="${3-}"
        mkdir -p "$STATE_DIRECTORY/environment"
        print -rn -- "$value" > "$environment_path.tmp"
        mv -f -- "$environment_path.tmp" "$environment_path"
        ;;
      unsetenv)
        rm -f -- "$environment_path" "$environment_path.tmp"
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
      2>&1 &
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
        PALATE_CALENDAR_VALIDATION_ATTESTATION_PATH; do
        print -n -- " $key=$(read_state_value "$key")"
      done
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

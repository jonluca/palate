#!/bin/zsh
set -euo pipefail

# Test-only command multiplexer. The contract harness symlinks this file as
# codesign/launchctl/lsof/open/pgrep/pkill/ps in an isolated PATH.

STATE_DIRECTORY="${PALATE_WRAPPED_STATS_HARNESS_FAKE_STATE:?Missing fake state directory}"
HELPER_PATH="${PALATE_WRAPPED_STATS_HARNESS_FAKE_HELPER:?Missing fake helper path}"
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
  local mode="${PALATE_WRAPPED_STATS_HARNESS_FAKE_MODE:-success}"
  local trigger_path="${PALATE_WRAPPED_STATS_HARNESS_FAKE_TRIGGER:?Missing trigger path}"
  local visual_ready_path="${PALATE_WRAPPED_STATS_HARNESS_FAKE_VISUAL_READY:?Missing visual-ready path}"
  while [[ ! -s "$trigger_path" ]]; do
    sleep 0.01
  done
  case "$mode" in
    success|mismatch)
      print -r -- "$(date +%s.%N)" > "$visual_ready_path.tmp"
      mv -f -- "$visual_ready_path.tmp" "$visual_ready_path"
      ;;
    mutate)
      sqlite3 "${PALATE_WRAPPED_STATS_HARNESS_FAKE_DATABASE:?Missing fake database path}" \
        "UPDATE visits SET notes = 'mutated-after-trigger' WHERE id = (SELECT id FROM visits WHERE status = 'confirmed' ORDER BY id LIMIT 1);"
      print -r -- "$(date +%s.%N)" > "$visual_ready_path.tmp"
      mv -f -- "$visual_ready_path.tmp" "$visual_ready_path"
      ;;
    stale)
      awk -v trigger="$(< "$trigger_path")" 'BEGIN { printf "%.9f\n", trigger - 1 }' \
        > "$visual_ready_path.tmp"
      mv -f -- "$visual_ready_path.tmp" "$visual_ready_path"
      ;;
    hold)
      while true; do sleep 0.05; done
      ;;
    *)
      print -u2 "Unsupported fake simulator mode: $mode"
      exit 2
      ;;
  esac
  while true; do sleep 0.05; done
}

if [[ "$COMMAND_NAME" == "fake-macos-command.sh" && "${1:-}" == "__simulate__" ]]; then
  simulate_palate
  exit 0
fi

case "$COMMAND_NAME" in
  codesign)
    exit 0
    ;;
  launchctl)
    subcommand="${1:-}"
    key="${2:-}"
    environment_path="$(state_path "$key")"
    case "$subcommand" in
      getenv)
        [[ -f "$environment_path" ]] && print -r -- "$(< "$environment_path")"
        ;;
      setenv)
        mkdir -p "$STATE_DIRECTORY/environment"
        print -rn -- "${3-}" > "$environment_path.tmp"
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
    nohup "$HELPER_PATH" __simulate__ > "$STATE_DIRECTORY/simulator.log" 2>&1 &
    simulator_pid="$!"
    disown "$simulator_pid" 2>/dev/null || true
    print -r -- "$simulator_pid" > "$STATE_DIRECTORY/pid.tmp"
    mv -f -- "$STATE_DIRECTORY/pid.tmp" "$STATE_DIRECTORY/pid"
    ;;
  lsof)
    mode="${PALATE_WRAPPED_STATS_HARNESS_FAKE_MODE:-success}"
    if [[ "$mode" == "mismatch" ]]; then
      executable_path="${PALATE_WRAPPED_STATS_HARNESS_MISMATCH_APP:?Missing mismatch app}/Palate"
    else
      executable_path="${PALATE_WRAPPED_STATS_HARNESS_MATCH_APP:?Missing matching app}/Palate"
    fi
    print "p${PALATE_WRAPPED_STATS_HARNESS_FAKE_PID:-99999}"
    print "ftxt"
    print "n$executable_path"
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
      print "Palate PALATE_WRAPPED_STATS_VALIDATION_RUN_ID=$(read_state_value PALATE_WRAPPED_STATS_VALIDATION_RUN_ID)"
    elif [[ "$arguments" == *" rss= "* ]]; then
      print "123456"
    elif [[ "$arguments" == *" %cpu= "* ]]; then
      print "12.5"
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

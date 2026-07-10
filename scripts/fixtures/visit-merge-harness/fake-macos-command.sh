#!/bin/zsh
set -euo pipefail

# Test-only command multiplexer for test-macos-visit-merge-harness.sh.
# Symlink this file as codesign/launchctl/lsof/open/pgrep/pkill/ps in an isolated PATH.

STATE_DIRECTORY="${PALATE_VISIT_MERGE_HARNESS_FAKE_STATE:?Missing fake state directory}"
HELPER_PATH="${PALATE_VISIT_MERGE_HARNESS_FAKE_HELPER:?Missing fake helper path}"
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
  local mode="${PALATE_VISIT_MERGE_HARNESS_FAKE_MODE:-success}"
  if [[ "$mode" == "hold" ]]; then
    while true; do sleep 0.05; done
  fi
  while [[ ! -s "${PALATE_VISIT_MERGE_HARNESS_FAKE_TRIGGER:?Missing fake trigger path}" ]]; do
    sleep 0.01
  done
  if [[ "$mode" == "parity-failure" ]]; then
    sqlite3 "$PALATE_VISIT_MERGE_HARNESS_FAKE_DATABASE" \
      "UPDATE photos SET uri = uri || '-incorrect' WHERE id = (SELECT id FROM photos ORDER BY id LIMIT 1);"
  fi
  local updated_at_ms
  updated_at_ms="$(awk -v value="$(date +%s.%N)" 'BEGIN { printf "%.0f", value * 1000 }')"
  NODE_NO_WARNINGS=1 \
    "${PALATE_VISIT_MERGE_HARNESS_NODE:?Missing fake Node path}" \
    "${PALATE_VISIT_MERGE_HARNESS_FIXTURE_HELPER:?Missing fixture helper path}" \
    reference \
    --database="${PALATE_VISIT_MERGE_HARNESS_FAKE_DATABASE:?Missing fake database path}" \
    --manifest="${PALATE_VISIT_MERGE_HARNESS_FAKE_MANIFEST:?Missing fake manifest path}" \
    --report="$STATE_DIRECTORY/simulated-reference.json" \
    --updated-at-ms="$updated_at_ms" \
    --atomic=true \
    > "$STATE_DIRECTORY/simulated-reference.log" 2>&1
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
  lsof)
    process_app_path="${PALATE_VISIT_MERGE_HARNESS_FAKE_PROCESS_APP:?Missing fake process app path}"
    print "p${PALATE_VISIT_MERGE_HARNESS_FAKE_PROCESS_PID:-0}"
    print "ftxt"
    print "n$process_app_path/Palate"
    ;;
  open)
    mkdir -p "$STATE_DIRECTORY"
    nohup "$HELPER_PATH" __simulate__ > "$STATE_DIRECTORY/simulator.log" 2>&1 &
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
      print "Palate PALATE_VISIT_MERGE_VALIDATION_RUN_ID=$(read_state_value PALATE_VISIT_MERGE_VALIDATION_RUN_ID)"
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

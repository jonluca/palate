#!/bin/zsh
set -euo pipefail

# Test-only command multiplexer. The harness symlinks this file as
# codesign/launchctl/lsof/open/pgrep/pkill/ps in an isolated PATH.

STATE_DIRECTORY="${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_STATE:?Missing fake state directory}"
HELPER_PATH="${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_HELPER:?Missing fake helper path}"
COMMAND_NAME="${0:t}"

environment_path() {
  local key="$1"
  [[ "$key" =~ '^[A-Z0-9_]+$' ]] || {
    print -u2 "Invalid fake environment key: $key"
    return 2
  }
  print -r -- "$STATE_DIRECTORY/environment/$key"
}

read_environment() {
  local environment_file
  environment_file="$(environment_path "$1")"
  [[ -f "$environment_file" ]] || return 1
  print -rn -- "$(< "$environment_file")"
}

simulate_palate() {
  trap 'exit 0' INT TERM HUP
  local trigger="${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_TRIGGER:?Missing fake trigger}"
  local mode="${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_MODE:-success}"
  while [[ ! -s "$trigger" ]]; do
    sleep 0.01
  done
  if [[ "$mode" != "no-completion" ]]; then
    local -a arguments=(
      --no-warnings
      --experimental-sqlite
      --experimental-strip-types
      "${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_ORACLE_HELPER:?Missing oracle helper}"
      apply-fixture
      "--database=${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_DATABASE:?Missing fake database}"
      "--oracle=${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_ORACLE:?Missing fake oracle}"
    )
    [[ "$mode" == "parity-failure" ]] && arguments+=(--inject-parity-failure)
    "${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_NODE:?Missing fake Node}" "${arguments[@]}"
  fi
  while true; do sleep 0.05; done
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
        environment_file="$(environment_path "$key")"
        [[ -f "$environment_file" ]] && print -r -- "$(< "$environment_file")"
        ;;
      setenv)
        environment_file="$(environment_path "$key")"
        mkdir -p "$STATE_DIRECTORY/environment"
        print -rn -- "${3-}" > "$environment_file.tmp"
        mv -f -- "$environment_file.tmp" "$environment_file"
        ;;
      unsetenv)
        environment_file="$(environment_path "$key")"
        rm -f -- "$environment_file" "$environment_file.tmp"
        ;;
      print)
        print "environment = {"
        for file in "$STATE_DIRECTORY"/environment/*(N); do
          print "  ${file:t} => $(< "$file")"
        done
        print "}"
        ;;
      *)
        print -u2 "Unsupported fake launchctl invocation: $*"
        exit 2
        ;;
    esac
    ;;

  open)
    nohup "$HELPER_PATH" __simulate__ 9>&- > "$STATE_DIRECTORY/simulator.log" 2>&1 &
    simulator_pid=$!
    disown "$simulator_pid" 2>/dev/null || true
    print -r -- "$simulator_pid" > "$STATE_DIRECTORY/pid.tmp"
    mv -f -- "$STATE_DIRECTORY/pid.tmp" "$STATE_DIRECTORY/pid"
    ;;

  codesign)
    [[ "${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_MODE:-success}" != "signature-failure" ]]
    ;;

  lsof)
    arguments=" $* "
    if [[ "$arguments" == *" -d txt "* ]]; then
      running_app="${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_RUNNING_APP:-${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_APP:?Missing fake app}}"
      print "p${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_PROCESS_PID:-4242}"
      print "n$running_app/Palate"
      exit 0
    fi
    # Isolated fixture database files have no external holders.
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
    if [[ "$arguments" == *" command= "* ]]; then
      run_id="$(read_environment PALATE_MICHELIN_SUGGESTION_VALIDATION_RUN_ID || true)"
      if [[ "${PALATE_MICHELIN_SUGGESTION_HARNESS_FAKE_MODE:-success}" == "environment-mismatch" ]]; then
        run_id="wrong-run-id"
      fi
      print "Palate PALATE_MICHELIN_SUGGESTION_VALIDATION_RUN_ID=$run_id"
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
    print -u2 "Unsupported fake command: $COMMAND_NAME"
    exit 2
    ;;
esac

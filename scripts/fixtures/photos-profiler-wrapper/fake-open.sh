#!/bin/zsh
set -euo pipefail

stdout_path=""
stderr_path=""

if [[ -n "${PALATE_PHOTOS_PROFILER_FAKE_ARGUMENTS:-}" ]]; then
  /usr/bin/printf '%s\n' "$@" > "$PALATE_PHOTOS_PROFILER_FAKE_ARGUMENTS"
fi

while (( $# > 0 )); do
  case "$1" in
    --stdout)
      shift
      stdout_path="${1:-}"
      ;;
    --stderr)
      shift
      stderr_path="${1:-}"
      ;;
  esac
  shift
done

if [[ -z "$stdout_path" || -z "$stderr_path" ]]; then
  print -u2 "Fake open requires --stdout and --stderr paths"
  exit 2
fi
if [[ -z "${PALATE_PHOTOS_PROFILER_FAKE_REPORT:-}" ]]; then
  print -u2 "PALATE_PHOTOS_PROFILER_FAKE_REPORT is required"
  exit 2
fi

/bin/cp "$PALATE_PHOTOS_PROFILER_FAKE_REPORT" "$stdout_path"
if [[ -n "${PALATE_PHOTOS_PROFILER_FAKE_STDERR:-}" ]]; then
  print -r -- "$PALATE_PHOTOS_PROFILER_FAKE_STDERR" > "$stderr_path"
else
  : > "$stderr_path"
fi

exit "${PALATE_PHOTOS_PROFILER_FAKE_OPEN_STATUS:-0}"

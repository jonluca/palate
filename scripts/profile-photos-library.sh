#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="${PALATE_PHOTOS_PROFILER_APP:-$ROOT_DIR/.build/PalatePhotosProfiler.app}"

if [[ "${PALATE_SKIP_PHOTOS_PROFILER_BUILD:-0}" != "1" ]]; then
  PALATE_PHOTOS_PROFILER_APP="$APP_PATH" zsh "$SCRIPT_DIR/build-photos-profiler.sh" >&2
fi

if [[ ! -d "$APP_PATH" ]]; then
  print -u2 "Profiler app not found at $APP_PATH"
  print -u2 "Build it first with: zsh scripts/build-photos-profiler.sh"
  exit 1
fi

if [[ $# -eq 0 ]]; then
  set -- \
    --batch-sizes 2000,500,250 \
    --iterations 5 \
    --warmup 1
fi

STDOUT_FILE="$(mktemp -t palate-photos-profiler-stdout)"
STDERR_FILE="$(mktemp -t palate-photos-profiler-stderr)"
trap 'rm -f -- "$STDOUT_FILE" "$STDERR_FILE"' EXIT

set +e
/usr/bin/open \
  -n \
  -W \
  --stdout "$STDOUT_FILE" \
  --stderr "$STDERR_FILE" \
  "$APP_PATH" \
  --args "$@"
OPEN_STATUS=$?
set -e

if [[ -s "$STDERR_FILE" ]]; then
  /bin/cat "$STDERR_FILE" >&2
fi
if [[ ! -s "$STDOUT_FILE" ]]; then
  print -u2 "Profiler produced no JSON output"
  exit 1
fi

/usr/bin/plutil -convert json -o /dev/null "$STDOUT_FILE"
REPORT_STATUS="$(/usr/bin/plutil -extract status raw -o - "$STDOUT_FILE")"
RESULT_PATH="${PALATE_PHOTOS_PROFILE_RESULT:-$ROOT_DIR/.build/photos-profile-$(date -u +%Y%m%dT%H%M%SZ).json}"
/usr/bin/install -d "$(dirname -- "$RESULT_PATH")"
/bin/cp "$STDOUT_FILE" "$RESULT_PATH"
/bin/cat "$STDOUT_FILE"

if [[ $OPEN_STATUS -ne 0 ]]; then
  exit "$OPEN_STATUS"
fi
if [[ "$REPORT_STATUS" != "ok" ]]; then
  exit 1
fi

#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if [[ ! -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]]; then
  print -u2 "Stable Xcode was not found at $DEVELOPER_DIR"
  exit 1
fi

SWIFT_BIN="$(xcrun --find swift)"
STDOUT_FILE="$(mktemp -t palate-calendar-batch-mutation-profile)"
trap 'rm -f -- "$STDOUT_FILE"' EXIT

set +e
"$SWIFT_BIN" run \
  --package-path "$ROOT_DIR" \
  --configuration release \
  PalateCalendarBatchMutationProfiler \
  "$@" >"$STDOUT_FILE"
RUN_STATUS=$?
set -e

if [[ ! -s "$STDOUT_FILE" ]]; then
  print -u2 "Calendar batch mutation profiler produced no JSON output"
  exit 1
fi
/usr/bin/plutil -convert json -o /dev/null "$STDOUT_FILE"
REPORT_STATUS="$(/usr/bin/plutil -extract status raw -o - "$STDOUT_FILE")"
RESULT_PATH="${PALATE_CALENDAR_BATCH_MUTATION_PROFILE_RESULT:-$ROOT_DIR/.build/calendar-batch-mutation-profile.json}"
/usr/bin/install -d "$(dirname -- "$RESULT_PATH")"
/bin/cp "$STDOUT_FILE" "$RESULT_PATH"
/bin/cat "$STDOUT_FILE"

if [[ $RUN_STATUS -ne 0 ]]; then
  exit "$RUN_STATUS"
fi
if [[ "$REPORT_STATUS" != "ok" ]]; then
  exit 1
fi

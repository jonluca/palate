#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if [[ ! -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]]; then
  print -u2 "Stable Xcode was not found at $DEVELOPER_DIR"
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node)}"
"$NODE_BIN" \
  --no-warnings \
  --experimental-strip-types \
  "$ROOT_DIR/scripts/test-vision-classification-transport.ts"

"$NODE_BIN" \
  --no-warnings \
  --experimental-sqlite \
  --experimental-strip-types \
  "$ROOT_DIR/scripts/test-vision-classification-transport-benchmark.ts"

SWIFT_BIN="$(xcrun --find swift)"
exec "$SWIFT_BIN" test \
  --package-path "$ROOT_DIR" \
  --configuration release \
  --filter 'PhotoAssetClassificationPackedResultV1Tests|PhotoAssetVisionResultTransportTests|PhotoAssetVisionResultTransportRuntimeAttestationTests'

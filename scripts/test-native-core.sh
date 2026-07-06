#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-/opt/homebrew}"
export PATH="$HOMEBREW_PREFIX/opt/ruby/bin:$HOMEBREW_PREFIX/bin:$PATH"

if [[ ! -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]]; then
  print -u2 "Stable Xcode was not found at $DEVELOPER_DIR"
  exit 1
fi

SWIFT_BIN="$(xcrun --find swift)"
"$SWIFT_BIN" test --package-path "$ROOT_DIR" --configuration release

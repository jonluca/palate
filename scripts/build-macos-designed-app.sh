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

CONFIGURATION="${PALATE_XCODE_CONFIGURATION:-Debug}"
CODE_SIGNING_ALLOWED="${PALATE_CODE_SIGNING_ALLOWED:-NO}"
DERIVED_DATA_PATH="${PALATE_DERIVED_DATA_PATH:-$ROOT_DIR/.build/xcode-macos-$CONFIGURATION-$CODE_SIGNING_ALLOWED}"
typeset -a provisioning_arguments
provisioning_arguments=()
if [[ "${PALATE_ALLOW_PROVISIONING_UPDATES:-0}" == "1" ]]; then
  provisioning_arguments+=("-allowProvisioningUpdates")
fi

cd "$ROOT_DIR"
xcodebuild \
  -workspace ios/Palate.xcworkspace \
  -scheme Palate \
  -configuration "$CONFIGURATION" \
  -destination "platform=macOS,name=My Mac" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  "CODE_SIGNING_ALLOWED=$CODE_SIGNING_ALLOWED" \
  "${provisioning_arguments[@]}" \
  build \
  -quiet

typeset -a app_paths
app_paths=("$DERIVED_DATA_PATH"/Build/Products/*/Palate.app(N))
if (( ${#app_paths} != 1 )); then
  print -u2 "Expected one Palate.app under $DERIVED_DATA_PATH/Build/Products, found ${#app_paths}"
  exit 1
fi

APP_PATH="${app_paths[1]}"
if [[ ! -s "$APP_PATH/Palate" ]]; then
  print -u2 "Built app is missing its executable at $APP_PATH/Palate"
  exit 1
fi

if [[ "$CODE_SIGNING_ALLOWED" == "YES" ]]; then
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
fi

print "$APP_PATH"

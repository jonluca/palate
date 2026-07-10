#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-/opt/homebrew}"
export PATH="$HOMEBREW_PREFIX/opt/ruby/bin:$HOMEBREW_PREFIX/bin:$PATH"

if [[ ! -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]]; then
  print -u2 "Xcode developer directory was not found at $DEVELOPER_DIR"
  exit 1
fi

CONFIGURATION="${PALATE_XCODE_CONFIGURATION:-Debug}"
CODE_SIGNING_ALLOWED="${PALATE_CODE_SIGNING_ALLOWED:-NO}"
IPHONEOS_DEPLOYMENT_TARGET="${PALATE_IPHONEOS_DEPLOYMENT_TARGET:-16.4}"
DERIVED_DATA_PATH="${PALATE_DERIVED_DATA_PATH:-$ROOT_DIR/.build/xcode-macos-$CONFIGURATION-$CODE_SIGNING_ALLOWED}"
CONFIGURATION_PRODUCTS_PATH="$DERIVED_DATA_PATH/Build/Products/$CONFIGURATION-iphoneos"
typeset -a provisioning_arguments
provisioning_arguments=()
typeset -a code_signing_arguments
code_signing_arguments=()
if [[ "${PALATE_ALLOW_PROVISIONING_UPDATES:-0}" == "1" ]]; then
  provisioning_arguments+=("-allowProvisioningUpdates")
fi

if [[ "$CODE_SIGNING_ALLOWED" == "NO" ]]; then
  code_signing_arguments+=("CODE_SIGNING_ALLOWED=NO")
elif [[ "$CODE_SIGNING_ALLOWED" != "YES" ]]; then
  print -u2 "PALATE_CODE_SIGNING_ALLOWED must be YES or NO"
  exit 1
fi

# Xcode can otherwise reuse an older React Native bundle from DerivedData even
# while recompiling the native executable. Release validation must exercise the
# current JavaScript, so remove only the generated bundle artifacts and require
# the bundle phase to recreate them.
if [[ "$CONFIGURATION" == "Release" ]]; then
  /bin/rm -f \
    "$CONFIGURATION_PRODUCTS_PATH/main.jsbundle" \
    "$CONFIGURATION_PRODUCTS_PATH/Palate.app/main.jsbundle"
fi

cd "$ROOT_DIR"
"$DEVELOPER_DIR/usr/bin/xcodebuild" \
  -workspace ios/Palate.xcworkspace \
  -scheme Palate \
  -configuration "$CONFIGURATION" \
  -destination "platform=macOS,name=My Mac" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  "IPHONEOS_DEPLOYMENT_TARGET=$IPHONEOS_DEPLOYMENT_TARGET" \
  "${code_signing_arguments[@]}" \
  "${provisioning_arguments[@]}" \
  build \
  -quiet

APP_PATH="$CONFIGURATION_PRODUCTS_PATH/Palate.app"
if [[ ! -d "$APP_PATH" ]]; then
  print -u2 "The requested $CONFIGURATION app was not built at $APP_PATH"
  exit 1
fi
if [[ ! -s "$APP_PATH/Palate" ]]; then
  print -u2 "Built app is missing its executable at $APP_PATH/Palate"
  exit 1
fi

if [[ "$CONFIGURATION" == "Release" && ! -s "$APP_PATH/main.jsbundle" ]]; then
  print -u2 "Release app is missing its generated React Native bundle at $APP_PATH/main.jsbundle"
  exit 1
fi

INFO_PLIST="$APP_PATH/Info.plist"
if [[ ! -f "$INFO_PLIST" ]]; then
  print -u2 "Built app is missing its Info.plist at $INFO_PLIST"
  exit 1
fi
PHOTO_USAGE_DESCRIPTION="$(/usr/bin/plutil -extract NSPhotoLibraryUsageDescription raw -o - "$INFO_PLIST" 2>/dev/null || true)"
if [[ -z "$PHOTO_USAGE_DESCRIPTION" ]]; then
  print -u2 "Built app is missing NSPhotoLibraryUsageDescription"
  exit 1
fi
CALENDAR_USAGE_DESCRIPTION="$(/usr/bin/plutil -extract NSCalendarsFullAccessUsageDescription raw -o - "$INFO_PLIST" 2>/dev/null || true)"
if [[ -z "$CALENDAR_USAGE_DESCRIPTION" ]]; then
  print -u2 "Built app is missing NSCalendarsFullAccessUsageDescription"
  exit 1
fi

if [[ "$CODE_SIGNING_ALLOWED" == "YES" ]]; then
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
fi

print "$APP_PATH"

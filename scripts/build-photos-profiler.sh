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
"$SWIFT_BIN" build \
  --package-path "$ROOT_DIR" \
  --configuration release \
  --product PalatePhotosProfiler

BIN_PATH="$("$SWIFT_BIN" build --package-path "$ROOT_DIR" --configuration release --show-bin-path)"
PROFILER_BINARY="$BIN_PATH/PalatePhotosProfiler"
APP_PATH="${PALATE_PHOTOS_PROFILER_APP:-$ROOT_DIR/.build/PalatePhotosProfiler.app}"
BUNDLE_IDENTIFIER="com.jonluca.palate.photos-profiler"
CODE_SIGN_IDENTITY="${PALATE_PHOTOS_PROFILER_CODE_SIGN_IDENTITY:--}"

if [[ ! -x "$PROFILER_BINARY" ]]; then
  print -u2 "Profiler binary was not produced at $PROFILER_BINARY"
  exit 1
fi

rm -rf -- "$APP_PATH"
/usr/bin/install -d "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
/usr/bin/install -m 755 "$PROFILER_BINARY" "$APP_PATH/Contents/MacOS/PalatePhotosProfiler"

INFO_PLIST="$APP_PATH/Contents/Info.plist"
/usr/bin/plutil -create xml1 "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleDisplayName -string "Palate Photos Profiler" "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleExecutable -string "PalatePhotosProfiler" "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleIdentifier -string "$BUNDLE_IDENTIFIER" "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleInfoDictionaryVersion -string "6.0" "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleName -string "PalatePhotosProfiler" "$INFO_PLIST"
/usr/bin/plutil -insert CFBundlePackageType -string "APPL" "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleShortVersionString -string "1.0" "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleVersion -string "1" "$INFO_PLIST"
/usr/bin/plutil -insert LSMinimumSystemVersion -string "13.0" "$INFO_PLIST"
/usr/bin/plutil -insert LSUIElement -bool true "$INFO_PLIST"
/usr/bin/plutil -insert NSPrincipalClass -string "NSApplication" "$INFO_PLIST"
/usr/bin/plutil -insert NSPhotoLibraryUsageDescription -string \
  "Palate Photos Profiler reads photo metadata and thumbnails to measure native Photos performance." \
  "$INFO_PLIST"

/usr/bin/codesign \
  --force \
  --deep \
  --sign "$CODE_SIGN_IDENTITY" \
  --identifier "$BUNDLE_IDENTIFIER" \
  --timestamp=none \
  "$APP_PATH"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"

print "$APP_PATH"

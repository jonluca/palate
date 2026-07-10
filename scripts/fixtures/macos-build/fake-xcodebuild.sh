#!/bin/zsh
set -euo pipefail

configuration=""
derived_data_path=""

while (( $# > 0 )); do
  case "$1" in
    -configuration)
      shift
      configuration="${1:-}"
      ;;
    -derivedDataPath)
      shift
      derived_data_path="${1:-}"
      ;;
  esac
  shift
done

if [[ -z "$configuration" || -z "$derived_data_path" ]]; then
  print -u2 "Fake xcodebuild requires -configuration and -derivedDataPath"
  exit 2
fi

if [[ "${PALATE_FAKE_XCODEBUILD_SKIP_PRODUCT:-0}" == "1" ]]; then
  exit 0
fi

app_path="$derived_data_path/Build/Products/$configuration-iphoneos/Palate.app"
mkdir -p "$app_path"

print -r -- '#!/bin/sh
exit 0' > "$app_path/Palate"
chmod +x "$app_path/Palate"

print -r -- '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPhotoLibraryUsageDescription</key>
  <string>Fixture Photos access</string>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>Fixture Calendar access</string>
</dict>
</plist>' > "$app_path/Info.plist"

if [[ "$configuration" == "Release" && ! -e "$app_path/main.jsbundle" ]]; then
  print -r -- "fresh-$configuration" > "$app_path/main.jsbundle"
fi

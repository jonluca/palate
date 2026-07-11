#!/bin/zsh
set -euo pipefail

configuration=""
derived_data_path=""
targeted_device_family=""

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
    TARGETED_DEVICE_FAMILY=*)
      targeted_device_family="${1#TARGETED_DEVICE_FAMILY=}"
      ;;
  esac
  shift
done

if [[ -z "$configuration" || -z "$derived_data_path" ]]; then
  print -u2 "Fake xcodebuild requires -configuration and -derivedDataPath"
  exit 2
fi
if [[ "$targeted_device_family" != "1,2" ]]; then
  print -u2 "Fake xcodebuild requires TARGETED_DEVICE_FAMILY=1,2; found ${targeted_device_family:-missing}"
  exit 2
fi

if [[ "${PALATE_FAKE_XCODEBUILD_SKIP_PRODUCT:-0}" == "1" ]]; then
  exit 0
fi

app_path="$derived_data_path/Build/Products/$configuration-iphoneos/Palate.app"
mkdir -p "$app_path"

fixture_device_family="${PALATE_FAKE_XCODEBUILD_UIDEVICE_FAMILY:-1,2}"
case "$fixture_device_family" in
  1)
    fixture_device_family_xml='    <integer>1</integer>'
    ;;
  1,2)
    fixture_device_family_xml='    <integer>1</integer>
    <integer>2</integer>'
    ;;
  *)
    print -u2 "Unsupported fake UIDeviceFamily value: $fixture_device_family"
    exit 2
    ;;
esac

print -r -- '#!/bin/sh
exit 0' > "$app_path/Palate"
chmod +x "$app_path/Palate"

print -r -- '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>UIDeviceFamily</key>
  <array>
'"$fixture_device_family_xml"'
  </array>
  <key>NSPhotoLibraryUsageDescription</key>
  <string>Fixture Photos access</string>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>Fixture Calendar access</string>
</dict>
</plist>' > "$app_path/Info.plist"

if [[ "$configuration" == "Release" && ! -e "$app_path/main.jsbundle" ]]; then
  print -r -- "fresh-$configuration" > "$app_path/main.jsbundle"
fi

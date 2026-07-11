#!/bin/zsh
set -euo pipefail

ROOT_DIRECTORY="${0:A:h:h}"
BUILD_HELPER_PATH="$ROOT_DIRECTORY/scripts/build-macos-designed-app.sh"
FAKE_XCODEBUILD_PATH="$ROOT_DIRECTORY/scripts/fixtures/macos-build/fake-xcodebuild.sh"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-macos-build.XXXXXX")"
FAKE_DEVELOPER_DIRECTORY="$TEMPORARY_DIRECTORY/developer"
FAKE_HOMEBREW_PREFIX="$TEMPORARY_DIRECTORY/homebrew"
DERIVED_DATA_PATH="$TEMPORARY_DIRECTORY/DerivedData"

cleanup() {
  rm -rf -- "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT

mkdir -p "$FAKE_DEVELOPER_DIRECTORY/usr/bin" "$FAKE_HOMEBREW_PREFIX/bin"
ln -s "$FAKE_XCODEBUILD_PATH" "$FAKE_DEVELOPER_DIRECTORY/usr/bin/xcodebuild"
# A conflicting PATH binary must never override the DEVELOPER_DIR executable
# that the build helper validated.
ln -s /usr/bin/false "$FAKE_HOMEBREW_PREFIX/bin/xcodebuild"

run_build() {
  local configuration="$1"
  shift
  env \
    DEVELOPER_DIR="$FAKE_DEVELOPER_DIRECTORY" \
    HOMEBREW_PREFIX="$FAKE_HOMEBREW_PREFIX" \
    PALATE_XCODE_CONFIGURATION="$configuration" \
    PALATE_CODE_SIGNING_ALLOWED=NO \
    PALATE_DERIVED_DATA_PATH="$DERIVED_DATA_PATH" \
    "$@" \
    zsh "$BUILD_HELPER_PATH"
}

assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    print -u2 "$label: expected '$expected', found '$actual'"
    return 1
  fi
}

debug_app_path="$DERIVED_DATA_PATH/Build/Products/Debug-iphoneos/Palate.app"
release_app_path="$DERIVED_DATA_PATH/Build/Products/Release-iphoneos/Palate.app"
mkdir -p "$debug_app_path" "$release_app_path"
print -r -- "unrelated-debug-product" > "$debug_app_path/unrelated-marker"
print -r -- "stale-release-bundle" > "$release_app_path/main.jsbundle"

release_output="$(run_build Release)"
assert_equal "$release_output" "$release_app_path" "Release app selection"
assert_equal "$(< "$release_app_path/main.jsbundle")" "fresh-Release" "Release bundle recreation"
assert_equal "$(< "$debug_app_path/unrelated-marker")" "unrelated-debug-product" "Debug product preservation"
assert_equal "$(/usr/bin/plutil -extract UIDeviceFamily json -o - "$release_app_path/Info.plist")" '[1,2]' "Designed-for-iPad device family"

debug_output="$(run_build Debug)"
assert_equal "$debug_output" "$debug_app_path" "Debug app selection"
assert_equal "$(< "$release_app_path/main.jsbundle")" "fresh-Release" "Release product preservation"

invalid_family_derived_data_path="$TEMPORARY_DIRECTORY/InvalidFamilyDerivedData"
DERIVED_DATA_PATH="$invalid_family_derived_data_path"
if invalid_family_output="$(run_build Debug PALATE_FAKE_XCODEBUILD_UIDEVICE_FAMILY=1 2>&1)"; then
  print -u2 "An iPhone-only macOS validation artifact unexpectedly succeeded"
  exit 1
fi
if [[ "$invalid_family_output" != *"must include iPad (2) in UIDeviceFamily"* ]]; then
  print -u2 "Invalid-device-family failure was not actionable: $invalid_family_output"
  exit 1
fi

missing_derived_data_path="$TEMPORARY_DIRECTORY/MissingDerivedData"
missing_debug_path="$missing_derived_data_path/Build/Products/Debug-iphoneos/Palate.app"
mkdir -p "$missing_debug_path"
print -r -- "other-configuration" > "$missing_debug_path/Palate"
chmod +x "$missing_debug_path/Palate"

DERIVED_DATA_PATH="$missing_derived_data_path"
if missing_output="$(run_build Release PALATE_FAKE_XCODEBUILD_SKIP_PRODUCT=1 2>&1)"; then
  print -u2 "A missing requested Release product unexpectedly succeeded"
  exit 1
fi
expected_missing_path="$missing_derived_data_path/Build/Products/Release-iphoneos/Palate.app"
if [[ "$missing_output" != *"$expected_missing_path"* ]]; then
  print -u2 "Missing-product failure did not identify the requested path: $missing_output"
  exit 1
fi

print "macOS build helper tests passed: Designed-for-iPad targeting, plist validation, configuration isolation, Release bundle refresh, and missing-product rejection."

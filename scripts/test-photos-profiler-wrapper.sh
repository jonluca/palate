#!/bin/zsh
set -euo pipefail

ROOT_DIRECTORY="${0:A:h:h}"
WRAPPER_PATH="$ROOT_DIRECTORY/scripts/profile-photos-library.sh"
FAKE_OPEN_PATH="$ROOT_DIRECTORY/scripts/fixtures/photos-profiler-wrapper/fake-open.sh"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-photos-profiler-wrapper.XXXXXX")"
FAKE_APP_PATH="$TEMPORARY_DIRECTORY/PalatePhotosProfiler.app"

cleanup() {
  rm -rf -- "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT

mkdir -p "$FAKE_APP_PATH"

assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    print -u2 "$label: expected '$expected', found '$actual'"
    return 1
  fi
}

run_case() {
  local case_name="$1"
  local expected_status="$2"
  local expected_stderr_fragment="${3:-}"
  local report_path="$TEMPORARY_DIRECTORY/$case_name.input.json"
  local result_path="$TEMPORARY_DIRECTORY/$case_name.result.json"
  local stdout_path="$TEMPORARY_DIRECTORY/$case_name.stdout"
  local stderr_path="$TEMPORARY_DIRECTORY/$case_name.stderr"
  local arguments_path="$TEMPORARY_DIRECTORY/$case_name.arguments"
  local command_status

  set +e
  env \
    PALATE_SKIP_PHOTOS_PROFILER_BUILD=1 \
    PALATE_PHOTOS_PROFILER_APP="$FAKE_APP_PATH" \
    PALATE_PHOTOS_PROFILER_OPEN_COMMAND="$FAKE_OPEN_PATH" \
    PALATE_PHOTOS_PROFILER_FAKE_REPORT="$report_path" \
    PALATE_PHOTOS_PROFILER_FAKE_ARGUMENTS="$arguments_path" \
    PALATE_PHOTOS_AUTHORIZATION_TIMEOUT_SECONDS="${PALATE_PHOTOS_AUTHORIZATION_TIMEOUT_SECONDS:-}" \
    PALATE_PHOTOS_PROFILE_RESULT="$result_path" \
    zsh "$WRAPPER_PATH" \
    > "$stdout_path" \
    2> "$stderr_path"
  command_status=$?
  set -e

  assert_equal "$command_status" "$expected_status" "$case_name exit status"
  if ! cmp -s "$report_path" "$result_path"; then
    print -u2 "$case_name did not retain the exact profiler report"
    return 1
  fi
  if ! cmp -s "$report_path" "$stdout_path"; then
    print -u2 "$case_name did not print the exact profiler report"
    return 1
  fi
  if rg -q "Could not extract value" "$stderr_path"; then
    print -u2 "$case_name leaked a plutil extraction failure"
    return 1
  fi
  if [[ -n "$expected_stderr_fragment" ]] && ! rg -Fq "$expected_stderr_fragment" "$stderr_path"; then
    print -u2 "$case_name stderr did not contain '$expected_stderr_fragment'"
    return 1
  fi
}

run_timeout_forwarding_case() {
  local arguments_path="$TEMPORARY_DIRECTORY/timeout-forwarding.arguments"

  /bin/cp "$success_report" "$TEMPORARY_DIRECTORY/timeout-forwarding.input.json"
  PALATE_PHOTOS_AUTHORIZATION_TIMEOUT_SECONDS=300 \
    PALATE_PHOTOS_PROFILER_FAKE_ARGUMENTS="$arguments_path" \
    run_case "timeout-forwarding" 0

  if ! awk '
    previous == "--authorization-timeout-ms" && $0 == "300000" { found = 1 }
    { previous = $0 }
    END { exit found ? 0 : 1 }
  ' "$arguments_path"; then
    print -u2 "timeout-forwarding did not pass the 300-second timeout to the profiler"
    return 1
  fi
}

run_invalid_timeout_case() {
  local value="$1"
  local arguments_path="$TEMPORARY_DIRECTORY/invalid-timeout-$value.arguments"
  local stderr_path="$TEMPORARY_DIRECTORY/invalid-timeout-$value.stderr"
  local command_status

  set +e
  env \
    PALATE_SKIP_PHOTOS_PROFILER_BUILD=1 \
    PALATE_PHOTOS_PROFILER_APP="$FAKE_APP_PATH" \
    PALATE_PHOTOS_PROFILER_OPEN_COMMAND="$FAKE_OPEN_PATH" \
    PALATE_PHOTOS_PROFILER_FAKE_ARGUMENTS="$arguments_path" \
    PALATE_PHOTOS_AUTHORIZATION_TIMEOUT_SECONDS="$value" \
    zsh "$WRAPPER_PATH" \
    > /dev/null \
    2> "$stderr_path"
  command_status=$?
  set -e

  assert_equal "$command_status" "2" "invalid timeout '$value' exit status"
  if [[ -e "$arguments_path" ]]; then
    print -u2 "invalid timeout '$value' launched the profiler"
    return 1
  fi
  if ! rg -Fq \
    "PALATE_PHOTOS_AUTHORIZATION_TIMEOUT_SECONDS must be an integer from 1 through 300" \
    "$stderr_path"; then
    print -u2 "invalid timeout '$value' did not explain the accepted bounds"
    return 1
  fi
}

permission_report="$TEMPORARY_DIRECTORY/permission-error.input.json"
print -r -- '{
  "schemaVersion": 1,
  "status": "error",
  "errorType": "PhotosProfilerSupport.PhotosProfilerError",
  "message": "Photos access is required to profile the library (authorization status: notDetermined)",
  "authorizationStatus": "notDetermined"
}' > "$permission_report"
run_case "permission-error" 1

missing_configuration_report="$TEMPORARY_DIRECTORY/missing-configuration.input.json"
print -r -- '{
  "schemaVersion": 1,
  "status": "ok"
}' > "$missing_configuration_report"
run_case \
  "missing-configuration" \
  1 \
  "Photos profiler success report is missing configuration.visionSampleCount"

success_report="$TEMPORARY_DIRECTORY/success.input.json"
print -r -- '{
  "schemaVersion": 1,
  "status": "ok",
  "configuration": {
    "visionSampleCount": 200
  },
  "vision": {
    "validation": {
      "exactOutcomeParity": true
    }
  }
}' > "$success_report"
run_case "success" 0

parity_failure_report="$TEMPORARY_DIRECTORY/parity-failure.input.json"
print -r -- '{
  "schemaVersion": 1,
  "status": "ok",
  "configuration": {
    "visionSampleCount": 200
  },
  "vision": {
    "validation": {
      "exactOutcomeParity": false
    }
  }
}' > "$parity_failure_report"
run_case "parity-failure" 1 "Vision baseline/pipeline outcome parity failed"

run_timeout_forwarding_case
run_invalid_timeout_case "0"
run_invalid_timeout_case "301"
run_invalid_timeout_case "not-a-number"

print "Photos profiler wrapper tests passed: report retention, parity rejection, 300-second timeout forwarding, and timeout bounds."

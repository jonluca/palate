#!/bin/zsh
set -euo pipefail

ROOT_DIRECTORY="${0:A:h:h}"
HARNESS_PATH="$ROOT_DIRECTORY/scripts/validate-macos-vision-result-page.sh"
FAKE_HELPER_TEMPLATE_PATH="$ROOT_DIRECTORY/scripts/fixtures/vision-result-page-harness/fake-macos-command.sh"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/palate-vision-page-harness.XXXXXX")"
FAKE_HELPER_PATH="$TEMPORARY_DIRECTORY/fake-macos-command.sh"
FAKE_BIN_DIRECTORY="$TEMPORARY_DIRECTORY/bin"
FAKE_STATE_DIRECTORY="$TEMPORARY_DIRECTORY/state"
FAKE_APP_PATH="$TEMPORARY_DIRECTORY/Palate.app"
MISMATCH_APP_PATH="$TEMPORARY_DIRECTORY/mismatch/Palate.app"
MANUAL_APP_PATH="$TEMPORARY_DIRECTORY/manual/Palate.app"
MANUAL_MISMATCH_APP_PATH="$TEMPORARY_DIRECTORY/manual-mismatch/Palate.app"
DATABASE_PATH="$TEMPORARY_DIRECTORY/vision-fixture.db"

cleanup() {
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    simulator_pid="$(< "$FAKE_STATE_DIRECTORY/pid")"
    kill -TERM "$simulator_pid" 2>/dev/null || true
  fi
  if [[ "${PALATE_VISION_PAGE_HARNESS_TEST_KEEP_TEMP:-0}" == "1" ]]; then
    print -u2 "Retained test directory: $TEMPORARY_DIRECTORY"
  else
    rm -rf -- "$TEMPORARY_DIRECTORY"
  fi
}
trap cleanup EXIT

for dependency in awk jq rg shasum sqlite3 zsh; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    print -u2 "Missing dependency: $dependency"
    exit 2
  fi
done

mkdir -p \
  "$FAKE_BIN_DIRECTORY" \
  "$FAKE_STATE_DIRECTORY/environment" \
  "$FAKE_APP_PATH" \
  "$MISMATCH_APP_PATH" \
  "$MANUAL_APP_PATH" \
  "$MANUAL_MISMATCH_APP_PATH"
cp "$FAKE_HELPER_TEMPLATE_PATH" "$FAKE_HELPER_PATH"
chmod 700 "$FAKE_HELPER_PATH"
for command_name in codesign launchctl lsof open pgrep pkill ps; do
  ln -s "$FAKE_HELPER_PATH" "$FAKE_BIN_DIRECTORY/$command_name"
done
ln -s /usr/bin/true "$FAKE_APP_PATH/Palate"
print -r -- "fixture-release-bundle" > "$FAKE_APP_PATH/main.jsbundle"
ln -s /usr/bin/false "$MISMATCH_APP_PATH/Palate"
print -r -- "mismatched-release-bundle" > "$MISMATCH_APP_PATH/main.jsbundle"
ln -s /usr/bin/true "$MANUAL_APP_PATH/Palate"
print -r -- "fixture-release-bundle" > "$MANUAL_APP_PATH/main.jsbundle"
ln -s /usr/bin/printf "$MANUAL_MISMATCH_APP_PATH/Palate"
print -r -- "fixture-release-bundle" > "$MANUAL_MISMATCH_APP_PATH/main.jsbundle"

export PALATE_VISION_PAGE_HARNESS_FAKE_STATE="$FAKE_STATE_DIRECTORY"
export PALATE_VISION_PAGE_HARNESS_FAKE_HELPER="$FAKE_HELPER_PATH"
export PALATE_VISION_PAGE_HARNESS_FAKE_APP="$FAKE_APP_PATH"
export PALATE_VISION_PAGE_HARNESS_TEST_SKIP_DURABILITY_SYNC=1
export PATH="$FAKE_BIN_DIRECTORY:$PATH"

sqlite3 "$DATABASE_PATH" >/dev/null <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  foodProbable INTEGER NOT NULL
);
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  visitId TEXT,
  creationTime REAL NOT NULL,
  foodDetected INTEGER,
  foodLabels TEXT,
  foodConfidence REAL,
  allLabels TEXT
);
INSERT INTO visits VALUES ('visit-1', 1);
INSERT INTO photos VALUES (
  'photo-1',
  'visit-1',
  1,
  1,
  '[{"label":"food","confidence":0.9}]',
  0.9,
  '[{"label":"food","confidence":0.9}]'
);
SQL
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
rm -f -- "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
ORIGINAL_DATABASE_SHA256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
ORIGINAL_DATABASE_MODE="$(stat -f '%Lp' "$DATABASE_PATH")"
typeset -a VISION_ENVIRONMENT_KEYS=(
  PALATE_VISION_RESULT_PAGE_SIZE
  PALATE_VISION_RESULT_TRANSPORT
  PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH
  PALATE_VISION_CLASSIFICATION_STRATEGY
  PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY
  PALATE_VISION_CONCURRENCY
  PALATE_VISION_PIPELINE_DEPTH
  PALATE_VISION_VALIDATION_RUN_ID
  PALATE_VISIT_FOOD_DETECTION_STRATEGY
)
typeset -A ORIGINAL_ENVIRONMENT_WAS_SET ORIGINAL_ENVIRONMENT_VALUE
typeset -A ORIGINAL_COMPONENT_PRESENT ORIGINAL_COMPONENT_SHA256 ORIGINAL_COMPONENT_MODE

set_original_environment_state() {
  local key="$1"
  local was_set="$2"
  local value="$3"
  if (( was_set )); then
    launchctl setenv "$key" "$value"
  else
    launchctl unsetenv "$key"
  fi
  ORIGINAL_ENVIRONMENT_WAS_SET[$key]="$was_set"
  ORIGINAL_ENVIRONMENT_VALUE[$key]="$value"
}

set_all_original_environment_states() {
  local state="$1"
  local index=0
  local key
  for key in "${VISION_ENVIRONMENT_KEYS[@]}"; do
    case "$state" in
      absent) set_original_environment_state "$key" 0 "" ;;
      empty) set_original_environment_state "$key" 1 "" ;;
      value)
        set_original_environment_state "$key" 1 "preexisting-$index"
        (( index += 1 ))
        ;;
      mixed)
        case $(( index % 3 )) in
          0) set_original_environment_state "$key" 0 "" ;;
          1) set_original_environment_state "$key" 1 "" ;;
          2) set_original_environment_state "$key" 1 "mixed-$index" ;;
        esac
        (( index += 1 ))
        ;;
      *)
        print -u2 "Unknown environment fixture state: $state"
        return 2
        ;;
    esac
  done
}

capture_original_database_contract() {
  local suffix component_path
  ORIGINAL_DATABASE_SHA256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
  ORIGINAL_DATABASE_MODE="$(stat -f '%Lp' "$DATABASE_PATH")"
  for suffix in wal shm journal; do
    component_path="$DATABASE_PATH-$suffix"
    if [[ -f "$component_path" ]]; then
      ORIGINAL_COMPONENT_PRESENT[$suffix]=1
      ORIGINAL_COMPONENT_SHA256[$suffix]="$(shasum -a 256 "$component_path" | awk '{print $1}')"
      ORIGINAL_COMPONENT_MODE[$suffix]="$(stat -f '%Lp' "$component_path")"
    else
      ORIGINAL_COMPONENT_PRESENT[$suffix]=0
      ORIGINAL_COMPONENT_SHA256[$suffix]=""
      ORIGINAL_COMPONENT_MODE[$suffix]=""
    fi
  done
}

set_all_original_environment_states value
set_original_environment_state PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY 0 ""
capture_original_database_contract

assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    print -u2 -- "$label: expected '$expected', found '$actual'"
    return 1
  fi
}

assert_mode() {
  local file_path="$1"
  local expected="$2"
  local label="$3"
  assert_equal "$(stat -f '%Lp' "$file_path")" "$expected" "$label mode"
}

assert_database_contract() {
  local label="$1"
  local suffix component_path
  assert_equal \
    "$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')" \
    "$ORIGINAL_DATABASE_SHA256" \
    "$label database hash"
  assert_mode "$DATABASE_PATH" "$ORIGINAL_DATABASE_MODE" "$label database"
  for suffix in wal shm journal; do
    component_path="$DATABASE_PATH-$suffix"
    if (( ORIGINAL_COMPONENT_PRESENT[$suffix] )); then
      [[ -f "$component_path" && ! -L "$component_path" ]]
      assert_equal \
        "$(shasum -a 256 "$component_path" | awk '{print $1}')" \
        "${ORIGINAL_COMPONENT_SHA256[$suffix]}" \
        "$label $suffix hash"
      assert_mode "$component_path" "${ORIGINAL_COMPONENT_MODE[$suffix]}" "$label $suffix"
    elif [[ -e "$component_path" ]]; then
      print -u2 "$label unexpectedly created $suffix"
      return 1
    fi
  done
}

assert_restored_contract() {
  local label="$1"
  local key environment_path
  assert_database_contract "$label"
  for key in "${VISION_ENVIRONMENT_KEYS[@]}"; do
    environment_path="$FAKE_STATE_DIRECTORY/environment/$key"
    if (( ORIGINAL_ENVIRONMENT_WAS_SET[$key] )); then
      if [[ ! -f "$environment_path" ]]; then
        print -u2 "$label did not restore environment key $key"
        return 1
      fi
      assert_equal \
        "$(< "$environment_path")" \
        "${ORIGINAL_ENVIRONMENT_VALUE[$key]}" \
        "$label environment $key"
    elif [[ -e "$environment_path" ]]; then
      print -u2 "$label restored originally absent environment key $key as set"
      return 1
    fi
  done
  if [[ -f "$FAKE_STATE_DIRECTORY/pid" ]]; then
    print -u2 "$label left the fake Palate process registered"
    return 1
  fi
  if [[ -n "$(find "${DATABASE_PATH:h}" -maxdepth 1 -name "${DATABASE_PATH:t}.vision-result-transport-attestation.tmp-*" -print -quit)" ]]; then
    print -u2 "$label left a native result-transport attestation file"
    return 1
  fi
}

wait_for_ready() {
  local log_path="$1"
  local harness_pid="$2"
  for _ in {1..500}; do
    if rg -q '^READY ' "$log_path" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$harness_pid" 2>/dev/null; then
      print -u2 "Harness exited before READY"
      sed -n '1,200p' "$log_path" >&2
      return 1
    fi
    sleep 0.01
  done
  print -u2 "Timed out waiting for READY"
  sed -n '1,200p' "$log_path" >&2
  return 1
}

wait_for_ready_to_launch() {
  local log_path="$1"
  local harness_pid="$2"
  for _ in {1..500}; do
    if rg -q '^READY_TO_LAUNCH ' "$log_path" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$harness_pid" 2>/dev/null; then
      print -u2 "Harness exited before READY_TO_LAUNCH"
      sed -n '1,200p' "$log_path" >&2
      return 1
    fi
    sleep 0.01
  done
  print -u2 "Timed out waiting for READY_TO_LAUNCH"
  sed -n '1,200p' "$log_path" >&2
  return 1
}

wait_for_path() {
  local target_path="$1"
  local process_pid="$2"
  local label="$3"
  for _ in {1..500}; do
    [[ -e "$target_path" ]] && return 0
    if ! kill -0 "$process_pid" 2>/dev/null; then
      print -u2 "$label process exited before creating $target_path"
      return 1
    fi
    sleep 0.01
  done
  print -u2 "Timed out waiting for $label path: $target_path"
  return 1
}

record_trigger() {
  local trigger_path="$1"
  print -r -- "$(date +%s.%N)" > "$trigger_path.tmp"
  mv -f -- "$trigger_path.tmp" "$trigger_path"
}

immutable_sqlite_uri() {
  local database_path="$1"
  jq -nr --arg path "${database_path:A}" '$path | @uri | "file:\(.)?mode=ro&immutable=1"'
}

run_success_case() {
  local case_name="$1"
  local concurrency="$2"
  local pipeline_depth="$3"
  local page_orchestration_strategy="$4"
  local result_transport="${5:-}"
  local retain_raw_databases="${6:-0}"
  local semantic_reference_database="${7:-}"
  local visit_food_detection_strategy="${8:-}"
  local expected_fixture_count="${9:-1}"
  local fake_mode="${10:-success}"
  local require_native_work_counters="${11:-0}"
  local page_size="${12:-1000}"
  local retain_raw_json=false
  local wal_present_json=false
  local shm_present_json=false
  local journal_present_json=false
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status
  local -a arguments
  mkdir -p "$output_directory"
  (( retain_raw_databases )) && retain_raw_json=true
  (( ORIGINAL_COMPONENT_PRESENT[wal] )) && wal_present_json=true
  (( ORIGINAL_COMPONENT_PRESENT[shm] )) && shm_present_json=true
  (( ORIGINAL_COMPONENT_PRESENT[journal] )) && journal_present_json=true

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE="$fake_mode"
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  arguments=(
    --app="$FAKE_APP_PATH"
    --database="$DATABASE_PATH"
    --page-size="$page_size"
    --output-prefix="$output_prefix"
    --expected-fixture-count="$expected_fixture_count"
    --timeout-seconds=5
  )
  if [[ -n "$concurrency" ]]; then
    arguments+=(--vision-concurrency="$concurrency")
  fi
  if [[ -n "$pipeline_depth" ]]; then
    arguments+=(--pipeline-depth="$pipeline_depth")
  fi
  if [[ -n "$page_orchestration_strategy" ]]; then
    arguments+=(--page-orchestration-strategy="$page_orchestration_strategy")
  fi
  if [[ -n "$result_transport" ]]; then
    arguments+=(--result-transport="$result_transport")
  fi
  if [[ -n "$visit_food_detection_strategy" ]]; then
    arguments+=(--visit-food-detection-strategy="$visit_food_detection_strategy")
  fi
  (( retain_raw_databases )) && arguments+=(--retain-raw-databases)
  if [[ -n "$semantic_reference_database" ]]; then
    arguments+=(--semantic-reference-database="$semantic_reference_database")
  fi
  (( require_native_work_counters )) && arguments+=(--require-native-work-counters)

  zsh "$HARNESS_PATH" "${arguments[@]}" > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  assert_equal "$exit_status" "0" "$case_name exit status"
  assert_restored_contract "$case_name"

  local expected_concurrency="${concurrency:-2}"
  local expected_pipeline_depth="${pipeline_depth:-4}"
  local expected_page_orchestration_strategy="${page_orchestration_strategy:-serial}"
  local expected_result_transport="${result_transport:-legacy}"
  local expected_visit_food_detection_strategy="${visit_food_detection_strategy:-full-plan-v1}"
  local expected_attempted_samples="$expected_fixture_count"
  local expected_successful_attempts="$expected_fixture_count"
  local expected_retryable_attempts=0
  local expected_skipped_samples=0
  local expected_pending_count=0
  local expected_native_batch_count=$(( (expected_fixture_count + page_size - 1) / page_size ))
  local expected_native_attestation_schema=2
  local expected_native_work_counters_available=true
  local expected_native_work_counters_required=false
  local expected_native_lifecycle_balanced=true
  local expected_native_requested_assets_match=true
  local expected_native_batch_count_matches=true
  local expected_attempt_accounting_source="native-dispatch-counters-plus-rank-plan-plus-durable-result-state"
  local expected_full_reference_photo_parity=true
  local expected_full_reference_photo_mismatches=0
  if [[ "$expected_visit_food_detection_strategy" == "rank3-bulk-tail-v1" ]]; then
    expected_attempted_samples=12
    expected_successful_attempts=10
    expected_retryable_attempts=2
    expected_skipped_samples=4
    expected_pending_count=6
    expected_full_reference_photo_parity=false
    expected_full_reference_photo_mismatches=6
    expected_native_batch_count=$((
      (4 + page_size - 1) / page_size
      + (3 + page_size - 1) / page_size
      + (3 + page_size - 1) / page_size
      + (2 + page_size - 1) / page_size
    ))
  fi
  if [[ "$fake_mode" == "native-attestation-v1" ]]; then
    expected_native_attestation_schema=1
    expected_native_work_counters_available=false
    expected_native_lifecycle_balanced=null
    expected_native_requested_assets_match=null
    expected_native_batch_count_matches=null
    expected_attempt_accounting_source="rank-plan-plus-durable-result-state"
  fi
  (( require_native_work_counters )) && expected_native_work_counters_required=true
  local expected_concurrency_override=false
  local expected_pipeline_override=false
  local expected_concurrency_environment=null
  local expected_pipeline_environment=null
  local expected_semantic_reference_source="live-original-snapshot"
  local expected_semantic_reference_sha256
  local expected_semantic_reference_main_mode=600
  local expected_semantic_reference_main_size=null
  local expected_semantic_reference_wal_present=false
  local expected_semantic_reference_wal_sha256=""
  local expected_semantic_reference_wal_mode=""
  local expected_semantic_reference_wal_size=null
  local expected_semantic_reference_shm_present=false
  local expected_semantic_reference_shm_sha256=""
  local expected_semantic_reference_shm_mode=""
  local expected_semantic_reference_shm_size=null
  local expected_semantic_reference_journal_present=false
  local expected_semantic_reference_journal_sha256=""
  local expected_semantic_reference_journal_mode=""
  local expected_semantic_reference_journal_size=null
  local semantic_reference_component_path semantic_reference_suffix
  [[ -n "$concurrency" ]] && expected_concurrency_override=true
  [[ -n "$pipeline_depth" ]] && expected_pipeline_override=true
  [[ -n "$concurrency" ]] && expected_concurrency_environment="$concurrency"
  [[ -n "$pipeline_depth" ]] && expected_pipeline_environment="$pipeline_depth"
  if [[ -n "$semantic_reference_database" ]]; then
    expected_semantic_reference_source="external-current-control"
    expected_semantic_reference_sha256="$(shasum -a 256 "$semantic_reference_database" | awk '{print $1}')"
    expected_semantic_reference_main_mode="$(stat -f '%Lp' "$semantic_reference_database")"
    expected_semantic_reference_main_size="$(stat -f '%z' "$semantic_reference_database")"
    for semantic_reference_suffix in wal shm journal; do
      semantic_reference_component_path="$semantic_reference_database-$semantic_reference_suffix"
      [[ -f "$semantic_reference_component_path" ]] || continue
      case "$semantic_reference_suffix" in
        wal)
          expected_semantic_reference_wal_present=true
          expected_semantic_reference_wal_sha256="$(shasum -a 256 "$semantic_reference_component_path" | awk '{print $1}')"
          expected_semantic_reference_wal_mode="$(stat -f '%Lp' "$semantic_reference_component_path")"
          expected_semantic_reference_wal_size="$(stat -f '%z' "$semantic_reference_component_path")"
          ;;
        shm)
          expected_semantic_reference_shm_present=true
          expected_semantic_reference_shm_sha256="$(shasum -a 256 "$semantic_reference_component_path" | awk '{print $1}')"
          expected_semantic_reference_shm_mode="$(stat -f '%Lp' "$semantic_reference_component_path")"
          expected_semantic_reference_shm_size="$(stat -f '%z' "$semantic_reference_component_path")"
          ;;
        journal)
          expected_semantic_reference_journal_present=true
          expected_semantic_reference_journal_sha256="$(shasum -a 256 "$semantic_reference_component_path" | awk '{print $1}')"
          expected_semantic_reference_journal_mode="$(stat -f '%Lp' "$semantic_reference_component_path")"
          expected_semantic_reference_journal_size="$(stat -f '%z' "$semantic_reference_component_path")"
          ;;
      esac
    done
  else
    expected_semantic_reference_sha256="$(jq -r '.standaloneSnapshotSha256' "$output_prefix.json")"
  fi

  jq -e \
    '.status == "ok"
     and .schemaVersion == 6
     and .schemaCompatibility.previousSchemaVersion == 5
     and .schemaCompatibility.semanticFieldsPreserved
     and .pageSize == $pageSize
     and .resultTransport == $resultTransport
     and .requestedResultTransport == $resultTransport
     and .visitFoodDetectionStrategy == $visitFoodDetectionStrategy
     and .pageOrchestrationStrategy == $pageOrchestrationStrategy
     and .configuration.resultPageSize == $pageSize
     and .configuration.resultTransport == $resultTransport
     and .configuration.requestedResultTransport == $resultTransport
     and .configuration.expectedResolvedResultTransport == $resultTransport
     and .configuration.classificationStrategy == "pipeline"
     and .configuration.classificationStrategyMode == "native-default"
     and .configuration.classificationStrategyEnvironmentValue == null
     and .configuration.visitFoodDetectionStrategy == $visitFoodDetectionStrategy
     and .configuration.pageOrchestrationStrategy == $pageOrchestrationStrategy
     and .configuration.visionConcurrency == $concurrency
     and .configuration.visionConcurrencyOverridden == $concurrencyOverride
     and .configuration.pipelineDepth == $pipelineDepth
     and .configuration.pipelineDepthOverridden == $pipelineOverride
     and .runtimeAttestation.observedProcessPageSize == $pageSize
     and .runtimeAttestation.requestedResultTransport == $resultTransport
     and .runtimeAttestation.observedProcessResultTransport == $resultTransport
     and .runtimeAttestation.expectedResolvedResultTransport == $resultTransport
     and .runtimeAttestation.observedProcessResultTransportEnvironmentValue == $resultTransport
     and .runtimeAttestation.resultTransportEnvironmentPresent
     and .runtimeAttestation.expectedResolvedClassificationStrategy == "pipeline"
     and .runtimeAttestation.observedProcessClassificationStrategyEnvironmentValue == null
     and (.runtimeAttestation.classificationStrategyEnvironmentPresent | not)
     and .runtimeAttestation.classificationStrategyAttestationSource == "validated-environment-absence-plus-native-default"
     and .runtimeAttestation.expectedResolvedVisitFoodDetectionStrategy == $visitFoodDetectionStrategy
     and .runtimeAttestation.observedProcessVisitFoodDetectionStrategyEnvironmentValue == $visitFoodDetectionStrategy
     and .runtimeAttestation.visitFoodDetectionStrategyEnvironmentPresent
     and .runtimeAttestation.visitFoodDetectionStrategyAttestationSource == "process-environment-plus-strategy-aware-semantic-oracle"
     and .runtimeAttestation.nativeResultTransport.schemaVersion == $nativeAttestationSchema
     and .runtimeAttestation.nativeResultTransport.runId == .runtimeAttestation.runId
     and .runtimeAttestation.nativeResultTransport.configuredResultTransport == $resultTransport
     and .runtimeAttestation.nativeResultTransport.resolvedResultTransport == $resultTransport
     and .runtimeAttestation.nativeResultTransport.selectedResultTransport == $resultTransport
     and .runtimeAttestation.nativeResultTransport.observedAtEpochSeconds == .runtimeAttestation.observedAtEpochSeconds
     and .runtimeAttestation.nativeResultTransport.workCountersAvailable == $nativeWorkCountersAvailable
     and (if $nativeWorkCountersAvailable then
       .runtimeAttestation.nativeResultTransport.lastObservedAtEpochSeconds >= .runtimeAttestation.nativeResultTransport.observedAtEpochSeconds
       and .runtimeAttestation.nativeResultTransport.lastObservedAtEpochSeconds <= .triggerBoundary.durableCompletionObservedAtEpochSeconds
       and .runtimeAttestation.nativeResultTransport.workCounters.startedBatchCount == $nativeBatchCount
       and .runtimeAttestation.nativeResultTransport.workCounters.startedRequestedAssetCount == $attemptedSamples
       and .runtimeAttestation.nativeResultTransport.workCounters.completedBatchCount == $nativeBatchCount
       and .runtimeAttestation.nativeResultTransport.workCounters.completedRequestedAssetCount == $attemptedSamples
       and .runtimeAttestation.nativeResultTransport.workCounters.resolvedBatchCount == $nativeBatchCount
       and .runtimeAttestation.nativeResultTransport.workCounters.resolvedRequestedAssetCount == $attemptedSamples
       and .runtimeAttestation.nativeResultTransport.workCounters.rejectedBatchCount == 0
       and .runtimeAttestation.nativeResultTransport.workCounters.rejectedRequestedAssetCount == 0
       and .runtimeAttestation.nativeResultTransport.workCounters.cancelledBatchCount == 0
       and .runtimeAttestation.nativeResultTransport.workCounters.cancelledRequestedAssetCount == 0
       and .runtimeAttestation.nativeResultTransport.workCounters.inFlightBatchCount == 0
       and .runtimeAttestation.nativeResultTransport.workCounters.inFlightRequestedAssetCount == 0
     else
       .runtimeAttestation.nativeResultTransport.lastObservedAtEpochSeconds == null
       and .runtimeAttestation.nativeResultTransport.workCounters == null
     end)
     and .runtimeAttestation.source == "process-environment-plus-native-result-transport-attestation"
     and .runtimeAttestation.expectedResolvedPageOrchestrationStrategy == $pageOrchestrationStrategy
     and .runtimeAttestation.observedProcessPageOrchestrationStrategyEnvironmentValue == $pageOrchestrationStrategy
     and .runtimeAttestation.pageOrchestrationStrategyEnvironmentPresent
     and .runtimeAttestation.expectedResolvedVisionConcurrency == $concurrency
     and .runtimeAttestation.observedProcessVisionConcurrencyEnvironmentValue == $concurrencyEnvironment
     and .runtimeAttestation.visionConcurrencyEnvironmentPresent == $concurrencyOverride
     and .runtimeAttestation.expectedResolvedPipelineDepth == $pipelineDepth
     and .runtimeAttestation.observedProcessPipelineDepthEnvironmentValue == $pipelineEnvironment
     and .runtimeAttestation.pipelineDepthEnvironmentPresent == $pipelineOverride
     and (.runtimeAttestation.runId | contains("-t\($resultTransport)-o\($pageOrchestrationStrategy)-c\($concurrency)-d\($pipelineDepth)-"))
     and .triggerBoundary.requiredAction == "confirm-start-deep-scan"
     and .triggerBoundary.validationEntrypoint == "isolated-visit-food"
     and (.triggerBoundary.rescanAllowed | not)
     and (.triggerBoundary.preparedVisionStateSha256 | test("^[0-9a-f]{64}$"))
     and .triggerBoundary.preTriggerVisionStateSha256 == .triggerBoundary.preparedVisionStateSha256
     and .triggerBoundary.unchangedBeforeTrigger
     and .triggerBoundary.preTriggerObservedAtEpochSeconds >= .runtimeAttestation.processEnvironmentObservedAtEpochSeconds
     and .triggerBoundary.triggerEpochSeconds >= .triggerBoundary.preTriggerObservedAtEpochSeconds
     and .triggerBoundary.triggerObservedAtEpochSeconds >= .triggerBoundary.triggerEpochSeconds
     and .runtimeAttestation.observedAtEpochSeconds >= .triggerBoundary.triggerEpochSeconds
     and .runtimeAttestation.observedAtEpochSeconds <= .triggerBoundary.durableCompletionObservedAtEpochSeconds
     and .triggerBoundary.durableCompletionObservedAtEpochSeconds >= .triggerBoundary.triggerObservedAtEpochSeconds
     and .triggerBoundary.maxTriggerAgeSeconds == 30
     and .triggerBoundary.triggerFollowedPreTriggerAttestation
     and .triggerBoundary.triggerWasNotFutureDated
     and .triggerBoundary.triggerWasFresh
     and .buildAttestation.strictCodeSignatureVerified
     and (.buildAttestation.manualLaunch | not)
     and .buildAttestation.canonicalAppPathStableAcrossManualRefresh
     and .buildAttestation.signingIdentityStableAcrossManualRefresh
     and .buildAttestation.mainJsBundleStableAcrossManualRefresh
     and (.buildAttestation.executableRefreshedAfterReadyToLaunch | not)
     and .buildAttestation.prelaunchExecutableSha256 == .buildAttestation.suppliedExecutableSha256
     and .buildAttestation.prelaunchMainJsBundleSha256 == .buildAttestation.suppliedMainJsBundleSha256
     and .buildAttestation.codeSigningIdentifier == "com.jonluca.photo-restaurant-matcher"
     and .buildAttestation.codeSigningTeamIdentifier == "F35YQQ5672"
     and (.buildAttestation.codeSigningDesignatedRequirement | startswith("identifier \"com.jonluca.photo-restaurant-matcher\""))
     and .buildAttestation.exactExecutableMatch
     and .buildAttestation.exactMainJsBundleMatch
     and .buildAttestation.suppliedExecutableSha256 == .buildAttestation.runningExecutableSha256
     and .buildAttestation.suppliedMainJsBundleSha256 == .buildAttestation.runningMainJsBundleSha256
     and .validation.exactSemanticPhotoParity == $fullReferencePhotoParity
     and .validation.photoMismatchCount == $fullReferencePhotoMismatches
     and .validation.exactStrategySemanticPhotoParity
     and .validation.strategyPhotoMismatchCount == 0
     and .validation.exactFullReferencePhotoParity == $fullReferencePhotoParity
     and .validation.fullReferencePhotoMismatchCount == $fullReferencePhotoMismatches
     and .validation.successfulAttemptMismatchCount == 0
     and .validation.retryablePartialStateCount == 0
     and .validation.skippedWriteCount == 0
     and .validation.photoIdMismatchCount == 0
     and .validation.unplannedPendingCount == 0
     and .validation.exactVisitFoodParity
     and .validation.exactPositiveVisitSet
     and .validation.positiveVisitIdMismatchCount == 0
     and .validation.invalidVisitFoodCount == 0
     and .validation.pendingCount == $pendingCount
     and .validation.pendingRowsAreExpected
     and .validation.workloadAccountingExact
     and .validation.nativeWorkCountersRequired == $nativeWorkCountersRequired
     and .validation.nativeWorkCountersAvailable == $nativeWorkCountersAvailable
     and .validation.nativeWorkLifecycleBalanced == $nativeLifecycleBalanced
     and .validation.nativeRequestedAssetCountMatchesAttempts == $nativeRequestedAssetsMatch
     and .validation.nativeBatchCountMatchesPlan == $nativeBatchCountMatches
     and .validation.integrity == "ok"
     and .validation.foreignKeyViolationCount == 0
     and .originalDatabaseSha256 == $originalSha256
     and .originalDatabase.main.sha256 == $originalSha256
     and .originalDatabase.main.mode == $originalMainMode
     and .originalDatabase.wal.present == $walPresent
     and .originalDatabase.shm.present == $shmPresent
     and .originalDatabase.journal.present == $journalPresent
     and .semanticReference.source == $semanticReferenceSource
     and .semanticReference.sha256 == $semanticReferenceSha256
     and (.semanticReference.sha256 | test("^[0-9a-f]{64}$"))
     and .semanticReference.components.main.present
     and .semanticReference.components.main.sha256 == $semanticReferenceSha256
     and .semanticReference.components.main.mode == $semanticReferenceMainMode
     and (.semanticReference.components.main.bytes | type) == "number"
     and .semanticReference.components.main.bytes > 0
     and ($semanticReferenceMainSize == null or .semanticReference.components.main.bytes == $semanticReferenceMainSize)
     and .semanticReference.components.wal.present == $semanticReferenceWalPresent
     and .semanticReference.components.wal.sha256 == (if $semanticReferenceWalPresent then $semanticReferenceWalSha256 else null end)
     and .semanticReference.components.wal.mode == (if $semanticReferenceWalPresent then $semanticReferenceWalMode else null end)
     and .semanticReference.components.wal.bytes == $semanticReferenceWalSize
     and (if $semanticReferenceWalPresent then .semanticReference.components.wal.bytes == 0 else true end)
     and .semanticReference.components.shm.present == $semanticReferenceShmPresent
     and .semanticReference.components.shm.sha256 == (if $semanticReferenceShmPresent then $semanticReferenceShmSha256 else null end)
     and .semanticReference.components.shm.mode == (if $semanticReferenceShmPresent then $semanticReferenceShmMode else null end)
     and .semanticReference.components.shm.bytes == $semanticReferenceShmSize
     and .semanticReference.components.journal.present == $semanticReferenceJournalPresent
     and .semanticReference.components.journal.sha256 == (if $semanticReferenceJournalPresent then $semanticReferenceJournalSha256 else null end)
     and .semanticReference.components.journal.mode == (if $semanticReferenceJournalPresent then $semanticReferenceJournalMode else null end)
     and .semanticReference.components.journal.bytes == $semanticReferenceJournalSize
     and (if $semanticReferenceJournalPresent then .semanticReference.components.journal.bytes == 0 else true end)
     and .restoration.exactMainAndSidecarSetRestored
     and .restoration.launchEnvironmentRestored
     and .restoration.rawDatabasePolicyApplied
     and .restoration.reportPublishedAfterRestoration
     and .restoration.restoredDatabaseSha256 == .originalDatabaseSha256
     and .rawDatabases.retained == $retainRaw
     and .resultDatabase.retained == $retainRaw
     and .workload.visitFoodDetectionStrategy == $visitFoodDetectionStrategy
     and .workload.plannedSamples == $fixtureCount
     and .workload.attemptedSamples == $attemptedSamples
     and .workload.successfulAttempts == $successfulAttempts
     and .workload.retryableAttempts == $retryableAttempts
     and .workload.skippedSamples == $skippedSamples
     and .workload.expectedNativeBatchCount == $nativeBatchCount
     and .workload.directNativeCountersRequired == $nativeWorkCountersRequired
     and .workload.directNativeCountersAvailable == $nativeWorkCountersAvailable
     and .workload.attemptAccountingSource == $attemptAccountingSource
     and (if $nativeWorkCountersAvailable then
       .workload.nativeDispatch == .runtimeAttestation.nativeResultTransport.workCounters
     else
       .workload.nativeDispatch == null
     end)
     and .samplesPath == "result.samples.tsv"' \
    --argjson concurrency "$expected_concurrency" \
    --argjson pageSize "$page_size" \
    --argjson pipelineDepth "$expected_pipeline_depth" \
    --arg resultTransport "$expected_result_transport" \
    --arg visitFoodDetectionStrategy "$expected_visit_food_detection_strategy" \
    --arg pageOrchestrationStrategy "$expected_page_orchestration_strategy" \
    --argjson concurrencyOverride "$expected_concurrency_override" \
    --argjson pipelineOverride "$expected_pipeline_override" \
    --argjson concurrencyEnvironment "$expected_concurrency_environment" \
    --argjson pipelineEnvironment "$expected_pipeline_environment" \
    --argjson retainRaw "$retain_raw_json" \
    --argjson fixtureCount "$expected_fixture_count" \
    --argjson attemptedSamples "$expected_attempted_samples" \
    --argjson successfulAttempts "$expected_successful_attempts" \
    --argjson retryableAttempts "$expected_retryable_attempts" \
    --argjson skippedSamples "$expected_skipped_samples" \
    --argjson nativeBatchCount "$expected_native_batch_count" \
    --argjson nativeAttestationSchema "$expected_native_attestation_schema" \
    --argjson nativeWorkCountersAvailable "$expected_native_work_counters_available" \
    --argjson nativeWorkCountersRequired "$expected_native_work_counters_required" \
    --argjson nativeLifecycleBalanced "$expected_native_lifecycle_balanced" \
    --argjson nativeRequestedAssetsMatch "$expected_native_requested_assets_match" \
    --argjson nativeBatchCountMatches "$expected_native_batch_count_matches" \
    --arg attemptAccountingSource "$expected_attempt_accounting_source" \
    --argjson pendingCount "$expected_pending_count" \
    --argjson fullReferencePhotoParity "$expected_full_reference_photo_parity" \
    --argjson fullReferencePhotoMismatches "$expected_full_reference_photo_mismatches" \
    --arg originalSha256 "$ORIGINAL_DATABASE_SHA256" \
    --arg originalMainMode "$ORIGINAL_DATABASE_MODE" \
    --argjson walPresent "$wal_present_json" \
    --argjson shmPresent "$shm_present_json" \
    --argjson journalPresent "$journal_present_json" \
    --arg semanticReferenceSource "$expected_semantic_reference_source" \
    --arg semanticReferenceSha256 "$expected_semantic_reference_sha256" \
    --arg semanticReferenceMainMode "$expected_semantic_reference_main_mode" \
    --argjson semanticReferenceMainSize "$expected_semantic_reference_main_size" \
    --argjson semanticReferenceWalPresent "$expected_semantic_reference_wal_present" \
    --arg semanticReferenceWalSha256 "$expected_semantic_reference_wal_sha256" \
    --arg semanticReferenceWalMode "$expected_semantic_reference_wal_mode" \
    --argjson semanticReferenceWalSize "$expected_semantic_reference_wal_size" \
    --argjson semanticReferenceShmPresent "$expected_semantic_reference_shm_present" \
    --arg semanticReferenceShmSha256 "$expected_semantic_reference_shm_sha256" \
    --arg semanticReferenceShmMode "$expected_semantic_reference_shm_mode" \
    --argjson semanticReferenceShmSize "$expected_semantic_reference_shm_size" \
    --argjson semanticReferenceJournalPresent "$expected_semantic_reference_journal_present" \
    --arg semanticReferenceJournalSha256 "$expected_semantic_reference_journal_sha256" \
    --arg semanticReferenceJournalMode "$expected_semantic_reference_journal_mode" \
    --argjson semanticReferenceJournalSize "$expected_semantic_reference_journal_size" \
    "$output_prefix.json" >/dev/null
  assert_mode "$output_prefix.json" 600 "$case_name report"
  assert_mode "$output_prefix.samples.tsv" 600 "$case_name samples"
  assert_mode "$DATABASE_PATH.palate-calendar-validation.lock" 600 "$case_name lock"
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  if rg -F -q "$TEMPORARY_DIRECTORY" "$output_prefix.json"; then
    print -u2 "$case_name aggregate report leaked an absolute fixture path"
    return 1
  fi
  local retained_snapshot
  retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
  if (( retain_raw_databases )); then
    [[ -n "$retained_snapshot" && -f "$output_prefix.result.db" ]]
    assert_mode "$retained_snapshot" 600 "$case_name retained snapshot"
    assert_mode "$output_prefix.result.db" 600 "$case_name retained result"
    sqlite3 -readonly "$(immutable_sqlite_uri "$output_prefix.result.db")" \
      "PRAGMA integrity_check;" | rg -qx ok
  else
    [[ -z "$retained_snapshot" && ! -e "$output_prefix.result.db" ]]
    jq -e \
      '.rawDatabases.snapshotPath == null and .resultDatabase.path == null' \
      "$output_prefix.json" >/dev/null
  fi
  rg -q \
    "^READY run_id=vision-page-${page_size}-t${expected_result_transport}-o${expected_page_orchestration_strategy}-c${expected_concurrency}-d${expected_pipeline_depth}-.* result_transport_requested=${expected_result_transport} result_transport_process_environment=${expected_result_transport} result_transport_expected=${expected_result_transport} visit_food_detection_strategy=${expected_visit_food_detection_strategy} page_orchestration_strategy=${expected_page_orchestration_strategy} vision_concurrency=${expected_concurrency} .*pipeline_depth=${expected_pipeline_depth} " \
    "$log_path"
  rg -q \
    'required_action=confirm-start-deep-scan validation_entrypoint=isolated-visit-food rescan_allowed=false$' \
    "$log_path"
}

run_process_mismatch_case() {
  local mode="$1"
  local expected_message="$2"
  local output_directory="$TEMPORARY_DIRECTORY/$mode"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local exit_status
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE="$mode"
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --page-orchestration-strategy=lookahead \
    --vision-concurrency=8 \
    --pipeline-depth=12 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" "1" "$mode exit status"
  rg -q "$expected_message" "$log_path"
  assert_restored_contract "$mode"
}

run_native_attestation_failure_case() {
  local mode="$1"
  local expected_message="$2"
  local require_native_work_counters="${3:-0}"
  local output_directory="$TEMPORARY_DIRECTORY/$mode"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE="$mode"
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  local -a arguments=(
    --app="$FAKE_APP_PATH"
    --database="$DATABASE_PATH"
    --page-size=1000
    --result-transport=packed-v1
    --output-prefix="$output_prefix"
    --expected-fixture-count=1
    --timeout-seconds=5
  )
  (( require_native_work_counters )) && arguments+=(--require-native-work-counters)
  zsh "$HARNESS_PATH" "${arguments[@]}" > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 1 "$mode exit status"
  rg -q "$expected_message" "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "$mode"
}

run_report_publication_sync_failure_case() {
  local output_directory="$TEMPORARY_DIRECTORY/report-publication-sync-failure"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status retained_snapshot
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  export PALATE_VISION_PAGE_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE=report-published
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  unset PALATE_VISION_PAGE_HARNESS_TEST_FAIL_DURABILITY_SYNC_PHASE

  assert_equal "$exit_status" 1 "report publication sync failure exit status"
  rg -q 'Injected durability sync failure: report-published' "$log_path"
  [[ ! -e "$output_prefix.json" && ! -L "$output_prefix.json" ]]
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  [[ ! -e "$output_prefix.result.db" ]]
  retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
  [[ -z "$retained_snapshot" ]]
  assert_restored_contract "report publication sync failure"
}

run_signal_case() {
  local case_name="$1"
  local signal_name="$2"
  local expected_exit_status="$3"
  local page_orchestration_strategy="$4"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --page-orchestration-strategy="$page_orchestration_strategy" \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  kill -"$signal_name" "$harness_pid"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e

  assert_equal "$exit_status" "$expected_exit_status" "$case_name exit status"
  assert_restored_contract "$case_name"
  [[ ! -e "$output_prefix.json" ]]
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  [[ ! -e "$output_prefix.result.db" ]]
  [[ -z "$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)" ]]
}

run_mismatched_build_case() {
  local output_directory="$TEMPORARY_DIRECTORY/mismatched-build"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local exit_status
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  export PALATE_VISION_PAGE_HARNESS_FAKE_RUNNING_APP="$MISMATCH_APP_PATH"
  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e
  unset PALATE_VISION_PAGE_HARNESS_FAKE_RUNNING_APP

  assert_equal "$exit_status" 1 "mismatched build exit status"
  rg -q 'Running Palate bundle does not match --app' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "mismatched build"
}

reset_manual_app_fixture() {
  rm -f -- \
    "$MANUAL_APP_PATH/Palate" \
    "$MANUAL_APP_PATH/.fake-codesign-identifier" \
    "$MANUAL_APP_PATH/.fake-codesign-team-identifier" \
    "$MANUAL_APP_PATH/.fake-codesign-designated-requirement"
  ln -s /usr/bin/true "$MANUAL_APP_PATH/Palate"
  print -r -- "fixture-release-bundle" > "$MANUAL_APP_PATH/main.jsbundle"
}

refresh_manual_app_fixture() {
  rm -f -- "$MANUAL_APP_PATH/Palate"
  ln -s /usr/bin/false "$MANUAL_APP_PATH/Palate"
}

run_manual_product_refresh_success_case() {
  local output_directory="$TEMPORARY_DIRECTORY/manual-product-refresh-success"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status prelaunch_executable_sha256 refreshed_executable_sha256
  local bundle_sha256
  mkdir -p "$output_directory"
  reset_manual_app_fixture
  prelaunch_executable_sha256="$(shasum -a 256 "$MANUAL_APP_PATH/Palate" | awk '{print $1}')"
  bundle_sha256="$(shasum -a 256 "$MANUAL_APP_PATH/main.jsbundle" | awk '{print $1}')"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  export PALATE_VISION_PAGE_HARNESS_FAKE_RUNNING_APP="$MANUAL_APP_PATH"
  zsh "$HARNESS_PATH" \
    --app="$MANUAL_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    --manual-launch \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready_to_launch "$log_path" "$harness_pid"
  refresh_manual_app_fixture
  refreshed_executable_sha256="$(shasum -a 256 "$MANUAL_APP_PATH/Palate" | awk '{print $1}')"
  if [[ "$refreshed_executable_sha256" == "$prelaunch_executable_sha256" ]]; then
    print -u2 "Manual refresh fixture did not change its executable hash"
    return 1
  fi
  open "$MANUAL_APP_PATH"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  unset PALATE_VISION_PAGE_HARNESS_FAKE_RUNNING_APP

  assert_equal "$exit_status" 0 "manual product refresh success exit status"
  jq -e \
    '.status == "ok"
     and .buildAttestation.strictCodeSignatureVerified
     and .buildAttestation.manualLaunch
     and .buildAttestation.canonicalAppPathStableAcrossManualRefresh
     and .buildAttestation.signingIdentityStableAcrossManualRefresh
     and .buildAttestation.mainJsBundleStableAcrossManualRefresh
     and .buildAttestation.executableRefreshedAfterReadyToLaunch
     and .buildAttestation.prelaunchExecutableSha256 == $prelaunchExecutableSha256
     and .buildAttestation.suppliedExecutableSha256 == $refreshedExecutableSha256
     and .buildAttestation.runningExecutableSha256 == $refreshedExecutableSha256
     and .buildAttestation.prelaunchExecutableSha256 != .buildAttestation.suppliedExecutableSha256
     and .buildAttestation.prelaunchMainJsBundleSha256 == $bundleSha256
     and .buildAttestation.suppliedMainJsBundleSha256 == $bundleSha256
     and .buildAttestation.runningMainJsBundleSha256 == $bundleSha256
     and .buildAttestation.codeSigningIdentifier == "com.jonluca.photo-restaurant-matcher"
     and .buildAttestation.codeSigningTeamIdentifier == "F35YQQ5672"
     and (.buildAttestation.codeSigningDesignatedRequirement | startswith("identifier \"com.jonluca.photo-restaurant-matcher\""))
     and .buildAttestation.exactExecutableMatch
     and .buildAttestation.exactMainJsBundleMatch' \
    --arg prelaunchExecutableSha256 "$prelaunch_executable_sha256" \
    --arg refreshedExecutableSha256 "$refreshed_executable_sha256" \
    --arg bundleSha256 "$bundle_sha256" \
    "$output_prefix.json" >/dev/null
  assert_restored_contract "manual product refresh success"
}

run_manual_product_refresh_process_mismatch_case() {
  local output_directory="$TEMPORARY_DIRECTORY/manual-product-refresh-process-mismatch"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status refreshed_executable_sha256 running_executable_sha256
  mkdir -p "$output_directory"
  reset_manual_app_fixture

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  export PALATE_VISION_PAGE_HARNESS_FAKE_RUNNING_APP="$MANUAL_MISMATCH_APP_PATH"
  zsh "$HARNESS_PATH" \
    --app="$MANUAL_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    --manual-launch \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready_to_launch "$log_path" "$harness_pid"
  refresh_manual_app_fixture
  refreshed_executable_sha256="$(shasum -a 256 "$MANUAL_APP_PATH/Palate" | awk '{print $1}')"
  running_executable_sha256="$(shasum -a 256 "$MANUAL_MISMATCH_APP_PATH/Palate" | awk '{print $1}')"
  open "$MANUAL_APP_PATH"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  unset PALATE_VISION_PAGE_HARNESS_FAKE_RUNNING_APP

  assert_equal "$exit_status" 1 "manual product refresh process mismatch exit status"
  rg -q 'Running Palate bundle does not match --app' "$log_path"
  rg -F -q \
    "Executable expected=$refreshed_executable_sha256 actual=$running_executable_sha256" \
    "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "manual product refresh process mismatch"
}

run_pretrigger_mutation_case() {
  local output_directory="$TEMPORARY_DIRECTORY/pretrigger-mutation"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local exit_status
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=pretrigger-mutation
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 1 "pre-trigger mutation exit status"
  rg -q 'Vision fixture state changed between installation and trigger readiness' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "pre-trigger mutation"
}

run_concurrent_lock_case() {
  local output_directory="$TEMPORARY_DIRECTORY/concurrent-lock"
  local first_prefix="$output_directory/first"
  local second_prefix="$output_directory/second"
  local first_log="$output_directory/first.log"
  local second_log="$output_directory/second.log"
  local first_pid first_exit second_exit
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$first_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$first_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$first_log" 2>&1 &
  first_pid="$!"
  wait_for_ready "$first_log" "$first_pid"

  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$second_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$second_log" 2>&1
  second_exit="$?"
  set -e
  assert_equal "$second_exit" 75 "concurrent lock contender exit status"
  rg -q 'already owns this database lock' "$second_log"
  [[ ! -e "$second_prefix.json" && ! -e "$second_prefix.samples.tsv" ]]

  kill -TERM "$first_pid"
  set +e
  wait "$first_pid"
  first_exit="$?"
  set -e
  assert_equal "$first_exit" 143 "concurrent lock owner exit status"
  [[ ! -e "$first_prefix.json" ]]
  assert_restored_contract "concurrent lock owner"
}

run_default_raw_cleanup_failure_case() {
  local output_directory="$TEMPORARY_DIRECTORY/raw-cleanup-failure"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local recovery_log="$output_directory/recovery.log"
  local harness_pid exit_status recovery_status retained_snapshot
  local guard_path="$DATABASE_PATH.palate-calendar-validation.guard"
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  export PALATE_VISION_PAGE_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP=1
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e
  unset PALATE_VISION_PAGE_HARNESS_TEST_FAIL_RAW_DATABASE_CLEANUP

  assert_equal "$exit_status" 1 "raw cleanup failure exit status"
  rg -q 'Sensitive database copy cleanup failed; refusing to publish a report' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  [[ -d "$guard_path" && ! -L "$guard_path" ]]
  assert_restored_contract "raw cleanup failure"
  retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
  [[ -n "$retained_snapshot" && -f "$output_prefix.result.db" ]]
  assert_mode "$retained_snapshot" 600 "raw cleanup failure snapshot"
  assert_mode "$output_prefix.result.db" 600 "raw cleanup failure result"
  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard \
    > "$recovery_log" 2>&1
  recovery_status="$?"
  set -e
  assert_equal "$recovery_status" 0 "raw cleanup recovery exit status"
  rg -q '^RECOVERED_STALE_GUARD ' "$recovery_log"
  [[ ! -e "$guard_path" ]]
  [[ ! -e "$retained_snapshot" && ! -e "$output_prefix.result.db" ]]
  assert_restored_contract "raw cleanup recovery"
}

create_exact_sidecar_fixture() {
  local ready_path="$TEMPORARY_DIRECTORY/crash-wal.ready"
  local writer_log="$TEMPORARY_DIRECTORY/crash-wal.log"
  local writer_pid writer_exit
  rm -f -- "$ready_path" "$writer_log"

  sqlite3 "$DATABASE_PATH" > "$writer_log" 2>&1 <<SQL &
PRAGMA wal_autocheckpoint = 0;
BEGIN IMMEDIATE;
UPDATE photos SET foodConfidence = 0.91 WHERE id = 'photo-1';
COMMIT;
.shell /usr/bin/touch "$ready_path"
.shell /bin/sleep 30
SQL
  writer_pid="$!"
  for _ in {1..500}; do
    [[ -e "$ready_path" ]] && break
    kill -0 "$writer_pid" 2>/dev/null || break
    sleep 0.01
  done
  [[ -e "$ready_path" ]]
  kill -KILL "$writer_pid"
  set +e
  wait "$writer_pid"
  writer_exit="$?"
  set -e
  assert_equal "$writer_exit" 137 "crashed WAL writer exit status"
  [[ -s "$DATABASE_PATH-wal" && -s "$DATABASE_PATH-shm" ]]
  touch "$DATABASE_PATH-journal"
  chmod 640 "$DATABASE_PATH"
  chmod 600 "$DATABASE_PATH-wal"
  chmod 640 "$DATABASE_PATH-shm"
  chmod 604 "$DATABASE_PATH-journal"
  capture_original_database_contract
}

run_sigkill_recovery_case() {
  local output_directory="$TEMPORARY_DIRECTORY/sigkill-recovery"
  local output_prefix="$output_directory/result"
  local blocked_prefix="$output_directory/blocked"
  local log_path="$output_directory/harness.log"
  local blocked_log="$output_directory/blocked.log"
  local corrupt_log="$output_directory/corrupt-recovery.log"
  local recovery_log="$output_directory/recovery.log"
  local saved_manifest="$output_directory/manifest.saved.json"
  local guard_path="$DATABASE_PATH.palate-calendar-validation.guard"
  local harness_pid killed_exit blocked_exit recovery_exit live_disposable_sha256
  local suffix
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  kill -KILL "$harness_pid"
  set +e
  wait "$harness_pid"
  killed_exit="$?"
  set -e
  assert_equal "$killed_exit" 137 "SIGKILL harness exit status"
  pkill -TERM -x Palate 2>/dev/null || true
  # A sleep child that was executing at SIGKILL may briefly retain fd 9.
  for _ in {1..100}; do
    if zsh -c 'exec 8> "$1"; lockf -s -t 0 8' -- \
      "$DATABASE_PATH.palate-calendar-validation.lock" 2>/dev/null; then
      break
    fi
    sleep 0.01
  done

  [[ ! -e "$output_prefix.json" ]]
  [[ -d "$guard_path" && ! -L "$guard_path" ]]
  assert_mode "$guard_path" 700 "SIGKILL guard directory"
  assert_mode "$guard_path/main" 600 "SIGKILL protected main"
  assert_mode "$guard_path/manifest.json" 600 "SIGKILL manifest"
  for suffix in wal shm journal; do
    (( ORIGINAL_COMPONENT_PRESENT[$suffix] )) \
      && assert_mode "$guard_path/$suffix" 600 "SIGKILL protected $suffix"
  done
  jq -e \
    --arg databasePath "${DATABASE_PATH:A}" \
    '.schemaVersion == 1
     and .kind == "palate-vision-result-page"
     and .databasePath == $databasePath
     and (.launchEnvironment | keys | sort) == ([
       "PALATE_VISION_RESULT_PAGE_SIZE",
       "PALATE_VISION_RESULT_TRANSPORT",
       "PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH",
       "PALATE_VISION_CLASSIFICATION_STRATEGY",
       "PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY",
       "PALATE_VISION_CONCURRENCY",
       "PALATE_VISION_PIPELINE_DEPTH",
       "PALATE_VISION_VALIDATION_RUN_ID",
       "PALATE_VISIT_FOOD_DETECTION_STRATEGY"
     ] | sort)
     and .components.main.present
     and .components.wal.present
     and .components.shm.present
     and .components.journal.present
     and (.artifactCleanup.temporaryPaths | length) == 8
     and .artifactCleanup.temporaryPaths[-1] == ($databasePath + ".vision-result-transport-attestation.tmp-" + .createdByRunId)
     and (.artifactCleanup.retainRawDatabases | not)' \
    "$guard_path/manifest.json" >/dev/null

  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$blocked_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$blocked_log" 2>&1
  blocked_exit="$?"
  set -e
  assert_equal "$blocked_exit" 74 "stale guard fail-closed exit status"
  rg -q 'must be restored before continuing' "$blocked_log"
  [[ ! -e "$blocked_prefix.json" ]]

  live_disposable_sha256="$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')"
  cp "$guard_path/manifest.json" "$saved_manifest"
  chmod 600 "$saved_manifest"
  jq --arg corruptHash "$(printf '0%.0s' {1..64})" \
    '.components.main.sha256 = $corruptHash' \
    "$saved_manifest" > "$guard_path/manifest.json.tmp"
  chmod 600 "$guard_path/manifest.json.tmp"
  mv -f -- "$guard_path/manifest.json.tmp" "$guard_path/manifest.json"
  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard \
    > "$corrupt_log" 2>&1
  recovery_exit="$?"
  set -e
  assert_equal "$recovery_exit" 1 "corrupt recovery refusal exit status"
  rg -q 'guard was retained' "$corrupt_log"
  [[ -d "$guard_path" ]]
  assert_equal \
    "$(shasum -a 256 "$DATABASE_PATH" | awk '{print $1}')" \
    "$live_disposable_sha256" \
    "corrupt recovery live disposable hash"

  cp "$saved_manifest" "$guard_path/manifest.json.tmp"
  chmod 600 "$guard_path/manifest.json.tmp"
  mv -f -- "$guard_path/manifest.json.tmp" "$guard_path/manifest.json"
  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard \
    > "$recovery_log" 2>&1
  recovery_exit="$?"
  set -e
  if (( recovery_exit != 0 )); then
    sed -n '1,240p' "$recovery_log" >&2
  fi
  assert_equal "$recovery_exit" 0 "stale guard recovery exit status"
  rg -q '^RECOVERED_STALE_GUARD ' "$recovery_log"
  [[ ! -e "$guard_path" ]]
  [[ ! -e "$output_prefix.json" && ! -e "$output_prefix.result.db" ]]
  [[ -z "$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)" ]]
  assert_restored_contract "SIGKILL recovery"
}

run_interrupted_recovery_temp_cleanup_case() {
  local output_directory="$TEMPORARY_DIRECTORY/interrupted-recovery-temp-cleanup"
  local output_prefix="$output_directory/result"
  local validation_log="$output_directory/validation.log"
  local interrupted_recovery_log="$output_directory/interrupted-recovery.log"
  local completed_recovery_log="$output_directory/completed-recovery.log"
  local guard_path="$DATABASE_PATH.palate-calendar-validation.guard"
  local recovery_ready_path="$FAKE_STATE_DIRECTORY/recovery-prepared"
  local recovery_continue_path="$FAKE_STATE_DIRECTORY/recovery-continue"
  local attestation_path
  local harness_pid recovery_pid killed_exit recovery_killed_exit recovery_exit retained_snapshot
  mkdir -p "$output_directory"
  rm -f -- "$recovery_ready_path" "$recovery_continue_path"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$validation_log" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$validation_log" "$harness_pid"
  kill -KILL "$harness_pid"
  set +e
  wait "$harness_pid"
  killed_exit="$?"
  set -e
  assert_equal "$killed_exit" 137 "interrupted recovery setup SIGKILL exit status"
  pkill -TERM -x Palate 2>/dev/null || true
  for _ in {1..100}; do
    if zsh -c 'exec 8> "$1"; lockf -s -t 0 8' -- \
      "$DATABASE_PATH.palate-calendar-validation.lock" 2>/dev/null; then
      break
    fi
    sleep 0.01
  done
  [[ -d "$guard_path" ]]
  attestation_path="$(jq -r '.artifactCleanup.temporaryPaths[-1]' "$guard_path/manifest.json")"
  print -r -- '{"stale":"native-attestation"}' > "$attestation_path"
  chmod 600 "$attestation_path"

  export PALATE_VISION_PAGE_HARNESS_TEST_PAUSE_RECOVERY_AFTER_PREPARE=1
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard \
    > "$interrupted_recovery_log" 2>&1 &
  recovery_pid="$!"
  wait_for_path "$recovery_ready_path" "$recovery_pid" "stale-guard recovery"
  [[ -f "$guard_path/recovery-main.tmp" && ! -L "$guard_path/recovery-main.tmp" ]]
  assert_mode "$guard_path/recovery-main.tmp" 600 "interrupted recovery private main temp"
  kill -KILL "$recovery_pid"
  set +e
  wait "$recovery_pid"
  recovery_killed_exit="$?"
  set -e
  assert_equal "$recovery_killed_exit" 137 "interrupted stale-guard recovery SIGKILL exit status"
  unset PALATE_VISION_PAGE_HARNESS_TEST_PAUSE_RECOVERY_AFTER_PREPARE
  rm -f -- "$recovery_ready_path" "$recovery_continue_path"
  for _ in {1..100}; do
    if zsh -c 'exec 8> "$1"; lockf -s -t 0 8' -- \
      "$DATABASE_PATH.palate-calendar-validation.lock" 2>/dev/null; then
      break
    fi
    sleep 0.01
  done
  [[ -f "$guard_path/recovery-main.tmp" ]]

  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard \
    > "$completed_recovery_log" 2>&1
  recovery_exit="$?"
  set -e
  if (( recovery_exit != 0 )); then
    sed -n '1,240p' "$completed_recovery_log" >&2
  fi
  assert_equal "$recovery_exit" 0 "interrupted stale-guard recovery retry exit status"
  rg -q '^RECOVERED_STALE_GUARD ' "$completed_recovery_log"
  [[ ! -e "$guard_path" ]]
  [[ ! -e "$attestation_path" && ! -e "$attestation_path.tmp" ]]
  [[ ! -e "$output_prefix.json" && ! -e "$output_prefix.result.db" ]]
  retained_snapshot="$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)"
  [[ -z "$retained_snapshot" ]]
  assert_restored_contract "interrupted stale-guard recovery retry"
}

run_legacy_manifest_recovery_case() {
  local case_name="$1"
  local environment_key_count="$2"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local recovery_log="$output_directory/recovery.log"
  local guard_path="$DATABASE_PATH.palate-calendar-validation.guard"
  local manifest_temp_path="$guard_path/manifest.json.tmp"
  local harness_pid killed_exit recovery_exit
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=success
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  kill -KILL "$harness_pid"
  set +e
  wait "$harness_pid"
  killed_exit="$?"
  set -e
  assert_equal "$killed_exit" 137 "$case_name killed exit status"
  pkill -TERM -x Palate 2>/dev/null || true
  for _ in {1..100}; do
    if zsh -c 'exec 8> "$1"; lockf -s -t 0 8' -- \
      "$DATABASE_PATH.palate-calendar-validation.lock" 2>/dev/null; then
      break
    fi
    sleep 0.01
  done
  [[ -d "$guard_path" && -f "$guard_path/manifest.json" ]]

  if (( environment_key_count == 7 )); then
    jq '
      del(
        .launchEnvironment.PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH,
        .launchEnvironment.PALATE_VISIT_FOOD_DETECTION_STRATEGY
      )
      | .artifactCleanup.temporaryPaths |= map(
          select(contains(".vision-result-transport-attestation.tmp-") | not)
        )
    ' "$guard_path/manifest.json" > "$manifest_temp_path"
  elif (( environment_key_count == 6 )); then
    jq '
      del(
        .launchEnvironment.PALATE_VISION_RESULT_TRANSPORT,
        .launchEnvironment.PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH,
        .launchEnvironment.PALATE_VISIT_FOOD_DETECTION_STRATEGY
      )
      | .artifactCleanup.temporaryPaths |= map(
          select(contains(".vision-result-transport-attestation.tmp-") | not)
        )
    ' "$guard_path/manifest.json" > "$manifest_temp_path"
  else
    print -u2 "Unsupported legacy environment-key count: $environment_key_count"
    return 2
  fi
  chmod 600 "$manifest_temp_path"
  mv -f -- "$manifest_temp_path" "$guard_path/manifest.json"
  jq -e \
    --argjson environmentKeyCount "$environment_key_count" \
    '(.launchEnvironment | keys | length) == $environmentKeyCount
     and (.artifactCleanup.temporaryPaths | length) == 7' \
    "$guard_path/manifest.json" >/dev/null

  set_original_environment_state \
    PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH \
    "${ORIGINAL_ENVIRONMENT_WAS_SET[PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH]}" \
    "${ORIGINAL_ENVIRONMENT_VALUE[PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH]}"
  set_original_environment_state \
    PALATE_VISIT_FOOD_DETECTION_STRATEGY \
    "${ORIGINAL_ENVIRONMENT_WAS_SET[PALATE_VISIT_FOOD_DETECTION_STRATEGY]}" \
    "${ORIGINAL_ENVIRONMENT_VALUE[PALATE_VISIT_FOOD_DETECTION_STRATEGY]}"
  if (( environment_key_count == 6 )); then
    set_original_environment_state \
      PALATE_VISION_RESULT_TRANSPORT \
      "${ORIGINAL_ENVIRONMENT_WAS_SET[PALATE_VISION_RESULT_TRANSPORT]}" \
      "${ORIGINAL_ENVIRONMENT_VALUE[PALATE_VISION_RESULT_TRANSPORT]}"
  fi

  set +e
  zsh "$HARNESS_PATH" --database="$DATABASE_PATH" --recover-stale-guard \
    > "$recovery_log" 2>&1
  recovery_exit="$?"
  set -e
  if (( recovery_exit != 0 )); then
    sed -n '1,240p' "$recovery_log" >&2
  fi
  assert_equal "$recovery_exit" 0 "$case_name recovery exit status"
  rg -q '^RECOVERED_STALE_GUARD ' "$recovery_log"
  [[ ! -e "$guard_path" && ! -e "$output_prefix.json" && ! -e "$output_prefix.result.db" ]]
  [[ -z "$(find "$output_directory" -maxdepth 1 -type f -name '*.original.db' -print -quit)" ]]
  assert_restored_contract "$case_name recovery"
}

assert_invalid_argument() {
  local argument="$1"
  local expected_message="$2"
  local log_path="$TEMPORARY_DIRECTORY/invalid-${argument//[^A-Za-z0-9]/-}.log"
  local exit_status
  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$TEMPORARY_DIRECTORY/invalid-result" \
    "$argument" \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e
  assert_equal "$exit_status" "2" "$argument exit status"
  rg -q -- "$expected_message" "$log_path"
  assert_restored_contract "$argument"
}

run_preexisting_result_refusal_case() {
  local output_directory="$TEMPORARY_DIRECTORY/preexisting-result"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local existing_result_path="$output_prefix.result.db"
  local original_result_sha256 exit_status
  mkdir -p "$output_directory"
  print -r -- "user-owned-result-sentinel" > "$existing_result_path"
  original_result_sha256="$(shasum -a 256 "$existing_result_path" | awk '{print $1}')"

  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1
  exit_status="$?"
  set -e
  assert_equal "$exit_status" 2 "preexisting result refusal exit status"
  rg -q 'Refusing to overwrite an existing result database artifact' "$log_path"
  assert_equal \
    "$(shasum -a 256 "$existing_result_path" | awk '{print $1}')" \
    "$original_result_sha256" \
    "preexisting result preservation"
  [[ ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  assert_restored_contract "preexisting result refusal"
  rm -f -- "$existing_result_path"
}

run_semantic_reference_write_sidecar_rejection_case() {
  local suffix="$1"
  local case_name="semantic-reference-nonempty-$suffix"
  local output_directory="$TEMPORARY_DIRECTORY/$case_name"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local reference_path="$output_directory/reference.db"
  local sidecar_path="$reference_path-$suffix"
  local reference_sha256 sidecar_sha256 exit_status
  mkdir -p "$output_directory"
  cp "$DATABASE_PATH" "$reference_path"
  chmod 600 "$reference_path"
  print -r -- "pending private $suffix data" > "$sidecar_path"
  chmod 600 "$sidecar_path"
  reference_sha256="$(shasum -a 256 "$reference_path" | awk '{print $1}')"
  sidecar_sha256="$(shasum -a 256 "$sidecar_path" | awk '{print $1}')"

  set +e
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --semantic-reference-database="$reference_path" \
    --page-size=1000 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=1 \
    --timeout-seconds=5 > "$log_path" 2>&1
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 1 "$case_name exit status"
  rg -q "External semantic reference has a nonempty $suffix" "$log_path"
  assert_equal \
    "$(shasum -a 256 "$reference_path" | awk '{print $1}')" \
    "$reference_sha256" \
    "$case_name reference main preservation"
  assert_equal \
    "$(shasum -a 256 "$sidecar_path" | awk '{print $1}')" \
    "$sidecar_sha256" \
    "$case_name reference sidecar preservation"
  [[ ! -e "$output_prefix.json" && ! -e "$DATABASE_PATH.palate-calendar-validation.guard" ]]
  assert_restored_contract "$case_name"
}

create_rank3_bulk_tail_fixture() {
  pkill -TERM -x Palate 2>/dev/null || true
  rm -f -- "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm" "$DATABASE_PATH-journal"
  sqlite3 "$DATABASE_PATH" >/dev/null <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  foodProbable INTEGER NOT NULL
);
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  visitId TEXT,
  creationTime REAL NOT NULL,
  foodDetected INTEGER,
  foodLabels TEXT,
  foodConfidence REAL,
  allLabels TEXT
);
INSERT INTO visits VALUES
  ('candidate-v1', 1),
  ('candidate-v2', 1),
  ('candidate-v3', 1),
  ('candidate-v4', 0);
WITH RECURSIVE
  visit_numbers(visitNumber) AS (
    VALUES (1) UNION ALL SELECT visitNumber + 1 FROM visit_numbers WHERE visitNumber < 4
  ),
  sample_ranks(sampleRank) AS (
    VALUES (1) UNION ALL SELECT sampleRank + 1 FROM sample_ranks WHERE sampleRank < 4
  ),
  planned AS (
    SELECT
      printf('candidate-v%d-p%d', visitNumber, sampleRank) AS photoId,
      printf('candidate-v%d', visitNumber) AS visitId,
      visitNumber * 100 + sampleRank AS creationTime,
      (visitNumber = 1 AND sampleRank = 1)
        OR (visitNumber = 2 AND sampleRank = 3)
        OR (visitNumber = 3 AND sampleRank = 4) AS containsFood
    FROM visit_numbers CROSS JOIN sample_ranks
  )
INSERT INTO photos
SELECT
  photoId,
  visitId,
  creationTime,
  containsFood,
  CASE WHEN containsFood THEN '[{"label":"food","confidence":0.9}]' ELSE '[]' END,
  CASE WHEN containsFood THEN 0.9 ELSE NULL END,
  CASE
    WHEN containsFood THEN '[{"label":"food","confidence":0.9}]'
    ELSE '[{"label":"other","confidence":0.8}]'
  END
FROM planned;
WITH RECURSIVE
  visit_numbers(visitNumber) AS (
    VALUES (1) UNION ALL SELECT visitNumber + 1 FROM visit_numbers WHERE visitNumber < 4
  ),
  unclassified_ranks(photoRank) AS (
    VALUES (1) UNION ALL SELECT photoRank + 1 FROM unclassified_ranks WHERE photoRank < 16
  )
INSERT INTO photos
SELECT
  printf('candidate-v%d-u%02d', visitNumber, photoRank),
  printf('candidate-v%d', visitNumber),
  visitNumber * 100 + 10 + photoRank,
  0,
  NULL,
  NULL,
  NULL
FROM visit_numbers CROSS JOIN unclassified_ranks;
SQL
  sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  rm -f -- "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
  chmod 600 "$DATABASE_PATH"
  capture_original_database_contract
}

run_rank3_skipped_write_rejection_case() {
  local output_directory="$TEMPORARY_DIRECTORY/rank3-skipped-write-rejection"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=candidate-skipped-write
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --visit-food-detection-strategy=rank3-bulk-tail-v1 \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=16 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 1 "rank3 skipped-write rejection exit status"
  rg -q 'Parity failed: 1 photo mismatches' "$log_path"
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "rank3 skipped-write rejection"
}

create_rank3_real_scale_fixture() {
  pkill -TERM -x Palate 2>/dev/null || true
  rm -f -- "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm" "$DATABASE_PATH-journal"
  sqlite3 "$DATABASE_PATH" >/dev/null <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  foodProbable INTEGER NOT NULL
);
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  visitId TEXT,
  creationTime REAL NOT NULL,
  foodDetected INTEGER,
  foodLabels TEXT,
  foodConfidence REAL,
  allLabels TEXT
);
INSERT INTO visits VALUES ('large-positive', 1);
WITH RECURSIVE singleton(number) AS (
  VALUES (1)
  UNION ALL
  SELECT number + 1 FROM singleton WHERE number < 11438
)
INSERT INTO visits
SELECT printf('large-singleton-%05d', number), 0 FROM singleton;
WITH RECURSIVE sample(rank) AS (
  VALUES (1)
  UNION ALL
  SELECT rank + 1 FROM sample WHERE rank < 1621
)
INSERT INTO photos
SELECT
  printf('large-positive-p%05d', rank),
  'large-positive',
  rank,
  CASE WHEN rank = 1 THEN 1 ELSE 0 END,
  CASE WHEN rank = 1 THEN '[{"label":"food","confidence":0.9}]' ELSE '[]' END,
  CASE WHEN rank = 1 THEN 0.9 ELSE NULL END,
  CASE
    WHEN rank = 1 THEN '[{"label":"food","confidence":0.9}]'
    ELSE '[{"label":"other","confidence":0.8}]'
  END
FROM sample;
WITH RECURSIVE singleton(number) AS (
  VALUES (1)
  UNION ALL
  SELECT number + 1 FROM singleton WHERE number < 11438
)
INSERT INTO photos
SELECT
  printf('large-singleton-p%05d', number),
  printf('large-singleton-%05d', number),
  2000 + number,
  0,
  '[]',
  NULL,
  '[{"label":"other","confidence":0.8}]'
FROM singleton;
SQL
  sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  rm -f -- "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
  chmod 600 "$DATABASE_PATH"
  assert_equal \
    "$(sqlite3 -readonly "$(immutable_sqlite_uri "$DATABASE_PATH")" \
      'SELECT COUNT(*) FROM photos WHERE allLabels IS NOT NULL;')" \
    13059 \
    "real-scale classified fixture count"
  assert_equal \
    "$(sqlite3 -readonly "$(immutable_sqlite_uri "$DATABASE_PATH")" \
      "SELECT COUNT(*) FROM photos WHERE visitId = 'large-positive' AND creationTime > 1;")" \
    1620 \
    "real-scale adaptive skipped count"
  capture_original_database_contract
}

run_rank3_full_plan_bypass_counter_priority_case() {
  local output_directory="$TEMPORARY_DIRECTORY/rank3-full-plan-bypass-real-scale"
  local output_prefix="$output_directory/result"
  local log_path="$output_directory/harness.log"
  local harness_pid exit_status
  mkdir -p "$output_directory"

  export PALATE_VISION_PAGE_HARNESS_FAKE_MODE=rank3-full-plan-bypass-real-scale
  export PALATE_VISION_PAGE_HARNESS_FAKE_DATABASE="$DATABASE_PATH"
  export PALATE_VISION_PAGE_HARNESS_FAKE_TRIGGER="$output_prefix.trigger"
  zsh "$HARNESS_PATH" \
    --app="$FAKE_APP_PATH" \
    --database="$DATABASE_PATH" \
    --page-size=1000 \
    --visit-food-detection-strategy=rank3-bulk-tail-v1 \
    --require-native-work-counters \
    --output-prefix="$output_prefix" \
    --expected-fixture-count=13059 \
    --timeout-seconds=5 \
    > "$log_path" 2>&1 &
  harness_pid="$!"
  wait_for_ready "$log_path" "$harness_pid"
  record_trigger "$output_prefix.trigger"
  set +e
  wait "$harness_pid"
  exit_status="$?"
  set -e

  assert_equal "$exit_status" 1 "real-scale full-plan bypass exit status"
  rg -q \
    'Native Vision requested-asset count mismatch: direct=13059 expected_attempted=11439' \
    "$log_path"
  if rg -q 'Parity failed:|Strategy workload accounting failed:' "$log_path"; then
    print -u2 "real-scale full-plan bypass did not prioritize direct native counter evidence"
    return 1
  fi
  [[ ! -e "$output_prefix.json" ]]
  assert_restored_contract "real-scale full-plan bypass"
}

help_output="$(zsh "$HARNESS_PATH" --help)"
[[ "$help_output" == *"--page-orchestration-strategy=MODE"* ]]
[[ "$help_output" == *"--result-transport=MODE"* ]]
[[ "$help_output" == *"default: legacy"* ]]
[[ "$help_output" == *"--visit-food-detection-strategy=MODE"* ]]
[[ "$help_output" == *"default: full-plan-v1"* ]]
[[ "$help_output" == *"--vision-concurrency=N"* ]]
[[ "$help_output" == *"--pipeline-depth=N"* ]]
[[ "$help_output" == *"--require-native-work-counters"* ]]
[[ "$help_output" == *"--retain-raw-databases"* ]]
[[ "$help_output" == *"--semantic-reference-database=PATH"* ]]
[[ "$help_output" == *"--recover-stale-guard"* ]]
[[ "$help_output" == *"--app=PATH"* ]]
[[ "$help_output" == *"immediately before confirming Start Deep Scan"* ]]
[[ "$help_output" == *"validation mode"* ]]
[[ "$help_output" == *"reroutes only that Deep Scan invocation"* ]]
[[ "$help_output" == *"Never use Rescan Now"* ]]

for value in "" 0 17 invalid; do
  assert_invalid_argument \
    "--vision-concurrency=$value" \
    '--vision-concurrency must be an integer from 1 through 16'
done
for value in "" 0 65 invalid; do
  assert_invalid_argument \
    "--pipeline-depth=$value" \
    '--pipeline-depth must be an integer from 1 through 64'
done
for value in "" LOOKAHEAD parallel 1; do
  assert_invalid_argument \
    "--page-orchestration-strategy=$value" \
    '--page-orchestration-strategy must be serial or lookahead'
done
for value in "" PACKED packed-v2 1; do
  assert_invalid_argument \
    "--result-transport=$value" \
    '--result-transport must be legacy or packed-v1'
done
for value in "" FULL adaptive 1; do
  assert_invalid_argument \
    "--visit-food-detection-strategy=$value" \
    '--visit-food-detection-strategy must be full-plan-v1 or rank3-bulk-tail-v1'
done

run_preexisting_result_refusal_case

EXTERNAL_SEMANTIC_REFERENCE="$TEMPORARY_DIRECTORY/external-semantic-reference.db"
cp "$DATABASE_PATH" "$EXTERNAL_SEMANTIC_REFERENCE"
chmod 600 "$EXTERNAL_SEMANTIC_REFERENCE"
: > "$EXTERNAL_SEMANTIC_REFERENCE-wal"
print -r -- "stable semantic reference SHM sentinel" > "$EXTERNAL_SEMANTIC_REFERENCE-shm"
chmod 640 "$EXTERNAL_SEMANTIC_REFERENCE-wal" "$EXTERNAL_SEMANTIC_REFERENCE-shm"

run_semantic_reference_write_sidecar_rejection_case wal
run_semantic_reference_write_sidecar_rejection_case journal

run_success_case overrides 8 12 lookahead
run_success_case minimum-bounds 1 1 serial
run_success_case maximum-bounds 16 64 lookahead
run_success_case native-defaults "" "" ""
run_success_case explicit-lookahead "" "" lookahead
run_success_case explicit-legacy-transport "" "" serial legacy
run_success_case explicit-packed-transport "" "" lookahead packed-v1
run_success_case native-v1-compatible "" "" serial packed-v1 0 "" full-plan-v1 1 native-attestation-v1
run_success_case strict-native-work-counters "" "" lookahead packed-v1 0 "" full-plan-v1 1 success 1
run_success_case retained-raw "" "" serial "" 1
run_success_case external-semantic-reference "" "" lookahead "" 0 "$EXTERNAL_SEMANTIC_REFERENCE"
run_success_case external-semantic-reference-repeat "" "" lookahead "" 0 "$EXTERNAL_SEMANTIC_REFERENCE"
assert_equal \
  "$(jq -cS '.semanticReference' "$TEMPORARY_DIRECTORY/external-semantic-reference/result.json")" \
  "$(jq -cS '.semanticReference' "$TEMPORARY_DIRECTORY/external-semantic-reference-repeat/result.json")" \
  "external semantic reference component attestation repeatability"
[[ -f "$EXTERNAL_SEMANTIC_REFERENCE" \
  && -f "$EXTERNAL_SEMANTIC_REFERENCE-wal" \
  && -f "$EXTERNAL_SEMANTIC_REFERENCE-shm" ]]
run_process_mismatch_case concurrency-mismatch 'did not inherit PALATE_VISION_CONCURRENCY=8'
run_process_mismatch_case pipeline-depth-mismatch 'did not inherit PALATE_VISION_PIPELINE_DEPTH=12'
run_process_mismatch_case orchestration-mismatch \
  'did not inherit PALATE_VISION_PAGE_ORCHESTRATION_STRATEGY=lookahead'
run_process_mismatch_case result-transport-mismatch \
  'did not inherit PALATE_VISION_RESULT_TRANSPORT=legacy'
run_process_mismatch_case attestation-path-mismatch \
  'did not inherit PALATE_VISION_RESULT_TRANSPORT_ATTESTATION_PATH'
run_process_mismatch_case visit-food-strategy-mismatch \
  'did not inherit PALATE_VISIT_FOOD_DETECTION_STRATEGY=full-plan-v1'
run_process_mismatch_case classification-mismatch \
  'unexpectedly inherited PALATE_VISION_CLASSIFICATION_STRATEGY'
run_native_attestation_failure_case native-attestation-mismatch \
  'Native Vision result transport attestation did not match'
run_native_attestation_failure_case native-attestation-missing \
  'Native Vision result transport attestation is missing'
run_native_attestation_failure_case native-attestation-v1 \
  'required direct-counter contract' 1
run_native_attestation_failure_case native-work-unbalanced \
  'balanced lifecycle'
run_native_attestation_failure_case native-work-asset-mismatch \
  'Native Vision requested-asset count mismatch'
run_native_attestation_failure_case native-work-batch-mismatch \
  'Native Vision batch count mismatch'
run_report_publication_sync_failure_case
run_mismatched_build_case
run_manual_product_refresh_success_case
run_manual_product_refresh_process_mismatch_case
run_pretrigger_mutation_case
run_concurrent_lock_case
run_default_raw_cleanup_failure_case
run_interrupted_recovery_temp_cleanup_case
run_legacy_manifest_recovery_case legacy-seven-key-manifest-recovery 7
run_legacy_manifest_recovery_case legacy-six-key-manifest-recovery 6

set_all_original_environment_states empty
run_signal_case signal-restores-empty TERM 143 lookahead
set_all_original_environment_states absent
run_signal_case signal-restores-unset HUP 129 serial
set_all_original_environment_states value
run_success_case restores-nonempty "" "" lookahead
create_exact_sidecar_fixture
run_signal_case exact-sidecars-signal TERM 143 serial
set_all_original_environment_states mixed
run_sigkill_recovery_case
create_rank3_bulk_tail_fixture
run_rank3_skipped_write_rejection_case
run_success_case rank3-bulk-tail-with-retryable-results "" "" lookahead packed-v1 0 "" rank3-bulk-tail-v1 16 candidate-success
run_success_case rank3-small-page-ceiling "" "" lookahead packed-v1 0 "" rank3-bulk-tail-v1 16 candidate-success 1 2
create_rank3_real_scale_fixture
run_rank3_full_plan_bypass_counter_priority_case

print "macOS Vision result-page harness contract tests passed: schema-1 compatibility and strict schema-2 native work counters, balanced lifecycle and mismatch rejection, real-scale 13,059/11,439/1,620 strategy-bypass diagnostics, adaptive small-page ceiling division, native result-transport and visit-food-strategy attestation, full-plan and rank3-bulk-tail semantic oracles, retryable/missing eligibility, private aggregate reports, raw cleanup/retention, build attestation, shared locking, exact database/environment restoration, legacy-manifest/SIGKILL recovery, and corruption refusal."

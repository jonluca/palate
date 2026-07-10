#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import {
  mountWrappedQueries,
  readProductionPolicyContract,
  weightedSqlDelta,
} from "./tab-query-refetch-policy-core.ts";

const contract = readProductionPolicyContract();
const expectedDualQueryWeight = contract.allTimeSqlCalls + contract.selectedYearSqlCalls;
assert.equal(expectedDualQueryWeight, 39);

const legacy = await mountWrappedQueries(contract, "legacy");
try {
  assert.deepEqual(legacy.snapshot(), {
    allTimeMaterializations: 1,
    selectedYearMaterializations: 1,
    weightedSqlCalls: 39,
  });
  legacy.markBothAgeStale();
  const beforeNavigation = legacy.snapshot();
  await legacy.legacyPathnameNavigation();
  const afterNavigation = legacy.snapshot();
  assert.equal(weightedSqlDelta(beforeNavigation, afterNavigation), 39);
  assert.deepEqual(afterNavigation, {
    allTimeMaterializations: 2,
    selectedYearMaterializations: 2,
    weightedSqlCalls: 78,
  });
} finally {
  legacy.close();
}

const candidate = await mountWrappedQueries(contract, "candidate");
let candidateNavigationDelta = -1;
let candidateMutationInvalidationDelta = -1;
let candidateFocusedRefreshDelta = -1;
let repeatedFocusDelta = -1;
try {
  candidate.markBothAgeStale();
  const beforeNavigation = candidate.snapshot();
  await candidate.candidatePathnameNavigation();
  const afterNavigation = candidate.snapshot();
  candidateNavigationDelta = weightedSqlDelta(beforeNavigation, afterNavigation);
  assert.equal(candidateNavigationDelta, 0, "candidate navigation must not refetch hidden stale Stats queries");

  await candidate.setStatsFocused(false);
  const beforeInvalidation = candidate.snapshot();
  await candidate.invalidateForModeledMutation();
  const afterInvalidation = candidate.snapshot();
  candidateMutationInvalidationDelta = weightedSqlDelta(beforeInvalidation, afterInvalidation);
  assert.equal(candidateMutationInvalidationDelta, 0, "modeled mutation should invalidate without hidden refetch");
  assert.equal(candidate.bothQueriesInvalidated(), true, "modeled mutation must invalidate all-time and year caches");

  const beforeFocus = candidate.snapshot();
  await candidate.candidateStatsFocus();
  const afterFocus = candidate.snapshot();
  candidateFocusedRefreshDelta = weightedSqlDelta(beforeFocus, afterFocus);
  assert.equal(candidateFocusedRefreshDelta, 39, "focused invalidated Stats must refresh exactly once");
  assert.equal(candidate.bothQueriesInvalidated(), false, "successful focused refresh must clear invalidation");

  const beforeRepeatedFocus = candidate.snapshot();
  await candidate.candidateStatsFocus();
  repeatedFocusDelta = weightedSqlDelta(beforeRepeatedFocus, candidate.snapshot());
  assert.equal(repeatedFocusDelta, 0, "fresh repeated focus must not refetch again");
} finally {
  candidate.close();
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      subsystem: "tab navigation query-refetch policy",
      sourceContract: contract,
      assertions: {
        legacyWeightedSqlCallsPerStaleNavigation: 39,
        candidateWeightedSqlCallsPerNavigation: candidateNavigationDelta,
        candidateWeightedSqlCallsAtMutationInvalidation: candidateMutationInvalidationDelta,
        candidateWeightedSqlCallsAtFirstStatsFocus: candidateFocusedRefreshDelta,
        candidateWeightedSqlCallsAtRepeatedFreshFocus: repeatedFocusDelta,
      },
    },
    null,
    2,
  ),
);

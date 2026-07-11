#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildReservationAwardLookupBatches,
  RESERVATION_AWARD_SINGLE_LOOKUP_CONCURRENCY,
  resolveReservationAwardsInBatches,
  type ReservationAwardBatchLookup,
  type ReservationAwardLookupInput,
} from "../utils/reservation-award-batch-core.ts";

process.env.TZ = "America/Los_Angeles";

function localTimestamp(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

async function assertNoMatches(): Promise<void> {
  let calls = 0;
  const inputs: ReservationAwardLookupInput[] = [
    { restaurantId: null, startTime: localTimestamp(2025, 1, 1) },
    { restaurantId: "resy-123", startTime: localTimestamp(2025, 1, 2) },
    { restaurantId: "", startTime: localTimestamp(2025, 1, 3) },
  ];
  const awards = await resolveReservationAwardsInBatches(inputs, async () => {
    calls += 1;
    return {};
  });
  assert.deepEqual(buildReservationAwardLookupBatches(inputs), []);
  assert.deepEqual(awards, [null, null, null]);
  assert.equal(calls, 0);
}

async function assertSameYearDeduplicationAndInvalidIds(): Promise<void> {
  const inputs: ReservationAwardLookupInput[] = [
    { restaurantId: "michelin-10", startTime: localTimestamp(2025, 1, 1) },
    { restaurantId: "michelin-10", startTime: localTimestamp(2025, 12, 31) },
    { restaurantId: "michelin-20", startTime: localTimestamp(2025, 6, 1) },
    { restaurantId: "michelin-007", startTime: localTimestamp(2025, 6, 2) },
    { restaurantId: "michelin-invalid", startTime: localTimestamp(2025, 7, 1) },
    { restaurantId: "provider-ignored", startTime: localTimestamp(2025, 8, 1) },
  ];
  const batches = buildReservationAwardLookupBatches(inputs);
  assert.deepEqual(batches, [
    {
      localYear: 2025,
      representativeTimestamp: inputs[0]!.startTime,
      restaurantIds: ["michelin-10", "michelin-20", "michelin-007", "michelin-invalid"],
    },
  ]);
  const calls: Array<{ ids: string[]; timestamp: number }> = [];
  const awards = await resolveReservationAwardsInBatches(inputs, async (ids, timestamp) => {
    calls.push({ ids: [...ids], timestamp });
    return {
      "michelin-10": "One Star",
      "michelin-20": "",
      "michelin-007": "Leading Zero Award",
      "michelin-invalid": null,
    };
  });
  assert.deepEqual(calls, [{ ids: batches[0]!.restaurantIds, timestamp: inputs[0]!.startTime }]);
  assert.deepEqual(awards, ["One Star", "One Star", "", "Leading Zero Award", null, null]);
}

async function assertDuplicateIdsAcrossYearsAndStableOrdering(): Promise<void> {
  const inputs: ReservationAwardLookupInput[] = [
    { restaurantId: "michelin-7", startTime: localTimestamp(2026, 4, 1) },
    { restaurantId: "michelin-7", startTime: localTimestamp(2024, 4, 1) },
    { restaurantId: "michelin-8", startTime: localTimestamp(2026, 5, 1) },
    { restaurantId: "michelin-7", startTime: localTimestamp(2025, 4, 1) },
    { restaurantId: "michelin-8", startTime: localTimestamp(2024, 5, 1) },
  ];
  assert.deepEqual(
    buildReservationAwardLookupBatches(inputs).map((batch) => ({
      year: batch.localYear,
      ids: batch.restaurantIds,
    })),
    [
      { year: 2026, ids: ["michelin-7", "michelin-8"] },
      { year: 2024, ids: ["michelin-7", "michelin-8"] },
      { year: 2025, ids: ["michelin-7"] },
    ],
  );
  const callYears: number[] = [];
  const awards = await resolveReservationAwardsInBatches(inputs, async (ids, timestamp) => {
    const year = new Date(timestamp).getFullYear();
    callYears.push(year);
    return Object.fromEntries(ids.map((id) => [id, `${id}:${year}`]));
  });
  assert.deepEqual(callYears, [2026, 2024, 2025]);
  assert.deepEqual(awards, [
    "michelin-7:2026",
    "michelin-7:2024",
    "michelin-8:2026",
    "michelin-7:2025",
    "michelin-8:2024",
  ]);
}

async function assertDstAndLocalYearBoundaries(): Promise<void> {
  const beforeLocalNewYear = Date.UTC(2026, 0, 1, 7, 59, 59, 999);
  const atLocalNewYear = Date.UTC(2026, 0, 1, 8, 0, 0, 0);
  assert.equal(new Date(beforeLocalNewYear).getFullYear(), 2025);
  assert.equal(new Date(atLocalNewYear).getFullYear(), 2026);

  const springBefore = localTimestamp(2025, 3, 9, 1, 30);
  const springAfter = localTimestamp(2025, 3, 9, 3, 30);
  const fallFirst = localTimestamp(2025, 11, 2, 1, 15);
  const inputs: ReservationAwardLookupInput[] = [
    { restaurantId: "michelin-year", startTime: beforeLocalNewYear },
    { restaurantId: "michelin-year", startTime: atLocalNewYear },
    { restaurantId: "michelin-dst", startTime: springBefore },
    { restaurantId: "michelin-dst", startTime: springAfter },
    { restaurantId: "michelin-dst", startTime: fallFirst },
  ];
  const batches = buildReservationAwardLookupBatches(inputs);
  assert.deepEqual(
    batches.map((batch) => ({ year: batch.localYear, ids: batch.restaurantIds })),
    [
      { year: 2025, ids: ["michelin-year", "michelin-dst"] },
      { year: 2026, ids: ["michelin-year"] },
    ],
  );
  const awards = await resolveReservationAwardsInBatches(inputs, async (ids, timestamp) => {
    const year = new Date(timestamp).getFullYear();
    return Object.fromEntries(ids.map((id) => [id, `${year}:${id}`]));
  });
  assert.deepEqual(awards, [
    "2025:michelin-year",
    "2026:michelin-year",
    "2025:michelin-dst",
    "2025:michelin-dst",
    "2025:michelin-dst",
  ]);
}

async function assertFailureAndNullBehavior(): Promise<void> {
  const inputs: ReservationAwardLookupInput[] = [
    { restaurantId: "michelin-fail", startTime: localTimestamp(2024, 1, 1) },
    { restaurantId: "michelin-empty", startTime: localTimestamp(2025, 1, 1) },
    { restaurantId: "michelin-null", startTime: localTimestamp(2025, 2, 1) },
    { restaurantId: "michelin-null-batch", startTime: localTimestamp(2026, 1, 1) },
  ];
  const lookup: ReservationAwardBatchLookup = async (_ids, timestamp) => {
    const year = new Date(timestamp).getFullYear();
    if (year === 2024) {
      throw new Error("injected lookup failure");
    }
    if (year === 2026) {
      const noAwards: Record<string, string | null> = { "michelin-null-batch": null };
      return noAwards;
    }
    const awards: Record<string, string | null> = { "michelin-empty": "", "michelin-null": null };
    return awards;
  };
  const isolatedCalls: string[] = [];
  assert.deepEqual(
    await resolveReservationAwardsInBatches(inputs, lookup, async (restaurantId, timestamp) => {
      isolatedCalls.push(`${new Date(timestamp).getFullYear()}:${restaurantId}`);
      return restaurantId === "michelin-fail" ? "Recovered independently" : null;
    }),
    ["Recovered independently", "", null, null],
  );
  assert.deepEqual(isolatedCalls, ["2024:michelin-fail"]);
  assert.deepEqual(await resolveReservationAwardsInBatches(inputs, lookup), [null, "", null, null]);
}

async function assertLargeAllNullBatchDoesNotFallback(): Promise<void> {
  const timestamp = localTimestamp(2025, 8, 1);
  const inputs: ReservationAwardLookupInput[] = Array.from({ length: 1_000 }, (_, index) => ({
    restaurantId: `michelin-${index + 1}`,
    startTime: timestamp,
  }));
  let batchCalls = 0;
  let singleCalls = 0;
  const awards = await resolveReservationAwardsInBatches(
    inputs,
    async (restaurantIds) => {
      batchCalls += 1;
      return Object.fromEntries(restaurantIds.map((restaurantId) => [restaurantId, null]));
    },
    async () => {
      singleCalls += 1;
      throw new Error("fulfilled all-null batches must not fall back");
    },
  );
  assert.equal(batchCalls, 1);
  assert.equal(singleCalls, 0);
  assert.deepEqual(
    awards,
    inputs.map(() => null),
  );
}

async function assertRejectedLargeBatchUsesBoundedFallback(): Promise<void> {
  const timestamp = localTimestamp(2025, 9, 1);
  const inputs: ReservationAwardLookupInput[] = Array.from({ length: 1_000 }, (_, index) => ({
    restaurantId: `michelin-${index + 1}`,
    startTime: timestamp,
  }));
  let batchCalls = 0;
  let activeSingleCalls = 0;
  let maxActiveSingleCalls = 0;
  const singleCallIds: string[] = [];
  const awards = await resolveReservationAwardsInBatches(
    inputs,
    async () => {
      batchCalls += 1;
      throw new Error("injected batch failure");
    },
    async (restaurantId) => {
      singleCallIds.push(restaurantId);
      activeSingleCalls += 1;
      maxActiveSingleCalls = Math.max(maxActiveSingleCalls, activeSingleCalls);
      try {
        await Promise.resolve();
        const numericId = Number(restaurantId.slice("michelin-".length));
        if (numericId % 97 === 0) {
          throw new Error("injected isolated lookup failure");
        }
        return numericId % 2 === 0 ? `Award ${numericId}` : null;
      } finally {
        activeSingleCalls -= 1;
      }
    },
  );
  const expectedAwards = inputs.map((_, index) => {
    const numericId = index + 1;
    return numericId % 97 !== 0 && numericId % 2 === 0 ? `Award ${numericId}` : null;
  });
  assert.equal(batchCalls, 1);
  assert.equal(singleCallIds.length, 1_000);
  assert.deepEqual(new Set(singleCallIds), new Set(inputs.map((input) => input.restaurantId!)));
  assert.equal(maxActiveSingleCalls, RESERVATION_AWARD_SINGLE_LOOKUP_CONCURRENCY);
  assert.equal(activeSingleCalls, 0);
  assert.deepEqual(awards, expectedAwards);
}

async function assertChunkingAndInvalidTimestamps(): Promise<void> {
  const invalidTimestamp = Number.NaN;
  const inputs: ReservationAwardLookupInput[] = Array.from({ length: 1_002 }, (_, index) => ({
    restaurantId: `michelin-${index + 1}`,
    startTime: invalidTimestamp,
  }));
  inputs.push({ restaurantId: "michelin-1", startTime: invalidTimestamp });
  const batches = buildReservationAwardLookupBatches(inputs);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.restaurantIds.length, 1_000);
  assert.equal(batches[1]!.restaurantIds.length, 2);
  assert.ok(Number.isNaN(batches[0]!.localYear));
  assert.ok(Number.isNaN(batches[1]!.localYear));
  const calls: number[] = [];
  const awards = await resolveReservationAwardsInBatches(inputs, async (ids, timestamp) => {
    assert.ok(Number.isNaN(timestamp));
    calls.push(ids.length);
    return Object.fromEntries(ids.map((id) => [id, `latest:${id}`]));
  });
  assert.deepEqual(calls, [1_000, 2]);
  assert.equal(awards.length, inputs.length);
  assert.equal(awards[0], "latest:michelin-1");
  assert.equal(awards.at(-1), "latest:michelin-1");
  assert.equal(awards[1_001], "latest:michelin-1002");
}

function assertProductionWiring(): void {
  const source = readFileSync(new URL("../services/reservation-import.ts", import.meta.url), "utf8");
  const michelinSource = readFileSync(new URL("../services/michelin.ts", import.meta.url), "utf8");
  assert.match(source, /resolveReservationAwardsInBatches/);
  assert.match(source, /readAwardsForProviderImportOrThrow\(restaurantIds, representativeTimestamp\)/);
  assert.match(source, /getAwardForDate\(restaurantId, representativeTimestamp\)/);
  assert.equal(source.match(/buildReservationOnlyVisits\(/g)?.length, 2);
  assert.match(source, /function buildReservationReviewVisits/);
  assert.match(source, /toReservationOnlyVisit\([\s\S]*sourceDisplayName,[\s\n]*null,[\s\n]*\)/);
  assert.doesNotMatch(source, /getAwardForReservationVisit/);
  assert.doesNotMatch(source, /locatedReservations\.map\(\(reservation\)\s*=>\s*toReservationOnlyVisit/);
  assert.match(michelinSource, /export async function readAwardsForProviderImportOrThrow/);
  assert.match(michelinSource, /return readAwardsForDateOrThrow\(michelinIds, timestamp\)/);
}

await assertNoMatches();
await assertSameYearDeduplicationAndInvalidIds();
await assertDuplicateIdsAcrossYearsAndStableOrdering();
await assertDstAndLocalYearBoundaries();
await assertFailureAndNullBehavior();
await assertLargeAllNullBatchDoesNotFallback();
await assertRejectedLargeBatchUsesBoundedFallback();
await assertChunkingAndInvalidTimestamps();
assertProductionWiring();

console.log(
  "Reservation award batching tests passed: no-match zero calls, per-local-year unique IDs, bounded chunks and rejected-batch fallbacks, 1,000-ID all-null success without fallback, invalid/leading-zero IDs, NaN/DST/year boundaries, isolated failures, empty/null behavior, stable outputs, and production wiring.",
);

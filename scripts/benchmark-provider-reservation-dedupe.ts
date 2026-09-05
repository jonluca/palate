import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { dedupeReservationOnlyVisits } from "../utils/provider-reservation-dedupe-core.ts";
import { BUFFER, createHistory, dedupeKey, legacyDedupe, type TestVisit } from "./test-provider-reservation-dedupe.ts";

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

// Both paths use pre-normalized names: this conservatively excludes normalization
// and its memoization overhead, plus all network, SQLite, and native work.
for (const count of [139, 1_000, 5_000]) {
  const visits = createHistory(count, 300);
  const expected = legacyDedupe(visits);
  let legacyKeyCalls = 0;
  let indexedKeyCalls = 0;
  legacyDedupe(visits, (item) => {
    legacyKeyCalls++;
    return dedupeKey(item);
  });
  dedupeReservationOnlyVisits(
    visits,
    (item) => {
      indexedKeyCalls++;
      return dedupeKey(item);
    },
    BUFFER,
  );
  const timings = { legacy: new Array<number>(), indexed: new Array<number>() };
  const strategies = {
    legacy: (input: readonly TestVisit[]) => legacyDedupe(input),
    indexed: (input: readonly TestVisit[]) => dedupeReservationOnlyVisits(input, dedupeKey, BUFFER),
  };
  for (let sample = -4; sample < 11; sample++) {
    const order: (keyof typeof strategies)[] = sample % 2 === 0 ? ["legacy", "indexed"] : ["indexed", "legacy"];
    for (const strategy of order) {
      const start = performance.now();
      const result = strategies[strategy](visits);
      const elapsed = performance.now() - start;
      assert.deepEqual(result, expected);
      if (sample >= 0) {
        timings[strategy].push(elapsed);
      }
    }
  }
  const legacyMs = median(timings.legacy);
  const indexedMs = median(timings.indexed);
  console.log(
    JSON.stringify({
      count,
      retained: expected.visits.length,
      legacyKeyCalls,
      indexedKeyCalls,
      legacyMs: Number(legacyMs.toFixed(3)),
      indexedMs: Number(indexedMs.toFixed(3)),
      speedup: Number((legacyMs / indexedMs).toFixed(2)),
      scope: "Synthetic JavaScript deduplication only; exact output parity for every sample",
    }),
  );
}

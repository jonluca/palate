import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dedupeReservationOnlyVisits } from "../utils/provider-reservation-dedupe-core.ts";

export interface TestVisit {
  readonly id: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly suggestedRestaurantId: string | null;
  readonly sourceLocation: string | null;
}

export const BUFFER = 2 * 60 * 60 * 1000;

export function dedupeKey(visit: TestVisit): string {
  return visit.suggestedRestaurantId ?? visit.name;
}

/** The previous service algorithm, including first-match and replacement order. */
export function legacyDedupe(visits: readonly TestVisit[], getKey = dedupeKey, buffer = BUFFER) {
  const sorted = [...visits].sort((a, b) => a.startTime - b.startTime);
  const deduped: TestVisit[] = [];
  let duplicateCount = 0;
  for (const visit of sorted) {
    const index = deduped.findIndex((existing) => {
      const keyA = getKey(existing);
      const keyB = getKey(visit);
      return (
        Boolean(keyA) &&
        keyA === keyB &&
        existing.startTime <= visit.endTime + buffer &&
        existing.endTime >= visit.startTime - buffer
      );
    });
    if (index === -1) {
      deduped.push(visit);
      continue;
    }
    duplicateCount += 1;
    const existing = deduped[index];
    if (
      (visit.suggestedRestaurantId ? 1 : 0) > (existing.suggestedRestaurantId ? 1 : 0) ||
      (visit.sourceLocation ? 1 : 0) > (existing.sourceLocation ? 1 : 0)
    ) {
      deduped[index] = visit;
    }
  }
  return { visits: deduped.sort((a, b) => b.startTime - a.startTime), duplicateCount };
}

function visit(id: string, name: string, startTime: number, endTime = startTime): TestVisit {
  return { id, name, startTime, endTime, suggestedRestaurantId: null, sourceLocation: null };
}

export function createHistory(count: number, restaurantCount: number, seed = 42): TestVisit[] {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: count }, (_, index) => {
    const name = `restaurant-${Math.floor(random() * restaurantCount)}`;
    const startTime = Math.floor(random() * Math.max(1, count / 4)) * BUFFER;
    return {
      id: `visit-${index}`,
      name,
      startTime,
      endTime: startTime + Math.floor(random() * 4) * BUFFER,
      suggestedRestaurantId: random() < 0.3 ? name : null,
      sourceLocation: random() < 0.5 ? "Synthetic address" : null,
    };
  });
}

function assertParity(visits: readonly TestVisit[], buffer = BUFFER): void {
  const frozen = Object.freeze(visits.map((item) => Object.freeze({ ...item })));
  const expected = legacyDedupe(frozen, dedupeKey, buffer);
  let keys = 0;
  const actual = dedupeReservationOnlyVisits(
    frozen,
    (item) => {
      keys++;
      return dedupeKey(item);
    },
    buffer,
  );
  assert.deepEqual(actual, expected);
  actual.visits.forEach((item, index) => assert.equal(item, expected.visits[index]));
  assert.equal(keys, visits.length, "Each input key is evaluated only once");
}

function main(): void {
  assertParity([]);
  assertParity([visit("one", "cafe", 0)]);
  const boundaries = [
    visit("first", "cafe", 0),
    visit("inclusive", "cafe", BUFFER),
    visit("outside", "cafe", BUFFER + 1),
    visit("other", "bistro", 0),
    visit("empty-a", "", 0),
    visit("empty-b", "", 0),
  ];
  assertParity(boundaries);
  assert.deepEqual(
    dedupeReservationOnlyVisits(boundaries, dedupeKey, BUFFER).visits.map((item) => item.id),
    ["outside", "first", "other", "empty-a", "empty-b"],
  );

  // A replacement can overlap an earlier retained interval: retain first-match order.
  const replacing = [
    visit("first", "cafe", 0, 1),
    visit("second", "cafe", 3, 4),
    { ...visit("replace-first", "cafe", 1, 10), sourceLocation: "location" },
    { ...visit("prefer-id", "ignored", 4, 5), suggestedRestaurantId: "cafe" },
    visit("empty-id", "cafe", 4, 5),
  ];
  assertParity(replacing, 0);
  assertParity([
    { ...visit("id", "different-name", 0), suggestedRestaurantId: "cafe" },
    { ...visit("name", "cafe", 0), sourceLocation: "better-location" },
    { ...visit("empty-id", "cafe", 0), suggestedRestaurantId: "" },
    visit("prototype", "__proto__", 0),
    visit("prototype-copy", "__proto__", 0),
    visit("unicode", "日本語\0café", 0),
    visit("unicode-copy", "日本語\0café", 0),
  ]);

  for (let seed = 1; seed <= 100; seed++) {
    assertParity(createHistory(200, 1 + (seed % 25), seed));
  }
  assertParity(createHistory(5_000, 300));
  assertParity(createHistory(1_000, 1));
  console.log(
    "Reservation dedupe passed: boundaries, replacements, ordering, identity, empty keys, and 100 seeded histories.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

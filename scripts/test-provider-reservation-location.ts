#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY,
  MAX_PROVIDER_RESERVATION_LOCATION_CONCURRENCY,
  getProviderReservationPlaceQuery,
  resolveProviderReservationLocations,
  type LocatedProviderReservation,
  type ProviderReservationLocationCandidate,
  type ProviderReservationLocationInput,
} from "../utils/provider-reservation-location-core.ts";
import {
  beginProviderReservationReplay,
  completeProviderReservationReplay,
  createProviderReservationReplayGateState,
  failProviderReservationReplay,
  resetProviderReservationReplay,
} from "../utils/provider-reservation-replay-gate-core.ts";

interface TestReservation extends ProviderReservationLocationInput {
  readonly id: string;
  readonly sourceEventId: string;
  readonly marker: number;
}

interface InstrumentedLookup {
  readonly search: (query: string) => Promise<readonly ProviderReservationLocationCandidate[]>;
  readonly fallback: (reservation: TestReservation) => ProviderReservationLocationCandidate | null;
  readonly searchCalls: string[];
  readonly fallbackCalls: string[];
  readonly getMaxInFlight: () => number;
}

function reservation(
  id: string,
  restaurantName: string,
  address: string | null,
  latitude: number | null = null,
  longitude: number | null = null,
): TestReservation {
  return Object.freeze({
    id,
    sourceEventId: `source-${id}`,
    marker: id.length,
    restaurantName,
    address,
    latitude,
    longitude,
  });
}

function makeLookup(): InstrumentedLookup {
  const placeResults = new Map<string, readonly ProviderReservationLocationCandidate[]>([
    [
      "Shared 1 Main",
      [
        { latitude: 10, longitude: 20, address: "Google shared" },
        { latitude: 99, longitude: 99, address: "Second result must be ignored" },
      ],
    ],
    ["Shared 2 Main", [{ latitude: 11, longitude: 21, address: "Google second address" }]],
    ["Fallback Place", []],
    ["Keep Empty", [{ latitude: 12, longitude: 22, address: "Google address must not replace empty provider text" }]],
    ["Missing", []],
    ["Alpha Beta Gamma", [{ latitude: 13, longitude: 23, address: "Collision result" }]],
  ]);
  const fallbackResults = new Map<string, ProviderReservationLocationCandidate>([
    ["fallback", { latitude: 30, longitude: 40, address: "Michelin fallback" }],
    ["fallback-copy", { latitude: 30, longitude: 40, address: "Michelin fallback" }],
    ["error", { latitude: 31, longitude: 41, address: "Michelin after error" }],
    ["error-copy", { latitude: 31, longitude: 41, address: "Michelin after error" }],
    ["empty", { latitude: 32, longitude: 42, address: "Michelin empty-query fallback" }],
    ["transient-reject-a", { latitude: 33, longitude: 43, address: "Fallback after transient rejection" }],
    ["transient-empty-a", { latitude: 34, longitude: 44, address: "Fallback after transient empty result" }],
  ]);
  const searchCalls: string[] = [];
  const fallbackCalls: string[] = [];
  const attemptsByQuery = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    search: async (query) => {
      searchCalls.push(query);
      const attempt = (attemptsByQuery.get(query) ?? 0) + 1;
      attemptsByQuery.set(query, attempt);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        if (query === "Error Place") {
          throw new Error("injected Places failure");
        }
        if (query === "Transient Reject Recovery") {
          if (attempt === 1) {
            throw new Error("injected transient Places failure");
          }
          return [{ latitude: 50 + attempt, longitude: 60 + attempt, address: `Recovered reject ${attempt}` }];
        }
        if (query === "Transient Empty Recovery") {
          return attempt === 1
            ? []
            : [{ latitude: 70 + attempt, longitude: 80 + attempt, address: `Recovered empty ${attempt}` }];
        }
        return placeResults.get(query) ?? [];
      } finally {
        inFlight -= 1;
      }
    },
    fallback: (input) => {
      fallbackCalls.push(input.id);
      return fallbackResults.get(input.id) ?? null;
    },
    searchCalls,
    fallbackCalls,
    getMaxInFlight: () => maxInFlight,
  };
}

/** Independent line-for-line semantic oracle for the prior sequential resolver. */
async function literalSequentialOracle(
  inputs: readonly TestReservation[],
  searchPlaces: (query: string) => Promise<readonly ProviderReservationLocationCandidate[]>,
  findLocalFallback: (reservation: TestReservation) => ProviderReservationLocationCandidate | null,
): Promise<Array<LocatedProviderReservation<TestReservation> | null>> {
  const output: Array<LocatedProviderReservation<TestReservation> | null> = [];
  for (const input of inputs) {
    if (input.latitude !== null && input.longitude !== null) {
      output.push(input as LocatedProviderReservation<TestReservation>);
      continue;
    }

    const query = [input.restaurantName, input.address].filter(Boolean).join(" ");
    let places: readonly ProviderReservationLocationCandidate[] = [];
    if (query) {
      try {
        places = await searchPlaces(query);
      } catch {
        places = [];
      }
    }
    const place = places[0];
    if (place) {
      output.push({
        ...input,
        latitude: place.latitude,
        longitude: place.longitude,
        address: input.address ?? place.address ?? null,
      });
      continue;
    }

    const fallback = findLocalFallback(input);
    output.push(
      fallback
        ? {
            ...input,
            latitude: fallback.latitude,
            longitude: fallback.longitude,
            address: input.address ?? fallback.address ?? null,
          }
        : null,
    );
  }
  return output;
}

function createSemanticFixture(): readonly TestReservation[] {
  return Object.freeze([
    reservation("direct", "Direct", null, 0, -122),
    reservation("shared-a", "Shared", "1 Main", 5, null),
    reservation("shared-b", "Shared", "1 Main"),
    reservation("different-address", "Shared", "2 Main"),
    reservation("fallback", "Fallback Place", null),
    reservation("fallback-copy", "Fallback Place", null),
    reservation("keep-empty", "Keep Empty", ""),
    reservation("error", "Error Place", null),
    reservation("error-copy", "Error Place", null),
    reservation("missing", "Missing", null),
    reservation("empty", "", null),
    reservation("collision-a", "Alpha Beta", "Gamma"),
    reservation("collision-b", "Alpha", "Beta Gamma"),
    reservation("transient-reject-a", "Transient Reject", "Recovery"),
    reservation("transient-reject-b", "Transient Reject", "Recovery"),
    reservation("transient-reject-c", "Transient Reject", "Recovery"),
    reservation("transient-empty-a", "Transient Empty", "Recovery"),
    reservation("transient-empty-b", "Transient Empty", "Recovery"),
    reservation("transient-empty-c", "Transient Empty", "Recovery"),
  ]);
}

async function testSequentialParityAndExactCoalescing(): Promise<void> {
  const inputs = createSemanticFixture();
  const before = JSON.stringify(inputs);
  const oracleLookup = makeLookup();
  const oracle = await literalSequentialOracle(inputs, oracleLookup.search, oracleLookup.fallback);
  const plannedLookup = makeLookup();
  const planned = await resolveProviderReservationLocations(inputs, {
    searchPlaces: plannedLookup.search,
    findLocalFallback: plannedLookup.fallback,
  });

  assert.deepEqual(planned, oracle);
  assert.equal(JSON.stringify(inputs), before, "the planner must not mutate provider records");
  assert.strictEqual(planned[0], inputs[0], "direct-coordinate inputs must bypass work and retain identity");
  assert.equal(planned[1]?.latitude, 10, "a partial coordinate must not bypass text search");
  assert.equal(planned[1]?.longitude, 20);
  assert.equal(planned[1]?.address, "1 Main", "provider address must take precedence over Google");
  assert.equal(
    planned.find((entry) => entry?.id === "keep-empty")?.address,
    "",
    "empty provider address uses nullish, not truthy, precedence",
  );
  assert.deepEqual(
    planned
      .filter((entry) => entry?.id === "collision-a" || entry?.id === "collision-b")
      .map((entry) => [entry?.latitude, entry?.longitude, entry?.address]),
    [
      [13, 23, "Gamma"],
      [13, 23, "Beta Gamma"],
    ],
    "different inputs with the exact same query share Google coordinates but retain provider addresses",
  );
  assert.deepEqual(
    planned
      .filter((entry, index) => inputs[index]!.id.startsWith("transient-reject"))
      .map((entry) => [entry?.id, entry?.latitude, entry?.longitude]),
    [
      ["transient-reject-a", 33, 43],
      ["transient-reject-b", 52, 62],
      ["transient-reject-c", 53, 63],
    ],
    "a rejected shared attempt must not prevent independent duplicate recovery attempts",
  );
  assert.deepEqual(
    planned
      .filter((entry, index) => inputs[index]!.id.startsWith("transient-empty"))
      .map((entry) => [entry?.id, entry?.latitude, entry?.longitude]),
    [
      ["transient-empty-a", 34, 44],
      ["transient-empty-b", 72, 82],
      ["transient-empty-c", 73, 83],
    ],
    "an empty shared attempt must not prevent independent duplicate recovery attempts",
  );
  assert.equal(
    planned.find((entry, index) => inputs[index]?.id === "missing"),
    null,
  );
  assert.deepEqual(
    planned.map((entry) => entry?.id ?? null),
    inputs.map((entry) => (entry.id === "missing" ? null : entry.id)),
    "output order must match input order",
  );

  assert.equal(oracleLookup.searchCalls.length, 17, "the literal sequential path searches per missing input");
  assert.deepEqual(plannedLookup.searchCalls, [
    "Shared 1 Main",
    "Shared 2 Main",
    "Fallback Place",
    "Keep Empty",
    "Error Place",
    "Missing",
    "Alpha Beta Gamma",
    "Transient Reject Recovery",
    "Transient Empty Recovery",
    "Fallback Place",
    "Error Place",
    "Transient Reject Recovery",
    "Transient Reject Recovery",
    "Transient Empty Recovery",
    "Transient Empty Recovery",
  ]);
  assert.equal(
    plannedLookup.searchCalls.filter((query) => query === "Shared 1 Main").length,
    1,
    "exact duplicate queries must coalesce",
  );
  assert.ok(
    plannedLookup.searchCalls.includes("Shared 2 Main"),
    "same name with a different address must not coalesce",
  );
  assert.equal(
    plannedLookup.searchCalls.filter((query) => query === "Alpha Beta Gamma").length,
    1,
    "coalescing is based on the exact constructed query, not the name",
  );
  assert.deepEqual(plannedLookup.fallbackCalls, [
    "fallback",
    "fallback-copy",
    "error",
    "error-copy",
    "missing",
    "empty",
    "transient-reject-a",
    "transient-empty-a",
  ]);
  assert.equal(plannedLookup.getMaxInFlight(), DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY);
  assert.equal(getProviderReservationPlaceQuery(inputs[1]!), "Shared 1 Main");
  assert.equal(getProviderReservationPlaceQuery(inputs.find((entry) => entry.id === "empty")!), "");
}

async function testBoundedConcurrencyAndReviewReuse(): Promise<void> {
  const inputs = Object.freeze(
    Array.from({ length: 24 }, (_, index) => reservation(`unique-${index}`, `Unique ${index}`, `${index} Lane`)),
  );
  const makeUniqueLookup = () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    return {
      search: async (query: string) => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          const index = Number(query.match(/^Unique (\d+)/)?.[1] ?? -1);
          return [{ latitude: index, longitude: -index, address: `Google ${index}` }];
        } finally {
          inFlight -= 1;
        }
      },
      stats: () => ({ calls, maxInFlight }),
    };
  };

  const twoWide = makeUniqueLookup();
  const located = await resolveProviderReservationLocations(
    inputs,
    { searchPlaces: twoWide.search, findLocalFallback: () => null },
    { concurrency: 2 },
  );
  assert.deepEqual(twoWide.stats(), { calls: 24, maxInFlight: 2 });

  const clamped = makeUniqueLookup();
  await resolveProviderReservationLocations(
    inputs,
    { searchPlaces: clamped.search, findLocalFallback: () => null },
    { concurrency: 100 },
  );
  assert.deepEqual(clamped.stats(), { calls: 24, maxInFlight: MAX_PROVIDER_RESERVATION_LOCATION_CONCURRENCY });

  let approvalSearchCalls = 0;
  const approval = await resolveProviderReservationLocations(
    located.filter((entry) => entry !== null),
    {
      searchPlaces: async () => {
        approvalSearchCalls += 1;
        throw new Error("located review records must bypass approval geocoding");
      },
      findLocalFallback: () => null,
    },
  );
  assert.equal(approvalSearchCalls, 0);
  assert.deepEqual(approval, located);
  for (let index = 0; index < approval.length; index++) {
    assert.strictEqual(approval[index], located[index]);
  }
}

function testReplayGenerationGate(): void {
  let state = createProviderReservationReplayGateState();
  const first = beginProviderReservationReplay(state, "payload-a");
  assert.equal(first.accepted, true);
  state = first.state;

  const duplicatePending = beginProviderReservationReplay(state, "payload-a");
  assert.equal(duplicatePending.accepted, false);
  assert.strictEqual(duplicatePending.state, state);

  const second = beginProviderReservationReplay(state, "payload-b");
  assert.equal(second.accepted, true);
  state = second.state;
  assert.equal(
    completeProviderReservationReplay(state, first.generation).accepted,
    false,
    "stale result must be rejected",
  );

  const completed = completeProviderReservationReplay(state, second.generation);
  assert.equal(completed.accepted, true);
  state = completed.state;
  assert.equal(beginProviderReservationReplay(state, "payload-b").accepted, false, "completed exact replay is cached");

  const retryStart = beginProviderReservationReplay(state, "payload-error");
  state = retryStart.state;
  const failed = failProviderReservationReplay(state, retryStart.generation);
  assert.equal(failed.accepted, true);
  state = failed.state;
  const retry = beginProviderReservationReplay(state, "payload-error");
  assert.equal(retry.accepted, true, "a failed exact payload must be retryable");
  state = retry.state;

  const reset = resetProviderReservationReplay(state);
  assert.equal(reset.status, "idle");
  assert.equal(completeProviderReservationReplay(reset, retry.generation).accepted, false);
  assert.equal(
    beginProviderReservationReplay(reset, "payload-error").accepted,
    true,
    "reload must permit a new capture",
  );
}

function extractTemplateLiteral(source: string, declaration: string): string {
  const startMarker = `const ${declaration} = \``;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${declaration} declaration is missing`);
  const bodyStart = start + startMarker.length;
  const bodyEnd = source.indexOf("\n`;", bodyStart);
  assert.notEqual(bodyEnd, -1, `${declaration} closing delimiter is missing`);
  return runInNewContext(`\`${source.slice(bodyStart, bodyEnd)}\``) as string;
}

async function testTockSuccessfulPayloadCache(): Promise<void> {
  const source = readFileSync(new URL("../app/(app)/tock-import.tsx", import.meta.url), "utf8");
  const bridgeScript = extractTemplateLiteral(source, "TOCK_HISTORY_BRIDGE_SCRIPT");
  const readHistoryStart = bridgeScript.indexOf("async function readHistory() {");
  const readHistoryEnd = bridgeScript.indexOf("window.__palateTockReadHistory = readHistory;", readHistoryStart);
  assert.notEqual(readHistoryStart, -1);
  assert.notEqual(readHistoryEnd, -1);
  const readHistorySource = bridgeScript.slice(readHistoryStart, readHistoryEnd);
  const cacheReadIndex = readHistorySource.indexOf("if (window.__palateTockHistoryPayload) {");
  const pendingReadIndex = readHistorySource.indexOf("if (window.__palateTockReadingHistory) {");
  const countRequestIndex = readHistorySource.indexOf('postGraphql("ReservationHistoryCount"');
  assert.ok(cacheReadIndex >= 0 && cacheReadIndex < pendingReadIndex && pendingReadIndex < countRequestIndex);
  assert.match(
    readHistorySource,
    /var captureComplete = typeof totalCount !== "number" \|\| purchases\.length >= totalCount;/,
  );
  assert.match(
    readHistorySource,
    /if \(!captureComplete\) \{[\s\S]*?count: 0,[\s\S]*?error: "Tock history capture was incomplete\. Retrying\.\.\."[\s\S]*?return;\s*\}/,
  );
  assert.match(
    readHistorySource,
    /if \(resultCount\(payload\) > 0 && captureComplete\) \{\s*window\.__palateTockHistoryPayload = payload;\s*\}/,
  );
  assert.match(bridgeScript, /setInterval\(readHistory, 2500\);/);

  const messages: Array<Record<string, unknown>> = [];
  const fetchUrls: string[] = [];
  const intervalCallbacks: Array<() => unknown> = [];
  const timeoutCallbacks: Array<() => unknown> = [];
  const windowObject: Record<string, unknown> = {
    ReactNativeWebView: {
      postMessage: (serialized: string) => {
        messages.push(JSON.parse(serialized) as Record<string, unknown>);
      },
    },
  };
  const context = {
    window: windowObject,
    fetch: async (url: string) => {
      fetchUrls.push(url);
      if (url.endsWith("/ReservationHistoryCount")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ data: { reservationHistoryCount: { pastBookingsCount: 2 } } }),
        };
      }
      assert.ok(url.endsWith("/PatronReservationHistory"));
      return {
        status: 200,
        ok: true,
        json: async () => ({ data: { purchases: [{ id: "purchase-1" }, { id: "purchase-2" }] } }),
      };
    },
    setInterval: (callback: () => unknown, milliseconds: number) => {
      assert.equal(milliseconds, 2_500);
      intervalCallbacks.push(callback);
      return 1;
    },
    setTimeout: (callback: () => unknown, milliseconds: number) => {
      assert.equal(milliseconds, 300);
      timeoutCallbacks.push(callback);
      return 2;
    },
  };

  runInNewContext(bridgeScript, context);
  assert.equal(intervalCallbacks.length, 1);
  assert.equal(timeoutCallbacks.length, 1);
  await timeoutCallbacks[0]!();
  assert.deepEqual(fetchUrls, ["/api/graphql/ReservationHistoryCount", "/api/graphql/PatronReservationHistory"]);
  assert.equal(messages.length, 1);
  const firstMessage = messages[0];
  assert.equal(firstMessage?.count, 2);

  await intervalCallbacks[0]!();
  await intervalCallbacks[0]!();
  assert.equal(fetchUrls.length, 2, "2.5-second delivery retries must not repeat GraphQL after success");
  assert.deepEqual(messages, [firstMessage, firstMessage, firstMessage]);

  runInNewContext(bridgeScript, context);
  await Promise.resolve();
  assert.equal(fetchUrls.length, 2, "bridge reinjection must repost the cached payload without GraphQL");
  assert.deepEqual(messages, [firstMessage, firstMessage, firstMessage, firstMessage]);
}

async function testTockShortKnownTotalRetriesUntilComplete(): Promise<void> {
  const source = readFileSync(new URL("../app/(app)/tock-import.tsx", import.meta.url), "utf8");
  const bridgeScript = extractTemplateLiteral(source, "TOCK_HISTORY_BRIDGE_SCRIPT");
  const messages: Array<Record<string, unknown>> = [];
  const fetchUrls: string[] = [];
  const intervalCallbacks: Array<() => unknown> = [];
  const timeoutCallbacks: Array<() => unknown> = [];
  let historyRequestCount = 0;
  const windowObject: Record<string, unknown> = {
    ReactNativeWebView: {
      postMessage: (serialized: string) => {
        messages.push(JSON.parse(serialized) as Record<string, unknown>);
      },
    },
  };
  const context = {
    window: windowObject,
    fetch: async (url: string) => {
      fetchUrls.push(url);
      if (url.endsWith("/ReservationHistoryCount")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ data: { reservationHistoryCount: { pastBookingsCount: 3 } } }),
        };
      }
      assert.ok(url.endsWith("/PatronReservationHistory"));
      historyRequestCount += 1;
      const purchaseCount = historyRequestCount === 1 ? 2 : 3;
      return {
        status: 200,
        ok: true,
        json: async () => ({
          data: {
            purchases: Array.from({ length: purchaseCount }, (_, index) => ({ id: `purchase-${index + 1}` })),
          },
        }),
      };
    },
    setInterval: (callback: () => unknown) => {
      intervalCallbacks.push(callback);
      return 1;
    },
    setTimeout: (callback: () => unknown) => {
      timeoutCallbacks.push(callback);
      return 2;
    },
  };

  runInNewContext(bridgeScript, context);
  await timeoutCallbacks[0]!();
  assert.equal(messages[0]?.count, 0, "a short known-total capture must post only retry status");
  assert.equal("payload" in messages[0]!, false, "a short known-total capture must not enter native review");
  assert.equal(messages[0]?.error, "Tock history capture was incomplete. Retrying...");
  assert.equal(windowObject.__palateTockHistoryPayload, undefined, "a short known-total capture must not be cached");
  assert.equal(fetchUrls.length, 2);

  await intervalCallbacks[0]!();
  assert.equal(fetchUrls.length, 4, "the next interval must retry both count and history after a short capture");
  assert.equal(messages[1]?.count, 3, "the complete retry must be the first reviewable payload");
  assert.ok("payload" in messages[1]!);
  assert.ok(windowObject.__palateTockHistoryPayload, "the complete retry must become the cached payload");

  await intervalCallbacks[0]!();
  assert.equal(fetchUrls.length, 4, "a complete retry must make later intervals cache-only");
  assert.deepEqual(messages[2], messages[1]);
}

function testProductionWiring(): void {
  const service = readFileSync(new URL("../services/reservation-import.ts", import.meta.url), "utf8");
  assert.match(service, /return resolveProviderReservationLocations\(reservations, \{/);
  assert.match(service, /searchPlaces: searchPlaceByText,/);
  assert.match(
    service,
    /const resolvedLocations = await resolveReservationLocations\(reservations, restaurantsByName\);/,
  );
  assert.match(service, /const locatedReservationsBySourceEventId = new Map\(/);
  assert.match(
    service,
    /const locatedReservation = locatedReservationsBySourceEventId\.get\(reservation\.sourceEventId\) \?\? reservation;/,
  );
  assert.doesNotMatch(service, /for \(const reservation of reservations\) \{\s*const located = await/);

  const browser = readFileSync(new URL("../components/reservation-import-browser-screen.tsx", import.meta.url), "utf8");
  assert.match(browser, /beginProviderReservationReplay\(replayGateRef\.current!?, event\.nativeEvent\.data\)/);
  assert.match(browser, /completeProviderReservationReplay\(replayGateRef\.current!?, replay\.generation\)/);
  assert.match(browser, /failProviderReservationReplay\(replayGateRef\.current!?, replay\.generation\)/);
  assert.match(browser, /replayGateRef\.current = resetProviderReservationReplay\(replayGateRef\.current!?\);/);
}

await testSequentialParityAndExactCoalescing();
await testBoundedConcurrencyAndReviewReuse();
testReplayGenerationGate();
await testTockSuccessfulPayloadCache();
await testTockShortKnownTotalRetriesUntilComplete();
testProductionWiring();

console.log("Provider reservation location tests passed.");

#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { QueryClient, timeoutManager, type TimeoutCallback } from "@tanstack/query-core";
import {
  ACTIVE_MICHELIN_UNICODE_NAME_ROWS_SQL,
  HYDRATE_UNVISITED_MICHELIN_NAME_SEARCH_SQL,
  MICHELIN_NAME_SEARCH_DEBOUNCE_MS,
  assertMichelinNameSearchNotAborted,
  createMichelinUnicodeNameIndex,
  isNonAsciiMichelinNameSearchQuery,
  normalizeMichelinNameSearchQuery,
  runStableMichelinNameSearch,
  selectSortedMichelinUnicodeMatchIds,
  type MichelinUnicodeNameIndexRow,
  type MichelinUnicodeNameRow,
} from "../utils/db/michelin-name-search-core.ts";
import {
  ensureMichelinDataInitialized,
  MICHELIN_INITIALIZATION_QUERY_KEY,
  MICHELIN_STATIC_QUERY_CACHE_POLICY,
} from "../utils/michelin-query-cache-policy.ts";

const DATASET_KEY = "michelin_dataset_version";

interface RestaurantRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string;
  readonly location: string;
  readonly cuisine: string;
  readonly latestAwardYear: number | null;
  readonly award: string;
  readonly datasetVersion: string | null;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      cuisine TEXT NOT NULL DEFAULT '',
      latestAwardYear INTEGER,
      award TEXT NOT NULL DEFAULT '',
      datasetVersion TEXT
    );
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      status TEXT NOT NULL
    );
    CREATE INDEX idx_visits_restaurant_status ON visits(restaurantId, status);
  `);
  return database;
}

function seedFixture(database: DatabaseSync): void {
  const insertRestaurant = database.prepare(`INSERT INTO michelin_restaurants
    (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (id: string, name: string, datasetVersion: string | null = "v2") =>
    insertRestaurant.run(
      id,
      name,
      40 + id.length / 100,
      -70 - id.length / 100,
      `Address ${id}`,
      "Fixture",
      "Test",
      2026,
      "Selected",
      datasetVersion,
    );

  add("michelin-composed", "École");
  add("michelin-decomposed", `E\u0301cole`);
  add("michelin-turkish-dotted", "İstanbul");
  add("michelin-turkish-ascii", "Istanbul");
  add("michelin-ascii-control", "Line\nBreak");
  add("michelin-sharp-s", "Straße");
  add("michelin-ss", "Strasse");
  add("michelin-sigma-medial", "Στοά");
  add("michelin-sigma-final", "ΟΣ");
  add("michelin-cjk", "東京 Étage");
  add("michelin-emoji", "🍣 Éclair");
  add("michelin-percent", "É%tage");
  add("michelin-underscore", "É_tagère");
  add("michelin-backslash", "É\\table");
  add("michelin-tie-b", "Égal");
  add("michelin-tie-a", "Égal");
  add("michelin-stale", "É stale snapshot", "v1");
  add("michelin-null-version", "É null version", null);
  add("michelin-v3", "É version three", "v3");

  for (let index = 0; index < 120; index += 1) {
    add(`michelin-bulk-${index.toString().padStart(3, "0")}`, `É Bulk ${index.toString().padStart(3, "0")}`);
  }

  database.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run(DATASET_KEY, "v2");
  const insertVisit = database.prepare("INSERT INTO visits (id, restaurantId, status) VALUES (?, ?, ?)");
  for (let index = 0; index < 55; index += 1) {
    insertVisit.run(`confirmed-${index}`, `michelin-bulk-${index.toString().padStart(3, "0")}`, "confirmed");
  }
  insertVisit.run("pending-060", "michelin-bulk-060", "pending");
  insertVisit.run("rejected-061", "michelin-bulk-061", "rejected");
  insertVisit.run("confirmed-composed", "michelin-composed", "confirmed");
}

function plainRows(rows: readonly Record<string, unknown>[]): RestaurantRow[] {
  return rows.map((row) => ({ ...row })) as unknown as RestaurantRow[];
}

function readDatasetVersion(database: DatabaseSync): string | null {
  const row = database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(DATASET_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function literalLegacyOracle(database: DatabaseSync, rawQuery: string, limit: number = 50): RestaurantRow[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return [];
  }
  const datasetVersion = readDatasetVersion(database);
  const confirmedIds = new Set(
    (
      database.prepare("SELECT restaurantId FROM visits WHERE status = 'confirmed'").all() as unknown as Array<{
        restaurantId: string;
      }>
    ).map((row) => row.restaurantId),
  );
  return plainRows(database.prepare("SELECT * FROM michelin_restaurants").all())
    .filter((row) => datasetVersion === null || row.datasetVersion === datasetVersion)
    .filter((row) => !confirmedIds.has(row.id))
    .filter((row) => row.name.toLowerCase().includes(query))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function readCandidateIndex(database: DatabaseSync): MichelinUnicodeNameIndexRow[] {
  const rows = database
    .prepare(ACTIVE_MICHELIN_UNICODE_NAME_ROWS_SQL)
    .all(DATASET_KEY, DATASET_KEY)
    .map((row) => ({ ...row })) as unknown as MichelinUnicodeNameRow[];
  return createMichelinUnicodeNameIndex(rows);
}

function hydrateCandidate(
  database: DatabaseSync,
  index: readonly MichelinUnicodeNameIndexRow[],
  rawQuery: string,
  limit: number = 50,
): RestaurantRow[] {
  const query = normalizeMichelinNameSearchQuery(rawQuery);
  const ids = selectSortedMichelinUnicodeMatchIds(index, query);
  return hydrateCandidateIds(database, ids, limit);
}

function hydrateCandidateIds(database: DatabaseSync, ids: readonly string[], limit: number = 50): RestaurantRow[] {
  if (ids.length === 0) {
    return [];
  }
  return plainRows(
    database
      .prepare(HYDRATE_UNVISITED_MICHELIN_NAME_SEARCH_SQL)
      .all(JSON.stringify(ids), DATASET_KEY, DATASET_KEY, limit),
  );
}

function assertCandidateMatchesOracle(
  database: DatabaseSync,
  index: readonly MichelinUnicodeNameIndexRow[],
  query: string,
  limit: number = 50,
): void {
  assert.deepEqual(hydrateCandidate(database, index, query, limit), literalLegacyOracle(database, query, limit), query);
}

interface TimedInput {
  readonly atMs: number;
  readonly value: string;
}

function simulateDebouncedNormalizedQueries(inputs: readonly TimedInput[]): string[] {
  const emissions: string[] = [];
  let pending: { dueMs: number; value: string } | null = null;
  for (const input of inputs) {
    if (pending && pending.dueMs <= input.atMs) {
      emissions.push(pending.value);
      pending = null;
    }
    const normalized = normalizeMichelinNameSearchQuery(input.value);
    pending = normalized ? { dueMs: input.atMs + MICHELIN_NAME_SEARCH_DEBOUNCE_MS, value: normalized } : null;
  }
  if (pending) {
    emissions.push(pending.value);
  }
  return emissions;
}

async function testInitializationCacheLifecycle(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const firstInitialization = createDeferred<{ loaded: number; skipped: boolean }>();
  let initializationCalls = 0;
  let pendingReviewInvalidations = 0;
  const initialize = async () => {
    initializationCalls += 1;
    return initializationCalls === 1 ? firstInitialization.promise : { loaded: 137, skipped: false };
  };
  const invalidatePendingReview = async () => {
    pendingReviewInvalidations += 1;
  };

  const firstConsumer = ensureMichelinDataInitialized(queryClient, initialize, invalidatePendingReview);
  const concurrentConsumer = ensureMichelinDataInitialized(queryClient, initialize, invalidatePendingReview);
  await Promise.resolve();
  assert.equal(initializationCalls, 1, "concurrent consumers must share the initialization query");
  firstInitialization.resolve({ loaded: 137, skipped: false });
  assert.deepEqual(await Promise.all([firstConsumer, concurrentConsumer]), [
    { loaded: 137, skipped: false },
    { loaded: 137, skipped: false },
  ]);
  assert.equal(pendingReviewInvalidations, 1, "only the actual initialization query invalidates pending review");

  await ensureMichelinDataInitialized(queryClient, initialize, invalidatePendingReview);
  assert.equal(initializationCalls, 1, "the successful initialization query stays cached");
  assert.ok(queryClient.getQueryData(MICHELIN_INITIALIZATION_QUERY_KEY));

  queryClient.clear();
  assert.equal(queryClient.getQueryData(MICHELIN_INITIALIZATION_QUERY_KEY), undefined);
  await ensureMichelinDataInitialized(queryClient, initialize, invalidatePendingReview);
  assert.equal(initializationCalls, 2, "Reset Everything's QueryClient.clear must make the next consumer reinitialize");
  assert.equal(pendingReviewInvalidations, 2);
  queryClient.clear();
}

interface FakeTimer {
  readonly callback: TimeoutCallback;
  due: number;
  readonly interval: number | null;
}

async function testStaticIndexSurvivesFiveMinuteGarbageCollection(): Promise<void> {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, FakeTimer>();
  const schedule = (callback: TimeoutCallback, delay: number, interval: number | null): number => {
    const timerId = nextTimerId++;
    timers.set(timerId, { callback, due: now + delay, interval });
    return timerId;
  };
  const advance = (milliseconds: number): void => {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) {
        break;
      }
      const [timerId, timer] = next;
      now = timer.due;
      timers.delete(timerId);
      timer.callback(undefined);
      if (timer.interval !== null) {
        timer.due = now + timer.interval;
        timers.set(timerId, timer);
      }
    }
    now = target;
  };

  timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) => schedule(callback, delay, null),
    clearTimeout: (timerId) => timers.delete(timerId ?? -1),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearInterval: (timerId) => timers.delete(timerId ?? -1),
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const indexKey = ["static", "michelinUnicodeNameIndex", "v2"] as const;
    const finiteControlKey = ["finite-control"] as const;
    await queryClient.fetchQuery({
      queryKey: indexKey,
      queryFn: async () => [{ id: "unicode", name: "É", lowerName: "é" }],
      ...MICHELIN_STATIC_QUERY_CACHE_POLICY,
    });
    await queryClient.fetchQuery({
      queryKey: finiteControlKey,
      queryFn: async () => "finite",
      staleTime: Infinity,
      gcTime: 5 * 60 * 1_000,
    });
    assert.equal(queryClient.getQueryCache().find({ queryKey: indexKey, exact: true })?.gcTime, Infinity);

    advance(5 * 60 * 1_000 + 1);
    assert.ok(queryClient.getQueryData(indexKey), "the static Unicode index must survive more than five idle minutes");
    assert.equal(queryClient.getQueryData(finiteControlKey), undefined, "the fake clock must exercise finite GC");
  } finally {
    queryClient.clear();
  }
}

async function testDatasetVersionSwapCannotPublishRenamedRow(): Promise<void> {
  const database = createDatabase();
  try {
    seedFixture(database);
    let hydrationAttempts = 0;
    let datasetChanges = 0;
    let firstAttemptRows: RestaurantRow[] = [];
    const result = await runStableMichelinNameSearch({
      readDatasetVersion: async () => readDatasetVersion(database),
      loadIndex: async () => readCandidateIndex(database),
      selectMatchingIds: (index) => selectSortedMichelinUnicodeMatchIds(index, "🍣"),
      hydrateMatchingIds: async (ids) => {
        hydrationAttempts += 1;
        if (hydrationAttempts === 1) {
          database.prepare("UPDATE app_metadata SET value = ? WHERE key = ?").run("v3", DATASET_KEY);
          database
            .prepare("UPDATE michelin_restaurants SET name = ?, datasetVersion = ? WHERE id = ?")
            .run("Plain renamed restaurant", "v3", "michelin-emoji");
        }
        const rows = hydrateCandidateIds(database, ids);
        if (hydrationAttempts === 1) {
          firstAttemptRows = rows;
        }
        return rows;
      },
      onDatasetChanged: () => {
        datasetChanges += 1;
      },
    });

    assert.deepEqual(
      firstAttemptRows.map(({ id, name }) => ({ id, name })),
      [{ id: "michelin-emoji", name: "Plain renamed restaurant" }],
      "the fixture must expose the same-ID rename that would be stale without version validation",
    );
    assert.deepEqual(result, [], "the stale renamed row must be discarded and the new dataset searched exactly");
    assert.equal(hydrationAttempts, 2, "one version mismatch gets one bounded retry");
    assert.equal(datasetChanges, 1);
  } finally {
    database.close();
  }

  let versionReads = 0;
  let repeatedHydrations = 0;
  await assert.rejects(
    runStableMichelinNameSearch({
      readDatasetVersion: async () => `moving-${versionReads++}`,
      loadIndex: async () => [],
      selectMatchingIds: () => [],
      hydrateMatchingIds: async () => {
        repeatedHydrations += 1;
        return [];
      },
    }),
    /changed during 2 consecutive search attempts/,
  );
  assert.equal(repeatedHydrations, 2, "continuously changing datasets must stop after the bounded retry");
}

await testStaticIndexSurvivesFiveMinuteGarbageCollection();
await testInitializationCacheLifecycle();
await testDatasetVersionSwapCannotPublishRenamedRow();

const database = createDatabase();
try {
  seedFixture(database);
  const activeIndex = readCandidateIndex(database);
  const activeIndexIds = new Set(activeIndex.map((row) => row.id));
  assert.equal(activeIndexIds.has("michelin-turkish-ascii"), false, "ASCII-only names must stay out of Unicode index");
  assert.equal(activeIndexIds.has("michelin-ss"), false);
  assert.equal(activeIndexIds.has("michelin-ascii-control"), false, "ASCII control bytes are not Unicode names");
  assert.equal(activeIndexIds.has("michelin-stale"), false, "historical dataset rows must stay out of active index");
  assert.equal(activeIndexIds.has("michelin-null-version"), false);

  for (const query of [
    " ÉCOLE ",
    `E\u0301COLE`,
    "İ",
    `i\u0307`,
    "ß",
    "Σ",
    "ς",
    "東京",
    "🍣",
    "é%",
    "é_",
    "é\\",
    "égal",
    "é bulk",
  ]) {
    assertCandidateMatchesOracle(database, activeIndex, query);
  }
  assert.equal(hydrateCandidate(database, activeIndex, "é bulk").length, 50, "visited prefix must not shrink page");
  assert.deepEqual(
    hydrateCandidate(database, activeIndex, "égal").map((row) => row.id),
    ["michelin-tie-a", "michelin-tie-b"],
    "ID localeCompare must break equal-name ties",
  );
  assert.equal(
    selectSortedMichelinUnicodeMatchIds(activeIndex, "ss").length,
    0,
    "ASCII queries use unchanged SQL path",
  );
  assert.equal(isNonAsciiMichelinNameSearchQuery(normalizeMichelinNameSearchQuery("K")), false);
  assert.equal(normalizeMichelinNameSearchQuery("İ"), `i\u0307`);

  const frozenIndex = activeIndex;
  database
    .prepare("INSERT INTO visits (id, restaurantId, status) VALUES (?, ?, ?)")
    .run("late-confirmation", "michelin-bulk-055", "confirmed");
  assertCandidateMatchesOracle(database, frozenIndex, "é bulk");
  assert.equal(hydrateCandidate(database, frozenIndex, "é bulk").length, 50);

  database.prepare("DELETE FROM app_metadata WHERE key = ?").run(DATASET_KEY);
  const unversionedIndex = readCandidateIndex(database);
  assert.ok(unversionedIndex.some((row) => row.id === "michelin-stale"));
  assert.ok(unversionedIndex.some((row) => row.id === "michelin-null-version"));
  assertCandidateMatchesOracle(database, unversionedIndex, "é stale");
  assertCandidateMatchesOracle(database, unversionedIndex, "é null");
  database.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run(DATASET_KEY, "v2");

  const queryClient = new QueryClient();
  let resultCalls = 0;
  let indexCalls = 0;
  let hydrationCalls = 0;
  const cachedSearch = async (rawQuery: string): Promise<RestaurantRow[]> => {
    const normalized = normalizeMichelinNameSearchQuery(rawQuery);
    return queryClient.fetchQuery({
      queryKey: ["michelinRestaurantSearch", normalized],
      staleTime: Infinity,
      queryFn: async ({ signal }) => {
        resultCalls += 1;
        assertMichelinNameSearchNotAborted(signal);
        const datasetVersion = readDatasetVersion(database);
        const index = await queryClient.ensureQueryData<MichelinUnicodeNameIndexRow[]>({
          queryKey: ["static", "michelinUnicodeNameIndex", datasetVersion ?? "unversioned"],
          queryFn: async () => {
            indexCalls += 1;
            return readCandidateIndex(database);
          },
          ...MICHELIN_STATIC_QUERY_CACHE_POLICY,
        });
        assertMichelinNameSearchNotAborted(signal);
        hydrationCalls += 1;
        return hydrateCandidate(database, index, normalized);
      },
    });
  };

  await cachedSearch(" ÉGAL ");
  await cachedSearch("égal");
  assert.deepEqual({ resultCalls, indexCalls, hydrationCalls }, { resultCalls: 1, indexCalls: 1, hydrationCalls: 1 });

  const rapidEmissions = simulateDebouncedNormalizedQueries([
    { atMs: 0, value: "é" },
    { atMs: 40, value: "ép" },
    { atMs: 80, value: "épi" },
  ]);
  assert.deepEqual(rapidEmissions, ["épi"]);
  for (const query of rapidEmissions) {
    await cachedSearch(query);
  }
  assert.equal(resultCalls, 2, "rapid typing must add one result query");
  assert.equal(indexCalls, 1, "all Unicode queries for one dataset must share the static index");

  const backspaceEmissions = simulateDebouncedNormalizedQueries([
    { atMs: 0, value: "épi" },
    { atMs: 250, value: "ép" },
    { atMs: 500, value: "épi" },
  ]);
  assert.deepEqual(backspaceEmissions, ["épi", "ép", "épi"]);
  for (const query of backspaceEmissions) {
    await cachedSearch(query);
  }
  assert.equal(resultCalls, 3, "backspacing adds only the one previously unseen normalized key");
  assert.equal(indexCalls, 1);

  await queryClient.invalidateQueries({ queryKey: ["michelinRestaurantSearch"] });
  assert.equal(
    queryClient.getQueryState(["static", "michelinUnicodeNameIndex", "v2"])?.isInvalidated,
    false,
    "visit-result invalidation must not reload the dataset-scoped index",
  );
  await cachedSearch("égal");
  assert.equal(resultCalls, 4);
  assert.equal(indexCalls, 1);

  database.prepare("UPDATE app_metadata SET value = ? WHERE key = ?").run("v3", DATASET_KEY);
  await queryClient.invalidateQueries({ queryKey: ["michelinRestaurantSearch"] });
  const v3Results = await cachedSearch("é version");
  assert.deepEqual(
    v3Results.map((row) => row.id),
    ["michelin-v3"],
  );
  assert.equal(indexCalls, 2, "dataset-version key change must build a replacement index");
  assert.ok(queryClient.getQueryData(["static", "michelinUnicodeNameIndex", "v3"]));

  const controller = new AbortController();
  controller.abort(new Error("stale generation"));
  assert.throws(() => assertMichelinNameSearchNotAborted(controller.signal), /stale generation/);

  const phaseController = new AbortController();
  await assert.rejects(
    runStableMichelinNameSearch({
      signal: phaseController.signal,
      readDatasetVersion: async () => "v3",
      loadIndex: async () => [],
      selectMatchingIds: () => [],
      hydrateMatchingIds: async () => {
        phaseController.abort(new Error("cancelled after hydration"));
        return [];
      },
    }),
    /cancelled after hydration/,
  );

  const hookSource = readFileSync(new URL("../hooks/queries.ts", import.meta.url), "utf8");
  const screenSource = readFileSync(new URL("../app/(app)/(tabs)/index.tsx", import.meta.url), "utf8");
  const databaseSource = readFileSync(new URL("../utils/db/michelin.ts", import.meta.url), "utf8");
  assert.match(hookSource, /queryKeys\.michelinUnicodeNameIndex\(datasetVersion\)/);
  assert.match(hookSource, /ensureQueryData<MichelinUnicodeNameIndexRow\[]>/);
  assert.match(hookSource, /MICHELIN_STATIC_QUERY_CACHE_POLICY/);
  assert.match(hookSource, /runStableMichelinNameSearch/);
  assert.match(hookSource, /assertMichelinNameSearchNotAborted\(signal\)/);
  assert.doesNotMatch(hookSource, /michelinInitializedQueryClients|michelinInitializationByQueryClient/);
  assert.match(screenSource, /MICHELIN_NAME_SEARCH_DEBOUNCE_MS/);
  assert.match(screenSource, /const timeoutId = setTimeout\(/);
  assert.match(screenSource, /isMichelinSearchDebouncing \|\| isMichelinSearchFetching/);
  assert.match(databaseSource, /m\.name COLLATE NOCASE LIKE \? ESCAPE '\\\\'/, "ASCII LIKE path must remain");
  assert.match(databaseSource, /runStableMichelinNameSearch/);
  assert.doesNotMatch(databaseSource, /const candidates = await database\.getAllAsync<MichelinRestaurantRecord>/);

  console.log("Michelin name search tests passed.");
} finally {
  database.close();
}

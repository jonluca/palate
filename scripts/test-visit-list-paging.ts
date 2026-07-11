#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/query-core";
import {
  buildVisitListPageQuery,
  MAX_VISIT_LIST_PAGE_SIZE,
  parseVisitListPageRows,
  type VisitListCursor,
  type VisitListFilter,
  type VisitListItem,
  type VisitListPageRow,
} from "../utils/db/visit-list-paging-core.ts";
import {
  refreshAllQueriesWithVisitListPageReset,
  resetVisitListPageQueries,
  VISIT_LIST_PAGE_QUERY_ROOT,
  VISIT_LIST_QUERY_POLICY,
} from "../utils/query-cache-policy.ts";
import { ensureMichelinDataInitialized } from "../utils/michelin-query-cache-policy.ts";

const VISIT_COUNT = 263;

async function waitForCondition(condition: () => boolean, failureMessage: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(failureMessage);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const LITERAL_PREVIEW_ORDER = `CASE
  WHEN p.foodDetected = 1 THEN 0
  WHEN p.foodDetected = 0 THEN 1
  ELSE 2
END ASC, p.creationTime ASC, p.id ASC`;

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE michelin_restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL,
      startTime REAL NOT NULL,
      photoCount INTEGER NOT NULL DEFAULT 0,
      foodProbable INTEGER NOT NULL DEFAULT 0,
      calendarEventTitle TEXT,
      calendarEventIsAllDay INTEGER
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      creationTime INTEGER NOT NULL,
      visitId TEXT,
      foodDetected INTEGER
    );
    CREATE INDEX idx_visits_time ON visits(startTime);
    CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
    CREATE INDEX idx_visits_food_time ON visits(foodProbable, startTime DESC);
    CREATE INDEX idx_photos_visit_preview ON photos(
      visitId,
      (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
      creationTime,
      id
    );
  `);
  return database;
}

function visitId(index: number): string {
  if (index === 0) {
    return "visit-'quoted'";
  }
  if (index === 1) {
    return "訪問-東京-🍣";
  }
  if (index === 2) {
    return 'visit-"json"-café';
  }
  return `visit-${index.toString().padStart(4, "0")}`;
}

function seedDatabase(database: DatabaseSync): void {
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertMichelin = database.prepare("INSERT INTO michelin_restaurants (id, name) VALUES (?, ?)");
  const insertVisit = database.prepare(`INSERT INTO visits (
    id, restaurantId, suggestedRestaurantId, status, startTime, photoCount,
    foodProbable, calendarEventTitle, calendarEventIsAllDay
  ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`);
  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, uri, creationTime, visitId, foodDetected) VALUES (?, ?, ?, ?, ?)",
  );
  database.exec("BEGIN");
  try {
    for (let index = 0; index < 12; index++) {
      insertRestaurant.run(`local-${index}`, index === 0 ? "Local O'Brien 雪" : `Local ${index}`);
      insertMichelin.run(`michelin-${index}`, index === 1 ? "Guide 東京" : `Guide ${index}`);
    }
    const statuses = ["pending", "confirmed", "rejected"] as const;
    for (let index = 0; index < VISIT_COUNT; index++) {
      const id = visitId(index);
      insertVisit.run(
        id,
        index % 5 === 0 ? null : `local-${index % 12}`,
        index % 7 === 0 ? null : `michelin-${index % 12}`,
        statuses[index % statuses.length],
        1_800_000_000_000.5 - Math.floor(index / 4) * 60_000,
        index % 4 === 0 ? 1 : 0,
        index % 9 === 0 ? `Reservation "${index}" 雪` : null,
        index % 11 === 0 ? 1 : index % 11 === 1 ? null : 0,
      );

      const photoCount = index % 6;
      for (let photoIndex = 0; photoIndex < photoCount; photoIndex++) {
        const photoId = `photo-${index.toString().padStart(4, "0")}-${String.fromCharCode(122 - photoIndex)}`;
        insertPhoto.run(
          photoId,
          index === 1 && photoIndex === 0 ? `ph://雪/'quote'/\\slash` : `ph://${photoId}`,
          1_700_000_000_000 + Math.floor(photoIndex / 2),
          id,
          photoIndex % 3 === 0 ? 1 : photoIndex % 3 === 1 ? 0 : null,
        );
      }
    }
    database.exec(`
      UPDATE visits
      SET photoCount = (SELECT COUNT(*) FROM photos WHERE photos.visitId = visits.id);
      COMMIT;
      PRAGMA optimize;
    `);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

interface LiteralRow extends Omit<VisitListItem, "foodProbable" | "calendarEventIsAllDay" | "previewPhotos"> {
  readonly foodProbable: number;
  readonly calendarEventIsAllDay: number | null;
  readonly previewPhotosJson: string | null;
}

function literalSelection(filter?: VisitListFilter): { readonly sql: string; readonly parameters: string[] } {
  if (filter === "food") {
    return { sql: "WHERE c.foodProbable = 1", parameters: [] };
  }
  return filter ? { sql: "WHERE c.status = ?", parameters: [filter] } : { sql: "", parameters: [] };
}

/** Literal full-list oracle. It intentionally imports no production SQL or parser. */
function runLiteralOracle(database: DatabaseSync, filter?: VisitListFilter): VisitListItem[] {
  const selection = literalSelection(filter);
  const rows = database
    .prepare(
      `SELECT
         c.id,
         c.status,
         c.startTime,
         c.photoCount,
         c.foodProbable,
         c.calendarEventTitle,
         c.calendarEventIsAllDay,
         r.name AS restaurantName,
         m.name AS suggestedRestaurantName,
         (
           SELECT json_group_array(uri)
           FROM (
             SELECT p.uri
             FROM photos p
             WHERE p.visitId = c.id
             ORDER BY ${LITERAL_PREVIEW_ORDER}
             LIMIT 3
           )
         ) AS previewPhotosJson
       FROM visits c
       LEFT JOIN restaurants r ON r.id = c.restaurantId
       LEFT JOIN michelin_restaurants m ON m.id = c.suggestedRestaurantId
       ${selection.sql}
       ORDER BY c.startTime DESC, c.id COLLATE BINARY DESC`,
    )
    .all(...selection.parameters) as unknown as LiteralRow[];
  return rows.map((row) => {
    let previewPhotos: string[] = [];
    if (row.previewPhotosJson) {
      try {
        const parsed: unknown = JSON.parse(row.previewPhotosJson);
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
          previewPhotos = parsed;
        }
      } catch {
        previewPhotos = [];
      }
    }
    return {
      id: row.id,
      status: row.status,
      startTime: row.startTime,
      photoCount: row.photoCount,
      foodProbable: row.foodProbable === 1,
      calendarEventTitle: row.calendarEventTitle,
      calendarEventIsAllDay: row.calendarEventIsAllDay === null ? null : row.calendarEventIsAllDay === 1,
      restaurantName: row.restaurantName,
      suggestedRestaurantName: row.suggestedRestaurantName,
      previewPhotos,
    };
  });
}

function readCandidatePage(
  database: DatabaseSync,
  filter: VisitListFilter | undefined,
  cursor: VisitListCursor | null,
  pageSize: number,
) {
  const query = buildVisitListPageQuery(filter, cursor, pageSize);
  const rows = database.prepare(query.sql).all(...query.parameters) as unknown as VisitListPageRow[];
  return parseVisitListPageRows(rows, query.pageSize);
}

function readAllCandidatePages(database: DatabaseSync, filter: VisitListFilter | undefined, pageSize: number) {
  const visits: VisitListItem[] = [];
  const cursors = new Set<string>();
  let cursor: VisitListCursor | null = null;
  let pageCount = 0;
  do {
    const page = readCandidatePage(database, filter, cursor, pageSize);
    visits.push(...page.visits);
    cursor = page.nextCursor;
    pageCount += 1;
    if (cursor) {
      const key = `${cursor.startTime}:${cursor.id}`;
      assert(!cursors.has(key), "candidate cursor repeated");
      cursors.add(key);
    }
    assert(pageCount <= VISIT_COUNT + 1, "candidate paging did not terminate");
  } while (cursor);
  return { visits, pageCount };
}

function assertLiteralParity(): void {
  const database = createDatabase();
  try {
    seedDatabase(database);
    for (const filter of [undefined, "pending", "confirmed", "rejected", "food"] as const) {
      const expected = runLiteralOracle(database, filter);
      for (const pageSize of [1, 2, 7, 128, 262, 263, 1_000]) {
        const actual = readAllCandidatePages(database, filter, pageSize);
        assert.deepEqual(actual.visits, expected, `${filter ?? "all"} page size ${pageSize}`);
        assert.equal(new Set(actual.visits.map(({ id }) => id)).size, actual.visits.length, "duplicate visit IDs");
      }
    }
    assert.deepEqual(readCandidatePage(database, undefined, { startTime: 0, id: "" }, 128), {
      visits: [],
      nextCursor: null,
    });
  } finally {
    database.close();
  }
}

function assertFractionalCursorTieBoundary(): void {
  const database = createDatabase();
  try {
    seedDatabase(database);
    const expected = runLiteralOracle(database);
    const first = readCandidatePage(database, undefined, null, 2);
    assert.equal(Number.isInteger(first.visits[0]?.startTime), false, "fixture must exercise REAL timestamps");
    assert(first.nextCursor, "fractional tie must continue after the first page");
    assert.equal(first.nextCursor.startTime, first.visits[1]?.startTime);

    const second = readCandidatePage(database, undefined, first.nextCursor, 2);
    assert.deepEqual(
      [...first.visits, ...second.visits],
      expected.slice(0, 4),
      "fractional equal-time visits must cross a keyset boundary without gaps or duplicates",
    );
  } finally {
    database.close();
  }
}

function explain(database: DatabaseSync, filter?: VisitListFilter, cursor: VisitListCursor | null = null): string {
  const query = buildVisitListPageQuery(filter, cursor, 128);
  return (database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.parameters) as Array<{ detail: string }>)
    .map(({ detail }) => detail)
    .join("\n");
}

function assertPrefixIndexPlan(plan: string, indexName: string, label: string): void {
  assert.match(plan, new RegExp(`\\b${indexName}\\b`), `${label} must use ${indexName}`);
  assert.match(plan, /idx_photos_visit_preview/, `${label} must keep indexed preview lookup`);
  for (const detail of plan.split("\n").filter((line) => line.includes("TEMP B-TREE"))) {
    assert.match(detail, /USE TEMP B-TREE FOR LAST TERM OF ORDER BY/, `${label} may sort only the final ID tie term`);
  }
  assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/, `${label} must not sort the complete order`);
}

function assertQueryPlans(): void {
  const database = createDatabase();
  try {
    seedDatabase(database);
    const all = explain(database);
    assertPrefixIndexPlan(all, "idx_visits_time", "all first page");
    const allContinuation = explain(database, undefined, { startTime: 1_800_000_000_000, id: "visit-z" });
    assertPrefixIndexPlan(allContinuation, "idx_visits_time", "all continuation page");
    for (const status of ["pending", "confirmed", "rejected"] as const) {
      assertPrefixIndexPlan(
        explain(database, status, { startTime: 1_800_000_000_000, id: "visit-z" }),
        "idx_visits_status_time",
        `${status} continuation page`,
      );
    }
    const food = explain(database, "food", { startTime: 1_800_000_000_000, id: "visit-z" });
    assertPrefixIndexPlan(food, "idx_visits_food_time", "food continuation page");
  } finally {
    database.close();
  }
}

function assertValidationAndParsing(): void {
  assert.throws(() => buildVisitListPageQuery(undefined, null, 0), RangeError);
  assert.throws(() => buildVisitListPageQuery(undefined, null, MAX_VISIT_LIST_PAGE_SIZE + 1), RangeError);
  assert.throws(() => buildVisitListPageQuery(undefined, { startTime: Number.NaN, id: "bad" }, 1), TypeError);
  assert.throws(
    () => buildVisitListPageQuery(undefined, { startTime: Number.POSITIVE_INFINITY, id: "bad" }, 1),
    TypeError,
  );
  assert.deepEqual(parseVisitListPageRows([], 1), { visits: [], nextCursor: null });
  const row: VisitListPageRow = {
    id: "parser",
    status: "pending",
    startTime: 1,
    photoCount: 2,
    foodProbable: 1,
    calendarEventTitle: null,
    calendarEventIsAllDay: 0,
    restaurantName: null,
    suggestedRestaurantName: null,
    previewPhotosJson: "not-json",
  };
  assert.deepEqual(parseVisitListPageRows([row], 1).visits[0], {
    id: "parser",
    status: "pending",
    startTime: 1,
    photoCount: 2,
    foodProbable: true,
    calendarEventTitle: null,
    calendarEventIsAllDay: false,
    restaurantName: null,
    suggestedRestaurantName: null,
    previewPhotos: [],
  });
  assert.throws(() => parseVisitListPageRows([{ ...row, status: "unknown" }], 1), /unsupported status/);
}

async function assertInfiniteResetContract(): Promise<void> {
  assert.equal(VISIT_LIST_QUERY_POLICY.staleTime, Infinity, "focus remounts must reuse authoritative list pages");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = [...VISIT_LIST_PAGE_QUERY_ROOT, "all"] as const;
  const calls: number[] = [];
  const observer = new InfiniteQueryObserver(queryClient, {
    queryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      calls.push(pageParam);
      return { index: pageParam };
    },
    getNextPageParam: (lastPage) => (lastPage.index < 2 ? lastPage.index + 1 : undefined),
    ...VISIT_LIST_QUERY_POLICY,
  });
  let unsubscribe = observer.subscribe(() => undefined);
  try {
    await observer.refetch();
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    assert.equal(queryClient.getQueryData<InfiniteData<{ index: number }, number>>(queryKey)?.pages.length, 3);

    unsubscribe();
    const callsBeforeFreshRemount = calls.length;
    unsubscribe = observer.subscribe(() => undefined);
    await Promise.resolve();
    assert.equal(calls.length, callsBeforeFreshRemount, "fresh focus remount must not refetch retained pages");

    const unrelatedKey = ["visits", "visit", "detail-id"] as const;
    queryClient.setQueryData(unrelatedKey, { marker: true });
    const callsBeforeReset = calls.length;
    await resetVisitListPageQueries(queryClient);
    const reset = queryClient.getQueryData<InfiniteData<{ index: number }, number>>(queryKey);
    assert.deepEqual(reset?.pages, [{ index: 0 }], "active list reset must refetch only page one");
    assert.deepEqual(reset?.pageParams, [0]);
    assert.equal(calls.length, callsBeforeReset + 1, "reset must execute exactly one initial-page request");
    assert.deepEqual(
      queryClient.getQueryData(unrelatedKey),
      { marker: true },
      "reset must not touch visit detail data",
    );
  } finally {
    unsubscribe();
    queryClient.clear();
  }
}

async function assertInactiveFocusResetContract(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = [...VISIT_LIST_PAGE_QUERY_ROOT, "all"] as const;
  const calls: number[] = [];
  const options = {
    queryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam }: { pageParam: number }) => {
      calls.push(pageParam);
      return { index: pageParam };
    },
    getNextPageParam: (lastPage: { index: number }) => (lastPage.index < 2 ? lastPage.index + 1 : undefined),
    ...VISIT_LIST_QUERY_POLICY,
    enabled: true,
  };
  const observer = new InfiniteQueryObserver(queryClient, options);
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await waitForCondition(
      () => observer.getCurrentResult().data?.pages.length === 1 && !observer.getCurrentResult().isFetching,
      "initial visit-list page did not load",
    );
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    assert.equal(observer.getCurrentResult().data?.pages.length, 3);

    observer.setOptions({ ...options, enabled: false });
    const callsBeforeReset = calls.length;
    await resetVisitListPageQueries(queryClient);
    assert.equal(queryClient.getQueryData(queryKey), undefined, "inactive reset must clear every retained page");
    assert.equal(calls.length, callsBeforeReset, "inactive reset must not refetch while the screen is unfocused");

    observer.setOptions({ ...options, enabled: true });
    await waitForCondition(
      () => observer.getCurrentResult().data?.pages.length === 1 && !observer.getCurrentResult().isFetching,
      "refocused visit-list query did not load one initial page",
    );
    assert.equal(calls.length, callsBeforeReset + 1, "refocus after reset must fetch exactly one page");
    assert.deepEqual(observer.getCurrentResult().data?.pageParams, [0]);
  } finally {
    unsubscribe();
    queryClient.clear();
  }
}

async function assertBroadRefreshContract(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const activePageKey = [...VISIT_LIST_PAGE_QUERY_ROOT, "all"] as const;
  const inactivePageKey = [...VISIT_LIST_PAGE_QUERY_ROOT, "food"] as const;
  const unrelatedKey = ["stats"] as const;
  const calls: number[] = [];
  const observer = new InfiniteQueryObserver(queryClient, {
    queryKey: activePageKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      calls.push(pageParam);
      return { index: pageParam };
    },
    getNextPageParam: (lastPage) => (lastPage.index < 2 ? lastPage.index + 1 : undefined),
    ...VISIT_LIST_QUERY_POLICY,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await waitForCondition(
      () => observer.getCurrentResult().data?.pages.length === 1 && !observer.getCurrentResult().isFetching,
      "active visit-list page did not load before broad refresh",
    );
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    queryClient.setQueryData<InfiniteData<{ index: number }, number>>(inactivePageKey, {
      pages: [{ index: 0 }, { index: 1 }],
      pageParams: [0, 1],
    });
    queryClient.setQueryData(unrelatedKey, { marker: true });

    const callsBeforeRefresh = calls.length;
    await refreshAllQueriesWithVisitListPageReset(queryClient);
    assert.deepEqual(observer.getCurrentResult().data?.pages, [{ index: 0 }]);
    assert.deepEqual(observer.getCurrentResult().data?.pageParams, [0]);
    assert.equal(calls.length, callsBeforeRefresh + 1, "broad refresh must refetch only the active initial page");
    assert.equal(queryClient.getQueryData(inactivePageKey), undefined, "broad refresh must clear inactive page caches");
    assert.deepEqual(queryClient.getQueryData(unrelatedKey), { marker: true });
    assert.equal(queryClient.getQueryState(unrelatedKey)?.isInvalidated, true, "non-page queries must be invalidated");
  } finally {
    unsubscribe();
    queryClient.clear();
  }
}

async function assertMichelinInitializationInvalidationContract(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pageKey = [...VISIT_LIST_PAGE_QUERY_ROOT, "pending"] as const;
  queryClient.setQueryData<InfiniteData<{ index: number }, number>>(pageKey, {
    pages: [{ index: 0 }, { index: 1 }],
    pageParams: [0, 1],
  });
  let invalidationCalls = 0;
  try {
    await ensureMichelinDataInitialized(
      queryClient,
      async () => ({ loaded: 28_785, skipped: false }),
      async () => {
        invalidationCalls += 1;
        await resetVisitListPageQueries(queryClient);
      },
    );
    assert.equal(invalidationCalls, 1, "a guide import must run its cache invalidation callback");
    assert.equal(queryClient.getQueryData(pageKey), undefined, "a guide import must clear stale suggested names");
  } finally {
    queryClient.clear();
  }

  const skippedClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let skippedInvalidationCalls = 0;
  try {
    await ensureMichelinDataInitialized(
      skippedClient,
      async () => ({ loaded: 0, skipped: true }),
      async () => {
        skippedInvalidationCalls += 1;
      },
    );
    assert.equal(skippedInvalidationCalls, 0, "an unchanged guide must not reset visit pages");
  } finally {
    skippedClient.clear();
  }
}

async function assertInFlightContinuationResetContract(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = [...VISIT_LIST_PAGE_QUERY_ROOT, "all"] as const;
  const calls: number[] = [];
  let continuationStarted: (() => void) | undefined;
  let continuationWasAborted = false;
  const continuationDidStart = new Promise<void>((resolve) => {
    continuationStarted = resolve;
  });
  const observer = new InfiniteQueryObserver(queryClient, {
    queryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      calls.push(pageParam);
      if (pageParam !== 1) {
        return { index: pageParam };
      }
      continuationStarted?.();
      return new Promise<{ index: number }>((_resolve, reject) => {
        const abort = () => {
          continuationWasAborted = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("continuation aborted"));
        };
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      });
    },
    getNextPageParam: (lastPage) => (lastPage.index === 0 ? 1 : undefined),
    ...VISIT_LIST_QUERY_POLICY,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await waitForCondition(
      () => observer.getCurrentResult().data?.pages.length === 1 && !observer.getCurrentResult().isFetching,
      "initial page did not load before continuation race",
    );
    const continuationResult = observer.fetchNextPage().catch((error: unknown) => error);
    await continuationDidStart;
    await resetVisitListPageQueries(queryClient);
    await continuationResult;

    assert.equal(continuationWasAborted, true, "reset must cancel an in-flight continuation");
    assert.deepEqual(calls, [0, 1, 0], "reset must replace the continuation with one initial-page request");
    assert.deepEqual(observer.getCurrentResult().data?.pages, [{ index: 0 }]);
    assert.deepEqual(observer.getCurrentResult().data?.pageParams, [0]);
  } finally {
    unsubscribe();
    queryClient.clear();
  }
}

function assertProductionWiring(): void {
  const hooks = readFileSync(new URL("../hooks/queries.ts", import.meta.url), "utf8");
  const visitsScreen = readFileSync(new URL("../app/(app)/visits.tsx", import.meta.url), "utf8");
  const homeScreen = readFileSync(new URL("../app/(app)/(tabs)/index.tsx", import.meta.url), "utf8");
  const settingsScreen = readFileSync(new URL("../app/(app)/(tabs)/settings.tsx", import.meta.url), "utf8");
  const database = readFileSync(new URL("../utils/db/core.ts", import.meta.url), "utf8");
  assert.match(hooks, /useInfiniteQuery\(\{[\s\S]*queryKeys\.visitPages\(filter\)/);
  assert.match(hooks, /getVisitListPage\(filter === "all" \? undefined : filter, pageParam\)/);
  assert.match(hooks, /\.\.\.VISIT_LIST_QUERY_POLICY/);
  assert.match(hooks, /function invalidateFoodDetectionQueries[\s\S]*invalidateVisitStatusQueries\(queryClient\)/);
  const michelinInitialization = hooks.match(/async function initializeMichelinDataForQuery[\s\S]*?\n}/)?.[0];
  assert(michelinInitialization, "Michelin query initialization helper must remain wired");
  assert.match(michelinInitialization, /invalidatePendingReviewQuery\(queryClient\)/);
  assert.match(michelinInitialization, /resetVisitListPageQueries\(queryClient\)/);
  assert.match(visitsScreen, /data\?\.pages\.flatMap/);
  assert.match(visitsScreen, /key=\{filter\}/);
  assert.match(visitsScreen, /onEndReached/);
  assert.match(visitsScreen, /stats\.foodProbableVisits/);
  for (const [label, source] of [
    ["All Visits", visitsScreen],
    ["Home", homeScreen],
    ["Settings", settingsScreen],
  ] as const) {
    assert.match(source, /refreshAllQueriesWithVisitListPageReset\(queryClient\)/, `${label} must use safe refresh`);
    assert.doesNotMatch(source, /queryClient\.invalidateQueries\(\s*\)/, `${label} must not broadly invalidate pages`);
  }
  assert.match(database, /idx_visits_time\b/);
  assert.match(database, /idx_visits_status_time\b/);
  assert.match(database, /idx_visits_food_time\b/);
  assert.doesNotMatch(database, /idx_visits_(?:time|status_time|food_time)_id/);
}

async function main(): Promise<void> {
  assertLiteralParity();
  assertFractionalCursorTieBoundary();
  assertQueryPlans();
  assertValidationAndParsing();
  await assertInfiniteResetContract();
  await assertInactiveFocusResetContract();
  await assertBroadRefreshContract();
  await assertMichelinInitializationInvalidationContract();
  await assertInFlightContinuationResetContract();
  assertProductionWiring();
  console.log(
    "Visit-list paging tests passed: literal full-list parity, filters, fractional keyset boundaries, stable ties, Unicode, previews, plans, validation, active/inactive/broad/in-flight resets, Michelin invalidation, and production wiring.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

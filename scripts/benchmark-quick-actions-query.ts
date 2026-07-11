import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  PENDING_QUICK_ACTIONS_SQL,
  createPendingQuickActionsData,
  parsePendingQuickActionRows,
  type PendingQuickActionQueryRow,
  type PendingQuickActionsData,
  type PendingQuickActionVisit,
} from "../utils/db/quick-actions-core.ts";
import { PENDING_VISITS_FOR_REVIEW_SQL, type PendingVisitReviewQueryRow } from "../utils/db/visit-review-core.ts";
import {
  BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS,
  assertCalendarTitleMatchingSourceContract,
} from "./calendar-title-matching-benchmark-core.ts";

type Strategy = "legacy-card-hydration" | "quick-actions-slim-rows";

interface Configuration {
  databasePath?: string;
  visits: number;
  photos: number;
  suggestionEdges: number;
  warmupIterations: number;
  samples: number;
  outputPath: string;
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly size?: number;
  readonly sha256?: string;
}

interface Measurement {
  readonly milliseconds: number;
  readonly resultDigest: string;
  readonly visits: number;
  readonly exactMatches: number;
}

const DEFAULT_CONFIGURATION: Configuration = {
  visits: 6_500,
  photos: 68_000,
  suggestionEdges: 5_200,
  warmupIterations: 2,
  samples: 9,
  outputPath: ".build/quick-actions-query-profile.json",
};

function usage(): string {
  return `Usage: benchmark-quick-actions-query.ts [options]

Options:
  --database=PATH          Immutable read-only Palate database instead of synthetic data
  --visits=N               Synthetic pending visits (default ${DEFAULT_CONFIGURATION.visits})
  --photos=N               Synthetic photos (default ${DEFAULT_CONFIGURATION.photos})
  --suggestion-edges=N     Synthetic suggestion edges (default ${DEFAULT_CONFIGURATION.suggestionEdges})
  --warmup=N               Warmup pairs (default ${DEFAULT_CONFIGURATION.warmupIterations})
  --samples=N              Counterbalanced measured pairs (default ${DEFAULT_CONFIGURATION.samples})
  --output=PATH            Aggregate-only JSON report (default ${DEFAULT_CONFIGURATION.outputPath})
  --help                   Show this help`;
}

function positiveInteger(value: string, option: string, allowZero: boolean = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  const configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--help") {
      return null;
    }
    const [option, value] = argument.split("=", 2);
    if (value === undefined) {
      throw new Error(`Expected --option=value, received ${argument}`);
    }
    switch (option) {
      case "--database":
        configuration.databasePath = resolve(value);
        break;
      case "--visits":
        configuration.visits = positiveInteger(value, option);
        break;
      case "--photos":
        configuration.photos = positiveInteger(value, option, true);
        break;
      case "--suggestion-edges":
        configuration.suggestionEdges = positiveInteger(value, option, true);
        break;
      case "--warmup":
        configuration.warmupIterations = positiveInteger(value, option, true);
        break;
      case "--samples":
        configuration.samples = positiveInteger(value, option);
        break;
      case "--output":
        configuration.outputPath = resolve(value);
        break;
      default:
        throw new Error(`Unknown option ${option}`);
    }
  }
  if (!configuration.databasePath) {
    assert.ok(
      configuration.suggestionEdges <= configuration.visits * 5,
      "synthetic suggestion edges must not exceed five per visit",
    );
  }
  return configuration;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { exists: false };
  }
  const stats = lstatSync(path);
  assert.equal(stats.isSymbolicLink(), false, `source sidecar must not be a symlink: ${path}`);
  assert.equal(stats.isFile(), true, `source sidecar must be a regular file: ${path}`);
  return { exists: true, size: stats.size, sha256: sha256(readFileSync(path)) };
}

function snapshotDatabaseFiles(databasePath: string): Record<string, FileSnapshot> {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].map((suffix) => [suffix || "main", snapshotFile(`${databasePath}${suffix}`)]),
  );
}

function immutableDatabaseUri(databasePath: string): string {
  const url = pathToFileURL(realpathSync(databasePath));
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  const output = resolve(outputPath);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const source = `${databasePath}${suffix}`;
    if (!existsSync(source)) {
      continue;
    }
    assert.notEqual(output, resolve(source), "benchmark output must not equal a source database path");
    if (existsSync(output)) {
      const sourceStats = statSync(source);
      const outputStats = statSync(output);
      assert.ok(
        sourceStats.dev !== outputStats.dev || sourceStats.ino !== outputStats.ino,
        "benchmark output must not hard-link a source database file",
      );
    }
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
      address TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', cuisine TEXT NOT NULL DEFAULT '',
      latestAwardYear INTEGER, award TEXT NOT NULL DEFAULT '', datasetVersion TEXT
    );
    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
      address TEXT, phone TEXT, website TEXT, googlePlaceId TEXT, cuisine TEXT, priceLevel INTEGER,
      rating REAL, notes TEXT
    );
    CREATE TABLE visits (
      id TEXT PRIMARY KEY, restaurantId TEXT, suggestedRestaurantId TEXT, status TEXT NOT NULL,
      startTime REAL NOT NULL, endTime REAL NOT NULL, centerLat REAL NOT NULL, centerLon REAL NOT NULL,
      photoCount INTEGER NOT NULL, foodProbable INTEGER NOT NULL, calendarEventId TEXT,
      calendarEventTitle TEXT, calendarEventLocation TEXT, calendarEventIsAllDay INTEGER, notes TEXT,
      updatedAt REAL, exportedToCalendarId TEXT, awardAtVisit TEXT
    );
    CREATE TABLE visit_suggested_restaurants (
      visitId TEXT NOT NULL, restaurantId TEXT NOT NULL, distance REAL NOT NULL,
      PRIMARY KEY (visitId, restaurantId)
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, uri TEXT NOT NULL, creationTime REAL NOT NULL, latitude REAL, longitude REAL,
      visitId TEXT, foodDetected INTEGER, foodLabels TEXT, foodConfidence REAL, allLabels TEXT,
      mediaType TEXT, duration REAL
    );
    CREATE INDEX idx_visits_status ON visits(status);
    CREATE INDEX idx_visit_suggested_distance ON visit_suggested_restaurants(visitId, distance);
    CREATE INDEX idx_photos_food_labels
      ON photos(visitId) WHERE foodDetected = 1 AND foodLabels IS NOT NULL;
    CREATE INDEX idx_photos_visit_preview ON photos(
      visitId,
      (CASE WHEN foodDetected = 1 THEN 0 WHEN foodDetected = 0 THEN 1 ELSE 2 END),
      creationTime,
      id
    );
  `);
}

function padded(prefix: string, value: number): string {
  return `${prefix}-${value.toString().padStart(7, "0")}`;
}

function syntheticPhotoCounts(visitCount: number, photoCount: number): number[] {
  const weights = Array.from({ length: visitCount }, (_, index) => (index % 23) + 1);
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);
  const counts = weights.map((weight) => Math.floor((photoCount * weight) / weightTotal));
  let remaining = photoCount - counts.reduce((total, count) => total + count, 0);
  for (let index = 0; remaining > 0; index = (index + 1) % counts.length, remaining--) {
    counts[index]! += 1;
  }
  return counts;
}

function seedSyntheticDatabase(database: DatabaseSync, configuration: Configuration): void {
  const restaurantCount = Math.max(1_200, Math.ceil(configuration.suggestionEdges / 4));
  const photoCounts = syntheticPhotoCounts(configuration.visits, configuration.photos);
  const suggestionSlotsByVisit = new Map<number, number[]>();
  for (let edge = 0; edge < configuration.suggestionEdges; edge++) {
    const visitIndex = edge % configuration.visits;
    const slot = Math.floor(edge / configuration.visits);
    const slots = suggestionSlotsByVisit.get(visitIndex) ?? [];
    slots.push(slot);
    suggestionSlotsByVisit.set(visitIndex, slots);
  }

  database.exec("BEGIN");
  try {
    const insertRestaurant = database.prepare(
      `INSERT INTO michelin_restaurants
         (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < restaurantCount; index++) {
      insertRestaurant.run(
        padded("restaurant", index),
        `Restaurant ${index}`,
        35 + (index % 1_000) / 10_000,
        -120 - (index % 1_000) / 10_000,
        `Address ${index}`,
        `Location ${index % 50}`,
        `Cuisine ${index % 20}`,
        2025,
        index % 4 === 0 ? "1 Star" : "Selected",
        "synthetic-v1",
      );
    }

    const insertVisit = database.prepare(
      `INSERT INTO visits
         (id, restaurantId, suggestedRestaurantId, status, startTime, endTime, centerLat, centerLon,
          photoCount, foodProbable, calendarEventId, calendarEventTitle, calendarEventLocation,
          calendarEventIsAllDay, notes, updatedAt, exportedToCalendarId, awardAtVisit)
       VALUES (?, NULL, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, NULL, NULL)`,
    );
    for (let index = 0; index < configuration.visits; index++) {
      const photoCount = photoCounts[index]!;
      const slots = suggestionSlotsByVisit.get(index) ?? [];
      const firstRestaurantIndex = slots.length > 0 ? (index * 7 + slots[0]!) % restaurantCount : -1;
      const directId = slots.length > 0 && index % 5 === 0 ? padded("restaurant", firstRestaurantIndex) : null;
      const calendarTitle =
        slots.length > 0 && index % 7 === 0 ? `Reservation at Restaurant ${firstRestaurantIndex}` : null;
      const startTime = 1_800_000_000_000 - index * 60_001 + (index % 7) * 0.125;
      insertVisit.run(
        padded("visit", index),
        directId,
        startTime,
        startTime + 3_600_000,
        35 + (index % 1_000) / 10_000,
        -120 - (index % 1_000) / 10_000,
        photoCount,
        index % 6 === 0 ? 1 : 0,
        calendarTitle ? padded("calendar", index) : null,
        calendarTitle,
        startTime + 1,
      );
    }

    const insertSuggestion = database.prepare(
      "INSERT INTO visit_suggested_restaurants (visitId, restaurantId, distance) VALUES (?, ?, ?)",
    );
    for (const [visitIndex, slots] of suggestionSlotsByVisit) {
      for (const slot of slots) {
        insertSuggestion.run(
          padded("visit", visitIndex),
          padded("restaurant", (visitIndex * 7 + slot) % restaurantCount),
          10 + slot * 5 + (visitIndex % 10) / 100,
        );
      }
    }

    const insertPhoto = database.prepare(
      `INSERT INTO photos
         (id, uri, creationTime, latitude, longitude, visitId, foodDetected, foodLabels,
          foodConfidence, allLabels, mediaType, duration)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, 'photo', NULL)`,
    );
    let photoIndex = 0;
    for (let visitIndex = 0; visitIndex < configuration.visits; visitIndex++) {
      const count = photoCounts[visitIndex]!;
      const foodProbable = visitIndex % 6 === 0;
      for (let offset = 0; offset < count; offset++, photoIndex++) {
        const labeled = foodProbable && offset < 2;
        const labels = labeled
          ? JSON.stringify([
              { label: `food-${visitIndex % 31}`, confidence: 0.9 - offset * 0.1 },
              { label: `shared-${visitIndex % 5}`, confidence: 0.7 + offset * 0.05 },
            ])
          : null;
        insertPhoto.run(
          padded("photo", photoIndex),
          `ph://synthetic-${photoIndex.toString().padStart(10, "0")}-${"x".repeat(32)}`,
          1_700_000_000_000 + photoIndex,
          padded("visit", visitIndex),
          labeled ? 1 : 0,
          labels,
          labeled ? 0.9 : 0,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function parseLegacyRows(rows: readonly PendingVisitReviewQueryRow[]): PendingQuickActionVisit[] {
  return rows.map((row) => {
    let suggestions: Array<{ id: string; name: string; latitude: number; longitude: number }> = [];
    if (row.suggestedRestaurantsJson) {
      const decoded = JSON.parse(row.suggestedRestaurantsJson) as Array<{
        id: string;
        name: string;
        latitude: number;
        longitude: number;
      }>;
      suggestions = decoded.map(({ id, name, latitude, longitude }) => ({ id, name, latitude, longitude }));
    }
    return {
      id: row.id,
      photoCount: row.photoCount,
      foodProbable: row.foodProbable === 1,
      suggestedRestaurantId: row.suggestedRestaurantId,
      calendarEventTitle: row.calendarEventTitle,
      startTime: row.startTime,
      suggestedRestaurants: suggestions,
      foodLabels: literalLegacyFoodLabels(row.foodLabelsJson, row.foodProbable === 1),
    };
  });
}

/** Independent literal mirror of the former Review-card food-label parser. */
function literalLegacyFoodLabels(
  foodLabelsJson: string | null,
  foodProbable: boolean,
): PendingQuickActionVisit["foodLabels"] {
  if (!foodLabelsJson || !foodProbable) {
    return [];
  }
  try {
    const arrays = JSON.parse(foodLabelsJson) as Array<Array<{ label: string; confidence: number }>>;
    const labels = new Map<string, { label: string; maxConfidence: number; photoCount: number }>();
    for (const photoLabels of arrays) {
      if (!Array.isArray(photoLabels)) {
        continue;
      }
      for (const label of photoLabels) {
        const existing = labels.get(label.label);
        if (existing) {
          existing.maxConfidence = Math.max(existing.maxConfidence, label.confidence);
          existing.photoCount += 1;
        } else {
          labels.set(label.label, { label: label.label, maxConfidence: label.confidence, photoCount: 1 });
        }
      }
    }
    return [...labels.values()].sort((left, right) => right.maxConfidence - left.maxConfidence).slice(0, 5);
  } catch {
    return [];
  }
}

/** Independent literal mirror of the removed monolithic hook transform. */
function createLiteralLegacyQuickActionsData(
  databaseOrderedVisits: readonly PendingQuickActionVisit[],
): PendingQuickActionsData {
  const fuzzyMatches: PendingQuickActionVisit[] = [];
  const remaining: PendingQuickActionVisit[] = [];
  for (const visit of databaseOrderedVisits) {
    let hasFuzzyMatch = false;
    if (visit.calendarEventTitle && visit.suggestedRestaurants.length > 0) {
      const cleanedTitle = BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.cleanCalendarEventTitle(visit.calendarEventTitle);
      hasFuzzyMatch = Boolean(
        cleanedTitle &&
        visit.suggestedRestaurants.some((restaurant) =>
          BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.isFuzzyRestaurantMatch(cleanedTitle, restaurant.name),
        ),
      );
    }
    (hasFuzzyMatch ? fuzzyMatches : remaining).push(visit);
  }
  const visits = [...fuzzyMatches, ...remaining];
  const exactMatches: PendingQuickActionsData["exactMatches"] = [];
  for (const visit of visits) {
    if (!visit.calendarEventTitle) {
      continue;
    }
    const restaurant = visit.suggestedRestaurants.find((suggestion) =>
      BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS.compareRestaurantAndCalendarTitle(
        visit.calendarEventTitle!,
        suggestion.name,
      ),
    );
    if (restaurant) {
      exactMatches.push({
        visitId: visit.id,
        visit,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        calendarTitle: visit.calendarEventTitle,
        startTime: visit.startTime,
      });
    }
  }
  return { visits, exactMatches };
}

function canonicalData(data: PendingQuickActionsData): object {
  const thresholds = [2, 3, 5, 10, 20];
  const labels = new Map<string, string[]>();
  for (const visit of data.visits) {
    for (const label of visit.foodLabels) {
      const visitIds = labels.get(label.label) ?? [];
      visitIds.push(visit.id);
      labels.set(label.label, visitIds);
    }
  }
  return {
    visits: data.visits.map((visit) => ({
      id: visit.id,
      photoCount: visit.photoCount,
      foodProbable: visit.foodProbable,
      suggestedRestaurantId: visit.suggestedRestaurantId,
      calendarEventTitle: visit.calendarEventTitle,
      startTime: visit.startTime,
      suggestedRestaurants: visit.suggestedRestaurants,
      foodLabels: visit.foodLabels,
    })),
    exactMatches: data.exactMatches.map(({ visit: _visit, ...match }) => match),
    actionIds: {
      thresholds: Object.fromEntries(
        thresholds.map((threshold) => [
          threshold,
          data.visits.filter((visit) => visit.photoCount < threshold).map((visit) => visit.id),
        ]),
      ),
      nonFood: data.visits.filter((visit) => !visit.foodProbable).map((visit) => visit.id),
      unmatched: data.visits
        .filter((visit) => !visit.suggestedRestaurantId && visit.suggestedRestaurants.length === 0)
        .map((visit) => visit.id),
      labels: [...labels.entries()],
    },
  };
}

function execute(database: DatabaseSync, strategy: Strategy): { data: PendingQuickActionsData; rawRows: unknown[] } {
  if (strategy === "legacy-card-hydration") {
    const rawRows = database.prepare(PENDING_VISITS_FOR_REVIEW_SQL).all() as unknown as PendingVisitReviewQueryRow[];
    return {
      data: createLiteralLegacyQuickActionsData(parseLegacyRows(rawRows)),
      rawRows,
    };
  }
  const rawRows = database.prepare(PENDING_QUICK_ACTIONS_SQL).all() as unknown as PendingQuickActionQueryRow[];
  return {
    data: createPendingQuickActionsData(parsePendingQuickActionRows(rawRows), BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS),
    rawRows,
  };
}

function measure(database: DatabaseSync, strategy: Strategy): Measurement {
  const startedAt = performance.now();
  const result = execute(database, strategy);
  const milliseconds = performance.now() - startedAt;
  const canonical = JSON.stringify(canonicalData(result.data));
  return {
    milliseconds,
    resultDigest: sha256(canonical),
    visits: result.data.visits.length,
    exactMatches: result.data.exactMatches.length,
  };
}

function summarize(samples: readonly number[]): object {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const medianIndex = Math.floor(sorted.length / 2);
  return {
    samplesMilliseconds: samples,
    minimumMilliseconds: sorted[0],
    medianMilliseconds:
      sorted.length % 2 === 0 ? (sorted[medianIndex - 1]! + sorted[medianIndex]!) / 2 : sorted[medianIndex],
    p95Milliseconds: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maximumMilliseconds: sorted.at(-1),
  };
}

const configuration = parseConfiguration(process.argv.slice(2));
if (!configuration) {
  console.log(usage());
  process.exit(0);
}

const sourceBefore = configuration.databasePath ? snapshotDatabaseFiles(configuration.databasePath) : null;
if (configuration.databasePath) {
  assert.equal(sourceBefore?.main.exists, true, "source database must exist");
  assert.ok(
    !sourceBefore?.["-wal"].exists || sourceBefore["-wal"].size === 0,
    "immutable source WAL must be absent or empty",
  );
  assertOutputDoesNotAliasSource(configuration.databasePath, configuration.outputPath);
}
const database = configuration.databasePath
  ? new DatabaseSync(immutableDatabaseUri(configuration.databasePath), { readOnly: true })
  : new DatabaseSync(":memory:");

let report: object;
try {
  if (configuration.databasePath) {
    database.exec("PRAGMA query_only = ON; BEGIN");
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    assert.equal(integrity?.integrity_check, "ok");
  } else {
    createSchema(database);
    seedSyntheticDatabase(database, configuration);
  }
  const calendarTitleMatchingSource = assertCalendarTitleMatchingSourceContract();
  const quickActionsCoreSource = readFileSync(new URL("../utils/db/quick-actions-core.ts", import.meta.url));
  const visitReviewRuntimeSource = readFileSync(new URL("../utils/db/visit-review.ts", import.meta.url));
  const legacyBefore = execute(database, "legacy-card-hydration");
  const slimBefore = execute(database, "quick-actions-slim-rows");
  const canonicalLegacy = canonicalData(legacyBefore.data);
  const canonicalSlim = canonicalData(slimBefore.data);
  assert.deepEqual(canonicalSlim, canonicalLegacy, "slim Quick Actions data must match the legacy card oracle");
  const resultDigest = sha256(JSON.stringify(canonicalLegacy));

  for (let warmup = 0; warmup < configuration.warmupIterations; warmup++) {
    const order: Strategy[] =
      warmup % 2 === 0
        ? ["legacy-card-hydration", "quick-actions-slim-rows"]
        : ["quick-actions-slim-rows", "legacy-card-hydration"];
    for (const strategy of order) {
      const sample = measure(database, strategy);
      assert.equal(sample.resultDigest, resultDigest);
    }
  }

  const timings: Record<Strategy, number[]> = {
    "legacy-card-hydration": [],
    "quick-actions-slim-rows": [],
  };
  let pairedSlimWins = 0;
  for (let sampleIndex = 0; sampleIndex < configuration.samples; sampleIndex++) {
    const order: Strategy[] =
      sampleIndex % 2 === 0
        ? ["legacy-card-hydration", "quick-actions-slim-rows"]
        : ["quick-actions-slim-rows", "legacy-card-hydration"];
    const pair = new Map<Strategy, number>();
    for (const strategy of order) {
      const sample = measure(database, strategy);
      assert.equal(sample.resultDigest, resultDigest);
      timings[strategy].push(sample.milliseconds);
      pair.set(strategy, sample.milliseconds);
    }
    if (pair.get("quick-actions-slim-rows")! < pair.get("legacy-card-hydration")!) {
      pairedSlimWins++;
    }
  }

  const legacyAfter = execute(database, "legacy-card-hydration");
  const slimAfter = execute(database, "quick-actions-slim-rows");
  assert.deepEqual(canonicalData(slimAfter.data), canonicalData(legacyAfter.data));
  assert.equal(sha256(JSON.stringify(canonicalData(legacyAfter.data))), resultDigest);
  const legacyMedian = (summarize(timings["legacy-card-hydration"]) as { medianMilliseconds: number })
    .medianMilliseconds;
  const slimMedian = (summarize(timings["quick-actions-slim-rows"]) as { medianMilliseconds: number })
    .medianMilliseconds;
  const actionCounts = {
    totalPending: legacyAfter.data.visits.length,
    exactMatches: legacyAfter.data.exactMatches.length,
    nonFood: legacyAfter.data.visits.filter((visit) => !visit.foodProbable).length,
    unmatched: legacyAfter.data.visits.filter(
      (visit) => !visit.suggestedRestaurantId && visit.suggestedRestaurants.length === 0,
    ).length,
    thresholds: Object.fromEntries(
      [2, 3, 5, 10, 20].map((threshold) => [
        threshold,
        legacyAfter.data.visits.filter((visit) => visit.photoCount < threshold).length,
      ]),
    ),
  };
  report = {
    benchmark: "quick-actions-lightweight-query",
    schemaVersion: 1,
    mode: configuration.databasePath ? "immutable-real" : "deterministic-synthetic",
    configuration: {
      visits: configuration.databasePath ? undefined : configuration.visits,
      photos: configuration.databasePath ? undefined : configuration.photos,
      suggestionEdges: configuration.databasePath ? undefined : configuration.suggestionEdges,
      warmupIterations: configuration.warmupIterations,
      samples: configuration.samples,
    },
    source: configuration.databasePath
      ? {
          fileName: basename(configuration.databasePath),
          files: sourceBefore,
        }
      : { seed: "closed-form-v1" },
    productionContract: {
      quickActionsSqlSha256: sha256(PENDING_QUICK_ACTIONS_SQL),
      legacySqlSha256: sha256(PENDING_VISITS_FOR_REVIEW_SQL),
      quickActionsCoreSourceSha256: sha256(quickActionsCoreSource),
      visitReviewRuntimeSourceSha256: sha256(visitReviewRuntimeSource),
      legacyTransformOracle: "independent literal benchmark implementation",
      calendarTitleMatchingSource,
    },
    correctness: {
      exactCanonicalParityBeforeAndAfterTiming: true,
      exactFloat64StartTimeTransport: "direct SQLite scalar",
      resultDigest,
      actionCounts,
    },
    payload: {
      legacyRows: legacyAfter.rawRows.length,
      slimRows: slimAfter.rawRows.length,
      legacyJsonEquivalentBytes: Buffer.byteLength(JSON.stringify(legacyAfter.rawRows)),
      slimJsonEquivalentBytes: Buffer.byteLength(JSON.stringify(slimAfter.rawRows)),
      bytesSaved:
        Buffer.byteLength(JSON.stringify(legacyAfter.rawRows)) - Buffer.byteLength(JSON.stringify(slimAfter.rawRows)),
      reductionPercent:
        (1 -
          Buffer.byteLength(JSON.stringify(slimAfter.rawRows)) /
            Buffer.byteLength(JSON.stringify(legacyAfter.rawRows))) *
        100,
    },
    timings: {
      legacyCardHydration: summarize(timings["legacy-card-hydration"]),
      quickActionsSlimRows: summarize(timings["quick-actions-slim-rows"]),
      medianSpeedup: legacyMedian / slimMedian,
      medianMillisecondsSaved: legacyMedian - slimMedian,
      pairedSlimWins,
      pairs: configuration.samples,
    },
    scope:
      "Node/V8 node:sqlite query, row conversion, JSON parsing, food-label reduction, and Calendar title matching; excludes Expo SQLite scheduling, React Native bridge conversion, Hermes, and rendering.",
    privacy: {
      aggregateOnlyReport: true,
      rawVisitIdsRetained: false,
      rawCalendarTitlesRetained: false,
      rawPhotoUrisRetained: false,
    },
  };

  if (configuration.databasePath) {
    database.exec("ROLLBACK");
  }
} finally {
  database.close();
}

if (configuration.databasePath) {
  const sourceAfter = snapshotDatabaseFiles(configuration.databasePath);
  assert.deepEqual(sourceAfter, sourceBefore, "source database and sidecars must remain byte-exact");
  (report as { source: { filesUnchanged?: boolean } }).source.filesUnchanged = true;
}

writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
console.error(`Saved Quick Actions query profile to ${configuration.outputPath}`);

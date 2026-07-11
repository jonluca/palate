#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

type BenchmarkFilter = "all" | "pending" | "confirmed" | "rejected" | "food";
type Component = "main" | "wal" | "shm" | "journal";

interface FileComponentSnapshot {
  readonly component: Component;
  readonly present: boolean;
  readonly modeOctal: string | null;
  readonly sizeBytes: string | null;
  readonly device: string | null;
  readonly inode: string | null;
  readonly sha256: string | null;
}

interface SourceSnapshot {
  readonly components: FileComponentSnapshot[];
}

interface ProfilerResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILER = join(ROOT, "scripts/benchmark-visit-list-paging.ts");
const FILTERS: readonly BenchmarkFilter[] = ["all", "pending", "confirmed", "rejected", "food"];
const SIDECARS = [
  { component: "wal", suffix: "-wal" },
  { component: "shm", suffix: "-shm" },
  { component: "journal", suffix: "-journal" },
] as const;
const PRIVATE_SENTINELS = [
  "PRIVATE_VISIT_ID_SENTINEL",
  "PRIVATE_RESTAURANT_NAME_SENTINEL",
  "PRIVATE_GUIDE_NAME_SENTINEL",
  "ph://PRIVATE_PHOTO_URI_SENTINEL",
] as const;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function snapshotSource(databasePath: string): SourceSnapshot {
  const snapshot = (component: Component, path: string): FileComponentSnapshot => {
    const identity = lstatIfPresent(path);
    if (!identity) {
      return {
        component,
        present: false,
        modeOctal: null,
        sizeBytes: null,
        device: null,
        inode: null,
        sha256: null,
      };
    }
    assert(identity.isFile() && !identity.isSymbolicLink(), `${component} fixture component must be regular`);
    const bigintIdentity = lstatSync(path, { bigint: true });
    return {
      component,
      present: true,
      modeOctal: (bigintIdentity.mode & 0o7777n).toString(8),
      sizeBytes: bigintIdentity.size.toString(),
      device: bigintIdentity.dev.toString(),
      inode: bigintIdentity.ino.toString(),
      sha256: sha256File(path),
    };
  };
  return {
    components: [
      snapshot("main", databasePath),
      ...SIDECARS.map(({ component, suffix }) => snapshot(component, `${databasePath}${suffix}`)),
    ],
  };
}

function createFixture(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE michelin_restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, award TEXT);
    CREATE TABLE visits (
      id TEXT PRIMARY KEY,
      restaurantId TEXT,
      suggestedRestaurantId TEXT,
      status TEXT NOT NULL,
      startTime REAL NOT NULL,
      endTime INTEGER NOT NULL,
      centerLat REAL NOT NULL,
      centerLon REAL NOT NULL,
      photoCount INTEGER NOT NULL,
      foodProbable INTEGER NOT NULL,
      calendarEventId TEXT,
      calendarEventTitle TEXT,
      calendarEventLocation TEXT,
      calendarEventIsAllDay INTEGER,
      notes TEXT,
      updatedAt INTEGER,
      exportedToCalendarId TEXT,
      awardAtVisit TEXT
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
  const insertRestaurant = database.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)");
  const insertGuide = database.prepare("INSERT INTO michelin_restaurants (id, name, award) VALUES (?, ?, ?)");
  const insertVisit = database.prepare(`
    INSERT INTO visits (
      id, restaurantId, suggestedRestaurantId, status, startTime, endTime,
      centerLat, centerLon, photoCount, foodProbable, calendarEventId,
      calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
      notes, updatedAt, exportedToCalendarId, awardAtVisit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPhoto = database.prepare(
    "INSERT INTO photos (id, uri, creationTime, visitId, foodDetected) VALUES (?, ?, ?, ?, ?)",
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 24; index++) {
      insertRestaurant.run(
        `restaurant-${index.toString().padStart(2, "0")}`,
        index === 0 ? PRIVATE_SENTINELS[1] : `Fixture Restaurant ${index}`,
      );
      insertGuide.run(
        `guide-${index.toString().padStart(2, "0")}`,
        index === 0 ? PRIVATE_SENTINELS[2] : `Fixture Guide ${index}`,
        index % 3 === 0 ? "Selected" : null,
      );
    }
    const statuses = ["pending", "confirmed", "rejected"] as const;
    for (let index = 0; index < 384; index++) {
      const id = index === 0 ? PRIVATE_SENTINELS[0] : `visit-${index.toString().padStart(5, "0")}`;
      const startTime = 1_800_000_000_000.25 - Math.floor(index / 4) * 60_000;
      const photoCount = index % 5;
      insertVisit.run(
        id,
        `restaurant-${(index % 24).toString().padStart(2, "0")}`,
        `guide-${(index % 24).toString().padStart(2, "0")}`,
        statuses[index % statuses.length],
        startTime,
        Math.trunc(startTime + 3_600_000),
        37.7,
        -122.4,
        photoCount,
        index % 4 === 0 ? 1 : 0,
        index % 5 === 0 ? `event-${index}` : null,
        index % 5 === 0 ? `Private calendar title ${index}` : null,
        null,
        index % 10 === 0 ? 1 : 0,
        null,
        Math.trunc(startTime),
        null,
        null,
      );
      for (let photoIndex = 0; photoIndex < photoCount; photoIndex++) {
        const photoId = `photo-${index.toString().padStart(5, "0")}-${photoIndex}`;
        insertPhoto.run(
          photoId,
          index === 0 && photoIndex === 0 ? PRIVATE_SENTINELS[3] : `ph://fixture-${photoId}`,
          Math.trunc(startTime) + photoIndex,
          id,
          photoIndex === 0 && index % 4 === 0 ? 1 : photoIndex % 2,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }

  for (const { suffix } of SIDECARS) {
    writeFileSync(`${databasePath}${suffix}`, Buffer.alloc(0), { mode: 0o600 });
  }
}

function invokeProfiler(databasePath: string, outputPath: string, filter: BenchmarkFilter = "all"): ProfilerResult {
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-sqlite",
      "--experimental-strip-types",
      PROFILER,
      `--database=${databasePath}`,
      `--filter=${filter}`,
      "--page-size=8",
      "--samples=1",
      "--warmup=0",
      `--output=${outputPath}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertRejected(databasePath: string, outputPath: string, expectedMessage: RegExp, label: string): void {
  const sourceBefore = snapshotSource(databasePath);
  const result = invokeProfiler(databasePath, outputPath);
  assert.notEqual(result.status, 0, `${label} must be rejected`);
  assert.match(result.stderr, expectedMessage, `${label} rejection reason`);
  assert.deepEqual(snapshotSource(databasePath), sourceBefore, `${label} must preserve every protected component`);
}

function assertAggregateOnlyReport(
  report: Record<string, unknown>,
  reportText: string,
  filter: BenchmarkFilter,
  databasePath: string,
  outputPath: string,
  sourceBefore: SourceSnapshot,
): void {
  assert.deepEqual(Object.keys(report).sort(), [
    "benchmarkScope",
    "configuration",
    "consistencyModel",
    "correctness",
    "dataset",
    "measurementOrder",
    "privacy",
    "queryPlanValidation",
    "queryPlans",
    "runtime",
    "schemaVersion",
    "sourceAttestation",
    "status",
    "strategyContracts",
    "timings",
    "transferAndTimingComparison",
  ]);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.status, "ok");
  const configuration = report.configuration as Record<string, unknown>;
  assert.equal(configuration.mode, "immutable-real");
  assert.equal(configuration.filter, filter);
  const correctness = report.correctness as Record<string, unknown>;
  assert.equal(correctness.exactFirstPagePrefixParityBeforeTiming, true);
  assert.equal(correctness.exactFullTraversalParityBeforeTiming, true);
  assert.equal(correctness.exactFirstPagePrefixParityAfterTiming, true);
  assert.equal(correctness.exactFullTraversalParityAfterTiming, true);
  const privacy = report.privacy as Record<string, unknown>;
  assert.deepEqual(privacy, {
    aggregateOnly: true,
    rawRowsRetainedInReport: false,
    visitIdentifiersRetainedInReport: false,
    restaurantIdentifiersOrNamesRetainedInReport: false,
    photoUrisRetainedInReport: false,
    sourceOrOutputPathsRetainedInReport: false,
    photosLibraryAccessed: false,
    calendarLibraryAccessed: false,
  });
  const sourceAttestation = report.sourceAttestation as Record<string, unknown>;
  assert.deepEqual(sourceAttestation.before, sourceBefore);
  assert.equal(sourceAttestation.afterMatchesBefore, true);
  assert.match(String(sourceAttestation.outputPublication), /O_NOFOLLOW/);

  for (const forbidden of [...PRIVATE_SENTINELS, databasePath, outputPath, dirname(databasePath)]) {
    assert(!reportText.includes(forbidden), `aggregate report must not retain ${JSON.stringify(forbidden)}`);
  }
  assert(!/"(?:databasePath|outputPath|mainBasename)"\s*:/.test(reportText), "report must not expose paths");
}

function assertSuccessfulFilters(databasePath: string, directory: string): void {
  for (const filter of FILTERS) {
    const outputPath = join(directory, `report-${filter}.json`);
    const sourceBefore = snapshotSource(databasePath);
    const result = invokeProfiler(databasePath, outputPath, filter);
    assert.equal(result.status, 0, `${filter} profiler failed: ${result.stderr}`);
    assert.deepEqual(snapshotSource(databasePath), sourceBefore, `${filter} profile must preserve the source`);
    assert.equal(lstatSync(outputPath).mode & 0o777, 0o600, `${filter} report must be mode 0600`);
    const reportText = readFileSync(outputPath, "utf8");
    const report = JSON.parse(reportText) as Record<string, unknown>;
    assertAggregateOnlyReport(report, reportText, filter, databasePath, outputPath, sourceBefore);
    const planValidation = report.queryPlanValidation as Record<string, unknown>;
    assert.equal(
      planValidation.expectedVisitIndex,
      filter === "all" ? "idx_visits_time" : filter === "food" ? "idx_visits_food_time" : "idx_visits_status_time",
    );
    assert.equal(planValidation.existingPrefixIndexUsedByEveryPlan, true);
    assert.equal(planValidation.fullOrderSortRejected, true);
  }
}

function withAlias(path: string, create: () => void, operation: () => void): void {
  create();
  try {
    operation();
  } finally {
    unlinkSync(path);
  }
}

function assertOutputAliasGuards(databasePath: string, directory: string): void {
  assertRejected(databasePath, databasePath, /must not alias/, "direct main output alias");

  const mainSymlink = join(directory, "main-symlink-output");
  withAlias(
    mainSymlink,
    () => symlinkSync(databasePath, mainSymlink),
    () => {
      assertRejected(databasePath, mainSymlink, /must not be a symbolic link/, "main symlink output alias");
    },
  );

  const mainHardlink = join(directory, "main-hardlink-output");
  withAlias(
    mainHardlink,
    () => linkSync(databasePath, mainHardlink),
    () => {
      assertRejected(databasePath, mainHardlink, /hard link/, "main hardlink output alias");
    },
  );

  for (const { component, suffix } of SIDECARS) {
    const sidecar = `${databasePath}${suffix}`;
    assertRejected(databasePath, sidecar, /must not alias/, `direct ${component} output alias`);

    const sidecarSymlink = join(directory, `${component}-symlink-output`);
    withAlias(
      sidecarSymlink,
      () => symlinkSync(sidecar, sidecarSymlink),
      () => {
        assertRejected(
          databasePath,
          sidecarSymlink,
          /must not be a symbolic link/,
          `${component} symlink output alias`,
        );
      },
    );

    const sidecarHardlink = join(directory, `${component}-hardlink-output`);
    withAlias(
      sidecarHardlink,
      () => linkSync(sidecar, sidecarHardlink),
      () => {
        assertRejected(databasePath, sidecarHardlink, /hard link/, `${component} hardlink output alias`);
      },
    );
  }

  const journal = `${databasePath}-journal`;
  unlinkSync(journal);
  const danglingOutput = join(directory, "dangling-sidecar-output");
  withAlias(
    danglingOutput,
    () => symlinkSync(journal, danglingOutput),
    () => {
      assertRejected(databasePath, danglingOutput, /must not be a symbolic link/, "dangling sidecar output alias");
      assert.equal(lstatIfPresent(journal), null, "dangling target must stay absent");
    },
  );
  writeFileSync(journal, Buffer.alloc(0), { mode: 0o600 });
}

function assertUnsafeSidecarsRejected(databasePath: string, directory: string): void {
  for (const suffix of ["-wal", "-journal"] as const) {
    const sidecar = `${databasePath}${suffix}`;
    writeFileSync(sidecar, "nonempty-sidecar-sentinel", { mode: 0o600 });
    try {
      const outputPath = join(directory, `unsafe-${suffix.slice(1)}.json`);
      assertRejected(databasePath, outputPath, /requires an empty or absent/, `nonempty ${suffix.slice(1)}`);
      assert.equal(lstatIfPresent(outputPath), null, "rejected sidecar profile must not publish output");
    } finally {
      writeFileSync(sidecar, Buffer.alloc(0), { mode: 0o600 });
    }
  }
}

function assertSourceSymlinkRejected(databasePath: string, directory: string): void {
  const sourceLink = join(directory, "source-link.db");
  symlinkSync(databasePath, sourceLink);
  try {
    const result = invokeProfiler(sourceLink, join(directory, "source-link-report.json"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Database source must not be a symbolic link/);
  } finally {
    unlinkSync(sourceLink);
  }
}

function main(): void {
  const directory = mkdtempSync(join(tmpdir(), "palate-visit-list-profiler-contract-"));
  const databasePath = join(directory, "fixture.db");
  try {
    createFixture(databasePath);
    chmodSync(databasePath, 0o600);
    assertSuccessfulFilters(databasePath, directory);
    assertOutputAliasGuards(databasePath, directory);
    assertUnsafeSidecarsRejected(databasePath, directory);
    assertSourceSymlinkRejected(databasePath, directory);
    console.log(
      "Visit-list profiler contract passed: all filters, exact immutable identity, aggregate-only 0600 reports, and source/output alias guards.",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main();

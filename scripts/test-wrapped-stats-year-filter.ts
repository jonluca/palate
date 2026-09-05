#!/usr/bin/env node
/// <reference types="node" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWrappedStatsYearFilter } from "../utils/db/wrapped-stats-year-filter-core.ts";
import type { MichelinStatsBucket } from "../utils/db/types.ts";
import {
  createWrappedStatsYearFilterDatabase,
  createWrappedStatsYearFilterHarness,
  seedWrappedStatsYearFilterBenchmark,
} from "./wrapped-stats-year-filter-harness.ts";

const timeZones = [
  "UTC",
  "America/Los_Angeles",
  "Pacific/Kiritimati",
  "America/St_Johns",
  "Australia/Lord_Howe",
  "Asia/Kathmandu",
];
const selectedYears = [1969, 1970, 2006, 2024, 2025, 2026];

async function testCurrentTimeZone(): Promise<void> {
  const database = createWrappedStatsYearFilterDatabase();
  try {
    const indexed = createWrappedStatsYearFilterHarness(database, "indexed");
    const legacy = createWrappedStatsYearFilterHarness(database, "legacy");
    for (const year of [undefined, null, 0, ...selectedYears]) {
      assert.deepEqual(
        JSON.stringify(await indexed.getWrappedStats(year)),
        JSON.stringify(await legacy.getWrappedStats(year)),
      );
    }
    seedWrappedStatsYearFilterBenchmark(database, 2400);
    const insert = database.prepare("INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?)");
    let count = 0;
    for (const year of selectedYears) {
      for (const localBoundary of [new Date(year, 0, 1).getTime(), new Date(year + 1, 0, 1).getTime()]) {
        for (const delta of [
          -172800001, -86400000, -1001, -1000, -1, -0.75, -0.125, 0, 0.125, 1, 1000, 86400000, 172800001,
        ]) {
          insert.run(`edge-${count++}`, "r-1", "confirmed", localBoundary + delta, 10, "1 Star");
        }
      }
    }
    // The original date predicate can classify fractional milliseconds just
    // before midnight into the next year. A bare exact range would lose them.
    const midnight = new Date(2025, 0, 1).getTime();
    const rounded = database
      .prepare("SELECT strftime('%Y', datetime(?/1000, 'unixepoch', 'localtime')) AS year")
      .get(midnight - 0.125);
    assert.equal(rounded?.year, "2025");

    for (const year of [undefined, null, 0, ...selectedYears, 999, 9999, 10000, 2025.5, Infinity, NaN]) {
      const filter = buildWrappedStatsYearFilter(year);
      const rows = database
        .prepare(`SELECT id FROM visits WHERE status = 'confirmed' ${filter.sql} ORDER BY id`)
        .all(...filter.parameters);
      const legacySql = year ? "AND strftime('%Y', datetime(startTime/1000, 'unixepoch', 'localtime')) = ?" : "";
      const legacyRows = database
        .prepare(`SELECT id FROM visits WHERE status = 'confirmed' ${legacySql} ORDER BY id`)
        .all(...(year ? [String(year)] : []));
      assert.deepEqual(rows, legacyRows, `year selection ${String(year)} (${process.env.TZ})`);
    }
    for (const year of [undefined, null, 0, ...selectedYears]) {
      assert.equal(
        JSON.stringify(await indexed.getWrappedStats(year)),
        JSON.stringify(await legacy.getWrappedStats(year)),
        `all production stats match for year ${String(year)} (${process.env.TZ})`,
      );
      for (const bucket of [
        "three-stars",
        "two-stars",
        "one-star",
        "bib-gourmand",
        "selected",
      ] satisfies MichelinStatsBucket[]) {
        assert.equal(
          JSON.stringify(await indexed.getMichelinRestaurantsForStatsBucket(year, bucket)),
          JSON.stringify(await legacy.getMichelinRestaurantsForStatsBucket(year, bucket)),
        );
      }
    }
    indexed.queries.length = 0;
    await indexed.getWrappedStats(2025);
    assert.equal(indexed.queries.length, 19);
    for (const query of indexed.queries) {
      assert.equal(query.parameters.length, 3, "each selected-year query receives the indexed range and local year");
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.parameters);
      assert.match(
        plan.map((row) => row.detail).join("\n"),
        /idx_visits_status_time \(status=\? AND startTime>\? AND startTime<\?\)/,
      );
    }
    indexed.queries.length = 0;
    await indexed.getWrappedStats();
    assert.equal(indexed.queries.length, 20);
    assert.ok(
      indexed.queries.every((query) => query.parameters.length === 0),
      "all-time queries retain their original plans",
    );
  } finally {
    database.close();
  }
}

if (process.argv.includes("--timezone-child")) {
  await testCurrentTimeZone();
} else {
  for (const timeZone of timeZones) {
    const child = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "--experimental-sqlite",
        fileURLToPath(import.meta.url),
        "--timezone-child",
      ],
      { encoding: "utf8", env: { ...process.env, TZ: timeZone } },
    );
    assert.equal(child.status, 0, `${timeZone}\n${child.stdout}\n${child.stderr}`);
  }
  console.log(
    JSON.stringify({
      suite: "wrapped-stats-year-filter",
      timeZones,
      selectedYears,
      productionStatsAndBucketsParity: true,
      emptyDatabaseParity: true,
      localYearAndFractionalTimestampParity: true,
      indexedQueries: 19,
      allTimeQueriesUnchanged: 20,
    }),
  );
}

import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as michelin from "../utils/db/wrapped-stats-michelin-core.ts";
import * as yearly from "../utils/db/wrapped-stats-yearly-core.ts";
import * as streak from "../utils/db/wrapped-stats-streak-core.ts";
import * as yearFilter from "../utils/db/wrapped-stats-year-filter-core.ts";
import type { MichelinStatsBucket, MichelinStatsRestaurantSummary, WrappedStats } from "../utils/db/types.ts";

export type YearFilterStrategy = "legacy" | "indexed";

interface StatsModule {
  getWrappedStats(year?: number | null): Promise<WrappedStats>;
  getMichelinRestaurantsForStatsBucket(
    year: number | null | undefined,
    bucket: MichelinStatsBucket,
  ): Promise<MichelinStatsRestaurantSummary[]>;
}

const compiledStats = ts.transpileModule(readFileSync(new URL("../utils/db/stats.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** Execute the production functions, changing only the year-range prefilter for the oracle. */
export function createWrappedStatsYearFilterHarness(database: DatabaseSync, strategy: YearFilterStrategy) {
  const queries: Array<{ sql: string; parameters: readonly SQLInputValue[] }> = [];
  const query = (sql: string, parameters: readonly SQLInputValue[] = []) => {
    const withoutRange = sql.replace(/AND (?:v\.)?startTime >= \? AND (?:v\.)?startTime < \? /, "");
    const effectiveSql = strategy === "legacy" ? withoutRange : sql;
    const effectiveParameters = strategy === "legacy" && sql !== withoutRange ? parameters.slice(2) : parameters;
    queries.push({ sql: effectiveSql, parameters: effectiveParameters });
    return { statement: database.prepare(effectiveSql), parameters: effectiveParameters };
  };
  const adapter = {
    async getAllAsync(sql: string, parameters?: readonly SQLInputValue[]) {
      const prepared = query(sql, parameters);
      return prepared.statement.all(...prepared.parameters);
    },
    async getFirstAsync(sql: string, parameters?: readonly SQLInputValue[]) {
      const prepared = query(sql, parameters);
      return prepared.statement.get(...prepared.parameters) ?? null;
    },
  };
  const modules = new Map<string, object>([
    ["./core", { DEBUG_TIMING: false, getDatabase: async () => adapter }],
    ["./wrapped-stats-michelin-core", michelin],
    ["./wrapped-stats-yearly-core", yearly],
    ["./wrapped-stats-streak-core", streak],
    ["./wrapped-stats-year-filter-core", yearFilter],
  ]);
  const exports: Partial<StatsModule> = {};
  runInNewContext(compiledStats, {
    exports,
    Date,
    console,
    require: (name: string) => {
      const module = modules.get(name);
      if (!module) {
        throw new Error(`Unrecognized production stats import: ${name}`);
      }
      return module;
    },
  });
  const { getWrappedStats, getMichelinRestaurantsForStatsBucket } = exports;
  if (!getWrappedStats || !getMichelinRestaurantsForStatsBucket) {
    throw new Error("Production stats exports missing");
  }
  return { getWrappedStats, getMichelinRestaurantsForStatsBucket, queries };
}

export function createWrappedStatsYearFilterDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE visits (
      id TEXT PRIMARY KEY, restaurantId TEXT, status TEXT NOT NULL,
      startTime INTEGER NOT NULL, photoCount INTEGER NOT NULL DEFAULT 0,
      awardAtVisit TEXT
    );
    CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL, longitude REAL);
    CREATE TABLE michelin_restaurants (id TEXT PRIMARY KEY, name TEXT, location TEXT, cuisine TEXT, award TEXT);
    CREATE INDEX idx_visits_status ON visits(status);
    CREATE INDEX idx_visits_status_time ON visits(status, startTime DESC);
    CREATE INDEX idx_visits_restaurant_status_time ON visits(restaurantId, status, startTime DESC);
  `);
  return database;
}

export function seedWrappedStatsYearFilterBenchmark(database: DatabaseSync, visits: number): void {
  const insertRestaurant = database.prepare("INSERT INTO restaurants VALUES (?, ?, ?, ?)");
  const insertMichelin = database.prepare("INSERT INTO michelin_restaurants VALUES (?, ?, ?, ?, ?)");
  const insertVisit = database.prepare("INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?)");
  database.exec("BEGIN");
  for (let index = 0; index < 500; index++) {
    insertRestaurant.run(`r-${index}`, `Restaurant ${index}`, 10 + index / 1000, 20 + index / 1000);
    insertMichelin.run(
      `r-${index}`,
      `Restaurant ${index}`,
      `City ${index % 20}, Country ${index % 8}`,
      `Cuisine ${index % 12}`,
      `${(index % 3) + 1} Stars`,
    );
  }
  for (let index = 0; index < visits; index++) {
    insertVisit.run(
      `v-${index}`,
      index % 47 === 0 ? null : `r-${index % 500}`,
      index % 7 === 0 ? "pending" : "confirmed",
      Date.UTC(2006 + (index % 20), Math.floor(index / 20) % 12, 1 + (Math.floor(index / 240) % 28), index % 24),
      index % 19,
      index % 11 === 0 ? "Bib Gourmand" : null,
    );
  }
  database.exec("COMMIT");
}

#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { APPLICATION_DATABASE_TABLES, dropApplicationDatabaseTables } from "../utils/db/reset-core.ts";

const coreSource = readFileSync(new URL("../utils/db/core.ts", import.meta.url), "utf8");
const initializedCoreTables = Array.from(
  coreSource.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g),
  (match) => match[1]!,
).sort();
const resetCoreTables = APPLICATION_DATABASE_TABLES.filter(
  (table) => table !== "michelin_restaurant_spatial_index",
).sort();

assert.deepEqual(
  resetCoreTables,
  initializedCoreTables,
  "reset must include every table initialized by the core database schema",
);
assert.ok(
  APPLICATION_DATABASE_TABLES.includes("michelin_restaurant_spatial_index"),
  "reset must include the separately initialized Michelin spatial table",
);

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON;");
for (const table of APPLICATION_DATABASE_TABLES) {
  database.exec(`CREATE TABLE "${table}" (value TEXT); INSERT INTO "${table}" VALUES ('stale');`);
}

await dropApplicationDatabaseTables({
  execAsync: async (source) => database.exec(source),
});

const remainingTables = database
  .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all();
assert.deepEqual(remainingTables, [], "reset must remove all app-owned tables");
assert.equal(
  (database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
  1,
  "reset must restore foreign-key enforcement",
);

const calls: string[] = [];
await assert.rejects(
  dropApplicationDatabaseTables({
    execAsync: async (source) => {
      calls.push(source);
      if (source.includes("DROP TABLE")) {
        throw new Error("synthetic drop failure");
      }
    },
  }),
  /synthetic drop failure/,
);
assert.equal(calls.at(-1), "PRAGMA foreign_keys = ON;", "failed reset must still restore foreign-key enforcement");

database.close();
console.log("Database reset tests passed.");

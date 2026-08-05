#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { APPLICATION_DATABASE_TABLES, dropApplicationDatabaseTables } from "../utils/db/reset-core.ts";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolveDeferred!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

class FakeLifecycleDatabase {
  initializationCount = 0;
  dropCount = 0;
  closeCount = 0;
  nextInitializationFailure: Error | null = null;
  nextInitializationBlock: { readonly started: Deferred<void>; readonly release: Deferred<void> } | null = null;
  nextDropBlock: { readonly started: Deferred<void>; readonly release: Deferred<void> } | null = null;

  async execAsync(source: string): Promise<void> {
    if (source.includes("DROP TABLE IF EXISTS")) {
      this.dropCount += 1;
      const block = this.nextDropBlock;
      this.nextDropBlock = null;
      if (block) {
        block.started.resolve();
        await block.release.promise;
      }
    }

    if (source.includes("PRAGMA journal_mode = WAL;")) {
      this.initializationCount += 1;
      const block = this.nextInitializationBlock;
      this.nextInitializationBlock = null;
      if (block) {
        block.started.resolve();
        await block.release.promise;
      }

      const failure = this.nextInitializationFailure;
      this.nextInitializationFailure = null;
      if (failure) {
        throw failure;
      }
    }
  }

  async getAllAsync<Value>(): Promise<Value[]> {
    return [];
  }

  async runAsync(): Promise<{ changes: number }> {
    return { changes: 0 };
  }

  async closeAsync(): Promise<void> {
    this.closeCount += 1;
  }
}

interface DatabaseLifecycleHarness {
  readonly databasesToOpen: FakeLifecycleDatabase[];
  openCount: number;
  restaurantIndexInvalidationCount: number;
  providerIndexInvalidationCount: number;
  openDatabaseAsync(): Promise<FakeLifecycleDatabase>;
}

async function assertDatabaseResetLifecycle(): Promise<void> {
  const firstDatabase = new FakeLifecycleDatabase();
  const recoveredDatabase = new FakeLifecycleDatabase();
  const harness: DatabaseLifecycleHarness = {
    databasesToOpen: [firstDatabase, recoveredDatabase],
    openCount: 0,
    restaurantIndexInvalidationCount: 0,
    providerIndexInvalidationCount: 0,
    async openDatabaseAsync() {
      this.openCount += 1;
      const database = this.databasesToOpen.shift();
      assert.ok(database, "test database open queue must not be exhausted");
      return database;
    },
  };

  const lifecycleGlobal = globalThis as typeof globalThis & {
    __DEV__: boolean;
    __palateDatabaseLifecycleHarness: DatabaseLifecycleHarness;
  };
  lifecycleGlobal.__DEV__ = true;
  lifecycleGlobal.__palateDatabaseLifecycleHarness = harness;

  const coreModuleUrl = new URL("../utils/db/core.ts?database-lifecycle-test", import.meta.url).href;
  const resetCoreModuleUrl = new URL("../utils/db/reset-core.ts", import.meta.url).href;
  register(new URL("./fixtures/database-reset-loader.mjs", import.meta.url), {
    parentURL: import.meta.url,
    data: { coreModuleUrl, resetCoreModuleUrl },
  });

  const core = await import(coreModuleUrl);
  const initializationStarted = createDeferred<void>();
  const releaseInitialization = createDeferred<void>();
  firstDatabase.nextInitializationBlock = { started: initializationStarted, release: releaseInitialization };
  const initialAcquisition = core.getDatabase();
  await initializationStarted.promise;

  assert.equal(firstDatabase.initializationCount, 1);
  assert.equal(harness.openCount, 1);

  const dropStarted = createDeferred<void>();
  const releaseDrop = createDeferred<void>();
  firstDatabase.nextDropBlock = { started: dropStarted, release: releaseDrop };

  const firstReset = core.nukeDatabase();
  const concurrentReset = core.nukeDatabase();

  let acquisitionSettled = false;
  const acquisitionDuringReset = core.getDatabase().then((database: unknown) => {
    acquisitionSettled = true;
    return database;
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(acquisitionSettled, false, "reset publication must mask an in-flight initial acquisition");

  releaseInitialization.resolve();
  await dropStarted.promise;
  await Promise.resolve();

  assert.equal(acquisitionSettled, false, "database acquisition must wait for the rebuilt schema");
  assert.equal(firstDatabase.dropCount, 1, "concurrent resets must share one schema rebuild");

  releaseDrop.resolve();
  await Promise.all([firstReset, concurrentReset]);
  assert.equal(await initialAcquisition, firstDatabase);
  assert.equal(await acquisitionDuringReset, firstDatabase);
  assert.equal(firstDatabase.initializationCount, 2);
  assert.equal(firstDatabase.closeCount, 0);
  assert.equal(harness.restaurantIndexInvalidationCount, 1);
  assert.equal(harness.providerIndexInvalidationCount, 1);

  const resetFailure = new Error("synthetic reset initialization failure");
  firstDatabase.nextInitializationFailure = resetFailure;
  const failedReset = core.nukeDatabase();
  const failedAcquisition = core.getDatabase();
  await Promise.all([
    assert.rejects(failedReset, (error) => error === resetFailure),
    assert.rejects(failedAcquisition, (error) => error === resetFailure),
  ]);

  assert.equal(firstDatabase.closeCount, 1, "a failed reset must close the invalid database handle");
  assert.equal(firstDatabase.dropCount, 2);

  assert.equal(await core.getDatabase(), recoveredDatabase, "a failed reset must allow a fresh database open");
  assert.equal(await core.getDatabase(), recoveredDatabase);
  assert.equal(recoveredDatabase.initializationCount, 1);
  assert.equal(harness.openCount, 2, "recovery must open exactly one fresh database handle");
}

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

await assertDatabaseResetLifecycle();

database.close();
console.log("Database reset tests passed.");

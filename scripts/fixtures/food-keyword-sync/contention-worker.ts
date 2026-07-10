/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  syncDefaultFoodKeywords,
  type FoodKeywordSyncConnection,
  type FoodKeywordSyncDatabase,
} from "../../../utils/db/food-keyword-sync-core.ts";

interface WorkerConfiguration {
  readonly databasePath: string;
  readonly createdAt: number;
  readonly missingKeyword: string;
  readonly reclassifiedKeyword: string;
}

const configuration = workerData as WorkerConfiguration;
const workerParentPort = parentPort;
if (!workerParentPort) {
  throw new Error("Food keyword contention worker requires a parent port.");
}

const database = new DatabaseSync(configuration.databasePath);
database.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL");

let inspectionCount = 0;
let writeExecutions = 0;
const connection: FoodKeywordSyncConnection = {
  async getAllAsync<T>(source: string, parameters: Array<string | number>) {
    const rows = database.prepare(source).all(...parameters) as T[];
    inspectionCount += 1;
    if (inspectionCount === 1) {
      const keywordRows = rows as Array<{ readonly keyword: string; readonly isBuiltIn: number }>;
      await new Promise<void>((resolve) => {
        workerParentPort.once("message", (message) => {
          if (message !== "release") {
            throw new Error(`Unexpected contention-worker message: ${String(message)}`);
          }
          resolve();
        });
        workerParentPort.postMessage({
          type: "preflight",
          missingKeywordPresent: keywordRows.some((row) => row.keyword === configuration.missingKeyword),
          reclassifiedValue: keywordRows.find((row) => row.keyword === configuration.reclassifiedKeyword)?.isBuiltIn,
        });
      });
    }
    return rows;
  },
  async runAsync(source, parameters) {
    writeExecutions += 1;
    const result = database.prepare(source).run(...parameters);
    return { changes: Number(result.changes) };
  },
};

const adapter: FoodKeywordSyncDatabase = {
  ...connection,
  async withExclusiveTransactionAsync(task) {
    database.exec("BEGIN IMMEDIATE");
    try {
      await task(connection);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
      throw error;
    }
  },
};

try {
  const result = await syncDefaultFoodKeywords(adapter, configuration.createdAt);
  workerParentPort.postMessage({
    type: "complete",
    result,
    inspectionCount,
    writeExecutions,
  });
} catch (error) {
  workerParentPort.postMessage({
    type: "failure",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
} finally {
  database.close();
}

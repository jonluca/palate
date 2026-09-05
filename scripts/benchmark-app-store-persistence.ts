#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createDeduplicatingStorage } from "../store/deduplicating-storage.ts";

const UPDATE_COUNT = 10_000;
const SAMPLE_COUNT = 5;

interface ScanState {
  progress: number;
  selectedCalendarIds: string[] | null;
  hasCompletedInitialScan: boolean;
}

async function measure(deduplicate: boolean) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE storage (key TEXT PRIMARY KEY NOT NULL, value TEXT)");
  const writeStatement = db.prepare(
    "INSERT INTO storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const readStatement = db.prepare("SELECT value FROM storage WHERE key = ?");
  let writeCount = 0;
  let serializedBytesWritten = 0;
  const sqliteStorage: StateStorage = {
    getItem(name) {
      const value = readStatement.get(name)?.value ?? null;
      return value === null ? null : String(value);
    },
    setItem(name, value) {
      writeCount++;
      serializedBytesWritten += Buffer.byteLength(value);
      writeStatement.run(name, value);
    },
    removeItem(name) {
      db.prepare("DELETE FROM storage WHERE key = ?").run(name);
    },
  };
  const storage = deduplicate ? createDeduplicatingStorage(sqliteStorage) : sqliteStorage;
  const store = createStore<ScanState>()(
    persist((): ScanState => ({ progress: 0, selectedCalendarIds: null, hasCompletedInitialScan: false }), {
      name: "scan",
      skipHydration: true,
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({
        selectedCalendarIds: state.selectedCalendarIds,
        hasCompletedInitialScan: state.hasCompletedInitialScan,
      }),
    }),
  );
  const startedAt = performance.now();
  for (let progress = 1; progress <= UPDATE_COUNT; progress++) {
    store.setState({ progress });
    if (progress === 2_500) {
      store.setState({ selectedCalendarIds: ["calendar-1"] });
    } else if (progress === 7_500) {
      store.setState({ selectedCalendarIds: ["calendar-2"] });
    }
  }
  store.setState({ hasCompletedInitialScan: true });
  const finalSnapshot = await storage.getItem("scan");
  const elapsedMilliseconds = performance.now() - startedAt;
  assert.equal(store.getState().progress, UPDATE_COUNT);
  assert.equal(writeCount, deduplicate ? 4 : UPDATE_COUNT + 3);
  db.close();
  return { elapsedMilliseconds, writeCount, serializedBytesWritten, finalSnapshot };
}

await measure(false);
await measure(true);
const baseline = [];
const deduplicated = [];
for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
  const first = await measure(sample % 2 !== 0);
  const second = await measure(sample % 2 === 0);
  baseline.push(sample % 2 === 0 ? first : second);
  deduplicated.push(sample % 2 === 0 ? second : first);
}
for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
  assert.equal(baseline[sample].finalSnapshot, deduplicated[sample].finalSnapshot);
}

function summarize(samples: Awaited<ReturnType<typeof measure>>[]) {
  const elapsed = samples.map((sample) => sample.elapsedMilliseconds).sort((a, b) => a - b);
  return {
    medianMilliseconds: elapsed[Math.floor(elapsed.length / 2)],
    writes: samples[0].writeCount,
    serializedBytesWritten: samples[0].serializedBytesWritten,
  };
}

const baselineSummary = summarize(baseline);
const deduplicatedSummary = summarize(deduplicated);
console.log(
  JSON.stringify(
    {
      measurement: "Host Node SQLite in-memory A/B with real Zustand persist; not device frame timing or disk latency",
      transientUpdates: UPDATE_COUNT,
      preferenceChanges: 3,
      samples: SAMPLE_COUNT,
      baseline: baselineSummary,
      deduplicated: deduplicatedSummary,
      writeReductionPercent: (1 - deduplicatedSummary.writes / baselineSummary.writes) * 100,
      elapsedRatio: baselineSummary.medianMilliseconds / deduplicatedSummary.medianMilliseconds,
      finalSnapshotIdentical: true,
    },
    null,
    2,
  ),
);

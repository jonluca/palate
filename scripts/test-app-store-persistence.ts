#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createDeduplicatingStorage } from "../store/deduplicating-storage.ts";
import { createDefaultAppPreferences, selectAppPreferences, type AppPreferences } from "../store/app-preferences.ts";

// The existing persisted format is the compatibility oracle, including property order.
const LEGACY_DEFAULT_PREFERENCES = {
  visitsFilter: "all",
  reviewFoodFilter: "on",
  reviewCalendarMatchesFilter: "on",
  reviewRestaurantMatchesFilter: "on",
  reviewStarFilter: "any",
  reviewFiltersCollapsed: true,
  hasCompletedOnboarding: false,
  hasCompletedInitialScan: false,
  googleMapsApiKey: null,
  selectedCalendarIds: null,
  hasSeenAddPhotosAlert: false,
  hideUndoBar: false,
  fastAnimations: false,
};

const firstDefaults = createDefaultAppPreferences();
const secondDefaults = createDefaultAppPreferences();
assert.notStrictEqual(firstDefaults, secondDefaults);
assert.equal(JSON.stringify(firstDefaults), JSON.stringify(LEGACY_DEFAULT_PREFERENCES));
firstDefaults.selectedCalendarIds = ["mutated-instance"];
firstDefaults.visitsFilter = "confirmed";
assert.equal(secondDefaults.selectedCalendarIds, null, "default instances must not share mutable preferences");
assert.equal(secondDefaults.visitsFilter, "all");

const NON_DEFAULT_PREFERENCES: AppPreferences = {
  visitsFilter: "rejected",
  reviewFoodFilter: "off",
  reviewCalendarMatchesFilter: "off",
  reviewRestaurantMatchesFilter: "off",
  reviewStarFilter: "3",
  reviewFiltersCollapsed: false,
  hasCompletedOnboarding: true,
  hasCompletedInitialScan: true,
  googleMapsApiKey: "test-only-key",
  selectedCalendarIds: ["calendar-1", "calendar-2"],
  hasSeenAddPhotosAlert: true,
  hideUndoBar: true,
  fastAnimations: true,
};
assert.deepEqual(selectAppPreferences(NON_DEFAULT_PREFERENCES), NON_DEFAULT_PREFERENCES);

function createMemoryStorage() {
  const values = new Map<string, string>();
  const writes: Array<{ name: string; value: string }> = [];
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      writes.push({ name, value });
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  return { storage, values, writes };
}

interface ScanState extends AppPreferences {
  progress: number;
  hasHydrated: boolean;
  resetAllState: () => void;
}

const memory = createMemoryStorage();
const storage = createDeduplicatingStorage(memory.storage);
const store = createStore<ScanState>()(
  persist(
    (set): ScanState => ({
      ...createDefaultAppPreferences(),
      progress: 0,
      hasHydrated: false,
      resetAllState: () => set({ ...createDefaultAppPreferences(), progress: 0 }),
    }),
    {
      name: "scan",
      storage: createJSONStorage(() => storage),
      skipHydration: true,
      partialize: selectAppPreferences,
      onRehydrateStorage: () => (state) => {
        if (state) {
          store.setState({ hasHydrated: true });
        }
      },
    },
  ),
);

await store.persist.rehydrate();
for (let progress = 1; progress <= 10_000; progress++) {
  store.setState({ progress });
}
await storage.getItem("scan");
assert.equal(store.getState().progress, 10_000, "all transient UI state must still update");
assert.equal(memory.writes.length, 1, "rapid scan updates must share the initial preference write");
assert.equal(
  memory.values.get("scan"),
  JSON.stringify({ state: LEGACY_DEFAULT_PREFERENCES, version: 0 }),
  "all persisted keys and their order must stay compatible while transient state and actions remain excluded",
);

store.setState({ selectedCalendarIds: ["calendar-1"] });
store.setState({ selectedCalendarIds: ["calendar-1"] });
store.setState({ hasCompletedInitialScan: true });
await storage.getItem("scan");
assert.equal(memory.writes.length, 3, "persist changed preferences and scan completion exactly once");
assert.deepEqual(JSON.parse(memory.values.get("scan")!), {
  state: { ...LEGACY_DEFAULT_PREFERENCES, selectedCalendarIds: ["calendar-1"], hasCompletedInitialScan: true },
  version: 0,
});

store.persist.clearStorage();
store.setState({ selectedCalendarIds: ["calendar-1"] });
await storage.getItem("scan");
assert.equal(memory.writes.length, 4, "cleared preferences must be saved even when unchanged in memory");
store.setState({ selectedCalendarIds: null, hasCompletedInitialScan: false });
await storage.getItem("scan");
assert.equal(memory.writes.length, 5, "a full preference reset must be persisted");

memory.values.set(
  "scan",
  JSON.stringify({
    state: { selectedCalendarIds: ["external-change"], hasCompletedInitialScan: true },
    version: 0,
  }),
);
await store.persist.rehydrate();
assert.deepEqual(store.getState().selectedCalendarIds, ["external-change"]);
assert.equal(store.getState().hasCompletedInitialScan, true);
assert.equal(store.getState().hasHydrated, true);
assert.equal(store.getState().reviewFoodFilter, "on", "older partial snapshots retain defaults for missing fields");

store.setState(NON_DEFAULT_PREFERENCES);
await storage.getItem("scan");
assert.deepEqual(JSON.parse(memory.values.get("scan")!).state, NON_DEFAULT_PREFERENCES);
store.getState().resetAllState();
await storage.getItem("scan");
assert.deepEqual(selectAppPreferences(store.getState()), LEGACY_DEFAULT_PREFERENCES);
assert.equal(store.getState().hasHydrated, true, "reset keeps the established hydration state");
assert.equal(store.getState().progress, 0);
assert.equal(memory.values.get("scan"), JSON.stringify({ state: LEGACY_DEFAULT_PREFERENCES, version: 0 }));

// Empty and absent calendar selections have different meanings and must round trip.
for (const selectedCalendarIds of [[], null]) {
  store.setState({ selectedCalendarIds });
  const snapshot = await storage.getItem("scan");
  assert.deepEqual(JSON.parse(snapshot!).state.selectedCalendarIds, selectedCalendarIds);
  await store.persist.rehydrate();
  assert.deepEqual(store.getState().selectedCalendarIds, selectedCalendarIds);
}

// A pending write and each duplicate must share completion; changed values,
// removal, and reads remain ordered even with a slow storage implementation.
const operations: string[] = [];
const writeGate = Promise.withResolvers<void>();
let persistedValue: string | null = null;
const orderedStorage = createDeduplicatingStorage({
  getItem() {
    operations.push("read");
    return persistedValue;
  },
  async setItem(_name, value) {
    operations.push(`start:${value}`);
    if (value === "first") {
      await writeGate.promise;
    }
    persistedValue = value;
    operations.push(`end:${value}`);
  },
  removeItem() {
    operations.push("remove");
    persistedValue = null;
  },
});
const first = orderedStorage.setItem("preferences", "first");
assert.strictEqual(orderedStorage.setItem("preferences", "first"), first);
const second = orderedStorage.setItem("preferences", "second");
const removal = orderedStorage.removeItem("preferences");
const afterRemoval = orderedStorage.setItem("preferences", "second");
const readAfterWrites = orderedStorage.getItem("preferences");
await Promise.resolve();
assert.deepEqual(operations, ["start:first"], "later operations must wait for the first write");
writeGate.resolve();
await Promise.all([first, second, removal, afterRemoval]);
assert.equal(await readAfterWrites, "second");
assert.deepEqual(operations, [
  "start:first",
  "end:first",
  "start:second",
  "end:second",
  "remove",
  "start:second",
  "end:second",
  "read",
]);

let attemptCount = 0;
const failingStorage = createDeduplicatingStorage({
  getItem: () => null,
  setItem: async () => {
    attemptCount++;
    if (attemptCount === 1) {
      throw new Error("write failed");
    }
  },
  removeItem: () => undefined,
});
await assert.rejects(Promise.resolve(failingStorage.setItem("preferences", "retry")), /write failed/);
await failingStorage.setItem("preferences", "retry");
await failingStorage.setItem("preferences", "retry");
assert.equal(attemptCount, 2, "failed values must retry, then deduplicate after success");

const failureGate = Promise.withResolvers<void>();
let replacementAttempts = 0;
const replacingStorage = createDeduplicatingStorage({
  getItem: () => null,
  async setItem(_name, value) {
    if (value === "old") {
      await failureGate.promise;
      throw new Error("old write failed");
    }
    replacementAttempts++;
  },
  removeItem: () => undefined,
});
const oldWrite = replacingStorage.setItem("preferences", "old");
const expectedFailure = assert.rejects(Promise.resolve(oldWrite), /old write failed/);
const newWrite = replacingStorage.setItem("preferences", "new");
failureGate.resolve();
await Promise.all([expectedFailure, newWrite]);
await replacingStorage.setItem("preferences", "new");
assert.equal(replacementAttempts, 1, "an older failure must not invalidate a newer snapshot");

const multiKeyMemory = createMemoryStorage();
const multiKeyStorage = createDeduplicatingStorage(multiKeyMemory.storage);
await Promise.all([
  multiKeyStorage.setItem("app-store", "same"),
  multiKeyStorage.setItem("app-store-dev", "same"),
  multiKeyStorage.setItem("app-store", "same"),
]);
assert.equal(multiKeyMemory.writes.length, 2, "development and production keys must remain independent");

const appStoreSource = readFileSync(new URL("../store/app-store.ts", import.meta.url), "utf8");
assert.match(appStoreSource, /storage: createJSONStorage\(\(\) => createDeduplicatingStorage\(AsyncStorage\)\)/);
assert.match(appStoreSource, /interface AppState extends AppPreferences/);
assert.equal(appStoreSource.match(/\.\.\.createDefaultAppPreferences\(\)/g)?.length, 2);
assert.match(appStoreSource, /resetAllState: \(\) =>\s*set\(\{\s*\.\.\.createDefaultAppPreferences\(\)/);
assert.match(appStoreSource, /partialize: selectAppPreferences/);
console.log(
  "App store persistence passed: preference contract/defaults, legacy snapshots, 10,000 transient updates, ordering, reset, rehydration, failures, and independent keys.",
);

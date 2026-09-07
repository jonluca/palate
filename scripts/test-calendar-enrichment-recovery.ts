#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

interface CalendarContextApi {
  getCalendarEnrichmentContext?: () => Promise<string | null>;
}

interface EnrichmentApi {
  enrichVisitsWithCalendarEvents?: (options: { incremental: boolean }) => Promise<{
    totalVisits: number;
    visitsWithEvents: number;
    isComplete: boolean;
  }>;
}

interface MatchingVisit {
  id: string;
  startTime: number;
  endTime: number;
  suggestedRestaurants: Array<{ id: string; name: string }>;
}

const calendarSource = readFileSync(new URL("../services/calendar.ts", import.meta.url), "utf8");
const visitSource = readFileSync(new URL("../services/visit.ts", import.meta.url), "utf8");
const compile = (source: string) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const compiledCalendar = compile(calendarSource);
const compiledVisit = compile(
  `${visitSource}\nexports.enrichVisitsWithCalendarEvents = enrichVisitsWithCalendarEvents;`,
);
const timestamp = 1_800_000_000_000;
const visit: MatchingVisit = {
  id: "visit",
  startTime: timestamp,
  endTime: timestamp + 60_000,
  suggestedRestaurants: [],
};
const event = {
  id: "event-in-A",
  title: "Dinner",
  location: null,
  notes: null,
  startDate: timestamp,
  endDate: timestamp + 60_000,
  isAllDay: false,
  calendarTitle: "A",
};

interface CalendarSelectionScenario {
  useNativeMatching: boolean;
  restoreSelection: boolean;
  initialSelection?: string[];
  restoredSelection?: string[];
  emptySnapshot?: boolean;
}

const selectionScenarios: readonly CalendarSelectionScenario[] = [
  { useNativeMatching: true, restoreSelection: true },
  { useNativeMatching: false, restoreSelection: true },
  { useNativeMatching: true, restoreSelection: false },
  { useNativeMatching: false, restoreSelection: false },
  { useNativeMatching: true, restoreSelection: false, emptySnapshot: true },
  { useNativeMatching: true, restoreSelection: true, initialSelection: ["B", "A", "A"], restoredSelection: ["A", "B"] },
  {
    useNativeMatching: false,
    restoreSelection: true,
    initialSelection: ["A", "B"],
    restoredSelection: ["B", "A", "A"],
  },
];
for (const scenario of selectionScenarios) {
  const { useNativeMatching, restoreSelection } = scenario;
  let selectedCalendarIds: string[] | null = [...(scenario.initialSelection ?? ["A"])];
  let requestedCalendarIds: readonly string[] | null = null;
  const calendarExports: CalendarContextApi = {};
  const calendarDependencies = new Map<string, object>([
    ["@/store", { getSelectedCalendarIds: () => selectedCalendarIds }],
    [
      "@/modules/calendar-matching",
      {
        getCalendarRevision: async () => "stable-eventkit-revision",
        isCalendarMatchingAvailable: () => useNativeMatching,
        matchVisits: async (_visits: MatchingVisit[], ids: readonly string[] | null) => {
          requestedCalendarIds = ids;
          if (restoreSelection) {
            selectedCalendarIds = [...(scenario.restoredSelection ?? ["A"])];
          }
          return ids?.includes("A") ? [{ ...event, visitId: visit.id, suggestedRestaurantId: null }] : [];
        },
      },
    ],
    [
      "expo-calendar/legacy",
      {
        EntityTypes: { EVENT: "event" },
        getCalendarPermissionsAsync: async () => ({ status: "granted" }),
        getCalendarsAsync: async () => [
          { id: "A", title: "A" },
          { id: "B", title: "B" },
        ],
        getEventsAsync: async (ids: readonly string[]) => {
          requestedCalendarIds = ids;
          if (restoreSelection) {
            selectedCalendarIds = [...(scenario.restoredSelection ?? ["A"])];
          }
          return ids.includes("A") ? [{ ...event, calendarId: "A", allDay: false }] : [];
        },
      },
    ],
  ]);
  runInNewContext(compiledCalendar, {
    exports: calendarExports,
    require: (name: string) => calendarDependencies.get(name) ?? {},
    console,
  });
  let persistedCalendarEventCount = 0;
  const visitDependencies = new Map<string, object>([
    ["./calendar", calendarExports],
    ["./michelin", { getMichelinDatasetVersion: () => "guide" }],
    ["@/modules/batch-asset-info", { getVisionResultPageSize: () => 24 }],
    [
      "@/utils/db",
      {
        getCalendarEnrichmentVisitSnapshot: async () => {
          // The context was read for A. A user can change selection while this
          // awaited SQLite read runs, and change it back before matching ends.
          assert.ok(selectedCalendarIds);
          selectedCalendarIds.splice(0, selectedCalendarIds.length, "B");
          return scenario.emptySnapshot ? [] : [visit];
        },
        batchUpdateVisitsCalendarEvents: async (updates: unknown[]) => {
          persistedCalendarEventCount += updates.length;
        },
        batchUpdateVisitSuggestedRestaurants: async () => undefined,
        recordCalendarEnrichmentAttempts: async () => undefined,
      },
    ],
  ]);
  const visitExports: EnrichmentApi = {};
  runInNewContext(compiledVisit, {
    exports: visitExports,
    require: (name: string) => visitDependencies.get(name) ?? {},
    __DEV__: false,
    console,
  });
  assert.ok(visitExports.enrichVisitsWithCalendarEvents);
  const matching = visitExports.enrichVisitsWithCalendarEvents({ incremental: true });
  if (!restoreSelection) {
    await assert.rejects(matching, /Calendar selection changed during matching/);
    assert.equal(persistedCalendarEventCount, 0, "a selection change must not persist stale event links");
    continue;
  }
  const result = await matching;
  assert.deepEqual(
    Array.from(requestedCalendarIds ?? []),
    [...new Set(scenario.initialSelection ?? ["A"])].sort(),
    `${useNativeMatching ? "native" : "fallback"} matching must retain the selection used by its cache context`,
  );
  assert.equal(result.visitsWithEvents, 1);
  assert.equal(persistedCalendarEventCount, 1);
}

// Native revision tracking is an optimization. Its failure must disable caching
// instead of aborting an otherwise valid quick scan after photos were saved.
const unavailableRevisionExports: CalendarContextApi = {};
const unavailableRevisionDependencies = new Map<string, object>([
  ["@/store", { getSelectedCalendarIds: () => ["A"] }],
  [
    "@/modules/calendar-matching",
    {
      getCalendarRevision: async () => {
        throw new Error("revision service unavailable");
      },
      isCalendarMatchingAvailable: () => true,
      matchVisits: async () => [{ ...event, visitId: visit.id, suggestedRestaurantId: null }],
    },
  ],
  ["expo-calendar/legacy", { getCalendarPermissionsAsync: async () => ({ status: "granted" }) }],
]);
runInNewContext(compiledCalendar, {
  exports: unavailableRevisionExports,
  require: (name: string) => unavailableRevisionDependencies.get(name) ?? {},
  console: { warn: () => undefined },
});
assert.ok(unavailableRevisionExports.getCalendarEnrichmentContext);
assert.equal(await unavailableRevisionExports.getCalendarEnrichmentContext(), null);
let uncachedPersistedEvents = 0;
let uncachedAttemptWrites = 0;
const uncachedVisitExports: EnrichmentApi = {};
const uncachedVisitDependencies = new Map<string, object>([
  ["./calendar", unavailableRevisionExports],
  ["./michelin", { getMichelinDatasetVersion: () => "guide" }],
  ["@/modules/batch-asset-info", { getVisionResultPageSize: () => 24 }],
  [
    "@/utils/db",
    {
      getCalendarEnrichmentVisitSnapshot: async (context: string | null) => {
        assert.equal(context, null, "failed revision tracking must request an uncached snapshot");
        return [visit];
      },
      batchUpdateVisitsCalendarEvents: async (updates: unknown[]) => {
        uncachedPersistedEvents += updates.length;
      },
      batchUpdateVisitSuggestedRestaurants: async () => undefined,
      recordCalendarEnrichmentAttempts: async () => {
        uncachedAttemptWrites++;
      },
    },
  ],
]);
runInNewContext(compiledVisit, {
  exports: uncachedVisitExports,
  require: (name: string) => uncachedVisitDependencies.get(name) ?? {},
  __DEV__: false,
  console,
});
assert.ok(uncachedVisitExports.enrichVisitsWithCalendarEvents);
const uncachedResult = await uncachedVisitExports.enrichVisitsWithCalendarEvents({ incremental: true });
assert.equal(uncachedResult.isComplete, true);
assert.equal(uncachedResult.visitsWithEvents, 1);
assert.equal(uncachedPersistedEvents, 1, "valid matches still persist when revision tracking is unavailable");
assert.equal(uncachedAttemptWrites, 0, "a missing revision must never produce a cached attempt");

console.log(
  "Calendar enrichment recovery passed: retained selection for native/fallback reads and uncached recovery when revision tracking fails.",
);

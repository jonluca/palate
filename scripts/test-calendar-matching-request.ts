#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type * as calendarApi from "../modules/calendar-matching/src/index.ts";
import * as requestCore from "../modules/calendar-matching/src/request-core.ts";
import {
  assertValidCalendarTimestamp,
  validateCalendarVisitsForNativeMatching,
} from "../modules/calendar-matching/src/request-core.ts";

interface TestVisit {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly suggestedRestaurants: readonly {
    readonly id: string;
    readonly name: string;
  }[];
}

function validVisit(overrides: Partial<TestVisit> = {}): TestVisit {
  return {
    id: "visit-1",
    startTime: 1_700_000_000_000,
    endTime: 1_700_003_600_000,
    suggestedRestaurants: [
      { id: "restaurant-1", name: "O'Brien's 🍣" },
      { id: "restaurant-2", name: "食堂 Café" },
    ],
    ...overrides,
  };
}

function testValidInputsRetainIdentity(): void {
  const visits = Object.freeze([
    Object.freeze({
      ...validVisit(),
      suggestedRestaurants: Object.freeze(
        validVisit().suggestedRestaurants.map((restaurant) => Object.freeze({ ...restaurant })),
      ),
    }),
    Object.freeze(validVisit({ id: "visit-2", startTime: -8_640_000_000_000_000, endTime: 0 })),
    Object.freeze(
      validVisit({
        id: "visit-3",
        startTime: 8_640_000_000_000_000,
        endTime: 8_640_000_000_000_000,
        suggestedRestaurants: Object.freeze([]),
      }),
    ),
  ]);

  const prepared = validateCalendarVisitsForNativeMatching(visits);

  assert.strictEqual(prepared, visits);
  assert.strictEqual(prepared[0], visits[0]);
  assert.strictEqual(prepared[0].suggestedRestaurants, visits[0].suggestedRestaurants);
}

function testTimestampValidation(): void {
  assert.doesNotThrow(() => assertValidCalendarTimestamp(-8_640_000_000_000_000, "timestamp"));
  assert.doesNotThrow(() => assertValidCalendarTimestamp(8_640_000_000_000_000, "timestamp"));

  for (const invalidValue of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    8_640_000_000_000_001,
    -8_640_000_000_000_001,
  ]) {
    assert.throws(
      () => assertValidCalendarTimestamp(invalidValue, "timestamp"),
      new TypeError("timestamp must be a valid ECMAScript Date timestamp in milliseconds."),
    );
  }
}

function testVisitValidationErrorsAndOrder(): void {
  assert.throws(
    () => validateCalendarVisitsForNativeMatching([validVisit({ startTime: Number.NaN, endTime: Number.NaN })]),
    new TypeError("visit.startTime must be a valid ECMAScript Date timestamp in milliseconds."),
  );
  assert.throws(
    () => validateCalendarVisitsForNativeMatching([validVisit({ endTime: Number.POSITIVE_INFINITY })]),
    new TypeError("visit.endTime must be a valid ECMAScript Date timestamp in milliseconds."),
  );
  assert.throws(
    () => validateCalendarVisitsForNativeMatching([validVisit({ id: "visit-reversed", startTime: 200, endTime: 100 })]),
    new RangeError("Visit visit-reversed has an endTime before its startTime."),
  );
  assert.deepEqual(validateCalendarVisitsForNativeMatching([]), []);
}

const compiledModule = ts.transpileModule(
  readFileSync(new URL("../modules/calendar-matching/src/index.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

type NativeCalendarMethods = Partial<
  Pick<typeof calendarApi, "getEvents" | "matchVisits" | "batchCreateExportEvents" | "batchDeleteEvents">
>;

function loadProductionApi(nativeModule: NativeCalendarMethods | null, platform = "ios") {
  const exports: Partial<typeof calendarApi> = {};
  const dependencies = new Map<string, object>([
    ["expo", { requireOptionalNativeModule: () => nativeModule }],
    ["react-native", { Platform: { OS: platform } }],
    ["./request-core", requestCore],
  ]);
  runInNewContext(compiledModule, {
    exports,
    require: (name: string) => {
      const dependency = dependencies.get(name);
      assert.ok(dependency, `Unexpected Calendar dependency: ${name}`);
      return dependency;
    },
  });
  const { getEvents, matchVisits, batchCreateExportEvents, batchDeleteEvents } = exports;
  assert.ok(getEvents && matchVisits && batchCreateExportEvents && batchDeleteEvents);
  return { getEvents, matchVisits, batchCreateExportEvents, batchDeleteEvents };
}

async function testProductionBoundary(): Promise<void> {
  const calls: { method: string; args: unknown[] }[] = [];
  const capture =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve([]);
    };
  const api = loadProductionApi({
    getEvents: capture("getEvents"),
    matchVisits: capture("matchVisits"),
    batchCreateExportEvents: capture("batchCreateExportEvents"),
    batchDeleteEvents: capture("batchDeleteEvents"),
  });
  const ids = Object.freeze(["calendar-雪"]);
  const visits = Object.freeze([Object.freeze(validVisit())]);
  const creates = Object.freeze([
    Object.freeze({ requestId: "create-1", title: "Café 🍣", startMs: 0, endMs: 1, location: null, notes: "" }),
  ]);
  const deletes = Object.freeze([
    Object.freeze({ requestId: "delete-1", eventId: "event-1", instanceStartMs: null, futureEvents: false }),
  ]);

  await api.getEvents(0, 1, ids);
  await api.matchVisits(visits, ids);
  await api.batchCreateExportEvents("calendar-雪", "UTC", creates);
  await api.batchDeleteEvents(deletes);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["getEvents", "matchVisits", "batchCreateExportEvents", "batchDeleteEvents"],
  );
  assert.strictEqual(calls[0].args[2], ids);
  assert.strictEqual(calls[1].args[0], visits);
  assert.strictEqual(calls[1].args[1], ids);
  assert.strictEqual(calls[2].args[2], creates);
  assert.strictEqual(calls[3].args[0], deletes);

  await api.getEvents(0, 1);
  const noCalendars = Object.freeze([]);
  await api.getEvents(0, 1, noCalendars);
  assert.strictEqual(calls[4].args[2], null);
  assert.strictEqual(calls[5].args[2], noCalendars);
  const previousCalls = calls.length;
  assert.equal((await api.matchVisits([])).length, 0);
  await assert.rejects(api.getEvents(Number.NaN, 1), /valid ECMAScript Date timestamp/);
  await assert.rejects(api.getEvents(1, 0), /greater than or equal/);
  await assert.rejects(api.matchVisits(visits, ids, -1), /finite non-negative/);
  await assert.rejects(api.matchVisits([validVisit({ endTime: 0 })]), /endTime before its startTime/);
  assert.equal(calls.length, previousCalls, "invalid and empty requests must not reach native code");

  for (const unavailable of [loadProductionApi(null), loadProductionApi({}, "android")]) {
    await assert.rejects(unavailable.getEvents(0, 1), /unavailable/);
    await assert.rejects(unavailable.batchCreateExportEvents("calendar", "UTC", creates), /unavailable/);
    await assert.rejects(unavailable.batchDeleteEvents(deletes), /unavailable/);
  }
  const failure = new Error("native mutation failed");
  const failingApi = loadProductionApi({ batchDeleteEvents: () => Promise.reject(failure) });
  await assert.rejects(failingApi.batchDeleteEvents(deletes), (error) => error === failure);
}

testValidInputsRetainIdentity();
testTimestampValidation();
testVisitValidationErrorsAndOrder();
await testProductionBoundary();

console.log("Calendar native matching request tests passed.");

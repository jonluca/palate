#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function testProductionWiring(): void {
  const source = readFileSync(new URL("../modules/calendar-matching/src/index.ts", import.meta.url), "utf8");

  assert.match(source, /const nativeVisits = validateCalendarVisitsForNativeMatching\(visits\);/);
  assert.match(source, /matchVisits\(\s*nativeVisits,\s*copySelectedCalendarIds/);
  assert.doesNotMatch(source, /suggestedRestaurants\.map/);
  assert.doesNotMatch(source, /visits\.map/);
}

testValidInputsRetainIdentity();
testTimestampValidation();
testVisitValidationErrorsAndOrder();
testProductionWiring();

console.log("Calendar native matching request tests passed.");

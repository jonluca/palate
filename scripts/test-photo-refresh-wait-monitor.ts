#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";
import { PHOTO_REFRESH_SLOW_WAIT_MS, monitorPhotoRefreshWait } from "../utils/photo-refresh-wait-monitor.ts";

function deferred<Result>() {
  let resolveOperation!: (value: Result) => void;
  let rejectOperation!: (reason: Error) => void;
  const promise = new Promise<Result>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  return { promise, resolve: resolveOperation, reject: rejectOperation };
}

test("an unresolved wait reports once and remains pending until its operation finishes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = deferred<object>();
  let reports = 0;
  let settled = false;
  const monitored = monitorPhotoRefreshWait(operation.promise, {
    shouldReport: () => true,
    onSlowWait: () => {
      reports += 1;
    },
  });
  void monitored.then(() => {
    settled = true;
  });

  assert.equal(PHOTO_REFRESH_SLOW_WAIT_MS, 60_000);
  context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS - 1);
  assert.equal(reports, 0);
  context.mock.timers.tick(1);
  assert.equal(reports, 1);
  context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS * 2);
  await Promise.resolve();
  assert.equal(reports, 1);
  assert.equal(settled, false, "reporting must not release ownership of pending work");

  const result = {};
  operation.resolve(result);
  assert.equal(await monitored, result, "late completion must preserve the original result");
  assert.equal(settled, true);
});

test("normal completion clears the timer before it evaluates reporting eligibility", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let eligibilityChecks = 0;
  let reports = 0;
  const result = {};
  const monitored = monitorPhotoRefreshWait(Promise.resolve(result), {
    shouldReport: () => {
      eligibilityChecks += 1;
      return true;
    },
    onSlowWait: () => {
      reports += 1;
    },
  });

  assert.equal(await monitored, result);
  context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS * 2);
  assert.equal(eligibilityChecks, 0);
  assert.equal(reports, 0);
});

test("rejection preserves the original error and clears the timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const error = new Error("operation failed");
  let eligibilityChecks = 0;
  let reports = 0;
  const monitored = monitorPhotoRefreshWait(Promise.reject(error), {
    shouldReport: () => {
      eligibilityChecks += 1;
      return true;
    },
    onSlowWait: () => {
      reports += 1;
    },
  });

  await assert.rejects(monitored, (actual) => actual === error);
  context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS * 2);
  assert.equal(eligibilityChecks, 0);
  assert.equal(reports, 0);
});

test("a wait does not report when the app is inactive at the deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = deferred<string>();
  let active = true;
  let reports = 0;
  const monitored = monitorPhotoRefreshWait(operation.promise, {
    shouldReport: () => active,
    onSlowWait: () => {
      reports += 1;
    },
  });

  active = false;
  context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS);
  assert.equal(reports, 0);
  active = true;
  context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS);
  assert.equal(reports, 0, "returning to the app must not emit an overdue report");
  operation.resolve("complete");
  assert.equal(await monitored, "complete");
});

test("a late rejection remains observable after a slow wait report", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = deferred<void>();
  const error = new Error("late operation failure");
  let reports = 0;
  const monitored = monitorPhotoRefreshWait(operation.promise, {
    shouldReport: () => true,
    onSlowWait: () => {
      reports += 1;
    },
  });

  context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS);
  assert.equal(reports, 1);
  operation.reject(error);
  await assert.rejects(monitored, (actual) => actual === error);
  context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS);
  assert.equal(reports, 1);
});

test("a reporting failure cannot interrupt the observed operation", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = deferred<string>();
  const monitored = monitorPhotoRefreshWait(operation.promise, {
    shouldReport: () => true,
    onSlowWait: () => {
      throw new Error("diagnostic failure");
    },
  });

  assert.doesNotThrow(() => context.mock.timers.tick(PHOTO_REFRESH_SLOW_WAIT_MS));
  operation.resolve("complete");
  assert.equal(await monitored, "complete");
});

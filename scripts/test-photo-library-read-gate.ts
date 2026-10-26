#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPhotoLibraryReadGate,
  isPhotoLibraryReadUnavailableError,
  PhotoLibraryReadBusyError,
  PhotoLibraryReadTimeoutError,
} from "../utils/photo-library-read-gate.ts";

function deferred<Result>() {
  let resolveOperation!: (value: Result) => void;
  let rejectOperation!: (reason: Error) => void;
  const promise = new Promise<Result>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  return { promise, resolve: resolveOperation, reject: rejectOperation };
}

test("successful reads release admission before the caller continues and never dispose owned results", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: 100 });
  const result = { sessionId: "owned" };
  let disposalCount = 0;
  assert.equal(
    await gate.read(() => Promise.resolve(result), {
      disposeLateResult: async () => {
        disposalCount += 1;
      },
    }),
    result,
  );
  assert.equal(gate.isBusy(), false);
  assert.equal(await gate.read(() => Promise.resolve("next")), "next");
  context.mock.timers.tick(1_000);
  assert.equal(gate.isBusy(), false);
  assert.equal(disposalCount, 0);
});

test("rejected reads and synchronous throws preserve their error and release before rejection is observed", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: 100 });
  const failed = new Error("read failed");
  await assert.rejects(
    gate.read(() => Promise.reject(failed)),
    (error) => error === failed,
  );
  assert.equal(gate.isBusy(), false);
  const thrown = new Error("could not start");
  await assert.rejects(
    gate.read(() => {
      throw thrown;
    }),
    (error) => error === thrown,
  );
  assert.equal(gate.isBusy(), false);
  context.mock.timers.tick(1_000);
  assert.equal(await gate.read(() => Promise.resolve("recovered")), "recovered");
});

test("timeouts reject once while pending reads retain every slot and later requests are not queued", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 2, timeoutMs: 100 });
  const first = deferred<string>();
  const second = deferred<string>();
  let settledCount = 0;
  const observe = (promise: Promise<string>) =>
    promise.catch((error: Error) => {
      settledCount += 1;
      assert.ok(error instanceof PhotoLibraryReadTimeoutError);
      assert.equal(error.code, "PHOTO_LIBRARY_READ_TIMEOUT");
    });
  const firstCaller = observe(gate.read(() => first.promise));
  assert.equal(gate.isBusy(), false, "one of two slots remains free");
  const secondCaller = observe(gate.read(() => second.promise));
  assert.equal(gate.isBusy(), true);
  let rejectedOperationStarts = 0;
  const attemptWhileBusy = () =>
    gate.read(async () => {
      rejectedOperationStarts += 1;
      return "must not run";
    });
  await assert.rejects(attemptWhileBusy(), PhotoLibraryReadBusyError);
  context.mock.timers.tick(99);
  assert.equal(settledCount, 0);
  context.mock.timers.tick(1);
  await Promise.all([firstCaller, secondCaller]);
  assert.equal(settledCount, 2);
  assert.equal(gate.isBusy(), true);
  await assert.rejects(attemptWhileBusy(), (error) => {
    assert.ok(error instanceof PhotoLibraryReadBusyError);
    return error.code === "PHOTO_LIBRARY_READ_BUSY";
  });
  context.mock.timers.tick(1_000);
  assert.equal(settledCount, 2);
  first.reject(new Error("late failure"));
  await first.promise.catch(() => undefined);
  assert.equal(gate.isBusy(), false, "only the settled underlying read frees a slot");
  assert.equal(await gate.read(() => Promise.resolve("third")), "third");
  second.reject(new Error("another late failure"));
  await second.promise.catch(() => undefined);
  assert.equal(rejectedOperationStarts, 0, "rejected requests never start after a slot becomes free");
});

test("late results are disposed once and keep admission until disposal settles", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: 100 });
  const operation = deferred<{ sessionId: string }>();
  const cleanup = deferred<void>();
  const result = { sessionId: "late" };
  let disposalCount = 0;
  const caller = gate.read(() => operation.promise, {
    disposeLateResult: async (actual) => {
      assert.equal(actual, result);
      disposalCount += 1;
      await cleanup.promise;
    },
  });
  const timedOut = assert.rejects(caller, PhotoLibraryReadTimeoutError);
  context.mock.timers.tick(100);
  await timedOut;
  operation.resolve(result);
  await operation.promise;
  assert.equal(disposalCount, 1);
  assert.equal(gate.isBusy(), true);
  await assert.rejects(
    gate.read(() => Promise.resolve(result)),
    PhotoLibraryReadBusyError,
  );
  cleanup.resolve();
  await cleanup.promise;
  await Promise.resolve();
  assert.equal(gate.isBusy(), false);
  await assert.rejects(caller, PhotoLibraryReadTimeoutError, "late fulfillment cannot resolve the original caller");
  context.mock.timers.tick(1_000);
  assert.equal(disposalCount, 1);
});

test("late results without cleanup release admission and late failures are consumed", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: 100 });
  const operation = deferred<string>();
  const caller = assert.rejects(
    gate.read(() => operation.promise),
    PhotoLibraryReadTimeoutError,
  );
  context.mock.timers.tick(100);
  await caller;
  operation.resolve("late");
  await operation.promise;
  await Promise.resolve();
  assert.equal(gate.isBusy(), false);
  const failed = deferred<string>();
  const secondCaller = assert.rejects(
    gate.read(() => failed.promise),
    PhotoLibraryReadTimeoutError,
  );
  context.mock.timers.tick(100);
  await secondCaller;
  failed.reject(new Error("late rejection must be consumed"));
  await Promise.resolve();
  assert.equal(gate.isBusy(), false);
});

test("cleanup failures are reported and even a failing reporter cannot retain admission", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: 100 });
  const operation = deferred<string>();
  const cleanupError = new Error("release failed");
  let reports = 0;
  const caller = assert.rejects(
    gate.read(() => operation.promise, {
      disposeLateResult: async () => {
        throw cleanupError;
      },
      onLateCleanupError: (error) => {
        assert.equal(error, cleanupError);
        reports += 1;
        throw new Error("reporting failed");
      },
    }),
    PhotoLibraryReadTimeoutError,
  );
  context.mock.timers.tick(100);
  await caller;
  operation.resolve("late");
  await operation.promise;
  await Promise.resolve();
  assert.equal(reports, 1);
  assert.equal(gate.isBusy(), false);
  assert.equal(await gate.read(() => Promise.resolve("next")), "next");
});

test("the deadline is armed before operation launch and wins a simultaneous late fulfillment once", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: 100 });
  let disposals = 0;
  const caller = gate.read(
    () => {
      assert.equal(gate.isBusy(), true, "admission is claimed before operation launch");
      context.mock.timers.tick(100);
      return Promise.resolve("at deadline");
    },
    {
      disposeLateResult: async () => {
        disposals += 1;
      },
    },
  );
  await assert.rejects(caller, PhotoLibraryReadTimeoutError);
  await Promise.resolve();
  assert.equal(gate.isBusy(), false);
  assert.equal(disposals, 1);
});

test("an asynchronous cleanup reporter cannot retain admission or leak its rejection", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: 100 });
  const operation = deferred<string>();
  const reporting = deferred<void>();
  const caller = assert.rejects(
    gate.read(() => operation.promise, {
      disposeLateResult: async () => {
        throw new Error("cleanup failed");
      },
      onLateCleanupError: () => reporting.promise,
    }),
    PhotoLibraryReadTimeoutError,
  );
  context.mock.timers.tick(100);
  await caller;
  operation.resolve("late");
  await operation.promise;
  await Promise.resolve();
  assert.equal(gate.isBusy(), false, "reporting does not own the settled read's admission");
  reporting.reject(new Error("reporting failed later"));
  await Promise.resolve();
});

test("a synchronous throw after the deadline consumes the error and frees admission", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: 100 });
  await assert.rejects(
    gate.read(() => {
      context.mock.timers.tick(100);
      throw new Error("late synchronous failure");
    }),
    PhotoLibraryReadTimeoutError,
  );
  assert.equal(gate.isBusy(), false);
});

test("large finite deadlines do not overflow platform timers", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const maximumTimerMs = 2_147_483_647;
  const gate = createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs: maximumTimerMs + 100 });
  const operation = deferred<string>();
  let timedOut = false;
  const caller = gate
    .read(() => operation.promise)
    .catch((error: Error) => {
      assert.ok(error instanceof PhotoLibraryReadTimeoutError);
      timedOut = true;
    });
  context.mock.timers.tick(maximumTimerMs);
  await Promise.resolve();
  assert.equal(timedOut, false);
  context.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(timedOut, false);
  context.mock.timers.tick(1);
  await caller;
  assert.equal(timedOut, true);
  operation.reject(new Error("late error"));
  await Promise.resolve();
  assert.equal(gate.isBusy(), false);
});

test("configuration and error classification are explicit", () => {
  for (const maximumOutstanding of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createPhotoLibraryReadGate({ maximumOutstanding, timeoutMs: 100 }), RangeError);
  }
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createPhotoLibraryReadGate({ maximumOutstanding: 1, timeoutMs }), RangeError);
  }
  assert.equal(isPhotoLibraryReadUnavailableError(new PhotoLibraryReadTimeoutError(100)), true);
  assert.equal(isPhotoLibraryReadUnavailableError(new PhotoLibraryReadBusyError()), true);
  assert.equal(isPhotoLibraryReadUnavailableError(new Error("other failure")), false);
  assert.equal(isPhotoLibraryReadUnavailableError(null), false);
});

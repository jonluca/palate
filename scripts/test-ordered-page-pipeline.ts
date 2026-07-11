#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { setImmediate as waitForImmediate, setTimeout as waitForTimeout } from "node:timers/promises";
import { runOrderedPagePipeline } from "../utils/ordered-page-pipeline-core.ts";
import { resolveVisionPageOrchestrationStrategy } from "../utils/vision-page-orchestration-core.ts";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: unknown): void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolveDeferred!: (value: Value) => void;
  let rejectDeferred!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject.");
}

// Selection is deliberately conservative for old binaries and malformed native constants.
assert.equal(resolveVisionPageOrchestrationStrategy(undefined), "serial");
assert.equal(resolveVisionPageOrchestrationStrategy(null), "serial");
assert.equal(resolveVisionPageOrchestrationStrategy("serial"), "serial");
assert.equal(resolveVisionPageOrchestrationStrategy("lookahead"), "lookahead");
for (const invalid of ["", "LOOKAHEAD", " lookahead", "parallel", 1, true, {}]) {
  assert.equal(resolveVisionPageOrchestrationStrategy(invalid), "serial");
}

// Runtime validation rejects malformed injected dependencies before work starts.
await assert.rejects(runOrderedPagePipeline(null as never), /options must be an object/);
await assert.rejects(
  runOrderedPagePipeline({
    pages: null as never,
    strategy: "serial",
    produce: async () => "unused",
    consume: async () => {},
  }),
  /pages must be an array/,
);
await assert.rejects(
  runOrderedPagePipeline({
    pages: [],
    strategy: "serial",
    produce: null as never,
    consume: async () => {},
  }),
  /producer must be a function/,
);
await assert.rejects(
  runOrderedPagePipeline({
    pages: [],
    strategy: "serial",
    produce: async () => "unused",
    consume: null as never,
  }),
  /consumer must be a function/,
);
await assert.rejects(
  runOrderedPagePipeline({
    pages: [],
    strategy: "parallel" as never,
    produce: async () => "unused",
    consume: async () => {},
  }),
  /Unsupported ordered page pipeline strategy/,
);

// Empty plans do no work in either mode.
for (const strategy of ["serial", "lookahead"] as const) {
  let calls = 0;
  await runOrderedPagePipeline({
    pages: [],
    strategy,
    produce: async () => {
      calls += 1;
      return "unused";
    },
    consume: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 0);
}

// Serial mode retains the exact legacy produce/consume order.
{
  const events: string[] = [];
  await runOrderedPagePipeline({
    pages: ["a", "b", "c"],
    strategy: "serial",
    produce: async (page, index) => {
      events.push(`produce-${index}-${page}`);
      return page.toUpperCase();
    },
    consume: async (produced, page, index) => {
      events.push(`consume-${index}-${page}-${produced}`);
    },
  });
  assert.deepEqual(events, [
    "produce-0-a",
    "consume-0-a-A",
    "produce-1-b",
    "consume-1-b-B",
    "produce-2-c",
    "consume-2-c-C",
  ]);
}

// Lookahead starts N+1 only after N production resolves, but before N consumption.
// Controlled completion also proves no third produced page becomes resident.
{
  const production = [createDeferred<string>(), createDeferred<string>(), createDeferred<string>()];
  const consumption = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];
  const events: string[] = [];
  const consumed: string[] = [];
  let residentPages = 0;
  let maximumResidentPages = 0;

  const operation = runOrderedPagePipeline({
    pages: [0, 1, 2],
    strategy: "lookahead",
    produce: async (_page, index) => {
      events.push(`produce-start-${index}`);
      const value = await production[index]!.promise;
      residentPages += 1;
      maximumResidentPages = Math.max(maximumResidentPages, residentPages);
      events.push(`produce-end-${index}`);
      return value;
    },
    consume: async (produced, _page, index) => {
      events.push(`consume-start-${index}`);
      await consumption[index]!.promise;
      consumed.push(produced);
      residentPages -= 1;
      events.push(`consume-end-${index}`);
    },
  });

  assert.deepEqual(events, ["produce-start-0"]);
  production[0]!.resolve("result-0");
  await flushMicrotasks();
  assert.deepEqual(events, ["produce-start-0", "produce-end-0", "produce-start-1", "consume-start-0"]);

  production[1]!.resolve("result-1");
  await flushMicrotasks();
  assert.equal(maximumResidentPages, 2);
  assert.ok(!events.includes("produce-start-2"));

  consumption[0]!.resolve();
  await flushMicrotasks();
  assert.deepEqual(consumed, ["result-0"]);
  assert.ok(events.indexOf("produce-start-2") > events.indexOf("consume-end-0"));
  assert.ok(events.indexOf("consume-start-1") > events.indexOf("produce-start-2"));

  production[2]!.resolve("result-2");
  consumption[1]!.resolve();
  await flushMicrotasks();
  consumption[2]!.resolve();
  await operation;

  assert.deepEqual(consumed, ["result-0", "result-1", "result-2"]);
  assert.equal(residentPages, 0);
  assert.equal(maximumResidentPages, 2);
}

// Ordered consumer work and progress remain non-overlapping under fast producers.
{
  const persisted: number[] = [];
  const progress: number[] = [];
  let activeConsumers = 0;
  let maximumActiveConsumers = 0;
  await runOrderedPagePipeline({
    pages: [0, 1, 2, 3, 4],
    strategy: "lookahead",
    produce: async (page) => page * 10,
    consume: async (produced, page) => {
      activeConsumers += 1;
      maximumActiveConsumers = Math.max(maximumActiveConsumers, activeConsumers);
      await Promise.resolve();
      persisted.push(produced);
      progress.push(page + 1);
      activeConsumers -= 1;
    },
  });
  assert.deepEqual(persisted, [0, 10, 20, 30, 40]);
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  assert.equal(maximumActiveConsumers, 1);
}

// A consumer failure abandons the one already-started lookahead, performs no
// later persistence/progress, and never starts a page beyond that lookahead.
{
  const failure = new Error("injected consume failure");
  const events: string[] = [];
  const error = await captureRejection(
    runOrderedPagePipeline({
      pages: [0, 1, 2, 3],
      strategy: "lookahead",
      produce: async (page) => {
        events.push(`produce-${page}`);
        return page;
      },
      consume: async (_produced, page) => {
        events.push(`consume-${page}`);
        throw failure;
      },
    }),
  );
  assert.equal(error, failure);
  assert.deepEqual(events, ["produce-0", "produce-1", "consume-0"]);
}

// A never-settling speculative producer cannot delay a known consumer failure.
{
  const failure = new Error("injected prompt consume failure");
  const neverSettles = new Promise<number>(() => {});
  const outcome = await Promise.race([
    captureRejection(
      runOrderedPagePipeline({
        pages: [0, 1],
        strategy: "lookahead",
        produce: (page) => (page === 0 ? Promise.resolve(page) : neverSettles),
        consume: async () => {
          throw failure;
        },
      }),
    ).then((error) => ({ status: "rejected" as const, error })),
    waitForTimeout(100).then(() => ({ status: "timed-out" as const })),
  ]);
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") {
    assert.equal(outcome.error, failure);
  }
}

// A speculative rejection that arrives after the consumer failure is already
// reported remains handled and cannot replace or augment the primary failure.
{
  const consumeFailure = new Error("injected consume failure before lookahead");
  const lookaheadFailure = new Error("injected late lookahead failure");
  const lookahead = createDeferred<number>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const error = await captureRejection(
      runOrderedPagePipeline({
        pages: [0, 1],
        strategy: "lookahead",
        produce: (page) => (page === 0 ? Promise.resolve(page) : lookahead.promise),
        consume: async () => {
          throw consumeFailure;
        },
      }),
    );
    assert.equal(error, consumeFailure);
    lookahead.reject(lookaheadFailure);
    await waitForImmediate();
    await waitForImmediate();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

// A lookahead failure allows the already-started current consume to finish, but
// its failed result is never consumed and no subsequent page is started.
{
  const failure = new Error("injected lookahead failure");
  const persisted: number[] = [];
  const produced: number[] = [];
  const error = await captureRejection(
    runOrderedPagePipeline({
      pages: [0, 1, 2],
      strategy: "lookahead",
      produce: async (page) => {
        produced.push(page);
        if (page === 1) {
          throw failure;
        }
        return page;
      },
      consume: async (value) => {
        persisted.push(value);
      },
    }),
  );
  assert.equal(error, failure);
  assert.deepEqual(produced, [0, 1]);
  assert.deepEqual(persisted, [0]);
}

// Simultaneous current-consume and next-produce failures preserve both errors.
{
  const consumeFailure = new Error("injected consume failure");
  const lookaheadFailure = new Error("injected lookahead failure");
  const error = await captureRejection(
    runOrderedPagePipeline({
      pages: [0, 1, 2],
      strategy: "lookahead",
      produce: async (page) => {
        if (page === 1) {
          throw lookaheadFailure;
        }
        return page;
      },
      consume: async () => {
        throw consumeFailure;
      },
    }),
  );
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, [consumeFailure, lookaheadFailure]);
  assert.match(error.message, /consumption and lookahead production both failed/);
}

// The speculative rejection handler is installed immediately: even when the
// current consumer stays pending for another turn, Node sees no unhandled event.
{
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const failure = new Error("immediate speculative rejection");
    const error = await captureRejection(
      runOrderedPagePipeline({
        pages: [0, 1],
        strategy: "lookahead",
        produce: (page) => (page === 1 ? Promise.reject(failure) : Promise.resolve(page)),
        consume: async () => {
          await waitForImmediate();
        },
      }),
    );
    assert.equal(error, failure);
    await waitForImmediate();
    await waitForImmediate();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

// Synchronous producer/consumer throws retain identity in both strategies.
for (const strategy of ["serial", "lookahead"] as const) {
  const producerFailure = new Error(`${strategy} sync producer`);
  assert.equal(
    await captureRejection(
      runOrderedPagePipeline({
        pages: [0],
        strategy,
        produce: () => {
          throw producerFailure;
        },
        consume: async () => {},
      }),
    ),
    producerFailure,
  );

  const consumerFailure = new Error(`${strategy} sync consumer`);
  assert.equal(
    await captureRejection(
      runOrderedPagePipeline({
        pages: [0],
        strategy,
        produce: async (page) => page,
        consume: () => {
          throw consumerFailure;
        },
      }),
    ),
    consumerFailure,
  );
}

console.log("Ordered page pipeline and Vision strategy tests passed.");

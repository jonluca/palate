/** Selects whether ordered pages are produced serially or with one-page lookahead. */
export type OrderedPagePipelineStrategy = "serial" | "lookahead";

/** Configures {@link runOrderedPagePipeline}. */
export interface OrderedPagePipelineOptions<Page, Produced> {
  /** Ordered page descriptors. Descriptors should be small and immutable. */
  readonly pages: readonly Page[];

  /** Produces one page without performing ordered persistence or progress writes. */
  readonly produce: (page: Page, index: number) => Promise<Produced>;

  /** Consumes one produced page. Calls are strictly ordered and never overlap. */
  readonly consume: (produced: Produced, page: Page, index: number) => void | Promise<void>;

  /**
   * `lookahead` overlaps production of page N+1 with consumption of page N.
   * It never starts more than one future page.
   */
  readonly strategy: OrderedPagePipelineStrategy;
}

type Settled<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly reason: unknown };

interface StartedSettled<Value> {
  /** Always fulfills because producer/consumer rejection is represented in the value. */
  readonly promise: Promise<Settled<Value>>;

  /** Synchronously exposes an outcome only after the operation has settled. */
  readonly outcome: Settled<Value> | undefined;
}

/**
 * Attaches both fulfillment and rejection handlers in the same turn in which
 * an operation is started. This keeps a speculative producer rejection from
 * becoming an unhandled promise while the current page is still consumed.
 */
function startSettled<Value>(operation: () => Value | PromiseLike<Value>): StartedSettled<Value> {
  let outcome: Settled<Value> | undefined;
  const record = (nextOutcome: Settled<Value>): Settled<Value> => {
    outcome = nextOutcome;
    return nextOutcome;
  };

  let promise: Promise<Settled<Value>>;
  try {
    promise = Promise.resolve(operation()).then(
      (value) => record({ status: "fulfilled", value }),
      (reason: unknown) => record({ status: "rejected", reason }),
    );
  } catch (reason) {
    promise = Promise.resolve(record({ status: "rejected", reason }));
  }

  return {
    promise,
    get outcome() {
      return outcome;
    },
  };
}

function assertOptions<Page, Produced>(options: OrderedPagePipelineOptions<Page, Produced>): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Ordered page pipeline options must be an object.");
  }
  if (!Array.isArray(options.pages)) {
    throw new TypeError("Ordered page pipeline pages must be an array.");
  }
  if (typeof options.produce !== "function") {
    throw new TypeError("Ordered page pipeline producer must be a function.");
  }
  if (typeof options.consume !== "function") {
    throw new TypeError("Ordered page pipeline consumer must be a function.");
  }
  if (options.strategy !== "serial" && options.strategy !== "lookahead") {
    throw new RangeError(`Unsupported ordered page pipeline strategy: ${String(options.strategy)}.`);
  }
}

function unwrap<Value>(outcome: Settled<Value>): Value {
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

/**
 * Produces and consumes ordered pages with an optional bounded lookahead.
 *
 * In lookahead mode, page N+1 starts only after page N production resolves and
 * immediately before page N consumption starts. Consumption remains serial, so
 * persistence and progress callbacks retain input order. If consumption fails,
 * the already-started lookahead is never consumed and no later page is started.
 * A pending lookahead cannot delay that failure; a rejection that already settled
 * concurrently is preserved alongside the consumption error.
 */
export async function runOrderedPagePipeline<Page, Produced>(
  options: OrderedPagePipelineOptions<Page, Produced>,
): Promise<void> {
  assertOptions(options);
  if (options.pages.length === 0) {
    return;
  }

  if (options.strategy === "serial") {
    for (let index = 0; index < options.pages.length; index++) {
      const page = options.pages[index]!;
      const produced = unwrap(await startSettled(() => options.produce(page, index)).promise);
      unwrap(await startSettled(() => options.consume(produced, page, index)).promise);
    }
    return;
  }

  let currentProduced = unwrap(await startSettled(() => options.produce(options.pages[0]!, 0)).promise);

  for (let index = 0; index < options.pages.length; index++) {
    const page = options.pages[index]!;
    const nextIndex = index + 1;
    const lookahead =
      nextIndex < options.pages.length
        ? startSettled(() => options.produce(options.pages[nextIndex]!, nextIndex))
        : undefined;
    const consumption = startSettled(() => options.consume(currentProduced, page, index));

    const consumptionOutcome = await consumption.promise;

    if (consumptionOutcome.status === "rejected") {
      // Do not let speculative work delay a known persistence/progress failure.
      // The speculative promise already has a rejection handler, so it remains
      // safe to abandon. Preserve both errors only when the producer rejection
      // had already settled by the time consumption failed.
      if (lookahead?.outcome?.status === "rejected") {
        throw new AggregateError(
          [consumptionOutcome.reason, lookahead.outcome.reason],
          "Ordered page consumption and lookahead production both failed.",
        );
      }
      throw consumptionOutcome.reason;
    }

    const lookaheadOutcome = lookahead ? await lookahead.promise : undefined;
    if (lookaheadOutcome?.status === "rejected") {
      throw lookaheadOutcome.reason;
    }
    if (lookaheadOutcome?.status === "fulfilled") {
      currentProduced = lookaheadOutcome.value;
    }
  }
}

export interface ReservationAwardLookupInput {
  readonly restaurantId: string | null;
  readonly startTime: number;
}

export interface ReservationAwardLookupBatch {
  readonly localYear: number;
  readonly representativeTimestamp: number;
  readonly restaurantIds: string[];
}

export type ReservationAwardBatchLookup = (
  restaurantIds: string[],
  representativeTimestamp: number,
) => Promise<Record<string, string | null>>;

export type ReservationAwardSingleLookup = (
  restaurantId: string,
  representativeTimestamp: number,
) => Promise<string | null>;

export const RESERVATION_AWARD_LOOKUP_BATCH_SIZE = 1_000;
export const RESERVATION_AWARD_SINGLE_LOOKUP_CONCURRENCY = 8;

interface ReservationAwardLookupPlan {
  readonly batches: ReservationAwardLookupBatch[];
  readonly localYearsByInputIndex: Array<number | null>;
}

function buildReservationAwardLookupPlan(inputs: readonly ReservationAwardLookupInput[]): ReservationAwardLookupPlan {
  const localYearsByInputIndex: Array<number | null> = inputs.map(() => null);
  const batchesByYear = new Map<
    number,
    { representativeTimestamp: number; restaurantIds: string[]; seenRestaurantIds: Set<string> }
  >();

  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]!;
    if (!input.restaurantId?.startsWith("michelin-")) {
      continue;
    }
    const localYear = new Date(input.startTime).getFullYear();
    localYearsByInputIndex[index] = localYear;
    let batch = batchesByYear.get(localYear);
    if (!batch) {
      batch = {
        representativeTimestamp: input.startTime,
        restaurantIds: [],
        seenRestaurantIds: new Set(),
      };
      batchesByYear.set(localYear, batch);
    }
    if (!batch.seenRestaurantIds.has(input.restaurantId)) {
      batch.seenRestaurantIds.add(input.restaurantId);
      batch.restaurantIds.push(input.restaurantId);
    }
  }

  const batches: ReservationAwardLookupBatch[] = [];
  for (const [localYear, batch] of batchesByYear) {
    for (let offset = 0; offset < batch.restaurantIds.length; offset += RESERVATION_AWARD_LOOKUP_BATCH_SIZE) {
      batches.push({
        localYear,
        representativeTimestamp: batch.representativeTimestamp,
        restaurantIds: batch.restaurantIds.slice(offset, offset + RESERVATION_AWARD_LOOKUP_BATCH_SIZE),
      });
    }
  }
  return { batches, localYearsByInputIndex };
}

/**
 * Group the effective Michelin lookups by the same local-year rule used by
 * getAwardForDate(). IDs retain first-occurrence order within each year.
 */
export function buildReservationAwardLookupBatches(
  inputs: readonly ReservationAwardLookupInput[],
): ReservationAwardLookupBatch[] {
  return buildReservationAwardLookupPlan(inputs).batches;
}

type ReservationAwardLookupLimiter = <T>(lookup: () => Promise<T>) => Promise<T>;

function createLookupLimiter(maxConcurrency: number): ReservationAwardLookupLimiter {
  let activeCount = 0;
  const pending: Array<() => void> = [];

  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (activeCount < maxConcurrency) {
        activeCount += 1;
        resolve();
        return;
      }
      pending.push(() => {
        activeCount += 1;
        resolve();
      });
    });

  return async <T>(lookup: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await lookup();
    } finally {
      activeCount -= 1;
      pending.shift()?.();
    }
  };
}

async function resolveBatchWithFailureIsolation(
  batch: ReservationAwardLookupBatch,
  batchLookup: ReservationAwardBatchLookup,
  singleLookup: ReservationAwardSingleLookup | undefined,
  limitSingleLookup: ReservationAwardLookupLimiter,
): Promise<Record<string, string | null>> {
  try {
    // A fulfilled all-null record is a legitimate no-award result. Only a
    // rejected batch is ambiguous enough to require per-ID failure isolation.
    return await batchLookup(batch.restaurantIds, batch.representativeTimestamp);
  } catch {
    if (!singleLookup) {
      return {};
    }
  }

  const isolatedEntries = await Promise.all(
    batch.restaurantIds.map((restaurantId) =>
      limitSingleLookup(async () => {
        try {
          return [restaurantId, await singleLookup(restaurantId, batch.representativeTimestamp)] as const;
        } catch {
          return [restaurantId, null] as const;
        }
      }),
    ),
  );
  return Object.fromEntries(isolatedEntries);
}

/**
 * Resolve one output per input with bounded batch queries per local year.
 * Rejected batches fall back to globally concurrency-limited single lookups;
 * fulfilled all-null batches remain successful no-award results.
 */
export async function resolveReservationAwardsInBatches(
  inputs: readonly ReservationAwardLookupInput[],
  batchLookup: ReservationAwardBatchLookup,
  singleLookup?: ReservationAwardSingleLookup,
): Promise<Array<string | null>> {
  const plan = buildReservationAwardLookupPlan(inputs);
  const limitSingleLookup = createLookupLimiter(RESERVATION_AWARD_SINGLE_LOOKUP_CONCURRENCY);
  const batchResults = await Promise.all(
    plan.batches.map(async (batch) => ({
      localYear: batch.localYear,
      awards: await resolveBatchWithFailureIsolation(batch, batchLookup, singleLookup, limitSingleLookup),
    })),
  );
  const awardsByYear = new Map<number, Record<string, string | null>>();
  for (const result of batchResults) {
    const existingAwards = awardsByYear.get(result.localYear);
    if (existingAwards) {
      Object.assign(existingAwards, result.awards);
    } else {
      awardsByYear.set(result.localYear, { ...result.awards });
    }
  }

  return inputs.map((input, index) => {
    const restaurantId = input.restaurantId;
    if (!restaurantId?.startsWith("michelin-")) {
      return null;
    }
    const localYear = plan.localYearsByInputIndex[index];
    if (localYear === null) {
      return null;
    }
    const awards = awardsByYear.get(localYear);
    return awards?.[restaurantId] ?? null;
  });
}

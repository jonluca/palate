export const DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY = 4;
export const MAX_PROVIDER_RESERVATION_LOCATION_CONCURRENCY = 8;

export interface ProviderReservationLocationInput {
  readonly restaurantName: string;
  readonly address: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface ProviderReservationLocationCandidate {
  readonly latitude: number;
  readonly longitude: number;
  readonly address?: string | null;
}

export type LocatedProviderReservation<T extends ProviderReservationLocationInput> = T & {
  readonly latitude: number;
  readonly longitude: number;
};

export interface ProviderReservationLocationDependencies<T extends ProviderReservationLocationInput> {
  readonly searchPlaces: (query: string) => Promise<readonly ProviderReservationLocationCandidate[]>;
  readonly findLocalFallback: (reservation: T) => ProviderReservationLocationCandidate | null;
}

export interface ProviderReservationLocationOptions {
  readonly concurrency?: number;
}

/** Build the exact text query used by the existing provider import path. */
export function getProviderReservationPlaceQuery(reservation: ProviderReservationLocationInput): string {
  return [reservation.restaurantName, reservation.address].filter(Boolean).join(" ");
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PROVIDER_RESERVATION_LOCATION_CONCURRENCY;
  }

  return Math.min(MAX_PROVIDER_RESERVATION_LOCATION_CONCURRENCY, Math.max(1, Math.floor(value)));
}

function hasDirectCoordinates<T extends ProviderReservationLocationInput>(
  reservation: T,
): reservation is LocatedProviderReservation<T> {
  return reservation.latitude !== null && reservation.longitude !== null;
}

function applyLocation<T extends ProviderReservationLocationInput>(
  reservation: T,
  location: ProviderReservationLocationCandidate,
): LocatedProviderReservation<T> {
  return {
    ...reservation,
    latitude: location.latitude,
    longitude: location.longitude,
    address: reservation.address ?? location.address ?? null,
  };
}

async function searchWithEmptyResultOnFailure(
  query: string,
  searchPlaces: ProviderReservationLocationDependencies<ProviderReservationLocationInput>["searchPlaces"],
): Promise<readonly ProviderReservationLocationCandidate[]> {
  try {
    return await searchPlaces(query);
  } catch {
    // The production Places adapter exposes failures as an empty result. Preserve
    // that contract for injected adapters so local fallback behavior stays exact.
    return [];
  }
}

async function runBoundedLocationJobs<Job, Result>(
  jobs: readonly Job[],
  concurrency: number,
  execute: (job: Job) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(jobs.length);
  let nextJobIndex = 0;
  const workerCount = Math.min(concurrency, jobs.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const jobIndex = nextJobIndex;
      nextJobIndex += 1;
      if (jobIndex >= jobs.length) {
        return;
      }
      results[jobIndex] = await execute(jobs[jobIndex]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Locate provider reservations with successful exact-query request coalescing and
 * bounded concurrency. If a shared attempt is empty or rejected, later duplicate
 * occurrences receive independent bounded attempts so transient failures cannot
 * poison the group. The result has one stable-order entry per input;
 * direct-coordinate inputs retain identity and unresolved inputs become null.
 */
export async function resolveProviderReservationLocations<T extends ProviderReservationLocationInput>(
  reservations: readonly T[],
  dependencies: ProviderReservationLocationDependencies<T>,
  options: ProviderReservationLocationOptions = {},
): Promise<Array<LocatedProviderReservation<T> | null>> {
  const queryByInputIndex = reservations.map((reservation) =>
    hasDirectCoordinates(reservation) ? null : getProviderReservationPlaceQuery(reservation),
  );
  const inputIndicesByQuery = new Map<string, number[]>();
  for (let inputIndex = 0; inputIndex < queryByInputIndex.length; inputIndex++) {
    const query = queryByInputIndex[inputIndex];
    if (!query) {
      continue;
    }
    const inputIndices = inputIndicesByQuery.get(query);
    if (inputIndices) {
      inputIndices.push(inputIndex);
    } else {
      inputIndicesByQuery.set(query, [inputIndex]);
    }
  }

  const concurrency = normalizeConcurrency(options.concurrency);
  const uniqueQueries = [...inputIndicesByQuery.keys()];
  const initialResults = await runBoundedLocationJobs(uniqueQueries, concurrency, (query) =>
    searchWithEmptyResultOnFailure(query, dependencies.searchPlaces),
  );
  const initialPlacesByQuery = new Map(
    uniqueQueries.map((query, index) => [query, initialResults[index] ?? []] as const),
  );

  const retryJobs: Array<{ readonly inputIndex: number; readonly query: string }> = [];
  for (const [query, inputIndices] of inputIndicesByQuery) {
    if (initialPlacesByQuery.get(query)?.[0]) {
      continue;
    }
    for (let occurrenceIndex = 1; occurrenceIndex < inputIndices.length; occurrenceIndex++) {
      retryJobs.push({ inputIndex: inputIndices[occurrenceIndex]!, query });
    }
  }
  retryJobs.sort((a, b) => a.inputIndex - b.inputIndex);
  const retryResults = await runBoundedLocationJobs(retryJobs, concurrency, (job) =>
    searchWithEmptyResultOnFailure(job.query, dependencies.searchPlaces),
  );
  const retryPlacesByInputIndex = new Map(
    retryJobs.map((job, index) => [job.inputIndex, retryResults[index] ?? []] as const),
  );

  return reservations.map((reservation, index) => {
    if (hasDirectCoordinates(reservation)) {
      return reservation;
    }

    const query = queryByInputIndex[index]!;
    const inputIndices = query ? inputIndicesByQuery.get(query) : undefined;
    const isFirstQueryOccurrence = inputIndices?.[0] === index;
    const initialPlace = query ? initialPlacesByQuery.get(query)?.[0] : undefined;
    const place = initialPlace ?? (isFirstQueryOccurrence ? undefined : retryPlacesByInputIndex.get(index)?.[0]);
    if (place) {
      return applyLocation(reservation, place);
    }

    const fallback = dependencies.findLocalFallback(reservation);
    return fallback ? applyLocation(reservation, fallback) : null;
  });
}

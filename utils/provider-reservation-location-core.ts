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
    // Try the local guide after a failed request. Outcomes live only for this
    // invocation, so a later import attempt can retry the same query.
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
 * Locate provider reservations with one bounded request per exact query,
 * including queries that return no matches or fail. The result has one entry per input;
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
  const concurrency = normalizeConcurrency(options.concurrency);
  const uniqueQueries = [...new Set(queryByInputIndex.filter((query): query is string => Boolean(query)))];
  const results = await runBoundedLocationJobs(uniqueQueries, concurrency, (query) =>
    searchWithEmptyResultOnFailure(query, dependencies.searchPlaces),
  );
  const placesByQuery = new Map(uniqueQueries.map((query, index) => [query, results[index] ?? []] as const));

  return reservations.map((reservation, index) => {
    if (hasDirectCoordinates(reservation)) {
      return reservation;
    }

    const query = queryByInputIndex[index]!;
    const place = query ? placesByQuery.get(query)?.[0] : undefined;
    if (place) {
      return applyLocation(reservation, place);
    }

    const fallback = dependencies.findLocalFallback(reservation);
    return fallback ? applyLocation(reservation, fallback) : null;
  });
}

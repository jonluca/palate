import type { ReservationOnlyVisitInput } from "./db/types";

type DedupeVisit = Pick<
  ReservationOnlyVisitInput,
  "startTime" | "endTime" | "suggestedRestaurantId" | "sourceLocation"
>;

/**
 * Preserve the first matching visit and the existing replacement rules while
 * comparing only visits with the same restaurant key. Keys are computed once per
 * input. Bucket indices retain insertion order even when a visit is replaced.
 */
export function dedupeReservationOnlyVisits<Visit extends DedupeVisit>(
  visits: readonly Visit[],
  getDedupeKey: (visit: Visit) => string,
  timeBufferMs: number,
) {
  const sorted = [...visits].sort((a, b) => a.startTime - b.startTime);
  const deduped: Visit[] = [];
  const indicesByKey = new Map<string, number[]>();
  let duplicateCount = 0;

  for (const visit of sorted) {
    const key = getDedupeKey(visit);
    // An empty restaurant key was never eligible for deduplication.
    const indices = key ? indicesByKey.get(key) : undefined;
    let duplicateIndex = -1;
    if (indices) {
      for (const index of indices) {
        const existing = deduped[index];
        if (existing.startTime <= visit.endTime + timeBufferMs && existing.endTime >= visit.startTime - timeBufferMs) {
          duplicateIndex = index;
          break;
        }
      }
    }

    if (duplicateIndex === -1) {
      if (key) {
        if (indices) {
          indices.push(deduped.length);
        } else {
          indicesByKey.set(key, [deduped.length]);
        }
      }
      deduped.push(visit);
      continue;
    }

    duplicateCount += 1;
    const existing = deduped[duplicateIndex];
    if (
      (visit.suggestedRestaurantId ? 1 : 0) > (existing.suggestedRestaurantId ? 1 : 0) ||
      (visit.sourceLocation ? 1 : 0) > (existing.sourceLocation ? 1 : 0)
    ) {
      deduped[duplicateIndex] = visit;
    }
  }

  return { visits: deduped.sort((a, b) => b.startTime - a.startTime), duplicateCount };
}

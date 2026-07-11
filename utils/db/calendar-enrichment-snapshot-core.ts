export interface CalendarEnrichmentSuggestedRestaurant {
  readonly id: string;
  readonly name: string;
}

export interface CalendarEnrichmentVisitSnapshot {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly suggestedRestaurants: CalendarEnrichmentSuggestedRestaurant[];
}

export interface CalendarEnrichmentSnapshotRow {
  readonly visitId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly suggestedRestaurantId: string | null;
  readonly suggestedRestaurantName: string | null;
}

/**
 * One read snapshot for Calendar enrichment. The former path loaded visits,
 * then issued one full Michelin hydration query per 300 visits even though the
 * native matcher only consumes suggestion IDs and names.
 */
export const CALENDAR_ENRICHMENT_SNAPSHOT_SQL = `SELECT
  v.id AS visitId,
  v.startTime,
  v.endTime,
  m.id AS suggestedRestaurantId,
  m.name AS suggestedRestaurantName
FROM visits v
LEFT JOIN visit_suggested_restaurants vsr ON vsr.visitId = v.id
LEFT JOIN michelin_restaurants m ON m.id = vsr.restaurantId
WHERE v.calendarEventId IS NULL
-- Explicit rowid tie-breakers retain the former queries' index/temp-sort
-- encounter order instead of changing ambiguous equal-time/equal-distance wins.
ORDER BY v.startTime DESC, v.rowid ASC, vsr.distance ASC, vsr.rowid ASC`;

/** Groups the ordered joined rows without transferring unused guide fields. */
export function buildCalendarEnrichmentVisitSnapshot(
  rows: readonly CalendarEnrichmentSnapshotRow[],
): CalendarEnrichmentVisitSnapshot[] {
  const visits: CalendarEnrichmentVisitSnapshot[] = [];
  const visitsById = new Map<string, CalendarEnrichmentVisitSnapshot>();

  for (const row of rows) {
    let visit = visitsById.get(row.visitId);
    if (!visit) {
      visit = {
        id: row.visitId,
        startTime: row.startTime,
        endTime: row.endTime,
        suggestedRestaurants: [],
      };
      visitsById.set(row.visitId, visit);
      visits.push(visit);
    } else if (visit.startTime !== row.startTime || visit.endTime !== row.endTime) {
      throw new Error(`Calendar enrichment snapshot returned inconsistent times for visit ${row.visitId}`);
    }

    // An absent Michelin join has the same semantics as the former INNER JOIN
    // suggestion query: retain the visit, but expose no orphaned suggestion.
    if (row.suggestedRestaurantId === null || row.suggestedRestaurantName === null) {
      continue;
    }
    visit.suggestedRestaurants.push({
      id: row.suggestedRestaurantId,
      name: row.suggestedRestaurantName,
    });
  }

  return visits;
}

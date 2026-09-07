import { CALENDAR_ENRICHMENT_SNAPSHOT_SQL } from "./calendar-enrichment-snapshot-core.ts";

export const CALENDAR_ENRICHMENT_CACHE_TABLE = "calendar_enrichment_attempts";
export const CALENDAR_ENRICHMENT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const CREATE_CALENDAR_ENRICHMENT_CACHE_SQL = `CREATE TABLE IF NOT EXISTS calendar_enrichment_attempts (
  visitId TEXT PRIMARY KEY NOT NULL,
  context TEXT NOT NULL,
  startTime INTEGER NOT NULL,
  endTime INTEGER NOT NULL,
  checkedAt INTEGER NOT NULL,
  FOREIGN KEY (visitId) REFERENCES visits(id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS invalidate_calendar_attempt_after_suggestion_insert
AFTER INSERT ON visit_suggested_restaurants BEGIN
  DELETE FROM calendar_enrichment_attempts WHERE visitId = NEW.visitId;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_calendar_attempt_after_suggestion_update
AFTER UPDATE ON visit_suggested_restaurants BEGIN
  DELETE FROM calendar_enrichment_attempts WHERE visitId IN (OLD.visitId, NEW.visitId);
END;
CREATE TRIGGER IF NOT EXISTS invalidate_calendar_attempt_after_suggestion_delete
AFTER DELETE ON visit_suggested_restaurants BEGIN
  DELETE FROM calendar_enrichment_attempts WHERE visitId = OLD.visitId;
END;`;

/** Null context preserves full matching on binaries without calendar revision support. */
export function buildIncrementalCalendarEnrichmentQuery(context: string | null, now: number) {
  if (context === null) {
    return { sql: CALENDAR_ENRICHMENT_SNAPSHOT_SQL, parameters: [] };
  }
  return {
    sql: CALENDAR_ENRICHMENT_SNAPSHOT_SQL.replace(
      "WHERE v.calendarEventId IS NULL",
      `WHERE v.calendarEventId IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM calendar_enrichment_attempts AS attempt
          WHERE attempt.visitId = v.id AND attempt.context = ?1
            AND attempt.startTime = v.startTime AND attempt.endTime = v.endTime
            AND attempt.checkedAt >= ?2 AND attempt.checkedAt <= ?3
        )`,
    ),
    parameters: [context, now - CALENDAR_ENRICHMENT_CACHE_MAX_AGE_MS, now],
  };
}

/** Store the times actually matched so a concurrent visit edit cannot be marked examined. */
export const RECORD_CALENDAR_ENRICHMENT_ATTEMPTS_SQL = `INSERT INTO calendar_enrichment_attempts
  (visitId, context, startTime, endTime, checkedAt)
SELECT json_extract(snapshot.value, '$.id'), ?2,
  json_extract(snapshot.value, '$.startTime'), json_extract(snapshot.value, '$.endTime'), ?3
FROM json_each(?1) AS snapshot
WHERE EXISTS (
  SELECT 1 FROM visits WHERE id = json_extract(snapshot.value, '$.id')
    AND calendarEventId IS NULL
    AND startTime = json_extract(snapshot.value, '$.startTime')
    AND endTime = json_extract(snapshot.value, '$.endTime')
)
AND (
  SELECT json_group_array(json_object('id', id, 'name', name)) FROM (
    SELECT m.id, m.name FROM visit_suggested_restaurants AS suggestion
    INNER JOIN michelin_restaurants AS m ON m.id = suggestion.restaurantId
    WHERE suggestion.visitId = json_extract(snapshot.value, '$.id')
    ORDER BY suggestion.distance ASC, suggestion.rowid ASC
  )
) = json_extract(snapshot.value, '$.suggestedRestaurants')
ON CONFLICT(visitId) DO UPDATE SET
  context = excluded.context, startTime = excluded.startTime,
  endTime = excluded.endTime, checkedAt = excluded.checkedAt`;

export const INVALIDATE_VISIT_CALENDAR_ATTEMPTS_SQL = `DELETE FROM calendar_enrichment_attempts
WHERE visitId IN (SELECT value FROM json_each(?))`;

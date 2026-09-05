import type { VisitWithDetails } from "./types";
import { parseVisitQueryRow, type VisitQueryRow } from "./visit-record-core.ts";
import { isJsonString, parseJsonValue } from "../runtime-json.ts";
import type { VisitListFilter } from "../visit-status.ts";

export type VisitDetailsFilter = VisitListFilter;

export interface VisitDetailsQuery {
  readonly sql: string;
  readonly parameters: (string | number)[];
}

export type VisitDetailsQueryRow = VisitQueryRow & {
  restaurantName: string | null;
  suggestedRestaurantName: string | null;
  suggestedRestaurantAward: string | null;
  previewPhotosJson: string | null;
};

const PREVIEW_PHOTO_PRIORITY_SQL =
  "CASE WHEN p.foodDetected = 1 THEN 0 WHEN p.foodDetected = 0 THEN 1 ELSE 2 END ASC, p.creationTime ASC, p.id ASC";

/**
 * Builds the complete visit-details query, including each visit's top-three
 * preview URIs. The correlated lookup avoids a second query containing every
 * visit ID and lets SQLite use the visit-leading photo index for each visit.
 */
export function buildVisitsWithDetailsQuery(filter?: VisitDetailsFilter): VisitDetailsQuery {
  let whereClause = "";
  const parameters: (string | number)[] = [];

  if (filter === "food") {
    whereClause = "WHERE c.foodProbable = 1";
  } else if (filter) {
    whereClause = "WHERE c.status = ?";
    parameters.push(filter);
  }

  return {
    sql: `SELECT c.*,
                 r.name AS restaurantName,
                 m.name AS suggestedRestaurantName,
                 COALESCE(c.awardAtVisit, m.award) AS suggestedRestaurantAward,
                 (
                   SELECT json_group_array(uri)
                   FROM (
                     SELECT p.uri
                     FROM photos p
                     WHERE p.visitId = c.id
                     ORDER BY ${PREVIEW_PHOTO_PRIORITY_SQL}
                     LIMIT 3
                   )
                 ) AS previewPhotosJson
          FROM visits c
          LEFT JOIN restaurants r ON c.restaurantId = r.id
          LEFT JOIN michelin_restaurants m ON c.suggestedRestaurantId = m.id
          ${whereClause}
          ORDER BY c.startTime DESC, c.id COLLATE BINARY DESC`,
    parameters,
  };
}

function parsePreviewPhotos(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = parseJsonValue(value);
    return Array.isArray(parsed) && parsed.every(isJsonString) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseVisitDetailsRows(rows: readonly VisitDetailsQueryRow[]): VisitWithDetails[] {
  return rows.map((row) => {
    const { previewPhotosJson, ...visit } = row;
    return {
      ...parseVisitQueryRow(visit),
      previewPhotos: parsePreviewPhotos(previewPhotosJson),
    };
  });
}

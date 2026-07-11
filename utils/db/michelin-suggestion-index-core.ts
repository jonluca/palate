export interface MichelinSuggestionLocation {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface MichelinSuggestionLocationReader {
  getAllAsync<Row>(source: string): Promise<Row[]>;
}

/** Maximum distance for the primary Michelin suggestion. */
export const MICHELIN_PRIMARY_MATCH_RADIUS_METERS = 100;

/** Maximum distance for the list of nearby Michelin suggestions. */
export const MICHELIN_SUGGESTION_RADIUS_METERS = 200;

/** Maximum number of Michelin suggestions stored for one visit. */
export const MICHELIN_SUGGESTION_LIMIT = 5;

export const ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL = `SELECT m.id, m.latitude, m.longitude
  FROM michelin_restaurants m
  JOIN app_metadata metadata
    ON metadata.key = 'michelin_dataset_version'
   AND m.datasetVersion = metadata.value`;

export function loadActiveMichelinSuggestionLocations(
  database: MichelinSuggestionLocationReader,
): Promise<MichelinSuggestionLocation[]> {
  return database.getAllAsync<MichelinSuggestionLocation>(ACTIVE_MICHELIN_SUGGESTION_LOCATIONS_SQL);
}

export const APPLICATION_DATABASE_TABLES = [
  // Clear photo-history checkpoints before a partial reset can remove photo rows.
  "app_metadata",
  "michelin_restaurant_spatial_index",
  "visit_suggested_restaurants",
  "automatic_photo_deep_scan_queue",
  "calendar_enrichment_attempts",
  "photos",
  "reservation_import_sources",
  "visits",
  "restaurants",
  "michelin_restaurants",
  "ignored_locations",
  "dismissed_reservation_import_sources",
  "reservation_import_review_exclusions",
  "dismissed_calendar_events",
  "food_keywords",
] as const;

export interface DatabaseResetExecutor {
  readonly execAsync: (source: string) => Promise<void>;
}

export const DROP_APPLICATION_DATABASE_TABLES_SQL = APPLICATION_DATABASE_TABLES.map(
  (table) => `DROP TABLE IF EXISTS ${table};`,
).join("\n");

/** Drops every app-owned table and restores FK enforcement even if a drop fails. */
export async function dropApplicationDatabaseTables(database: DatabaseResetExecutor): Promise<void> {
  await database.execAsync("PRAGMA foreign_keys = OFF;");
  try {
    await database.execAsync(DROP_APPLICATION_DATABASE_TABLES_SQL);
  } finally {
    await database.execAsync("PRAGMA foreign_keys = ON;");
  }
}

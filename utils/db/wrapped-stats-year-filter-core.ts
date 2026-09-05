export interface WrappedStatsYearFilter {
  readonly sql: string;
  readonly parameters: (number | string)[];
}

/**
 * Bound selected-year reads with the existing (status, startTime) index.
 * Keep SQLite's local-year predicate authoritative: a padded UTC range admits
 * every time-zone offset as well as SQLite's fractional-second rounding at
 * New Year, without converting each row from every other year to local time.
 */
export function buildWrappedStatsYearFilter(
  year?: number | null,
  column: "startTime" | "v.startTime" = "startTime",
): WrappedStatsYearFilter {
  if (!year) {
    return { sql: "", parameters: [] };
  }

  const localYearSql = `AND strftime('%Y', datetime(${column}/1000, 'unixepoch', 'localtime')) = ?`;
  // Preserve the previous filter behavior for values that cannot be a
  // four-digit SQLite year, including fractional and non-finite inputs.
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    return { sql: localYearSql, parameters: [String(year)] };
  }

  const paddingMs = 2 * 24 * 60 * 60 * 1000;
  return {
    sql: `AND ${column} >= ? AND ${column} < ? ${localYearSql}`,
    parameters: [Date.UTC(year, 0, 1) - paddingMs, Date.UTC(year + 1, 0, 1) + paddingMs, String(year)],
  };
}

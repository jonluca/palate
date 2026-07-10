export type VisitStatus = "pending" | "confirmed" | "rejected";

export interface VisitStatusBatchStatement {
  readonly sql: string;
  readonly parameters: [status: VisitStatus, updatedAt: number, visitIdsJson: string];
  readonly requestedCount: number;
}

const VALID_VISIT_STATUSES = new Set<VisitStatus>(["pending", "confirmed", "rejected"]);

/**
 * Build one set-based update for a bulk status action. A JSON parameter avoids
 * SQLite's variable limit while keeping identifiers fully parameterized.
 */
export function buildVisitStatusBatchStatement(
  visitIds: readonly string[],
  status: VisitStatus,
  updatedAt: number,
): VisitStatusBatchStatement | null {
  if (visitIds.length === 0) {
    return null;
  }
  if (!VALID_VISIT_STATUSES.has(status)) {
    throw new RangeError(`Unsupported visit status: ${String(status)}.`);
  }
  if (!Number.isFinite(updatedAt)) {
    throw new RangeError(`updatedAt must be finite; received ${updatedAt}.`);
  }
  for (const visitId of visitIds) {
    if (typeof visitId !== "string") {
      throw new TypeError("Visit status batches require string visit IDs.");
    }
  }

  const visitIdsJson = JSON.stringify(visitIds);
  return {
    sql: `UPDATE visits
      SET status = ?, updatedAt = ?
      WHERE id IN (
        SELECT value
        FROM json_each(?)
        WHERE type = 'text'
      )`,
    parameters: [status, updatedAt, visitIdsJson],
    requestedCount: visitIds.length,
  };
}

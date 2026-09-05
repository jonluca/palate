/** Persisted visit statuses; keep these literals stable across database and export boundaries. */
export const VISIT_STATUSES = ["pending", "confirmed", "rejected"] as const;

export type VisitStatus = (typeof VISIT_STATUSES)[number];
export type VisitListFilter = VisitStatus | "food";
export type VisitStatusFilter = VisitStatus | "all";

/** Validate stored status text without normalizing case or whitespace. */
export function isVisitStatus(value: string): value is VisitStatus {
  return VISIT_STATUSES.some((status) => value === status);
}

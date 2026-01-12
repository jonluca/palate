import type { ExactCalendarMatch, PendingVisitForReview } from "@/hooks/queries";

export type ReviewTab = "all" | "exact" | "other";

export interface ExactMatchItem {
  match: ExactCalendarMatch;
  visit: PendingVisitForReview;
}

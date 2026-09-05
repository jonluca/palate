import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PendingVisitReviewMatchTools } from "../utils/db/visit-review-paging-core.ts";
import {
  cleanCalendarEventTitle,
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
} from "../utils/restaurant-name-matching.ts";

export const BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS: PendingVisitReviewMatchTools = {
  cleanCalendarEventTitle,
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
};

export interface CalendarTitleMatchingSourceAttestation {
  readonly source: "utils/restaurant-name-matching.ts";
  readonly sourceSha256: string;
  readonly implementation: "production TypeScript module";
}

export function getCalendarTitleMatchingSourceAttestation(): CalendarTitleMatchingSourceAttestation {
  const source = readFileSync(new URL("../utils/restaurant-name-matching.ts", import.meta.url), "utf8");
  return {
    source: "utils/restaurant-name-matching.ts",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    implementation: "production TypeScript module",
  };
}

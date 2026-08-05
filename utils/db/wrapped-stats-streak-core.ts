import type { WrappedStats } from "./types";
import { parseLocalDateInput } from "../local-date.ts";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface WrappedStatsVisitDate {
  readonly date: string;
}

function getLocalCalendarDayOrdinal(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MILLISECONDS_PER_DAY;
}

export function calculateLongestDiningStreak(
  visitDates: readonly WrappedStatsVisitDate[],
): WrappedStats["longestStreak"] {
  if (visitDates.length === 0) {
    return null;
  }

  let currentStreak = 1;
  let maxStreak = 1;
  let streakStart = parseLocalDateInput(visitDates[0].date)!.getTime();
  let maxStreakStart = streakStart;
  let maxStreakEnd = streakStart;

  for (let index = 1; index < visitDates.length; index++) {
    const previousDate = parseLocalDateInput(visitDates[index - 1].date)!;
    const currentDate = parseLocalDateInput(visitDates[index].date)!;
    const calendarDayDifference = getLocalCalendarDayOrdinal(currentDate) - getLocalCalendarDayOrdinal(previousDate);

    if (calendarDayDifference === 1) {
      currentStreak++;
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
        maxStreakStart = streakStart;
        maxStreakEnd = currentDate.getTime();
      }
    } else {
      currentStreak = 1;
      streakStart = currentDate.getTime();
    }
  }

  return maxStreak >= 2
    ? {
        days: maxStreak,
        startDate: maxStreakStart,
        endDate: maxStreakEnd,
      }
    : null;
}

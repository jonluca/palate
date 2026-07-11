import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deburr } from "lodash-es";
import type { PendingVisitReviewMatchTools } from "../utils/db/visit-review-paging-core.ts";
import { memoize } from "../utils/memoize.ts";

const PRODUCTION_SOURCE_PATH = fileURLToPath(new URL("../services/calendar.ts", import.meta.url));
const PRODUCTION_SOURCE_START = "const CALENDAR_TITLE_PREFIXES_TO_STRIP = [";
const PRODUCTION_SOURCE_END = "export const isFuzzyRestaurantMatch = memoize(_isFuzzyRestaurantMatch);";
const EXPECTED_PRODUCTION_SOURCE_SHA256 = "d35e678969ad647061e9849eb6d64b0895d3ed09106fa5fe6da57b8bfe9f4586";

// This benchmark-only mirror lets Node exercise the same pure title semantics
// without loading Expo Calendar or the React Native module graph. The source
// slice hash above forces an explicit review whenever production semantics move.
const CALENDAR_TITLE_PREFIXES_TO_STRIP = [
  /^resevervation\s+(at|for|@)\s+/i,
  /^reservation\s+(at|for|@)\s+/i,
  /^booking\s+appointment\s+(at|for|@)\s+/i,
  /^resy\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^opentable\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^yelp\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^tock\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^seated\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^bookatable\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^quandoo\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^the\s+fork\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^exploretock\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^sevenrooms\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^tripleseat\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^tablein\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^eat\s*app\s*[-:@]?\s*(reservation\s+(at|for|@)?\s*)?/i,
  /^via\s+(resy|opentable|tock|yelp)\s*[-:@]?\s*/i,
  /^(dinner|lunch|brunch|breakfast|supper|tea|coffee|happy\s*hour|drinks|appetizers)\s+(at|@)\s+/i,
  /^(dinner|lunch|brunch|breakfast|supper)\s+reservation\s+(at|for|@)?\s*/i,
  /^(date\s*night|anniversary|birthday|celebration|celebrate|party)\s+(at|@)\s+/i,
  /^(date\s*night|anniversary|birthday|celebration)\s+dinner\s+(at|@)?\s*/i,
  /^\d{1,2}:?\d{0,2}\s*(am|pm)?\s+(at|@)\s+/i,
  /^(eating\s+)?at\s+/i,
  /^(going\s+to|meet\s+at|meeting\s+at|dining\s+at)\s+/i,
  /^meal\s+(at|@)\s+/i,
  /^table\s+(at|for|@)\s+/i,
  /^booking\s+(at|for|@)\s+/i,
  /^your\s+(reservation|table|booking)\s+(at|for|@)\s+/i,
  /^ticket:\s+/i,
  /^reservation\s*:\s+/i,
  /^confirmation\s*:\s+/i,
  /^confirmed\s*:\s+/i,
  /^booking\s*:\s+/i,
  /^reminder\s*:\s+/i,
  /^don'?t\s+forget\s*:\s+/i,
  /^event\s+(at|@)\s+/i,
  /^upcoming reservation (at|for|@)\s+/i,
  /^reservation\s+(at|for|@)\s+/i,
  /^dinner\s*\|/i,
  /^cena\s*\|/i,
  /^(pranzo|almuerzo|déjeuner|mittagessen|almoço)\s+(at|@|a|à|en|bei|em)?\s*/i,
  /^(cena|comida|dîner|abendessen|jantar)\s+(at|@|a|à|en|bei|em)?\s*/i,
  /^(colazione|desayuno|petit\s*déjeuner|frühstück|café\s*da\s*manhã)\s+(at|@|a|à|en|bei|em)?\s*/i,
  /^[🍴🍕🍔🍣🍜🥘🍝🍲🥗🍛🍱🥡🍷🍺🍸🥂🍾☕🍵🍽]\s*/u,
];

const CALENDAR_TITLE_SUFFIXES_TO_STRIP = [
  /\s*[-–—]\s*\d+\s*(people|guests|pax|persons?)$/i,
  /\s*[-–—]\s*table\s+for\s+\d+$/i,
  /\s*[-–—]\s*party\s+of\s+\d+$/i,
  /\s*\(\d+\s*(people|guests|pax|persons?)\)$/i,
  /\s*\(party\s+of\s+\d+\)$/i,
  /\s*\(table\s+for\s+\d+\)$/i,
  /\s*\(for\s+\d+\)$/i,
  /\s*for\s+\d+$/i,
  /\s*(dinner|lunch|brunch|cena|breakfast|supper)\s*$/i,
  /\s*[-–—]\s*(confirmed|pending|waitlist|wait\s*list)$/i,
  /\s*\((confirmed|pending|waitlist|wait\s*list)\)$/i,
  /\s*[-–—]\s*\d{1,2}:\d{2}\s*(am|pm)?$/i,
  /\s*@\s*\d{1,2}:\d{2}\s*(am|pm)?$/i,
  /\s*on\s+\w+\s*,\s*\w+\s+\d{1,2}(st|nd|rd|th)?\s*,\s*\d{4}\s*,?\s*\d{1,2}:\d{2}\s*(AM|PM)?$/i,
  /\s*[-–—]\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?$/i,
  /\s*[-–—]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(st|nd|rd|th)?$/i,
  /\s*\((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(st|nd|rd|th)?\)$/i,
  /\s*[-–—]\s*(conf|confirmation)\s*#?\s*[\w\d]+$/i,
  /\s*\(confirmation\s*:?\s*[\w\d]+\)$/i,
  /\s*\(reservation\s*:?\s*[\w\d]+\)$/i,
  /\s*\(booking\s*:?\s*[\w\d]+\)$/i,
  /\s*#\s*[\w\d]{4,}$/i,
  /\s*[-–—]\s*w\/?\s+\w+.*$/i,
  /\s*[-–—]\s*with\s+\w+.*$/i,
  /\s*\(w\/?\s+\w+.*\)$/i,
  /\s*\(with\s+\w+.*\)$/i,
  /\s*[-–—]\s*via\s+(resy|opentable|tock|yelp|thefork)$/i,
  /\s*\(via\s+(resy|opentable|tock|yelp|thefork)\)$/i,
  /\s*\((resy|opentable|tock|yelp|thefork)\)$/i,
  /\s*[-–—]\s*(downtown|midtown|uptown|westside|eastside)$/i,
  /\s*[-–—]\s*(main|flagship|original)\s*(location|branch)?$/i,
  /\s+reservation$/i,
  /\s+booking$/i,
];

const COMPARISON_SUFFIX_DESCRIPTOR_TERMS = [
  "wine\\s+bar",
  "cocktail\\s+bar",
  "steak\\s?house",
  "restaurant",
  "gourmet",
  "cafe",
  "café",
  "bar",
  "bistro",
  "kitchen",
  "grill",
  "company",
  "brewing",
  "house",
  "japanese",
  "farm",
  "inn",
  "room",
  "place",
  "experience",
  "eatery",
  "dining",
  "tavern",
  "pub",
  "pizzeria",
  "trattoria",
  "osteria",
  "ristorante",
  "brasserie",
  "chophouse",
  "seafood",
  "sushi",
  "ramen",
  "izakaya",
  "taqueria",
  "cantina",
  "bodega",
  "diner",
  "lounge",
  "gastropub",
  "bakery",
  "patisserie",
  "delicatessen",
  "deli",
  "creamery",
  "rooftop",
  "terrace",
  "garden",
  "spot",
  "joint",
  "shack",
  "club",
];
const COMPARISON_SUFFIX_DESCRIPTOR_PATTERN = COMPARISON_SUFFIX_DESCRIPTOR_TERMS.join("|");
const COMPARISON_SUFFIXES_TO_STRIP = [
  new RegExp(
    `\\s+(?:${COMPARISON_SUFFIX_DESCRIPTOR_PATTERN})(?:\\s+(?:(?:and|&|/)\\s+)?(?:${COMPARISON_SUFFIX_DESCRIPTOR_PATTERN}))*\\s*$`,
    "i",
  ),
  /\s+(nyc|la|sf|london|dc|atl|chi|bos|sea|pdx|phx|den|mia|dal|hou|austin)\s*$/i,
  /^the\s+/i,
];
const COMPARISON_PREFIXES_TO_STRIP = [
  /^reservation\s+(at|for|@)\s+/i,
  /^upcoming reservation (at|for|@)\s+/i,
  /^reservation\s*:\s+/i,
  /^the\s+(dining room|dining hall|experience|kitchen table|table)?\s*(at)?\s*:?\s*/i,
  /^restaurant\s*:?\s*/i,
  /^bar\s*:?\s*/i,
  /^confirmation\s*:?\s+/i,
  /^booking\s*:?\s+/i,
  /^confirmed\s*:?\s+/i,
  /^dinner\s*(at|@)?\s+/i,
  /^lunch\s*(at|@)?\s+/i,
  /^brunch\s*(at|@)\s+/i,
  /^breakfast\s*(at|@)?\s+/i,
  /^supper\s+(at|@)\s+/i,
  /^meal\s+(at|@)\s+/i,
  /^table\s*(at|for|@)?\s+/i,
  /^eating\s+(at|@)\s+/i,
  /^dining\s+(at|@)\s+/i,
  /^visit\s+to\s+/i,
  /^going\s+to\s+/i,
  /^meet(ing)?\s+(at|@)\s+/i,
  /^date\s+(at|@)\s+/i,
  /^date\s+night\s+(at|@)\s+/i,
  /^anniversary\s+(at|@)\s+/i,
  /^birthday\s+(at|@)\s+/i,
  /^celebration\s+(at|@)\s+/i,
  /^the\s+/i,
  /^resy\s*[-:@]?\s*/i,
  /^opentable\s*[-:@]?\s*/i,
  /^tock\s*[-:@]?\s*/i,
  /^yelp\s*[-:@]?\s*/i,
  /^via\s+(resy|opentable|tock|yelp)\s*[-:@]?\s*/i,
];
const INSIGNIFICANT_WORDS = new Set([
  "the",
  "restaurant",
  "cafe",
  "café",
  "bar",
  "bistro",
  "kitchen",
  "grill",
  "house",
  "room",
  "place",
  "a",
  "an",
  "and",
  "&",
  "eatery",
  "dining",
  "tavern",
  "pub",
  "inn",
  "lounge",
  "spot",
  "joint",
  "diner",
  "at",
  "of",
  "in",
  "on",
  "for",
]);

function cleanCalendarEventTitle(title: string): string {
  if (!title) {
    return "";
  }
  let cleaned = title
    .trim()
    .replace(/[–—−‐‑‒―-]/g, " ")
    .replace(/\s+/g, " ");
  let previous: string;
  do {
    previous = cleaned;
    for (const pattern of CALENDAR_TITLE_PREFIXES_TO_STRIP) {
      cleaned = cleaned.replace(pattern, "");
    }
    for (const pattern of CALENDAR_TITLE_SUFFIXES_TO_STRIP) {
      cleaned = cleaned.replace(pattern, "");
    }
    cleaned = cleaned.trim();
  } while (cleaned !== previous);
  return cleaned;
}
const memoizedCleanCalendarEventTitle = memoize(cleanCalendarEventTitle);

function stripComparisonAffixes(value: string): string {
  let result = value
    .trim()
    .replace(/[–—−‐‑‒―-]/g, " ")
    .replace(/\s+/g, " ");
  let previous: string;
  do {
    previous = result;
    for (const pattern of COMPARISON_PREFIXES_TO_STRIP) {
      result = result.replace(pattern, "");
    }
    for (const pattern of COMPARISON_SUFFIXES_TO_STRIP) {
      result = result.replace(pattern, "");
    }
    result = result.trim();
  } while (result !== previous);
  return result;
}
const memoizedStripComparisonAffixes = memoize(stripComparisonAffixes);

function normalizeForComparison(value: string): string {
  return deburr(value)
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/[''’`´ʼʻ]/g, "'")
    .replace(/[–—−‐‑‒―]/g, " ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/'s\b/g, "s")
    .replace(/'/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const memoizedNormalizeForComparison = memoize(normalizeForComparison);

function compareRestaurantAndCalendarTitle(calendarTitle: string, restaurantName: string): boolean {
  if (!calendarTitle || !restaurantName) {
    return false;
  }
  const cleanedCalendar = memoizedStripComparisonAffixes(memoizedCleanCalendarEventTitle(calendarTitle));
  const cleanedRestaurant = memoizedStripComparisonAffixes(restaurantName);
  const normalizedCalendar = memoizedNormalizeForComparison(cleanedCalendar);
  const normalizedRestaurant = memoizedNormalizeForComparison(cleanedRestaurant);
  if (normalizedCalendar.length < 3 || normalizedRestaurant.length < 3) {
    return false;
  }
  if (normalizedCalendar === normalizedRestaurant) {
    return true;
  }
  return cleanedRestaurant.length >= 8 && normalizedCalendar.split(" ").some((part) => part === normalizedRestaurant);
}

function isFuzzyRestaurantMatch(left: string, right: string, threshold = 3): boolean {
  const normalizedLeft = memoizedNormalizeForComparison(left);
  const normalizedRight = memoizedNormalizeForComparison(right);
  if (normalizedLeft.length < threshold || normalizedRight.length < threshold) {
    return false;
  }
  if (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return true;
  }
  const significantWords = (value: string): string[] =>
    value.split(" ").filter((word) => word.length > 1 && !INSIGNIFICANT_WORDS.has(word));
  const leftWords = significantWords(normalizedLeft);
  const rightWords = significantWords(normalizedRight);
  if (leftWords.length > 0 && leftWords.length <= 2 && leftWords.every((word) => normalizedRight.includes(word))) {
    return true;
  }
  return rightWords.length > 0 && rightWords.length <= 2 && rightWords.every((word) => normalizedLeft.includes(word));
}

export const BENCHMARK_CALENDAR_TITLE_MATCH_TOOLS: PendingVisitReviewMatchTools = {
  cleanCalendarEventTitle: memoizedCleanCalendarEventTitle,
  isFuzzyRestaurantMatch: memoize(isFuzzyRestaurantMatch),
  compareRestaurantAndCalendarTitle: memoize(compareRestaurantAndCalendarTitle),
};

export interface CalendarTitleMatchingSourceAttestation {
  readonly source: "services/calendar.ts";
  readonly sourceSliceSha256: string;
  readonly sourceContractMatched: true;
  readonly implementation: "benchmark-only Node mirror pinned to production source slice";
}

export function assertCalendarTitleMatchingSourceContract(): CalendarTitleMatchingSourceAttestation {
  const source = readFileSync(PRODUCTION_SOURCE_PATH, "utf8");
  const start = source.indexOf(PRODUCTION_SOURCE_START);
  const endStart = source.indexOf(PRODUCTION_SOURCE_END, start);
  assert.notEqual(start, -1, "production calendar-title source start marker must exist");
  assert.notEqual(endStart, -1, "production calendar-title source end marker must exist");
  const sourceSlice = source.slice(start, endStart + PRODUCTION_SOURCE_END.length);
  const sourceSliceSha256 = createHash("sha256").update(sourceSlice).digest("hex");
  assert.equal(
    sourceSliceSha256,
    EXPECTED_PRODUCTION_SOURCE_SHA256,
    "production calendar-title semantics changed; review and update the benchmark mirror and pinned hash",
  );
  return {
    source: "services/calendar.ts",
    sourceSliceSha256,
    sourceContractMatched: true,
    implementation: "benchmark-only Node mirror pinned to production source slice",
  };
}

import { deburr } from "lodash-es";
import { memoize } from "./memoize.ts";

/**
 * Common prefixes and patterns to strip from calendar event titles
 * to extract the restaurant name.
 */
const CALENDAR_TITLE_PREFIXES_TO_STRIP = [
  // Reservation services
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
  // Common meal prefixes
  /^(dinner|lunch|brunch|breakfast|supper|tea|coffee|happy\s*hour|drinks|appetizers)\s+(at|@)\s+/i,
  /^(dinner|lunch|brunch|breakfast|supper)\s+reservation\s+(at|for|@)?\s*/i,
  // Special occasion prefixes
  /^(date\s*night|anniversary|birthday|celebration|celebrate|party)\s+(at|@)\s+/i,
  /^(date\s*night|anniversary|birthday|celebration)\s+dinner\s+(at|@)?\s*/i,
  // Time prefix patterns: "830pm at", "8:30 pm at", "8pm at <name>"
  /^\d{1,2}:?\d{0,2}\s*(am|pm)?\s+(at|@)\s+/i,
  // Simple "at" prefix
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
  // Foreign language meal prefixes
  /^(pranzo|almuerzo|déjeuner|mittagessen|almoço)\s+(at|@|a|à|en|bei|em)?\s*/i,
  /^(cena|comida|dîner|abendessen|jantar)\s+(at|@|a|à|en|bei|em)?\s*/i,
  /^(colazione|desayuno|petit\s*déjeuner|frühstück|café\s*da\s*manhã)\s+(at|@|a|à|en|bei|em)?\s*/i,
  // Emoji prefixes (common in calendar apps)
  /^[🍴🍕🍔🍣🍜🥘🍝🍲🥗🍛🍱🥡🍷🍺🍸🥂🍾☕🍵🍽]\s*/u,
];

const CALENDAR_TITLE_SUFFIXES_TO_STRIP = [
  // Reservation details
  /\s*[–—−‐‑‒―-]\s*\d+\s*(people|guests|pax|persons?)$/i,
  /\s*[–—−‐‑‒―-]\s*table\s+for\s+\d+$/i,
  /\s*[–—−‐‑‒―-]\s*party\s+of\s+\d+$/i,
  /\s*\(\d+\s*(people|guests|pax|persons?)\)$/i,
  /\s*\(party\s+of\s+\d+\)$/i,
  /\s*\(table\s+for\s+\d+\)$/i,
  /\s*\(for\s+\d+\)$/i,
  /\s*for\s+\d+$/i,
  /\s*(dinner|lunch|brunch|cena|breakfast|supper)\s*$/i,
  // Status suffixes
  /\s*[–—−‐‑‒―-]\s*(confirmed|pending|waitlist|wait\s*list)$/i,
  /\s*\((confirmed|pending|waitlist|wait\s*list)\)$/i,
  // Time suffixes
  /\s*[–—−‐‑‒―-]\s*\d{1,2}:\d{2}\s*(am|pm)?$/i,
  /\s*@\s*\d{1,2}:\d{2}\s*(am|pm)?$/i,
  // Full date with year and time: "on Wednesday, November 29, 2023, 8:45 PM"
  /\s*on\s+\w+\s*,\s*\w+\s+\d{1,2}(st|nd|rd|th)?\s*,\s*\d{4}\s*,?\s*\d{1,2}:\d{2}\s*(AM|PM)?$/i,
  // Date patterns: "12/25", "Dec 25", "December 25th"
  /\s*[–—−‐‑‒―-]\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?$/i,
  /\s*[–—−‐‑‒―-]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(st|nd|rd|th)?$/i,
  /\s*\((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(st|nd|rd|th)?\)$/i,
  // Confirmation numbers
  /\s*[–—−‐‑‒―-]\s*(conf|confirmation)\s*#?\s*[\w\d]+$/i,
  /\s*\(confirmation\s*:?\s*[\w\d]+\)$/i,
  /\s*\(reservation\s*:?\s*[\w\d]+\)$/i,
  /\s*\(booking\s*:?\s*[\w\d]+\)$/i,
  /\s*#\s*[\w\d]{4,}$/i, // Generic confirmation number
  // Guest/companion patterns
  /\s*[–—−‐‑‒―-]\s*w\/?\s+\w+.*$/i, // "- w/ John", "- with friends"
  /\s*[–—−‐‑‒―-]\s*with\s+\w+.*$/i,
  /\s*\(w\/?\s+\w+.*\)$/i,
  /\s*\(with\s+\w+.*\)$/i,
  // Via platform suffixes
  /\s*[–—−‐‑‒―-]\s*via\s+(resy|opentable|tock|yelp|thefork)$/i,
  /\s*\(via\s+(resy|opentable|tock|yelp|thefork)\)$/i,
  /\s*\((resy|opentable|tock|yelp|thefork)\)$/i,
  // Location/branch suffixes
  /\s*[–—−‐‑‒―-]\s*(downtown|midtown|uptown|westside|eastside)$/i,
  /\s*[–—−‐‑‒―-]\s*(main|flagship|original)\s*(location|branch)?$/i,
  // "reservation" or "booking" at the end
  /\s+reservation$/i,
  /\s+booking$/i,
];

function stripCalendarTitleAffixes(value: string): string {
  let cleaned = value;
  let prev: string;
  do {
    prev = cleaned;
    for (const p of CALENDAR_TITLE_PREFIXES_TO_STRIP) {
      cleaned = cleaned.replace(p, "");
    }
    for (const p of CALENDAR_TITLE_SUFFIXES_TO_STRIP) {
      cleaned = cleaned.replace(p, "");
    }
    cleaned = cleaned.trim();
  } while (cleaned !== prev);
  return cleaned;
}

/** Clean and normalize a calendar event title to extract the likely restaurant name */
function _cleanCalendarEventTitle(title: string): string {
  if (!title) {
    return "";
  }
  const withOriginalSeparators = title.trim().replace(/\s+/g, " ");
  const stripped = stripCalendarTitleAffixes(withOriginalSeparators);
  const normalized = stripped.replace(/[–—−‐‑‒―-]/g, " ").replace(/\s+/g, " ");
  return stripCalendarTitleAffixes(normalized);
}
export const cleanCalendarEventTitle = memoize(_cleanCalendarEventTitle);

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
  // City abbreviations at the end
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
  // Platform prefixes
  /^resy\s*[-:@]?\s*/i,
  /^opentable\s*[-:@]?\s*/i,
  /^tock\s*[-:@]?\s*/i,
  /^yelp\s*[-:@]?\s*/i,
  /^via\s+(resy|opentable|tock|yelp)\s*[-:@]?\s*/i,
];

/** Strip comparison-specific prefixes and suffixes from a name */
function _stripComparisonAffixes(str: string): string {
  let result = str
    .trim()
    .replace(/[–—−‐‑‒―-]/g, " ")
    .replace(/\s+/g, " ");
  let prev: string;
  do {
    prev = result;
    for (const p of COMPARISON_PREFIXES_TO_STRIP) {
      result = result.replace(p, "");
    }
    for (const p of COMPARISON_SUFFIXES_TO_STRIP) {
      result = result.replace(p, "");
    }
    result = result.trim();
  } while (result !== prev);
  return result;
}
export const stripComparisonAffixes = memoize(_stripComparisonAffixes);
/** Compare a restaurant name with a calendar event title to determine if they match */
function _compareRestaurantAndCalendarTitle(calendarTitle: string, restaurantName: string): boolean {
  if (!calendarTitle || !restaurantName) {
    return false;
  }

  const cleanedCalendar = stripComparisonAffixes(cleanCalendarEventTitle(calendarTitle));
  const cleanedRestaurant = stripComparisonAffixes(restaurantName);
  const normCalendar = normalizeForComparison(cleanedCalendar);
  const normRestaurant = normalizeForComparison(cleanedRestaurant);

  if (normCalendar.length < 3 || normRestaurant.length < 3) {
    return false;
  }

  if (normCalendar === normRestaurant) {
    return true;
  }

  // Treat long cleaned restaurant names as exact when they appear verbatim within the
  // normalized calendar title, e.g. "Dinner at Le Bernardin".
  return cleanedRestaurant.length >= 8 && normCalendar.split(" ").some((l) => l === normRestaurant);
}
export const compareRestaurantAndCalendarTitle = memoize(_compareRestaurantAndCalendarTitle);
/** Normalize a string for fuzzy comparison */
function _normalizeForComparison(str: string): string {
  return (
    deburr(str)
      .toLowerCase()
      // Strip all emojis
      .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
      // Normalize various apostrophe/quote styles
      .replace(/[''’`´ʼʻ]/g, "'")
      // Normalize dashes to spaces
      .replace(/[–—−‐‑‒―]/g, " ")
      // Normalize ampersand to "and"
      .replace(/\s*&\s*/g, " and ")
      // Remove possessive 's (so "Joe's" matches "Joes")
      .replace(/'s\b/g, "s")
      // Remove remaining apostrophes (so "rock'n'roll" → "rocknroll")
      .replace(/'/g, "")
      // Replace non-alphanumeric with space
      .replace(/[^\w\s]/g, " ")
      // Collapse multiple spaces
      .replace(/\s+/g, " ")
      .trim()
  );
}
export const normalizeForComparison = memoize(_normalizeForComparison);

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

/** Check if two strings are a fuzzy match for restaurant name comparison */
function _isFuzzyRestaurantMatch(a: string, b: string, threshold: number = 3): boolean {
  const normA = normalizeForComparison(a);
  const normB = normalizeForComparison(b);

  if (normA.length < threshold || normB.length < threshold) {
    return false;
  }

  // Exact match or substring match
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) {
    return true;
  }

  // Extract significant words
  const getSignificantWords = (s: string) => s.split(" ").filter((w) => w.length > 1 && !INSIGNIFICANT_WORDS.has(w));

  const wordsA = getSignificantWords(normA);
  const wordsB = getSignificantWords(normB);

  // If one has few significant words, check if all are in the other
  if (wordsA.length > 0 && wordsA.length <= 2 && wordsA.every((w) => normB.includes(w))) {
    return true;
  }
  if (wordsB.length > 0 && wordsB.length <= 2 && wordsB.every((w) => normA.includes(w))) {
    return true;
  }

  return false;
}
export const isFuzzyRestaurantMatch = memoize(_isFuzzyRestaurantMatch);

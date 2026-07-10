#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { deburr } from "lodash-es";
import {
  buildMichelinProviderSpatialQueryPlans,
  groupMichelinProviderSpatialCandidates,
  MICHELIN_PROVIDER_SPATIAL_HYDRATION_SQL,
  type MichelinProviderSpatialCandidateRow,
} from "../utils/db/michelin-provider-spatial-core.ts";
import { findProviderMichelinMatch, type ProviderMichelinNameTools } from "../utils/provider-michelin-matching-core.ts";

type MatchKind = "exact" | "fuzzy";
type WorkloadKind = MatchKind | "miss";

interface Configuration {
  readonly databasePath: string;
  readonly outputPath: string;
  readonly reservationCount: number;
  readonly samples: number;
  readonly warmupPairs: number;
  readonly batchSize: number;
}

interface RestaurantRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string;
  readonly location: string;
  readonly cuisine: string;
  readonly latestAwardYear: number | null;
  readonly award: string;
  readonly datasetVersion?: string | null;
}

interface LocatedReservation {
  readonly ordinal: number;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly workloadKind: WorkloadKind;
}

interface MichelinMatch {
  readonly restaurant: RestaurantRow;
  readonly distanceMeters: number;
  readonly kind: MatchKind;
}

interface ExecutionResult {
  readonly matches: readonly (MichelinMatch | null)[];
  readonly sqliteCalls: number;
  readonly transferredRows: number;
  readonly payloadBytes: number;
  readonly candidateCounts: readonly number[];
}

interface TimedExecution extends ExecutionResult {
  readonly elapsedMilliseconds: number;
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly size: number | null;
  readonly sha256: string | null;
  readonly device: number | null;
  readonly inode: number | null;
}

interface MeasurementSummary {
  readonly minimumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}

const EARTH_RADIUS_METERS = 6_371_000;
const EXACT_RADIUS_METERS = 1000;
const FUZZY_RADIUS_METERS = 250;
const BOUNDING_RADIUS_METERS = EXACT_RADIUS_METERS;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const ACTIVE_DATASET_KEY = "michelin_dataset_version";
const DEFAULT_DATABASE_PATH = join(
  process.env.HOME ?? "",
  "Library/Containers/3043B5A3-30EC-4EDC-9AB4-3AFC61142C73/Data/Documents/SQLite/photo_foodie.db",
);
const DEFAULT_CONFIGURATION: Configuration = {
  databasePath: DEFAULT_DATABASE_PATH,
  outputPath: ".build/michelin-provider-spatial-profile.json",
  reservationCount: 256,
  samples: 7,
  warmupPairs: 2,
  batchSize: 64,
};

// These expressions are a literal benchmark oracle for the production title
// comparison path. SQL only narrows spatial candidates; none of this Unicode-
// aware matching is intentionally moved into SQLite.
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

function usage(): string {
  return `Usage: benchmark-michelin-provider-spatial.ts [options]

  --database=PATH      Palate SQLite database (default: this Mac's app database)
  --output=PATH        Aggregate-only JSON report (default: ${DEFAULT_CONFIGURATION.outputPath})
  --reservations=N     Deterministic located reservations (default: ${DEFAULT_CONFIGURATION.reservationCount})
  --samples=N          Counterbalanced measured pairs (default: ${DEFAULT_CONFIGURATION.samples})
  --warmup=N           Counterbalanced warmup pairs (default: ${DEFAULT_CONFIGURATION.warmupPairs})
  --batch-size=N       Reservations per candidate SQL call (default: ${DEFAULT_CONFIGURATION.batchSize})
  --help, -h           Show help

The source is opened with mode=ro&immutable=1 after rejecting pending WAL or
journal data. The retained report contains aggregate counts, hashes, timings,
and payload sizes only; it never includes guide identities or coordinates.`;
}

function parsePositiveInteger(value: string, option: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new RangeError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} safe integer.`);
  }
  return parsed;
}

function parseConfiguration(arguments_: readonly string[]): Configuration | null {
  let configuration = { ...DEFAULT_CONFIGURATION };
  for (const argument of arguments_) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const option = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!value) {
      throw new RangeError(`${option} cannot be empty.`);
    }
    switch (option) {
      case "--database":
        configuration = { ...configuration, databasePath: resolve(value) };
        break;
      case "--output":
        configuration = { ...configuration, outputPath: resolve(value) };
        break;
      case "--reservations":
        configuration = { ...configuration, reservationCount: parsePositiveInteger(value, option) };
        break;
      case "--samples":
        configuration = { ...configuration, samples: parsePositiveInteger(value, option) };
        break;
      case "--warmup":
        configuration = { ...configuration, warmupPairs: parsePositiveInteger(value, option, true) };
        break;
      case "--batch-size": {
        const batchSize = parsePositiveInteger(value, option);
        if (batchSize > 100) {
          throw new RangeError("--batch-size must not exceed 100 so the query stays below legacy SQLite bind limits.");
        }
        configuration = { ...configuration, batchSize };
        break;
      }
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }
  return configuration;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { exists: false, size: null, sha256: null, device: null, inode: null };
  }
  const metadata = statSync(path);
  if (!metadata.isFile()) {
    throw new Error(`Expected a regular file: ${path}`);
  }
  return {
    exists: true,
    size: metadata.size,
    sha256: sha256File(path),
    device: metadata.dev,
    inode: metadata.ino,
  };
}

function canonicalizePotentialPath(path: string, seenSymlinks = new Set<string>()): string {
  let ancestor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (metadata.isSymbolicLink()) {
        if (seenSymlinks.has(ancestor)) {
          throw new Error(`Path contains a symbolic-link cycle at ${ancestor}.`);
        }
        seenSymlinks.add(ancestor);
        const target = resolve(dirname(ancestor), readlinkSync(ancestor));
        return resolve(canonicalizePotentialPath(target, seenSymlinks), ...missingSegments);
      }
      return resolve(realpathSync(ancestor), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missingSegments.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function sourcePathVariants(databasePath: string): string[] {
  const resolved = resolve(databasePath);
  return [...new Set([resolved, realpathSync(resolved)])];
}

function protectedSourcePaths(databasePath: string): string[] {
  return sourcePathVariants(databasePath).flatMap((base) => [
    base,
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${base}${suffix}`),
  ]);
}

function assertOutputDoesNotAliasSource(databasePath: string, outputPath: string): void {
  const outputCanonical = canonicalizePotentialPath(outputPath);
  const outputIdentity = existsSync(outputPath) ? statSync(outputPath) : null;
  for (const protectedPath of protectedSourcePaths(databasePath)) {
    if (canonicalizePotentialPath(protectedPath) === outputCanonical) {
      throw new Error("Benchmark output must not alias the source database or one of its SQLite sidecars.");
    }
    if (outputIdentity && existsSync(protectedPath)) {
      const protectedIdentity = statSync(protectedPath);
      if (outputIdentity.dev === protectedIdentity.dev && outputIdentity.ino === protectedIdentity.ino) {
        throw new Error("Benchmark output must not be a hard link to the source database or a SQLite sidecar.");
      }
    }
  }
}

function snapshotProtectedFiles(databasePath: string): Readonly<Record<string, FileSnapshot>> {
  return Object.fromEntries(
    protectedSourcePaths(databasePath).map((path, index) => [`protected-${index}`, snapshotFile(path)]),
  );
}

function assertNoPendingJournalData(databasePath: string): void {
  for (const base of sourcePathVariants(databasePath)) {
    for (const suffix of ["-wal", "-journal"] as const) {
      const path = `${base}${suffix}`;
      if (existsSync(path) && statSync(path).size > 0) {
        throw new Error(`Source has a non-empty ${suffix} sidecar; checkpoint and close its writer first.`);
      }
    }
  }
}

function assertSourceHasNoHardLinkAliases(databasePath: string): void {
  const metadata = statSync(realpathSync(databasePath));
  if (metadata.nlink !== 1) {
    throw new Error(
      "Source database has hard-link aliases; their undiscoverable WAL/journal filenames make immutable profiling unsafe.",
    );
  }
}

function immutableDatabaseUri(databasePath: string): string {
  const uri = pathToFileURL(resolve(databasePath));
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set("immutable", "1");
  return uri.href;
}

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

function compareRestaurantAndCalendarTitle(calendarTitle: string, restaurantName: string): boolean {
  if (!calendarTitle || !restaurantName) {
    return false;
  }
  const cleanedCalendar = stripComparisonAffixes(cleanCalendarEventTitle(calendarTitle));
  const cleanedRestaurant = stripComparisonAffixes(restaurantName);
  const normalizedCalendar = normalizeForComparison(cleanedCalendar);
  const normalizedRestaurant = normalizeForComparison(cleanedRestaurant);
  if (normalizedCalendar.length < 3 || normalizedRestaurant.length < 3) {
    return false;
  }
  if (normalizedCalendar === normalizedRestaurant) {
    return true;
  }
  return cleanedRestaurant.length >= 8 && normalizedCalendar.split(" ").some((part) => part === normalizedRestaurant);
}

function isFuzzyRestaurantMatch(left: string, right: string, threshold = 3): boolean {
  const normalizedLeft = normalizeForComparison(left);
  const normalizedRight = normalizeForComparison(right);
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

function assertValidCoordinate(latitude: number, longitude: number, label: string): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError(`${label} latitude must be finite and between -90 and 90.`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError(`${label} longitude must be finite and between -180 and 180.`);
  }
}

function isValidGuideCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

function calculateDistanceMeters(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const toRadians = (degrees: number): number => degrees * (Math.PI / 180);
  const latitudeDelta = toRadians(latitude2 - latitude1);
  const longitudeDelta = toRadians(longitude2 - longitude1);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitude1)) * Math.cos(toRadians(latitude2)) * Math.sin(longitudeDelta / 2) ** 2;
  const angularDistance = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return EARTH_RADIUS_METERS * angularDistance;
}

function buildRestaurantsByNormalizedName(
  restaurants: readonly RestaurantRow[],
): ReadonlyMap<string, readonly RestaurantRow[]> {
  const mutable = new Map<string, RestaurantRow[]>();
  for (const restaurant of restaurants) {
    const key = normalizeForComparison(stripComparisonAffixes(restaurant.name));
    if (!key) {
      continue;
    }
    const existing = mutable.get(key);
    if (existing) {
      existing.push(restaurant);
    } else {
      mutable.set(key, [restaurant]);
    }
  }
  return mutable;
}

function findMichelinMatch(
  reservation: LocatedReservation,
  restaurants: readonly RestaurantRow[],
  restaurantsByName: ReadonlyMap<string, readonly RestaurantRow[]>,
): MichelinMatch | null {
  assertValidCoordinate(reservation.latitude, reservation.longitude, `Reservation ${reservation.ordinal}`);
  const normalizedName = normalizeForComparison(stripComparisonAffixes(reservation.name));
  const exactMatches = restaurantsByName.get(normalizedName) ?? [];
  const exactCandidates = exactMatches
    .map((restaurant) => ({
      restaurant,
      distanceMeters: calculateDistanceMeters(
        reservation.latitude,
        reservation.longitude,
        restaurant.latitude,
        restaurant.longitude,
      ),
      kind: "exact" as const,
    }))
    .filter(({ distanceMeters }) => distanceMeters <= EXACT_RADIUS_METERS)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
  if (exactCandidates.length > 0) {
    return exactCandidates[0]!;
  }

  let best: MichelinMatch | null = null;
  for (const restaurant of restaurants) {
    const distanceMeters = calculateDistanceMeters(
      reservation.latitude,
      reservation.longitude,
      restaurant.latitude,
      restaurant.longitude,
    );
    if (distanceMeters > FUZZY_RADIUS_METERS) {
      continue;
    }
    if (
      !compareRestaurantAndCalendarTitle(reservation.name, restaurant.name) &&
      !isFuzzyRestaurantMatch(reservation.name, restaurant.name)
    ) {
      continue;
    }
    if (!best || distanceMeters < best.distanceMeters) {
      best = { restaurant, distanceMeters, kind: "fuzzy" };
    }
  }
  return best;
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 && longitude > 0 ? 180 : normalized;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return value;
}

function restaurantFromRow(row: Record<string, unknown>, label: string): RestaurantRow {
  const latestAwardYear = row.latestAwardYear;
  if (latestAwardYear !== null && (typeof latestAwardYear !== "number" || !Number.isFinite(latestAwardYear))) {
    throw new TypeError(`${label}.latestAwardYear must be null or finite.`);
  }
  return {
    id: requiredString(row.id, `${label}.id`),
    name: requiredString(row.name, `${label}.name`),
    latitude: finiteNumber(row.latitude, `${label}.latitude`),
    longitude: finiteNumber(row.longitude, `${label}.longitude`),
    address: requiredString(row.address, `${label}.address`),
    location: requiredString(row.location, `${label}.location`),
    cuisine: requiredString(row.cuisine, `${label}.cuisine`),
    latestAwardYear: latestAwardYear as number | null,
    award: requiredString(row.award, `${label}.award`),
    datasetVersion:
      row.datasetVersion === undefined || row.datasetVersion === null
        ? row.datasetVersion
        : requiredString(row.datasetVersion, `${label}.datasetVersion`),
  };
}

const FULL_GUIDE_SQL = `SELECT m.*
  FROM michelin_restaurants m
  WHERE NOT EXISTS (
    SELECT 1 FROM app_metadata WHERE key = ?
  ) OR m.datasetVersion = (
    SELECT value FROM app_metadata WHERE key = ?
  )`;

const SOURCE_ORDER_SQL = `SELECT m.rowid AS sourceOrder, m.*
  FROM michelin_restaurants m
  WHERE NOT EXISTS (
    SELECT 1 FROM app_metadata WHERE key = ?
  ) OR m.datasetVersion = (
    SELECT value FROM app_metadata WHERE key = ?
  )
  ORDER BY m.rowid ASC`;

function queryFullGuide(database: DatabaseSync): {
  readonly rawRows: Record<string, unknown>[];
  readonly rows: RestaurantRow[];
} {
  const rawRows = database.prepare(FULL_GUIDE_SQL).all(ACTIVE_DATASET_KEY, ACTIVE_DATASET_KEY) as unknown as Record<
    string,
    unknown
  >[];
  const rows = rawRows.map((row, index) => restaurantFromRow(row, `Full guide row ${index}`));
  return { rawRows, rows };
}

function executeLegacy(
  database: DatabaseSync,
  reservations: readonly LocatedReservation[],
  measurePayload: boolean = true,
): ExecutionResult {
  const guide = queryFullGuide(database);
  const restaurantsByName = buildRestaurantsByNormalizedName(guide.rows);
  return {
    matches: reservations.map((reservation) => findMichelinMatch(reservation, guide.rows, restaurantsByName)),
    sqliteCalls: 1,
    transferredRows: guide.rows.length,
    payloadBytes: measurePayload ? Buffer.byteLength(JSON.stringify(guide.rawRows)) : 0,
    candidateCounts: reservations.map(() => guide.rows.length),
  };
}

const BENCHMARK_NAME_TOOLS: ProviderMichelinNameTools = {
  normalizeForComparison,
  stripComparisonAffixes,
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
};

function executeCandidate(
  database: DatabaseSync,
  reservations: readonly LocatedReservation[],
  batchSize: number,
  measurePayload: boolean = true,
): ExecutionResult {
  const candidateRows: MichelinProviderSpatialCandidateRow[] = [];
  let sqliteCalls = 0;
  let transferredRows = 0;
  let payloadBytes = 0;
  const plans = buildMichelinProviderSpatialQueryPlans(
    reservations.map(({ latitude, longitude }) => ({ latitude, longitude })),
    batchSize,
  );
  for (const plan of plans) {
    const rawRows = database
      .prepare(
        plan.sql.replaceAll("michelin_restaurant_spatial_index", "provider_spatial_scratch.michelin_spatial_index"),
      )
      .all(...plan.parameters) as unknown as MichelinProviderSpatialCandidateRow[];
    sqliteCalls += 1;
    transferredRows += rawRows.length;
    if (measurePayload) {
      payloadBytes += Buffer.byteLength(JSON.stringify(rawRows));
    }
    candidateRows.push(...rawRows);
  }
  const candidateGroups = groupMichelinProviderSpatialCandidates(candidateRows, reservations.length);
  const candidateCounts = candidateGroups.map((group) => group.length);
  const spatialMatches = reservations.map((reservation, index): MichelinMatch | null => {
    const match = findProviderMichelinMatch(
      { restaurantName: reservation.name, latitude: reservation.latitude, longitude: reservation.longitude },
      candidateGroups[index]!,
      BENCHMARK_NAME_TOOLS,
    );
    return match
      ? {
          restaurant: { ...match.restaurant, address: "", location: "", cuisine: "", latestAwardYear: null, award: "" },
          distanceMeters: match.distance,
          kind: match.kind,
        }
      : null;
  });
  const matchedIds = [...new Set(spatialMatches.flatMap((match) => (match ? [match.restaurant.id] : [])))];
  const hydratedById = new Map<string, RestaurantRow>();
  if (matchedIds.length > 0) {
    const rawRows = database
      .prepare(MICHELIN_PROVIDER_SPATIAL_HYDRATION_SQL)
      .all(JSON.stringify(matchedIds), ACTIVE_DATASET_KEY, ACTIVE_DATASET_KEY) as unknown as Record<string, unknown>[];
    sqliteCalls += 1;
    transferredRows += rawRows.length;
    if (measurePayload) {
      payloadBytes += Buffer.byteLength(JSON.stringify(rawRows));
    }
    for (let index = 0; index < rawRows.length; index++) {
      const restaurant = restaurantFromRow(rawRows[index]!, `Hydrated match row ${index}`);
      hydratedById.set(restaurant.id, restaurant);
    }
  }
  const matches = spatialMatches.map((match) => {
    if (!match) {
      return null;
    }
    const hydrated = hydratedById.get(match.restaurant.id);
    if (!hydrated) {
      throw new Error("Candidate match disappeared before detail hydration.");
    }
    return { ...match, restaurant: hydrated };
  });
  return { matches, sqliteCalls, transferredRows, payloadBytes, candidateCounts };
}

function sourceOrderMap(database: DatabaseSync): {
  readonly rows: RestaurantRow[];
  readonly byId: ReadonlyMap<string, number>;
} {
  const rawRows = database.prepare(SOURCE_ORDER_SQL).all(ACTIVE_DATASET_KEY, ACTIVE_DATASET_KEY) as unknown as Record<
    string,
    unknown
  >[];
  const rows: RestaurantRow[] = [];
  const byId = new Map<string, number>();
  for (let index = 0; index < rawRows.length; index++) {
    const raw = rawRows[index]!;
    const sourceOrder = finiteNumber(raw.sourceOrder, `Source order row ${index}.sourceOrder`);
    const restaurant = restaurantFromRow(raw, `Source order row ${index}`);
    rows.push(restaurant);
    byId.set(restaurant.id, sourceOrder);
  }
  return { rows, byId };
}

function matchSignature(
  matches: readonly (MichelinMatch | null)[],
  sourceOrdersById: ReadonlyMap<string, number>,
): string {
  const anonymized = matches.map((match) => {
    if (!match) {
      return null;
    }
    const sourceOrder = sourceOrdersById.get(match.restaurant.id);
    if (sourceOrder === undefined) {
      throw new Error("Matched restaurant was absent from the active source-order map.");
    }
    return [match.kind, sourceOrder, Number(match.distanceMeters.toFixed(6))] as const;
  });
  return sha256(JSON.stringify(anonymized));
}

function assertMatchParity(
  expected: ExecutionResult,
  actual: ExecutionResult,
  sourceOrdersById: ReadonlyMap<string, number>,
): string {
  assert.equal(actual.matches.length, expected.matches.length);
  for (let index = 0; index < expected.matches.length; index++) {
    const expectedMatch = expected.matches[index];
    const actualMatch = actual.matches[index];
    assert.equal(actualMatch?.restaurant.id ?? null, expectedMatch?.restaurant.id ?? null, `match ${index} id`);
    assert.equal(actualMatch?.kind ?? null, expectedMatch?.kind ?? null, `match ${index} kind`);
    if (expectedMatch && actualMatch) {
      assert.ok(Math.abs(actualMatch.distanceMeters - expectedMatch.distanceMeters) <= 1e-7, `match ${index} distance`);
    }
  }
  const expectedSignature = matchSignature(expected.matches, sourceOrdersById);
  assert.equal(matchSignature(actual.matches, sourceOrdersById), expectedSignature);
  return expectedSignature;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function offsetCoordinate(
  latitude: number,
  longitude: number,
  northMeters: number,
  eastMeters: number,
): { readonly latitude: number; readonly longitude: number } {
  const latitudeOffset = (northMeters / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const targetLatitude = Math.max(-90, Math.min(90, latitude + latitudeOffset));
  const cosine = Math.cos(targetLatitude * (Math.PI / 180));
  const longitudeOffset =
    Math.abs(cosine) < 1e-12 ? 0 : (eastMeters / (EARTH_RADIUS_METERS * cosine)) * (180 / Math.PI);
  return { latitude: targetLatitude, longitude: normalizeLongitude(longitude + longitudeOffset) };
}

function buildWorkload(anchors: readonly RestaurantRow[], reservationCount: number): LocatedReservation[] {
  if (anchors.length === 0) {
    throw new Error("Cannot derive a workload from an empty active guide.");
  }
  const random = createRandom(0x51a71a1);
  return Array.from({ length: reservationCount }, (_, ordinal) => {
    const anchorIndex = Math.min(anchors.length - 1, Math.floor(((ordinal + 0.5) / reservationCount) * anchors.length));
    const anchor = anchors[anchorIndex]!;
    const angle = random() * Math.PI * 2;
    const radius = 15 + random() * 85;
    const coordinate = offsetCoordinate(
      anchor.latitude,
      anchor.longitude,
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
    );
    const pattern = ordinal % 4;
    if (pattern <= 1) {
      return {
        ordinal,
        name: `Reservation at ${anchor.name}`,
        ...coordinate,
        workloadKind: "exact" as const,
      };
    }
    if (pattern === 2) {
      return {
        ordinal,
        name: `providerprobe ${anchor.name}`,
        ...coordinate,
        workloadKind: "fuzzy" as const,
      };
    }
    return {
      ordinal,
      name: `providerprobe-unmatched-${ordinal.toString(36)}-qxz`,
      ...coordinate,
      workloadKind: "miss" as const,
    };
  });
}

function timed(run: () => ExecutionResult): TimedExecution {
  const startedAt = performance.now();
  const result = run();
  const elapsedMilliseconds = performance.now() - startedAt;
  return { ...result, elapsedMilliseconds };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

function summarizeMeasurements(values: readonly number[]): MeasurementSummary {
  return {
    minimumMilliseconds: Number(Math.min(...values).toFixed(3)),
    medianMilliseconds: Number(percentile(values, 0.5).toFixed(3)),
    p95Milliseconds: Number(percentile(values, 0.95).toFixed(3)),
    maximumMilliseconds: Number(Math.max(...values).toFixed(3)),
    samplesMilliseconds: values.map((value) => Number(value.toFixed(3))),
  };
}

function summarizeCounts(values: readonly number[]): {
  readonly minimum: number;
  readonly median: number;
  readonly p95: number;
  readonly maximum: number;
  readonly mean: number;
  readonly total: number;
} {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    minimum: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    maximum: Math.max(...values),
    mean: Number((total / values.length).toFixed(3)),
    total,
  };
}

function assertSourceSchema(database: DatabaseSync): void {
  for (const table of ["michelin_restaurants", "app_metadata"]) {
    const row = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
      | { name?: unknown }
      | undefined;
    if (row?.name !== table) {
      throw new Error(`Source database is missing ${table}.`);
    }
  }
  const index = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_michelin_location'")
    .get() as { name?: unknown } | undefined;
  if (index?.name !== "idx_michelin_location") {
    throw new Error("Source database is missing idx_michelin_location(latitude, longitude).");
  }
}

function assertCandidateQueryUsesLocationIndex(database: DatabaseSync, reservation: LocatedReservation): void {
  const query = buildMichelinProviderSpatialQueryPlans([reservation], 1)[0]!;
  const plan = database
    .prepare(
      `EXPLAIN QUERY PLAN ${query.sql.replaceAll(
        "michelin_restaurant_spatial_index",
        "provider_spatial_scratch.michelin_spatial_index",
      )}`,
    )
    .all(...query.parameters) as unknown as Array<{ detail?: unknown }>;
  assert.ok(
    plan.some(
      (row) =>
        typeof row.detail === "string" && row.detail.includes("spatial") && row.detail.includes("VIRTUAL TABLE INDEX"),
    ),
    "Candidate query plan did not use the scratch R-Tree virtual-table index.",
  );
}

function buildScratchSpatialIndex(database: DatabaseSync): {
  readonly elapsedMilliseconds: number;
  readonly indexedRows: number;
} {
  const startedAt = performance.now();
  database.exec(`
    ATTACH DATABASE ':memory:' AS provider_spatial_scratch;
    CREATE VIRTUAL TABLE provider_spatial_scratch.michelin_spatial_index USING rtree(
      restaurantRowId,
      minimumLatitude,
      maximumLatitude,
      minimumLongitude,
      maximumLongitude
    );
  `);
  database
    .prepare(`INSERT INTO provider_spatial_scratch.michelin_spatial_index
      (restaurantRowId, minimumLatitude, maximumLatitude, minimumLongitude, maximumLongitude)
      SELECT rowid, latitude, latitude, longitude, longitude
      FROM michelin_restaurants m
      WHERE m.latitude BETWEEN -90.0 AND 90.0
        AND m.longitude BETWEEN -180.0 AND 180.0
        AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)`)
    .run();
  const countRow = database
    .prepare("SELECT COUNT(*) AS count FROM provider_spatial_scratch.michelin_spatial_index")
    .get() as { count?: unknown } | undefined;
  return {
    elapsedMilliseconds: performance.now() - startedAt,
    indexedRows: finiteNumber(countRow?.count, "Scratch R-Tree row count"),
  };
}

const SCRATCH_SPATIAL_HEALTH_SQL = `SELECT
  (
    SELECT COUNT(*)
    FROM michelin_restaurants m
    LEFT JOIN provider_spatial_scratch.michelin_spatial_index spatial ON spatial.restaurantRowId = m.rowid
    WHERE m.latitude BETWEEN -90.0 AND 90.0
      AND m.longitude BETWEEN -180.0 AND 180.0
      AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)
      AND (
        spatial.restaurantRowId IS NULL
        OR NOT (m.latitude BETWEEN spatial.minimumLatitude AND spatial.maximumLatitude)
        OR NOT (m.longitude BETWEEN spatial.minimumLongitude AND spatial.maximumLongitude)
        OR spatial.maximumLatitude - spatial.minimumLatitude > 0.001
        OR spatial.maximumLongitude - spatial.minimumLongitude > 0.001
      )
  ) + (
    SELECT COUNT(*)
    FROM provider_spatial_scratch.michelin_spatial_index spatial
    LEFT JOIN michelin_restaurants m ON m.rowid = spatial.restaurantRowId
    WHERE m.rowid IS NULL
       OR NOT (
         m.latitude BETWEEN -90.0 AND 90.0
         AND m.longitude BETWEEN -180.0 AND 180.0
         AND NOT (m.latitude = 0.0 AND m.longitude = 0.0)
       )
  ) AS issueCount`;

function measureHealthySpatialCheck(database: DatabaseSync): MeasurementSummary {
  const samples: number[] = [];
  for (let sample = 0; sample < 9; sample++) {
    const startedAt = performance.now();
    const row = database.prepare(SCRATCH_SPATIAL_HEALTH_SQL).get() as { issueCount?: unknown } | undefined;
    samples.push(performance.now() - startedAt);
    assert.equal(row?.issueCount, 0);
  }
  return summarizeMeasurements(samples);
}

function createSyntheticDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_metadata (key, value) VALUES ('${ACTIVE_DATASET_KEY}', 'synthetic-v1');
    CREATE TABLE michelin_restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      cuisine TEXT NOT NULL DEFAULT '',
      latestAwardYear INTEGER,
      award TEXT NOT NULL DEFAULT '',
      datasetVersion TEXT
    );
    CREATE INDEX idx_michelin_location ON michelin_restaurants(latitude, longitude);
  `);
  return database;
}

function insertSyntheticRestaurant(
  statement: ReturnType<DatabaseSync["prepare"]>,
  id: string,
  name: string,
  latitude: number,
  longitude: number,
): void {
  statement.run(id, name, latitude, longitude, "", "", "", null, "", "synthetic-v1");
}

function runSyntheticCorrectnessTests(): { readonly parityQueries: number; readonly edgeCases: number } {
  const database = createSyntheticDatabase();
  try {
    const insert = database.prepare(`INSERT INTO michelin_restaurants
      (id, name, latitude, longitude, address, location, cuisine, latestAwardYear, award, datasetVersion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertSyntheticRestaurant(insert, "tie-first", "Tie Place", 10, 20);
    insertSyntheticRestaurant(insert, "tie-second", "Tie Place", 10, 20);
    insertSyntheticRestaurant(insert, "date-line-west", "Date Line", 0.01, -179.999);
    insertSyntheticRestaurant(insert, "pole-first", "Pole Place", 90, -120);
    insertSyntheticRestaurant(insert, "pole-second", "Pole Place", 90, 120);
    insertSyntheticRestaurant(insert, "fuzzy", "Harbor Table", 1, 1);
    insertSyntheticRestaurant(
      insert,
      "boundary",
      "Boundary Place",
      20 + (999.999 / EARTH_RADIUS_METERS) * (180 / Math.PI),
      30,
    );
    insertSyntheticRestaurant(insert, "invalid-latitude", "Invalid", 91, 10);
    insertSyntheticRestaurant(insert, "invalid-longitude", "Invalid", 10, 181);
    insertSyntheticRestaurant(insert, "zero-zero", "Invalid", 0, 0);

    const random = createRandom(0x5eedc0de);
    for (let index = 0; index < 1000; index++) {
      insertSyntheticRestaurant(
        insert,
        `random-${index.toString().padStart(4, "0")}`,
        `Synthetic Place ${index}`,
        random() * 179.8 - 89.9,
        random() * 360 - 180,
      );
    }

    buildScratchSpatialIndex(database);

    const ordered = sourceOrderMap(database);
    const validRows = ordered.rows.filter(({ latitude, longitude }) => isValidGuideCoordinate(latitude, longitude));
    const validOrders = new Map(
      [...ordered.byId].filter(([id]) => validRows.some((restaurant) => restaurant.id === id)),
    );
    const fixedQueries: LocatedReservation[] = [
      { ordinal: 0, name: "Reservation at Tie Place", latitude: 10, longitude: 20, workloadKind: "exact" },
      { ordinal: 1, name: "Reservation at Date Line", latitude: 0.01, longitude: 179.999, workloadKind: "exact" },
      { ordinal: 2, name: "Reservation at Pole Place", latitude: 90, longitude: 0, workloadKind: "exact" },
      { ordinal: 3, name: "providerprobe Harbor Table", latitude: 1, longitude: 1, workloadKind: "fuzzy" },
      { ordinal: 4, name: "Reservation at Boundary Place", latitude: 20, longitude: 30, workloadKind: "exact" },
      { ordinal: 5, name: "providerprobe-no-match", latitude: -90, longitude: 180, workloadKind: "miss" },
      { ordinal: 6, name: "Reservation at Invalid", latitude: 0, longitude: 0, workloadKind: "miss" },
    ];
    const randomQueries = buildWorkload(
      validRows.filter((row) => row.id.startsWith("random-")),
      200,
    ).map((query, index) => ({ ...query, ordinal: fixedQueries.length + index }));
    const queries = [...fixedQueries, ...randomQueries];
    const legacy: ExecutionResult = {
      matches: queries.map((query) => findMichelinMatch(query, validRows, buildRestaurantsByNormalizedName(validRows))),
      sqliteCalls: 0,
      transferredRows: 0,
      payloadBytes: 0,
      candidateCounts: [],
    };
    const candidate = executeCandidate(database, queries, 64);
    assertMatchParity(legacy, candidate, validOrders);
    assert.equal(candidate.matches[0]?.restaurant.id, "tie-first");
    assert.equal(candidate.matches[1]?.restaurant.id, "date-line-west");
    assert.equal(candidate.matches[2]?.restaurant.id, "pole-first");
    assert.equal(candidate.matches[3]?.restaurant.id, "fuzzy");
    assert.equal(candidate.matches[4]?.restaurant.id, "boundary");
    assert.equal(candidate.matches[5], null);
    assert.equal(candidate.matches[6], null);
    assert.throws(
      () => buildMichelinProviderSpatialQueryPlans([{ latitude: Number.NaN, longitude: 0 }]),
      /latitude must be finite/,
    );
    assert.throws(
      () => buildMichelinProviderSpatialQueryPlans([{ latitude: 0, longitude: 181 }]),
      /longitude must be finite/,
    );
    assertCandidateQueryUsesLocationIndex(database, fixedQueries[0]!);
    return { parityQueries: queries.length, edgeCases: fixedQueries.length + 5 };
  } finally {
    database.close();
  }
}

function assertAliasGuards(): void {
  const directory = mkdtempSync(join(tmpdir(), "palate-provider-spatial-"));
  try {
    const source = join(directory, "source.db");
    const sidecar = `${source}-shm`;
    writeFileSync(source, "source");
    writeFileSync(sidecar, "sidecar");
    assert.throws(() => assertOutputDoesNotAliasSource(source, source), /must not alias/);
    const sourceSymlink = join(directory, "source-link.db");
    const sidecarSymlink = join(directory, "sidecar-link");
    const sourceHardlink = join(directory, "source-hardlink.db");
    const sidecarHardlink = join(directory, "sidecar-hardlink");
    symlinkSync(source, sourceSymlink);
    symlinkSync(sidecar, sidecarSymlink);
    linkSync(source, sourceHardlink);
    linkSync(sidecar, sidecarHardlink);
    assert.throws(() => assertSourceHasNoHardLinkAliases(source), /hard-link aliases/);
    assert.throws(() => assertOutputDoesNotAliasSource(source, sourceSymlink), /must not alias/);
    assert.throws(() => assertOutputDoesNotAliasSource(source, sidecarSymlink), /must not alias/);
    assert.throws(() => assertOutputDoesNotAliasSource(source, sourceHardlink), /hard link/);
    assert.throws(() => assertOutputDoesNotAliasSource(source, sidecarHardlink), /hard link/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertAggregateOnlyReport(report: unknown, sourceRows: readonly RestaurantRow[], databasePath: string): void {
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(resolve(databasePath)), "Report leaked the source database path.");
  const reportStrings = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      reportStrings.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(collect);
    }
  };
  collect(report);
  for (const row of sourceRows) {
    assert.ok(!reportStrings.has(row.id), "Report leaked a guide restaurant id.");
    assert.ok(!reportStrings.has(row.name), "Report leaked a guide restaurant name.");
    if (row.address) {
      assert.ok(!reportStrings.has(row.address), "Report leaked a guide restaurant address.");
    }
  }
}

function main(): void {
  const configuration = parseConfiguration(process.argv.slice(2));
  if (!configuration) {
    console.log(usage());
    return;
  }
  if (!existsSync(configuration.databasePath) || !statSync(configuration.databasePath).isFile()) {
    throw new Error(`Database path is not a file: ${configuration.databasePath}`);
  }
  assertOutputDoesNotAliasSource(configuration.databasePath, configuration.outputPath);
  assertSourceHasNoHardLinkAliases(configuration.databasePath);
  assertNoPendingJournalData(configuration.databasePath);
  const protectedBefore = snapshotProtectedFiles(configuration.databasePath);
  const sourceDatabaseSha256 = sha256File(configuration.databasePath);
  const sourceDatabaseBytes = statSync(configuration.databasePath).size;
  const syntheticTests = runSyntheticCorrectnessTests();
  assertAliasGuards();

  // The URI itself enforces read-only immutable access to main. Do not pass
  // DatabaseSync's connection-wide readOnly option: it would also make the
  // attached in-memory scratch schema read-only and prevent R-Tree setup.
  const database = new DatabaseSync(immutableDatabaseUri(configuration.databasePath));
  let report: Record<string, unknown>;
  let sourceRowsForPrivacyCheck: RestaurantRow[] = [];
  try {
    const scratchSpatialIndex = buildScratchSpatialIndex(database);
    const healthySpatialCheck = measureHealthySpatialCheck(database);
    database.exec("PRAGMA query_only = ON; BEGIN");
    assertSourceSchema(database);
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`Source integrity_check failed: ${String(integrity?.integrity_check)}`);
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    const ordered = sourceOrderMap(database);
    sourceRowsForPrivacyCheck = ordered.rows;
    if (ordered.rows.length === 0) {
      throw new Error("The active Michelin guide is empty.");
    }
    const invalidGuideCoordinateCount = ordered.rows.filter(
      ({ latitude, longitude }) => !isValidGuideCoordinate(latitude, longitude),
    ).length;
    if (invalidGuideCoordinateCount !== 0) {
      throw new Error(
        `Active guide contains ${invalidGuideCoordinateCount} invalid coordinates; refusing to benchmark a workload that violates import invariants.`,
      );
    }
    const currentUnordered = queryFullGuide(database).rows;
    assert.deepEqual(
      currentUnordered.map(({ id }) => id),
      ordered.rows.map(({ id }) => id),
      "Current unordered full-guide materialization did not match rowid order; source-order tie parity is unprovable.",
    );
    const reservations = buildWorkload(ordered.rows, configuration.reservationCount);
    assertCandidateQueryUsesLocationIndex(database, reservations[0]!);

    const referenceLegacy = executeLegacy(database, reservations);
    const referenceCandidate = executeCandidate(database, reservations, configuration.batchSize);
    const parityHash = assertMatchParity(referenceLegacy, referenceCandidate, ordered.byId);
    const candidateCountSummary = summarizeCounts(referenceCandidate.candidateCounts);

    for (let pair = 0; pair < configuration.warmupPairs; pair++) {
      if (pair % 2 === 0) {
        executeLegacy(database, reservations, false);
        executeCandidate(database, reservations, configuration.batchSize, false);
      } else {
        executeCandidate(database, reservations, configuration.batchSize, false);
        executeLegacy(database, reservations, false);
      }
    }

    const legacyTimes: number[] = [];
    const candidateTimes: number[] = [];
    for (let pair = 0; pair < configuration.samples; pair++) {
      const first = pair % 2 === 0 ? "legacy" : "candidate";
      const firstResult = timed(() =>
        first === "legacy"
          ? executeLegacy(database, reservations, false)
          : executeCandidate(database, reservations, configuration.batchSize, false),
      );
      const secondResult = timed(() =>
        first === "legacy"
          ? executeCandidate(database, reservations, configuration.batchSize, false)
          : executeLegacy(database, reservations, false),
      );
      const legacyResult = first === "legacy" ? firstResult : secondResult;
      const candidateResult = first === "candidate" ? firstResult : secondResult;
      assertMatchParity(legacyResult, candidateResult, ordered.byId);
      legacyTimes.push(legacyResult.elapsedMilliseconds);
      candidateTimes.push(candidateResult.elapsedMilliseconds);
    }
    const legacyTiming = summarizeMeasurements(legacyTimes);
    const candidateTiming = summarizeMeasurements(candidateTimes);
    const resultCounts = referenceLegacy.matches.reduce(
      (counts, match) => {
        counts[match?.kind ?? "unmatched"] += 1;
        return counts;
      },
      { exact: 0, fuzzy: 0, unmatched: 0 },
    );
    const workloadCounts = reservations.reduce(
      (counts, reservation) => {
        counts[reservation.workloadKind] += 1;
        return counts;
      },
      { exact: 0, fuzzy: 0, miss: 0 },
    );

    report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      source: {
        databaseSha256: sourceDatabaseSha256,
        databaseBytes: sourceDatabaseBytes,
        integrityCheck: "ok",
        foreignKeyViolationCount: foreignKeyViolations,
        activeGuideRows: ordered.rows.length,
        activeGuideInvalidCoordinateRows: invalidGuideCoordinateCount,
        existingLatitudeLongitudeIndexPresent: true,
        scratchRTreeIndexedRows: scratchSpatialIndex.indexedRows,
        scratchRTreeBuildMilliseconds: Number(scratchSpatialIndex.elapsedMilliseconds.toFixed(3)),
        healthyDeepSpatialCheck: healthySpatialCheck,
        sourceOrderObservation: "current full-guide query matched ascending rowid for every active row",
        pendingWalBytes: 0,
      },
      selfTests: {
        ...syntheticTests,
        coversAntimeridian: true,
        coversPoles: true,
        coversRadiusBoundaries: true,
        coversInvalidCoordinates: true,
        coversSourceOrderDistanceTies: true,
        coversOutputDirectSymlinkAndHardlinkAliases: true,
        rejectsHardLinkedSourceDatabases: true,
        productionCoreAndMatcherImported: true,
      },
      workload: {
        locatedReservations: reservations.length,
        deterministicSeed: "0x51a71a1",
        syntheticInputKinds: workloadCounts,
        observedResultKinds: resultCounts,
        rawNamesOrCoordinatesRetained: false,
        exactRadiusMeters: EXACT_RADIUS_METERS,
        fuzzyRadiusMeters: FUZZY_RADIUS_METERS,
        sqlBoundingRadiusMeters: BOUNDING_RADIUS_METERS,
      },
      parity: {
        allMatchesEqual: true,
        anonymizedResultSha256: parityHash,
        legacyResultSha256: parityHash,
        candidateResultSha256: matchSignature(referenceCandidate.matches, ordered.byId),
      },
      transfer: {
        legacyFullGuideRows: referenceLegacy.transferredRows,
        legacyPayloadBytes: referenceLegacy.payloadBytes,
        candidateRows: referenceCandidate.transferredRows,
        candidatePayloadBytes: referenceCandidate.payloadBytes,
        candidateCountsPerReservation: candidateCountSummary,
        rowReductionPercent: Number(
          ((1 - referenceCandidate.transferredRows / referenceLegacy.transferredRows) * 100).toFixed(3),
        ),
        payloadReductionPercent: Number(
          ((1 - referenceCandidate.payloadBytes / referenceLegacy.payloadBytes) * 100).toFixed(3),
        ),
      },
      performance: {
        samples: configuration.samples,
        warmupPairs: configuration.warmupPairs,
        batchSize: configuration.batchSize,
        legacySqliteCallsPerRun: referenceLegacy.sqliteCalls,
        candidateSqliteCallsPerRun: referenceCandidate.sqliteCalls,
        legacyFullMaterializationAndScan: legacyTiming,
        batchedBoundingCandidateQueryAndScan: candidateTiming,
        medianSpeedup: Number((legacyTiming.medianMilliseconds / candidateTiming.medianMilliseconds).toFixed(2)),
        medianMillisecondsSaved: Number(
          (legacyTiming.medianMilliseconds - candidateTiming.medianMilliseconds).toFixed(3),
        ),
        timedRegion:
          "SQLite prepare/execute/decode, JS row hydration, normalized-name indexing, Haversine filtering, and exact/fuzzy selection",
        excludes:
          "source integrity checks, attached R-Tree build, Expo dedicated-connection lifecycle, workload derivation, payload-byte instrumentation, parity hashing, report serialization, and app rendering",
      },
      implementationRisks: [
        "Keep calendar-title and Unicode-aware fuzzy normalization in JavaScript; SQLite only narrows by a conservative 1000 m box.",
        "The isolated legacy materialization only observed rowid order from its unordered SELECT; production candidate grouping explicitly restores rowid order before applying tie behavior.",
        "Split longitude intervals at the antimeridian and search every longitude when a bound reaches a pole; final Haversine checks remain authoritative.",
        "Reject invalid located-reservation coordinates and preserve the guide import invariant that active coordinates are valid and not 0,0.",
        "Chunk VALUES input below SQLite bind limits; the production model uses eight binds per reservation plus two active-dataset binds.",
        "Maintain the R-Tree transactionally when a guide dataset changes; this read-only benchmark builds an attached in-memory equivalent once and reports that excluded build cost separately.",
        "The no-coordinate provider fallback still needs a separate exact-name lookup; the spatial path only replaces matching for located reservations.",
        "Re-benchmark small and very large provider batches on Expo SQLite because Node's row-decoding cost is a proxy, not the React Native bridge itself.",
      ],
    };
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may not have started; preserve the original error.
    }
    throw error;
  } finally {
    database.close();
  }

  assert.equal(sha256File(configuration.databasePath), sourceDatabaseSha256, "Source database bytes changed.");
  assert.deepEqual(
    snapshotProtectedFiles(configuration.databasePath),
    protectedBefore,
    "Source or sidecar state changed.",
  );
  assertAggregateOnlyReport(report, sourceRowsForPrivacyCheck, configuration.databasePath);
  mkdirSync(dirname(configuration.outputPath), { recursive: true });
  writeFileSync(configuration.outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "w" });
  assert.equal(sha256File(configuration.databasePath), sourceDatabaseSha256, "Source changed while writing report.");
  assert.deepEqual(
    snapshotProtectedFiles(configuration.databasePath),
    protectedBefore,
    "Source sidecars changed while writing report.",
  );
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

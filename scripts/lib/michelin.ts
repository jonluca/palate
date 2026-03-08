import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MICHELIN_DB_PATH = fileURLToPath(new URL("../../assets/michelin.db", import.meta.url).toString());
const SQLITE_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

const LOAD_MICHELIN_RESTAURANTS_QUERY = `
WITH latest_award AS (
  SELECT
    restaurant_id,
    year,
    distinction,
    green_star,
    ROW_NUMBER() OVER (PARTITION BY restaurant_id ORDER BY year DESC) AS row_num
  FROM restaurant_awards
)
SELECT
  printf('michelin-%s', r.id) AS id,
  CAST(r.id AS INTEGER) AS sourceRestaurantId,
  r.name AS name,
  r.description AS description,
  r.address AS address,
  r.location AS location,
  CAST(r.latitude AS REAL) AS latitude,
  CAST(r.longitude AS REAL) AS longitude,
  r.cuisine AS cuisine,
  r.phone_number AS phoneNumber,
  r.website_url AS websiteUrl,
  r.url AS sourceUrl,
  la.year AS latestAwardYear,
  la.distinction AS latestDistinction,
  COALESCE(la.green_star, 0) AS hasGreenStar
FROM restaurants r
LEFT JOIN latest_award la
  ON la.restaurant_id = r.id
 AND la.row_num = 1
WHERE r.latitude IS NOT NULL
  AND r.longitude IS NOT NULL
  AND TRIM(r.latitude) <> ''
  AND TRIM(r.longitude) <> ''
ORDER BY r.id
`;

interface MichelinRestaurantRow {
  id: string;
  sourceRestaurantId: number;
  name: string | null;
  description: string | null;
  address: string | null;
  location: string | null;
  latitude: number | string;
  longitude: number | string;
  cuisine: string | null;
  phoneNumber: string | null;
  websiteUrl: string | null;
  sourceUrl: string | null;
  latestAwardYear: number | null;
  latestDistinction: string | null;
  hasGreenStar: number | boolean | null;
}

export interface MichelinCanonicalRestaurantSeed {
  id: string;
  source: "michelin";
  sourceRestaurantId: number;
  name: string;
  description: string;
  address: string;
  location: string;
  latitude: number;
  longitude: number;
  cuisine: string;
  phoneNumber: string | null;
  websiteUrl: string | null;
  sourceUrl: string | null;
  latestAwardYear: number | null;
  award: string;
  hasGreenStar: boolean;
}

function toRequiredString(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function toNullableString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toCoordinate(value: number | string) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Michelin coordinate: ${value}`);
  }

  return parsed;
}

export function buildAwardLabel(latestDistinction: string | null, hasGreenStar: boolean) {
  const distinction = latestDistinction?.trim() ?? "";

  if (hasGreenStar) {
    return distinction ? `${distinction}, Green Star` : "Green Star";
  }

  return distinction;
}

export async function loadMichelinCanonicalRestaurants(): Promise<MichelinCanonicalRestaurantSeed[]> {
  let stdout: string;

  try {
    const response = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", MICHELIN_DB_PATH, LOAD_MICHELIN_RESTAURANTS_QUERY],
      {
        encoding: "utf8",
        maxBuffer: SQLITE_MAX_BUFFER_BYTES,
      },
    );
    stdout = response.stdout;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The sqlite3 CLI is required to seed Michelin data, but it was not found on PATH.", {
        cause: error,
      });
    }

    throw error;
  }

  const rows = JSON.parse(stdout) as MichelinRestaurantRow[];

  return rows
    .map((row) => {
      const latitude = toCoordinate(row.latitude);
      const longitude = toCoordinate(row.longitude);
      const hasGreenStar = Boolean(row.hasGreenStar);

      if ((latitude === 0 && longitude === 0) || !row.name?.trim()) {
        return null;
      }

      return {
        id: row.id,
        source: "michelin" as const,
        sourceRestaurantId: row.sourceRestaurantId,
        name: row.name.trim(),
        description: toRequiredString(row.description),
        address: toRequiredString(row.address),
        location: toRequiredString(row.location),
        latitude,
        longitude,
        cuisine: toRequiredString(row.cuisine),
        phoneNumber: toNullableString(row.phoneNumber),
        websiteUrl: toNullableString(row.websiteUrl),
        sourceUrl: toNullableString(row.sourceUrl),
        latestAwardYear: row.latestAwardYear,
        award: buildAwardLabel(row.latestDistinction, hasGreenStar),
        hasGreenStar,
      };
    })
    .filter((row): row is MichelinCanonicalRestaurantSeed => row !== null);
}

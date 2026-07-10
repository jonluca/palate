import type { PhotoRecord, RestaurantRecord, VisitRecord } from "./db/types";

export interface ExportData {
  exportedAt: string;
  stats: {
    totalVisits: number;
    confirmedVisits: number;
    totalPhotos: number;
    uniqueRestaurants: number;
  };
  visits: Array<{
    visitId: string;
    status: string;
    suggestedRestaurantId: string | null;
    restaurant: {
      id: string;
      name: string;
      latitude: number;
      longitude: number;
      address: string | null;
      phone: string | null;
      website: string | null;
      googlePlaceId: string | null;
      cuisine: string | null;
      priceLevel: number | null;
      rating: number | null;
      notes: string | null;
    } | null;
    visitDate: string;
    startTime: string;
    endTime: string;
    duration: string;
    startTimestamp: number;
    endTimestamp: number;
    location: {
      latitude: number;
      longitude: number;
    };
    photoCount: number;
    foodProbable: boolean;
    awardAtVisit: string | null;
    notes: string | null;
    calendarEvent: {
      id: string | null;
      title: string | null;
      location: string | null;
      isAllDay: boolean | null;
    };
    exportedToCalendarId: string | null;
    updatedAt: string | null;
    photos: Array<{
      id: string;
      uri: string;
      createdAt: string;
      latitude: number | null;
      longitude: number | null;
      mediaType: "photo" | "video";
      duration: number | null;
      foodDetected: boolean | null;
      foodConfidence: number | null | undefined;
      foodLabels: PhotoRecord["foodLabels"] | null | undefined;
      allLabels: PhotoRecord["allLabels"] | null | undefined;
    }>;
  }>;
  restaurants: Array<{
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    visitCount: number;
    address: string | null;
    phone: string | null;
    website: string | null;
    googlePlaceId: string | null;
    cuisine: string | null;
    priceLevel: number | null;
    rating: number | null;
    notes: string | null;
  }>;
}

export type ExportVisit = ExportData["visits"][number];
export type ExportVisitPhoto = ExportVisit["photos"][number];

export interface BuildExportDataInput {
  readonly visits: readonly VisitRecord[];
  readonly restaurants: readonly RestaurantRecord[];
  readonly photosByVisitId: ReadonlyMap<string, readonly PhotoRecord[]>;
  readonly exportedAt: string;
}

export interface BuildExportVisitsInput {
  readonly visits: readonly VisitRecord[];
  readonly restaurants: readonly RestaurantRecord[];
  readonly photosByVisitId: ReadonlyMap<string, readonly PhotoRecord[]>;
}

export interface BuildExportDataFromVisitsInput {
  readonly visits: readonly ExportVisit[];
  readonly restaurants: readonly RestaurantRecord[];
  readonly exportedAt: string;
}

/** Replace denormalized visit counts with exact counts from the export snapshot. */
export function withExactExportPhotoCounts(
  visits: readonly ExportVisit[],
  photoCountsByVisitId: ReadonlyMap<string, number>,
): ExportVisit[] {
  const visitIds = new Set(visits.map((visit) => visit.visitId));
  if (visitIds.size !== visits.length) {
    throw new RangeError("Export visits must have unique visit IDs.");
  }

  for (const [visitId, photoCount] of photoCountsByVisitId) {
    if (!visitIds.has(visitId)) {
      throw new RangeError(`Export photo count map contains unexpected visit ID ${JSON.stringify(visitId)}.`);
    }
    if (!Number.isSafeInteger(photoCount) || photoCount < 0) {
      throw new RangeError(`Photo count for visit ${JSON.stringify(visitId)} must be a non-negative safe integer.`);
    }
  }

  return visits.map((visit) => {
    if (!photoCountsByVisitId.has(visit.visitId)) {
      throw new RangeError(`Export photo count map is missing visit ID ${JSON.stringify(visit.visitId)}.`);
    }
    return { ...visit, photoCount: photoCountsByVisitId.get(visit.visitId)! };
  });
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0];
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(start: number, end: number): string {
  const diffMs = end - start;
  const diffMins = Math.round(diffMs / (1000 * 60));
  if (diffMins < 60) {
    return `${diffMins} minutes`;
  }
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours} hours`;
}

/** Convert one parsed database photo without retaining its raw JSON row. */
export function buildExportPhoto(photo: PhotoRecord): ExportVisitPhoto {
  return {
    id: photo.id,
    uri: photo.uri,
    createdAt: new Date(photo.creationTime).toISOString(),
    latitude: photo.latitude,
    longitude: photo.longitude,
    mediaType: photo.mediaType,
    duration: photo.duration,
    foodDetected: photo.foodDetected,
    foodConfidence: photo.foodConfidence,
    foodLabels: photo.foodLabels,
    allLabels: photo.allLabels,
  };
}

/** Build visit rows, allowing callers to append bounded photo pages later. */
export function buildExportVisits(input: BuildExportVisitsInput): ExportVisit[] {
  const restaurantsById = new Map(input.restaurants.map((restaurant) => [restaurant.id, restaurant]));

  return input.visits.map((visit) => {
    const restaurant = visit.restaurantId ? (restaurantsById.get(visit.restaurantId) ?? null) : null;
    const photos = input.photosByVisitId.get(visit.id) ?? [];
    return {
      visitId: visit.id,
      status: visit.status,
      restaurant: restaurant
        ? {
            id: restaurant.id,
            name: restaurant.name,
            latitude: restaurant.latitude,
            longitude: restaurant.longitude,
            address: restaurant.address,
            phone: restaurant.phone,
            website: restaurant.website,
            googlePlaceId: restaurant.googlePlaceId,
            cuisine: restaurant.cuisine,
            priceLevel: restaurant.priceLevel,
            rating: restaurant.rating,
            notes: restaurant.notes,
          }
        : null,
      suggestedRestaurantId: visit.suggestedRestaurantId,
      visitDate: formatDate(visit.startTime),
      startTime: formatTime(visit.startTime),
      endTime: formatTime(visit.endTime),
      duration: formatDuration(visit.startTime, visit.endTime),
      startTimestamp: visit.startTime,
      endTimestamp: visit.endTime,
      location: {
        latitude: visit.centerLat,
        longitude: visit.centerLon,
      },
      photoCount: visit.photoCount,
      foodProbable: Boolean(visit.foodProbable),
      awardAtVisit: visit.awardAtVisit,
      notes: visit.notes,
      calendarEvent: {
        id: visit.calendarEventId,
        title: visit.calendarEventTitle,
        location: visit.calendarEventLocation,
        isAllDay: visit.calendarEventIsAllDay === null ? null : Boolean(visit.calendarEventIsAllDay),
      },
      exportedToCalendarId: visit.exportedToCalendarId,
      updatedAt: visit.updatedAt ? new Date(visit.updatedAt).toISOString() : null,
      photos: photos.map(buildExportPhoto),
    };
  });
}

/** Finalize aggregate statistics and restaurant rows from built visit rows. */
export function buildExportDataFromVisits(input: BuildExportDataFromVisitsInput): ExportData {
  const visits = [...input.visits];
  const restaurantVisitCounts = new Map<string, number>();
  for (const visit of visits) {
    if (visit.restaurant) {
      restaurantVisitCounts.set(visit.restaurant.id, (restaurantVisitCounts.get(visit.restaurant.id) ?? 0) + 1);
    }
  }

  const visitedRestaurantIds = new Set(visits.map((visit) => visit.restaurant?.id).filter(Boolean));
  const restaurants = input.restaurants
    .filter((restaurant) => visitedRestaurantIds.has(restaurant.id))
    .map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      visitCount: restaurantVisitCounts.get(restaurant.id) ?? 0,
      address: restaurant.address,
      phone: restaurant.phone,
      website: restaurant.website,
      googlePlaceId: restaurant.googlePlaceId,
      cuisine: restaurant.cuisine,
      priceLevel: restaurant.priceLevel,
      rating: restaurant.rating,
      notes: restaurant.notes,
    }))
    .sort((left, right) => right.visitCount - left.visitCount);

  return {
    exportedAt: input.exportedAt,
    stats: {
      totalVisits: visits.length,
      confirmedVisits: visits.filter((visit) => visit.status === "confirmed").length,
      totalPhotos: visits.reduce((sum, visit) => sum + visit.photoCount, 0),
      uniqueRestaurants: restaurants.length,
    },
    visits,
    restaurants,
  };
}

/** Build the stable public export shape from already-batched database rows. */
export function buildExportData(input: BuildExportDataInput): ExportData {
  return buildExportDataFromVisits({
    visits: buildExportVisits(input),
    restaurants: input.restaurants,
    exportedAt: input.exportedAt,
  });
}

export function exportDataToJSONString(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}

export function exportDataToCSVString(data: ExportData): string {
  const headers = [
    "Visit Date",
    "Start Time",
    "End Time",
    "Duration",
    "Restaurant Name",
    "Restaurant ID",
    "Status",
    "Photo Count",
    "Latitude",
    "Longitude",
    "Visit ID",
  ];
  const rows = data.visits.map((visit) => [
    visit.visitDate,
    visit.startTime,
    visit.endTime,
    visit.duration,
    visit.restaurant?.name || "Unknown",
    visit.restaurant?.id || "",
    visit.status,
    visit.photoCount.toString(),
    visit.location.latitude.toFixed(6),
    visit.location.longitude.toFixed(6),
    visit.visitId,
  ]);

  return [headers.join(","), ...rows.map((row) => row.map((cell) => `"${cell}"`).join(","))].join("\n");
}

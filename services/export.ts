import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  getVisits,
  getPhotosByVisitId,
  getAllRestaurants,
  getRestaurantById,
  type PhotoRecord,
  type RestaurantRecord,
} from "@/utils/db";

interface ExportData {
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

export type ExportFormat = "json" | "csv";

export interface ExportShareResult {
  fileUri: string | null;
  fileName: string | null;
  savedToFile: boolean;
  shared: boolean;
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

function formatTimestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function ensureExportDirectory(baseDir: Directory): Directory {
  const exportDir = new Directory(baseDir, "exports");
  exportDir.create({ intermediates: true, idempotent: true });
  return exportDir;
}

async function generateExportData(
  options: {
    includePhotos?: boolean;
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<ExportData> {
  const { includePhotos = true, statusFilter = "confirmed" } = options;

  // Get visits
  const visitsEntries = await getVisits(statusFilter === "all" ? undefined : statusFilter);

  // Get all restaurants
  const allRestaurants = await getAllRestaurants();
  const restaurantVisitCounts = new Map<string, number>();

  // Build visits data
  const visits = await Promise.all(
    visitsEntries.map(async (visit) => {
      let restaurant: RestaurantRecord | null = null;
      if (visit.restaurantId) {
        restaurant = await getRestaurantById(visit.restaurantId);
        if (restaurant) {
          restaurantVisitCounts.set(restaurant.id, (restaurantVisitCounts.get(restaurant.id) || 0) + 1);
        }
      }

      let photos: PhotoRecord[] = [];
      if (includePhotos) {
        photos = await getPhotosByVisitId(visit.id);
      }

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
        foodProbable: visit.foodProbable,
        awardAtVisit: visit.awardAtVisit,
        notes: visit.notes,
        calendarEvent: {
          id: visit.calendarEventId,
          title: visit.calendarEventTitle,
          location: visit.calendarEventLocation,
          isAllDay: visit.calendarEventIsAllDay,
        },
        exportedToCalendarId: visit.exportedToCalendarId,
        updatedAt: visit.updatedAt ? new Date(visit.updatedAt).toISOString() : null,
        photos: photos.map((p) => ({
          id: p.id,
          uri: p.uri,
          createdAt: new Date(p.creationTime).toISOString(),
          latitude: p.latitude,
          longitude: p.longitude,
          mediaType: p.mediaType,
          duration: p.duration,
          foodDetected: p.foodDetected,
          foodConfidence: p.foodConfidence,
          foodLabels: p.foodLabels,
          allLabels: p.allLabels,
        })),
      };
    }),
  );

  // Build restaurants with visit counts
  const visitedRestaurantIds = new Set(visits.map((c) => c.restaurant?.id).filter(Boolean));
  const restaurants = allRestaurants
    .filter((r) => visitedRestaurantIds.has(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      visitCount: restaurantVisitCounts.get(r.id) || 0,
      address: r.address,
      phone: r.phone,
      website: r.website,
      googlePlaceId: r.googlePlaceId,
      cuisine: r.cuisine,
      priceLevel: r.priceLevel,
      rating: r.rating,
      notes: r.notes,
    }))
    .sort((a, b) => b.visitCount - a.visitCount);

  const totalPhotos = visits.reduce((sum, v) => sum + v.photoCount, 0);

  return {
    exportedAt: new Date().toISOString(),
    stats: {
      totalVisits: visits.length,
      confirmedVisits: visits.filter((c) => c.status === "confirmed").length,
      totalPhotos,
      uniqueRestaurants: restaurants.length,
    },
    visits,
    restaurants,
  };
}

async function generateJSONString(
  options: {
    includePhotos?: boolean;
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<string> {
  const data = await generateExportData(options);
  return JSON.stringify(data, null, 2);
}

async function generateCSVString(
  options: {
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<string> {
  const data = await generateExportData({ ...options, includePhotos: false });

  // Build CSV
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

  const rows = data.visits.map((v) => [
    v.visitDate,
    v.startTime,
    v.endTime,
    v.duration,
    v.restaurant?.name || "Unknown",
    v.restaurant?.id || "",
    v.status,
    v.photoCount.toString(),
    v.location.latitude.toFixed(6),
    v.location.longitude.toFixed(6),
    v.visitId,
  ]);

  return [headers.join(","), ...rows.map((r) => r.map((cell) => `"${cell}"`).join(","))].join("\n");
}

export async function exportToJSON(
  options: {
    includePhotos?: boolean;
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<string> {
  return generateJSONString(options);
}

export async function exportToCSV(
  options: {
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<string> {
  return generateCSVString(options);
}

export async function shareExport(data: string, format: ExportFormat): Promise<ExportShareResult> {
  const baseDir = Paths.document ?? Paths.cache;
  const exportDir = ensureExportDirectory(baseDir);
  const timestamp = formatTimestampForFilename(new Date());
  const fileName = `palate-export-${timestamp}.${format}`;
  const file = new File(exportDir, fileName);
  file.write(data, { encoding: "utf8" });
  const canShare = await Sharing.isAvailableAsync();
  let shared = false;
  if (canShare) {
    const mimeType = format === "json" ? "application/json" : "text/csv";
    await Sharing.shareAsync(file.uri, {
      mimeType,
      dialogTitle: "Share export",
    });
    shared = true;
  } else {
    console.warn("Sharing not available on this device.");
  }

  return {
    fileUri: file.uri,
    fileName,
    savedToFile: true,
    shared,
  };
}

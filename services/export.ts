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
    restaurant: {
      id: string;
      name: string;
      latitude: number;
      longitude: number;
    } | null;
    visitDate: string;
    startTime: string;
    endTime: string;
    duration: string;
    location: {
      latitude: number;
      longitude: number;
    };
    photoCount: number;
    photos: Array<{
      id: string;
      uri: string;
      createdAt: string;
    }>;
  }>;
  restaurants: Array<{
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    visitCount: number;
  }>;
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
            }
          : null,
        visitDate: formatDate(visit.startTime),
        startTime: formatTime(visit.startTime),
        endTime: formatTime(visit.endTime),
        duration: formatDuration(visit.startTime, visit.endTime),
        location: {
          latitude: visit.centerLat,
          longitude: visit.centerLon,
        },
        photoCount: visit.photoCount,
        photos: photos.map((p) => ({
          id: p.id,
          uri: p.uri,
          createdAt: new Date(p.creationTime).toISOString(),
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

// For now, we just return the data as a string
// In a full implementation, you'd write to a temp file and share it
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

// Placeholder - in production you'd write to a file and share
export async function shareExport(data: string): Promise<void> {
  console.log("Export data:", data.substring(0, 500) + "...");
  // TODO: Implement proper file sharing when expo-file-system is available
}

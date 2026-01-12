import type { MichelinRestaurantRecord } from "@/utils/db";

// Calculate distance between two GPS coordinates in meters using Haversine formula
export function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

// Find nearby Michelin restaurants sorted by distance (returns multiple options)
export function findNearbyMichelinRestaurants(
  lat: number,
  lon: number,
  restaurants: MichelinRestaurantRecord[],
  maxDistanceMeters: number = 500,
  limit: number = 5,
): Array<MichelinRestaurantRecord & { distance: number }> {
  const nearby: Array<MichelinRestaurantRecord & { distance: number }> = [];

  for (const restaurant of restaurants) {
    const distance = calculateDistanceMeters(lat, lon, restaurant.latitude, restaurant.longitude);
    if (distance <= maxDistanceMeters) {
      nearby.push({ ...restaurant, distance });
    }
  }

  // Sort by distance and limit
  return nearby.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

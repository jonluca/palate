import { getDatabase } from "./core";
import { invalidateRestaurantIndex } from "./michelin-index";
import type { MichelinRestaurantRecord } from "./types";

// Michelin restaurant operations
export async function insertMichelinRestaurants(restaurants: MichelinRestaurantRecord[]): Promise<void> {
  if (restaurants.length === 0) {
    return;
  }

  const database = await getDatabase();
  const batchSize = 1000;

  for (let i = 0; i < restaurants.length; i += batchSize) {
    const batch = restaurants.slice(i, i + batchSize);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = batch.flatMap((r) => [
      r.id,
      r.name,
      r.latitude,
      r.longitude,
      r.address,
      r.location,
      r.cuisine,
      r.award,
    ]);

    await database.runAsync(
      `INSERT OR IGNORE INTO michelin_restaurants (id, name, latitude, longitude, address, location, cuisine, award) VALUES ${placeholders}`,
      values,
    );
  }

  // Invalidate spatial index so it rebuilds with new data
  invalidateRestaurantIndex();
}

export async function getMichelinRestaurantCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM michelin_restaurants`);
  return result?.count ?? 0;
}

export async function getAllMichelinRestaurants(): Promise<MichelinRestaurantRecord[]> {
  const database = await getDatabase();
  return database.getAllAsync<MichelinRestaurantRecord>(`SELECT * FROM michelin_restaurants`);
}

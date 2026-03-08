import { sql } from "drizzle-orm";
import { closeDatabaseConnection, db } from "../server/db/client";
import { canonicalRestaurant } from "../server/db/schema";
import { loadMichelinCanonicalRestaurants } from "./lib/michelin";

const BATCH_SIZE = 500;

async function main() {
  const startedAt = Date.now();
  const restaurants = await loadMichelinCanonicalRestaurants();

  if (restaurants.length === 0) {
    console.log("No Michelin restaurants found to seed.");
    return;
  }

  console.log(`Loaded ${restaurants.length.toLocaleString()} Michelin restaurants from SQLite.`);

  for (let index = 0; index < restaurants.length; index += BATCH_SIZE) {
    const batch = restaurants.slice(index, index + BATCH_SIZE);

    await db
      .insert(canonicalRestaurant)
      .values(batch)
      .onConflictDoUpdate({
        target: canonicalRestaurant.id,
        set: {
          source: sql`excluded.source`,
          sourceRestaurantId: sql`excluded.source_restaurant_id`,
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          address: sql`excluded.address`,
          location: sql`excluded.location`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          cuisine: sql`excluded.cuisine`,
          phoneNumber: sql`excluded.phone_number`,
          websiteUrl: sql`excluded.website_url`,
          sourceUrl: sql`excluded.source_url`,
          latestAwardYear: sql`excluded.latest_award_year`,
          award: sql`excluded.award`,
          hasGreenStar: sql`excluded.has_green_star`,
          updatedAt: sql`now()`,
        },
      });

    console.log(
      `Upserted ${Math.min(index + batch.length, restaurants.length).toLocaleString()} / ${restaurants.length.toLocaleString()}`,
    );
  }

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(canonicalRestaurant);

  console.log(
    `Seeded ${count.toLocaleString()} canonical restaurants in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
  );
}

async function run() {
  try {
    await main();
  } catch (error) {
    console.error("Failed to seed canonical restaurants.");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
  }
}

void run();

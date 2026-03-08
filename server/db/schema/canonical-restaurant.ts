import { boolean, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const canonicalRestaurant = pgTable(
  "canonical_restaurant",
  {
    id: text("id").primaryKey(),
    source: text("source").default("michelin").notNull(),
    sourceRestaurantId: integer("source_restaurant_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    address: text("address").notNull().default(""),
    location: text("location").notNull().default(""),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    cuisine: text("cuisine").notNull().default(""),
    phoneNumber: text("phone_number"),
    websiteUrl: text("website_url"),
    sourceUrl: text("source_url"),
    latestAwardYear: integer("latest_award_year"),
    award: text("award").notNull().default(""),
    hasGreenStar: boolean("has_green_star").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("canonical_restaurant_source_source_id_idx").on(table.source, table.sourceRestaurantId),
    index("canonical_restaurant_name_idx").on(table.name),
    index("canonical_restaurant_location_idx").on(table.location),
    index("canonical_restaurant_name_location_idx").on(table.name, table.location),
    index("canonical_restaurant_award_year_name_idx").on(table.award, table.latestAwardYear.desc(), table.name),
    index("canonical_restaurant_lat_lon_idx").on(table.latitude, table.longitude),
  ],
);

export type CanonicalRestaurant = typeof canonicalRestaurant.$inferSelect;
export type NewCanonicalRestaurant = typeof canonicalRestaurant.$inferInsert;

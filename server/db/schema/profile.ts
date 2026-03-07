import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const userProfile = pgTable("user_profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  bio: text("bio"),
  homeCity: text("home_city"),
  favoriteCuisine: text("favorite_cuisine"),
  publicVisits: boolean("public_visits").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userConfirmedVisit = pgTable(
  "user_confirmed_visit",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    localVisitId: text("local_visit_id").notNull(),
    restaurantId: text("restaurant_id"),
    restaurantName: text("restaurant_name").notNull(),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    centerLat: doublePrecision("center_lat").notNull(),
    centerLon: doublePrecision("center_lon").notNull(),
    photoCount: integer("photo_count").default(0).notNull(),
    awardAtVisit: text("award_at_visit"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.localVisitId],
      name: "user_confirmed_visit_pk",
    }),
    index("user_confirmed_visit_user_start_idx").on(table.userId, table.startTime),
  ],
);

export const userFollow = pgTable(
  "user_follow",
  {
    followerId: text("follower_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    followeeId: text("followee_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.followerId, table.followeeId],
      name: "user_follow_pk",
    }),
    index("user_follow_followee_idx").on(table.followeeId),
    index("user_follow_follower_idx").on(table.followerId),
  ],
);

export const userConfirmedVisitLike = pgTable(
  "user_confirmed_visit_like",
  {
    visitUserId: text("visit_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    visitLocalVisitId: text("visit_local_visit_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.visitUserId, table.visitLocalVisitId, table.userId],
      name: "user_confirmed_visit_like_pk",
    }),
    foreignKey({
      name: "user_confirmed_visit_like_visit_fk",
      columns: [table.visitUserId, table.visitLocalVisitId],
      foreignColumns: [userConfirmedVisit.userId, userConfirmedVisit.localVisitId],
    }).onDelete("cascade"),
    index("user_confirmed_visit_like_user_idx").on(table.userId),
    index("user_confirmed_visit_like_visit_idx").on(table.visitUserId, table.visitLocalVisitId),
  ],
);

export const userConfirmedVisitComment = pgTable(
  "user_confirmed_visit_comment",
  {
    id: text("id").primaryKey(),
    visitUserId: text("visit_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    visitLocalVisitId: text("visit_local_visit_id").notNull(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "user_confirmed_visit_comment_visit_fk",
      columns: [table.visitUserId, table.visitLocalVisitId],
      foreignColumns: [userConfirmedVisit.userId, userConfirmedVisit.localVisitId],
    }).onDelete("cascade"),
    index("user_confirmed_visit_comment_author_idx").on(table.authorUserId),
    index("user_confirmed_visit_comment_visit_idx").on(table.visitUserId, table.visitLocalVisitId, table.createdAt),
  ],
);

export type UserProfile = typeof userProfile.$inferSelect;
export type NewUserProfile = typeof userProfile.$inferInsert;
export type UserConfirmedVisit = typeof userConfirmedVisit.$inferSelect;
export type NewUserConfirmedVisit = typeof userConfirmedVisit.$inferInsert;
export type UserFollow = typeof userFollow.$inferSelect;
export type UserConfirmedVisitLike = typeof userConfirmedVisitLike.$inferSelect;
export type NewUserConfirmedVisitLike = typeof userConfirmedVisitLike.$inferInsert;
export type UserConfirmedVisitComment = typeof userConfirmedVisitComment.$inferSelect;
export type NewUserConfirmedVisitComment = typeof userConfirmedVisitComment.$inferInsert;

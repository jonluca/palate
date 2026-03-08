import { randomUUID } from "node:crypto";
import { inArray, or } from "drizzle-orm";
import { closeDatabaseConnection, db } from "../server/db/client";
import { user } from "../server/db/schema/auth-schema";
import {
  userConfirmedVisit,
  userConfirmedVisitComment,
  userConfirmedVisitLike,
  userFollow,
  userProfile,
} from "../server/db/schema/profile";
import type { MichelinCanonicalRestaurantSeed } from "./lib/michelin";
import { loadMichelinCanonicalRestaurants } from "./lib/michelin";

type DemoUserKey =
  | "lena-park"
  | "marcus-bell"
  | "sofia-moretti"
  | "kenji-tanaka"
  | "priya-desai"
  | "mateo-alvarez"
  | "noa-levy"
  | "claire-dubois";

interface VisitPlan {
  cityToken: string;
  offset: number;
  daysAgo: number;
  durationHours: number;
}

interface DemoUserPlan {
  key: DemoUserKey;
  name: string;
  email: string;
  homeCity: string;
  favoriteCuisine: string;
  bio: string;
  visits: VisitPlan[];
}

interface FollowEdge {
  followerKey: DemoUserKey;
  followeeKey: DemoUserKey;
}

interface LikePlan {
  visitUserKey: DemoUserKey;
  visitIndex: number;
  likedByKey: DemoUserKey;
}

interface CommentPlan {
  visitUserKey: DemoUserKey;
  visitIndex: number;
  authorKey: DemoUserKey;
  body: string;
}

const DEMO_USERS: DemoUserPlan[] = [
  {
    key: "lena-park",
    name: "Lena Park",
    email: "palate-demo+lena@palate.test",
    homeCity: "San Francisco",
    favoriteCuisine: "Japanese Contemporary",
    bio: "Keeps a running list of tasting menus, hand rolls, and late-night noodles.",
    visits: [
      { cityToken: "San Francisco", offset: 0, daysAgo: 4, durationHours: 2 },
      { cityToken: "San Francisco", offset: 5, daysAgo: 18, durationHours: 2 },
      { cityToken: "San Francisco", offset: 11, daysAgo: 41, durationHours: 3 },
      { cityToken: "New York", offset: 2, daysAgo: 73, durationHours: 2 },
    ],
  },
  {
    key: "marcus-bell",
    name: "Marcus Bell",
    email: "palate-demo+marcus@palate.test",
    homeCity: "New York",
    favoriteCuisine: "Seafood",
    bio: "Usually booking the first counter seat and comparing wine pairings.",
    visits: [
      { cityToken: "New York", offset: 0, daysAgo: 2, durationHours: 2 },
      { cityToken: "New York", offset: 8, daysAgo: 15, durationHours: 2 },
      { cityToken: "New York", offset: 15, daysAgo: 36, durationHours: 3 },
      { cityToken: "San Francisco", offset: 5, daysAgo: 69, durationHours: 2 },
    ],
  },
  {
    key: "sofia-moretti",
    name: "Sofia Moretti",
    email: "palate-demo+sofia@palate.test",
    homeCity: "Paris",
    favoriteCuisine: "Classic French",
    bio: "Alternates between old-school dining rooms and tiny neighborhood bistros.",
    visits: [
      { cityToken: "Paris, France", offset: 0, daysAgo: 5, durationHours: 2 },
      { cityToken: "Paris, France", offset: 9, daysAgo: 19, durationHours: 2 },
      { cityToken: "Paris, France", offset: 22, daysAgo: 47, durationHours: 3 },
      { cityToken: "Barcelona", offset: 3, daysAgo: 81, durationHours: 2 },
    ],
  },
  {
    key: "kenji-tanaka",
    name: "Kenji Tanaka",
    email: "palate-demo+kenji@palate.test",
    homeCity: "Tokyo",
    favoriteCuisine: "Sushi",
    bio: "Chases seasonal menus and keeps notes on rice texture and tea service.",
    visits: [
      { cityToken: "Tokyo, Japan", offset: 0, daysAgo: 3, durationHours: 2 },
      { cityToken: "Tokyo, Japan", offset: 12, daysAgo: 17, durationHours: 2 },
      { cityToken: "Tokyo, Japan", offset: 28, daysAgo: 38, durationHours: 3 },
      { cityToken: "Singapore", offset: 4, daysAgo: 78, durationHours: 2 },
    ],
  },
  {
    key: "priya-desai",
    name: "Priya Desai",
    email: "palate-demo+priya@palate.test",
    homeCity: "Singapore",
    favoriteCuisine: "Indian",
    bio: "Finds the tasting-menu restaurants that still feel relaxed enough for a weeknight.",
    visits: [
      { cityToken: "Singapore", offset: 0, daysAgo: 6, durationHours: 2 },
      { cityToken: "Singapore", offset: 9, daysAgo: 23, durationHours: 2 },
      { cityToken: "Singapore", offset: 18, daysAgo: 43, durationHours: 2 },
      { cityToken: "Tokyo, Japan", offset: 12, daysAgo: 71, durationHours: 2 },
    ],
  },
  {
    key: "mateo-alvarez",
    name: "Mateo Alvarez",
    email: "palate-demo+mateo@palate.test",
    homeCity: "Barcelona",
    favoriteCuisine: "Catalan",
    bio: "Likes long lunches, bright seafood, and restaurants with a point of view.",
    visits: [
      { cityToken: "Barcelona", offset: 0, daysAgo: 7, durationHours: 2 },
      { cityToken: "Barcelona", offset: 7, daysAgo: 26, durationHours: 2 },
      { cityToken: "Barcelona", offset: 14, daysAgo: 52, durationHours: 3 },
      { cityToken: "Paris, France", offset: 9, daysAgo: 88, durationHours: 2 },
    ],
  },
  {
    key: "noa-levy",
    name: "Noa Levy",
    email: "palate-demo+noa@palate.test",
    homeCity: "New York",
    favoriteCuisine: "Levantine",
    bio: "Collects bar seats, tasting counters, and the best desserts on the menu.",
    visits: [
      { cityToken: "New York", offset: 0, daysAgo: 9, durationHours: 2 },
      { cityToken: "New York", offset: 11, daysAgo: 21, durationHours: 2 },
      { cityToken: "New York", offset: 24, daysAgo: 44, durationHours: 2 },
      { cityToken: "Paris, France", offset: 0, daysAgo: 76, durationHours: 2 },
    ],
  },
  {
    key: "claire-dubois",
    name: "Claire Dubois",
    email: "palate-demo+claire@palate.test",
    homeCity: "Paris",
    favoriteCuisine: "Bistronomy",
    bio: "Always has a short list of places worth repeating before the menu changes.",
    visits: [
      { cityToken: "Paris, France", offset: 0, daysAgo: 8, durationHours: 2 },
      { cityToken: "Paris, France", offset: 14, daysAgo: 27, durationHours: 2 },
      { cityToken: "Paris, France", offset: 29, daysAgo: 57, durationHours: 2 },
      { cityToken: "New York", offset: 8, daysAgo: 92, durationHours: 2 },
    ],
  },
];

const FOLLOW_EDGES: FollowEdge[] = [
  { followerKey: "lena-park", followeeKey: "marcus-bell" },
  { followerKey: "lena-park", followeeKey: "claire-dubois" },
  { followerKey: "marcus-bell", followeeKey: "lena-park" },
  { followerKey: "marcus-bell", followeeKey: "noa-levy" },
  { followerKey: "sofia-moretti", followeeKey: "claire-dubois" },
  { followerKey: "sofia-moretti", followeeKey: "mateo-alvarez" },
  { followerKey: "kenji-tanaka", followeeKey: "priya-desai" },
  { followerKey: "priya-desai", followeeKey: "kenji-tanaka" },
  { followerKey: "mateo-alvarez", followeeKey: "sofia-moretti" },
  { followerKey: "mateo-alvarez", followeeKey: "marcus-bell" },
  { followerKey: "noa-levy", followeeKey: "marcus-bell" },
  { followerKey: "noa-levy", followeeKey: "claire-dubois" },
  { followerKey: "claire-dubois", followeeKey: "sofia-moretti" },
  { followerKey: "claire-dubois", followeeKey: "lena-park" },
];

const LIKE_PLANS: LikePlan[] = [
  { visitUserKey: "marcus-bell", visitIndex: 0, likedByKey: "lena-park" },
  { visitUserKey: "lena-park", visitIndex: 1, likedByKey: "marcus-bell" },
  { visitUserKey: "claire-dubois", visitIndex: 0, likedByKey: "sofia-moretti" },
  { visitUserKey: "priya-desai", visitIndex: 1, likedByKey: "kenji-tanaka" },
  { visitUserKey: "kenji-tanaka", visitIndex: 2, likedByKey: "priya-desai" },
  { visitUserKey: "sofia-moretti", visitIndex: 3, likedByKey: "mateo-alvarez" },
  { visitUserKey: "noa-levy", visitIndex: 0, likedByKey: "marcus-bell" },
  { visitUserKey: "marcus-bell", visitIndex: 1, likedByKey: "noa-levy" },
];

const COMMENT_PLANS: CommentPlan[] = [
  {
    visitUserKey: "marcus-bell",
    visitIndex: 0,
    authorKey: "lena-park",
    body: "Saving this one for my next New York trip.",
  },
  {
    visitUserKey: "lena-park",
    visitIndex: 1,
    authorKey: "claire-dubois",
    body: "The plating looks great. Adding it to my SF list.",
  },
  {
    visitUserKey: "claire-dubois",
    visitIndex: 0,
    authorKey: "sofia-moretti",
    body: "This room always makes me want to book another lunch.",
  },
  {
    visitUserKey: "priya-desai",
    visitIndex: 1,
    authorKey: "kenji-tanaka",
    body: "That menu sounds exactly right for a midweek dinner.",
  },
  {
    visitUserKey: "mateo-alvarez",
    visitIndex: 0,
    authorKey: "sofia-moretti",
    body: "Barcelona keeps pulling me back. This spot looks worth the detour.",
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let viewerEmail: string | null = null;
  let viewerId: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--viewer-email") {
      const nextValue = args[index + 1];
      if (!nextValue || nextValue.startsWith("--")) {
        throw new Error("Expected a value after --viewer-email.");
      }
      viewerEmail = nextValue;
      index += 1;
      continue;
    }

    if (arg === "--viewer-id") {
      const nextValue = args[index + 1];
      if (!nextValue || nextValue.startsWith("--")) {
        throw new Error("Expected a value after --viewer-id.");
      }
      viewerId = nextValue;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (viewerEmail && viewerId) {
    throw new Error("Provide either --viewer-email or --viewer-id, not both.");
  }

  return { viewerEmail, viewerId };
}

function getDemoUserId(key: DemoUserKey) {
  return `demo-user-${key}`;
}

function getVisitLocalId(key: DemoUserKey, visitIndex: number) {
  return `demo-visit-${key}-${visitIndex + 1}`;
}

function normalizeLocationToken(token: string) {
  return token.toLowerCase();
}

function getRestaurantPool(restaurants: MichelinCanonicalRestaurantSeed[], token: string) {
  const normalizedToken = normalizeLocationToken(token);

  return restaurants.filter((restaurant) => restaurant.location.toLowerCase().includes(normalizedToken));
}

function pickRestaurant(
  restaurants: MichelinCanonicalRestaurantSeed[],
  token: string,
  offset: number,
): MichelinCanonicalRestaurantSeed {
  const pool = getRestaurantPool(restaurants, token);

  if (pool.length === 0) {
    throw new Error(`No Michelin restaurants found for location token "${token}".`);
  }

  return pool[offset % pool.length];
}

function createVisitWindow(daysAgo: number, durationHours: number, userIndex: number, visitIndex: number) {
  const start = new Date();
  start.setUTCHours(19, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - daysAgo);
  start.setUTCHours(18 + ((userIndex + visitIndex) % 3), 15 * ((visitIndex % 2) + 1), 0, 0);

  const end = new Date(start);
  end.setTime(start.getTime() + durationHours * 60 * 60 * 1000);

  return { start, end };
}

async function resolveViewerUserId(args: { viewerEmail: string | null; viewerId: string | null }) {
  if (!args.viewerEmail && !args.viewerId) {
    return null;
  }

  const viewer = args.viewerEmail
    ? await db.query.user.findFirst({
        where: (table, { eq }) => eq(table.email, args.viewerEmail!),
      })
    : await db.query.user.findFirst({
        where: (table, { eq }) => eq(table.id, args.viewerId!),
      });

  if (!viewer) {
    throw new Error(
      args.viewerEmail
        ? `No existing backend user found for email ${args.viewerEmail}.`
        : `No existing backend user found for id ${args.viewerId}.`,
    );
  }

  return viewer.id;
}

async function main() {
  const args = parseArgs();
  const viewerUserId = await resolveViewerUserId(args);
  const restaurants = await loadMichelinCanonicalRestaurants();
  const now = new Date();
  const demoUserIds = DEMO_USERS.map((demoUser) => getDemoUserId(demoUser.key));
  const demoUserIdByKey = new Map(DEMO_USERS.map((demoUser) => [demoUser.key, getDemoUserId(demoUser.key)]));
  const visitIdByKey = new Map<string, string>();

  const userRows = DEMO_USERS.map((demoUser) => ({
    id: getDemoUserId(demoUser.key),
    name: demoUser.name,
    email: demoUser.email,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  }));

  const profileRows = DEMO_USERS.map((demoUser) => ({
    userId: getDemoUserId(demoUser.key),
    bio: demoUser.bio,
    homeCity: demoUser.homeCity,
    favoriteCuisine: demoUser.favoriteCuisine,
    publicVisits: true,
    createdAt: now,
    updatedAt: now,
  }));

  const followRows = FOLLOW_EDGES.map((edge) => ({
    followerId: demoUserIdByKey.get(edge.followerKey)!,
    followeeId: demoUserIdByKey.get(edge.followeeKey)!,
    createdAt: now,
  }));

  if (viewerUserId) {
    for (const demoUserId of demoUserIds) {
      followRows.push({
        followerId: viewerUserId,
        followeeId: demoUserId,
        createdAt: now,
      });
    }

    for (const demoUserId of demoUserIds.slice(0, 4)) {
      followRows.push({
        followerId: demoUserId,
        followeeId: viewerUserId,
        createdAt: now,
      });
    }
  }

  const visitRows = DEMO_USERS.flatMap((demoUser, userIndex) =>
    demoUser.visits.map((visitPlan, visitIndex) => {
      const restaurant = pickRestaurant(restaurants, visitPlan.cityToken, visitPlan.offset);
      const localVisitId = getVisitLocalId(demoUser.key, visitIndex);
      const visitKey = `${demoUser.key}:${visitIndex}`;
      const { start, end } = createVisitWindow(visitPlan.daysAgo, visitPlan.durationHours, userIndex, visitIndex);

      visitIdByKey.set(visitKey, localVisitId);

      return {
        userId: getDemoUserId(demoUser.key),
        localVisitId,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name.slice(0, 240),
        startTime: start,
        endTime: end,
        centerLat: restaurant.latitude,
        centerLon: restaurant.longitude,
        photoCount: 3 + ((userIndex + visitIndex) % 5),
        awardAtVisit: restaurant.award || null,
        createdAt: start,
        updatedAt: end,
      };
    }),
  );

  const likeRows = LIKE_PLANS.map((plan) => ({
    visitUserId: demoUserIdByKey.get(plan.visitUserKey)!,
    visitLocalVisitId: visitIdByKey.get(`${plan.visitUserKey}:${plan.visitIndex}`)!,
    userId: demoUserIdByKey.get(plan.likedByKey)!,
    createdAt: now,
  }));

  const commentRows = COMMENT_PLANS.map((plan, index) => ({
    id: randomUUID(),
    visitUserId: demoUserIdByKey.get(plan.visitUserKey)!,
    visitLocalVisitId: visitIdByKey.get(`${plan.visitUserKey}:${plan.visitIndex}`)!,
    authorUserId: demoUserIdByKey.get(plan.authorKey)!,
    body: plan.body,
    createdAt: new Date(now.getTime() + index * 60_000),
    updatedAt: new Date(now.getTime() + index * 60_000),
  }));

  await db.transaction(async (tx) => {
    await tx
      .delete(userConfirmedVisitComment)
      .where(
        or(
          inArray(userConfirmedVisitComment.visitUserId, demoUserIds),
          inArray(userConfirmedVisitComment.authorUserId, demoUserIds),
        ),
      );

    await tx
      .delete(userConfirmedVisitLike)
      .where(
        or(
          inArray(userConfirmedVisitLike.visitUserId, demoUserIds),
          inArray(userConfirmedVisitLike.userId, demoUserIds),
        ),
      );

    await tx
      .delete(userFollow)
      .where(or(inArray(userFollow.followerId, demoUserIds), inArray(userFollow.followeeId, demoUserIds)));

    await tx.delete(userConfirmedVisit).where(inArray(userConfirmedVisit.userId, demoUserIds));
    await tx.delete(userProfile).where(inArray(userProfile.userId, demoUserIds));
    await tx.delete(user).where(inArray(user.id, demoUserIds));

    await tx.insert(user).values(userRows);
    await tx.insert(userProfile).values(profileRows);
    await tx.insert(userFollow).values(followRows);
    await tx.insert(userConfirmedVisit).values(visitRows);

    if (likeRows.length > 0) {
      await tx.insert(userConfirmedVisitLike).values(likeRows);
    }

    if (commentRows.length > 0) {
      await tx.insert(userConfirmedVisitComment).values(commentRows);
    }
  });

  console.log(`Seeded ${userRows.length.toLocaleString()} demo users.`);
  console.log(`Seeded ${visitRows.length.toLocaleString()} confirmed demo visits.`);
  console.log(`Seeded ${followRows.length.toLocaleString()} follow relationships.`);
  console.log(`Seeded ${likeRows.length.toLocaleString()} likes and ${commentRows.length.toLocaleString()} comments.`);

  if (viewerUserId) {
    console.log(`Linked viewer ${viewerUserId} to all demo users so the feed is visible immediately.`);
  } else {
    console.log(
      "Pass --viewer-email you@example.com (or --viewer-id ...) to make an existing account follow the demo users.",
    );
  }
}

async function run() {
  try {
    await main();
  } catch (error) {
    console.error("Failed to seed demo social data.");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
  }
}

void run();

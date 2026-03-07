import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, inArray, ne, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import { user } from "../../db/schema/auth-schema";
import { userConfirmedVisit, userFollow, userProfile } from "../../db/schema/profile";
import type { TRPCContext } from "../context";
import { protectedProcedure, publicProcedure, router } from "../trpc";

const syncedVisitInputSchema = z.object({
  localVisitId: z.string().trim().min(1).max(255),
  restaurantId: z.string().trim().min(1).max(255).nullable(),
  restaurantName: z.string().trim().min(1).max(240),
  startTime: z.number().int(),
  endTime: z.number().int(),
  centerLat: z.number().finite(),
  centerLon: z.number().finite(),
  photoCount: z.number().int().nonnegative(),
  awardAtVisit: z.string().trim().min(1).max(120).nullable(),
});

interface SocialUserRow {
  id: string;
  name: string;
  email: string;
  homeCity: string | null;
  favoriteCuisine: string | null;
  publicVisits: boolean;
}

function buildUserSummary(row: SocialUserRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    homeCity: row.homeCity,
    favoriteCuisine: row.favoriteCuisine,
    publicVisits: row.publicVisits,
  };
}

async function getUserRowsByIds(ctx: Pick<TRPCContext, "db">, userIds: string[]) {
  if (userIds.length === 0) {
    return new Map<string, SocialUserRow>();
  }

  const rows = await ctx.db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      homeCity: userProfile.homeCity,
      favoriteCuisine: userProfile.favoriteCuisine,
      publicVisits: userProfile.publicVisits,
    })
    .from(user)
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(inArray(user.id, userIds));

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        email: row.email,
        homeCity: row.homeCity,
        favoriteCuisine: row.favoriteCuisine,
        publicVisits: row.publicVisits ?? false,
      },
    ]),
  );
}

async function getSocialState(ctx: Pick<TRPCContext, "db">, userId: string) {
  const [followingRows, followerRows, syncedVisitRows] = await Promise.all([
    ctx.db.select({ userId: userFollow.followeeId }).from(userFollow).where(eq(userFollow.followerId, userId)),
    ctx.db.select({ userId: userFollow.followerId }).from(userFollow).where(eq(userFollow.followeeId, userId)),
    ctx.db
      .select({ localVisitId: userConfirmedVisit.localVisitId })
      .from(userConfirmedVisit)
      .where(eq(userConfirmedVisit.userId, userId)),
  ]);

  const followingIds = followingRows.map((row) => row.userId);
  const followerIds = followerRows.map((row) => row.userId);
  const followingSet = new Set(followingIds);
  const followerSet = new Set(followerIds);
  const friendIds = followingIds.filter((id) => followerSet.has(id));

  return {
    followingIds,
    followerIds,
    followingSet,
    followerSet,
    friendIds,
    counts: {
      following: followingIds.length,
      followers: followerIds.length,
      friends: friendIds.length,
      syncedVisits: syncedVisitRows.length,
    },
  };
}

async function getViewerRelationship(ctx: Pick<TRPCContext, "db" | "session">, targetUserId: string) {
  const viewerUserId = ctx.session?.user.id;

  if (!viewerUserId || viewerUserId === targetUserId) {
    return {
      isSelf: viewerUserId === targetUserId,
      isFollowing: false,
      followsYou: false,
      isFriend: false,
    };
  }

  const [viewerFollows, targetFollowsViewer] = await Promise.all([
    ctx.db.query.userFollow.findFirst({
      where: and(eq(userFollow.followerId, viewerUserId), eq(userFollow.followeeId, targetUserId)),
    }),
    ctx.db.query.userFollow.findFirst({
      where: and(eq(userFollow.followerId, targetUserId), eq(userFollow.followeeId, viewerUserId)),
    }),
  ]);

  const isFollowing = Boolean(viewerFollows);
  const followsYou = Boolean(targetFollowsViewer);

  return {
    isSelf: false,
    isFollowing,
    followsYou,
    isFriend: isFollowing && followsYou,
  };
}

export const socialRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const selfUserId = ctx.session.user.id;
    const state = await getSocialState(ctx, selfUserId);
    const usersById = await getUserRowsByIds(ctx, [...new Set([...state.followingIds, ...state.followerIds])]);

    const relationForId = (id: string) => ({
      isFollowing: state.followingSet.has(id),
      followsYou: state.followerSet.has(id),
      isFriend: state.followingSet.has(id) && state.followerSet.has(id),
    });

    const following = state.followingIds
      .map((id) => usersById.get(id))
      .filter((row): row is SocialUserRow => Boolean(row))
      .map((row) => ({
        ...buildUserSummary(row),
        relationship: relationForId(row.id),
      }));

    const followers = state.followerIds
      .map((id) => usersById.get(id))
      .filter((row): row is SocialUserRow => Boolean(row))
      .map((row) => ({
        ...buildUserSummary(row),
        relationship: relationForId(row.id),
      }));

    const friends = state.friendIds
      .map((id) => usersById.get(id))
      .filter((row): row is SocialUserRow => Boolean(row))
      .map((row) => ({
        ...buildUserSummary(row),
        relationship: relationForId(row.id),
      }));

    return {
      counts: state.counts,
      following,
      followers,
      friends,
    };
  }),

  search: protectedProcedure
    .input(
      z.object({
        query: z.string().trim().max(80),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.query.length < 2) {
        return [];
      }

      const pattern = `%${input.query}%`;
      const selfUserId = ctx.session.user.id;

      const rows = await ctx.db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          homeCity: userProfile.homeCity,
          favoriteCuisine: userProfile.favoriteCuisine,
          publicVisits: userProfile.publicVisits,
        })
        .from(user)
        .leftJoin(userProfile, eq(userProfile.userId, user.id))
        .where(
          and(
            ne(user.id, selfUserId),
            or(
              ilike(user.name, pattern),
              ilike(user.email, pattern),
              ilike(userProfile.homeCity, pattern),
              ilike(userProfile.favoriteCuisine, pattern),
            ),
          ),
        )
        .orderBy(user.name)
        .limit(20);

      if (rows.length === 0) {
        return [];
      }

      const candidateIds = rows.map((row) => row.id);
      const [followingRows, followerRows] = await Promise.all([
        ctx.db
          .select({ userId: userFollow.followeeId })
          .from(userFollow)
          .where(and(eq(userFollow.followerId, selfUserId), inArray(userFollow.followeeId, candidateIds))),
        ctx.db
          .select({ userId: userFollow.followerId })
          .from(userFollow)
          .where(and(eq(userFollow.followeeId, selfUserId), inArray(userFollow.followerId, candidateIds))),
      ]);

      const followingSet = new Set(followingRows.map((row) => row.userId));
      const followerSet = new Set(followerRows.map((row) => row.userId));

      return rows.map((row) => ({
        ...buildUserSummary({
          id: row.id,
          name: row.name,
          email: row.email,
          homeCity: row.homeCity,
          favoriteCuisine: row.favoriteCuisine,
          publicVisits: row.publicVisits ?? false,
        }),
        relationship: {
          isFollowing: followingSet.has(row.id),
          followsYou: followerSet.has(row.id),
          isFriend: followingSet.has(row.id) && followerSet.has(row.id),
        },
      }));
    }),

  follow: protectedProcedure
    .input(
      z.object({
        userId: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot follow yourself.",
        });
      }

      const targetUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
      });

      if (!targetUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found.",
        });
      }

      await ctx.db
        .insert(userFollow)
        .values({
          followerId: ctx.session.user.id,
          followeeId: input.userId,
          createdAt: new Date(),
        })
        .onConflictDoNothing();

      return { userId: input.userId };
    }),

  unfollow: protectedProcedure
    .input(
      z.object({
        userId: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(userFollow)
        .where(and(eq(userFollow.followerId, ctx.session.user.id), eq(userFollow.followeeId, input.userId)));

      return { userId: input.userId };
    }),

  publicProfile: publicProcedure
    .input(
      z.object({
        userId: z.string().trim().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({
          id: user.id,
          name: user.name,
          homeCity: userProfile.homeCity,
          favoriteCuisine: userProfile.favoriteCuisine,
          publicVisits: userProfile.publicVisits,
        })
        .from(user)
        .leftJoin(userProfile, eq(userProfile.userId, user.id))
        .where(eq(user.id, input.userId))
        .limit(1);

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profile not found.",
        });
      }

      const counts = (await getSocialState(ctx, input.userId)).counts;
      const relationship = await getViewerRelationship(ctx, input.userId);
      const visitsVisible = relationship.isSelf || (row.publicVisits ?? false);
      const visits = visitsVisible
        ? await ctx.db
            .select({
              localVisitId: userConfirmedVisit.localVisitId,
              restaurantId: userConfirmedVisit.restaurantId,
              restaurantName: userConfirmedVisit.restaurantName,
              startTime: userConfirmedVisit.startTime,
              endTime: userConfirmedVisit.endTime,
              centerLat: userConfirmedVisit.centerLat,
              centerLon: userConfirmedVisit.centerLon,
              photoCount: userConfirmedVisit.photoCount,
              awardAtVisit: userConfirmedVisit.awardAtVisit,
            })
            .from(userConfirmedVisit)
            .where(eq(userConfirmedVisit.userId, input.userId))
            .orderBy(desc(userConfirmedVisit.startTime))
            .limit(50)
        : [];

      return {
        user: {
          id: row.id,
          name: row.name,
        },
        profile: {
          homeCity: row.homeCity,
          favoriteCuisine: row.favoriteCuisine,
          publicVisits: row.publicVisits ?? false,
        },
        counts,
        relationship,
        visitsVisible,
        visits,
      };
    }),

  syncConfirmedVisits: protectedProcedure
    .input(
      z.object({
        visits: z.array(syncedVisitInputSchema),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const visitsById = new Map<string, z.infer<typeof syncedVisitInputSchema>>();

      for (const visit of input.visits) {
        if (visit.endTime < visit.startTime) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Visit end time cannot be earlier than the start time.",
          });
        }

        visitsById.set(visit.localVisitId, visit);
      }

      const visits = Array.from(visitsById.values());
      const selfUserId = ctx.session.user.id;

      await ctx.db.transaction(async (tx) => {
        if (visits.length === 0) {
          await tx.delete(userConfirmedVisit).where(eq(userConfirmedVisit.userId, selfUserId));
          return;
        }

        const localVisitIds = visits.map((visit) => visit.localVisitId);

        await tx
          .delete(userConfirmedVisit)
          .where(
            and(
              eq(userConfirmedVisit.userId, selfUserId),
              not(inArray(userConfirmedVisit.localVisitId, localVisitIds)),
            ),
          );

        const batchSize = 200;

        for (let index = 0; index < visits.length; index += batchSize) {
          const batch = visits.slice(index, index + batchSize);

          await tx
            .insert(userConfirmedVisit)
            .values(
              batch.map((visit) => ({
                userId: selfUserId,
                localVisitId: visit.localVisitId,
                restaurantId: visit.restaurantId,
                restaurantName: visit.restaurantName,
                startTime: new Date(visit.startTime),
                endTime: new Date(visit.endTime),
                centerLat: visit.centerLat,
                centerLon: visit.centerLon,
                photoCount: visit.photoCount,
                awardAtVisit: visit.awardAtVisit,
                createdAt: now,
                updatedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: [userConfirmedVisit.userId, userConfirmedVisit.localVisitId],
              set: {
                restaurantId: sql`excluded.restaurant_id`,
                restaurantName: sql`excluded.restaurant_name`,
                startTime: sql`excluded.start_time`,
                endTime: sql`excluded.end_time`,
                centerLat: sql`excluded.center_lat`,
                centerLon: sql`excluded.center_lon`,
                photoCount: sql`excluded.photo_count`,
                awardAtVisit: sql`excluded.award_at_visit`,
                updatedAt: now,
              },
            });
        }
      });

      return {
        syncedCount: visits.length,
      };
    }),
});

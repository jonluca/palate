import { eq } from "drizzle-orm";
import { z } from "zod";
import { userConfirmedVisit, userFollow, userProfile } from "../../db/schema";
import { protectedProcedure, router } from "../trpc";

function normalizeOptionalField(value: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export const profileRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const selfUserId = ctx.session.user.id;
    const [profile, followingRows, followerRows, syncedVisitRows] = await Promise.all([
      ctx.db.query.userProfile.findFirst({
        where: eq(userProfile.userId, selfUserId),
      }),
      ctx.db.select({ userId: userFollow.followeeId }).from(userFollow).where(eq(userFollow.followerId, selfUserId)),
      ctx.db.select({ userId: userFollow.followerId }).from(userFollow).where(eq(userFollow.followeeId, selfUserId)),
      ctx.db
        .select({ localVisitId: userConfirmedVisit.localVisitId })
        .from(userConfirmedVisit)
        .where(eq(userConfirmedVisit.userId, selfUserId)),
    ]);

    const followingIds = followingRows.map((row) => row.userId);
    const followerSet = new Set(followerRows.map((row) => row.userId));

    return {
      user: {
        id: selfUserId,
        email: ctx.session.user.email,
        name: ctx.session.user.name,
      },
      profile,
      counts: {
        following: followingIds.length,
        followers: followerRows.length,
        friends: followingIds.filter((id) => followerSet.has(id)).length,
        syncedVisits: syncedVisitRows.length,
      },
    };
  }),
  update: protectedProcedure
    .input(
      z.object({
        bio: z.string().max(280).nullable(),
        homeCity: z.string().max(120).nullable(),
        favoriteCuisine: z.string().max(120).nullable(),
        publicVisits: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      const [profile] = await ctx.db
        .insert(userProfile)
        .values({
          userId: ctx.session.user.id,
          bio: normalizeOptionalField(input.bio),
          homeCity: normalizeOptionalField(input.homeCity),
          favoriteCuisine: normalizeOptionalField(input.favoriteCuisine),
          publicVisits: input.publicVisits,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userProfile.userId,
          set: {
            bio: normalizeOptionalField(input.bio),
            homeCity: normalizeOptionalField(input.homeCity),
            favoriteCuisine: normalizeOptionalField(input.favoriteCuisine),
            publicVisits: input.publicVisits,
            updatedAt: now,
          },
        })
        .returning();

      return profile;
    }),
});

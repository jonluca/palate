import { eq } from "drizzle-orm";
import { z } from "zod";
import { userProfile } from "../../db/schema";
import { protectedProcedure, router } from "../trpc";

function normalizeOptionalField(value: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export const profileRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const profile = await ctx.db.query.userProfile.findFirst({
      where: eq(userProfile.userId, ctx.session.user.id),
    });

    return {
      user: {
        id: ctx.session.user.id,
        email: ctx.session.user.email,
        name: ctx.session.user.name,
      },
      profile,
    };
  }),
  update: protectedProcedure
    .input(
      z.object({
        homeCity: z.string().max(120).nullable(),
        favoriteCuisine: z.string().max(120).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      const [profile] = await ctx.db
        .insert(userProfile)
        .values({
          userId: ctx.session.user.id,
          homeCity: normalizeOptionalField(input.homeCity),
          favoriteCuisine: normalizeOptionalField(input.favoriteCuisine),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userProfile.userId,
          set: {
            homeCity: normalizeOptionalField(input.homeCity),
            favoriteCuisine: normalizeOptionalField(input.favoriteCuisine),
            updatedAt: now,
          },
        })
        .returning();

      return profile;
    }),
});

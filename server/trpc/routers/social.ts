import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ilike, inArray, ne, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import { user } from "../../db/schema/auth-schema";
import {
  userConfirmedVisit,
  userConfirmedVisitComment,
  userConfirmedVisitLike,
  userFollow,
  userProfile,
} from "../../db/schema/profile";
import type { TRPCContext } from "../context";
import { protectedProcedure, publicProcedure, router } from "../trpc";

const FEED_LIMIT = 60;
const COMMENT_PREVIEW_LIMIT = 2;
const RESTAURANT_FRIEND_MATCH_LIMIT = 12;

const syncedTimestampSchema = z
  .number()
  .finite()
  .refine((value) => Number.isSafeInteger(Math.round(value)), {
    message: "Timestamp must be within the safe integer range.",
  })
  .transform((value) => Math.round(value));

const syncedVisitInputSchema = z.object({
  localVisitId: z.string().trim().min(1).max(255),
  restaurantId: z.string().trim().min(1).max(255).nullable(),
  restaurantName: z.string().trim().min(1).max(240),
  startTime: syncedTimestampSchema,
  endTime: syncedTimestampSchema,
  centerLat: z.number().finite(),
  centerLon: z.number().finite(),
  photoCount: z.number().int().nonnegative(),
  awardAtVisit: z.string().trim().min(1).max(120).nullable(),
});

const visitReferenceSchema = z.object({
  visitUserId: z.string().trim().min(1),
  localVisitId: z.string().trim().min(1),
});

const setLikeInputSchema = visitReferenceSchema.extend({
  liked: z.boolean(),
});

const addCommentInputSchema = visitReferenceSchema.extend({
  body: z.string().trim().min(1).max(500),
});

interface SocialUserRow {
  id: string;
  name: string;
  email: string;
  homeCity: string | null;
  favoriteCuisine: string | null;
  publicVisits: boolean;
}

interface SocialVisitRow {
  userId: string;
  localVisitId: string;
  restaurantId: string | null;
  restaurantName: string;
  startTime: Date;
  endTime: Date;
  centerLat: number;
  centerLon: number;
  photoCount: number;
  awardAtVisit: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SocialCommentRow {
  id: string;
  visitUserId: string;
  visitLocalVisitId: string;
  authorUserId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

function getVisitKey(visitUserId: string, localVisitId: string) {
  return `${visitUserId}:${localVisitId}`;
}

function buildRelationship(args: { isFollowing: boolean; followsYou: boolean }) {
  return {
    isFollowing: args.isFollowing,
    followsYou: args.followsYou,
    isFriend: args.isFollowing && args.followsYou,
  };
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

function buildVisitSummary(row: SocialVisitRow) {
  return {
    localVisitId: row.localVisitId,
    restaurantId: row.restaurantId,
    restaurantName: row.restaurantName,
    startTime: row.startTime,
    endTime: row.endTime,
    centerLat: row.centerLat,
    centerLon: row.centerLon,
    photoCount: row.photoCount,
    awardAtVisit: row.awardAtVisit,
  };
}

function buildCommentSummary(row: SocialCommentRow, author: SocialUserRow, viewerUserId: string) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: buildUserSummary(author),
    isOwnComment: row.authorUserId === viewerUserId,
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

async function assertViewerCanAccessVisit(
  ctx: Pick<TRPCContext, "db" | "session">,
  args: {
    visitUserId: string;
    localVisitId: string;
  },
) {
  const [visitRow] = await ctx.db
    .select({
      userId: userConfirmedVisit.userId,
      localVisitId: userConfirmedVisit.localVisitId,
      restaurantId: userConfirmedVisit.restaurantId,
      restaurantName: userConfirmedVisit.restaurantName,
      startTime: userConfirmedVisit.startTime,
      endTime: userConfirmedVisit.endTime,
      centerLat: userConfirmedVisit.centerLat,
      centerLon: userConfirmedVisit.centerLon,
      photoCount: userConfirmedVisit.photoCount,
      awardAtVisit: userConfirmedVisit.awardAtVisit,
      createdAt: userConfirmedVisit.createdAt,
      updatedAt: userConfirmedVisit.updatedAt,
      ownerPublicVisits: userProfile.publicVisits,
    })
    .from(userConfirmedVisit)
    .leftJoin(userProfile, eq(userProfile.userId, userConfirmedVisit.userId))
    .where(and(eq(userConfirmedVisit.userId, args.visitUserId), eq(userConfirmedVisit.localVisitId, args.localVisitId)))
    .limit(1);

  if (!visitRow) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Visit not found.",
    });
  }

  const viewerUserId = ctx.session?.user.id;

  if (viewerUserId === args.visitUserId) {
    return {
      visit: {
        userId: visitRow.userId,
        localVisitId: visitRow.localVisitId,
        restaurantId: visitRow.restaurantId,
        restaurantName: visitRow.restaurantName,
        startTime: visitRow.startTime,
        endTime: visitRow.endTime,
        centerLat: visitRow.centerLat,
        centerLon: visitRow.centerLon,
        photoCount: visitRow.photoCount,
        awardAtVisit: visitRow.awardAtVisit,
        createdAt: visitRow.createdAt,
        updatedAt: visitRow.updatedAt,
      } satisfies SocialVisitRow,
      relationship: {
        isSelf: true,
        isFollowing: false,
        followsYou: false,
        isFriend: false,
      },
    };
  }

  const relationship = await getViewerRelationship(ctx, args.visitUserId);

  if (!relationship.isFollowing && !(visitRow.ownerPublicVisits ?? false)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This visit is not visible to you.",
    });
  }

  return {
    visit: {
      userId: visitRow.userId,
      localVisitId: visitRow.localVisitId,
      restaurantId: visitRow.restaurantId,
      restaurantName: visitRow.restaurantName,
      startTime: visitRow.startTime,
      endTime: visitRow.endTime,
      centerLat: visitRow.centerLat,
      centerLon: visitRow.centerLon,
      photoCount: visitRow.photoCount,
      awardAtVisit: visitRow.awardAtVisit,
      createdAt: visitRow.createdAt,
      updatedAt: visitRow.updatedAt,
    } satisfies SocialVisitRow,
    relationship,
  };
}

async function getFeedData(ctx: Pick<TRPCContext, "db" | "session">, viewerUserId: string) {
  const state = await getSocialState(ctx, viewerUserId);

  if (state.followingIds.length === 0) {
    return [];
  }

  const visits = await ctx.db
    .select({
      userId: userConfirmedVisit.userId,
      localVisitId: userConfirmedVisit.localVisitId,
      restaurantId: userConfirmedVisit.restaurantId,
      restaurantName: userConfirmedVisit.restaurantName,
      startTime: userConfirmedVisit.startTime,
      endTime: userConfirmedVisit.endTime,
      centerLat: userConfirmedVisit.centerLat,
      centerLon: userConfirmedVisit.centerLon,
      photoCount: userConfirmedVisit.photoCount,
      awardAtVisit: userConfirmedVisit.awardAtVisit,
      createdAt: userConfirmedVisit.createdAt,
      updatedAt: userConfirmedVisit.updatedAt,
    })
    .from(userConfirmedVisit)
    .where(inArray(userConfirmedVisit.userId, state.followingIds))
    .orderBy(desc(userConfirmedVisit.startTime), desc(userConfirmedVisit.createdAt))
    .limit(FEED_LIMIT);

  if (visits.length === 0) {
    return [];
  }

  const likePredicates = visits.map((visit) =>
    and(
      eq(userConfirmedVisitLike.visitUserId, visit.userId),
      eq(userConfirmedVisitLike.visitLocalVisitId, visit.localVisitId),
    ),
  );

  const commentPredicates = visits.map((visit) =>
    and(
      eq(userConfirmedVisitComment.visitUserId, visit.userId),
      eq(userConfirmedVisitComment.visitLocalVisitId, visit.localVisitId),
    ),
  );

  const [likeRows, commentRows] = await Promise.all([
    ctx.db
      .select({
        visitUserId: userConfirmedVisitLike.visitUserId,
        visitLocalVisitId: userConfirmedVisitLike.visitLocalVisitId,
        userId: userConfirmedVisitLike.userId,
      })
      .from(userConfirmedVisitLike)
      .where(or(...likePredicates)),
    ctx.db
      .select({
        id: userConfirmedVisitComment.id,
        visitUserId: userConfirmedVisitComment.visitUserId,
        visitLocalVisitId: userConfirmedVisitComment.visitLocalVisitId,
        authorUserId: userConfirmedVisitComment.authorUserId,
        body: userConfirmedVisitComment.body,
        createdAt: userConfirmedVisitComment.createdAt,
        updatedAt: userConfirmedVisitComment.updatedAt,
      })
      .from(userConfirmedVisitComment)
      .where(or(...commentPredicates))
      .orderBy(desc(userConfirmedVisitComment.createdAt)),
  ]);

  const userIds = new Set<string>(visits.map((visit) => visit.userId));
  commentRows.forEach((comment) => userIds.add(comment.authorUserId));
  const usersById = await getUserRowsByIds(ctx, Array.from(userIds));

  const likeSummaryByVisit = new Map<
    string,
    {
      likeCount: number;
      viewerHasLiked: boolean;
    }
  >();

  likeRows.forEach((row) => {
    const key = getVisitKey(row.visitUserId, row.visitLocalVisitId);
    const current = likeSummaryByVisit.get(key) ?? {
      likeCount: 0,
      viewerHasLiked: false,
    };

    current.likeCount += 1;
    current.viewerHasLiked = current.viewerHasLiked || row.userId === viewerUserId;
    likeSummaryByVisit.set(key, current);
  });

  const commentCountByVisit = new Map<string, number>();
  const previewCommentsByVisit = new Map<string, ReturnType<typeof buildCommentSummary>[]>();

  commentRows.forEach((row) => {
    const key = getVisitKey(row.visitUserId, row.visitLocalVisitId);
    commentCountByVisit.set(key, (commentCountByVisit.get(key) ?? 0) + 1);

    const author = usersById.get(row.authorUserId);

    if (!author) {
      return;
    }

    const preview = previewCommentsByVisit.get(key) ?? [];

    if (preview.length < COMMENT_PREVIEW_LIMIT) {
      preview.push(buildCommentSummary(row, author, viewerUserId));
      previewCommentsByVisit.set(key, preview);
    }
  });

  return visits
    .map((visit) => {
      const author = usersById.get(visit.userId);

      if (!author) {
        return null;
      }

      const key = getVisitKey(visit.userId, visit.localVisitId);
      const likeSummary = likeSummaryByVisit.get(key);
      const previewComments = [...(previewCommentsByVisit.get(key) ?? [])].reverse();

      return {
        id: key,
        author: buildUserSummary(author),
        relationship: buildRelationship({
          isFollowing: state.followingSet.has(author.id),
          followsYou: state.followerSet.has(author.id),
        }),
        visit: {
          userId: visit.userId,
          ...buildVisitSummary(visit),
        },
        engagement: {
          likeCount: likeSummary?.likeCount ?? 0,
          commentCount: commentCountByVisit.get(key) ?? 0,
          viewerHasLiked: likeSummary?.viewerHasLiked ?? false,
        },
        previewComments,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

async function getRestaurantFriendMatches(
  ctx: Pick<TRPCContext, "db"> & { session: NonNullable<TRPCContext["session"]> },
  restaurantId: string,
) {
  const state = await getSocialState(ctx, ctx.session.user.id);

  if (state.friendIds.length === 0) {
    return [];
  }

  const visits = await ctx.db
    .select({
      userId: userConfirmedVisit.userId,
      startTime: userConfirmedVisit.startTime,
    })
    .from(userConfirmedVisit)
    .where(and(eq(userConfirmedVisit.restaurantId, restaurantId), inArray(userConfirmedVisit.userId, state.friendIds)))
    .orderBy(desc(userConfirmedVisit.startTime), desc(userConfirmedVisit.createdAt));

  if (visits.length === 0) {
    return [];
  }

  const usersById = await getUserRowsByIds(ctx, Array.from(new Set(visits.map((visit) => visit.userId))));

  const matchesByUserId = new Map<
    string,
    {
      user: ReturnType<typeof buildUserSummary>;
      relationship: ReturnType<typeof buildRelationship>;
      visitCount: number;
      lastVisitedAt: Date;
    }
  >();

  for (const visit of visits) {
    const existingMatch = matchesByUserId.get(visit.userId);

    if (existingMatch) {
      existingMatch.visitCount += 1;
      continue;
    }

    const friend = usersById.get(visit.userId);

    if (!friend) {
      continue;
    }

    matchesByUserId.set(visit.userId, {
      user: buildUserSummary(friend),
      relationship: buildRelationship({
        isFollowing: true,
        followsYou: true,
      }),
      visitCount: 1,
      lastVisitedAt: visit.startTime,
    });
  }

  return Array.from(matchesByUserId.values())
    .sort((a, b) => {
      const timeDelta = b.lastVisitedAt.getTime() - a.lastVisitedAt.getTime();
      return timeDelta !== 0 ? timeDelta : b.visitCount - a.visitCount;
    })
    .slice(0, RESTAURANT_FRIEND_MATCH_LIMIT);
}

export const socialRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const selfUserId = ctx.session.user.id;
    const state = await getSocialState(ctx, selfUserId);
    const usersById = await getUserRowsByIds(ctx, [...new Set([...state.followingIds, ...state.followerIds])]);

    const relationForId = (id: string) =>
      buildRelationship({
        isFollowing: state.followingSet.has(id),
        followsYou: state.followerSet.has(id),
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

  feed: protectedProcedure.query(async ({ ctx }) => {
    return getFeedData(ctx, ctx.session.user.id);
  }),

  restaurantFriends: protectedProcedure
    .input(
      z.object({
        restaurantId: z.string().trim().min(1).max(255),
      }),
    )
    .query(async ({ ctx, input }) => {
      return getRestaurantFriendMatches(ctx, input.restaurantId);
    }),

  visitComments: protectedProcedure.input(visitReferenceSchema).query(async ({ ctx, input }) => {
    await assertViewerCanAccessVisit(ctx, input);

    const rows = await ctx.db
      .select({
        id: userConfirmedVisitComment.id,
        visitUserId: userConfirmedVisitComment.visitUserId,
        visitLocalVisitId: userConfirmedVisitComment.visitLocalVisitId,
        authorUserId: userConfirmedVisitComment.authorUserId,
        body: userConfirmedVisitComment.body,
        createdAt: userConfirmedVisitComment.createdAt,
        updatedAt: userConfirmedVisitComment.updatedAt,
      })
      .from(userConfirmedVisitComment)
      .where(
        and(
          eq(userConfirmedVisitComment.visitUserId, input.visitUserId),
          eq(userConfirmedVisitComment.visitLocalVisitId, input.localVisitId),
        ),
      )
      .orderBy(asc(userConfirmedVisitComment.createdAt));

    const usersById = await getUserRowsByIds(ctx, Array.from(new Set(rows.map((row) => row.authorUserId))));

    return rows
      .map((row) => {
        const author = usersById.get(row.authorUserId);
        return author ? buildCommentSummary(row, author, ctx.session.user.id) : null;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  }),

  setVisitLike: protectedProcedure.input(setLikeInputSchema).mutation(async ({ ctx, input }) => {
    await assertViewerCanAccessVisit(ctx, input);

    if (input.liked) {
      await ctx.db
        .insert(userConfirmedVisitLike)
        .values({
          visitUserId: input.visitUserId,
          visitLocalVisitId: input.localVisitId,
          userId: ctx.session.user.id,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
    } else {
      await ctx.db
        .delete(userConfirmedVisitLike)
        .where(
          and(
            eq(userConfirmedVisitLike.visitUserId, input.visitUserId),
            eq(userConfirmedVisitLike.visitLocalVisitId, input.localVisitId),
            eq(userConfirmedVisitLike.userId, ctx.session.user.id),
          ),
        );
    }

    return {
      visitUserId: input.visitUserId,
      localVisitId: input.localVisitId,
      liked: input.liked,
    };
  }),

  addVisitComment: protectedProcedure.input(addCommentInputSchema).mutation(async ({ ctx, input }) => {
    await assertViewerCanAccessVisit(ctx, input);

    const now = new Date();
    const commentId = randomUUID();

    await ctx.db.insert(userConfirmedVisitComment).values({
      id: commentId,
      visitUserId: input.visitUserId,
      visitLocalVisitId: input.localVisitId,
      authorUserId: ctx.session.user.id,
      body: input.body,
      createdAt: now,
      updatedAt: now,
    });

    const author = (await getUserRowsByIds(ctx, [ctx.session.user.id])).get(ctx.session.user.id);

    if (!author) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to load comment author.",
      });
    }

    return buildCommentSummary(
      {
        id: commentId,
        visitUserId: input.visitUserId,
        visitLocalVisitId: input.localVisitId,
        authorUserId: ctx.session.user.id,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      },
      author,
      ctx.session.user.id,
    );
  }),

  deleteVisitComment: protectedProcedure
    .input(
      z.object({
        commentId: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [comment] = await ctx.db
        .select({
          id: userConfirmedVisitComment.id,
          visitUserId: userConfirmedVisitComment.visitUserId,
          visitLocalVisitId: userConfirmedVisitComment.visitLocalVisitId,
          authorUserId: userConfirmedVisitComment.authorUserId,
        })
        .from(userConfirmedVisitComment)
        .where(eq(userConfirmedVisitComment.id, input.commentId))
        .limit(1);

      if (!comment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Comment not found.",
        });
      }

      if (comment.authorUserId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only delete your own comments.",
        });
      }

      await ctx.db.delete(userConfirmedVisitComment).where(eq(userConfirmedVisitComment.id, input.commentId));

      return {
        commentId: input.commentId,
        visitUserId: comment.visitUserId,
        localVisitId: comment.visitLocalVisitId,
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
        relationship: buildRelationship({
          isFollowing: followingSet.has(row.id),
          followsYou: followerSet.has(row.id),
        }),
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
          bio: userProfile.bio,
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
      const visitsVisible = relationship.isSelf || relationship.isFollowing || (row.publicVisits ?? false);
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
          bio: row.bio,
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

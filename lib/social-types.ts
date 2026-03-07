import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/trpc/router";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type SocialMe = RouterOutputs["social"]["me"];
export type SocialUser = SocialMe["following"][number];
export type SocialRelationship = SocialUser["relationship"];
export type SocialPublicProfile = RouterOutputs["social"]["publicProfile"];
export type SocialFeedItem = RouterOutputs["social"]["feed"][number];
export type SocialFeedComment = RouterOutputs["social"]["visitComments"][number];

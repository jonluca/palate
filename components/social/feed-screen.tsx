import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { FlashList } from "@shopify/flash-list";
import { router, type Href } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppleSignInButton } from "@/components/auth/apple-sign-in-button";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import {
  useAddVisitComment,
  useDeleteVisitComment,
  useSetVisitLike,
  useSocialFeed,
  useSocialMe,
  useVisitComments,
} from "@/hooks/use-social";
import { useSession } from "@/lib/auth-client";
import type { SocialFeedComment, SocialFeedItem } from "@/lib/social-types";

function formatVisitDate(value: string | number | Date) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function EmptyFeedCard({
  title,
  body,
  ctaLabel,
  onPress,
}: {
  title: string;
  body: string;
  ctaLabel?: string;
  onPress?: () => void;
}) {
  return (
    <Card animated={false} className={"gap-4 p-5"}>
      <View className={"gap-1"}>
        <ThemedText variant={"title4"} className={"font-semibold"}>
          {title}
        </ThemedText>
        <ThemedText variant={"footnote"} color={"secondary"}>
          {body}
        </ThemedText>
      </View>

      {ctaLabel && onPress ? (
        <Button onPress={onPress}>
          <ButtonText>{ctaLabel}</ButtonText>
        </Button>
      ) : null}
    </Card>
  );
}

function CommentRow({
  comment,
  onDelete,
  deleting,
}: {
  comment: SocialFeedComment;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  return (
    <View className={"gap-1 rounded-2xl border border-white/10 bg-background px-3 py-3"}>
      <View className={"flex-row items-start justify-between gap-3"}>
        <View className={"flex-1 gap-1"}>
          <Pressable onPress={() => router.push(`/people/${comment.author.id}` as Href)}>
            <ThemedText variant={"subhead"} className={"font-semibold"}>
              {comment.author.name}
            </ThemedText>
          </Pressable>
          <ThemedText variant={"caption1"} color={"tertiary"}>
            {formatVisitDate(comment.createdAt)}
          </ThemedText>
        </View>

        {comment.isOwnComment ? (
          <Pressable disabled={deleting} onPress={onDelete} hitSlop={8}>
            <ThemedText variant={"caption1"} className={"font-semibold text-red-300"}>
              {deleting ? "Deleting..." : "Delete"}
            </ThemedText>
          </Pressable>
        ) : null}
      </View>

      <ThemedText variant={"footnote"} color={"secondary"}>
        {comment.body}
      </ThemedText>
    </View>
  );
}

function FeedCard({ item }: { item: SocialFeedItem }) {
  const { showToast } = useToast();
  const [commentDraft, setCommentDraft] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(item.previewComments.length > 0);

  const commentsQuery = useVisitComments({
    visitUserId: item.visit.userId,
    localVisitId: item.visit.localVisitId,
    enabled: commentsOpen,
  });

  const likeMutation = useSetVisitLike({
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Unable to update like state." });
    },
  });
  const addCommentMutation = useAddVisitComment({
    onSuccess: () => {
      setCommentDraft("");
      setCommentsOpen(true);
    },
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Unable to add your comment." });
    },
  });
  const deleteCommentMutation = useDeleteVisitComment({
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Unable to delete that comment." });
    },
  });

  const visibleComments = commentsOpen ? (commentsQuery.data ?? item.previewComments) : item.previewComments;
  const commentCount = commentsQuery.data?.length ?? item.engagement.commentCount;
  const showViewAllComments = !commentsOpen && commentCount > item.previewComments.length;
  const isLikePending =
    likeMutation.isPending &&
    likeMutation.variables?.visitUserId === item.visit.userId &&
    likeMutation.variables?.localVisitId === item.visit.localVisitId;
  const likeCount = item.engagement.likeCount;

  const handleLikePress = () => {
    likeMutation.mutate({
      visitUserId: item.visit.userId,
      localVisitId: item.visit.localVisitId,
      liked: !item.engagement.viewerHasLiked,
    });
  };

  const handlePostComment = () => {
    const body = commentDraft.trim();

    if (!body) {
      return;
    }

    addCommentMutation.mutate({
      visitUserId: item.visit.userId,
      localVisitId: item.visit.localVisitId,
      body,
    });
  };

  return (
    <Card animated={false} className={"gap-4 p-5"}>
      <View className={"gap-3"}>
        <View className={"flex-row items-start justify-between gap-4"}>
          <View className={"flex-1 gap-1"}>
            <Pressable onPress={() => router.push(`/people/${item.author.id}` as Href)}>
              <View className={"flex-row items-center gap-2"}>
                <ThemedText variant={"heading"} className={"font-semibold"}>
                  {item.author.name}
                </ThemedText>
                <ThemedText variant={"caption1"} className={"rounded-full bg-white/10 px-2 py-1"}>
                  {item.relationship.isFriend ? "Friend" : item.relationship.followsYou ? "Follows you" : "Following"}
                </ThemedText>
              </View>
            </Pressable>
            <ThemedText variant={"footnote"} color={"secondary"}>
              {item.author.homeCity || item.author.favoriteCuisine
                ? [item.author.homeCity, item.author.favoriteCuisine].filter(Boolean).join(" · ")
                : item.author.email}
            </ThemedText>
          </View>

          <ThemedText variant={"caption1"} color={"tertiary"}>
            {formatVisitDate(item.visit.startTime)}
          </ThemedText>
        </View>

        <View className={"gap-2 rounded-3xl border border-white/10 bg-background px-4 py-4"}>
          <View className={"flex-row items-start justify-between gap-3"}>
            <View className={"flex-1 gap-1"}>
              <Pressable
                disabled={!item.visit.restaurantId}
                onPress={() => {
                  if (item.visit.restaurantId) {
                    router.push(`/restaurant/${item.visit.restaurantId}` as Href);
                  }
                }}
              >
                <ThemedText variant={"title4"} className={"font-semibold"}>
                  {item.visit.restaurantName}
                </ThemedText>
              </Pressable>
              <ThemedText variant={"footnote"} color={"secondary"}>
                {item.visit.photoCount.toLocaleString()} photo{item.visit.photoCount === 1 ? "" : "s"} · Visited{" "}
                {formatVisitDate(item.visit.startTime)}
              </ThemedText>
            </View>

            {item.visit.awardAtVisit ? (
              <View className={"rounded-full bg-amber-500/15 px-3 py-1"}>
                <ThemedText variant={"caption1"} className={"font-semibold text-amber-300"}>
                  {item.visit.awardAtVisit}
                </ThemedText>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      <View className={"flex-row gap-3"}>
        <Pressable
          className={"flex-row items-center gap-2 rounded-full border border-white/10 bg-background px-3 py-2"}
          disabled={isLikePending}
          onPress={handleLikePress}
        >
          <MaterialIcons
            name={item.engagement.viewerHasLiked ? "favorite" : "favorite-border"}
            size={18}
            color={item.engagement.viewerHasLiked ? "#FF5A5F" : "#A1A1AA"}
          />
          <ThemedText variant={"footnote"} className={"font-semibold"}>
            {likeCount.toLocaleString()}
          </ThemedText>
        </Pressable>

        <Pressable
          className={"flex-row items-center gap-2 rounded-full border border-white/10 bg-background px-3 py-2"}
          onPress={() => setCommentsOpen((current) => !current)}
        >
          <MaterialIcons name={"chat-bubble-outline"} size={17} color={"#A1A1AA"} />
          <ThemedText variant={"footnote"} className={"font-semibold"}>
            {commentCount.toLocaleString()}
          </ThemedText>
        </Pressable>
      </View>

      {visibleComments.length > 0 || commentsOpen ? (
        <View className={"gap-3"}>
          <View className={"flex-row items-center justify-between gap-3"}>
            <ThemedText variant={"subhead"} className={"font-semibold"}>
              Comments
            </ThemedText>
            {commentsOpen && commentsQuery.isLoading ? (
              <ActivityIndicator color={"#0A84FF"} />
            ) : showViewAllComments ? (
              <Pressable onPress={() => setCommentsOpen(true)}>
                <ThemedText variant={"caption1"} className={"font-semibold text-primary"}>
                  View all {commentCount.toLocaleString()}
                </ThemedText>
              </Pressable>
            ) : null}
          </View>

          {visibleComments.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              deleting={deleteCommentMutation.isPending && deleteCommentMutation.variables?.commentId === comment.id}
              onDelete={
                comment.isOwnComment ? () => deleteCommentMutation.mutate({ commentId: comment.id }) : undefined
              }
            />
          ))}

          <View className={"gap-2 rounded-2xl border border-white/10 bg-background px-3 py-3"}>
            <TextInput
              value={commentDraft}
              onChangeText={setCommentDraft}
              placeholder={"Add a comment"}
              placeholderTextColor={"rgba(255,255,255,0.42)"}
              className={"min-h-[44px] text-[15px] text-foreground"}
              multiline
            />
            <View className={"flex-row justify-end"}>
              <Button
                size={"sm"}
                onPress={handlePostComment}
                loading={addCommentMutation.isPending}
                disabled={!commentDraft.trim()}
              >
                <ButtonText size={"sm"}>Post</ButtonText>
              </Button>
            </View>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

function LoadingState() {
  return (
    <View className={"gap-4 px-4"}>
      {Array.from({ length: 3 }).map((_, index) => (
        <Card key={index} animated={false} className={"gap-4 p-5"}>
          <View className={"h-5 w-40 rounded-full bg-white/10"} />
          <View className={"h-24 rounded-3xl bg-white/10"} />
          <View className={"flex-row gap-3"}>
            <View className={"h-10 flex-1 rounded-full bg-white/10"} />
            <View className={"h-10 flex-1 rounded-full bg-white/10"} />
          </View>
        </Card>
      ))}
    </View>
  );
}

export function FeedScreen() {
  const insets = useSafeAreaInsets();
  const { data: session } = useSession();
  const socialFeedQuery = useSocialFeed();
  const socialMeQuery = useSocialMe();

  if (!session?.user) {
    return (
      <View className={"flex-1 bg-background px-4 pt-6"}>
        <Card animated={false} className={"gap-4 p-5"}>
          <View className={"gap-1"}>
            <ThemedText variant={"title3"} className={"font-semibold"}>
              Sign in for your feed
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Follow people on Palate to see the restaurants they have visited, then jump into likes and comments from
              here.
            </ThemedText>
          </View>

          <AppleSignInButton />
        </Card>
      </View>
    );
  }

  if (socialFeedQuery.isLoading && !socialFeedQuery.data) {
    return (
      <View className={"flex-1 bg-background pt-4"}>
        <LoadingState />
      </View>
    );
  }

  const feed = socialFeedQuery.data ?? [];
  const followingCount = socialMeQuery.data?.counts.following ?? 0;

  return (
    <View className={"flex-1 bg-background"}>
      <FlashList
        data={feed}
        renderItem={({ item }) => <FeedCard item={item} />}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior={"automatic"}
        contentContainerStyle={{
          paddingTop: 12,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 16,
        }}
        ItemSeparatorComponent={() => <View className={"h-4"} />}
        refreshControl={
          <RefreshControl
            refreshing={socialFeedQuery.isRefetching || socialMeQuery.isRefetching}
            onRefresh={() => {
              socialFeedQuery.refetch();
              socialMeQuery.refetch();
            }}
          />
        }
        ListHeaderComponent={
          <View className={"gap-2 pb-4"}>
            <ThemedText variant={"largeTitle"} className={"font-bold"}>
              Feed
            </ThemedText>
            <ThemedText variant={"body"} color={"secondary"}>
              Restaurants visited by the people you follow, newest visits first.
            </ThemedText>
          </View>
        }
        ListEmptyComponent={
          followingCount === 0 ? (
            <EmptyFeedCard
              title={"Nothing here yet"}
              body={"Follow a few people from your profile to start building your feed."}
              ctaLabel={"Find People"}
              onPress={() => router.push("/social" as Href)}
            />
          ) : (
            <EmptyFeedCard
              title={"No visits from your circle yet"}
              body={
                "You are following people, but none of their confirmed visits have shown up yet. Pull to refresh after they sync more visits."
              }
            />
          )
        }
      />
    </View>
  );
}

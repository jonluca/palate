import { router, type Href } from "expo-router";
import React from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useRestaurantFriends } from "@/hooks";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { useSession } from "@/lib/auth-client";
import type { SocialRestaurantFriend } from "@/lib/social-types";

function formatVisitDate(value: string | number | Date) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function FriendVisitRow({ friend }: { friend: SocialRestaurantFriend }) {
  const visitCountLabel = `${friend.visitCount.toLocaleString()} synced visit${friend.visitCount === 1 ? "" : "s"}`;
  const metaLine = [visitCountLabel, `Last here ${formatVisitDate(friend.lastVisitedAt)}`].join(" · ");

  return (
    <Pressable
      onPress={() => router.push(`/people/${friend.user.id}` as Href)}
      className={"gap-2 rounded-2xl border border-white/10 bg-background px-4 py-3"}
    >
      <View className={"flex-row items-start justify-between gap-3"}>
        <View className={"flex-1 gap-1"}>
          <ThemedText variant={"heading"} className={"font-semibold"}>
            {friend.user.name}
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"}>
            {metaLine}
          </ThemedText>
        </View>

        <ThemedText variant={"caption1"} className={"rounded-full bg-white/10 px-2 py-1"}>
          Friend
        </ThemedText>
      </View>
    </Pressable>
  );
}

interface FriendsWhoVisitedCardProps {
  restaurantId?: string | null;
  restaurantName?: string | null;
}

export function FriendsWhoVisitedCard({ restaurantId, restaurantName }: FriendsWhoVisitedCardProps) {
  const { data: session } = useSession();
  const friendsQuery = useRestaurantFriends(restaurantId ?? undefined);

  if (!session?.user || !restaurantId) {
    return null;
  }

  const friends = friendsQuery.data ?? [];
  const detail = restaurantName
    ? `Friends with synced confirmed visits to ${restaurantName}.`
    : "Friends with synced confirmed visits here.";

  return (
    <Card animated={false} className={"gap-4 p-5"}>
      <View className={"gap-1"}>
        <ThemedText variant={"title4"} className={"font-semibold"}>
          Friends who've been here
        </ThemedText>
        <ThemedText variant={"footnote"} color={"secondary"}>
          {detail}
        </ThemedText>
      </View>

      {friendsQuery.isLoading && !friendsQuery.data ? (
        <View className={"flex-row items-center gap-2 rounded-2xl border border-white/10 bg-background px-4 py-3"}>
          <ActivityIndicator color={"#0A84FF"} />
          <ThemedText variant={"footnote"} color={"secondary"}>
            Checking your friends...
          </ThemedText>
        </View>
      ) : friends.length > 0 ? (
        <View className={"gap-3"}>
          {friends.map((friend) => (
            <FriendVisitRow key={friend.user.id} friend={friend} />
          ))}
        </View>
      ) : (
        <View className={"rounded-2xl border border-white/10 bg-background px-4 py-3"}>
          <ThemedText variant={"footnote"} color={"secondary"}>
            No friends have logged a confirmed visit here yet.
          </ThemedText>
        </View>
      )}
    </Card>
  );
}

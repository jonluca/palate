import React from "react";
import { Pressable, View } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";

interface RelationshipState {
  isFollowing: boolean;
  followsYou: boolean;
  isFriend: boolean;
}

interface UserSummary {
  id: string;
  name: string;
  email?: string;
  homeCity?: string | null;
  favoriteCuisine?: string | null;
  publicVisits?: boolean;
}

interface UserRowProps {
  user: UserSummary;
  relationship?: RelationshipState | null;
  onPress?: () => void;
  actionLabel?: string;
  onPressAction?: () => void;
  actionLoading?: boolean;
  actionDisabled?: boolean;
  hideEmail?: boolean;
}

function getRelationshipLabel(relationship?: RelationshipState | null) {
  if (!relationship) {
    return null;
  }

  if (relationship.isFriend) {
    return "Friends";
  }

  if (relationship.isFollowing) {
    return "Following";
  }

  if (relationship.followsYou) {
    return "Follows you";
  }

  return null;
}

export function UserRow({
  user,
  relationship,
  onPress,
  actionLabel,
  onPressAction,
  actionLoading = false,
  actionDisabled = false,
  hideEmail = false,
}: UserRowProps) {
  const relationshipLabel = getRelationshipLabel(relationship);
  const metaLine = [user.homeCity, user.favoriteCuisine].filter(Boolean).join(" · ");

  return (
    <Card animated={false} className={"p-4"}>
      <View className={"flex-row items-start justify-between gap-3"}>
        <Pressable className={"flex-1 gap-1"} disabled={!onPress} onPress={onPress}>
          <View className={"flex-row items-center gap-2"}>
            <ThemedText variant={"heading"} className={"font-semibold"}>
              {user.name}
            </ThemedText>
            {relationshipLabel ? (
              <ThemedText variant={"caption1"} className={"rounded-full bg-white/10 px-2 py-1"}>
                {relationshipLabel}
              </ThemedText>
            ) : null}
          </View>

          {!hideEmail && user.email ? (
            <ThemedText variant={"footnote"} color={"secondary"} selectable>
              {user.email}
            </ThemedText>
          ) : null}

          {metaLine ? (
            <ThemedText variant={"footnote"} color={"secondary"}>
              {metaLine}
            </ThemedText>
          ) : null}

          <ThemedText variant={"caption1"} color={"tertiary"}>
            {user.publicVisits ? "Public visit history enabled" : "Visit history is private"}
          </ThemedText>
        </Pressable>

        {actionLabel && onPressAction ? (
          <Button
            size={"sm"}
            variant={relationship?.isFollowing ? "secondary" : "default"}
            loading={actionLoading}
            disabled={actionDisabled}
            onPress={onPressAction}
          >
            <ButtonText size={"sm"} variant={relationship?.isFollowing ? "secondary" : "default"}>
              {actionLabel}
            </ButtonText>
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

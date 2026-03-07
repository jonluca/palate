import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppleSignInButton } from "@/components/auth/apple-sign-in-button";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth-client";
import { cloudQueryKeys } from "@/lib/cloud-sync";
import { useTRPCClient } from "@/lib/trpc";

function CountTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <View className={"flex-1 rounded-2xl border border-white/10 bg-background px-3 py-3"}>
      <ThemedText variant={"title4"} className={"font-semibold"} selectable>
        {(value ?? 0).toLocaleString()}
      </ThemedText>
      <ThemedText variant={"caption1"} color={"tertiary"}>
        {label}
      </ThemedText>
    </View>
  );
}

function formatVisitDate(value: string | number | Date) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getFollowActionLabel(relationship: { isFollowing: boolean; followsYou: boolean }) {
  if (relationship.isFollowing) {
    return "Unfollow";
  }

  if (relationship.followsYou) {
    return "Follow Back";
  }

  return "Follow";
}

export default function PersonProfileScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();
  const { showToast } = useToast();
  const { data: session } = useSession();

  const profileQuery = useQuery({
    queryKey: cloudQueryKeys.publicProfile(id ?? ""),
    enabled: Boolean(id),
    queryFn: () => trpcClient.social.publicProfile.query({ userId: id! }),
  });

  const followMutation = useMutation({
    mutationFn: async () => {
      const profile = profileQuery.data;

      if (!profile) {
        throw new Error("Profile not loaded.");
      }

      return profile.relationship.isFollowing
        ? trpcClient.social.unfollow.mutate({ userId: profile.user.id })
        : trpcClient.social.follow.mutate({ userId: profile.user.id });
    },
    onSuccess: (_result, _variables) => {
      if (!id) {
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["cloud", "social"] });
      queryClient.invalidateQueries({ queryKey: cloudQueryKeys.publicProfile(id) });
    },
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Unable to update follow state." });
    },
  });

  const profile = profileQuery.data;

  return (
    <>
      <Stack.Screen options={{ title: profile?.user.name || "Profile" }} />
      <ScrollView
        className={"flex-1 bg-background"}
        contentInsetAdjustmentBehavior={"automatic"}
        contentContainerStyle={{
          paddingTop: 12,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 16,
          gap: 16,
        }}
      >
        {profile ? (
          <>
            <Card animated={false} className={"gap-4 p-5"}>
              <View className={"gap-2"}>
                <ThemedText variant={"title2"} className={"font-bold"}>
                  {profile.user.name || "Profile"}
                </ThemedText>
                {profile.profile.homeCity || profile.profile.favoriteCuisine ? (
                  <ThemedText variant={"body"} color={"secondary"}>
                    {[profile.profile.homeCity, profile.profile.favoriteCuisine].filter(Boolean).join(" · ")}
                  </ThemedText>
                ) : null}
                <ThemedText variant={"footnote"} color={"tertiary"}>
                  {profile.profile.publicVisits ? "Public visit history enabled" : "Visit history is private"}
                </ThemedText>
              </View>

              <View className={"flex-row gap-3"}>
                <CountTile label={"Visits"} value={profile.counts.syncedVisits} />
                <CountTile label={"Following"} value={profile.counts.following} />
                <CountTile label={"Followers"} value={profile.counts.followers} />
              </View>

              {!profile.relationship.isSelf ? (
                session?.user ? (
                  <Button onPress={() => followMutation.mutate()} loading={followMutation.isPending}>
                    <ButtonText>{getFollowActionLabel(profile.relationship)}</ButtonText>
                  </Button>
                ) : (
                  <AppleSignInButton variant={"secondary"} label={"Sign In To Follow"} />
                )
              ) : null}
            </Card>

            <Card animated={false} className={"gap-3 p-5"}>
              <ThemedText variant={"title4"} className={"font-semibold"}>
                Confirmed visits
              </ThemedText>

              {profile.visitsVisible ? (
                profile.visits.length > 0 ? (
                  <View className={"gap-3"}>
                    {profile.visits.map((visit) => (
                      <View
                        key={visit.localVisitId}
                        className={"rounded-2xl border border-white/10 bg-background px-4 py-3"}
                      >
                        <ThemedText variant={"heading"} className={"font-semibold"}>
                          {visit.restaurantName}
                        </ThemedText>
                        <ThemedText variant={"footnote"} color={"secondary"}>
                          {formatVisitDate(visit.startTime)} · {visit.photoCount.toLocaleString()} photo
                          {visit.photoCount === 1 ? "" : "s"}
                        </ThemedText>
                        {visit.awardAtVisit ? (
                          <ThemedText variant={"caption1"} color={"tertiary"}>
                            Awarded {visit.awardAtVisit} at the time of visit
                          </ThemedText>
                        ) : null}
                      </View>
                    ))}
                  </View>
                ) : (
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    No confirmed visits have been synced yet.
                  </ThemedText>
                )
              ) : (
                <ThemedText variant={"footnote"} color={"secondary"}>
                  This user has not made their confirmed visits public.
                </ThemedText>
              )}
            </Card>
          </>
        ) : (
          <Card animated={false} className={"p-5"}>
            <ThemedText variant={"footnote"} color={"secondary"}>
              {profileQuery.isLoading ? "Loading profile..." : "This profile could not be loaded."}
            </ThemedText>
          </Card>
        )}
      </ScrollView>
    </>
  );
}

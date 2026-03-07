import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthTextField } from "@/components/auth/auth-text-field";
import { UserRow } from "@/components/social/user-row";
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

function SectionTitle({ title }: { title: string }) {
  return (
    <ThemedText variant={"footnote"} color={"tertiary"} className={"px-1 font-semibold uppercase tracking-wide"}>
      {title}
    </ThemedText>
  );
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

export default function SocialScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();
  const { showToast } = useToast();
  const { data: session } = useSession();
  const [query, setQuery] = useState("");

  const socialQuery = useQuery({
    queryKey: cloudQueryKeys.socialMe,
    enabled: Boolean(session?.user),
    queryFn: () => trpcClient.social.me.query(),
  });

  const trimmedQuery = query.trim();
  const searchQuery = useQuery({
    queryKey: cloudQueryKeys.socialSearch(trimmedQuery),
    enabled: Boolean(session?.user) && trimmedQuery.length >= 2,
    queryFn: () => trpcClient.social.search.query({ query: trimmedQuery }),
  });

  const followMutation = useMutation({
    mutationFn: async ({ userId, isFollowing }: { userId: string; isFollowing: boolean }) => {
      return isFollowing ? trpcClient.social.unfollow.mutate({ userId }) : trpcClient.social.follow.mutate({ userId });
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["cloud", "social"] });
      queryClient.invalidateQueries({ queryKey: cloudQueryKeys.publicProfile(variables.userId) });
    },
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Unable to update follow state." });
    },
  });

  const isLoggedIn = Boolean(session?.user);

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentInsetAdjustmentBehavior={"automatic"}
      contentContainerStyle={{
        paddingTop: 12,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 16,
        gap: 16,
      }}
      keyboardShouldPersistTaps={"handled"}
    >
      {!isLoggedIn ? (
        <Card animated={false} className={"gap-4 p-5"}>
          <View className={"gap-1"}>
            <ThemedText variant={"title4"} className={"font-semibold"}>
              Sign in for friends and following
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              You can use Palate without an account. Continue with Apple only when you want cloud sync or social
              features.
            </ThemedText>
          </View>

          <Button onPress={() => router.push("/(auth)/sign-in" as Href)}>
            <ButtonText>Continue with Apple</ButtonText>
          </Button>
        </Card>
      ) : (
        <>
          <Card animated={false} className={"gap-4 p-5"}>
            <View className={"gap-1"}>
              <ThemedText variant={"title4"} className={"font-semibold"}>
                Search people
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Search by name, email, home city, or favorite cuisine.
              </ThemedText>
            </View>

            <AuthTextField
              label={"People"}
              value={query}
              onChangeText={setQuery}
              placeholder={"Search Palate people"}
            />

            {trimmedQuery.length >= 2 && searchQuery.isLoading ? (
              <View className={"flex-row items-center gap-2 px-1"}>
                <ActivityIndicator color={"#0A84FF"} />
                <ThemedText variant={"footnote"} color={"secondary"}>
                  Looking for people...
                </ThemedText>
              </View>
            ) : null}

            {trimmedQuery.length >= 2 && searchQuery.data ? (
              <View className={"gap-3"}>
                <SectionTitle title={"Search results"} />
                {searchQuery.data.length > 0 ? (
                  searchQuery.data.map((person) => (
                    <UserRow
                      key={person.id}
                      user={person}
                      relationship={person.relationship}
                      onPress={() => router.push(`/people/${person.id}` as Href)}
                      actionLabel={getFollowActionLabel(person.relationship)}
                      actionLoading={followMutation.isPending && followMutation.variables?.userId === person.id}
                      onPressAction={() =>
                        followMutation.mutate({
                          userId: person.id,
                          isFollowing: person.relationship.isFollowing,
                        })
                      }
                    />
                  ))
                ) : (
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    No people matched that search.
                  </ThemedText>
                )}
              </View>
            ) : null}
          </Card>

          <Card animated={false} className={"gap-4 p-5"}>
            <SectionTitle title={"Overview"} />
            <View className={"flex-row gap-3"}>
              <CountTile label={"Friends"} value={socialQuery.data?.counts.friends} />
              <CountTile label={"Following"} value={socialQuery.data?.counts.following} />
              <CountTile label={"Followers"} value={socialQuery.data?.counts.followers} />
            </View>
          </Card>

          <View className={"gap-3"}>
            <SectionTitle title={"Friends"} />
            {socialQuery.data?.friends.length ? (
              socialQuery.data.friends.map((person) => (
                <UserRow
                  key={`friend-${person.id}`}
                  user={person}
                  relationship={person.relationship}
                  onPress={() => router.push(`/people/${person.id}` as Href)}
                  actionLabel={"Unfollow"}
                  actionLoading={followMutation.isPending && followMutation.variables?.userId === person.id}
                  onPressAction={() => followMutation.mutate({ userId: person.id, isFollowing: true })}
                />
              ))
            ) : (
              <Card animated={false} className={"p-4"}>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  Mutual follows appear here as friends.
                </ThemedText>
              </Card>
            )}
          </View>

          <View className={"gap-3"}>
            <SectionTitle title={"Following"} />
            {socialQuery.data?.following.length ? (
              socialQuery.data.following.map((person) => (
                <UserRow
                  key={`following-${person.id}`}
                  user={person}
                  relationship={person.relationship}
                  onPress={() => router.push(`/people/${person.id}` as Href)}
                  actionLabel={"Unfollow"}
                  actionLoading={followMutation.isPending && followMutation.variables?.userId === person.id}
                  onPressAction={() => followMutation.mutate({ userId: person.id, isFollowing: true })}
                />
              ))
            ) : (
              <Card animated={false} className={"p-4"}>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  Search for people above to start following them.
                </ThemedText>
              </Card>
            )}
          </View>

          <View className={"gap-3"}>
            <SectionTitle title={"Followers"} />
            {socialQuery.data?.followers.length ? (
              socialQuery.data.followers.map((person) => (
                <UserRow
                  key={`follower-${person.id}`}
                  user={person}
                  relationship={person.relationship}
                  onPress={() => router.push(`/people/${person.id}` as Href)}
                  actionLabel={getFollowActionLabel(person.relationship)}
                  actionLoading={followMutation.isPending && followMutation.variables?.userId === person.id}
                  onPressAction={() =>
                    followMutation.mutate({
                      userId: person.id,
                      isFollowing: person.relationship.isFollowing,
                    })
                  }
                />
              ))
            ) : (
              <Card animated={false} className={"p-4"}>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  Followers will show up here when other people follow you.
                </ThemedText>
              </Card>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import React, { useState } from "react";
import { ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthTextField } from "@/components/auth/auth-text-field";
import { ThemedText } from "@/components/themed-text";
import { useToast } from "@/components/ui/toast";
import { Button, ButtonText, Card } from "@/components/ui";
import { signOut, useSession } from "@/lib/auth-client";
import { cloudQueryKeys, syncConfirmedVisitsSnapshot } from "@/lib/cloud-sync";
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

interface ProfileDraft {
  homeCity: string;
  favoriteCuisine: string;
  publicVisits: boolean;
}

function getProfileDraft(
  profile:
    | {
        homeCity?: string | null;
        favoriteCuisine?: string | null;
        publicVisits?: boolean;
      }
    | null
    | undefined,
): ProfileDraft {
  return {
    homeCity: profile?.homeCity ?? "",
    favoriteCuisine: profile?.favoriteCuisine ?? "",
    publicVisits: profile?.publicVisits ?? false,
  };
}

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();
  const { data: session } = useSession();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);

  const profileQuery = useQuery({
    queryKey: cloudQueryKeys.profile,
    enabled: Boolean(session?.user),
    queryFn: () => trpcClient.profile.me.query(),
  });

  const healthQuery = useQuery({
    queryKey: cloudQueryKeys.health,
    queryFn: () => trpcClient.health.ping.query(),
  });

  const profile = profileQuery.data?.profile;
  const activeDraft = session?.user ? draft : null;
  const homeCity = activeDraft?.homeCity ?? profile?.homeCity ?? "";
  const favoriteCuisine = activeDraft?.favoriteCuisine ?? profile?.favoriteCuisine ?? "";
  const publicVisits = activeDraft?.publicVisits ?? profile?.publicVisits ?? false;

  const updateProfileMutation = useMutation({
    mutationFn: async () => {
      if (!session?.user) {
        throw new Error("Sign in to save your cloud profile.");
      }

      return trpcClient.profile.update.mutate({
        homeCity: homeCity.trim() || null,
        favoriteCuisine: favoriteCuisine.trim() || null,
        publicVisits,
      });
    },
    onSuccess: (profile) => {
      queryClient.setQueryData(
        cloudQueryKeys.profile,
        (current: Awaited<ReturnType<typeof trpcClient.profile.me.query>> | undefined) =>
          current
            ? {
                ...current,
                profile,
              }
            : current,
      );
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ["cloud", "social"] });
      showToast({ type: "success", message: "Cloud profile updated." });
    },
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Failed to save your profile" });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => syncConfirmedVisitsSnapshot({ throwOnError: true }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: cloudQueryKeys.profile });
      queryClient.invalidateQueries({ queryKey: ["cloud", "social"] });
      showToast({
        type: "success",
        message: result.skipped
          ? "Sign in to sync visits."
          : `Synced ${result.syncedCount.toLocaleString()} confirmed visits.`,
      });
    },
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Failed to sync confirmed visits." });
    },
  });

  async function handleSignOut() {
    const result = await signOut();

    if (result.error) {
      showToast({ type: "error", message: result.error.message ?? "Unable to sign out" });
      return;
    }

    queryClient.removeQueries({ queryKey: ["cloud"] });
    setDraft(null);
    router.replace("/" as Href);
  }

  const counts = profileQuery.data?.counts;

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
      <Card animated={false} className={"gap-4 p-5"}>
        <View className={"gap-2"}>
          <ThemedText variant={"title2"} className={"font-bold"}>
            {session?.user?.name || "Local-first Palate"}
          </ThemedText>
          <ThemedText variant={"body"} color={"secondary"} selectable>
            {session?.user?.email ?? "Use Palate without an account, then sign in later for sync and social."}
          </ThemedText>
        </View>

        <View className={"rounded-2xl border border-white/10 bg-background px-4 py-3"}>
          <ThemedText variant={"caption1"} color={"tertiary"} className={"uppercase tracking-[1.4px]"}>
            Backend status
          </ThemedText>
          <ThemedText variant={"subhead"} className={"mt-2 font-semibold"}>
            {healthQuery.data?.status === "ok" ? "Connected to tRPC backend" : "Waiting for backend"}
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"} selectable>
            {healthQuery.data?.serverTime ?? "Start `yarn server:dev` to bring the backend online."}
          </ThemedText>
        </View>

        {session?.user ? (
          <Button variant={"secondary"} onPress={handleSignOut}>
            <ButtonText variant={"secondary"}>Sign Out</ButtonText>
          </Button>
        ) : (
          <Button onPress={() => router.push("/sign-in" as Href)}>
            <ButtonText>Continue with Apple</ButtonText>
          </Button>
        )}
      </Card>

      {session?.user ? (
        <>
          <Card animated={false} className={"gap-4 p-5"}>
            <View className={"gap-1"}>
              <ThemedText variant={"title4"} className={"font-semibold"}>
                Cloud profile
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Keep your profile data and optional visit visibility in Postgres.
              </ThemedText>
            </View>

            <AuthTextField
              label={"Home city"}
              value={homeCity}
              onChangeText={(value) =>
                setDraft((current) => ({
                  ...(current ?? getProfileDraft(profile)),
                  homeCity: value,
                }))
              }
              placeholder={"San Francisco"}
            />
            <AuthTextField
              label={"Favorite cuisine"}
              value={favoriteCuisine}
              onChangeText={(value) =>
                setDraft((current) => ({
                  ...(current ?? getProfileDraft(profile)),
                  favoriteCuisine: value,
                }))
              }
              placeholder={"Japanese"}
            />

            <View className={"rounded-2xl border border-white/10 bg-background px-4 py-3"}>
              <View className={"flex-row items-center justify-between gap-3"}>
                <View className={"flex-1 gap-1"}>
                  <ThemedText variant={"subhead"} className={"font-semibold"}>
                    Public confirmed visits
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    Show synced confirmed visits on your public profile for followers and friends.
                  </ThemedText>
                </View>
                <Switch
                  value={publicVisits}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...(current ?? getProfileDraft(profile)),
                      publicVisits: value,
                    }))
                  }
                />
              </View>
            </View>

            {profileQuery.error ? (
              <ThemedText
                variant={"footnote"}
                className={"rounded-2xl bg-red-500/10 px-3 py-2 text-red-300"}
                selectable
              >
                {profileQuery.error.message}
              </ThemedText>
            ) : null}

            <Button onPress={() => updateProfileMutation.mutate()} loading={updateProfileMutation.isPending}>
              <ButtonText>Save Cloud Profile</ButtonText>
            </Button>
          </Card>

          <Card animated={false} className={"gap-4 p-5"}>
            <View className={"gap-1"}>
              <ThemedText variant={"title4"} className={"font-semibold"}>
                Sync & social
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Confirmed visits sync in the background when you are logged in. You can also trigger a fresh snapshot.
              </ThemedText>
            </View>

            <View className={"flex-row gap-3"}>
              <CountTile label={"Synced visits"} value={counts?.syncedVisits} />
              <CountTile label={"Following"} value={counts?.following} />
              <CountTile label={"Friends"} value={counts?.friends} />
            </View>

            <View className={"flex-row gap-3"}>
              <Button className={"flex-1"} onPress={() => syncMutation.mutate()} loading={syncMutation.isPending}>
                <ButtonText>Sync Confirmed Visits</ButtonText>
              </Button>
              <Button className={"flex-1"} variant={"secondary"} onPress={() => router.push("/social" as Href)}>
                <ButtonText variant={"secondary"}>Manage Social</ButtonText>
              </Button>
            </View>
          </Card>
        </>
      ) : (
        <Card animated={false} className={"gap-3 p-5"}>
          <ThemedText variant={"title4"} className={"font-semibold"}>
            Optional cloud features
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"}>
            Signing in is still optional. When you want cloud sync, public visit history, or following, continue with
            Apple.
          </ThemedText>
        </Card>
      )}
    </ScrollView>
  );
}

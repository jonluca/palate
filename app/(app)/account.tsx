import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import React, { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthTextField } from "@/components/auth/auth-text-field";
import { ThemedText } from "@/components/themed-text";
import { useToast } from "@/components/ui/toast";
import { Button, ButtonText, Card } from "@/components/ui";
import { signOut, useSession } from "@/lib/auth-client";
import { useTRPCClient } from "@/lib/trpc";

const REMOTE_PROFILE_QUERY_KEY = ["auth", "profile"] as const;
const HEALTH_QUERY_KEY = ["auth", "health"] as const;

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();
  const { data: session } = useSession();
  const [homeCity, setHomeCity] = useState("");
  const [favoriteCuisine, setFavoriteCuisine] = useState("");

  const profileQuery = useQuery({
    queryKey: REMOTE_PROFILE_QUERY_KEY,
    enabled: Boolean(session?.user),
    queryFn: () => trpcClient.profile.me.query(),
  });

  const healthQuery = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: () => trpcClient.health.ping.query(),
  });

  useEffect(() => {
    if (!profileQuery.data) {
      return;
    }

    setHomeCity(profileQuery.data.profile?.homeCity ?? "");
    setFavoriteCuisine(profileQuery.data.profile?.favoriteCuisine ?? "");
  }, [profileQuery.data]);

  const updateProfileMutation = useMutation({
    mutationFn: () =>
      trpcClient.profile.update.mutate({
        homeCity: homeCity.trim() || null,
        favoriteCuisine: favoriteCuisine.trim() || null,
      }),
    onSuccess: (profile) => {
      queryClient.setQueryData(
        REMOTE_PROFILE_QUERY_KEY,
        (current: Awaited<ReturnType<typeof trpcClient.profile.me.query>>) =>
          current
            ? {
                ...current,
                profile,
              }
            : current,
      );
      showToast({ type: "success", message: "Profile synced to Postgres" });
    },
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Failed to save your profile" });
    },
  });

  async function handleSignOut() {
    const result = await signOut();

    if (result.error) {
      showToast({ type: "error", message: result.error.message ?? "Unable to sign out" });
      return;
    }

    queryClient.removeQueries({ queryKey: REMOTE_PROFILE_QUERY_KEY });
    queryClient.removeQueries({ queryKey: HEALTH_QUERY_KEY });
    router.replace("/(auth)/sign-in" as Href);
  }

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
            {session?.user.name ?? "Palate account"}
          </ThemedText>
          <ThemedText variant={"body"} color={"secondary"} selectable>
            {session?.user.email ?? "Not signed in"}
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

        <Button variant={"secondary"} onPress={handleSignOut}>
          <ButtonText variant={"secondary"}>Sign Out</ButtonText>
        </Button>
      </Card>

      <Card animated={false} className={"gap-4 p-5"}>
        <View className={"gap-1"}>
          <ThemedText variant={"title4"} className={"font-semibold"}>
            Cloud profile
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"}>
            This data is stored in Postgres through the protected tRPC router.
          </ThemedText>
        </View>

        <AuthTextField label={"Home city"} value={homeCity} onChangeText={setHomeCity} placeholder={"San Francisco"} />
        <AuthTextField
          label={"Favorite cuisine"}
          value={favoriteCuisine}
          onChangeText={setFavoriteCuisine}
          placeholder={"Japanese"}
        />

        {profileQuery.error ? (
          <ThemedText variant={"footnote"} className={"rounded-2xl bg-red-500/10 px-3 py-2 text-red-300"} selectable>
            {profileQuery.error.message}
          </ThemedText>
        ) : null}

        <Button onPress={() => updateProfileMutation.mutate()} loading={updateProfileMutation.isPending}>
          <ButtonText>Save Cloud Profile</ButtonText>
        </Button>
      </Card>
    </ScrollView>
  );
}

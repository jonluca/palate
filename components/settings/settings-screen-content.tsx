import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";
import { AppleSignInButton } from "@/components/auth/apple-sign-in-button";
import { ThemedText } from "@/components/themed-text";
import {
  AboutCard,
  AdvancedSettingsCard,
  AllVisitsCard,
  CalendarSection,
  DeepScanCard,
  QuickActionsCard,
} from "@/components/settings";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth-client";
import { cloudQueryKeys, syncConfirmedVisitsSnapshot } from "@/lib/cloud-sync";
import { useTRPCClient } from "@/lib/trpc";

function SettingsSectionHeader({ title }: { title: string }) {
  return (
    <ThemedText variant={"footnote"} color={"tertiary"} className={"mb-3 px-1 font-semibold uppercase tracking-wide"}>
      {title}
    </ThemedText>
  );
}

function CloudSettingsCard() {
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();
  const { showToast } = useToast();
  const { data: session } = useSession();

  const profileQuery = useQuery({
    queryKey: cloudQueryKeys.profile,
    enabled: Boolean(session?.user),
    queryFn: () => trpcClient.profile.me.query(),
  });

  const profile = profileQuery.data?.profile;
  const counts = profileQuery.data?.counts;

  const publicVisitsMutation = useMutation({
    mutationFn: async (publicVisits: boolean) => {
      if (!session?.user) {
        throw new Error("Sign in to manage cloud settings.");
      }

      return trpcClient.profile.update.mutate({
        bio: profile?.bio ?? null,
        homeCity: profile?.homeCity ?? null,
        favoriteCuisine: profile?.favoriteCuisine ?? null,
        publicVisits,
      });
    },
    onSuccess: (updatedProfile) => {
      queryClient.setQueryData(
        cloudQueryKeys.profile,
        (current: Awaited<ReturnType<typeof trpcClient.profile.me.query>> | undefined) =>
          current
            ? {
                ...current,
                profile: updatedProfile,
              }
            : current,
      );
      queryClient.invalidateQueries({ queryKey: ["cloud", "social"] });
      if (session?.user?.id) {
        queryClient.invalidateQueries({ queryKey: cloudQueryKeys.publicProfile(session.user.id) });
      }
      showToast({
        type: "success",
        message: updatedProfile.publicVisits ? "Public visit history enabled." : "Public visit history hidden.",
      });
    },
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Unable to update visit visibility." });
    },
  });

  const displayedPublicVisits =
    publicVisitsMutation.isPending && typeof publicVisitsMutation.variables === "boolean"
      ? publicVisitsMutation.variables
      : (profile?.publicVisits ?? false);

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

  if (!session?.user) {
    return null;
  }

  return (
    <Card animated={false} className={"gap-4 p-5"}>
      <View className={"gap-1"}>
        <ThemedText variant={"title4"} className={"font-semibold"}>
          Cloud & privacy
        </ThemedText>
        <ThemedText variant={"footnote"} color={"secondary"}>
          Choose what friends can see and trigger a fresh sync when your visit history changes.
        </ThemedText>
      </View>

      <View className={"rounded-2xl border border-white/10 bg-background px-4 py-3"}>
        <View className={"flex-row items-center justify-between gap-3"}>
          <View className={"flex-1 gap-1"}>
            <ThemedText variant={"subhead"} className={"font-semibold"}>
              Public confirmed visits
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Let followers and friends see the confirmed visits on your public profile.
            </ThemedText>
          </View>
          <Switch
            value={displayedPublicVisits}
            onValueChange={(value) => publicVisitsMutation.mutate(value)}
            disabled={publicVisitsMutation.isPending || profileQuery.isLoading}
          />
        </View>
      </View>

      <View className={"rounded-2xl border border-white/10 bg-background px-4 py-3"}>
        <ThemedText variant={"subhead"} className={"font-semibold"}>
          {`${(counts?.syncedVisits ?? 0).toLocaleString()} confirmed visit${counts?.syncedVisits === 1 ? "" : "s"} synced`}
        </ThemedText>
        <ThemedText variant={"footnote"} color={"secondary"}>
          Palate syncs in the background when you open the app, and you can force a fresh snapshot any time.
        </ThemedText>
      </View>

      {profileQuery.error ? (
        <ThemedText variant={"footnote"} className={"rounded-2xl bg-red-500/10 px-3 py-2 text-red-300"} selectable>
          {profileQuery.error.message}
        </ThemedText>
      ) : null}

      <View className={"flex-row gap-3"}>
        <Button className={"flex-1"} onPress={() => syncMutation.mutate()} loading={syncMutation.isPending}>
          <ButtonText>Force Sync</ButtonText>
        </Button>
        <Button className={"flex-1"} variant={"secondary"} onPress={() => router.push("/social" as Href)}>
          <ButtonText variant={"secondary"}>Friends</ButtonText>
        </Button>
      </View>
    </Card>
  );
}

interface SettingsScreenContentProps {
  showSignInButton?: boolean;
}

export function SettingsScreenContent({ showSignInButton = false }: SettingsScreenContentProps) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries();
    setRefreshing(false);
  }, [queryClient]);

  const shouldShowSignInButton = showSignInButton && !session?.user;

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentInsetAdjustmentBehavior={"automatic"}
      contentContainerStyle={{
        paddingTop: 12,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 16,
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className={"mb-6 gap-2"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Settings
        </ThemedText>
        <ThemedText variant={"body"} color={"secondary"}>
          Manage your app, privacy, and food memories
        </ThemedText>
      </View>

      {shouldShowSignInButton ? (
        <Animated.View entering={FadeInDown.delay(140).duration(300)} className={"mb-6 gap-2"}>
          <AppleSignInButton />
          <ThemedText variant={"footnote"} color={"tertiary"} className={"px-1"}>
            Sign in if you want cloud sync, public profiles, and to follow friends.
          </ThemedText>
        </Animated.View>
      ) : null}

      {session?.user ? (
        <Animated.View entering={FadeInDown.delay(150).duration(300)} className={"mb-6"}>
          <SettingsSectionHeader title={"Cloud"} />
          <CloudSettingsCard />
        </Animated.View>
      ) : null}

      <Animated.View entering={FadeInDown.delay(180).duration(300)} className={"mb-6"}>
        <SettingsSectionHeader title={"Daily Use"} />
        <View className={"gap-3"}>
          <AllVisitsCard />
          <QuickActionsCard />
          <DeepScanCard />
        </View>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(230).duration(300)} className={"mb-6"}>
        <SettingsSectionHeader title={"Calendar"} />
        <CalendarSection />
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(280).duration(300)} className={"mb-6"}>
        <SettingsSectionHeader title={"Advanced"} />
        <AdvancedSettingsCard />
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(330).duration(300)}>
        <SettingsSectionHeader title={"About"} />
        <AboutCard />
      </Animated.View>
    </ScrollView>
  );
}

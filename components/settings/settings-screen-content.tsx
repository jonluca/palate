import { useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
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
import { useSession } from "@/lib/auth-client";

function SettingsSectionHeader({ title }: { title: string }) {
  return (
    <ThemedText variant={"footnote"} color={"tertiary"} className={"mb-3 px-1 font-semibold uppercase tracking-wide"}>
      {title}
    </ThemedText>
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
          Manage your app, data, and stats
        </ThemedText>
      </View>

      {shouldShowSignInButton ? (
        <Animated.View entering={FadeInDown.delay(140).duration(300)} className={"mb-6 gap-2"}>
          <AppleSignInButton />
          <ThemedText variant={"footnote"} color={"tertiary"} className={"px-1"}>
            Sign in only when you want cloud sync, public profiles, or social features.
          </ThemedText>
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

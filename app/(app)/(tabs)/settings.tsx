import React, { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { Link, type Href } from "expo-router";
import Animated, { FadeInDown } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import {
  AboutCard,
  AdvancedSettingsCard,
  AllVisitsCard,
  CalendarSection,
  DeepScanCard,
  QuickActionsCard,
} from "@/components/settings";
import { Card } from "@/components/ui";
import { useSession } from "@/lib/auth-client";

function SettingsSectionHeader({ title }: { title: string }) {
  return (
    <ThemedText variant={"footnote"} color={"tertiary"} className={"mb-3 px-1 font-semibold uppercase tracking-wide"}>
      {title}
    </ThemedText>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const { data: session } = useSession();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries();
    setRefreshing(false);
  }, [queryClient]);

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
      <View className={"gap-2 mb-6"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Settings
        </ThemedText>
        <ThemedText variant={"body"} color={"secondary"}>
          Manage your data and view stats
        </ThemedText>
      </View>

      <Animated.View entering={FadeInDown.delay(150).duration(300)} className={"mb-6"}>
        <SettingsSectionHeader title={"Account"} />
        <Link href={"/(app)/account" as Href} asChild>
          <Pressable>
            <Card animated={false} className={"gap-1 p-4"}>
              <ThemedText variant={"heading"} className={"font-semibold"}>
                {session?.user.name ?? "Account"}
              </ThemedText>
              <ThemedText variant={"subhead"} color={"secondary"} selectable>
                {session?.user.email ?? "Manage your sign-in and cloud profile"}
              </ThemedText>
              <ThemedText variant={"footnote"} color={"tertiary"}>
                Better Auth session, tRPC profile, and sign-out controls
              </ThemedText>
            </Card>
          </Pressable>
        </Link>
      </Animated.View>

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

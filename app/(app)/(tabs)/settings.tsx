import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import Animated, { FadeInDown } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import {
  AboutCard,
  AdvancedSettingsCard,
  AllVisitsCard,
  AuthEntryCard,
  CalendarSection,
  DeepScanCard,
  QuickActionsCard,
} from "@/components/settings";

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
          Manage your app, data, and stats
        </ThemedText>
      </View>

      <Animated.View entering={FadeInDown.delay(150).duration(300)} className={"mb-6"}>
        <AuthEntryCard />
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

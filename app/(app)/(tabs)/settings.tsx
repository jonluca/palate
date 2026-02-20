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
  CalendarSection,
  DeepScanCard,
  QuickActionsCard,
  SectionHeader,
} from "@/components/settings";

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
          Manage your data and view stats
        </ThemedText>
      </View>

      <Animated.View entering={FadeInDown.delay(150).duration(300)} className={"mb-6"}>
        <SectionHeader>Daily Use</SectionHeader>
        <View className={"gap-3"}>
          <AllVisitsCard />
          <QuickActionsCard />
          <DeepScanCard />
        </View>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(200).duration(300)} className={"mb-6"}>
        <SectionHeader>Calendar</SectionHeader>
        <CalendarSection />
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(250).duration(300)} className={"mb-6"}>
        <SectionHeader>Advanced</SectionHeader>
        <AdvancedSettingsCard />
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(300).duration(300)}>
        <SectionHeader>About</SectionHeader>
        <AboutCard />
      </Animated.View>
    </ScrollView>
  );
}

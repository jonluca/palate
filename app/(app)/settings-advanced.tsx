import React, { useCallback } from "react";
import { Alert, View } from "react-native";
import { Stack } from "expo-router";
import * as Haptics from "expo-haptics";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import { useToast } from "@/components/ui/toast";
import { useIgnoredLocations, useRemoveIgnoredLocation, useStats, type IgnoredLocationRecord } from "@/hooks/queries";
import {
  DangerZoneCard,
  ExportVisitsCard,
  FastAnimationsCard,
  FoodKeywordsCard,
  GoogleMapsApiKeyCard,
  IgnoredLocationsCard,
  MergeDuplicatesSection,
  RecomputeSuggestionsCard,
  UndoBarCard,
} from "@/components/settings";
import { ScreenLayout } from "@/components/screen-layout";

function SectionHeader({ children }: { children: string }) {
  return (
    <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide px-1 mb-3"}>
      {children}
    </ThemedText>
  );
}

function AdvancedIntroCard() {
  return (
    <Card animated={false}>
      <View className={"p-4 gap-3"}>
        <View className={"flex-row items-center gap-3"}>
          <View className={"w-10 h-10 rounded-full items-center justify-center bg-purple-500/15"}>
            <IconSymbol name={"slider.horizontal.3"} size={20} color={"#a855f7"} />
          </View>
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Advanced Settings
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Tuning, troubleshooting, and maintenance tools
            </ThemedText>
          </View>
        </View>

        <View className={"bg-background/40 rounded-xl p-3 gap-1.5"}>
          <View className={"flex-row items-center gap-2"}>
            <IconSymbol name={"info.circle"} size={14} color={"#9ca3af"} />
            <ThemedText variant={"caption1"} color={"tertiary"} className={"flex-1"}>
              Most people can leave these settings as-is.
            </ThemedText>
          </View>
          <View className={"flex-row items-center gap-2"}>
            <IconSymbol name={"gearshape.2"} size={14} color={"#9ca3af"} />
            <ThemedText variant={"caption1"} color={"tertiary"} className={"flex-1"}>
              Use them when you need more control or want to fix scanning/matching issues.
            </ThemedText>
          </View>
        </View>
      </View>
    </Card>
  );
}

export default function AdvancedSettingsScreen() {
  const { showToast } = useToast();
  const { data: stats } = useStats();
  const { data: ignoredLocations = [] } = useIgnoredLocations();
  const removeIgnoredLocationMutation = useRemoveIgnoredLocation();

  const handleRemoveIgnoredLocation = useCallback(
    (location: IgnoredLocationRecord) => {
      Alert.alert(
        "Remove Ignored Location",
        `Stop ignoring ${location.name ?? "this location"}? Existing rejected visits won't be restored automatically.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            onPress: () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              removeIgnoredLocationMutation.mutate(location.id, {
                onSuccess: () => showToast({ type: "success", message: "Location removed from ignored list" }),
                onError: () => showToast({ type: "error", message: "Failed to remove location" }),
              });
            },
          },
        ],
      );
    },
    [removeIgnoredLocationMutation, showToast],
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: "Advanced Settings",
          headerLargeTitle: true,
        }}
      />
      <ScreenLayout>
        <AdvancedIntroCard />

        <SectionHeader>Interface</SectionHeader>
        <View className={"gap-3"}>
          <UndoBarCard />
          <FastAnimationsCard />
        </View>

        <SectionHeader>Matching</SectionHeader>
        <View className={"gap-3"}>
          <RecomputeSuggestionsCard />
        </View>

        <MergeDuplicatesSection />

        <View className={"mb-6"}>
          <SectionHeader>Detection & Matching</SectionHeader>
          <View className={"gap-3"}>
            <FoodKeywordsCard />
            <GoogleMapsApiKeyCard />
          </View>
        </View>

        {ignoredLocations.length > 0 && (
          <View className={"mb-6"}>
            <SectionHeader>Ignored Locations</SectionHeader>
            <IgnoredLocationsCard locations={ignoredLocations} onRemove={handleRemoveIgnoredLocation} />
          </View>
        )}

        {stats && stats.confirmedVisits > 0 && (
          <View className={"mb-6"}>
            <SectionHeader>Backup</SectionHeader>
            <ExportVisitsCard />
          </View>
        )}

        <View>
          <SectionHeader>Danger Zone</SectionHeader>
          <DangerZoneCard />
        </View>
      </ScreenLayout>
    </>
  );
}

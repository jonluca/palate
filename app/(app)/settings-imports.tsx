import React from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import { ScreenLayout } from "@/components/screen-layout";
import { OpenTableImportCard, ResyImportCard, SectionHeader, TockImportCard } from "@/components/settings";

function ProviderImportsIntroCard() {
  return (
    <Card animated={false}>
      <View className={"p-4 gap-3"}>
        <View className={"flex-row items-center gap-3"}>
          <View className={"w-10 h-10 rounded-full items-center justify-center bg-red-500/15"}>
            <IconSymbol name={"fork.knife.circle.fill"} size={20} color={"#ff462d"} />
          </View>
          <View className={"flex-1"}>
            <ThemedText variant={"subhead"} className={"font-medium"}>
              Reservation Providers
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Import past reservations as confirmed visits
            </ThemedText>
          </View>
        </View>
      </View>
    </Card>
  );
}

export default function SettingsImportsScreen() {
  return (
    <>
      <Stack.Screen
        options={{
          title: "Reservation Imports",
        }}
      />
      <ScreenLayout>
        <ProviderImportsIntroCard />

        <SectionHeader>Providers</SectionHeader>
        <View className={"gap-3"}>
          <ResyImportCard />
          <TockImportCard />
          <OpenTableImportCard />
        </View>
      </ScreenLayout>
    </>
  );
}

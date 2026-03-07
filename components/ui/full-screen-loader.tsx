import React from "react";
import { ActivityIndicator, View } from "react-native";
import { ThemedText } from "@/components/themed-text";

export function FullScreenLoader({ label = "Loading..." }: { label?: string }) {
  return (
    <View className={"flex-1 items-center justify-center gap-3 bg-background px-6"}>
      <ActivityIndicator size={"large"} color={"#0A84FF"} />
      <ThemedText variant={"callout"} color={"secondary"}>
        {label}
      </ThemedText>
    </View>
  );
}

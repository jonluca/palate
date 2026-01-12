import React from "react";
import { View } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";

interface PhotoCountDisplayProps {
  count: number;
  label?: string;
}

export function PhotoCountDisplay({ count, label = "Ready to scan" }: PhotoCountDisplayProps) {
  return (
    <View className={"flex-row items-center gap-3"}>
      <View className={"w-10 h-10 rounded-full bg-green-500/15 items-center justify-center"}>
        <IconSymbol name={"photo.stack"} size={20} color={"#22c55e"} />
      </View>
      <View className={"flex-1"}>
        <ThemedText variant={"subhead"} className={"font-semibold"}>
          {count.toLocaleString()} Photos
        </ThemedText>
        <ThemedText variant={"footnote"} color={"secondary"}>
          {label}
        </ThemedText>
      </View>
    </View>
  );
}

import React from "react";
import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import type { SymbolViewProps } from "expo-symbols";

interface ScanHeaderProps {
  title: string;
  description: string;
  iconName?: SymbolViewProps["name"];
  iconColor?: string;
  iconBackgroundColor?: string;
}

export function ScanHeader({
  title,
  description,
  iconName = "camera.viewfinder",
  iconColor = "#f97316",
  iconBackgroundColor = "bg-orange-500/15",
}: ScanHeaderProps) {
  return (
    <Animated.View entering={FadeIn.duration(400)} className={"items-center mb-8"}>
      <View className={`w-20 h-20 rounded-full ${iconBackgroundColor} items-center justify-center mb-6`}>
        <IconSymbol name={iconName as never} size={40} color={iconColor} />
      </View>
      <ThemedText variant={"largeTitle"} className={"font-bold text-center mb-2"}>
        {title}
      </ThemedText>
      <ThemedText variant={"body"} color={"secondary"} className={"text-center max-w-xs"}>
        {description}
      </ThemedText>
    </Animated.View>
  );
}

import React from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";

interface HomeHeaderProps {
  onMapPress?: () => void;
}

export function HomeHeader({ onMapPress }: HomeHeaderProps) {
  return (
    <View className={"gap-4"}>
      <View className={"flex-row items-start justify-between"}>
        <Animated.View entering={FadeIn.duration(400)} className={"gap-1 flex-1"}>
          <ThemedText variant={"largeTitle"} className={"font-bold"}>
            Restaurant Visits
          </ThemedText>
        </Animated.View>
        {onMapPress ? (
          <Pressable
            onPress={onMapPress}
            hitSlop={8}
            accessibilityRole={"button"}
            accessibilityLabel={"Open restaurant map"}
            className={"w-11 h-11 rounded-2xl border border-border bg-secondary/70 items-center justify-center ml-3"}
          >
            <IconSymbol name={"map"} size={18} color={"#0A84FF"} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

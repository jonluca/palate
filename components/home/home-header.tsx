import React from "react";
import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";

export function HomeHeader() {
  return (
    <View className={"gap-1"}>
      <Animated.View entering={FadeIn.duration(400)} className={"gap-1 flex-1"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Restaurants
        </ThemedText>
        <ThemedText variant={"footnote"} color={"secondary"}>
          Search, sort, and revisit every place you have saved.
        </ThemedText>
      </Animated.View>
    </View>
  );
}

import React from "react";
import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";

export function HomeHeader() {
  return (
    <View className={"gap-4"}>
      <View className={"flex-row items-start justify-between"}>
        <Animated.View entering={FadeIn.duration(400)} className={"gap-1 flex-1"}>
          <ThemedText variant={"largeTitle"} className={"font-bold"}>
            Restaurant Visits
          </ThemedText>
        </Animated.View>
      </View>
    </View>
  );
}

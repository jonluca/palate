import React from "react";
import { View, Pressable } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";

export function HomeHeader() {
  const handleScanPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push("/rescan");
  };

  return (
    <View className={"gap-4"}>
      {/* Title Row */}
      <View className={"flex-row items-start justify-between"}>
        <Animated.View entering={FadeIn.duration(400)} className={"gap-1 flex-1"}>
          <ThemedText variant={"largeTitle"} className={"font-bold"}>
            Restaurant Visits
          </ThemedText>
        </Animated.View>

        {/* Scan Button */}
        <Animated.View entering={FadeIn.delay(200).duration(300)}>
          <Pressable
            onPress={handleScanPress}
            className={"w-11 h-11 rounded-full bg-orange-500/15 items-center justify-center"}
          >
            <IconSymbol name={"camera.viewfinder"} size={22} color={"#f97316"} />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

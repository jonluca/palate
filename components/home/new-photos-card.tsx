import React from "react";
import { View, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeIn, FadeInRight, useSharedValue, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useQuery } from "@tanstack/react-query";
import { getTotalPhotoCount } from "@/utils/db";
import { usePermissions, usePhotoCount, queryKeys } from "@/hooks/queries";

/**
 * Hook to check for new photos that haven't been scanned yet
 */
function useNewPhotosCount() {
  const { data: hasPermission } = usePermissions();
  const { data: cameraRollCount } = usePhotoCount(hasPermission === true);

  const { data: dbPhotoCount } = useQuery({
    queryKey: [...queryKeys.stats, "dbPhotoCount"],
    queryFn: getTotalPhotoCount,
    enabled: hasPermission === true,
  });

  const newPhotosCount =
    hasPermission && cameraRollCount !== undefined && dbPhotoCount !== undefined
      ? Math.max(0, cameraRollCount - dbPhotoCount)
      : 0;

  return {
    newPhotosCount,
    hasPermission,
    isLoading: cameraRollCount === undefined || dbPhotoCount === undefined,
  };
}

export function NewPhotosCard() {
  const { newPhotosCount, hasPermission, isLoading } = useNewPhotosCount();
  const cardScale = useSharedValue(1);

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push("/rescan");
  };

  const handlePressIn = () => {
    cardScale.value = withTiming(0.98, { duration: 100 });
  };

  const handlePressOut = () => {
    cardScale.value = withTiming(1, { duration: 200 });
  };

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: cardScale.value }],
  }));

  if (isLoading || !hasPermission || newPhotosCount === 0) {
    return null;
  }

  return (
    <Animated.View entering={FadeIn.duration(400)} className={"rounded-2xl overflow-hidden"} style={cardStyle}>
      <Pressable onPress={handlePress} onPressIn={handlePressIn} onPressOut={handlePressOut}>
        <LinearGradient
          colors={["#059669", "#10b981", "#34d399"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          className={"rounded-2xl overflow-hidden"}
          style={{ borderCurve: "continuous" }}
        >
          <View className={"p-4 flex-row items-center gap-4"}>
            {/* Icon */}
            <View className={"w-12 h-12 rounded-full bg-white/20 items-center justify-center"}>
              <IconSymbol name={"photo.badge.plus"} size={24} color={"white"} />
            </View>

            {/* Content */}
            <View className={"flex-1 gap-0.5"}>
              <ThemedText variant={"title1"} className={"text-white font-semibold"}>
                {newPhotosCount.toLocaleString()} new photo{newPhotosCount === 1 ? "" : "s"}
              </ThemedText>
              <ThemedText variant={"footnote"} className={"text-white/70"}>
                Tap to scan for restaurant visits
              </ThemedText>
            </View>

            {/* Arrow */}
            <Animated.View
              entering={FadeInRight.delay(200).duration(300)}
              className={"w-8 h-8 rounded-full bg-white/20 items-center justify-center"}
            >
              <IconSymbol name={"chevron.right"} size={16} color={"white"} />
            </Animated.View>
          </View>
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

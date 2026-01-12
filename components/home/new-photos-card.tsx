import React from "react";
import { View, Pressable } from "react-native";
import Animated, {
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
  withRepeat,
  Easing,
} from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useQuery } from "@tanstack/react-query";
import { getTotalPhotoCount } from "@/utils/db";
import { usePermissions, usePhotoCount, queryKeys } from "@/hooks/queries";
import { useEffect } from "react";

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
  const pulseOpacity = useSharedValue(1);

  // Subtle pulse animation on the badge
  useEffect(() => {
    pulseOpacity.value = withRepeat(
      withSequence(
        withTiming(0.6, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      true,
    );
  }, [pulseOpacity]);

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

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
  }));

  if (isLoading || !hasPermission || newPhotosCount === 0) {
    return null;
  }

  return (
    <Animated.View
      entering={FadeIn.duration(400)}
      className={"rounded-2xl overflow-hidden bg-card"}
      style={[cardStyle, { borderCurve: "continuous" }]}
    >
      <Pressable onPress={handlePress} onPressIn={handlePressIn} onPressOut={handlePressOut}>
        <View className={"p-4 flex-row items-center gap-3"}>
          {/* Icon with green background */}
          <View className={"w-11 h-11 rounded-xl bg-green-500 items-center justify-center"}>
            <IconSymbol name={"photo.badge.plus"} size={22} color={"white"} />
          </View>

          {/* Content */}
          <View className={"flex-1 gap-0.5"}>
            <View className={"flex-row items-center gap-2"}>
              <ThemedText variant={"heading"} className={"font-semibold"}>
                New Photos
              </ThemedText>
              {/* iOS-style count badge */}
              <Animated.View
                style={pulseStyle}
                className={"bg-green-500 px-2 py-0.5 rounded-full min-w-[24px] items-center"}
              >
                <ThemedText variant={"caption1"} className={"text-white font-bold"}>
                  {newPhotosCount > 999 ? "999+" : newPhotosCount}
                </ThemedText>
              </Animated.View>
            </View>
            <ThemedText variant={"footnote"} color={"tertiary"}>
              Tap to scan for restaurant visits
            </ThemedText>
          </View>

          {/* Chevron */}
          <View className={"w-7 h-7 items-center justify-center"}>
            <IconSymbol name={"chevron.right"} size={14} color={"#C7C7CC"} weight={"semibold"} />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

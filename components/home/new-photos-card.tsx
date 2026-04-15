import React from "react";
import { View, Pressable } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useQuery } from "@tanstack/react-query";
import { getTotalPhotoCount } from "@/utils/db";
import { usePermissions, usePhotoCount, queryKeys } from "@/hooks/queries";
import { useResetScan } from "@/store";

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
  const resetScan = useResetScan();
  const shouldShow = !isLoading && Boolean(hasPermission) && newPhotosCount > 0;

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    resetScan();
    router.push("/rescan");
  };

  if (!shouldShow) {
    return null;
  }

  return (
    <Animated.View entering={FadeIn.duration(200)} className={"rounded-2xl"}>
      <Pressable onPress={handlePress}>
        <View className={"p-4 flex-row items-center gap-3 bg-card border border-emerald-500/20 rounded-2xl"}>
          <View
            className={
              "w-11 h-11 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 items-center justify-center"
            }
          >
            <IconSymbol name={"photo.badge.plus"} size={20} color={"#34d399"} />
          </View>

          <View className={"flex-1 gap-0.5"}>
            <View className={"flex-row items-center gap-2"}>
              <ThemedText variant={"heading"} className={"font-semibold"}>
                New Photos
              </ThemedText>
              <View
                className={
                  "bg-emerald-500/15 border border-emerald-500/20 px-2 py-0.5 rounded-full min-w-[24px] items-center"
                }
              >
                <ThemedText
                  variant={"caption1"}
                  className={"text-emerald-300 font-semibold"}
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {newPhotosCount > 999 ? "999+" : newPhotosCount}
                </ThemedText>
              </View>
            </View>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Tap to scan for restaurant visits
            </ThemedText>
          </View>

          <View className={"w-8 h-8 rounded-full bg-secondary/80 items-center justify-center"}>
            <IconSymbol name={"chevron.right"} size={13} color={"#8E8E93"} weight={"semibold"} />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

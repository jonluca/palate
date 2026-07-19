import React from "react";
import { Platform, Pressable, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useQuery } from "@tanstack/react-query";
import { queryKeys, usePermissions } from "@/hooks/queries";
import { useResetScan } from "@/store";
import { getUnscannedPhotoCount } from "@/services/scanner";

/**
 * Hook to check for new photos that haven't been scanned yet
 */
function useNewPhotosCount() {
  const { data: hasPermission } = usePermissions();
  const { data: newPhotosCount } = useQuery({
    queryKey: [...queryKeys.photoCount, "unscanned"],
    queryFn: getUnscannedPhotoCount,
    enabled: hasPermission === true,
    staleTime: 1000 * 60 * 2,
  });

  return {
    newPhotosCount: newPhotosCount ?? 0,
    hasPermission,
    isLoading: hasPermission === true && newPhotosCount === undefined,
  };
}

export function NewPhotosCard() {
  const { newPhotosCount, hasPermission, isLoading } = useNewPhotosCount();
  const resetScan = useResetScan();
  const shouldShow = !isLoading && Boolean(hasPermission) && newPhotosCount > 0;
  const formattedNewPhotosCount = newPhotosCount.toLocaleString();
  const displayedNewPhotosCount = newPhotosCount > 999 ? "999+" : formattedNewPhotosCount;

  const handlePress = () => {
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    resetScan();
    router.push("/rescan");
  };

  if (!shouldShow) {
    return null;
  }

  return (
    <Animated.View entering={FadeIn.duration(200)} className={"rounded-2xl"}>
      <Pressable
        onPress={handlePress}
        accessibilityRole={"button"}
        accessibilityLabel={`${formattedNewPhotosCount} new photos ready to scan`}
        accessibilityHint={"Opens the scan screen to look for new restaurant visits"}
        style={({ pressed }) => ({
          borderCurve: "continuous",
          opacity: pressed ? 0.7 : 1,
        })}
        className={"rounded-2xl border border-border bg-card"}
      >
        <View className={"p-4 flex-row items-center gap-3"}>
          <View className={"size-11 rounded-xl bg-emerald-500/15 items-center justify-center"}>
            <IconSymbol name={"camera.fill"} size={19} color={"#34d399"} />
          </View>

          <View className={"flex-1 gap-0.5"}>
            <ThemedText variant={"heading"} className={"font-semibold"}>
              New photos available
            </ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Scan for new restaurant visits
            </ThemedText>
          </View>

          <View className={"flex-row items-center gap-2"}>
            <View className={"min-w-6 h-6 px-1.5 rounded-full bg-emerald-500/15 items-center justify-center"}>
              <ThemedText
                variant={"caption1"}
                className={"text-emerald-400 font-semibold"}
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {displayedNewPhotosCount}
              </ThemedText>
            </View>
            <IconSymbol name={"chevron.right"} size={13} color={"#8E8E93"} weight={"semibold"} />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

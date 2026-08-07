import React from "react";
import { ActivityIndicator, View } from "react-native";
import Animated, { FadeIn, FadeOut, useReducedMotion } from "react-native-reanimated";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { useAppStore } from "@/store";
import { cn } from "@/utils/cn";

const indeterminatePulse = {
  "0%": { opacity: 0.35, transform: [{ scaleX: 0.08 }] },
  "50%": { opacity: 1, transform: [{ scaleX: 1 }] },
  "100%": { opacity: 0.35, transform: [{ scaleX: 0.08 }] },
};

interface BackgroundPhotoUpdateBarProps {
  className?: string;
}

export function BackgroundPhotoUpdateBar({ className }: BackgroundPhotoUpdateBarProps) {
  const reduceMotion = useReducedMotion();
  const update = useAppStore((state) =>
    state.isBackgroundPhotoScanRunning ? state.backgroundPhotoScanProgress : null,
  );

  if (update === null) {
    return null;
  }

  const percentage = update.progress === null ? null : Math.round(update.progress * 100);
  const accessibilityValue =
    percentage === null
      ? { text: update.detail }
      : { min: 0, max: 100, now: percentage, text: `${percentage.toLocaleString()}% · ${update.detail}` };

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      className={cn("rounded-2xl border border-primary/20 bg-primary/10 px-3.5 py-3 gap-2.5", className)}
      style={{ borderCurve: "continuous" }}
      accessible={true}
      accessibilityRole={"progressbar"}
      accessibilityLabel={"Updating photos in the background"}
      accessibilityValue={accessibilityValue}
    >
      <View className={"flex-row items-center gap-3"}>
        <View className={"size-8 rounded-full bg-primary/15 items-center justify-center"}>
          {reduceMotion ? (
            <IconSymbol name={"arrow.triangle.2.circlepath"} size={16} color={"#0A84FF"} />
          ) : (
            <ActivityIndicator size={"small"} color={"#0A84FF"} />
          )}
        </View>

        <View className={"flex-1 gap-0.5"}>
          <ThemedText variant={"footnote"} className={"font-semibold"}>
            Updating in background
          </ThemedText>
          <ThemedText variant={"caption1"} color={"secondary"} numberOfLines={2}>
            {update.detail}
          </ThemedText>
        </View>

        {percentage !== null ? (
          <ThemedText
            variant={"caption1"}
            className={"text-primary font-semibold"}
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {percentage.toLocaleString()}%
          </ThemedText>
        ) : null}
      </View>

      <View className={"h-1.5 rounded-full bg-primary/15 overflow-hidden"}>
        {percentage === null ? (
          reduceMotion ? (
            <View className={"h-full w-1/3 rounded-full bg-primary"} />
          ) : (
            <Animated.View
              className={"h-full w-full rounded-full bg-primary"}
              style={{
                transformOrigin: "left center",
                animationName: indeterminatePulse,
                animationDuration: "1200ms",
                animationIterationCount: "infinite",
                animationTimingFunction: "ease-in-out",
              }}
            />
          )
        ) : (
          <Animated.View
            className={"h-full w-full rounded-full bg-primary"}
            style={[
              {
                transformOrigin: "left center",
                transform: [{ scaleX: update.progress ?? 0 }],
              },
              reduceMotion
                ? undefined
                : {
                    transitionProperty: "transform",
                    transitionDuration: 220,
                    transitionTimingFunction: "ease-out",
                  },
            ]}
          />
        )}
      </View>
    </Animated.View>
  );
}

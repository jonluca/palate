import { cn } from "@/utils/cn";
import React from "react";
import { View } from "react-native";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { ThemedText } from "../themed-text";

interface StatRowProps {
  label: string;
  value: string | number;
  valueColor?: string;
  delay?: number;
  animated?: boolean;
}

export function StatRow({ label, value, valueColor, delay = 0, animated = true }: StatRowProps) {
  const content = (
    <>
      <ThemedText variant={"subhead"} color={"tertiary"}>
        {label}
      </ThemedText>
      <ThemedText
        variant={"subhead"}
        className={cn("font-semibold", valueColor)}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </ThemedText>
    </>
  );

  if (animated) {
    return (
      <Animated.View
        entering={FadeIn.delay(delay).duration(300)}
        layout={LinearTransition}
        className={"flex-row justify-between items-center py-2"}
      >
        {content}
      </Animated.View>
    );
  }

  return <View className={"flex-row justify-between items-center py-2"}>{content}</View>;
}

export function StatDivider({ delay = 0, animated = true }: { delay?: number; animated?: boolean }) {
  if (animated) {
    return <Animated.View entering={FadeIn.delay(delay).duration(200)} className={"h-px bg-border my-3"} />;
  }

  return <View className={"h-px bg-border my-3"} />;
}

import React from "react";
import { View, Pressable } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card, StatRow, StatDivider } from "@/components/ui";
import { formatTime, formatDuration } from "./utils";
import * as Haptics from "expo-haptics";

interface VisitDetailsCardProps {
  startTime: number;
  endTime: number;
  photoCount: number;
  mergeableCount: number;
  onMergePress: () => void;
}

export function VisitDetailsCard({
  startTime,
  endTime,
  photoCount,
  mergeableCount,
  onMergePress,
}: VisitDetailsCardProps) {
  const handleMergePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onMergePress();
  };

  return (
    <Card delay={100}>
      <View className={"p-4"}>
        <StatRow label={"Time"} value={`${formatTime(startTime)} – ${formatTime(endTime)}`} delay={0} />
        <StatRow label={"Duration"} value={formatDuration(startTime, endTime)} delay={50} />
        <StatRow label={"Photos"} value={photoCount} delay={100} />
        {mergeableCount > 0 && (
          <>
            <StatDivider delay={300} />
            <Animated.View entering={FadeIn.delay(350).duration(200)} className={"pt-2"}>
              <Pressable
                onPress={handleMergePress}
                className={"flex-row items-center justify-center gap-2 py-2 bg-blue-500/10 rounded-lg"}
              >
                <IconSymbol name={"arrow.triangle.merge"} size={16} color={"#3b82f6"} />
                <ThemedText variant={"subhead"} className={"text-blue-500 font-medium"}>
                  Merge with Another Visit
                </ThemedText>
              </Pressable>
            </Animated.View>
          </>
        )}
      </View>
    </Card>
  );
}

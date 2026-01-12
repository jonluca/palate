import React from "react";
import { View } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { uniqBy } from "lodash-es";

export interface AggregatedFoodLabel {
  label: string;
  maxConfidence: number;
  photoCount: number;
}

interface FoodDetectionCardProps {
  labels: AggregatedFoodLabel[];
}

export function FoodDetectionCard({ labels }: FoodDetectionCardProps) {
  if (labels.length === 0) {
    return null;
  }
  const uniqueLabels = uniqBy(labels, "label");

  return (
    <Card delay={85}>
      <View className={"p-4 gap-3"}>
        <View className={"flex-row items-center gap-2"}>
          <View className={"w-7 h-7 rounded-full bg-amber-500/20 items-center justify-center"}>
            <ThemedText variant={"subhead"}>🍽️</ThemedText>
          </View>
          <ThemedText variant={"footnote"} color={"secondary"}>
            Food Detected
          </ThemedText>
        </View>
        <View className={"flex-row flex-wrap gap-2"}>
          {uniqueLabels.map((item) => (
            <View key={item.label} className={"flex-row items-center gap-1.5 bg-amber-500/15 px-3 py-1.5 rounded-full"}>
              <ThemedText variant={"subhead"} className={"text-amber-700 font-medium"}>
                {item.label}
              </ThemedText>
              <ThemedText variant={"caption1"} className={"text-amber-600/70"}>
                {Math.round(item.maxConfidence * 100).toLocaleString()}%
              </ThemedText>
            </View>
          ))}
        </View>
      </View>
    </Card>
  );
}

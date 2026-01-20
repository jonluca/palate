import React, { useMemo, useState } from "react";
import { Pressable, View, LayoutAnimation } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { Ionicons } from "@expo/vector-icons";
import type { FoodLabel } from "@/utils/db";

export interface AggregatedLabel {
  label: string;
  maxConfidence: number;
  photoCount: number;
}

interface AllLabelsCardProps {
  photos: Array<{ allLabels?: FoodLabel[] | null }>;
}

export function AllLabelsCard({ photos }: AllLabelsCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Aggregate all labels from photos
  const aggregatedLabels = useMemo(() => {
    const labelMap = new Map<string, { maxConfidence: number; photoCount: number }>();

    for (const photo of photos) {
      if (!photo.allLabels) {
        continue;
      }

      for (const label of photo.allLabels) {
        const existing = labelMap.get(label.label);
        if (existing) {
          existing.maxConfidence = Math.max(existing.maxConfidence, label.confidence);
          existing.photoCount++;
        } else {
          labelMap.set(label.label, {
            maxConfidence: label.confidence,
            photoCount: 1,
          });
        }
      }
    }

    return Array.from(labelMap.entries())
      .map(([label, data]) => ({ label, ...data }))
      .sort((a, b) => b.maxConfidence - a.maxConfidence);
  }, [photos]);

  if (aggregatedLabels.length === 0) {
    return null;
  }

  const toggleExpanded = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsExpanded(!isExpanded);
  };

  // Show top 5 labels when collapsed, all when expanded
  const displayedLabels = isExpanded ? aggregatedLabels : aggregatedLabels.slice(0, 5);
  const hasMoreLabels = aggregatedLabels.length > 5;

  return (
    <Card delay={95}>
      <Pressable onPress={toggleExpanded} className={"p-4 gap-3"}>
        <View className={"flex-row items-center justify-between"}>
          <View className={"flex-row items-center gap-2"}>
            <View className={"w-7 h-7 rounded-full bg-purple-500/20 items-center justify-center"}>
              <Ionicons name={"images"} size={16} color={"#a855f7"} />
            </View>
            <ThemedText variant={"footnote"} color={"secondary"}>
              All Image Labels
            </ThemedText>
            <View className={"bg-purple-500/20 px-2 py-0.5 rounded-full"}>
              <ThemedText variant={"caption2"} className={"text-purple-600"}>
                {aggregatedLabels.length.toLocaleString()}
              </ThemedText>
            </View>
          </View>
          <Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={18} color={"#9ca3af"} />
        </View>

        <View className={"flex-row flex-wrap gap-2"}>
          {displayedLabels.map((item) => (
            <View
              key={item.label}
              className={"flex-row items-center gap-1.5 bg-purple-500/10 px-3 py-1.5 rounded-full"}
            >
              <ThemedText variant={"subhead"} className={"text-purple-700 font-medium"}>
                {item.label}
              </ThemedText>
              <ThemedText variant={"caption1"} className={"text-purple-600/70"}>
                {Math.round(item.maxConfidence * 100)}%
              </ThemedText>
            </View>
          ))}
        </View>

        {!isExpanded && hasMoreLabels && (
          <ThemedText variant={"caption1"} color={"tertiary"} className={"text-center"}>
            Tap to see {aggregatedLabels.length - 5} more labels
          </ThemedText>
        )}
      </Pressable>
    </Card>
  );
}

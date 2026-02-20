import React from "react";
import { View, Pressable, Modal, ScrollView, ActivityIndicator, Image, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Badge } from "@/components/ui";
import { statusVariant, formatDate } from "./utils";
import type { VisitWithRestaurant } from "@/hooks/queries";
import * as Haptics from "expo-haptics";

interface MergeVisitsModalProps {
  visible: boolean;
  isLoading: boolean;
  visits: VisitWithRestaurant[];
  onMerge: (sourceVisit: VisitWithRestaurant) => void;
  onClose: () => void;
}

export function MergeVisitsModal({ visible, isLoading, visits, onMerge, onClose }: MergeVisitsModalProps) {
  const insets = useSafeAreaInsets();

  const handleMerge = (visit: VisitWithRestaurant) => {
    Alert.alert(
      "Merge Visits",
      `Merge "${visit.restaurantName ?? visit.suggestedRestaurantName ?? "Unknown"}" (${visit.photoCount.toLocaleString()} photos) into this visit?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Merge",
          style: "destructive",
          onPress: () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onMerge(visit);
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} transparent={true} animationType={"slide"} onRequestClose={onClose}>
      <View className={"flex-1 bg-black/50 justify-end"}>
        <Pressable className={"absolute inset-0"} onPress={onClose} />
        <View
          className={"bg-card rounded-t-3xl overflow-hidden"}
          style={{ paddingBottom: insets.bottom + 16, maxHeight: "80%" }}
        >
          {/* Header */}
          <View className={"flex-row items-center justify-between p-4 border-b border-border"}>
            <ThemedText variant={"title3"} className={"font-semibold"}>
              Merge Visits
            </ThemedText>
            <Pressable onPress={onClose} hitSlop={8}>
              <IconSymbol name={"xmark.circle.fill"} size={28} color={"#6b7280"} />
            </Pressable>
          </View>

          {/* Description */}
          <View className={"px-4 py-3 bg-blue-500/10"}>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Select a visit to merge into this one. All photos from the selected visit will be moved here.
            </ThemedText>
          </View>

          {/* Visits List */}
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}>
            {isLoading ? (
              <View className={"py-12 items-center"}>
                <ActivityIndicator size={"large"} />
                <ThemedText variant={"footnote"} color={"secondary"} className={"mt-3"}>
                  Loading visits...
                </ThemedText>
              </View>
            ) : visits.length === 0 ? (
              <View className={"py-12 items-center"}>
                <IconSymbol name={"photo.stack"} size={40} color={"#6b7280"} />
                <ThemedText variant={"body"} color={"secondary"} className={"mt-3 text-center"}>
                  No other visits found to merge with.
                </ThemedText>
              </View>
            ) : (
              visits.map((mergeVisit) => (
                <Pressable
                  key={mergeVisit.id}
                  onPress={() => handleMerge(mergeVisit)}
                  className={"bg-background rounded-xl p-3  active:bg-border/50"}
                >
                  <View className={"flex-row gap-3"}>
                    {/* Preview Photos */}
                    {mergeVisit.previewPhotos.length > 0 && (
                      <View className={"w-16 h-16 rounded-lg overflow-hidden bg-gray-500/20"}>
                        <Image
                          source={{ uri: mergeVisit.previewPhotos[0] }}
                          style={{ width: "100%", height: "100%" }}
                          resizeMode={"cover"}
                        />
                      </View>
                    )}

                    {/* Info */}
                    <View className={"flex-1 gap-1"}>
                      <ThemedText variant={"subhead"} className={"font-medium"} numberOfLines={1}>
                        {mergeVisit.restaurantName ?? mergeVisit.suggestedRestaurantName ?? "Unknown Location"}
                      </ThemedText>
                      <ThemedText variant={"caption1"} color={"secondary"}>
                        {formatDate(mergeVisit.startTime)}
                      </ThemedText>
                      <View className={"flex-row items-center gap-3"}>
                        <View className={"flex-row items-center gap-1"}>
                          <IconSymbol name={"photo"} size={12} color={"#6b7280"} />
                          <ThemedText variant={"caption2"} color={"tertiary"}>
                            {mergeVisit.photoCount.toLocaleString()} photos
                          </ThemedText>
                        </View>
                        <Badge variant={statusVariant[mergeVisit.status]} label={mergeVisit.status} />
                        {Boolean(mergeVisit.foodProbable) && <ThemedText variant={"caption2"}>🍽️</ThemedText>}
                      </View>
                    </View>

                    {/* Merge indicator */}
                    <View className={"justify-center"}>
                      <IconSymbol name={"arrow.right.circle"} size={24} color={"#3b82f6"} />
                    </View>
                  </View>
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

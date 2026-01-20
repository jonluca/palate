import React, { useCallback, useMemo, useState } from "react";
import { View, Alert, ScrollView, Pressable } from "react-native";
import { useToast } from "@/components/ui/toast";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import Animated, { FadeInDown } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import {
  usePendingReview,
  useBatchUpdateVisitStatus,
  useBatchConfirmVisits,
  useMergeableSameRestaurantVisits,
  useBatchMergeSameRestaurantVisits,
  type MergeableVisitGroup,
} from "@/hooks/queries";

const PHOTO_THRESHOLD_OPTIONS = [3, 5, 10, 20, 50];

// Aggregate all unique food labels with visit counts
function useAllFoodLabels(pendingVisits: Array<{ id: string; foodLabels: Array<{ label: string }> }>) {
  return useMemo(() => {
    const labelMap = new Map<string, Set<string>>(); // label -> set of visit IDs

    for (const visit of pendingVisits) {
      for (const foodLabel of visit.foodLabels) {
        const existing = labelMap.get(foodLabel.label) ?? new Set();
        existing.add(visit.id);
        labelMap.set(foodLabel.label, existing);
      }
    }

    // Convert to array and sort by visit count (descending)
    const labels = Array.from(labelMap.entries())
      .map(([label, visitIds]) => ({
        label,
        visitCount: visitIds.size,
        visitIds: Array.from(visitIds),
      }))
      .sort((a, b) => b.visitCount - a.visitCount);

    return labels;
  }, [pendingVisits]);
}

export default function QuickActionsScreen() {
  const insets = useSafeAreaInsets();
  const [selectedPhotoThreshold, setSelectedPhotoThreshold] = useState(3);
  const [selectedFoodLabels, setSelectedFoodLabels] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const { showToast } = useToast();

  const { data, isLoading } = usePendingReview();
  const pendingVisits = useMemo(() => data?.visits ?? [], [data?.visits]);
  const exactCalendarMatches = useMemo(() => data?.exactMatches ?? [], [data?.exactMatches]);

  const batchUpdateMutation = useBatchUpdateVisitStatus();
  const batchConfirmMutation = useBatchConfirmVisits();

  // Merge same restaurant visits
  const { data: mergeableGroups = [] } = useMergeableSameRestaurantVisits();
  const batchMergeMutation = useBatchMergeSameRestaurantVisits();

  // Calculate total visits that can be merged
  const totalMergeableVisits = useMemo(() => {
    return mergeableGroups.reduce((sum: number, group) => sum + group.visits.length, 0);
  }, [mergeableGroups]);

  // Calculate how many visits will remain after merge (one per group)
  const visitsAfterMerge = mergeableGroups.length;
  const visitsToMerge = totalMergeableVisits - visitsAfterMerge;

  // Get all unique food labels across pending visits
  const allFoodLabels = useAllFoodLabels(pendingVisits);

  // Calculate counts based on current threshold
  const visitsUnderThreshold = pendingVisits.filter((v) => v.photoCount < selectedPhotoThreshold);
  const nonFoodVisits = pendingVisits.filter((v) => !v.foodProbable);
  const visitsWithoutMichelinMatch = pendingVisits.filter(
    (v) => !v.suggestedRestaurantId && v.suggestedRestaurants.length === 0,
  );

  // Calculate visits with selected food labels
  const visitsWithSelectedLabels = useMemo(() => {
    if (selectedFoodLabels.size === 0) {
      return [];
    }
    return pendingVisits.filter((visit) => visit.foodLabels.some((fl) => selectedFoodLabels.has(fl.label)));
  }, [pendingVisits, selectedFoodLabels]);

  const handleIgnoreByPhotoCount = useCallback(async () => {
    if (visitsUnderThreshold.length === 0) {
      return;
    }

    Alert.alert(
      "Ignore Visits",
      `This will skip ${visitsUnderThreshold.length.toLocaleString()} visit${visitsUnderThreshold.length === 1 ? "" : "s"} with fewer than ${selectedPhotoThreshold.toLocaleString()} photo${selectedPhotoThreshold === 1 ? "" : "s"}. This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Skip Visits",
          style: "destructive",
          onPress: async () => {
            setIsProcessing(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const visitIds = visitsUnderThreshold.map((v) => v.id);
              await batchUpdateMutation.mutateAsync({ visitIds, newStatus: "rejected" });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Skipped ${visitIds.length.toLocaleString()} visit${visitIds.length === 1 ? "" : "s"}.`,
              });
            } catch (error) {
              console.error("Error skipping visits:", error);
              showToast({ type: "error", message: "Failed to skip visits. Please try again." });
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ],
    );
  }, [visitsUnderThreshold, selectedPhotoThreshold, batchUpdateMutation, showToast]);

  const handleIgnoreNonFood = useCallback(async () => {
    if (nonFoodVisits.length === 0) {
      return;
    }

    Alert.alert(
      "Skip Non-Food Visits",
      `This will skip ${nonFoodVisits.length.toLocaleString()} visit${nonFoodVisits.length === 1 ? "" : "s"} that don't appear to contain food photos. This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Skip Visits",
          style: "destructive",
          onPress: async () => {
            setIsProcessing(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const visitIds = nonFoodVisits.map((v) => v.id);
              await batchUpdateMutation.mutateAsync({ visitIds, newStatus: "rejected" });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Skipped ${visitIds.length.toLocaleString()} non-food visit${visitIds.length === 1 ? "" : "s"}.`,
              });
            } catch (error) {
              console.error("Error skipping visits:", error);
              showToast({ type: "error", message: "Failed to skip visits. Please try again." });
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ],
    );
  }, [nonFoodVisits, batchUpdateMutation, showToast]);

  const handleIgnoreNoMichelinMatch = useCallback(async () => {
    if (visitsWithoutMichelinMatch.length === 0) {
      return;
    }

    Alert.alert(
      "Skip Unmatched Visits",
      `This will skip ${visitsWithoutMichelinMatch.length.toLocaleString()} visit${visitsWithoutMichelinMatch.length === 1 ? "" : "s"} that don't have a Michelin restaurant match. This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Skip Visits",
          style: "destructive",
          onPress: async () => {
            setIsProcessing(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const visitIds = visitsWithoutMichelinMatch.map((v) => v.id);
              await batchUpdateMutation.mutateAsync({ visitIds, newStatus: "rejected" });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Skipped ${visitIds.length.toLocaleString()} unmatched visit${visitIds.length === 1 ? "" : "s"}.`,
              });
            } catch (error) {
              console.error("Error skipping visits:", error);
              showToast({ type: "error", message: "Failed to skip visits. Please try again." });
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ],
    );
  }, [visitsWithoutMichelinMatch, batchUpdateMutation, showToast]);

  const handleToggleFoodLabel = useCallback((label: string) => {
    Haptics.selectionAsync();
    setSelectedFoodLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  const handleIgnoreByFoodLabels = useCallback(async () => {
    if (visitsWithSelectedLabels.length === 0) {
      return;
    }

    const labelsList = Array.from(selectedFoodLabels).join(", ");
    Alert.alert(
      "Skip Visits by Food Label",
      `This will skip ${visitsWithSelectedLabels.length.toLocaleString()} visit${visitsWithSelectedLabels.length === 1 ? "" : "s"} containing photos labeled: ${labelsList}. This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Skip Visits",
          style: "destructive",
          onPress: async () => {
            setIsProcessing(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const visitIds = visitsWithSelectedLabels.map((v) => v.id);
              await batchUpdateMutation.mutateAsync({ visitIds, newStatus: "rejected" });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Skipped ${visitIds.length.toLocaleString()} visit${visitIds.length === 1 ? "" : "s"}.`,
              });
              // Clear selection after successful skip
              setSelectedFoodLabels(new Set());
            } catch (error) {
              console.error("Error skipping visits:", error);
              showToast({ type: "error", message: "Failed to skip visits. Please try again." });
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ],
    );
  }, [visitsWithSelectedLabels, selectedFoodLabels, batchUpdateMutation, showToast]);

  const handleSkipAll = useCallback(async () => {
    if (pendingVisits.length === 0) {
      return;
    }

    Alert.alert(
      "Skip All Pending Visits",
      `This will skip ALL ${pendingVisits.length.toLocaleString()} pending visit${pendingVisits.length === 1 ? "" : "s"}. This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Skip All",
          style: "destructive",
          onPress: async () => {
            setIsProcessing(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            try {
              const visitIds = pendingVisits.map((v) => v.id);
              await batchUpdateMutation.mutateAsync({ visitIds, newStatus: "rejected" });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Skipped all ${visitIds.length.toLocaleString()} pending visits.`,
              });
            } catch (error) {
              console.error("Error skipping visits:", error);
              showToast({ type: "error", message: "Failed to skip visits. Please try again." });
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ],
    );
  }, [pendingVisits, batchUpdateMutation, showToast]);

  const handleApproveExactMatches = useCallback(async () => {
    if (exactCalendarMatches.length === 0) {
      return;
    }

    Alert.alert(
      "Auto-Approve Calendar Matches",
      `This will confirm ${exactCalendarMatches.length.toLocaleString()} visit${exactCalendarMatches.length === 1 ? "" : "s"} where the calendar event name exactly matches a Michelin restaurant. This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve All",
          style: "default",
          onPress: async () => {
            setIsProcessing(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              await batchConfirmMutation.mutateAsync(exactCalendarMatches);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Confirmed ${exactCalendarMatches.length.toLocaleString()} visit${exactCalendarMatches.length === 1 ? "" : "s"}.`,
              });
            } catch (error) {
              console.error("Error confirming visits:", error);
              showToast({ type: "error", message: "Failed to confirm visits. Please try again." });
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ],
    );
  }, [exactCalendarMatches, batchConfirmMutation, showToast]);

  const handleMergeSameRestaurantVisits = useCallback(async () => {
    if (mergeableGroups.length === 0) {
      return;
    }

    Alert.alert(
      "Merge Same-Restaurant Visits",
      `This will merge ${visitsToMerge.toLocaleString()} visit${visitsToMerge === 1 ? "" : "s"} into ${mergeableGroups.length.toLocaleString()} visit${mergeableGroups.length === 1 ? "" : "s"}. This action cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Merge All",
          style: "default",
          onPress: async () => {
            setIsProcessing(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              const { mergeCount } = await batchMergeMutation.mutateAsync(mergeableGroups);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Merged ${mergeCount.toLocaleString()} visit${mergeCount === 1 ? "" : "s"}.`,
              });
            } catch (error) {
              console.error("Error merging visits:", error);
              showToast({ type: "error", message: "Failed to merge visits. Please try again." });
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ],
    );
  }, [mergeableGroups, visitsToMerge, batchMergeMutation, showToast]);

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentContainerStyle={{
        paddingTop: insets.top + 60,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 16,
      }}
    >
      {/* Header */}
      <View className={"gap-2 mb-6"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Quick Actions
        </ThemedText>
        <ThemedText variant={"body"} color={"secondary"}>
          Bulk operations to speed up your review process
        </ThemedText>
      </View>

      {/* Stats Summary */}
      <Animated.View entering={FadeInDown.delay(100).duration(300)} className={"mb-6"}>
        <Card animated={false}>
          <View className={"p-4 flex-row items-center gap-4"}>
            <View className={"w-12 h-12 rounded-full bg-blue-500/15 items-center justify-center"}>
              <IconSymbol name={"list.bullet.clipboard"} size={24} color={"#3b82f6"} />
            </View>
            <View className={"flex-1"}>
              <ThemedText variant={"title3"} className={"font-bold"}>
                {isLoading ? "..." : pendingVisits.length.toLocaleString()}
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Pending visits to review
              </ThemedText>
            </View>
          </View>
        </Card>
      </Animated.View>

      {/* Auto-Approve Calendar Matches */}
      {exactCalendarMatches.length > 0 && (
        <Animated.View entering={FadeInDown.delay(150).duration(300)} className={"mb-6"}>
          <ThemedText
            variant={"footnote"}
            color={"tertiary"}
            className={"uppercase font-semibold tracking-wide px-1 mb-3"}
          >
            Auto-Approve
          </ThemedText>
          <Card animated={false}>
            <View className={"p-4 gap-4"}>
              <View className={"flex-row items-center gap-3"}>
                <View className={"w-10 h-10 rounded-full bg-green-500/15 items-center justify-center"}>
                  <IconSymbol name={"checkmark.circle.fill"} size={20} color={"#22c55e"} />
                </View>
                <View className={"flex-1"}>
                  <ThemedText variant={"subhead"} className={"font-medium"}>
                    Exact Calendar Matches
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    Calendar event names exactly match Michelin restaurants
                  </ThemedText>
                </View>
              </View>

              {/* Preview of matches */}
              <View className={"gap-2"}>
                {exactCalendarMatches.slice(0, 3).map((match) => (
                  <View key={match.visitId} className={"flex-row items-center gap-2 bg-white/5 rounded-lg px-3 py-2"}>
                    <IconSymbol name={"calendar"} size={14} color={"#22c55e"} />
                    <ThemedText variant={"caption1"} className={"flex-1"} numberOfLines={1}>
                      {match.restaurantName}
                    </ThemedText>
                  </View>
                ))}
                {exactCalendarMatches.length > 3 && (
                  <ThemedText variant={"caption2"} color={"tertiary"} className={"px-1"}>
                    +{exactCalendarMatches.length - 3} more match{exactCalendarMatches.length - 3 === 1 ? "" : "es"}
                  </ThemedText>
                )}
              </View>

              {/* Action Button */}
              <View className={"bg-background/50 rounded-xl p-3"}>
                <View className={"flex-row items-center justify-between"}>
                  <View className={"flex-1"}>
                    <ThemedText variant={"subhead"} className={"font-medium"}>
                      {exactCalendarMatches.length.toLocaleString()} visit
                      {exactCalendarMatches.length === 1 ? "" : "s"}
                    </ThemedText>
                    <ThemedText variant={"caption2"} color={"tertiary"}>
                      Ready to auto-approve
                    </ThemedText>
                  </View>
                  <Button
                    variant={"success"}
                    size={"sm"}
                    onPress={handleApproveExactMatches}
                    loading={isProcessing}
                    disabled={isProcessing}
                  >
                    <ButtonText variant={"success"}>Approve All</ButtonText>
                  </Button>
                </View>
              </View>
            </View>
          </Card>
        </Animated.View>
      )}

      {/* Merge Same-Restaurant Visits */}
      {mergeableGroups.length > 0 && (
        <Animated.View entering={FadeInDown.delay(175).duration(300)} className={"mb-6"}>
          <ThemedText
            variant={"footnote"}
            color={"tertiary"}
            className={"uppercase font-semibold tracking-wide px-1 mb-3"}
          >
            Organize
          </ThemedText>
          <Card animated={false}>
            <View className={"p-4 gap-4"}>
              <View className={"flex-row items-center gap-3"}>
                <View className={"w-10 h-10 rounded-full bg-blue-500/15 items-center justify-center"}>
                  <IconSymbol name={"arrow.triangle.merge"} size={20} color={"#3b82f6"} />
                </View>
                <View className={"flex-1"}>
                  <ThemedText variant={"subhead"} className={"font-medium"}>
                    Merge Same-Restaurant Visits
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    Combine visits to the same restaurant closely clustered in time
                  </ThemedText>
                </View>
              </View>

              {/* Preview of merge groups */}
              <View className={"gap-2"}>
                {mergeableGroups.slice(0, 3).map((group: MergeableVisitGroup) => (
                  <View
                    key={group.restaurantId}
                    className={"flex-row items-center gap-2 bg-white/5 rounded-lg px-3 py-2"}
                  >
                    <IconSymbol name={"arrow.triangle.merge"} size={14} color={"#3b82f6"} />
                    <ThemedText variant={"caption1"} className={"flex-1"} numberOfLines={1}>
                      {group.restaurantName}
                    </ThemedText>
                    <ThemedText variant={"caption2"} color={"tertiary"}>
                      {group.visits.length} visits → 1
                    </ThemedText>
                  </View>
                ))}
                {mergeableGroups.length > 3 && (
                  <ThemedText variant={"caption2"} color={"tertiary"} className={"px-1"}>
                    +{mergeableGroups.length - 3} more group{mergeableGroups.length - 3 === 1 ? "" : "s"}
                  </ThemedText>
                )}
              </View>

              {/* Action Button */}
              <View className={"bg-background/50 rounded-xl p-3"}>
                <View className={"flex-row items-center justify-between"}>
                  <View className={"flex-1"}>
                    <ThemedText variant={"subhead"} className={"font-medium"}>
                      {visitsToMerge.toLocaleString()} visit{visitsToMerge === 1 ? "" : "s"} to merge
                    </ThemedText>
                    <ThemedText variant={"caption2"} color={"tertiary"}>
                      Into {mergeableGroups.length.toLocaleString()} combined visit
                      {mergeableGroups.length === 1 ? "" : "s"}
                    </ThemedText>
                  </View>
                  <Button
                    variant={"default"}
                    size={"sm"}
                    onPress={handleMergeSameRestaurantVisits}
                    loading={isProcessing}
                    disabled={isProcessing}
                  >
                    <ButtonText>Merge All</ButtonText>
                  </Button>
                </View>
              </View>
            </View>
          </Card>
        </Animated.View>
      )}

      {/* Skip by Photo Count */}
      <Animated.View entering={FadeInDown.delay(200).duration(300)} className={"mb-6"}>
        <ThemedText
          variant={"footnote"}
          color={"tertiary"}
          className={"uppercase font-semibold tracking-wide px-1 mb-3"}
        >
          Filter by Photo Count
        </ThemedText>
        <Card animated={false}>
          <View className={"p-4 gap-4"}>
            <View className={"flex-row items-center gap-3"}>
              <View className={"w-10 h-10 rounded-full bg-amber-500/15 items-center justify-center"}>
                <IconSymbol name={"photo.stack"} size={20} color={"#f59e0b"} />
              </View>
              <View className={"flex-1"}>
                <ThemedText variant={"subhead"} className={"font-medium"}>
                  Skip Low-Photo Visits
                </ThemedText>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  Ignore visits with fewer photos than threshold
                </ThemedText>
              </View>
            </View>

            {/* Threshold Selector */}
            <View className={"gap-2"}>
              <ThemedText variant={"caption1"} color={"tertiary"}>
                Minimum photos required:
              </ThemedText>
              <View className={"flex-row gap-2"}>
                {PHOTO_THRESHOLD_OPTIONS.map((threshold) => {
                  const visitsUnderThreshold = pendingVisits.filter((v) => v.photoCount < threshold);
                  const isDisabled = visitsUnderThreshold.length === 0;
                  return (
                    <Pressable
                      key={threshold}
                      onPress={() => {
                        if (isDisabled) {
                          return;
                        }
                        Haptics.selectionAsync();
                        setSelectedPhotoThreshold(threshold);
                      }}
                      className={`flex-1 py-2.5 rounded-xl items-center justify-center ${selectedPhotoThreshold === threshold ? "bg-amber-500" : isDisabled ? "bg-gray-500/10 opacity-20" : "bg-white/5"}`}
                      disabled={isDisabled}
                    >
                      <ThemedText
                        variant={"subhead"}
                        className={`font-semibold ${selectedPhotoThreshold === threshold ? "text-black" : ""}`}
                      >
                        {threshold}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Action Button */}
            <View className={"bg-background/50 rounded-xl p-3"}>
              <View className={"flex-row items-center justify-between"}>
                <View className={"flex-1"}>
                  <ThemedText variant={"subhead"} className={"font-medium"}>
                    {visitsUnderThreshold.length.toLocaleString()} visit
                    {visitsUnderThreshold.length === 1 ? "" : "s"}
                  </ThemedText>
                  <ThemedText variant={"caption2"} color={"tertiary"}>
                    With fewer than {selectedPhotoThreshold} photo{selectedPhotoThreshold === 1 ? "" : "s"}
                  </ThemedText>
                </View>
                <Button
                  variant={"secondary"}
                  size={"sm"}
                  onPress={handleIgnoreByPhotoCount}
                  loading={isProcessing}
                  disabled={visitsUnderThreshold.length === 0 || isProcessing}
                >
                  <ButtonText variant={"secondary"}>Skip</ButtonText>
                </Button>
              </View>
            </View>
          </View>
        </Card>
      </Animated.View>

      {/* Skip Non-Food */}
      <Animated.View entering={FadeInDown.delay(300).duration(300)} className={"mb-6"}>
        <ThemedText
          variant={"footnote"}
          color={"tertiary"}
          className={"uppercase font-semibold tracking-wide px-1 mb-3"}
        >
          Filter by Content
        </ThemedText>
        <Card animated={false}>
          <View className={"p-4 gap-4"}>
            <View className={"flex-row items-center gap-3"}>
              <View className={"w-10 h-10 rounded-full bg-red-500/15 items-center justify-center"}>
                <IconSymbol name={"fork.knife"} size={20} color={"#ef4444"} />
              </View>
              <View className={"flex-1"}>
                <ThemedText variant={"subhead"} className={"font-medium"}>
                  Skip Non-Food Visits
                </ThemedText>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  Ignore visits without detected food photos
                </ThemedText>
              </View>
            </View>

            <View className={"bg-background/50 rounded-xl p-3"}>
              <View className={"flex-row items-center justify-between"}>
                <View className={"flex-1"}>
                  <ThemedText variant={"subhead"} className={"font-medium"}>
                    {nonFoodVisits.length.toLocaleString()} visit{nonFoodVisits.length === 1 ? "" : "s"}
                  </ThemedText>
                  <ThemedText variant={"caption2"} color={"tertiary"}>
                    No food detected in photos
                  </ThemedText>
                </View>
                <Button
                  variant={"secondary"}
                  size={"sm"}
                  onPress={handleIgnoreNonFood}
                  loading={isProcessing}
                  disabled={nonFoodVisits.length === 0 || isProcessing}
                >
                  <ButtonText variant={"secondary"}>Skip</ButtonText>
                </Button>
              </View>
            </View>
          </View>
        </Card>
      </Animated.View>

      {/* Skip No Michelin Match */}
      <Animated.View entering={FadeInDown.delay(400).duration(300)} className={"mb-6"}>
        <Card animated={false}>
          <View className={"p-4 gap-4"}>
            <View className={"flex-row items-center gap-3"}>
              <View className={"w-10 h-10 rounded-full bg-purple-500/15 items-center justify-center"}>
                <IconSymbol name={"star.slash"} size={20} color={"#a855f7"} />
              </View>
              <View className={"flex-1"}>
                <ThemedText variant={"subhead"} className={"font-medium"}>
                  Skip Non-Michelin Visits
                </ThemedText>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  Ignore visits without a Michelin restaurant match
                </ThemedText>
              </View>
            </View>

            <View className={"bg-background/50 rounded-xl p-3"}>
              <View className={"flex-row items-center justify-between"}>
                <View className={"flex-1"}>
                  <ThemedText variant={"subhead"} className={"font-medium"}>
                    {visitsWithoutMichelinMatch.length.toLocaleString()} visit
                    {visitsWithoutMichelinMatch.length === 1 ? "" : "s"}
                  </ThemedText>
                  <ThemedText variant={"caption2"} color={"tertiary"}>
                    No Michelin restaurant nearby
                  </ThemedText>
                </View>
                <Button
                  variant={"secondary"}
                  size={"sm"}
                  onPress={handleIgnoreNoMichelinMatch}
                  loading={isProcessing}
                  disabled={visitsWithoutMichelinMatch.length === 0 || isProcessing}
                >
                  <ButtonText variant={"secondary"}>Skip</ButtonText>
                </Button>
              </View>
            </View>
          </View>
        </Card>
      </Animated.View>

      {/* Skip by Food Label */}
      {allFoodLabels.length > 0 && (
        <Animated.View entering={FadeInDown.delay(450).duration(300)} className={"mb-6"}>
          <ThemedText
            variant={"footnote"}
            color={"tertiary"}
            className={"uppercase font-semibold tracking-wide px-1 mb-3"}
          >
            Filter by Food Label
          </ThemedText>
          <Card animated={false}>
            <View className={"p-4 gap-4"}>
              <View className={"flex-row items-center gap-3"}>
                <View className={"w-10 h-10 rounded-full bg-emerald-500/15 items-center justify-center"}>
                  <IconSymbol name={"tag.fill"} size={20} color={"#10b981"} />
                </View>
                <View className={"flex-1"}>
                  <ThemedText variant={"subhead"} className={"font-medium"}>
                    Skip by Detected Food
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    Ignore visits with specific food types detected
                  </ThemedText>
                </View>
              </View>

              {/* Food Label Pills */}
              <View className={"gap-2"}>
                <ThemedText variant={"caption1"} color={"tertiary"}>
                  Select food labels to skip:
                </ThemedText>
                <View className={"flex-row flex-wrap gap-2"}>
                  {allFoodLabels.map(({ label, visitCount }) => {
                    const isSelected = selectedFoodLabels.has(label);
                    return (
                      <Pressable
                        key={label}
                        onPress={() => handleToggleFoodLabel(label)}
                        className={`px-3 py-1.5 rounded-full flex-row items-center gap-1.5 ${
                          isSelected ? "bg-emerald-500" : "bg-white/10"
                        }`}
                      >
                        <ThemedText variant={"caption1"} className={`font-medium ${isSelected ? "text-black" : ""}`}>
                          {label}
                        </ThemedText>
                        <ThemedText variant={"caption2"} className={isSelected ? "text-black/60" : "text-white/40"}>
                          ({visitCount})
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {/* Action Button */}
              <View className={"bg-background/50 rounded-xl p-3"}>
                <View className={"flex-row items-center justify-between"}>
                  <View className={"flex-1"}>
                    <ThemedText variant={"subhead"} className={"font-medium"}>
                      {visitsWithSelectedLabels.length.toLocaleString()} visit
                      {visitsWithSelectedLabels.length === 1 ? "" : "s"}
                    </ThemedText>
                    <ThemedText variant={"caption2"} color={"tertiary"}>
                      {selectedFoodLabels.size === 0
                        ? "Select labels above"
                        : `With ${selectedFoodLabels.size} label${selectedFoodLabels.size === 1 ? "" : "s"} selected`}
                    </ThemedText>
                  </View>
                  <Button
                    variant={"secondary"}
                    size={"sm"}
                    onPress={handleIgnoreByFoodLabels}
                    loading={isProcessing}
                    disabled={visitsWithSelectedLabels.length === 0 || isProcessing}
                  >
                    <ButtonText variant={"secondary"}>Skip</ButtonText>
                  </Button>
                </View>
              </View>
            </View>
          </Card>
        </Animated.View>
      )}

      {/* Nuclear Option */}
      <Animated.View entering={FadeInDown.delay(550).duration(300)} className={"mb-6"}>
        <ThemedText
          variant={"footnote"}
          color={"tertiary"}
          className={"uppercase font-semibold tracking-wide px-1 mb-3"}
        >
          Danger Zone
        </ThemedText>
        <Card animated={false}>
          <View className={"p-4 gap-4"}>
            <View className={"flex-row items-center gap-3"}>
              <View className={"w-10 h-10 rounded-full bg-red-500/15 items-center justify-center"}>
                <IconSymbol name={"trash"} size={20} color={"#ef4444"} />
              </View>
              <View className={"flex-1"}>
                <ThemedText variant={"subhead"} className={"font-medium"}>
                  Skip All Pending
                </ThemedText>
                <ThemedText variant={"footnote"} color={"secondary"}>
                  Clear your entire pending queue at once
                </ThemedText>
              </View>
            </View>
            <Button
              variant={"destructive"}
              onPress={handleSkipAll}
              loading={isProcessing}
              disabled={pendingVisits.length === 0 || isProcessing}
            >
              <ButtonText variant={"destructive"}>Skip All {pendingVisits.length.toLocaleString()} Visits</ButtonText>
            </Button>
          </View>
        </Card>
      </Animated.View>

      {/* Tip */}
      <Animated.View entering={FadeInDown.delay(650).duration(300)}>
        <View className={"bg-blue-500/10 rounded-xl p-4 flex-row gap-3"}>
          <IconSymbol name={"lightbulb.fill"} size={18} color={"#3b82f6"} />
          <View className={"flex-1"}>
            <ThemedText variant={"footnote"} className={"text-blue-400"}>
              Tip: These actions skip visits (mark as rejected). You can always rescan your photos to find them again
              later.
            </ThemedText>
          </View>
        </View>
      </Animated.View>
    </ScrollView>
  );
}

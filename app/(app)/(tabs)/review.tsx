import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { AnimatedListItem } from "@/components/review";
import { DeepScanCard } from "@/components/settings/deep-scan-card";
import { SkeletonVisitCard, Button, ButtonText, Card, useUndo } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import {
  usePendingReview,
  useBatchConfirmVisits,
  type PendingVisitForReview,
  type ExactCalendarMatch,
} from "@/hooks/queries";
import { FlashList } from "@shopify/flash-list";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, RefreshControl, Alert, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useToast } from "@/components/ui/toast";
import Animated, { LinearTransition } from "react-native-reanimated";
import { router } from "expo-router";
import {
  useReviewFoodFilter,
  useSetReviewFoodFilter,
  useReviewRestaurantMatchesFilter,
  useSetReviewRestaurantMatchesFilter,
  useReviewFiltersCollapsed,
  useSetReviewFiltersCollapsed,
} from "@/store";
import { ReviewModeCard } from "@/components/visit-card/review-mode-card";

type ReviewListItem =
  | {
      type: "exact";
      key: string;
      visitId: string;
      match: ExactCalendarMatch;
      exactIndex: number;
    }
  | {
      type: "manual";
      key: string;
      visitId: string;
      visit: PendingVisitForReview;
      manualIndex: number;
    };

function LoadingState() {
  return (
    <View className={"gap-4"}>
      {Array.from({ length: 3 }).map((_, i) => (
        <SkeletonVisitCard key={i} />
      ))}
    </View>
  );
}

function ReviewCaughtUpCard() {
  return (
    <Card className={"border border-green-500/20 bg-green-500/10"}>
      <View className={"p-5 gap-3"}>
        <View className={"flex-row items-center gap-3"}>
          <View
            className={"w-10 h-10 rounded-2xl bg-green-500/15 border border-green-500/20 items-center justify-center"}
          >
            <IconSymbol name={"checkmark.circle.fill"} size={20} color={"#22c55e"} />
          </View>
          <View className={"flex-1"}>
            <ThemedText className={"font-semibold"}>All caught up</ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              You’ve reviewed everything pending.
            </ThemedText>
          </View>
        </View>
        <Button variant={"outline"} onPress={() => router.push("/rescan")}>
          <ButtonText variant={"outline"}>Scan for new photos</ButtonText>
        </Button>
      </View>
    </Card>
  );
}

export default function ReviewScreen() {
  "use no memo";

  const [refreshing, setRefreshing] = useState(false);
  const [isApproving, setIsApproving] = useState(false);

  // Review filters from store
  const foodFilter = useReviewFoodFilter();
  const setFoodFilter = useSetReviewFoodFilter();
  const restaurantMatchesFilter = useReviewRestaurantMatchesFilter();
  const setRestaurantMatchesFilter = useSetReviewRestaurantMatchesFilter();
  const filtersCollapsed = useReviewFiltersCollapsed();
  const setFiltersCollapsed = useSetReviewFiltersCollapsed();

  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { setOnUndoComplete } = useUndo();

  // FlashList refs for scrolling back after undo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reviewListRef = useRef<any>(null);

  // Data queries
  const { data, isLoading } = usePendingReview();
  const pendingVisits = useMemo(() => data?.visits ?? [], [data?.visits]);
  const exactMatches = useMemo(() => data?.exactMatches ?? [], [data?.exactMatches]);

  // Mutations
  const batchConfirmMutation = useBatchConfirmVisits();

  // Computed data
  const exactMatchVisitIds = useMemo(() => new Set(exactMatches.map((m) => m.visitId)), [exactMatches]);

  const reviewableVisits = useMemo(
    () => pendingVisits.filter((v) => !exactMatchVisitIds.has(v.id)),
    [pendingVisits, exactMatchVisitIds],
  );

  const ToggleChip = useCallback(
    ({ label, value, onToggle }: { label: string; value: boolean; onToggle: () => void }) => {
      return (
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onToggle();
          }}
          className={`h-8 px-3 rounded-full border items-center justify-center ${
            value ? "bg-primary/15 border-primary/25" : "bg-secondary/70 border-border"
          }`}
        >
          <ThemedText
            variant={"footnote"}
            className={`font-semibold ${value ? "text-primary" : "text-secondary-foreground"}`}
          >
            {label}
          </ThemedText>
        </Pressable>
      );
    },
    [],
  );

  const filteredReviewableVisits = useMemo(() => {
    const filtered = reviewableVisits.filter((v) => {
      // Food toggle: ON => must have food
      if (foodFilter === "on" && !v.foodProbable) {
        return false;
      }

      // Restaurant matches toggle: ON => must have matches
      // Treat "no matches" as both [] and missing/null (defensive).
      const matchCount = v.suggestedRestaurants?.length ?? 0;
      const hasRestaurantMatches = matchCount > 0;
      if (restaurantMatchesFilter === "on" && !hasRestaurantMatches) {
        return false;
      }

      return true;
    });

    return filtered
      .map((visit, index) => ({ visit, index }))
      .sort((a, b) => {
        const aHasCalendarMatch = Boolean(a.visit.calendarEventTitle);
        const bHasCalendarMatch = Boolean(b.visit.calendarEventTitle);

        if (aHasCalendarMatch !== bHasCalendarMatch) {
          return aHasCalendarMatch ? -1 : 1;
        }

        // Preserve backend order for ties.
        return a.index - b.index;
      })
      .map(({ visit }) => visit);
  }, [reviewableVisits, foodFilter, restaurantMatchesFilter]);

  const mergedReviewItems = useMemo<ReviewListItem[]>(
    () => [
      ...exactMatches.map(
        (match, exactIndex) =>
          ({
            type: "exact",
            key: `exact-${match.visitId}`,
            visitId: match.visitId,
            match,
            exactIndex,
          }) satisfies ReviewListItem,
      ),
      ...filteredReviewableVisits.map(
        (visit, manualIndex) =>
          ({
            type: "manual",
            key: `manual-${visit.id}`,
            visitId: visit.id,
            visit,
            manualIndex,
          }) satisfies ReviewListItem,
      ),
    ],
    [exactMatches, filteredReviewableVisits],
  );

  // UI state
  const hasExactMatches = exactMatches.length > 0;
  const isAllCaughtUp = !isLoading && pendingVisits.length === 0;
  const shouldShowDeepScanEmptyCard =
    foodFilter === "on" && reviewableVisits.length > 0 && !reviewableVisits.some((visit) => visit.foodProbable);

  // Register undo complete callback to scroll back to restored item
  useEffect(() => {
    setOnUndoComplete((visitId: string) => {
      // Wait a bit for the query to refetch and the item to appear in the list
      setTimeout(() => {
        const index = mergedReviewItems.findIndex((item) => item.visitId === visitId);
        if (index !== -1) {
          reviewListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
        }
      }, 300); // Small delay for data to refetch
    });

    return () => setOnUndoComplete(null);
  }, [setOnUndoComplete, mergedReviewItems]);

  // Handlers
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await queryClient.refetchQueries();
    setRefreshing(false);
  }, [queryClient]);

  const handleApproveAllExactMatches = useCallback(() => {
    if (exactMatches.length === 0) {
      return;
    }

    Alert.alert(
      "Approve All Exact Matches",
      `This will confirm ${exactMatches.length.toLocaleString()} visit${exactMatches.length === 1 ? "" : "s"} where the calendar event name exactly matches a Michelin restaurant.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve All",
          style: "default",
          onPress: async () => {
            setIsApproving(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              await batchConfirmMutation.mutateAsync(exactMatches);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Confirmed ${exactMatches.length.toLocaleString()} visit${exactMatches.length === 1 ? "" : "s"}.`,
              });
            } catch (error) {
              console.error("Error confirming visits:", error);
              showToast({ type: "error", message: "Failed to confirm visits. Please try again." });
            } finally {
              setIsApproving(false);
            }
          },
        },
      ],
    );
  }, [exactMatches, batchConfirmMutation, showToast]);

  // Render functions
  const renderReviewItem = useCallback(({ item }: { item: ReviewListItem; index: number }) => {
    if (item.type === "exact") {
      return (
        <AnimatedListItem itemKey={item.match.visitId}>
          <ReviewModeCard
            visit={item.match.visit}
            match={item.match}
            enableAppleMapsVerification={item.exactIndex < 3}
          />
        </AnimatedListItem>
      );
    }

    return (
      <AnimatedListItem itemKey={item.visit.id}>
        <ReviewModeCard visit={item.visit} enableAppleMapsVerification={item.manualIndex < 8} />
      </AnimatedListItem>
    );
  }, []);

  // List headers
  const ReviewListHeader = useCallback(
    () => (
      <View className={"gap-3"}>
        <View className={"gap-1"}>
          <ThemedText variant={"largeTitle"} className={"font-bold p-0 m-0"}>
            Review Visits
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"}>
            {hasExactMatches
              ? `${exactMatches.length.toLocaleString()} exact match${exactMatches.length === 1 ? "" : "es"} shown first${
                  filteredReviewableVisits.length > 0
                    ? `, ${filteredReviewableVisits.length.toLocaleString()} ${filteredReviewableVisits.length === 1 ? "visit needs" : "visits need"} manual review`
                    : ""
                }`
              : `${filteredReviewableVisits.length.toLocaleString()} ${
                  filteredReviewableVisits.length === 1 ? "visit needs" : "visits need"
                } manual review`}
          </ThemedText>
        </View>

        {exactMatches.length > 1 && (
          <Button
            variant={"success"}
            onPress={handleApproveAllExactMatches}
            loading={isApproving}
            disabled={isApproving}
            className={"w-full"}
          >
            <IconSymbol name={"checkmark.circle.fill"} size={18} color={"#fff"} />
            <ButtonText variant={"success"} className={"ml-2"}>
              Approve All Exact Matches ({exactMatches.length.toLocaleString()})
            </ButtonText>
          </Button>
        )}

        {/* Filters */}
        {reviewableVisits.length > 0 && (
          <Pressable
            className={"bg-card rounded-2xl border border-border px-3 py-2.5"}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setFiltersCollapsed(!filtersCollapsed);
            }}
          >
            <View className={"flex-row items-center justify-between gap-2"}>
              <View className={"flex-row items-center gap-2 flex-1"}>
                <IconSymbol name={"line.3.horizontal.decrease"} size={14} color={"#8E8E93"} />
                <ThemedText variant={"footnote"} color={"secondary"} numberOfLines={1} className={"flex-1"}>
                  Filters
                </ThemedText>
              </View>
              <IconSymbol name={filtersCollapsed ? "chevron.down" : "chevron.up"} size={14} color={"#8E8E93"} />
            </View>

            {!filtersCollapsed && (
              <Animated.View layout={LinearTransition.duration(200)} className={"gap-2.5 pt-2.5"}>
                <View className={"flex-row gap-2 flex-wrap"}>
                  <ToggleChip
                    label={"Food"}
                    value={foodFilter === "on"}
                    onToggle={() => setFoodFilter(foodFilter === "on" ? "off" : "on")}
                  />
                  <ToggleChip
                    label={"Restaurant Match"}
                    value={restaurantMatchesFilter === "on"}
                    onToggle={() => setRestaurantMatchesFilter(restaurantMatchesFilter === "on" ? "off" : "on")}
                  />
                </View>
              </Animated.View>
            )}
          </Pressable>
        )}
      </View>
    ),
    [
      filteredReviewableVisits.length,
      hasExactMatches,
      exactMatches.length,
      handleApproveAllExactMatches,
      isApproving,
      reviewableVisits.length,
      filtersCollapsed,
      setFiltersCollapsed,
      foodFilter,
      setFoodFilter,
      restaurantMatchesFilter,
      setRestaurantMatchesFilter,
      ToggleChip,
    ],
  );

  const listContentStyle = useMemo(
    () => ({
      paddingTop: 0,
      paddingBottom: insets.bottom + 32,
      paddingHorizontal: 16,
    }),
    [insets.bottom],
  );

  const refreshControl = useMemo(
    () => <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#8E8E93"} colors={["#8E8E93"]} />,
    [refreshing, onRefresh],
  );

  return (
    <ScreenLayout scrollable={false} className={"p-0"} style={{ paddingTop: 0, paddingBottom: 0 }}>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <FlashList
          ref={reviewListRef}
          data={mergedReviewItems}
          renderItem={renderReviewItem}
          keyExtractor={(item) => item.key}
          refreshControl={refreshControl}
          refreshing={refreshing}
          contentContainerStyle={listContentStyle}
          ListHeaderComponent={ReviewListHeader}
          ListHeaderComponentStyle={{ marginTop: 0, paddingTop: 0, marginBottom: 12 }}
          ListEmptyComponent={
            isLoading ? (
              <LoadingState />
            ) : isAllCaughtUp ? (
              <ReviewCaughtUpCard />
            ) : (
              <View className={"gap-3"}>
                <ThemedText variant={"title3"} className={"font-semibold"}>
                  No visits match these filters
                </ThemedText>
                <ThemedText variant={"body"} color={"secondary"}>
                  Try changing the filters above.
                </ThemedText>
                {shouldShowDeepScanEmptyCard && <DeepScanCard />}
              </View>
            )
          }
        />
      </View>
    </ScreenLayout>
  );
}

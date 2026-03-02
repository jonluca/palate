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
import { View, RefreshControl, Alert, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useToast } from "@/components/ui/toast";
import { router } from "expo-router";
import {
  useReviewFoodFilter,
  useSetReviewFoodFilter,
  useReviewCalendarMatchesFilter,
  useSetReviewCalendarMatchesFilter,
  useReviewRestaurantMatchesFilter,
  useSetReviewRestaurantMatchesFilter,
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

type ReviewQuickFilter = "all" | "food" | "matched" | "calendar";

function LoadingState() {
  return (
    <View className={"gap-4"}>
      {Array.from({ length: 3 }).map((_, i) => (
        <SkeletonVisitCard key={i} />
      ))}
    </View>
  );
}

function ReviewCompletionCard() {
  return (
    <Card>
      <View className={"p-5 gap-4"}>
        <View className={"flex-row items-center gap-3"}>
          <View
            className={"w-10 h-10 rounded-2xl bg-green-500/15 border border-green-500/20 items-center justify-center"}
          >
            <IconSymbol name={"checkmark.circle.fill"} size={20} color={"#22c55e"} />
          </View>
          <View className={"flex-1"}>
            <ThemedText className={"font-semibold"}>Review complete</ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              No more visits to review right now.
            </ThemedText>
          </View>
        </View>
        <Button onPress={() => router.push("/rescan")} size={"lg"}>
          <ButtonText>Scan for new photos</ButtonText>
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
  const calendarMatchesFilter = useReviewCalendarMatchesFilter();
  const setCalendarMatchesFilter = useSetReviewCalendarMatchesFilter();
  const restaurantMatchesFilter = useReviewRestaurantMatchesFilter();
  const setRestaurantMatchesFilter = useSetReviewRestaurantMatchesFilter();

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

  const activeFilterCount =
    Number(foodFilter === "on") + Number(restaurantMatchesFilter === "on") + Number(calendarMatchesFilter === "on");
  const activeQuickFilter: ReviewQuickFilter =
    activeFilterCount > 1
      ? "all"
      : calendarMatchesFilter === "on"
        ? "calendar"
        : restaurantMatchesFilter === "on"
          ? "matched"
          : foodFilter === "on"
            ? "food"
            : "all";
  const isFoodFilterActive = activeQuickFilter === "food";
  const isMatchFilterActive = activeQuickFilter === "matched";
  const isCalendarFilterActive = activeQuickFilter === "calendar";

  const setQuickFilter = useCallback(
    (next: ReviewQuickFilter) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setFoodFilter(next === "food" ? "on" : "off");
      setRestaurantMatchesFilter(next === "matched" ? "on" : "off");
      setCalendarMatchesFilter(next === "calendar" ? "on" : "off");
    },
    [setCalendarMatchesFilter, setFoodFilter, setRestaurantMatchesFilter],
  );

  const FilterPill = useCallback(
    ({ label, value }: { label: string; value: ReviewQuickFilter }) => (
      <Pressable
        onPress={() => setQuickFilter(value)}
        className={`h-9 px-3.5 rounded-full items-center justify-center border ${
          activeQuickFilter === value ? "bg-foreground border-foreground" : "bg-secondary/70 border-border"
        }`}
      >
        <ThemedText
          variant={"footnote"}
          className={`font-semibold ${activeQuickFilter === value ? "text-background" : "text-secondary-foreground"}`}
        >
          {label}
        </ThemedText>
      </Pressable>
    ),
    [activeQuickFilter, setQuickFilter],
  );

  const filterExactMatches = useCallback(
    (match: ExactCalendarMatch) => {
      if (isFoodFilterActive && !match.visit.foodProbable) {
        return false;
      }
      if (isMatchFilterActive && !match.restaurantId) {
        return false;
      }
      if (isCalendarFilterActive && !match.calendarTitle) {
        return false;
      }
      return true;
    },
    [isCalendarFilterActive, isFoodFilterActive, isMatchFilterActive],
  );

  const filteredExactMatches = useMemo(
    () => exactMatches.filter(filterExactMatches),
    [exactMatches, filterExactMatches],
  );

  const filteredReviewableVisits = useMemo(() => {
    const filtered = reviewableVisits.filter((v) => {
      if (isFoodFilterActive && !v.foodProbable) {
        return false;
      }

      const matchCount = v.suggestedRestaurants?.length ?? 0;
      const hasRestaurantMatches = matchCount > 0;
      if (isMatchFilterActive && !hasRestaurantMatches) {
        return false;
      }

      if (isCalendarFilterActive && !v.calendarEventTitle) {
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
  }, [reviewableVisits, isFoodFilterActive, isMatchFilterActive, isCalendarFilterActive]);

  const mergedReviewItems = useMemo<ReviewListItem[]>(
    () => [
      ...filteredExactMatches.map(
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
    [filteredExactMatches, filteredReviewableVisits],
  );

  // UI state
  const hasVisibleExactMatches = filteredExactMatches.length > 0;
  const isAllCaughtUp = !isLoading && pendingVisits.length === 0;
  const reviewSummary = isAllCaughtUp
    ? "No visits pending review"
    : `${pendingVisits.length.toLocaleString()} pending visit${pendingVisits.length === 1 ? "" : "s"}`;

  const shouldShowDeepScanEmptyCard =
    isFoodFilterActive && reviewableVisits.length > 0 && !reviewableVisits.some((visit) => visit.foodProbable);

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
    if (filteredExactMatches.length === 0) {
      return;
    }

    Alert.alert(
      "Approve All Exact Matches",
      `This will confirm ${filteredExactMatches.length.toLocaleString()} visit${filteredExactMatches.length === 1 ? "" : "s"} where the calendar event name exactly matches a Michelin restaurant.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve All",
          style: "default",
          onPress: async () => {
            setIsApproving(true);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              await batchConfirmMutation.mutateAsync(filteredExactMatches);
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Confirmed ${filteredExactMatches.length.toLocaleString()} visit${filteredExactMatches.length === 1 ? "" : "s"}.`,
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
  }, [filteredExactMatches, batchConfirmMutation, showToast]);

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
          <ThemedText variant={"largeTitle"} className={"font-bold"}>
            Review
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"}>
            {reviewSummary}
          </ThemedText>
        </View>

        {hasVisibleExactMatches ? (
          <Pressable
            onPress={handleApproveAllExactMatches}
            className={"rounded-2xl border border-green-500/20 bg-green-500/10 px-4 py-3"}
          >
            <View className={"flex-row items-center gap-3"}>
              <View
                className={
                  "w-10 h-10 rounded-2xl bg-green-500/15 border border-green-500/20 items-center justify-center"
                }
              >
                <IconSymbol name={"checkmark.circle.fill"} size={20} color={"#22c55e"} />
              </View>
              <View className={"flex-1"}>
                <ThemedText variant={"footnote"} className={"font-semibold"}>
                  {filteredExactMatches.length.toLocaleString()} exact calendar match
                  {filteredExactMatches.length === 1 ? "" : "es"}
                </ThemedText>
                <ThemedText variant={"caption1"} color={"secondary"}>
                  {isApproving ? "Approving..." : "Tap to bulk approve"}
                </ThemedText>
              </View>
            </View>
          </Pressable>
        ) : null}

        <Pressable
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.push("/quick-actions");
          }}
          className={"rounded-2xl border border-white/8 bg-card px-4 py-3"}
        >
          <View className={"flex-row items-center gap-3"}>
            <View className={"w-10 h-10 rounded-2xl bg-secondary items-center justify-center"}>
              <IconSymbol name={"bolt.fill"} size={18} color={"#F59E0B"} />
            </View>
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-semibold"}>
                Quick Actions
              </ThemedText>
              <ThemedText variant={"caption1"} color={"secondary"}>
                Bulk approve or skip visits
              </ThemedText>
            </View>
            <IconSymbol name={"chevron.right"} size={16} color={"#8E8E93"} />
          </View>
        </Pressable>

        {reviewableVisits.length > 0 || exactMatches.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className={"-mx-4"}
            contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
          >
            <View className={"flex-row gap-2"}>
              <FilterPill label={"All"} value={"all"} />
              <FilterPill label={"Has Food"} value={"food"} />
              <FilterPill label={"Has Match"} value={"matched"} />
              <FilterPill label={"Calendar"} value={"calendar"} />
            </View>
          </ScrollView>
        ) : null}

        {mergedReviewItems.length === 0 && !isAllCaughtUp ? (
          <Pressable
            onPress={() => setQuickFilter("all")}
            className={"self-start rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5"}
          >
            <ThemedText variant={"caption1"} className={"text-primary font-semibold"}>
              Clear filters
            </ThemedText>
          </Pressable>
        ) : null}
      </View>
    ),
    [
      mergedReviewItems.length,
      exactMatches.length,
      filteredExactMatches.length,
      hasVisibleExactMatches,
      reviewSummary,
      handleApproveAllExactMatches,
      isApproving,
      reviewableVisits.length,
      isAllCaughtUp,
      FilterPill,
      setQuickFilter,
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
              <ReviewCompletionCard />
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

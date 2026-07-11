import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { DeepScanCard } from "@/components/settings/deep-scan-card";
import { SkeletonVisitCard, Button, ButtonText, Card, useUndo } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import {
  createLoadedExactCalendarMatches,
  usePendingReviewPages,
  useBatchConfirmVisits,
  useUnanalyzedPhotoCount,
  type PendingVisitForReview,
  type ExactCalendarConfirmation,
  type ExactCalendarMatch,
} from "@/hooks/queries";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, RefreshControl, Alert, Pressable, ActivityIndicator } from "react-native";
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
import { refreshReviewQueries } from "@/utils/review-query-policy";
import {
  allowsAutomaticDeepScanFollowup,
  getResolvedVisitFoodDetectionStrategy,
  isVisionVisitFoodValidationModeEnabled,
} from "@/modules/batch-asset-info";

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

const reviewMaintainVisibleContentPosition = { disabled: true } as const;
const getReviewItemType = (item: ReviewListItem) => item.type;

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

async function approveAllExactMatches({
  exactMatches,
  batchConfirm,
  setIsApproving,
  showToast,
}: {
  exactMatches: readonly ExactCalendarConfirmation[];
  batchConfirm: (matches: ExactCalendarConfirmation[]) => Promise<unknown>;
  setIsApproving: React.Dispatch<React.SetStateAction<boolean>>;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  setIsApproving(true);
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

  try {
    await batchConfirm([...exactMatches]);
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

  // FlashList ref coordinates post-exact-match and undo scrolling.
  const reviewListRef = useRef<FlashListRef<ReviewListItem>>(null);

  // Data queries
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = usePendingReviewPages({
    food: foodFilter,
    restaurantMatches: restaurantMatchesFilter,
  });
  const { data: unanalyzedPhotoCount } = useUnanalyzedPhotoCount();
  const manifest = data?.pages[0]?.manifest ?? null;
  const pendingVisits = useMemo(() => data?.pages.flatMap((page) => page.visits) ?? [], [data?.pages]);
  const exactConfirmations = useMemo(() => manifest?.exactConfirmations ?? [], [manifest?.exactConfirmations]);
  const exactMatches = useMemo(
    () => createLoadedExactCalendarMatches(pendingVisits, exactConfirmations),
    [pendingVisits, exactConfirmations],
  );

  // Mutations
  const batchConfirmMutation = useBatchConfirmVisits();

  // Computed data
  const exactMatchVisitIds = useMemo(
    () => new Set(exactConfirmations.map((confirmation) => confirmation.visitId)),
    [exactConfirmations],
  );

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
      ...reviewableVisits.map(
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
    [exactMatches, reviewableVisits],
  );

  // UI state
  const exactMatchCount = manifest?.summary.exactMatchCount ?? 0;
  const filteredManualCount = manifest?.summary.filteredManualCount ?? 0;
  const hasExactMatches = exactMatchCount > 0;
  const isAllCaughtUp = !isLoading && manifest !== null && manifest.summary.totalPending === 0;
  const reviewSummary = useMemo(() => {
    if (isAllCaughtUp) {
      return "No visits pending review";
    }

    if (hasExactMatches) {
      return `${exactMatchCount.toLocaleString()} exact match${exactMatchCount === 1 ? "" : "es"} shown first${
        filteredManualCount > 0
          ? `, ${filteredManualCount.toLocaleString()} ${filteredManualCount === 1 ? "visit needs" : "visits need"} manual review`
          : ""
      }`;
    }

    return `${filteredManualCount.toLocaleString()} ${
      filteredManualCount === 1 ? "visit needs" : "visits need"
    } manual review`;
  }, [isAllCaughtUp, hasExactMatches, exactMatchCount, filteredManualCount]);

  const shouldAutoDeepScan =
    allowsAutomaticDeepScanFollowup(
      getResolvedVisitFoodDetectionStrategy(),
      isVisionVisitFoodValidationModeEnabled(),
    ) &&
    !isLoading &&
    (unanalyzedPhotoCount ?? 0) > 0 &&
    (isAllCaughtUp ||
      (foodFilter === "on" &&
        (manifest?.summary.reviewableCount ?? 0) > 0 &&
        manifest?.summary.reviewableFoodCount === 0));

  const previousExactMatchCountRef = useRef(0);

  useEffect(() => {
    const previousExactMatchCount = previousExactMatchCountRef.current;
    previousExactMatchCountRef.current = exactMatchCount;

    if (previousExactMatchCount > 0 && exactMatchCount === 0) {
      const frame = requestAnimationFrame(() => {
        reviewListRef.current?.scrollToTop({ animated: true });
      });

      return () => cancelAnimationFrame(frame);
    }
  }, [exactMatchCount]);

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
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    return refreshReviewQueries(queryClient).finally(() => {
      setRefreshing(false);
    });
  }, [queryClient]);

  const handleApproveAllExactMatches = useCallback(() => {
    if (exactConfirmations.length === 0) {
      return;
    }

    Alert.alert(
      "Approve All Exact Matches",
      `This will confirm ${exactConfirmations.length.toLocaleString()} visit${exactConfirmations.length === 1 ? "" : "s"} where the calendar event name matches a Michelin restaurant.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve All",
          style: "default",
          onPress: async () => {
            await approveAllExactMatches({
              exactMatches: exactConfirmations,
              batchConfirm: batchConfirmMutation.mutateAsync,
              setIsApproving,
              showToast,
            });
          },
        },
      ],
    );
  }, [exactConfirmations, batchConfirmMutation, showToast]);

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  // Render functions
  const renderReviewItem = useCallback(({ item }: { item: ReviewListItem; index: number }) => {
    if (item.type === "exact") {
      return (
        <ReviewModeCard visit={item.match.visit} match={item.match} enableAppleMapsVerification={item.exactIndex < 3} />
      );
    }

    return <ReviewModeCard visit={item.visit} enableAppleMapsVerification={item.manualIndex < 8} />;
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
            {reviewSummary}
          </ThemedText>
        </View>

        {exactMatchCount > 1 && (
          <Button
            variant={"success"}
            onPress={handleApproveAllExactMatches}
            loading={isApproving}
            disabled={isApproving}
            className={"w-full"}
          >
            <IconSymbol name={"checkmark.circle.fill"} size={18} color={"#fff"} />
            <ButtonText variant={"success"} className={"ml-2"}>
              Approve All Exact Matches ({exactMatchCount.toLocaleString()})
            </ButtonText>
          </Button>
        )}

        {/* Filters */}
        {(manifest?.summary.reviewableCount ?? 0) > 0 && (
          <Pressable
            className={"bg-card rounded-2xl px-3 py-2.5"}
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
      exactMatchCount,
      reviewSummary,
      handleApproveAllExactMatches,
      isApproving,
      manifest?.summary.reviewableCount,
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

  const reviewListKey = `${foodFilter}-${restaurantMatchesFilter}`;

  return (
    <ScreenLayout scrollable={false} className={"p-0"} style={{ paddingTop: 0, paddingBottom: 0 }}>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* FlashList must own these absolute-positioned cells; animating them leaves gaps while they are recycled. */}
        <FlashList
          key={reviewListKey}
          ref={reviewListRef}
          data={mergedReviewItems}
          renderItem={renderReviewItem}
          keyExtractor={(item) => item.key}
          getItemType={getReviewItemType}
          maintainVisibleContentPosition={reviewMaintainVisibleContentPosition}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.6}
          refreshControl={refreshControl}
          refreshing={refreshing}
          contentContainerStyle={listContentStyle}
          ListHeaderComponent={ReviewListHeader}
          ListHeaderComponentStyle={{ marginTop: 0, paddingTop: 0, marginBottom: 12 }}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className={"items-center py-6"}>
                <ActivityIndicator color={"#8E8E93"} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            isLoading ? (
              <LoadingState />
            ) : shouldAutoDeepScan ? (
              <DeepScanCard autoStart={true} />
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
              </View>
            )
          }
        />
      </View>
    </ScreenLayout>
  );
}

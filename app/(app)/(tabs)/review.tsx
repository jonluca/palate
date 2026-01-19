import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { AnimatedListItem, ReviewVisitCard, TabButton, type ReviewTab } from "@/components/review";
import { AllCaughtUpEmpty, SkeletonVisitCard, Button, ButtonText, Card, useUndo } from "@/components/ui";
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
  useReviewMatchesFilter,
  useSetReviewMatchesFilter,
  useReviewFiltersCollapsed,
  useSetReviewFiltersCollapsed,
} from "@/store";

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
          <View className={"w-10 h-10 rounded-2xl bg-green-500/20 items-center justify-center"}>
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

function NoManualReviewLeftCard({ onGoToExact }: { onGoToExact: () => void }) {
  return (
    <Card className={"border border-border bg-card"}>
      <View className={"p-5 gap-3"}>
        <View className={"flex-row items-center gap-3"}>
          <View className={"w-10 h-10 rounded-2xl bg-primary/10 items-center justify-center"}>
            <IconSymbol name={"sparkles"} size={18} color={"#999"} />
          </View>
          <View className={"flex-1"}>
            <ThemedText className={"font-semibold"}>Nothing to manually review</ThemedText>
            <ThemedText variant={"footnote"} color={"secondary"}>
              You only have Exact Matches left.
            </ThemedText>
          </View>
        </View>
        <Button onPress={onGoToExact}>
          <ButtonText>Go to Exact Matches</ButtonText>
        </Button>
      </View>
    </Card>
  );
}

export default function ReviewScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [activeTab, setActiveTab] = useState<ReviewTab>("all");

  // Review filters from store
  const foodFilter = useReviewFoodFilter();
  const setFoodFilter = useSetReviewFoodFilter();
  const matchesFilter = useReviewMatchesFilter();
  const setMatchesFilter = useSetReviewMatchesFilter();
  const filtersCollapsed = useReviewFiltersCollapsed();
  const setFiltersCollapsed = useSetReviewFiltersCollapsed();

  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { setOnUndoComplete } = useUndo();

  // FlashList refs for scrolling back after undo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const regularListRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exactMatchListRef = useRef<any>(null);
  const hasSetInitialTab = useRef(false);

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
          className={`px-3 py-1.5 rounded-full ${value ? "bg-primary" : "bg-secondary/30"}`}
        >
          <ThemedText
            variant={"footnote"}
            className={`font-medium ${value ? "text-primary-foreground" : "text-foreground"}`}
          >
            {label}
          </ThemedText>
        </Pressable>
      );
    },
    [],
  );

  const filteredReviewableVisits = useMemo(() => {
    return reviewableVisits.filter((v) => {
      // Food toggle: ON => must have food, OFF => must not have food (covers 0/false/null/undefined)
      if (foodFilter === "on" && !v.foodProbable) {
        return false;
      }
      if (foodFilter === "off" && !!v.foodProbable) {
        return false;
      }

      // Matches toggle: ON => must have matches, OFF => must have no matches.
      // Treat "no matches" as both [] and missing/null (defensive).
      const matchCount = v.suggestedRestaurants?.length ?? 0;
      const hasMatches = matchCount > 0;
      if (matchesFilter === "on" && !hasMatches) {
        return false;
      }
      if (matchesFilter === "off" && hasMatches) {
        return false;
      }

      return true;
    });
  }, [reviewableVisits, foodFilter, matchesFilter]);

  // UI state
  const hasExactMatches = exactMatches.length > 0;
  const hasTabs = hasExactMatches;
  const isAllCaughtUp = !isLoading && pendingVisits.length === 0;

  // Set initial tab to "exact" if there are exact matches on first load
  useEffect(() => {
    if (!isLoading && !hasSetInitialTab.current && hasExactMatches) {
      hasSetInitialTab.current = true;
      setActiveTab("exact");
    }
  }, [isLoading, hasExactMatches]);

  // Switch back to "all" tab if current tab becomes empty
  useEffect(() => {
    if (activeTab === "exact" && !hasExactMatches) {
      setActiveTab("all");
    }
  }, [activeTab, hasExactMatches]);

  // Register undo complete callback to scroll back to restored item
  useEffect(() => {
    setOnUndoComplete((visitId: string) => {
      // Wait a bit for the query to refetch and the item to appear in the list
      setTimeout(() => {
        // Try to find the item in the current list and scroll to it
        if (activeTab === "all") {
          const index = filteredReviewableVisits.findIndex((v) => v.id === visitId);
          if (index !== -1) {
            regularListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
          }
        } else if (activeTab === "exact") {
          const index = exactMatches.findIndex((m) => m.visitId === visitId);
          if (index !== -1) {
            exactMatchListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
          }
        }
      }, 300); // Small delay for data to refetch
    });

    return () => setOnUndoComplete(null);
  }, [setOnUndoComplete, activeTab, filteredReviewableVisits, exactMatches]);

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
              if (exactMatches.length === exactMatches.length) {
                setActiveTab("all");
              }
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
  const renderRegularItem = useCallback(
    ({ item, index }: { item: PendingVisitForReview; index: number }) => (
      <AnimatedListItem itemKey={item.id}>
        <ReviewVisitCard visit={item} index={index < 10 ? index : 0} enableAppleMapsVerification={index < 8} />
      </AnimatedListItem>
    ),
    [],
  );

  const renderExactMatchItem = useCallback(
    ({ item, index }: { item: ExactCalendarMatch; index: number }) => (
      <AnimatedListItem itemKey={item.visitId}>
        <ReviewVisitCard
          visit={item.visit}
          match={item}
          index={index < 10 ? index : 0}
          enableAppleMapsVerification={index < 3}
        />
      </AnimatedListItem>
    ),
    [],
  );

  // List headers
  const RegularListHeader = useCallback(
    () => (
      <View className={"gap-1"}>
        <ThemedText variant={"largeTitle"} className={"font-bold p-0 m-0"}>
          Review Visits
        </ThemedText>
        <ThemedText variant={"footnote"} color={"secondary"}>
          {filteredReviewableVisits.length.toLocaleString()}{" "}
          {filteredReviewableVisits.length === 1 ? "visit needs" : "visits need"} manual review
        </ThemedText>

        {/* Filters */}
        {reviewableVisits.length > 0 && (
          <Pressable
            className={`bg-card rounded-xl px-3 py-2`}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setFiltersCollapsed(!filtersCollapsed);
            }}
          >
            <View className={"flex-row items-center justify-between gap-2"}>
              <View className={"flex-row items-center gap-2 flex-1"}>
                <IconSymbol name={"line.3.horizontal.decrease"} size={14} color={"#999"} />
                <ThemedText variant={"footnote"} color={"secondary"} numberOfLines={1} className={"flex-1"}>
                  Filters
                </ThemedText>
              </View>
              <IconSymbol name={filtersCollapsed ? "chevron.down" : "chevron.up"} size={14} color={"#999"} />
            </View>

            {!filtersCollapsed && (
              <Animated.View layout={LinearTransition.duration(200)} className={"gap-2.5 pt-2.5"}>
                <View className={"flex-row gap-2 flex-wrap"}>
                  <ToggleChip
                    label={"Has Food"}
                    value={foodFilter === "on"}
                    onToggle={() => setFoodFilter(foodFilter === "on" ? "off" : "on")}
                  />
                  <ToggleChip
                    label={"Has Restaurant Matches"}
                    value={matchesFilter === "on"}
                    onToggle={() => setMatchesFilter(matchesFilter === "on" ? "off" : "on")}
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
      reviewableVisits.length,
      filtersCollapsed,
      setFiltersCollapsed,
      foodFilter,
      setFoodFilter,
      matchesFilter,
      setMatchesFilter,
      ToggleChip,
    ],
  );

  const ExactMatchListHeader = useCallback(
    () => (
      <View className={"gap-4"}>
        <View className={"gap-2"}>
          <ThemedText variant={"largeTitle"} className={"font-bold"}>
            Exact Matches
          </ThemedText>
          <ThemedText variant={"body"} color={"secondary"}>
            {exactMatches.length.toLocaleString()} calendar event{exactMatches.length === 1 ? "" : "s"} match restaurant
            names
          </ThemedText>
        </View>
        <Button
          variant={"success"}
          onPress={handleApproveAllExactMatches}
          loading={isApproving}
          disabled={isApproving}
          className={"w-full"}
        >
          <IconSymbol name={"checkmark.circle.fill"} size={18} color={"#fff"} />
          <ButtonText variant={"success"} className={"ml-2"}>
            Approve All ({exactMatches.length.toLocaleString()})
          </ButtonText>
        </Button>
      </View>
    ),
    [exactMatches.length, handleApproveAllExactMatches, isApproving],
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
    () => <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#999"} colors={["#999"]} />,
    [refreshing, onRefresh],
  );

  return (
    <ScreenLayout scrollable={false} className={"p-0"} style={{ paddingTop: 0, paddingBottom: 0 }}>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Tab Bar */}
        {hasTabs && (
          <View className={"px-4 pt-4 pb-2"}>
            <View className={"flex-row gap-2 bg-background/50 p-1 rounded-2xl"}>
              <TabButton
                label={"All"}
                count={filteredReviewableVisits.length}
                isSelected={activeTab === "all"}
                onPress={() => setActiveTab("all")}
              />
              {hasExactMatches && (
                <TabButton
                  label={"Exact"}
                  count={exactMatches.length}
                  isSelected={activeTab === "exact"}
                  onPress={() => setActiveTab("exact")}
                />
              )}
            </View>
          </View>
        )}

        {/* Tab Content */}
        {activeTab === "all" && (
          <FlashList
            ref={regularListRef}
            data={filteredReviewableVisits}
            renderItem={renderRegularItem}
            keyExtractor={(item) => item.id}
            refreshControl={refreshControl}
            refreshing={refreshing}
            contentContainerStyle={listContentStyle}
            ListHeaderComponent={RegularListHeader}
            ListHeaderComponentStyle={{ marginTop: 0, paddingTop: 0, marginBottom: 12 }}
            ListEmptyComponent={
              isLoading ? (
                <LoadingState />
              ) : isAllCaughtUp ? (
                <ReviewCaughtUpCard />
              ) : reviewableVisits.length === 0 && hasExactMatches ? (
                <NoManualReviewLeftCard onGoToExact={() => setActiveTab("exact")} />
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
        )}

        {activeTab === "exact" && hasExactMatches && (
          <FlashList
            ref={exactMatchListRef}
            data={exactMatches}
            renderItem={renderExactMatchItem}
            keyExtractor={(item) => item.visitId}
            refreshing={refreshing}
            refreshControl={refreshControl}
            contentContainerStyle={listContentStyle}
            ListHeaderComponent={ExactMatchListHeader}
            ListHeaderComponentStyle={{ marginBottom: 24 }}
            ListEmptyComponent={isLoading ? <LoadingState /> : <AllCaughtUpEmpty />}
          />
        )}
      </View>
    </ScreenLayout>
  );
}

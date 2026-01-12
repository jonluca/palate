import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { AnimatedListItem, ReviewVisitCard, TabButton, type ReviewTab } from "@/components/review";
import { AllCaughtUpEmpty, SkeletonVisitCard, Button, ButtonText, Card, FilterPills } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import {
  usePendingReview,
  useBatchConfirmVisits,
  type PendingVisitForReview,
  type ExactCalendarMatch,
} from "@/hooks/queries";
import { FlashList } from "@shopify/flash-list";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, RefreshControl, Alert, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useToast } from "@/components/ui/toast";
import Animated, { LinearTransition } from "react-native-reanimated";
import { router } from "expo-router";

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

  type FoodFilter = "on" | "off";
  type MatchesFilter = "on" | "off";
  type StarFilter = "any" | "2plus" | "3";

  const [filtersCollapsed, setFiltersCollapsed] = useState(true);
  const [foodFilter, setFoodFilter] = useState<FoodFilter>("on");
  const [matchesFilter, setMatchesFilter] = useState<MatchesFilter>("on");
  const [starFilter, setStarFilter] = useState<StarFilter>("any");

  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

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
          className={`px-4 py-2 rounded-full ${value ? "bg-primary" : "bg-card"}`}
        >
          <View className={"flex-row items-center gap-2"}>
            <ThemedText className={`text-sm font-medium ${value ? "text-primary-foreground" : "text-foreground"}`}>
              {label}
            </ThemedText>
          </View>
        </Pressable>
      );
    },
    [],
  );

  function parseMichelinStars(award: string | null | undefined): number {
    if (!award) {
      return 0;
    }
    const s = award.toLowerCase();
    const digitMatch = s.match(/(\d)\s*star/);
    if (digitMatch) {
      return Number(digitMatch[1]) || 0;
    }
    if (s.includes("three star")) {
      return 3;
    }
    if (s.includes("two star")) {
      return 2;
    }
    if (s.includes("one star")) {
      return 1;
    }
    return 0;
  }

  const visitMaxStars = useCallback((visit: PendingVisitForReview) => {
    let max = 0;
    for (const r of visit.suggestedRestaurants) {
      max = Math.max(max, parseMichelinStars(r.award));
      if (max >= 3) {
        return 3;
      }
    }
    return max;
  }, []);

  const filtersSummary = useMemo(() => {
    const parts: string[] = [];

    parts.push(foodFilter === "on" ? "Food" : "No Food");
    parts.push(matchesFilter === "on" ? "Matches" : "No Matches");

    if (starFilter === "2plus") {
      parts.push("2★+");
    } else if (starFilter === "3") {
      parts.push("3★");
    }

    return parts.join(" · ");
  }, [foodFilter, matchesFilter, starFilter]);

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

      const maxStars = visitMaxStars(v);
      if (starFilter === "2plus" && maxStars < 2) {
        return false;
      }
      if (starFilter === "3" && maxStars < 3) {
        return false;
      }

      return true;
    });
  }, [reviewableVisits, foodFilter, matchesFilter, starFilter, visitMaxStars]);

  // UI state
  const hasExactMatches = exactMatches.length > 0;
  const hasTabs = hasExactMatches;
  const isAllCaughtUp = !isLoading && pendingVisits.length === 0;

  // Switch back to "all" tab if current tab becomes empty
  useEffect(() => {
    if (activeTab === "exact" && !hasExactMatches) {
      setActiveTab("all");
    }
  }, [activeTab, hasExactMatches]);

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
      <View className={"gap-2"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Review Visits
        </ThemedText>
        <ThemedText variant={"body"} color={"secondary"}>
          {filteredReviewableVisits.length.toLocaleString()}{" "}
          {filteredReviewableVisits.length === 1 ? "visit needs" : "visits need"} manual review
        </ThemedText>

        {/* Filters */}
        {reviewableVisits.length > 0 && (
          <View className={"pt-2"}>
            <Pressable
              className={"bg-card rounded-2xl px-4 py-3"}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setFiltersCollapsed((v) => !v);
              }}
            >
              <View className={"flex-row items-center justify-between gap-3"}>
                <View className={"flex-1 gap-1"}>
                  <ThemedText className={"font-semibold"}>Filters</ThemedText>
                  <ThemedText variant={"footnote"} color={"tertiary"} numberOfLines={2}>
                    {filtersSummary}
                  </ThemedText>
                </View>
                <IconSymbol name={filtersCollapsed ? "chevron.down" : "chevron.up"} size={18} color={"#999"} />
              </View>
            </Pressable>

            {!filtersCollapsed && (
              <Animated.View layout={LinearTransition.duration(200)} className={"gap-3 pt-3"}>
                <View className={"flex-row gap-2 flex-wrap"}>
                  <ToggleChip
                    label={"Food"}
                    value={foodFilter === "on"}
                    onToggle={() => setFoodFilter((v) => (v === "on" ? "off" : "on"))}
                  />
                  <ToggleChip
                    label={"Matches"}
                    value={matchesFilter === "on"}
                    onToggle={() => setMatchesFilter((v) => (v === "on" ? "off" : "on"))}
                  />
                </View>

                <FilterPills
                  options={[
                    { value: "any" as const, label: "Stars: Any" },
                    { value: "2plus" as const, label: "2★+" },
                    { value: "3" as const, label: "3★" },
                  ]}
                  value={starFilter}
                  onChange={setStarFilter}
                />
              </Animated.View>
            )}
          </View>
        )}
      </View>
    ),
    [
      filteredReviewableVisits.length,
      reviewableVisits.length,
      filtersCollapsed,
      foodFilter,
      matchesFilter,
      starFilter,
      filtersSummary,
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
      paddingTop: 16,
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
            data={filteredReviewableVisits}
            renderItem={renderRegularItem}
            keyExtractor={(item) => item.id}
            refreshControl={refreshControl}
            refreshing={refreshing}
            contentContainerStyle={listContentStyle}
            ListHeaderComponent={RegularListHeader}
            ListHeaderComponentStyle={{ marginBottom: 24 }}
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
                  <Button
                    variant={"outline"}
                    onPress={() => {
                      setFoodFilter("on");
                      setMatchesFilter("on");
                      setStarFilter("any");
                    }}
                  >
                    <ButtonText variant={"outline"}>Reset to Has Food</ButtonText>
                  </Button>
                </View>
              )
            }
          />
        )}

        {activeTab === "exact" && hasExactMatches && (
          <FlashList
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

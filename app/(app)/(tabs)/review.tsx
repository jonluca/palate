import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { AnimatedListItem, ReviewVisitCard, TabButton, type ReviewTab } from "@/components/review";
import { AllCaughtUpEmpty, SkeletonVisitCard, Button, ButtonText, FilterPills } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import {
  usePendingReview,
  useBatchConfirmVisits,
  type PendingVisitForReview,
  type ExactCalendarMatch,
} from "@/hooks/queries";
import { FlashList } from "@shopify/flash-list";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, RefreshControl, Alert, Modal, Pressable, ScrollView, TextInput, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useToast } from "@/components/ui/toast";
import Animated, { LinearTransition } from "react-native-reanimated";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";

function LoadingState() {
  return (
    <View className={"gap-4"}>
      {Array.from({ length: 3 }).map((_, i) => (
        <SkeletonVisitCard key={i} />
      ))}
    </View>
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
  const [selectedRestaurantId, setSelectedRestaurantId] = useState<string | null>(null);
  const [startDateMs, setStartDateMs] = useState<number | null>(null);
  const [endDateMs, setEndDateMs] = useState<number | null>(null);

  const [restaurantModalVisible, setRestaurantModalVisible] = useState(false);
  const [restaurantSearchQuery, setRestaurantSearchQuery] = useState("");
  const [dateModalVisible, setDateModalVisible] = useState(false);
  const [androidActiveDateField, setAndroidActiveDateField] = useState<"start" | "end" | null>(null);

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

  const formatShortDate = useCallback((ms: number) => {
    try {
      return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return "";
    }
  }, []);

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

  const uniqueSuggestedRestaurants = useMemo(() => {
    const map = new Map<string, { id: string; name: string; award: string | null }>();
    for (const v of reviewableVisits) {
      for (const r of v.suggestedRestaurants) {
        if (!map.has(r.id)) {
          map.set(r.id, { id: r.id, name: r.name, award: r.award ?? null });
        }
      }
    }
    const list = Array.from(map.values());
    list.sort((a, b) => {
      const starDiff = parseMichelinStars(b.award) - parseMichelinStars(a.award);
      if (starDiff !== 0) {
        return starDiff;
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [reviewableVisits]);

  const selectedRestaurant = useMemo(() => {
    if (!selectedRestaurantId) {
      return null;
    }
    return uniqueSuggestedRestaurants.find((r) => r.id === selectedRestaurantId) ?? null;
  }, [selectedRestaurantId, uniqueSuggestedRestaurants]);

  const filtersSummary = useMemo(() => {
    const parts: string[] = [];

    parts.push(foodFilter === "on" ? "Food" : "No Food");
    parts.push(matchesFilter === "on" ? "Matches" : "No Matches");

    if (starFilter === "2plus") {
      parts.push("2★+");
    } else if (starFilter === "3") {
      parts.push("3★");
    }

    if (startDateMs || endDateMs) {
      parts.push(`${startDateMs ? formatShortDate(startDateMs) : "…"}–${endDateMs ? formatShortDate(endDateMs) : "…"}`);
    }

    if (selectedRestaurant) {
      parts.push(selectedRestaurant.name);
    }

    return parts.join(" · ");
  }, [foodFilter, matchesFilter, starFilter, startDateMs, endDateMs, selectedRestaurant, formatShortDate]);

  const toStartOfDayMs = useCallback(
    (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime(),
    [],
  );
  const toEndOfDayMs = useCallback(
    (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime(),
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

      const maxStars = visitMaxStars(v);
      if (starFilter === "2plus" && maxStars < 2) {
        return false;
      }
      if (starFilter === "3" && maxStars < 3) {
        return false;
      }

      if (selectedRestaurantId && !v.suggestedRestaurants.some((r) => r.id === selectedRestaurantId)) {
        return false;
      }

      if (startDateMs !== null && v.startTime < startDateMs) {
        return false;
      }
      if (endDateMs !== null && v.startTime > endDateMs) {
        return false;
      }

      return true;
    });
  }, [
    reviewableVisits,
    foodFilter,
    matchesFilter,
    starFilter,
    selectedRestaurantId,
    startDateMs,
    endDateMs,
    visitMaxStars,
  ]);

  // UI state
  const hasExactMatches = exactMatches.length > 0;
  const hasTabs = hasExactMatches;
  const isEmpty = pendingVisits.length === 0;

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

                <View className={"flex-row gap-2"}>
                  <Button variant={"muted"} size={"sm"} className={"flex-1"} onPress={() => setDateModalVisible(true)}>
                    <ButtonText variant={"muted"} size={"sm"}>
                      {startDateMs || endDateMs
                        ? `Date: ${startDateMs ? formatShortDate(startDateMs) : "…"}–${endDateMs ? formatShortDate(endDateMs) : "…"}`
                        : "Date: Any"}
                    </ButtonText>
                  </Button>
                  <Button
                    variant={"muted"}
                    size={"sm"}
                    className={"flex-1"}
                    onPress={() => setRestaurantModalVisible(true)}
                  >
                    <ButtonText variant={"muted"} size={"sm"}>
                      {selectedRestaurant ? `Restaurant: ${selectedRestaurant.name}` : "Restaurant: Any"}
                    </ButtonText>
                  </Button>
                </View>

                {(selectedRestaurantId || startDateMs !== null || endDateMs !== null) && (
                  <View className={"flex-row gap-2"}>
                    <Button
                      variant={"outline"}
                      size={"sm"}
                      className={"flex-1"}
                      onPress={() => {
                        setSelectedRestaurantId(null);
                        setRestaurantSearchQuery("");
                        setStartDateMs(null);
                        setEndDateMs(null);
                      }}
                    >
                      <ButtonText variant={"outline"} size={"sm"}>
                        Clear Filters
                      </ButtonText>
                    </Button>
                  </View>
                )}
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
      selectedRestaurant,
      selectedRestaurantId,
      startDateMs,
      endDateMs,
      formatShortDate,
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
              ) : isEmpty || reviewableVisits.length === 0 ? (
                <AllCaughtUpEmpty />
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
                      setSelectedRestaurantId(null);
                      setRestaurantSearchQuery("");
                      setStartDateMs(null);
                      setEndDateMs(null);
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

        {/* Restaurant Filter Modal */}
        <Modal visible={restaurantModalVisible} animationType={"slide"} presentationStyle={"pageSheet"}>
          <View className={"flex-1 bg-background"}>
            <View className={"px-4 pt-4 pb-3 border-b border-border gap-3"}>
              <View className={"flex-row items-center justify-between"}>
                <ThemedText variant={"heading"} className={"font-semibold"}>
                  Filter by Restaurant
                </ThemedText>
                <Pressable
                  onPress={() => {
                    setRestaurantModalVisible(false);
                    setRestaurantSearchQuery("");
                  }}
                >
                  <ThemedText className={"text-primary font-semibold"}>Done</ThemedText>
                </Pressable>
              </View>

              <TextInput
                value={restaurantSearchQuery}
                onChangeText={setRestaurantSearchQuery}
                placeholder={"Search restaurants…"}
                placeholderTextColor={"#999"}
                className={"bg-card rounded-2xl px-4 py-3 text-foreground"}
                autoCapitalize={"none"}
                autoCorrect={false}
              />

              <View className={"flex-row gap-2"}>
                <Button
                  variant={"outline"}
                  size={"sm"}
                  className={"flex-1"}
                  onPress={() => {
                    setSelectedRestaurantId(null);
                    setRestaurantModalVisible(false);
                    setRestaurantSearchQuery("");
                  }}
                >
                  <ButtonText variant={"outline"} size={"sm"}>
                    Clear Restaurant
                  </ButtonText>
                </Button>
              </View>
            </View>

            <ScrollView className={"flex-1"}>
              <View className={"p-4 gap-2"}>
                {uniqueSuggestedRestaurants
                  .filter((r) => {
                    const q = restaurantSearchQuery.trim().toLowerCase();
                    if (!q) {
                      return true;
                    }
                    return r.name.toLowerCase().includes(q) || (r.award ?? "").toLowerCase().includes(q);
                  })
                  .slice(0, 250)
                  .map((r) => {
                    const isSelected = selectedRestaurantId === r.id;
                    return (
                      <Pressable
                        key={r.id}
                        onPress={() => {
                          setSelectedRestaurantId(r.id);
                          setRestaurantModalVisible(false);
                          setRestaurantSearchQuery("");
                        }}
                        className={"bg-card rounded-2xl px-4 py-3"}
                      >
                        <View className={"flex-row items-center justify-between gap-3"}>
                          <View className={"flex-1"}>
                            <ThemedText className={"font-semibold"} numberOfLines={1}>
                              {r.name}
                            </ThemedText>
                            {!!r.award && (
                              <ThemedText variant={"footnote"} color={"secondary"} numberOfLines={1}>
                                {r.award}
                              </ThemedText>
                            )}
                          </View>
                          {isSelected && <IconSymbol name={"checkmark"} size={18} color={"#22c55e"} />}
                        </View>
                      </Pressable>
                    );
                  })}
              </View>
            </ScrollView>
          </View>
        </Modal>

        {/* Date Range Modal */}
        <Modal visible={dateModalVisible} animationType={"slide"} presentationStyle={"pageSheet"}>
          <View className={"flex-1 bg-background"}>
            <View className={"px-4 pt-4 pb-3 border-b border-border gap-3"}>
              <View className={"flex-row items-center justify-between"}>
                <ThemedText variant={"heading"} className={"font-semibold"}>
                  Filter by Date
                </ThemedText>
                <Pressable
                  onPress={() => {
                    setDateModalVisible(false);
                    setAndroidActiveDateField(null);
                  }}
                >
                  <ThemedText className={"text-primary font-semibold"}>Done</ThemedText>
                </Pressable>
              </View>

              {Platform.OS === "ios" ? (
                <View className={"gap-4"}>
                  <View className={"gap-2"}>
                    <View className={"flex-row items-center justify-between"}>
                      <ThemedText className={"font-semibold"}>Start date</ThemedText>
                      <Pressable
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setStartDateMs(null);
                        }}
                      >
                        <ThemedText className={"text-primary font-semibold"}>Clear</ThemedText>
                      </Pressable>
                    </View>
                    <DateTimePicker
                      value={startDateMs ? new Date(startDateMs) : new Date()}
                      mode={"date"}
                      display={"inline"}
                      onChange={(_event: DateTimePickerEvent, date?: Date) => {
                        if (!date) {
                          return;
                        }
                        const nextStart = toStartOfDayMs(date);
                        setStartDateMs(nextStart);
                        if (endDateMs !== null && endDateMs < nextStart) {
                          setEndDateMs(toEndOfDayMs(date));
                        }
                      }}
                    />
                  </View>

                  <View className={"gap-2"}>
                    <View className={"flex-row items-center justify-between"}>
                      <ThemedText className={"font-semibold"}>End date</ThemedText>
                      <Pressable
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setEndDateMs(null);
                        }}
                      >
                        <ThemedText className={"text-primary font-semibold"}>Clear</ThemedText>
                      </Pressable>
                    </View>
                    <DateTimePicker
                      value={endDateMs ? new Date(endDateMs) : new Date()}
                      mode={"date"}
                      display={"inline"}
                      onChange={(_event: DateTimePickerEvent, date?: Date) => {
                        if (!date) {
                          return;
                        }
                        const nextEnd = toEndOfDayMs(date);
                        setEndDateMs(nextEnd);
                        if (startDateMs !== null && nextEnd < startDateMs) {
                          setStartDateMs(toStartOfDayMs(date));
                        }
                      }}
                    />
                  </View>
                </View>
              ) : (
                <View className={"gap-3"}>
                  <Pressable
                    className={"bg-card rounded-2xl px-4 py-3"}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setAndroidActiveDateField("start");
                    }}
                  >
                    <View className={"flex-row items-center justify-between gap-3"}>
                      <ThemedText className={"font-semibold"}>Start</ThemedText>
                      <ThemedText variant={"footnote"} color={"tertiary"}>
                        {startDateMs ? formatShortDate(startDateMs) : "Any"}
                      </ThemedText>
                    </View>
                  </Pressable>

                  <Pressable
                    className={"bg-card rounded-2xl px-4 py-3"}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setAndroidActiveDateField("end");
                    }}
                  >
                    <View className={"flex-row items-center justify-between gap-3"}>
                      <ThemedText className={"font-semibold"}>End</ThemedText>
                      <ThemedText variant={"footnote"} color={"tertiary"}>
                        {endDateMs ? formatShortDate(endDateMs) : "Any"}
                      </ThemedText>
                    </View>
                  </Pressable>

                  <View className={"flex-row gap-2"}>
                    <Button
                      variant={"outline"}
                      size={"sm"}
                      className={"flex-1"}
                      onPress={() => {
                        setStartDateMs(null);
                        setEndDateMs(null);
                        setAndroidActiveDateField(null);
                        setDateModalVisible(false);
                      }}
                    >
                      <ButtonText variant={"outline"} size={"sm"}>
                        Clear Dates
                      </ButtonText>
                    </Button>
                  </View>

                  {androidActiveDateField && (
                    <DateTimePicker
                      value={
                        androidActiveDateField === "start"
                          ? startDateMs
                            ? new Date(startDateMs)
                            : new Date()
                          : endDateMs
                            ? new Date(endDateMs)
                            : new Date()
                      }
                      mode={"date"}
                      onChange={(event: DateTimePickerEvent, date?: Date) => {
                        if (event.type === "dismissed") {
                          setAndroidActiveDateField(null);
                          return;
                        }
                        if (!date) {
                          setAndroidActiveDateField(null);
                          return;
                        }

                        if (androidActiveDateField === "start") {
                          const nextStart = toStartOfDayMs(date);
                          setStartDateMs(nextStart);
                          if (endDateMs !== null && endDateMs < nextStart) {
                            setEndDateMs(toEndOfDayMs(date));
                          }
                        } else {
                          const nextEnd = toEndOfDayMs(date);
                          setEndDateMs(nextEnd);
                          if (startDateMs !== null && nextEnd < startDateMs) {
                            setStartDateMs(toStartOfDayMs(date));
                          }
                        }

                        setAndroidActiveDateField(null);
                      }}
                    />
                  )}
                </View>
              )}
            </View>
          </View>
        </Modal>
      </View>
    </ScreenLayout>
  );
}

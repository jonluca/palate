import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { AnimatedListItem, ReviewVisitCard, TabButton, type ReviewTab } from "@/components/review";
import { AllCaughtUpEmpty, SkeletonVisitCard, Button, ButtonText } from "@/components/ui";
import { IconSymbol } from "@/components/icon-symbol";
import {
  usePendingReview,
  useBatchConfirmVisits,
  type PendingVisitForReview,
  type ExactCalendarMatch,
} from "@/hooks/queries";
import { FlashList } from "@shopify/flash-list";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, RefreshControl, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useToast } from "@/components/ui/toast";

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

  // Helper to check if a visit has high-confidence signals
  const isHighConfidenceVisit = useCallback((visit: PendingVisitForReview) => {
    const hasRestaurantMatch = visit.suggestedRestaurants.length > 0;
    const hasCalendarEvent = !!visit.calendarEventTitle;
    const hasFood = !!visit.foodProbable;
    return hasRestaurantMatch || hasCalendarEvent || hasFood;
  }, []);

  // Filter visits into categories
  const { highConfidenceVisits, lowConfidenceVisits } = useMemo(() => {
    const visitsWithoutExactMatches = pendingVisits.filter((v) => !exactMatchVisitIds.has(v.id));
    const high: PendingVisitForReview[] = [];
    const low: PendingVisitForReview[] = [];

    for (const visit of visitsWithoutExactMatches) {
      if (isHighConfidenceVisit(visit)) {
        high.push(visit);
      } else {
        low.push(visit);
      }
    }

    return { highConfidenceVisits: high, lowConfidenceVisits: low };
  }, [pendingVisits, exactMatchVisitIds, isHighConfidenceVisit]);

  // UI state
  const hasExactMatches = exactMatches.length > 0;
  const hasLowConfidence = lowConfidenceVisits.length > 0;
  const hasTabs = hasExactMatches || hasLowConfidence;
  const isEmpty = pendingVisits.length === 0;

  // Switch back to "all" tab if current tab becomes empty
  useEffect(() => {
    if (activeTab === "exact" && !hasExactMatches) {
      setActiveTab("all");
    }
    if (activeTab === "other" && !hasLowConfidence) {
      setActiveTab("all");
    }
  }, [activeTab, hasExactMatches, hasLowConfidence]);

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
          {highConfidenceVisits.length.toLocaleString()}{" "}
          {highConfidenceVisits.length === 1 ? "visit needs" : "visits need"} manual review
        </ThemedText>
      </View>
    ),
    [highConfidenceVisits.length],
  );

  const LowConfidenceListHeader = useCallback(
    () => (
      <View className={"gap-2"}>
        <ThemedText variant={"largeTitle"} className={"font-bold"}>
          Other Visits
        </ThemedText>
        <ThemedText variant={"body"} color={"secondary"}>
          {lowConfidenceVisits.length.toLocaleString()} {lowConfidenceVisits.length === 1 ? "visit" : "visits"} without
          restaurant matches, calendar events, or food detected
        </ThemedText>
      </View>
    ),
    [lowConfidenceVisits.length],
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
                count={highConfidenceVisits.length}
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
              {hasLowConfidence && (
                <TabButton
                  label={"Other"}
                  count={lowConfidenceVisits.length}
                  isSelected={activeTab === "other"}
                  onPress={() => setActiveTab("other")}
                />
              )}
            </View>
          </View>
        )}

        {/* Tab Content */}
        {activeTab === "all" && (
          <FlashList
            data={highConfidenceVisits}
            renderItem={renderRegularItem}
            keyExtractor={(item) => item.id}
            refreshControl={refreshControl}
            refreshing={refreshing}
            contentContainerStyle={listContentStyle}
            ListHeaderComponent={RegularListHeader}
            ListHeaderComponentStyle={{ marginBottom: 24 }}
            ListEmptyComponent={isLoading ? <LoadingState /> : isEmpty ? <AllCaughtUpEmpty /> : null}
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

        {activeTab === "other" && hasLowConfidence && (
          <FlashList
            data={lowConfidenceVisits}
            renderItem={renderRegularItem}
            keyExtractor={(item) => item.id}
            refreshing={refreshing}
            refreshControl={refreshControl}
            contentContainerStyle={listContentStyle}
            ListHeaderComponent={LowConfidenceListHeader}
            ListHeaderComponentStyle={{ marginBottom: 24 }}
            ListEmptyComponent={isLoading ? <LoadingState /> : <AllCaughtUpEmpty />}
          />
        )}
      </View>
    </ScreenLayout>
  );
}

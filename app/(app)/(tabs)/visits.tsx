import { VisitCard, type VisitStatus } from "@/components/visit-card";
import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { FilterPills, NoVisitsEmpty, SkeletonVisitCard } from "@/components/ui";
import { useStats, useVisits, useQuickUpdateVisitStatus, type VisitWithRestaurant } from "@/hooks/queries";
import { useVisitsFilter, useSetVisitsFilter } from "@/store";
import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { View, RefreshControl } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "@react-navigation/native";

function LoadingState() {
  return (
    <View className={"gap-6"}>
      {Array.from({ length: 4 }).map((_, i) => (
        <SkeletonVisitCard key={i} />
      ))}
    </View>
  );
}

export default function VisitsScreen() {
  const filter = useVisitsFilter();
  const setFilter = useSetVisitsFilter();
  const [refreshing, setRefreshing] = useState(false);

  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const isFocused = useIsFocused();
  // Queries
  const { data: stats } = useStats();
  const { data: visits = [], isLoading: visitsLoading } = useVisits(filter, { enabled: isFocused });

  // Mutations
  const updateStatusMutation = useQuickUpdateVisitStatus();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries();
    setRefreshing(false);
  };

  const filterOptions = useMemo(
    () =>
      stats
        ? [
            { value: "all" as const, label: "All", count: stats.totalVisits },
            { value: "confirmed" as const, label: "Confirmed", count: stats.confirmedVisits },
            { value: "pending" as const, label: "Pending", count: stats.pendingVisits },
            {
              value: "rejected" as const,
              label: "Rejected",
              count: stats.totalVisits - stats.pendingVisits - stats.confirmedVisits,
            },
            { value: "food" as const, label: "🍽️ Food", count: stats.foodProbableVisits },
          ].filter((option) => option.count > 0)
        : [],
    [stats],
  );

  const handleStatusChange = useCallback(
    (visitId: string, newStatus: VisitStatus) => {
      updateStatusMutation.mutate({ visitId, newStatus });
    },
    [updateStatusMutation],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: VisitWithRestaurant; index: number }) => (
      <VisitCard
        mode={"list"}
        id={item.id}
        restaurantName={item.restaurantName ?? item.suggestedRestaurantName}
        status={item.status}
        startTime={item.startTime}
        photoCount={item.photoCount}
        previewPhotos={item.previewPhotos}
        foodProbable={item.foodProbable}
        calendarEventTitle={item.calendarEventTitle}
        calendarEventIsAllDay={item.calendarEventIsAllDay}
        onPress={(photoIndex) =>
          photoIndex !== undefined
            ? router.push(`/visit/${item.id}?photo=${photoIndex}`)
            : router.push(`/visit/${item.id}`)
        }
        onStatusChange={(newStatus) => handleStatusChange(item.id, newStatus)}
        index={index < 10 ? index : 0}
      />
    ),
    [handleStatusChange],
  );

  const ListHeader = useCallback(
    () => (
      <View className={"gap-6"}>
        {/* Header */}
        <View className={"gap-2"}>
          <ThemedText variant={"largeTitle"} className={"font-bold"}>
            All Visits
          </ThemedText>
        </View>

        {/* Filters */}
        {stats && stats.totalVisits > 0 && (
          <Animated.View layout={LinearTransition}>
            <FilterPills options={filterOptions} value={filter} onChange={setFilter} />
          </Animated.View>
        )}

        {/* Visits List Title */}
        {visits.length > 0 && (
          <Animated.View layout={LinearTransition}>
            <ThemedText
              variant={"footnote"}
              color={"tertiary"}
              className={"uppercase font-semibold tracking-wide px-1"}
            >
              {filter === "all" ? "All Visits" : `${filter.charAt(0).toUpperCase() + filter.slice(1)} Visits`} (
              {visits.length.toLocaleString()})
            </ThemedText>
          </Animated.View>
        )}
      </View>
    ),
    [stats, filter, filterOptions, visits.length, setFilter],
  );

  const ItemSeparator = useCallback(() => <View style={{ height: 24 }} />, []);

  return (
    <ScreenLayout scrollable={false} className={"p-0"} style={{ paddingTop: 0, paddingBottom: 0 }}>
      <FlashList
        data={visits}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: 16,
        }}
        ListHeaderComponent={ListHeader}
        ListHeaderComponentStyle={{ marginBottom: 24 }}
        ListEmptyComponent={
          visitsLoading ? (
            <LoadingState />
          ) : stats && stats.totalVisits === 0 ? (
            <NoVisitsEmpty onScan={() => router.push("/rescan")} />
          ) : null
        }
        ItemSeparatorComponent={ItemSeparator}
      />
    </ScreenLayout>
  );
}

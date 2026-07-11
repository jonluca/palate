import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { FilterPills, NoVisitsEmpty, SkeletonVisitCard } from "@/components/ui";
import { useStats, useVisits, type FilterType, type VisitListItem } from "@/hooks/queries";
import { useVisitsFilter, useSetVisitsFilter } from "@/store";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { router, Stack, useIsFocused } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { View, RefreshControl, Pressable } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { IconSymbol } from "@/components/icon-symbol";
import { ListModeCard } from "@/components/visit-card/list-mode-card";
import { refreshAllQueriesWithVisitListPageReset } from "@/utils/query-cache-policy";

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
  const listRef = useRef<FlashListRef<VisitListItem>>(null);
  const [refreshing, setRefreshing] = useState(false);

  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const isFocused = useIsFocused();
  // Queries
  const { data: stats } = useStats();
  const {
    data,
    isLoading: visitsLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPlaceholderData,
  } = useVisits(filter, {
    enabled: isFocused,
  });
  const displayedFilter = data?.pages[0]?.filter ?? filter;
  const visits = useMemo(() => data?.pages.flatMap((page) => page.visits) ?? [], [data?.pages]);
  const visitCount = useMemo(() => {
    if (!stats) {
      return visits.length;
    }
    switch (displayedFilter) {
      case "confirmed":
        return stats.confirmedVisits;
      case "pending":
        return stats.pendingVisits;
      case "rejected":
        return stats.totalVisits - stats.pendingVisits - stats.confirmedVisits;
      case "food":
        return stats.foodProbableVisits;
      case "all":
      default:
        return stats.totalVisits;
    }
  }, [displayedFilter, stats, visits.length]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshAllQueriesWithVisitListPageReset(queryClient).finally(() => {
      setRefreshing(false);
    });
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

  const renderItem = useCallback(
    ({ item, index }: { item: VisitListItem; index: number }) => (
      <ListModeCard
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
        enableAppleMapsVerification={index < 10}
      />
    ),
    [],
  );

  const handleFilterChange = useCallback(
    (nextFilter: FilterType) => {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      setFilter(nextFilter);
    },
    [setFilter],
  );

  const ListHeader = useCallback(
    () => (
      <View className={"gap-6"}>
        {/* Header */}
        <View className={"flex-row items-center gap-3"}>
          <Pressable onPress={() => router.back()} hitSlop={8} className={"p-2 -ml-2"}>
            <IconSymbol name={"chevron.left"} size={24} color={"#f97316"} />
          </Pressable>
          <ThemedText variant={"largeTitle"} className={"font-bold flex-1"}>
            All Visits
          </ThemedText>
        </View>

        {/* Filters */}
        {stats && stats.totalVisits > 0 && (
          <Animated.View layout={LinearTransition}>
            <FilterPills options={filterOptions} value={displayedFilter} onChange={handleFilterChange} />
          </Animated.View>
        )}

        {/* Visits List Title */}
        {visitCount > 0 && (
          <Animated.View layout={LinearTransition}>
            <ThemedText
              variant={"footnote"}
              color={"tertiary"}
              className={"uppercase font-semibold tracking-wide px-1"}
            >
              {displayedFilter === "all"
                ? "All Visits"
                : `${displayedFilter.charAt(0).toUpperCase() + displayedFilter.slice(1)} Visits`}{" "}
              ({visitCount.toLocaleString()})
            </ThemedText>
          </Animated.View>
        )}
      </View>
    ),
    [stats, displayedFilter, filterOptions, visitCount, handleFilterChange],
  );

  const ItemSeparator = useCallback(() => <View style={{ height: 24 }} />, []);
  const handleEndReached = useCallback(() => {
    if (!isPlaceholderData && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isPlaceholderData]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenLayout scrollable={false} className={"p-0"} style={{ paddingTop: 0, paddingBottom: 0 }}>
        <FlashList
          ref={listRef}
          data={visits}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          onEndReached={handleEndReached}
          onEndReachedThreshold={1}
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
    </>
  );
}

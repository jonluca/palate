import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { Card, SkeletonRestaurantCard, NoRestaurantsEmpty, FilterPills } from "@/components/ui";
import { HomeHeader, NewPhotosCard } from "@/components/home";
import { useConfirmedRestaurants, useMichelinRestaurants, type RestaurantWithVisits } from "@/hooks/queries";
import type { MichelinRestaurantRecord } from "@/utils/db";
import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState, useRef, useEffect } from "react";
import { View, RefreshControl, Pressable, TextInput } from "react-native";
import Animated, {
  FadeInDown,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  withTiming,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { IconSymbol } from "@/components/icon-symbol";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { cn } from "@/utils/cn";

type SortOption = "recent" | "confirmed" | "name" | "visits";
type StarFilter = "all" | "1star" | "2star" | "3star" | "lost" | "gained";

const sortOptions: { value: SortOption; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "confirmed", label: "Recently Confirmed" },
  { value: "name", label: "A-Z" },
  { value: "visits", label: "Most Visits" },
];

const starFilterOptions: { value: StarFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "1star", label: "⭐" },
  { value: "2star", label: "⭐⭐" },
  { value: "3star", label: "⭐⭐⭐" },
  { value: "lost", label: "Lost Stars" },
  { value: "gained", label: "Gained Stars" },
];

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getStarCount(award: string | null): number {
  if (!award) {
    return 0;
  }
  const lower = award.toLowerCase();
  if (lower.includes("3 star")) {
    return 3;
  }
  if (lower.includes("2 star")) {
    return 2;
  }
  if (lower.includes("1 star")) {
    return 1;
  }
  return 0;
}

function formatAward(award: string | null): string | null {
  if (!award) {
    return null;
  }
  const lower = award.toLowerCase();
  if (lower.includes("3 star")) {
    return "⭐⭐⭐";
  }
  if (lower.includes("2 star")) {
    return "⭐⭐";
  }
  if (lower.includes("1 star")) {
    return "⭐";
  }
  if (lower.includes("bib gourmand")) {
    return "🍽️ Bib";
  }
  if (lower.includes("green star")) {
    return "🌿";
  }
  return null;
}

function PhotoPreview({ photos }: { photos: string[] }) {
  if (photos.length === 0) {
    return null;
  }

  return (
    <View className={"flex-row h-32 overflow-hidden border-b border-border"}>
      {photos.slice(0, 3).map((uri) => (
        <View key={uri} className={"flex-1"}>
          <Image recyclingKey={uri} source={{ uri }} style={{ width: "100%", height: 128 }} contentFit={"cover"} />
        </View>
      ))}
    </View>
  );
}

function RestaurantCard({ restaurant, index }: { restaurant: RestaurantWithVisits; index: number }) {
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/restaurant/${restaurant.id}`);
  };

  const hasPhotos = restaurant.previewPhotos.length > 0;
  const currentAwardDisplay = formatAward(restaurant.currentAward);
  const visitedAwardDisplay = formatAward(restaurant.visitedAward);

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).duration(150)}>
      <Pressable onPress={handlePress} className={"rounded-2xl"}>
        <Card animated={false}>
          <PhotoPreview photos={restaurant.previewPhotos} />
          <View className={hasPhotos ? "p-3.5 gap-1.5" : "p-4 gap-2"}>
            <View className={"flex-row items-start justify-between"}>
              <View className={"flex-1 gap-0.5"}>
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"heading"} className={"font-semibold flex-shrink"} numberOfLines={1}>
                    {restaurant.name}
                  </ThemedText>
                  {currentAwardDisplay && (
                    <ThemedText variant={"subhead"} className={"text-amber-300"}>
                      {currentAwardDisplay}
                    </ThemedText>
                  )}
                </View>
                <View className={"flex-row items-center gap-1"}>
                  <ThemedText variant={"footnote"} color={"tertiary"}>
                    Last visit: {formatDate(restaurant.lastVisit)}
                  </ThemedText>
                  {visitedAwardDisplay && (
                    <ThemedText variant={"footnote"} color={"tertiary"}>
                      · Visited at {visitedAwardDisplay}
                    </ThemedText>
                  )}
                </View>
              </View>
              <View className={"items-end gap-2 ml-3"}>
                {restaurant.visitCount > 1 ? (
                  <View className={"px-2 py-1 rounded-full bg-secondary/80  flex-row items-center gap-1"}>
                    <ThemedText
                      variant={"caption1"}
                      color={"secondary"}
                      className={"font-semibold"}
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {restaurant.visitCount.toLocaleString()}
                    </ThemedText>
                    <ThemedText variant={"caption2"} color={"tertiary"}>
                      {"visits"}
                    </ThemedText>
                  </View>
                ) : null}
                <View className={"w-7 h-7 rounded-full bg-secondary/70 items-center justify-center"}>
                  <IconSymbol name={"chevron.right"} size={12} color={"#8E8E93"} weight={"semibold"} />
                </View>
              </View>
            </View>
          </View>
        </Card>
      </Pressable>
    </Animated.View>
  );
}

function MichelinRestaurantCard({ restaurant, index }: { restaurant: MichelinRestaurantRecord; index: number }) {
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/restaurant/${restaurant.id}`);
  };

  const awardDisplay = formatAward(restaurant.award);

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).duration(150)}>
      <Pressable onPress={handlePress} className={"rounded-2xl"}>
        <Card animated={false}>
          <View className={"p-4 gap-2"}>
            <View className={"flex-row items-start justify-between"}>
              <View className={"flex-1 gap-1"}>
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"heading"} className={"font-semibold flex-shrink"} numberOfLines={1}>
                    {restaurant.name}
                  </ThemedText>
                  {awardDisplay && (
                    <ThemedText variant={"subhead"} className={"text-amber-300"}>
                      {awardDisplay}
                    </ThemedText>
                  )}
                </View>
                <View className={"flex-row items-center gap-2 flex-wrap"}>
                  {restaurant.cuisine ? (
                    <ThemedText variant={"footnote"} color={"tertiary"}>
                      {restaurant.cuisine}
                    </ThemedText>
                  ) : null}
                </View>
                {restaurant.location ? (
                  <ThemedText variant={"footnote"} color={"tertiary"} numberOfLines={1}>
                    {restaurant.location}
                  </ThemedText>
                ) : null}
              </View>
              <View className={"flex-row items-center gap-2 ml-3"}>
                <ThemedText variant={"caption1"} color={"tertiary"}>
                  Not visited
                </ThemedText>
                <View className={"w-7 h-7 rounded-full bg-secondary/70 items-center justify-center"}>
                  <IconSymbol name={"chevron.right"} size={12} color={"#8E8E93"} weight={"semibold"} />
                </View>
              </View>
            </View>
          </View>
        </Card>
      </Pressable>
    </Animated.View>
  );
}

function LoadingState() {
  return (
    <View className={"gap-4"}>
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonRestaurantCard key={i} />
      ))}
    </View>
  );
}

function SearchBar({
  value,
  onChangeText,
  onClear,
  filtersExpanded,
  onToggleFilters,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onClear: () => void;
  filtersExpanded: boolean;
  onToggleFilters: () => void;
}) {
  "use no memo";

  const rotation = useSharedValue(0);

  React.useEffect(() => {
    rotation.value = withTiming(filtersExpanded ? 180 : 0, { duration: 200 });
  }, [filtersExpanded, rotation]);

  const arrowStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <View className={"flex-row items-center gap-2"}>
      <View className={"flex-1 h-11 flex-row items-center bg-secondary/70  rounded-2xl px-3 gap-2"}>
        <IconSymbol name={"magnifyingglass"} size={16} color={"#8E8E93"} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={"Search restaurants..."}
          placeholderTextColor={"#8E8E93"}
          className={"flex-1 text-foreground"}
          style={{ height: 22, fontSize: 16 }}
          autoCapitalize={"none"}
          autoCorrect={false}
          clearButtonMode={"never"}
        />
        {value.length > 0 && (
          <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(150)}>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onClear();
              }}
              hitSlop={8}
              className={"w-6 h-6 rounded-full items-center justify-center"}
            >
              <IconSymbol name={"xmark.circle.fill"} size={18} color={"#8E8E93"} />
            </Pressable>
          </Animated.View>
        )}
      </View>
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onToggleFilters();
        }}
        hitSlop={8}
        className={cn(
          "w-11 h-11 rounded-2xl border items-center justify-center",
          filtersExpanded ? "bg-primary/15 border-primary/25" : "bg-secondary/70 border-border",
        )}
      >
        <Animated.View style={arrowStyle}>
          <IconSymbol name={"chevron.down"} size={16} color={filtersExpanded ? "#0A84FF" : "#8E8E93"} />
        </Animated.View>
      </Pressable>
    </View>
  );
}

// Union type for list items
type ListItem =
  | { type: "visited"; data: RestaurantWithVisits }
  | { type: "michelin"; data: MichelinRestaurantRecord }
  | { type: "section-header"; title: string };

export default function RestaurantsScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [starFilter, setStarFilter] = useState<StarFilter>("all");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listRef = useRef<any>(null);

  const { data: restaurants = [], isLoading } = useConfirmedRestaurants();
  const { data: michelinRestaurants = [] } = useMichelinRestaurants();

  const scrollToTop = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // Instantly scroll to top when search query or filters change
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [searchQuery, starFilter, sortBy]);

  // Create a set of visited restaurant IDs for filtering
  const visitedRestaurantIds = useMemo(() => {
    return new Set(restaurants.map((r) => r.id));
  }, [restaurants]);

  // Filter and sort restaurants, and add Michelin results when searching
  const listItems = useMemo((): ListItem[] => {
    const query = searchQuery.toLowerCase().trim();
    const isSearching = query.length > 0;

    // Filter visited restaurants
    let visitedResults = [...restaurants];

    // Apply search filter
    if (isSearching) {
      visitedResults = visitedResults.filter((r) => r.name.toLowerCase().includes(query));
    }

    // Apply star filter
    if (starFilter !== "all") {
      visitedResults = visitedResults.filter((r) => {
        const currentStars = getStarCount(r.currentAward);
        const visitedStars = getStarCount(r.visitedAward ?? r.currentAward);

        switch (starFilter) {
          case "1star":
            return currentStars === 1;
          case "2star":
            return currentStars === 2;
          case "3star":
            return currentStars === 3;
          case "lost":
            // Restaurant had more stars when visited than it does now
            return visitedStars > currentStars;
          case "gained":
            // Restaurant has more stars now than when visited
            return currentStars > visitedStars;
          default:
            return true;
        }
      });
    }

    // Sort visited restaurants
    switch (sortBy) {
      case "name":
        visitedResults.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "visits":
        visitedResults.sort((a, b) => b.visitCount - a.visitCount);
        break;
      case "confirmed":
        visitedResults.sort((a, b) => (b.lastConfirmedAt ?? 0) - (a.lastConfirmedAt ?? 0));
        break;
      case "recent":
      default:
        visitedResults.sort((a, b) => b.lastVisit - a.lastVisit);
        break;
    }

    const items: ListItem[] = visitedResults.map((data) => ({ type: "visited", data }));

    // When searching, also include unvisited Michelin restaurants (only when no star filter is active)
    if (isSearching && michelinRestaurants.length > 0 && starFilter === "all") {
      const unvisitedMichelin = michelinRestaurants
        .filter((r) => !visitedRestaurantIds.has(r.id) && r.name.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 50); // Limit to 50 results for performance

      if (unvisitedMichelin.length > 0) {
        items.push({ type: "section-header", title: `All Restaurants (${unvisitedMichelin.length})` });
        items.push(...unvisitedMichelin.map((data) => ({ type: "michelin" as const, data })));
      }
    }

    return items;
  }, [restaurants, michelinRestaurants, visitedRestaurantIds, searchQuery, sortBy, starFilter]);

  // For backward compatibility with existing code
  const filteredAndSortedRestaurants = useMemo(() => {
    return listItems.filter((item): item is { type: "visited"; data: RestaurantWithVisits } => item.type === "visited");
  }, [listItems]);

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries();
    setRefreshing(false);
  };

  const handleSortChange = useCallback((value: SortOption) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSortBy(value);
  }, []);

  const handleStarFilterChange = useCallback((value: StarFilter) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStarFilter(value);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
  }, []);

  const handleToggleFilters = useCallback(() => {
    setFiltersExpanded((prev) => !prev);
  }, []);

  const renderItem = useCallback(({ item, index }: { item: ListItem; index: number }) => {
    if (item.type === "section-header") {
      return (
        <View className={""}>
          <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide px-1"}>
            {item.title}
          </ThemedText>
        </View>
      );
    }
    if (item.type === "michelin") {
      return <MichelinRestaurantCard restaurant={item.data} index={index < 10 ? index : 0} />;
    }
    return <RestaurantCard restaurant={item.data} index={index < 10 ? index : 0} />;
  }, []);

  const ListEmpty = useCallback(() => {
    if (isLoading) {
      return <LoadingState />;
    }

    // If we have restaurants but no results at all (including Michelin)
    if (restaurants.length > 0 && listItems.length === 0) {
      const hasActiveFilter = starFilter !== "all";
      const filterLabel = starFilterOptions.find((o) => o.value === starFilter)?.label ?? "";

      return (
        <Animated.View entering={FadeIn.duration(200)} className={"py-8 items-center gap-3"}>
          <IconSymbol name={"magnifyingglass"} size={40} color={"gray"} />
          <ThemedText variant={"body"} color={"secondary"} className={"text-center"}>
            {hasActiveFilter ? `No restaurants with ${filterLabel}` : `No restaurants match "${searchQuery}"`}
          </ThemedText>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              if (hasActiveFilter) {
                setStarFilter("all");
              } else {
                setSearchQuery("");
              }
            }}
          >
            <ThemedText variant={"subhead"} className={"text-primary font-medium"}>
              {hasActiveFilter ? "Clear filter" : "Clear search"}
            </ThemedText>
          </Pressable>
        </Animated.View>
      );
    }

    return <NoRestaurantsEmpty onPress={() => router.push("/review")} />;
  }, [isLoading, restaurants.length, listItems.length, searchQuery, starFilter]);

  const ItemSeparator = useCallback(() => <View style={{ height: 16 }} />, []);

  return (
    <ScreenLayout scrollable={false} className={"p-0"} style={{ paddingTop: 0, paddingBottom: 0 }}>
      {/* Tap-to-scroll-to-top area over status bar */}
      <Pressable
        onPress={scrollToTop}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: insets.top,
          zIndex: 100,
        }}
      />

      {/* Header controls rendered outside FlashList to prevent keyboard dismissal */}
      {restaurants.length > 0 && (
        <View style={{ paddingTop: insets.top + 16, paddingHorizontal: 16 }} className={"gap-3 bg-background"}>
          {/* Header */}
          {!searchQuery && <HomeHeader />}

          {/* New Photos Card */}
          <NewPhotosCard />

          <SearchBar
            value={searchQuery}
            onChangeText={setSearchQuery}
            onClear={handleClearSearch}
            filtersExpanded={filtersExpanded}
            onToggleFilters={handleToggleFilters}
          />
          {filtersExpanded && (
            <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} className={"gap-3"}>
              <FilterPills options={sortOptions} value={sortBy} onChange={handleSortChange} />
              <FilterPills options={starFilterOptions} value={starFilter} onChange={handleStarFilterChange} />
            </Animated.View>
          )}

          {/* Restaurant List Section Title */}
          {filteredAndSortedRestaurants.length > 0 && (
            <ThemedText
              variant={"footnote"}
              color={"tertiary"}
              className={"uppercase font-semibold tracking-wide px-1 pt-1"}
            >
              My Restaurants ({filteredAndSortedRestaurants.length})
            </ThemedText>
          )}
        </View>
      )}

      <View
        className={"flex-1"}
        style={{
          paddingBottom: insets.bottom,
        }}
      >
        <FlashList
          ref={listRef}
          data={listItems}
          renderItem={renderItem}
          keyExtractor={(item) => {
            if (item.type === "section-header") {
              return `section-${item.title}`;
            }
            return `${sortBy}-${starFilter}-${searchQuery}-${item.data.id}`;
          }}
          getItemType={(item) => item.type}
          drawDistance={250}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#8E8E93"} />}
          contentContainerStyle={{
            paddingTop: restaurants.length > 0 ? 0 : insets.top + 16,
            paddingBottom: insets.bottom + 32,
            paddingHorizontal: 16,
          }}
          ListEmptyComponent={ListEmpty}
          ItemSeparatorComponent={ItemSeparator}
        />
      </View>
    </ScreenLayout>
  );
}

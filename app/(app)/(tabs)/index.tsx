import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { Card, SkeletonRestaurantCard, NoRestaurantsEmpty, FilterPills } from "@/components/ui";
import { HomeHeader, NewPhotosCard } from "@/components/home";
import { useConfirmedRestaurants, useMichelinRestaurants, type RestaurantWithVisits } from "@/hooks/queries";
import type { MichelinRestaurantRecord } from "@/utils/db";
import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState, useRef } from "react";
import { View, RefreshControl, Pressable, TextInput } from "react-native";
import Animated, { FadeInDown, FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { IconSymbol } from "@/components/icon-symbol";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";

type SortOption = "recent" | "confirmed" | "name" | "visits";

const sortOptions: { value: SortOption; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "confirmed", label: "Recently Confirmed" },
  { value: "name", label: "A-Z" },
  { value: "visits", label: "Most Visits" },
];

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
    <View className={"flex-row h-32 overflow-hidden"}>
      {photos.slice(0, 3).map((uri, i) => (
        <View key={i} className={"flex-1"}>
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
      <Pressable onPress={handlePress}>
        <Card animated={false}>
          <PhotoPreview photos={restaurant.previewPhotos} />
          <View className={hasPhotos ? "p-3 gap-1" : "p-4 gap-2"}>
            <View className={"flex-row items-start justify-between"}>
              <View className={"flex-1 gap-0.5"}>
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"heading"} className={"font-semibold flex-shrink"} numberOfLines={1}>
                    {restaurant.name}
                  </ThemedText>
                  {currentAwardDisplay && <ThemedText variant={"subhead"}>{currentAwardDisplay}</ThemedText>}
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
              <View className={"flex-row items-center gap-1 ml-3"}>
                <ThemedText variant={"subhead"} color={"secondary"} className={"font-medium"}>
                  {restaurant.visitCount.toLocaleString()}
                </ThemedText>
                <ThemedText variant={"footnote"} color={"tertiary"}>
                  {restaurant.visitCount === 1 ? "visit" : "visits"}
                </ThemedText>
                <IconSymbol name={"chevron.right"} size={14} color={"gray"} />
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
      <Pressable onPress={handlePress}>
        <Card animated={false}>
          <View className={"p-4 gap-2"}>
            <View className={"flex-row items-start justify-between"}>
              <View className={"flex-1 gap-1"}>
                <View className={"flex-row items-center gap-2"}>
                  <ThemedText variant={"heading"} className={"font-semibold flex-shrink"} numberOfLines={1}>
                    {restaurant.name}
                  </ThemedText>
                  {awardDisplay && <ThemedText variant={"subhead"}>{awardDisplay}</ThemedText>}
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
              <View className={"flex-row items-center gap-1 ml-3"}>
                <ThemedText variant={"footnote"} color={"tertiary"}>
                  Not visited
                </ThemedText>
                <IconSymbol name={"chevron.right"} size={14} color={"gray"} />
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
}: {
  value: string;
  onChangeText: (text: string) => void;
  onClear: () => void;
}) {
  return (
    <View className={"flex-row items-center bg-card rounded-xl px-3 py-2 gap-2"}>
      <IconSymbol name={"magnifyingglass"} size={18} color={"gray"} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={"Search restaurants..."}
        placeholderTextColor={"#888"}
        className={"flex-1 text-foreground text-base"}
        style={{ height: 24 }}
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
          >
            <IconSymbol name={"xmark.circle.fill"} size={18} color={"gray"} />
          </Pressable>
        </Animated.View>
      )}
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
    if (isSearching) {
      visitedResults = visitedResults.filter((r) => r.name.toLowerCase().includes(query));
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

    // When searching, also include unvisited Michelin restaurants
    if (isSearching && michelinRestaurants.length > 0) {
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
  }, [restaurants, michelinRestaurants, visitedRestaurantIds, searchQuery, sortBy]);

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

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
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
      return (
        <Animated.View entering={FadeIn.duration(200)} className={"py-8 items-center gap-3"}>
          <IconSymbol name={"magnifyingglass"} size={40} color={"gray"} />
          <ThemedText variant={"body"} color={"secondary"} className={"text-center"}>
            No restaurants match "{searchQuery}"
          </ThemedText>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setSearchQuery("");
            }}
          >
            <ThemedText variant={"subhead"} className={"text-primary font-medium"}>
              Clear search
            </ThemedText>
          </Pressable>
        </Animated.View>
      );
    }

    return <NoRestaurantsEmpty onPress={() => router.push("/review")} />;
  }, [isLoading, restaurants.length, listItems.length, searchQuery]);

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

          <SearchBar value={searchQuery} onChangeText={setSearchQuery} onClear={handleClearSearch} />
          <FilterPills options={sortOptions} value={sortBy} onChange={handleSortChange} />

          {/* Restaurant List Section Title */}
          {filteredAndSortedRestaurants.length > 0 && (
            <ThemedText
              variant={"footnote"}
              color={"tertiary"}
              className={"uppercase font-semibold tracking-wide px-1"}
            >
              My Restaurants ({filteredAndSortedRestaurants.length})
            </ThemedText>
          )}
        </View>
      )}

      <View className={"flex-1"}>
        <FlashList
          ref={listRef}
          data={listItems}
          renderItem={renderItem}
          keyExtractor={(item) => {
            if (item.type === "section-header") {
              return `section-${item.title}`;
            }
            return item.data.id;
          }}
          getItemType={(item) => item.type}
          drawDistance={250}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{
            paddingTop: restaurants.length > 0 ? 0 : insets.top + 16,
            paddingBottom: insets.bottom + 32,
            paddingHorizontal: 16,
          }}
          ListEmptyComponent={ListEmpty}
          key={`${sortBy}-${searchQuery}`}
          ItemSeparatorComponent={ItemSeparator}
          extraData={{ searchQuery, sortBy }}
        />
      </View>
    </ScreenLayout>
  );
}

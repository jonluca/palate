import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { Card, SkeletonRestaurantCard, NoRestaurantsEmpty, FilterPills } from "@/components/ui";
import { HomeHeader, NewPhotosCard } from "@/components/home";
import { useConfirmedRestaurants, type RestaurantWithVisits } from "@/hooks/queries";
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

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).duration(150)}>
      <Pressable onPress={handlePress}>
        <Card animated={false}>
          <PhotoPreview photos={restaurant.previewPhotos} />
          <View className={hasPhotos ? "p-3 gap-1" : "p-4 gap-2"}>
            <View className={"flex-row items-start justify-between"}>
              <View className={"flex-1 gap-0.5"}>
                <ThemedText variant={"heading"} className={"font-semibold"} numberOfLines={1}>
                  {restaurant.name}
                </ThemedText>
                <ThemedText variant={"footnote"} color={"tertiary"}>
                  Last visit: {formatDate(restaurant.lastVisit)}
                </ThemedText>
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
        className={"flex-1 text-foreground text-base py-1"}
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

export default function RestaurantsScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listRef = useRef<any>(null);

  const { data: restaurants = [], isLoading } = useConfirmedRestaurants();

  const scrollToTop = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // Filter and sort restaurants
  const filteredAndSortedRestaurants = useMemo(() => {
    let result = [...restaurants];

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter((r) => r.name.toLowerCase().includes(query));
    }

    // Sort restaurants
    switch (sortBy) {
      case "name":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "visits":
        result.sort((a, b) => b.visitCount - a.visitCount);
        break;
      case "confirmed":
        result.sort((a, b) => (b.lastConfirmedAt ?? 0) - (a.lastConfirmedAt ?? 0));
        break;
      case "recent":
      default:
        result.sort((a, b) => b.lastVisit - a.lastVisit);
        break;
    }

    return result;
  }, [restaurants, searchQuery, sortBy]);

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

  const renderItem = useCallback(
    ({ item, index }: { item: RestaurantWithVisits; index: number }) => (
      <RestaurantCard restaurant={item} index={index < 10 ? index : 0} />
    ),
    [],
  );

  const ListEmpty = useCallback(() => {
    if (isLoading) {
      return <LoadingState />;
    }

    // If we have restaurants but filtered results are empty
    if (restaurants.length > 0 && filteredAndSortedRestaurants.length === 0) {
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
  }, [isLoading, restaurants.length, filteredAndSortedRestaurants.length, searchQuery]);

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
              My Restaurants ({filteredAndSortedRestaurants.length.toLocaleString()})
            </ThemedText>
          )}
        </View>
      )}

      <View className={"flex-1"}>
        <FlashList
          ref={listRef}
          data={filteredAndSortedRestaurants}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          drawDistance={250}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{
            paddingTop: restaurants.length > 0 ? 16 : insets.top + 16,
            paddingBottom: insets.bottom + 32,
            paddingHorizontal: 16,
          }}
          ListEmptyComponent={ListEmpty}
          key={`${sortBy}`}
          ItemSeparatorComponent={ItemSeparator}
          extraData={{ searchQuery, sortBy }}
        />
      </View>
    </ScreenLayout>
  );
}

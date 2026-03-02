import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText } from "@/components/ui";
import {
  useUnifiedNearbyRestaurants,
  useSearchNearbyRestaurants,
  useConfirmedRestaurants,
  type NearbyRestaurant,
  type RestaurantWithVisits,
} from "@/hooks";
import {
  RestaurantRowCard,
  getRestaurantAwardBadge,
  getRestaurantSourceBadge,
  formatRestaurantDistance,
} from "@/components/restaurants/restaurant-row-card";
import type { PlaceResult } from "@/services/places";
import type { VisitRecord } from "@/utils/db";
import { useGoogleMapsApiKey } from "@/store";
import React, { useState, useRef, useMemo } from "react";
import { View, Pressable, Modal, ScrollView, TextInput } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { cleanCalendarEventTitle } from "@/services/calendar";

export interface RestaurantOption {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance?: number;
  award?: string | null;
  cuisine?: string;
  address?: string | null;
  source: "michelin" | "mapkit" | "google";
}

export function getMichelinBadge(award: string): { emoji: string; label: string } | null {
  const badge = getRestaurantAwardBadge(award);
  if (!badge) {
    return null;
  }

  if (badge.label.startsWith("3 Michelin")) {
    return { emoji: "⭐⭐⭐", label: badge.label };
  }
  if (badge.label.startsWith("2 Michelin")) {
    return { emoji: "⭐⭐", label: badge.label };
  }
  if (badge.label.startsWith("1 Michelin")) {
    return { emoji: "⭐", label: badge.label };
  }
  if (badge.label === "Bib Gourmand") {
    return { emoji: "🍽️", label: badge.label };
  }
  if (badge.label === "Green Star") {
    return { emoji: "🌿", label: badge.label };
  }

  return { emoji: "🏆", label: badge.label };
}

/**
 * Calculate similarity between two strings using Levenshtein distance.
 * Returns a score between 0 (no match) and 1 (exact match).
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) {
    return 1;
  }
  if (s1.length === 0 || s2.length === 0) {
    return 0;
  }

  // Check if one contains the other (partial match bonus)
  if (s1.includes(s2) || s2.includes(s1)) {
    const shorter = s1.length < s2.length ? s1 : s2;
    const longer = s1.length < s2.length ? s2 : s1;
    return shorter.length / longer.length + 0.3; // Bonus for containment
  }

  // Calculate Levenshtein distance
  const matrix: number[][] = [];
  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }

  const distance = matrix[s1.length][s2.length];
  const maxLength = Math.max(s1.length, s2.length);
  return 1 - distance / maxLength;
}

function formatPriceLevel(level: number | undefined): string | null {
  if (level === undefined) {
    return null;
  }
  return "$".repeat(level);
}

// Sort restaurants by similarity to a search term
function sortBySimilarity<T extends { name: string }>(items: T[], searchTerm: string | null): T[] {
  if (!searchTerm) {
    return items;
  }
  return [...items].sort((a, b) => {
    const simA = calculateSimilarity(a.name, searchTerm);
    const simB = calculateSimilarity(b.name, searchTerm);
    return simB - simA; // Higher similarity first
  });
}

interface RestaurantSearchModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (restaurant: RestaurantOption) => void;
  visit: VisitRecord;
}

function MatchPill() {
  return (
    <View className={"px-2 py-1 rounded-full border border-emerald-500/20 bg-emerald-500/12"}>
      <ThemedText variant={"caption2"} className={"text-emerald-400 font-medium"}>
        Match
      </ThemedText>
    </View>
  );
}

export function RestaurantSearchModal({ visible, onClose, onSelect, visit }: RestaurantSearchModalProps) {
  const [searchingGoogle, setSearchingGoogle] = useState(false);
  const [googleResults, setGoogleResults] = useState<PlaceResult[]>([]);
  const [showGoogle, setShowGoogle] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const scrollViewRef = useRef<ScrollView>(null);
  const searchInputRef = useRef<TextInput>(null);
  const googleMapsApiKey = useGoogleMapsApiKey();
  const { centerLat, centerLon } = visit;

  // Use unified hook for Michelin + MapKit results
  // Pass a minimal visit object with coordinates (suggestedRestaurants not available here)
  const { data: unifiedRestaurants, isLoading: isLoadingNearby } = useUnifiedNearbyRestaurants(
    { centerLat, centerLon },
    visible,
  );

  // Also fetch confirmed restaurants (restaurants the user has visited)
  const { data: confirmedRestaurants = [] } = useConfirmedRestaurants();

  const searchGoogleMutation = useSearchNearbyRestaurants();

  const calendarEventTitle = visit.calendarEventTitle;

  const handleSearchGoogle = async () => {
    setSearchingGoogle(true);
    try {
      const results = await searchGoogleMutation.mutateAsync({
        lat: centerLat,
        lon: centerLon,
        radius: 150,
      });
      setGoogleResults(results);
      setShowGoogle(true);
      // Scroll to top when showing Google results
      setTimeout(() => {
        scrollViewRef.current?.scrollTo({ y: 0, animated: true });
      }, 100);
    } catch (error) {
      console.error("Google search failed:", error);
    } finally {
      setSearchingGoogle(false);
    }
  };

  // Sort term: use search query if provided, otherwise fall back to calendar event title
  const sortTerm = searchQuery.trim() || calendarEventTitle;

  // Convert confirmed restaurants to RestaurantOption and filter by search query
  const visitedOptions: (RestaurantOption & { visitCount: number })[] = useMemo(() => {
    // Only include visited restaurants when there's a search query
    if (!searchQuery.trim()) {
      return [];
    }

    const query = searchQuery.toLowerCase();
    const filtered = confirmedRestaurants.filter((r: RestaurantWithVisits) => r.name.toLowerCase().includes(query));

    const options = filtered.map((r: RestaurantWithVisits) => ({
      id: r.id,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      address: null,
      source: "michelin" as const, // Use michelin as source since these are confirmed
      visitCount: r.visitCount,
    }));

    return sortBySimilarity(options, sortTerm);
  }, [confirmedRestaurants, searchQuery, sortTerm]);

  // Convert unified results to RestaurantOption, filter by search, and sort by similarity
  const nearbyOptions: RestaurantOption[] = useMemo(() => {
    const options: RestaurantOption[] = unifiedRestaurants.map((r: NearbyRestaurant) => ({
      id: r.id,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      distance: r.distance,
      award: r.award,
      cuisine: r.cuisine,
      address: r.address,
      source: r.source,
    }));

    // Filter by search query if provided
    const filtered = searchQuery.trim()
      ? options.filter((r) => {
          const query = searchQuery.toLowerCase();
          return (
            r.name.toLowerCase().includes(query) ||
            r.cuisine?.toLowerCase().includes(query) ||
            r.address?.toLowerCase().includes(query)
          );
        })
      : options;

    // Exclude restaurants that are already in visitedOptions to avoid duplicates
    const visitedIds = new Set(visitedOptions.map((v) => v.id));
    const deduplicated = filtered.filter((r) => !visitedIds.has(r.id));

    return sortBySimilarity(deduplicated, sortTerm);
  }, [unifiedRestaurants, sortTerm, searchQuery, visitedOptions]);

  const googleOptions: (RestaurantOption & {
    rating?: number;
    priceLevel?: number;
  })[] = useMemo(() => {
    const options = googleResults.map((r) => ({
      id: r.placeId,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      address: r.address,
      rating: r.rating,
      priceLevel: r.priceLevel,
      source: "google" as const,
    }));

    // Filter by search query if provided
    const filtered = searchQuery.trim()
      ? options.filter((r) => {
          const query = searchQuery.toLowerCase();
          return r.name.toLowerCase().includes(query) || r.address?.toLowerCase().includes(query);
        })
      : options;

    return sortBySimilarity(filtered, sortTerm);
  }, [googleResults, sortTerm, searchQuery]);

  const handleClose = () => {
    setShowGoogle(false);
    setGoogleResults([]);
    setSearchQuery("");
    onClose();
  };

  return (
    <Modal visible={visible} animationType={"slide"} presentationStyle={"pageSheet"}>
      <View className={"flex-1 bg-background"} style={{ paddingTop: 0 }}>
        <View className={"flex-row items-center justify-between p-4 border-b border-white/10"}>
          <View className={"flex-1"}>
            <ThemedText variant={"heading"} className={"font-semibold"}>
              Select Restaurant
            </ThemedText>
            {calendarEventTitle && (
              <ThemedText variant={"footnote"} color={"tertiary"} className={"mt-1"}>
                Calendar: {cleanCalendarEventTitle(calendarEventTitle)}
              </ThemedText>
            )}
          </View>
          <Pressable onPress={handleClose} hitSlop={12}>
            <IconSymbol name={"xmark.circle.fill"} size={28} color={"#6b7280"} />
          </Pressable>
        </View>

        {/* Search Input */}
        <View className={"px-4 py-3 border-b border-white/10"}>
          <View className={"flex-row items-center bg-white/5 rounded-lg px-3 py-2"}>
            <IconSymbol name={"magnifyingglass"} size={18} color={"#6b7280"} />
            <TextInput
              ref={searchInputRef}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={"Search restaurants..."}
              placeholderTextColor={"#6b7280"}
              className={"flex-1 ml-2 text-white text-base"}
              autoCapitalize={"none"}
              autoCorrect={false}
              clearButtonMode={"while-editing"}
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={() => setSearchQuery("")} hitSlop={8}>
                <IconSymbol name={"xmark.circle.fill"} size={18} color={"#6b7280"} />
              </Pressable>
            )}
          </View>
        </View>

        <ScrollView ref={scrollViewRef} className={"flex-1"} contentContainerStyle={{ padding: 16, paddingBottom: 80 }}>
          {/* Visited Restaurants (shown when searching) */}
          {!showGoogle && visitedOptions.length > 0 && (
            <Animated.View entering={FadeIn} className={"gap-4 mb-6"}>
              <ThemedText variant={"subhead"} color={"secondary"} className={"font-medium"}>
                Your Restaurants
              </ThemedText>
              <View className={"gap-3"}>
                {visitedOptions.map((restaurant) => {
                  const similarity = sortTerm ? calculateSimilarity(restaurant.name, sortTerm) : 0;
                  const isLikelyMatch = similarity > 0.5;
                  return (
                    <RestaurantRowCard
                      key={`visited-${restaurant.id}`}
                      onPress={() => {
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        onSelect(restaurant);
                        handleClose();
                      }}
                      title={restaurant.name}
                      subtitle={`${restaurant.visitCount} ${restaurant.visitCount === 1 ? "visit" : "visits"}`}
                      variant={"selection"}
                      source={"visited"}
                      badge={getRestaurantSourceBadge("visited")}
                      rightAccessory={isLikelyMatch ? <MatchPill /> : undefined}
                    />
                  );
                })}
              </View>
            </Animated.View>
          )}

          {/* Nearby Results (Michelin + MapKit) */}
          {!showGoogle && (
            <Animated.View entering={FadeIn} className={"gap-4"}>
              <ThemedText variant={"subhead"} color={"secondary"} className={"font-medium"}>
                Nearby Restaurants
                {sortTerm && (
                  <ThemedText variant={"caption2"} color={"tertiary"}>
                    {" "}
                    (sorted by match)
                  </ThemedText>
                )}
              </ThemedText>

              {isLoadingNearby ? (
                <View className={"py-8 items-center gap-2"}>
                  <ThemedText variant={"body"} color={"tertiary"} className={"text-center"}>
                    Searching nearby...
                  </ThemedText>
                </View>
              ) : nearbyOptions.length === 0 ? (
                <View className={"py-8 items-center gap-2"}>
                  <ThemedText variant={"body"} color={"tertiary"} className={"text-center"}>
                    No restaurants found nearby
                  </ThemedText>
                </View>
              ) : (
                <View className={"gap-3"}>
                  {nearbyOptions.map((restaurant) => {
                    const similarity = sortTerm ? calculateSimilarity(restaurant.name, sortTerm) : 0;
                    const isLikelyMatch = similarity > 0.5;
                    const badge =
                      getRestaurantAwardBadge(restaurant.award) ?? getRestaurantSourceBadge(restaurant.source);
                    return (
                      <RestaurantRowCard
                        key={restaurant.id}
                        onPress={() => {
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          onSelect(restaurant);
                          handleClose();
                        }}
                        title={restaurant.name}
                        subtitle={restaurant.cuisine ?? restaurant.address}
                        supportingText={restaurant.cuisine && restaurant.address ? restaurant.address : null}
                        variant={"selection"}
                        source={restaurant.source}
                        badge={badge}
                        rightAccessory={
                          <View className={"items-end gap-2"}>
                            {isLikelyMatch ? <MatchPill /> : null}
                            {restaurant.distance !== undefined ? (
                              <ThemedText variant={"caption1"} color={"tertiary"}>
                                {formatRestaurantDistance(restaurant.distance)}
                              </ThemedText>
                            ) : null}
                          </View>
                        }
                      />
                    );
                  })}
                </View>
              )}
            </Animated.View>
          )}

          {/* Google Results */}
          {showGoogle && (
            <Animated.View entering={FadeIn} className={"gap-4"}>
              <View className={"flex-row items-center gap-2"}>
                <Pressable onPress={() => setShowGoogle(false)}>
                  <IconSymbol name={"chevron.left"} size={20} color={"#6b7280"} />
                </Pressable>
                <ThemedText variant={"subhead"} color={"secondary"} className={"font-medium"}>
                  Google Maps Results
                  {sortTerm && (
                    <ThemedText variant={"caption2"} color={"tertiary"}>
                      {" "}
                      (sorted by match)
                    </ThemedText>
                  )}
                </ThemedText>
              </View>

              {googleOptions.length === 0 ? (
                <View className={"py-8 items-center gap-2"}>
                  <ThemedText variant={"body"} color={"tertiary"} className={"text-center"}>
                    No restaurants found nearby
                  </ThemedText>
                </View>
              ) : (
                <View className={"gap-3"}>
                  {googleOptions.map((restaurant) => {
                    const similarity = sortTerm ? calculateSimilarity(restaurant.name, sortTerm) : 0;
                    const isLikelyMatch = similarity > 0.5;
                    const priceString = formatPriceLevel(restaurant.priceLevel);
                    return (
                      <RestaurantRowCard
                        key={restaurant.id}
                        onPress={() => {
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          onSelect(restaurant);
                          handleClose();
                        }}
                        title={restaurant.name}
                        subtitle={restaurant.address}
                        supportingText={
                          restaurant.rating !== undefined
                            ? `${restaurant.rating.toFixed(1)}${priceString ? ` · ${priceString}` : ""}`
                            : priceString
                        }
                        variant={"selection"}
                        source={"google"}
                        badge={getRestaurantSourceBadge("google")}
                        rightAccessory={isLikelyMatch ? <MatchPill /> : undefined}
                      />
                    );
                  })}
                </View>
              )}
            </Animated.View>
          )}
        </ScrollView>

        {/* Fixed Google Search Button at bottom */}
        {!showGoogle && (
          <View className={"absolute bottom-0 left-0 right-0 p-4 bg-background border-t border-white/10"}>
            {googleMapsApiKey ? (
              <Button onPress={handleSearchGoogle} variant={"secondary"} loading={searchingGoogle}>
                <ButtonText variant={"secondary"}>
                  {searchingGoogle ? "Searching..." : "Search Google Maps Instead"}
                </ButtonText>
              </Button>
            ) : (
              <View className={"items-center gap-1 py-2"}>
                <ThemedText variant={"footnote"} color={"tertiary"} className={"text-center"}>
                  Set a Google Maps API key in Settings to search Google Maps
                </ThemedText>
              </View>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

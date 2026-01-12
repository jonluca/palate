import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card, Button, ButtonText } from "@/components/ui";
import { useUnifiedNearbyRestaurants, useSearchNearbyRestaurants, type NearbyRestaurant } from "@/hooks";
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

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters).toLocaleString()}m`;
  }
  const km = meters / 1000;
  return `${km.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}km`;
}

export function getMichelinBadge(award: string): { emoji: string; label: string } | null {
  if (!award) {
    return null;
  }
  const lowerAward = award.toLowerCase();
  if (lowerAward.includes("3 star")) {
    return { emoji: "⭐⭐⭐", label: "3 Michelin Stars" };
  }
  if (lowerAward.includes("2 star")) {
    return { emoji: "⭐⭐", label: "2 Michelin Stars" };
  }
  if (lowerAward.includes("1 star")) {
    return { emoji: "⭐", label: "1 Michelin Star" };
  }
  if (lowerAward.includes("bib")) {
    return { emoji: "🍽️", label: "Bib Gourmand" };
  }
  if (lowerAward.includes("selected")) {
    return { emoji: "🏆", label: "Michelin Selected" };
  }
  return null;
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
  centerLat: number;
  centerLon: number;
  visit: VisitRecord;
}

export function RestaurantSearchModal({
  visible,
  onClose,
  onSelect,
  centerLat,
  centerLon,
  visit,
}: RestaurantSearchModalProps) {
  const [searchingGoogle, setSearchingGoogle] = useState(false);
  const [googleResults, setGoogleResults] = useState<PlaceResult[]>([]);
  const [showGoogle, setShowGoogle] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const scrollViewRef = useRef<ScrollView>(null);
  const searchInputRef = useRef<TextInput>(null);
  const googleMapsApiKey = useGoogleMapsApiKey();

  // Use unified hook for Michelin + MapKit results
  const { data: unifiedRestaurants, isLoading: isLoadingNearby } = useUnifiedNearbyRestaurants(
    centerLat,
    centerLon,
    500, // Michelin radius
    200, // MapKit radius
    visible,
  );

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

    return sortBySimilarity(filtered, sortTerm);
  }, [unifiedRestaurants, sortTerm, searchQuery]);

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
                  {nearbyOptions.map((restaurant, idx) => {
                    const badge = restaurant.award ? getMichelinBadge(restaurant.award) : null;
                    const similarity = sortTerm ? calculateSimilarity(restaurant.name, sortTerm) : 0;
                    const isLikelyMatch = similarity > 0.5;
                    return (
                      <Pressable
                        key={`${restaurant.id}-${idx}`}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          onSelect(restaurant);
                          handleClose();
                        }}
                      >
                        <Card animated={false}>
                          <View className={"p-3 gap-1"}>
                            <View className={"flex-row items-start justify-between"}>
                              <View className={"flex-1"}>
                                <View className={"flex-row items-center gap-2"}>
                                  <ThemedText variant={"subhead"} className={"font-medium"}>
                                    {restaurant.name}
                                  </ThemedText>
                                  {isLikelyMatch && (
                                    <View className={"bg-emerald-500/20 px-1.5 py-0.5 rounded"}>
                                      <ThemedText variant={"caption2"} className={"text-emerald-400"}>
                                        Match
                                      </ThemedText>
                                    </View>
                                  )}
                                </View>
                                {restaurant.cuisine && (
                                  <ThemedText variant={"footnote"} color={"tertiary"}>
                                    {restaurant.cuisine}
                                  </ThemedText>
                                )}
                                {!restaurant.cuisine && restaurant.address && (
                                  <ThemedText variant={"footnote"} color={"tertiary"} numberOfLines={1}>
                                    {restaurant.address}
                                  </ThemedText>
                                )}
                              </View>
                              {restaurant.distance !== undefined && (
                                <ThemedText variant={"footnote"} color={"tertiary"}>
                                  {formatDistance(restaurant.distance)}
                                </ThemedText>
                              )}
                            </View>
                            {badge && (
                              <View className={"flex-row items-center gap-1 mt-1"}>
                                <ThemedText variant={"caption1"}>{badge.emoji}</ThemedText>
                                <ThemedText variant={"caption2"} color={"secondary"}>
                                  {badge.label}
                                </ThemedText>
                              </View>
                            )}
                          </View>
                        </Card>
                      </Pressable>
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
                      <Pressable
                        key={restaurant.id}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          onSelect(restaurant);
                          handleClose();
                        }}
                      >
                        <Card animated={false}>
                          <View className={"p-3 gap-1"}>
                            <View className={"flex-row items-start justify-between"}>
                              <View className={"flex-1"}>
                                <View className={"flex-row items-center gap-2"}>
                                  <ThemedText variant={"subhead"} className={"font-medium"}>
                                    {restaurant.name}
                                  </ThemedText>
                                  {isLikelyMatch && (
                                    <View className={"bg-emerald-500/20 px-1.5 py-0.5 rounded"}>
                                      <ThemedText variant={"caption2"} className={"text-emerald-400"}>
                                        Match
                                      </ThemedText>
                                    </View>
                                  )}
                                </View>
                                {restaurant.address && (
                                  <ThemedText variant={"footnote"} color={"tertiary"} numberOfLines={1}>
                                    {restaurant.address}
                                  </ThemedText>
                                )}
                              </View>
                              <View className={"items-end"}>
                                {restaurant.rating !== undefined && (
                                  <View className={"flex-row items-center gap-1"}>
                                    <ThemedText variant={"footnote"} className={"text-amber-400"}>
                                      ★
                                    </ThemedText>
                                    <ThemedText variant={"footnote"} color={"secondary"}>
                                      {restaurant.rating.toFixed(1)}
                                    </ThemedText>
                                  </View>
                                )}
                                {priceString && (
                                  <ThemedText variant={"caption2"} color={"tertiary"}>
                                    {priceString}
                                  </ThemedText>
                                )}
                              </View>
                            </View>
                          </View>
                        </Card>
                      </Pressable>
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

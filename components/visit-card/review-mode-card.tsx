import { cn } from "@/utils/cn";
import { IconSymbol } from "@/components/icon-symbol";
import { Card } from "@/components/ui";
import { ThemedText } from "@/components/themed-text";
import { cleanCalendarEventTitle, isFuzzyRestaurantMatch } from "@/services/calendar";
import * as Haptics from "expo-haptics";
import React, { useState, useEffect, useMemo } from "react";
import { Pressable, View, ScrollView } from "react-native";
import { PhotoPreview } from "./photo-preview";
import { CalendarBadge, NearbyRestaurantsBadge, ExactMatchBadge, AppleMapsVerifiedBadge } from "./badges";
import { VisitActions } from "./visit-actions";
import { formatDate, formatTime, formatDistance, getMichelinBadge } from "./utils";
import { useAppleMapsSearch } from "@/hooks/use-apple-maps-search";
import type { ReviewModeProps, SuggestedRestaurant } from "./types";

export function ReviewModeCard({
  id,
  startTime,
  photoCount,
  previewPhotos = [],
  foodProbable = false,
  calendarEventTitle,
  onPress,
  index: _index = 0,
  suggestedRestaurantName,
  suggestedRestaurantAward,
  suggestedRestaurantCuisine,
  suggestedRestaurants = [],
  hasSuggestion = false,
  isLoading = false,
  onConfirm,
  onReject,
  onFindRestaurant,
  centerLat,
  centerLon,
  enableAppleMapsVerification = false,
  match,
}: ReviewModeProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset selected index when card identity changes (handles FlashList recycling)
  useEffect(() => {
    setSelectedIndex(0);
  }, [id]);

  // When we have an exact match, use that directly - no need for suggestions
  const hasMatch = Boolean(match);

  // Apple Maps search and merge with Michelin suggestions (only when enabled and no match)
  const appleMapsSearch = useAppleMapsSearch(
    suggestedRestaurants,
    centerLat ?? suggestedRestaurants[0]?.latitude ?? 0,
    centerLon ?? suggestedRestaurants[0]?.longitude ?? 0,
    enableAppleMapsVerification && !hasMatch,
  );

  // Use merged restaurants when Apple Maps search is enabled, otherwise use original
  const unsortedDisplayRestaurants = enableAppleMapsVerification
    ? appleMapsSearch.mergedRestaurants
    : suggestedRestaurants.map((r) => ({ ...r, source: "michelin" as const, isVerified: false }));

  // Sort restaurants by match likelihood: name match with calendar event first, then distance
  const displayRestaurants = useMemo(() => {
    if (!calendarEventTitle || unsortedDisplayRestaurants.length === 0) {
      return unsortedDisplayRestaurants;
    }

    const cleanedTitle = cleanCalendarEventTitle(calendarEventTitle);

    return [...unsortedDisplayRestaurants].sort((a, b) => {
      const aMatches = isFuzzyRestaurantMatch(a.name, cleanedTitle);
      const bMatches = isFuzzyRestaurantMatch(b.name, cleanedTitle);

      // First priority: name match with calendar event
      if (aMatches && !bMatches) {
        return -1;
      }
      if (!aMatches && bMatches) {
        return 1;
      }

      // If both match, prioritize Michelin restaurants
      if (aMatches && bMatches) {
        const aIsMichelin = a.source === "michelin";
        const bIsMichelin = b.source === "michelin";
        if (aIsMichelin && !bIsMichelin) {
          return -1;
        }
        if (!aIsMichelin && bIsMichelin) {
          return 1;
        }
      }

      // Finally, sort by distance
      return a.distance - b.distance;
    });
  }, [unsortedDisplayRestaurants, calendarEventTitle]);

  const hasMultipleSuggestions = !hasMatch && displayRestaurants.length > 1;
  const hasSingleSuggestion = !hasMatch && hasSuggestion && displayRestaurants.length === 1;
  const isVerifying = appleMapsSearch.isLoading;
  const appleMapsCount = appleMapsSearch.appleMapsCount;
  const michelinCount = displayRestaurants.filter((r) => r.source === "michelin").length;

  // Determine what to display based on match vs suggestions
  const selectedRestaurant = hasMultipleSuggestions ? displayRestaurants[selectedIndex] : null;

  // Find matched restaurant details from suggestions if we have a match
  const matchedRestaurant = hasMatch ? suggestedRestaurants.find((r) => r.id === match?.restaurantId) : null;

  // Display values: match takes priority, then selected restaurant, then primary suggestion
  const displayName = hasMatch ? match?.restaurantName : (selectedRestaurant?.name ?? suggestedRestaurantName);
  const displayAward = hasMatch ? matchedRestaurant?.award : (selectedRestaurant?.award ?? suggestedRestaurantAward);
  const displayCuisine = hasMatch
    ? matchedRestaurant?.cuisine
    : (selectedRestaurant?.cuisine ?? suggestedRestaurantCuisine);

  const badge = displayAward ? getMichelinBadge(displayAward) : null;

  // Has any suggestion to confirm (match, selected, or single suggestion)
  const canConfirm = hasMatch || hasSuggestion || hasMultipleSuggestions;

  const handleViewVisit = (photoIndex?: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.(photoIndex);
  };

  const handleConfirm = () => {
    if (hasMatch && matchedRestaurant) {
      // Confirm with matched restaurant
      onConfirm?.(matchedRestaurant);
    } else if (selectedRestaurant) {
      // Convert merged restaurant back to SuggestedRestaurant format
      const restaurant: SuggestedRestaurant = {
        id: selectedRestaurant.id,
        name: selectedRestaurant.name,
        latitude: selectedRestaurant.latitude,
        longitude: selectedRestaurant.longitude,
        address: selectedRestaurant.address,
        location: selectedRestaurant.location,
        cuisine: selectedRestaurant.cuisine,
        award: selectedRestaurant.award,
        distance: selectedRestaurant.distance,
      };
      onConfirm?.(restaurant);
    } else {
      onConfirm?.();
    }
  };

  const handleReject = () => {
    onReject?.();
  };

  const handleSelectRestaurant = (idx: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedIndex(idx);
  };

  return (
    <View className={"mb-4"}>
      <Pressable onPress={() => handleViewVisit()}>
        <Card animated={false}>
          <PhotoPreview photos={previewPhotos} onPhotoPress={handleViewVisit} />

          <View className={"p-4 gap-3"}>
            {/* Date and Food Badge */}
            <View className={"flex-row items-center justify-between"}>
              <View>
                <ThemedText variant={"subhead"} className={"font-medium"}>
                  {formatDate(startTime)}
                </ThemedText>
                <ThemedText variant={"footnote"} color={"tertiary"}>
                  at {formatTime(startTime)} • {photoCount.toLocaleString()} photos
                </ThemedText>
              </View>
              <View className={"flex-row items-center gap-2"}>
                {Boolean(foodProbable) && (
                  <View className={"flex-row items-center gap-1 bg-amber-500/10 px-2 py-1 rounded-full"}>
                    <ThemedText variant={"caption1"}>🍽️</ThemedText>
                    <ThemedText variant={"caption2"} className={"text-amber-600"}>
                      Food Detected
                    </ThemedText>
                  </View>
                )}
                <IconSymbol name={"chevron.right"} size={16} color={"gray"} />
              </View>
            </View>

            {/* Badges row */}
            <View className={"flex-row items-center gap-2 flex-1 overflow-x-auto"}>
              {calendarEventTitle && <CalendarBadge title={calendarEventTitle} />}
              {hasMatch && <ExactMatchBadge />}
              {hasMultipleSuggestions && <NearbyRestaurantsBadge count={displayRestaurants.length} />}
              {!hasMatch && (isVerifying || appleMapsCount > 0) && <AppleMapsVerifiedBadge isLoading={isVerifying} />}
            </View>

            {/* Exact Match Card - shown when we have a calendar match */}
            {hasMatch && (
              <View className={"rounded-xl p-3 gap-2 bg-green-500/10"}>
                <View className={"flex-row items-center gap-2"}>
                  <View className={"w-6 h-6 rounded-full bg-green-500/20 items-center justify-center"}>
                    <IconSymbol name={"checkmark.seal.fill"} size={14} color={"#22c55e"} />
                  </View>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    Calendar Match Found
                  </ThemedText>
                </View>
                <ThemedText numberOfLines={1} variant={"heading"} className={"font-semibold"}>
                  {displayName}
                </ThemedText>
                {badge && (
                  <View className={"flex-row items-center gap-1"}>
                    <ThemedText variant={"caption1"}>{badge.emoji}</ThemedText>
                    <ThemedText variant={"caption2"} color={"secondary"}>
                      {badge.label}
                    </ThemedText>
                  </View>
                )}
                {displayCuisine && (
                  <ThemedText numberOfLines={1} variant={"footnote"} color={"tertiary"}>
                    {displayCuisine}
                  </ThemedText>
                )}
              </View>
            )}

            {/* Multiple Suggestions Picker - only when no match */}
            {hasMultipleSuggestions && (
              <View className={"gap-2"}>
                <View className={"flex-row items-center gap-2"}>
                  <View className={"w-6 h-6 rounded-full bg-amber-500/20 items-center justify-center"}>
                    <IconSymbol name={"list.bullet"} size={14} color={"#f59e0b"} />
                  </View>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    {displayRestaurants.length.toLocaleString()} Nearby
                    {michelinCount > 0 && appleMapsCount > 0
                      ? ` (${michelinCount} Michelin, ${appleMapsCount} Apple Maps)`
                      : michelinCount > 0
                        ? " Michelin"
                        : " Apple Maps"}
                  </ThemedText>
                </View>
                <ScrollView
                  style={{ maxHeight: 260 }}
                  showsVerticalScrollIndicator={true}
                  nestedScrollEnabled={true}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {displayRestaurants.map((restaurant, idx) => {
                    const isSelected = idx === selectedIndex;
                    const restaurantBadge = getMichelinBadge(restaurant.award);
                    const isMichelin = restaurant.source === "michelin";
                    const isAppleMaps = restaurant.source === "apple-maps";
                    const isVerified = restaurant.isVerified;
                    return (
                      <Pressable
                        key={`${restaurant.id}-${idx}`}
                        onPress={() => handleSelectRestaurant(idx)}
                        className={cn(
                          "rounded-xl p-3 border-2",
                          isSelected
                            ? "bg-green-500/15 border-green-500/30"
                            : isAppleMaps
                              ? "bg-blue-500/5 border-blue-500/10"
                              : isVerified
                                ? "bg-amber-500/5 border-amber-500/20"
                                : "bg-card border-transparent",
                        )}
                      >
                        <View className={"flex-row items-start justify-between"}>
                          <View className={"flex-1 gap-1"}>
                            <View className={"flex-row items-center gap-2"}>
                              {isSelected && <IconSymbol name={"checkmark.circle.fill"} size={16} color={"#22c55e"} />}
                              <ThemedText variant={"subhead"} className={"font-medium flex-1"} numberOfLines={1}>
                                {restaurant.name}
                              </ThemedText>
                              {isAppleMaps && (
                                <View
                                  className={"flex-row items-center gap-1 bg-blue-500/15 px-1.5 py-0.5 rounded-full"}
                                >
                                  <IconSymbol name={"map.fill"} size={8} color={"#3b82f6"} />
                                </View>
                              )}
                              {isMichelin && isVerified && (
                                <View
                                  className={"flex-row items-center gap-1 bg-green-500/15 px-1.5 py-0.5 rounded-full"}
                                >
                                  <IconSymbol name={"checkmark.seal.fill"} size={8} color={"#22c55e"} />
                                </View>
                              )}
                            </View>
                            <View className={"flex-row items-center gap-2 flex-wrap"}>
                              {restaurantBadge && (
                                <View className={"flex-row items-center gap-1"}>
                                  <ThemedText variant={"caption1"}>{restaurantBadge.emoji}</ThemedText>
                                  <ThemedText variant={"caption2"} color={"secondary"}>
                                    {restaurantBadge.label}
                                  </ThemedText>
                                </View>
                              )}
                              {isAppleMaps && !restaurantBadge && (
                                <ThemedText variant={"caption2"} className={"text-blue-500"}>
                                  Apple Maps
                                </ThemedText>
                              )}
                            </View>
                            {restaurant.cuisine && (
                              <ThemedText variant={"caption2"} color={"tertiary"}>
                                {restaurant.cuisine}
                              </ThemedText>
                            )}
                          </View>
                          <ThemedText variant={"caption2"} color={"tertiary"}>
                            {formatDistance(restaurant.distance)}
                          </ThemedText>
                        </View>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            {/* Single Suggestion - only when no match and exactly one suggestion */}
            {hasSingleSuggestion && (
              <View
                className={cn(
                  "rounded-xl p-3 gap-2",
                  displayRestaurants[0].source === "michelin" ? "bg-green-500/10" : "bg-blue-500/10",
                )}
              >
                <View className={"flex-row items-center justify-between"}>
                  <View className={"flex-row items-center gap-2"}>
                    <View
                      className={cn(
                        "w-6 h-6 rounded-full items-center justify-center",
                        displayRestaurants[0].source === "michelin" ? "bg-green-500/20" : "bg-blue-500/20",
                      )}
                    >
                      <IconSymbol
                        name={displayRestaurants[0].source === "michelin" ? "star.fill" : "map.fill"}
                        size={14}
                        color={displayRestaurants[0].source === "michelin" ? "#22c55e" : "#3b82f6"}
                      />
                    </View>
                    <ThemedText variant={"footnote"} color={"secondary"}>
                      {displayRestaurants[0].source === "michelin" ? "Michelin Match Found" : "Apple Maps Restaurant"}
                    </ThemedText>
                  </View>
                  {displayRestaurants[0].isVerified && displayRestaurants[0].source === "michelin" && (
                    <View className={"flex-row items-center gap-1 bg-blue-500/15 px-2 py-0.5 rounded-full"}>
                      <IconSymbol name={"checkmark.seal.fill"} size={10} color={"#22c55e"} />
                      <ThemedText variant={"caption2"} className={"text-green-500"}>
                        Verified
                      </ThemedText>
                    </View>
                  )}
                </View>
                <ThemedText numberOfLines={1} variant={"heading"} className={"font-semibold"}>
                  {displayName}
                </ThemedText>
                {badge && (
                  <View className={"flex-row items-center gap-1"}>
                    <ThemedText variant={"caption1"}>{badge.emoji}</ThemedText>
                    <ThemedText variant={"caption2"} color={"secondary"}>
                      {badge.label}
                    </ThemedText>
                  </View>
                )}
                {displayCuisine && (
                  <ThemedText numberOfLines={1} variant={"footnote"} color={"tertiary"}>
                    {displayCuisine}
                  </ThemedText>
                )}
              </View>
            )}

            {/* Actions */}
            <VisitActions
              onSkip={handleReject}
              onConfirm={handleConfirm}
              onFindRestaurant={onFindRestaurant}
              hasSuggestion={canConfirm}
              isLoading={isLoading}
              variant={"pill"}
            />

            {/* Alternative: Find Different - only shown when we have a suggestion */}
            {canConfirm && (
              <Pressable onPress={onFindRestaurant} className={"self-end"} hitSlop={8}>
                <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
                  Not this restaurant?
                </ThemedText>
              </Pressable>
            )}
          </View>
        </Card>
      </Pressable>
    </View>
  );
}

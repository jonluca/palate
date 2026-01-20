import { cn } from "@/utils/cn";
import { IconSymbol } from "@/components/icon-symbol";
import { Card, NearbyRestaurantsList } from "@/components/ui";
import { ThemedText } from "@/components/themed-text";
import { cleanCalendarEventTitle, isFuzzyRestaurantMatch } from "@/services/calendar";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Pressable, View } from "react-native";
import { PhotoPreview } from "./photo-preview";
import { CalendarBadge, NearbyRestaurantsBadge, ExactMatchBadge } from "./badges";
import { VisitActions } from "./visit-actions";
import { formatDate, formatTime, getMichelinBadge } from "./utils";
import { useUnifiedNearbyRestaurants, type NearbyRestaurant } from "@/hooks";
import type { ReviewModeProps, SuggestedRestaurant } from "./types";

export function ReviewModeCard({
  id,
  startTime,
  photoCount,
  previewPhotos = [],
  foodProbable = false,
  calendarEventTitle,
  onPress,
  suggestedRestaurantName,
  suggestedRestaurantAward,
  suggestedRestaurantCuisine,
  suggestedRestaurants = [],
  hasSuggestion = false,
  loadingAction = null,
  onConfirm,
  onReject,
  onFindRestaurant,
  centerLat,
  centerLon,
  enableAppleMapsVerification = false,
  match,
}: ReviewModeProps) {
  const [selectedRestaurant, setSelectedRestaurant] = useState<NearbyRestaurant | null>(null);

  // Reset selected restaurant when card identity changes (handles FlashList recycling)
  useEffect(() => {
    setSelectedRestaurant(null);
  }, [id]);

  // When we have an exact match, use that directly - no need for suggestions
  const hasMatch = Boolean(match);

  // Fetch nearby restaurants using unified hook (Michelin + MapKit)
  const shouldFetchNearby = enableAppleMapsVerification && !hasMatch && Boolean(centerLat) && Boolean(centerLon);
  const { data: unifiedRestaurants = [] } = useUnifiedNearbyRestaurants(centerLat, centerLon, shouldFetchNearby);

  // Use unified results when fetching is enabled, otherwise fall back to passed suggestedRestaurants
  const unsortedDisplayRestaurants: NearbyRestaurant[] = shouldFetchNearby
    ? unifiedRestaurants
    : suggestedRestaurants.map((r) => ({
        id: r.id,
        name: r.name,
        latitude: r.latitude,
        longitude: r.longitude,
        distance: r.distance,
        award: r.award || null,
        cuisine: r.cuisine,
        address: r.address,
        source: "michelin" as const,
      }));

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

  // Determine the currently selected restaurant from the list (or default to first)
  const currentSelectedRestaurant = hasMultipleSuggestions
    ? (selectedRestaurant ?? displayRestaurants[0] ?? null)
    : null;

  // Find matched restaurant details from suggestions if we have a match
  const matchedRestaurant = hasMatch ? suggestedRestaurants.find((r) => r.id === match?.restaurantId) : null;

  // Display values: match takes priority, then selected restaurant, then primary suggestion
  const displayName = hasMatch ? match?.restaurantName : (currentSelectedRestaurant?.name ?? suggestedRestaurantName);
  const displayAward = hasMatch
    ? matchedRestaurant?.award
    : (currentSelectedRestaurant?.award ?? suggestedRestaurantAward);
  const displayCuisine = hasMatch
    ? matchedRestaurant?.cuisine
    : (currentSelectedRestaurant?.cuisine ?? suggestedRestaurantCuisine);

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
    } else if (currentSelectedRestaurant) {
      // Convert NearbyRestaurant to SuggestedRestaurant format
      const restaurant: SuggestedRestaurant = {
        id: currentSelectedRestaurant.id,
        name: currentSelectedRestaurant.name,
        latitude: currentSelectedRestaurant.latitude,
        longitude: currentSelectedRestaurant.longitude,
        address: currentSelectedRestaurant.address ?? "",
        location: currentSelectedRestaurant.address ?? "",
        cuisine: currentSelectedRestaurant.cuisine ?? "",
        award: currentSelectedRestaurant.award ?? "",
        distance: currentSelectedRestaurant.distance,
      };
      onConfirm?.(restaurant);
    } else {
      onConfirm?.();
    }
  };

  const handleReject = () => {
    onReject?.();
  };

  const handleSelectRestaurant = useCallback((restaurant: NearbyRestaurant) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedRestaurant(restaurant);
  }, []);

  const handleDeepLink = useCallback((restaurant: NearbyRestaurant) => {
    // Navigate to restaurant detail page
    router.push(`/restaurant/${restaurant.id}`);
  }, []);

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
              <NearbyRestaurantsList
                restaurants={displayRestaurants}
                selectedRestaurant={currentSelectedRestaurant}
                onSelectRestaurant={handleSelectRestaurant}
                onDeepLink={handleDeepLink}
                variant={"compact"}
              />
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
              loadingAction={loadingAction}
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

import { Card, NearbyRestaurantsList, SwipeableCard, useUndo } from "@/components/ui";
import { RestaurantSearchModal, type RestaurantOption } from "@/components/restaurant-search-modal";
import { cleanCalendarEventTitle, isFuzzyRestaurantMatch } from "@/services/calendar";
import { useConfirmVisit, useQuickUpdateVisitStatus, useUndoVisitAction } from "@/hooks/queries";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Pressable, View } from "react-native";
import { PhotoPreview } from "./photo-preview";
import { VisitActions } from "./visit-actions";
import { VisitMetaHeader, BadgesRow, ExactMatchCard, NotThisRestaurantLink } from "./review-mode-components";
import { useUnifiedNearbyRestaurants, type NearbyRestaurant } from "@/hooks";
import type { ReviewModeProps, SuggestedRestaurant, LoadingAction } from "./types";

export function ReviewModeCard({ visit, match, enableAppleMapsVerification = false }: ReviewModeProps) {
  const [showSearch, setShowSearch] = useState(false);
  const [selectedRestaurant, setSelectedRestaurant] = useState<NearbyRestaurant | null>(null);

  // Mutations
  const confirmMutation = useConfirmVisit();
  const updateStatusMutation = useQuickUpdateVisitStatus();
  const undoMutation = useUndoVisitAction();
  const { showUndo } = useUndo();

  // Reset state when card identity changes (handles FlashList recycling)
  useEffect(() => {
    setShowSearch(false);
    setSelectedRestaurant(null);
  }, [visit.id]);

  // Extract visit properties for easier access
  const { id, startTime, photoCount, previewPhotos = [], foodProbable = false, calendarEventTitle } = visit;

  // When we have an exact match, use that directly - no need for suggestions
  const hasMatch = Boolean(match);

  // Fetch nearby restaurants using unified hook (Michelin from visit + MapKit when enabled)
  // The hook merges visit.suggestedRestaurants with MapKit results automatically
  const shouldFetchMapKit = enableAppleMapsVerification && !hasMatch;
  const { data: displayRestaurantsUnsorted = [] } = useUnifiedNearbyRestaurants(visit, shouldFetchMapKit);

  // Sort restaurants by match likelihood: name match with calendar event first, then distance
  const displayRestaurants = useMemo(() => {
    if (!calendarEventTitle || displayRestaurantsUnsorted.length === 0) {
      return displayRestaurantsUnsorted;
    }

    const cleanedTitle = cleanCalendarEventTitle(calendarEventTitle);

    return [...displayRestaurantsUnsorted].sort((a, b) => {
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
  }, [displayRestaurantsUnsorted, calendarEventTitle]);

  // Determine the currently selected restaurant from the list (or default to first)
  const currentSelectedRestaurant =
    selectedRestaurant ??
    (visit.suggestedRestaurantId
      ? (displayRestaurants.find((r) => r.id === visit.suggestedRestaurantId) ?? null)
      : null) ??
    displayRestaurants[0] ??
    null;

  // Find matched restaurant details from suggestions if we have a match
  // This lookup provides additional details (award, cuisine) not stored in the ExactCalendarMatch
  const matchedRestaurant = hasMatch ? displayRestaurantsUnsorted.find((r) => r.id === match?.restaurantId) : null;

  // Display values: match takes priority, then selected restaurant, then primary suggestion
  // When we have a match, always use match.restaurantName for the name
  // For award/cuisine, try matchedRestaurant first, then fall back to visit's suggested restaurant data
  const displayName = hasMatch ? match?.restaurantName : currentSelectedRestaurant?.name;
  const displayAward = hasMatch ? matchedRestaurant?.award : currentSelectedRestaurant?.award;
  const displayCuisine = hasMatch ? matchedRestaurant?.cuisine : currentSelectedRestaurant?.cuisine;

  // Has any suggestion to confirm (match, selected, or single suggestion)
  const canConfirm = hasMatch || Boolean(displayRestaurants.length);

  // Determine which action is currently loading
  const loadingAction: LoadingAction = confirmMutation.isPending
    ? "confirm"
    : updateStatusMutation.isPending
      ? "skip"
      : null;
  const isAnyLoading = loadingAction !== null;

  // Swipe is only enabled when we have a single clear suggestion
  const canSwipeConfirm = canConfirm;

  const handleViewVisit = useCallback(
    (photoIndex?: number) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (photoIndex !== undefined) {
        router.push(`/visit/${id}?photo=${photoIndex}`);
      } else {
        router.push(`/visit/${id}`);
      }
    },
    [id],
  );

  const handleConfirmSuggestion = useCallback(
    async (restaurant?: SuggestedRestaurant | NearbyRestaurant) => {
      // Determine the restaurant to confirm
      let restaurantToConfirm: { id: string; name: string; latitude: number; longitude: number } | null = null;

      if (restaurant) {
        // A specific restaurant was passed (from picker or match)
        restaurantToConfirm = {
          id: restaurant.id,
          name: restaurant.name,
          latitude: restaurant.latitude,
          longitude: restaurant.longitude,
        };
      } else if (match) {
        // Confirming the exact match
        restaurantToConfirm = {
          id: match.restaurantId,
          name: match.restaurantName,
          latitude: match.latitude,
          longitude: match.longitude,
        };
      } else if (currentSelectedRestaurant) {
        // Use the currently selected restaurant from the picker
        restaurantToConfirm = {
          id: currentSelectedRestaurant.id,
          name: currentSelectedRestaurant.name,
          latitude: currentSelectedRestaurant.latitude,
          longitude: currentSelectedRestaurant.longitude,
        };
      }

      if (!restaurantToConfirm) {
        return;
      }

      await confirmMutation.mutateAsync({
        visitId: id,
        restaurantId: restaurantToConfirm.id,
        restaurantName: restaurantToConfirm.name,
        latitude: restaurantToConfirm.latitude,
        longitude: restaurantToConfirm.longitude,
        startTime,
      });

      // Show undo banner
      showUndo({
        type: "confirm",
        visitId: id,
        message: `Confirmed ${restaurantToConfirm.name}`,
        onUndo: async () => {
          await undoMutation.mutateAsync({ visitId: id });
        },
      });
    },
    [match, currentSelectedRestaurant, id, startTime, confirmMutation, showUndo, undoMutation],
  );

  const handleReject = useCallback(async () => {
    await updateStatusMutation.mutateAsync({ visitId: id, newStatus: "rejected" });

    // Show undo banner
    showUndo({
      type: "reject",
      visitId: id,
      message: "Visit skipped",
      onUndo: async () => {
        await undoMutation.mutateAsync({ visitId: id });
      },
    });
  }, [id, updateStatusMutation, showUndo, undoMutation]);

  const handleSelectRestaurantFromModal = useCallback(
    async (restaurant: RestaurantOption) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await confirmMutation.mutateAsync({
        visitId: id,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        startTime,
      });

      // Show undo banner
      showUndo({
        type: "confirm",
        visitId: id,
        message: `Confirmed ${restaurant.name}`,
        onUndo: async () => {
          await undoMutation.mutateAsync({ visitId: id });
        },
      });
    },
    [id, startTime, confirmMutation, showUndo, undoMutation],
  );

  const handleConfirmButton = useCallback(() => {
    if (hasMatch) {
      // When we have a match, use the match data directly
      // The match contains the restaurant ID, name, and coordinates
      handleConfirmSuggestion();
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
      handleConfirmSuggestion(restaurant);
    } else {
      handleConfirmSuggestion();
    }
  }, [hasMatch, currentSelectedRestaurant, handleConfirmSuggestion]);

  const handleSelectRestaurantFromList = useCallback((restaurant: NearbyRestaurant) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedRestaurant(restaurant);
  }, []);

  return (
    <>
      <SwipeableCard
        cardKey={id}
        onSwipeLeft={handleReject}
        onSwipeRight={canSwipeConfirm ? () => handleConfirmSuggestion() : undefined}
        leftLabel={"Skip"}
        rightLabel={"Confirm"}
        enabled={!isAnyLoading}
      >
        <View className={"mb-4"}>
          <Pressable onPress={() => handleViewVisit()}>
            <Card animated={false}>
              <PhotoPreview photos={previewPhotos} onPhotoPress={handleViewVisit} />

              <View className={"p-4 gap-3"}>
                <VisitMetaHeader startTime={startTime} photoCount={photoCount} foodProbable={foodProbable} />

                <BadgesRow calendarEventTitle={calendarEventTitle} hasMatch={hasMatch} />

                {hasMatch ? (
                  <ExactMatchCard
                    displayName={displayName}
                    displayAward={displayAward}
                    displayCuisine={displayCuisine}
                  />
                ) : (
                  <NearbyRestaurantsList
                    restaurants={displayRestaurants}
                    selectedRestaurant={currentSelectedRestaurant}
                    onSelectRestaurant={handleSelectRestaurantFromList}
                    onAutoSelectRestaurant={setSelectedRestaurant}
                    calendarEventTitle={calendarEventTitle ?? undefined}
                    autoSelectOnAppleLoad={selectedRestaurant === null}
                    variant={"compact"}
                  />
                )}
                <VisitActions
                  onSkip={handleReject}
                  onConfirm={handleConfirmButton}
                  onFindRestaurant={() => setShowSearch(true)}
                  hasSuggestion={canConfirm}
                  loadingAction={loadingAction}
                  variant={"pill"}
                />

                {canConfirm && <NotThisRestaurantLink onPress={() => setShowSearch(true)} />}
              </View>
            </Card>
          </Pressable>
        </View>
      </SwipeableCard>

      <RestaurantSearchModal
        visible={showSearch}
        onClose={() => setShowSearch(false)}
        onSelect={handleSelectRestaurantFromModal}
        visit={visit}
      />
    </>
  );
}

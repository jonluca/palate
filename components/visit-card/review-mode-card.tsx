import { Card, NearbyRestaurantsList, SwipeableCard, useUndo } from "@/components/ui";
import { RestaurantSearchModal, type RestaurantOption } from "@/components/restaurant-search-modal";
import { AutoRestaurantSelector } from "@/components/restaurant-auto-selector";
import { useConfirmVisit, useQuickUpdateVisitStatus, useUndoVisitAction } from "@/hooks/queries";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Pressable, View } from "react-native";
import tzLookup from "tz-lookup";
import { PhotoPreview } from "./photo-preview";
import { VisitActions } from "./visit-actions";
import { VisitMetaHeader, BadgesRow, ExactMatchCard } from "./review-mode-components";
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

  const visitTimeZone = useMemo(() => {
    const explicitTimeZone = (visit as { timeZone?: string | null }).timeZone;
    if (explicitTimeZone) {
      return explicitTimeZone;
    }
    if (Number.isFinite(visit.centerLat) && Number.isFinite(visit.centerLon)) {
      try {
        return tzLookup(visit.centerLat, visit.centerLon);
      } catch {
        return null;
      }
    }
    return null;
  }, [visit]);

  // Determine which action is currently loading
  const loadingAction: LoadingAction = confirmMutation.isPending
    ? "confirm"
    : updateStatusMutation.isPending
      ? "skip"
      : null;
  const isAnyLoading = loadingAction !== null;

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
    [match, id, startTime, confirmMutation, showUndo, undoMutation],
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

  return (
    <AutoRestaurantSelector
      restaurants={displayRestaurantsUnsorted}
      calendarEventTitle={calendarEventTitle}
      selectedRestaurant={selectedRestaurant}
      onSelectedRestaurantChange={setSelectedRestaurant}
      hasExactMatch={hasMatch}
      selectionResetKey={visit.id}
    >
      {({ displayRestaurants, onSelectRestaurant }) => {
        const currentSelectedRestaurant =
          selectedRestaurant ??
          (visit.suggestedRestaurantId
            ? (displayRestaurants.find((r) => r.id === visit.suggestedRestaurantId) ?? null)
            : null) ??
          displayRestaurants[0] ??
          null;

        const matchedRestaurant = hasMatch
          ? displayRestaurantsUnsorted.find((r) => r.id === match?.restaurantId)
          : null;

        const displayName = hasMatch ? match?.restaurantName : currentSelectedRestaurant?.name;
        const displayAward = hasMatch ? matchedRestaurant?.award : currentSelectedRestaurant?.award;
        const displayCuisine = hasMatch ? matchedRestaurant?.cuisine : currentSelectedRestaurant?.cuisine;

        const canConfirm = hasMatch || Boolean(displayRestaurants.length);
        const canSwipeConfirm = canConfirm;

        const handleConfirmButton = () => {
          if (hasMatch) {
            handleConfirmSuggestion();
          } else if (currentSelectedRestaurant) {
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
        };

        const swipeRestaurant = hasMatch ? undefined : (currentSelectedRestaurant ?? undefined);

        const handleSelectRestaurantFromList = (restaurant: NearbyRestaurant) => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onSelectRestaurant(restaurant);
        };

        return (
          <>
            <SwipeableCard
              cardKey={id}
              onSwipeLeft={handleReject}
              onSwipeRight={canSwipeConfirm ? () => handleConfirmSuggestion(swipeRestaurant) : undefined}
              leftLabel={"Skip"}
              rightLabel={"Confirm"}
              enabled={!isAnyLoading}
            >
              <View className={"mb-4"}>
                <Pressable onPress={() => handleViewVisit()}>
                  <Card animated={false}>
                    <PhotoPreview photos={previewPhotos} onPhotoPress={handleViewVisit} />

                    <View className={"p-4 gap-3"}>
                      <VisitMetaHeader
                        startTime={startTime}
                        photoCount={photoCount}
                        foodProbable={foodProbable}
                        timeZone={visitTimeZone}
                      />

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
                          variant={"compact"}
                        />
                      )}
                      <VisitActions
                        onSkip={handleReject}
                        onConfirm={handleConfirmButton}
                        onFindRestaurant={() => setShowSearch(true)}
                        onNotThisRestaurant={() => setShowSearch(true)}
                        hasSuggestion={canConfirm}
                        loadingAction={loadingAction}
                        variant={"pill"}
                      />
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
      }}
    </AutoRestaurantSelector>
  );
}

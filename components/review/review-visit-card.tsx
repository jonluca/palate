import { RestaurantSearchModal, type RestaurantOption } from "@/components/restaurant-search-modal";
import { SwipeableCard, useUndo } from "@/components/ui";
import { VisitCard, type SuggestedRestaurant } from "@/components/visit-card";
import {
  useConfirmVisit,
  useQuickUpdateVisitStatus,
  useUndoVisitAction,
  type ExactCalendarMatch,
  type PendingVisitForReview,
} from "@/hooks/queries";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useState } from "react";

interface ReviewVisitCardProps {
  visit: PendingVisitForReview;
  index: number;
  match?: ExactCalendarMatch;
  enableAppleMapsVerification?: boolean;
}

/** Card for reviewing a visit with swipe actions and restaurant confirmation */
export function ReviewVisitCard({ visit, index, match, enableAppleMapsVerification = false }: ReviewVisitCardProps) {
  const [showSearch, setShowSearch] = useState(false);
  const confirmMutation = useConfirmVisit();
  const updateStatusMutation = useQuickUpdateVisitStatus();
  const undoMutation = useUndoVisitAction();
  const { showUndo } = useUndo();

  // Reset modal state when card identity changes (handles FlashList recycling)
  useEffect(() => {
    setShowSearch(false);
  }, [visit.id]);

  // If we have a match, use its restaurant info; otherwise use the visit's suggestion
  const hasSuggestion = match ? true : !!visit.suggestedRestaurantId && !!visit.suggestedRestaurantName;
  const hasMultipleSuggestions = !match && visit.suggestedRestaurants && visit.suggestedRestaurants.length > 1;

  const handleConfirmSuggestion = async (selectedRestaurant?: SuggestedRestaurant) => {
    // Determine the restaurant name for the undo message
    const restaurantName =
      selectedRestaurant?.name ?? match?.restaurantName ?? visit.suggestedRestaurantName ?? "restaurant";

    // If a restaurant was selected from the multiple suggestions picker
    if (selectedRestaurant) {
      await confirmMutation.mutateAsync({
        visitId: visit.id,
        restaurantId: selectedRestaurant.id,
        restaurantName: selectedRestaurant.name,
        latitude: selectedRestaurant.latitude,
        longitude: selectedRestaurant.longitude,
        startTime: visit.startTime,
      });
    } else if (match) {
      // If we have an exact match, use its restaurant info
      await confirmMutation.mutateAsync({
        visitId: match.visitId,
        restaurantId: match.restaurantId,
        restaurantName: match.restaurantName,
        latitude: match.latitude,
        longitude: match.longitude,
        startTime: match.startTime,
      });
    } else if (visit.suggestedRestaurantId && visit.suggestedRestaurantName) {
      // Fall back to the primary suggestion
      await confirmMutation.mutateAsync({
        visitId: visit.id,
        restaurantId: visit.suggestedRestaurantId,
        restaurantName: visit.suggestedRestaurantName,
        latitude: visit.centerLat,
        longitude: visit.centerLon,
        startTime: visit.startTime,
      });
    } else {
      return;
    }

    // Show undo banner
    showUndo({
      type: "confirm",
      visitId: visit.id,
      message: `Confirmed ${restaurantName}`,
      onUndo: async () => {
        await undoMutation.mutateAsync({ visitId: visit.id });
      },
    });
  };

  const handleReject = async () => {
    await updateStatusMutation.mutateAsync({ visitId: visit.id, newStatus: "rejected" });

    // Show undo banner
    showUndo({
      type: "reject",
      visitId: visit.id,
      message: "Visit skipped",
      onUndo: async () => {
        await undoMutation.mutateAsync({ visitId: visit.id });
      },
    });
  };

  const handleSelectRestaurant = async (restaurant: RestaurantOption) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await confirmMutation.mutateAsync({
      visitId: visit.id,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      startTime: visit.startTime,
    });

    // Show undo banner
    showUndo({
      type: "confirm",
      visitId: visit.id,
      message: `Confirmed ${restaurant.name}`,
      onUndo: async () => {
        await undoMutation.mutateAsync({ visitId: visit.id });
      },
    });
  };

  const handleViewVisit = (photoIndex?: number) => {
    if (photoIndex !== undefined) {
      router.push(`/visit/${visit.id}?photo=${photoIndex}`);
    } else {
      router.push(`/visit/${visit.id}`);
    }
  };

  const isLoading = confirmMutation.isPending || updateStatusMutation.isPending;

  // Use swipeable card for quick actions
  const canSwipeConfirm = hasSuggestion && !hasMultipleSuggestions;

  // Use match's restaurant name if available, otherwise use visit's suggestion
  const suggestedRestaurantName = match?.restaurantName ?? visit.suggestedRestaurantName;

  return (
    <>
      <SwipeableCard
        cardKey={visit.id}
        onSwipeLeft={handleReject}
        onSwipeRight={canSwipeConfirm ? () => handleConfirmSuggestion() : undefined}
        leftLabel={"Skip"}
        rightLabel={"Confirm"}
        enabled={!isLoading}
      >
        <VisitCard
          mode={"review"}
          id={visit.id}
          startTime={visit.startTime}
          photoCount={visit.photoCount}
          previewPhotos={visit.previewPhotos}
          foodProbable={visit.foodProbable}
          calendarEventTitle={visit.calendarEventTitle}
          calendarEventIsAllDay={visit.calendarEventIsAllDay}
          onPress={handleViewVisit}
          match={match}
          index={index}
          suggestedRestaurantName={suggestedRestaurantName}
          suggestedRestaurantAward={visit.suggestedRestaurantAward}
          suggestedRestaurantCuisine={visit.suggestedRestaurantCuisine}
          suggestedRestaurants={match ? undefined : visit.suggestedRestaurants}
          hasSuggestion={hasSuggestion || hasMultipleSuggestions}
          isLoading={isLoading}
          onConfirm={handleConfirmSuggestion}
          onReject={handleReject}
          onFindRestaurant={() => setShowSearch(true)}
          centerLat={visit.centerLat}
          centerLon={visit.centerLon}
          enableAppleMapsVerification={enableAppleMapsVerification && !match}
        />
      </SwipeableCard>

      <RestaurantSearchModal
        visible={showSearch}
        onClose={() => setShowSearch(false)}
        onSelect={handleSelectRestaurant}
        centerLat={visit.centerLat}
        centerLon={visit.centerLon}
        visit={visit}
      />
    </>
  );
}

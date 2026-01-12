import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { RestaurantSearchModal, type RestaurantOption } from "@/components/restaurant-search-modal";
import { Ionicons } from "@expo/vector-icons";
import {
  VisitHeader,
  CalendarEventCard,
  FoodDetectionCard,
  VisitDetailsCard,
  PhotosSection,
  NearbyRestaurantsCard,
  SuggestedRestaurantCard,
  NoMatchCard,
  VisitActionButtons,
  PhotoGalleryModal,
  MergeVisitsModal,
  NotesCard,
  type AggregatedFoodLabel,
} from "@/components/visit";
import {
  useVisitDetail,
  useUpdateVisitStatus,
  useUpdateVisitNotes,
  useConfirmVisit,
  useMergeableVisits,
  useMergeVisits,
  useIgnoreLocation,
  useScanVisitForFood,
  useReverseGeocode,
  useUnifiedNearbyRestaurants,
  type VisitStatus,
  type VisitFoodScanProgress,
  type NearbyRestaurant,
} from "@/hooks";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import type { FoodLabel } from "@/utils/db";
import { cleanCalendarEventTitle } from "@/services/calendar";
import { ActivityIndicator, View, Alert } from "react-native";
import { useToast } from "@/components/ui/toast";

// Hook to aggregate food labels from photos
function useAggregatedFoodLabels(
  photos: Array<{ foodDetected?: boolean | null; foodLabels?: FoodLabel[] | null }>,
): AggregatedFoodLabel[] {
  return useMemo(() => {
    const labelMap = new Map<string, { maxConfidence: number; photoCount: number }>();

    for (const photo of photos) {
      if (!photo.foodDetected || !photo.foodLabels) {
        continue;
      }

      for (const label of photo.foodLabels as FoodLabel[]) {
        const existing = labelMap.get(label.label);
        if (existing) {
          existing.maxConfidence = Math.max(existing.maxConfidence, label.confidence);
          existing.photoCount++;
        } else {
          labelMap.set(label.label, {
            maxConfidence: label.confidence,
            photoCount: 1,
          });
        }
      }
    }

    return Array.from(labelMap.entries())
      .map(([label, data]) => ({ label, ...data }))
      .sort((a, b) => b.maxConfidence - a.maxConfidence)
      .slice(0, 8);
  }, [photos]);
}

export default function VisitDetailScreen() {
  const { id, photo } = useLocalSearchParams<{ id: string; photo?: string }>();
  const initialPhotoIndex = photo !== undefined ? parseInt(photo, 10) : null;
  const [galleryIndex, setGalleryIndex] = useState<number | null>(initialPhotoIndex);
  const [showSearch, setShowSearch] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [selectedRestaurantIndex, setSelectedRestaurantIndex] = useState(0);
  const [foodScanProgress, setFoodScanProgress] = useState<VisitFoodScanProgress | null>(null);
  const { showToast } = useToast();

  // React Query hooks
  const { data, isLoading } = useVisitDetail(id);
  const updateStatus = useUpdateVisitStatus(id);
  const updateNotes = useUpdateVisitNotes(id);
  const confirmVisit = useConfirmVisit();
  const mergeVisits = useMergeVisits();
  const ignoreLocation = useIgnoreLocation();
  const scanForFood = useScanVisitForFood(id, setFoodScanProgress);

  // Get mergeable visits when modal is open
  const { data: mergeableVisits = [], isLoading: isMergeableLoading } = useMergeableVisits(
    id,
    data?.visit?.startTime,
    showMergeModal,
  );

  // Fetch nearby restaurants using unified hook (Michelin + MapKit)
  const shouldFetchNearby = data?.visit?.status === "pending" && !data?.restaurant;
  const { data: suggestedRestaurants = [] } = useUnifiedNearbyRestaurants(
    data?.visit?.centerLat,
    data?.visit?.centerLon,
    500, // Michelin radius
    200, // MapKit radius
    shouldFetchNearby,
  );

  // Reverse geocode the location for display when no restaurant is matched
  const needsGeocode = !data?.restaurant && !data?.suggestedRestaurant && !data?.visit?.calendarEventTitle;
  const { data: geocodedLocation } = useReverseGeocode(data?.visit?.centerLat, data?.visit?.centerLon, needsGeocode);

  // Aggregate food labels
  const aggregatedFoodLabels = useAggregatedFoodLabels(data?.photos ?? []);

  const handleStatusChange = useCallback(
    async (newStatus: VisitStatus) => {
      Haptics.notificationAsync(
        newStatus === "confirmed"
          ? Haptics.NotificationFeedbackType.Success
          : newStatus === "rejected"
            ? Haptics.NotificationFeedbackType.Warning
            : Haptics.NotificationFeedbackType.Success,
      );

      try {
        await updateStatus.mutateAsync(newStatus);
        if (newStatus !== "pending") {
          router.back();
        }
      } catch (error) {
        console.error("Error updating visit:", error);
      }
    },
    [updateStatus],
  );

  const handleConfirmWithSuggestion = useCallback(async () => {
    if (!data?.visit) {
      return;
    }

    const hasMultipleNearby = suggestedRestaurants.length > 1;
    const selectedNearby = hasMultipleNearby ? suggestedRestaurants[selectedRestaurantIndex] : null;
    const restaurantToConfirm = selectedNearby ?? data.suggestedRestaurant;

    if (!restaurantToConfirm) {
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    try {
      await confirmVisit.mutateAsync({
        visitId: data.visit.id,
        restaurantId: restaurantToConfirm.id,
        restaurantName: restaurantToConfirm.name,
        latitude: restaurantToConfirm.latitude,
        longitude: restaurantToConfirm.longitude,
      });
      router.back();
    } catch (error) {
      console.error("Error confirming visit:", error);
    }
  }, [data, confirmVisit, suggestedRestaurants, selectedRestaurantIndex]);

  const handleSelectRestaurant = useCallback(
    async (restaurant: RestaurantOption) => {
      if (!data?.visit) {
        return;
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      try {
        await confirmVisit.mutateAsync({
          visitId: data.visit.id,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          latitude: restaurant.latitude,
          longitude: restaurant.longitude,
        });
        router.back();
      } catch (error) {
        console.error("Error confirming visit:", error);
      }
    },
    [data, confirmVisit],
  );

  const handleMergeVisit = useCallback(
    async (sourceVisit: { id: string }) => {
      if (!data?.visit) {
        return;
      }

      try {
        await mergeVisits.mutateAsync({
          targetVisitId: data.visit.id,
          sourceVisitId: sourceVisit.id,
        });
        setShowMergeModal(false);
        showToast({ type: "success", message: "Visits merged successfully" });
      } catch (error) {
        console.error("Error merging visits:", error);
        showToast({ type: "error", message: "Failed to merge visits. Please try again." });
      }
    },
    [data, mergeVisits, showToast],
  );

  const handleIgnoreLocation = useCallback(() => {
    if (!data?.visit) {
      return;
    }

    Alert.alert(
      "Ignore Location",
      "This will skip all visits at this location (within ~100m). Future visits here will also be skipped. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Ignore Location",
          style: "destructive",
          onPress: async () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            try {
              await ignoreLocation.mutateAsync({
                latitude: data.visit.centerLat,
                longitude: data.visit.centerLon,
                radius: 100,
                name: data.suggestedRestaurant?.name ?? data.visit.calendarEventTitle ?? null,
              });
              router.back();
            } catch (error) {
              console.error("Error ignoring location:", error);
              showToast({ type: "error", message: "Failed to ignore location. Please try again." });
            }
          },
        },
      ],
    );
  }, [data, ignoreLocation, showToast]);

  const handleScanForFood = useCallback(async () => {
    if (!data?.photos || data.photos.length === 0) {
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const result = await scanForFood.mutateAsync(data.photos.map((p) => ({ id: p.id })));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (result.foodPhotosFound > 0) {
        showToast({
          type: "success",
          message: `Found food in ${result.foodPhotosFound.toLocaleString()} of ${result.totalPhotos.toLocaleString()} photos!`,
        });
      } else {
        showToast({
          type: "info",
          message: `No food detected in ${result.totalPhotos.toLocaleString()} photos.`,
        });
      }
    } catch (error) {
      console.error("Error scanning for food:", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showToast({ type: "error", message: "Failed to scan photos for food. Please try again." });
    } finally {
      setFoodScanProgress(null);
    }
  }, [data?.photos, scanForFood, showToast]);

  const handleSaveNotes = useCallback(
    async (notes: string | null) => {
      try {
        await updateNotes.mutateAsync(notes);
        showToast({ type: "success", message: "Notes saved" });
      } catch (error) {
        console.error("Error saving notes:", error);
        showToast({ type: "error", message: "Failed to save notes" });
      }
    },
    [updateNotes, showToast],
  );

  if (isLoading) {
    return (
      <View className={"flex-1 bg-background items-center justify-center"}>
        <ActivityIndicator size={"large"} />
      </View>
    );
  }

  if (!data?.visit) {
    return (
      <ScreenLayout scrollable={false}>
        <View className={"flex-1 items-center justify-center gap-4"}>
          <ThemedText variant={"title2"} className={"font-semibold"}>
            Visit Not Found
          </ThemedText>
          <ThemedText variant={"body"} color={"secondary"} className={"text-center"}>
            This visit doesn't exist or has been deleted.
          </ThemedText>
          <Button onPress={() => router.back()} variant={"secondary"}>
            <ButtonText variant={"secondary"}>Go Back</ButtonText>
          </Button>
        </View>
      </ScreenLayout>
    );
  }

  const { visit, restaurant, suggestedRestaurant, photos } = data;
  const photoData = photos.map((p) => ({ id: p.id, uri: p.uri, foodLabels: p.foodLabels as FoodLabel[] | null }));
  const displayName =
    restaurant?.name ??
    suggestedRestaurant?.name ??
    (visit.calendarEventTitle ? cleanCalendarEventTitle(visit.calendarEventTitle) : null) ??
    geocodedLocation ??
    "Unknown Location";

  // Nearby restaurants are already in the correct format
  const nearbyRestaurantsForCard: NearbyRestaurant[] = suggestedRestaurants;

  const showNearbyRestaurants = visit.status === "pending" && !restaurant && suggestedRestaurants.length > 1;
  const showSuggestedRestaurant =
    visit.status === "pending" && suggestedRestaurant && !restaurant && suggestedRestaurants.length <= 1;
  const showNoMatch =
    visit.status === "pending" && !suggestedRestaurant && !restaurant && suggestedRestaurants.length === 0;

  // Check if any photos haven't been scanned for food yet
  const unscannedPhotosCount = photos.filter((p) => p.foodDetected === null).length;
  const showFoodScanCard = unscannedPhotosCount > 0;

  return (
    <>
      <ScreenLayout>
        <VisitHeader
          displayName={displayName}
          status={visit.status}
          startTime={visit.startTime}
          foodProbable={Boolean(visit.foodProbable)}
          award={suggestedRestaurant?.award}
        />

        <VisitDetailsCard
          startTime={visit.startTime}
          endTime={visit.endTime}
          photoCount={visit.photoCount}
          mergeableCount={mergeableVisits.length}
          onMergePress={() => setShowMergeModal(true)}
        />

        {showSuggestedRestaurant && (
          <SuggestedRestaurantCard
            name={suggestedRestaurant.name}
            award={suggestedRestaurant.award}
            cuisine={suggestedRestaurant.cuisine}
            address={suggestedRestaurant.address}
            onSearchPress={() => setShowSearch(true)}
          />
        )}

        {showNearbyRestaurants && (
          <NearbyRestaurantsCard
            restaurants={nearbyRestaurantsForCard}
            selectedIndex={selectedRestaurantIndex}
            onSelectIndex={setSelectedRestaurantIndex}
            onSearchPress={() => setShowSearch(true)}
          />
        )}

        {showNoMatch && <NoMatchCard onSearchPress={() => setShowSearch(true)} />}

        {visit.calendarEventTitle && (
          <CalendarEventCard title={visit.calendarEventTitle} location={visit.calendarEventLocation} />
        )}

        <PhotosSection photos={photoData} onPhotoPress={(index) => setGalleryIndex(index)} />

        {showFoodScanCard && (
          <Card delay={90}>
            <View className={"p-4 gap-3"}>
              <View className={"flex-row items-center justify-between"}>
                <View className={"flex-row items-center gap-2"}>
                  <View className={"w-7 h-7 rounded-full bg-emerald-500/20 items-center justify-center"}>
                    <Ionicons name={"scan"} size={16} color={"#10b981"} />
                  </View>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    {"Food Detection"}
                  </ThemedText>
                </View>
                <Button variant={"secondary"} size={"sm"} onPress={handleScanForFood} disabled={scanForFood.isPending}>
                  <ButtonText variant={"secondary"}>
                    {scanForFood.isPending
                      ? foodScanProgress
                        ? `${foodScanProgress.processedPhotos.toLocaleString()}/${foodScanProgress.totalPhotos.toLocaleString()}`
                        : "Starting..."
                      : "Scan Photos"}
                  </ButtonText>
                </Button>
              </View>
              <ThemedText variant={"caption1"} color={"tertiary"}>
                {scanForFood.isPending
                  ? `Analyzing photos for food... ${(foodScanProgress?.foodPhotosFound ?? 0).toLocaleString()} found so far`
                  : `${unscannedPhotosCount.toLocaleString()} of ${photos.length.toLocaleString()} photos haven't been scanned for food`}
              </ThemedText>
            </View>
          </Card>
        )}

        {Boolean(visit.foodProbable) && aggregatedFoodLabels.length > 0 && (
          <FoodDetectionCard labels={aggregatedFoodLabels} />
        )}

        <NotesCard notes={visit.notes} onSave={handleSaveNotes} isSaving={updateNotes.isPending} />

        <VisitActionButtons
          status={visit.status}
          hasSuggestion={Boolean(suggestedRestaurant)}
          nearbyCount={suggestedRestaurants.length}
          isLoading={updateStatus.isPending || confirmVisit.isPending || ignoreLocation.isPending}
          onStatusChange={handleStatusChange}
          onConfirmWithSuggestion={handleConfirmWithSuggestion}
          onFindRestaurant={() => setShowSearch(true)}
          onIgnoreLocation={handleIgnoreLocation}
        />
      </ScreenLayout>

      <RestaurantSearchModal
        visible={showSearch}
        onClose={() => setShowSearch(false)}
        onSelect={handleSelectRestaurant}
        centerLat={visit.centerLat}
        centerLon={visit.centerLon}
        visit={visit}
      />

      {galleryIndex !== null && (
        <PhotoGalleryModal
          visible={true}
          photos={photoData}
          currentIndex={galleryIndex}
          onIndexChange={setGalleryIndex}
          onClose={() => setGalleryIndex(null)}
        />
      )}

      <MergeVisitsModal
        visible={showMergeModal}
        isLoading={isMergeableLoading}
        visits={mergeableVisits}
        onMerge={handleMergeVisit}
        onClose={() => setShowMergeModal(false)}
      />
    </>
  );
}

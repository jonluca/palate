import { ScreenLayout } from "@/components/screen-layout";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { RestaurantSearchModal } from "@/components/restaurant-search-modal";
import { Ionicons } from "@expo/vector-icons";
import {
  VisitHeader,
  CalendarEventCard,
  FoodDetectionCard,
  PhotosSection,
  NearbyRestaurantsCard,
  SuggestedRestaurantCard,
  NoMatchCard,
  VisitActionButtons,
  PhotoGalleryModal,
  MergeVisitsModal,
  NotesCard,
  AllLabelsCard,
  type AggregatedFoodLabel,
  type LoadingAction,
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
  useAddPhotosToVisit,
  useRemovePhotosFromVisit,
  type VisitStatus,
  type VisitFoodScanProgress,
  type NearbyRestaurant,
} from "@/hooks";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { FoodLabel } from "@/utils/db";
import { cleanCalendarEventTitle } from "@/services/calendar";
import { logVisitViewed } from "@/services/analytics";
import { createAlbumWithPhotos } from "@/services/scanner";
import { ActivityIndicator, View, Alert, Pressable } from "react-native";
import { useToast } from "@/components/ui/toast";
import { useHasSeenAddPhotosAlert, useSetHasSeenAddPhotosAlert } from "@/store";

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

// Common shape for restaurants that can be confirmed
type ConfirmableRestaurant = Pick<NearbyRestaurant, "id" | "name" | "latitude" | "longitude">;

export default function VisitDetailScreen() {
  const { id, photo } = useLocalSearchParams<{ id: string; photo?: string }>();
  const initialPhotoIndex = photo !== undefined ? parseInt(photo, 10) : null;
  const [galleryIndex, setGalleryIndex] = useState<number | null>(initialPhotoIndex);
  const [showSearch, setShowSearch] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [selectedRestaurant, setSelectedRestaurant] = useState<NearbyRestaurant | null>(null);
  const [foodScanProgress, setFoodScanProgress] = useState<VisitFoodScanProgress | null>(null);
  const [loadingAction, setLoadingAction] = useState<LoadingAction>(null);
  const [isCreatingAlbum, setIsCreatingAlbum] = useState(false);
  const { showToast } = useToast();
  const hasSeenAddPhotosAlert = useHasSeenAddPhotosAlert();
  const setHasSeenAddPhotosAlert = useSetHasSeenAddPhotosAlert();

  // Track visit view
  useEffect(() => {
    if (id) {
      logVisitViewed(parseInt(id, 10) || 0);
    }
  }, [id]);

  // React Query hooks
  const { data, isLoading } = useVisitDetail(id);
  const updateStatus = useUpdateVisitStatus(id);
  const updateNotes = useUpdateVisitNotes(id);
  const confirmVisit = useConfirmVisit();
  const mergeVisits = useMergeVisits();
  const ignoreLocation = useIgnoreLocation();
  const scanForFood = useScanVisitForFood(id, setFoodScanProgress);
  const addPhotosToVisit = useAddPhotosToVisit(id);
  const removePhotosFromVisit = useRemovePhotosFromVisit(id);

  // Get mergeable visits when modal is open
  const { data: mergeableVisits = [], isLoading: isMergeableLoading } = useMergeableVisits(
    id,
    data?.visit?.startTime,
    showMergeModal,
  );

  // Fetch nearby restaurants using unified hook (Michelin + MapKit)
  // Pass visit data with coordinates and pre-computed suggested restaurants
  const shouldFetchNearby = data?.visit?.status === "pending" && !data?.restaurant;
  const visitForNearby = useMemo(() => {
    if (!data?.visit) {
      return undefined;
    }
    return {
      centerLat: data.visit.centerLat,
      centerLon: data.visit.centerLon,
      suggestedRestaurants: data.suggestedRestaurants,
    };
  }, [data?.visit, data?.suggestedRestaurants]);
  const { data: suggestedRestaurants = [] } = useUnifiedNearbyRestaurants(visitForNearby, shouldFetchNearby);

  // Reverse geocode the location for display when no restaurant is matched
  const needsGeocode = !data?.restaurant && !data?.suggestedRestaurant && !data?.visit?.calendarEventTitle;
  const { data: geocodedLocation } = useReverseGeocode(data?.visit?.centerLat, data?.visit?.centerLon, needsGeocode);

  // Aggregate food labels
  const aggregatedFoodLabels = useAggregatedFoodLabels(data?.photos ?? []);

  const handleStatusChange = useCallback(
    async (newStatus: VisitStatus) => {
      // Set loading action based on what's being done
      const action: LoadingAction = newStatus === "rejected" ? "skip" : newStatus === "confirmed" ? "confirm" : "skip";
      setLoadingAction(action);

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
      } finally {
        setLoadingAction(null);
      }
    },
    [updateStatus],
  );

  // Unified confirmation handler that takes the restaurant directly
  const handleConfirmRestaurant = useCallback(
    async (restaurant: ConfirmableRestaurant) => {
      if (!data?.visit) {
        return;
      }

      setLoadingAction("confirm");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      try {
        await confirmVisit.mutateAsync({
          visitId: data.visit.id,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          latitude: restaurant.latitude,
          longitude: restaurant.longitude,
          startTime: data.visit.startTime,
        });
        router.back();
      } catch (error) {
        console.error("Error confirming visit:", error);
      } finally {
        setLoadingAction(null);
      }
    },
    [data, confirmVisit],
  );

  // Derive the restaurant to confirm from state or fallback to suggested
  const restaurantToConfirm = selectedRestaurant ?? data?.suggestedRestaurant ?? null;

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

  const selectAndAddPhotos = useCallback(async () => {
    try {
      // Request media library permission
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        showToast({ type: "error", message: "Photo library permission is required to add photos" });
        return;
      }

      // Open image picker
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        quality: 1,
        orderedSelection: true,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Extract asset IDs from the selected images
      const assetIds = result.assets
        .map((asset) => asset.assetId)
        .filter((id): id is string => id !== null && id !== undefined);

      if (assetIds.length === 0) {
        showToast({
          type: "info",
          message: "Selected photos don't have asset IDs. Only photos from your camera roll can be added.",
        });
        return;
      }

      // Add the photos to this visit
      const moveResult = await addPhotosToVisit.mutateAsync(assetIds);

      if (moveResult.movedCount > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const movedFromOther = moveResult.fromVisitIds.length > 0;
        showToast({
          type: "success",
          message: movedFromOther
            ? `Added ${moveResult.movedCount.toLocaleString()} photo${moveResult.movedCount === 1 ? "" : "s"} (moved from ${moveResult.fromVisitIds.length} other visit${moveResult.fromVisitIds.length === 1 ? "" : "s"})`
            : `Added ${moveResult.movedCount.toLocaleString()} photo${moveResult.movedCount === 1 ? "" : "s"} to this visit`,
        });
      } else {
        showToast({
          type: "info",
          message: "No matching photos found in your library. Photos must be scanned first.",
        });
      }
    } catch (error) {
      console.error("Error adding photos:", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showToast({ type: "error", message: "Failed to add photos. Please try again." });
    }
  }, [addPhotosToVisit, showToast]);

  const handleAddPhotos = useCallback(async () => {
    // Only show the warning alert the first time
    if (!hasSeenAddPhotosAlert) {
      setHasSeenAddPhotosAlert(true);
      Alert.alert(
        "Add Photos to Visit",
        "Each photo can only be associated with one visit. If a selected photo is already linked to another visit, it will be moved to this visit.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Select Photos",
            onPress: selectAndAddPhotos,
          },
        ],
      );
    } else {
      // User has already seen the alert, go directly to photo picker
      await selectAndAddPhotos();
    }
  }, [hasSeenAddPhotosAlert, setHasSeenAddPhotosAlert, selectAndAddPhotos]);

  const handleRemovePhotos = useCallback(
    async (photoIds: string[]) => {
      if (photoIds.length === 0) {
        return;
      }

      // Show confirmation alert
      Alert.alert(
        "Remove Photos",
        `Remove ${photoIds.length} photo${photoIds.length === 1 ? "" : "s"} from this visit? The photos will remain in your library but won't be associated with this visit.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: async () => {
              try {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                const result = await removePhotosFromVisit.mutateAsync(photoIds);
                if (result.removedCount > 0) {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  showToast({
                    type: "success",
                    message: `Removed ${result.removedCount} photo${result.removedCount === 1 ? "" : "s"} from this visit`,
                  });
                }
              } catch (error) {
                console.error("Error removing photos:", error);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                showToast({ type: "error", message: "Failed to remove photos. Please try again." });
              }
            },
          },
        ],
      );
    },
    [removePhotosFromVisit, showToast],
  );

  const handleCreateAlbum = useCallback(async () => {
    if (!data?.photos || data.photos.length === 0) {
      return;
    }

    // Build the album name from the restaurant/visit info
    const albumName =
      data.restaurant?.name ??
      data.suggestedRestaurant?.name ??
      (data.visit?.calendarEventTitle ? cleanCalendarEventTitle(data.visit.calendarEventTitle) : null) ??
      `Visit ${new Date(data.visit?.startTime ?? Date.now()).toLocaleDateString()}`;

    Alert.alert("Create Album", `Create a Photos album named "${albumName}" with ${data.photos.length} photos?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Create Album",
        onPress: async () => {
          setIsCreatingAlbum(true);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

          try {
            const photoIds = data.photos.map((p) => p.id);
            const result = await createAlbumWithPhotos(albumName, photoIds);

            if (result.success) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast({
                type: "success",
                message: `Album "${albumName}" created with ${result.photoCount} photos`,
              });
            } else {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              showToast({
                type: "error",
                message: result.error ?? "Failed to create album",
              });
            }
          } catch (error) {
            console.error("Error creating album:", error);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            showToast({ type: "error", message: "Failed to create album. Please try again." });
          } finally {
            setIsCreatingAlbum(false);
          }
        },
      },
    ]);
  }, [data, showToast]);

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
          endTime={visit.endTime}
          foodProbable={Boolean(visit.foodProbable)}
          award={suggestedRestaurant?.award}
        />

        {visit.calendarEventTitle && (
          <CalendarEventCard title={visit.calendarEventTitle} location={visit.calendarEventLocation} />
        )}

        {showNoMatch && <NoMatchCard onSearchPress={() => setShowSearch(true)} />}

        {showSuggestedRestaurant && (
          <SuggestedRestaurantCard
            name={suggestedRestaurant.name}
            award={suggestedRestaurant.award}
            cuisine={suggestedRestaurant.cuisine}
            address={suggestedRestaurant.address}
            onSearchPress={() => setShowSearch(true)}
          />
        )}

        <NearbyRestaurantsCard
          isShowingSuggestedRestaurant={Boolean(showSuggestedRestaurant)}
          restaurants={nearbyRestaurantsForCard}
          selectedRestaurant={selectedRestaurant}
          onSelectRestaurant={setSelectedRestaurant}
          onSearchPress={() => setShowSearch(true)}
        />

        <VisitActionButtons
          status={visit.status}
          restaurantToConfirm={restaurantToConfirm}
          loadingAction={loadingAction}
          onStatusChange={handleStatusChange}
          onConfirmRestaurant={handleConfirmRestaurant}
          onFindRestaurant={() => setShowSearch(true)}
          onIgnoreLocation={handleIgnoreLocation}
        />
        <PhotosSection
          photos={photoData}
          onPhotoPress={(index) => setGalleryIndex(index)}
          onAddPhotos={handleAddPhotos}
          isAddingPhotos={addPhotosToVisit.isPending}
          onRemovePhotos={handleRemovePhotos}
          isRemovingPhotos={removePhotosFromVisit.isPending}
          onCreateAlbum={handleCreateAlbum}
          isCreatingAlbum={isCreatingAlbum}
        />

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

        <AllLabelsCard photos={photos} />

        {visit.status !== "pending" && (
          <Pressable
            onPress={() => handleStatusChange("pending")}
            disabled={loadingAction !== null}
            className={"flex-row items-center justify-center gap-2 py-4 mt-2"}
          >
            {loadingAction === "skip" ? (
              <ActivityIndicator size={"small"} color={"#9ca3af"} />
            ) : (
              <>
                <Ionicons name={"refresh"} size={14} color={"#9ca3af"} />
                <ThemedText variant={"footnote"} color={"tertiary"} className={"underline"}>
                  Reset to Pending
                </ThemedText>
              </>
            )}
          </Pressable>
        )}
      </ScreenLayout>

      <RestaurantSearchModal
        visible={showSearch}
        onClose={() => setShowSearch(false)}
        onSelect={handleConfirmRestaurant}
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
